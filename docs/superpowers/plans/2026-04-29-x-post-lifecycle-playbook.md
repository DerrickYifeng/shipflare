# X Post Lifecycle Playbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the post-writer agent to draft X posts that match the founder's product lifecycle phase by rewriting `x-content-guide.md` into a phase-aware playbook and bumping the writer's model from haiku-4-5 to sonnet-4-6.

**Architecture:** Prompt-only enforcement. The post-writer reads `phase` from `query_plan_items` (already plumbed) and follows the matching subsection of a restructured `x-content-guide.md`. No DB schema, no new tools, no validator changes. The model upgrade is what lets us trust prompt-only enforcement.

**Tech Stack:** TypeScript, vitest, Drizzle (read-only here), Markdown reference files inlined by `src/tools/AgentTool/loader.ts`.

**Spec:** `docs/superpowers/specs/2026-04-29-x-post-lifecycle-playbook-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/tools/AgentTool/agents/post-writer/AGENT.md` | Modify | Frontmatter `model` bump; workflow step 3 reads `phase` and applies playbook; `voice` hint vocabulary; `whyItWorks` enrichment |
| `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` | Rewrite | Phase-aware drafting playbook (universal rules + voice clusters + 6-phase rules + bad/good examples) |
| `src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts` | Modify | Pin `model: 'claude-sonnet-4-6'` (line 33 today) |
| `src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts` | Create | Structural tests on the rewritten guide (phase sections, voice clusters, sub-modes) |

---

## Task 1: Bump writer model to sonnet-4-6

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts:33`
- Modify: `src/tools/AgentTool/agents/post-writer/AGENT.md:5`

- [ ] **Step 1: Update the existing model pin (TDD red)**

In `src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts` change line 33:

```diff
-    expect(writer.model).toBe('claude-haiku-4-5-20251001');
+    expect(writer.model).toBe('claude-sonnet-4-6');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts`
Expected: FAIL — assertion mismatch (`claude-haiku-4-5-20251001` !== `claude-sonnet-4-6`).

- [ ] **Step 3: Bump the model in AGENT.md frontmatter**

In `src/tools/AgentTool/agents/post-writer/AGENT.md` change line 5:

```diff
-model: claude-haiku-4-5-20251001
+model: claude-sonnet-4-6
```

`maxTurns: 12` stays unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts`
Expected: PASS — both `it()` blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/AGENT.md \
        src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts
git commit -m "feat(post-writer): bump model to claude-sonnet-4-6

Sonnet's instruction-following lets us encode lifecycle-phase rules
in the content guide and trust prompt-only enforcement, instead of
adding regex validators for banned openers / begging language.
Per spec docs/superpowers/specs/2026-04-29-x-post-lifecycle-playbook-design.md."
```

---

## Task 2: Add structural test scaffold for x-content-guide.md

**Files:**
- Create: `src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`

- [ ] **Step 1: Create the test file**

Create `src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts` with this content:

```ts
// Structural tests for the X content guide. The post-writer relies on
// six phase subsections (one per LaunchPhase value), five named voice
// clusters, and three named steady-phase sub-modes. These tests catch
// accidental section deletion / typos that would silently mismatch the
// AGENT.md vocabulary.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const GUIDE_PATH = path.resolve(
  process.cwd(),
  'src/tools/AgentTool/agents/post-writer/references/x-content-guide.md',
);

const PHASES = [
  'foundation',
  'audience',
  'momentum',
  'launch',
  'compound',
  'steady',
] as const;

const VOICE_CLUSTERS = [
  'terse_shipper',
  'vulnerable_philosopher',
  'daily_vlogger',
  'patient_grinder',
  'contrarian_analyst',
] as const;

const STEADY_SUBMODES = [
  'revenue_flex',
  'contrarian_teacher',
  'sunset',
] as const;

