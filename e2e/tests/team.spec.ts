import { testWithProduct, expect } from '../fixtures/auth';
import { seedTeam, seedTeamMessage, getTestDb } from '../fixtures/db';
import { mockEventSource, emitSSEEvent } from '../helpers/sse-mock';
import { teamMessages } from '../../src/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Phase D end-to-end. Verifies the `/team` page scaffold, member detail
 * view, real-time activity log (via mocked SSE), and direct-message form
 * against real API routes. We don't kick off an actual team_run — that
 * would drive a real Claude call and be too slow + non-deterministic for
 * CI. The backend-integration test in `live-injection.test.ts` covers
 * the coordinator-reads-injected-message path.
 */
testWithProduct.describe('/team — Phase D', () => {
  testWithProduct('renders the team grid with member cards', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    await seedTeam(testUser.id);
    await page.goto('/team');

    // Header renders the team name from teams.name.
    await expect(
      page.getByRole('heading', { name: 'My Marketing Team' }),
    ).toBeVisible();

    // All three base-roster members render as cards (matched via the
    // agent-type test id set in member-card.tsx).
    await expect(
      page.getByTestId('member-card-coordinator'),
    ).toBeVisible();
    await expect(
      page.getByTestId('member-card-growth-strategist'),
    ).toBeVisible();
    await expect(
      page.getByTestId('member-card-content-planner'),
    ).toBeVisible();

    // Each card links to its detail page.
    const coord = page.getByTestId('member-card-coordinator');
    await expect(coord).toHaveAttribute('href', /^\/team\//);
  });

  testWithProduct('member detail page renders the activity log from seeded messages', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    const { teamId, coordinatorId } = await seedTeam(testUser.id);
    await seedTeamMessage(teamId, {
      fromMemberId: null,
      toMemberId: coordinatorId,
      type: 'user_prompt',
      content: 'Plan my launch',
    });
    await seedTeamMessage(teamId, {
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'agent_text',
      content: 'On it — spinning up the strategy.',
    });

    await mockEventSource(page);
    await page.goto(`/team/${coordinatorId}`);

    // Breadcrumb + hero.
    await expect(page.getByRole('heading', { name: 'Sam' })).toBeVisible();

    // Activity log list is a semantic log region.
    const log = page.getByTestId('activity-log-list');
    await expect(log).toBeVisible();
    await expect(log).toHaveAttribute('role', 'log');
    await expect(log).toHaveAttribute('aria-live', 'polite');

    // Both seeded messages visible in the initial render (server-rendered).
    await expect(log.getByText('Plan my launch')).toBeVisible();
    await expect(
      log.getByText('On it — spinning up the strategy.'),
    ).toBeVisible();
  });

  testWithProduct('new messages arrive in the activity log via SSE without reload', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    const { teamId, coordinatorId } = await seedTeam(testUser.id);
    await mockEventSource(page);
    await page.goto(`/team/${coordinatorId}`);

    // The fake EventSource opens on mount; drain the connected + snapshot_end
    // envelopes the real SSE route would emit so `useTeamEvents` transitions
    // to isConnected=true.
    await emitSSEEvent(page, {
      type: 'connected',
      teamId,
      runId: null,
    } as unknown as Parameters<typeof emitSSEEvent>[1]);
    await emitSSEEvent(page, {
      type: 'snapshot_end',
    } as unknown as Parameters<typeof emitSSEEvent>[1]);

    // Live "event" envelope — shape mirrors SendMessageTool.publishToRedis.
    const liveMessageId = crypto.randomUUID();
    await emitSSEEvent(page, {
      type: 'event',
      messageId: liveMessageId,
      runId: null,
      teamId,
      from: coordinatorId,
      to: null,
      content: 'Live-streamed update from the coordinator.',
      createdAt: new Date().toISOString(),
    } as unknown as Parameters<typeof emitSSEEvent>[1]);

    const log = page.getByTestId('activity-log-list');
    await expect(
      log.getByText('Live-streamed update from the coordinator.'),
    ).toBeVisible();
  });

  testWithProduct('send-message form posts to /api/team/message and clears on success', async ({
    authenticatedPageWithProduct: page,
    testUser,
  }) => {
    const { teamId, coordinatorId } = await seedTeam(testUser.id);
    await mockEventSource(page);
    await page.goto(`/team/${coordinatorId}`);

    const input = page.getByTestId('send-message-input');
    await expect(input).toBeVisible();
    await input.fill('Re-plan this week');

    const submit = page.getByTestId('send-message-submit');
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/team/message') && res.request().method() === 'POST',
      ),
      submit.click(),
    ]);
    expect([200, 202]).toContain(response.status());

    // Input clears on success.
    await expect(input).toHaveValue('');

    // Durable write hit team_messages — the backend contract this form
    // relies on. We don't assert runId here (none was active), only that
    // the row exists for this team.
    const db = getTestDb();
    const rows = await db
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.teamId, teamId));
    expect(
      rows.some(
        (r) => r.type === 'user_prompt' && r.content === 'Re-plan this week',
      ),
    ).toBe(true);
  });

  testWithProduct('empty state links to onboarding when the user has no team yet', async ({
    authenticatedPageWithProduct: page,
  }) => {
    // No team seed — user exists with a product but never hit the
    // onboarding plan route.
    await page.goto('/team');
    await expect(page.getByText('Your team is ready.')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Start onboarding' }),
    ).toHaveAttribute('href', '/onboarding');
  });
});
