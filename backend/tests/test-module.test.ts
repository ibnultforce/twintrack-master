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

/** Farhana is the super admin. Kamrul has no profile that grants anything in Test. */
describe('Test module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });
  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('GET /test', () => {
    it('answers someone who holds test.read', async () => {
      const response = await (await as('farhana')).get('/test');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok', module: 'test' });
      expect(Number.isNaN(Date.parse(response.body.time))).toBe(false);
    });

    it('refuses someone without test.read', async () => {
      const response = await (await as('kamrul')).get('/test');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('refuses a caller with no session', async () => {
      const response = await request(app).get('/test');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('no_token');
    });
  });

  describe('GET /test/users', () => {
    it('lists active colleagues, without super admins, to someone who holds test.read', async () => {
      const response = await (await as('farhana')).get('/test/users?pageSize=100');
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(response.body.people.length);
      const emails = response.body.people.map((person: { email: string }) => person.email);
      expect(emails).toContain('kamrul@twintrack.test');
      expect(emails).not.toContain('farhana@twintrack.test');
      expect(response.body.people[0]).not.toHaveProperty('profileId');
    });

    it('searches by name', async () => {
      const response = await (await as('farhana')).get('/test/users?search=kamrul');
      expect(response.status).toBe(200);
      expect(response.body.people.map((person: { email: string }) => person.email)).toEqual(['kamrul@twintrack.test']);
    });

    it('refuses someone without test.read', async () => {
      const response = await (await as('kamrul')).get('/test/users');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('refuses a caller with no session', async () => {
      const response = await request(app).get('/test/users');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('no_token');
    });

    it('refuses a page size over the limit', async () => {
      const response = await (await as('farhana')).get('/test/users?pageSize=1000');
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
    });
  });
});
