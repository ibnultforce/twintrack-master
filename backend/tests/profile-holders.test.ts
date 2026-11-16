import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';

type Holder = { id: string; canRemove: boolean };
const holderIds = (body: { people: Holder[] }) => body.people.map((person) => person.id);
const removable = (body: { people: Holder[] }) => Object.fromEntries(body.people.map((person) => [person.id, person.canRemove]));

/**
 * From the test fixture: Farhana is the super admin. Mehedi (u_09) and Sumaiya (u_10) hold Developer. Arif (u_07) holds
 * Access admin. Rumana is the auditor: she reads people but gives no profiles. Sabbir gives profiles in Master and HR
 * only, so Engineering lead, which also reaches Project management, is beyond his access. Kamrul has nothing in Master.
 */
describe('GET /access-profiles/:id/people', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });
  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  it('lists who holds a profile, with their org role, and lets a super admin remove any of them', async () => {
    const response = await (await as('farhana')).get('/access-profiles/ap_developer/people');
    expect(response.status).toBe(200);
    expect(response.body.profile).toEqual({ id: 'ap_developer', name: 'Developer' });
    expect(holderIds(response.body)).toEqual(['u_09', 'u_10']);
    expect(response.body.people[0]).toMatchObject({ name: 'Mehedi Hasan', email: 'mehedi@twintrack.test', status: 'active', orgRole: { id: expect.any(String), name: expect.any(String) } });
    expect(removable(response.body)).toEqual({ u_09: true, u_10: true });
  });

  it('drops a person from the list once their profile is taken away', async () => {
    const farhana = await as('farhana');
    expect((await farhana.put('/users/u_10/profile', { profileId: null })).status).toBe(200);
    expect(holderIds((await farhana.get('/access-profiles/ap_developer/people')).body)).toEqual(['u_09']);
  });

  it('never offers to remove your own profile', async () => {
    const response = await (await as('arif')).get('/access-profiles/ap_access_admin/people');
    expect(response.status).toBe(200);
    expect(removable(response.body)).toEqual({ u_07: false });
  });

  it('shows people, but no remove, to someone who reads people without giving profiles', async () => {
    const response = await (await as('rumana')).get('/access-profiles/ap_developer/people');
    expect(response.status).toBe(200);
    expect(removable(response.body)).toEqual({ u_09: false, u_10: false });
  });

  it('offers no remove when the profile goes beyond your own access, as the API would refuse it', async () => {
    const sabbir = await as('sabbir');
    const response = await sabbir.get('/access-profiles/ap_engineering_lead/people');
    expect(response.status).toBe(200);
    expect(removable(response.body)).toEqual({ u_04: false });
    expect((await sabbir.put('/users/u_04/profile', { profileId: null })).body.error.code).toBe('beyond_own_access');
  });

  it('refuses someone who neither reads people nor gives profiles', async () => {
    const response = await (await as('kamrul')).get('/access-profiles/ap_developer/people');
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('refuses a caller with no session', async () => {
    const response = await request(app).get('/access-profiles/ap_developer/people');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('no_token');
  });

  it('answers 404 for a profile that does not exist', async () => {
    const response = await (await as('farhana')).get('/access-profiles/ap_nowhere/people');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('unknown_profile');
  });
});
