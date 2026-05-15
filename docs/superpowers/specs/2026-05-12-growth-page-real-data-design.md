# Growth page — real data, module-based progress dashboard

**Date:** 2026-05-12
**Status:** spec
**Author:** brainstorm session w/ Claude (Opus 4.7)

## Problem

`/growth` ships today as a near-empty placeholder: one real `HealthMeter` reading `/api/health` plus three "Scout is calibrating" empty cards (Communities / Keyword triggers / ICPs). The empty cards were placeholders for a calibration pipeline that never materialized.

Three things need to land:

1. **Per-channel data** for each connected platform (X, Reddit) — what the team actually shipped this week.
2. **Reddit subreddit management** moves out of `/settings/reddit-channels` and into `/growth`, where channel ops naturally live.
3. **Health score rewritten** to reflect the user-facing pipeline activity (search → draft → post → reply) — *positive progress feedback* rather than abstract quality dimensions.

The legacy `health_scores` table uses a 5-dimensional model (Pipeline / Quality / Engagement / Consistency / Safety) that doesn't compose to the team-of-managers framing from [`docs/agent-roster-roadmap.md`](../../agent-roster-roadmap.md). The new model is **per-channel → per-module → overall** so adding SEO Manager or Content Marketing Manager later is one config-file change.

## Information architecture

```
/growth
├─ Header: "Growth" · "Your marketing team's progress — last 7 days."
├─ ❶ Hero card
│  ├─ Overall dial (0-100, conic-gradient on --sf-success)
│  └─ Module strip — 5 chips
│     ├─ SOCIAL · 74 · ● LIVE
│     ├─ SEARCH · — · ○ PLANNED
│     ├─ PERFORMANCE · — · ○ PLANNED
│     ├─ CONTENT · — · ○ PLANNED
│     └─ ANALYTICS · — · ○ PLANNED
└─ ❷ Social Marketing panel
   ├─ Header: "Social Media Manager · 74/100" + Active pill
   └─ Channel cards (grid 1fr 1fr → 1fr 1fr stacked on narrow)
      ├─ X card
      │  ├─ Platform tile (𝕏) + handle + connection status
      │  ├─ 4 metrics row: Threads / Drafts / Posts / Replies
      │  └─ Meta line: Pending · Approve rate · Last post
      └─ Reddit card
         ├─ Platform tile (R) + "Handoff mode" + active status
         ├─ 4 metrics row: Threads / Drafts / Posts / Replies
         ├─ Meta line: Pending · Approve rate · Last post
         └─ Subreddit chips row + "Manage subreddits →" link

/growth/reddit-channels                    (route moved from /settings/reddit-channels)
└─ <RedditResearchCard />                  (no component changes)

/settings
└─ Reddit row deleted; X row stays (handles OAuth)
```

Invariant: **`overallScore` = weighted average of live module scores.** With only Social live, weight = 1.0 → `overallScore === socialModuleScore`. When SEO Manager ships, register it in `growth-modules.ts`; weights rebalance automatically.

## Data sources

All windows are fixed at **7 days**. No new event types — every metric derives from existing tables.

| Metric | Query |
|---|---|
| **Threads** | `count(*) from threads where created_at >= now() - interval '7 days' and platform = ?` (filtered by `threads.userId` implicit via `posts`/`drafts` join — see below) |
| **Drafts** | `count(*) from drafts d join threads t on d.thread_id = t.id where d.user_id = ? and d.created_at >= weekAgo and t.platform = ?` |
| **Posts** | `count(*) from posts p join drafts d on p.draft_id = d.id where p.user_id = ? and p.platform = ? and p.posted_at >= weekAgo and p.status in ('posted','verified') and d.draft_type = 'original_post'` |
| **Replies** | same as Posts but `d.draft_type = 'reply'` |
| **Pending** | `count(*) from drafts d join threads t on d.thread_id = t.id where d.user_id = ? and d.status = 'pending' and t.platform = ?` (no 7d window — pending is point-in-time) |
| **Approve rate** | `approved_count / (approved_count + skipped_count)` over 7d on `drafts` joined `threads.platform = ?` — null when denominator is 0 |
| **Last post** | `max(posted_at) from posts where user_id = ? and platform = ?` — no window (we want last-ever) |
| **Active subreddits** | `count(*) from product_reddit_channels where product_id in (...) and disabled = false` — only rendered on Reddit card |

