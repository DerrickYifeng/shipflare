import { testWithProduct, expect } from '../fixtures/auth';

/**
 * Regression guard for the plan-and-reply journey redesign: clicking
 * "Generate Week" must NOT enqueue any reply-discovery work (`search-source`
 * or `discovery-scan`). The calendar planner was historically doing both,
 * blending two user journeys into one slow blob; Phase 11 of the plan split
 * them, and this test locks that split in.
 *
 * Strategy:
 *  - Trigger the planner via the UI button.
 *  - Poll `/api/debug/queue-counts` (dev-only route) for up to 30s, giving
 *    BullMQ plenty of time to accept any enqueue the planner might slip in.
 *  - Assert the scan queues stayed at 0 for every poll.
 *  - Assert no SourceChips rendered (the Today-surface artifact that would
 *    only appear if a scan had fanned out).
 */
testWithProduct.describe('Generate Week decoupling', () => {
  testWithProduct.setTimeout(60_000);

  testWithProduct('Generate Week does not trigger a reply scan', async ({
    authenticatedPageWithProduct: page,
    request,
  }) => {
    await page.goto('/calendar');

    await page.getByRole('button', { name: /generate week/i }).click();

    // Poll queue counts for up to 30s; if scan jobs appear at any point,
    // break + fail fast so the test surfaces which queue regressed.
    let scanTotal = 0;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const res = await request.get('/api/debug/queue-counts');
      if (res.ok()) {
        const body = (await res.json()) as {
          searchSource?: { total?: number };
          discoveryScan?: { total?: number };
        };
        scanTotal =
          (body.searchSource?.total ?? 0) + (body.discoveryScan?.total ?? 0);
        if (scanTotal > 0) break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(scanTotal).toBe(0);
    await expect(page.locator('[data-source-id]')).toHaveCount(0);
  });
});
