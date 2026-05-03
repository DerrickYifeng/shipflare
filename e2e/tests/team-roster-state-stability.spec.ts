// Smoke for the react-hooks/set-state-in-effect lint fix shipped in
// the same commit as this spec. The two patched files —
// `teammate-roster.tsx` and `teammate-transcript-drawer.tsx` — moved
// "reset state on prop change" out of useEffect and into the
// state-during-render pattern (React's "Storing information from
// previous renders"). The risk-of-regression class for that change is
// React surfacing a console.error during render (e.g. infinite
// setState loop, getSnapshot stability warning). This spec mounts
// `/team` in a real browser and asserts no React-class console.error
// fires during navigation + interaction.
//
// Per the plan's downgrade clause: setting up real seed data + SSE
// fixtures for a meaningful end-to-end interaction would require
// non-trivial infra beyond the scope of this fix. We assert the
// minimum bar: the page renders, navigation away + back is stable,
// and no React error escapes to the console.

import { testWithProduct, expect } from '../fixtures/auth';
import { seedTeam } from '../fixtures/db';
import { mockEventSource } from '../helpers/sse-mock';

const REACT_ERROR_PATTERNS = [
  /Maximum update depth exceeded/i,
  /Cannot update a component .* while rendering/i,
  /Too many re-renders/i,
  /infinite loop/i,
  /Hydration failed/i,
  /Text content does not match/i,
];

// Skip the suite gracefully when DATABASE_URL isn't configured — the
// `seedTeam` fixture would throw on insert and the failure would be a
// red herring vs. the lint-fix smoke we actually want to run.
const HAS_DB = Boolean(process.env.DATABASE_URL);

testWithProduct.describe('Team roster + transcript drawer — state-stability fixes', () => {
  testWithProduct.skip(
    !HAS_DB,
    'DATABASE_URL not set — skipping team-roster e2e smoke (run from main repo with .env.local).',
  );

  testWithProduct(
    '/team renders and re-renders without React state-stability errors',
    async ({ authenticatedPageWithProduct: page, testUser }) => {
      await seedTeam(testUser.id);
      await mockEventSource(page);

      const reactErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (REACT_ERROR_PATTERNS.some((re) => re.test(text))) {
          reactErrors.push(text);
        }
      });
      page.on('pageerror', (err) => {
        reactErrors.push(err.message);
      });

      // First render — covers initial useState seed path. We don't
      // assert on a specific element because the team-page render
      // tree depends on whether the seed produced a complete team;
      // the contract we care about is "page reaches DOMContentLoaded
      // without React surfacing a state-stability error".
      const firstResp = await page.goto('/team');
      expect(firstResp?.ok()).toBe(true);
      await page.waitForLoadState('domcontentloaded');

      // Navigate away + back — covers the parent-re-fetch / re-seed
      // path (Site 1) that prop-changes drive through the new
      // state-during-render block. If `/today` is unavailable for
      // any reason, fall back to a reload of `/team`.
      const todayResp = await page.goto('/today');
      if (todayResp?.ok()) {
        await page.waitForLoadState('domcontentloaded');
      }
      const secondResp = await page.goto('/team');
      expect(secondResp?.ok()).toBe(true);
      await page.waitForLoadState('domcontentloaded');

      // Give React a tick to flush any deferred warnings.
      await page.waitForTimeout(250);

      expect(
        reactErrors,
        `React errors leaked to console: ${reactErrors.join(' | ')}`,
      ).toEqual([]);
    },
  );
});
