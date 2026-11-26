import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { priceBill } from '../src/modules/accounts/bill/bill.service.js';
import { budgetStatusOf } from '../src/modules/accounts/budget/budget.service.js';
import { financialYearOf, monthsOfFinancialYear } from '../src/modules/accounts/financialYear.js';
import { getTrialBalance, todayAsEntryDate } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { shareOfGross } from '../src/modules/accounts/payroll/contributions.js';
import { isDueIn, nextDuePeriod } from '../src/modules/accounts/regularExpense/regularExpense.service.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const SETTINGS = '/accounts/settings';
const VENDORS = '/accounts/vendors';
const BILLS = '/accounts/bills';
const PAYROLL = '/accounts/payroll-runs';
const VOUCHERS = '/accounts/journal-vouchers';
const REGULAR = '/accounts/regular-expenses';
const CASH = 'la_1100';
const OPENING = 'la_3900';
const VAT_RECEIVABLE = 'la_1700';
const TAX_PAYABLE = 'la_2300';
const PROVIDENT_FUND = 'la_2400';
const GRATUITY = 'la_2500';
const SALARIES_PAYABLE = 'la_2200';
const OFFICE_RENT = 'la_5300';
const UTILITIES = 'la_5400';

/** Tests run on today's month, so the financial year screens, which stop at this month, include it. */
const MONTH = todayAsEntryDate().slice(0, 7);
const YEAR = financialYearOf(MONTH);

