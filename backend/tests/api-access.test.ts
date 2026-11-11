import { createHash, randomBytes } from 'node:crypto';
import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { ApiToken } from '../src/modules/master/models/apiToken.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { OAuthClient } from '../src/modules/master/models/oauth.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addOrgRole, addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const API_URL = 'http://localhost:4100';
const PORTAL_URL = 'http://twintrack.localhost:3100';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

/** Sends one MCP JSON-RPC call, as an MCP client would. */
function callMcp(app: Application, token: string | null, method: string, params: object = {}) {
  const pending = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream').set('Content-Type', 'application/json');
  if (token) pending.set('Authorization', `Bearer ${token}`);
  return pending.send({ jsonrpc: '2.0', id: 1, method, params });
}

const callTool = (app: Application, token: string, name: string, args: object = {}) => callMcp(app, token, 'tools/call', { name, arguments: args });
const toolData = (response: request.Response) => JSON.parse(response.body.result.content[0].text);

describe('API tokens, OAuth and MCP', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const makeToken = async (id: string, body: object = { name: 'Claude Code' }) => (await (await as(id)).post('/me/api-tokens', body)).body as { id: string; token: string };

  beforeAll(() => {
    app = createApp(createTestConfig({ PUBLIC_API_URL: API_URL, PORTAL_URL, IMPERSONATION_ENABLED: 'true' }));
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addOrgRole('or_root');
    await AccessProfile.create({ _id: 'ap_clients', name: 'Client reader', grants: { master: { client: { actions: ['read'] } } } });
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true, orgRoleId: 'or_root' });
    await addPerson('karim', { name: 'Karim Ahmed', title: 'Backend Developer', profileId: 'ap_developer', orgRoleId: 'or_root' });
    await addPerson('sara', { name: 'Sara Sales', profileId: 'ap_clients', orgRoleId: 'or_root' });
  });

  describe('personal API tokens', () => {
    it('shows a new token once, and lists it afterwards without the token', async () => {
      const karim = await as('karim');
      const created = await karim.post('/me/api-tokens', { name: 'Laptop', expiresInDays: 30 });
      expect(created.status).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.body).toMatchObject({ name: 'Laptop', token: expect.stringMatching(/^tt_pat_/), prefix: expect.stringMatching(/^tt_pat_.{4}$/) });
      expect(created.body.expiresAt).toEqual(expect.any(String));

      const { tokens } = (await karim.get('/me/api-tokens')).body;
      expect(tokens).toHaveLength(1);
      expect(JSON.stringify(tokens)).not.toContain(created.body.token);
      expect(JSON.stringify(await ApiToken.find().lean())).not.toContain(created.body.token);
      expect(await AuditLog.exists({ action: 'apiToken.created', actorId: 'karim' })).toBeTruthy();
    });

    it("lists only your own tokens, and treats someone else's as not found", async () => {
      const { id } = await makeToken('karim');
      expect((await (await as('sara')).get('/me/api-tokens')).body.tokens).toEqual([]);
      expect((await (await as('sara')).post(`/me/api-tokens/${id}/revoke`)).status).toBe(404);
    });

    it('stops a revoked token from working', async () => {
      const { id, token } = await makeToken('karim');
      expect((await (await as('karim')).post(`/me/api-tokens/${id}/revoke`)).body.revokedAt).toEqual(expect.any(String));
      expect((await callMcp(app, token, 'tools/list')).status).toBe(401);
    });

    it('allows ten active tokens at most', async () => {
      for (let count = 0; count < 10; count += 1) await makeToken('karim');
      const response = await (await as('karim')).post('/me/api-tokens', { name: 'One too many' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('too_many_tokens');
    });

    it('refuses to make a token while signed in as someone else', async () => {
      const { accessToken } = (await (await as('farhana')).post('/users/karim/impersonate')).body;
      const response = await requestsAs(app, accessToken).post('/me/api-tokens', { name: 'Sneaky' });
      expect(response.body.error.code).toBe('impersonating');
    });

    it.each([{}, { name: '' }, { name: 'x', expiresInDays: 0 }, { name: 'x', expiresInDays: 400 }, { name: 'x', extra: 1 }])('refuses the body %j', async (body) => {
      expect((await (await as('karim')).post('/me/api-tokens', body)).status).toBe(422);
    });
  });

  describe('the MCP endpoint', () => {
    it('asks for a token, and says where to start OAuth', async () => {
      const response = await callMcp(app, null, 'tools/list');
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe(`Bearer resource_metadata="${API_URL}/.well-known/oauth-protected-resource/mcp"`);
    });

    it('refuses an unknown token', async () => {
      const response = await callMcp(app, 'tt_pat_not-a-real-token', 'tools/list');
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
    });

    it("answers as the token's person, with Master's tools", async () => {
      const { token } = await makeToken('karim');
      const tools = (await callMcp(app, token, 'tools/list')).body.result.tools.map((tool: { name: string }) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['whoami', 'my_permissions', 'find_colleagues', 'list_clients']));

      const whoami = toolData(await callTool(app, token, 'whoami'));
      expect(whoami).toMatchObject({ id: 'karim', name: 'Karim Ahmed', modules: [{ key: 'tasks' }] });
      expect(toolData(await callTool(app, token, 'my_permissions', { module: 'tasks' }))).toMatchObject({ hasAccess: true, permissions: { 'task.read': 'own' } });
      expect(toolData(await callTool(app, token, 'find_colleagues', { search: 'sara' })).people.map((person: { id: string }) => person.id)).toEqual(['sara']);
      expect((await ApiToken.findOne().lean())?.lastUsedAt).toBeInstanceOf(Date);
    });

    it("keeps each tool to the person's own permissions", async () => {
      const karimToken = (await makeToken('karim')).token;
      const refused = await callTool(app, karimToken, 'list_clients');
      expect(refused.body.result).toMatchObject({ isError: true, content: [{ text: 'You do not have permission to see clients.' }] });

      await (await as('farhana')).post('/clients', { name: 'Acme Ltd' });
      const saraToken = (await makeToken('sara')).token;
      expect(toolData(await callTool(app, saraToken, 'list_clients')).clients.map((client: { name: string }) => client.name)).toEqual(['Acme Ltd']);
    });

    it('stops working at once when the person is deactivated', async () => {
      const { token } = await makeToken('karim');
      await User.updateOne({ _id: 'karim' }, { $set: { status: 'inactive' } });
      expect((await callMcp(app, token, 'tools/list')).status).toBe(401);
    });

    it.each(['get', 'delete'] as const)('answers %s with 405, because it is stateless', async (method) => {
      const response = await request(app)[method]('/mcp');
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST');
    });

    it('takes calls from any origin, because apps authenticate with tokens, not cookies', async () => {
      const response = await request(app).options('/mcp').set('Origin', 'https://claude.ai').set('Access-Control-Request-Method', 'POST');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('OAuth for connectors', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    async function registerClient() {
      const response = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Claude', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'] });
      expect(response.status).toBe(201);
      return response.body as { client_id: string; client_secret: string };
    }

    async function startAuthorization(clientId: string) {
      const response = await request(app).get('/oauth/authorize').query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        resource: `${API_URL}/mcp`,
      });
      expect(response.status).toBe(302);
      const consent = new URL(response.headers.location as string);
      expect(`${consent.origin}${consent.pathname}`).toBe(`${PORTAL_URL}/oauth/consent`);
      return consent.searchParams.get('request') as string;
    }

    const exchange = (client: { client_id: string; client_secret: string }, fields: Record<string, string>) =>
      request(app).post('/oauth/token').type('form').send({ client_id: client.client_id, client_secret: client.client_secret, ...fields });

    async function connectKarim() {
      const client = await registerClient();
      const requestId = await startAuthorization(client.client_id);
      const karim = await as('karim');
      expect((await karim.get(`/oauth/requests/${requestId}`)).body).toMatchObject({ clientName: 'Claude', redirectHost: 'claude.ai' });

      const { redirectUrl } = (await karim.post(`/oauth/requests/${requestId}/decision`, { approve: true })).body;
      const redirect = new URL(redirectUrl);
      expect(redirect.searchParams.get('state')).toBe('xyz');
      const code = redirect.searchParams.get('code') as string;
      const tokens = await exchange(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
      expect(tokens.status).toBe(200);
      return { client, code, tokens: tokens.body as { access_token: string; refresh_token: string } };
    }

    it('publishes where the sign-in flow lives', async () => {
      const metadata = (await request(app).get('/.well-known/oauth-authorization-server')).body;
      expect(metadata).toMatchObject({ issuer: `${API_URL}/`, authorization_endpoint: `${API_URL}/oauth/authorize`, token_endpoint: `${API_URL}/oauth/token` });
      const resource = (await request(app).get('/.well-known/oauth-protected-resource/mcp')).body;
      expect(resource.resource).toBe(`${API_URL}/mcp`);
    });

    it('stores a registered secret encrypted, never as sent', async () => {
      const { client_secret: secret } = await registerClient();
      expect(JSON.stringify(await OAuthClient.find().lean())).not.toContain(secret);
    });

    it('connects an app after the person approves, and its token acts as them', async () => {
      const { tokens } = await connectKarim();
      expect(tokens.access_token).toMatch(/^tt_oat_/);
      expect(toolData(await callTool(app, tokens.access_token, 'whoami')).id).toBe('karim');

      const { apps } = (await (await as('karim')).get('/me/connected-apps')).body;
      expect(apps).toEqual([expect.objectContaining({ clientName: 'Claude' })]);
    });

    it('replaces both tokens on refresh, so the old refresh token stops working', async () => {
      const { client, tokens } = await connectKarim();
      const refreshed = await exchange(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      expect(refreshed.status).toBe(200);
      expect((await callMcp(app, tokens.access_token, 'tools/list')).status).toBe(401);
      expect((await callMcp(app, refreshed.body.access_token, 'tools/list')).status).toBe(200);
      expect((await exchange(client, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).status).toBe(400);
    });

    it('treats a code used twice as leaked, and revokes what it gave', async () => {
      const { client, code, tokens } = await connectKarim();
      const again = await exchange(client, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI });
      expect(again.status).toBe(400);
      expect(again.body.error).toBe('invalid_grant');
      expect((await callMcp(app, tokens.access_token, 'tools/list')).status).toBe(401);
    });

    it('refuses a wrong PKCE verifier', async () => {
      const client = await registerClient();
      const requestId = await startAuthorization(client.client_id);
      const { redirectUrl } = (await (await as('karim')).post(`/oauth/requests/${requestId}/decision`, { approve: true })).body;
      const code = new URL(redirectUrl).searchParams.get('code') as string;
      const response = await exchange(client, { grant_type: 'authorization_code', code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: REDIRECT_URI });
      expect(response.status).toBe(400);
    });

    it('sends the app a refusal when the person declines, and lets each request be answered once', async () => {
      const client = await registerClient();
      const requestId = await startAuthorization(client.client_id);
      const karim = await as('karim');
      const { redirectUrl } = (await karim.post(`/oauth/requests/${requestId}/decision`, { approve: false })).body;
      expect(new URL(redirectUrl).searchParams.get('error')).toBe('access_denied');
      expect((await karim.post(`/oauth/requests/${requestId}/decision`, { approve: true })).body.error.code).toBe('request_answered');
    });

    it('disconnects an app, which stops its token at once', async () => {
      const { tokens } = await connectKarim();
      const karim = await as('karim');
      const [connected] = (await karim.get('/me/connected-apps')).body.apps;
      expect((await karim.post(`/me/connected-apps/${connected.id}/revoke`)).body).toEqual({ id: connected.id, revoked: true });
      expect((await callMcp(app, tokens.access_token, 'tools/list')).status).toBe(401);
      expect((await karim.get('/me/connected-apps')).body.apps).toEqual([]);
      expect((await (await as('sara')).post(`/me/connected-apps/${connected.id}/revoke`)).status).toBe(404);
    });

    it('answers 404 for a request that does not exist, and needs a session', async () => {
      expect((await (await as('karim')).get('/oauth/requests/nope')).body.error.code).toBe('unknown_request');
      expect((await request(app).get('/oauth/requests/nope')).status).toBe(401);
    });
  });
});