`threads` has no direct `user_id` column today — the user identity comes from the `posts`/`drafts` join. The query for "threads found by this user this week" routes through `threads` rows that are referenced by `drafts` rows owned by the user, OR through `pipeline_events`/`activity_events` if more reliable. The processor implementation will pick the cleanest path; spec-level the count is "threads surfaced for this user's discovery sweeps this week."

## Score formula

```ts
// Per-channel — each component capped at 1.0 then equally averaged
function channelScore(counts: ChannelCounts, target: ChannelTarget): number {
  const cThreads = Math.min(1, counts.threads / target.threads);
  const cDrafts  = Math.min(1, counts.drafts  / target.drafts);
  const cPosts   = Math.min(1, counts.posts   / target.posts);
  const cReplies = Math.min(1, counts.replies / target.replies);
  return Math.round(100 * (cThreads + cDrafts + cPosts + cReplies) / 4);
}

// Module = average of enabled channel scores
function moduleScore(channelScores: number[]): number {
  return Math.round(channelScores.reduce((a, b) => a + b, 0) / channelScores.length);
}

// Overall = weighted average across live modules
function overallScore(modules: { score: number; weight: number }[]): number {
  return Math.round(modules.reduce((acc, m) => acc + m.score * m.weight, 0));
}
```

Cap-then-average prevents "all threads no posts" inflation. Targets live in a new file:

```ts
// src/lib/growth-targets.ts
export interface ChannelTarget {
  threads: number;
  drafts: number;
  posts: number;
  replies: number;
}

export const GROWTH_TARGETS: Record<string, ChannelTarget> = {
  x:      { threads: 30, drafts: 20, posts: 5, replies: 15 },
  reddit: { threads: 15, drafts: 10, posts: 3, replies: 8  },
};
```

Module registry:

```ts
// src/lib/growth-modules.ts
export interface GrowthModule {
  id: 'social' | 'search' | 'performance' | 'content' | 'analytics';
  displayName: string;          // "Social marketing", etc.
  managerTitle: string;         // "Social Media Manager"
  live: boolean;                // false for Tier 2 modules
  channels: string[];           // platform ids; ['x','reddit'] for social
}

export const GROWTH_MODULES: GrowthModule[] = [
  { id: 'social',      displayName: 'Social marketing', managerTitle: 'Social Media Manager', live: true,  channels: ['x','reddit'] },
  { id: 'search',      displayName: 'Search',           managerTitle: 'SEO Manager',           live: false, channels: [] },
  { id: 'performance', displayName: 'Performance',      managerTitle: 'Performance Marketing Manager', live: false, channels: [] },
  { id: 'content',     displayName: 'Content',          managerTitle: 'Content Marketing Manager', live: false, channels: [] },
  { id: 'analytics',   displayName: 'Analytics',        managerTitle: 'Marketing Analytics Manager', live: false, channels: [] },
];

// Weight = 1 / liveModuleCount. Each live module weighs equally for now.
```

## Schema changes

Single migration drops the legacy table and adds two new rollup tables.

```sql
DROP TABLE health_scores;

CREATE TABLE channel_scores (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       text NOT NULL,
  score          integer NOT NULL,
  threads        integer NOT NULL,
  drafts         integer NOT NULL,
  posts          integer NOT NULL,
  replies        integer NOT NULL,
  pending        integer NOT NULL,
  approve_rate   real,                       -- null when no decisions yet
  last_post_at   timestamp,                  -- null on cold start
  calculated_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX channel_scores_user_platform_idx
  ON channel_scores(user_id, platform, calculated_at DESC);

CREATE TABLE module_scores (
  id             text PRIMARY KEY,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id      text NOT NULL,
  score          integer NOT NULL,
  calculated_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX module_scores_user_module_idx
  ON module_scores(user_id, module_id, calculated_at DESC);
```

## Worker — `processGrowthRollup`

Rewritten from `src/workers/processors/health-score.ts`. The BullMQ queue name stays `health-score` (Redis stability — no leftover stuck jobs need to migrate); the file is renamed to `growth-rollup.ts`.