describe('provident fund, regular expenses, office rent, VAT, tax filings and budget', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    const chart = validateChartOfAccountsFile(readSeedFiles().chartOfAccounts);
    if (!chart.ok) throw new Error(JSON.stringify(chart.errors));
    await runInTransaction((session) => insertMissingLedgerAccounts(chart.value, session));
    await AccessProfile.create([
      {
        _id: 'ap_ct_accountant',
        name: 'Accountant',
        grants: {
          accounts: {
            bill: { actions: ['read', 'create', 'update'] },
            vendor: { actions: ['read', 'create', 'update'] },
            regularExpense: { actions: ['read', 'create', 'update'] },
            payrollRun: { actions: ['read', 'create', 'update'], fieldAccess: { lines: 'edit' } },
            journalVoucher: { actions: ['read', 'create', 'update'] },
            providentFund: { actions: ['read'] },
            taxFiling: { actions: ['read'] },
            budget: { actions: ['read'] },
          },
        },
      },
      {
        _id: 'ap_ct_ceo',
        name: 'CEO',
        grants: { accounts: { bill: { actions: ['read', 'approve'] }, payrollRun: { actions: ['read', 'approve'] }, journalVoucher: { actions: ['read', 'approve'] }, budget: { actions: ['read', 'update'] } } },
      },
      { _id: 'ap_ct_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_ct_accountant' });
    await addPerson('nadia', { profileId: 'ap_ct_ceo' });
    await addPerson('rumana', { profileId: 'ap_ct_none' });
    await AccountsEmployee.create([
      { _id: 'emp_1', employeeCode: 'E1', name: 'Nusrat Jahan', designation: 'QA Engineer', department: 'engineering', joinDate: '2024-01-01', monthlySalary: 6_000_000, isActive: true, version: 0 },
      // An odd salary, so the shares round.
      { _id: 'emp_2', employeeCode: 'E2', name: 'Imran Hossain', designation: 'Analyst', department: 'delivery', joinDate: '2024-01-01', monthlySalary: 5_000_005, isActive: true, version: 0 },
    ]);
    const farhana = await as('farhana');
    await farhana.patch(SETTINGS, { taxRates: [{ code: 'VAT15', name: 'VAT 15%', basisPoints: 1500 }], providentFundBasisPoints: 1000, gratuityBasisPoints: 833 });
    const opening = await farhana.post(VOUCHERS, { voucherDate: `${MONTH}-01`, memo: 'Opening cash', lines: [{ accountId: CASH, debit: 100_000_000 }, { accountId: OPENING, credit: 100_000_000 }] });
    await farhana.post(`${VOUCHERS}/${opening.body.id}/submit`);
    await (await as('nadia')).post(`${VOUCHERS}/${opening.body.id}/approve`);
  });

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  async function recordVoucher(voucherId: string) {
    await (await as('rahim')).post(`${VOUCHERS}/${voucherId}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${voucherId}/approve`)).status).toBe(200);
  }

  async function newVendor(name: string, tdsBasisPoints = 0) {
    const vendor = await (await as('rahim')).post(VENDORS, { name, category: 'rent', tdsBasisPoints });
    expect(vendor.status).toBe(201);
    return vendor.body.id as string;
  }

  async function recordBill(billId: string) {
    await (await as('rahim')).post(`${BILLS}/${billId}/submit`);
    expect((await (await as('nadia')).post(`${BILLS}/${billId}/approve`)).status).toBe(200);
  }

  it('needs a session and the permission', async () => {
    const routes = [
      ['get', '/accounts/provident-fund'], ['post', `/accounts/provident-fund/${MONTH}/deposit`],
      ['get', REGULAR], ['post', REGULAR], ['post', `${REGULAR}/bills`], ['patch', `${REGULAR}/re_1`], ['get', `${REGULAR}/re_1/history`], ['get', '/accounts/office-rent'],
      ['get', '/accounts/tax-filings'], ['post', `/accounts/tax-filings/${MONTH}/pay`],
      ['get', `/accounts/budgets/${YEAR}`], ['put', `/accounts/budgets/${YEAR}`],
    ] as const;
    for (const [method, path] of routes) {
      expect((await request(app)[method](path).send({})).status).toBe(401);
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    }
    // Reading the budget isn't changing it: that is the CEO's.
    expect((await (await as('rahim')).put(`/accounts/budgets/${YEAR}`, { lines: [] })).status).toBe(403);
  });

  it('works out shares, periods, financial years and budget status in whole paisa', () => {
    expect(shareOfGross(5_000_005, 1000)).toBe(500_001);
    expect(shareOfGross(5_000_005, 833)).toBe(416_500);
    expect(priceBill([{ description: 'x', accountId: 'a', quantity: 1, unitPrice: 333 }], 500, 1500)).toMatchObject({ amount: 333, vat: 50, tds: 17, netPayable: 366 });
    expect(financialYearOf('2027-03-15')).toBe(2026);
    expect(monthsOfFinancialYear(2026)[0]).toBe('2026-07');
    expect(monthsOfFinancialYear(2026)[11]).toBe('2027-06');
    const yearly = { frequency: 'yearly' as const, startMonth: '2026-03' };
    expect(isDueIn(yearly, '2027-03')).toBe(true);
    expect(isDueIn(yearly, '2027-04')).toBe(false);
    expect(nextDuePeriod(yearly, '2026-11')).toBe('2027-03');
    expect(isDueIn({ frequency: 'monthly', startMonth: '2026-01', endMonth: '2026-06' }, '2026-07')).toBe(false);
    expect(budgetStatusOf(100, 89)).toEqual({ usedBasisPoints: 8900, status: 'under' });
    expect(budgetStatusOf(100, 90).status).toBe('near_limit');
    expect(budgetStatusOf(100, 101).status).toBe('over');
    expect(budgetStatusOf(0, 1).status).toBe('unbudgeted');
  });

  it('payroll takes the provident fund share, the company adds the same and sets gratuity aside, and a deposit clears the fund', async () => {
    const rahim = await as('rahim');
    const run = await rahim.post(PAYROLL, { month: MONTH, payDate: `${MONTH}-28` });
    expect(run.status).toBe(201);
    const imran = run.body.lines.find((line: { employeeId: string }) => line.employeeId === 'emp_2');
    expect(imran).toMatchObject({ gross: 5_000_005, providentFund: 500_001, gratuity: 416_500, net: 5_000_005 - 500_001 });
    await rahim.post(`${PAYROLL}/${run.body.id}/submit`);
    expect((await (await as('nadia')).post(`${PAYROLL}/${run.body.id}/approve`)).status).toBe(200);

    const fundShares = 600_000 + 500_001;
    expect(await balanceOf(PROVIDENT_FUND)).toBe(-fundShares * 2);
    expect(await balanceOf(GRATUITY)).toBe(-(499_800 + 416_500));
    expect((await getTrialBalance()).difference).toBe(0);

    const fund = await rahim.get('/accounts/provident-fund');
    expect(fund.status).toBe(200);
    expect(fund.body.months[0]).toMatchObject({ month: MONTH, members: 2, employeeShare: fundShares, companyShare: fundShares, total: fundShares * 2, gratuity: 916_300, paymentStatus: 'unpaid' });
    expect(fund.body.employees.find((person: { employeeId: string }) => person.employeeId === 'emp_2')).toMatchObject({ providentFund: 1_000_002, gratuity: 416_500 });

    const deposit = await rahim.post(`/accounts/provident-fund/${MONTH}/deposit`, { paymentDate: `${MONTH}-28`, moneyAccountId: CASH, reference: 'PF-NOV' });
    expect(deposit.status).toBe(201);
    expect((await rahim.post(`/accounts/provident-fund/${MONTH}/deposit`, { paymentDate: `${MONTH}-28`, moneyAccountId: CASH })).body.error.code).toBe('nothing_owed');
    await recordVoucher(deposit.body.id);
    expect(await balanceOf(PROVIDENT_FUND)).toBe(0);
    expect((await rahim.get('/accounts/provident-fund')).body.months[0].paymentStatus).toBe('paid');

    // Salaries are still paid in full net, so salaries payable clears.
    const salaries = await rahim.post(`${PAYROLL}/${run.body.id}/pay`, { paymentDate: `${MONTH}-28`, moneyAccountId: CASH });
    await recordVoucher(salaries.body.id);
    expect(await balanceOf(SALARIES_PAYABLE)).toBe(0);
    expect((await getTrialBalance()).difference).toBe(0);
  });

  it('the Day 5 test: VAT on a bill is the rate times the amount before tax, and is claimed back', async () => {
    const rahim = await as('rahim');
    const vendorId = await newVendor('City Properties', 500);
    expect((await rahim.post(BILLS, { vendorId, billDate: `${MONTH}-02`, lines: [{ description: 'Rent', accountId: OFFICE_RENT, quantity: 1, unitPrice: 100 }], vatCode: 'NOPE' })).status).toBe(422);
    const bill = await rahim.post(BILLS, { vendorId, billDate: `${MONTH}-02`, lines: [{ description: 'Rent', accountId: OFFICE_RENT, quantity: 1, unitPrice: 12_000_000 }], vatCode: 'VAT15' });
    expect(bill.status).toBe(201);
    expect(bill.body).toMatchObject({ amount: 12_000_000, vatCode: 'VAT15', vatBasisPoints: 1500, vat: 1_800_000, tds: 600_000, netPayable: 12_000_000 + 1_800_000 - 600_000 });

    // Taking VAT off a draft prices it again without.
    const edited = await rahim.patch(`${BILLS}/${bill.body.id}`, { vatCode: null, reason: 'Check' });
    expect(edited.body).toMatchObject({ vat: 0, netPayable: 12_000_000 - 600_000 });
    await rahim.patch(`${BILLS}/${bill.body.id}`, { vatCode: 'VAT15', reason: 'VAT applies' });

    await recordBill(bill.body.id);
    expect(await balanceOf(VAT_RECEIVABLE)).toBe(1_800_000);
    expect(await balanceOf(TAX_PAYABLE)).toBe(-600_000);
    expect((await getTrialBalance()).difference).toBe(0);

    const filings = await rahim.get('/accounts/tax-filings');
    expect(filings.status).toBe(200);
    const tds = filings.body.filings.find((filing: { type: string; month: string }) => filing.type === 'vendor_tds' && filing.month === MONTH);
    const vat = filings.body.filings.find((filing: { type: string; month: string }) => filing.type === 'vat_purchases' && filing.month === MONTH);
    expect(tds).toMatchObject({ base: 12_000_000, amount: 600_000, paymentStatus: 'unpaid', challans: [] });
    expect(vat).toMatchObject({ base: 12_000_000, amount: 1_800_000 });

    // Paying the month's TDS, with its challan number, clears what is owed to the tax authority.
    expect((await rahim.post(`/accounts/tax-filings/${MONTH}/pay`, { paymentDate: `${MONTH}-05`, moneyAccountId: CASH })).status).toBe(422);
    const payment = await rahim.post(`/accounts/tax-filings/${MONTH}/pay`, { paymentDate: `${MONTH}-05`, moneyAccountId: CASH, challanNumber: 'CH-123' });
    expect(payment.status).toBe(201);
    expect(payment.body.reference).toBe('CH-123');
    await recordVoucher(payment.body.id);
    expect(await balanceOf(TAX_PAYABLE)).toBe(0);
    const paid = (await rahim.get('/accounts/tax-filings')).body.filings.find((filing: { type: string; month: string }) => filing.type === 'vendor_tds' && filing.month === MONTH);
    expect(paid).toMatchObject({ paymentStatus: 'paid', challans: ['CH-123'] });
    // A reversed payment's challan is no longer listed.
    expect((await (await as('farhana')).post(`${VOUCHERS}/${payment.body.id}/reverse`, {})).status).toBe(200);
    const reversed = (await rahim.get('/accounts/tax-filings')).body.filings.find((filing: { type: string; month: string }) => filing.type === 'vendor_tds' && filing.month === MONTH);
    expect(reversed).toMatchObject({ paymentStatus: 'unpaid', challans: [] });
  });

  it('the Day 5 test: a regular expense makes one draft bill per period, with no duplicates', async () => {
    const rahim = await as('rahim');
    const vendorId = await newVendor('City Properties');
    const rent = await rahim.post(REGULAR, { name: 'Office rent', category: 'rent', vendorId, accountId: OFFICE_RENT, frequency: 'monthly', amount: 12_000_000, vatCode: 'VAT15', dayOfMonth: 5, startMonth: MONTH });
    expect(rent.status).toBe(201);
    expect(rent.body.nextDue).toMatchObject({ period: MONTH, date: `${MONTH}-05` });
    expect((await rahim.post(REGULAR, { name: 'Bad', category: 'rent', vendorId, accountId: CASH, frequency: 'monthly', amount: 1, dayOfMonth: 5, startMonth: MONTH })).status).toBe(422);
    expect((await rahim.post(REGULAR, { name: 'Bad', category: 'rent', vendorId, accountId: OFFICE_RENT, frequency: 'monthly', amount: 1, dayOfMonth: 31, startMonth: MONTH })).status).toBe(422);
    const internet = await rahim.post(REGULAR, { name: 'Internet', category: 'utilities', vendorId, accountId: UTILITIES, frequency: 'monthly', amount: 300_000, dayOfMonth: 10, startMonth: MONTH });

    const first = await rahim.post(`${REGULAR}/bills`, { month: MONTH });
    expect(first.status).toBe(200);
    expect(first.body.made).toHaveLength(2);
    const rentBill = first.body.made.find((bill: { regularExpense: { id: string } }) => bill.regularExpense.id === rent.body.id);
    expect(rentBill).toMatchObject({ status: 'draft', billDate: `${MONTH}-05`, amount: 12_000_000, vat: 1_800_000, regularExpense: { period: MONTH } });

    // Running it again makes nothing new.
    const again = await rahim.post(`${REGULAR}/bills`, { month: MONTH });
    expect(again.body.made).toHaveLength(0);
    expect(again.body.skipped).toHaveLength(2);
    expect((await rahim.get(`${BILLS}?pageSize=100`)).body.bills).toHaveLength(2);

    // Next due moves on once the period has its bill.
    const listed = (await rahim.get(REGULAR)).body.expenses.find((expense: { id: string }) => expense.id === rent.body.id);
    expect(listed.nextDue.period > MONTH).toBe(true);
    expect(listed.latestBill).toMatchObject({ number: rentBill.number, status: 'draft' });

    // Cancelling the bill frees the period, which can then be billed again.
    await rahim.post(`${BILLS}/${rentBill.id}/cancel`, { reason: 'Wrong amount' });
    const redo = await rahim.post(`${REGULAR}/bills`, { month: MONTH });
    expect(redo.body.made).toHaveLength(1);

    // A stopped expense makes no more bills.
    await rahim.patch(`${REGULAR}/${internet.body.id}`, { isActive: false });
    expect((await rahim.get(`${REGULAR}/${internet.body.id}/history`)).body.entries.length).toBeGreaterThanOrEqual(2);

    // Office rent shows the rent agreement and its bill.
    const officeRent = await rahim.get('/accounts/office-rent');
    expect(officeRent.status).toBe(200);
    expect(officeRent.body.agreements.map((agreement: { id: string }) => agreement.id)).toEqual([rent.body.id]);
    expect(officeRent.body.bills).toHaveLength(2);
    expect(officeRent.body.totals.monthly).toBe(12_000_000);
  });

  it('budget against actual counts recorded spending and bills still waiting, and warns near the limit', async () => {
    const rahim = await as('rahim');
    const nadia = await as('nadia');
    expect((await nadia.put(`/accounts/budgets/${YEAR}`, { lines: [{ accountId: CASH, amount: 1 }] })).status).toBe(422);
    const set = await nadia.put(`/accounts/budgets/${YEAR}`, { lines: [{ accountId: OFFICE_RENT, amount: 20_000_000 }, { accountId: UTILITIES, amount: 0 }] });
    expect(set.status).toBe(200);
    expect(set.body.lines).toEqual([expect.objectContaining({ accountId: OFFICE_RENT, budget: 20_000_000, used: 0, status: 'under' })]);

    const vendorId = await newVendor('City Properties');
    const recorded = await rahim.post(BILLS, { vendorId, billDate: `${MONTH}-02`, lines: [{ description: 'Rent', accountId: OFFICE_RENT, quantity: 1, unitPrice: 12_000_000 }] });
    await recordBill(recorded.body.id);
    await rahim.post(BILLS, { vendorId, billDate: `${MONTH}-03`, lines: [{ description: 'Rent', accountId: OFFICE_RENT, quantity: 1, unitPrice: 6_000_000 }] });
    await rahim.post(BILLS, { vendorId, billDate: `${MONTH}-04`, lines: [{ description: 'Router', accountId: UTILITIES, quantity: 1, unitPrice: 50_000 }] });

    const budget = await rahim.get(`/accounts/budgets/${YEAR}`);
    expect(budget.status).toBe(200);
    const rentLine = budget.body.lines.find((line: { accountId: string }) => line.accountId === OFFICE_RENT);
    expect(rentLine).toMatchObject({ actual: 12_000_000, pending: 6_000_000, used: 18_000_000, difference: 2_000_000, usedBasisPoints: 9000, status: 'near_limit' });
    expect(budget.body.lines.find((line: { accountId: string }) => line.accountId === UTILITIES)).toMatchObject({ budget: 0, pending: 50_000, status: 'unbudgeted' });
    expect((await rahim.get(`/accounts/budgets/${YEAR + 1}`)).body.lines).toEqual([]);
  });
});
