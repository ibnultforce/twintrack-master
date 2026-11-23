import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { findAccountBalance } from '../src/modules/accounts/ledger/ledger.repository.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { LedgerEntry } from '../src/modules/accounts/models/ledgerEntry.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const REQUESTS = '/accounts/update-requests';
const VOUCHERS = '/accounts/journal-vouchers';
const CASH = 'la_1100';
const BANK = 'la_1200';
const RENT = 'la_5300';

/** November's rent, ৳25,000, recorded as paid in cash. */
const rentInCash = {
  voucherDate: '2026-11-02',
  memo: 'November office rent',
  lines: [{ accountId: RENT, debit: 2_500_000 }, { accountId: CASH, credit: 2_500_000 }],
};

/** The correction: it was ৳26,000, paid from the bank. */
const rentFromBank = [{ accountId: RENT, debit: 2_600_000 }, { accountId: BANK, credit: 2_600_000 }];

describe('update requests', () => {
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
        _id: 'ap_ur_accountant', name: 'Accountant',
        grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update', 'approve'] }, updateRequest: { actions: ['read', 'create', 'approve'] } } },
      },
      { _id: 'ap_ur_clerk', name: 'Clerk', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update'] }, updateRequest: { actions: ['read', 'create'] } } } },
      { _id: 'ap_ur_requests_only', name: 'Requests only', grants: { accounts: { updateRequest: { actions: ['read', 'create'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_ur_accountant' });
    await addPerson('nadia', { profileId: 'ap_ur_accountant' });
    await addPerson('sumon', { profileId: 'ap_ur_clerk' });
    await addPerson('ruma', { profileId: 'ap_ur_requests_only' });
    await addPerson('kamrul');
  });

  /** Rahim makes and submits the voucher, Nadia approves it, so it is recorded in the ledger. */
  async function recordedVoucher(body: object = rentInCash): Promise<string> {
    const rahim = await as('rahim');
    const created = await rahim.post(VOUCHERS, body);
    await rahim.post(`${VOUCHERS}/${created.body.id}/submit`);
    expect((await (await as('nadia')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(200);
    return created.body.id as string;
  }

  const askToCorrect = async (asPerson: string, voucherId: string, changes: object = { lines: rentFromBank }) =>
    (await as(asPerson)).post(REQUESTS, { recordType: 'journalVoucher', recordId: voucherId, reason: 'The rent was ৳26,000, paid from the bank', changes });

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post', string][] = [
      ['list', 'get', REQUESTS],
      ['create', 'post', REQUESTS],
      ['get', 'get', `${REQUESTS}/ur_1`],
      ['approve', 'post', `${REQUESTS}/ur_1/approve`],
      ['reject', 'post', `${REQUESTS}/ur_1/reject`],
      ['change history', 'get', '/accounts/change-history'],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused for someone with no Accounts access', async (_label, method, path) => {
      const kamrul = await as('kamrul');
      expect((await (method === 'get' ? kamrul.get(path) : kamrul.post(path, {}))).status).toBe(403);
    });

    it("refuses a request from someone who can't see vouchers", async () => {
      const voucherId = await recordedVoucher();
      expect((await askToCorrect('ruma', voucherId)).status).toBe(403);
    });

    it("shows no voucher details to someone who can read requests but not vouchers", async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      const ruma = await as('ruma');
      expect((await ruma.get(REQUESTS)).body).toMatchObject({ total: 0, requests: [], summary: { waiting: 0 } });
      expect((await ruma.get(`${REQUESTS}/${asked.body.id}`)).status).toBe(403);
      expect((await ruma.post(`${REQUESTS}/${asked.body.id}/reject`, { note: 'No' })).status).toBe(403);
      expect((await ruma.get('/accounts/approvals')).body).toMatchObject({ waitingForYou: { total: 0 }, yoursWaiting: { total: 0 } });
      await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/approve`);
      expect((await ruma.get('/accounts/change-history')).body.entries).toEqual([]);
    });
  });

  describe('the Day 2 gate: a recorded voucher is corrected through a reversal', () => {
    it('changes nothing until someone else approves, then reverses the old entry and records the corrected one', async () => {
      const voucherId = await recordedVoucher();
      const original = (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}`)).body;
      expect(original.allowedActions.requestCorrection).toBe(true);

      const asked = await askToCorrect('rahim', voucherId);
      expect(asked.status).toBe(201);
      expect(asked.body).toMatchObject({
        number: 'UR-0001', status: 'waiting', recordNumber: 'JV-0001',
        before: { total: 2_500_000, lines: [{ accountId: RENT, debit: 2_500_000, credit: 0 }, { accountId: CASH, debit: 0, credit: 2_500_000 }] },
        after: { voucherDate: '2026-11-02', memo: 'November office rent', total: 2_600_000 },
        createdBy: { id: 'rahim' },
      });
      // Waiting: the books still say cash.
      expect(await findAccountBalance(CASH)).toBe(-2_500_000);

      const own = await (await as('rahim')).post(`${REQUESTS}/${asked.body.id}/approve`);
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe('own_record');
      expect((await (await as('rahim')).get(`${REQUESTS}/${asked.body.id}`)).body.allowedActions).toEqual({ approve: false, reject: false });
      expect((await (await as('nadia')).get(`${REQUESTS}/${asked.body.id}`)).body.allowedActions).toEqual({ approve: true, reject: true });

      const applied = await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/approve`);
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ status: 'applied', decidedBy: { id: 'nadia' } });

      // The voucher keeps its number and stays recorded, with the corrected lines and a new ledger entry.
      const corrected = (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}`)).body;
      expect(corrected).toMatchObject({ number: 'JV-0001', status: 'recorded', total: 2_600_000, ledgerEntryId: applied.body.correctedEntryId });
      expect(corrected.ledgerEntryId).not.toBe(original.ledgerEntryId);

      // The ledger keeps the mistake, its reversal and the fix.
      const oldEntry = await LedgerEntry.findById(original.ledgerEntryId).lean();
      expect(oldEntry?.reversedBy).toBe(applied.body.reversalEntryId);
      expect(await findAccountBalance(CASH)).toBe(0);
      expect(await findAccountBalance(BANK)).toBe(-2_600_000);
      expect(await findAccountBalance(RENT)).toBe(2_600_000);
      expect((await getTrialBalance()).difference).toBe(0);

      // The voucher's own history shows the old and new values.
      const history = (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}/history`)).body.entries;
      expect(history[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'total', from: 2_500_000, to: 2_600_000 })]));
      expect(await AuditLog.exists({ action: 'journalVoucher.corrected', targetId: voucherId })).toBeTruthy();
      expect(await AuditLog.exists({ action: 'updateRequest.applied', targetId: asked.body.id })).toBeTruthy();
    });

    it('lets a super admin approve someone else\'s request, but never their own', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('farhana', voucherId);
      expect((await (await as('farhana')).post(`${REQUESTS}/${asked.body.id}/approve`)).status).toBe(403);
      expect((await (await as('rahim')).post(`${REQUESTS}/${asked.body.id}/approve`)).status).toBe(200);
    });

    it("refuses someone who can't approve update requests", async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      expect((await (await as('sumon')).post(`${REQUESTS}/${asked.body.id}/approve`)).status).toBe(403);
    });

    it('can change only the date or memo, which keeps the amounts', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId, { voucherDate: '2026-11-01' });
      expect(asked.body.after).toMatchObject({ voucherDate: '2026-11-01', total: 2_500_000 });
      await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/approve`);
      const corrected = await LedgerEntry.findOne({ _id: (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}`)).body.ledgerEntryId }).lean();
      expect(corrected?.entryDate).toBe('2026-11-01');
    });
  });

  describe('refusals', () => {
    it('refuses a voucher that is not recorded: drafts are edited directly', async () => {
      const draft = await (await as('rahim')).post(VOUCHERS, rentInCash);
      const response = await askToCorrect('rahim', draft.body.id);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('record_not_recorded');
    });

    it('refuses corrected lines that do not balance, and a request that changes nothing', async () => {
      const voucherId = await recordedVoucher();
      const unbalanced = await askToCorrect('rahim', voucherId, { lines: [{ accountId: RENT, debit: 100 }, { accountId: BANK, credit: 99 }] });
      expect(unbalanced.status).toBe(422);
      expect(unbalanced.body.error.code).toBe('unbalanced_entry');
      const same = await askToCorrect('rahim', voucherId, { memo: 'November office rent' });
      expect(same.status).toBe(422);
      expect(same.body.error.code).toBe('no_change');
    });

    it('shows the waiting request on the voucher instead of offering a second one', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      const voucher = (await (await as('sumon')).get(`${VOUCHERS}/${voucherId}`)).body;
      expect(voucher.waitingUpdateRequest).toEqual({ id: asked.body.id, number: 'UR-0001' });
      expect(voucher.allowedActions.requestCorrection).toBe(false);
      await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/reject`, { note: 'Keep it' });
      const afterDecision = (await (await as('sumon')).get(`${VOUCHERS}/${voucherId}`)).body;
      expect(afterDecision).not.toHaveProperty('waitingUpdateRequest');
      expect(afterDecision.allowedActions.requestCorrection).toBe(true);
    });

    it('allows one waiting request per voucher', async () => {
      const voucherId = await recordedVoucher();
      const firstAsk = await askToCorrect('rahim', voucherId);
      expect(firstAsk.status).toBe(201);
      const second = await askToCorrect('sumon', voucherId, { memo: 'Rent' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('update_request_already_waiting');
    });

    it('refuses deciding twice', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      const nadia = await as('nadia');
      expect((await nadia.post(`${REQUESTS}/${asked.body.id}/approve`)).status).toBe(200);
      const again = await nadia.post(`${REQUESTS}/${asked.body.id}/reject`, { note: 'Too late' });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('update_request_not_waiting');
    });

    it('applies nothing when the voucher was reversed in the meantime, and leaves the request waiting', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      await (await as('nadia')).post(`${VOUCHERS}/${voucherId}/reverse`);
      const refused = await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/approve`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('voucher_not_recorded');
      expect((await (await as('rahim')).get(`${REQUESTS}/${asked.body.id}`)).body.status).toBe('waiting');
      expect((await getTrialBalance()).difference).toBe(0);
    });
  });

  describe('a failure halfway', () => {
    it('leaves no reversal, no new entry and no change when the corrected lines can no longer be recorded', async () => {
      const voucherId = await recordedVoucher();
      const officeExpenses = 'la_5500';
      const asked = await askToCorrect('rahim', voucherId, { lines: [{ accountId: officeExpenses, debit: 2_500_000 }, { accountId: CASH, credit: 2_500_000 }] });
      expect(asked.status).toBe(201);
      // The account in the corrected lines is closed before anyone approves.
      expect((await (await as('farhana')).patch(`/accounts/ledger-accounts/${officeExpenses}`, { isActive: false })).status).toBe(200);

      const entriesBefore = await LedgerEntry.countDocuments();
      const voucherBefore = (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}`)).body;
      const refused = await (await as('nadia')).post(`${REQUESTS}/${asked.body.id}/approve`);
      expect(refused.status).toBe(422);

      expect(await LedgerEntry.countDocuments()).toBe(entriesBefore);
      expect(await LedgerEntry.exists({ reversedBy: { $exists: true } })).toBeNull();
      const voucherAfter = (await (await as('rahim')).get(`${VOUCHERS}/${voucherId}`)).body;
      expect(voucherAfter).toMatchObject({ version: voucherBefore.version, ledgerEntryId: voucherBefore.ledgerEntryId, total: 2_500_000 });
      expect((await (await as('rahim')).get(`${REQUESTS}/${asked.body.id}`)).body.status).toBe('waiting');
      expect(await AuditLog.exists({ action: 'journalVoucher.corrected' })).toBeNull();
      expect((await getTrialBalance()).difference).toBe(0);
    });
  });

  describe('rejecting', () => {
    it('needs a note, changes nothing in the books, and tells the requester why', async () => {
      const voucherId = await recordedVoucher();
      const asked = await askToCorrect('rahim', voucherId);
      const nadia = await as('nadia');
      expect((await nadia.post(`${REQUESTS}/${asked.body.id}/reject`, {})).status).toBe(422);
      const rejected = await nadia.post(`${REQUESTS}/${asked.body.id}/reject`, { note: 'The bank statement shows ৳25,000' });
      expect(rejected.body).toMatchObject({ status: 'rejected', rejectionNote: 'The bank statement shows ৳25,000' });
      expect(await findAccountBalance(CASH)).toBe(-2_500_000);
      // Once decided, a new request may be made.
      expect((await askToCorrect('rahim', voucherId, { memo: 'Rent for November' })).status).toBe(201);
    });
  });

  describe('lists', () => {
    it("gives the screen's tiles: waiting, applied this week, rejected and the average review time", async () => {
      const [first, second, third] = [await recordedVoucher(), await recordedVoucher(), await recordedVoucher()];
      const nadia = await as('nadia');
      await nadia.post(`${REQUESTS}/${(await askToCorrect('rahim', first)).body.id}/approve`);
      await nadia.post(`${REQUESTS}/${(await askToCorrect('rahim', second)).body.id}/reject`, { note: 'No' });
      await askToCorrect('rahim', third);
      const { summary } = (await nadia.get(REQUESTS)).body;
      expect(summary).toMatchObject({ waiting: 1, appliedThisWeek: 1, rejected: 1 });
      expect(summary.averageReviewMinutes).toBe(0);
    });

    it('lists requests newest first, filtered by status', async () => {
      const first = await recordedVoucher();
      const second = await recordedVoucher();
      const applied = await askToCorrect('rahim', first);
      await (await as('nadia')).post(`${REQUESTS}/${applied.body.id}/approve`);
      await askToCorrect('rahim', second, { memo: 'Rent, second office' });

      const rahim = await as('rahim');
      expect((await rahim.get(REQUESTS)).body.requests.map((item: { number: string }) => item.number)).toEqual(['UR-0002', 'UR-0001']);
      expect((await rahim.get(`${REQUESTS}?status=waiting`)).body.requests.map((item: { number: string }) => item.number)).toEqual(['UR-0002']);
    });

    it('puts waiting requests in the approvals queue for others, and in the requester\'s own list', async () => {
      const voucherId = await recordedVoucher();
      await askToCorrect('rahim', voucherId);
      const forNadia = (await (await as('nadia')).get('/accounts/approvals')).body.waitingForYou.items;
      expect(forNadia).toEqual([expect.objectContaining({ type: 'updateRequest', number: 'UR-0001', amount: 2_600_000 })]);
      const forRahim = (await (await as('rahim')).get('/accounts/approvals')).body;
      expect(forRahim.waitingForYou.total).toBe(0);
      expect(forRahim.yoursWaiting.items[0]).toMatchObject({ type: 'updateRequest' });
    });

    it('shows corrections and reversals in the change history, newest first', async () => {
      const corrected = await recordedVoucher();
      const reversed = await recordedVoucher({ ...rentInCash, memo: 'Rent typed twice' });
      const asked = await askToCorrect('rahim', corrected);
      const nadia = await as('nadia');
      await nadia.post(`${REQUESTS}/${asked.body.id}/approve`);
      await nadia.post(`${VOUCHERS}/${reversed}/reverse`);

      const entries = (await (await as('rahim')).get('/accounts/change-history')).body.entries;
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ kind: 'reversal', recordNumber: 'JV-0002', approvedBy: { id: 'nadia' } });
      expect(entries[1]).toMatchObject({
        kind: 'correction', recordNumber: 'JV-0001', request: { number: 'UR-0001' },
        changes: [{ field: 'total', from: 2_500_000, to: 2_600_000 }], askedBy: { id: 'rahim' }, approvedBy: { id: 'nadia' },
      });

      // Someone who can read vouchers but not update requests sees only the reversals.
      const forSumonWithoutRequests = await AccessProfile.updateOne({ _id: 'ap_ur_clerk' }, { $unset: { 'grants.accounts.updateRequest': 1 } });
      expect(forSumonWithoutRequests.modifiedCount).toBe(1);
      const forSumon = (await (await as('sumon')).get('/accounts/change-history')).body.entries;
      expect(forSumon.map((entry: { kind: string }) => entry.kind)).toEqual(['reversal']);
    });
  });
});
