import { testWithProduct, expect } from '../fixtures/auth';
import { seedTodoItem } from '../fixtures/db';
import { mockEventSource, emitSSESequence } from '../helpers/sse-mock';

/**
 * Happy-path E2E for the Today → "Scan for replies" surface.
 *
 * Mocks the `/api/discovery/scan` POST so the test doesn't need live BullMQ
 * fan-out, then emits simulated per-source SSE events on the `agents`
 * channel (which is where `useProgressiveStream('discovery')` subscribes).
 *
 * Assertions target the `data-source-id` / `data-state` attributes on
 * `SourceChip` — these are the DOM contract the `generate-week-decoupling`
 * spec also relies on, so they're pinned to the component's render output
 * and not to localized text.
 */
testWithProduct('scan-for-replies happy path', async ({
  authenticatedPageWithProduct: page,
  testUser,
}) => {
  // Seed an expired todo so the server-side first-run check returns false;
  // the Today page then renders the EmptyState + scan surface instead of the
  // FirstRun "getting ready" screen.
  await seedTodoItem(testUser.id);

  await mockEventSource(page);

  // Stub the scan POST so the button click returns a deterministic scanRunId
  // plus the two sources we're about to simulate progress for.
  await page.route('**/api/discovery/scan', async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fallback();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scanRunId: 'scan-e2e-happy',
        sources: ['r/SaaS', 'r/indiehackers'],
        status: 'fanned-out',
      }),
    });
  });

  // Resume-check (fires on mount) — silence it so it doesn't mask our
  // deterministic scan state.
  await page.route('**/api/discovery/scan-status**', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sources: [] }),
    }),
  );

  await page.goto('/today');
  await page.getByRole('button', { name: /scan for replies/i }).click();

  // Simulate per-source progression on the agents channel.
  await emitSSESequence(page, [
    {
      channel: 'agents',
      event: {
        type: 'pipeline',
        pipeline: 'discovery',
        itemId: 'reddit:r/SaaS',
        state: 'searching',
      },
    },
    {
      channel: 'agents',
      event: {
        type: 'pipeline',
        pipeline: 'discovery',
        itemId: 'reddit:r/indiehackers',
        state: 'searching',
      },
    },
    {
      channel: 'agents',
      event: {
        type: 'pipeline',
        pipeline: 'discovery',
        itemId: 'reddit:r/SaaS',
        state: 'searched',
        data: { found: 5, aboveGate: 2 },
      },
    },
    {
      channel: 'agents',
      event: {
        type: 'pipeline',
        pipeline: 'discovery',
        itemId: 'reddit:r/indiehackers',
        state: 'searched',
        data: { found: 3, aboveGate: 1 },
      },
    },
  ]);

  await expect(
    page.locator('[data-source-id="reddit:r/SaaS"][data-state="searched"]'),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-source-id="reddit:r/indiehackers"][data-state="searched"]',
    ),
  ).toBeVisible();
});