```
processGrowthRollup(userId):
  weekAgo = now - 7d
  for platform in listAvailablePlatforms():
    counts = computeChannelCounts(userId, platform, weekAgo)
    meta   = computeChannelMeta(userId, platform, weekAgo)
    target = GROWTH_TARGETS[platform]
    score  = channelScore(counts, target)
    INSERT INTO channel_scores (...)
  for module in GROWTH_MODULES where module.live:
    channelScoresForModule = SELECT score FROM channel_scores
                              WHERE user_id = ? AND platform IN module.channels
                              ORDER BY calculated_at DESC LIMIT 1 per platform
    score = moduleScore(channelScoresForModule)
    INSERT INTO module_scores (...)
```

Read paths only ever look at the latest row per `(user_id, platform)` and per `(user_id, module_id)` — the index supports this.

## API

| Route | Method | Behavior |
|---|---|---|
| `/api/health` | GET | **DELETED** — no external consumers |
| `/api/growth/overview` | GET | **NEW** — returns hierarchical shape below |
| `/api/reddit-channels` | GET/POST/PATCH | unchanged |
| `/api/reddit-channels/re-research` | POST | unchanged |

Response shape:

```ts
interface GrowthOverviewResponse {
  overallScore: number | null;         // null on cold start
  modules: Array<{
    id: GrowthModule['id'];
    displayName: string;
    managerTitle: string;
    live: boolean;
    score: number | null;              // null if not-live or cold start
    channels?: Array<{                 // present when live = true
      platform: string;                // 'x' | 'reddit'
      displayName: string;             // 'X' | 'Reddit'
      connected: boolean;
      handleOrLabel: string;           // '@username' | 'Handoff mode' | 'Not connected'
      score: number | null;
      threads: number;
      drafts: number;
      posts: number;
      replies: number;
      pending: number;
      approveRate: number | null;
      lastPostAt: string | null;       // ISO timestamp
      activeSubreddits?: string[];     // Reddit only; top 5 by rank
    }>;
  }>;
}
```

Modules render in `GROWTH_MODULES` declaration order. The UI doesn't need to know the order — server controls it.

The `connected` field on each channel is computed at request time by left-joining the `channels` table on `(user_id, platform)`. `channel_scores` rows exist for every available platform (with zeros on cold start) regardless of connection state; `connected` exists separately so the UI can swap to the "Connect X to start" CTA path.

## Route changes

| Action | From | To |
|---|---|---|
| Move | `/settings/reddit-channels/page.tsx` | `/growth/reddit-channels/page.tsx` (verbatim copy; deletes the old file) |
| Update | Hero copy in `<RedditResearchCard />` (linking back to settings) | Update text + breadcrumb to reference Growth |
| Delete | `RedditIntegrationRow` + `RedditTileIcon` + Reddit row mount in `settings-content.tsx` | — |
| Delete | `SettingsRedditChannel` type, `redditChannels` prop wiring in `/settings/page.tsx` | — |
| Delete | Communities / Keyword triggers / ICP empty-state cards in `growth-content.tsx` | — |

