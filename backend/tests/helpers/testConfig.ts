import type { Config } from '../../src/config.js';
import { loadConfig } from '../../src/config.js';

export const TEST_ORIGIN = 'http://twintrack.localhost:3100';

export const TEST_ENV = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/test',
  ALLOWED_ORIGINS: TEST_ORIGIN,
  LOG_LEVEL: 'silent',
  JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-for-validation',
};

export const createTestConfig = (overrides: Record<string, string> = {}): Config =>
  loadConfig({ ...TEST_ENV, ...overrides });
