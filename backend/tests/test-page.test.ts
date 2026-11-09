import { readFileSync } from 'node:fs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createMasterRoutes } from '../src/modules/master/master.routes.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { createTestConfig, TEST_ENV, TEST_ORIGIN } from './helpers/testConfig.js';

const PASSWORD = 'test-page-password';
const COOKIE_HOLDER_EMAIL = 'rahim@twintrack.test';
const PUBLIC_ADDRESS = 'demo-link.trycloudflare.com';

interface Scenario {
  title: string;
  expected: number;
  code?: string;
  request: { method: string; path: string; as?: string; literalToken?: string; cookie?: boolean; body?: string };
}
interface ScenarioFile {
  groups: { routes: { id: string; scenarios: Scenario[] }[] }[];
}

const scenarioFile = JSON.parse(readFileSync(new URL('../test-page/scenarios.json', import.meta.url), 'utf8')) as ScenarioFile;
const routes = scenarioFile.groups.flatMap((group) => group.routes);
const scenarios = routes.flatMap((route) => route.scenarios.map((scenario) => [`${route.id}: ${scenario.title}`, scenario] as const));

interface Account {
  id: string;
  email: string;
}
const { accounts, testPassword } = JSON.parse(readFileSync(new URL('../test-page/accounts.json', import.meta.url), 'utf8')) as { accounts: Account[]; testPassword: string };
const seedUsers = (readSeedFiles().users as { users: { id: string; email: string }[] }).users;

describe('test page', () => {
  useTestDatabase();

  const enabledApp = createApp(createTestConfig({ TEST_PAGE_ENABLED: 'true' }));
  const disabledApp = createApp(createTestConfig());

  describe('availability', () => {
    it.each(['/try/', '/try/app.js', '/try/scenarios.json'])('hides %s unless it is switched on', async (path) => {
      expect((await request(disabledApp).get(path)).status).toBe(404);
    });

    it('can not be switched on in production', () => {
      expect(() => loadConfig({ ...TEST_ENV, NODE_ENV: 'production', TEST_PAGE_ENABLED: 'true' })).toThrow(ConfigError);
    });

    it('sends /try on to the folder, so the page finds its files', async () => {
      const response = await request(enabledApp).get('/try');
      expect(response.status).toBe(301);
      expect(response.headers.location).toBe('/try/');
    });

    it('serves the page with a policy that allows only its own files, and no forced HTTPS', async () => {
      const response = await request(enabledApp).get('/try/');
      expect(response.status).toBe(200);
      expect(response.text).toContain('Try the TwinTrack API');
      const policy = response.headers['content-security-policy'];
      expect(policy).toContain("default-src 'self'");
      expect(policy).not.toContain('upgrade-insecure-requests');
      expect(policy).not.toContain('unsafe-inline');
    });

    it('still protects API routes while it is on', async () => {
      expect((await request(enabledApp).get('/users')).status).toBe(401);
    });
  });

  describe('signing in from the page behind a changing address', () => {
    const logIn = (app: typeof enabledApp, origin: string) =>
      request(app).post('/auth/login').set('Host', PUBLIC_ADDRESS).set('Origin', origin).send({ email: COOKIE_HOLDER_EMAIL, password: PASSWORD });

    beforeEach(async () => {
      await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    });

    it('accepts a request from the address the API is being reached on', async () => {
      expect((await logIn(enabledApp, `https://${PUBLIC_ADDRESS}`)).status).toBe(200);
    });

    it('still refuses any other address', async () => {
      const response = await logIn(enabledApp, 'https://evil.example');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('origin_not_allowed');
    });

    it('refuses a malformed origin instead of failing', async () => {
      expect((await logIn(enabledApp, 'not a url')).status).toBe(403);
    });

    it('refuses the same address when the page is off', async () => {
      expect((await logIn(disabledApp, `https://${PUBLIC_ADDRESS}`)).status).toBe(403);
    });
  });

  describe('test accounts', () => {
    it('list every person in the seed, with the right email', () => {
      const pairs = (people: { id: string; email: string }[]) => people.map(({ id, email }) => `${id} ${email}`).sort();
      expect(pairs(accounts)).toEqual(pairs(seedUsers));
    });

    it('fill in the same password the example settings give the seed', () => {
      const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
      expect(example).toContain(`SEED_PASSWORD=${testPassword}`);
    });
  });

  describe('scenarios', () => {
    it('cover every built route', () => {
      const covered = routes.filter((route) => route.scenarios.length > 0).map((route) => route.id);
      const built = createMasterRoutes(createTestConfig()).map((route) => `${route.method} ${route.path}`);
      expect(built.filter((id) => !covered.includes(id))).toEqual([]);
    });

    beforeAll(async () => {
      await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    });

    it.each(scenarios)('%s', async (_name, { expected, code, request: sent }) => {
      await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });

      const logIn = (email: string) => request(enabledApp).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: PASSWORD });
      const method = sent.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
      const pending = request(enabledApp)[method](sent.path).set('Origin', TEST_ORIGIN);

      if (sent.as) pending.set('Authorization', `Bearer ${(await logIn(sent.as)).body.accessToken as string}`);
      if (sent.literalToken) pending.set('Authorization', `Bearer ${sent.literalToken}`);
      if (sent.cookie) pending.set('Cookie', ((await logIn(COOKIE_HOLDER_EMAIL)).headers['set-cookie'] as unknown as string[])[0]!);
      if (sent.body) pending.set('Content-Type', 'application/json').send(sent.body.split('YOUR_PASSWORD').join(PASSWORD));

      const response = await pending;
      expect(response.status).toBe(expected);
      if (code) expect(response.body.error.code).toBe(code);
    });
  });
});
