import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { toPaisa } from '../src/modules/accounts/currency/exchangeRates.js';
import { paymentStateOf } from '../src/modules/accounts/documents/documentState.js';
import { amountForHours } from '../src/modules/accounts/invoice/invoiceLines.js';
import { receiptLines } from '../src/modules/accounts/invoice/invoice.service.js';
import { priceBill } from '../src/modules/accounts/bill/bill.service.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { Bill } from '../src/modules/accounts/models/bill.js';
import { Invoice } from '../src/modules/accounts/models/invoice.js';
import { JournalVoucher } from '../src/modules/accounts/models/journalVoucher.js';
import { LedgerEntry } from '../src/modules/accounts/models/ledgerEntry.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Client } from '../src/modules/master/models/client.js';
import { Project } from '../src/modules/projects/models/project.js';
import { Task, type TaskDoc } from '../src/modules/projects/models/task.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const ACCOUNTS = '/accounts/ledger-accounts';
const VOUCHERS = '/accounts/journal-vouchers';
const INVOICES = '/accounts/invoices';
const BILLS = '/accounts/bills';
const VENDORS = '/accounts/vendors';
const CLIENTS = '/accounts/clients';
const SETTINGS = '/accounts/settings';

const RECEIVABLE = 'la_1300';
const PAYABLE = 'la_2100';
const TAX_PAYABLE = 'la_2300';
const OPENING_EQUITY = 'la_3900';
const SERVICE_INCOME = 'la_4100';
const EXCHANGE_GAIN = 'la_4200';
const EQUIPMENT = 'la_1600';
const OFFICE_EXPENSES = 'la_5500';

/** $1 = Tk 122.00 from 1 November, and Tk 123.00 from 20 November. */
const USD_RATES = [
  { currency: 'USD', effectiveFrom: '2026-11-01', paisaPerUnit: 12_200 },
  { currency: 'USD', effectiveFrom: '2026-11-20', paisaPerUnit: 12_300 },
];

