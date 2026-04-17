import { config } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// Load .env.local so both the Playwright fixtures and the dev server
// share the same DATABASE_URL, AUTH_SECRET, etc.
config({ path: '.env.local' });

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'perf',
      testMatch: /.*\.perf\.ts/,
      retries: 0,
      timeout: 180_000,
      use: { baseURL: process.env.BASE_URL ?? 'http://localhost:3000' },
    },
  ],

  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
