import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn, TEST_PASSWORD } from './helpers/signedIn.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';

const HR_ORIGIN = 'http://hr.twintrack.localhost:3200';

const inventoryManifest = (version = '1.0.0') => ({
  manifestVersion: 1,
  module: { key: 'inventory', name: 'Inventory', version, description: 'Stock tracking.' },
  resources: [{ key: 'item', label: 'Items', actions: ['read', 'create'] }],
  routes: [],
});

describe('module and activity administration', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig({ ALLOWED_ORIGINS: `${TEST_ORIGIN},${HR_ORIGIN}`, MODULE_FRONTEND_URLS: `hr=${HR_ORIGIN}` }));
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await addPerson('farhana', { superAdmin: true });
    await addPerson('alia', { name: 'Alia Access', profileId: 'ap_access_admin' });
    await addPerson('sabbir', { profileId: 'ap_hr_access' });
    await addPerson('rumana', { name: 'Rumana Akter', profileId: 'ap_auditor' });
    // A profile may cover a module before it's loaded, and grants nothing until it is.
    await AccessProfile.create({ _id: 'ap_inventory', name: 'Inventory lead', grants: { inventory: '*' } });
    await addPerson('karim', { profileId: 'ap_inventory' });
  });

  describe('who can reach each route', () => {
    it.each([
      ['get', '/modules'],
      ['post', '/modules/import'],
      ['delete', '/modules/hr'],
      ['get', '/audit'],
    ] as const)('%s %s needs a token, and is refused without the permission', async (method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
      const refused = await (await as('karim'))[method](path);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('forbidden');
    });

    it('gives an auditor the activity log and nothing else here', async () => {
      const auditor = await as('rumana');
      expect((await auditor.get('/audit')).status).toBe(200);
      expect((await auditor.get('/modules')).status).toBe(403);
    });

    it('keeps the activity log and modules from an HR access manager', async () => {
      const hrManager = await as('sabbir');
      expect((await hrManager.get('/audit')).status).toBe(403);
      expect((await hrManager.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD })).status).toBe(403);
    });
  });

  describe('GET /modules', () => {
    it('lists loaded modules with where to find them', async () => {
      const response = await (await as('alia')).get('/modules');
      expect(response.status).toBe(200);
      expect(response.body.modules).toEqual([
        expect.objectContaining({ key: 'hr', name: 'HR', core: false, frontendUrl: HR_ORIGIN }),
        expect.objectContaining({ key: 'master', core: true, frontendUrl: null }),
        expect.objectContaining({ key: 'tasks', name: 'Tasks', core: false, frontendUrl: null }),
      ]);
    });
  });

  describe('POST /modules/import', () => {
    it('adds a new module, and access to it works straight away', async () => {
      const karim = await as('karim');
      expect((await karim.get('/me/modules')).body.modules).toEqual([]);

      const response = await (await as('farhana')).post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ key: 'inventory', version: '1.0.0', core: false, created: true });

      expect((await karim.get('/me/modules')).body.modules[0]).toMatchObject({ key: 'inventory', profileName: 'Inventory lead' });
    });

    it('asks for the password of the person importing, and saves nothing without it', async () => {
      const admin = await as('farhana');
      const wrong = await admin.post('/modules/import', { manifest: inventoryManifest(), password: 'not-the-password' });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('wrong_current_password');
      expect((await admin.post('/modules/import', { manifest: inventoryManifest() })).status).toBe(422);
      expect(await Module.countDocuments({ key: 'inventory' })).toBe(0);
    });

    describe('for someone who is not a super admin', () => {
      it('adds a module and imports a new version of it', async () => {
        const admin = await as('alia');
        expect((await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD })).status).toBe(201);
        expect((await admin.post('/modules/import', { manifest: inventoryManifest('1.1.0'), password: TEST_PASSWORD })).status).toBe(200);
      });

      it('needs module.update to replace resources edited in the app', async () => {
        await (await as('farhana')).put('/modules/hr/resources/salary', { label: 'Pay', actions: ['read', 'create', 'update', 'approve', 'delete', 'share'] });
        const hr = (await Module.findOne({ key: 'hr' }).lean())!;
        const manifest = { manifestVersion: 1, module: { key: 'hr', name: 'HR', version: '9.0.0' }, resources: hr.resources, routes: [] };
        const refused = await (await as('alia')).post('/modules/import', { manifest, password: TEST_PASSWORD });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe('permissions_edited');

        await AccessProfile.create({ _id: 'ap_modules', name: 'Modules', grants: { master: { module: { actions: ['create', 'update'] } } } });
        await User.updateOne({ _id: 'alia' }, { $set: { profileId: 'ap_modules' } });
        expect((await (await as('alia')).post('/modules/import', { manifest, password: TEST_PASSWORD })).status).toBe(200);
      });
    });

    it('refuses a manifest that still lists permission sets, which were removed', async () => {
      const response = await (await as('farhana')).post('/modules/import', { manifest: { ...inventoryManifest(), permissionSets: [] }, password: TEST_PASSWORD });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body.error.fields)).toContain('permission sets were removed');
    });

    it('replaces a module imported again, and records both versions', async () => {
      const admin = await as('farhana');
      await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
      const response = await admin.post('/modules/import', { manifest: inventoryManifest('1.1.0'), password: TEST_PASSWORD });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ version: '1.1.0', created: false });

      const entries = await AuditLog.find({ action: 'module.imported' }).sort({ at: 1, _id: 1 }).lean();
      expect(entries.map((entry) => entry.before)).toEqual([{ version: null }, { version: '1.0.0' }]);
    });

    it('lists every problem in an invalid manifest and saves nothing', async () => {
      const response = await (await as('alia')).post('/modules/import', { manifest: { manifestVersion: 1, module: { key: 'BAD KEY' } }, password: TEST_PASSWORD });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.fields.length).toBeGreaterThan(1);
      expect(await Module.countDocuments({ key: 'BAD KEY' })).toBe(0);
    });

    it('refuses a module named after a JavaScript built-in', async () => {
      const response = await (await as('alia')).post('/modules/import', { manifest: { ...inventoryManifest(), module: { key: 'constructor', name: 'Bad', version: '1.0.0' } }, password: TEST_PASSWORD });
      expect(response.status).toBe(422);
      expect(await Module.countDocuments({ key: 'constructor' })).toBe(0);
    });

    it('keeps the module list working if such a module is already stored', async () => {
      await Module.create({ key: 'constructor', name: 'Old', version: '1.0.0', resources: [], routes: [] });
      const response = await (await as('karim')).get('/me/modules');
      expect(response.status).toBe(200);
      expect(response.body.modules).toEqual([]);
    });

    it('refuses a manifest that replaces Master, or calls itself core', async () => {
      const admin = await as('alia');
      const asMaster = inventoryManifest();
      asMaster.module.key = 'master';
      const replaced = await admin.post('/modules/import', { manifest: asMaster, password: TEST_PASSWORD });
      expect(replaced.status).toBe(403);
      expect(replaced.body.error.code).toBe('core_module');
      expect((await Module.findOne({ key: 'master' }).lean())?.core).toBe(true);

      const claimsCore = inventoryManifest();
      (claimsCore.module as Record<string, unknown>).core = true;
      expect((await admin.post('/modules/import', { manifest: claimsCore, password: TEST_PASSWORD })).status).toBe(403);
      expect(await AuditLog.countDocuments({ action: 'module.imported' })).toBe(0);
    });
  });

  describe('GET /modules/:key/export', () => {
    it('returns a manifest that can be imported back, with resources changed in the app', async () => {
      const admin = await as('farhana');
      await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
      await admin.put('/modules/inventory/resources/bin', { label: 'Bins', actions: ['read'] });

      const exported = await admin.get('/modules/inventory/export');
      expect(exported.status).toBe(200);
      expect(exported.body.module).toEqual({ key: 'inventory', name: 'Inventory', version: '1.0.0', description: 'Stock tracking.' });
      expect(exported.body.resources.map((resource: { key: string }) => resource.key)).toEqual(['item', 'bin']);
      expect(exported.body).not.toHaveProperty('permissionSets');

      const reimported = await admin.post('/modules/import', { manifest: exported.body, password: TEST_PASSWORD });
      expect(reimported.status).toBe(200);
    });

    it('needs module.read, and answers 404 for a module that is not loaded', async () => {
      expect((await (await as('karim')).get('/modules/hr/export')).status).toBe(403);
      expect((await (await as('alia')).get('/modules/inventory/export')).body.error.code).toBe('unknown_module');
    });
  });

  describe('DELETE /modules/:key', () => {
    it('removes a module, ending access from it until it is imported again', async () => {
      const admin = await as('farhana');
      await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
      const karim = await as('karim');
      expect((await karim.get('/me/modules')).body.modules).toHaveLength(1);

      const response = await admin.delete('/modules/inventory');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ removed: true, key: 'inventory', affectedUsers: 1 });
      expect((await karim.get('/me/modules')).body.modules).toEqual([]);
      expect(await AuditLog.countDocuments({ action: 'module.removed', targetId: 'inventory' })).toBe(1);

      expect((await User.findById('karim').lean())?.profileId).toBe('ap_inventory');
      await admin.post('/modules/import', { manifest: inventoryManifest(), password: TEST_PASSWORD });
      expect((await karim.get('/me/modules')).body.modules).toHaveLength(1);
    });

    it('refuses to remove a core module', async () => {
      const response = await (await as('alia')).delete('/modules/master');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('core_module');
      expect(await Module.countDocuments({ key: 'master' })).toBe(1);
    });

    it('answers 404 for a module that is not loaded', async () => {
      const response = await (await as('alia')).delete('/modules/inventory');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_module');
    });
  });

  describe('GET /audit', () => {
    it('lists the newest entries first, with a total and who did what', async () => {
      const admin = await as('alia');
      await admin.post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', orgRoleId: 'or_root' });

      // Adding someone also sends their invitation, which is logged after the person is created.
      const response = await admin.get('/audit?pageSize=2');
      expect(response.status).toBe(200);
      expect(response.body.total).toBeGreaterThan(2);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.entries[0]).toMatchObject({ action: 'user.password_link_sent', actorName: 'Alia Access', targetName: 'Nadia Noor' });
      expect(response.body.entries[1]).toMatchObject({ action: 'user.created', actorName: 'Alia Access', targetName: 'Nadia Noor' });
      expect(response.body.entries[0].id).toEqual(expect.any(String));
    });

    it('filters by the start of the action', async () => {
      const admin = await as('alia');
      await admin.post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test', orgRoleId: 'or_root' });

      const { body } = await admin.get('/audit?actionPrefix=auth.');
      expect(body.total).toBeGreaterThan(0);
      expect(body.entries.every((entry: { action: string }) => entry.action.startsWith('auth.'))).toBe(true);
    });

    it('treats the dot in a prefix as a dot', async () => {
      await (await as('alia')).get('/audit');
      const { body } = await (await as('alia')).get('/audit?actionPrefix=auth.login.');
      expect(body.total).toBe(0);
    });

    it.each(['actionPrefix=.*(', 'page=0', 'pageSize=101'])('refuses the query %s', async (query) => {
      expect((await (await as('alia')).get(`/audit?${query}`)).status).toBe(422);
    });
  });
});
