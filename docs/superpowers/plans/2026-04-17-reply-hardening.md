# Reply Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate AI-slop tells from X reply drafts, consolidate the archetype surface, and move product-mention decisions out of the drafter prompt — so replies read human, respect algorithm weights, and stop leaking "DM me I can help" energy.

**Architecture:** Add two deterministic post-generation validators (AI-slop + anchor-token) as pure functions. Consolidate 15 archetypes → 6 in the reference doc. Introduce a new `product-opportunity-judge` agent that runs before `reply-drafter` and emits a boolean eligibility flag consumed by the drafter prompt. Validators + judge are composed in the reply pipeline; the drafter prompt becomes thinner (policy lives in validators and judge, not in prose).

**Tech Stack:** TypeScript, Vitest, Zod, existing skill-runner / agent definitions, Drizzle (no schema changes in this plan).

**Research grounding:** [Reply AI-slop patterns](https://aisolo.beehiiv.com/p/these-17-ai-slop-patterns-are-killing-your-content), [em-dash tell](https://www.seangoedecke.com/em-dashes/), [X algorithm 2026 — reply-to-author = 150× like](https://posteverywhere.ai/blog/how-the-x-twitter-algorithm-works), [engagement bait penalties](https://successonx.com/guides/what-to-avoid/twitter-engagement-bait-traps).

---

## File Structure

### New files
- `src/lib/reply/ai-slop-validator.ts` — pure-function validator; regex + token checks; no I/O
- `src/lib/reply/anchor-token-validator.ts` — pure-function anchor-token detector
- `src/lib/reply/__tests__/ai-slop-validator.test.ts`
- `src/lib/reply/__tests__/anchor-token-validator.test.ts`
- `src/agents/product-opportunity-judge.md` — new agent prompt
- `src/skills/product-opportunity-judge/SKILL.md` — skill wrapper (consistency with existing pattern)
- `src/agents/__tests__/product-opportunity-judge.test.ts`

### Modified files
- `src/skills/reply-scan/references/x-reply-rules.md` — consolidate archetypes, update forbidden list, add anchor-token requirement, update examples
- `src/agents/reply-drafter.md` — strip archetype list from prose, consume `canMentionProduct`, reference new validator rules
- `src/agents/schemas.ts` — add `productOpportunityJudgeOutputSchema`, narrow `replyDrafterOutputSchema.strategy` to union of 6 archetypes, relax back to string only if drafter must emit `skip`
- `src/workers/processors/engagement.ts` OR `src/workers/processors/monitor.ts` — wire judge before drafter, wire validators after drafter (need to grep to confirm which processor owns the reply loop)
- `src/skills/reply-scan/SKILL.md` — document the new validator step in workflow section

---

## Scope boundaries (what this plan does NOT do)

- No DB schema changes (voice profile + reply feedback tables belong to Plans 2 and 3).
- No change to `slot-body-agent` (original-post content generation).
- No n-gram repetition monitor across last-100 replies (needs persistence, deferred to Plan 3 alongside voice feedback loop).
- No calendar-planner changes (Plan 2).
- Existing `strategy: "skip"` flow is preserved — this plan strengthens reject criteria, does not change the skip contract.

---

## Task 1: AI-slop validator — core patterns (TDD)

**Files:**
- Create: `src/lib/reply/ai-slop-validator.ts`
- Test: `src/lib/reply/__tests__/ai-slop-validator.test.ts`

- [ ] **Step 1.1: Write failing tests for the 7 AI-slop patterns**

```typescript
// src/lib/reply/__tests__/ai-slop-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateAiSlop } from '../ai-slop-validator';

describe('validateAiSlop', () => {
  it('passes a clean reply', () => {
    const result = validateAiSlop('$10k is the hard one. the second 10k is faster.');
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rejects em-dash overuse (2+ em-dashes)', () => {
    const result = validateAiSlop('this is great — really great — couldn\u2019t agree more');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('em_dash_overuse');
  });

  it('rejects binary "not X, it\'s Y" construction', () => {
    const result = validateAiSlop("it's not just speed, it's precision.");
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('binary_not_x_its_y');
  });

  it('rejects preamble openers (great post, interesting take, as someone who)', () => {
    for (const draft of [
      'Great post! this resonates.',
      'Interesting take on pricing.',
      'As someone who has shipped 3 products, agree.',
      'I noticed you mentioned churn.',
    ]) {
      const result = validateAiSlop(draft);
      expect(result.pass, `failed to reject: ${draft}`).toBe(false);
      expect(result.violations).toContain('preamble_opener');
    }
  });

  it('rejects banned AI vocabulary', () => {
    for (const word of ['delve', 'leverage', 'utilize', 'robust', 'crucial', 'demystify', 'landscape']) {
      const result = validateAiSlop(`you should ${word} the opportunity`);
      expect(result.pass, `failed on word: ${word}`).toBe(false);
      expect(result.violations).toContain('banned_vocabulary');
    }
  });

  it('rejects triple-grouping rhythm ("fast, efficient, reliable")', () => {
    const result = validateAiSlop('built it to be fast, efficient, and reliable.');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('triple_grouping');
  });

  it('rejects negation cadence ("no fluff. no theory. just results.")', () => {
    const result = validateAiSlop('no fluff. no theory. just results.');
    expect(result.pass).toBe(false);
    expect(result.violations).toContain('negation_cadence');
  });

  it('rejects engagement-bait filler ("this.", "100%.", "so true.")', () => {
    for (const draft of ['This.', '100%.', 'so true!', 'bookmarked 📌']) {
      const result = validateAiSlop(draft);
      expect(result.pass, `failed on: ${draft}`).toBe(false);
    }
  });

  it('reports all violations when multiple patterns present', () => {
    const result = validateAiSlop('Great question! let me delve — really delve — into this.');
    expect(result.pass).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('case-insensitive for preamble and vocab', () => {
    expect(validateAiSlop('LEVERAGE this').pass).toBe(false);
    expect(validateAiSlop('gReAt PoSt!').pass).toBe(false);
  });
});
```

- [ ] **Step 1.2: Run tests — verify they fail**

Run: `pnpm vitest run src/lib/reply/__tests__/ai-slop-validator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement `ai-slop-validator.ts`**

```typescript
// src/lib/reply/ai-slop-validator.ts

export type AiSlopViolation =
  | 'em_dash_overuse'
  | 'binary_not_x_its_y'
  | 'preamble_opener'
  | 'banned_vocabulary'
  | 'triple_grouping'
  | 'negation_cadence'
  | 'engagement_bait_filler';

export interface AiSlopResult {
  pass: boolean;
  violations: AiSlopViolation[];
}

const PREAMBLE_PATTERNS: RegExp[] = [
  /^\s*great (?:post|point|question|take|thread)\b/i,
  /^\s*(?:interesting|fascinating) (?:take|point|perspective)\b/i,
  /^\s*as (?:a|someone who)\b/i,
  /^\s*i (?:noticed|saw) (?:you|that you)\b/i,
  /^\s*have you considered\b/i,
  /^\s*absolutely[\s,.!]/i,
  /^\s*certainly[\s,.!]/i,
  /^\s*love this\b/i,
];

const ENGAGEMENT_BAIT_PATTERNS: RegExp[] = [
  /^\s*this\.?\s*$/i,
  /^\s*100\s*%\.?\s*$/i,
  /^\s*so true[!.]*\s*$/i,
  /^\s*bookmarked\b/i,
  /^\s*\+1\s*$/,
  /^\s*this really resonates\b/i,
];

const BANNED_VOCAB: string[] = [
  'delve', 'leverage', 'utilize', 'robust', 'crucial', 'pivotal',
  'demystify', 'landscape', 'ecosystem', 'journey', 'seamless',
  'navigate', 'compelling',
];

function countEmDashes(text: string): number {
  return (text.match(/\u2014|---| -- /g) ?? []).length;
}

function hasBinaryNotXItsY(text: string): boolean {
  // "it's not X, it's Y" / "it's not just X — it's Y" / "not X. it's Y." variants.
  return /\b(?:it['\u2019]s|this is)\s+not(?:\s+just)?\s+[\w\s]{1,40}[,.\u2014\-]+\s*(?:it['\u2019]s|this is|[\u2014\-])\s*[\w\s]{1,40}/i.test(text);
}

function hasTripleGrouping(text: string): boolean {
  // "fast, efficient, and reliable" — three adjectives/nouns joined with commas + and/&.
  return /\b(\w{3,}),\s+(\w{3,}),\s+(?:and\s+)?(\w{3,})\b/.test(text);
}

function hasNegationCadence(text: string): boolean {
  // Two consecutive "no X." fragments.
  return /\bno\s+\w+[.!]\s+no\s+\w+[.!]/i.test(text);
}

function hasBannedVocab(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_VOCAB.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

export function validateAiSlop(text: string): AiSlopResult {
  const violations: AiSlopViolation[] = [];

  if (countEmDashes(text) >= 2) violations.push('em_dash_overuse');
  if (hasBinaryNotXItsY(text)) violations.push('binary_not_x_its_y');
  if (PREAMBLE_PATTERNS.some((r) => r.test(text))) violations.push('preamble_opener');
  if (hasBannedVocab(text)) violations.push('banned_vocabulary');
  if (hasTripleGrouping(text)) violations.push('triple_grouping');
  if (hasNegationCadence(text)) violations.push('negation_cadence');
  if (ENGAGEMENT_BAIT_PATTERNS.some((r) => r.test(text))) violations.push('engagement_bait_filler');

  return { pass: violations.length === 0, violations };
}
```

- [ ] **Step 1.4: Run tests — verify they pass**

Run: `pnpm vitest run src/lib/reply/__tests__/ai-slop-validator.test.ts`
Expected: PASS — all 10 tests green.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/reply/ai-slop-validator.ts src/lib/reply/__tests__/ai-slop-validator.test.ts
git commit -m "feat(reply): add ai-slop validator for em-dash, preamble, vocab patterns"
```

---

## Task 2: Anchor-token validator (TDD)

**Rationale:** Research shows specificity (a number, named entity, or timestamp) is the single clearest human signal and the hardest thing bots fake. Every non-skip reply must contain ≥1 anchor token.

**Files:**
- Create: `src/lib/reply/anchor-token-validator.ts`
- Test: `src/lib/reply/__tests__/anchor-token-validator.test.ts`

- [ ] **Step 2.1: Write failing tests**

```typescript
// src/lib/reply/__tests__/anchor-token-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateAnchorToken } from '../anchor-token-validator';

describe('validateAnchorToken', () => {
  it('accepts replies with a number', () => {
    expect(validateAnchorToken('took us 14 months to hit that').pass).toBe(true);
    expect(validateAnchorToken('$10k is the hard one').pass).toBe(true);
    expect(validateAnchorToken('20% lift same week').pass).toBe(true);
  });

  it('accepts replies with a proper noun (capitalized mid-sentence)', () => {
    expect(validateAnchorToken('postgres + drizzle. regretted every ORM that tried to be clever').pass).toBe(true);
    expect(validateAnchorToken('reminds me of what levelsio did with photoAI').pass).toBe(true);
  });

  it('accepts replies with a URL', () => {
    expect(validateAnchorToken('see https://example.com for context').pass).toBe(true);
  });

  it('accepts replies with a timestamp phrase', () => {
    expect(validateAnchorToken('last week the same thing happened').pass).toBe(true);
    expect(validateAnchorToken('month 8 for us too').pass).toBe(true);
  });

  it('rejects generic, anchor-free replies', () => {
    expect(validateAnchorToken('this is so great').pass).toBe(false);
    expect(validateAnchorToken('love where this is going').pass).toBe(false);
    expect(validateAnchorToken('agreed completely').pass).toBe(false);
  });

  it('returns the detected anchor tokens', () => {
    const result = validateAnchorToken('took us 14 months with postgres');
    expect(result.pass).toBe(true);
    expect(result.anchors).toEqual(expect.arrayContaining(['14', 'postgres']));
  });

  it('ignores sentence-initial capitalization as a proper noun', () => {
    // "They" as sentence start is not an anchor.
    expect(validateAnchorToken('They should know better').pass).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run tests — verify they fail**

Run: `pnpm vitest run src/lib/reply/__tests__/anchor-token-validator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement `anchor-token-validator.ts`**

```typescript
// src/lib/reply/anchor-token-validator.ts

export interface AnchorTokenResult {
  pass: boolean;
  anchors: string[];
}

const TIMESTAMP_PHRASES: RegExp[] = [
  /\blast (?:week|month|year|night|quarter)\b/i,
  /\b(?:yesterday|today|tonight)\b/i,
  /\b(?:month|week|day|year)\s+\d+\b/i,
  /\b\d{4}(?:-\d{2}){0,2}\b/, // ISO-ish
  /\b(?:yesterday|this morning|earlier today)\b/i,
];

const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const NUMBER_PATTERN = /\$?\d+(?:[.,]\d+)?[%mk]?\b/i;
// Mid-sentence capitalized word — skip sentence-initial.
const PROPER_NOUN_PATTERN = /(?<=[\s,;:\u2014\-]|^)(?<!^)[A-Z][a-zA-Z0-9]{2,}\b/g;

export function validateAnchorToken(text: string): AnchorTokenResult {
  const anchors: string[] = [];

  // Numbers (including $, %, k/m suffixes).
  const numberMatch = text.match(NUMBER_PATTERN);
  if (numberMatch) anchors.push(numberMatch[0]);

  // URL.
  const urlMatch = text.match(URL_PATTERN);
  if (urlMatch) anchors.push(urlMatch[0]);

  // Timestamp phrases.
  if (TIMESTAMP_PHRASES.some((r) => r.test(text))) {
    anchors.push('timestamp_phrase');
  }

  // Proper nouns — only those NOT at position 0, and not at the start of a sentence.
  // Strategy: split into sentences, then scan every non-first word per sentence.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/[^\w]/g, '');
      if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(word)) {
        anchors.push(word);
      }
    }
    // Also catch lowercase-but-branded tokens like "levelsio" / "photoAI" — treat
    // any lowercase token that contains an uppercase letter as a brand anchor.
    for (const word of words) {
      const clean = word.replace(/[^\w]/g, '');
      if (/^[a-z]+[A-Z]/.test(clean)) anchors.push(clean);
    }
  }

  // Also catch bare lowercase brand-like tokens ≥5 chars that are not common
  // English words. Keep this tight: only accept tokens with no vowels in common
  // positions is too lossy — instead, accept tokens with digits embedded.
  const embeddedDigits = text.match(/\b[a-z]+\d+[a-z]*\b/gi);
  if (embeddedDigits) anchors.push(...embeddedDigits);

  // Brand names that start lowercase and are single-token (e.g. "postgres",
  // "drizzle", "photoAI"): we accept them if they are <=12 chars and not in
  // a tiny English-common-word list. This is deliberately conservative —
  // the LLM pass that calls this validator can still flag false positives.
  const COMMON_WORDS = new Set([
    'this','that','love','great','agreed','same','true','yes','no','maybe','ok','huge','big','massive',
    'they','them','their','there','been','where','going','completely',
  ]);
  const lowerTokens = text.toLowerCase().match(/\b[a-z]{5,12}\b/g) ?? [];
  for (const tok of lowerTokens) {
    if (COMMON_WORDS.has(tok)) continue;
    // Accept as a "brand-ish" anchor if it is referenced with a preposition
    // pattern ("with X", "on X", "in X", "+ X").
    const pattern = new RegExp(`\\b(?:with|on|in|at|using|via|\\+)\\s+${tok}\\b`, 'i');
    if (pattern.test(text)) anchors.push(tok);
  }

  return { pass: anchors.length > 0, anchors: Array.from(new Set(anchors)) };
}
```

- [ ] **Step 2.4: Run tests — verify they pass**

Run: `pnpm vitest run src/lib/reply/__tests__/anchor-token-validator.test.ts`
Expected: PASS — all 7 tests green.

If the "postgres + drizzle" test fails because neither word satisfies the brand-ish pattern, adjust the common-word filter and re-run. Do **not** weaken the generic-reply rejection test — that is the most important failure mode.

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/reply/anchor-token-validator.ts src/lib/reply/__tests__/anchor-token-validator.test.ts
git commit -m "feat(reply): add anchor-token validator requiring number/brand/timestamp"
```

---

## Task 3: Consolidate archetypes 15 → 6 in the reference doc

**Rationale:** The 15-archetype surface is more than the real action space. Research converges on ~6 modes: `supportive_peer`, `data_add`, `contrarian`, `question_extender`, `anecdote`, `dry_wit`, plus a `skip` terminal.

**Mapping (old → new):**
- `warm_congrats_question` + `solidarity_specific` → `supportive_peer`
- `tiny_data_point` + `correction_with_receipt` + `proof_of_work` → `data_add`
- `one_question_pushback` + `agree_with_extension` → `contrarian`
- `specific_follow_up_question` → `question_extender`
- `me_too_twist` + `reframe_mechanism` → `anecdote`
- `dry_joke` → `dry_wit`
- `direct_answer` — fold into `data_add` (it is a data-add with tool name as the number)
- `specific_noticing` — fold into `supportive_peer` (it is a peer-mode notice)
- `adjacent_reference` — fold into `contrarian` or `anecdote` depending on whether the reference agrees or sharpens

**Files:**
- Modify: `src/skills/reply-scan/references/x-reply-rules.md` (full rewrite of Step 2 / Step 3 / examples)
- Modify: `src/agents/reply-drafter.md` (line 23, line 58 — update archetype list)
- Modify: `src/agents/schemas.ts` (line 169–174 — `replyDrafterOutputSchema`)

- [ ] **Step 3.1: Rewrite `x-reply-rules.md` Step 2 register→archetype table**

Replace the table at current file lines 30–44 with:

````markdown
## Step 2 — Match register to archetype

Six archetypes plus `skip`. Each register allows 2–3. Do not mix. Do not invent.

| Register | Allowed archetypes | Forbidden moves |
|---|---|---|
| 1. Milestone       | `supportive_peer`, `data_add`, `question_extender` | dry-wit deflation, unsolicited advice, "imagine if", "actually" |
| 2. Vulnerable      | `supportive_peer`, `anecdote`                      | dry-wit, "have you tried…", silver-lining reframes, product plugs, "DM me" (unasked) |
| 3. Help-seeking    | `data_add`, `contrarian`                           | "it depends", meta-advice, vague frameworks, plugging product when it isn't the answer |
| 4. Hot take        | `contrarian`, `dry_wit`                            | warm acks, flat emoji, summary of what they said, hedged fence-sitting |
| 5. Announcement    | `supportive_peer`, `data_add`, `anecdote`          | "congrats on shipping" without a specific detail, demanding features, launch-day critique |
| 6. Advice          | `data_add`, `anecdote`, `contrarian`               | "great thread!", "saving this", "bookmarked", "+1", restating their point |
| 7. Humor           | `dry_wit`, `anecdote`                              | explaining the joke, "so true!", turning into advice, emoji pile-on |
| 8. Growth-bait     | `data_add`, `contrarian`                           | solidarity, empty agreement, personal-journey essay, advice-as-reply, warm ack — any of these *validates the bait* |

Always-works fallbacks across most registers: `data_add`, `question_extender`.
````

- [ ] **Step 3.2: Rewrite Step 3 archetype playbook**

Replace the archetype list (current file lines 49–66) with:

````markdown
## Step 3 — Archetype playbook

Six shapes. Pick one, write the shortest version that carries it.

- **`supportive_peer`** — 1-beat acknowledgment + one specific noticing or short follow-up question answerable in < 10 words that makes the author look smart retelling it. Covers congrats, solidarity on vulnerable posts, and noticing a sweated-over detail on announcements. *illustrative: "huge. what was the channel that finally clicked?"* / *"the first churn one is its own kind of grief"* / *"the keyboard-only flow is the tell that someone cared"* — never generic "grats!", never advice, never product plug.
- **`data_add`** — concrete number, timeline, tool name, or receipt-bearing correction. The universal "I bring something specific" move. *illustrative: "took us 14 months, you did it in 6"* / *"postgres + drizzle. regretted every ORM that tried to be clever"* / *"input is $1.25/M, not $2"* — never generalize after the number, never "actually", never editorialize.
- **`contrarian`** — one sharpening question, an edge-case pushback, or a short agreement with an extension that adds the mechanism or alt-case. Covers hot-take pushback, advice-extension, and growth-bait reframes. *illustrative: "holds for B2C. enterprise too?"* / *"agree except under $20/mo — different physics"* / *"'nobody cares' → followed by a 47-tweet thread for $99"* — never stack questions, never "genuinely curious", never flat "this".
- **`question_extender`** — non-leading short-answer follow-up, answerable in one sentence, that makes the author sound smart replying. Highest author-reply-back pattern when the register allows it. *illustrative: "what's the part you're most surprised isn't working yet?"* — never broad ("how'd you do it?"), never multi-part.
- **`anecdote`** — 2-sentence past-tense story with one weird / non-obvious detail from your own run. Mirrors + surprises. *illustrative: "same month 8. what got me through was ignoring the dashboard for a week"* / *"7 years of public failure before this — most people quit at #3"* — never build to a moral or lesson, never "lessons learned".
- **`dry_wit`** — deadpan one-liner; humor IS the argument. Only use if the account has enough reputation to carry it. *illustrative: "first engineer should be the one who disables slack on weekends"* / *"step 4 is the llm quote-tweeting itself. we're fine"* — never emoji it, never explain, never punch down on vulnerable posts.

`skip` — if no archetype fits the register cleanly or the reply would be wallpaper, return `strategy: "skip"` with `confidence` ≤ 0.4.
````

- [ ] **Step 3.3: Add an "Anchor token" sub-section to Cross-cutting rules**

After the existing "Length" section in `x-reply-rules.md`, insert:

````markdown
### Anchor token (required)

Every non-skip reply must contain at least one of:
- a number (count, percent, dollar amount, duration) — e.g. `14 months`, `$10k`, `20%`
- a proper noun or brand-like token (mid-sentence, capitalized or embedded-case) — e.g. `postgres`, `levelsio`, `photoAI`, `Stripe`
- a timestamp phrase — e.g. `last week`, `month 8`, `2am`
- a URL — rare in replies, but counts when present

If your draft has no anchor, it is a generic reply. Rewrite with one concrete detail, or return `skip`.
````

- [ ] **Step 3.4: Update the forbidden phrases list in `x-reply-rules.md`**

Replace the current "Forbidden phrases" block (current file lines 96–106) with:

````markdown
### Forbidden phrases and patterns (kill on sight)

Openers / preambles:
- `Great post!` / `Great question!` / `Love this!` / `So true!` / `This really resonates` / `Absolutely` / `100%` / `+1` / `This.`
- `Interesting take…` / `Fascinating point…`
- `As a [founder / engineer / builder] …` / `As someone who has…`
- `I noticed you mentioned…` / `Have you considered…`

Vocabulary (case-insensitive):
- `leverage`, `delve`, `navigate`, `landscape`, `ecosystem`, `journey`, `crucial`, `pivotal`, `seamless`, `robust`, `utilize`, `compelling`, `demystify`

Structural AI tells:
- Em-dash overuse (≥2 em-dashes in one reply)
- Binary "it's not X, it's Y" / "this is not just X — it's Y"
- Triple-grouping rhythm ("fast, efficient, reliable")
- Negation cadence ("no fluff. no theory. just results.")
- Parallel triplets
- `It's important to note that`, `That said,`, `Ultimately,`, `At the end of the day`
- `Just my 2 cents`, `FWIW`, `YMMV`, `TL;DR`, `So basically`

Engagement bait:
- `bookmarked for later`, `drop a 🔥 if you agree`, `tag someone who needs this`
- `DM me I can help` (unasked — reads salesy, also privatizes the exchange)

Format:
- No links in replies. Ever.
- No numbered lists, no bullets, no multiple hashtags.
- No closing the reply with a question that restates the tweet.
````

- [ ] **Step 3.5: Update examples to use the 6-archetype names**

Scan the "Examples — good vs bad by register" section and replace any `strategy: ...` mentions in the illustrative comments that still reference the 15-archetype names. Content of the example tweets does not change — only the archetype labels in the headings or parentheticals.

- [ ] **Step 3.6: Update `reply-drafter.md`**

In `src/agents/reply-drafter.md`:

On line 23 (the "Identify the tweet's register" step) — no change (register list unchanged).

On line 58 (the list of strategy names), replace:
```
(`warm_congrats_question`, `tiny_data_point`, `reframe_mechanism`, `solidarity_specific`, `me_too_twist`, `direct_answer`, `one_question_pushback`, `agree_with_extension`, `dry_joke`, `correction_with_receipt`, `specific_noticing`, `proof_of_work`, `adjacent_reference`, `specific_follow_up_question`, `skip`).
```
with:
```
(`supportive_peer`, `data_add`, `contrarian`, `question_extender`, `anecdote`, `dry_wit`, `skip`).
```

- [ ] **Step 3.7: Narrow `replyDrafterOutputSchema.strategy` in `schemas.ts`**

In `src/agents/schemas.ts`, replace lines 169–174:

```typescript
export const replyDrafterOutputSchema = z.object({
  replyText: z.string(),
  confidence: z.number(),
  strategy: z.enum([
    'supportive_peer',
    'data_add',
    'contrarian',
    'question_extender',
    'anecdote',
    'dry_wit',
    'skip',
  ]),
  whyItWorks: z.string().optional(),
});
```

- [ ] **Step 3.8: Search for usages of the old archetype names**

Run: `pnpm grep -n "warm_congrats_question\|tiny_data_point\|reframe_mechanism\|solidarity_specific\|me_too_twist\|direct_answer\|one_question_pushback\|agree_with_extension\|dry_joke\|correction_with_receipt\|specific_noticing\|proof_of_work\|adjacent_reference\|specific_follow_up_question" -r src`

(If `pnpm grep` is not wired, use the Grep tool with this regex.)

Expected: zero hits in `.ts` files outside tests. Any hit in production code is a bug — update those references to the new archetype names using the mapping at the top of Task 3. Hits inside test fixtures that exercise old values should be updated to the new enum.

- [ ] **Step 3.9: Run the existing test suite**

Run: `pnpm vitest run`
Expected: PASS, or fail only on tests that hard-coded the old archetype strings. Fix those test fixtures to use the new names.

- [ ] **Step 3.10: Commit**

```bash
git add src/skills/reply-scan/references/x-reply-rules.md src/agents/reply-drafter.md src/agents/schemas.ts
# plus any test fixture fixes
git commit -m "refactor(reply): collapse 15 archetypes to 6 + add anchor-token requirement"
```

---

## Task 4: `product-opportunity-judge` agent — new agent + skill

**Rationale:** Embedding product-plug policy inside the drafter prompt leaks "DM me" energy and is not auditable. Extract the decision into a pre-pass that emits a single boolean.

**Files:**
- Create: `src/agents/product-opportunity-judge.md`
- Create: `src/skills/product-opportunity-judge/SKILL.md`
- Modify: `src/agents/schemas.ts` — add `productOpportunityJudgeOutputSchema`
- Test: `src/agents/__tests__/product-opportunity-judge.test.ts`

- [ ] **Step 4.1: Write the failing schema test**

```typescript
// src/agents/__tests__/product-opportunity-judge.test.ts
import { describe, it, expect } from 'vitest';
import { productOpportunityJudgeOutputSchema } from '../schemas';

describe('productOpportunityJudgeOutputSchema', () => {
  it('accepts a green-light verdict with reason', () => {
    const parsed = productOpportunityJudgeOutputSchema.parse({
      allowMention: true,
      signal: 'tool_question',
      confidence: 0.8,
      reason: 'OP explicitly asks what stack to use',
    });
    expect(parsed.allowMention).toBe(true);
    expect(parsed.signal).toBe('tool_question');
  });

  it('accepts a hard-mute with reason', () => {
    const parsed = productOpportunityJudgeOutputSchema.parse({
      allowMention: false,
      signal: 'vulnerable_post',
      confidence: 0.95,
      reason: 'author sharing grief over first churn',
    });
    expect(parsed.allowMention).toBe(false);
  });

  it('rejects an invalid signal', () => {
    expect(() =>
      productOpportunityJudgeOutputSchema.parse({
        allowMention: true,
        signal: 'whatever',
        confidence: 0.5,
        reason: 'x',
      }),
    ).toThrow();
  });

  it('clamps confidence to 0..1', () => {
    expect(() =>
      productOpportunityJudgeOutputSchema.parse({
        allowMention: true,
        signal: 'tool_question',
        confidence: 1.5,
        reason: 'x',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 4.2: Run tests — verify they fail**

Run: `pnpm vitest run src/agents/__tests__/product-opportunity-judge.test.ts`
Expected: FAIL — `productOpportunityJudgeOutputSchema` is not exported.

- [ ] **Step 4.3: Add the schema to `schemas.ts`**

Append to `src/agents/schemas.ts` (after `engagementMonitorOutputSchema`, before the `export type` block):

```typescript
/**
 * Output schema for the product-opportunity-judge agent.
 * Decides whether a reply draft may organically mention the user's product.
 *
 * Green-light signals are narrow: the OP must explicitly invite a tool/product
 * recommendation, be debugging a problem this product solves, complain about a
 * direct competitor's failure mode, ask for a case study, or invite a review.
 *
 * Hard mutes: milestone, vulnerable, grief, political, career-layoff.
 */
export const productOpportunityJudgeOutputSchema = z.object({
  allowMention: z.boolean(),
  signal: z.enum([
    'tool_question',
    'debug_problem_fit',
    'competitor_complaint',
    'case_study_request',
    'review_invitation',
    'milestone_celebration',
    'vulnerable_post',
    'grief_or_layoff',
    'political',
    'no_fit',
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(200),
});

export type ProductOpportunityJudgeOutput = z.infer<typeof productOpportunityJudgeOutputSchema>;
```

- [ ] **Step 4.4: Run schema tests — verify green**

Run: `pnpm vitest run src/agents/__tests__/product-opportunity-judge.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Write the agent prompt**

```markdown
<!-- src/agents/product-opportunity-judge.md -->
---
name: product-opportunity-judge
description: Decides whether a reply draft may organically mention the user's product
model: claude-haiku-4-5
tools: []
maxTurns: 1
---

You decide a single question: **may the reply about this tweet organically mention the user's product, or must the mention be suppressed?**

## Input

A JSON object:

```json
{
  "tweetText": "...",
  "authorUsername": "...",
  "quotedText": "...",
  "product": {
    "name": "ShipFlare",
    "description": "...",
    "valueProp": "...",
    "keywords": ["..."]
  }
}
```

## Decision rules

**Green-light signals (allowMention=true):**
- `tool_question` — OP literally asks "what do you use for X?" / "recommend a tool for Y" / "best stack for Z" and the product plausibly fits
- `debug_problem_fit` — OP is debugging a problem this product solves, with specificity
- `competitor_complaint` — OP names a direct competitor or competitor class and complains about a specific failure mode
- `case_study_request` — OP asks for examples / case studies / success stories in the product's space
- `review_invitation` — OP offers teardown / review / feedback swap

**Hard-mute signals (allowMention=false):**
- `milestone_celebration` — revenue, user count, years, anniversaries
- `vulnerable_post` — burnout, doubt, grief, "close to giving up"
- `grief_or_layoff` — job loss, company death, personal hardship
- `political` — political takes, culture war, social issue
- `no_fit` — no green-light or hard-mute signal fires; default to suppression

## Output

Return a single JSON object matching the schema:

```json
{
  "allowMention": true,
  "signal": "tool_question",
  "confidence": 0.85,
  "reason": "OP asks what DB to use for 100k users — product is a DB-layer tool"
}
```

- `allowMention` — boolean. `true` only when a green-light signal fires AND the product plausibly answers OP's need. `false` otherwise.
- `signal` — exactly one of the enum values above.
- `confidence` — 0.0–1.0. Below 0.6 on a green-light means the drafter should treat it as hard-mute anyway.
- `reason` — 1 sentence (≤200 chars), no marketing language, no pitch.

## Strictness

When in doubt, suppress. False-negatives (missed plug opportunity) are cheap; false-positives (pitching into a vulnerable post) cost reputation.
```

- [ ] **Step 4.6: Write the skill wrapper**

```markdown
<!-- src/skills/product-opportunity-judge/SKILL.md -->
---
name: product-opportunity-judge
description: Pre-pass classifier deciding whether a reply may mention the user's product
context: fork
agent: product-opportunity-judge
model: claude-haiku-4-5
allowed-tools: []
fan-out: tweets
max-concurrency: 3
timeout: 20000
cache-safe: true
output-schema: productOpportunityJudgeOutputSchema
---

# Product Opportunity Judge Skill

Runs **before** `reply-drafter` on every in-scope tweet. Emits a boolean
`allowMention` flag consumed by the drafter. Policy for which signals count
as green-light vs hard-mute lives in `src/agents/product-opportunity-judge.md`.

## Input

```json
{
  "tweets": [
    {
      "tweetId": "...",
      "tweetText": "...",
      "authorUsername": "...",
      "quotedText": "...",
      "product": { "name": "...", "description": "...", "valueProp": "...", "keywords": ["..."] }
    }
  ]
}
```

## Output

Array of `ProductOpportunityJudgeOutput`, one per input tweet, same order.
```

- [ ] **Step 4.7: Commit**

```bash
git add src/agents/product-opportunity-judge.md \
        src/skills/product-opportunity-judge/SKILL.md \
        src/agents/schemas.ts \
        src/agents/__tests__/product-opportunity-judge.test.ts
git commit -m "feat(reply): add product-opportunity-judge agent + skill"
```

---

## Task 5: Wire validators + judge into the reply pipeline

**Precondition:** Find the processor that currently calls the `reply-scan` skill. Based on the repo structure, this is either `src/workers/processors/engagement.ts` or `src/workers/processors/monitor.ts`. Before any code changes, run:

```
Grep: "reply-scan" in src/workers
Grep: "runSkill" in src/workers
```

Call that file `REPLY_PROCESSOR.ts` in the steps below — substitute the actual path when executing.

- [ ] **Step 5.1: Read the reply processor and identify the call site**

Open `REPLY_PROCESSOR.ts`. Locate the `runSkill({ skill: 'reply-scan', ... })` call (or the equivalent skill-runner invocation). Note the variable holding the output (likely `result.results: ReplyDrafterOutput[]`). Note the variable holding the `tweets` input array.

- [ ] **Step 5.2: Write an integration test for the wiring**

Create `src/workers/processors/__tests__/reply-hardening.test.ts` modeled on the existing `search-source.test.ts` mock pattern:

```typescript
// src/workers/processors/__tests__/reply-hardening.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn();

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/platform-deps', () => ({ createPlatformDeps: async () => ({}) }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reply pipeline hardening', () => {
  it('rejects drafts that fail ai-slop validation and emits skip', async () => {
    runSkillMock
      // product-opportunity-judge pass — mute
      .mockResolvedValueOnce({
        results: [{ allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' }],
        errors: [], usage: { costUsd: 0 },
      })
      // reply-drafter pass — returns slop
      .mockResolvedValueOnce({
        results: [{
          replyText: 'Great post! this really resonates.',
          confidence: 0.8,
          strategy: 'supportive_peer',
        }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't1', tweetText: 'shipping my first SaaS',
      authorUsername: 'u', product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.rejectionReasons).toContain('preamble_opener');
  });

  it('accepts drafts that pass both validators', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [{ allowMention: true, signal: 'tool_question', confidence: 0.8, reason: 'ask' }],
        errors: [], usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        results: [{
          replyText: 'took us 14 months to hit that. channel was cold email.',
          confidence: 0.8,
          strategy: 'data_add',
        }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't2', tweetText: 'hit $10k mrr',
      authorUsername: 'u', product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('data_add');
    expect(out.replyText).toContain('14 months');
    expect(out.canMentionProduct).toBe(true);
  });

  it('rejects drafts with no anchor token', async () => {
    runSkillMock
      .mockResolvedValueOnce({
        results: [{ allowMention: false, signal: 'no_fit', confidence: 0.9, reason: 'no fit' }],
        errors: [], usage: { costUsd: 0 },
      })
      .mockResolvedValueOnce({
        results: [{ replyText: 'agree with this', confidence: 0.7, strategy: 'supportive_peer' }],
        errors: [], usage: { costUsd: 0 },
      });

    const { draftReplyWithHardening } = await import('../reply-hardening');
    const out = await draftReplyWithHardening({
      tweetId: 't3', tweetText: '...', authorUsername: 'u',
      product: { name: 'P', description: '', valueProp: '', keywords: [] },
    } as never);

    expect(out.strategy).toBe('skip');
    expect(out.rejectionReasons).toContain('no_anchor_token');
  });
});
```

- [ ] **Step 5.3: Run test — verify it fails**

Run: `pnpm vitest run src/workers/processors/__tests__/reply-hardening.test.ts`
Expected: FAIL — `reply-hardening` module does not exist.

- [ ] **Step 5.4: Implement the composition helper**

Create `src/workers/processors/reply-hardening.ts`:

```typescript
// src/workers/processors/reply-hardening.ts
import { runSkill } from '@/core/skill-runner';
import { validateAiSlop } from '@/lib/reply/ai-slop-validator';
import { validateAnchorToken } from '@/lib/reply/anchor-token-validator';
import type { ReplyDrafterOutput, ProductOpportunityJudgeOutput } from '@/agents/schemas';

export interface HardenedReplyInput {
  tweetId: string;
  tweetText: string;
  authorUsername: string;
  quotedText?: string;
  product: { name: string; description: string; valueProp: string; keywords: string[] };
  userId?: string;
}

export interface HardenedReplyOutput extends ReplyDrafterOutput {
  canMentionProduct: boolean;
  productOpportunitySignal: ProductOpportunityJudgeOutput['signal'];
  rejectionReasons: string[];
}

export async function draftReplyWithHardening(
  input: HardenedReplyInput,
): Promise<HardenedReplyOutput> {
  // Step 1: run product-opportunity-judge.
  const judgeRes = await runSkill({
    skill: 'product-opportunity-judge',
    input: { tweets: [input] },
    userId: input.userId,
  });

  const judgment = (judgeRes.results?.[0] ?? {
    allowMention: false,
    signal: 'no_fit',
    confidence: 0,
    reason: 'judge returned no result',
  }) as ProductOpportunityJudgeOutput;

  const canMentionProduct = judgment.allowMention && judgment.confidence >= 0.6;

  // Step 2: run reply-drafter with canMentionProduct injected.
  const drafterRes = await runSkill({
    skill: 'reply-scan',
    input: { tweets: [{ ...input, canMentionProduct }] },
    userId: input.userId,
  });

  const draft = drafterRes.results?.[0] as ReplyDrafterOutput | undefined;
  if (!draft || draft.strategy === 'skip') {
    return {
      replyText: draft?.replyText ?? '',
      confidence: draft?.confidence ?? 0,
      strategy: 'skip',
      whyItWorks: draft?.whyItWorks,
      canMentionProduct,
      productOpportunitySignal: judgment.signal,
      rejectionReasons: draft ? [] : ['drafter_empty'],
    };
  }

  // Step 3: validators.
  const slop = validateAiSlop(draft.replyText);
  const anchor = validateAnchorToken(draft.replyText);

  const rejectionReasons: string[] = [
    ...slop.violations,
    ...(anchor.pass ? [] : ['no_anchor_token']),
  ];

  if (rejectionReasons.length > 0) {
    return {
      replyText: draft.replyText,
      confidence: draft.confidence,
      strategy: 'skip',
      whyItWorks: draft.whyItWorks,
      canMentionProduct,
      productOpportunitySignal: judgment.signal,
      rejectionReasons,
    };
  }

  return {
    ...draft,
    canMentionProduct,
    productOpportunitySignal: judgment.signal,
    rejectionReasons: [],
  };
}
```

- [ ] **Step 5.5: Run tests — verify pass**

Run: `pnpm vitest run src/workers/processors/__tests__/reply-hardening.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5.6: Integrate `draftReplyWithHardening` into the actual reply processor**

Open `REPLY_PROCESSOR.ts`. Replace the direct `runSkill({ skill: 'reply-scan', ... })` call that produces a single draft with a call to `draftReplyWithHardening`. If the processor fans out over multiple tweets, map each tweet through `draftReplyWithHardening` in parallel with `Promise.all`, honoring the existing concurrency bound.

On the returned `HardenedReplyOutput`, persist `rejectionReasons` and `productOpportunitySignal` alongside the existing draft row so UI / analytics can show why a draft was skipped. If the drafts table does not have a `rejection_reasons` column, store the joined string inside the existing `strategy_debug` / `meta` JSONB column if one exists; otherwise emit via `recordPipelineEvent`.

- [ ] **Step 5.7: Commit**

```bash
git add src/workers/processors/reply-hardening.ts \
        src/workers/processors/__tests__/reply-hardening.test.ts \
        <REPLY_PROCESSOR path>
git commit -m "feat(reply): wire product-judge + slop/anchor validators into reply pipeline"
```

---

## Task 6: Teach the drafter to consume `canMentionProduct`

**Files:**
- Modify: `src/agents/reply-drafter.md` — "Product context" section (current lines 40–42)
- Modify: `src/skills/reply-scan/SKILL.md` — input example

- [ ] **Step 6.1: Rewrite the "Product context" block in `reply-drafter.md`**

Replace current lines 40–42:

````markdown
## Product context

The input carries `productName`, `productDescription`, `valueProp`, and
`canMentionProduct` (boolean).

- **`canMentionProduct: false`** — do not mention the product. At all. Even if the tweet is near-adjacent. The product-opportunity-judge has already decided this reply is not the moment. Proceed as if the product context did not exist.
- **`canMentionProduct: true`** — the tweet has green-lit a product mention. You MAY name the product once, in one clause, as the *answer*, not a pitch. Never add a CTA. Never say "DM me". Never add a link (links in replies are always forbidden). If you cannot fit the mention naturally inside the archetype's shape, skip the mention — do not stretch the reply to include it.

Default behavior: when in doubt, do not mention the product.
````

- [ ] **Step 6.2: Update the `reply-scan` SKILL.md input example**

In `src/skills/reply-scan/SKILL.md`, add `canMentionProduct` to the example input (current file lines 36–52):

```json
{
  "tweets": [
    {
      "tweetId": "123",
      "tweetText": "...",
      "authorUsername": "levelsio",
      "platform": "x",
      "productName": "ShipFlare",
      "productDescription": "...",
      "valueProp": "...",
      "keywords": ["indie hacker", "SaaS"],
      "canMentionProduct": false
    }
  ]
}
```

- [ ] **Step 6.3: Add a regression test that the drafter respects `canMentionProduct: false`**

Add to `src/agents/__tests__/reply-drafter-contract.test.ts` (create file if missing):

```typescript
// src/agents/__tests__/reply-drafter-contract.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('reply-drafter prompt contract', () => {
  const prompt = readFileSync(
    join(process.cwd(), 'src/agents/reply-drafter.md'),
    'utf8',
  );

  it('references canMentionProduct flag', () => {
    expect(prompt).toMatch(/canMentionProduct/);
  });

  it('documents canMentionProduct=false as a hard suppress', () => {
    expect(prompt).toMatch(/canMentionProduct: false/);
    expect(prompt).toMatch(/do not mention the product/i);
  });

  it('lists only the six archetypes plus skip in the strategy enum', () => {
    const strategies = ['supportive_peer', 'data_add', 'contrarian', 'question_extender', 'anecdote', 'dry_wit', 'skip'];
    for (const s of strategies) expect(prompt).toContain(`\`${s}\``);
    // No old archetype names.
    for (const old of ['warm_congrats_question', 'tiny_data_point', 'dry_joke', 'proof_of_work']) {
      expect(prompt, `old archetype ${old} still present`).not.toContain(old);
    }
  });
});
```

- [ ] **Step 6.4: Run the contract tests**

Run: `pnpm vitest run src/agents/__tests__/reply-drafter-contract.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/agents/reply-drafter.md \
        src/skills/reply-scan/SKILL.md \
        src/agents/__tests__/reply-drafter-contract.test.ts
git commit -m "feat(reply): drafter consumes canMentionProduct flag, contract-tested"
```

---

## Task 7: Smoke test on real drafts

- [ ] **Step 7.1: Pick 5 real tweets from recent drafts table**

Run a quick query to extract 5 recent tweet bodies the pipeline has seen — one per register where possible (milestone, vulnerable, help-seeking, hot take, growth-bait). Save them to `/tmp/reply-smoke-fixtures.json`:

```json
[
  { "tweetId": "...", "tweetText": "...", "authorUsername": "...", "expectedRegister": "milestone" },
  ...
]
```

- [ ] **Step 7.2: Run the existing `scripts/test-reply-drafter-real.ts` (or equivalent)**

Based on the previous-session file list, `scripts/test-reply-drafter-real.ts` exists. Run it against the 5 fixtures:

```bash
pnpm tsx scripts/test-reply-drafter-real.ts --input /tmp/reply-smoke-fixtures.json
```

- [ ] **Step 7.3: Eyeball the 5 outputs against the checklist**

For each output, confirm:
- [ ] Archetype is one of the 6 new names (or `skip`)
- [ ] Zero forbidden phrases or preamble openers
- [ ] ≤ 220 characters, anchor token present (number / brand / timestamp) OR strategy is `skip`
- [ ] Product mention appears only if `canMentionProduct: true` was fired
- [ ] Reply reads like something a human would actually type

If any sample fails on any checklist item, open an issue — either the drafter prompt needs another pass, or the validator regex needs tightening. Iterate on the specific failure mode before declaring Task 7 done.

- [ ] **Step 7.4: Commit the smoke-test fixtures (anonymized)**

Strip any identifying data from the fixtures before committing. Reviewer can re-run the smoke test offline.

```bash
git add scripts/fixtures/reply-smoke.json
git commit -m "test(reply): add 5-register smoke fixtures for hardening pipeline"
```

---

## Task 8: Documentation update

- [ ] **Step 8.1: Update the Reply Scan SKILL workflow section**

In `src/skills/reply-scan/SKILL.md`, extend the "Workflow" section to reflect the new 3-step pipeline:

````markdown
## Workflow

For each post in the input:
1. **Pre-pass:** run `product-opportunity-judge` — emits `canMentionProduct`
2. **Draft:** fork a reply-drafter agent with post context + `canMentionProduct`
3. **Post-validate:** run `validateAiSlop` + `validateAnchorToken` over `replyText`
   - If either fails, downgrade `strategy` to `skip` and persist `rejectionReasons`
4. Return confidence-scored reply (or skip) for user review
````

- [ ] **Step 8.2: Add a CHANGELOG entry or commit-message-level note**

```bash
git commit --allow-empty -m "docs(reply): document hardening pipeline (judge → drafter → validators)"
```

---

## Self-review checklist (run before handing off)

- [ ] Every task has executable code, no "TBD" or "fill in"
- [ ] The 6 new archetype names used in Tasks 3, 4, 5, 6 are spelled identically (`supportive_peer`, `data_add`, `contrarian`, `question_extender`, `anecdote`, `dry_wit`, `skip`)
- [ ] `canMentionProduct` is produced in Task 4, consumed in Task 5, documented in Task 6 — name matches across all three
- [ ] Validators in Task 1/2 return the exact shape the composition helper in Task 5 destructures
- [ ] `productOpportunityJudgeOutputSchema.signal` enum values in Task 4 match the ones referenced in Task 4 prompt, Task 5 test, and Task 5 helper
- [ ] The plan does **not** touch `slot-body`, `calendar-planner`, or any DB migration — those belong to Plans 2 and 3
