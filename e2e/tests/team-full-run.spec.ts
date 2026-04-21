import { testWithProduct, expect } from '../fixtures/auth';
import { seedTeam, getTestDb } from '../fixtures/db';
import {
  teamMessages,
  teamTasks,
  strategicPaths,
  planItems,
} from '../../src/lib/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * Full onboarding-to-team-run E2E. Exercises the REAL
 * coordinator → growth-strategist → content-planner pipeline
 * end-to-end: POST /api/team/run with trigger='onboarding', wait for the
 * BullMQ worker to drive a multi-turn Anthropic session, and assert the
 * durable side-effects (team_messages, team_tasks, strategic_paths,
 * plan_items) that the coordinator is contracted to produce.
 *
 * Gated behind RUN_FULL_E2E=1 for the same reason the Phase C
 * equivalence eval is gated behind RUN_EQUIVALENCE_EVAL=1: each run
 * issues real Anthropic calls (~$0.50) and runs 5–10 min wall. Do not
 * enable on every PR — wire this into a nightly cron or the
 * release-candidate job instead. See e2e/README.md for invocation.
 *
 * Prerequisites when RUN_FULL_E2E=1:
 *   - ANTHROPIC_API_KEY   (validated at worker startup via src/lib/env.ts)
 *   - DATABASE_URL         (shared with dev server via .env.local)
 *   - REDIS_URL            (BullMQ connection — the `bun run dev`
 *                           concurrently stack starts the worker process)
 *
 * Failure modes that are NOT bugs in tested code: Anthropic rate limits,
 * 529 overloads, transient network blips. Re-run once before
 * investigating.
 */
const RUN_FULL = process.env.RUN_FULL_E2E === '1';

if (RUN_FULL && !process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'RUN_FULL_E2E=1 but ANTHROPIC_API_KEY is unset. This spec drives a ' +
      'real team_run (~$0.50 / run) and cannot proceed without credentials. ' +
      'Either set ANTHROPIC_API_KEY or unset RUN_FULL_E2E.',
  );
}

const describeMaybe = RUN_FULL
  ? testWithProduct.describe
  : testWithProduct.describe.skip;

