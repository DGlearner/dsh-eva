import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    hookTimeout: 900_000,
    testTimeout: 900_000,
    teardownTimeout: 120_000,
  },
});
