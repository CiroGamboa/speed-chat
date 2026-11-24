import { defineConfig, devices } from '@playwright/test';

// Port is overridable (TEST_PORT) so a stale server left behind by an interrupted run can be
// stepped around instead of poisoning every spec with ERR_CONNECTION_REFUSED.
const PORT = Number(process.env.TEST_PORT || 8080);

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
    baseURL: process.env.BASE_URL || `http://localhost:${PORT}`,
    // The planned test additions roughly triple the count; a trace per passing test is a lot of
    // disk for nothing. Failures still get a full trace.
    trace: 'retain-on-failure',
    video: 'off',
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Match real Chrome on the venue PC: media stays blocked until the page is actually
      // clicked. Headless Chromium otherwise permits autoplay, which would hide the exact
      // failure these tests exist to catch (alarm shows on screen, never makes a sound).
      launchOptions: { args: ['--autoplay-policy=document-user-activation-required'] },
    },
  }],
  webServer: {
    command: 'node tests/static-server.mjs',
    env: { ...process.env, PORT: String(PORT) },
    port: PORT,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
