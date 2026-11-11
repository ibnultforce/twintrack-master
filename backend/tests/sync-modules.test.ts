import { beforeEach, describe, expect, it } from 'vitest';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import type { ManifestResource } from '../src/modules/master/moduleRegistry/manifest.js';
import { syncModules } from '../src/seed/syncModules.js';
import { useTestDatabase } from './helpers/database.js';

const manifest = (resources: object[], routes: object[] = [], version = '2.0.0') => ({
  manifestVersion: 1,
  module: { key: 'tasks', name: 'Tasks', version },
  resources,
  routes,
});

const taskResource: ManifestResource = { key: 'task', label: 'Tasks', actions: ['read', 'create'], scoped: true };
const customResource: ManifestResource = { key: 'trip', label: 'Trips', actions: ['read'], custom: true, fields: [{ key: 'title', label: 'Title', type: 'text' }] };

describe('reloading modules from their manifests', () => {
  useTestDatabase();

  beforeEach(async () => {
    await Module.create({
      key: 'tasks',
      name: 'Tasks',
      version: '1.0.0',
      resources: [taskResource, { key: 'bonus', label: 'Bonuses', actions: ['read'] } satisfies ManifestResource, customResource],
      routes: [],
      permissionsEditedAt: new Date(),
    });
  });

  it('takes resources from the file, and keeps custom objects built in the app', async () => {
    const [synced] = await syncModules([manifest([taskResource])]);

    expect(synced).toEqual({ key: 'tasks', version: '2.0.0' });
    const stored = await Module.findOne({ key: 'tasks' }).lean();
    expect(stored?.version).toBe('2.0.0');
    expect(stored?.resources.map((resource) => resource.key)).toEqual(['task', 'trip']);
  });

  it('leaves people and profiles alone', async () => {
    await AccessProfile.create({ _id: 'ap_clerk', name: 'Clerk', grants: { tasks: { task: { actions: ['read'], scope: 'team' } } } });
    await User.create({ _id: 'u_1', name: 'One', email: 'one@twintrack.test', passwordHash: 'x', profileId: 'ap_clerk' });
    await syncModules([manifest([taskResource])]);

    const people = await User.find().lean();
    expect(people).toHaveLength(1);
    expect(people[0]?.profileId).toBe('ap_clerk');
    expect((await AccessProfile.findById('ap_clerk').lean())?.grants).toEqual({ tasks: { task: { actions: ['read'], scope: 'team' } } });
  });

  it('changes nothing when a manifest is invalid', async () => {
    await expect(syncModules([manifest([taskResource]), { manifestVersion: 1, module: { key: 'BAD KEY' } }])).rejects.toThrow();
    expect((await Module.findOne({ key: 'tasks' }).lean())?.version).toBe('1.0.0');
  });
});
