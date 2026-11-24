import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { JournalVoucher } from '../src/modules/accounts/models/journalVoucher.js';
import { LedgerEntry } from '../src/modules/accounts/models/ledgerEntry.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { RecordHistory } from '../src/modules/master/models/recordHistory.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PAYMENTS = '/accounts/payment-vouchers';
const RECEIPTS = '/accounts/receipt-vouchers';
const VOUCHERS = '/accounts/journal-vouchers';
const ACCOUNTS = '/accounts/ledger-accounts';

const CASH = 'la_1100';
const BANK_GROUP = 'la_1200';
const RECEIVABLE = 'la_1300';
const PAYABLE = 'la_2100';
const OPENING_EQUITY = 'la_3900';
const RENT = 'la_5300';
const OFFICE_EXPENSES = 'la_5500';

const CITY_BANK = { code: '1210', name: 'City Bank, current', type: 'asset', parentId: BANK_GROUP, cashOrBank: 'bank', bankName: 'City Bank' };

/** Paying 18,000.00 owed to a vendor, plus 0.01 in office expenses, from the bank. Amounts are in paisa. */
const paymentFrom = (moneyAccountId: string) => ({
  voucherDate: '2026-11-10',
  memo: 'Paying Desh Furniture',
  party: 'Desh Furniture',
  reference: 'Cheque 004512',
  moneyAccountId,
  lines: [
    { accountId: PAYABLE, amount: 1_800_000, memo: 'Bill DF-221' },
    { accountId: OFFICE_EXPENSES, amount: 1 },
  ],
});

