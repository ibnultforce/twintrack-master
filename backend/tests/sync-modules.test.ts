import { beforeEach, describe, expect, it } from 'vitest';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import type { ManifestResource } from '../src/modules/master/moduleRegistry/manifest.js';
import { syncModules } from '../src/seed/syncModules.js';
import { useTestDatabase } from './helpers/database.js';

const manifest = (resources: object[], routes: object[] = [], version = '2.0.0') => ({
  manifestVersion: 1,
  module: { key: 'projects', name: 'Project management', version },
  resources,
  routes,
});

const taskResource: ManifestResource = { key: 'task', label: 'Tasks', actions: ['read', 'create'], scoped: true };
const customResource: ManifestResource = { key: 'trip', label: 'Trips', actions: ['read'], custom: true, fields: [{ key: 'title', label: 'Title', type: 'text' }] };

describe('reloading modules from their manifests', () => {
  useTestDatabase();

  beforeEach(async () => {
    await Module.create({
      key: 'projects',
      name: 'Project management',
      version: '1.0.0',
      resources: [taskResource, { key: 'bonus', label: 'Bonuses', actions: ['read'] } satisfies ManifestResource, customResource],
      routes: [],
      permissionsEditedAt: new Date(),
    });
  });

  it('takes resources from the file, and keeps custom objects built in the app', async () => {
    const { loaded } = await syncModules([manifest([taskResource])]);

    expect(loaded).toEqual([{ key: 'projects', version: '2.0.0' }]);
    const stored = await Module.findOne({ key: 'projects' }).lean();
    expect(stored?.version).toBe('2.0.0');
    expect(stored?.resources.map((resource) => resource.key)).toEqual(['task', 'trip']);
  });

  it('leaves people and profiles alone', async () => {
    await AccessProfile.create({ _id: 'ap_clerk', name: 'Clerk', grants: { projects: { task: { actions: ['read'], scope: 'team' } } } });
    await User.create({ _id: 'u_1', name: 'One', email: 'one@twintrack.test', passwordHash: 'x', profileId: 'ap_clerk' });
    await syncModules([manifest([taskResource])]);

    const people = await User.find().lean();
    expect(people).toHaveLength(1);
    expect(people[0]?.profileId).toBe('ap_clerk');
    expect((await AccessProfile.findById('ap_clerk').lean())?.grants).toEqual({ projects: { task: { actions: ['read'], scope: 'team' } } });
  });

  it('changes nothing when a manifest is invalid', async () => {
    await expect(syncModules([manifest([taskResource]), { manifestVersion: 1, module: { key: 'BAD KEY' } }])).rejects.toThrow();
    expect((await Module.findOne({ key: 'projects' }).lean())?.version).toBe('1.0.0');
  });

  describe('a module whose manifest file is gone', () => {
    const otherModule = (key: string, extra: object = {}) =>
      Module.create({ key, name: key, version: '1.0.0', resources: [{ key: 'test', label: 'Test', actions: ['read'] }], routes: [], ...extra });

    it('is removed, and the removal is in the activity log', async () => {
      await otherModule('api-test', { source: 'file' });
      const { removed } = await syncModules([manifest([taskResource])]);

      expect(removed).toEqual(['api-test']);
      expect(await Module.exists({ key: 'api-test' })).toBeNull();
      expect(await AuditLog.findOne({ action: 'module.removed', targetId: 'api-test' }).lean()).toMatchObject({ actorName: 'Manifest reload' });
    });

    it('is removed when it was saved before modules recorded where they came from', async () => {
      await otherModule('old-module');
      expect((await syncModules([manifest([taskResource])])).removed).toEqual(['old-module']);
    });

    it('stays when it was imported in the app, or holds custom objects', async () => {
      await otherModule('imported', { source: 'app' });
      await otherModule('with-objects', { source: 'file', resources: [customResource] });
      const result = await syncModules([manifest([taskResource])]);

      expect(result.removed).toEqual([]);
      expect(result.keptWithCustomObjects).toEqual(['with-objects']);
      expect(await Module.countDocuments({ key: { $in: ['imported', 'with-objects'] } })).toBe(2);
    });

    it('never removes a core module', async () => {
      await otherModule('master', { core: true });
      expect((await syncModules([manifest([taskResource])])).removed).toEqual([]);
    });
  });
});
