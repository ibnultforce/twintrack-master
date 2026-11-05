import { existsSync, readFileSync } from 'node:fs';
import type { Application } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

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

function appRoutes(app: Application): string[] {
  const stack = (app as unknown as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } })
    .router.stack;
  return stack.flatMap(({ route }) =>
    route ? Object.keys(route.methods).map((method) => `${method.toUpperCase()} ${route.path}`) : [],
  );
}

// postman/ is ignored by git, so a fresh clone doesn't have the collection.
const collectionFile = new URL('../../postman/twintrack-master.postman_collection.json', import.meta.url);

describe('Postman collection', () => {
  it.skipIf(!existsSync(collectionFile))('has a request for every API route', () => {
    const collection = JSON.parse(readFileSync(collectionFile, 'utf8')) as { item: PostmanItem[] };
    const app = createApp(
      loadConfig({ MONGODB_URI: 'mongodb://127.0.0.1/test', ALLOWED_ORIGINS: 'http://a.test', LOG_LEVEL: 'silent' }),
    );

    const routes = appRoutes(app);
    expect(routes).toContain('GET /health');
    expect(routes.filter((route) => !collectionRequests(collection.item).includes(route))).toEqual([]);
  });
});
