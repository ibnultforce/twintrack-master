import { readFileSync } from 'node:fs';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hrRoutes } from '../src/modules/hr/hr.routes.js';
import { Salary } from '../src/modules/hr/models/salary.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { User } from '../src/modules/master/models/user.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { FARHANA: 'u_01', SABBIR: 'u_03', RAHIM: 'u_04', RUMANA: 'u_05', KAMRUL: 'u_06', ARIF: 'u_07', KARIM: 'u_08', MEHEDI: 'u_09' };
const newSalary = { employeeId: ID.KARIM, amount: 99000, effectiveFrom: '2027-01-01' };

describe('HR module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const employeesIn = (body: { salaries: { employeeId: string }[] }) => body.salaries.map((salary) => salary.employeeId).sort();
  /** Changes what the Engineering lead profile, which Rahim holds, allows in HR. */
  const setLeadSalaryGrant = (grant: object) => AccessProfile.updateOne({ _id: 'ap_engineering_lead' }, { $set: { 'grants.hr.salary': grant } });

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('builds what the HR manifest says is built, with the same permissions', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../manifests/hr.manifest.json', import.meta.url), 'utf8')) as {
      module: { baseUrl: string };
      routes: { method: string; path: string; permission?: string; planned?: boolean }[];
    };
    const describeRoute = (route: { method: string; path: string; permission?: string }) => `${route.method} ${route.path} ${route.permission}`;
    const built = manifest.routes.filter((route) => !route.planned).map((route) => describeRoute({ ...route, path: `${manifest.module.baseUrl}${route.path}` }));
    expect(built.sort()).toEqual(hrRoutes.map(describeRoute).sort());
  });

  describe('GET /hr/salaries', () => {
    it('shows everyone to HR Admin', async () => {
      const response = await (await as('kamrul')).get('/hr/salaries');
      expect(response.status).toBe(200);
      expect(response.body.scope).toBe('all');
      expect(response.body.total).toBe(6);
      expect(response.body.salaries[0].employeeName).toEqual(expect.any(String));
    });

    it('shows a Manager only themselves and their team', async () => {
      const { body } = await (await as('rahim')).get('/hr/salaries');
      expect(body.scope).toBe('team');
      expect(employeesIn(body)).toEqual([ID.RAHIM, ID.ARIF, ID.KARIM].sort());
    });

    it('widens when the profile\'s reach is changed, on the next request', async () => {
      const rahim = await as('rahim');
      await setLeadSalaryGrant({ actions: ['read'], scope: 'all' });
      expect((await rahim.get('/hr/salaries')).body.total).toBe(6);
    });

    it('can narrow to a person\'s own salary', async () => {
      const rahim = await as('rahim');
      await setLeadSalaryGrant({ actions: ['read'], scope: 'own' });
      expect(employeesIn((await rahim.get('/hr/salaries')).body)).toEqual([ID.RAHIM]);
    });

    it.each(['sabbir', 'karim'])('refuses %s, who holds no salary.read', async (name) => {
      const response = await (await as(name)).get('/hr/salaries');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('needs a token', async () => {
      expect((await request(app).get('/hr/salaries')).status).toBe(401);
    });

    it('follows a profile given to one person, within their team', async () => {
      await AccessProfile.create({ _id: 'ap_staff', name: 'Staff', grants: { hr: { salary: { actions: ['read'], scope: 'own' } } } });
      const karim = await as('karim');
      await (await as('farhana')).put(`/users/${ID.KARIM}/profile`, { profileId: 'ap_staff' });
      expect(employeesIn((await karim.get('/hr/salaries')).body)).toEqual([ID.KARIM]);
    });
  });

  describe('changing salaries', () => {
    it('lets HR Admin create one, which starts as pending', async () => {
      const response = await (await as('kamrul')).post('/hr/salaries', newSalary);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ employeeId: ID.KARIM, amount: 99000, currency: 'BDT', status: 'pending' });
    });

    it('lets HR Admin approve one, and records who did', async () => {
      const response = await (await as('kamrul')).patch('/hr/salaries/s_07/approve');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'approved', approvedBy: ID.KAMRUL });
    });

    it('needs approving again after the amount changes', async () => {
      const response = await (await as('kamrul')).patch('/hr/salaries/s_08', { amount: 100000 });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ amount: 100000, status: 'pending' });
      expect(response.body.approvedBy).toBeUndefined();
    });

    it.each([
      ['create', 'post', '/hr/salaries', newSalary],
      ['update', 'patch', '/hr/salaries/s_08', { amount: 1 }],
      ['approve', 'patch', '/hr/salaries/s_07/approve', undefined],
    ] as const)('refuses a Manager who only has salary.read: %s', async (_label, method, path, body) => {
      const response = await (await as('rahim'))[method](path, body as object);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('lets a Manager change salaries when their profile allows it, inside their team only', async () => {
      const rahim = await as('rahim');
      await setLeadSalaryGrant({ actions: ['read', 'update'], scope: 'team', fieldAccess: { amount: 'edit' } });
      expect((await rahim.patch('/hr/salaries/s_08', { amount: 96000 })).status).toBe(200);

      const outside = await rahim.patch('/hr/salaries/s_05', { amount: 1 });
      expect(outside.status).toBe(403);
      expect(outside.body.error.code).toBe('out_of_scope');
      expect((await Salary.findById('s_05').lean())?.amount).toBe(150000);
    });

    it.each([
      ['a person who does not exist', { ...newSalary, employeeId: 'nobody' }],
      ['an amount of zero', { ...newSalary, amount: 0 }],
      ['a bad date', { ...newSalary, effectiveFrom: 'soon' }],
      ['another field', { ...newSalary, status: 'approved' }],
    ])('refuses creating one with %s', async (_label, body) => {
      expect((await (await as('kamrul')).post('/hr/salaries', body)).status).toBe(422);
    });

    it('answers 404 for a salary that does not exist', async () => {
      const kamrul = await as('kamrul');
      expect((await kamrul.patch('/hr/salaries/nothing', { amount: 1 })).body.error.code).toBe('unknown_salary');
      expect((await kamrul.patch('/hr/salaries/nothing/approve')).body.error.code).toBe('unknown_salary');
    });

    it('logs changes without the amount, because auditors may not see salaries', async () => {
      await (await as('kamrul')).patch('/hr/salaries/s_08', { amount: 123456 });
      const entry = await AuditLog.findOne({ action: 'salary.updated' }).lean();
      expect(entry).toMatchObject({ actorId: ID.KAMRUL, targetId: 's_08', module: 'hr' });
      expect(JSON.stringify(entry)).not.toContain('123456');
    });

    it('stops when the HR module is removed', async () => {
      const kamrul = await as('kamrul');
      expect((await (await as('farhana')).delete('/modules/hr')).status).toBe(200);
      expect((await kamrul.get('/hr/salaries')).status).toBe(403);
    });
  });

  it('ignores leftover access fields from before profiles', async () => {
    await User.updateOne({ _id: ID.KARIM }, { $set: { 'assignments.master': 'admin', 'permissionSets.hr': ['admin'] } });
    expect((await (await as('karim')).get('/hr/salaries')).status).toBe(403);
  });
});
