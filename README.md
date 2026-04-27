# ShipFlare

AI marketing autopilot for indie developers. Discover communities, engage conversations, and grow your presence — all on autopilot.

ShipFlare deploys a pipeline of AI agents that find where your users hang out, join relevant conversations with helpful replies, publish product launches and updates, and keep your community presence active across Reddit, X, Hacker News, and more. Every piece of content is reviewed for quality and FTC compliance before it goes live.

## How it works

Onboarding runs in 4 steps:

1. **Add your product** — Scan a GitHub repo or website URL. The extractor pulls name, description, keywords, target audience, voice, and product category. You confirm and edit on a staggered review screen before anything persists.
2. **Connect your accounts** — OAuth into Reddit and X. At least one channel unlocks the agent pipeline; you can skip to try the product first and connect later.
3. **Where's your product at?** — MVP, launching this week, or already live. Each state picks a different playbook shape (pre-launch · launch sprint · compound growth) and captures the dates that drive cadence decisions.
4. **Your launch plan** — A two-tier planner runs in parallel with a 6-agent animation (~5s). The output is a tactile plan you can edit before committing: About (product profile), Timeline (multi-week thesis arc + milestones), First week (concrete `plan_items`).

After the commit, you land at `/today` with a live pipeline overlay. First drafts arrive in ~1 hour. Nothing posts until you approve.

### Planner architecture

The planner is **two-tier**:

- **Strategic Planner** (low frequency, Sonnet 4.6) — Runs at onboarding and when you change state / launch date. Produces a `strategic_paths` row: a 6-week narrative, milestones, a per-week thesis arc, content pillars, channel mix, and phase goals. This is the long arc the tactical layer anchors against.
- **Tactical Planner** (high frequency, Haiku 4.5) — Runs at onboarding (after strategic), every Monday cron, and on manual re-plan. Reads the active strategic path + the week's signals, produces concrete `plan_items` rows for the next 7 days.

`plan_items` is the only todo source. Each row is either auto-executed (`userAction='auto'`), queued for your approval (`'approve'`), or surfaced as manual work (`'manual'`). Terminal states: `completed`, `skipped`, `failed`, `superseded`, `stale`.

Execution is a dumb dispatcher: the Plan Execute worker reads `plan_items`, calls the atomic skill named in `skillName` with the row's `params`, advances the state machine. Skills are composable building blocks — `draft-single-post-x`, `draft-single-reply`, `send-email`, `discovery`, `posting`, `draft-review`, etc. — each runnable in isolation.

### Runtime pipeline

```
Onboarding → Strategic Planner → Tactical Planner → plan_items → Plan Executor → Atomic Skills → Tools
                                                         ↑                             ↓
                                                  Weekly Replan Cron            Draft Review
                                                                                      ↓
                                                                                /today approval
                                                                                      ↓
                                                                                   Posting
```

Agents learn over time. A memory system distills insights from every run — which communities yield results, what tone works where, which approaches get engagement.

## Supported channels

| Channel | Discovery | Posting | Status |
|---------|-----------|---------|--------|
| Reddit | `reddit_search`, `reddit_discover_subs`, `reddit_hot_posts` | `reddit_post`, `reddit_submit_post` | Live |
| X / Twitter | `x_search` (via xAI Grok API) | `x_post` | Live |
| Hacker News | `hn_search`, `hn_get_thread` | -- | Discovery only |

The architecture is channel-agnostic by design. Each channel is a set of tools (search + post) that agents call through the same query loop. Adding a new channel (e.g. LinkedIn, Discord, Indie Hackers, Product Hunt) requires:

1. **Tools** — Implement search and post tools in `src/tools/` following the existing `ToolDefinition` interface.
2. **Agent prompts** — Add channel-specific instructions to the relevant agent `.md` files (discovery, content, posting).
3. **OAuth flow** (if needed) — Add a connect route under `src/app/api/<channel>/` and store encrypted tokens in the `channels` table.
4. **Worker config** — The existing BullMQ pipeline (discovery -> content -> review -> posting) handles new channels automatically once tools are registered.

No changes to the core runtime (`query-loop`, `swarm`, `skill-runner`) or the scoring/review pipeline are required.

## Tech stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16, React 19, App Router |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL (Supabase), Drizzle ORM |
| Queue | BullMQ, Redis, ioredis |
| AI | Anthropic Claude (Haiku 4.5 for agents, Sonnet 4.6 for content) |
| Auth | Auth.js v5 (GitHub OAuth) |
| Workers | Bun (separate process) |
| Testing | Playwright (E2E), Vitest |

