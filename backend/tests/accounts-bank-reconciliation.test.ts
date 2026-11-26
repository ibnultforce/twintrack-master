import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { parseAmount, parseStatementCsv, parseStatementDate, splitCsvRow } from '../src/modules/accounts/bankReconciliation/statementCsv.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const BASE = '/accounts/bank-reconciliations';
const VOUCHERS = '/accounts/journal-vouchers';
const OPENING_EQUITY = 'la_3900';
const RENT = 'la_5300';
const OFFICE = 'la_5500';
const BANK_CHARGES = 'la_5700';
const RECEIVABLE = 'la_1300';
const SALARIES = 'la_5100';

/** The sample statement kept in the repository for the Day 4 gate: City Bank, November 2026. */
const SAMPLE_CSV = readFileSync(fileURLToPath(new URL('../../docs/samples/city-bank-statement-november-2026.csv', import.meta.url)), 'utf8');

describe('bank reconciliation and office expenses', () => {
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
      { _id: 'ap_br_clerk', name: 'Bank clerk', grants: { accounts: { bankReconciliation: { actions: ['read', 'create', 'update'] }, ledgerAccount: { actions: ['read'] } } } },
      { _id: 'ap_br_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] } } } },
      { _id: 'ap_br_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_br_clerk' });
    await addPerson('nadia', { profileId: 'ap_br_approver' });
    await addPerson('rumana', { profileId: 'ap_br_none' });
    const bank = await (await as('farhana')).post('/accounts/ledger-accounts', { code: '1210', name: 'City Bank, current', type: 'asset', parentId: 'la_1200', cashOrBank: 'bank', bankName: 'City Bank' });
    bankId = bank.body.id as string;
  });

  /** Records a voucher with the bank on one side: positive amounts are money in. */
  async function bankEntry(voucherDate: string, memo: string, otherAccount: string, amount: number) {
    const farhana = await as('farhana');
    const lines = amount > 0
      ? [{ accountId: bankId, debit: amount }, { accountId: otherAccount, credit: amount }]
      : [{ accountId: otherAccount, debit: -amount }, { accountId: bankId, credit: -amount }];
    const created = await farhana.post(VOUCHERS, { voucherDate, memo, lines });
    await farhana.post(`${VOUCHERS}/${created.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  async function bookNovember() {
    await bankEntry('2026-11-01', 'Opening deposit', OPENING_EQUITY, 5_000_000);
    await bankEntry('2026-11-02', 'November rent', RENT, -2_500_000);
    // The cheque cleared a day before the books recorded it.
    await bankEntry('2026-11-06', 'Desh Furniture', OFFICE, -1_800_000);
    await bankEntry('2026-11-20', 'Acme Ltd payment', RECEIVABLE, 1_250_050);
    // Written on the 29th, not yet presented at the bank.
    await bankEntry('2026-11-29', 'Cheque to a supplier', OFFICE, -300_000);
  }

  const importSample = async () => (await as('rahim')).post(BASE, { accountId: bankId, from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1_892_550, csv: SAMPLE_CSV, fileName: 'city-bank-november.csv' });

  describe('reading a bank CSV', () => {
    it('splits quoted cells, reads amounts and day-first dates', () => {
      expect(splitCsvRow('a,"Desh, Ltd","say ""hi"""')).toEqual(['a', 'Desh, Ltd', 'say "hi"']);
      expect(parseAmount('"1,23,456.50"'.replace(/"/g, ''))).toBe(12_345_650);
      expect(parseAmount('(500)')).toBe(-50_000);
      expect(parseAmount('')).toBeUndefined();
      expect(parseAmount('12.345')).toBeNaN();
      expect(parseStatementDate('03/11/2026')).toBe('2026-11-03');
      expect(parseStatementDate('2026-11-03')).toBe('2026-11-03');
      expect(parseStatementDate('31/02/2026')).toBeUndefined();
    });

    it('reads the sample with debit and credit columns, money in positive', () => {
      const lines = parseStatementCsv(SAMPLE_CSV);
      expect(lines.map((line) => line.amount)).toEqual([5_000_000, -2_500_000, -1_800_000, 1_250_050, -57_500]);
      expect(lines[1]).toMatchObject({ date: '2026-11-02', reference: '004511' });
    });

    it('reads a single signed amount column, and names the bad row', () => {
      expect(parseStatementCsv('Date,Narration,Amount\n2026-11-01,In,100.00\n2026-11-02,Out,-40').map((line) => line.amount)).toEqual([10_000, -4_000]);
      expect(() => parseStatementCsv('Date,Narration,Amount\n2026-11-01,In,abc')).toThrow(/Row 2/);
      expect(() => parseStatementCsv('When,Narration,Amount\n2026-11-01,In,1')).toThrow(/no Date column/);
    });
  });

  it('needs a session and the permission', async () => {
    for (const [method, path] of [['get', BASE], ['post', BASE], ['get', `${BASE}/bs_1`], ['post', `${BASE}/bs_1/lines/sl_1/match`], ['post', `${BASE}/bs_1/lines/sl_1/unmatch`], ['post', `${BASE}/bs_1/rematch`], ['post', `${BASE}/bs_1/complete`], ['get', '/accounts/office-expenses?from=2026-11-01&to=2026-11-30']] as const) {
      expect((await request(app)[method](path).send({})).status).toBe(401);
      expect((await (await as('rumana'))[method](path, {})).status).toBe(403);
    }
  });

  it('the Day 4 gate: the sample CSV reconciles with no difference once the bank charge is recorded', async () => {
    await bookNovember();
    const imported = await importSample();
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ number: 'BR-0001', status: 'open', canComplete: false });
    // Four lines match on amount, the furniture cheque a day apart; the bank charge isn't in the books yet.
    expect(imported.body.summary).toMatchObject({ matchedCount: 4, unmatchedCount: 1, bookBalance: 1_650_050, inBankNotBooks: -57_500, inBooksNotBank: -300_000 });
    expect(imported.body.unmatchedBookItems).toEqual([expect.objectContaining({ memo: expect.stringContaining('Cheque to a supplier'), amount: -300_000 })]);
    const rahim = await as('rahim');
    expect((await rahim.post(`${BASE}/${imported.body.id}/complete`, {})).body.error.code).toBe('statement_has_unmatched_lines');

    await bankEntry('2026-11-30', 'Bank charge, November', BANK_CHARGES, -57_500);
    const rematched = await rahim.post(`${BASE}/${imported.body.id}/rematch`, {});
    expect(rematched.body.summary).toMatchObject({ unmatchedCount: 0, difference: 0, adjustedBookBalance: 1_892_550 });
    expect(rematched.body.canComplete).toBe(true);

    const done = await rahim.post(`${BASE}/${imported.body.id}/complete`, {});
    expect(done.body).toMatchObject({ status: 'reconciled', reconciledBy: { id: 'rahim' } });
    expect((await rahim.post(`${BASE}/${imported.body.id}/rematch`, {})).body.error.code).toBe('statement_reconciled');
    expect((await rahim.get(BASE)).body.lastReconciled).toEqual({ [bankId]: '2026-11-30' });
  });

  it('carries a cheque not yet presented to the next month, and leaves the reconciled month as it was', async () => {
    await bookNovember();
    await bankEntry('2026-11-30', 'Bank charge, November', BANK_CHARGES, -57_500);
    const rahim = await as('rahim');
    const november = await importSample();
    expect((await rahim.post(`${BASE}/${november.body.id}/complete`, {})).status).toBe(200);

    // The supplier's cheque written on 29 November reaches the bank on 3 December.
    const decemberCsv = 'Date,Description,Cheque No,Debit,Credit,Balance\n03/12/2026,Supplier cheque,004514,"3,000.00",,"15,925.50"\n';
    const december = await rahim.post(BASE, { accountId: bankId, from: '2026-12-01', to: '2026-12-31', openingBalance: 1_892_550, closingBalance: 1_592_550, csv: decemberCsv });
    expect(december.status).toBe(201);
    expect(december.body.lines[0]).toMatchObject({ matchedEntry: { date: '2026-11-29' } });
    expect(december.body.summary).toMatchObject({ unmatchedCount: 0, inBooksNotBank: 0, difference: 0 });
    expect(december.body.unmatchedBookItems).toEqual([]);
    expect(december.body.canComplete).toBe(true);

    // November still shows the cheque as not yet at the bank on 30 November, and still has no difference.
    const novemberAgain = await rahim.get(`${BASE}/${november.body.id}`);
    expect(novemberAgain.body.summary).toMatchObject({ inBooksNotBank: -300_000, difference: 0 });
  });

  it('matches a transfer between two bank accounts on each account\'s statement', async () => {
    const farhana = await as('farhana');
    const savings = await farhana.post('/accounts/ledger-accounts', { code: '1220', name: 'City Bank, savings', type: 'asset', parentId: 'la_1200', cashOrBank: 'bank', bankName: 'City Bank' });
    await bankEntry('2026-11-01', 'Opening deposit', OPENING_EQUITY, 5_000_000);
    await bankEntry('2026-11-10', 'To savings', savings.body.id as string, -1_000_000);
    const rahim = await as('rahim');
    const header = 'Date,Description,Cheque No,Debit,Credit,Balance\n';
    const current = await rahim.post(BASE, { accountId: bankId, from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 4_000_000, csv: `${header}01/11/2026,Deposit,,,"50,000.00","50,000.00"\n10/11/2026,To savings,,"10,000.00",,"40,000.00"\n` });
    const saving = await rahim.post(BASE, { accountId: savings.body.id, from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1_000_000, csv: `${header}10/11/2026,From current,,,"10,000.00","10,000.00"\n` });
    expect(current.body.summary).toMatchObject({ unmatchedCount: 0, difference: 0 });
    expect(saving.body.summary).toMatchObject({ unmatchedCount: 0, difference: 0 });
  });

  it('refuses a statement that does not add up, a line outside the period, and a non-bank account', async () => {
    const rahim = await as('rahim');
    expect((await rahim.post(BASE, { accountId: bankId, from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1, csv: SAMPLE_CSV })).body.error.code).toBe('statement_does_not_add_up');
    expect((await rahim.post(BASE, { accountId: bankId, from: '2026-11-02', to: '2026-11-30', openingBalance: 0, closingBalance: 1_892_550, csv: SAMPLE_CSV })).body.error.code).toBe('invalid_statement');
    expect((await rahim.post(BASE, { accountId: RENT, from: '2026-11-01', to: '2026-11-30', openingBalance: 0, closingBalance: 1_892_550, csv: SAMPLE_CSV })).status).toBe(422);
  });

  it('matches and unmatches by hand, only for the same amount and an entry not used elsewhere', async () => {
    await bookNovember();
    const imported = await importSample();
    const rahim = await as('rahim');
    const rentLine = imported.body.lines.find((line: { amount: number }) => line.amount === -2_500_000);
    const unmatched = await rahim.post(`${BASE}/${imported.body.id}/lines/${rentLine.id}/unmatch`, {});
    expect(unmatched.body.summary.matchedCount).toBe(3);
    const chargeLine = imported.body.lines.find((line: { amount: number }) => line.amount === -57_500);
    expect((await rahim.post(`${BASE}/${imported.body.id}/lines/${chargeLine.id}/match`, { entryId: rentLine.matchedEntryId })).status).toBe(422);
    const rematchedByHand = await rahim.post(`${BASE}/${imported.body.id}/lines/${rentLine.id}/match`, { entryId: rentLine.matchedEntryId });
    expect(rematchedByHand.body.summary.matchedCount).toBe(4);
    const otherLine = imported.body.lines.find((line: { amount: number }) => line.amount === 5_000_000);
    expect((await rahim.post(`${BASE}/${imported.body.id}/lines/${otherLine.id}/match`, { entryId: rentLine.matchedEntryId })).body.error.code).toBe('line_matched');
  });

  it('lists office running costs by account from the ledger, leaving out people costs and reversals netting out', async () => {
    await bookNovember();
    await bankEntry('2026-11-30', 'November salaries', SALARIES, -100_000);
    const rentId = await bankEntry('2026-11-03', 'Rent, booked twice', RENT, -2_500_000);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${rentId}/reverse`, {})).status).toBe(200);
    const expenses = await (await as('rahim')).get('/accounts/office-expenses?from=2026-11-01&to=2099-12-31');
    expect(expenses.status).toBe(200);
    expect(expenses.body.categories.map((category: { code: string; amount: number }) => [category.code, category.amount])).toEqual([['5300', 2_500_000], ['5500', 2_100_000]]);
    expect(expenses.body.total).toBe(4_600_000);
    expect(expenses.body.lines.some((line: { accountId: string }) => line.accountId === SALARIES)).toBe(false);
  });
});
