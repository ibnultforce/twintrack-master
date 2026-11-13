import { resolveDependencies } from '../src/appDependencies.js';
import { readFileSync, writeFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { hrRoutes } from '../src/modules/hr/hr.routes.js';
import { createMasterRoutes } from '../src/modules/master/master.routes.js';
import { createAccountsRoutes } from '../src/modules/accounts/accounts.routes.js';
import { createTasksRoutes } from '../src/modules/tasks/tasks.routes.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { createTestConfig, TEST_ENV, TEST_ORIGIN } from './helpers/testConfig.js';

const PASSWORD = 'test-page-password';
const COOKIE_HOLDER_EMAIL = 'rahim@twintrack.test';
const PUBLIC_ADDRESS = 'demo-link.trycloudflare.com';

interface ScenarioRequest {
  method: string;
  path: string;
  as?: string;
  literalToken?: string;
  cookie?: boolean;
  body?: string;
  /** Sent with the body. JSON unless set, which a photo upload needs. */
  contentType?: string;
  /** An Accept header, which the MCP endpoint needs. */
  accept?: string;
  /** Sent in place of the allowed origin. Only this replay can send it, because browsers set Origin themselves. */
  origin?: string;
}
/** A request run before the scenario, such as creating the record it uses. `save` keeps response fields for {{name}} placeholders. */
interface SetupStep extends ScenarioRequest {
  save?: Record<string, string>;
}
interface Scenario {
  kind: 'success' | 'fail';
  title: string;
  expected: number;
  code?: string;
  setup?: SetupStep[];
  request: ScenarioRequest;
}
interface ScenarioFile {
  groups: { routes: { id: string; scenarios: Scenario[] }[] }[];
}

const scenarioFile = JSON.parse(readFileSync(new URL('../test-page/scenarios.json', import.meta.url), 'utf8')) as ScenarioFile;
const routes = scenarioFile.groups.flatMap((group) => group.routes);
const scenarios = routes.flatMap((route) => route.scenarios.map((scenario) => [`${route.id}: ${scenario.title}`, scenario, route.id] as const));

/**
 * Set API_SAMPLES_FILE to a path to save each route's first success scenario, request and response, for the API
 * scenarios page in design/. Tokens are replaced and long lists cut to two items, so the file is safe to publish.
 */
const SAMPLES_FILE = process.env.API_SAMPLES_FILE;
const SAMPLE_LIST_LENGTH = 2;
const SECRET_FIELDS = new Set(['accessToken']);
interface ApiSample {
  title: string;
  request: { method: string; path: string; as?: string; body?: unknown };
  response: { status: number; body: unknown };
}
const samples: Record<string, ApiSample> = {};

function toSampleValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, SAMPLE_LIST_LENGTH).map(toSampleValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_FIELDS.has(key) ? `<${key}>` : toSampleValue(inner)]));
  }
  return value;
}

const parseSentBody = (body: string) => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
};

interface Account {
  id: string;
  email: string;
}
const { accounts, testPassword } = JSON.parse(readFileSync(new URL('../test-page/accounts.json', import.meta.url), 'utf8')) as { accounts: Account[]; testPassword: string };
const seedUsers = (readSeedFiles().users as { users: { id: string; email: string }[] }).users;

