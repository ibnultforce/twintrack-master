import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const APPROVALS = '/accounts/approvals';
const VOUCHERS = '/accounts/journal-vouchers';

const voucher = (memo: string) => ({
  voucherDate: '2026-11-02',
  memo,
  lines: [
    { accountId: 'la_5300', debit: 2_500_000 },
    { accountId: 'la_1100', credit: 2_500_000 },
  ],
});

interface ApprovalItem {
  type: string;
  number: string;
  title: string;
  createdBy?: { id: string };
}

describe('the approvals queue', () => {
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
      { _id: 'ap_q_accountant', name: 'Accountant', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update', 'approve'] } } } },
      { _id: 'ap_q_clerk', name: 'Clerk', grants: { accounts: { journalVoucher: { actions: ['read', 'create', 'update'] } } } },
      { _id: 'ap_q_settings', name: 'Settings only', grants: { accounts: { setting: { actions: ['read'] } } } },
    ]);
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rahim', { profileId: 'ap_q_accountant' });
    await addPerson('nadia', { profileId: 'ap_q_accountant' });
    await addPerson('sumon', { profileId: 'ap_q_clerk' });
    await addPerson('shila', { profileId: 'ap_q_settings' });
    await addPerson('kamrul');
  });

  async function submit(maker: string, memo: string): Promise<string> {
    const client = await as(maker);
    const created = await client.post(VOUCHERS, voucher(memo));
    expect((await client.post(`${VOUCHERS}/${created.body.id}/submit`)).status).toBe(200);
    return created.body.id as string;
  }

  const titles = (list: { items: ApprovalItem[] }) => list.items.map((item) => item.title);

  it('needs a token, and a permission to read some kind of approvable record', async () => {
    expect((await request(app).get(APPROVALS)).status).toBe(401);
    expect((await (await as('kamrul')).get(APPROVALS)).status).toBe(403);
    expect((await (await as('shila')).get(APPROVALS)).status).toBe(403);
  });

  it("shows an approver other people's waiting vouchers, oldest first, and keeps their own apart", async () => {
    await submit('rahim', 'First rent');
    await submit('sumon', 'Second rent');
    await submit('nadia', 'Nadia rent');
    const draft = await (await as('rahim')).post(VOUCHERS, voucher('Still a draft'));
    expect(draft.status).toBe(201);

    const response = await (await as('nadia')).get(APPROVALS);
    expect(response.status).toBe(200);
    expect(titles(response.body.waitingForYou)).toEqual(['First rent', 'Second rent']);
    expect(response.body.waitingForYou.total).toBe(2);
    expect(response.body.waitingForYou.items[0]).toMatchObject({ type: 'journalVoucher', number: 'JV-0001', amount: 2_500_000, date: '2026-11-02', createdBy: { id: 'rahim', name: 'Person rahim' } });
    expect(titles(response.body.yoursWaiting)).toEqual(['Nadia rent']);
  });

  it('shows someone without the approve permission nothing to decide, only their own waiting vouchers', async () => {
    await submit('rahim', 'Rahim rent');
    await submit('sumon', 'Sumon rent');
    const body = (await (await as('sumon')).get(APPROVALS)).body;
    expect(body.waitingForYou).toEqual({ total: 0, items: [] });
    expect(titles(body.yoursWaiting)).toEqual(['Sumon rent']);
  });

  it("never shows a super admin's own voucher as theirs to decide", async () => {
    await submit('farhana', 'Farhana rent');
    await submit('rahim', 'Rahim rent');
    const body = (await (await as('farhana')).get(APPROVALS)).body;
    expect(titles(body.waitingForYou)).toEqual(['Rahim rent']);
    expect(titles(body.yoursWaiting)).toEqual(['Farhana rent']);
  });

  it("shows today's stand-in what they may decide, and stops after the end date", async () => {
    await submit('rahim', 'Rahim rent');
    const farhana = await as('farhana');
    await farhana.patch('/accounts/settings', { standInApproverId: 'sumon', standInUntil: '2999-12-31' });
    expect(titles((await (await as('sumon')).get(APPROVALS)).body.waitingForYou)).toEqual(['Rahim rent']);

    await farhana.patch('/accounts/settings', { standInUntil: '2020-01-01' });
    expect((await (await as('sumon')).get(APPROVALS)).body.waitingForYou.total).toBe(0);
  });

  it('drops a voucher from the queue once it is approved or returned', async () => {
    const approved = await submit('rahim', 'To approve');
    const returned = await submit('rahim', 'To return');
    const nadia = await as('nadia');
    expect((await nadia.post(`${VOUCHERS}/${approved}/approve`)).status).toBe(200);
    expect((await nadia.post(`${VOUCHERS}/${returned}/return`, { note: 'Add the invoice number' })).status).toBe(200);
    expect((await nadia.get(APPROVALS)).body.waitingForYou.total).toBe(0);
    expect((await (await as('rahim')).get(APPROVALS)).body.yoursWaiting.total).toBe(0);
  });
});
