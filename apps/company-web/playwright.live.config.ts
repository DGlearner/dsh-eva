import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.COMPANY_WEB_LIVE_BASE_URL;
if (!baseURL) throw new Error('COMPANY_WEB_LIVE_BASE_URL is required');
if (!process.env.COMPANY_WEB_LIVE_TEST_PASSWORD) {
  throw new Error('COMPANY_WEB_LIVE_TEST_PASSWORD is required');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: 'live-api.spec.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});