describeMaybe(
  'Full onboarding team_run — real Anthropic pipeline (gate: RUN_FULL_E2E=1)',
  () => {
    testWithProduct('coordinator drives delegation + writes strategic path + plan items; accepts mid-run injection', async ({
      authenticatedPageWithProduct: page,
      testUser,
    }) => {
      // 10 min wall cap — matches spec §15.3 alert threshold and the
      // worker's lockDuration ceiling (src/workers/index.ts:223).
      testWithProduct.setTimeout(10 * 60 * 1000);

      const db = getTestDb();
      const { teamId, coordinatorId } = await seedTeam(testUser.id);

      // --- Trigger onboarding run ---
      // Hand off to the same endpoint the onboarding flow will call in
      // production — the route derives a goal template from the product
      // row (see src/app/api/team/run/route.ts::deriveGoalFromTrigger).
      const runResponse = await page.request.post('/api/team/run', {
        data: {
          teamId,
          trigger: 'onboarding',
          goal:
            'Plan the launch strategy for ShipFlare. Produce a strategic narrative, content pillars, channel mix, and a week of scheduled plan_items.',
        },
      });
      expect([200, 202]).toContain(runResponse.status());
      const runBody = (await runResponse.json()) as {
        runId: string;
        alreadyRunning: boolean;
      };
      const runId = runBody.runId;
      expect(runId).toBeTruthy();

      // --- /team grid renders 3 member cards (unchanged Phase D contract) ---
      await page.goto('/team');
      await expect(
        page.getByTestId('member-card-coordinator'),
      ).toBeVisible();
      await expect(
        page.getByTestId('member-card-growth-strategist'),
      ).toBeVisible();
      await expect(
        page.getByTestId('member-card-content-planner'),
      ).toBeVisible();

      // --- Wait for the coordinator to start producing activity ---
      // Polls team_messages directly because the SSE activity log has
      // its own rendering latency; the durable write is the contract we
      // care about here. Ceiling: 9.5 min to leave headroom before the
      // 10 min testTimeout.
      const firstMessageDeadline = Date.now() + 9.5 * 60 * 1000;
      let observedMessageCount = 0;
      while (Date.now() < firstMessageDeadline) {
        const rows = await db
          .select({ id: teamMessages.id })
          .from(teamMessages)
          .where(eq(teamMessages.runId, runId));
        observedMessageCount = rows.length;
        if (observedMessageCount > 0) break;
        await page.waitForTimeout(2_000);
      }
      expect(observedMessageCount).toBeGreaterThan(0);

      // --- Navigate to coordinator detail + assert log is alive ---
      await page.goto(`/team/${coordinatorId}`);
      await expect(page.getByTestId('activity-log-list')).toBeVisible();

      // --- Send a mid-run injection and assert durable write ---
      // Covers the Phase D Day 3 live-injection contract (spec §4.4).
      // We don't assert the coordinator USES the message — that's a
      // prompt-behaviour assertion and flaky against real LLMs. We only
      // assert the HTTP contract: 200/202 + team_messages row written.
      const injectMessage =
        'Just make a note: this is an injected test message from team-full-run E2E.';
      const msgResponse = await page.request.post('/api/team/message', {
        data: {
          teamId,
          memberId: coordinatorId,
          message: injectMessage,
        },
      });
      expect([200, 202]).toContain(msgResponse.status());
      const injectedRows = await db
        .select()
        .from(teamMessages)
        .where(
          and(
            eq(teamMessages.teamId, teamId),
            eq(teamMessages.type, 'user_prompt'),
          ),
        );
      expect(
        injectedRows.some((r) => r.content === injectMessage),
      ).toBe(true);

      // --- Wait for run completion ---
      // `team_runs.status` flips from 'running' → 'completed' when the
      // coordinator returns a StructuredOutput. The worker is
      // single-concurrency per team (lockDuration 15 min), so once the
      // completion flag lands we know all downstream writes settled.
      const completionDeadline = Date.now() + 9.5 * 60 * 1000;
      let finalStatus: string | null = null;
      while (Date.now() < completionDeadline) {
        const rows = await db
          .select({ status: teamMessages.type })
          .from(teamMessages)
          .where(
            and(
              eq(teamMessages.runId, runId),
              eq(teamMessages.type, 'completion'),
            ),
          )
          .limit(1);
        if (rows.length > 0) {
          finalStatus = 'completed';
          break;
        }
        await page.waitForTimeout(5_000);
      }
      expect(finalStatus).toBe('completed');

      // --- Delegation assertion: coordinator spawned ≥1 subagent Task ---
      // The coordinator's job is to delegate — growth-strategist for the
      // strategic path, content-planner for plan_items. If zero Tasks
      // spawned, the coordinator short-circuited and the downstream
      // contracts below won't hold anyway.
      const taskRows = await db
        .select({ id: teamTasks.id, memberId: teamTasks.memberId })
        .from(teamTasks)
        .where(eq(teamTasks.runId, runId));
      expect(taskRows.length).toBeGreaterThanOrEqual(1);

      // --- ≥1 tool_call message (Task delegation OR StructuredOutput) ---
      const toolCallRows = await db
        .select({ id: teamMessages.id })
        .from(teamMessages)
        .where(
          and(
            eq(teamMessages.runId, runId),
            eq(teamMessages.type, 'tool_call'),
          ),
        );
      expect(toolCallRows.length).toBeGreaterThanOrEqual(1);

      // --- strategic_paths row written ---
      // growth-strategist's StructuredOutput flows through into the
      // processor's post-run commit (see src/workers/processors/team-run.ts).
      const pathRows = await db
        .select({ id: strategicPaths.id })
        .from(strategicPaths)
        .where(eq(strategicPaths.userId, testUser.id));
      expect(pathRows.length).toBeGreaterThanOrEqual(1);

      // --- ≥5 plan_items rows written ---
      // content-planner's contract: one week of scheduled plan items.
      // Threshold 5 picked conservatively — spec §4.2 onboarding
      // template aims for ~14, but LLM variance can undershoot. A
      // true regression (zero items, schema error) produces 0, well
      // below 5.
      const itemRows = await db
        .select({ id: planItems.id })
        .from(planItems)
        .where(eq(planItems.userId, testUser.id));
      expect(itemRows.length).toBeGreaterThanOrEqual(5);
    });
  },
);