The `<RedditIntegrationRow>` deletion also drops the `SettingsRedditChannel` interface, the `redditChannels` server-side query in `/settings/page.tsx`, and the `RedditTileIcon` SVG (unless reused elsewhere — grep confirms it isn't).

## UI — component breakdown

All UI uses the `--sf-*` design tokens (`src/app/globals.css`). Cards use `var(--sf-card-shadow)`, radius 12px, no border. Sentence-case headings. Mono-uppercase for ops labels (Threads / Drafts / Posts / Replies, module strip labels, status pills). Apple Blue `--sf-accent` only for the "Manage subreddits →" link.

```
src/app/(app)/growth/
├─ page.tsx                                  (auth gate + server fetch)
├─ growth-content.tsx                        (rewritten)
├─ _components/
│  ├─ overall-hero.tsx                       (dial + module strip)
│  ├─ module-strip.tsx                       (5 module chips)
│  ├─ social-panel.tsx                       (header + grid of channel cards)
│  ├─ channel-card.tsx                       (one card for X or Reddit)
│  └─ subreddit-chips.tsx                    (Reddit-only inline chip list)
└─ reddit-channels/
   └─ page.tsx                               (moved from /settings/reddit-channels)
```

`<HealthMeter>` is reused for the overall dial — it already renders the conic gradient + numeric center we need.

`<ChannelCard>` is platform-agnostic: takes a `ChannelOverview` prop and renders the 4-metric grid + meta line. The Reddit-specific subreddit chips are an optional `<slot>` rendered below the meta line by `<SocialPanel>` when `platform === 'reddit'`.

## Empty states & error handling

| Scenario | UI |
|---|---|
| Cold start (no `channel_scores` row) | Dial: `—`; Social chip: `—` + "Awaiting first rollup"; Channel cards: all dashes + body *"Your team hasn't started shipping yet — first rollup runs after kickoff completes."* |
| Channel disconnected | Card shows platform header + a single CTA "Connect X to start" (links to onboarding entry); 4-metric grid collapses to a one-line note |
| All zeros, channel connected | Numbers render `0` (not dash); meta line shows `Pending 0 · Approve rate — · Last post —` |
| `approve_rate` denominator zero | Meta line shows `Approve rate —` |
| `last_post_at` null | Meta line shows `Last post —` |
| No active subreddits | "No active subreddits yet — research runs on next kickoff" + "Manage subreddits →" link unchanged |
| `/api/growth/overview` errors | Hero card collapses to "Couldn't load Growth — refresh to retry." Module strip + Social panel hidden |
| `processGrowthRollup` worker error | BullMQ retries; UI keeps last-known-good rows; no user-facing failure surface in v1 |

Trigger cadence stays the same: `daily-run-fanout` already schedules `health-score` jobs; we just point the handler at `processGrowthRollup`.

## Testing

| Layer | What to test | File |
|---|---|---|
| Processor math | Seed drafts/posts/threads for two users on X+Reddit; verify channel/module/overall scores and that capped components don't exceed 1.0 | `src/workers/processors/__tests__/growth-rollup.test.ts` |
| Cold start | Empty DB → `/api/growth/overview` returns `overallScore: null`, all modules `score: null`, channels' counts `0` | same |
| Edge cases | All zero → 0; all targets met → 100; disabled channel excluded from module avg; `live: false` module excluded from overall | same |
| API | Auth gate; response shape; modules in declared order | `src/app/api/growth/overview/__tests__/route.test.ts` |
| Reddit-channels move | `/api/reddit-channels/*` endpoints unchanged; `/growth/reddit-channels` resolves the same `<RedditResearchCard>` component | existing tests |
| Settings cleanup | Settings page no longer renders Reddit row | `src/app/(app)/settings/__tests__/...` (or a snapshot) |
| Real-browser smoke | Playwright: sign in → `/growth` → assert dial number + Social Media Manager heading + both channel cards + click "Manage subreddits →" → land on `/growth/reddit-channels` | `tests/e2e/growth.spec.ts` |

Migration safety check: grep confirms `/api/health/route.ts` is the only reader of `health_scores`. That route is deleted in the same PR, so the `DROP TABLE` is safe.

## Out of scope (v1)

- 30-day window or 7/30-day toggle — fixed 7d for now (mentioned in roadmap as a follow-up).
- "Search engagement received" (X mentions, Reddit comment replies) — requires external API pulls; skipped.
- Per-channel sparklines / time series — rollup table only stores latest values; a `channel_scores` history exists but the UI doesn't graph it yet.
- Module score weights other than equal share — when SEO ships, we'll decide whether marketing modules should be weighted by founder priority.
- Trend deltas (this week vs last week) — easy v2 once we have ≥2 weeks of rollup history.

## Open implementation questions

These do not block the spec but need a decision during the plan-writing phase:

1. **Threads attribution** — `threads` table has no `user_id`. The processor needs to decide whether to count via `drafts.thread_id → threads` join (only threads that produced drafts), or via `pipeline_events`/`activity_events` records of discovery surfacing (broader). Recommend the join — under-counts slightly but is unambiguous.
2. **Pending join cost** — `drafts.status='pending'` is already indexed on `(user_id, status, created_at desc)`. The thread-join filter for platform adds a hop; if hot in production, consider denormalizing `platform` onto `drafts` (it currently lives on `threads`).
3. **First rollup trigger** — kickoff is the natural moment, but kickoff doesn't currently fan out a `health-score` job. Either (a) add the fan-out at kickoff completion, or (b) let the first daily cron tick produce the first rollup (founder sees `—` until that night).