describe('payment and receipt vouchers', () => {
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
      { _id: 'ap_pv_accountant', name: 'Accountant', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update', 'approve'] }, ledgerAccount: { actions: ['read'] } } } },
      { _id: 'ap_pv_auditor', name: 'Auditor', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_pv_accountant' });
    await addPerson('nadia', { profileId: 'ap_pv_accountant' });
    await addPerson('rumana', { profileId: 'ap_pv_auditor' });

    const bank = await (await as('farhana')).post(ACCOUNTS, CITY_BANK);
    expect(bank.status).toBe(201);
    bankId = bank.body.id as string;
  });

  /** Submits a draft as its maker and has nadia approve it, so it is recorded. */
  async function record(voucherId: string, maker = 'rahim') {
    expect((await (await as(maker)).post(`${VOUCHERS}/${voucherId}/submit`)).status).toBe(200);
    const approved = await (await as('nadia')).post(`${VOUCHERS}/${voucherId}/approve`);
    expect(approved.status).toBe(200);
    return approved.body;
  }

  const balanceOf = async (accountId: string) => (await getTrialBalance()).rows.find((row) => row.accountId === accountId)?.balance ?? 0;

  /** Puts 50,000.00 in the bank and records 18,000.00 owed to a vendor, as a journal voucher farhana makes. */
  async function openBooks() {
    const farhana = await as('farhana');
    const opening = await farhana.post(VOUCHERS, {
      voucherDate: '2026-11-01',
      memo: 'Opening bank balance and a bill owed',
      lines: [
        { accountId: bankId, debit: 5_000_000 },
        { accountId: OFFICE_EXPENSES, debit: 1_800_000 },
        { accountId: OPENING_EQUITY, credit: 5_000_000 },
        { accountId: PAYABLE, credit: 1_800_000 },
      ],
    });
    expect(opening.status).toBe(201);
    await record(opening.body.id, 'farhana');
  }

  describe('who can reach each route', () => {
    const routes: [string, 'post' | 'patch', string][] = [
      ['create payment', 'post', PAYMENTS],
      ['update payment', 'patch', `${PAYMENTS}/jv_1`],
      ['create receipt', 'post', RECEIPTS],
      ['update receipt', 'patch', `${RECEIPTS}/jv_1`],
    ];

    it.each(routes)('%s needs a session', async (_name, method, path) => {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    });

    it.each(routes)('%s needs the voucher permission', async (_name, method, path) => {
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    });
  });

  describe('a payment', () => {
    it('adds the cash or bank line itself, numbers it PV, and keeps party and reference', async () => {
      const created = await (await as('rahim')).post(PAYMENTS, paymentFrom(bankId));
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        voucherType: 'payment',
        number: 'PV-0001',
        party: 'Desh Furniture',
        reference: 'Cheque 004512',
        moneyAccountId: bankId,
        total: 1_800_001,
        status: 'draft',
        lines: [
          { accountId: PAYABLE, debit: 1_800_000, credit: 0, memo: 'Bill DF-221' },
          { accountId: OFFICE_EXPENSES, debit: 1, credit: 0 },
          { accountId: bankId, debit: 0, credit: 1_800_001, memo: 'Paid out' },
        ],
      });
      // Journal vouchers keep their own series.
      const journal = await (await as('rahim')).post(VOUCHERS, { voucherDate: '2026-11-10', memo: 'Rent', lines: [{ accountId: RENT, debit: 100 }, { accountId: CASH, credit: 100 }] });
      expect(journal.body).toMatchObject({ voucherType: 'journal', number: 'JV-0001' });
    });

    it('lowers both the bank balance and the amount owed once recorded, and the books stay balanced', async () => {
      await openBooks();
      const created = await (await as('rahim')).post(PAYMENTS, { ...paymentFrom(bankId), lines: [{ accountId: PAYABLE, amount: 1_800_000 }] });
      const recorded = await record(created.body.id);
      expect(recorded.status).toBe('recorded');

      expect(await balanceOf(bankId)).toBe(5_000_000 - 1_800_000);
      expect(await balanceOf(PAYABLE)).toBe(0);
      expect((await getTrialBalance()).difference).toBe(0);
      const entry = await LedgerEntry.findById(recorded.ledgerEntryId).lean();
      expect(entry?.source).toEqual({ type: 'journalVoucher', id: created.body.id });
    });

    it('nets back to the earlier balances when reversed', async () => {
      await openBooks();
      const created = await (await as('rahim')).post(PAYMENTS, { ...paymentFrom(bankId), lines: [{ accountId: PAYABLE, amount: 1_800_000 }] });
      await record(created.body.id);
      expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/reverse`, {})).status).toBe(200);
      expect(await balanceOf(bankId)).toBe(5_000_000);
      expect(await balanceOf(PAYABLE)).toBe(-1_800_000);
      expect((await getTrialBalance()).difference).toBe(0);
    });

    it('refuses its maker approving it, super admins included', async () => {
      const farhana = await as('farhana');
      const created = await farhana.post(PAYMENTS, paymentFrom(bankId));
      await farhana.post(`${VOUCHERS}/${created.body.id}/submit`);
      const refused = await farhana.post(`${VOUCHERS}/${created.body.id}/approve`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('own_record');
    });

    it.each([
      ['an account not marked cash or bank', { moneyAccountId: RENT }, 422],
      ['an unknown money account', { moneyAccountId: 'la_none' }, 422],
      ['the money account as an item', { lines: [{ accountId: CASH, amount: 100 }], moneyAccountId: CASH }, 422],
      ['an item of zero', { lines: [{ accountId: RENT, amount: 0 }] }, 422],
      ['no party', { party: '' }, 422],
      ['no items', { lines: [] }, 422],
      ['full debit and credit lines', { lines: [{ accountId: RENT, debit: 100 }] }, 422],
    ])('refuses %s, saving nothing', async (_label, change, status) => {
      const before = await JournalVoucher.countDocuments();
      expect((await (await as('rahim')).post(PAYMENTS, { ...paymentFrom(bankId), ...change })).status).toBe(status);
      expect(await JournalVoucher.countDocuments()).toBe(before);
    });

    it('refuses an inactive money account', async () => {
      expect((await (await as('farhana')).patch(`${ACCOUNTS}/${bankId}`, { isActive: false })).status).toBe(200);
      const refused = await (await as('rahim')).post(PAYMENTS, paymentFrom(bankId));
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields[0].path).toBe('moneyAccountId');
    });
  });

  describe('a receipt', () => {
    it('debits the money account and credits what it was received for, numbered RV', async () => {
      const created = await (await as('rahim')).post(RECEIPTS, {
        voucherDate: '2026-11-12',
        memo: 'Client payment',
        party: 'Acme Ltd',
        moneyAccountId: CASH,
        lines: [{ accountId: RECEIVABLE, amount: 250_000 }],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        voucherType: 'receipt',
        number: 'RV-0001',
        lines: [
          { accountId: RECEIVABLE, debit: 0, credit: 250_000 },
          { accountId: CASH, debit: 250_000, credit: 0, memo: 'Received' },
        ],
      });
      await record(created.body.id);
      expect(await balanceOf(CASH)).toBe(250_000);
      expect(await balanceOf(RECEIVABLE)).toBe(-250_000);
    });
  });

  describe('editing a draft', () => {
    it('needs a reason, which is kept in the history', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYMENTS, paymentFrom(bankId));
      expect((await rahim.patch(`${PAYMENTS}/${created.body.id}`, { memo: 'Paying Desh Furniture, November' })).status).toBe(422);

      const edited = await rahim.patch(`${PAYMENTS}/${created.body.id}`, { memo: 'Paying Desh Furniture, November', reason: 'Named the month' });
      expect(edited.status).toBe(200);
      const history = await rahim.get(`${VOUCHERS}/${created.body.id}/history`);
      expect(history.body.entries[0]).toMatchObject({ action: 'updated', reason: 'Named the month', changes: [{ field: 'memo' }] });
    });

    it('rebuilds the lines from a new money account alone, keeping the items', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYMENTS, paymentFrom(bankId));
      const edited = await rahim.patch(`${PAYMENTS}/${created.body.id}`, { moneyAccountId: CASH, reason: 'Paid in cash after all' });
      expect(edited.status).toBe(200);
      expect(edited.body.moneyAccountId).toBe(CASH);
      expect(edited.body.lines).toEqual([
        { accountId: PAYABLE, debit: 1_800_000, credit: 0, memo: 'Bill DF-221' },
        { accountId: OFFICE_EXPENSES, debit: 1, credit: 0 },
        { accountId: CASH, debit: 0, credit: 1_800_001, memo: 'Paid out' },
      ]);
    });

    it('rebuilds the lines from new items, and removes a blank reference', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYMENTS, paymentFrom(bankId));
      const edited = await rahim.patch(`${PAYMENTS}/${created.body.id}`, { lines: [{ accountId: RENT, amount: 500 }], reference: '', reason: 'Wrong bill' });
      expect(edited.body.total).toBe(500);
      expect(edited.body.reference).toBeUndefined();
      expect(edited.body.lines).toHaveLength(2);
    });

    it('refuses editing a recorded payment with 409', async () => {
      await openBooks();
      const created = await (await as('rahim')).post(PAYMENTS, paymentFrom(bankId));
      await record(created.body.id);
      const refused = await (await as('rahim')).patch(`${PAYMENTS}/${created.body.id}`, { memo: 'Too late', reason: 'Typo' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('voucher_not_draft');
    });

    it('refuses editing one type on another type’s path', async () => {
      const rahim = await as('rahim');
      const payment = await rahim.post(PAYMENTS, paymentFrom(bankId));
      expect((await rahim.patch(`${VOUCHERS}/${payment.body.id}`, { memo: 'x', reason: 'Typo' })).body.error.code).toBe('wrong_voucher_type');
      expect((await rahim.patch(`${RECEIPTS}/${payment.body.id}`, { memo: 'x', reason: 'Typo' })).body.error.code).toBe('wrong_voucher_type');
    });

    it('leaves no change and no history when the new lines fail', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(PAYMENTS, paymentFrom(bankId));
      const historyBefore = await RecordHistory.countDocuments({ recordId: created.body.id });
      const refused = await rahim.patch(`${PAYMENTS}/${created.body.id}`, { lines: [{ accountId: 'la_none', amount: 5 }], reason: 'Typo' });
      expect(refused.status).toBe(422);
      expect((await JournalVoucher.findById(created.body.id).lean())?.total).toBe(1_800_001);
      expect(await RecordHistory.countDocuments({ recordId: created.body.id })).toBe(historyBefore);
    });
  });

  describe('listing', () => {
    it('filters by type, and searches the party', async () => {
      const rahim = await as('rahim');
      await rahim.post(PAYMENTS, paymentFrom(bankId));
      await rahim.post(VOUCHERS, { voucherDate: '2026-11-10', memo: 'Rent', lines: [{ accountId: RENT, debit: 100 }, { accountId: CASH, credit: 100 }] });

      expect((await rahim.get(`${VOUCHERS}?type=payment`)).body.vouchers.map((voucher: { number: string }) => voucher.number)).toEqual(['PV-0001']);
      expect((await rahim.get(`${VOUCHERS}?type=journal`)).body.vouchers.map((voucher: { number: string }) => voucher.number)).toEqual(['JV-0001']);
      expect((await rahim.get(`${VOUCHERS}?search=desh`)).body.total).toBe(1);
      expect((await rahim.get(`${VOUCHERS}?type=bill`)).status).toBe(422);
    });

    it('counts a voucher saved before types existed as a journal voucher', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(VOUCHERS, { voucherDate: '2026-11-10', memo: 'Rent', lines: [{ accountId: RENT, debit: 100 }, { accountId: CASH, credit: 100 }] });
      await JournalVoucher.collection.updateOne({ _id: created.body.id }, { $unset: { voucherType: 1 } });
      expect((await rahim.get(`${VOUCHERS}?type=journal`)).body.total).toBe(1);
      expect((await rahim.get(`${VOUCHERS}/${created.body.id}`)).body.voucherType).toBe('journal');
    });
  });

  describe('correcting a recorded payment', () => {
    it('refuses corrected lines that no longer pay from its money account', async () => {
      await openBooks();
      const created = await (await as('rahim')).post(PAYMENTS, { ...paymentFrom(bankId), lines: [{ accountId: PAYABLE, amount: 1_800_000 }] });
      await record(created.body.id);
      await AccessProfile.updateOne({ _id: 'ap_pv_accountant' }, { $set: { 'grants.accounts.updateRequest': { actions: ['read', 'create', 'approve'] } } });

      const refused = await (await as('rahim')).post('/accounts/update-requests', {
        recordType: 'journalVoucher',
        recordId: created.body.id,
        reason: 'Paid in cash',
        changes: { lines: [{ accountId: PAYABLE, debit: 1_800_000 }, { accountId: OPENING_EQUITY, credit: 1_800_000 }] },
      });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields[0].path).toBe('changes.lines');
    });
  });
});
