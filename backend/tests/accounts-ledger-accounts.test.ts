import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { LedgerAccount } from '../src/modules/accounts/models/ledgerAccount.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const BASE = '/accounts/ledger-accounts';

async function loadStartingChart(): Promise<void> {
  const chart = validateChartOfAccountsFile(readSeedFiles().chartOfAccounts);
  if (!chart.ok) throw new Error(JSON.stringify(chart.errors));
  await runInTransaction((session) => insertMissingLedgerAccounts(chart.value, session));
}

describe('chart of accounts', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await AccessProfile.create({ _id: 'ap_chart_reader', name: 'Chart reader', grants: { accounts: { ledgerAccount: { actions: ['read'] } } } });
    await addPerson('farhana', { superAdmin: true });
    await addPerson('rita', { profileId: 'ap_chart_reader' });
    await addPerson('karim');
    await loadStartingChart();
  });

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch', string, object?][] = [
      ['list', 'get', BASE],
      ['get', 'get', `${BASE}/la_1200`],
      ['create', 'post', BASE, { code: '1210', name: 'Bank', type: 'asset' }],
      ['update', 'patch', `${BASE}/la_1200`, { name: 'Banks' }],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused for someone without the permission', async (_label, method, path, body) => {
      const karim = await as('karim');
      expect((await (method === 'get' ? karim.get(path) : karim[method](path, body))).status).toBe(403);
    });

    it('a reader can list but not add or change accounts', async () => {
      const rita = await as('rita');
      expect((await rita.get(BASE)).status).toBe(200);
      expect((await rita.post(BASE, { code: '1210', name: 'Bank', type: 'asset' })).status).toBe(403);
      expect((await rita.patch(`${BASE}/la_1200`, { name: 'Banks' })).status).toBe(403);
    });
  });

  describe('starting chart', () => {
    it('lists every seeded account in code order, with its normal balance side', async () => {
      const response = await (await as('farhana')).get(BASE).query({ pageSize: 100 });
      expect(response.status).toBe(200);
      const codes = (response.body.accounts as { code: string }[]).map((account) => account.code);
      expect(codes).toEqual([...codes].sort());
      expect(response.body.total).toBe(codes.length);
      const bank = (response.body.accounts as { code: string; normalBalance: string; parentId: string }[]).find((account) => account.code === '1200');
      expect(bank).toMatchObject({ normalBalance: 'debit', parentId: 'la_1000' });
    });

    it('filters by type, active state and search', async () => {
      const farhana = await as('farhana');
      const income = await farhana.get(BASE).query({ type: 'income' });
      expect((income.body.accounts as { type: string }[]).every((account) => account.type === 'income')).toBe(true);
      expect((await farhana.get(BASE).query({ search: '12' })).body.accounts[0].code).toBe('1200');
      expect((await farhana.get(BASE).query({ search: 'rent' })).body.accounts[0].code).toBe('5300');
      expect((await farhana.get(BASE).query({ isActive: 'false' })).body.total).toBe(0);
    });

    it('loading the starting chart again keeps edits made in the app', async () => {
      await (await as('farhana')).patch(`${BASE}/la_1200`, { name: 'Banks' });
      await loadStartingChart();
      expect((await LedgerAccount.findById('la_1200').lean())?.name).toBe('Banks');
    });
  });

  describe('adding an account', () => {
    it('saves it under a parent of the same type, with history and an audit entry', async () => {
      const response = await (await as('farhana')).post(BASE, { code: '1210', name: 'City Bank current account', type: 'asset', parentId: 'la_1200' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ code: '1210', type: 'asset', normalBalance: 'debit', parentId: 'la_1200', isActive: true, version: 0 });
      expect(await AuditLog.exists({ action: 'ledgerAccount.created', targetId: response.body.id })).toBeTruthy();
    });

    it('refuses a code another account uses', async () => {
      const response = await (await as('farhana')).post(BASE, { code: '1200', name: 'Second bank group', type: 'asset' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('duplicate_account_code');
    });

    it.each([
      ['a parent of another type', { code: '5150', name: 'Overtime', type: 'expense', parentId: 'la_1000' }],
      ['a parent that does not exist', { code: '5150', name: 'Overtime', type: 'expense', parentId: 'la_missing' }],
      ['a code with letters', { code: '12A0', name: 'Bank', type: 'asset' }],
      ['an unknown type', { code: '1210', name: 'Bank', type: 'cash' }],
    ])('refuses %s', async (_label, body) => {
      const response = await (await as('farhana')).post(BASE, body);
      expect(response.status).toBe(422);
    });

    it('refuses an inactive parent', async () => {
      const farhana = await as('farhana');
      await farhana.patch(`${BASE}/la_5900`, { isActive: false });
      expect((await farhana.post(BASE, { code: '5910', name: 'Fines', type: 'expense', parentId: 'la_5900' })).status).toBe(422);
    });
  });

  describe('changing an account', () => {
    it('refuses to move an account under itself or its own sub-account', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch(`${BASE}/la_1000`, { parentId: 'la_1000' })).status).toBe(422);
      expect((await farhana.patch(`${BASE}/la_1000`, { parentId: 'la_1200' })).status).toBe(422);
    });

    it('moves an account to the top level with a null parent', async () => {
      const response = await (await as('farhana')).patch(`${BASE}/la_1200`, { parentId: null });
      expect(response.status).toBe(200);
      expect(response.body.parentId).toBeUndefined();
    });

    it('refuses to change the type of an account with sub-accounts', async () => {
      const response = await (await as('farhana')).patch(`${BASE}/la_1000`, { type: 'expense' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('account_has_sub_accounts');
    });

    it('refuses a type that no longer matches the parent', async () => {
      expect((await (await as('farhana')).patch(`${BASE}/la_1200`, { type: 'expense' })).status).toBe(422);
    });

    it('refuses to deactivate a group with active sub-accounts, and allows it once they are inactive', async () => {
      const farhana = await as('farhana');
      const refused = await farhana.patch(`${BASE}/la_3000`, { isActive: false });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('account_has_active_sub_accounts');

      await farhana.patch(`${BASE}/la_3100`, { isActive: false });
      await farhana.patch(`${BASE}/la_3200`, { isActive: false });
      const saved = await farhana.patch(`${BASE}/la_3000`, { isActive: false });
      expect(saved.status).toBe(200);
      expect(await AuditLog.exists({ action: 'ledgerAccount.deactivated', targetId: 'la_3000' })).toBeTruthy();
    });

    it('refuses a code another account uses', async () => {
      expect((await (await as('farhana')).patch(`${BASE}/la_1100`, { code: '1200' })).status).toBe(409);
    });

    it('refuses an edit made from an old copy', async () => {
      const farhana = await as('farhana');
      await farhana.patch(`${BASE}/la_1100`, { name: 'Petty cash', version: 0 });
      const stale = await farhana.patch(`${BASE}/la_1100`, { name: 'Cash', version: 0 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('version_conflict');
    });

    it('answers 404 for an account that does not exist', async () => {
      expect((await (await as('farhana')).patch(`${BASE}/la_missing`, { name: 'Nothing' })).status).toBe(404);
    });
  });
});

describe('starting chart of accounts file', () => {
  it('accepts the committed seed file', () => {
    expect(validateChartOfAccountsFile(readSeedFiles().chartOfAccounts).ok).toBe(true);
  });

  it('refuses a parent listed after its child, a parent of another type, and repeated codes', () => {
    const result = validateChartOfAccountsFile({
      type: 'chartOfAccounts',
      accounts: [
        { id: 'la_a', code: '1100', name: 'Cash', type: 'asset', parentId: 'la_b' },
        { id: 'la_b', code: '1000', name: 'Assets', type: 'asset' },
        { id: 'la_c', code: '5000', name: 'Expenses', type: 'expense', parentId: 'la_b' },
        { id: 'la_d', code: '1000', name: 'Assets again', type: 'asset' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual(['accounts.0.parentId', 'accounts.2.parentId', 'accounts.3.code']);
  });
});
