# ShipFlare

AI marketing autopilot for indie developers. Discover communities, engage conversations, and grow your presence — all on autopilot.

ShipFlare deploys a pipeline of AI agents that find where your users hang out, join relevant conversations with helpful replies, publish product launches and updates, and keep your community presence active across Reddit, X, Hacker News, and more. Every piece of content is reviewed for quality and FTC compliance before it goes live.

## How it works

```
Connect Product → AI Scan → Community Discovery → Thread Scoring → Draft Generation → Review → Post
```

1. **Onboarding** — Connect your product via GitHub repo or website URL. GitHub import scans your codebase for tech stack, key files, and context. Website import scrapes your homepage and runs an SEO audit. Both feed into a unified product profile that agents reference for every piece of content they generate.
2. **Discovery** — AI agents crawl Reddit, X, and Hacker News to find communities and conversations where your product is relevant.
3. **Scoring** — Threads are scored across five dimensions: relevance, intent, exposure, freshness, and engagement.
4. **Drafting** — A content agent writes contextual replies that lead with genuine help, not promotion. Every draft includes FTC disclosure.
5. **Review** — An adversarial reviewer checks relevance, tone, authenticity, compliance, and risk. Only `PASS` drafts reach your queue.
6. **Posting** — Approved drafts are posted to Reddit/X with rate limiting, shadowban detection, and circuit breaker protection.

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

| Agent | Model | Role |
|-------|-------|------|
| Scout | Haiku 4.5 | Discovers communities and reads subreddit rules |
| Discovery | Haiku 4.5 | Generates search queries, finds threads, scores relevance |
| Analyst | Haiku 4.5 | Deep-dives threads, classifies intent, decides engagement strategy |
| Content | Sonnet 4.6 | Drafts contextual, value-first replies |
| Draft Review | Haiku 4.5 | Adversarial quality gate (6 mandatory checks) |
| Posting | Haiku 4.5 | Posts to Reddit/X, verifies visibility, detects shadowbans |

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
├── tools/            # 19 tools (Reddit, X, HN, web, scoring, SEO)
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
