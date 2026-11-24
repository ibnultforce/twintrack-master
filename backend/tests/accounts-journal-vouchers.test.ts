import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { getTrialBalance, todayAsEntryDate } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { JournalVoucher } from '../src/modules/accounts/models/journalVoucher.js';
import { LedgerAccount } from '../src/modules/accounts/models/ledgerAccount.js';
import { LedgerEntry } from '../src/modules/accounts/models/ledgerEntry.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const BASE = '/accounts/journal-vouchers';
const CASH = 'la_1100';
const RENT = 'la_5300';

/** November's rent of 25,000.00, paid in cash. Amounts are in paisa. */
const rentVoucher = {
  voucherDate: '2026-11-02',
  memo: 'November office rent',
  lines: [
    { accountId: RENT, debit: 2_500_000 },
    { accountId: CASH, credit: 2_500_000 },
  ],
};

describe('journal vouchers', () => {
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
      // An accountant makes vouchers and may approve other people's.
      { _id: 'ap_jv_accountant', name: 'Accountant', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update', 'approve'] }, ledgerAccount: { actions: ['read'] } } } },
      // A clerk makes vouchers but can't approve.
      { _id: 'ap_jv_clerk', name: 'Clerk', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update'] } } } },
      { _id: 'ap_jv_auditor', name: 'Auditor', grants: { accounts: { journalVoucher: { actions: ['read'] }, auditLog: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_jv_accountant' });
    await addPerson('nadia', { profileId: 'ap_jv_accountant' });
    await addPerson('sumon', { profileId: 'ap_jv_clerk' });
    await addPerson('rumana', { profileId: 'ap_jv_auditor' });
    await addPerson('kamrul');
  });

  /** Makes a voucher as `maker` and submits it. Returns its id. */
  async function submittedVoucher(maker: string, body: object = rentVoucher): Promise<string> {
    const client = await as(maker);
    const created = await client.post(BASE, body);
    expect(created.status).toBe(201);
    expect((await client.post(`${BASE}/${created.body.id}/submit`)).status).toBe(200);
    return created.body.id as string;
  }

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch', string][] = [
      ['list', 'get', BASE],
      ['create', 'post', BASE],
      ['get', 'get', `${BASE}/jv_1`],
      ['update', 'patch', `${BASE}/jv_1`],
      ['submit', 'post', `${BASE}/jv_1/submit`],
      ['approve', 'post', `${BASE}/jv_1/approve`],
      ['return', 'post', `${BASE}/jv_1/return`],
      ['reverse', 'post', `${BASE}/jv_1/reverse`],
      ['history', 'get', `${BASE}/jv_1/history`],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused for someone with no Accounts access', async (_label, method, path) => {
      const kamrul = await as('kamrul');
      expect((await (method === 'get' ? kamrul.get(path) : kamrul[method](path, {}))).status).toBe(403);
    });

    it('a reader can list but not make vouchers', async () => {
      const rumana = await as('rumana');
      expect((await rumana.get(BASE)).status).toBe(200);
      expect((await rumana.post(BASE, rentVoucher)).status).toBe(403);
    });
  });

  describe('making a voucher', () => {
    it('saves a balanced draft with the next number, history and an activity log entry', async () => {
      const rahim = await as('rahim');
      const first = await rahim.post(BASE, rentVoucher);
      const second = await rahim.post(BASE, rentVoucher);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ number: 'JV-0001', status: 'draft', total: 2_500_000, createdBy: { id: 'rahim', name: 'Person rahim' } });
      expect(second.body.number).toBe('JV-0002');
      expect(await AuditLog.countDocuments({ action: 'journalVoucher.created', module: 'accounts' })).toBe(2);
      expect((await rahim.get(`${BASE}/${first.body.id}/history`)).body.entries[0].action).toBe('created');
    });

    it('refuses an unbalanced draft and saves nothing', async () => {
      const response = await (await as('rahim')).post(BASE, { ...rentVoucher, lines: [{ accountId: RENT, debit: 100 }, { accountId: CASH, credit: 99 }] });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('unbalanced_entry');
      expect(await JournalVoucher.countDocuments()).toBe(0);
    });

    it.each([
      ['a date that does not exist', { voucherDate: '2026-02-30' }],
      ['a fraction of a paisa', { lines: [{ accountId: RENT, debit: 1.5 }, { accountId: CASH, credit: 1.5 }] }],
      ['one line', { lines: [{ accountId: RENT, debit: 100 }] }],
      ['a group account', { lines: [{ accountId: 'la_5000', debit: 100 }, { accountId: CASH, credit: 100 }] }],
    ])('refuses %s', async (_label, change) => {
      expect((await (await as('rahim')).post(BASE, { ...rentVoucher, ...change })).status).toBe(422);
    });

    it('edits a draft, and refuses edits once it is submitted', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(BASE, rentVoucher);
      const edited = await rahim.patch(`${BASE}/${created.body.id}`, { memo: 'Rent for November', reason: 'Clearer memo', version: created.body.version });
      expect(edited.status).toBe(200);
      expect(edited.body.memo).toBe('Rent for November');

      await rahim.post(`${BASE}/${created.body.id}/submit`);
      const refused = await rahim.patch(`${BASE}/${created.body.id}`, { memo: 'Changed after submitting', reason: 'Late change' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('voucher_not_draft');
    });

    it('refuses an edit made from an old copy', async () => {
      const rahim = await as('rahim');
      const created = await rahim.post(BASE, rentVoucher);
      await rahim.patch(`${BASE}/${created.body.id}`, { memo: 'First edit', reason: 'Typo', version: 0 });
      expect((await rahim.patch(`${BASE}/${created.body.id}`, { memo: 'Second edit', reason: 'Typo', version: 0 })).status).toBe(409);
    });
  });

  describe('listing', () => {
    it('filters by month, by number or memo, and by status together', async () => {
      const rahim = await as('rahim');
      await rahim.post(BASE, { ...rentVoucher, voucherDate: '2026-10-31', memo: 'October office rent' });
      await rahim.post(BASE, rentVoucher);
      await rahim.post(BASE, { ...rentVoucher, voucherDate: '2026-11-30', memo: 'Internet bill' });
      const numbersFor = async (query: string) => (await rahim.get(`${BASE}?${query}`)).body.vouchers.map((voucher: { number: string }) => voucher.number);

      expect(await numbersFor('from=2026-11-01&to=2026-11-30')).toEqual(['JV-0003', 'JV-0002']);
      expect(await numbersFor('search=office')).toEqual(['JV-0002', 'JV-0001']);
      expect(await numbersFor('search=jv-0003')).toEqual(['JV-0003']);
      expect(await numbersFor('search=(')).toEqual([]);
      expect(await numbersFor('from=2026-11-01&search=rent&status=draft')).toEqual(['JV-0002']);
    });

    it('refuses a date range that ends before it starts', async () => {
      const response = await (await as('rahim')).get(`${BASE}?from=2026-11-30&to=2026-11-01`);
      expect(response.status).toBe(422);
    });
  });

  describe('approving', () => {
    it('records an approved voucher in the ledger, traced back to it, with every step in the activity log', async () => {
      const voucherId = await submittedVoucher('rahim');
      const approved = await (await as('nadia')).post(`${BASE}/${voucherId}/approve`);

      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'recorded', approvedBy: { id: 'nadia' } });
      const entry = await LedgerEntry.findById(approved.body.ledgerEntryId).lean();
      expect(entry).toMatchObject({ entryDate: '2026-11-02', source: { type: 'journalVoucher', id: voucherId }, total: 2_500_000 });

      const trialBalance = await getTrialBalance();
      expect(trialBalance.difference).toBe(0);
      expect(trialBalance.rows.map(({ code, balance }) => [code, balance])).toEqual([['1100', -2_500_000], ['5300', 2_500_000]]);

      const actions = (await AuditLog.find({ module: 'accounts' }).sort({ at: 1, _id: 1 }).lean()).map((entry) => entry.action);
      expect(actions).toEqual(['journalVoucher.created', 'journalVoucher.submitted', 'ledgerEntry.posted', 'journalVoucher.approved']);
    });

    it('refuses the maker, even when their profile may approve other vouchers', async () => {
      const voucherId = await submittedVoucher('rahim');
      const refused = await (await as('rahim')).post(`${BASE}/${voucherId}/approve`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('own_record');
      expect(await LedgerEntry.countDocuments()).toBe(0);
    });

    it('refuses a super admin approving their own voucher', async () => {
      const voucherId = await submittedVoucher('farhana');
      const refused = await (await as('farhana')).post(`${BASE}/${voucherId}/approve`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('own_record');
    });

    it('refuses someone who can read vouchers but not approve them', async () => {
      const voucherId = await submittedVoucher('rahim');
      const refused = await (await as('rumana')).post(`${BASE}/${voucherId}/approve`);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('forbidden');
    });

    it('refuses a draft that has not been submitted', async () => {
      const created = await (await as('rahim')).post(BASE, rentVoucher);
      const refused = await (await as('nadia')).post(`${BASE}/${created.body.id}/approve`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('voucher_not_submitted');
    });

    it('records nothing when the ledger refuses the entry, and leaves the voucher waiting', async () => {
      const voucherId = await submittedVoucher('rahim');
      await LedgerAccount.updateOne({ _id: RENT }, { $set: { isActive: false } });
      const refused = await (await as('nadia')).post(`${BASE}/${voucherId}/approve`);
      expect(refused.status).toBe(422);
      expect(await LedgerEntry.countDocuments()).toBe(0);
      expect((await JournalVoucher.findById(voucherId).lean())?.status).toBe('submitted');
    });

    it('lets only one of two approvals made at the same time record the voucher', async () => {
      const voucherId = await submittedVoucher('rahim');
      const [nadia, farhana] = [await as('nadia'), await as('farhana')];
      const results = await Promise.all([nadia.post(`${BASE}/${voucherId}/approve`), farhana.post(`${BASE}/${voucherId}/approve`)]);
      expect(results.filter((result) => result.status === 200)).toHaveLength(1);
      expect(await LedgerEntry.countDocuments()).toBe(1);
    });

    it('tells each person which buttons will work', async () => {
      const voucherId = await submittedVoucher('rahim');
      expect((await (await as('rahim')).get(`${BASE}/${voucherId}`)).body.allowedActions).toEqual({ edit: false, submit: false, approve: false, return: false, reverse: false, requestCorrection: false });
      expect((await (await as('nadia')).get(`${BASE}/${voucherId}`)).body.allowedActions).toMatchObject({ approve: true, return: true });
      expect((await (await as('rumana')).get(`${BASE}/${voucherId}`)).body.allowedActions).toMatchObject({ approve: false });
    });
  });

  describe('the stand-in approver', () => {
    it('may approve without the approve permission while named in Settings, and not after the end date', async () => {
      const farhana = await as('farhana');
      const first = await submittedVoucher('rahim');
      expect((await farhana.patch('/accounts/settings', { standInApproverId: 'rumana', standInUntil: '2999-12-31' })).status).toBe(200);
      expect((await (await as('rumana')).post(`${BASE}/${first}/approve`)).status).toBe(200);

      const second = await submittedVoucher('rahim');
      await farhana.patch('/accounts/settings', { standInUntil: '2020-01-01' });
      expect((await (await as('rumana')).post(`${BASE}/${second}/approve`)).status).toBe(403);
    });

    it('still may not approve their own voucher', async () => {
      await (await as('farhana')).patch('/accounts/settings', { standInApproverId: 'sumon' });
      const voucherId = await submittedVoucher('sumon');
      const refused = await (await as('sumon')).post(`${BASE}/${voucherId}/approve`);
      expect(refused.body.error.code).toBe('own_record');
    });
  });

  describe('returning to the maker', () => {
    it('sends it back as a draft with a note, which goes when it is submitted again', async () => {
      const voucherId = await submittedVoucher('rahim');
      const nadia = await as('nadia');
      expect((await nadia.post(`${BASE}/${voucherId}/return`, {})).status).toBe(422);
      const returned = await nadia.post(`${BASE}/${voucherId}/return`, { note: 'Attach the rent receipt number to the memo.' });
      expect(returned.body).toMatchObject({ status: 'draft', returnNote: 'Attach the rent receipt number to the memo.' });

      const rahim = await as('rahim');
      await rahim.patch(`${BASE}/${voucherId}`, { memo: 'November office rent, receipt 4471', reason: 'Added the receipt number' });
      const resubmitted = await rahim.post(`${BASE}/${voucherId}/submit`);
      expect(resubmitted.body.status).toBe('submitted');
      expect(resubmitted.body.returnNote).toBeUndefined();
    });

    it('refuses the maker returning their own voucher', async () => {
      const voucherId = await submittedVoucher('rahim');
      expect((await (await as('rahim')).post(`${BASE}/${voucherId}/return`, { note: 'Never mind' })).body.error.code).toBe('own_record');
    });
  });

  describe('reversing', () => {
    it('cancels a recorded voucher in the ledger, so every account it touched is back to zero', async () => {
      const voucherId = await submittedVoucher('rahim');
      const nadia = await as('nadia');
      await nadia.post(`${BASE}/${voucherId}/approve`);

      const reversed = await nadia.post(`${BASE}/${voucherId}/reverse`, { memo: 'Rent was paid from the bank, not cash' });
      expect(reversed.status).toBe(200);
      expect(reversed.body).toMatchObject({ status: 'reversed', reversedBy: { id: 'nadia' } });
      const reversal = await LedgerEntry.findById(reversed.body.reversalEntryId).lean();
      expect(reversal).toMatchObject({ entryDate: todayAsEntryDate(), memo: 'Rent was paid from the bank, not cash', reversalOf: reversed.body.ledgerEntryId });

      const trialBalance = await getTrialBalance();
      expect(trialBalance.difference).toBe(0);
      expect(trialBalance.rows.every((row) => row.balance === 0)).toBe(true);
      expect(await AuditLog.exists({ action: 'journalVoucher.reversed', targetId: voucherId })).toBeTruthy();
    });

    it("refuses the maker, a voucher that isn't recorded, and a second reversal", async () => {
      const voucherId = await submittedVoucher('rahim');
      const nadia = await as('nadia');
      expect((await nadia.post(`${BASE}/${voucherId}/reverse`)).body.error.code).toBe('voucher_not_recorded');
      await nadia.post(`${BASE}/${voucherId}/approve`);
      expect((await (await as('rahim')).post(`${BASE}/${voucherId}/reverse`)).body.error.code).toBe('own_record');
      expect((await nadia.post(`${BASE}/${voucherId}/reverse`)).status).toBe(200);
      expect((await nadia.post(`${BASE}/${voucherId}/reverse`)).status).toBe(409);
      expect(await LedgerEntry.countDocuments()).toBe(2);
    });
  });

  describe('the Accounts activity log', () => {
    it('lists only what Accounts wrote, newest first, for people with the permission', async () => {
      const voucherId = await submittedVoucher('rahim');
      await (await as('nadia')).post(`${BASE}/${voucherId}/approve`);

      const response = await (await as('rumana')).get('/accounts/audit-log');
      expect(response.status).toBe(200);
      expect(response.body.entries.every((entry: { module: string }) => entry.module === 'accounts')).toBe(true);
      expect(response.body.entries[0]).toMatchObject({ action: 'journalVoucher.approved', actorId: 'nadia', targetId: voucherId });
      expect(await AuditLog.exists({ module: { $ne: 'accounts' } })).toBeTruthy();

      const filtered = await (await as('rumana')).get('/accounts/audit-log').query({ actionPrefix: 'ledgerEntry.' });
      expect(filtered.body.entries.map((entry: { action: string }) => entry.action)).toEqual(['ledgerEntry.posted']);

      expect((await (await as('sumon')).get('/accounts/audit-log')).status).toBe(403);
    });
  });
});
