/**
 * Real-browser regression smoke for the client-side trust boundary.
 *
 * Threat model: a competitor signs up to ShipFlare on a paid plan, opens
 * /team, and uses Chrome DevTools' Network tab to inspect the bodies of
 * every /api/team/* response. We assert ZERO internal architecture
 * strings (AI vendor bindings, agent type names, skill gerunds, raw
 * tool names, raw tool inputs, internal kickoff playbook vocab) appear
 * in any captured body.
 *
 * Coverage strategy — three capture surfaces:
 *
 *   1. Passive capture of every `/api/team/*` response Playwright sees
 *      while navigating /team and /team/<memberId>. Bodies for
 *      streaming SSE responses are read with a short timeout because
 *      `response.text()` would otherwise block until the stream closes.
 *
 *   2. Active probes against the four client-callable endpoints that
 *      operate on team_messages content:
 *        - GET /api/team/events?teamId=...  (SSE — read first frames)
 *        - GET /api/team/activity?memberId=...
 *        - GET /api/team/conversations?teamId=...
 *        - GET /api/team/conversations/<id>/messages
 *      Active probes guarantee we exercise the redaction path even
 *      when the UI happens not to fire that fetch on initial render.
 *
 *   3. The seed deliberately writes team_messages rows with the rawest
 *      forms of leak vocabulary — `metadata.tool_name='find_threads_via_xai'`,
 *      an Anthropic `tool_use` content block whose `name='Task'` and
 *      `input.subagent_type='social-media-manager'`, a kickoff
 *      `user_prompt` whose `content` carries the playbook prose, and
 *      a `tool_result` whose `metadata.tool_name='process_replies_batch'`.
 *      Without those seeds the assertion would pass vacuously against
 *      empty rows. With them, the test fails distinctly per regression
 *      class.
 */

import { testWithProduct, expect } from '../fixtures/auth';
import { getTestDb, seedTeam } from '../fixtures/db';
import { teamMessages, teamConversations } from '../../src/lib/db/schema';

// Banned strings the wire MUST NOT carry. Two source-of-truth groupings:
//   1. Seeded raw values (we put them in team_messages.metadata / contentBlocks
//      and assert they are stripped at the API boundary).
//   2. Vocabulary that should never leak even if a future code path forgets
//      to call redactMessageRowForClient — these are tested as a defence-in-
//      depth scan over every captured body.
const BANNED = [
  // AI vendor binding (xAI is the secret sauce — must not appear)
  'xai_find_customers',
  'find_threads_via_xai',
  'XAI_API_KEY',

  // Internal agent + skill names
  'social-media-manager',
  'judging-thread-quality',
  'drafting-post',
  'drafting-reply',
  'validating-draft',
  'allocating-plan-items',
  'generating-strategy',
  'posting-to-platform',

  // Pipeline / internal tool names that should be relabelled to
  // semantic verbs ('searching', 'batching', 'planning', etc.).
  'process_posts_batch',
  'process_replies_batch',
  'persist_queue_threads',
  'find_threads',
  'add_plan_item',
  'update_plan_item',
  'query_plan_items',
  'query_strategic_path',
  'query_product_context',

  // Kickoff playbook wording (should be replaced by metadata.publicContent)
  'discover-and-fill-slot',
  'kickoff playbook',
  'subagent_type',

  // Raw agent_type for the lead — redactor maps to 'Team Lead'.
  'coordinator',

  // The seeded raw query content the leak test plants.
  'secret query',
];

/**
 * Plant team_messages rows that EXERCISE the redactor.
 *
 * Each row carries raw internal vocabulary in a different field so the
 * test fails distinctly per regression class.
 */
