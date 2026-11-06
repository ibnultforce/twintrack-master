import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
  ALLOWED_ORIGINS: 'http://twintrack.localhost:3100, http://hr.twintrack.localhost:3101',
  LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-for-validation',
};

describe('environment validation', () => {
  it('reads valid settings and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(4100);
    expect(config.allowedOrigins).toEqual(['http://twintrack.localhost:3100', 'http://hr.twintrack.localhost:3101']);
  });

  it('names every missing or invalid setting', () => {
    expect(() => loadConfig({ PORT: 'abc', ALLOWED_ORIGINS: 'not-a-url' })).toThrow(ConfigError);
    try {
      loadConfig({ PORT: 'abc', ALLOWED_ORIGINS: 'not-a-url' });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('PORT');
      expect(message).toContain('MONGODB_URI');
      expect(message).toContain('ALLOWED_ORIGINS');
      expect(message).toContain('JWT_ACCESS_SECRET');
    }
  });

  it('applies the agreed session and token defaults', () => {
    expect(loadConfig(validEnv).auth).toMatchObject({
      accessTokenTtlSeconds: 900,
      sessionIdleDays: 7,
      sessionMaxDays: 30,
      isRefreshCookieSecure: false,
    });
  });

  it('refuses a short token secret', () => {
    expect(() => loadConfig({ ...validEnv, JWT_ACCESS_SECRET: 'too-short' })).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('secures the refresh cookie in production and refuses to turn that off', () => {
    expect(loadConfig({ ...validEnv, NODE_ENV: 'production' }).auth.isRefreshCookieSecure).toBe(true);
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production', REFRESH_COOKIE_SECURE: 'false' })).toThrow(
      /REFRESH_COOKIE_SECURE/,
    );
  });

  it('reads module frontend addresses', () => {
    const config = loadConfig({
      ...validEnv,
      MODULE_FRONTEND_URLS: 'master=http://twintrack.localhost:3100, hr=http://hr.twintrack.localhost:3101',
    });
    expect(config.moduleFrontendUrls.get('hr')).toBe('http://hr.twintrack.localhost:3101');
    expect(loadConfig(validEnv).moduleFrontendUrls.size).toBe(0);
  });

  it.each([
    ['a non-web address', 'hr=javascript:alert(1)'],
    ['an address with a path', 'hr=http://hr.twintrack.localhost:3101/app'],
    ['a missing address', 'hr'],
    ['an invalid module key', 'HR=http://hr.twintrack.localhost:3101'],
    ['a repeated module', 'hr=http://hr.twintrack.localhost:3101,hr=http://twintrack.localhost:3100'],
    ['an address not in ALLOWED_ORIGINS', 'hr=https://hr.twintrack.com'],
  ])('refuses %s in MODULE_FRONTEND_URLS', (_label, value) => {
    expect(() => loadConfig({ ...validEnv, MODULE_FRONTEND_URLS: value })).toThrow(/MODULE_FRONTEND_URLS/);
  });
});

describe('app foundation', () => {
  const app = createApp(loadConfig(validEnv));

  it('reports unavailable from /health while the database is disconnected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable', database: 'disconnected' });
  });

  it('allows listed origins and gives no CORS approval to others', async () => {
    const allowed = await request(app).get('/health').set('Origin', 'http://twintrack.localhost:3100');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://twintrack.localhost:3100');
    const other = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON errors for unknown routes and unreadable bodies', async () => {
    const missing = await request(app).get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('no_route');
    const broken = await request(app).post('/nope').set('Content-Type', 'application/json').send('{broken');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('bad_request');
  });
});