describe('x-content-guide.md structural integrity', () => {
  let guide: string;
  beforeAll(async () => {
    guide = await fs.readFile(GUIDE_PATH, 'utf-8');
  });

  it('contains a top-level "Output contract" section', () => {
    expect(guide).toMatch(/##\s+1\.\s+Output contract/i);
  });

  it('contains a "Universal rules" section enumerating the four hard rules', () => {
    expect(guide).toMatch(/##\s+2\.\s+Universal rules/i);
    expect(guide).toMatch(/280 weighted/i);
    expect(guide).toMatch(/sibling[- ]platform/i);
    expect(guide).toMatch(/unsourced numeric/i);
  });

  it('contains a "Banned openers" section listing all banned phrases', () => {
    expect(guide).toMatch(/##\s+3\.\s+Banned openers/i);
    for (const phrase of [
      'Excited to announce',
      'Excited to share',
      'Big news!',
      'Quick update:',
      'please RT',
    ]) {
      expect(guide).toContain(phrase);
    }
  });

  it('defines all 5 voice clusters in §4', () => {
    expect(guide).toMatch(/##\s+4\.\s+Voice clusters/i);
    for (const cluster of VOICE_CLUSTERS) {
      expect(guide).toContain(cluster);
    }
  });

  it('contains a default-voice-per-phase mapping for every phase', () => {
    for (const phase of PHASES) {
      // Each phase row in §4's defaults table mentions the phase name.
      const re = new RegExp(`\\b${phase}\\b`, 'i');
      expect(guide).toMatch(re);
    }
  });

  it('contains a phase subsection for each LaunchPhase under §5', () => {
    for (const phase of PHASES) {
      // Match e.g. "### 5.1 foundation" — number is flexible, name is fixed.
      const re = new RegExp(`###\\s+5\\.\\d+\\s+${phase}\\b`, 'i');
      expect(guide).toMatch(re);
    }
  });

  it('every phase subsection declares Default voice / Objective / Templates', () => {
    for (const phase of PHASES) {
      const sectionStart = guide.search(
        new RegExp(`###\\s+5\\.\\d+\\s+${phase}\\b`, 'i'),
      );
      expect(sectionStart, `${phase} subsection missing`).toBeGreaterThan(-1);
      // Walk to the end of this subsection (next "### " header or end of file).
      const remainder = guide.slice(sectionStart + 1);
      const nextHeaderIdx = remainder.search(/\n##+\s/);
      const section =
        nextHeaderIdx === -1 ? remainder : remainder.slice(0, nextHeaderIdx);

      expect(section).toMatch(/Default voice/i);
      expect(section).toMatch(/Objective/i);
      expect(section).toMatch(/Templates?/i);
    }
  });

  it('the steady subsection names all three sub-modes', () => {
    const steadyStart = guide.search(/###\s+5\.\d+\s+steady\b/i);
    expect(steadyStart).toBeGreaterThan(-1);
    const remainder = guide.slice(steadyStart + 1);
    const nextHeaderIdx = remainder.search(/\n##\s/);
    const section =
      nextHeaderIdx === -1 ? remainder : remainder.slice(0, nextHeaderIdx);

    for (const mode of STEADY_SUBMODES) {
      expect(section).toContain(mode);
    }
  });

  it('contains a "Bad vs good examples" section', () => {
    expect(guide).toMatch(/##\s+6\.\s+Bad vs good/i);
  });
});
```

Note: vitest's `beforeAll` is auto-imported when used inside `describe`; if your config requires explicit import add `beforeAll` to the import line.

- [ ] **Step 2: Run the test to verify it fails (the guide is still phase-blind)**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: FAIL — most assertions fail because the current guide has none of `## 3. Banned openers`, `## 4. Voice clusters`, the 6 phase subsections, etc. The first universal-rules assertions may pass.

- [ ] **Step 3: Commit the failing test scaffold**

```bash
git add src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts
git commit -m "test(post-writer): structural tests for x-content-guide

Pin the expected section structure (output contract, universal rules,
banned openers, 5 voice clusters, 6 phase subsections, 3 steady
sub-modes, bad/good examples). Currently failing — Tasks 3-10 fill
the guide content."
```

---

## Task 3: Rewrite §1–§4 of x-content-guide.md (universal rules + voice clusters)

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

This task replaces the entire current guide (135 lines) with the new §1–§4. Phases 5.1–5.6 and §6 are added in Tasks 4–10.

- [ ] **Step 1: Replace the file with §1–§4**

Overwrite `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md` with this content:

````markdown
# X Content Guidelines

## 1. Output contract

Output exactly **ONE** single tweet, ≤ 280 weighted chars. Build-in-public on
X is dominated by single tweets — they're sharper, travel further, and respect
the reader's time.

**Hard rule: never emit multiple tweets joined by `\n\n`.** The body must be
a single tweet. No paragraph breaks across tweets, no "And here's why..."
continuation, no bullet expansion into a second tweet.

If the brief feels too rich for one tweet, your job is to **compress**. Cut
the warm-up. Cut the recap. Pick the one specific number / sentence / image
that carries the point and ship that. Almost every "I think this needs more
space" instinct on a build update is wrong — it's a single tweet you haven't
compressed yet.

### Compression heuristics

- Lead with the **specific** thing (number, day, screenshot description),
  not the setup.
- Drop transitional sentences. "Here's the thing" / "Let me explain" → cut.
- Use a colon, dash, or line break instead of full sentences for contrast.
- Push the product mention to the last clause if it appears at all.
- Hashtags go on the last line. `#buildinpublic` plus 0–2 topical tags from
  `#indiehackers / #saas / #aitools / #microsaas`.

## 2. Universal rules

### 2.1 Hard rules — `validate_draft` enforces these

1. **280 weighted chars** — twitter-text accounting: t.co URLs count as 23,
   emoji as 2, CJK as 2, ASCII as 1. The `validate_draft` tool is the source
   of truth — never count by hand.
2. **No links in tweet body** — if a link is needed, set `linkReply` and it
   will be posted as the first reply. (X penalizes reach by ~50% on tweets
   that contain links.)
3. **No sibling-platform leaks** — never mention "reddit", "r/", "subreddit",
   "upvote", "karma" without an explicit contrast marker ("unlike", "vs",
   "instead of", "compared to") in the same sentence.
4. **No unsourced numeric claims** — every percentage / multiplier / `$N` /
   "over N" needs an in-sentence citation ("according to X", "source:", a
   URL, or @handle). If you can't cite it, drop the number.

### 2.2 Style targets — surfaced as warnings

5. **#buildinpublic plus 0–2 topical hashtags** from `#indiehackers / #saas
   / #aitools / #microsaas`. Hard cap: 3 hashtags total.
6. **Write in first person** — "I", "we", "my".
7. **Be specific** — numbers, names, timeframes. "Revenue grew 40% last
   month" beats "Revenue is growing".
8. **No corporate vocabulary** — avoid "leverage", "delve", "comprehensive",
   "robust", "synergy", "ecosystem", "journey".
9. **No emoji overload** — max 1–2 per tweet (each emoji costs 2 weighted
   chars).
10. **Never pitch the product in engagement content** — lead with value,
    stories, lessons.

## 3. Banned openers and begging phrases

These are universal — bad in every phase, every voice, every post type. If
you wrote a draft starting with one of these, rewrite the opener.

**Banned openers:**

- "Excited to announce..."
- "Excited to share..."
- "Big news!"
- "Quick update:"
- "Just wanted to say..."
- "Hey friends,"
- "I'm thrilled to..."

**Banned begging phrases:**

- "please RT"
- "support means everything"
- "any feedback appreciated 🙏"
- "RT if you like it"
- "would mean a lot"

If the post is good, the ask is implicit. If you need to beg, the post
isn't ready.

## 4. Voice clusters

Five voice clusters cover the stylistic range that works on X. Each cluster
is identified by a name; the post-writer's caller can pass any of these as
a `voice` hint to override the phase default.

### terse_shipper
Minimal text, screenshots and numbers carry the post. All-lowercase OK.
Periods optional. One sentence per line. Exemplar: levelsio.
*When to use:* launch day, milestone reveals, anything where the visual or
the number is the point.

### vulnerable_philosopher
Reflective single sentences with sentence-level craft. Complete thoughts,
no padding, no "thread of one". Exemplar: dvassallo.
*When to use:* contrarian takes, post-mortem reflections, lessons from
failure.

### daily_vlogger
Energetic, "Day N" cadence, milestone emoji at peaks (🎉 🚀 💪). Community-
first language. Exemplars: andrewzacker, tibo_maker.
*When to use:* build-out-loud phases — foundation and audience — where
volume + transparency outpaces polish.

### patient_grinder
Sparse, grateful, milestone-only. No daily noise. Posts only when there's a
real number. Exemplar: ryanashcraft.
*When to use:* first-revenue posts, post-launch traction documentation, any
moment where understatement amplifies the signal.

### contrarian_analyst
Hot takes on the meta — industry, AI, competitors, indie norms. References
to specific products / decisions / years. Exemplars: marc_louvion, rauchg.
*When to use:* steady-state thought leadership; teaching from authority.

### Default voice by phase

When the caller does not pass a `voice` hint, use this default:

| Phase | Default voice |
|---|---|
| `foundation` | `daily_vlogger` |
| `audience` | `daily_vlogger` |
| `momentum` | `terse_shipper` |
| `launch` | `terse_shipper` |
| `compound` | `patient_grinder` |
| `steady` | `contrarian_analyst` |

Caller's hint always wins. Free-form strings outside this vocabulary are
accepted; map them to the closest cluster (e.g. "data-led" → `terse_shipper`,
"reflective" → `vulnerable_philosopher`).
````

- [ ] **Step 2: Run structural tests to verify §1–§4 pass**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: §1–§4 tests PASS; the §5 phase-subsection tests still FAIL (we add those next). Specifically:
- "Output contract" → PASS
- "Universal rules" → PASS
- "Banned openers" → PASS
- "Voice clusters" → PASS
- "Default-voice-per-phase mapping" → PASS
- Phase-subsection tests → FAIL
- Steady sub-modes → FAIL
- Bad vs good examples → FAIL

- [ ] **Step 3: Run the loader-smoke test to confirm the guide still loads**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts`
Expected: PASS. The "≤ 280 weighted chars" assertion still resolves.

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): rewrite x-content-guide §1-§4

Output contract, universal rules, banned openers/begging phrases,
and the 5 voice clusters with phase defaults. Replaces the
phase-blind structure that conflated lifecycle stages.
Phase playbook (§5) added in subsequent commits."
```

---

## Task 4: Add §5.1 foundation phase

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5 header and 5.1 foundation subsection**

Append to the end of the file:

````markdown

## 5. By-phase playbook

This is the heart of the guide. Read the plan_item's `phase` field
(`foundation | audience | momentum | launch | compound | steady`), open
the matching subsection below, and apply ITS rules. Do not generalize
across phases — a `foundation` post and a `compound` post are different
shapes even on the same product.

### 5.1 foundation

The founder has no launch date set yet. They're building niche audience
credibility, validating the idea, doing early MVP work. Audience is small
(<2K) but compounding fast if they post consistently.

**Default voice:** `daily_vlogger`

**Objective:** Build credibility through visible, daily work. Attract
early users and validators. Show the build, not the hype.

**Post types to use:** `behind-the-scenes`, `screenshot-only`,
`question`, `poll`, `lesson`, `hot-take` (carefully)

**Hook patterns:** `day-N-log`, `screenshot+caption`, `curiosity-gap`,
`ask`, `contrarian` (sparingly)

**Number anchors:** days building, hours spent, commits, lines shipped,
features-shipped count, waitlist signups, mockup version number.
*Not yet:* MRR, paying customers — those don't exist yet.

**Length target:** 80–200 chars. **Media strongly preferred** (≥78% of
breakouts at this stage have media).

**Phase-specific bans:**
- "making good progress" / "more updates soon" — vague
- "working hard 💪" — empty signal
- Long technical essays without visuals
- Complaining about a problem without your attempt at a solution

**Templates**

**Template 5.1.A — Day-N log**

```
Day N of building [product].
[One specific thing shipped today.]
[Optional: number — hours, commits, signups.]
[Optional: question or ask.]
```

Verbatim example (andrewzacker, 2026-04-04):
> Day 9 of daily build in public video updates.
>
> - How we plan to hit $1k MRR with Content Copilot
> - New project that will help indie hackers with marketing
> - Got first feedback on our SaaS 👀

Source: https://x.com/andrewzacker/status/2040548207697035741

**Template 5.1.B — WIP screenshot + ask**

```
[One sentence describing what's in the screenshot — UI element, flow,
state.]

[Specific feedback ask: "rate 1-10", "would you click this", "which
copy lands harder".]
```

Pair the tweet with an actual screenshot. The screenshot does the
heavy lifting; the caption sets up the ask.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: foundation phase test PASSES; other phases still FAIL.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add foundation-phase playbook to x-content-guide"
```

---

## Task 5: Add §5.2 audience phase

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5.2 audience subsection**

Append to the end of the file:

````markdown

### 5.2 audience

Launch date is set. Founder is 8–28 days from going live. MVP is coming
together; the work shifts from "can I build this" to "will anyone use
this". This is demand-building.

**Default voice:** `daily_vlogger`

**Objective:** Validate demand and grow the waitlist / signup list before
the launch. Every post should make at least one person closer to "yes".

**Post types to use:** `screenshot-only` (mockups + UI WIP), `question`,
`poll`, `behind-the-scenes`, `milestone` (waitlist count)

**Hook patterns:** `screenshot+caption`, `ask`, `curiosity-gap`,
`day-N-log`

**Number anchors:** waitlist signups, days to launch, mockup version,
poll responses, "X people said Y in interviews".
*Not yet:* revenue, paying customers.

**Length target:** 100–220 chars. Media: prefer mockup or poll.

**Phase-specific bans:**
- Detailed technical stack debates (audience doesn't care yet)
- Feature lists without context — show ONE flow, not the menu
- Overpromising launch dates that haven't been committed to in code

**Templates**

**Template 5.2.A — Mockup feedback request**

```
[Screenshot of mockup.]

Would you use this for [specific use case]?

[Optional: one specific question — "is the CTA obvious?", "does this
copy land?".]
```

The ask must be concrete enough that a one-line reply is useful.
"Thoughts?" is a banned ending.

**Template 5.2.B — Waitlist milestone**

```
[N] on the waitlist for [product].

The most-asked question so far: [specific quote or paraphrase from
real signups].

Launching [date].
```

This works because it does three things at once: number anchor,
social proof, and a specific demand signal. The "most-asked
question" is what turns a generic waitlist count into a story.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: audience test PASSES.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add audience-phase playbook to x-content-guide"
```

---

## Task 6: Add §5.3 momentum phase

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5.3 momentum subsection**

Append:

````markdown

### 5.3 momentum

Final week before launch. Last-mile polish, hype building, audience priming.
Cadence climbs to 7–10 posts/week.

**Default voice:** `terse_shipper`

**Objective:** Convert waitlist warmth into launch-day attention. Every
post is a tee-up for the launch tweet.

**Post types to use:** `behind-the-scenes` (countdown), `screenshot-only`
(final UI), `milestone` (e.g. "pricing locked"), `question` (last-call
input)

**Hook patterns:** `screenshot+caption`, `number-led` (countdown),
`milestone-pop`

**Number anchors:** days to launch, hours of sleep lost, finalized
features, signed-up beta testers, pricing tiers.

**Length target:** 80–180 chars. Media required when announcing
finalized assets.

**Phase-specific bans:**
- Walking back launch date publicly (do it privately if you must;
  publicly it kills hype)
- Generic "almost there!" tweets without a specific number or asset
- New feature scope creep announced as a hype post

**Templates**

**Template 5.3.A — Countdown + asset reveal**

```
[N] days until [product] launches.

[One concrete asset reveal — pricing card screenshot, hero copy,
landing page snapshot.]

[Optional: ask for last-mile feedback on this specific asset.]
```

**Template 5.3.B — Pricing reveal with reasoning**

```
Pricing locked for [product]:
[$X] [tier 1 — one-line value]
[$Y] [tier 2 — one-line value]

Why [pricing decision]: [one sentence — the customer-facing reason].
```

The "why" line is what makes this work. A naked pricing card is a
billboard; a pricing card with the customer reason is a story.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: momentum test PASSES.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add momentum-phase playbook to x-content-guide"
```

---

## Task 7: Add §5.4 launch phase

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5.4 launch subsection**

Append:

````markdown

### 5.4 launch

Launch day. The product is live. This phase only lasts a few days but it
produces the most attention per post in the entire lifecycle.

**Default voice:** `terse_shipper`

**Objective:** Maximize first-week traction and prove legitimacy. Make
it easy for people to sign up and easy for early users to share.

**Post types to use:** `launch`, `milestone`, `revenue-update` (first $),
`screenshot-only` (live dashboard / first signups), `behind-the-scenes`

**Hook patterns:** `milestone-pop`, `number-led`, `screenshot+caption`

**Number anchors:** launch-day signups, hour-by-hour traffic, first $,
first paying customer count, Product Hunt rank if applicable.

**Length target:** 100–250 chars for the headline launch tweet. Media
**required** — link in `linkReply`, never in the body.

**Phase-specific bans:**
- "Please RT if you like it ❤️" (banned begging)
- Launch tweet without a screenshot or demo media
- Overhyped claims with no proof ("the best X ever")
- Apologizing pre-emptively ("sorry for the spam, but...")

**Templates**

**Template 5.4.A — "It's live" launch tweet**

```
[product] is live.

[One sentence: what it does for whom.]

[Demo media — 15s screen recording or hero screenshot.]

[Optional: launch-week offer — "first 100 users get [thing]".]
```

The link goes in `linkReply`, NOT in the body. X penalizes body
links by ~50% reach.

**Template 5.4.B — First revenue post**

```
First $[N] for [product].

[One sentence story — who paid, why, how they found it.]

[Stripe / dashboard screenshot.]
```

Verbatim exemplar (synthetic from S3-launch dataset):
> First $127 today. The user who signed up tweeted "finally" — that's
> 7 months of building reduced to one word.

Single tweet, specific number, specific quote, specific timeframe.
That's the breakout shape.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: launch test PASSES.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add launch-phase playbook to x-content-guide"
```

---

## Task 8: Add §5.5 compound phase

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5.5 compound subsection**

Append:

````markdown

### 5.5 compound

First 30 days post-launch. The most breakout-prone phase. First $0 → $1K
MRR, first paying customers, first churn, "I can't believe people are
actually paying for this" — only if true.

**Default voice:** `patient_grinder`

**Objective:** Convert launch attention into durable proof. Every post
should anchor a real number to a real story.

**Post types to use:** `revenue-update`, `milestone`, `lesson`,
`failure`, `behind-the-scenes` (first-customer story)

**Hook patterns:** `number-led` (used in 45% of breakouts at this
stage), `revenue-flex`, `milestone-pop`, `transformation`

**Number anchors:** $MRR (exact, not rounded — `$1,247` not `~$1K`),
paying customers, signups, churn %, conversion %, time since launch.

**Length target:** 120–280 chars. Media: dashboard / Stripe screenshot
strongly preferred (78% of breakouts at this stage have media).

**Phase-specific bans:**
- Vanity metrics divorced from revenue ("we hit 10K page views!" with
  no conversion)
- Generic gratitude posts ("thank you all for the support 🙏")
- Radio silence after launch — the worst move
- Rounded vague numbers ("hit ~$1K MRR" — give the exact figure)

**Templates**

**Template 5.5.A — Revenue update**

```
[product] hit $[exact_number] MRR.

[Bootstrapped? Time to here? One specific context detail.]

[Stripe / dashboard screenshot.]

[Optional: one-line lesson or "what's next".]
```

Verbatim exemplar (ryanashcraft, 2026-04-06):
> Foodnoms has officially hit $50K MRR.
>
> Bootstrapped with no full-time employees. Took 6 and a half years
> to get here.
>
> The grind never stops. Still working to make the product better
> every day. I love this little app. Glad others do too!

Source: https://x.com/ryanashcraft/status/2041244172775301254

That post is technically a `steady`-phase post (>30 days post-launch)
but the structure transfers cleanly to compound: exact number,
context, screenshot, one-line attitude.

**Template 5.5.B — First churn / first failure**

```
First [churn / refund / killed feature] for [product].

[One sentence: what happened.]

[One sentence: why it happened, with data if you have it.]

[One sentence: what you're doing about it.]
```

Failure posts in compound consistently outperform vanity success
posts. The audience is rooting for the underdog story.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: compound test PASSES.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add compound-phase playbook to x-content-guide"
```

---

## Task 9: Add §5.6 steady phase with three sub-modes

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §5.6 steady subsection**

Append:

````markdown

### 5.6 steady

30+ days post-launch. The phase covers everything from "$1K MRR
post-launch traction" through "$300K MRR thought-leader" through
"sunsetting after six years". It carries three sub-modes — pick the
one that matches the input.

**Default voice:** `contrarian_analyst`

**Sub-mode selection (read the spawn prompt):**

| Caller signal | Sub-mode |
|---|---|
| Concrete revenue / user-count / years numbers passed in | `revenue_flex` |
| `sunsetting: true` or `pivoting: true` flag | `sunset` |
| Otherwise (default) | `contrarian_teacher` |

---

#### Sub-mode 5.6.a — `revenue_flex`

Annual reflection or major-milestone post. The number is the lede; the
story is the proof.

**Suggested voice:** `patient_grinder` or `terse_shipper` (override the
phase default when in revenue_flex).

**Number anchors:** total MRR / ARR, years to here, total customers,
team size, runway.

**Template 5.6.a.A — Annual reflection**

```
[N] years to $[X] [MRR | ARR | total revenue].

[One specific lesson — narrowest, most concrete.]
[One thing that surprised you.]
[Optional: advice to your earlier self.]
```

#### Sub-mode 5.6.b — `contrarian_teacher`

Default mode. Hot takes on the indie meta, "what I wish I knew at $0",
systems and playbooks, observations from N years of building.

**Suggested voice:** `contrarian_analyst` or `vulnerable_philosopher`.

**Number anchors:** years building, products shipped, products killed,
customers served, hiring count.

**Template 5.6.b.A — Contrarian one-liner**

```
[Strong opinion that contradicts a common indie take, in <15 words.]
```

Verbatim exemplar (dvassallo, 2026-04-25):
> You only need to define revenue when you've been faking it.

Source: https://x.com/dvassallo/status/2048167053148959135

That's the entire post. 60 chars, contrarian, lands.

**Template 5.6.b.B — Teacher reflection**

```
[The thing most people get wrong about X.]

[Your concrete counter-experience — specific number, specific year,
specific company.]

[Implication for the reader.]
```

#### Sub-mode 5.6.c — `sunset`

Sunset, pivot, or sale announcement. Honesty wins; blame loses.

**Suggested voice:** `vulnerable_philosopher`.

**Number anchors:** peak MRR / ARR, total revenue earned, total
customers, years of operation.

**Template 5.6.c.A — Sunset announcement**

```
[Headline: "We're sunsetting [product]" or "Pivoting to [Y]".]

[Peak number — peak MRR, total customers, years.]

[One-sentence reason — the real one, not "market wasn't ready".]

[Optional: what's next, or thank-you to customers if they were the
core of it.]
```

NEVER use this template to soft-launch a hard sell on a new thing.
Sunset posts that immediately pivot to "anyway, here's my new
project" lose trust. Wait at least a week.
````

- [ ] **Step 2: Run structural tests**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: steady test PASSES; the steady-sub-modes test PASSES.

- [ ] **Step 3: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add steady-phase playbook with 3 sub-modes"
```

---

## Task 10: Add §6 bad vs good examples

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/references/x-content-guide.md`

- [ ] **Step 1: Append §6**

Append:

````markdown

## 6. Bad vs good examples

### 6.1 Multi-tweet output (BAD) vs single compressed tweet (GOOD)

**BAD — paragraph-broken multi-tweet output**

```
I shipped a feature on Tuesday I was proud of. Took 3 days.

By Wednesday morning I realized: no one knew about it.

So I spent the next 6 hours:
- Writing the same update in 3 voices
- Searching for communities
- Rewriting it for each platform's norms

That's why we're building ShipFlare.

#buildinpublic #indiehackers
```

Why this fails: it's split into multiple tweets via blank lines. The
platform only sends one tweet — extra paragraphs get dropped on the
floor.

**GOOD — single compressed tweet**

```
Tuesday: 3 days to ship a feature I was proud of.
Wednesday: 6 hours figuring out which voice, which community, which
platform's norms.
The build took 3 days. The hustle took 6 hours.
That's the gap we're building ShipFlare to close. #buildinpublic
```

Same idea, one tweet, ~245 chars, every clause earns its space.

### 6.2 Phase-mismatch example

**BAD — Day-N log written from `steady` phase**

```
Day 47 of building ShipFlare 💪
Today: refactored the validators.
Long way to go but excited!
```

Why this fails: the founder is at $50K MRR and three years post-launch.
"Day 47" reads as either tone-deaf or fake. The audience expects scale-
phase content (reflection, contrarian take, system-level lesson).

**GOOD — same founder, `steady.contrarian_teacher` post**

```
3 years in, the validators we shipped on day 47 still catch 90% of
bad drafts. The other 10% is what 3 years of editing taught me to
write into the prompt.
```

Same product, same engineer, same fact — completely different shape
because the phase changed.

### 6.3 Banned-opener rewrite

**BAD**

```
Excited to announce that we just shipped revenue analytics for
ShipFlare! 🎉
```

**GOOD**

```
Revenue analytics shipped for ShipFlare.
First user to try it: spotted a $1,247/mo retention leak inside 4
minutes. That's what this was for.
```

The banned opener is replaced with the specific number + the user
story that proves the feature mattered.
````

- [ ] **Step 2: Run structural tests — all should pass now**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/references/__tests__/x-content-guide.test.ts`
Expected: ALL tests PASS.

- [ ] **Step 3: Run loader-smoke test to verify the guide still inlines**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/references/x-content-guide.md
git commit -m "feat(post-writer): add §6 bad/good examples (multi-tweet, phase mismatch, banned opener)"
```

---

## Task 11: Update AGENT.md workflow + voice hint vocabulary + whyItWorks

**Files:**
- Modify: `src/tools/AgentTool/agents/post-writer/AGENT.md`

- [ ] **Step 1: Replace the "Draft the body" paragraph (X half) in workflow step 3**

Open `src/tools/AgentTool/agents/post-writer/AGENT.md`. Find the existing X-drafting paragraph in step 3 of the workflow (currently lines ~85–94 in the file shown in the spec — search for "Pick a content type for voice + structure"). Replace the X portion with:

```markdown
   For X: **output is exactly ONE single tweet ≤280 weighted chars.**

   Read `phase` from the plan_item row you just loaded — it is one of
   `foundation | audience | momentum | launch | compound | steady`.
   Open the matching subsection of x-content-guide §5 ("By-phase
   playbook") and apply the rules from THAT subsection: post types,
   hook patterns, number anchors, banned moves, length target, and
   the verbatim templates for that phase. Do NOT generalize across
   phases — a `foundation` post and a `compound` post are different
   shapes even on the same product.

   For voice: if the caller's spawn prompt passed a `voice` hint (one
   of `terse_shipper | vulnerable_philosopher | daily_vlogger |
   patient_grinder | contrarian_analyst`), use it. Otherwise use the
   phase default from x-content-guide §4. Free-form voice strings
   (e.g. "data-led", "reflective") are still accepted — map them to
   the closest cluster.

   For phase=steady: pick a sub-mode based on what the caller
   supplied. Concrete revenue / user-count / years numbers in the
   spawn prompt → `revenue_flex`. `sunsetting` or `pivoting` flag →
   `sunset`. Otherwise → `contrarian_teacher` (default).

   Multi-tweet threads are not supported — if the brief feels too
   rich for one tweet, compress: cut the warm-up, drop transitional
   sentences, lead with the specific thing, push the product mention
   to the last clause.
```

(The Reddit drafting paragraph that follows stays unchanged.)

- [ ] **Step 2: Update the `voice` soft-hints line**

In the same file, find the soft hints list under "Your input (passed by caller as prompt)". Replace the existing `voice` line:

```diff
-  - `voice` — voice override (e.g. "terse", "data-led")
+  - `voice` — voice cluster: one of `terse_shipper |
+    vulnerable_philosopher | daily_vlogger | patient_grinder |
+    contrarian_analyst`. Free-form strings still accepted but the
+    cluster names map cleanly to x-content-guide §4. When omitted,
+    the writer uses the phase default.
```

- [ ] **Step 3: Add the `whyItWorks` enrichment instruction**

Find step 6 of the workflow ("Persist via `draft_post`."). After the existing `draft_post` bullet, add:

```markdown
     For X drafts, `whyItWorks` MUST identify the resolved phase, voice
     cluster, and template ID, e.g.:
       "compound-phase first-revenue update in patient_grinder voice,
        leads with $1,247 MRR per template 5.5.A"
     Reviewers use this to see which playbook section produced each
     draft. For Reddit drafts, the existing one-sentence angle
     justification is fine.
```

- [ ] **Step 4: Run loader-smoke to verify AGENT.md still parses**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/__tests__/loader-smoke.test.ts`
Expected: PASS — `model: 'claude-sonnet-4-6'` still pinned, all 6 tools still listed, 3 references still inlined.

- [ ] **Step 5: Run the full content-guide suite**

Run: `pnpm vitest run src/tools/AgentTool/agents/post-writer/`
Expected: all post-writer tests PASS — both `__tests__/loader-smoke.test.ts` and `references/__tests__/x-content-guide.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/AgentTool/agents/post-writer/AGENT.md
git commit -m "feat(post-writer): teach AGENT.md to read phase + voice cluster

Workflow step 3 now reads plan_items.phase and applies the matching
x-content-guide §5 subsection. Voice hint vocabulary tightened to
the 5 named clusters from x-content-guide §4 (free-form still
accepted, mapped to closest). whyItWorks enriched with phase +
voice + template ID for reviewer visibility."
```

---

## Task 12: Final verification + manual smoke pass record

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full agent-tool test suite**

Run: `pnpm vitest run src/tools/AgentTool/`
Expected: ALL agent-tool tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm tsc --noEmit --pretty false`
Expected: exit code 0. (No new TS files in this change, but the model bump touches a frontmatter literal that the loader already validates with zod.)

- [ ] **Step 3: Manual smoke pass — record one draft per phase**

Run the post-writer against six plan_items, one for each `LaunchPhase`
value. Use whatever interactive runner the project has (typically
the engine harness or a dev API route). For each phase, confirm:

| Phase | Expected behavior |
|---|---|
| `foundation` | Hook is `day-N-log` or `screenshot+caption`. No revenue numbers. Caller-free voice → `daily_vlogger`. |
| `audience` | Mockup feedback or waitlist milestone. Days-to-launch number. |
| `momentum` | Countdown with specific asset reveal. |
| `launch` | "Live" + demo media + first $ shape. No links in body (linkReply set). |
| `compound` | Exact-MRR number, screenshot ref, story. |
| `steady` (no hints) | Contrarian one-liner or teacher reflection. |
| `steady` with `mrr: 50000` hint | Annual reflection / revenue_flex template. |
| `steady` with `sunsetting: true` hint | Honest sunset post. No "anyway, here's my new thing". |

Record each draft (full text + chosen template ID + chosen voice
cluster from `whyItWorks`) in the PR description.

- [ ] **Step 4: Confirm `whyItWorks` enrichment is present**

Spot-check at least 3 of the 8 drafts above and verify `whyItWorks`
in the persisted plan_item.output identifies the resolved phase,
voice, and template ID.

- [ ] **Step 5: No commit at this step (verification only)**

This task produces no code changes — its output is the manual smoke
record in the PR description.

---

## Self-review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Phase ↔ Grok-stage mapping | Tasks 4–9 (one task per ShipFlare phase, ordered foundation → steady) |
| Voice cluster vocabulary + phase defaults | Task 3 (§4) |
| Steady sub-modes (revenue_flex / contrarian_teacher / sunset) | Task 9 (§5.6) |
| What changes — guide rewrite | Tasks 3–10 |
| What changes — AGENT.md model bump | Task 1 |
| What changes — AGENT.md workflow + hints + whyItWorks | Task 11 |
| What changes — structural tests | Task 2 (scaffold), Tasks 4–10 (verify per phase) |
| What changes — model pin test | Task 1 |
| Universal rules + banned openers | Task 3 (§2 + §3) |
| Bad vs good examples (incl. phase mismatch + banned opener) | Task 10 |
| Manual smoke pass | Task 12 |
| What does NOT change | Verified by running existing tests at Tasks 1, 3, 10, 11, 12 |

No spec gaps.

**Placeholder scan:** No `TBD`, `TODO`, `implement later`, or "similar to Task N" references. Each task carries the verbatim content it adds.

**Type consistency:** No new TS types introduced; the only TS edit is the test pin at Task 1, which references the existing `WriterAgent.model` field that the loader already produces. AGENT.md frontmatter shape is validated by the existing `frontmatterSchema` zod parser in `src/tools/AgentTool/loader.ts` — no new fields.
