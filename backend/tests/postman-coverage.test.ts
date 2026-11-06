import { existsSync, readFileSync } from 'node:fs';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createTestConfig } from './helpers/testConfig.js';

interface PostmanItem {
  item?: PostmanItem[];
  request?: { method: string; url: { raw: string } };
}

function collectionRequests(items: PostmanItem[]): string[] {
  return items.flatMap((item) => {
    if (item.item) return collectionRequests(item.item);
    if (!item.request) return [];
    return [`${item.request.method} ${item.request.url.raw.replace('{{baseUrl}}', '')}`];
  });
}

interface StackLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: unknown };
}

const appStack = (app: Application) => (app as unknown as { router: { stack: StackLayer[] } }).router.stack;

function appRoutes(app: Application): string[] {
  return appStack(app).flatMap(({ route }) =>
    route ? Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${route.path}`) : [],
  );
}

/** Makes "GET /users/:id" and "GET /users/{{userId}}?page=1" compare as the same route. */
const routeShape = (route: string) => route.split('?')[0]!.replace(/:[^/]+|\{\{[^}]+\}\}/g, ':param');

function routesWithoutRequest(routes: string[], requests: string[]): string[] {
  const coveredShapes = new Set(requests.map(routeShape));
  return routes.filter((route) => !coveredShapes.has(routeShape(route)));
}

// postman/ is ignored by git, so a fresh clone doesn't have the collection.
const collectionFile = new URL('../../postman/twintrack-master.postman_collection.json', import.meta.url);

describe('Postman collection', () => {
  it.skipIf(!existsSync(collectionFile))('has a request for every API route', () => {
    const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as { item: PostmanItem[] };
    const routes = appRoutes(createApp(createTestConfig()));
    expect(routes).toContain('GET /health');
    expect(routes).toContain('POST /auth/login');
    expect(routesWithoutRequest(routes, collectionRequests(collection.item))).toEqual([]);
  });

  it('matches route parameters to Postman variables, and reports what is missing', () => {
    const routes = ['GET /users/:id', 'PATCH /users/:id/roles', 'GET /audit'];
    const requests = ['GET /users/{{userId}}', 'GET /audit?page=1'];
    expect(routesWithoutRequest(routes, requests)).toEqual(['PATCH /users/:id/roles']);
  });

  // A mounted router hides its routes from appRoutes, which would let this check pass without testing them.
  it('sees every route because none are on mounted routers', () => {
    expect(appStack(createApp(createTestConfig())).filter(({ handle }) => Array.isArray(handle?.stack))).toEqual([]);
  });
});
