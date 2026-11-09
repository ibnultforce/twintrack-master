import { hash } from '@node-rs/argon2';
import express, { type Application } from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { registerRoutes, type ApiRoute } from '../src/lib/apiRoute.js';
import { handleApiError } from '../src/lib/errorHandler.js';
import { createRequestLogger } from '../src/lib/requestLogger.js';
import { createAccessMiddleware } from '../src/modules/master/access/access.middleware.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Session } from '../src/modules/master/models/session.js';
import { User } from '../src/modules/master/models/user.js';
import { validateManifest } from '../src/modules/master/moduleRegistry/manifest.js';
import { importManifest } from '../src/modules/master/moduleRegistry/moduleRegistry.service.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { useTestDatabase } from './helpers/database.js';
import { createTestConfig, TEST_ENV, TEST_ORIGIN } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const NEW_PASSWORD = 'a-brand-new-password';
const HR_ORIGIN = 'http://hr.twintrack.localhost:3200';
const config = createTestConfig({
  ALLOWED_ORIGINS: `${TEST_ORIGIN},${HR_ORIGIN}`,
  MODULE_FRONTEND_URLS: `hr=${HR_ORIGIN}`,
});
const issuer = config.auth.tokenIssuer;
const secretKey = new TextEncoder().encode(TEST_ENV.JWT_ACCESS_SECRET);

async function importSeedManifests(): Promise<void> {
  for (const raw of readSeedFiles().manifests) {
    const manifest = validateManifest(raw);
    if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));
    await importManifest(manifest.value, { allowCore: true });
  }
}

