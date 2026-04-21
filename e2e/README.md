# E2E tests

Playwright specs for ShipFlare — run against the dev server (auto-started
by `playwright.config.ts`'s `webServer`). Specs live in `e2e/tests/`;
fixtures in `e2e/fixtures/`; shared helpers in `e2e/helpers/`.

## Running

```bash
bun run test:e2e              # full suite, headless
bun run test:e2e:headed       # open a browser so you can watch
bun run test:e2e:ui           # Playwright's UI runner
```

## Visual regression

The onboarding spec (`e2e/tests/onboarding.spec.ts`) captures reference
screenshots of each stage on desktop (1440×900) and mobile (375×812).
Playwright's `toHaveScreenshot()` diffs each run against the blessed
baseline and fails if more than **3%** of pixels drift.

### Layout

```
e2e/screenshots/
└── onboarding.spec.ts/
    └── baseline/          # committed — the blessed reference
        ├── stage1-source-desktop.png
        ├── stage3-review-desktop.png
        └── …

test-results/               # gitignored
└── onboarding-<test>-chromium/
    ├── stage1-source-desktop-actual.png    # what this run rendered
    ├── stage1-source-desktop-expected.png  # baseline copy
    └── stage1-source-desktop-diff.png      # highlighted diff
```

The baseline path is pinned by `snapshotPathTemplate` in
`playwright.config.ts`, so it does NOT include a platform suffix —
baselines are shared across local macOS and CI Linux. The 3% pixel
tolerance absorbs subpixel font-rendering jitter between those.

### Running only the visual regression

```bash
bun run test:e2e:visual       # run, fail on drift
bun run test:e2e:visual:update # blessed update — re-renders all baselines
```

### Workflow: blessing a visual change

1. Ship the UI change on a branch.
2. Run `bun run test:e2e:visual` — expect failures on affected stages.
3. Open `test-results/…/stage-*-diff.png` and confirm the diff is
   intentional.
4. Run `bun run test:e2e:visual:update` to re-write the baselines.
5. `git add e2e/screenshots/onboarding.spec.ts/baseline/` and commit
   alongside the UI change.
6. Reviewers see both the code diff AND the new baseline PNGs in the PR.

Do **not** run `:update` speculatively — baselines should only move
when a human has confirmed the diff is the intended visual.

### Tuning the threshold

`maxDiffPixelRatio: 0.03` lives in `playwright.config.ts` under
`expect.toHaveScreenshot`. Lower it once you have a platform-pinned
runner (e.g. Docker + CI Linux) that eliminates font jitter. Higher
values hide real regressions — don't bump this without evidence.

## Adding a new visual-regression shot

```ts
await expect(page).toHaveScreenshot('my-new-stage.png');
```

The first test run generates `baseline/my-new-stage.png` automatically
(when `--update-snapshots` is passed). Commit the PNG, then subsequent
runs diff against it.

## Writing normal E2E tests

- Authenticate via the `authenticatedPage` fixture
  (`e2e/fixtures/auth.ts`) — it seeds a user + session cookie.
- Mock API boundaries in `e2e/helpers/intercepts.ts`. The onboarding
  flow has helpers for `/api/onboarding/{extract,plan,commit,…}`.
- Prefer `page.getByRole(...)` over CSS selectors.
- Assert on `level: 2` for stage headings — the ProgressRail renders
  an `<h1>` with the same text, so unqualified `getByRole('heading')`
  is ambiguous.

## Real-API full run: `team-full-run.spec.ts`

Gated E2E that drives a real onboarding → team_run →
coordinator-response pipeline against Anthropic's API. Skipped by
default — opt in with `RUN_FULL_E2E=1`.

```bash
RUN_FULL_E2E=1 \
ANTHROPIC_API_KEY=sk-ant-... \
  pnpm test:e2e e2e/tests/team-full-run.spec.ts
```

Requires the dev server (`bun run dev`) to be running so the BullMQ
worker process can pick up the team-run job. Playwright's `webServer`
config reuses an existing server when present.

### Cost and wall time

- **Cost**: ~$0.50 per run (one coordinator main loop + two subagent
  delegations through Claude Sonnet).
- **Wall time**: 5–10 minutes. Per-test timeout is pinned at 10 min.

### CI strategy

Run this spec on a **nightly cron** or the **release-candidate**
pipeline — not on every PR. Matches the Phase C equivalence eval
(`RUN_EQUIVALENCE_EVAL=1`, ~$2/run) gating pattern so the heavy
credit-burning tests share one opt-in discipline.

### Expected flakes (not bugs)

Failures caused by these modes are external and should NOT trigger a
code investigation — re-run once before looking at the diff:

- Anthropic 429 rate limits during high-load windows
- Anthropic 529 overloaded responses
- Transient network blips between the dev server and
  `api.anthropic.com`

If the failure reproduces twice OR the assertion that failed is about
a schema / DB shape (e.g. `strategic_paths.length < 1`,
`plan_items.length < 5`), treat it as a real regression in the
coordinator or subagent contracts.
