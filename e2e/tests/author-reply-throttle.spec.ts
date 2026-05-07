import { testWithProduct, expect } from '../fixtures/auth';
import { getTestDb } from '../fixtures/db';
import * as schema from '../../src/lib/db/schema';
import { hasRecentReplyToAuthor } from '../../src/lib/reply-throttle';
import { getReplyAuthorCooldownDays } from '../../src/lib/platform-config';
import { makeThread, makeDraft } from '../fixtures/seed-data';

/**
 * Real-browser smoke for the author-level reply throttle.
 *
 * The throttle (src/lib/reply-throttle.ts) is the single source of truth used
 * by both `find_threads` (discovery filter) and `draft_reply` (last-mile
 * guard). When a user has a non-terminal draft (pending/approved/posted/
 * handed_off) against any thread by author A on platform P within the
 * cooldown window (7 days for X), no NEW draft should be authored against
 * another thread by author A on the same platform.
 *
 * This spec asserts the natural state-shape outcome: with one `posted` draft
 * 2 days ago against thread T_old (X, author 'alice_throttle_test') and a
 * second freshly-discovered thread T_new (X, same author) with NO draft, the
 * /today feed surfaces zero pending reply cards for that author. We also
 * pin the predicate directly so the test fails if the cooldown window
 * regresses or the BLOCKING_STATUSES set is widened/narrowed in a way that
 * breaks the contract.
 */
testWithProduct('author reply throttle hides additional threads from a recently-engaged author', async ({
  authenticatedPageWithProduct: page,
  testUser,
}) => {
  const db = getTestDb();
  const NOW = new Date();
  const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 86_400_000);

  const tOld = makeThread(testUser.id, 9001, {
    platform: 'x',
    author: 'alice_throttle_test',
    externalId: 'ext_alice_old',
    community: 'x',
    discoveredAt: TWO_DAYS_AGO,
  });
  const tNew = makeThread(testUser.id, 9002, {
    platform: 'x',
    author: 'alice_throttle_test',
    externalId: 'ext_alice_new',
    community: 'x',
    discoveredAt: NOW,
  });

  const dOld = makeDraft(testUser.id, tOld.id, 1, {
    status: 'posted',
    createdAt: TWO_DAYS_AGO,
  });

  await db.insert(schema.threads).values([tOld, tNew]);
  await db.insert(schema.drafts).values([dOld]);

  // Predicate-level pin: confirm the throttle would block a new draft
  // against author 'alice_throttle_test' on platform 'x' right now. This
  // catches regressions in the cooldown window or BLOCKING_STATUSES set
  // even if the UI shape happens to also be empty for unrelated reasons.
  const wouldThrottle = await hasRecentReplyToAuthor(db, {
    userId: testUser.id,
    platform: 'x',
    author: 'alice_throttle_test',
    withinDays: getReplyAuthorCooldownDays('x'),
  });
  expect(wouldThrottle).toBe(true);

  // UI smoke: /today only surfaces drafts.status='pending'. The posted
  // draft against tOld doesn't render as a reply card; tNew has no draft
  // (because the throttle would have blocked it during discovery / draft
  // creation). The feed should therefore show no reply card mentioning
  // 'alice_throttle_test'.
  await page.goto('/today');

  const aliceCards = page
    .locator('article')
    .filter({ hasText: 'alice_throttle_test' });

  await expect(aliceCards).toHaveCount(0);
});
