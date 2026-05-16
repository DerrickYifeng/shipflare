/**
 * Task 17 — agent activity feed live smoke.
 *
 * Three scenarios from plan 2026-05-15-agent-activity-feed.md
 * (lines 2772-2820) covering the activity surface end-to-end:
 *
 *   1. Onboarding plan-build shows real strategist activity.
 *   2. /team chat shows an activity trail under each CMO bubble
 *      (ticker → Activity (N) toggle → rows).
 *   3. Mid-turn reload restores live broadcasts. (See "Seed-replay
 *      gap" note below — this test asserts the live-only behavior.)
 *
 * Run:
 *   pnpm test:e2e:live -- e2e/tests/activity-feed.live-smoke.ts
 *
 * Cost: ~$0.10-0.40 LLM (one onboarding planner + two /team turns).
 *
 * Seed-replay gap (Task 11):
 *   The replay hook calls `agent.stub.getRecentActivity(...)` but
 *   that RPC isn't implemented in production yet, so seed-replay
 *   no-ops on reload. After reload, the local `events` array starts
 *   empty; only NEW broadcasts from CMO populate it. Test 3
 *   therefore asserts "an Activity row arrives within 30s of reload"
 *   (proving live broadcasts work) rather than the
 *   "no-duplicate-data-event-id" stronger contract from the plan.
 *   When the RPC lands, tighten this test back to dedup checks.
 */

import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const AUTH_PATH = '.auth/founder.json';

test.skip(
  !fs.existsSync(AUTH_PATH),
  `live-smoke needs ${AUTH_PATH} — capture via \`pnpm playwright codegen --save-storage=${AUTH_PATH} http://localhost:3000\` after signing in. See e2e/README.md.`,
);

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// Test 1 — Onboarding plan-build shows real strategist activity
// ---------------------------------------------------------------------------
//
// Precondition: the founder is mid-onboarding and the next click
// triggers Stage 6 (`plan-building`). There is no `?stage=` URL
// param — Stage is internal React state owned by `OnboardingFlow`
// and auto-resumes at most up to `state` (see line 219 of
// OnboardingFlow.tsx). Reaching `plan-building` in a clean session
// would require driving 5+ prior stages (source extraction → review
// → connect → state → "Generate plan"), each behind LLM calls.
//
// To keep this spec deterministic and cheap, we:
//   1. Navigate to /onboarding.
//   2. Look for a "Generate plan" / "Continue" button on the
//      currently-resumed stage. If absent (i.e. the founder is too
//      early in onboarding to reach stage 6 without driving the
//      whole flow), skip with a clear message so the spec doesn't
//      false-fail.
//   3. Click it and assert the strategist activity rows appear.
test('[smoke] onboarding plan-build shows real strategist activity', async ({
  page,
}) => {
  await page.goto('/onboarding');

  // The "Generate plan" CTA is the entry point into Stage 6
  // (StagePlanBuilding). Skip if the resumed session isn't sitting
  // on the state-step that owns this button — the test is meant to
  // verify the activity feed, not drive the whole onboarding flow.
  const generateButton = page
    .getByRole('button', { name: /generate plan|build (my )?plan|create plan/i })
    .first();
  const generateVisible = await generateButton
    .isVisible({ timeout: 10_000 })
    .catch(() => false);
  test.skip(
    !generateVisible,
    'Pre-condition: founder session must be parked on the "Generate plan" step. ' +
      'Drive onboarding up to the state-step manually, then re-run this spec, ' +
      'OR re-capture .auth/founder.json from a session sitting on that step.',
  );

  await generateButton.click();

  // Plan-build stage mounts <PlanBuildActivity> which subscribes
  // to `useCmoActivity({ runId })` and renders an <ActivityTrail>
  // with `defaultOpen` + `hideTicker` once events arrive. We assert
  // a strategist row materializes within 30s.
  //
  // Two acceptable signals:
  //   (a) at least one `data-activity-row` appears — the strict
  //       contract from Task 13's row selectors.
  //   (b) "Preparing strategist…" placeholder collapses and is
  //       replaced by row text matching strategist/planning vocabulary.
  //
  // We rely on (a) because Stage 6 mounts PlanBuildActivity with
  // `defaultOpen`, so rows render as soon as the first event lands.
  const firstRow = page.locator('[data-activity-row]').first();
  await expect(firstRow).toBeVisible({ timeout: 30_000 });

  // Sanity: each row carries a data-event-id (Task 13 contract).
  const eventId = await firstRow.getAttribute('data-event-id');
  expect(eventId, 'row must carry a data-event-id attribute').toBeTruthy();
});

