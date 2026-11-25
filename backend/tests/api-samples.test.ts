import type { Application } from 'express';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { useTestDatabase } from './helpers/database.js';
import { seededModules } from './helpers/manifestModules.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

interface Example {
  title: string;
  outcome: string;
  parameters: Record<string, string>;
  body: string;
  needs: { value: string }[];
}

describe('Try samples filled from the database', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const examplesOf = async (person: string, api: string): Promise<Example[]> =>
    (await (await as(person)).get('/me/permissions/master')).body.guides[api].examples;

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('farhana', { superAdmin: true });
    await addPerson('karim');
    await addPerson('arif');
    await AccessProfile.create({ _id: 'ap_people', name: 'People admin', grants: { master: { user: { actions: ['read', 'create'], scope: 'all' } } } });
    await addPerson('alia', { profileId: 'ap_people' });
  });

  it('gives a super admin ids of real people, and a fresh email for a new one', async () => {
    const realIds = new Set(['karim', 'arif', 'alia']);
    const [readOne] = await examplesOf('farhana', 'GET /users/:id');
    expect(realIds.has(readOne!.parameters.id!)).toBe(true);

    const create = (await examplesOf('farhana', 'POST /users')).find((example) => example.outcome === 'accepted')!;
    const body = JSON.parse(create.body) as { email: string; managerId: string };
    expect(body.email).toMatch(/^nadia\+[0-9a-f]+@twintrack\.test$/);
    expect(realIds.has(body.managerId)).toBe(true);
  });

  it('fills a value an earlier step makes from a real record, and drops it from what is needed', async () => {
    const profileIds = (await (await as('farhana')).get('/access-profiles')).body.profiles.map((profile: { id: string }) => profile.id);
    const profileExamples = await examplesOf('farhana', 'PATCH /access-profiles/:id');
    expect(profileIds).toContain(profileExamples[0]!.parameters.id);
    expect(profileExamples[0]!.needs).toEqual([]);
  });

  it('says which fields take a record and lists the records to choose from', async () => {
    const response = await (await as('farhana')).get('/me/permissions/master');
    const create = (response.body.guides['POST /users'].examples as (Example & { choices: { field: string; list: string }[] })[]).find((example) => example.outcome === 'accepted')!;
    expect(create.choices).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'managerId', location: 'body', list: 'User', isMany: false }),
      expect.objectContaining({ field: 'orgRoleId', location: 'body', list: 'OrgRole' }),
    ]));
    const people = response.body.references.User as { id: string; label: string }[];
    expect(people).toContainEqual({ id: 'karim', label: expect.stringContaining('karim@twintrack.test') });
    expect(people.some((person) => person.id === 'farhana')).toBe(false);
  });

  it('offers people for an id field the API takes but the sample leaves out', async () => {
    const response = await (await as('farhana')).get('/me/permissions/master');
    const rename = (response.body.guides['PATCH /users/:id'].examples as { choices: { field: string; list: string }[] }[])[0]!;
    expect(rename.choices).toContainEqual({ field: 'managerId', location: 'body', list: 'User', isMany: false });
  });

  it('answers for every module the seed loads, so no module\'s API bodies break the Try dialog', async () => {
    const farhana = await as('farhana');
    for (const { key } of seededModules()) {
      expect((await farhana.get(`/me/permissions/${key}`)).status, key).toBe(200);
    }
  });

  it('keeps the example data for anyone else, so they learn no ids beyond their reach', async () => {
    const [readOne] = await examplesOf('alia', 'GET /users/:id');
    expect(readOne!.parameters.id).toBe('u_04');
    expect((await (await as('alia')).get('/me/permissions/master')).body.references).toBeUndefined();
  });
});
