import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const KARIM = 'u_08';
const salaryReader = { key: 'salary-reader', name: 'Salary reader', grants: { salary: { actions: ['read'], scope: 'team' } } };

describe('letting someone create roles for one module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const givePermissions = async (moduleKey: string, permissions: string[]) =>
    (await as('farhana')).put(`/users/${KARIM}/privileges`, { module: moduleKey, permissions, reason: 'Sets up roles for this module' });

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('when two changes happen at once', () => {
    const emptyRole = (key: string) => ({ key, name: key, grants: {} });
    const hrRoles = async () => (await Module.findOne({ key: 'hr' }).lean())!.roles;

    it('keeps both edits to different roles', async () => {
      const farhana = await as('farhana');
      await farhana.post('/roles/hr', emptyRole('first'));
      await farhana.post('/roles/hr', emptyRole('second'));

      const responses = await Promise.all([
        farhana.patch('/roles/hr/first', { name: 'First edited' }),
        farhana.patch('/roles/hr/second', { name: 'Second edited' }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const names = (await hrRoles()).map((role) => role.name);
      expect(names).toEqual(expect.arrayContaining(['First edited', 'Second edited']));
    });

    it('never leaves someone holding a role that was deleted', async () => {
      const farhana = await as('farhana');
      await farhana.post('/roles/hr', emptyRole('short-lived'));

      await Promise.all([
        farhana.delete('/roles/hr/short-lived'),
        farhana.patch(`/users/${KARIM}/roles`, { module: 'hr', role: 'short-lived' }),
      ]);
      const roleExists = (await hrRoles()).some((role) => role.key === 'short-lived');
      const assigned = (await User.findById(KARIM).lean())!.assignments.hr === 'short-lived';
      expect(roleExists || !assigned).toBe(true);
    });
  });

  it('is refused until a super admin gives role.update in that module', async () => {
    const karim = await as('karim');
    expect((await karim.post('/roles/hr', salaryReader)).status).toBe(403);
    expect((await karim.get('/roles/manageable')).status).toBe(403);
  });

  describe('once given role.update and salary.read in HR', () => {
    beforeEach(async () => {
      expect((await givePermissions('hr', ['role.update', 'salary.read'])).status).toBe(200);
    });

    it('creates a role from what they hold, which can be given straight away', async () => {
      expect((await (await as('karim')).post('/roles/hr', salaryReader)).status).toBe(201);
      expect((await (await as('kamrul')).patch('/users/u_09/roles', { module: 'hr', role: 'salary-reader' })).status).toBe(200);
    });

    it.each([
      ['a permission they do not hold', { salary: { actions: ['update'], scope: 'team' } }],
      ['a wider reach than they hold', { salary: { actions: ['read'], scope: 'all' } }],
      ['everything in the module', '*'],
    ])('refuses %s', async (_label, grants) => {
      const response = await (await as('karim')).post('/roles/hr', { ...salaryReader, grants });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('beyond_own_access');
    });

    it('stays inside that module', async () => {
      const response = await (await as('karim')).post('/roles/employee', { key: 'reader', name: 'Reader', grants: {} });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('edits a role they made, but can not widen it', async () => {
      const karim = await as('karim');
      await karim.post('/roles/hr', salaryReader);
      expect((await karim.patch('/roles/hr/salary-reader', { name: 'Pay reader' })).status).toBe(200);
      const widened = await karim.patch('/roles/hr/salary-reader', { grants: { salary: { actions: ['read', 'update'], scope: 'team' } } });
      expect(widened.body.error.code).toBe('beyond_own_access');
    });

    it('can not rename, change or delete a role stronger than their own access', async () => {
      const karim = await as('karim');
      expect((await karim.patch('/roles/hr/admin', { name: 'Boss' })).body.error.code).toBe('beyond_own_access');
      expect((await karim.patch('/roles/hr/admin', { grants: {} })).body.error.code).toBe('beyond_own_access');
      expect((await karim.delete('/roles/hr/admin')).body.error.code).toBe('beyond_own_access');
    });

    it('lists only the module they can edit, with what they may use', async () => {
      const { body } = await (await as('karim')).get('/roles/manageable');
      expect(body.modules.map((module: { key: string }) => module.key)).toEqual(['hr']);
      expect(body.modules[0].assignable).toEqual({ 'role.update': 'all', 'salary.read': 'team' });
    });

    it('can not change what a module offers', async () => {
      const response = await (await as('karim')).put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
      expect(response.status).toBe(403);
    });

    it('ends when role.update is taken away', async () => {
      const karim = await as('karim');
      await givePermissions('hr', ['salary.read']);
      expect((await karim.post('/roles/hr', salaryReader)).status).toBe(403);
    });
  });

  it('does not reach other modules from role.update in Master', async () => {
    await givePermissions('master', ['role.update']);
    const response = await (await as('karim')).post('/roles/hr', salaryReader);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('leaves a super admin free to use any permission, and shows the APIs each one opens', async () => {
    const farhana = await as('farhana');
    expect((await farhana.post('/roles/hr', { key: 'everything', name: 'Everything', grants: '*' })).status).toBe(201);
    const { body } = await farhana.get('/roles/manageable');
    const hr = body.modules.find((module: { key: string }) => module.key === 'hr');
    expect(hr.apis['salary.read']).toEqual(['GET /hr/salaries']);
    expect(hr.apis['role.update']).toContain('POST /roles/:module');
    expect(hr.assignable['salary.approve']).toBe('all');
  });
});
