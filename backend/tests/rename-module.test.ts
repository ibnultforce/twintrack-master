import { describe, expect, it } from 'vitest';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Module } from '../src/modules/master/models/module.js';
import { RecordShare } from '../src/modules/master/models/recordShare.js';
import { renameModule } from '../src/seed/renameModule.js';
import { useTestDatabase } from './helpers/database.js';

useTestDatabase();

const rename = { fromKey: 'tasks', toKey: 'projects', toBaseUrl: '/projects' };

async function storeOldModule(): Promise<void> {
  await Module.create({
    key: 'tasks',
    name: 'Tasks',
    version: '1.6.0',
    baseUrl: '/tasks',
    core: false,
    resources: [],
    routes: [],
    routeAccess: [
      { method: 'GET', path: '/tasks/tasks/:id', access: 'signed', changedBy: 'u_admin', changedAt: new Date() },
      { method: 'GET', path: '/users', access: 'signed', changedBy: 'u_admin', changedAt: new Date() },
    ],
  });
}

describe('renaming a module', () => {
  it('moves the key, grants, route changes and module fields together', async () => {
    await storeOldModule();
    await AccessProfile.create({ _id: 'ap_dev', name: 'Developer', grants: { tasks: { task: { actions: ['read'], scope: 'own' } }, hr: {} } });
    await AuditLog.create({ module: 'tasks', action: 'task.update', actorId: 'u_admin' });
    await RecordShare.create({ _id: 'sh_1', module: 'tasks', object: 'task', recordId: 't_1', granteeType: 'user', granteeId: 'u_1', access: 'read', sharedBy: 'u_admin' });

    const result = await renameModule(rename);

    expect(result).toMatchObject({ profiles: 1, auditEntries: 1, shares: 1 });
    const stored = await Module.findOne({ key: 'projects' }).lean();
    expect(stored?.baseUrl).toBe('/projects');
    expect(stored?.routeAccess?.map((change) => change.path)).toEqual(['/projects/tasks/:id', '/users']);
    expect(await Module.exists({ key: 'tasks' })).toBeNull();
    expect((await AccessProfile.findById('ap_dev').lean())?.grants).toEqual({ projects: { task: { actions: ['read'], scope: 'own' } }, hr: {} });
    expect(await AuditLog.countDocuments({ module: 'projects' })).toBe(1);
    expect(await RecordShare.countDocuments({ module: 'projects' })).toBe(1);
  });

  it('refuses when the old module is missing or the new key is taken, changing nothing', async () => {
    await expect(renameModule(rename)).rejects.toThrow(/no module "tasks"/);

    await storeOldModule();
    await Module.create({ key: 'projects', name: 'Projects', version: '1.0.0', core: false, resources: [], routes: [] });
    await expect(renameModule(rename)).rejects.toThrow(/already exists/);
    expect(await Module.exists({ key: 'tasks' })).not.toBeNull();
  });

  it('refuses an invalid module key', async () => {
    await expect(renameModule({ ...rename, toKey: 'Project Management' })).rejects.toThrow(/valid module key/);
  });
});
