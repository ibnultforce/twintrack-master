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

/** Farhana is the super admin. Kamrul has no profile that grants anything in New test. */
describe('New test module', () => {
  useTestDatabase();

  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig());
  });
  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  describe('GET /new-test/test', () => {
    it('answers someone who holds test.read', async () => {
      const response = await (await as('farhana')).get('/new-test/test');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok', module: 'new-test' });
      expect(Number.isNaN(Date.parse(response.body.time))).toBe(false);
    });

    it('refuses someone without test.read', async () => {
      const response = await (await as('kamrul')).get('/new-test/test');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('refuses a caller with no session', async () => {
      const response = await request(app).get('/new-test/test');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('no_token');
    });
  });

  describe('GET /new-test/health', () => {
    it('answers without a session', async () => {
      const response = await request(app).get('/new-test/health');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'ok', module: 'new-test' });
      expect(Number.isNaN(Date.parse(response.body.time))).toBe(false);
    });

    it('answers someone with no New test permissions', async () => {
      const response = await (await as('kamrul')).get('/new-test/health');
      expect(response.status).toBe(200);
    });
  });
});
