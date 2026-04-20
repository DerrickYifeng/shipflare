# Skill catalog (markdown re-export)

> This file is a markdown mirror of `src/skills/_catalog.ts`, injected into the
> tactical-planner prompt so the planner can pick valid `skillName` values
> when emitting plan items. Kept in sync by hand — if _catalog.ts grows, update
> both.

Each row describes one skill: the canonical `name` (must appear in
`plan_items.skillName` exactly as written), what it does, which plan_item
kinds it executes, and any channel filter. `channels` is absent = platform-
agnostic; the planner must only use the skill on channels in its list.

## Content atoms

| name | description | supportedKinds | channels |
|---|---|---|---|
| `draft-single-post` | Draft one original post (tweet or thread) for one plan_item of kind content_post. | `['content_post']` | `['x']` |
| `draft-single-reply` | Draft one reply to a monitored post or discovered thread. | `['content_reply']` | `['x']` |

## Email atoms

| name | description | supportedKinds | channels |
|---|---|---|---|
| `draft-email` | Draft one lifecycle / transactional email. Branched by emailType. | `['email_send']` | — |
| `send-email` | Send a drafted email via Resend (no LLM). | `['email_send']` | — |
| `ab-test-subject` | Two subject variants for one email. Inline utility; dispatcher chains between draft and send. | `[]` | — |

## Launch-asset atoms

| name | description | supportedKinds | channels |
|---|---|---|---|
| `build-launch-runsheet` | Hourly runsheet for launch day. Each beat becomes a runsheet_beat row. | `['launch_asset']` | — |
| `draft-hunter-outreach` | One personalized DM to one PH hunter. | `['launch_asset']` | — |
| `draft-launch-day-comment` | Pinned maker comment for PH launch. | `['launch_asset']` | — |
| `draft-waitlist-page` | HTML + addressable copy for one waitlist page. | `['launch_asset']` | — |
| `generate-launch-asset-brief` | Text brief for designer / video team. Does NOT render the asset. | `['launch_asset']` | — |

## Research / analytics atoms

| name | description | supportedKinds | channels |
|---|---|---|---|
| `analytics-summarize` | Weekly analytics summary + recommended next moves. | `['analytics_summary']` | — |
| `identify-top-supporters` | Rank up to 30 accounts by weighted engagement events. | `['analytics_summary']` | — |
| `compile-retrospective` | Long-form retrospective post (launch / sprint / quarter). | `['analytics_summary']` | — |
| `extract-milestone-from-commits` | Pick the highest-signal milestone from a git window. | `[]` (inline gate) | — |
| `fetch-community-rules` | Classify a subreddit's self-promotion policy. | `[]` | `['reddit']` |
| `fetch-community-hot-posts` | Top formats + avg engagement + one insight. | `[]` | `['reddit']` |
| `generate-interview-questions` | Exactly 10 questions tailored to intent. | `['interview']` | — |

## Utility

| name | description | supportedKinds | channels |
|---|---|---|---|
| `classify-thread-sentiment` | One thread → pos/neg/neutral/mixed + confidence. | `[]` (inline classifier) | — |

## Existing executors (pre-Phase-5)

| name | description | supportedKinds | channels |
|---|---|---|---|
| `discovery` | Search a single platform source for on-topic threads. | `[]` | — |
| `draft-review` | Adversarial quality check for a drafted post/reply. | `[]` (inline gate) | — |
| `posting` | Publish an approved draft to its platform. Serial, no retry. | `[]` (terminal step) | — |
| `voice-extractor` | Extract voice profile from historical posts. | `['setup_task']` | — |

## Planner atoms (self-reference)

| name | description | supportedKinds | channels |
|---|---|---|---|
| `strategic-planner` | Upstream framer. Only called at onboarding + phase change. | `[]` | — |
| `tactical-planner` | This skill. Emits plan_items for a 7-day window. | `[]` | — |

## Rules for the tactical planner

- Pick the first skill in the list whose `supportedKinds` contains the
  item's `kind` AND whose `channels` (if present) contains the item's
  `channel`.
- If no skill matches (e.g. `setup_task` with no skill), emit
  `skillName: null` and `userAction: 'manual'`.
- Never invent a `skillName` that isn't in this table.
- `send-email` is chained downstream from `draft-email` by the Phase 7
  dispatcher — the tactical planner does NOT emit `send-email` rows
  directly; emit `draft-email` with `kind: 'email_send'` and the
  dispatcher handles the second step.
