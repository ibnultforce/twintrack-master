import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const REASON = 'Covering payroll this month';

describe('what only a super admin can change', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('farhana', { superAdmin: true });
    await addPerson('tariq', { superAdmin: true });
    await addPerson('alia', { assignments: { master: 'admin' } });
    await addPerson('sabbir', { assignments: { master: 'hr-access' } });
    await addPerson('rahim', { assignments: { hr: 'manager' } });
    await addPerson('karim');
  });

  describe('any person', () => {
    it('sets a role on another super admin, and on themselves', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch('/users/tariq/roles', { module: 'hr', role: 'manager' })).body.assignments).toEqual({ hr: 'manager' });
      expect((await farhana.patch('/users/farhana/roles', { module: 'hr', role: 'manager' })).status).toBe(200);
    });

    it('leaves a super admin with everything, whatever role is on their record', async () => {
      await (await as('farhana')).patch('/users/tariq/roles', { module: 'hr', role: 'viewer' });
      const permissions = await (await as('tariq')).get('/me/permissions/hr');
      expect(permissions.body).toMatchObject({ role: 'super-admin' });
      expect(permissions.body.permissions['salary.update']).toBe('all');
    });

    it('sets privileges on themselves', async () => {
      const response = await (await as('farhana')).put('/users/farhana/privileges', { module: 'hr', permissions: ['salary.read'], reason: REASON });
      expect(response.status).toBe(200);
      expect(response.body.privileges).toEqual({ hr: ['salary.read'] });
    });
  });

  describe('any permission', () => {
    const giveSalaryUpdate = { module: 'hr', permissions: ['salary.update'], reason: REASON };

    it('gives a permission the module does not mark grantable, and it works at once', async () => {
      const karim = await as('karim');
      const response = await (await as('farhana')).put('/users/karim/privileges', giveSalaryUpdate);
      expect(response.status).toBe(200);
      expect(response.body.superAdminGrants).toEqual({ hr: ['salary.update'] });
      expect(response.body.privileges).toEqual({});

      const permissions = await karim.get('/me/permissions/hr');
      expect(permissions.body.hasAccess).toBe(true);
      expect(permissions.body.permissions['salary.update']).toBe('team');
    });

    it('keeps grantable and super-admin-only permissions apart, and clears both', async () => {
      const farhana = await as('farhana');
      const both = await farhana.put('/users/karim/privileges', { ...giveSalaryUpdate, permissions: ['salary.read', 'salary.update'] });
      expect(both.body.privileges).toEqual({ hr: ['salary.read'] });
      expect(both.body.superAdminGrants).toEqual({ hr: ['salary.update'] });

      const cleared = await farhana.put('/users/karim/privileges', { module: 'hr', permissions: [] });
      expect(cleared.body.privileges).toEqual({});
      expect(cleared.body.superAdminGrants).toEqual({});
    });

    it('offers every permission in the access options', async () => {
      const options = async (id: string) => {
        const { body } = await (await as(id)).get('/users/access-options');
        return body.modules.find((module: { key: string }) => module.key === 'hr').grantable;
      };
      expect(await options('farhana')).toContainEqual({ permission: 'salary.update', scope: 'team' });
      expect(await options('alia')).not.toContainEqual({ permission: 'salary.update', scope: 'team' });
    });

    it('still refuses a permission the module does not have', async () => {
      const response = await (await as('farhana')).put('/users/karim/privileges', { ...giveSalaryUpdate, permissions: ['salary.fly'] });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('not_grantable');
    });

    it('still needs a reason', async () => {
      const response = await (await as('farhana')).put('/users/karim/privileges', { module: 'hr', permissions: ['salary.update'] });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('reason');
    });

    it('is not open to anyone else', async () => {
      const response = await (await as('alia')).put('/users/karim/privileges', giveSalaryUpdate);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('not_grantable');
    });

    it('stops other people removing what a super admin gave', async () => {
      await (await as('farhana')).put('/users/karim/privileges', giveSalaryUpdate);
      const response = await (await as('sabbir')).put('/users/karim/privileges', { module: 'hr', permissions: [] });
      expect(response.status).toBe(200);
      expect(response.body.superAdminGrants).toEqual({ hr: ['salary.update'] });
    });

    it('keeps other people out of super admins and their own access, as before', async () => {
      const alia = await as('alia');
      expect((await alia.patch('/users/farhana/roles', { module: 'hr', role: 'admin' })).body.error.code).toBe('super_admin');
      expect((await alia.patch('/users/alia/roles', { module: 'hr', role: 'admin' })).body.error.code).toBe('own_access');
    });
  });

  describe('PATCH /roles/:module/:key', () => {
    const managerWithSalary = { grants: { salary: { actions: ['read', 'update'], scope: 'team' } } };

    it('changes what a role allows, on the next request of everyone who has it', async () => {
      const rahim = await as('rahim');
      expect((await rahim.get('/me/permissions/hr')).body.permissions['salary.update']).toBeUndefined();

      const response = await (await as('farhana')).patch('/roles/hr/manager', { ...managerWithSalary, name: 'Team Lead' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ module: 'hr', key: 'manager', name: 'Team Lead', grants: ['salary.read (team)', 'salary.update (team)'] });

      const permissions = await rahim.get('/me/permissions/hr');
      expect(permissions.body.roleName).toBe('Team Lead');
      expect(permissions.body.permissions['salary.update']).toBe('team');
      expect(permissions.body.permissions['salary.approve']).toBeUndefined();
    });

    it('records the change, and marks the module as edited', async () => {
      await (await as('farhana')).patch('/roles/hr/manager', managerWithSalary);
      const entry = await AuditLog.findOne({ action: 'role.updated' }).lean();
      expect(entry).toMatchObject({ actorId: 'farhana', module: 'hr', targetId: 'hr.manager', after: { grants: managerWithSalary.grants } });
      expect((await Module.findOne({ key: 'hr' }).lean())?.permissionsEditedAt).toBeInstanceOf(Date);
    });

    it('can edit Master\'s own roles, without locking out the super admin', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch('/roles/master/admin', { grants: { user: { actions: ['read'] } } })).status).toBe(200);
      expect((await (await as('alia')).get('/modules')).status).toBe(403);
      expect((await farhana.get('/modules')).status).toBe(200);
    });

    it.each([
      ['an unknown resource', { grants: { ghost: { actions: ['read'] } } }, 'is not a resource'],
      ['an unknown action', { grants: { salary: { actions: ['fly'] } } }, 'grants.salary.actions'],
      ['a narrow scope on an unscoped resource', { grants: { access: { actions: ['read'], scope: 'team' } } }, "isn't scoped"],
    ])('refuses %s, and saves nothing', async (_label, body, message) => {
      const response = await (await as('farhana')).patch('/roles/hr/manager', body);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.fields)).toContain(message);
      expect((await Module.findOne({ key: 'hr' }).lean())?.permissionsEditedAt).toBeUndefined();
    });

    it.each([
      ['no fields', {}],
      ['another field', { key: 'renamed' }],
      ['grants that are neither "*" nor a list', { grants: 'everything' }],
    ])('refuses a request with %s', async (_label, body) => {
      expect((await (await as('farhana')).patch('/roles/hr/manager', body)).status).toBe(422);
    });

    it('answers 404 for a module or role that does not exist', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch('/roles/account/viewer', managerWithSalary)).body.error.code).toBe('unknown_module');
      expect((await farhana.patch('/roles/hr/emperor', managerWithSalary)).body.error.code).toBe('unknown_role');
    });

    it('is refused for an Access Admin, whose role has no role.update', async () => {
      const response = await (await as('alia')).patch('/roles/hr/manager', managerWithSalary);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('is refused for anyone without role.update', async () => {
      const response = await (await as('sabbir')).patch('/roles/hr/manager', managerWithSalary);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  describe('PUT /modules/:key/resources/:resource/grantable', () => {
    const path = '/modules/hr/resources/salary/grantable';

    it('changes what can be given to one person, so an Access Admin can give it', async () => {
      const giveSalaryUpdate = { module: 'hr', permissions: ['salary.update'], reason: REASON };
      const alia = await as('alia');
      expect((await alia.put('/users/karim/privileges', giveSalaryUpdate)).status).toBe(422);

      const response = await (await as('farhana')).put(path, { actions: ['read', 'update'] });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ module: 'hr', resource: 'salary', grantable: ['read', 'update'] });
      expect((await alia.put('/users/karim/privileges', giveSalaryUpdate)).status).toBe(200);
    });

    it('stops a privilege counting once it is no longer allowed', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { 'privileges.hr': ['salary.read'] } });
      const karim = await as('karim');
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(true);

      await (await as('farhana')).put(path, { actions: [] });
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(false);
    });

    it('records the change', async () => {
      await (await as('farhana')).put(path, { actions: ['read', 'update'] });
      const entry = await AuditLog.findOne({ action: 'module.grantable_changed' }).lean();
      expect(entry).toMatchObject({ actorId: 'farhana', targetId: 'hr.salary', before: { grantable: ['read'] }, after: { grantable: ['read', 'update'] } });
    });

    it('lets module.update narrow the list, but only a super admin widen it', async () => {
      await User.updateOne({ _id: 'alia' }, { $set: { 'superAdminGrants.master': ['module.update'] } });
      const alia = await as('alia');
      const widened = await alia.put(path, { actions: ['read', 'update'] });
      expect(widened.status).toBe(403);
      expect(widened.body.error.code).toBe('beyond_own_access');
      expect((await alia.put(path, { actions: [] })).status).toBe(200);
    });

    it('refuses an action the resource does not have', async () => {
      expect((await (await as('farhana')).put(path, { actions: ['delete'] })).status).toBe(422);
    });

    it('answers 404 for a module or resource that does not exist', async () => {
      const farhana = await as('farhana');
      expect((await farhana.put('/modules/account/resources/salary/grantable', { actions: [] })).body.error.code).toBe('unknown_module');
      expect((await farhana.put('/modules/hr/resources/ghost/grantable', { actions: [] })).body.error.code).toBe('unknown_resource');
    });

    it('is refused for an Access Admin', async () => {
      const response = await (await as('alia')).put(path, { actions: ['read', 'update'] });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  describe('POST and DELETE /roles/:module', () => {
    const lead = { key: 'lead', name: 'Team Lead', grants: { salary: { actions: ['read'], scope: 'team' } } };

    it('adds a role that can be given straight away and takes effect', async () => {
      const farhana = await as('farhana');
      const response = await farhana.post('/roles/hr', lead);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ module: 'hr', key: 'lead', name: 'Team Lead' });

      expect((await farhana.patch('/users/karim/roles', { module: 'hr', role: 'lead' })).status).toBe(200);
      const permissions = await (await as('karim')).get('/me/permissions/hr');
      expect(permissions.body).toMatchObject({ role: 'lead', roleName: 'Team Lead' });
      expect(permissions.body.permissions['salary.read']).toBe('team');
    });

    it.each([
      ['a key already used', { ...lead, key: 'manager' }],
      ['a badly formed key', { ...lead, key: 'Team Lead' }],
      ['a permission the module does not have', { ...lead, grants: { salary: { actions: ['fly'] } } }],
    ])('refuses %s', async (_label, body) => {
      expect((await (await as('farhana')).post('/roles/hr', body)).status).toBe(422);
    });

    it('removes a role nobody holds', async () => {
      const farhana = await as('farhana');
      await farhana.post('/roles/hr', lead);
      expect((await farhana.delete('/roles/hr/lead')).status).toBe(200);
      expect((await farhana.get('/roles')).body.roles.some((role: { module: string; key: string }) => role.module === 'hr' && role.key === 'lead')).toBe(false);
    });

    it('refuses to remove a role someone holds', async () => {
      const response = await (await as('farhana')).delete('/roles/hr/manager');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('role_in_use');
    });

    it('is refused for an Access Admin', async () => {
      expect((await (await as('alia')).post('/roles/hr', lead)).body.error.code).toBe('forbidden');
      expect((await (await as('alia')).delete('/roles/hr/viewer')).body.error.code).toBe('forbidden');
    });
  });

  describe('PUT and DELETE /modules/:key/resources/:resource', () => {
    it('adds a resource whose permissions a role can then use', async () => {
      const farhana = await as('farhana');
      const added = await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read', 'approve'] });
      expect(added.status).toBe(201);
      expect((await farhana.patch('/roles/hr/staff', { grants: { bonus: { actions: ['approve'] } } })).status).toBe(200);
      await farhana.patch('/users/karim/roles', { module: 'hr', role: 'staff' });
      expect((await (await as('karim')).get('/me/permissions/hr')).body.permissions).toEqual({ 'bonus.approve': 'all' });
    });

    it('adds an action to a resource, and keeps what is grantable', async () => {
      const response = await (await as('farhana')).put('/modules/hr/resources/salary', { label: 'Salaries', actions: ['read', 'create', 'update', 'approve', 'delete'] });
      expect(response.status).toBe(200);
      expect(response.body.resource).toMatchObject({ scoped: true, grantable: ['read'], actions: ['read', 'create', 'update', 'approve', 'delete'] });
    });

    it('refuses removing an action a role still uses', async () => {
      const response = await (await as('farhana')).put('/modules/hr/resources/salary', { label: 'Salaries', actions: ['update'] });
      expect(response.status).toBe(422);
    });

    it('refuses removing an action a route uses', async () => {
      const response = await (await as('farhana')).put('/modules/master/resources/audit', { label: 'Activity log', actions: ['delete'] });
      expect(response.status).toBe(422);
    });

    it('removes a resource nothing uses, and refuses one still in use', async () => {
      const farhana = await as('farhana');
      await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
      expect((await farhana.delete('/modules/hr/resources/bonus')).status).toBe(200);
      expect((await farhana.delete('/modules/hr/resources/salary')).status).toBe(422);
      expect((await farhana.delete('/modules/hr/resources/ghost')).body.error.code).toBe('unknown_resource');
    });

    it('is refused for an Access Admin', async () => {
      const response = await (await as('alia')).put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  describe('deciding from permissions alone', () => {
    it('lets anyone whose role is given role.update edit the rules, and stops when it is taken away', async () => {
      const farhana = await as('farhana');
      const sabbir = await as('sabbir');
      const grants = { salary: { actions: ['read'], scope: 'all' } };
      await farhana.patch('/users/sabbir/roles', { module: 'hr', role: 'staff' });
      expect((await sabbir.patch('/roles/hr/viewer', { name: 'Reader' })).status).toBe(403);

      await farhana.patch('/roles/hr/staff', { grants: { ...grants, role: { actions: ['update'] } } });
      expect((await sabbir.patch('/roles/hr/viewer', { name: 'Reader' })).status).toBe(200);

      await farhana.patch('/roles/hr/staff', { grants });
      expect((await sabbir.patch('/roles/hr/viewer', { name: 'Viewer' })).status).toBe(403);
    });

    it('takes which module a role can change access in from the Master manifest', async () => {
      const master = await Module.findOne({ key: 'master' }).lean();
      const resources = master!.resources.map((resource) => (resource.key === 'hrAccess' ? { ...resource, managesAccessOf: 'master' } : resource));
      await Module.updateOne({ key: 'master' }, { $set: { resources } });

      const sabbir = await as('sabbir');
      expect((await sabbir.patch('/users/karim/roles', { module: 'master', role: 'auditor' })).status).toBe(200);
      expect((await sabbir.patch('/users/karim/roles', { module: 'hr', role: 'staff' })).body.error.code).toBe('hr_roles_only');
    });

    it('gives the scenario\'s salary permissions from role data', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { 'assignments.hr': 'admin' } });
      const salaryOf = async (id: string) => {
        const { body } = await (await as(id)).get('/me/permissions/hr');
        return Object.keys(body.permissions).filter((permission) => permission.startsWith('salary.')).sort();
      };
      expect(await salaryOf('karim')).toEqual(['salary.approve', 'salary.create', 'salary.read', 'salary.update']);
      expect(await salaryOf('rahim')).toEqual(['salary.read']);
    });
  });

  describe('protecting a super admin\'s edits', () => {
    const hrManifest = async () => {
      const module = await Module.findOne({ key: 'hr' }).lean();
      return { manifestVersion: 1, module: { key: 'hr', name: 'HR', version: '9.0.0' }, resources: module!.resources, routes: [], roles: module!.roles };
    };

    beforeEach(async () => {
      await (await as('farhana')).put('/modules/hr/resources/salary/grantable', { actions: ['read', 'update'] });
    });

    it('stops an Access Admin importing over them', async () => {
      const response = await (await as('alia')).post('/modules/import', { manifest: await hrManifest(), password: TEST_PASSWORD });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('permissions_edited');
      expect((await Module.findOne({ key: 'hr' }).lean())?.version).not.toBe('9.0.0');
    });

    it('stops an Access Admin removing the module', async () => {
      const response = await (await as('alia')).delete('/modules/hr');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('permissions_edited');
    });

    it('lets a super admin replace them, which clears the mark', async () => {
      const response = await (await as('farhana')).post('/modules/import', { manifest: await hrManifest(), password: TEST_PASSWORD });
      expect(response.status).toBe(200);
      expect((await Module.findOne({ key: 'hr' }).lean())?.permissionsEditedAt).toBeUndefined();
      expect((await (await as('alia')).post('/modules/import', { manifest: await hrManifest(), password: TEST_PASSWORD })).status).toBe(200);
    });

    it('lets a super admin remove the module', async () => {
      expect((await (await as('farhana')).delete('/modules/hr')).status).toBe(200);
    });
  });
});
