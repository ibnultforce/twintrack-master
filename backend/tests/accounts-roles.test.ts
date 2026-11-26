import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runInTransaction } from '../src/db.js';
import { getTrialBalance } from '../src/modules/accounts/ledger/ledger.service.js';
import { validateChartOfAccountsFile } from '../src/modules/accounts/ledgerAccount/chartOfAccountsFile.js';
import { insertMissingLedgerAccounts } from '../src/modules/accounts/ledgerAccount/ledgerAccount.repository.js';
import { AccountsEmployee } from '../src/modules/accounts/models/accountsEmployee.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

/*
 * Day 6, Task 23: the role check. Four example profiles, each with a checklist of what it must and mustn't do in
 * Accounts. The profiles are built from the manifest's resources, so a new resource is covered without editing this.
 */

interface ManifestRoute { method: string; path: string; access: string; permission?: string; anyPermission?: string[] }
interface ManifestResource { key: string; actions: string[] }

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../manifests/accounts.manifest.json', import.meta.url)), 'utf8')) as {
  module: { baseUrl: string };
  resources: ManifestResource[];
  routes: ManifestRoute[];
};

const grantsWith = (actionsFor: (resource: ManifestResource) => string[]) =>
  Object.fromEntries(manifest.resources.map((resource) => [resource.key, { actions: actionsFor(resource) }]).filter(([, grant]) => (grant as { actions: string[] }).actions.length > 0));

/** Reads everything, makes and changes records, approves nothing, and sees no salaries or bank numbers. Settings stay with the approver. */
const ACCOUNTANT = grantsWith((resource) => resource.actions.filter((action) => action !== 'approve' && !(resource.key === 'setting' && action === 'update')));
/** Reads and decides everything, makes nothing, and sees salaries and bank numbers. */
const APPROVER = {
  ...grantsWith((resource) => resource.actions.filter((action) => action === 'read' || action === 'approve' || (resource.key === 'setting' && action === 'update'))),
};
APPROVER.payrollRun = { ...APPROVER.payrollRun, fieldAccess: { lines: 'read' } } as never;
APPROVER.ledgerAccount = { ...APPROVER.ledgerAccount, fieldAccess: { bankAccountNumber: 'read' } } as never;
/** Reads everything, and nothing else. Salaries and bank numbers stay hidden. */
const AUDITOR = grantsWith((resource) => resource.actions.filter((action) => action === 'read'));

const ROLES = {
  accountant: { person: 'rahim', grants: ACCOUNTANT },
  approver: { person: 'nadia', grants: APPROVER },
  auditor: { person: 'aziz', grants: AUDITOR },
  employee: { person: 'sohel', grants: {} },
} as const;
type Role = keyof typeof ROLES;

const holds = (role: Role, permission: string) => {
  const [resource, action] = permission.split('.');
  const grant = (ROLES[role].grants as Record<string, { actions: string[] }>)[resource ?? ''];
  return Boolean(grant?.actions.includes(action ?? ''));
};
const mayReach = (role: Role, route: ManifestRoute) =>
  route.access !== 'private' || (route.permission ? holds(role, route.permission) : (route.anyPermission ?? []).some((permission) => holds(role, permission)));

const VOUCHERS = '/accounts/journal-vouchers';
const PAYROLL = '/accounts/payroll-runs';
const CASH = 'la_1100';
const OPENING_EQUITY = 'la_3900';
const SALARY_EXPENSE = 'la_5100';

