import { beforeEach, describe, expect, it } from 'vitest';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { syncModules } from '../src/seed/syncModules.js';
import { useTestDatabase } from './helpers/database.js';

const manifest = (resources: object[], routes: object[] = [], version = '2.0.0') => ({
  manifestVersion: 1,
  module: { key: 'tasks', name: 'Tasks', version },
  resources,
  routes,
  permissionSets: [],
});

const taskResource = { key: 'task', label: 'Tasks', actions: ['read', 'create'], scoped: true };

describe('reloading modules from their manifests', () => {
  useTestDatabase();

  beforeEach(async () => {
    await Module.create({
      key: 'tasks',
      name: 'Tasks',
      version: '1.0.0',
      resources: [taskResource, { key: 'bonus', label: 'Bonuses', actions: ['read'] }],
      routes: [],
      permissionSets: [
        { key: 'clerk', name: 'Clerk', grants: { task: { actions: ['read', 'delete'], scope: 'team' }, bonus: { actions: ['read'] } } },
        { key: 'owner', name: 'Owner', grants: '*' },
      ],
      permissionsEditedAt: new Date(),
    } as never);
  });

  it('takes resources from the file and keeps permission sets, without what the file no longer offers', async () => {
    const [synced] = await syncModules([manifest([taskResource])]);

    expect(synced).toEqual({
      key: 'tasks',
      version: '2.0.0',
      keptPermissionSets: ['clerk', 'owner'],
      droppedPermissions: ['clerk: task.delete', 'clerk: bonus.read'],
    });
    const stored = await Module.findOne({ key: 'tasks' }).lean();
    expect(stored?.version).toBe('2.0.0');
    expect(stored?.resources.map((resource) => resource.key)).toEqual(['task']);
    expect(stored?.permissionSets).toEqual([
      { key: 'clerk', name: 'Clerk', grants: { task: { actions: ['read'], scope: 'team' } } },
      { key: 'owner', name: 'Owner', grants: '*' },
    ]);
  });

  it('still counts kept permission sets as edits', async () => {
    await syncModules([manifest([taskResource])]);
    expect((await Module.findOne({ key: 'tasks' }).lean())?.permissionsEditedAt).toBeInstanceOf(Date);
  });

  it('adds nobody and leaves people alone', async () => {
    await User.create({ _id: 'u_1', name: 'One', email: 'one@twintrack.test', passwordHash: 'x', permissionSets: { tasks: ['clerk'] } });
    await syncModules([manifest([taskResource])]);
    const people = await User.find().lean();
    expect(people).toHaveLength(1);
    expect(people[0]?.permissionSets).toEqual({ tasks: ['clerk'] });
  });

  it('changes nothing when a manifest is invalid', async () => {
    await expect(syncModules([manifest([taskResource]), { manifestVersion: 1, module: { key: 'BAD KEY' } }])).rejects.toThrow();
    expect((await Module.findOne({ key: 'tasks' }).lean())?.version).toBe('1.0.0');
  });
});
