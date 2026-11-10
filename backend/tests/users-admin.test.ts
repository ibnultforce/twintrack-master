import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Session } from '../src/modules/master/models/session.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';

const NEW_PASSWORD = 'a-brand-new-password';

describe('user administration', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true });
    await addPerson('alia', { name: 'Alia Access', permissionSets: { master: ['admin'] } });
    await addPerson('sabbir', { name: 'Sabbir Alam', permissionSets: { hr: ['staff'], master: ['hr-access'] } });
    await addPerson('rumana', { name: 'Rumana Akter', permissionSets: { master: ['auditor'] } });
    await addPerson('rahim', { name: 'Rahim Uddin', title: 'Engineering Lead', managerId: 'farhana', permissionSets: { hr: ['manager'] } });
    await addPerson('karim', { name: 'Karim Ahmed', title: 'Backend Developer', managerId: 'rahim' });
    await addPerson('jahid', { name: 'Jahid Rana', status: 'inactive' });
  });

  describe('who can reach each route', () => {
    const adminRoutes: [string, 'get' | 'post' | 'patch' | 'put', string, object?][] = [
      ['list people', 'get', '/users'],
      ['add a person', 'post', '/users', { name: 'New', email: 'new@twintrack.test' }],
      ['access options', 'get', '/users/access-options'],
      ['read a person', 'get', '/users/rahim'],
      ['edit a person', 'patch', '/users/rahim', { title: 'Boss' }],
      ['set status', 'patch', '/users/rahim/status', { status: 'inactive' }],
      ['reset a password', 'post', '/users/rahim/reset-password'],
      ['set permission sets', 'put', '/users/rahim/permission-sets', { module: 'hr', permissionSets: [] }],
    ];

    it.each(adminRoutes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(adminRoutes)('%s is refused for someone with no Master role', async (_label, method, path, body) => {
      const karim = await as('karim');
      const response = await karim[method](path, body as object);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('lets an auditor read people but change nothing', async () => {
      const auditor = await as('rumana');
      expect((await auditor.get('/users')).status).toBe(200);
      expect((await auditor.patch('/users/rahim', { title: 'Boss' })).status).toBe(403);
      expect((await auditor.put('/users/rahim/permission-sets', { module: 'hr', permissionSets: ['admin'], reason: 'No' })).status).toBe(403);
    });

    it('blocks an admin who still has a temporary password', async () => {
      const admin = await as('alia');
      await User.updateOne({ _id: 'alia' }, { $set: { mustChangePassword: true } });
      const response = await admin.get('/users');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('password_change_required');
    });
  });

  describe('GET /users', () => {
    it('lists people by name with a total, and never password data', async () => {
      const response = await (await as('alia')).get('/users?pageSize=2');
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(7);
      expect(response.body.users.map((user: { id: string }) => user.id)).toEqual(['alia', 'farhana']);
      expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|argon2/);
    });

    it('moves through pages without repeating anyone', async () => {
      const admin = await as('alia');
      const first = await admin.get('/users?page=1&pageSize=4');
      const second = await admin.get('/users?page=2&pageSize=4');
      const ids = [...first.body.users, ...second.body.users].map((user: { id: string }) => user.id);
      expect(new Set(ids).size).toBe(7);
    });

    it('searches name, email and title, ignoring case', async () => {
      const admin = await as('alia');
      expect((await admin.get('/users?search=RAHIM')).body.total).toBe(1);
      expect((await admin.get('/users?search=karim@')).body.total).toBe(1);
      expect((await admin.get('/users?search=backend')).body.total).toBe(1);
    });

    it('treats regular expression characters in a search as plain text', async () => {
      const response = await (await as('alia')).get(`/users?search=${encodeURIComponent('.*')}`);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(0);
    });

    it('filters by status', async () => {
      const response = await (await as('alia')).get('/users?status=inactive');
      expect(response.body.users.map((user: { id: string }) => user.id)).toEqual(['jahid']);
    });

    it.each(['page=0', 'pageSize=1000', 'page=abc', 'status=gone'])('refuses the query %s', async (query) => {
      expect((await (await as('alia')).get(`/users?${query}`)).status).toBe(422);
    });
  });

  describe('POST /users', () => {
    const newPerson = { name: 'Nadia Noor', email: 'NADIA@twintrack.test', title: 'Analyst', managerId: 'rahim', orgRoleId: 'or_root' };

    it('adds a person and shows the temporary password once', async () => {
      const response = await (await as('alia')).post('/users', newPerson);
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.user).toMatchObject({
        name: 'Nadia Noor',
        email: 'nadia@twintrack.test',
        contract: 'permanent',
        status: 'active',
        mustChangePassword: true,
        superAdmin: false,
        orgRoleId: 'or_root',
        permissionSets: {},
      });
      expect(response.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);
      expect(response.body.user.passwordHash).toBeUndefined();
    });

    it('records it without the password', async () => {
      const response = await (await as('alia')).post('/users', newPerson);
      const entry = await AuditLog.findOne({ action: 'user.created' }).lean();
      expect(entry).toMatchObject({ actorId: 'alia', targetId: response.body.user.id, targetName: 'Nadia Noor' });
      expect(JSON.stringify(entry)).not.toContain(response.body.temporaryPassword);
    });

    it('refuses an email already in use, in any case', async () => {
      const response = await (await as('alia')).post('/users', { name: 'Copy', email: 'RAHIM@twintrack.test', orgRoleId: 'or_root' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('email_taken');
      expect(await AuditLog.countDocuments({ action: 'user.created' })).toBe(0);
    });

    it('refuses a manager who does not exist', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, managerId: 'nobody' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('managerId');
    });

    it('needs a place in the org tree', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, orgRoleId: undefined });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
    });

    it('refuses an org role that does not exist', async () => {
      const response = await (await as('alia')).post('/users', { ...newPerson, orgRoleId: 'or_nowhere' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
      expect(await User.countDocuments({ email: 'nadia@twintrack.test' })).toBe(0);
    });

    it.each([
      ['super admin', { superAdmin: true }],
      ['a role', { permissionSets: { master: ['admin'] } }],
      ['a password hash', { passwordHash: 'x' }],
      ['an id', { _id: 'chosen' }],
    ])('refuses a request that tries to set %s', async (_label, extra) => {
      const response = await (await as('alia')).post('/users', { ...newPerson, ...extra });
      expect(response.status).toBe(422);
      expect(await User.countDocuments({ email: 'nadia@twintrack.test' })).toBe(0);
    });
  });

  describe('GET /users/access-options and /users/:id', () => {
    it('is not mistaken for a person called access-options', async () => {
      const response = await (await as('alia')).get('/users/access-options');
      expect(response.status).toBe(200);
      expect(response.body.modules.map((module: { key: string }) => module.key)).toEqual(['hr', 'master', 'tasks']);
    });

    it('offers the permission sets of each module, with what they allow', async () => {
      const { body } = await (await as('alia')).get('/users/access-options');
      const hr = body.modules.find((module: { key: string }) => module.key === 'hr');
      expect(hr.permissionSets).toContainEqual(expect.objectContaining({ key: 'manager', name: 'Manager', grants: ['salary.read (team)'] }));
    });

    it('says which modules this caller may change', async () => {
      const canChange = async (id: string) => {
        const { body } = await (await as(id)).get('/users/access-options');
        return Object.fromEntries(body.modules.map((module: { key: string; canChange: boolean }) => [module.key, module.canChange]));
      };
      expect(await canChange('alia')).toEqual({ hr: true, master: true, tasks: true });
      expect(await canChange('sabbir')).toEqual({ hr: true, master: false, tasks: false });
      expect(await canChange('rumana')).toEqual({ hr: false, master: false, tasks: false });
    });

    it('returns one person, and 404 for anyone else', async () => {
      const admin = await as('alia');
      const response = await admin.get('/users/rahim');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: 'rahim', name: 'Rahim Uddin', permissionSets: { hr: ['manager'] } });
      expect(response.body.passwordHash).toBeUndefined();

      const missing = await admin.get('/users/nobody');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('unknown_user');
    });
  });

  describe('PATCH /users/:id', () => {
    it('changes details, clears a field with null, and records only what changed', async () => {
      const response = await (await as('alia')).patch('/users/rahim', { title: null, team: 'Platform', name: 'Rahim Uddin' });
      expect(response.status).toBe(200);
      expect(response.body.team).toBe('Platform');
      expect(response.body.title).toBeUndefined();

      const entry = await AuditLog.findOne({ action: 'user.updated' }).lean();
      expect(entry).toMatchObject({
        actorId: 'alia',
        targetId: 'rahim',
        before: { title: 'Engineering Lead', team: null },
        after: { title: null, team: 'Platform' },
      });
    });

    it('writes nothing when nothing changes', async () => {
      await (await as('alia')).patch('/users/rahim', { name: 'Rahim Uddin' });
      expect(await AuditLog.countDocuments({ action: 'user.updated' })).toBe(0);
    });

    it('refuses an email someone else uses', async () => {
      const response = await (await as('alia')).patch('/users/rahim', { email: 'karim@twintrack.test' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('email_taken');
    });

    it.each([
      ['themselves', 'rahim', 'rahim'],
      ['someone who reports to them', 'rahim', 'karim'],
      ['someone who does not exist', 'rahim', 'nobody'],
    ])('refuses making a person report to %s', async (_label, id, managerId) => {
      const response = await (await as('alia')).patch(`/users/${id}`, { managerId });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('managerId');
    });

    it('moves a person to a new manager, and removes one with null', async () => {
      const admin = await as('alia');
      expect((await admin.patch('/users/karim', { managerId: 'farhana' })).body.managerId).toBe('farhana');
      expect((await admin.patch('/users/karim', { managerId: null })).body.managerId).toBeUndefined();
    });

    it('moves a person to another org role, and refuses one that does not exist', async () => {
      await addOrgRole('or_engineering', 'or_root');
      const admin = await as('alia');
      expect((await admin.patch('/users/karim', { orgRoleId: 'or_engineering' })).body.orgRoleId).toBe('or_engineering');

      const response = await admin.patch('/users/karim', { orgRoleId: 'or_nowhere' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('orgRoleId');
    });

    it('lets nobody move themselves in the org tree', async () => {
      const response = await (await as('alia')).patch('/users/alia', { orgRoleId: 'or_root' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_account');
    });

    it.each([
      ['no fields', {}],
      ['no org role', { orgRoleId: null }],
      ['super admin', { superAdmin: true }],
      ['a status', { status: 'inactive' }],
      ['a role', { permissionSets: { master: ['admin'] } }],
      ['a blank name', { name: ' ' }],
      ['an object as a title', { title: { $ne: null } }],
    ])('refuses a request with %s', async (_label, body) => {
      expect((await (await as('alia')).patch('/users/rahim', body)).status).toBe(422);
    });

    it('protects a super admin from anyone but another super admin', async () => {
      const response = await (await as('alia')).patch('/users/farhana', { email: 'taken-over@twintrack.test' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('super_admin_protected');

      await addPerson('tariq', { superAdmin: true });
      expect((await (await as('tariq')).patch('/users/farhana', { title: 'Founder' })).status).toBe(200);
    });
  });

  describe('PATCH /users/:id/status', () => {
    it('signs the person out everywhere on deactivation', async () => {
      const rahim = await as('rahim');
      expect((await rahim.get('/me/modules')).status).toBe(200);

      const response = await (await as('alia')).patch('/users/rahim/status', { status: 'inactive' });
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('inactive');

      const refused = await rahim.get('/me/modules');
      expect(refused.status).toBe(401);
      expect(await Session.countDocuments({ userId: 'rahim', revokedAt: { $exists: false } })).toBe(0);
    });

    it('does not bring an old session back on reactivation', async () => {
      const rahim = await as('rahim');
      const admin = await as('alia');
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'active' });

      const refused = await rahim.get('/me/modules');
      expect(refused.status).toBe(401);
      expect(refused.body.error.code).toBe('session_revoked');
      await signIn(app, 'rahim@twintrack.test');
    });

    it('records each change once', async () => {
      const admin = await as('alia');
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'inactive' });
      await admin.patch('/users/rahim/status', { status: 'active' });
      expect(await AuditLog.countDocuments({ action: 'user.deactivated', targetId: 'rahim' })).toBe(1);
      expect(await AuditLog.countDocuments({ action: 'user.reactivated', targetId: 'rahim' })).toBe(1);
    });

    it('refuses deactivating yourself', async () => {
      const response = await (await as('alia')).patch('/users/alia/status', { status: 'inactive' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_account');
    });

    it('refuses deactivating a super admin unless a super admin asks', async () => {
      const response = await (await as('alia')).patch('/users/farhana/status', { status: 'inactive' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('super_admin_protected');
    });

    it('refuses any other status', async () => {
      expect((await (await as('alia')).patch('/users/rahim/status', { status: 'deleted' })).status).toBe(422);
    });
  });

  describe('POST /users/:id/reset-password', () => {
    it('replaces the password, signs the person out and requires a change', async () => {
      const rahim = await as('rahim');
      const response = await (await as('alia')).post('/users/rahim/reset-password');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.user.mustChangePassword).toBe(true);

      expect((await rahim.get('/me/modules')).status).toBe(401);
      const oldPassword = await request(app)
        .post('/auth/login')
        .set('Origin', TEST_ORIGIN)
        .send({ email: 'rahim@twintrack.test', password: TEST_PASSWORD });
      expect(oldPassword.status).toBe(401);

      const fresh = requestsAs(app, await signIn(app, 'rahim@twintrack.test', response.body.temporaryPassword));
      expect((await fresh.get('/me/modules')).body.error.code).toBe('password_change_required');
    });

    it('gives a different password each time, and logs none of them', async () => {
      const admin = await as('alia');
      const first = (await admin.post('/users/rahim/reset-password')).body.temporaryPassword;
      const second = (await admin.post('/users/rahim/reset-password')).body.temporaryPassword;
      expect(first).not.toBe(second);

      const entries = JSON.stringify(await AuditLog.find({ action: 'user.password_reset' }).lean());
      expect(entries).not.toContain(first);
      expect(entries).not.toContain(second);
    });

    it('refuses your own account, so a stolen session cannot take it over', async () => {
      const response = await (await as('alia')).post('/users/alia/reset-password');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_account');
    });

    it('refuses a super admin unless a super admin asks', async () => {
      const response = await (await as('alia')).post('/users/farhana/reset-password');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('super_admin_protected');
    });

    it('answers 404 for someone who does not exist', async () => {
      expect((await (await as('alia')).post('/users/nobody/reset-password')).status).toBe(404);
    });
  });

  describe('PUT /users/:id/permission-sets', () => {
    const giveManager = { module: 'hr', permissionSets: ['manager'], reason: 'Leads the backend team' };

    it('gives a permission set and records it with the reason', async () => {
      const response = await (await as('alia')).put('/users/karim/permission-sets', giveManager);
      expect(response.status).toBe(200);
      expect(response.body.permissionSets).toEqual({ hr: ['manager'] });

      const entry = await AuditLog.findOne({ action: 'user.permission_sets_changed' }).lean();
      expect(entry).toMatchObject({
        actorId: 'alia',
        targetId: 'karim',
        module: 'hr',
        reason: giveManager.reason,
        before: { permissionSets: [] },
        after: { permissionSets: ['manager'] },
      });
    });

    it('takes every set away with an empty list, and needs no reason for that', async () => {
      const response = await (await as('alia')).put('/users/rahim/permission-sets', { module: 'hr', permissionSets: [] });
      expect(response.status).toBe(200);
      expect(response.body.permissionSets).toEqual({});
    });

    it('takes sets away in a module that is no longer loaded', async () => {
      await User.updateOne({ _id: 'rahim' }, { $set: { 'permissionSets.account': ['viewer'] } });
      const response = await (await as('alia')).put('/users/rahim/permission-sets', { module: 'account', permissionSets: [] });
      expect(response.status).toBe(200);
      expect(response.body.permissionSets.account).toBeUndefined();
    });

    it('needs a reason to give a new set', async () => {
      const response = await (await as('alia')).put('/users/karim/permission-sets', { module: 'hr', permissionSets: ['manager'] });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('reason');
    });

    it('applies on the person\'s next request, with the same token', async () => {
      const karim = await as('karim');
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(false);
      await (await as('sabbir')).put('/users/karim/permission-sets', giveManager);
      expect((await karim.get('/me/permissions/hr')).body.permissions['salary.read']).toBe('team');
    });

    it('lets an HR access manager change HR permission sets only', async () => {
      const sabbir = await as('sabbir');
      expect((await sabbir.put('/users/karim/permission-sets', giveManager)).status).toBe(200);

      const refused = await sabbir.put('/users/karim/permission-sets', { ...giveManager, module: 'master', permissionSets: ['admin'] });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('module_access_only');
      expect((await User.findById('karim').lean())?.permissionSets.master).toBeUndefined();
    });

    it('stops anyone changing their own access', async () => {
      const response = await (await as('alia')).put('/users/alia/permission-sets', giveManager);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('own_access');
    });

    it('has nothing to set on a super admin', async () => {
      const response = await (await as('alia')).put('/users/farhana/permission-sets', giveManager);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('super_admin');
    });

    it('refuses a set the module does not have, or a module not loaded', async () => {
      const admin = await as('alia');
      const unknownSet = await admin.put('/users/karim/permission-sets', { ...giveManager, permissionSets: ['emperor'] });
      expect(unknownSet.status).toBe(422);
      expect(unknownSet.body.error.code).toBe('unknown_permission_set');
      expect((await admin.put('/users/karim/permission-sets', { ...giveManager, module: 'account', permissionSets: ['viewer'] })).status).toBe(404);
    });

    it('stores a repeated set once, and writes nothing when nothing changes', async () => {
      const admin = await as('alia');
      const response = await admin.put('/users/karim/permission-sets', { ...giveManager, permissionSets: ['manager', 'manager'] });
      expect(response.body.permissionSets).toEqual({ hr: ['manager'] });

      await admin.put('/users/karim/permission-sets', giveManager);
      expect(await AuditLog.countDocuments({ action: 'user.permission_sets_changed' })).toBe(1);
    });

    it.each([
      ['a key that could reach another field', { module: 'hr.$', permissionSets: [] }],
      ['a key with a dot', { module: 'hr.admin', permissionSets: [] }],
      ['a key that would find a JavaScript built-in', { module: 'constructor', permissionSets: [] }],
      ['no permissionSets field', { module: 'hr' }],
      ['an object as the sets', { module: 'hr', permissionSets: { $ne: null } }],
    ])('refuses %s', async (_label, body) => {
      expect((await (await as('alia')).put('/users/karim/permission-sets', body)).status).toBe(422);
    });
  });

  describe('a person\'s profile', () => {
    beforeEach(async () => {
      await AccessProfile.create({ _id: 'ap_staff', name: 'Staff', grants: { hr: { salary: { actions: ['read'], scope: 'own' } } } });
    });

    it('is given and taken away through PATCH /users/:id, and applies on the next request', async () => {
      const karim = await as('karim');
      const admin = await as('alia');
      expect((await admin.patch('/users/karim', { profileId: 'ap_staff' })).body.profileId).toBe('ap_staff');
      expect((await karim.get('/me/permissions/hr')).body).toMatchObject({ profileName: 'Staff', permissions: { 'salary.read': 'own' } });

      expect((await admin.patch('/users/karim', { profileId: null })).body.profileId).toBeUndefined();
      expect((await karim.get('/me/permissions/hr')).body.hasAccess).toBe(false);
    });

    it('can be set when adding a person', async () => {
      const response = await (await as('alia')).post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', orgRoleId: 'or_root', profileId: 'ap_staff' });
      expect(response.status).toBe(201);
      expect(response.body.user.profileId).toBe('ap_staff');
    });

    it('refuses a profile that does not exist', async () => {
      const response = await (await as('alia')).patch('/users/karim', { profileId: 'ap_ghost' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('profileId');
    });

    it('needs user.update, so an HR access manager can not give one', async () => {
      expect((await (await as('sabbir')).patch('/users/karim', { profileId: 'ap_staff' })).status).toBe(403);
    });

    it('counts a person among a module\'s people when only their profile gives access there', async () => {
      await (await as('alia')).patch('/users/karim', { profileId: 'ap_staff' });
      const { body } = await (await as('alia')).get('/modules/hr/people');
      const karim = body.people.find((person: { id: string }) => person.id === 'karim');
      expect(karim).toMatchObject({ profile: { id: 'ap_staff', name: 'Staff' }, profilePermissions: { 'salary.read': 'own' }, permissionSets: [] });
    });
  });

  describe('Rahim and Karim, from start to finish', () => {
    it('takes a new person from a temporary password to a permission set that applies at once', async () => {
      const added = await (await as('alia')).post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', managerId: 'rahim', orgRoleId: 'or_root' });
      const nadiaId = added.body.user.id as string;

      const nadia = requestsAs(app, await signIn(app, 'nadia@twintrack.test', added.body.temporaryPassword));
      expect((await nadia.get('/me/modules')).status).toBe(403);
      const changed = await nadia.post('/auth/change-password', { currentPassword: added.body.temporaryPassword, newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(200);
      expect((await nadia.get('/me/modules')).body).toEqual({ modules: [] });

      const hrManager = await as('sabbir');
      await hrManager.put(`/users/${nadiaId}/permission-sets`, { module: 'hr', permissionSets: ['staff'], reason: 'Joins the people team' });
      const asStaff = await nadia.get('/me/permissions/hr');
      expect(asStaff.body.permissionSets).toEqual(['staff']);
      expect(asStaff.body.permissions['salary.read']).toBeUndefined();

      await hrManager.put(`/users/${nadiaId}/permission-sets`, { module: 'hr', permissionSets: ['staff', 'manager'], reason: 'Helping with payroll this month' });
      const withManager = await nadia.get('/me/permissions/hr');
      expect(withManager.body).toMatchObject({ permissionSets: ['staff', 'manager'] });
      expect(withManager.body.permissions['salary.read']).toBe('team');
    });
  });
});
