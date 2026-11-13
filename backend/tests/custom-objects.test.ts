import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CustomRecord } from '../src/modules/master/models/customRecord.js';
import { Module } from '../src/modules/master/models/module.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { RAHIM: 'u_04', KARIM: 'u_08', MEHEDI: 'u_09', JACK: 'u_13' };
const TRAINING = '/records/hr/training';

const trainingDefinition = {
  key: 'training',
  label: 'Trainings',
  fields: [
    { key: 'title', label: 'Title', type: 'text', required: true, tracked: true },
    { key: 'hours', label: 'Hours', type: 'number', tracked: true },
    { key: 'startsOn', label: 'Starts on', type: 'date' },
    { key: 'level', label: 'Level', type: 'select', options: ['basic', 'advanced'] },
    { key: 'cost', label: 'Cost', type: 'number', protected: true, tracked: true },
  ],
};

describe('custom objects', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  /** Builds a profile with these HR grants, as the super admin, and gives it to the person in place of the one they had. */
  const giveHrProfile = async (personId: string, name: string, hrGrants: object) => {
    const farhana = await as('farhana');
    const created = await farhana.post('/access-profiles', { name, grants: { hr: hrGrants } });
    await farhana.put(`/users/${personId}/profile`, { profileId: created.body.id });
  };

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('defining an object', () => {
    it('adds it to the module as a resource with the usual actions, tracked and protected fields', async () => {
      const response = await (await as('farhana')).post('/modules/hr/objects', trainingDefinition);
      expect(response.status).toBe(201);
      expect(response.body.object).toMatchObject({
        key: 'training',
        custom: true,
        scoped: true,
        actions: ['read', 'create', 'update', 'delete', 'share'],
        trackedFields: ['title', 'hours', 'cost'],
        protectedFields: ['cost'],
        sharingModel: 'private',
      });
      const hr = await Module.findOne({ key: 'hr' }).lean();
      expect(hr?.resources.map((resource) => resource.key)).toContain('training');
    });

    it.each([
      ['a key already used', { ...trainingDefinition, key: 'salary' }, 409],
      ['a badly formed key', { ...trainingDefinition, key: 'Training Plan' }, 422],
      ['no fields', { ...trainingDefinition, fields: [] }, 422],
      ['a select field with no options', { ...trainingDefinition, fields: [{ key: 'level', label: 'Level', type: 'select' }] }, 422],
      ['a field listed twice', { ...trainingDefinition, fields: [trainingDefinition.fields[0], trainingDefinition.fields[0]] }, 422],
      ['an unknown field type', { ...trainingDefinition, fields: [{ key: 'x', label: 'X', type: 'colour' }] }, 422],
    ])('refuses %s', async (_label, body, status) => {
      expect((await (await as('farhana')).post('/modules/hr/objects', body)).status).toBe(status);
    });

    it('needs module.create, and keeps the object when the module manifest is imported again', async () => {
      expect((await (await as('karim')).post('/modules/hr/objects', trainingDefinition)).status).toBe(403);
      const farhana = await as('farhana');
      await farhana.post('/modules/hr/objects', trainingDefinition);
      const exported = (await farhana.get('/modules/hr/export')).body;
      const withoutObject = { ...exported, resources: exported.resources.filter((resource: { key: string }) => resource.key !== 'training') };
      expect((await farhana.post('/modules/import', { manifest: withoutObject, password: PASSWORD })).status).toBe(200);
      expect((await Module.findOne({ key: 'hr' }).lean())?.resources.map((resource) => resource.key)).toContain('training');
    });

    it('changes the fields, and refuses removing an object that still has records', async () => {
      const farhana = await as('farhana');
      await farhana.post('/modules/hr/objects', trainingDefinition);
      const changed = await farhana.put('/modules/hr/objects/training', { label: 'Courses', fields: trainingDefinition.fields });
      expect(changed.body.object.label).toBe('Courses');

      await farhana.post(TRAINING, { values: { title: 'Safety' } });
      expect((await farhana.delete('/modules/hr/objects/training')).body.error.code).toBe('object_in_use');
      await CustomRecord.deleteMany({});
      expect((await farhana.delete('/modules/hr/objects/training')).status).toBe(200);
    });

    it('refuses removing an object with records as a plain resource too, so they are never orphaned', async () => {
      const farhana = await as('farhana');
      await farhana.post('/modules/hr/objects', trainingDefinition);
      const { id } = (await farhana.post(TRAINING, { values: { title: 'Safety' } })).body as { id: string };
      // A record in the recycle bin still counts, because it can be restored.
      await farhana.delete(`${TRAINING}/${id}`);

      const refused = await farhana.delete('/modules/hr/resources/training');
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('object_in_use');
      expect((await Module.findOne({ key: 'hr' }).lean())?.resources.map((resource) => resource.key)).toContain('training');

      await CustomRecord.deleteMany({});
      expect((await farhana.delete('/modules/hr/resources/training')).status).toBe(200);
    });
  });

  describe('records', () => {
    beforeEach(async () => {
      await (await as('farhana')).post('/modules/hr/objects', trainingDefinition);
      await giveHrProfile(ID.KARIM, 'training-editor', { training: { actions: ['read', 'create', 'update'], scope: 'own', fieldAccess: { cost: 'edit' } } });
      await giveHrProfile(ID.RAHIM, 'training-lead', { training: { actions: ['read', 'delete'], scope: 'team' } });
    });

    it('creates a record checked against the fields, owned by the creator', async () => {
      const karim = await as('karim');
      const created = await karim.post(TRAINING, { values: { title: 'First aid', hours: 6, startsOn: '2027-02-01', level: 'basic', cost: 500 } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ ownerId: ID.KARIM, version: 0, values: { title: 'First aid', hours: 6, cost: 500 } });
      expect((await karim.get(`${TRAINING}/${created.body.id}`)).body.values.level).toBe('basic');
    });

    it.each([
      ['a missing required field', { hours: 2 }],
      ['a number as text', { title: 'X', hours: 'two' }],
      ['an option not offered', { title: 'X', level: 'expert' }],
      ['a field the object does not have', { title: 'X', colour: 'red' }],
      ['a badly formed date', { title: 'X', startsOn: 'soon' }],
    ])('refuses %s', async (_label, values) => {
      expect((await (await as('karim')).post(TRAINING, { values })).status).toBe(422);
    });

    it('follows the scope: the owner sees their own, and someone above them sees the team', async () => {
      const created = (await (await as('karim')).post(TRAINING, { values: { title: 'First aid' } })).body;
      const rahim = await as('rahim');
      expect((await rahim.get(TRAINING)).body.total).toBe(1);
      expect((await (await as('farhana')).post(TRAINING, { values: { title: 'Not Karim\'s' } })).status).toBe(201);
      expect((await (await as('karim')).get(TRAINING)).body.total).toBe(1);
      expect((await rahim.get(`${TRAINING}/${created.id}`)).status).toBe(200);
    });

    it('hides a protected field from someone without access to it', async () => {
      const created = (await (await as('karim')).post(TRAINING, { values: { title: 'First aid', cost: 500 } })).body;
      const seen = (await (await as('rahim')).get(`${TRAINING}/${created.id}`)).body;
      expect(seen.values).toEqual({ title: 'First aid' });
      const history = (await (await as('rahim')).get(`${TRAINING}/${created.id}/history`)).body.entries;
      expect(JSON.stringify(history)).not.toContain('500');
    });

    it('keeps history, refuses a stale edit, clears a field with null, and needs edit access for a protected one', async () => {
      const karim = await as('karim');
      const created = (await karim.post(TRAINING, { values: { title: 'First aid', hours: 6 } })).body;
      const changed = await karim.patch(`${TRAINING}/${created.id}`, { values: { hours: 8, startsOn: null }, version: 0 });
      expect(changed.body).toMatchObject({ version: 1, values: { title: 'First aid', hours: 8 } });
      expect((await karim.patch(`${TRAINING}/${created.id}`, { values: { hours: 9 }, version: 0 })).body.error.code).toBe('version_conflict');
      expect((await karim.patch(`${TRAINING}/${created.id}`, { values: { title: null } })).status).toBe(422);

      const history = (await karim.get(`${TRAINING}/${created.id}/history`)).body.entries;
      expect(history[0].changes).toEqual([{ field: 'hours', from: 6, to: 8 }]);
    });

    it('deletes and restores within the scope, with the recycle bin needing delete', async () => {
      const created = (await (await as('karim')).post(TRAINING, { values: { title: 'First aid' } })).body;
      expect((await (await as('karim')).delete(`${TRAINING}/${created.id}`)).status).toBe(403);
      const rahim = await as('rahim');
      expect((await rahim.delete(`${TRAINING}/${created.id}`)).status).toBe(200);
      expect((await rahim.get(TRAINING)).body.total).toBe(0);
      expect((await rahim.get(`${TRAINING}?deleted=true`)).body.total).toBe(1);
      expect((await rahim.post(`${TRAINING}/${created.id}/restore`)).status).toBe(200);
      expect((await rahim.get(TRAINING)).body.total).toBe(1);
    });

    it('can be shared like any other record', async () => {
      await giveHrProfile(ID.MEHEDI, 'training-reader', { training: { actions: ['read'], scope: 'own' } });
      const karim = await as('karim');
      const created = (await karim.post(TRAINING, { values: { title: 'First aid' } })).body;
      expect((await (await as('mehedi')).get(TRAINING)).body.total).toBe(0);

      const share = (await karim.post(`${TRAINING}/${created.id}/shares`, { granteeType: 'user', granteeId: ID.MEHEDI, access: 'read' })).body;
      expect((await (await as('mehedi')).get(TRAINING)).body.total).toBe(1);
      expect((await karim.get(`${TRAINING}/${created.id}/shares`)).body.shares).toHaveLength(1);
      expect((await karim.delete(`${TRAINING}/${created.id}/shares/${share.id}`)).status).toBe(200);
      expect((await (await as('mehedi')).get(TRAINING)).body.total).toBe(0);
    });

    it('lists the objects someone can read, without protected fields they can not see', async () => {
      const objects = (await (await as('rahim')).get('/records')).body.objects;
      expect(objects).toEqual([expect.objectContaining({ module: 'hr', key: 'training', can: { create: false, update: false, delete: true } })]);
      expect(objects[0].fields.map((field: { key: string }) => field.key)).not.toContain('cost');
      const karims = (await (await as('karim')).get('/records')).body.objects[0];
      expect(karims.fields.find((field: { key: string }) => field.key === 'cost')).toMatchObject({ editable: true });
      expect((await (await as('jack')).get('/records')).body.objects).toEqual([]);
    });

    it('refuses someone without the permission, an unknown object, and a missing token', async () => {
      expect((await (await as('jack')).get(TRAINING)).body.error.code).toBe('forbidden');
      expect((await (await as('farhana')).get('/records/hr/salary')).body.error.code).toBe('unknown_object');
      expect((await (await as('farhana')).get('/records/nowhere/training')).body.error.code).toBe('unknown_module');
      expect((await request(app).get(TRAINING)).status).toBe(401);
      expect((await (await as('farhana')).get(`${TRAINING}/cr_nowhere`)).body.error.code).toBe('unknown_record');
    });
  });
});
