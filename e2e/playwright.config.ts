import { defineConfig } from '@playwright/test'

/**
 * The end-to-end egress proof (e2e/egress.spec.ts): a real build, the real
 * vault-only server, headless Chromium with a virtual passkey, and every
 * request the tab makes recorded and judged. `npm run test:egress` runs it;
 * .github/workflows/egress.yml runs it on every push and pull request.
 *
 * Kept apart from vitest (vite.config.ts excludes e2e/): it takes a build
 * and a browser, and it is one long scenario rather than many small tests.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  // One scenario, run once: a retry would hide a flaky privacy proof rather than fix it.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  // The whole session — create, enter data on five screens, autosave, reload, unlock, browse — in one test.
  timeout: 4 * 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  outputDir: '../test-results',
  use: {
    browserName: 'chromium',
    headless: true,
    actionTimeout: 20_000, // a control that isn't there is a failure to report, not something to wait the whole test out for
    viewport: { width: 1280, height: 800 }, // the sidebar tier (≥1080): one nav, no tab bar
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
})
