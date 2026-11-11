import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { User } from '../src/modules/master/models/user.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const ID = { FARHANA: 'u_01', SABBIR: 'u_03', RAHIM: 'u_04', KAMRUL: 'u_06', ARIF: 'u_07', KARIM: 'u_08', JAHID: 'u_11', JACK: 'u_13' };

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

  it('lets someone who gives profiles see who could be given one covering the module', async () => {
    const response = await (await as('sabbir')).get('/modules/hr/addable-people');
    expect(response.status).toBe(200);
    expect(idsIn(response.body)).toEqual(expect.arrayContaining([ID.KARIM, ID.JACK]));
    expect(response.body.total).toBe(response.body.people.length);
  });

  it('leaves out people already in the module, super admins, the deactivated and the caller', async () => {
    const ids = idsIn((await (await as('sabbir')).get('/modules/hr/addable-people')).body);
    for (const excluded of [ID.RAHIM, ID.FARHANA, ID.JAHID, ID.SABBIR]) expect(ids).not.toContain(excluded);
  });

  it('returns only what is needed to pick someone, and their current profile', async () => {
    const { body } = await (await as('sabbir')).get('/modules/hr/addable-people?search=arif');
    expect(body.people).toEqual([{ id: ID.ARIF, name: 'Arif Chowdhury', email: 'arif@twintrack.test', title: expect.any(String), profileId: 'ap_access_admin' }]);
  });

  it('treats search text literally and takes pages', async () => {
    const sabbir = await as('sabbir');
    expect((await sabbir.get('/modules/hr/addable-people?search=.*')).body.people).toEqual([]);
    const firstPage = (await sabbir.get('/modules/hr/addable-people?pageSize=2')).body;
    expect(firstPage.people).toHaveLength(2);
    expect(firstPage.total).toBeGreaterThan(2);
  });

  it('stops listing someone once their profile covers the module', async () => {
    await (await as('farhana')).put(`/users/${ID.KARIM}/profile`, { profileId: 'ap_hr_admin' });
    expect(idsIn((await (await as('sabbir')).get('/modules/hr/addable-people')).body)).not.toContain(ID.KARIM);
  });

  // Arif and Karim report to Rahim, and u_09 and u_10 sit in org roles below his.
  it('lists only the people a team-scoped giver reaches', async () => {
    await AccessProfile.create({ _id: 'ap_team_giver', name: 'Team giver', grants: { master: { userProfile: { actions: ['update'], scope: 'team' } } } });
    await User.updateOne({ _id: ID.RAHIM }, { $set: { profileId: 'ap_team_giver' } });
    expect(idsIn((await (await as('rahim')).get('/modules/hr/addable-people')).body).sort()).toEqual([ID.ARIF, ID.KARIM, 'u_09', 'u_10']);
  });

  it('refuses someone with no token', async () => {
    expect((await request(app).get('/modules/hr/addable-people')).status).toBe(401);
  });

  it('refuses someone who can not give profiles, even an HR admin', async () => {
    const response = await (await as('kamrul')).get('/modules/hr/addable-people');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('answers 404 for a module that is not loaded', async () => {
    const response = await (await as('arif')).get('/modules/account/addable-people');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('unknown_module');
  });
});
