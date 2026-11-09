import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { FARHANA: 'u_01', RAHIM: 'u_04', KAMRUL: 'u_06', KARIM: 'u_08', JAHID: 'u_11', JACK: 'u_13' };

describe('GET /modules/:key/addable-people', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));
  const idsIn = (body: { people: { id: string }[] }) => body.people.map((person) => person.id);

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('lets a module admin with no Master role see who can be added', async () => {
    const response = await (await as('kamrul')).get('/modules/hr/addable-people');
    expect(response.status).toBe(200);
    expect(idsIn(response.body)).toEqual(expect.arrayContaining([ID.KARIM, ID.JACK]));
    expect(response.body.total).toBe(response.body.people.length);
  });

  it('leaves out people already in the module, super admins, the deactivated and the caller', async () => {
    const ids = idsIn((await (await as('kamrul')).get('/modules/hr/addable-people')).body);
    for (const excluded of [ID.RAHIM, ID.FARHANA, ID.JAHID, ID.KAMRUL]) expect(ids).not.toContain(excluded);
  });

  it('returns only what is needed to pick someone', async () => {
    const { body } = await (await as('kamrul')).get('/modules/hr/addable-people?search=karim');
    expect(body.people).toEqual([{ id: ID.KARIM, name: 'Karim Ahmed', email: 'karim@twintrack.test', title: 'Backend Developer' }]);
  });

  it('treats search text literally and takes pages', async () => {
    const kamrul = await as('kamrul');
    expect((await kamrul.get('/modules/hr/addable-people?search=.*')).body.people).toEqual([]);
    const firstPage = (await kamrul.get('/modules/hr/addable-people?pageSize=2')).body;
    expect(firstPage.people).toHaveLength(2);
    expect(firstPage.total).toBeGreaterThan(2);
  });

  it('stops listing someone once they are added', async () => {
    const kamrul = await as('kamrul');
    await kamrul.patch(`/users/${ID.KARIM}/roles`, { module: 'hr', role: 'staff' });
    expect(idsIn((await kamrul.get('/modules/hr/addable-people')).body)).not.toContain(ID.KARIM);
  });

  it('refuses someone with no token', async () => {
    expect((await request(app).get('/modules/hr/addable-people')).status).toBe(401);
  });

  it('refuses someone who can not change access anywhere', async () => {
    const response = await (await as('karim')).get('/modules/hr/addable-people');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('refuses a module admin in a module they do not manage', async () => {
    const response = await (await as('kamrul')).get('/modules/master/addable-people');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('follows managesAccessOf for a Master role', async () => {
    expect((await (await as('jasmin')).get('/modules/employee/addable-people')).status).toBe(200);
  });

  it('answers 404 for a module that is not loaded', async () => {
    const response = await (await as('arif')).get('/modules/account/addable-people');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('unknown_module');
  });
});