async function seedLeakyMessages(
  teamId: string,
  conversationId: string,
  coordinatorId: string,
): Promise<void> {
  const db = getTestDb();
  const now = Date.now();

  await db.insert(teamMessages).values([
    // (1) Kickoff user_prompt — raw playbook prose lives in `content`.
    //     Redactor reads metadata.publicContent and substitutes it.
    {
      id: crypto.randomUUID(),
      teamId,
      conversationId,
      runId: null,
      fromMemberId: null,
      toMemberId: coordinatorId,
      type: 'user_prompt',
      messageType: 'message',
      content:
        'Run the discover-and-fill-slot kickoff playbook for this week. Spawn social-media-manager to draft posts.',
      contentBlocks: null,
      metadata: {
        publicContent: 'Find a slot to fill this week and draft content.',
        trigger: 'kickoff',
      },
      createdAt: new Date(now - 60_000),
    },

    // (2) Tool call with raw vendor-bound name + raw query input.
    {
      id: crypto.randomUUID(),
      teamId,
      conversationId,
      runId: null,
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'tool_call',
      messageType: 'message',
      content: null,
      contentBlocks: null,
      metadata: {
        tool_use_id: 'toolu_test_1',
        tool_name: 'find_threads_via_xai',
        tool_input: {
          query: 'secret query',
          subreddits: ['webdev', 'SaaS'],
        },
      },
      createdAt: new Date(now - 50_000),
    },

    // (3) Assistant tool_use block (Anthropic ContentBlockParam shape):
    //     spawning a teammate by raw subagent_type. The `description`
    //     field is intentionally founder-friendly (the redactor passes
    //     it through, truncated to 200 chars, because it's the only
    //     prose the founder UI shows). All leak vocabulary lives in
    //     the OTHER input keys (`prompt`, `agent_role`, `tools`)
    //     which `redactToolInput` is contracted to drop.
    {
      id: crypto.randomUUID(),
      teamId,
      conversationId,
      runId: null,
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'tool_call',
      messageType: 'message',
      content: null,
      contentBlocks: [
        {
          type: 'tool_use',
          id: 'toolu_test_2',
          name: 'Task',
          input: {
            subagent_type: 'social-media-manager',
            description: 'Draft posts about API design for the week',
            prompt:
              'Run drafting-post and validating-draft. Use process_posts_batch for the SaaS slot. Reference query_strategic_path. The kickoff playbook for discover-and-fill-slot applies.',
            agent_role: 'social-media-manager',
            tools: ['find_threads_via_xai', 'process_posts_batch'],
          },
        },
      ],
      metadata: {
        tool_use_id: 'toolu_test_2',
        tool_name: 'Task',
        tool_input: {
          subagent_type: 'social-media-manager',
          description: 'Draft posts about API design for the week',
          prompt:
            'Run drafting-post and validating-draft. Use process_posts_batch.',
          agent_role: 'social-media-manager',
        },
      },
      createdAt: new Date(now - 40_000),
    },

    // (4) Tool result row carrying internal pipeline tool name in metadata
    //     and raw output text in the contentBlocks tool_result. Confirms:
    //       - metadata.tool_name is rewritten via TOOL_LABEL_MAP
    //         (process_replies_batch → batching)
    //       - tool_result contentBlocks are replaced with '[redacted]'
    //         (otherwise the raw "secret query" output would surface)
    //     The top-level row.content is intentionally founder-friendly here;
    //     leaks via row.content are the upstream tool's responsibility,
    //     not the redactor's. We assert that contract elsewhere.
    {
      id: crypto.randomUUID(),
      teamId,
      conversationId,
      runId: null,
      fromMemberId: coordinatorId,
      toMemberId: null,
      type: 'tool_result',
      messageType: 'message',
      content: 'Done — 5 drafts created.',
      contentBlocks: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_test_1',
          is_error: false,
          content:
            'process_replies_batch returned threads matching secret query for find_threads_via_xai.',
        },
      ],
      metadata: {
        tool_use_id: 'toolu_test_1',
        tool_name: 'process_replies_batch',
      },
      createdAt: new Date(now - 30_000),
    },
  ]);
}

/**
 * Read at most `maxBytes` of an SSE response inside the page context.
 * `response.text()` would block until the server closes the stream;
 * SSE connections in /api/team/events stay open for up to 30 minutes,
 * so we instead fetch with a manually-aborted reader that drains for
 * `windowMs` and returns whatever frames arrived in that window.
 */
async function readSseFramesInPage(
  page: import('@playwright/test').Page,
  url: string,
  windowMs: number,
): Promise<string> {
  return await page.evaluate(
    async ({ url, windowMs }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), windowMs);
      let acc = '';
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.body) return '';
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
        }
      } catch {
        // AbortError on timeout is expected — we return whatever
        // accumulated. Network errors fall through to the same branch.
      } finally {
        clearTimeout(t);
      }
      return acc;
    },
    { url, windowMs },
  );
}

