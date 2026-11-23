import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { todayAsEntryDate } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const CASH_BANK = '/accounts/cash-bank';
const ACCOUNTS = '/accounts/ledger-accounts';
const VOUCHERS = '/accounts/journal-vouchers';
const NOVEMBER = 'from=2026-11-01&to=2026-11-30';

const CASH = 'la_1100';
const BANK_GROUP = 'la_1200';
const OPENING_EQUITY = 'la_3900';
const SERVICE_INCOME = 'la_4100';
const RENT = 'la_5300';
const OFFICE_EXPENSES = 'la_5500';

const CITY_BANK = { code: '1210', name: 'City Bank, current', type: 'asset', parentId: BANK_GROUP, cashOrBank: 'bank', bankName: 'City Bank', bankAccountNumber: '1102-3344-7712' };

type Line = [accountId: string, debit: number, credit: number];

interface CashBankRow {
  code: string;
  opening: number;
  moneyIn: number;
  moneyOut: number;
  balance: number;
  bankAccountNumber?: string;
}

describe('cash and bank balances', () => {
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
      { _id: 'ap_cb_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] } } } },
      { _id: 'ap_cb_reader', name: 'Chart reader', grants: { accounts: { ledgerAccount: { actions: ['read'] } } } },
      { _id: 'ap_cb_bank_reader', name: 'Bank reader', grants: { accounts: { ledgerAccount: { actions: ['read'], fieldAccess: { bankAccountNumber: 'read' } } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('nadia', { profileId: 'ap_cb_approver' });
    await addPerson('rita', { profileId: 'ap_cb_reader' });
    await addPerson('bilkis', { profileId: 'ap_cb_bank_reader' });
    await addPerson('kamrul');
  });

  /** Makes a voucher as the super admin and has someone else approve it, so it is recorded in the ledger. */
  async function recorded(voucherDate: string, memo: string, lines: Line[]): Promise<string> {
    const farhana = await as('farhana');
    const created = await farhana.post(VOUCHERS, { voucherDate, memo, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
    expect(created.status).toBe(201);
    expect((await farhana.post(`${VOUCHERS}/${created.body.id}/submit`)).status).toBe(200);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  async function openCityBank(): Promise<string> {
    const created = await (await as('farhana')).post(ACCOUNTS, CITY_BANK);
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  const rowFor = (body: { accounts: CashBankRow[] }, code: string) => body.accounts.find((row) => row.code === code);

  it('needs a token and the chart of accounts read permission', async () => {
    expect((await request(app).get(CASH_BANK)).status).toBe(401);
    expect((await (await as('kamrul')).get(CASH_BANK)).status).toBe(403);
    expect((await (await as('nadia')).get(CASH_BANK)).status).toBe(403);
  });

  it('works out every figure from the ledger: the balance after five entries matches the worked example', async () => {
    const cityBank = await openCityBank();
    // Opening balances on the day the books start, against Opening balance equity: ৳5,00,000 in the bank, ৳20,000 in cash.
    await recorded('2026-10-31', 'Opening balances', [[cityBank, 50_000_000, 0], [CASH, 2_000_000, 0], [OPENING_EQUITY, 0, 52_000_000]]);
    await recorded('2026-11-02', 'November office rent', [[RENT, 2_500_000, 0], [cityBank, 0, 2_500_000]]);
    await recorded('2026-11-05', 'Client payment', [[cityBank, 12_000_000, 0], [SERVICE_INCOME, 0, 12_000_000]]);
    await recorded('2026-11-10', 'Cash withdrawn from the bank', [[CASH, 1_000_000, 0], [cityBank, 0, 1_000_000]]);
    await recorded('2026-11-20', 'Printer paper', [[OFFICE_EXPENSES, 350_050, 0], [CASH, 0, 350_050]]);
    await recorded('2026-12-01', 'December rent, after the period', [[RENT, 2_500_000, 0], [cityBank, 0, 2_500_000]]);

    const response = await (await as('rita')).get(`${CASH_BANK}?${NOVEMBER}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ from: '2026-11-01', to: '2026-11-30' });
    // Worked by hand: bank 5,00,000 + 1,20,000 - 25,000 - 10,000; cash 20,000 + 10,000 - 3,500.50.
    expect(rowFor(response.body, '1210')).toMatchObject({ name: 'City Bank, current', cashOrBank: 'bank', bankName: 'City Bank', opening: 50_000_000, moneyIn: 12_000_000, moneyOut: 3_500_000, balance: 58_500_000 });
    expect(rowFor(response.body, '1100')).toMatchObject({ cashOrBank: 'cash', opening: 2_000_000, moneyIn: 1_000_000, moneyOut: 350_050, balance: 2_649_950 });
    expect(response.body.totals).toEqual({ opening: 52_000_000, moneyIn: 13_000_000, moneyOut: 3_850_050, balance: 61_149_950 });
    // Only cash and bank accounts are listed, never the group they sit in.
    expect(response.body.accounts.map((row: CashBankRow) => row.code)).toEqual(['1100', '1210']);
  });

  it('shows a reversal as money moving back, so the balance returns to what it was', async () => {
    const cityBank = await openCityBank();
    await recorded('2026-11-01', 'Opening balance', [[cityBank, 10_000_000, 0], [OPENING_EQUITY, 0, 10_000_000]]);
    const mistake = await recorded('2026-11-03', 'Rent paid twice', [[RENT, 2_500_000, 0], [cityBank, 0, 2_500_000]]);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${mistake}/reverse`)).status).toBe(200);

    const today = todayAsEntryDate();
    const row = rowFor((await (await as('rita')).get(`${CASH_BANK}?from=2026-11-01&to=${today > '2026-11-30' ? today : '2026-11-30'}`)).body, '1210');
    expect(row).toMatchObject({ moneyIn: 12_500_000, moneyOut: 2_500_000, balance: 10_000_000 });
  });

  it('shows each account in the chart with its balance on its normal side, from the ledger', async () => {
    await recorded('2026-11-05', 'Client payment into cash', [[CASH, 12_000_000, 0], [SERVICE_INCOME, 0, 12_000_000]]);
    await recorded('2026-11-06', 'Rent from cash', [[RENT, 2_500_000, 0], [CASH, 0, 2_500_000]]);
    const accounts = (await (await as('rita')).get(`${ACCOUNTS}?pageSize=100`)).body.accounts as { code: string; balance: number }[];
    const balanceOf = (code: string) => accounts.find((account) => account.code === code)?.balance;
    // Cash is an asset: debits minus credits. Income is credit-side: credits minus debits.
    expect(balanceOf('1100')).toBe(9_500_000);
    expect(balanceOf('4100')).toBe(12_000_000);
    expect(balanceOf('5300')).toBe(2_500_000);
    expect(balanceOf('3900')).toBe(0);
    expect((await (await as('rita')).get(`${ACCOUNTS}/${CASH}`)).body.balance).toBe(9_500_000);
  });

  it('defaults to this month so far', async () => {
    const today = todayAsEntryDate();
    const body = (await (await as('rita')).get(CASH_BANK)).body;
    expect(body).toMatchObject({ from: `${today.slice(0, 7)}-01`, to: today });
  });

  it('refuses a period that ends before it starts', async () => {
    expect((await (await as('rita')).get(`${CASH_BANK}?from=2026-11-30&to=2026-11-01`)).status).toBe(422);
  });

  it('hides the bank account number unless the profile names it, and masks it when it does', async () => {
    await openCityBank();
    expect(rowFor((await (await as('rita')).get(`${CASH_BANK}?${NOVEMBER}`)).body, '1210')).not.toHaveProperty('bankAccountNumber');
    expect(rowFor((await (await as('bilkis')).get(`${CASH_BANK}?${NOVEMBER}`)).body, '1210')?.bankAccountNumber).toBe('•••• 7712');
  });

  it('leaves out an inactive account that had no money in the period', async () => {
    const cityBank = await openCityBank();
    expect((await (await as('farhana')).patch(`${ACCOUNTS}/${cityBank}`, { isActive: false })).status).toBe(200);
    expect(rowFor((await (await as('rita')).get(`${CASH_BANK}?${NOVEMBER}`)).body, '1210')).toBeUndefined();
  });

  describe('marking accounts as cash or bank', () => {
    it('allows only asset accounts, and a bank name only on a bank account', async () => {
      const farhana = await as('farhana');
      const income = await farhana.post(ACCOUNTS, { code: '4150', name: 'Training income', type: 'income', parentId: 'la_4000', cashOrBank: 'bank' });
      expect(income.status).toBe(422);
      const cashWithBankName = await farhana.post(ACCOUNTS, { code: '1110', name: 'Petty cash', type: 'asset', parentId: 'la_1000', cashOrBank: 'cash', bankName: 'City Bank' });
      expect(cashWithBankName.status).toBe(422);
      expect((await farhana.patch(`${ACCOUNTS}/${CASH}`, { type: 'expense' })).status).toBe(422);
    });

    it("refuses marking an account that groups others, and grouping accounts under a cash or bank account", async () => {
      const farhana = await as('farhana');
      await openCityBank();
      expect((await farhana.patch(`${ACCOUNTS}/${BANK_GROUP}`, { cashOrBank: 'bank' })).status).toBe(422);
      expect((await farhana.post(ACCOUNTS, { code: '1105', name: 'Petty cash box', type: 'asset', parentId: CASH })).status).toBe(422);
    });

    it('can stop being cash or bank, which removes it from the screen and records the change', async () => {
      const farhana = await as('farhana');
      const cityBank = await openCityBank();
      const changed = await farhana.patch(`${ACCOUNTS}/${cityBank}`, { cashOrBank: null, bankName: null });
      expect(changed.status).toBe(200);
      expect(changed.body).not.toHaveProperty('cashOrBank');
      expect(rowFor((await farhana.get(`${CASH_BANK}?${NOVEMBER}`)).body, '1210')).toBeUndefined();
      const history = (await farhana.get(`${ACCOUNTS}/${cityBank}/history`)).body.entries;
      expect(JSON.stringify(history)).toContain('cashOrBank');
    });
  });
});
