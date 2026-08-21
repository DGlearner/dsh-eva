import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'business-api-integration',
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
  },
});