describe('Accounts role check (Day 6)', () => {
  useTestDatabase();

  let app: Application;
  const as = async (role: Role | 'admin') => requestsAs(app, await signIn(app, `${role === 'admin' ? 'farhana' : ROLES[role].person}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    const chart = validateChartOfAccountsFile(readSeedFiles().chartOfAccounts);
    if (!chart.ok) throw new Error(JSON.stringify(chart.errors));
    await runInTransaction((session) => insertMissingLedgerAccounts(chart.value, session));
    await AccessProfile.create(Object.entries(ROLES).map(([role, { grants }]) => ({ _id: `ap_role_${role}`, name: role, grants: { accounts: grants } })));
    await addPerson('farhana', { superAdmin: true });
    for (const [role, { person }] of Object.entries(ROLES)) await addPerson(person, { profileId: `ap_role_${role}` });
    await AccountsEmployee.create([
      { _id: 'emp_E1', employeeCode: 'E1', name: 'Person One', designation: 'Engineer', department: 'engineering', joinDate: '2024-01-01', monthlySalary: 8_500_000, isActive: true, version: 0 },
      { _id: 'emp_E2', employeeCode: 'E2', name: 'Person Two', designation: 'Engineer', department: 'engineering', joinDate: '2024-01-01', monthlySalary: 6_000_000, isActive: true, version: 0 },
    ]);
  });

  describe('every route, every role: refused without its permission, open with it', () => {
    const cases = (Object.keys(ROLES) as Role[]).flatMap((role) => manifest.routes.map((route) => [role, route.method, route.path, route] as const));
    it.each(cases)('%s: %s %s', async (role, method, path, route) => {
      const url = `${manifest.module.baseUrl}${path.replace(/:[a-zA-Z]+/g, 'x_none')}`;
      const client = await as(role);
      const send = { GET: client.get, POST: client.post, PATCH: client.patch, PUT: (target: string) => client.put(target, {}), DELETE: client.delete }[method as 'GET'];
      const response = await send(url);
      if (!mayReach(role, route)) {
        expect(response.status).toBe(403);
      } else if (method === 'GET') {
        // Reached: the answer may be the data, or that the made-up id doesn't exist, never a refusal.
        expect([200, 404, 422]).toContain(response.status);
      } else {
        expect(response.status).not.toBe(401);
      }
    });
  });

  it('accountant: makes and submits a voucher, but can\'t approve it; the approver records it; auditor and employee can do neither', async () => {
    const accountant = await as('accountant');
    const voucher = { voucherDate: '2026-11-01', memo: 'Opening cash', lines: [{ accountId: CASH, debit: 1_000_000 }, { accountId: OPENING_EQUITY, credit: 1_000_000 }] };
    expect((await (await as('auditor')).post(VOUCHERS, voucher)).status).toBe(403);
    expect((await (await as('approver')).post(VOUCHERS, voucher)).status).toBe(403);
    expect((await (await as('employee')).post(VOUCHERS, voucher)).status).toBe(403);

    const created = await accountant.post(VOUCHERS, voucher);
    expect(created.status).toBe(201);
    expect((await accountant.post(`${VOUCHERS}/${created.body.id}/submit`)).status).toBe(200);
    expect((await accountant.post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(403);
    expect((await (await as('auditor')).post(`${VOUCHERS}/${created.body.id}/approve`)).status).toBe(403);
    const approved = await (await as('approver')).post(`${VOUCHERS}/${created.body.id}/approve`);
    expect(approved.body.status).toBe('recorded');
    expect((await getTrialBalance()).difference).toBe(0);
    // The auditor reads it and its history, and the audit log.
    const auditor = await as('auditor');
    expect((await auditor.get(`${VOUCHERS}/${created.body.id}`)).body).toMatchObject({ status: 'recorded', allowedActions: { edit: false, approve: false, reverse: false, requestCorrection: false } });
    expect((await auditor.get('/accounts/audit-log')).status).toBe(200);
  });

  it('salaries: only the approver sees each person\'s pay, on the run, in the general ledger and in exports', async () => {
    const accountant = await as('accountant');
    const run = await accountant.post(PAYROLL, { month: '2026-11', payDate: '2026-11-30' });
    expect(run.status).toBe(201);
    expect(run.body).not.toHaveProperty('lines');
    await accountant.post(`${PAYROLL}/${run.body.id}/submit`);
    expect((await (await as('approver')).post(`${PAYROLL}/${run.body.id}/approve`)).status).toBe(200);
    const ledgerPath = `/accounts/general-ledger?accountId=${SALARY_EXPENSE}&from=2026-11-01&to=2026-11-30`;

    const approver = await as('approver');
    expect((await approver.get(`${PAYROLL}/${run.body.id}`)).body.lines).toHaveLength(2);
    expect((await approver.get(ledgerPath)).body).toMatchObject({ payPerPersonHidden: false, total: 2 });
    expect((await approver.get('/accounts/exports/salaries')).text).toContain('Person One');

    for (const role of ['accountant', 'auditor'] as const) {
      const client = await as(role);
      const seen = await client.get(`${PAYROLL}/${run.body.id}`);
      expect(seen.body).not.toHaveProperty('lines');
      expect(seen.body.total).toBe(14_500_000);
      const ledger = await client.get(ledgerPath);
      expect(ledger.body).toMatchObject({ payPerPersonHidden: true, total: 1, closing: 14_500_000 });
      expect(JSON.stringify(ledger.body)).not.toContain('Person One');
      expect((await client.get('/accounts/exports/salaries')).status).toBe(403);
      expect((await client.get(`${PAYROLL}/${run.body.id}/history`)).text).not.toContain('8500000');
    }
  });

  it('bank numbers: only the approver sees them, on the chart and in its export', async () => {
    const bank = await (await as('admin')).post('/accounts/ledger-accounts', { code: '1250', name: 'City Bank, current', type: 'asset', parentId: 'la_1000', cashOrBank: 'bank', bankName: 'City Bank', bankAccountNumber: '1234-5678-90' });
    expect(bank.status).toBe(201);
    // Shown masked to whoever may read it, and in full only when they press Reveal, which is audited.
    expect((await (await as('approver')).get(`/accounts/ledger-accounts/${bank.body.id}`)).body.bankAccountNumber).toBe('•••• 7890');
    expect((await (await as('approver')).post(`/accounts/ledger-accounts/${bank.body.id}/reveal-bank-number`)).text).toContain('1234-5678-90');
    expect((await (await as('auditor')).post(`/accounts/ledger-accounts/${bank.body.id}/reveal-bank-number`)).status).toBe(403);
    // The export has the column, masked as on screen; the full number never leaves in a file.
    const approverFile = (await (await as('approver')).get('/accounts/exports/chart-of-accounts')).text;
    expect(approverFile).toContain('Bank account number');
    expect(approverFile).toContain('•••• 7890');
    expect(approverFile).not.toContain('1234-5678-90');
    for (const role of ['accountant', 'auditor'] as const) {
      const client = await as(role);
      expect((await client.get(`/accounts/ledger-accounts/${bank.body.id}`)).body).not.toHaveProperty('bankAccountNumber');
      const file = (await client.get('/accounts/exports/chart-of-accounts')).text;
      expect(file).not.toContain('Bank account number');
      expect(file).not.toContain('7890');
    }
  });

  it('employee: no Accounts screen, report or export at all', async () => {
    const employee = await as('employee');
    for (const path of ['/accounts/status', '/accounts/dashboard', '/accounts/reports/profit-and-loss?from=2026-11-01&to=2026-11-30', '/accounts/exports', '/accounts/approvals', '/accounts/general-ledger?accountId=la_1100&from=2026-11-01&to=2026-11-30']) {
      expect((await employee.get(path)).status, path).toBe(403);
    }
  });
});
