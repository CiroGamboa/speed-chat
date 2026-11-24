import { defineConfig, devices } from '@playwright/test';

// All scenarios share one DB namespace (see tests/global-setup.ts), so tests MUST run serially.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000, // soak/chaos scenarios need headroom
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8080',
    // Stage 1 roughly triples the test count; a trace per passing test is a lot of disk for
    // nothing. Failures still get a full trace.
    trace: 'retain-on-failure',
    video: 'off',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/static-server.mjs',
    port: 8080,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