// ---------------------------------------------------------------------------
// Test 2 — /team chat shows activity trail under each CMO bubble
// ---------------------------------------------------------------------------
test('[smoke] /team chat: ticker + Activity (N) trail appears under CMO bubble', async ({
  page,
}) => {
  await page.goto('/team');

  // Composer is the same selector chain used by the other team-chat
  // live-smoke specs — tolerant to placeholder copy churn.
  const composer = page
    .getByPlaceholder(/message your team|send a message|ask|type/i)
    .or(page.getByRole('textbox').first())
    .first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // A prompt that nudges the lead to dispatch a sub-agent (so
  // subagent_dispatch events fire, populating the ticker + trail).
  await composer.fill(
    "[smoke activity] What's my current strategic phase and the top plan item this week? Be concise.",
  );
  await composer.press('Enter');
  const sendButton = page.getByRole('button', { name: /send|submit/i }).first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click().catch(() => undefined);
  }

  // Ticker should appear within ~15s of submit. The ActivityTrail
  // renders "Asking <Sub-agent>…" or "<sub-agent> is thinking" while
  // a leaf subagent_dispatch has no matching finish. Tolerant regex.
  const ticker = page
    .getByText(/asking\s+\w|thinking|is planning/i)
    .first();
  await expect(ticker).toBeVisible({ timeout: 15_000 });

  // The Activity (N) toggle appears once at least one event has
  // been recorded (see activity-toggle.tsx). Wait up to 30s.
  const activityToggle = page
    .getByRole('button', { name: /activity\s*\(\d+\)/i })
    .first();
  await expect(activityToggle).toBeVisible({ timeout: 30_000 });

  // Expand and verify at least one row renders.
  await activityToggle.click();
  const firstRow = page.locator('[data-activity-row]').first();
  await expect(firstRow).toBeVisible({ timeout: 5_000 });
  const eventId = await firstRow.getAttribute('data-event-id');
  expect(eventId, 'expanded row must carry a data-event-id').toBeTruthy();
});

// ---------------------------------------------------------------------------
// Test 3 — Mid-turn reload replays activity (best-effort, live-only)
// ---------------------------------------------------------------------------
//
// The Task 11 seed-replay hook calls `agent.stub.getRecentActivity()`
// but that RPC isn't shipped yet, so reload returns an empty events
// array. The WebSocket re-subscribes and live broadcasts continue,
// so NEW activity events after reload still show up. We assert that
// behavior here. When the RPC lands (Phase 2 follow-up), tighten
// this test to check that historical events are restored AND that
// data-event-id values are unique (no duplicates from double-replay).
test('[smoke] mid-turn reload — live broadcasts continue after reload', async ({
  page,
}) => {
  await page.goto('/team');

  const composer = page
    .getByPlaceholder(/message your team|send a message|ask|type/i)
    .or(page.getByRole('textbox').first())
    .first();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // Long-running prompt — multiple sub-agent dispatches so the run
  // is still in flight when we reload.
  await composer.fill(
    "[smoke reload] Give me a detailed multi-step plan for the next 7 days: " +
      "first ask the strategic-planner for the current path, then ask the " +
      "tactical-planner for this week's items, then summarize. Take your time.",
  );
  await composer.press('Enter');
  const sendButton = page.getByRole('button', { name: /send|submit/i }).first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click().catch(() => undefined);
  }

  // Wait long enough for the lead to dispatch at least one sub-agent
  // before we yank the page out from under it.
  await page.waitForTimeout(1_500);

  // Reload mid-turn. The hook re-mounts; useCmoActivity reconnects
  // the WebSocket; the run continues server-side; live broadcasts
  // from now-onward should populate the empty events array.
  await page.reload();

  // Composer should re-render quickly (server-rendered shell).
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // KNOWN GAP (Task 11): seed-replay is a no-op because
  // `agent.stub.getRecentActivity` isn't implemented. So we don't
  // assert historical replay. Instead, we assert live broadcasts
  // continue — an Activity (N) toggle (with N >= 1) materializes
  // within 30s of reload, proving the WebSocket re-subscribed and
  // new events are flowing.
  const activityToggle = page
    .getByRole('button', { name: /activity\s*\(\d+\)/i })
    .first();
  await expect(activityToggle).toBeVisible({ timeout: 30_000 });

  // Expand and check rows render with unique data-event-id values
  // (defensive — even today, if two rows share an id, it's a bug
  // worth catching).
  await activityToggle.click();
  const rows = page.locator('[data-activity-row]');
  const rowCount = await rows.count();
  expect(rowCount, 'expanded trail should contain at least 1 row').toBeGreaterThan(0);

  const eventIds = await rows.evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-event-id')),
  );
  const nonEmpty = eventIds.filter((id): id is string => !!id);
  expect(
    nonEmpty.length,
    'every visible row should carry a data-event-id',
  ).toBe(eventIds.length);

  const unique = new Set(nonEmpty);
  expect(
    unique.size,
    `data-event-id values must be unique (got duplicates: ${nonEmpty.join(', ')})`,
  ).toBe(nonEmpty.length);
});
