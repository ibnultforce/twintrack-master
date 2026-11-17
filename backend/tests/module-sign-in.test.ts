import type { Application } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { HandoffCode } from '../src/modules/master/models/handoffCode.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const MODULE_ORIGIN = 'http://projects.example.localhost:3300';
const CALLBACK = `${MODULE_ORIGIN}/auth/callback`;
const SETTINGS = { frontendUrl: MODULE_ORIGIN, redirectUrls: [CALLBACK], allowedOrigins: [] };

describe('signing in to a module frontend with a one-time code', () => {
  useTestDatabase();

  let app: Application;
  const as = async (id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));
  const exchange = (code: string, origin = MODULE_ORIGIN) => request(app).post('/auth/handoff').set('Origin', origin).send({ code });
  const codeFrom = (redirectTo: string) => new URL(redirectTo).searchParams.get('code')!;

  beforeAll(() => {
    app = createApp(createTestConfig());
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('farhana', { superAdmin: true });
    await AccessProfile.create({ _id: 'ap_signin_developer', name: 'Developer', grants: { projects: { task: { actions: ['read'], scope: 'own' } } } });
    await AccessProfile.create({ _id: 'ap_signin_module_admin', name: 'Module admin', grants: { master: '*' } });
    await addPerson('karim', { profileId: 'ap_signin_developer' });
    await addPerson('alia', { profileId: 'ap_signin_module_admin' });
  });

  it('lets only a super admin save where a module signs people in', async () => {
    const alia = await as('alia');
    const refused = await alia.put('/modules/projects/frontend', SETTINGS);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('super_admin_only');

    const farhana = await as('farhana');
    const saved = await farhana.put('/modules/projects/frontend', SETTINGS);
    expect(saved.status).toBe(200);
    expect(saved.body.frontendSettings).toMatchObject({ frontendUrl: MODULE_ORIGIN, frontendUrlSource: 'app', redirectUrls: [CALLBACK] });

    const listed = (await farhana.get('/modules')).body.modules.find((module: { key: string }) => module.key === 'projects');
    expect(listed.frontendUrl).toBe(MODULE_ORIGIN);
    const mine = (await (await as('karim')).get('/me/modules')).body.modules.find((module: { key: string }) => module.key === 'projects');
    expect(mine).toMatchObject({ frontendUrl: MODULE_ORIGIN, signsInWithCode: true });
  });

  it('refuses a redirect address outside the frontend and allowed origins, and insecure or malformed addresses', async () => {
    const farhana = await as('farhana');
    const refused = await farhana.put('/modules/projects/frontend', {
      frontendUrl: `${MODULE_ORIGIN}/path`,
      redirectUrls: ['https://evil.example/callback', `${CALLBACK}#fragment`],
      allowedOrigins: ['not an address'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.map((field: { path: string }) => field.path)).toEqual(['frontendUrl', 'allowedOrigins.0', 'redirectUrls.0', 'redirectUrls.1']);
  });

  it('lets a saved origin call the API at once, and forgets it once removed', async () => {
    const farhana = await as('farhana');
    const extraOrigin = 'https://projects.example.com';
    const preflight = () => request(app).options('/auth/handoff').set('Origin', extraOrigin).set('Access-Control-Request-Method', 'POST');
    expect((await preflight()).headers['access-control-allow-origin']).toBeUndefined();

    await farhana.put('/modules/projects/frontend', { ...SETTINGS, allowedOrigins: [extraOrigin] });
    expect((await preflight()).headers['access-control-allow-origin']).toBe(extraOrigin);

    await farhana.put('/modules/projects/frontend', SETTINGS);
    expect((await preflight()).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('signs a person in to the module once per code, on the Master session', async () => {
    await (await as('farhana')).put('/modules/projects/frontend', SETTINGS);
    const karim = await as('karim');

    const issued = await karim.post('/modules/projects/handoff', {});
    expect(issued.status).toBe(200);
    expect(issued.body.redirectTo.startsWith(`${CALLBACK}?code=`)).toBe(true);
    const code = codeFrom(issued.body.redirectTo);
    expect(await HandoffCode.countDocuments({ codeHash: code })).toBe(0);

    const exchanged = await exchange(code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.body).toMatchObject({ module: 'projects', expiresIn: expect.any(Number) });
    const moduleSession = requestsAs(app, exchanged.body.accessToken);
    expect((await moduleSession.get('/auth/me')).body.email).toBe('karim@twintrack.test');

    const reused = await exchange(code);
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('invalid_code');
  });

  it('refuses a code from another address, an expired code, and people without access to the module', async () => {
    await (await as('farhana')).put('/modules/projects/frontend', SETTINGS);
    const karim = await as('karim');

    const wrongOrigin = await exchange(codeFrom((await karim.post('/modules/projects/handoff', {})).body.redirectTo), 'https://evil.example');
    expect(wrongOrigin.status).toBe(403);

    const code = codeFrom((await karim.post('/modules/projects/handoff', {})).body.redirectTo);
    await HandoffCode.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await exchange(code)).body.error.code).toBe('invalid_code');

    const unlisted = await karim.post('/modules/projects/handoff', { redirectUrl: 'https://evil.example/callback' });
    expect(unlisted.body.error.code).toBe('unknown_redirect_url');

    const noAccess = await karim.post('/modules/hr/handoff', {});
    expect(noAccess.status).toBe(403);
  });

  it('says when a module has no sign-in address yet', async () => {
    const issued = await (await as('karim')).post('/modules/projects/handoff', {});
    expect(issued.status).toBe(409);
    expect(issued.body.error.code).toBe('no_redirect_url');
  });

  it('ends the module access when the person signs out of Master', async () => {
    await (await as('farhana')).put('/modules/projects/frontend', SETTINGS);
    const masterToken = await signIn(app, 'karim@twintrack.test');
    const code = codeFrom((await requestsAs(app, masterToken).post('/modules/projects/handoff', {})).body.redirectTo);
    const moduleToken = (await exchange(code)).body.accessToken as string;

    const sessionId = JSON.parse(Buffer.from(masterToken.split('.')[1]!, 'base64url').toString()).sid as string;
    const { Session } = await import('../src/modules/master/models/session.js');
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: new Date() } });
    expect((await requestsAs(app, moduleToken).get('/auth/me')).status).toBe(401);
  });
});
