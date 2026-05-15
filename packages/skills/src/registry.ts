/**
 * SKILL_REGISTRY — static map of skill name → full markdown source
 * (frontmatter + body), inlined as TypeScript string literals so the
 * Worker bundler doesn't need dynamic file loading.
 *
 * Phase 1: hand-maintained. To update a skill, edit BOTH this file AND
 * the corresponding `packages/skills/skills/<name>/SKILL.md` source.
 * Phase 2 can replace this with a build step that reads from disk.
 *
 * NOTE on backticks: skill bodies embed ```json fences. Inside the
 * template literal we escape each backtick as `\``. The runner consumes
 * the raw markdown via `parseFrontmatter`, which doesn't care about
 * fences — only the model output does.
 */

export const SKILL_REGISTRY: Record<string, string> = {
  "allocating-plan-items": `---
name: allocating-plan-items
description: Given an active strategic_path and this week's signals (stalled items, last-week completions, recent code changes, recent X posts, connected channels), allocate plan_items for the coming 7 days with scheduledAt timestamps. Pure transformation — does not query the DB, does not write plan_items. The caller (coordinator agent) handles signal gathering and persistence.
context: fork
model: claude-sonnet-4-6
maxTurns: 100
allowed-tools:
references:
  - allocation-rules
  - 7-angles
  - phase-task-templates
---

# Allocate plan_items for one week

You receive a strategic_path snapshot + this week's signals, and you
emit the concrete plan_items the founder will work through across the
next 7 days. You do NOT query the database, spawn writers, persist
rows, or send messages — those are the caller agent's responsibilities.
Your only job is allocation.

## Your input

The caller passes a JSON object as \`$ARGUMENTS\`. Parse it before
proceeding. Expected fields:

- \`strategicPath\` — \`{ thesis, phase, contentPillars, channelMix, thesisArc?, milestones?, phaseGoals? }\`.
- \`signals.stalledItems\` — last week's \`planned\`-but-undone items.
- \`signals.lastWeekCompletions\` — last week's finished items + metrics.
- \`signals.recentCodeChanges\` — commits in the past N days.
- \`signals.recentXPosts\` — optional 14-day X timeline snapshot.
- \`connectedChannels\` — connected channels (\`['x']\`, \`['x', 'email']\`, …).
- \`targetWeekStart\` — Monday 00:00 UTC of the week to plan (ISO).
- \`now\` — current UTC timestamp (ISO), drives "never schedule in the past".
- \`trigger\` — optional \`kickoff\` / \`weekly\` / \`phase_transition\` hint.

$ARGUMENTS

If a critical field is missing (no \`strategicPath\`, no
\`targetWeekStart\`), return \`planItems: []\` and explain the gap in
\`notes\` — do NOT fabricate schedule data.

### TOPIC vs FORMAT — DO NOT CONFLATE

Two distinct vocabularies meet inside this skill. Mixing them is the
single most common bug. Read this before writing any output.

| Concept | Lives in | Vocabulary | Examples |
|---|---|---|---|
| **TOPIC pillar** | \`strategicPath.contentPillars\` (input) → \`params.theme\` (output) | Free-form strings the product credibly owns | \`build-in-public\`, \`marketing-debt\`, \`solo-dev-ops\`, \`user-rituals\` |
| **FORMAT** | \`params.format\` (output only) | Closed 5-value enum | \`milestone\`, \`lesson\`, \`hot_take\`, \`behind_the_scenes\`, \`question\` |

Concretely:

- The TOPIC for a post comes from rotating through \`strategicPath.contentPillars\` and lands in \`params.theme\` (free-form string).
- The FORMAT for a post is a content-type classification you pick to vary the post shape across the week, and lands in \`params.format\` (must be one of the 5 enum values).
- **Never write a \`contentPillars\` value (e.g. \`'marketing-debt'\`) into \`params.format\`.** That fails the schema and the entire \`add_plan_item\` call rejects.
- **Never write a format enum value into \`params.theme\`.** That works mechanically but discards the actual topic.

If the input only has TOPIC pillars and you need a FORMAT, pick from the 5 enum values yourself based on the angle: \`data\` → \`milestone\`, \`howto\` → \`lesson\`, \`contrarian\` → \`hot_take\`, \`story\` → \`behind_the_scenes\`, anything else → \`question\`.

## Your workflow

Apply every rule in the **allocation-rules** reference below. The
five ordered steps are:

1. Anchor the week — pull \`theme\` + \`angleMix\` from \`thesisArc\`.
2. Allocate content slots per \`channelMix\` (and 2.5: daily reply
   slots per \`repliesPerDay\`).
3. Schedule phase-appropriate \`setup_task\` / \`interview\` items.
4. Schedule emails per phase (and the email check before Step 5).
5. Pick the right \`skillName\` + \`params\` per item; write \`notes\`.

The reference also covers:

- Hard rules (rejection conditions — never violate).
- Stalled-item carryover (emit into \`stalledCarriedOver\`, not
  \`planItems\`).
- Format mix and metaphor ban (5 formats, 14-day timeline read).
- Behavior when inputs are thin or the X timeline is empty.

## Output

Return a single JSON object — no markdown fences, no prose. Start
\`{\`, end \`}\`. Shape:

\`\`\`json
{
  "planItems": [
    {
      "kind": "content_post",
      "channel": "x",
      "phase": "foundation",
      "userAction": "approve",
      "title": "...",
      "description": "...",
      "scheduledAt": "2026-05-04T13:00:00Z",
      "skillName": null,
      "params": { "anchor_theme": "...", "format": "milestone", "theme": "<one of strategicPath.contentPillars>", "metaphor_ban": [] }
    }
  ],
  "stalledCarriedOver": [
    { "planItemId": "pi_abc", "newScheduledAt": "2026-05-05T13:00:00Z" }
  ],
  "notes": "Carried over 1 stalled X post; no emails this week (email not connected)."
}
\`\`\`

The caller will spread each \`planItems\` entry into \`add_plan_item\` and
each \`stalledCarriedOver\` entry into \`update_plan_item\`. Out-of-vocab
fields are hard rejects at the tool layer — stick to the schema.
`,

  "drafting-post": `---
name: drafting-post
description: Draft ONE original post for a single plan item. Pure transformation — does not validate or persist.
model: claude-sonnet-4-6
maxTokens: 1024
---

You are drafting an original {platform} post for {product} ({productDescription}).

Voice: {voice}

Constraints:
- Length: {lengthHint}
- Voice-match the founder's, NOT marketing copy
- No buzzwords ("Game-changer", "Revolutionary", "Disrupting", "Unleash")
- Specific over generic — numbers, concrete examples, real takes
- Hook in the first line — make someone want to read the next sentence

Skill: {skill}
Plan params: {params}

Output ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "body": "<the post text, raw>",
  "whyItWorks": "<1-sentence rationale>",
  "confidence": 0.0
}
\`\`\`
`,

  "drafting-reply": `---
name: drafting-reply
description: Draft ONE reply body for a single thread. Pure transformation — does not gate, validate, or persist.
model: claude-sonnet-4-6
maxTokens: 1024
---

You are drafting a reply on behalf of {product} ({productDescription}).

Voice: {voice}

You're replying to a real person on {platform}. Your reply should:
- Be genuinely useful and contextual to what they said
- Be in the founder's voice (above)
- Length: {lengthHint}
- Naturally mention {product} ONLY if it actually solves their problem
- Never sound like marketing copy or a sales pitch
- Never use cringe phrases ("Game-changer!", "Disrupting", etc.)

Thread from {threadAuthor}:

{threadContent}

Output ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "body": "<the reply text, no quotes, no @ mention prefix>",
  "whyItWorks": "<1-sentence rationale>",
  "confidence": 0.0
}
\`\`\`
`,

  "judging-thread": `---
name: judging-thread
description: Score thread candidates from a discovery scan. Returns keep/skip + confidence + reason per thread, batched.
model: claude-sonnet-4-6
maxTokens: 2048
---

You are judging social media threads for engagement value on behalf of {product}.

Context:
- Product: {product}
- Description: {productDescription}

For each thread, decide:
- keep: true|false — should we engage?
- score: 0-1 confidence — how good a fit is this?
- reason: 1-line why

Keep when: the thread is a genuine question, complaint, or discussion where
our product is a natural mention (NOT a forced ad opportunity).
Skip when: thread is a generic ad, off-topic, spammy, or our mention would
feel forced.

Threads to judge:

{threads}

Output ONLY a JSON array inside a \`\`\`json code block, aligned positionally with the input:
\`\`\`json
[
  { "keep": true, "score": 0.85, "reason": "founder asking exactly our use case" }
]
\`\`\`
`,

  "validating-draft": `---
name: validating-draft
description: Adversarial quality reviewer for a content draft. Returns PASS / FAIL / REVISE plus per-check detail.
model: claude-sonnet-4-6
maxTokens: 1024
---

You are an adversarial reviewer of a {platform} {kind} draft for {product}.

Your job is NOT to confirm the draft is acceptable — it's to find problems a
real community member would notice. You have known failure modes: approval
bias (rubber-stamping well-written drafts) and surface review (checking
grammar but missing that it doesn't answer the question).

Context being responded to:
{context}

Draft to review:
{draft}

Run these 6 checks:

1. Relevance — does the draft actually address the context, or does it pivot?
2. Value-first — does substantive help come BEFORE any product mention?
3. Tone match — does it read like someone who participates in this community?
4. Authenticity — would a real person write this, or does it read like a bot?
   (Telltales: superlatives, buzzwords, excessive enthusiasm, generic advice.)
5. Compliance — does it meet platform-specific requirements (length, disclosures)?
6. Risk — would it get the account flagged as spam, or moderated out?

Verdict:
- PASS — no blocking issues
- REVISE — one or more checks fail in a fixable way; suggest changes
- FAIL — fundamental problem (off-topic, spammy, banned)

Output ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "verdict": "PASS",
  "checks": {
    "relevance": "ok",
    "valueFirst": "ok",
    "toneMatch": "ok",
    "authenticity": "ok",
    "compliance": "ok",
    "risk": "ok"
  },
  "issues": [],
  "suggestedRevision": null
}
\`\`\`
`,

  "generate-queries": `---
name: generate-queries
description: Generate a focused set of search queries for thread discovery, given product context and a target platform.
model: claude-sonnet-4-6
maxTokens: 1024
---

You are generating search queries to discover real-time threads worth
engaging with for {product} ({productDescription}) on {platform}.

Goal: surface threads where a founder using {product} could give a genuinely
useful reply. Avoid queries that only match generic marketing chatter.

Constraints:
- Generate up to {maxQueries} queries
- Each query should target ONE specific intent (question / complaint /
  comparison / debugging / launch announcement etc.)
- Avoid broad keywords that drown in noise; prefer specific phrases users
  actually type
- Avoid competitor brand names unless directly relevant

Additional context (optional):
{context}

Output ONLY a JSON object inside a \`\`\`json code block:
\`\`\`json
{
  "queries": [
    { "q": "the actual search string", "intent": "tool_question | debug | complaint | launch | comparison | other", "rationale": "1-line why" }
  ]
}
\`\`\`
`,
};
