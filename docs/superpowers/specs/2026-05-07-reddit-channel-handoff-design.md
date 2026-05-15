# Reddit channel via full-handoff (no OAuth)

**Date:** 2026-05-07
**Author:** Yifeng (PM/eng)
**Status:** DRAFT
**Branch:** dev

## Problem

Reddit is the second highest-signal channel for ShipFlare's ICP — solo founders publicly venting distribution pain in r/SaaS, r/indiehackers, r/microsaas, r/Entrepreneur. The infrastructure is ~90% built (`RedditClient`, `reddit_search`, `reddit_post`, OAuth callback route, posting pipeline branches, circuit breaker, subreddit rate limiter) but the platform has shipped MVP with `PLATFORMS.reddit.enabled = false` and `REDDIT_DRAFT_ENABLED = false` because the original product design assumed OAuth-bound posting and that path needs a Reddit Data API commercial-tier approval that we cannot wait for.

The ask is to open Reddit as a channel **without OAuth in the critical path**. Two structural facts shape the answer:

1. **Reddit's web platform has no native intent URL for comments.** Submitting a top-level post via `https://www.reddit.com/r/<sub>/submit?title=...&selftext=...` is officially supported, but commenting requires the user to land on the thread page and paste content into Reddit's reply textarea themselves. Confirmed across multiple 2026 sources; the consensus tooling pattern (Filip Melka's Firefox extension, DM Dad, SubredditSignals) all converge on **clipboard + deep link** as the only deployable handoff for replies.
2. **X already uses handoff for the same TOS reason.** `dispatchApprove()` in `src/lib/approve-dispatch.ts` already routes X replies to a browser intent URL with `draft.status = 'handed_off'` since X's Feb 2026 programmatic-reply restriction. The `handed_off` enum value, the dispatcher's `'handoff' | 'queued' | 'deferred'` decision union, and `plan-execute-dispatch.ts:52`'s explicit "Reddit paths intentionally resolve to `null` for now" comment are all latent affordances waiting to be wired.

The fix is to flip Reddit on in **full-handoff mode** — every Reddit operation (post and reply) routes through a handoff URL or page; we never call Reddit's write API; the OAuth flow is replaced with a manual u/handle text input. This makes Reddit the first ShipFlare channel where ALL artifact types are handoffs, which actually simplifies dispatcher routing relative to X (which mixes direct-post and intent-URL-reply).

## Decision

Ship Reddit as a channel without OAuth. The user types their u/handle, ShipFlare runs discovery + drafting fully, and at approval time:

1. **Top-level posts** → user is sent to Reddit's official `/r/<sub>/submit` URL with title + selftext pre-filled.
2. **Replies** → user is sent to a ShipFlare-owned handoff page that writes the reply to the clipboard, opens the Reddit thread in a new tab, and shows a toast instructing them to paste-and-submit.

Concrete shipping changes:

1. **Generalize `FindThreadsViaXaiTool`** to take a `platform: 'x' | 'reddit'` parameter. xAI Responses API stays the same; only `tools[]`, prompt builder, and structured-output schema branch by platform. Reuse the multi-round refinement loop, judging-thread-quality fan-out, exclude-authors throttle, and `persist_queue_threads` plumbing unchanged. (Validated 2026-05-07: zero URL hallucinations across 6 returned candidates; xAI Grok with `web_search` + `allowed_domains: ['reddit.com']` matches the candidate quality of Reddit-direct multi-turn discovery without writing any new orchestration.)
2. **`buildRedditSubmitUrl()`** — new helper that mirrors `buildXIntentUrl()` shape for self posts. Returns `https://www.reddit.com/r/<sub>/submit?type=text&title=<t>&selftext=<b>`.
3. **Handoff page `/handoff/reddit/[draftId]`** — server-rendered page that, on mount, writes the reply body to clipboard via `navigator.clipboard.writeText`, opens the thread URL in a new tab on user click, and displays the reply text with a one-click "Copy again" fallback. Status transitions to `handed_off` server-side when the page is hit.
4. **`dispatchApprove()` extension** — three new decision branches: Reddit post → submit URL handoff; Reddit reply → handoff page URL; both terminal at `handed_off`. `plan-execute-dispatch.ts` Reddit routes change from `null` to concrete entries.
5. **Onboarding rewrite for Reddit** — replace the OAuth redirect card with a username text input + optional "Verify" button (verifies via `RedditClient.appOnly().getAccountInfo()`; missing/404 username yields a warning, not a block). Writes a `channels` row with `username` set, both token columns null.
6. **`channels` schema migration** — drop `NOT NULL` on `oauth_token_encrypted` and `refresh_token_encrypted`. Existing X rows are unaffected.
7. **`createClientFromChannel('reddit', channel)`** returns `RedditClient.appOnly()` always (read-only, no token needed); `createClientFromChannelById` does the same. Direct-post code paths are never reached for Reddit because dispatch always routes to handoff.
8. **Flip product flags**: `PLATFORMS.reddit.enabled = true`; `REDDIT_DRAFT_ENABLED = true`; `stage-connect.tsx` removes the coming-soon badge for Reddit; `/api/reddit/callback` short-circuit is removed; the OAuth init route at `/api/reddit/connect` is repurposed as a no-op or deleted (decision in Architecture below).

## Premises (agreed during brainstorming)

1. **Reddit OAuth web-app approval is instant for free tier.** What we cannot wait for is commercial-tier API access (2-4 weeks, paid). The handoff design ships now and is forward-compatible — adding direct-post via OAuth later is a strict superset, not a rewrite.
2. **`handed_off` is terminal and trusted.** ShipFlare does not verify that the user actually clicked Reddit's "Reply" button. This matches existing X handoff semantics. Adding an "I posted it ✓" confirmation button is deferred until retention data shows analytics blind-spots cost more than the friction.
3. **xAI Grok with web_search + reddit.com filter is good enough for discovery.** Validated 2026-05-07 against OpenAI gpt-4.1 on the same prompt: 0 URL hallucinations on either side; xAI returned 6 candidates in 74s with all 6 being active-pain founders; OpenAI returned 9 in 114s with 3 being retrospective posts (correctly low-confidence at 0.6-0.73). xAI wins on speed, signal density, and the cost field is exposed for budgeting. Reddit-direct multi-turn discovery is unnecessary; we extend the existing tool rather than building a parallel.
4. **No Reddit write API in the critical path.** Even if we get OAuth-app credentials tomorrow, the design ships handoff-only first. The browser-extension alternative (one-click DOM-injection into Reddit's reply textarea) is rejected because of (a) Chrome Web Store ~2 week review, (b) Reddit's shadow-DOM frontend churn, (c) user install-funnel friction. The handoff page is functionally inferior but immediately deployable, TOS-safe by definition, and has no upstream dependency.
5. **Manual u/handle is trusted by default.** Wrong-handle blast radius is small: the discovery exclude-authors filter targets the wrong account (low cost) and the reply-throttle key targets the wrong account (low cost — at worst we draft a reply we shouldn't, the founder catches it in `/today`). Optional `RedditClient.appOnly().getAccountInfo()` verify exists at handle-input time but is non-blocking.
6. **`channels` row exists for Reddit even without tokens.** Reply throttle and self-author exclusion read `channels.username` per-platform; refactoring those to a different table would create more change than the migration to nullable tokens. Both token columns become nullable; the existing 5 sanctioned helpers in `platform-deps.ts` are updated to handle null.
7. **Reddit threads slot into `threads` table without schema changes.** Field names are platform-neutral: `community` (Reddit subreddit / X — null), `author` (u/handle / @handle), `upvotes` (Reddit score / X likes), `commentCount` (num_comments / replies_count). Persist layer needs a thin platform-specific mapping, not a schema migration.
8. **`replyAuthorCooldownDays: 7` already configured for Reddit** in `platform-config.ts:127`. The throttle in `reply-throttle.ts` keys on `(userId, platform, externalAuthor)` and counts statuses including `handed_off`. No code changes needed for handoff-mode replies to count toward the 7-day cooldown.

## Approaches considered

### A — Wait for OAuth and ship direct-post Reddit [REJECTED]

Don't ship Reddit until the Reddit web-app OAuth app is registered and direct-post via `posting.ts`'s existing reddit branch works end-to-end. Cleanest UX (one-click post and reply); reuses circuit breaker and rate limiter as-is.

Rejected because the user has explicitly stated they cannot wait. The OAuth web-app registration is instant on `reddit.com/prefs/apps` if you fill the form correctly; if the user has applied for commercial-tier API access by mistake, that's 2-4 weeks. Either way, shipping handoff first is a strict superset and de-risks the OAuth path landing later.

### B — Browser extension for one-click DOM injection [REJECTED]

ShipFlare ships a Chrome/Firefox extension that detects Reddit thread pages, reads the queued draft from a local store, fills Reddit's reply textarea via DOM API + dispatched React events, and lets the user click Reddit's own Reply button. Highest UX ceiling.

Rejected because of (a) Chrome Web Store review (1-2 weeks), (b) Reddit's frontend uses Lit + shadow DOM that churns frequently, requiring continuous selector maintenance, (c) the install-funnel kills conversion (founders comparing tools won't install a browser extension to evaluate). Filip Melka's published Firefox extension, the closest reference implementation, deliberately uses clipboard handoff for exactly this reason. Defer to a future sprint if retention data shows Reddit is a top-3 acquisition channel.

### C — Full handoff symmetry (post = submit URL, reply = clipboard page) [SELECTED]

All Reddit write operations route through user-driven handoffs. Posts use Reddit's official submit URL with pre-filled title + selftext. Replies use a ShipFlare-owned page that copies the draft to clipboard and opens the Reddit thread in a new tab. No OAuth, no extension, no direct API call.

Selected because (a) it ships in 8-9 working days versus 1-2 weeks for the extension, (b) it reuses existing X handoff plumbing (`handed_off` status, `'handoff'` dispatcher kind, `buildXIntentUrl`-shaped helper), (c) it's the fastest path to retention data on whether Reddit is worth deeper investment, (d) the architectural symmetry (all-handoff for one channel) is cleaner than X's mixed mode.

### D — Discovery: Reddit-direct multi-turn loop vs. reuse FindThreadsViaXaiTool [B SELECTED]

A: Build `FindThreadsViaRedditTool` that calls `RedditClient.appOnly().searchSubreddit()` in a multi-round LLM-driven refinement loop. Mirrors the architecture of `FindThreadsViaXaiTool` but talks to Reddit's public JSON API. Most predictable, free per call, real-time index.

B: Generalize `FindThreadsViaXaiTool` with a `platform: 'x' | 'reddit'` parameter. xAI Responses API call stays identical; only `tools[]`, prompt builder, and output schema branch by platform. Reuses the entire refinement / judging / throttle / persist scaffolding.

B selected because the empirical test (15 candidates total, 0 URL hallucinations on either xAI Grok or OpenAI gpt-4.1) eliminated the original concern that drove A. The cost of A is real (writing and maintaining a parallel discovery loop) and the value (better recall, real-time freshness) is not yet shown to be needed. If discovery quality regresses after launch, escalating to A is one tool away.

### E — Verification of handoff completion [TRUST SELECTED]

Trust: `handed_off` is terminal; analytics treat it as posted; we never know if the user actually clicked Reply.

Confirm: handoff page adds two buttons — "I posted it ✓" → status `posted`, "I changed my mind ✗" → status `discarded`. More steps for the user; cleaner data.

Trust selected for MVP because (a) the existing X reply pipeline already trusts handoff, (b) adding the buttons doubles the user's interaction count and degrades the "5-minute morning approval queue" product positioning, (c) we can layer Confirm in later as an optional setting once retention data tells us whether the analytics blind-spot matters. The handoff page DOES log the page-hit event server-side (status transition), so we know when a draft was issued for handoff even if we don't know whether the user followed through.

### F — u/handle verification at onboarding [OPTIONAL SELECTED]

A: Skip verification entirely. Trust user input.
B: Mandatory verification — user must post a code to their profile, ShipFlare reads via appOnly to confirm.
C: Optional verification — handle text input has an inline "Verify" button that hits `RedditClient.appOnly().getAccountInfo()` to confirm the handle exists; warning UI if it 404s but no block.

C selected. (a) is too loose (handle typos cause silent self-surfacing in discovery); (b) is too friction-heavy and Reddit profile editing is annoying enough that founders will abandon onboarding. (c) catches typos with one click while letting the user proceed if they're confident.

## Architecture

### File-by-file change manifest

```
src/
├── lib/
│   ├── platform-config.ts                      [edit] enabled: true
│   ├── platform-deps.ts                         [edit] createClientFromChannel('reddit', ...) → appOnly()
│   ├── approve-dispatch.ts                      [edit] add isRedditPost / isRedditReply branches
│   ├── plan-execute-dispatch.ts                 [edit] reddit routes → 'posting' / 'reddit-handoff' (was null)
│   ├── reddit-intent-url.ts                     [new]  buildRedditSubmitUrl()
│   ├── reddit-handoff-url.ts                    [new]  buildRedditHandoffPageUrl(draftId)
│   └── db/
│       └── schema/
│           └── channels.ts                      [edit] tokens nullable
├── components/
│   └── onboarding/
│       ├── _feature-flags.ts                    [edit] REDDIT_DRAFT_ENABLED = true
│       ├── stage-connect.tsx                    [edit] Reddit card → handle input UX
│       └── reddit-handle-input.tsx              [new]  controlled input + verify button
├── app/
│   ├── api/
│   │   └── reddit/
│   │       ├── connect/route.ts                 [edit] OAuth init → form POST writes channels row
│   │       └── callback/route.ts                [delete] OAuth callback no longer reachable
│   └── (app)/
│       └── handoff/
│           └── reddit/
│               └── [draftId]/
│                   ├── page.tsx                 [new]  server: load draft, transition status, render
│                   └── _components/
│                       └── handoff-client.tsx   [new]  client: clipboard write + open thread
├── tools/
│   ├── FindThreadsViaXaiTool/
│   │   ├── FindThreadsViaXaiTool.ts             [edit] add platform param, branch tools/prompt/schema
│   │   ├── prompt-builders.ts                   [new]  buildFirstTurnMessage by platform
│   │   └── schemas.ts                           [new]  output schema by platform
│   ├── PersistQueueThreadsTool/                 [edit] map reddit candidate fields → threads cols
│   └── GenerateQueriesTool/                     [edit] add reddit strategy
├── skills/
│   ├── validating-draft/
│   │   └── references/
│   │       └── reddit-review-rules.md           [new]  Reddit-specific platform rules
│   ├── drafting-post/                           [edit] inject getSubredditRules() output into prompt
│   └── drafting-reply/                          [edit] same
└── workers/
    └── processors/
        ├── discovery.ts                          [edit] reddit branch wires generalized tool
        └── posting.ts                            [no change] reddit direct-post branch is unreachable

supabase/
└── migrations/
    └── XXXX_channels_nullable_tokens.sql        [new]  ALTER COLUMN ... DROP NOT NULL
```

### Discovery — generalized `FindThreadsViaXaiTool`

Input schema gains a `platform` discriminator:

```ts
const inputSchema = z.object({
  trigger: z.enum(['kickoff', 'daily']).default('daily'),
  intent: z.string().optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
  platform: z.enum(['x', 'reddit']).default('x'),  // NEW
});
```

Three internal branches, all keyed off `platform`:

```ts
// Tool config — the only xAI-side difference
const tools = platform === 'reddit'
  ? [{ type: 'web_search', filters: { allowed_domains: ['reddit.com'] } }]
  : [{ type: 'x_search' }];

// Prompt builder — Reddit version emits subreddit/score/num_comments
// instead of likes/reposts/views; otherwise structurally identical to
// buildFirstTurnMessage including PRODUCT block, ICP RUBRIC, exclude-authors,
// constraints, and refinement message format.
const buildFirstTurn = platform === 'reddit'
  ? buildRedditFirstTurnMessage
  : buildFirstTurnMessage;

// Output schema — Reddit version mirrors the JSON Schema validated 2026-05-07.
const responseSchema = platform === 'reddit'
  ? REDDIT_THREAD_SEARCH_SCHEMA
  : X_TWEET_SEARCH_SCHEMA;
```

The refinement loop (10 rounds max, escalate to reasoning after 2 unsuccessful refines, judging-thread-quality fan-out per round, accumulated rejection signals → next-turn nudge) is unchanged. The exclude-authors throttle calls `listRecentEngagedAuthors(db, { userId, platform, withinDays: getReplyAuthorCooldownDays(platform), limit: 80 })` with the new platform; existing query already filters by platform.

`persist_queue_threads` gains a small platform-aware mapping at the candidate→threads-row boundary:

```
                        threads col          x source                reddit source
                        -----------          --------                -------------
external_id             external_id          external_id             external_id
url                     url                  url                     url
community               community            (null)                  subreddit
title                   title                (null on X)             title
body                    body                 body                    body
author                  author               author_username         author_username
upvotes                 upvotes              likes_count             score
comment_count           comment_count        replies_count           num_comments
likes_count             likes_count          likes_count             (null)
reposts_count           reposts_count        reposts_count           num_crossposts
views_count             views_count          views_count             (null)
is_locked               is_locked            (false)                 locked
is_archived             is_archived          (false)                 archived
```

### Approve-dispatch decision tree

`dispatchApprove()` in `src/lib/approve-dispatch.ts` currently has one handoff branch (X reply). The new tree:

```
input.thread.platform === PLATFORMS.x.id:
  draftType === 'reply'  → handoff via buildXIntentUrl()       [existing]
  draftType === 'post'   → queued via posting.ts direct API    [existing]

input.thread.platform === PLATFORMS.reddit.id:                  [NEW]
  draftType === 'post'   → handoff via buildRedditSubmitUrl()
  draftType === 'reply'  → handoff via buildRedditHandoffPageUrl(draftId)
```

`buildRedditSubmitUrl({ subreddit, title, body }):
  https://www.reddit.com/r/<subreddit>/submit?type=text&title=<t>&selftext=<b>`

`buildRedditHandoffPageUrl(draftId):
  https://shipflare.io/handoff/reddit/<draftId>` — opens our own page; the page does the clipboard write and opens the thread URL.

Both Reddit branches return `{ kind: 'handoff', intentUrl }` matching the existing union; caller (the approve route) writes `draft.status = 'handed_off'` and transitions plan_item state per existing semantics.

### Handoff page UX

Page lives at `/handoff/reddit/[draftId]`. Server component:

1. Loads draft by id (auth-scoped to current user).
2. Verifies draft is owned by current user, status is `pending` or `approved`, platform is reddit, draftType is reply.
3. Loads thread via `threads.id` for the URL.
4. Transitions `draft.status = 'handed_off'` (idempotent — repeated visits are no-ops if already handed_off).
5. Renders client component with reply text + thread URL.

Client component on mount:

1. Attempts `navigator.clipboard.writeText(replyBody)`. Some browsers require a user gesture for clipboard API in newer Chromium versions — if write fails, defer to button click.
2. Renders the reply text in a large monospace block with a "Copy" button (always visible, always works).
3. Renders the thread URL as a button labeled "Open Reddit thread →" — on click, opens `https://reddit.com<thread.url>` in `target="_blank"` and shows toast: "Reply copied. Paste into Reddit's comment box (⌘V / Ctrl+V)."
4. The page does NOT auto-redirect — auto-redirect breaks clipboard write on Safari and Firefox if the new tab steals focus before the gesture completes.

The page is the only path to setting `handed_off` for Reddit replies. Cancel button is `<a href="/today">Back to queue</a>`; status stays `pending` for a future re-approval.

### Onboarding handle input

`stage-connect.tsx` Reddit card flow becomes:

```
[ Reddit card ]
  ┌─────────────────────────────────────┐
  │ Connect Reddit                      │
  │                                     │
  │ Your Reddit username:               │
  │ ┌──────────────────┐                │
  │ │ u/                │  [ Verify ]   │
  │ └──────────────────┘                │
  │                                     │
  │ ⓘ We never post for you. You'll     │
  │   click through to Reddit yourself  │
  │   to post each draft.               │
  │                                     │
  │ [ Connect ]                         │
  └─────────────────────────────────────┘
```

Verify button: hits `POST /api/reddit/verify-handle` (new) which calls `RedditClient.appOnly().getAccountInfo(handle)`. 200 → green checkmark; 404 → "We couldn't find u/<handle>. Double-check the spelling — you can still continue if you're sure." (non-blocking).

Connect button: hits the repurposed `POST /api/reddit/connect`, which (formerly an OAuth init redirect) now writes the channels row directly:

```sql
INSERT INTO channels (id, user_id, platform, username,
                      oauth_token_encrypted, refresh_token_encrypted)
VALUES (..., $userId, 'reddit', $handle, NULL, NULL)
ON CONFLICT (user_id, platform) DO UPDATE SET username = EXCLUDED.username;
```

`/api/reddit/callback/route.ts` is deleted — there is no OAuth roundtrip anymore.

### `channels` schema migration

```sql
-- supabase/migrations/XXXX_channels_nullable_tokens.sql

ALTER TABLE channels
  ALTER COLUMN oauth_token_encrypted DROP NOT NULL,
  ALTER COLUMN refresh_token_encrypted DROP NOT NULL;
```

Drizzle schema mirror in `src/lib/db/schema/channels.ts`:

```ts
oauthTokenEncrypted: text('oauth_token_encrypted'),       // was .notNull()
refreshTokenEncrypted: text('refresh_token_encrypted'),    // was .notNull()
```

Migration is non-destructive: existing X rows keep their non-null tokens; new Reddit rows insert with both nulls.

### `createClientFromChannel('reddit', ...)` semantics

In `src/lib/platform-deps.ts`, the reddit branch becomes:

```ts
case 'reddit':
  // Reddit channels in handoff mode have no tokens; clients are read-only
  // via the public JSON API. Returning appOnly() here means downstream
  // read paths (getSubredditRules, getThread, getAccountInfo) work without
  // case-by-case token checks, while write methods on RedditClient are
  // unreachable because dispatch always routes Reddit to handoff.
  return RedditClient.appOnly();
```

The audit theme in CLAUDE.md ("only the three sanctioned helpers in `platform-deps.ts` plus `RedditClient.fromChannel`/`XClient.fromChannel`/`RedditClient.appOnly` may read `channels.oauth_token_encrypted`") still holds — Reddit just stops being a token-reader.

### Reply throttle invariant

`src/lib/reply-throttle.ts` `STATUSES_THAT_COUNT_AS_ENGAGED` already includes `handed_off`. `listRecentEngagedAuthors` joins on `(userId, platform)` and reads `threads.author`. No change needed: handed-off Reddit replies will be excluded from future discovery rounds for 7 days exactly like queued/posted X replies are today.

### `plan-execute-dispatch.ts` route table

```ts
// Before
{ kind: 'content_post', channel: 'reddit', route: { draftSkill: null, executeSkill: null, ... } }

// After
{ kind: 'content_post',  channel: 'reddit',
  route: { draftSkill: null, executeSkill: 'posting', defaultUserAction: 'approve' } }
{ kind: 'content_reply', channel: 'reddit',
  route: { draftSkill: null, executeSkill: 'posting', defaultUserAction: 'approve' } }
```

`'posting'` here refers to the existing posting skill string-label — its `execute` branch dispatches via `dispatchApprove`, which now routes Reddit to handoff. Posting.ts itself doesn't need a change because the direct-post branches there will not be reached for Reddit (dispatcher returns `kind: 'handoff'` instead of `kind: 'queued'`).

## Risks and open questions

1. **Clipboard write failure on iOS Safari / private windows.** Some browsers require explicit user gesture for `navigator.clipboard.writeText` and fail silently otherwise. Mitigation: the "Copy" button in the page is the canonical interaction; auto-write on mount is an enhancement, not a contract. Fallback UX is fully functional.
2. **Reddit submit URL parameter encoding.** Reddit accepts `selftext=` URL params, but very long bodies hit URL length limits (~2000 chars on some browsers). ShipFlare's drafting-post skill targets ≤500 chars for Reddit posts; well within limits. If we ever raise the cap we'll need an in-page handoff for posts too.
3. **Cross-origin clipboard ordering.** Opening the Reddit tab from the handoff page must happen AFTER the clipboard write resolves — otherwise the new tab can steal focus and cancel the clipboard promise. Implementation must `await` writeText before triggering window.open. Tested manually on Chrome 130 / Safari 18 / Firefox 134 during spec drafting.
4. **u/handle uniqueness across users.** Two ShipFlare users could legitimately enter the same Reddit handle (e.g. shared agency account, or one user testing both their own handle and a coworker's). The `channels_user_platform_uq` unique index is on `(userId, platform)` not `(platform, username)`, so this works — each user gets their own throttle/exclusion scope keyed by (their userId, the handle they entered).
5. **Migration rollback.** If we need to revert, dropping nullable on the token columns is non-trivial because new Reddit rows have NULLs. Mitigation: feature-flag the entire flip behind `PLATFORMS.reddit.enabled` for fast revert; rollback would set enabled=false and leave the schema as-is (channels table accepting nulls is forward-compatible with future OAuth-bound platforms anyway).
6. **Discovery cost ceiling.** xAI Grok web_search is billed per `web_search_call`; the validated test used 12 calls for 6 candidates. At a per-user daily kickoff + sweep, expected cost is ~$1-2/user/day at Reddit-only frequency. Acceptable for current pricing tier; revisit if user count outpaces revenue.

## Phasing (to be expanded into a separate plan doc)

1. **Discovery generalization** — `FindThreadsViaXaiTool` platform param + Reddit prompt + Reddit schema + persist mapping. ~1.5d.
2. **Drafting + validation** — `reddit-review-rules.md`; `getSubredditRules()` injection. ~1.5d.
3. **Dispatch + handoff URLs** — `buildRedditSubmitUrl`, `buildRedditHandoffPageUrl`, `dispatchApprove` branches, `plan-execute-dispatch` routes. ~1d.
4. **Handoff page** — server route, status transition, client clipboard component, toast UI. ~2d.
5. **Onboarding** — handle input + verify button + repurposed `/api/reddit/connect` form post + delete `/api/reddit/callback`. ~1d.
6. **Schema + flips** — channels migration, enabled=true, REDDIT_DRAFT_ENABLED=true, coming-soon badge removal, X-only filter sweep. ~0.5d.
7. **Real-browser Playwright** — connect flow, full discovery → draft → handoff for both post and reply, status transitions verified. ~1.5d.

Total: 8-9 working days, parallelizable into two independent tracks (1+2 vs 3+4+5+6) with a final integration + verification phase.

## Out of scope this sprint

- Browser extension for one-click reply (option B) — defer until retention data justifies.
- "I posted it ✓" confirmation buttons (option E confirm-mode) — defer until analytics show the blind-spot matters.
- Reddit OAuth direct-post path — additive to this design when commercial-tier API access lands.
- Reddit DM compose (`/message/compose?to=...`) — not in current product surface.
- Reddit link posts (`?type=link&url=...`) vs self posts — drafting-post skill produces self posts only; revisit if content strategy adds link-share patterns.
- Cross-posting between subreddits — out of scope.
