import { readFileSync } from 'node:fs';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { registerRoutes, type ApiRoute } from '../src/lib/apiRoute.js';
import { createMasterRoutes } from '../src/modules/master/master.routes.js';
import { validateManifest, type ManifestRoute } from '../src/modules/master/moduleRegistry/manifest.js';
import { createTestConfig } from './helpers/testConfig.js';

const rawManifest: unknown = JSON.parse(readFileSync(new URL('../../manifests/master.manifest.json', import.meta.url), 'utf8'));
const manifest = validateManifest(rawManifest);
if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));

const accessRules = ({ method, path, access, permission, anyPermission }: ManifestRoute | ApiRoute) => ({
  method,
  path,
  access,
  permission,
  anyPermission,
});

const byMethodAndPath = (first: { method: string; path: string }, second: { method: string; path: string }) =>
  `${first.method} ${first.path}`.localeCompare(`${second.method} ${second.path}`);

describe('Master route table', () => {
  it('matches the routes the manifest says are built, including their access rules', () => {
    const builtRoutes = manifest.value.routes.filter((route) => !route.planned);
    const tableRoutes = createMasterRoutes(createTestConfig());
    expect(tableRoutes.map(accessRules).sort(byMethodAndPath)).toEqual(builtRoutes.map(accessRules).sort(byMethodAndPath));
  });

  it('runs the access checks before the route middleware and handler', async () => {
    const calls: string[] = [];
    const recordCall = (name: string): RequestHandler => (_req, _res, next) => {
      calls.push(name);
      next();
    };
    const route: ApiRoute = {
      method: 'GET',
      path: '/ordered',
      access: 'signed',
      middleware: [recordCall('route middleware')],
      handler: (_req, res) => {
        calls.push('handler');
        res.end();
      },
    };
    const app = express();
    registerRoutes(app, [route], () => [recordCall('access check')]);

    await request(app).get('/ordered');
    expect(calls).toEqual(['access check', 'route middleware', 'handler']);
  });
});
