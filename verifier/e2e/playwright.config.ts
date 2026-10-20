import { defineConfig } from '@playwright/test'

/**
 * The extension's end-to-end check (verifier.spec.ts): the built app served
 * by dist-server/index.js, the built extension loaded unpacked into a
 * persistent Chromium context, and the three verdicts provoked — green on the
 * untouched build, red after one asset is tampered with on disk, grey once
 * build.json is gone. `npm run test:verifier` runs it.
 *
 * Kept apart from vitest (vite.config.ts excludes verifier/e2e/) and from the
 * egress proof (e2e/playwright.config.ts looks only at its own directory).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  // One scenario in three steps that share a server and a browser: in order, once.
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 2 * 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  outputDir: '../../test-results/verifier',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
})