describe('invoices, vendors and bills', () => {
  useTestDatabase();

  let app: Application;
  let bankId: string;
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
        _id: 'ap_ib_accountant',
        name: 'Accountant',
        grants: { accounts: { invoice: { actions: ['read', 'create', 'update'] }, bill: { actions: ['read', 'create', 'update'] }, vendor: { actions: ['read', 'create', 'update'] }, clientAccount: { actions: ['read', 'update'] }, journalVoucher: { actions: ['read', 'create', 'update'] } } },
      },
      {
        _id: 'ap_ib_manager',
        name: 'Finance manager',
        grants: { accounts: { invoice: { actions: ['read', 'create', 'update', 'approve'] }, bill: { actions: ['read', 'create', 'update', 'approve'] }, journalVoucher: { actions: ['read', 'approve'] } } },
      },
      { _id: 'ap_ib_reader', name: 'Reader', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_ib_accountant' });
    await addPerson('nadia', { profileId: 'ap_ib_manager' });
    await addPerson('rumana', { profileId: 'ap_ib_reader' });

    const farhana = await as('farhana');
    const bank = await farhana.post(ACCOUNTS, { code: '1210', name: 'City Bank, current', type: 'asset', parentId: 'la_1200', cashOrBank: 'bank', bankName: 'City Bank' });
    expect(bank.status).toBe(201);
    bankId = bank.body.id as string;
    expect((await farhana.patch(SETTINGS, { currencies: [{ code: 'USD', name: 'US dollar' }], exchangeRates: USD_RATES })).status).toBe(200);

    await Client.create({ _id: 'cl_hope', name: 'Hope Foundation', status: 'active', version: 0 });
    await Project.create({ _id: 'pr_portal', name: 'Donor Portal', leadId: 'farhana', clientId: 'cl_hope', version: 0 });
    const task = (taskNumber: number, extra: Partial<TaskDoc>): Partial<TaskDoc> => ({
      _id: `tk_${taskNumber}`, taskNumber, projectId: 'pr_portal', title: `Task ${taskNumber}`, assignedDevId: 'rahim', tlId: 'farhana', estimatedHours: 10, status: 'done' as const, completedAt: new Date('2026-11-05T10:00:00Z'), version: 0, ...extra,
    });
    await Task.create([task(1, {}), task(2, { estimatedHours: 1.5 }), task(3, { billable: false }), task(4, { status: 'in_progress', completedAt: undefined })]);
  });

  /** Submits as `maker`, then nadia approves. */
  async function approve(base: string, id: string, maker = 'rahim') {
    expect((await (await as(maker)).post(`${base}/${id}/submit`)).status).toBe(200);
    const approved = await (await as('nadia')).post(`${base}/${id}/approve`);
    expect(approved.status).toBe(200);
    return approved.body;
  }

  /** Records a voucher made from an invoice or bill: its maker submits it and farhana approves. */
  async function recordVoucher(voucherId: string) {
    expect((await (await as('rahim')).post(`${VOUCHERS}/${voucherId}/submit`)).status).toBe(200);
    expect((await (await as('farhana')).post(`${VOUCHERS}/${voucherId}/approve`)).status).toBe(200);
  }

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  async function setHopeRate() {
    expect((await (await as('rahim')).patch(`${CLIENTS}/cl_hope`, { currency: 'USD', hourlyRate: 4_500, termsDays: 15 })).status).toBe(200);
  }

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch', string][] = [
      ['clients', 'get', CLIENTS], ['client billing', 'patch', `${CLIENTS}/cl_1`],
      ['invoices', 'get', INVOICES], ['new invoice', 'post', INVOICES], ['billable tasks', 'get', `${INVOICES}/billable-tasks`],
      ['invoice', 'get', `${INVOICES}/in_1`], ['edit invoice', 'patch', `${INVOICES}/in_1`], ['submit invoice', 'post', `${INVOICES}/in_1/submit`],
      ['approve invoice', 'post', `${INVOICES}/in_1/approve`], ['return invoice', 'post', `${INVOICES}/in_1/return`], ['cancel invoice', 'post', `${INVOICES}/in_1/cancel`],
      ['receive payment', 'post', `${INVOICES}/in_1/receive-payment`], ['invoice history', 'get', `${INVOICES}/in_1/history`],
      ['vendors', 'get', VENDORS], ['new vendor', 'post', VENDORS], ['vendor', 'get', `${VENDORS}/vn_1`], ['edit vendor', 'patch', `${VENDORS}/vn_1`], ['vendor history', 'get', `${VENDORS}/vn_1/history`],
      ['bills', 'get', BILLS], ['new bill', 'post', BILLS], ['bill', 'get', `${BILLS}/bl_1`], ['edit bill', 'patch', `${BILLS}/bl_1`], ['submit bill', 'post', `${BILLS}/bl_1/submit`],
      ['approve bill', 'post', `${BILLS}/bl_1/approve`], ['return bill', 'post', `${BILLS}/bl_1/return`], ['cancel bill', 'post', `${BILLS}/bl_1/cancel`],
      ['pay bill', 'post', `${BILLS}/bl_1/pay`], ['bill history', 'get', `${BILLS}/bl_1/history`],
    ];

    it.each(routes)('%s needs a session', async (_name, method, path) => {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    });

    it.each(routes.filter(([name]) => !['receive payment', 'pay bill'].includes(name)))('%s needs its permission', async (_name, method, path) => {
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    });
  });

  describe('the money rules', () => {
    it('converts at the rate and rounds half away from zero to the paisa', () => {
      expect(toPaisa(1_800_000, 12_200)).toBe(219_600_000);
      expect(toPaisa(1, 12_250)).toBe(123);
      expect(toPaisa(1, 12_150)).toBe(122);
      expect(amountForHours(1.5, 4_500)).toBe(6_750);
      expect(amountForHours(0.333, 4_500)).toBe(1_499);
    });

    it('prices a bill and its TDS to the paisa', () => {
      const priced = priceBill([{ description: 'Laptop', accountId: EQUIPMENT, quantity: 2, unitPrice: 16_000_000 }, { description: 'Cable', accountId: OFFICE_EXPENSES, quantity: 0.5, unitPrice: 33 }], 500);
      expect(priced.lines.map((line) => line.amount)).toEqual([32_000_000, 17]);
      expect(priced).toMatchObject({ amount: 32_000_017, tds: 1_600_001, netPayable: 30_400_016 });
    });

    it('clears exactly what was recorded once the last receipt arrives, and books the rate difference', () => {
      const invoice = { number: 'INV-0001', exchangeRate: 12_250 };
      const first = receiptLines(invoice, 1, 0, 12_250, bankId);
      const second = receiptLines(invoice, 1, 1, 12_250, bankId);
      const cleared = [first, second].map((lines) => lines.find((line) => line.accountId === RECEIVABLE)?.credit ?? 0);
      expect(cleared[0]! + cleared[1]!).toBe(toPaisa(2, 12_250));
      const atNewRate = receiptLines(invoice, 100, 0, 12_300, bankId);
      expect(atNewRate).toContainEqual({ accountId: EXCHANGE_GAIN, credit: 50, memo: 'Exchange gain on INV-0001' });
    });

    it('works out paid, outstanding and overdue', () => {
      expect(paymentStateOf(100, '2026-11-30', undefined, '2026-11-30')).toMatchObject({ paid: 0, outstanding: 100, paymentStatus: 'unpaid' });
      expect(paymentStateOf(100, '2026-11-30', { recorded: 40, committed: 70 }, '2026-12-03')).toMatchObject({ paid: 40, outstanding: 60, pending: 30, paymentStatus: 'overdue', daysOverdue: 3 });
      expect(paymentStateOf(100, '2026-11-30', { recorded: 100, committed: 100 }, '2026-12-03').paymentStatus).toBe('paid');
    });
  });

  describe('client billing', () => {
    it('lists clients on the defaults until someone sets them, and refuses an unlisted currency', async () => {
      const rahim = await as('rahim');
      expect((await rahim.get(CLIENTS)).body.clients).toEqual([expect.objectContaining({ clientId: 'cl_hope', termsDays: 30, currency: 'BDT', version: 0 })]);
      expect((await rahim.patch(`${CLIENTS}/cl_hope`, { currency: 'EUR' })).status).toBe(422);
      await setHopeRate();
      expect((await rahim.get(CLIENTS)).body.clients[0]).toMatchObject({ currency: 'USD', hourlyRate: 4_500, termsDays: 15, version: 1 });
      expect((await rahim.patch(`${CLIENTS}/cl_nobody`, { termsDays: 10 })).status).toBe(404);
    });
  });

  describe('invoices', () => {
    it('offers only finished, billable, unbilled tasks, priced at the client rate', async () => {
      await setHopeRate();
      const offered = await (await as('rahim')).get(`${INVOICES}/billable-tasks?clientId=cl_hope&from=2026-11-01&to=2026-11-30`);
      expect(offered.status).toBe(200);
      expect(offered.body.tasks.map((task: { id: string; amount: number }) => [task.id, task.amount])).toEqual([['tk_1', 45_000], ['tk_2', 6_750]]);
    });

    it('bills tasks once, due on the client terms, and frees them when the draft is cancelled', async () => {
      await setHopeRate();
      const rahim = await as('rahim');
      const created = await rahim.post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1', 'tk_2'], items: [{ description: 'Hosting setup', amount: 10_000, milestone: 'Go live' }] });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ number: 'INV-0001', currency: 'USD', dueDate: '2026-11-25', total: 61_750, status: 'draft' });
      expect((await Task.findById('tk_1').lean())?.invoiceId).toBe(created.body.id);

      const twice = await rahim.post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1'] });
      expect(twice.status).toBe(422);
      expect((await rahim.post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_3'] })).status).toBe(422);
      expect((await rahim.post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_4'] })).status).toBe(422);

      expect((await rahim.post(`${INVOICES}/${created.body.id}/cancel`, { reason: 'Wrong month' })).body.status).toBe('cancelled');
      expect((await Task.findById('tk_1').lean())?.invoiceId).toBeUndefined();
    });

    it('needs a rate on the issue date for a foreign currency', async () => {
      const refused = await (await as('rahim')).post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-10-15', currency: 'USD', items: [{ description: 'Design', amount: 100 }] });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('no_exchange_rate');
    });

    it('edits a draft with a reason, swapping its tasks', async () => {
      await setHopeRate();
      const rahim = await as('rahim');
      const created = await rahim.post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1'] });
      expect((await rahim.patch(`${INVOICES}/${created.body.id}`, { taskIds: ['tk_2'] })).status).toBe(422);
      const edited = await rahim.patch(`${INVOICES}/${created.body.id}`, { taskIds: ['tk_2'], reason: 'Only the second task is finished for the client' });
      expect(edited.body.total).toBe(6_750);
      expect((await Task.findById('tk_1').lean())?.invoiceId).toBeUndefined();
      expect((await Task.findById('tk_2').lean())?.invoiceId).toBe(created.body.id);
    });

    it('the Day 3 gate: an invoice receives a payment, with balanced ledger lines and the rate difference booked', async () => {
      await setHopeRate();
      // Due far ahead, so the test doesn't turn overdue as the calendar moves; overdue has its own test.
      const created = await (await as('rahim')).post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', dueDate: '2099-12-31', taskIds: ['tk_1'] });
      await (await as('rahim')).post(`${INVOICES}/${created.body.id}/submit`);
      const own = await (await as('farhana')).post(`${INVOICES}/${created.body.id}/approve`);
      expect(own.status).toBe(200);
      expect(own.body).toMatchObject({ status: 'issued', exchangeRate: 12_200, totalInTaka: 5_490_000, paymentStatus: 'unpaid', outstanding: 45_000 });
      expect(await balanceOf(RECEIVABLE)).toBe(5_490_000);
      expect(await balanceOf(SERVICE_INCOME)).toBe(-5_490_000);

      const rahim = await as('rahim');
      const part = await rahim.post(`${INVOICES}/${created.body.id}/receive-payment`, { receivedDate: '2026-11-21', moneyAccountId: bankId, amount: 20_000, reference: 'SWIFT 1' });
      expect(part.status).toBe(201);
      expect(part.body).toMatchObject({ voucherType: 'receipt', party: 'Hope Foundation', linkedDocument: { type: 'invoice', number: 'INV-0001', amount: 20_000 } });
      expect((await rahim.post(`${INVOICES}/${created.body.id}/receive-payment`, { receivedDate: '2026-11-21', moneyAccountId: bankId, amount: 25_001 })).body.error.code).toBe('more_than_owed');
      await recordVoucher(part.body.id);
      expect((await rahim.get(`${INVOICES}/${created.body.id}`)).body).toMatchObject({ paid: 20_000, outstanding: 25_000, paymentStatus: 'part_paid' });

      const rest = await rahim.post(`${INVOICES}/${created.body.id}/receive-payment`, { receivedDate: '2026-11-21', moneyAccountId: bankId });
      expect(rest.body.linkedDocument.amount).toBe(25_000);
      await recordVoucher(rest.body.id);

      const paid = await rahim.get(`${INVOICES}/${created.body.id}`);
      expect(paid.body).toMatchObject({ paid: 45_000, outstanding: 0, paymentStatus: 'paid', allowedActions: { receivePayment: false, cancel: false } });
      expect(paid.body.receipts).toHaveLength(2);
      // $450 received at Tk 123 = Tk 55,350; recorded at Tk 122 = Tk 54,900; Tk 450 exchange gain.
      expect(await balanceOf(bankId)).toBe(5_535_000);
      expect(await balanceOf(RECEIVABLE)).toBe(0);
      expect(await balanceOf(EXCHANGE_GAIN)).toBe(-45_000);
      expect((await getTrialBalance()).difference).toBe(0);
    });

    it('refuses editing a receipt made from an invoice, and refuses cancelling an invoice with receipts', async () => {
      await setHopeRate();
      const created = await (await as('rahim')).post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1'] });
      await approve(INVOICES, created.body.id);
      const receipt = await (await as('rahim')).post(`${INVOICES}/${created.body.id}/receive-payment`, { receivedDate: '2026-11-12', moneyAccountId: bankId });
      const edit = await (await as('rahim')).patch(`/accounts/receipt-vouchers/${receipt.body.id}`, { memo: 'x', reason: 'Typo' });
      expect(edit.body.error.code).toBe('linked_voucher');
      expect((await (await as('nadia')).post(`${INVOICES}/${created.body.id}/cancel`, { reason: 'Wrong client' })).body.error.code).toBe('invoice_has_receipts');
    });

    it('cancels an issued invoice with a reversal, freeing its tasks, but never by its maker', async () => {
      await setHopeRate();
      const created = await (await as('rahim')).post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1'] });
      await approve(INVOICES, created.body.id);
      expect((await (await as('rahim')).post(`${INVOICES}/${created.body.id}/cancel`, { reason: 'Wrong client' })).status).toBe(403);
      const cancelled = await (await as('nadia')).post(`${INVOICES}/${created.body.id}/cancel`, { reason: 'Wrong client' });
      expect(cancelled.body.status).toBe('cancelled');
      expect(await balanceOf(RECEIVABLE)).toBe(0);
      expect((await Task.findById('tk_1').lean())?.invoiceId).toBeUndefined();
    });

    it('shows waiting invoices in the Approvals queue in taka', async () => {
      await setHopeRate();
      const created = await (await as('rahim')).post(INVOICES, { clientId: 'cl_hope', issueDate: '2026-11-10', taskIds: ['tk_1'] });
      await (await as('rahim')).post(`${INVOICES}/${created.body.id}/submit`);
      const queue = await (await as('nadia')).get('/accounts/approvals');
      expect(queue.body.waitingForYou.items).toEqual([expect.objectContaining({ type: 'invoice', number: 'INV-0001', amount: 5_490_000 })]);
    });
  });

  describe('vendors and bills', () => {
    async function makeVendor() {
      const vendor = await (await as('rahim')).post(VENDORS, { name: 'TechWorld', category: 'equipment', tdsBasisPoints: 500, contactEmail: 'Sales@TechWorld.test' });
      expect(vendor.status).toBe(201);
      return vendor.body.id as string;
    }

    async function openBank() {
      const farhana = await as('farhana');
      const opening = await farhana.post(VOUCHERS, { voucherDate: '2026-11-01', memo: 'Opening bank balance', lines: [{ accountId: bankId, debit: 50_000_000 }, { accountId: OPENING_EQUITY, credit: 50_000_000 }] });
      await farhana.post(`${VOUCHERS}/${opening.body.id}/submit`);
      expect((await (await as('nadia')).post(`${VOUCHERS}/${opening.body.id}/approve`)).status).toBe(200);
    }

    it('keeps vendors with their TDS rate, and lists them by name', async () => {
      const vendorId = await makeVendor();
      const rahim = await as('rahim');
      expect((await rahim.get(`${VENDORS}/${vendorId}`)).body).toMatchObject({ name: 'TechWorld', contactEmail: 'sales@techworld.test', tdsBasisPoints: 500, isActive: true });
      expect((await rahim.patch(`${VENDORS}/${vendorId}`, { contactEmail: null, isActive: false })).body.contactEmail).toBeUndefined();
      expect((await rahim.get(`${VENDORS}?isActive=false`)).body.total).toBe(1);
      expect((await rahim.post(VENDORS, { name: 'X', category: 'cars', tdsBasisPoints: 0 })).status).toBe(422);
    });

    it('the Day 3 gate: a bill is recorded with TDS, then paid from the bank, with balanced ledger lines', async () => {
      await openBank();
      const vendorId = await makeVendor();
      const rahim = await as('rahim');
      const created = await rahim.post(BILLS, {
        vendorId,
        vendorReference: 'TW-8812',
        billDate: '2026-11-03',
        // Far ahead, so the test doesn't turn overdue as the calendar moves; overdue has its own test.
        dueDate: '2099-12-31',
        lines: [{ description: 'Laptop, 16 GB', accountId: EQUIPMENT, quantity: 2, unitPrice: 16_000_000 }],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ number: 'B-0001', amount: 32_000_000, tds: 1_600_000, netPayable: 30_400_000, status: 'draft' });

      // The maker can't approve their own bill, super admins included.
      const own = await as('farhana');
      const farhanaBill = await own.post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Mouse', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 100_000 }] });
      await own.post(`${BILLS}/${farhanaBill.body.id}/submit`);
      expect((await own.post(`${BILLS}/${farhanaBill.body.id}/approve`)).body.error.code).toBe('own_record');

      const recorded = await approve(BILLS, created.body.id);
      expect(recorded).toMatchObject({ status: 'recorded', paymentStatus: 'unpaid', outstanding: 30_400_000 });
      expect(await balanceOf(EQUIPMENT)).toBe(32_000_000);
      expect(await balanceOf(PAYABLE)).toBe(-30_400_000);
      expect(await balanceOf(TAX_PAYABLE)).toBe(-1_600_000);
      expect((await rahim.patch(`${BILLS}/${created.body.id}`, { billDate: '2026-11-04', reason: 'Typo' })).status).toBe(409);

      const payment = await rahim.post(`${BILLS}/${created.body.id}/pay`, { paymentDate: '2026-11-14', moneyAccountId: bankId, reference: 'Cheque 004520' });
      expect(payment.status).toBe(201);
      expect(payment.body).toMatchObject({ voucherType: 'payment', party: 'TechWorld', total: 30_400_000, linkedDocument: { type: 'bill', number: 'B-0001', amount: 30_400_000 } });
      expect((await rahim.get(`${BILLS}/${created.body.id}`)).body).toMatchObject({ pending: 30_400_000, allowedActions: { pay: false } });
      await recordVoucher(payment.body.id);

      expect((await rahim.get(`${BILLS}/${created.body.id}`)).body).toMatchObject({ paid: 30_400_000, outstanding: 0, paymentStatus: 'paid' });
      expect(await balanceOf(PAYABLE)).toBe(0);
      expect(await balanceOf(bankId)).toBe(50_000_000 - 30_400_000);
      expect((await getTrialBalance()).difference).toBe(0);
      expect((await rahim.get(`${BILLS}?paymentStatus=paid`)).body.bills.map((bill: { number: string }) => bill.number)).toEqual(['B-0001']);
    });

    it('a reversed payment opens the bill again', async () => {
      await openBank();
      const vendorId = await makeVendor();
      const created = await (await as('rahim')).post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Chair', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 1_000_000 }] });
      await approve(BILLS, created.body.id);
      const payment = await (await as('rahim')).post(`${BILLS}/${created.body.id}/pay`, { paymentDate: '2026-11-04', moneyAccountId: bankId });
      await recordVoucher(payment.body.id);
      expect((await (await as('farhana')).post(`${VOUCHERS}/${payment.body.id}/reverse`, {})).status).toBe(200);
      expect((await (await as('rahim')).get(`${BILLS}/${created.body.id}`)).body).toMatchObject({ paid: 0, outstanding: 950_000 });
    });

    it('records only one of two payments made for the same bill at the same moment', async () => {
      await openBank();
      const vendorId = await makeVendor();
      const created = await (await as('rahim')).post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Chair', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 1_000_000 }] });
      await approve(BILLS, created.body.id);
      const payment = await (await as('rahim')).post(`${BILLS}/${created.body.id}/pay`, { paymentDate: '2026-11-04', moneyAccountId: bankId });
      expect(payment.body.linkedDocument).toMatchObject({ amount: 950_000, amountDue: 950_000 });
      // A double click: a second voucher that passed the open-amount check before the first one was saved.
      const first = await JournalVoucher.findById(payment.body.id).lean();
      await JournalVoucher.create({ ...first, _id: 'jv_double_click', number: 'PV-9999' });

      await recordVoucher(payment.body.id);
      expect((await (await as('rahim')).post(`${VOUCHERS}/jv_double_click/submit`)).status).toBe(200);
      const second = await (await as('farhana')).post(`${VOUCHERS}/jv_double_click/approve`);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('more_than_owed');
      expect((await (await as('rahim')).get(`${BILLS}/${created.body.id}`)).body).toMatchObject({ paid: 950_000, outstanding: 0 });
      expect(await balanceOf(bankId)).toBe(50_000_000 - 950_000);
    });

    it('refuses an update request on a payment made from a bill', async () => {
      await openBank();
      const vendorId = await makeVendor();
      const created = await (await as('rahim')).post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Chair', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 1_000_000 }] });
      await approve(BILLS, created.body.id);
      const payment = await (await as('rahim')).post(`${BILLS}/${created.body.id}/pay`, { paymentDate: '2026-11-04', moneyAccountId: bankId });
      await recordVoucher(payment.body.id);
      const refused = await (await as('farhana')).post('/accounts/update-requests', { recordType: 'journalVoucher', recordId: payment.body.id, reason: 'Wrong date', changes: { voucherDate: '2026-11-05' } });
      expect(refused.body.error.code).toBe('linked_voucher');
    });

    it('a failure halfway leaves no bill and no ledger lines', async () => {
      const vendorId = await makeVendor();
      const billsBefore = await Bill.countDocuments();
      const entriesBefore = await LedgerEntry.countDocuments();
      const refused = await (await as('rahim')).post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Ghost', accountId: 'la_none', quantity: 1, unitPrice: 100 }] });
      expect(refused.status).toBe(422);
      expect(await Bill.countDocuments()).toBe(billsBefore);
      expect(await LedgerEntry.countDocuments()).toBe(entriesBefore);
      expect(await Invoice.countDocuments()).toBe(0);
    });

    it('cancels a recorded bill with a reversal, and returns a submitted one to its maker', async () => {
      const vendorId = await makeVendor();
      const rahim = await as('rahim');
      const first = await rahim.post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Desk', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 2_000_000 }] });
      await approve(BILLS, first.body.id);
      expect((await (await as('nadia')).post(`${BILLS}/${first.body.id}/cancel`, { reason: 'Duplicate of B-0000' })).body.status).toBe('cancelled');
      expect(await balanceOf(OFFICE_EXPENSES)).toBe(0);

      const second = await rahim.post(BILLS, { vendorId, billDate: '2026-11-03', lines: [{ description: 'Desk', accountId: OFFICE_EXPENSES, quantity: 1, unitPrice: 2_000_000 }] });
      await rahim.post(`${BILLS}/${second.body.id}/submit`);
      const returned = await (await as('nadia')).post(`${BILLS}/${second.body.id}/return`, { note: 'Attach the receipt' });
      expect(returned.body).toMatchObject({ status: 'draft', returnNote: 'Attach the receipt' });
      const history = await rahim.get(`${BILLS}/${second.body.id}/history`);
      expect(history.body.entries.length).toBeGreaterThanOrEqual(3);
    });
  });
});
