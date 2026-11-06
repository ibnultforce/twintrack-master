import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRequestLogger } from '../src/lib/requestLogger.js';

describe('request logging', () => {
  it('never writes tokens or cookies to the log', async () => {
    const logLines: string[] = [];
    const app = express();
    app.use(createRequestLogger('info', { write: (line: string) => logLines.push(line) }));
    app.get('/', (_req, res) => {
      res.cookie('session', 'secret-set-cookie-value').json({});
    });

    await request(app).get('/').set('Authorization', 'Bearer secret-access-token').set('Cookie', 'session=secret-cookie-value');

    const log = logLines.join('\n');
    expect(log).toContain('[Redacted]');
    expect(log).not.toContain('secret-access-token');
    expect(log).not.toContain('secret-cookie-value');
    expect(log).not.toContain('secret-set-cookie-value');
  });
});
