import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const staffGrants = { hr: { salary: { actions: ['read'], scope: 'own' } } };

describe('access profiles', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('farhana', { superAdmin: true });
    await addPerson('alia', { permissionSets: { master: ['admin'] } });
    await addPerson('karim');
  });

  describe('who can reach each route', () => {
    const routes: [string, 'get' | 'post' | 'patch' | 'delete', string, object?][] = [
      ['list', 'get', '/access-profiles'],
      ['create', 'post', '/access-profiles', { name: 'Staff', grants: {} }],
      ['update', 'patch', '/access-profiles/ap_x', { name: 'Staff' }],
      ['delete', 'delete', '/access-profiles/ap_x'],
    ];

    it.each(routes)('%s needs a token', async (_label, method, path) => {
      expect((await request(app)[method](path)).status).toBe(401);
    });

    it.each(routes)('%s is refused for someone without the permission', async (_label, method, path, body) => {
      const karim = await as('karim');
      const response = await (method === 'get' || method === 'delete' ? karim[method](path) : karim[method](path, body));
      expect(response.status).toBe(403);
    });

    it('lets an Access Admin read profiles but not change them', async () => {
      const alia = await as('alia');
      expect((await alia.get('/access-profiles')).status).toBe(200);
      expect((await alia.post('/access-profiles', { name: 'Staff', grants: {} })).status).toBe(403);
    });
  });

  it('creates a profile, lists it with what it allows in each module, and records it', async () => {
    const farhana = await as('farhana');
    const created = await farhana.post('/access-profiles', { name: 'Staff', description: 'Everyone on the team', grants: staffGrants });
    expect(created.status).toBe(201);
    expect(created.body.id).toMatch(/^ap_/);

    await User.updateOne({ _id: 'karim' }, { $set: { profileId: created.body.id } });
    const { body } = await farhana.get('/access-profiles');
    expect(body.profiles).toEqual([
      expect.objectContaining({
        name: 'Staff',
        description: 'Everyone on the team',
        holders: 1,
        modules: expect.arrayContaining([expect.objectContaining({ key: 'hr', name: 'HR', loaded: true, grants: ['salary.read (own)'] })]),
      }),
    ]);
    expect(await AuditLog.countDocuments({ action: 'access_profile.created', actorId: 'farhana' })).toBe(1);
  });

  it.each([
    ['a module that is not loaded', { account: { invoice: { actions: ['read'] } } }, 'not a loaded module'],
    ['an unknown resource', { hr: { ghost: { actions: ['read'] } } }, 'is not a resource'],
    ['an unknown action', { hr: { salary: { actions: ['fly'] } } }, 'grants.hr'],
    ['a narrow scope on an unscoped resource', { master: { audit: { actions: ['read'], scope: 'team' } } }, "isn't scoped"],
  ])('refuses %s, and saves nothing', async (_label, grants, message) => {
    const response = await (await as('farhana')).post('/access-profiles', { name: 'Bad', grants });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body.error.fields)).toContain(message);
    expect(await AccessProfile.countDocuments()).toBe(0);
  });

  it('changes a profile, which applies to everyone holding it on their next request', async () => {
    const farhana = await as('farhana');
    const { body: profile } = await farhana.post('/access-profiles', { name: 'Staff', grants: staffGrants });
    await User.updateOne({ _id: 'karim' }, { $set: { profileId: profile.id } });
    const karim = await as('karim');
    expect((await karim.get('/me/permissions/hr')).body.permissions).toEqual({ 'salary.read': 'own' });

    const updated = await farhana.patch(`/access-profiles/${profile.id}`, { name: 'Team', description: null, grants: { hr: { salary: { actions: ['read'], scope: 'team' } } } });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Team', description: '', holders: 1 });
    expect((await karim.get('/me/permissions/hr')).body.permissions).toEqual({ 'salary.read': 'team' });
    expect((await karim.get('/me/permissions/master')).body.hasAccess).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'access_profile.updated' })).toBe(1);
  });

  it('removes a profile nobody holds, and refuses one that someone holds', async () => {
    const farhana = await as('farhana');
    const { body: profile } = await farhana.post('/access-profiles', { name: 'Staff', grants: staffGrants });
    await User.updateOne({ _id: 'karim' }, { $set: { profileId: profile.id } });

    const refused = await farhana.delete(`/access-profiles/${profile.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('profile_in_use');

    await User.updateOne({ _id: 'karim' }, { $unset: { profileId: 1 } });
    expect((await farhana.delete(`/access-profiles/${profile.id}`)).status).toBe(200);
    expect(await AccessProfile.countDocuments()).toBe(0);
  });

  it('answers 404 for a profile that does not exist, and 422 for an empty change', async () => {
    const farhana = await as('farhana');
    expect((await farhana.patch('/access-profiles/ap_ghost', { name: 'X' })).body.error.code).toBe('unknown_profile');
    expect((await farhana.delete('/access-profiles/ap_ghost')).status).toBe(404);
    expect((await farhana.patch('/access-profiles/ap_ghost', {})).status).toBe(422);
  });

  it('stops someone changing a profile stronger than their own access', async () => {
    await AccessProfile.create({ _id: 'ap_editor', name: 'Editor', grants: { master: { accessProfile: { actions: ['read', 'update', 'delete'] } } } });
    await AccessProfile.create({ _id: 'ap_hr', name: 'HR lead', grants: { hr: '*' } });
    await User.updateOne({ _id: 'karim' }, { $set: { profileId: 'ap_editor' } });
    const karim = await as('karim');
    expect((await karim.patch('/access-profiles/ap_hr', { name: 'Renamed' })).body.error.code).toBe('beyond_own_access');
    expect((await karim.delete('/access-profiles/ap_hr')).body.error.code).toBe('beyond_own_access');
  });
});