describe('access checks', () => {
  useTestDatabase();

  let app: Application;
  let passwordHash: string;

  const signIn = async (email: string, password = PASSWORD, target: Application = app): Promise<string> => {
    const response = await request(target).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email, password });
    expect(response.status).toBe(200);
    return (response.body as { accessToken: string }).accessToken;
  };

  const getAs = (token: string, path: string, target: Application = app) =>
    request(target).get(path).set('Authorization', `Bearer ${token}`);

  const signToken = (claims: { sub: string; sid: string }) =>
    new SignJWT({ sid: claims.sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(claims.sub).setIssuer(issuer).setAudience(issuer);

  const addPerson = (id: string, overrides: Record<string, unknown> = {}) =>
    User.create({ _id: id, name: `Person ${id}`, email: `${id}@twintrack.test`, passwordHash, ...overrides });

  beforeAll(async () => {
    app = createApp(config);
    passwordHash = await hash(PASSWORD);
  });

  beforeEach(async () => {
    await importSeedManifests();
    await addPerson('rahim', { name: 'Rahim Uddin', assignments: { hr: 'manager', account: 'viewer' }, managerId: 'farhana', title: 'Engineering Lead' });
    await addPerson('farhana', { name: 'Farhana Kabir', superAdmin: true });
    await addPerson('karim');
    await addPerson('sabbir', { assignments: { hr: 'staff', master: 'hr-access' } });
  });

  describe('session check', () => {
    const expectRefused = async (token: string, code: string) => {
      const response = await getAs(token, '/me/modules');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe(code);
    };

    it('refuses a request with no token', async () => {
      const response = await request(app).get('/me/modules');
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('no_token');
    });

    it('refuses a garbage token', async () => {
      await expectRefused('not.a.token', 'invalid_token');
    });

    it('refuses a token edited to name someone else', async () => {
      const [header, payload, signature] = (await signIn('rahim@twintrack.test')).split('.') as [string, string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
      const editedPayload = Buffer.from(JSON.stringify({ ...claims, sub: 'farhana' })).toString('base64url');
      await expectRefused(`${header}.${editedPayload}.${signature}`, 'invalid_token');
    });

    it('refuses a token signed with a different secret', async () => {
      const otherKey = new TextEncoder().encode('a-different-secret-that-is-also-long-enough');
      await expectRefused(await signToken({ sub: 'farhana', sid: 'any' }).setExpirationTime('5m').sign(otherKey), 'invalid_token');
    });

    it('refuses an unsigned token', async () => {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'farhana', sid: 'any', iss: issuer, aud: issuer })}.`;
      await expectRefused(unsigned, 'invalid_token');
    });

    it('refuses a token from a different issuer', async () => {
      const token = await new SignJWT({ sid: 'any' }).setProtectedHeader({ alg: 'HS256' }).setSubject('farhana').setIssuer('https://other.example').setAudience(issuer).setExpirationTime('5m').sign(secretKey);
      await expectRefused(token, 'invalid_token');
    });

    it('says when a token has expired, so the frontend knows to refresh', async () => {
      const token = await signToken({ sub: 'rahim', sid: 'any' }).setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(secretKey);
      await expectRefused(token, 'token_expired');
    });

    it('refuses a valid token whose session belongs to someone else', async () => {
      await signIn('rahim@twintrack.test');
      const rahimSession = await Session.findOne({ userId: 'rahim' }).lean();
      const token = await signToken({ sub: 'farhana', sid: rahimSession!._id }).setExpirationTime('5m').sign(secretKey);
      await expectRefused(token, 'session_revoked');
    });

    it('stops a still-valid token straight after logout', async () => {
      const login = await request(app).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'rahim@twintrack.test', password: PASSWORD });
      const cookies = login.headers['set-cookie'] as unknown as string[];
      await request(app).post('/auth/logout').set('Origin', TEST_ORIGIN).set('Cookie', cookies[0]!);
      await expectRefused((login.body as { accessToken: string }).accessToken, 'session_revoked');
    });

    it('stops a still-valid token when the session passes its limit', async () => {
      const token = await signIn('rahim@twintrack.test');
      await Session.updateOne({ userId: 'rahim' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await expectRefused(token, 'session_revoked');
    });

    it('stops a still-valid token as soon as the account is deactivated', async () => {
      const token = await signIn('rahim@twintrack.test');
      await User.updateOne({ _id: 'rahim' }, { $set: { status: 'inactive' } });
      await expectRefused(token, 'account_inactive');
    });
  });

  describe('permission check on private routes', () => {
    let privateApp: Application;

    beforeAll(() => {
      const respondWithScope: ApiRoute['handler'] = (req, res) => {
        res.json({ scope: req.permissionScope });
      };
      const routes: ApiRoute[] = [
        { method: 'GET', path: '/one-permission', access: 'private', permission: 'user.update', handler: respondWithScope },
        { method: 'GET', path: '/any-permission', access: 'private', anyPermission: ['user.update', 'hrAccess.update'], handler: respondWithScope },
        { method: 'GET', path: '/no-permission', access: 'private', handler: respondWithScope },
      ];
      privateApp = express();
      privateApp.use(createRequestLogger('silent'));
      registerRoutes(privateApp, routes, createAccessMiddleware(config.auth, 'master'));
      privateApp.use(handleApiError);
    });

    it('asks for a token before checking anything else', async () => {
      expect((await request(privateApp).get('/one-permission')).status).toBe(401);
    });

    it('refuses someone without the permission', async () => {
      const response = await getAs(await signIn('karim@twintrack.test'), '/one-permission', privateApp);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('forbidden');
    });

    it('lets a super admin through, and passes the scope to the handler', async () => {
      const response = await getAs(await signIn('farhana@twintrack.test'), '/one-permission', privateApp);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ scope: 'all' });
    });

    it('accepts any one of several allowed permissions', async () => {
      const token = await signIn('sabbir@twintrack.test');
      expect((await getAs(token, '/one-permission', privateApp)).status).toBe(403);
      expect((await getAs(token, '/any-permission', privateApp)).status).toBe(200);
    });

    it('refuses everyone on a private route that names no permission', async () => {
      expect((await getAs(await signIn('farhana@twintrack.test'), '/no-permission', privateApp)).status).toBe(403);
    });

    it('applies a role change on the next call, with the same token', async () => {
      const token = await signIn('sabbir@twintrack.test');
      expect((await getAs(token, '/any-permission', privateApp)).status).toBe(200);

      await User.updateOne({ _id: 'sabbir' }, { $unset: { 'assignments.master': 1 } });
      expect((await getAs(token, '/any-permission', privateApp)).status).toBe(403);
    });
  });

  describe('temporary passwords', () => {
    let token: string;

    beforeEach(async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { mustChangePassword: true } });
      token = await signIn('karim@twintrack.test');
    });

    it('blocks other routes until the password is changed', async () => {
      const response = await getAs(token, '/me/modules');
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('password_change_required');

      const update = await request(app).patch('/auth/me').set('Authorization', `Bearer ${token}`).send({ name: 'New Name' });
      expect(update.status).toBe(403);
    });

    it('still shows the profile, so the portal knows to ask for a new password', async () => {
      const response = await getAs(token, '/auth/me');
      expect(response.status).toBe(200);
      expect(response.body.mustChangePassword).toBe(true);
    });

    it('opens everything once the password is changed', async () => {
      const changed = await request(app)
        .post('/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(200);
      expect((await getAs(token, '/me/modules')).status).toBe(200);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the profile with the manager, and no password data', async () => {
      const response = await getAs(await signIn('rahim@twintrack.test'), '/auth/me');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: 'rahim',
        name: 'Rahim Uddin',
        title: 'Engineering Lead',
        superAdmin: false,
        manager: { id: 'farhana', name: 'Farhana Kabir' },
      });
      expect(response.body.passwordHash).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain('argon2');
    });

    it('shows no manager when there is none', async () => {
      expect((await getAs(await signIn('farhana@twintrack.test'), '/auth/me')).body.manager).toBeNull();
    });
  });

  describe('PATCH /auth/me', () => {
    const patchAs = (token: string, body: object) => request(app).patch('/auth/me').set('Authorization', `Bearer ${token}`).send(body);

    it('changes the name and records it', async () => {
      const response = await patchAs(await signIn('rahim@twintrack.test'), { name: '  Rahim U.  ' });
      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Rahim U.');

      const entry = await AuditLog.findOne({ action: 'user.name_changed' }).lean();
      expect(entry).toMatchObject({ actorId: 'rahim', before: { name: 'Rahim Uddin' }, after: { name: 'Rahim U.' } });
    });

    it('writes no audit entry when the name stays the same', async () => {
      await patchAs(await signIn('rahim@twintrack.test'), { name: 'Rahim Uddin' });
      expect(await AuditLog.countDocuments({ action: 'user.name_changed' })).toBe(0);
    });

    it.each([
      ['a role', { name: 'Rahim', assignments: { master: 'admin' } }],
      ['super admin', { name: 'Rahim', superAdmin: true }],
      ['a job title', { name: 'Rahim', title: 'Founder' }],
      ['a blank name', { name: '   ' }],
      ['an object as the name', { name: { $ne: null } }],
    ])('refuses a request containing %s', async (_label, body) => {
      const response = await patchAs(await signIn('rahim@twintrack.test'), body);
      expect(response.status).toBe(422);

      const rahim = await User.findById('rahim').lean();
      expect(rahim).toMatchObject({ name: 'Rahim Uddin', superAdmin: false, title: 'Engineering Lead' });
      expect(rahim?.assignments.master).toBeUndefined();
    });
  });

  describe('POST /auth/change-password', () => {
    const changeAs = (token: string, body: object, target: Application = app) =>
      request(target).post('/auth/change-password').set('Authorization', `Bearer ${token}`).send(body);

    it('needs a signed-in caller', async () => {
      expect((await request(app).post('/auth/change-password').send({})).status).toBe(401);
    });

    it('replaces the password', async () => {
      const response = await changeAs(await signIn('rahim@twintrack.test'), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ passwordChanged: true });

      const oldPassword = await request(app).post('/auth/login').set('Origin', TEST_ORIGIN).send({ email: 'rahim@twintrack.test', password: PASSWORD });
      expect(oldPassword.status).toBe(401);
      await signIn('rahim@twintrack.test', NEW_PASSWORD);
    });

    it('ends other sessions but keeps this one', async () => {
      const otherDevice = await signIn('rahim@twintrack.test');
      const thisDevice = await signIn('rahim@twintrack.test');

      await changeAs(thisDevice, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      expect((await getAs(thisDevice, '/me/modules')).status).toBe(200);
      expect((await getAs(otherDevice, '/me/modules')).status).toBe(401);
    });

    it('leaves other people signed in', async () => {
      const someoneElse = await signIn('karim@twintrack.test');
      await changeAs(await signIn('rahim@twintrack.test'), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect((await getAs(someoneElse, '/me/modules')).status).toBe(200);
    });

    it('refuses a wrong current password without a 401, and changes nothing', async () => {
      const token = await signIn('rahim@twintrack.test');
      const response = await changeAs(token, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('wrong_current_password');
      await signIn('rahim@twintrack.test');
    });

    it.each([
      ['too short', { currentPassword: PASSWORD, newPassword: 'short' }],
      ['one character under the minimum', { currentPassword: PASSWORD, newPassword: 'seven-7' }],
      ['the same as the current one', { currentPassword: PASSWORD, newPassword: PASSWORD }],
      ['too long', { currentPassword: PASSWORD, newPassword: 'x'.repeat(257) }],
      ['not a string', { currentPassword: PASSWORD, newPassword: { $ne: null } }],
    ])('refuses a new password that is %s', async (_label, body) => {
      const response = await changeAs(await signIn('rahim@twintrack.test'), body);
      expect(response.status).toBe(422);
      expect(response.body.error.fields[0].path).toBe('newPassword');
    });

    it('records the change without storing either password', async () => {
      await changeAs(await signIn('rahim@twintrack.test'), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      const entries = await AuditLog.find({ action: 'auth.password_changed' }).lean();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actorId).toBe('rahim');
      expect(JSON.stringify(entries)).not.toContain(NEW_PASSWORD);
      expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    });

    it('blocks repeated guesses at the current password', async () => {
      const limitedApp = createApp(createTestConfig({ LOGIN_MAX_FAILED_ATTEMPTS: '2' }));
      const token = await signIn('rahim@twintrack.test');
      const guess = () => changeAs(token, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, limitedApp);
      expect((await guess()).status).toBe(403);
      expect((await guess()).status).toBe(403);
      expect((await guess()).status).toBe(429);
    });
  });

  describe('GET /me/modules', () => {
    const moduleKeys = (body: { modules: { key: string }[] }) => body.modules.map((module) => module.key);

    it('lists only the modules this person can open, with where to find them', async () => {
      const response = await getAs(await signIn('rahim@twintrack.test'), '/me/modules');
      expect(response.status).toBe(200);
      expect(response.body.modules).toEqual([
        { key: 'hr', name: 'HR', description: expect.any(String) as string, frontendUrl: HR_ORIGIN, roleName: 'Manager' },
      ]);
    });

    it('leaves out a module that is not loaded, even with a role in it', async () => {
      expect(moduleKeys((await getAs(await signIn('rahim@twintrack.test'), '/me/modules')).body)).not.toContain('account');
    });

    it('returns an empty list for someone with no access', async () => {
      expect((await getAs(await signIn('karim@twintrack.test'), '/me/modules')).body).toEqual({ modules: [] });
    });

    it('lists every loaded module for a super admin, with no address when none is set', async () => {
      const { body } = await getAs(await signIn('farhana@twintrack.test'), '/me/modules');
      expect(moduleKeys(body)).toEqual(['employee', 'hr', 'master']);
      expect((body as { modules: { key: string; frontendUrl: string | null }[] }).modules[2]?.frontendUrl).toBeNull();
    });

    it('lists a module reached through a special privilege alone', async () => {
      await User.updateOne({ _id: 'karim' }, { $set: { 'privileges.hr': ['salary.read'] } });
      const { body } = await getAs(await signIn('karim@twintrack.test'), '/me/modules');
      expect(body.modules[0]).toMatchObject({ key: 'hr', roleName: null });
    });
  });

  describe('GET /me/permissions/:module', () => {
    it('returns what this person can do, with scopes', async () => {
      const response = await getAs(await signIn('rahim@twintrack.test'), '/me/permissions/hr');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        module: 'hr',
        hasAccess: true,
        role: 'manager',
        permissions: { 'salary.read': 'team' },
      });
      expect(response.body.permissions['salary.update']).toBeUndefined();
    });

    it('answers normally for someone with no access to the module', async () => {
      const response = await getAs(await signIn('karim@twintrack.test'), '/me/permissions/hr');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ hasAccess: false, permissions: {} });
    });

    it('answers 404 for a module that is not loaded', async () => {
      const response = await getAs(await signIn('rahim@twintrack.test'), '/me/permissions/account');
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('unknown_module');
    });

    it('shows a role removed in Master on the next call, with the same token', async () => {
      const token = await signIn('rahim@twintrack.test');
      expect((await getAs(token, '/me/permissions/hr')).body.hasAccess).toBe(true);

      await User.updateOne({ _id: 'rahim' }, { $unset: { 'assignments.hr': 1 } });
      expect((await getAs(token, '/me/permissions/hr')).body.hasAccess).toBe(false);
    });
  });
});
