import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { Module } from '../src/modules/master/models/module.js';
import { User } from '../src/modules/master/models/user.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const KARIM = 'u_08';
const salaryReader = { key: 'salary-reader', name: 'Salary reader', grants: { salary: { actions: ['read'], scope: 'team' } } };

/** Gives Karim a profile holding these permissions in one module. Salary permissions reach his team. */
async function giveKarimProfile(moduleKey: string, permissions: string[]) {
  const grants: Record<string, { actions: string[]; scope?: string }> = {};
  for (const permission of permissions) {
    const [resource, action] = permission.split('.') as [string, string];
    grants[resource] ??= { actions: [], ...(resource === 'salary' && { scope: 'team' }) };
    grants[resource].actions.push(action);
  }
  await AccessProfile.findByIdAndUpdate('ap_karim', { $set: { name: 'Karim', grants: { [moduleKey]: grants } } }, { upsert: true });
  await User.updateOne({ _id: KARIM }, { $set: { profileId: 'ap_karim' } });
}

describe('letting someone build permission sets for one module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('when two changes happen at once', () => {
    const emptySet = (key: string) => ({ key, name: key, grants: {} });
    const hrSets = async () => (await Module.findOne({ key: 'hr' }).lean())!.permissionSets;

    it('keeps both edits to different permission sets', async () => {
      const farhana = await as('farhana');
      await farhana.post('/permission-sets/hr', emptySet('first'));
      await farhana.post('/permission-sets/hr', emptySet('second'));

      const responses = await Promise.all([
        farhana.patch('/permission-sets/hr/first', { name: 'First edited' }),
        farhana.patch('/permission-sets/hr/second', { name: 'Second edited' }),
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect((await hrSets()).map((permissionSet) => permissionSet.name)).toEqual(expect.arrayContaining(['First edited', 'Second edited']));
    });

    it('never leaves someone holding a permission set that was deleted', async () => {
      const farhana = await as('farhana');
      await farhana.post('/permission-sets/hr', emptySet('short-lived'));

      await Promise.all([
        farhana.delete('/permission-sets/hr/short-lived'),
        farhana.put(`/users/${KARIM}/permission-sets`, { module: 'hr', permissionSets: ['short-lived'], reason: 'Testing' }),
      ]);
      const setExists = (await hrSets()).some((permissionSet) => permissionSet.key === 'short-lived');
      const held = (await User.findById(KARIM).lean())!.permissionSets.hr?.includes('short-lived') ?? false;
      expect(setExists || !held).toBe(true);
    });
  });

  it.each([
    ['permissionSet.read', { create: 403, update: 403, remove: 403 }],
    ['permissionSet.create', { create: 201, update: 403, remove: 403 }],
    ['permissionSet.update', { create: 403, update: 200, remove: 403 }],
    ['permissionSet.delete', { create: 403, update: 403, remove: 200 }],
  ])('%s allows only its own action', async (permission, expected) => {
    await (await as('farhana')).post('/permission-sets/hr', { key: 'existing', name: 'Existing', grants: {} });
    await giveKarimProfile('hr', [permission]);
    const karim = await as('karim');

    expect((await karim.get('/permission-sets')).status).toBe(200);
    expect((await karim.post('/permission-sets/hr', { key: 'fresh', name: 'Fresh', grants: {} })).status).toBe(expected.create);
    expect((await karim.patch('/permission-sets/hr/existing', { name: 'Renamed' })).status).toBe(expected.update);
    expect((await karim.delete('/permission-sets/hr/existing')).status).toBe(expected.remove);
  });

  it('is refused until someone is given permission set rights in that module', async () => {
    const karim = await as('karim');
    expect((await karim.post('/permission-sets/hr', salaryReader)).status).toBe(403);
    expect((await karim.get('/permission-sets')).status).toBe(403);
  });

  describe('once given permission set rights and salary.read in HR', () => {
    beforeEach(async () => {
      await giveKarimProfile('hr', ['permissionSet.create', 'permissionSet.update', 'permissionSet.delete', 'salary.read']);
    });

    it('creates a permission set from what they hold, which can be given straight away', async () => {
      expect((await (await as('karim')).post('/permission-sets/hr', salaryReader)).status).toBe(201);
      const given = await (await as('kamrul')).put('/users/u_09/permission-sets', { module: 'hr', permissionSets: ['salary-reader'], reason: 'Testing' });
      expect(given.status).toBe(200);
    });

    it.each([
      ['a permission they do not hold', { salary: { actions: ['update'], scope: 'team' } }],
      ['a wider reach than they hold', { salary: { actions: ['read'], scope: 'all' } }],
      ['everything in the module', '*'],
    ])('refuses %s', async (_label, grants) => {
      const response = await (await as('karim')).post('/permission-sets/hr', { ...salaryReader, grants });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('beyond_own_access');
    });

    it('stays inside that module', async () => {
      const response = await (await as('karim')).post('/permission-sets/master', { key: 'reader', name: 'Reader', grants: {} });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('edits a permission set they made, but can not widen it', async () => {
      const karim = await as('karim');
      await karim.post('/permission-sets/hr', salaryReader);
      expect((await karim.patch('/permission-sets/hr/salary-reader', { name: 'Pay reader' })).status).toBe(200);
      const widened = await karim.patch('/permission-sets/hr/salary-reader', { grants: { salary: { actions: ['read', 'update'], scope: 'team' } } });
      expect(widened.body.error.code).toBe('beyond_own_access');
    });

    it('can not rename, change or delete a permission set stronger than their own access', async () => {
      const karim = await as('karim');
      expect((await karim.patch('/permission-sets/hr/admin', { name: 'Boss' })).body.error.code).toBe('beyond_own_access');
      expect((await karim.patch('/permission-sets/hr/admin', { grants: {} })).body.error.code).toBe('beyond_own_access');
      expect((await karim.delete('/permission-sets/hr/admin')).body.error.code).toBe('beyond_own_access');
    });

    it('lists only the module they can edit, with what they may use', async () => {
      const { body } = await (await as('karim')).get('/permission-sets');
      expect(body.modules.map((module: { key: string }) => module.key)).toEqual(['hr']);
      expect(body.modules[0].assignable).toEqual({
        'permissionSet.create': 'all',
        'permissionSet.update': 'all',
        'permissionSet.delete': 'all',
        'salary.read': 'team',
      });
    });

    it('can not change what a module offers', async () => {
      const response = await (await as('karim')).put('/modules/hr/resources/bonus', { label: 'Bonuses', actions: ['read'] });
      expect(response.status).toBe(403);
    });

    it('ends when the rights are taken away', async () => {
      const karim = await as('karim');
      await giveKarimProfile('hr', ['salary.read']);
      expect((await karim.post('/permission-sets/hr', salaryReader)).status).toBe(403);
    });
  });

  it('does not reach other modules from permission set rights in Master', async () => {
    await giveKarimProfile('master', ['permissionSet.create', 'permissionSet.update', 'permissionSet.delete']);
    const response = await (await as('karim')).post('/permission-sets/hr', salaryReader);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('leaves a super admin free to use any permission, and shows the APIs each one opens', async () => {
    const farhana = await as('farhana');
    expect((await farhana.post('/permission-sets/hr', { key: 'everything', name: 'Everything', grants: '*' })).status).toBe(201);
    const { body } = await farhana.get('/permission-sets');
    const hr = body.modules.find((module: { key: string }) => module.key === 'hr');
    expect(hr.apis['salary.read']).toEqual(expect.arrayContaining(['GET /hr/salaries', 'GET /hr/salaries/:id/history', 'POST /hr/salaries/:id/shares']));
    expect(hr.apis['permissionSet.create']).toEqual(['POST /permission-sets/:module']);
    expect(hr.apis['permissionSet.update']).toEqual(['PATCH /permission-sets/:module/:key']);
    expect(hr.apis['permissionSet.delete']).toEqual(['DELETE /permission-sets/:module/:key']);
    expect(hr.assignable['salary.approve']).toBe('all');
  });
});
