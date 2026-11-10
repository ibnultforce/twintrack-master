import { hash } from '@node-rs/argon2';
import type { Application } from 'express';
import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { hashRefreshToken } from '../src/modules/master/auth/tokens.js';
import { AuditLog } from '../src/modules/master/models/auditLog.js';
import { Session } from '../src/modules/master/models/session.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { createTestConfig, TEST_ENV, TEST_ORIGIN } from './helpers/testConfig.js';

const EMAIL = 'rahim@twintrack.test';
const PASSWORD = 'correct-password';
const MILLISECONDS_PER_DAY = 86_400_000;

function setCookieHeader(response: Response): string | undefined {
  const headers = response.headers['set-cookie'] as unknown as string[] | undefined;
  return headers?.[0];
}

function refreshTokenFrom(response: Response): string {
  const match = setCookieHeader(response)?.match(/^twintrack_refresh=([^;]+)/);
  if (!match?.[1]) throw new Error('The response set no refresh cookie.');
  return match[1];
}

describe('auth routes', () => {
  useTestDatabase();

  let app: Application;
  let passwordHash: string;

  const postLogin = (body: object = { email: EMAIL, password: PASSWORD }, target: Application = app) =>
    request(target).post('/auth/login').set('Origin', TEST_ORIGIN).send(body);

  const postRefresh = (refreshToken?: string) => {
    const pending = request(app).post('/auth/refresh').set('Origin', TEST_ORIGIN);
    return refreshToken ? pending.set('Cookie', `twintrack_refresh=${refreshToken}`) : pending;
  };

  const postLogout = (refreshToken?: string) => {
    const pending = request(app).post('/auth/logout').set('Origin', TEST_ORIGIN);
    return refreshToken ? pending.set('Cookie', `twintrack_refresh=${refreshToken}`) : pending;
  };

  const expectCookieCleared = (response: Response) => {
    expect(setCookieHeader(response)).toMatch(/^twintrack_refresh=;.*Expires=Thu, 01 Jan 1970/);
  };

  /** Moves the last rotation into the past, so the grace period has run out. */
  const endGracePeriod = () => Session.updateMany({}, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });

  beforeAll(async () => {
    app = createApp(createTestConfig());
    passwordHash = await hash(PASSWORD);
  });

  beforeEach(async () => {
    await User.create({ _id: 'u_04', name: 'Rahim Uddin', email: EMAIL, passwordHash, permissionSets: { hr: ['manager'] } });
  });

  describe('POST /auth/login', () => {
    it('returns a short-lived token holding identity only', async () => {
      const response = await postLogin();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ expiresIn: 900, mustChangePassword: false });
      expect(response.headers['cache-control']).toBe('no-store');

      const { accessToken } = response.body as { accessToken: string };
      const secret = new TextEncoder().encode(TEST_ENV.JWT_ACCESS_SECRET);
      const { payload } = await jwtVerify(accessToken, secret, {
        issuer: 'https://api.twintrack.com',
        audience: 'https://api.twintrack.com',
      });
      expect(decodeProtectedHeader(accessToken).alg).toBe('HS256');
      expect(payload.sub).toBe('u_04');
      expect(payload.exp! - payload.iat!).toBe(900);
      expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    });

    it('sets an HttpOnly, same-site, host-only cookie for auth routes only', async () => {
      const cookie = setCookieHeader(await postLogin());
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/auth/);
      expect(cookie).not.toMatch(/Domain=/);
    });

    it('marks the cookie Secure when configured', async () => {
      const secureApp = createApp(createTestConfig({ REFRESH_COOKIE_SECURE: 'true' }));
      expect(setCookieHeader(await postLogin(undefined, secureApp))).toMatch(/Secure/);
    });

    it('stores only a hash of the refresh token, and ends the session after 7 days idle or 30 days total', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      const session = await Session.findOne().lean();
      expect(session?.tokenHash).toBe(hashRefreshToken(refreshToken));
      expect(JSON.stringify(session)).not.toContain(refreshToken);

      const daysLeft = (date: Date | undefined) => Math.round((date!.getTime() - Date.now()) / MILLISECONDS_PER_DAY);
      expect(daysLeft(session?.expiresAt)).toBe(7);
      expect(daysLeft(session?.absoluteExpiresAt)).toBe(30);
    });

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const wrongPassword = await postLogin({ email: EMAIL, password: 'wrong' });
      const unknownEmail = await postLogin({ email: 'nobody@twintrack.test', password: 'wrong' });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body).toEqual(unknownEmail.body);
      expect(await Session.countDocuments()).toBe(0);
    });

    it('accepts an email in any letter case', async () => {
      expect((await postLogin({ email: 'RAHIM@TwinTrack.test', password: PASSWORD })).status).toBe(200);
    });

    it('reveals a deactivated account only to someone with the right password', async () => {
      await User.updateOne({ _id: 'u_04' }, { $set: { status: 'inactive' } });
      expect((await postLogin()).status).toBe(403);
      expect((await postLogin({ email: EMAIL, password: 'wrong' })).status).toBe(401);
      expect(await Session.countDocuments()).toBe(0);
    });

    it('rejects query objects in place of strings', async () => {
      const response = await postLogin({ email: { $ne: null }, password: { $ne: null } });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('validation_failed');
    });

    it('rejects a very long password before hashing it', async () => {
      expect((await postLogin({ email: EMAIL, password: 'x'.repeat(257) })).status).toBe(422);
    });

    it('records successful and failed logins without storing the password', async () => {
      await postLogin({ email: EMAIL, password: 'wrong-password-value' });
      await postLogin();
      const entries = await AuditLog.find().sort({ at: 1 }).lean();
      expect(entries.map((entry) => entry.action)).toEqual(['auth.login_failed', 'auth.login']);
      expect(entries[0]?.actorId).toBe('u_04');
      expect(JSON.stringify(entries)).not.toContain('wrong-password-value');
    });

    it('blocks an address after too many failures, without counting successes', async () => {
      const limitedApp = createApp(createTestConfig({ LOGIN_MAX_FAILED_ATTEMPTS: '2' }));
      expect((await postLogin(undefined, limitedApp)).status).toBe(200);
      expect((await postLogin({ email: EMAIL, password: 'wrong' }, limitedApp)).status).toBe(401);
      expect((await postLogin({ email: EMAIL, password: 'wrong' }, limitedApp)).status).toBe(401);

      const blocked = await postLogin(undefined, limitedApp);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('too_many_attempts');
    });
  });

  describe('origin check', () => {
    it.each([
      ['login', '/auth/login'],
      ['refresh', '/auth/refresh'],
      ['logout', '/auth/logout'],
    ])('refuses %s from an unknown or missing origin', async (_name, path) => {
      const unknownOrigin = await request(app).post(path).set('Origin', 'https://evil.example').send({ email: EMAIL, password: PASSWORD });
      expect(unknownOrigin.status).toBe(403);
      expect(unknownOrigin.body.error.code).toBe('origin_not_allowed');
      expect((await request(app).post(path).send({ email: EMAIL, password: PASSWORD })).status).toBe(403);
      expect(await Session.countDocuments()).toBe(0);
    });

    it('does not rotate or end a session for a cross-site request', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      const cookie = `twintrack_refresh=${refreshToken}`;
      await request(app).post('/auth/refresh').set('Origin', 'https://evil.example').set('Cookie', cookie);
      await request(app).post('/auth/logout').set('Origin', 'https://evil.example').set('Cookie', cookie);

      const session = await Session.findOne().lean();
      expect(session?.tokenHash).toBe(hashRefreshToken(refreshToken));
      expect(session?.revokedAt).toBeUndefined();
    });
  });

  describe('POST /auth/refresh', () => {
    it('returns a new access token and replaces the refresh token', async () => {
      const firstToken = refreshTokenFrom(await postLogin());
      const response = await postRefresh(firstToken);
      expect(response.status).toBe(200);
      expect(decodeJwt((response.body as { accessToken: string }).accessToken).sub).toBe('u_04');

      const secondToken = refreshTokenFrom(response);
      expect(secondToken).not.toBe(firstToken);
      expect((await Session.findOne().lean())?.tokenHash).toBe(hashRefreshToken(secondToken));
    });

    it('answers 401 with no cookie and with an unknown cookie', async () => {
      const noCookie = await postRefresh();
      expect(noCookie.status).toBe(401);
      expect(noCookie.body.error.code).toBe('no_session');

      const unknownCookie = await postRefresh('not-a-real-token');
      expect(unknownCookie.status).toBe(401);
      expectCookieCleared(unknownCookie);
    });

    it('moves the idle limit forward on use, but never past the 30-day limit', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      const absoluteExpiresAt = new Date(Date.now() + 2 * MILLISECONDS_PER_DAY);
      await Session.updateOne({}, { $set: { absoluteExpiresAt } });

      await postRefresh(refreshToken);
      expect((await Session.findOne().lean())?.expiresAt.getTime()).toBe(absoluteExpiresAt.getTime());
    });

    it('lets an old token through in the grace period, without replacing the cookie', async () => {
      const firstToken = refreshTokenFrom(await postLogin());
      const secondToken = refreshTokenFrom(await postRefresh(firstToken));

      const secondTab = await postRefresh(firstToken);
      expect(secondTab.status).toBe(200);
      expect(setCookieHeader(secondTab)).toBeUndefined();

      expect((await Session.findOne().lean())?.tokenHash).toBe(hashRefreshToken(secondToken));
      expect((await postRefresh(secondToken)).status).toBe(200);
    });

    it('keeps the session when two tabs refresh at the same moment', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      const responses = await Promise.all([postRefresh(refreshToken), postRefresh(refreshToken)]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      expect(responses.filter((response) => setCookieHeader(response)).length).toBe(1);
      expect((await Session.findOne().lean())?.revokedAt).toBeUndefined();
    });

    it('ends the whole session when an old token is reused after the grace period', async () => {
      const firstToken = refreshTokenFrom(await postLogin());
      const secondToken = refreshTokenFrom(await postRefresh(firstToken));
      await endGracePeriod();

      const reused = await postRefresh(firstToken);
      expect(reused.status).toBe(401);
      expect(reused.body.error.code).toBe('session_revoked');
      expectCookieCleared(reused);

      expect((await postRefresh(secondToken)).status).toBe(401);
      const audited = await AuditLog.find({ action: 'auth.session_token_reused' }).lean();
      expect(audited).toHaveLength(1);
      expect(audited[0]?.actorId).toBe('u_04');
    });

    it('treats a token two rotations old as reuse, even inside the grace period', async () => {
      const firstToken = refreshTokenFrom(await postLogin());
      const secondToken = refreshTokenFrom(await postRefresh(firstToken));
      await postRefresh(secondToken);

      expect((await postRefresh(firstToken)).status).toBe(401);
      expect((await Session.findOne().lean())?.revokedAt).toBeDefined();
    });

    it.each([
      ['the idle limit', 'expiresAt'],
      ['the 30-day limit', 'absoluteExpiresAt'],
    ])('ends a session that has passed %s', async (_name, field) => {
      const refreshToken = refreshTokenFrom(await postLogin());
      await Session.updateOne({}, { $set: { [field]: new Date(Date.now() - 1000) } });

      const response = await postRefresh(refreshToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('session_expired');
      expectCookieCleared(response);
      expect((await Session.findOne().lean())?.revokedAt).toBeDefined();
    });

    it('ends the session of a deactivated user', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      await User.updateOne({ _id: 'u_04' }, { $set: { status: 'inactive' } });

      const response = await postRefresh(refreshToken);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('account_inactive');
      expect((await Session.findOne().lean())?.revokedAt).toBeDefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('ends the session from the cookie alone, with no access token', async () => {
      const refreshToken = refreshTokenFrom(await postLogin());
      const response = await postLogout(refreshToken);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ signedOut: true });
      expectCookieCleared(response);
      expect((await postRefresh(refreshToken)).status).toBe(401);
      expect(await AuditLog.countDocuments({ action: 'auth.logout' })).toBe(1);
    });

    it('succeeds with no cookie, and with a session that has already ended', async () => {
      expect((await postLogout()).status).toBe(200);

      const refreshToken = refreshTokenFrom(await postLogin());
      await postLogout(refreshToken);
      expect((await postLogout(refreshToken)).status).toBe(200);
      expect(await AuditLog.countDocuments({ action: 'auth.logout' })).toBe(1);
    });
  });
});
