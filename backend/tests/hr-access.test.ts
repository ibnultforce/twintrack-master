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

  describe('a module admin changing access', () => {
    it('changes the permission sets of someone who has access to the module, with no Master access', async () => {
      const kamrul = await as('kamrul');
      const response = await kamrul.put(`/users/${ID.RAHIM}/permission-sets`, { module: 'hr', permissionSets: ['staff'], reason: 'Testing' });
      expect(response.status).toBe(200);
      expect(response.body.permissionSets.hr).toEqual(['staff']);
      expect((await (await as('rahim')).get('/me/permissions/hr')).body.permissionSets).toEqual(['staff']);
    });

    it('gives several permission sets at once, with a reason for the activity log', async () => {
      const response = await (await as('kamrul')).put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['staff', 'manager'], reason: 'Helping with hiring' });
      expect(response.status).toBe(200);
      expect(response.body.permissionSets.hr).toEqual(['staff', 'manager']);
      expect(await AuditLog.findOne({ action: 'user.permission_sets_changed' }).lean()).toMatchObject({ reason: 'Helping with hiring', after: { permissionSets: ['staff', 'manager'] } });
    });

    it('needs a reason to give a new permission set, but not to take one away', async () => {
      const kamrul = await as('kamrul');
      const missing = await kamrul.put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['staff', 'manager'] });
      expect(missing.status).toBe(422);
      expect(missing.body.error.fields[0].path).toBe('reason');
      expect((await kamrul.put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: [] })).status).toBe(200);
    });

    it('adds someone with no access to the module yet, which works at once', async () => {
      const karim = await as('karim');
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(false);

      const response = await (await as('kamrul')).put(`/users/${ID.KARIM}/permission-sets`, { module: 'hr', permissionSets: ['staff'], reason: 'Testing' });
      expect(response.status).toBe(200);
      expect((await karim.get('/me/permissions/hr')).body.permissionSets).toEqual(['staff']);
      expect((await (await as('kamrul')).get('/modules/hr/people')).body.people.map((person: { id: string }) => person.id)).toContain(ID.KARIM);
    });

    it('can give another module admin their permission set, and take it away', async () => {
      const kamrul = await as('kamrul');
      await kamrul.put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['admin'], reason: 'Testing' });
      const sabbir = await as('sabbir');
      expect((await sabbir.put(`/users/${ID.RAHIM}/permission-sets`, { module: 'hr', permissionSets: ['viewer'], reason: 'Testing' })).status).toBe(200);
      await kamrul.put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['staff'], reason: 'Testing' });
      expect((await (await as('sabbir')).get('/me/permissions/hr')).body.permissions['access.update']).toBeUndefined();
    });

    it('stays inside the module', async () => {
      const response = await (await as('kamrul')).put(`/users/${ID.RUMANA}/permission-sets`, { module: 'master', permissionSets: ['admin'], reason: 'Testing' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('module_access_only');
    });

    it('can not change their own access, or a super admin\'s', async () => {
      const kamrul = await as('kamrul');
      expect((await kamrul.put(`/users/${ID.KAMRUL}/permission-sets`, { module: 'hr', permissionSets: ['viewer'], reason: 'Testing' })).body.error.code).toBe('own_access');
      expect((await kamrul.put(`/users/${ID.FARHANA}/permission-sets`, { module: 'hr', permissionSets: ['viewer'], reason: 'Testing' })).body.error.code).toBe('super_admin');
    });

    it('can not give a permission set the module does not have', async () => {
      const response = await (await as('kamrul')).put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['ghost'], reason: 'No' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('unknown_permission_set');
    });

    it('comes from the permission set, so it stops when the set loses it', async () => {
      const kamrul = await as('kamrul');
      await (await as('farhana')).patch('/permission-sets/hr/admin', { grants: { salary: { actions: ['read'], scope: 'all' } } });
      expect((await kamrul.put(`/users/${ID.RAHIM}/permission-sets`, { module: 'hr', permissionSets: ['staff'], reason: 'Testing' })).body.error.code).toBe('forbidden');
    });

    it('can be put in any permission set', async () => {
      const farhana = await as('farhana');
      const hr = (await farhana.get('/permission-sets')).body.modules.find((module: { key: string }) => module.key === 'hr');
      const manager = hr.permissionSets.find((permissionSet: { key: string }) => permissionSet.key === 'manager');
      expect(manager).toBeDefined();
      await farhana.patch('/permission-sets/hr/manager', { grants: { access: { actions: ['read', 'update'] } } });
      expect((await (await as('rahim')).put(`/users/${ID.SABBIR}/permission-sets`, { module: 'hr', permissionSets: ['viewer'], reason: 'Testing' })).status).toBe(200);
    });

    it('sees only their own module in the access options, and only its people', async () => {
      const kamrul = await as('kamrul');
      const options = await kamrul.get('/users/access-options');
      expect(options.body.modules.map((module: { key: string; canChange: boolean }) => [module.key, module.canChange])).toEqual([['hr', true]]);

      const people = await kamrul.get('/modules/hr/people');
      expect(people.status).toBe(200);
      expect(people.body.people.map((person: { id: string }) => person.id)).toContain(ID.RAHIM);
      expect(JSON.stringify(people.body)).not.toMatch(/passwordHash|argon2/);
      expect((await kamrul.get('/modules/master/people')).status).toBe(403);
      expect((await kamrul.get('/users')).status).toBe(403);
    });

    it('refuses everyone else before reading the request', async () => {
      const rahim = await as('rahim');
      expect((await rahim.put(`/users/${ID.KARIM}/permission-sets`, {})).body.error.code).toBe('forbidden');
      expect((await rahim.get('/modules/hr/people')).body.error.code).toBe('forbidden');
      expect((await request(app).get('/modules/hr/people')).status).toBe(401);
    });
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

    it('widens when the role\'s reach is changed, on the next request', async () => {
      const rahim = await as('rahim');
      await (await as('farhana')).patch('/permission-sets/hr/manager', { grants: { salary: { actions: ['read'], scope: 'all' } } });
      expect((await rahim.get('/hr/salaries')).body.total).toBe(6);
    });

    it('can narrow to a person\'s own salary', async () => {
      const rahim = await as('rahim');
      await (await as('farhana')).patch('/permission-sets/hr/manager', { grants: { salary: { actions: ['read'], scope: 'own' } } });
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

    it('follows a permission set given to one person, within their team', async () => {
      const karim = await as('karim');
      const farhana = await as('farhana');
      await farhana.post('/permission-sets/hr', { key: 'salary-reader', name: 'Salary reader', grants: { salary: { actions: ['read'], scope: 'team' } } });
      await farhana.put(`/users/${ID.KARIM}/permission-sets`, { module: 'hr', permissionSets: ['salary-reader'], reason: 'Testing' });
      expect(employeesIn((await karim.get('/hr/salaries')).body)).toEqual([ID.KARIM]);
    });

    it('follows a profile, and takes the wider scope from a permission set on top of it', async () => {
      await AccessProfile.create({ _id: 'ap_staff', name: 'Staff', grants: { hr: { salary: { actions: ['read'], scope: 'own' } } } });
      await User.updateOne({ _id: ID.ARIF }, { $set: { profileId: 'ap_staff' } });
      const arif = await as('arif');
      expect(employeesIn((await arif.get('/hr/salaries')).body)).toEqual([ID.ARIF]);

      await User.updateOne({ _id: ID.RAHIM }, { $set: { profileId: 'ap_staff', permissionSets: {} } });
      const rahim = await as('rahim');
      expect(employeesIn((await rahim.get('/hr/salaries')).body)).toEqual([ID.RAHIM]);
      await (await as('farhana')).put(`/users/${ID.RAHIM}/permission-sets`, { module: 'hr', permissionSets: ['manager'], reason: 'Leads a team' });
      expect(employeesIn((await rahim.get('/hr/salaries')).body)).toEqual([ID.RAHIM, ID.ARIF, ID.KARIM].sort());
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

    it('lets a Manager change salaries when their permission set allows it, inside their team only', async () => {
      const rahim = await as('rahim');
      await (await as('farhana')).patch('/permission-sets/hr/manager', { grants: { salary: { actions: ['read', 'update'], scope: 'team', fieldAccess: { amount: 'edit' } } } });
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

  it('ignores a person\'s Master role for HR routes', async () => {
    await User.updateOne({ _id: ID.KARIM }, { $set: { 'assignments.master': 'admin' } });
    expect((await (await as('karim')).get('/hr/salaries')).status).toBe(403);
  });
});
