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

  // Visual-regression baselines live next to the tests so they're easy to
  // eyeball in PR diffs. `actual` + `diff` PNGs land in `test-results/`
  // (already gitignored) — only the blessed baseline is tracked.
  snapshotPathTemplate:
    '{testDir}/../screenshots/{testFileName}/baseline/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      // 3% of pixels may drift. Tuned empirically: stage 3 mobile hovers
      // around 2% drift across runs even with animations disabled + a
      // stagger-settle wait, likely subpixel font rendering. A real
      // visual regression (color/layout/missing element) produces 10%+
      // diff — plenty of headroom. Lower this only after pinning the
      // render platform.
      maxDiffPixelRatio: 0.03,
      // Disable the CSS-animation settling heuristic; the six-step
      // animator pulses forever and would stall Playwright's default
      // wait. Does NOT disable CSS transitions, which still fire on
      // state changes — mount the stage fully before snapping.
      animations: 'disabled',
    },
  },

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
    // `live-smoke` runs real-browser regression specs against the
    // founder's actual authenticated session — real GitHub/X OAuth,
    // real product, real LLM. Spec files match `*.live-smoke.ts` and
    // each one begins with a `test.skip(!fs.existsSync('.auth/founder.json'), ...)`
    // so `pnpm test:e2e` (the seeded suite) doesn't break when the
    // auth file isn't present.
    //
    // One-time setup to capture `.auth/founder.json` (gitignored):
    //   1. Run the dev server: `bun run dev`
    //   2. `mkdir -p .auth`
    //   3. `pnpm playwright codegen --save-storage=.auth/founder.json http://localhost:3000`
    //   4. In the Codegen window, complete the GitHub sign-in flow,
    //      wait for /team or /today to load, then close the window.
    //   5. `.auth/founder.json` now contains the real session. DO NOT commit it.
    //
    // Run live-smoke specs with `pnpm test:e2e:live` (headed by
    // default — watch the real account get driven) or
    // `pnpm test:e2e:live:ci` (headless, for CI / unattended runs).
    {
      name: 'live-smoke',
      testMatch: /.*\.live-smoke\.ts/,
      retries: 0,
      // LLM round-trips can be slow — give each spec ample headroom.
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: '.auth/founder.json',
        baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
      },
    },
  ],

  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
