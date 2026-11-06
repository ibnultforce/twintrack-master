import type { Options } from 'express-rate-limit';
import { describe, expect, it } from 'vitest';
import { MongoRateLimitStore } from '../src/modules/master/auth/rateLimitStore.js';
import { RateLimitCounter } from '../src/modules/master/models/rateLimitCounter.js';
import { useTestDatabase } from './helpers/database.js';

const WINDOW_MILLISECONDS = 60_000;

function createStore(prefix = 'login'): MongoRateLimitStore {
  const store = new MongoRateLimitStore(prefix);
  store.init({ windowMs: WINDOW_MILLISECONDS } as Options);
  return store;
}

describe('rate limit store', () => {
  useTestDatabase();

  it('counts attempts and keeps the same window', async () => {
    const store = createStore();
    const first = await store.increment('1.2.3.4');
    const second = await store.increment('1.2.3.4');
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime).toEqual(first.resetTime);
  });

  it('shares counts between API instances', async () => {
    await createStore().increment('1.2.3.4');
    expect((await createStore().increment('1.2.3.4')).totalHits).toBe(2);
  });

  it('counts concurrent attempts exactly', async () => {
    const store = createStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.increment('1.2.3.4')));
    expect(results.map((result) => result.totalHits).sort((first, second) => first - second)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it('keeps addresses and limiters apart', async () => {
    await createStore('login').increment('1.2.3.4');
    expect((await createStore('login').increment('5.6.7.8')).totalHits).toBe(1);
    expect((await createStore('change-password').increment('1.2.3.4')).totalHits).toBe(1);
  });

  it('starts again once the window has ended', async () => {
    const store = createStore();
    await store.increment('1.2.3.4');
    await store.increment('1.2.3.4');
    await RateLimitCounter.updateOne({ _id: 'login:1.2.3.4' }, { $set: { resetAt: new Date(Date.now() - 1000) } });

    const result = await store.increment('1.2.3.4');
    expect(result.totalHits).toBe(1);
    expect(result.resetTime?.getTime()).toBeGreaterThan(Date.now());
  });

  it('takes back a count without going below zero', async () => {
    const store = createStore();
    await store.increment('1.2.3.4');
    await store.decrement('1.2.3.4');
    await store.decrement('1.2.3.4');
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
  });

  it('forgets an address on request', async () => {
    const store = createStore();
    await store.increment('1.2.3.4');
    await store.resetKey('1.2.3.4');
    expect((await store.increment('1.2.3.4')).totalHits).toBe(1);
  });
});
