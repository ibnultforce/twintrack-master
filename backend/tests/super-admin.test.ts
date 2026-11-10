import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const REASON = 'Covering payroll this month';

/** Gives one person a profile with these grants, straight in the database. */
async function giveProfile(personId: string, grants: Record<string, unknown>) {
  await AccessProfile.findByIdAndUpdate(`ap_${personId}`, { $set: { name: `Profile of ${personId}`, grants } }, { upsert: true });
  await User.updateOne({ _id: personId }, { $set: { profileId: `ap_${personId}` } });
}

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
    await addPerson('alia', { permissionSets: { master: ['admin'] } });
    await addPerson('sabbir', { permissionSets: { master: ['hr-access'] } });
    await addPerson('rahim', { permissionSets: { hr: ['manager'] } });
    await addPerson('karim');
  });

  describe('any person', () => {
    it('gives a permission set to another super admin, and to themselves', async () => {
      const farhana = await as('farhana');
      const toTariq = await farhana.put('/users/tariq/permission-sets', { module: 'hr', permissionSets: ['manager'], reason: REASON });
      expect(toTariq.body.permissionSets).toEqual({ hr: ['manager'] });
      expect((await farhana.put('/users/farhana/permission-sets', { module: 'hr', permissionSets: ['manager'], reason: REASON })).status).toBe(200);
    });

    it('gives themselves a profile, which nobody else may do', async () => {
      const profile = await AccessProfile.create({ _id: 'ap_staff', name: 'Staff', grants: {} });
      expect((await (await as('farhana')).patch('/users/farhana', { profileId: profile._id })).status).toBe(200);
      const refused = await (await as('alia')).patch('/users/alia', { profileId: profile._id });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('own_account');
    });

    it('leaves a super admin with everything, whatever is on their record', async () => {
      await (await as('farhana')).put('/users/tariq/permission-sets', { module: 'hr', permissionSets: ['viewer'], reason: REASON });
      const permissions = await (await as('tariq')).get('/me/permissions/hr');
      expect(permissions.body).toMatchObject({ profile: 'super-admin' });
      expect(permissions.body.permissions['salary.update']).toBe('all');
    });

    it('keeps other people out of super admins and their own access, as before', async () => {
      const alia = await as('alia');
      const giveAdmin = { module: 'hr', permissionSets: ['admin'], reason: REASON };
      expect((await alia.put('/users/farhana/permission-sets', giveAdmin)).body.error.code).toBe('super_admin');
      expect((await alia.put('/users/alia/permission-sets', giveAdmin)).body.error.code).toBe('own_access');
    });
  });

  describe('profiles beyond their own access', () => {
    it('lets a super admin build a profile holding everything in a module, which works at once', async () => {
      const farhana = await as('farhana');
      const created = await farhana.post('/access-profiles', { name: 'HR lead', grants: { hr: '*' } });
      expect(created.status).toBe(201);
      await farhana.patch('/users/karim', { profileId: created.body.id });
      expect((await (await as('karim')).get('/me/permissions/hr')).body.permissions['salary.approve']).toBe('all');
    });

    it('refuses anyone else a profile beyond what they hold', async () => {
      await giveProfile('karim', { master: { accessProfile: { actions: ['read', 'create'] } }, hr: { salary: { actions: ['read'], scope: 'team' } } });
      const karim = await as('karim');
      expect((await karim.post('/access-profiles', { name: 'Reader', grants: { hr: { salary: { actions: ['read'], scope: 'team' } } } })).status).toBe(201);
      for (const grants of [{ hr: '*' }, { hr: { salary: { actions: ['update'], scope: 'team' } } }, { hr: { salary: { actions: ['read'], scope: 'all' } } }]) {
        const response = await karim.post('/access-profiles', { name: 'Too much', grants });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('beyond_own_access');
      }
    });
  });

  describe('PATCH /permission-sets/:module/:key', () => {
    const managerWithSalary = { grants: { salary: { actions: ['read', 'update'], scope: 'team' } } };

    it('changes what a permission set allows, on the next request of everyone who has it', async () => {
      const rahim = await as('rahim');
      expect((await rahim.get('/me/permissions/hr')).body.permissions['salary.update']).toBeUndefined();

      const response = await (await as('farhana')).patch('/permission-sets/hr/manager', { ...managerWithSalary, name: 'Team Lead' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ module: 'hr', key: 'manager', name: 'Team Lead', grants: ['salary.read (team)', 'salary.update (team)'] });

      const permissions = await rahim.get('/me/permissions/hr');
      expect(permissions.body.permissionSets).toEqual(['manager']);
      expect(permissions.body.permissions['salary.update']).toBe('team');
      expect(permissions.body.permissions['salary.approve']).toBeUndefined();
    });

    it('records the change, and marks the module as edited', async () => {
      await (await as('farhana')).patch('/permission-sets/hr/manager', managerWithSalary);
      const entry = await AuditLog.findOne({ action: 'permission_set.updated' }).lean();
      expect(entry).toMatchObject({ actorId: 'farhana', module: 'hr', targetId: 'hr.manager', after: { grants: managerWithSalary.grants } });
      expect((await Module.findOne({ key: 'hr' }).lean())?.permissionsEditedAt).toBeInstanceOf(Date);
    });

    it('can edit Master\'s own permission sets, without locking out the super admin', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch('/permission-sets/master/admin', { grants: { user: { actions: ['read'] } } })).status).toBe(200);
      expect((await (await as('alia')).get('/modules')).status).toBe(403);
      expect((await farhana.get('/modules')).status).toBe(200);
    });

    it.each([
      ['an unknown resource', { grants: { ghost: { actions: ['read'] } } }, 'is not a resource'],
      ['an unknown action', { grants: { salary: { actions: ['fly'] } } }, 'grants.salary.actions'],
      ['a narrow scope on an unscoped resource', { grants: { access: { actions: ['read'], scope: 'team' } } }, "isn't scoped"],
    ])('refuses %s, and saves nothing', async (_label, body, message) => {
      const response = await (await as('farhana')).patch('/permission-sets/hr/manager', body);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.fields)).toContain(message);
      expect((await Module.findOne({ key: 'hr' }).lean())?.permissionsEditedAt).toBeUndefined();
    });

    it.each([
      ['no fields', {}],
      ['another field', { key: 'renamed' }],
      ['grants that are neither "*" nor a list', { grants: 'everything' }],
    ])('refuses a request with %s', async (_label, body) => {
      expect((await (await as('farhana')).patch('/permission-sets/hr/manager', body)).status).toBe(422);
    });

    it('answers 404 for a module or permission set that does not exist', async () => {
      const farhana = await as('farhana');
      expect((await farhana.patch('/permission-sets/account/viewer', managerWithSalary)).body.error.code).toBe('unknown_module');
      expect((await farhana.patch('/permission-sets/hr/emperor', managerWithSalary)).body.error.code).toBe('unknown_permission_set');
    });

    it.each(['alia', 'sabbir'])('is refused for %s, who holds no permissionSet.update in HR', async (id) => {
      const response = await (await as(id)).patch('/permission-sets/hr/manager', managerWithSalary);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  describe('POST and DELETE /permission-sets/:module', () => {
    const lead = { key: 'lead', name: 'Team Lead', grants: { salary: { actions: ['read'], scope: 'team' } } };

    it('adds a permission set that can be given straight away and takes effect', async () => {
      const farhana = await as('farhana');
      const response = await farhana.post('/permission-sets/hr', lead);
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ module: 'hr', key: 'lead', name: 'Team Lead' });

      expect((await farhana.put('/users/karim/permission-sets', { module: 'hr', permissionSets: ['lead'], reason: REASON })).status).toBe(200);
      const permissions = await (await as('karim')).get('/me/permissions/hr');
      expect(permissions.body).toMatchObject({ permissionSets: ['lead'] });
      expect(permissions.body.permissions['salary.read']).toBe('team');
    });

    it.each([
      ['a key already used', { ...lead, key: 'manager' }],
      ['a badly formed key', { ...lead, key: 'Team Lead' }],
      ['a permission the module does not have', { ...lead, grants: { salary: { actions: ['fly'] } } }],
    ])('refuses %s', async (_label, body) => {
      expect((await (await as('farhana')).post('/permission-sets/hr', body)).status).toBe(422);
    });

    it('removes a permission set nobody holds', async () => {
      const farhana = await as('farhana');
      await farhana.post('/permission-sets/hr', lead);
      expect((await farhana.delete('/permission-sets/hr/lead')).status).toBe(200);
      const hr = (await farhana.get('/permission-sets')).body.modules.find((module: { key: string }) => module.key === 'hr');
      expect(hr.permissionSets.some((permissionSet: { key: string }) => permissionSet.key === 'lead')).toBe(false);
    });

    it('refuses to remove a permission set someone holds', async () => {
      const response = await (await as('farhana')).delete('/permission-sets/hr/manager');
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('permission_set_in_use');
    });

    it('is refused for an Access Admin', async () => {
      expect((await (await as('alia')).post('/permission-sets/hr', lead)).body.error.code).toBe('forbidden');
      expect((await (await as('alia')).delete('/permission-sets/hr/viewer')).body.error.code).toBe('forbidden');
    });
  });

  describe('PUT and DELETE /modules/:key/resources/:resource', () => {
    it('adds a resource whose permissions a permission set can then use', async () => {
      const farhana = await as('farhana');
      const added = await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read', 'approve'] });
      expect(added.status).toBe(201);
      expect((await farhana.patch('/permission-sets/hr/staff', { grants: { bonus: { actions: ['approve'] } } })).status).toBe(200);
      await farhana.put('/users/karim/permission-sets', { module: 'hr', permissionSets: ['staff'], reason: REASON });
      expect((await (await as('karim')).get('/me/permissions/hr')).body.permissions).toEqual({ 'bonus.approve': 'all' });
    });

    it('adds an action to a resource, and keeps it scoped', async () => {
      const response = await (await as('farhana')).put('/modules/hr/resources/salary', { label: 'Salaries', actions: ['read', 'create', 'update', 'approve', 'delete'] });
      expect(response.status).toBe(200);
      expect(response.body.resource).toMatchObject({ scoped: true, actions: ['read', 'create', 'update', 'approve', 'delete'] });
    });

    it.each([
      { permission: 'create', adds: 201, changes: 403 },
      { permission: 'update', adds: 403, changes: 200 },
    ])('module.$permission allows only its own action on resources', async ({ permission, adds, changes }) => {
      await giveProfile('karim', { master: { module: { actions: [permission] } } });
      const karim = await as('karim');
      expect((await karim.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] })).status).toBe(adds);
      expect((await karim.put('/modules/hr/resources/salary', { label: 'Pay', actions: ['read', 'create', 'update', 'approve', 'delete'] })).status).toBe(changes);
      expect((await karim.delete('/modules/hr/resources/ghost')).status).toBe(403);
    });

    it('module.delete removes a resource but cannot add or change one', async () => {
      await giveProfile('karim', { master: { module: { actions: ['delete'] } } });
      const karim = await as('karim');
      expect((await karim.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] })).status).toBe(403);
      expect((await karim.delete('/modules/hr/resources/ghost')).body.error.code).toBe('unknown_resource');
    });

    describe('for someone who is not a super admin', () => {
      const asModuleAdmin = async () => {
        await giveProfile('karim', { master: { module: { actions: ['create', 'update', 'delete'] } } });
        return as('karim');
      };

      it('names the API using an action instead of reporting manifest paths', async () => {
        const response = await (await asModuleAdmin()).put('/modules/master/resources/user', { label: 'Users', actions: ['read', 'update'] });
        expect(response.status).toBe(422);
        expect(response.body.error.message).toContain('create is used by POST /users');
        expect(response.body.error.message).not.toContain('routes.');
      });

      it('locks an action only until the last permission set using it lets go', async () => {
        const farhana = await as('farhana');
        await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read', 'approve'] });
        await farhana.patch('/permission-sets/hr/staff', { grants: { bonus: { actions: ['approve'] } } });
        const karim = await asModuleAdmin();

        const whileUsed = await karim.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
        expect(whileUsed.status).toBe(422);
        expect(whileUsed.body.error.message).toContain('approve is used by permission set');

        await farhana.patch('/permission-sets/hr/staff', { grants: { bonus: { actions: ['read'] } } });
        expect((await karim.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] })).status).toBe(200);
      });

      it('locks an action a profile uses', async () => {
        const farhana = await as('farhana');
        await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read', 'approve'] });
        await AccessProfile.create({ _id: 'ap_bonus', name: 'Bonus approver', grants: { hr: { bonus: { actions: ['approve'] } } } });
        const response = await (await asModuleAdmin()).put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
        expect(response.status).toBe(422);
        expect(response.body.error.message).toContain('approve is used by profile Bonus approver');
      });

      it('refuses removing an action a permission set or a route uses', async () => {
        const karim = await asModuleAdmin();
        expect((await karim.put('/modules/hr/resources/salary', { label: 'Salaries', actions: ['update'] })).status).toBe(422);
        expect((await karim.put('/modules/master/resources/audit', { label: 'Activity log', actions: ['delete'] })).status).toBe(422);
      });

      it('removes a resource nothing uses, and refuses one still in use', async () => {
        const karim = await asModuleAdmin();
        await karim.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
        expect((await karim.delete('/modules/hr/resources/bonus')).status).toBe(200);
        expect((await karim.delete('/modules/hr/resources/salary')).status).toBe(422);
        expect((await karim.delete('/modules/hr/resources/ghost')).body.error.code).toBe('unknown_resource');
      });
    });

    it('removes an unused action and allows renaming with every used action kept', async () => {
      const farhana = await as('farhana');
      await farhana.put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read', 'approve', 'delete'] });
      expect((await farhana.put('/modules/hr/resources/bonus', { label: 'Bonus pay', actions: ['read'] })).status).toBe(200);
      const users = (await farhana.get('/modules')).body.modules.find((module: { key: string }) => module.key === 'master').usedBy;
      expect(users['user.create']).toContain('POST /users');
      const usersResource = await farhana.get('/modules/master/export');
      const actions = usersResource.body.resources.find((resource: { key: string }) => resource.key === 'user').actions;
      expect((await farhana.put('/modules/master/resources/user', { label: 'People', actions })).status).toBe(200);
    });

    it('lets a super admin remove an action that permission sets and profiles use, which they then lose', async () => {
      const farhana = await as('farhana');
      await AccessProfile.create({ _id: 'ap_reader', name: 'Reader', grants: { hr: { salary: { actions: ['read', 'update'], scope: 'team' } } } });
      expect((await farhana.put('/modules/hr/resources/salary', { label: 'Salaries', actions: ['update'] })).status).toBe(200);
      const permissionSets = (await farhana.get('/modules/hr/export')).body.permissionSets as { grants: Record<string, { actions: string[] }> | '*' }[];
      for (const permissionSet of permissionSets) {
        if (permissionSet.grants !== '*') expect(permissionSet.grants.salary?.actions ?? []).not.toContain('read');
      }
      expect((await AccessProfile.findById('ap_reader').lean())?.grants).toEqual({ hr: { salary: { actions: ['update'], scope: 'team' } } });
    });

    it('lets a super admin remove an action an API uses, and keeps the module editable afterwards', async () => {
      const farhana = await as('farhana');
      expect((await farhana.put('/modules/master/resources/permissionSet', { label: 'Permission sets', actions: ['read', 'create', 'update'] })).status).toBe(200);
      expect((await farhana.put('/modules/master/resources/user', { label: 'Users', actions: ['read', 'update'] })).status).toBe(200);
      expect((await farhana.put('/modules/master/resources/user', { label: 'People', actions: ['read', 'update'] })).status).toBe(200);
      // Nobody else can hold the removed permission, so only a super admin can still use the API.
      expect((await farhana.post('/users', {})).status).not.toBe(403);
    });

    it('lets a super admin remove a resource a permission set uses', async () => {
      expect((await (await as('farhana')).delete('/modules/hr/resources/salary')).status).toBe(200);
    });

    it('is refused for an Access Admin', async () => {
      const response = await (await as('alia')).put('/modules/hr/resources/salary', { label: 'Pay', actions: ['read', 'update'] });
      expect(response.body.error.code).toBe('forbidden');
    });
  });

  describe('deciding from permissions alone', () => {
    it('lets anyone whose permission set is given permissionSet.update edit the rules, and stops when it is taken away', async () => {
      const farhana = await as('farhana');
      const sabbir = await as('sabbir');
      const grants = { salary: { actions: ['read'], scope: 'all' } };
      await farhana.put('/users/sabbir/permission-sets', { module: 'hr', permissionSets: ['staff'], reason: REASON });
      expect((await sabbir.patch('/permission-sets/hr/viewer', { name: 'Reader' })).status).toBe(403);

      await farhana.patch('/permission-sets/hr/staff', { grants: { ...grants, permissionSet: { actions: ['update'] } } });
      expect((await sabbir.patch('/permission-sets/hr/viewer', { name: 'Reader' })).status).toBe(200);

      await farhana.patch('/permission-sets/hr/staff', { grants });
      expect((await sabbir.patch('/permission-sets/hr/viewer', { name: 'Viewer' })).status).toBe(403);
    });

    it('takes which module someone can change access in from the Master manifest', async () => {
      const master = await Module.findOne({ key: 'master' }).lean();
      const resources = master!.resources.map((resource) => (resource.key === 'hrAccess' ? { ...resource, managesAccessOf: 'master' } : resource));
      await Module.updateOne({ key: 'master' }, { $set: { resources } });

      const sabbir = await as('sabbir');
      expect((await sabbir.put('/users/karim/permission-sets', { module: 'master', permissionSets: ['auditor'], reason: REASON })).status).toBe(200);
      const refused = await sabbir.put('/users/karim/permission-sets', { module: 'hr', permissionSets: ['staff'], reason: REASON });
      expect(refused.body.error.code).toBe('module_access_only');
    });

    it('gives the scenario\'s salary permissions from permission set data', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { 'permissionSets.hr': ['admin'] } });
      const salaryOf = async (id: string) => {
        const { body } = await (await as(id)).get('/me/permissions/hr');
        return Object.keys(body.permissions).filter((permission) => permission.startsWith('salary.')).sort();
      };
      expect(await salaryOf('karim')).toEqual(['salary.approve', 'salary.create', 'salary.delete', 'salary.read', 'salary.share', 'salary.update']);
      expect(await salaryOf('rahim')).toEqual(['salary.read']);
    });
  });

  describe('protecting a super admin\'s edits', () => {
    const hrManifest = async () => {
      const module = await Module.findOne({ key: 'hr' }).lean();
      return { manifestVersion: 1, module: { key: 'hr', name: 'HR', version: '9.0.0' }, resources: module!.resources, routes: [], permissionSets: module!.permissionSets };
    };

    beforeEach(async () => {
      await (await as('farhana')).patch('/permission-sets/hr/viewer', { name: 'Reader' });
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
