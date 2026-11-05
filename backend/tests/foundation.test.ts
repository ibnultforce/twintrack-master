import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
  ALLOWED_ORIGINS: 'http://twintrack.localhost:3100, http://hr.twintrack.localhost:3101',
  LOG_LEVEL: 'silent',
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
    }
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