## Agents

v3 ships 6 brand-locked agents visible throughout the UI (`SCOUT / DISCOVERY / ANALYST / CONTENT / REVIEW / POSTING`):

| Agent | Model | Role |
|-------|-------|------|
| Scout | Haiku 4.5 | Discovery source survey — which subreddits, handles, threads to watch |
| Discovery | Haiku 4.5 | Per-source thread fetch + 5-dimension scoring (relevance · intent · exposure · freshness · engagement) |
| Analyst | Sonnet 4.6 | Strategic + Tactical planners — narrative, milestones, thesis arc, weekly plan_items |
| Content | Sonnet 4.6 | Atomic drafters: `draft-single-post-x`, `draft-single-reply`, `send-email`, etc. |
| Review | Haiku 4.5 | Adversarial quality gate (6 mandatory checks: relevance · tone · authenticity · FTC · risk · truth) |
| Posting | Haiku 4.5 | Posts to Reddit/X, verifies visibility, detects shadowbans, runs circuit breaker |

Under the hood each agent is a set of atomic skills (SKILL.md + agent.md pairs) that the Plan Executor dispatches per-item. See `src/skills/_catalog.ts` for the full catalog and `docs/superpowers/specs/2026-04-20-planner-and-skills-redesign-design.md` for the architecture.

## Getting started

### Prerequisites

- Node.js 20+
- [Bun](https://bun.sh) (for workers)
- PostgreSQL (or Supabase)
- Redis

### Environment

Copy `.env.example` or create `.env.local` with:

```bash
# Required
DATABASE_URL=postgresql://...
REDIS_URL=redis://localhost:6379
AUTH_SECRET=<random-string-min-16-chars>
GITHUB_ID=<github-oauth-app-id>
GITHUB_SECRET=<github-oauth-app-secret>
ANTHROPIC_API_KEY=sk-ant-...
REDDIT_CLIENT_ID=<reddit-app-id>
REDDIT_CLIENT_SECRET=<reddit-app-secret>
REDDIT_REDIRECT_URI=http://localhost:3000/api/reddit/callback
ENCRYPTION_KEY=<random-string-min-32-chars>
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Optional (enables X/Twitter)
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REDIRECT_URI=http://localhost:3000/api/x/callback
XAI_API_KEY=  # xAI Grok API for X search
```

### Install and run

```bash
pnpm install
pnpm db:push          # push schema to database
pnpm dev              # starts Next.js + Redis + Bun worker concurrently
```

The dev script runs three processes:
- **Next.js** dev server on `http://localhost:3000`
- **Redis** server (ephemeral, no persistence)
- **Bun worker** for background job processing

### Database

```bash
pnpm db:generate      # generate migrations from schema changes
pnpm db:push          # push schema directly (development)
pnpm db:studio        # open Drizzle Studio GUI
```

## Project structure

```
src/
├── agents/           # Agent definitions (.md with YAML frontmatter)
├── skills/           # Skill compositions (fan-out configs for agents)
├── tools/            # 24 tools (Reddit, X, HN, web, scoring, SEO, email)
├── core/             # Runtime: query loop, swarm coordinator, pipelines
├── memory/           # Agent memory system (log + distill pattern)
├── workers/          # BullMQ processors (discovery, content, review, posting, ...)
├── app/              # Next.js App Router pages and API routes
├── components/       # React components (dashboard, onboarding, landing, ...)
├── hooks/            # Client-side data fetching hooks (SWR)
├── lib/              # Database schema, env config, queue setup, rate limiter
├── bridge/           # Memory bridge (connects workers to memory system)
└── types/            # Shared TypeScript types
```

## Safety guardrails

- **FTC compliance** — All drafts include affiliation disclosure, enforced by both content and review agents.
- **Value-first** — Drafts must lead with genuine help. Pure promotion is rejected.
- **Community rules** — Scout agent reads actual subreddit rules before recommending engagement.
- **Rate limiting** — Max 3 posts per subreddit per day.
- **Circuit breaker** — Trips on shadowban detection or mod removal. Blocks all posts for 24 hours.
- **Serial posting** — Concurrency of 1 to prevent spam-like patterns.
- **Shadowban detection** — Verifies post visibility after publishing. Trips circuit breaker if detected.

## Testing

```bash
pnpm test:e2e         # run Playwright E2E tests
pnpm test:e2e:ui      # Playwright UI mode
pnpm test:e2e:headed  # run in headed browser
```
