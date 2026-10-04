import { defineConfig } from '@playwright/test';

const port = 4398;
export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Uses the locally installed Google Chrome; run `npx playwright install chromium` and remove this line to use bundled Chromium.
    channel: process.env.PW_CHANNEL ?? 'chrome',
    viewport: { width: 1600, height: 950 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LLD_STUDIO_PORT: String(port) },
  },
});