describe('test page', () => {
  useTestDatabase();

  // Impersonation is on too, as in development, where the page is used.
  const enabledApp = createApp(createTestConfig({ TEST_PAGE_ENABLED: 'true', IMPERSONATION_ENABLED: 'true' }));
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
    const builtRouteIds = [...createMasterRoutes(createTestConfig(), resolveDependencies(createTestConfig())), ...hrRoutes, ...createTasksRoutes(createTestConfig(), resolveDependencies(createTestConfig())), ...createAccountsRoutes(createTestConfig(), resolveDependencies(createTestConfig()))].map((route) => `${route.method} ${route.path}`);
    const routesWith = (kind: Scenario['kind']) => routes.filter((route) => route.scenarios.some((scenario) => scenario.kind === kind)).map((route) => route.id);

    // Succeeding on these needs something neither this replay nor someone using the page can get: a link that only
    // arrives by email, or an OAuth request an app started through /oauth/authorize, which answers with a redirect.
    // users-admin.test.ts, api-access.test.ts and the Postman collection cover their success.
    // GET and DELETE /mcp only ever answer 405, because the endpoint is stateless.
    const SUCCESS_COVERED_ELSEWHERE = [
      'POST /auth/set-password',
      'GET /oauth/requests/:id',
      'POST /oauth/requests/:id/decision',
      'POST /me/connected-apps/:id/revoke',
      'POST /connected-apps/:id/revoke',
      'GET /mcp',
      'DELETE /mcp',
      // Uploads need a part's ETag header, and file links come from the storage, which a replay can't follow.
      // attachments.test.ts and the Postman collection cover their success.
      'POST /tasks/tasks/:id/attachments/:attachmentId/complete',
      'GET /tasks/tasks/:id/attachments/:attachmentId/url',
      'PUT /files/parts',
      'POST /accounts/documents/:id/complete',
      'GET /accounts/documents/:id/url',
      'GET /files/content',
    ];

    it.each(['success', 'fail'] as const)('give every built route in every module a %s scenario', (kind) => {
      const covered = [...routesWith(kind), ...(kind === 'success' ? SUCCESS_COVERED_ELSEWHERE : [])];
      expect(builtRouteIds.filter((id) => !covered.includes(id))).toEqual([]);
    });

    beforeAll(async () => {
      await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
    });

    afterAll(() => {
      if (SAMPLES_FILE) writeFileSync(SAMPLES_FILE, `${JSON.stringify(samples, null, 2)}
`);
    });

    it.each(scenarios)('%s', async (_name, { kind, title, expected, code, setup = [], request: sent }, routeId) => {
      await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });

      const logIn = (email: string) => request(enabledApp).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email, password: PASSWORD });
      const saved: Record<string, string> = {};
      const fillIn = (text: string) => text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => saved[name] ?? `{{${name}}}`);

      const sendRequest = async (sending: ScenarioRequest) => {
        const method = sending.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
        const pending = request(enabledApp)[method](fillIn(sending.path)).set('Origin', sending.origin ?? TEST_ORIGIN);
        if (sending.as) pending.set('Authorization', `Bearer ${(await logIn(sending.as)).body.accessToken as string}`);
        if (sending.literalToken) pending.set('Authorization', `Bearer ${fillIn(sending.literalToken)}`);
        if (sending.accept) pending.set('Accept', sending.accept);
        if (sending.cookie) pending.set('Cookie', ((await logIn(COOKIE_HOLDER_EMAIL)).headers['set-cookie'] as unknown as string[])[0]!);
        if (sending.body) pending.set('Content-Type', sending.contentType ?? 'application/json').send(fillIn(sending.body.split('YOUR_PASSWORD').join(PASSWORD)));
        return pending;
      };

      for (const step of setup) {
        const answer = await sendRequest(step);
        expect(answer.status, `setup ${step.method} ${step.path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
        // A field may be nested, such as attachment.id.
        for (const [name, field] of Object.entries(step.save ?? {})) saved[name] = String(field.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], answer.body));
      }

      const response = await sendRequest(sent);
      expect(response.status, JSON.stringify(response.body)).toBe(expected);
      if (code) expect(response.body.error.code).toBe(code);

      if (SAMPLES_FILE && kind === 'success' && !samples[routeId]) {
        samples[routeId] = {
          title,
          request: { method: sent.method, path: fillIn(sent.path), ...(sent.as && { as: sent.as }), ...(sent.body && { body: parseSentBody(fillIn(sent.body)) }) },
          response: { status: response.status, body: toSampleValue(response.body) },
        };
      }
    });
  });
});