testWithProduct.describe('Competitor leakage smoke', () => {
  testWithProduct(
    'no /api/team/* response body carries internal architecture strings',
    async ({ authenticatedPageWithProduct: page, testUser }) => {
      // 90s ceiling: dev server JIT compile of /team can chew 20-30s
      // on a cold cache, then 30s for navigation + 15s for SSE drain
      // + headroom for the four active probes.
      testWithProduct.setTimeout(90_000);

      // --- Seed: team + conversation + leaky messages -------------
      const { teamId, coordinatorId } = await seedTeam(testUser.id);

      const db = getTestDb();
      const conversationId = crypto.randomUUID();
      await db.insert(teamConversations).values({
        id: conversationId,
        teamId,
        title: 'Leak smoke conversation',
      });

      await seedLeakyMessages(teamId, conversationId, coordinatorId);

      // --- Capture every /api/team/* response Playwright sees -----
      // SSE responses block on .text() until the stream closes — race
      // against a short timeout so we capture at least the first frames
      // without hanging the whole test.
      const networkBodies: string[] = [];
      page.on('response', async (res) => {
        const url = res.url();
        if (!url.includes('/api/team/')) return;
        const isSse =
          (res.headers()['content-type'] ?? '').includes('text/event-stream');
        try {
          if (isSse) {
            // Skip — passively reading SSE responses with res.text()
            // hangs until stream close. We'll read SSE separately via
            // an active page-context fetch with a windowed reader.
            return;
          }
          const body = await res.text();
          networkBodies.push(`URL: ${url}\nBODY: ${body}`);
        } catch {
          /* response no longer available — skip */
        }
      });

      // --- Navigate the founder UI's typical path ------------------
      // Triggers any client-side fetches the team-desk + member detail
      // pages issue on mount. Ignore navigation errors — the goal here
      // is to exercise whatever the UI naturally hits, not to assert on
      // page state.
      await page.goto('/team').catch(() => undefined);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.goto(`/team/${coordinatorId}`).catch(() => undefined);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);

      // Give the client a beat to fire any deferred fetches (sticky
      // composer, conversation auto-create, etc.).
      await page.waitForTimeout(2_000);

      // --- Active probes against every redactor-bearing endpoint --
      // The UI may not naturally fetch all of these on a fresh seed
      // (e.g. /api/team/conversations/<id>/messages only fires when
      // a conversation is focused). Probe them explicitly so the
      // redaction path is exercised regardless of UI state.
      const probes = [
        `/api/team/activity?memberId=${encodeURIComponent(coordinatorId)}`,
        `/api/team/conversations?teamId=${encodeURIComponent(teamId)}`,
        `/api/team/conversations/${encodeURIComponent(conversationId)}/messages`,
      ];
      for (const path of probes) {
        const res = await page.request.get(path);
        const body = await res.text();
        networkBodies.push(`URL: ${path}\nBODY: ${body}`);
      }

      // SSE drain — read the snapshot frames the events route emits
      // at connection start. 8s window is generous for the four
      // seeded rows; the snapshot send is synchronous post-Redis
      // subscribe, so the bytes land in the first round-trip.
      const sseFrames = await readSseFramesInPage(
        page,
        `/api/team/events?teamId=${encodeURIComponent(teamId)}`,
        8_000,
      );
      networkBodies.push(
        `URL: /api/team/events?teamId=${teamId}\nBODY: ${sseFrames}`,
      );

      // --- Assert -------------------------------------------------
      const dump = networkBodies.join('\n---\n');

      expect(
        networkBodies.length,
        'no /api/team/* responses were captured — fixture is broken, not the redactor',
      ).toBeGreaterThan(0);

      // Per-body scan so each leak is attributed to its source URL.
      // Failing fast on the first match would hide subsequent leaks;
      // triaging all of them at once is cheaper than re-running per-leak.
      const leaks: Array<{ banned: string; url: string; excerpt: string }> = [];
      for (const entry of networkBodies) {
        const urlMatch = entry.match(/^URL: ([^\n]+)/);
        const url = urlMatch ? urlMatch[1] : '<unknown url>';
        for (const banned of BANNED) {
          const idx = entry.indexOf(banned);
          if (idx < 0) continue;
          const start = Math.max(0, idx - 150);
          const end = Math.min(entry.length, idx + banned.length + 150);
          leaks.push({ banned, url, excerpt: entry.slice(start, end) });
        }
      }

      if (leaks.length > 0) {
        for (const l of leaks) {
          // eslint-disable-next-line no-console
          console.error(
            `LEAK DETECTED\n  banned: ${l.banned}\n  url:    ${l.url}\n  excerpt: ...${l.excerpt}...\n`,
          );
        }
      }
      expect(
        leaks.map((l) => `${l.banned} @ ${l.url}`),
        `${leaks.length} banned strings leaked into /api/team/* response bodies`,
      ).toEqual([]);

      // --- Positive assertion: the redactor IS doing work ---------
      // Without this, a regression that turned redactMessageRowForClient
      // into a no-op AND coincidentally also dropped all four seeded
      // rows would still pass. We confirm at least one redacted label
      // surfaced — proves the bodies we scanned came from the redactor
      // path, not an empty bypass. 'searching' covers find_threads_via_xai
      // → searching; 'delegating' covers Task → delegating; 'batching'
      // covers process_replies_batch → batching.
      expect(
        dump.includes('searching') ||
          dump.includes('Team Lead') ||
          dump.includes('delegating') ||
          dump.includes('batching'),
        'no redacted label surfaced — bodies may not be exercising the redactor',
      ).toBe(true);
    },
  );
});
