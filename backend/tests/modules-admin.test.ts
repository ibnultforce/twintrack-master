import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';

const HR_ORIGIN = 'http://hr.twintrack.localhost:3200';

const tasksManifest = (version = '1.0.0', roles = [{ key: 'lead', name: 'Lead', grants: '*' as const }]) => ({
  manifestVersion: 1,
  module: { key: 'tasks', name: 'Tasks', version, description: 'Task tracking.' },
  resources: [{ key: 'task', label: 'Tasks', actions: ['read', 'create'], grantable: ['create'] }],
  routes: [],
  roles,
});

describe('module, role and activity administration', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig({ ALLOWED_ORIGINS: `${TEST_ORIGIN},${HR_ORIGIN}`, MODULE_FRONTEND_URLS: `hr=${HR_ORIGIN}` }));
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('alia', { name: 'Alia Access', assignments: { master: 'admin' } });
    await addPerson('sabbir', { assignments: { master: 'hr-access' } });
    await addPerson('rumana', { name: 'Rumana Akter', assignments: { master: 'auditor' } });
    await addPerson('karim', { assignments: { tasks: 'lead' } });
  });

  describe('who can reach each route', () => {
    it.each([
      ['get', '/modules'],
      ['post', '/modules/import'],
      ['delete', '/modules/hr'],
      ['get', '/roles'],
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
      expect((await auditor.get('/roles')).status).toBe(403);
    });

    it('keeps the activity log and modules from an HR access manager', async () => {
      const hrManager = await as('sabbir');
      expect((await hrManager.get('/audit')).status).toBe(403);
      expect((await hrManager.post('/modules/import', tasksManifest())).status).toBe(403);
    });
  });

  describe('GET /modules', () => {
    it('lists loaded modules with where to find them', async () => {
      const response = await (await as('alia')).get('/modules');
      expect(response.status).toBe(200);
      expect(response.body.modules).toEqual([
        expect.objectContaining({ key: 'hr', name: 'HR', core: false, frontendUrl: HR_ORIGIN }),
        expect.objectContaining({ key: 'master', core: true, frontendUrl: null }),
      ]);
    });
  });

  describe('POST /modules/import', () => {
    it('adds a new module, and access to it works straight away', async () => {
      const karim = await as('karim');
      expect((await karim.get('/me/modules')).body.modules).toEqual([]);

      const response = await (await as('alia')).post('/modules/import', tasksManifest());
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ key: 'tasks', version: '1.0.0', core: false, created: true, orphanedAssignments: 0 });

      expect((await karim.get('/me/modules')).body.modules[0]).toMatchObject({ key: 'tasks', roleName: 'Lead' });
    });

    it('replaces a module imported again, and counts people whose role has gone', async () => {
      const admin = await as('alia');
      await admin.post('/modules/import', tasksManifest());
      const response = await admin.post('/modules/import', tasksManifest('1.1.0', [{ key: 'member', name: 'Member', grants: '*' }]));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ version: '1.1.0', created: false, orphanedAssignments: 1 });

      const entries = await AuditLog.find({ action: 'module.imported' }).sort({ at: 1, _id: 1 }).lean();
      expect(entries.map((entry) => entry.before)).toEqual([{ version: null }, { version: '1.0.0' }]);
    });

    it('lists every problem in an invalid manifest and saves nothing', async () => {
      const response = await (await as('alia')).post('/modules/import', { manifestVersion: 1, module: { key: 'BAD KEY' } });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.fields.length).toBeGreaterThan(1);
      expect(await Module.countDocuments({ key: 'BAD KEY' })).toBe(0);
    });

    it('refuses a module named after a JavaScript built-in', async () => {
      const response = await (await as('alia')).post('/modules/import', { ...tasksManifest(), module: { key: 'constructor', name: 'Bad', version: '1.0.0' } });
      expect(response.status).toBe(422);
      expect(await Module.countDocuments({ key: 'constructor' })).toBe(0);
    });

    it('keeps the module list working if such a module is already stored', async () => {
      await Module.create({ key: 'constructor', name: 'Old', version: '1.0.0', resources: [], routes: [], roles: [] });
      const response = await (await as('karim')).get('/me/modules');
      expect(response.status).toBe(200);
      expect(response.body.modules).toEqual([]);
    });

    it('refuses a manifest that replaces Master, or calls itself core', async () => {
      const admin = await as('alia');
      const asMaster = tasksManifest();
      asMaster.module.key = 'master';
      const replaced = await admin.post('/modules/import', asMaster);
      expect(replaced.status).toBe(403);
      expect(replaced.body.error.code).toBe('core_module');
      expect((await Module.findOne({ key: 'master' }).lean())?.core).toBe(true);

      const claimsCore = tasksManifest();
      (claimsCore.module as Record<string, unknown>).core = true;
      expect((await admin.post('/modules/import', claimsCore)).status).toBe(403);
      expect(await AuditLog.countDocuments({ action: 'module.imported' })).toBe(0);
    });
  });

  describe('DELETE /modules/:key', () => {
    it('removes a module, ending access from it until it is imported again', async () => {
      const admin = await as('alia');
      await admin.post('/modules/import', tasksManifest());
      const karim = await as('karim');
      expect((await karim.get('/me/modules')).body.modules).toHaveLength(1);

      const response = await admin.delete('/modules/tasks');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ removed: true, key: 'tasks', affectedUsers: 1 });
      expect((await karim.get('/me/modules')).body.modules).toEqual([]);
      expect(await AuditLog.countDocuments({ action: 'module.removed', targetId: 'tasks' })).toBe(1);

      expect((await User.findById('karim').lean())?.assignments).toEqual({ tasks: 'lead' });
      await admin.post('/modules/import', tasksManifest());
      expect((await karim.get('/me/modules')).body.modules).toHaveLength(1);
    });

    it('refuses to remove a core module', async () => {
      const response = await (await as('alia')).delete('/modules/master');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('core_module');
      expect(await Module.countDocuments({ key: 'master' })).toBe(1);
    });

    it('answers 404 for a module that is not loaded', async () => {
      const response = await (await as('alia')).delete('/modules/tasks');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_module');
    });
  });

  describe('GET /roles', () => {
    const findRole = (body: { roles: { module: string; key: string }[] }, module: string, key: string) =>
      body.roles.find((role) => role.module === module && role.key === key);

    it('describes the fixed templates of every loaded module', async () => {
      const { body, status } = await (await as('alia')).get('/roles');
      expect(status).toBe(200);
      expect(findRole(body, 'hr', 'admin')).toMatchObject({ moduleName: 'HR', name: 'HR Admin', grants: ['Everything in this module'] });
      expect(findRole(body, 'hr', 'manager')).toMatchObject({
        grants: ['employee.read (team)', 'leave.read (team)', 'leave.approve (team)', 'attendance.read (team)', 'salary.read (team)'],
      });
      expect(findRole(body, 'master', 'auditor')).toMatchObject({ grants: expect.arrayContaining(['audit.read', 'user.read']) });
    });
  });

  describe('GET /audit', () => {
    it('lists the newest entries first, with a total and who did what', async () => {
      const admin = await as('alia');
      await admin.post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test' });

      const response = await admin.get('/audit?pageSize=1');
      expect(response.status).toBe(200);
      expect(response.body.total).toBeGreaterThan(1);
      expect(response.body.entries).toHaveLength(1);
      expect(response.body.entries[0]).toMatchObject({ action: 'user.created', actorName: 'Alia Access', targetName: 'Nadia Noor' });
      expect(response.body.entries[0].id).toEqual(expect.any(String));
    });

    it('filters by the start of the action', async () => {
      const admin = await as('alia');
      await admin.post('/users', { name: 'Nadia Noor', email: 'nadia@twintrack.test' });

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
