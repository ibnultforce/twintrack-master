import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Client } from '../src/modules/master/models/client.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const VOUCHERS = '/accounts/journal-vouchers';
const INVOICES = '/accounts/invoices';
const CASH = 'la_1100';
const RECEIVABLE = 'la_1300';
const OPENING_EQUITY = 'la_3900';
const RENT = 'la_5300';
const OFFICE = 'la_5500';

describe('general ledger, trial balance and client accounts', () => {
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
      { _id: 'ap_lr_reader', name: 'Books reader', grants: { accounts: { ledgerAccount: { actions: ['read'] }, invoice: { actions: ['read'] } } } },
      { _id: 'ap_lr_none', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
      { _id: 'ap_lr_approver', name: 'Approver', grants: { accounts: { journalVoucher: { actions: ['read', 'approve'] }, invoice: { actions: ['read', 'approve'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rita', { profileId: 'ap_lr_reader' });
    await addPerson('rumana', { profileId: 'ap_lr_none' });
    await addPerson('nadia', { profileId: 'ap_lr_approver' });
  });

  /** Makes, submits and has nadia approve a voucher. Returns its id. */
  async function record(voucherDate: string, memo: string, lines: [string, number, number][]) {
    const farhana = await as('farhana');
    const created = await farhana.post(VOUCHERS, { voucherDate, memo, lines: lines.map(([accountId, debit, credit]) => ({ accountId, debit, credit })) });
    await farhana.post(`${VOUCHERS}/${created.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  it('needs a session and the read permission', async () => {
    for (const path of ['/accounts/general-ledger', '/accounts/trial-balance', '/accounts/client-accounts', '/accounts/client-accounts/cl_1']) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await (await as('rumana')).get(path)).status).toBe(403);
    }
  });

  it('the Day 4 gate: each account in the general ledger closes on its trial balance figure, with a running balance', async () => {
    await record('2026-10-31', 'Opening cash', [[CASH, 10_000_000, 0], [OPENING_EQUITY, 0, 10_000_000]]);
    const rentId = await record('2026-11-02', 'November rent', [[RENT, 2_500_000, 0], [CASH, 0, 2_500_000]]);
    await record('2026-11-05', 'Stationery', [[OFFICE, 12_345, 0], [CASH, 0, 12_345]]);
    expect((await (await as('farhana')).post(`${VOUCHERS}/${rentId}/reverse`, {})).status).toBe(403);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${rentId}/reverse`, {})).status).toBe(200);
    const rita = await as('rita');

    const ledger = await rita.get(`/accounts/general-ledger?accountId=${CASH}&from=2026-11-01&to=2099-12-31`);
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({ account: { code: '1100', normalBalance: 'debit' }, opening: 10_000_000, totalDebit: 2_500_000, totalCredit: 2_512_345, closing: 9_987_655, total: 3 });
    expect(ledger.body.lines.map((line: { debit: number; credit: number; balance: number }) => [line.debit, line.credit, line.balance])).toEqual([
      [0, 2_500_000, 7_500_000],
      [0, 12_345, 7_487_655],
      [2_500_000, 0, 9_987_655],
    ]);
    expect(ledger.body.lines[0].source).toMatchObject({ type: 'journalVoucher', number: 'JV-0002' });
    expect(ledger.body.lines[2].isReversal).toBe(true);

    // Page 2 carries the running balance on from page 1.
    const secondPage = await rita.get(`/accounts/general-ledger?accountId=${CASH}&from=2026-11-01&to=2099-12-31&page=2&pageSize=2`);
    expect(secondPage.body.lines).toEqual([expect.objectContaining({ balance: 9_987_655 })]);

    const trial = await rita.get('/accounts/trial-balance');
    expect(trial.body.difference).toBe(0);
    for (const row of trial.body.rows as { accountId: string; balance: number }[]) {
      const accountLedger = await rita.get(`/accounts/general-ledger?accountId=${row.accountId}&from=1900-01-01&to=2099-12-31`);
      expect(accountLedger.body.closing).toBe(row.balance);
    }
    expect((await rita.get('/accounts/trial-balance?to=2026-10-31')).body.rows).toEqual([
      expect.objectContaining({ code: '1100', balance: 10_000_000 }),
      expect.objectContaining({ code: '3900', balance: -10_000_000 }),
    ]);
  });

  it('refuses an unknown account and a range that ends before it starts', async () => {
    const rita = await as('rita');
    expect((await rita.get('/accounts/general-ledger?accountId=la_none&from=2026-11-01&to=2026-11-30')).status).toBe(404);
    expect((await rita.get(`/accounts/general-ledger?accountId=${CASH}&from=2026-11-30&to=2026-11-01`)).status).toBe(422);
  });

  it("a client's balance equals their unpaid invoices, with ageing, and a statement that closes on it", async () => {
    await Client.create([{ _id: 'cl_hope', name: 'Hope Foundation', status: 'active', version: 0 }, { _id: 'cl_none', name: 'No invoices', status: 'active', version: 0 }]);
    const farhana = await as('farhana');
    const issue = async (issueDate: string, dueDate: string, amount: number) => {
      const created = await farhana.post(INVOICES, { clientId: 'cl_hope', issueDate, dueDate, items: [{ description: 'Work', amount }] });
      await farhana.post(`${INVOICES}/${created.body.id}/submit`);
      expect((await (await as('nadia')).post(`${INVOICES}/${created.body.id}/approve`)).status).toBe(200);
      return created.body.id as string;
    };
    const paidInFull = await issue('2026-09-01', '2026-09-15', 1_000_000);
    const partPaid = await issue('2026-10-01', '2026-10-10', 2_000_000);
    await issue('2026-11-20', '2099-12-31', 3_000_000);
    for (const [invoiceId, amount, date] of [[paidInFull, 1_000_000, '2026-09-11'], [partPaid, 500_000, '2026-10-20']] as const) {
      const receipt = await farhana.post(`${INVOICES}/${invoiceId}/receive-payment`, { receivedDate: date, moneyAccountId: CASH, amount });
      await farhana.post(`${VOUCHERS}/${receipt.body.id}/submit`);
      expect((await (await as('nadia')).post(`${VOUCHERS}/${receipt.body.id}/approve`)).status).toBe(200);
    }

    const rita = await as('rita');
    const accounts = await rita.get('/accounts/client-accounts');
    expect(accounts.body.clients).toHaveLength(1);
    const hope = accounts.body.clients[0];
    expect(hope).toMatchObject({ clientName: 'Hope Foundation', billed: 6_000_000, received: 1_500_000, outstanding: 4_500_000, overdueCount: 1, rating: 'watch', lastPayment: '2026-10-20', averageDaysToPay: 10 });
    expect(hope.ageing.notYetDue).toBe(3_000_000);
    expect(hope.ageing.days1To30 + hope.ageing.days31To60 + hope.ageing.over60).toBe(1_500_000);
    // The ledger agrees: what clients owe sits in receivables.
    const receivable = (await rita.get('/accounts/trial-balance')).body.rows.find((row: { accountId: string }) => row.accountId === RECEIVABLE);
    expect(receivable.balance).toBe(accounts.body.totals.outstanding);

    const statement = await rita.get('/accounts/client-accounts/cl_hope');
    expect(statement.body.lines.map((line: { kind: string; balance: number }) => [line.kind, line.balance])).toEqual([
      ['invoice', 1_000_000], ['receipt', 0], ['invoice', 2_000_000], ['receipt', 1_500_000], ['invoice', 4_500_000],
    ]);
    expect(statement.body.outstanding).toBe(4_500_000);
    expect((await rita.get('/accounts/client-accounts/cl_nobody')).status).toBe(404);
  });
});
