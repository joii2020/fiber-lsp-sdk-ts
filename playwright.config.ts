import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', headless: true },
  webServer: {
    command: 'node examples/server/index.ts --static',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  timeout: 30_000,
});
