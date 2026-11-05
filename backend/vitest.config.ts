import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-mongo.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
