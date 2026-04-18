# Voice Profile + Hybrid Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user a persistent *voice profile* that flows into every generated tweet and reply, so ShipFlare's output stops sounding generically AI and starts sounding like the specific founder it was written for.

**Architecture:** Per-user `voice_profiles` row (one per channel) with two layers — (a) structured fields the user edits directly in onboarding (archetype, emoji policy, banned words, worldview tags, opener/closer preferences) and (b) an LLM-extracted markdown *style card* plus a pool of top-engagement sample tweets auto-refreshed from the connected X account. At generation time, a `buildVoiceBlock()` helper assembles a hybrid prompt fragment: the structured card + 5 randomly-rotated few-shot examples + a banned-phrase list, wrapped in a `<voice_profile>` XML block. The fragment is injected into `content`, `slot-body-agent`, and `reply-drafter` prompts. A `voiceStrength` knob (loose/moderate/strict) controls how much of the card is included to prevent over-fitting.

**Tech Stack:** TypeScript, Drizzle (PostgreSQL migration), Vitest, Zod, existing skill-runner, Claude Haiku 4.5 for the extraction pass (cheap, one-shot).

**Research grounding:** [Nicolas Cole — voice as variable combination](https://x.com/nicolascole77), [Lex Style Guides (hybrid card + samples)](https://lex.page/about), [Spiral v3 engagement-weighted tweet pulls](https://every.to/on-every/introducing-spiral-v3-an-ai-writing-partner-with-taste), [arxiv 2410.03848 — voice imitation axes](https://arxiv.org/html/2410.03848v1), [Claude prompting best practices for style control](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices).

---

## File Structure

### New files
- `drizzle/0020_voice_profiles.sql` — migration
- `src/lib/db/schema/voice-profiles.ts` — Drizzle model
- `src/agents/voice-extractor.md` — agent that turns ≤30 sample tweets into a style card
- `src/skills/voice-extractor/SKILL.md` — skill manifest
- `src/lib/voice/inject.ts` — `buildVoiceBlock()` helper (pure function)
- `src/lib/voice/__tests__/inject.test.ts`
- `src/workers/processors/voice-extract.ts` — background job that pulls tweets, runs the extractor, writes the profile
- `src/workers/processors/__tests__/voice-extract.test.ts`
- `src/lib/queue/voice-extract.ts` — queue + enqueue helper (mirrors existing queue scaffolds)
- `src/app/api/voice-profile/route.ts` — GET/PUT endpoint for the settings UI (auth-gated)
- `src/app/(settings)/voice/page.tsx` — minimal settings page (archetype picker, emoji/opener choices, banned words, style-card editor)

### Modified files
- `src/lib/db/schema/index.ts` — re-export `voiceProfiles`
- `src/agents/schemas.ts` — add `voiceExtractorOutputSchema` + `VoiceProfile` TS type
- `src/agents/content.md` — inject `{{voice_block}}` anchor + instructions to honor it
- `src/agents/slot-body-agent.md` — same
- `src/agents/reply-drafter.md` — same; reply drafter's banned-phrase list defers to the voice profile's banned list if present
- `src/workers/processors/calendar-slot-draft.ts` — load voice profile, include in `runSkill` input
- `src/workers/processors/reply-hardening.ts` (from Plan 1) — same
- `src/workers/processors/content.ts` — same (for reply-type drafts)
- `src/lib/queue/index.ts` — register voice-extract queue
- `src/app/(onboarding)/voice/page.tsx` — 90-second onboarding form (3 steps)

---

## Scope boundaries

- **Does not** add voice feedback-loop telemetry (which drafts users edited or rejected feed back into voice updates). Deferred — needs more signal design.
- **Does not** ship multi-channel voice profiles (LinkedIn/Reddit voice). The schema supports `channel` as a column; only `'x'` is wired in this plan.
- **Does not** add n-gram repetition monitoring across last-100 replies (mentioned in the research). Defer to a follow-up plan; needs longer-running observation before a good threshold is clear.
- Assumes Plan 1 (reply hardening) has landed — this plan modifies `reply-hardening.ts` and `reply-drafter.md` from that plan.

---

## Task 1: Drizzle migration + model — `voice_profiles`

**Files:**
- Create: `drizzle/0020_voice_profiles.sql`
- Create: `src/lib/db/schema/voice-profiles.ts`
- Modify: `src/lib/db/schema/index.ts`

- [ ] **Step 1.1: Write the Drizzle model**

Create `src/lib/db/schema/voice-profiles.ts`:

```typescript
import {
  pgTable, text, timestamp, integer, jsonb, boolean, real, unique, index,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user voice profile, per channel. Hybrid schema:
 *  - structured fields edited by the user in onboarding / settings
 *  - LLM-extracted style card + top-engagement sample tweets
 *
 * Generation time injects both layers via `buildVoiceBlock()`.
 *
 * No tokens or PII live here. `sampleTweets` is the raw tweet text only —
 * publicly posted content the user already owns on X.
 */
export const voiceProfiles = pgTable(
  'voice_profiles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(), // 'x' | future: 'linkedin' | 'reddit'

    // Structured (user-editable)
    register: text('register').notNull().default('builder_log'),
    //   'builder_log' | 'operator_essay' | 'shitposter' | 'thought_leader' | 'researcher'
    pronouns: text('pronouns').notNull().default('i'),
    //   'i' | 'we' | 'you_direct'
    capitalization: text('capitalization').notNull().default('sentence'),
    //   'sentence' | 'lowercase' | 'title'
    emojiPolicy: text('emoji_policy').notNull().default('sparing'),
    //   'none' | 'sparing' | 'signature'
    signatureEmoji: text('signature_emoji'), // nullable; e.g. '🚢'
    punctuationSignatures: jsonb('punctuation_signatures')
      .notNull()
      .$type<string[]>()
      .default([]),
    //   subset of ['em_dash', 'ellipsis', 'parenthetical_aside', 'one_line_per_sentence']
    humorRegister: jsonb('humor_register')
      .notNull()
      .$type<string[]>()
      .default([]),
    //   subset of ['self_deprecating', 'dry', 'absurdist', 'meme', 'none']
    bannedWords: jsonb('banned_words').notNull().$type<string[]>().default([]),
    bannedPhrases: jsonb('banned_phrases').notNull().$type<string[]>().default([]),
    worldviewTags: jsonb('worldview_tags').notNull().$type<string[]>().default([]),
    //   subset of ['pro_craft','anti_hype','pro_hustle','pro_calm','contrarian','pro_open_source']
    openerPreferences: jsonb('opener_preferences')
      .notNull()
      .$type<string[]>()
      .default([]),
    //   e.g. ['Just shipped…', 'TIL…', 'Hot take:', 'naked_claim']
    closerPolicy: text('closer_policy').notNull().default('silent_stop'),
    //   'question' | 'cta' | 'payoff' | 'silent_stop'
    voiceStrength: text('voice_strength').notNull().default('moderate'),
    //   'loose' | 'moderate' | 'strict' — controls injection weight

    // Auto-extracted (background job)
    extractedStyleCardMd: text('extracted_style_card_md'),
    sampleTweets: jsonb('sample_tweets')
      .notNull()
      .$type<Array<{ id: string; text: string; engagement: number }>>()
      .default([]),
    avgSentenceLength: real('avg_sentence_length'),
    openerHistogram: jsonb('opener_histogram')
      .$type<Record<string, number>>()
      .default({}),
    lengthHistogram: jsonb('length_histogram')
      .$type<Record<string, number>>()
      .default({}),
    extractionVersion: integer('extraction_version').notNull().default(0),
    lastExtractedAt: timestamp('last_extracted_at', { mode: 'date' }),

    // User-edited flag — once true, extraction no longer overwrites the style card,
    // only refreshes the sample tweets + histograms.
    styleCardEdited: boolean('style_card_edited').notNull().default(false),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    unique('voice_profiles_user_channel').on(t.userId, t.channel),
    index('voice_profiles_user_idx').on(t.userId),
  ],
);
```

- [ ] **Step 1.2: Re-export from the schema index**

In `src/lib/db/schema/index.ts`:

```typescript
export * from './voice-profiles';
```

- [ ] **Step 1.3: Generate the migration**

Run: `pnpm db:generate`
Expected: `drizzle/0020_*.sql` is produced. Rename to `drizzle/0020_voice_profiles.sql`. Inspect: it must `CREATE TABLE voice_profiles` with all columns and the unique index.

- [ ] **Step 1.4: Push to local DB**

Run: `pnpm db:push`
Expected: migration applied.

- [ ] **Step 1.5: Commit**

```bash
git add drizzle/0020_voice_profiles.sql \
        drizzle/meta/ \
        src/lib/db/schema/voice-profiles.ts \
        src/lib/db/schema/index.ts
git commit -m "feat(voice): add voice_profiles table with structured + extracted fields"
```

---

## Task 2: `voice-extractor` agent + schema

**Files:**
- Create: `src/agents/voice-extractor.md`
- Create: `src/skills/voice-extractor/SKILL.md`
- Modify: `src/agents/schemas.ts` — add `voiceExtractorOutputSchema`
- Test: `src/agents/__tests__/voice-extractor-schema.test.ts`

- [ ] **Step 2.1: Write the failing schema test**

```typescript
// src/agents/__tests__/voice-extractor-schema.test.ts
import { describe, it, expect } from 'vitest';
import { voiceExtractorOutputSchema } from '../schemas';

describe('voiceExtractorOutputSchema', () => {
  it('accepts a filled-out extraction', () => {
    const parsed = voiceExtractorOutputSchema.parse({
      styleCardMd: '# Style\n- sentence length: short\n- banned: ...',
      detectedBannedWords: ['leverage', 'delve'],
      topBigrams: [['shipped', 'today'], ['build', 'public']],
      avgSentenceLength: 9.4,
      lengthHistogram: { '0-50': 4, '50-100': 12, '100-150': 9, '150-200': 3, '200-280': 2 },
      openerHistogram: { 'just_shipped': 7, 'til': 3, 'naked_claim': 12 },
      confidence: 0.8,
    });
    expect(parsed.avgSentenceLength).toBeGreaterThan(0);
  });

  it('rejects a missing styleCardMd', () => {
    expect(() =>
      voiceExtractorOutputSchema.parse({
        detectedBannedWords: [],
        topBigrams: [],
        avgSentenceLength: 10,
        lengthHistogram: {},
        openerHistogram: {},
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('caps styleCardMd length', () => {
    const huge = 'a'.repeat(10_000);
    expect(() =>
      voiceExtractorOutputSchema.parse({
        styleCardMd: huge,
        detectedBannedWords: [],
        topBigrams: [],
        avgSentenceLength: 10,
        lengthHistogram: {},
        openerHistogram: {},
        confidence: 0.5,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2.2: Run — verify fail**

Run: `pnpm vitest run src/agents/__tests__/voice-extractor-schema.test.ts`
Expected: FAIL — schema not exported.

- [ ] **Step 2.3: Add the schema**

Append to `src/agents/schemas.ts`:

```typescript
/**
 * Output schema for the voice-extractor agent. Consumes ≤30 sample tweets +
 * the user's structured preferences; emits a markdown style card plus
 * auxiliary metrics used for re-extraction heuristics.
 *
 * The style card is capped at 4000 chars to keep the injected voice block
 * small enough that the primary task prompt retains attention.
 */
export const voiceExtractorOutputSchema = z.object({
  styleCardMd: z.string().min(40).max(4000),
  detectedBannedWords: z.array(z.string()).max(30),
  topBigrams: z.array(z.tuple([z.string(), z.string()])).max(30),
  avgSentenceLength: z.number().positive().max(80),
  lengthHistogram: z.record(z.string(), z.number()),
  openerHistogram: z.record(z.string(), z.number()),
  confidence: z.number().min(0).max(1),
});

export type VoiceExtractorOutput = z.infer<typeof voiceExtractorOutputSchema>;
```

- [ ] **Step 2.4: Run — verify pass**

Run: `pnpm vitest run src/agents/__tests__/voice-extractor-schema.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Write the agent prompt**

Create `src/agents/voice-extractor.md`:

```markdown
---
name: voice-extractor
description: Extracts a markdown style card + histograms from a user's tweet corpus
model: claude-haiku-4-5
tools: []
maxTurns: 1
---

You analyse a founder's X tweet corpus (≤30 engagement-weighted samples) plus
their structured voice preferences and emit a concise markdown **style card**
that any downstream writing agent can inject to mimic their voice.

## Input

```json
{
  "structured": {
    "register": "builder_log",
    "pronouns": "i",
    "capitalization": "sentence",
    "emojiPolicy": "sparing",
    "signatureEmoji": null,
    "punctuationSignatures": ["em_dash"],
    "humorRegister": ["self_deprecating"],
    "bannedWords": [],
    "bannedPhrases": [],
    "worldviewTags": ["pro_craft", "anti_hype"],
    "openerPreferences": ["Just shipped…", "naked_claim"],
    "closerPolicy": "silent_stop"
  },
  "samples": [
    { "id": "...", "text": "...", "engagement": 142 },
    ...
  ]
}
```

## Your job

1. Read the samples. Infer: sentence length distribution, opener histogram,
   lexical fingerprint (top bigrams, signature words), emoji frequency,
   humor register, recurring punctuation tics.
2. Cross-check inferred traits against the structured fields — when they
   disagree, **prefer the user's structured preference** (user knows best).
   Record disagreements in the style card as "user preference:" notes.
3. Detect banned-word candidates: words that appear *zero times* in samples
   but are common AI-slop (`leverage`, `delve`, `utilize`, `robust`,
   `crucial`, `demystify`, `landscape`). Return as `detectedBannedWords`.
4. Produce a `styleCardMd` markdown document with these sections (≤4000 chars):

   ```
   # Voice Profile — {register}

   ## Cadence
   - Average sentence length: {N} words
   - {short/long}, {fragment-tolerant/complete}
   - Distinctive rhythm: ...

   ## Lexicon
   - Signature words: ...
   - Banned (never use): ...
   - Prefers: ... over ...

   ## Punctuation & format
   - ...

   ## Opener moves
   - Preferred: ...
   - Avoids: ...

   ## Closer moves
   - Pattern: {closerPolicy}

   ## Humor register
   - ...

   ## Worldview signals
   - ...

   ## What this founder will never say
   - ...

   ## What this founder says all the time (mimic)
   - example line in their voice
   - example line in their voice
   ```

   The last two sections are the most useful — write them with concrete phrases.
5. Return the histograms you computed; downstream heuristics use them.

## Output

JSON matching `voiceExtractorOutputSchema`. Do not wrap in fences.

- `styleCardMd` — the markdown above
- `detectedBannedWords` — auto-suggested banned list (user may accept/reject)
- `topBigrams` — up to 30 tuples of `[word1, word2]`, stopword-filtered
- `avgSentenceLength` — words per sentence
- `lengthHistogram` — bucketed tweet lengths `{"0-50": N, "50-100": N, ...}`
- `openerHistogram` — `{"just_shipped": N, "til": N, "naked_claim": N, ...}`
- `confidence` — 0.0 if < 5 samples, 1.0 if 20+ clean samples
```

- [ ] **Step 2.6: Write the skill manifest**

Create `src/skills/voice-extractor/SKILL.md`:

```markdown
---
name: voice-extractor
description: Analyse a user's tweet corpus + structured prefs; emit a hybrid style card
context: fork
agent: voice-extractor
model: claude-haiku-4-5
allowed-tools: []
timeout: 60000
cache-safe: false
output-schema: voiceExtractorOutputSchema
---

# Voice Extractor Skill

Runs when the user connects their X account for the first time, when they
click "Re-analyse my voice" in settings, or on a monthly cron when ≥50 new
tweets have accumulated since the last extraction.

## Input

```json
{
  "structured": { /* see agent prompt */ },
  "samples": [ { "id": "...", "text": "...", "engagement": 142 } ]
}
```

## Output

See `voiceExtractorOutputSchema`.
```

- [ ] **Step 2.7: Commit**

```bash
git add src/agents/voice-extractor.md \
        src/skills/voice-extractor/SKILL.md \
        src/agents/schemas.ts \
        src/agents/__tests__/voice-extractor-schema.test.ts
git commit -m "feat(voice): add voice-extractor agent + schema"
```

---

## Task 3: `buildVoiceBlock()` pure helper

**Rationale:** The injection logic is deterministic and deserves to be tested in isolation. `buildVoiceBlock()` takes a voice profile row and returns an XML-wrapped string for prompt injection. Callers (content, slot-body, reply-drafter processors) use this one helper.

**Files:**
- Create: `src/lib/voice/inject.ts`
- Test: `src/lib/voice/__tests__/inject.test.ts`

- [ ] **Step 3.1: Write the failing tests**

```typescript
// src/lib/voice/__tests__/inject.test.ts
import { describe, it, expect } from 'vitest';
import { buildVoiceBlock } from '../inject';
import type { VoiceProfileRow } from '../inject';

function fakeProfile(overrides: Partial<VoiceProfileRow> = {}): VoiceProfileRow {
  return {
    register: 'builder_log',
    pronouns: 'i',
    capitalization: 'sentence',
    emojiPolicy: 'sparing',
    signatureEmoji: null,
    punctuationSignatures: ['em_dash'],
    humorRegister: ['self_deprecating'],
    bannedWords: ['leverage', 'delve'],
    bannedPhrases: ['in today\u2019s fast-paced world'],
    worldviewTags: ['pro_craft'],
    openerPreferences: ['Just shipped…'],
    closerPolicy: 'silent_stop',
    voiceStrength: 'moderate',
    extractedStyleCardMd: '# Voice\n- short sentences\n- never uses em-dash unprompted',
    sampleTweets: Array.from({ length: 15 }, (_, i) => ({
      id: `t${i}`,
      text: `sample tweet ${i} with some content`,
      engagement: 100 - i,
    })),
    ...overrides,
  };
}

describe('buildVoiceBlock', () => {
  it('returns null when profile is undefined', () => {
    expect(buildVoiceBlock(null)).toBeNull();
    expect(buildVoiceBlock(undefined)).toBeNull();
  });

  it('wraps output in <voice_profile> XML', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toMatch(/^<voice_profile>/);
    expect(block).toMatch(/<\/voice_profile>\s*$/);
  });

  it('includes the structured fields', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toContain('builder_log');
    expect(block).toContain('em_dash');
    expect(block).toContain('pro_craft');
  });

  it('includes the extracted style card markdown', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toContain('short sentences');
  });

  it('rotates 5 sample tweets per call (randomised)', () => {
    const profile = fakeProfile();
    const blockA = buildVoiceBlock(profile, { seed: 1 })!;
    const blockB = buildVoiceBlock(profile, { seed: 2 })!;
    // Different seeds produce different sample selections.
    expect(blockA).not.toBe(blockB);
    // Each block contains exactly 5 sample lines.
    const countA = (blockA.match(/<example>/g) ?? []).length;
    expect(countA).toBe(5);
  });

  it('respects voiceStrength: strict → include full card', () => {
    const block = buildVoiceBlock(fakeProfile({ voiceStrength: 'strict' }))!;
    // strict includes bannedPhrases explicitly.
    expect(block).toContain('in today');
  });

  it('respects voiceStrength: loose → omit extractedStyleCardMd', () => {
    const block = buildVoiceBlock(fakeProfile({ voiceStrength: 'loose' }))!;
    expect(block).not.toContain('short sentences');
    // Structured fields still present.
    expect(block).toContain('builder_log');
  });

  it('falls back gracefully when extractedStyleCardMd is null', () => {
    const block = buildVoiceBlock(fakeProfile({ extractedStyleCardMd: null }))!;
    expect(block).toBeTruthy();
    expect(block).toContain('builder_log');
  });

  it('emits an explicit "do not parrot examples verbatim" instruction', () => {
    const block = buildVoiceBlock(fakeProfile())!;
    expect(block).toMatch(/do not (copy|parrot|repeat) (these|example)/i);
  });
});
```

- [ ] **Step 3.2: Run — verify fail**

Run: `pnpm vitest run src/lib/voice/__tests__/inject.test.ts`
Expected: FAIL — helper not found.

- [ ] **Step 3.3: Implement `inject.ts`**

Create `src/lib/voice/inject.ts`:

```typescript
/**
 * Build the <voice_profile> XML block injected into content / slot-body /
 * reply-drafter prompts. Pure function — takes a profile row, returns a
 * string (or null when profile is absent).
 */

export interface VoiceProfileRow {
  register: string;
  pronouns: string;
  capitalization: string;
  emojiPolicy: string;
  signatureEmoji: string | null;
  punctuationSignatures: string[];
  humorRegister: string[];
  bannedWords: string[];
  bannedPhrases: string[];
  worldviewTags: string[];
  openerPreferences: string[];
  closerPolicy: string;
  voiceStrength: string; // 'loose' | 'moderate' | 'strict'
  extractedStyleCardMd: string | null;
  sampleTweets: Array<{ id: string; text: string; engagement: number }>;
}

export interface BuildVoiceBlockOptions {
  /** Random seed for sample rotation. Default: Date.now(). */
  seed?: number;
  /** Number of sample tweets to include. Default: 5. */
  sampleCount?: number;
}

// Simple deterministic shuffle used for deterministic testing.
function seededShuffle<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildVoiceBlock(
  profile: VoiceProfileRow | null | undefined,
  options: BuildVoiceBlockOptions = {},
): string | null {
  if (!profile) return null;

  const { seed = Date.now(), sampleCount = 5 } = options;
  const strength = profile.voiceStrength;
  const includeCard = strength !== 'loose';
  const includeBannedPhrases = strength === 'strict';

  const parts: string[] = ['<voice_profile>'];

  // Structured fields — always included.
  parts.push('<register>' + profile.register + '</register>');
  parts.push('<pronouns>' + profile.pronouns + '</pronouns>');
  parts.push('<capitalization>' + profile.capitalization + '</capitalization>');
  parts.push(
    '<emoji_policy>' +
      profile.emojiPolicy +
      (profile.signatureEmoji ? ` (signature: ${profile.signatureEmoji})` : '') +
      '</emoji_policy>',
  );
  if (profile.punctuationSignatures.length > 0) {
    parts.push(
      '<punctuation>' + profile.punctuationSignatures.join(', ') + '</punctuation>',
    );
  }
  if (profile.humorRegister.length > 0) {
    parts.push('<humor>' + profile.humorRegister.join(', ') + '</humor>');
  }
  if (profile.worldviewTags.length > 0) {
    parts.push('<worldview>' + profile.worldviewTags.join(', ') + '</worldview>');
  }
  if (profile.openerPreferences.length > 0) {
    parts.push('<openers>' + profile.openerPreferences.join(' | ') + '</openers>');
  }
  parts.push('<closer>' + profile.closerPolicy + '</closer>');

  if (profile.bannedWords.length > 0) {
    parts.push('<banned_words>' + profile.bannedWords.join(', ') + '</banned_words>');
  }
  if (includeBannedPhrases && profile.bannedPhrases.length > 0) {
    parts.push(
      '<banned_phrases>' + profile.bannedPhrases.join(' | ') + '</banned_phrases>',
    );
  }

  // Extracted card — moderate + strict only.
  if (includeCard && profile.extractedStyleCardMd) {
    parts.push('<style_card>');
    parts.push(profile.extractedStyleCardMd.trim());
    parts.push('</style_card>');
  }

  // Sample tweets — rotate to prevent over-fitting.
  const pool = profile.sampleTweets;
  if (pool.length > 0) {
    const shuffled = seededShuffle(pool, seed);
    const picks = shuffled.slice(0, Math.min(sampleCount, shuffled.length));
    parts.push('<examples>');
    for (const pick of picks) {
      parts.push('<example>' + pick.text.replace(/\n/g, ' ') + '</example>');
    }
    parts.push('</examples>');
  }

  parts.push(
    '<instruction>Write in the voice described above. Do not copy phrases verbatim from the example tweets — they show rhythm and vocabulary, not content. Honor banned_words as hard constraints.</instruction>',
  );
  parts.push('</voice_profile>');

  return parts.join('\n');
}
```

- [ ] **Step 3.4: Run — verify pass**

Run: `pnpm vitest run src/lib/voice/__tests__/inject.test.ts`
Expected: PASS, all 9 tests.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/voice/inject.ts src/lib/voice/__tests__/inject.test.ts
git commit -m "feat(voice): buildVoiceBlock helper with strength-gated injection + sample rotation"
```

---

## Task 4: Background extraction job

**Files:**
- Create: `src/lib/queue/voice-extract.ts`
- Modify: `src/lib/queue/index.ts`
- Create: `src/workers/processors/voice-extract.ts`
- Test: `src/workers/processors/__tests__/voice-extract.test.ts`

- [ ] **Step 4.1: Add queue + enqueue helper**

Create `src/lib/queue/voice-extract.ts` following the existing queue scaffold pattern (inspect `src/lib/queue/enqueue.ts` or a sibling for the BullMQ wiring in use). Export `voiceExtractQueue` and an `enqueueVoiceExtract(jobData)` helper. Job data type:

```typescript
// src/lib/queue/voice-extract.ts
import { Queue } from 'bullmq';
import { connection } from './connection'; // substitute actual module name

export interface VoiceExtractJobData {
  schemaVersion: 1;
  userId: string;
  channel: 'x';
  triggerReason: 'onboarding' | 'manual' | 'monthly_cron';
  traceId?: string;
}

export const voiceExtractQueue = new Queue<VoiceExtractJobData>('voice-extract', {
  connection,
});

export async function enqueueVoiceExtract(
  data: VoiceExtractJobData,
): Promise<void> {
  await voiceExtractQueue.add('extract', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 50,
    removeOnFail: 100,
  });
}
```

- [ ] **Step 4.2: Register the queue in the top-level queue index**

In `src/lib/queue/index.ts`, export the new queue + helper so the worker registration code (typically in `src/workers/index.ts`) picks it up. Follow the pattern used by existing queues.

- [ ] **Step 4.3: Write the failing processor test**

```typescript
// src/workers/processors/__tests__/voice-extract.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMock = vi.fn();
const insertMock = vi.fn();
const runSkillMock = vi.fn();
const xClientMock = {
  listUserTweets: vi.fn(),
};

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => [
            {
              id: 'vp-1',
              userId: 'u-1',
              channel: 'x',
              register: 'builder_log',
              pronouns: 'i',
              capitalization: 'sentence',
              emojiPolicy: 'sparing',
              signatureEmoji: null,
              punctuationSignatures: [],
              humorRegister: [],
              bannedWords: [],
              bannedPhrases: [],
              worldviewTags: [],
              openerPreferences: [],
              closerPolicy: 'silent_stop',
              voiceStrength: 'moderate',
              extractedStyleCardMd: null,
              sampleTweets: [],
              extractionVersion: 0,
              styleCardEdited: false,
            },
          ],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: () => [{ id: 'vp-1' }] }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (v: unknown) => {
        updateMock(v);
        return { where: () => ({}) };
      },
    }),
  },
}));
vi.mock('@/lib/platform-deps', () => ({
  createPlatformDeps: async () => ({ xClient: xClientMock }),
}));
vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'voice-extractor' }) }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockReset();
});

describe('processVoiceExtract', () => {
  it('skips extraction when styleCardEdited is true (respects user edits)', async () => {
    // Set up a profile that has been user-edited.
    const db = await import('@/lib/db');
    vi.spyOn(db.db, 'select').mockImplementationOnce(
      () =>
        ({
          from: () => ({
            where: () => ({
              limit: () => [
                {
                  id: 'vp-1',
                  userId: 'u-1',
                  channel: 'x',
                  register: 'builder_log',
                  pronouns: 'i',
                  capitalization: 'sentence',
                  emojiPolicy: 'sparing',
                  signatureEmoji: null,
                  punctuationSignatures: [],
                  humorRegister: [],
                  bannedWords: [],
                  bannedPhrases: [],
                  worldviewTags: [],
                  openerPreferences: [],
                  closerPolicy: 'silent_stop',
                  voiceStrength: 'moderate',
                  extractedStyleCardMd: 'user wrote this',
                  sampleTweets: [],
                  extractionVersion: 1,
                  styleCardEdited: true,
                },
              ],
            }),
          }),
        } as never),
    );
    xClientMock.listUserTweets.mockResolvedValueOnce({
      tweets: Array.from({ length: 20 }, (_, i) => ({
        id: `t${i}`,
        text: `t${i}`,
        engagement: i,
      })),
    });

    const { processVoiceExtract } = await import('../voice-extract');
    await processVoiceExtract({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u-1', channel: 'x', triggerReason: 'monthly_cron' },
    } as never);

    // Samples + histograms updated, but styleCardMd not overwritten.
    const setCall = updateMock.mock.calls[0]?.[0];
    expect(setCall).toBeDefined();
    expect(setCall).not.toHaveProperty('extractedStyleCardMd');
    expect(runSkillMock).toHaveBeenCalled(); // histograms still extracted
  });

  it('runs extractor and writes styleCardMd when user has not edited', async () => {
    xClientMock.listUserTweets.mockResolvedValueOnce({
      tweets: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        text: `sample tweet ${i}`,
        engagement: i,
      })),
    });
    runSkillMock.mockResolvedValueOnce({
      results: [
        {
          styleCardMd: '# extracted card',
          detectedBannedWords: ['leverage'],
          topBigrams: [['shipped', 'today']],
          avgSentenceLength: 8.2,
          lengthHistogram: { '50-100': 7, '100-150': 3 },
          openerHistogram: { just_shipped: 4 },
          confidence: 0.8,
        },
      ],
      errors: [],
      usage: { costUsd: 0.001 },
    });

    const { processVoiceExtract } = await import('../voice-extract');
    await processVoiceExtract({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u-1', channel: 'x', triggerReason: 'onboarding' },
    } as never);

    const setCall = updateMock.mock.calls[0]?.[0];
    expect(setCall.extractedStyleCardMd).toContain('extracted card');
    expect(setCall.avgSentenceLength).toBe(8.2);
    expect(setCall.extractionVersion).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4.4: Run — verify fail**

Run: `pnpm vitest run src/workers/processors/__tests__/voice-extract.test.ts`
Expected: FAIL.

- [ ] **Step 4.5: Implement the processor**

Create `src/workers/processors/voice-extract.ts`:

```typescript
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { join } from 'path';
import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema/voice-profiles';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import {
  voiceExtractorOutputSchema,
  type VoiceExtractorOutput,
} from '@/agents/schemas';
import { createPlatformDeps } from '@/lib/platform-deps';
import { recordPipelineEvent } from '@/lib/pipeline-events';
import { createLogger, loggerForJob } from '@/lib/logger';
import type { VoiceExtractJobData } from '@/lib/queue/voice-extract';
import { getTraceId } from '@/lib/queue/types';

const baseLog = createLogger('worker:voice-extract');
const extractorSkill = loadSkill(
  join(process.cwd(), 'src/skills/voice-extractor'),
);

const SAMPLE_LIMIT = 30;

export async function processVoiceExtract(job: Job<VoiceExtractJobData>) {
  const traceId = getTraceId(job.data, job.id);
  const log = loggerForJob(baseLog, job);
  const { userId, channel } = job.data;

  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    log.warn(`voice profile for ${userId} not found — run onboarding first`);
    return;
  }

  // Pull engagement-weighted tweets from the user's connected channel.
  const deps = await createPlatformDeps(channel, userId);
  const xClient = (deps as { xClient?: { listUserTweets: Function } }).xClient;
  if (!xClient) {
    log.warn(`no xClient for ${userId}; skipping extraction`);
    return;
  }
  const { tweets } = await xClient.listUserTweets({
    limit: 200,
    orderBy: 'engagement',
  });

  const samples = tweets.slice(0, SAMPLE_LIMIT).map((t: { id: string; text: string; engagement: number }) => ({
    id: t.id,
    text: t.text,
    engagement: t.engagement,
  }));

  // Run extractor (cheap haiku pass).
  const res = await runSkill<VoiceExtractorOutput>({
    skill: extractorSkill,
    input: {
      structured: {
        register: profile.register,
        pronouns: profile.pronouns,
        capitalization: profile.capitalization,
        emojiPolicy: profile.emojiPolicy,
        signatureEmoji: profile.signatureEmoji,
        punctuationSignatures: profile.punctuationSignatures,
        humorRegister: profile.humorRegister,
        bannedWords: profile.bannedWords,
        bannedPhrases: profile.bannedPhrases,
        worldviewTags: profile.worldviewTags,
        openerPreferences: profile.openerPreferences,
        closerPolicy: profile.closerPolicy,
      },
      samples,
    },
    deps: {},
    outputSchema: voiceExtractorOutputSchema,
    runId: traceId,
  });

  if (res.errors.length > 0 || !res.results[0]) {
    log.warn(`voice extraction failed for ${userId}: ${res.errors[0]?.error ?? 'no result'}`);
    return;
  }

  const extract = res.results[0];

  // Persist — respect styleCardEdited flag.
  const updateSet: Record<string, unknown> = {
    sampleTweets: samples,
    avgSentenceLength: extract.avgSentenceLength,
    lengthHistogram: extract.lengthHistogram,
    openerHistogram: extract.openerHistogram,
    extractionVersion: profile.extractionVersion + 1,
    lastExtractedAt: new Date(),
    updatedAt: new Date(),
  };
  if (!profile.styleCardEdited) {
    updateSet.extractedStyleCardMd = extract.styleCardMd;
    // Offer detected banned words as suggestions, not overwrites — merge with existing.
    const merged = Array.from(new Set([...profile.bannedWords, ...extract.detectedBannedWords]));
    updateSet.bannedWords = merged;
  }

  await db
    .update(voiceProfiles)
    .set(updateSet)
    .where(eq(voiceProfiles.id, profile.id));

  await recordPipelineEvent({
    userId,
    stage: 'voice_extracted',
    cost: res.usage.costUsd,
    metadata: {
      channel,
      sampleCount: samples.length,
      version: Number(updateSet.extractionVersion),
      triggerReason: job.data.triggerReason,
    },
  });

  log.info(
    `voice profile ${profile.id} refreshed (v${updateSet.extractionVersion}, ${samples.length} samples)`,
  );
}
```

- [ ] **Step 4.6: Run tests — verify pass**

Run: `pnpm vitest run src/workers/processors/__tests__/voice-extract.test.ts`
Expected: PASS, both tests.

- [ ] **Step 4.7: Register the processor**

Wire `processVoiceExtract` into the worker bootstrap (usually `src/workers/index.ts`), mirroring how existing processors are registered.

- [ ] **Step 4.8: Commit**

```bash
git add src/lib/queue/voice-extract.ts \
        src/lib/queue/index.ts \
        src/workers/processors/voice-extract.ts \
        src/workers/processors/__tests__/voice-extract.test.ts \
        src/workers/index.ts
git commit -m "feat(voice): background extraction job respecting user-edited style cards"
```

---

## Task 5: Inject voice into content + slot-body + reply-drafter prompts

**Files:**
- Modify: `src/agents/content.md`
- Modify: `src/agents/slot-body-agent.md`
- Modify: `src/agents/reply-drafter.md`
- Modify: `src/workers/processors/calendar-slot-draft.ts`
- Modify: `src/workers/processors/reply-hardening.ts`
- Modify: `src/workers/processors/content.ts`

- [ ] **Step 5.1: Add the anchor to each agent prompt**

In each of `src/agents/content.md`, `src/agents/slot-body-agent.md`, and `src/agents/reply-drafter.md`, add a new section immediately after the `## Input` section:

```markdown
## Voice profile (optional)

If the input contains a `voiceBlock` field, it is an XML fragment describing the user's voice. Honor it. When the voice profile conflicts with the default rules above:

- **Banned words and punctuation signatures** in the voice profile are **hard constraints** — they override defaults.
- **Humor register, pronouns, capitalization** override defaults.
- **Openers and closers** — follow the voice profile's preferences when the register allows.
- **Reply archetype selection and structural rules** (anchor token, 240-char cap, no preamble) are NOT overridden — they apply regardless.

Do not reproduce the `<example>` tweet texts verbatim; they show rhythm and vocabulary, not content.

If `voiceBlock` is absent, proceed with the default rules.
```

- [ ] **Step 5.2: Write a helper loader `loadVoiceBlockForUser()`**

Add to `src/lib/voice/inject.ts`:

```typescript
import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema/voice-profiles';
import { and, eq } from 'drizzle-orm';

/**
 * Fetch voice profile for (userId, channel) and build the injection block.
 * Returns null when no profile exists — callers proceed with defaults.
 */
export async function loadVoiceBlockForUser(
  userId: string,
  channel: string,
  options: BuildVoiceBlockOptions = {},
): Promise<string | null> {
  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.userId, userId), eq(voiceProfiles.channel, channel)))
    .limit(1);

  if (!profile) return null;
  return buildVoiceBlock(profile as VoiceProfileRow, options);
}
```

- [ ] **Step 5.3: Inject in the calendar-slot-draft processor**

In `src/workers/processors/calendar-slot-draft.ts`, before the `runSkill` call, load the voice block:

```typescript
import { loadVoiceBlockForUser } from '@/lib/voice/inject';

// ...inside processCalendarSlotDraft, after loading product/theme:
const voiceBlock = await loadVoiceBlockForUser(userId, channel);
```

Then extend the `runSkill` input with `voiceBlock`:

```typescript
input: {
  // ... existing fields ...
  voiceBlock,
},
```

- [ ] **Step 5.4: Inject in reply-hardening**

In `src/workers/processors/reply-hardening.ts` (from Plan 1), before calling `runSkill({ skill: 'reply-scan', ... })`, load the voice block:

```typescript
import { loadVoiceBlockForUser } from '@/lib/voice/inject';

// inside draftReplyWithHardening:
const voiceBlock = input.userId
  ? await loadVoiceBlockForUser(input.userId, 'x')
  : null;
```

And extend the drafter input:

```typescript
input: {
  tweets: [{ ...input, canMentionProduct, voiceBlock }],
},
```

- [ ] **Step 5.5: Inject in the reply-to-community processor**

Repeat the same pattern in `src/workers/processors/content.ts` (the original-post / reply on community threads path) before its `runSkill` call.

- [ ] **Step 5.6: Update the slot-body SKILL and reply-scan SKILL input schemas to document `voiceBlock`**

In both SKILL.md files, add `voiceBlock: string | null` to the documented Input type.

- [ ] **Step 5.7: Write a contract test that voice block reaches the agent**

```typescript
// src/workers/processors/__tests__/voice-injection-contract.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runSkillMock = vi.fn(async () => ({
  results: [{ tweets: ['ok'], confidence: 0.7, whyItWorks: 'fine' }],
  errors: [],
  usage: { costUsd: 0 },
}));

vi.mock('@/core/skill-runner', () => ({ runSkill: runSkillMock }));
vi.mock('@/core/skill-loader', () => ({ loadSkill: () => ({ name: 'slot-body' }) }));
vi.mock('@/memory/store', () => ({ MemoryStore: class {} }));
vi.mock('@/memory/prompt-builder', () => ({ buildMemoryPrompt: async () => '' }));
vi.mock('@/lib/queue', () => ({ enqueueReview: vi.fn() }));
vi.mock('@/lib/redis', () => ({ publishUserEvent: vi.fn() }));
vi.mock('@/lib/pipeline-events', () => ({ recordPipelineEvent: vi.fn() }));

vi.mock('@/lib/voice/inject', async () => {
  const actual = await vi.importActual<typeof import('@/lib/voice/inject')>('@/lib/voice/inject');
  return {
    ...actual,
    loadVoiceBlockForUser: async () => '<voice_profile>test-block</voice_profile>',
  };
});

// DB mock: any select returns minimal valid rows.
vi.mock('@/lib/db', () => {
  const rows = {
    calendar: [{ id: 'cal-1', isWhiteSpace: false, state: 'queued', topic: 't', contentType: 'metric', angle: 'story', themeId: 'theme-1' }],
    product: [{ id: 'p', name: 'N', description: 'd', valueProp: 'v', keywords: [], lifecyclePhase: 'launched' }],
    theme: [{ id: 'theme-1', thesis: 'claim', thesisSource: 'milestone', pillar: null, fallbackMode: null }],
    prior: [],
    history: [],
  };
  let step = 0;
  return {
    db: {
      select: () => ({
        from: () => ({
          innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: () => rows.history }) }) }),
          where: () => ({
            limit: () => {
              step++;
              if (step === 1) return rows.calendar;
              if (step === 2) return rows.product;
              if (step === 3) return rows.theme;
              return rows.prior;
            },
          }),
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => [{ id: 'x' }], onConflictDoNothing: () => ({ returning: () => [{ id: 'x' }] }) }) }),
      update: () => ({ set: () => ({ where: () => ({}) }) }),
    },
  };
});

beforeEach(() => {
  runSkillMock.mockClear();
});

describe('voice block injection contract', () => {
  it('slot-body processor passes voiceBlock into skill input', async () => {
    const { processCalendarSlotDraft } = await import('../calendar-slot-draft');
    await processCalendarSlotDraft({
      id: 'j',
      data: { schemaVersion: 1, userId: 'u', productId: 'p', calendarItemId: 'cal-1', channel: 'x' },
    } as never);
    const input = runSkillMock.mock.calls[0][0].input;
    expect(input.voiceBlock).toContain('test-block');
  });
});
```

- [ ] **Step 5.8: Run — verify pass**

Run: `pnpm vitest run src/workers/processors/__tests__/voice-injection-contract.test.ts`
Expected: PASS.

- [ ] **Step 5.9: Commit**

```bash
git add src/lib/voice/inject.ts \
        src/agents/content.md \
        src/agents/slot-body-agent.md \
        src/agents/reply-drafter.md \
        src/skills/slot-body/SKILL.md \
        src/skills/reply-scan/SKILL.md \
        src/workers/processors/calendar-slot-draft.ts \
        src/workers/processors/reply-hardening.ts \
        src/workers/processors/content.ts \
        src/workers/processors/__tests__/voice-injection-contract.test.ts
git commit -m "feat(voice): inject <voice_profile> block into content, slot-body, reply prompts"
```

---

## Task 6: Onboarding form + settings API

**Scope note:** The goal is functional, not beautiful. A working 3-step form that writes the structured fields, plus a GET/PUT endpoint and a settings page with the editable style card.

**Files:**
- Create: `src/app/api/voice-profile/route.ts`
- Create: `src/app/(onboarding)/voice/page.tsx`
- Create: `src/app/(settings)/voice/page.tsx`

- [ ] **Step 6.1: Build the GET/PUT route**

Create `src/app/api/voice-profile/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { voiceProfiles } from '@/lib/db/schema/voice-profiles';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const updateSchema = z.object({
  channel: z.string().default('x'),
  register: z.enum(['builder_log', 'operator_essay', 'shitposter', 'thought_leader', 'researcher']).optional(),
  pronouns: z.enum(['i', 'we', 'you_direct']).optional(),
  capitalization: z.enum(['sentence', 'lowercase', 'title']).optional(),
  emojiPolicy: z.enum(['none', 'sparing', 'signature']).optional(),
  signatureEmoji: z.string().max(8).nullable().optional(),
  punctuationSignatures: z.array(z.enum(['em_dash','ellipsis','parenthetical_aside','one_line_per_sentence'])).optional(),
  humorRegister: z.array(z.enum(['self_deprecating','dry','absurdist','meme','none'])).optional(),
  bannedWords: z.array(z.string()).optional(),
  bannedPhrases: z.array(z.string()).optional(),
  worldviewTags: z.array(z.enum(['pro_craft','anti_hype','pro_hustle','pro_calm','contrarian','pro_open_source'])).optional(),
  openerPreferences: z.array(z.string()).optional(),
  closerPolicy: z.enum(['question', 'cta', 'payoff', 'silent_stop']).optional(),
  voiceStrength: z.enum(['loose', 'moderate', 'strict']).optional(),
  extractedStyleCardMd: z.string().max(4000).optional(),
  markEdited: z.boolean().optional(),
});

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const channel = url.searchParams.get('channel') ?? 'x';
  const [profile] = await db
    .select()
    .from(voiceProfiles)
    .where(and(eq(voiceProfiles.userId, session.user.id), eq(voiceProfiles.channel, channel)))
    .limit(1);
  return NextResponse.json({ profile: profile ?? null });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = updateSchema.parse(await req.json());
  const { channel, markEdited, ...rest } = body;
  const setValues: Record<string, unknown> = { ...rest, updatedAt: new Date() };
  if (markEdited) setValues.styleCardEdited = true;

  await db
    .insert(voiceProfiles)
    .values({ userId: session.user.id, channel, ...rest, styleCardEdited: !!markEdited })
    .onConflictDoUpdate({
      target: [voiceProfiles.userId, voiceProfiles.channel],
      set: setValues,
    });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6.2: Write the onboarding page (3 steps, ≤90 sec)**

Create `src/app/(onboarding)/voice/page.tsx` — a simple client component with three steps:

1. **Archetype picker** — 5 cards (`builder_log` / `operator_essay` / `shitposter` / `thought_leader` / `researcher`). Each seeds sensible defaults for emoji/pronouns/opener.
2. **Choices** — pronouns radio, capitalization radio, emoji policy radio (with optional signature emoji input), humor register multiselect.
3. **Banned list** — free-text comma-separated with 5 suggested buttons (`delve`, `leverage`, `utilize`, `robust`, `crucial`) the user can tap to add.

On submit, PUT to `/api/voice-profile`, then enqueue a voice extraction via `POST /api/voice-profile/extract` (create this trivial route too — body = `{ channel }`, calls `enqueueVoiceExtract`). Redirect to `/dashboard`.

Skeleton code (shadcn or minimal CSS; both are fine):

```tsx
'use client';
import { useState } from 'react';

const ARCHETYPES = [
  { id: 'builder_log', label: 'Builder log', blurb: 'Short ship-updates, numbers, demo clips.' },
  { id: 'operator_essay', label: 'Operator essay', blurb: 'Mid-length reflections on how to run things.' },
  { id: 'shitposter', label: 'Shitposter', blurb: 'Dry wit, absurdist observations, one-liners.' },
  { id: 'thought_leader', label: 'Thought leader', blurb: 'Frameworks, aphorisms, worldview-stating.' },
  { id: 'researcher', label: 'Researcher', blurb: 'Data-first, cited claims, careful hedges.' },
];

export default function VoiceOnboardingPage() {
  const [step, setStep] = useState(0);
  const [archetype, setArchetype] = useState('builder_log');
  const [pronouns, setPronouns] = useState<'i' | 'we' | 'you_direct'>('i');
  const [capitalization, setCapitalization] = useState<'sentence' | 'lowercase' | 'title'>('sentence');
  const [emojiPolicy, setEmojiPolicy] = useState<'none' | 'sparing' | 'signature'>('sparing');
  const [bannedWords, setBannedWords] = useState<string[]>([]);

  async function submit() {
    await fetch('/api/voice-profile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'x',
        register: archetype,
        pronouns,
        capitalization,
        emojiPolicy,
        bannedWords,
      }),
    });
    await fetch('/api/voice-profile/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'x' }),
    });
    window.location.href = '/dashboard';
  }

  return (
    <main className="max-w-lg mx-auto p-8">
      {step === 0 && (
        <div>
          <h1 className="text-2xl font-semibold">Pick your register</h1>
          <div className="grid gap-3 mt-4">
            {ARCHETYPES.map((a) => (
              <button
                key={a.id}
                onClick={() => { setArchetype(a.id); setStep(1); }}
                className={`text-left p-4 border rounded ${archetype === a.id ? 'border-black' : 'border-gray-200'}`}
              >
                <div className="font-medium">{a.label}</div>
                <div className="text-sm text-gray-500">{a.blurb}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 1 && (
        <div>
          <h1 className="text-2xl font-semibold">How do you usually write?</h1>
          <div className="mt-4 space-y-4">
            <label>Pronouns
              <select value={pronouns} onChange={(e) => setPronouns(e.target.value as typeof pronouns)}>
                <option value="i">I (solo)</option>
                <option value="we">We (team)</option>
                <option value="you_direct">You (addressing reader)</option>
              </select>
            </label>
            <label>Capitalization
              <select value={capitalization} onChange={(e) => setCapitalization(e.target.value as typeof capitalization)}>
                <option value="sentence">Sentence case</option>
                <option value="lowercase">all lowercase</option>
                <option value="title">Title Case</option>
              </select>
            </label>
            <label>Emoji policy
              <select value={emojiPolicy} onChange={(e) => setEmojiPolicy(e.target.value as typeof emojiPolicy)}>
                <option value="none">never</option>
                <option value="sparing">sparing (≤1 / tweet)</option>
                <option value="signature">signature emoji</option>
              </select>
            </label>
            <button onClick={() => setStep(2)}>Next</button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div>
          <h1 className="text-2xl font-semibold">Words you never want to see</h1>
          <p className="text-sm text-gray-500 mt-2">Tap any that apply, or type your own.</p>
          <div className="flex flex-wrap gap-2 mt-4">
            {['delve', 'leverage', 'utilize', 'robust', 'crucial', 'demystify'].map((w) => (
              <button
                key={w}
                onClick={() =>
                  setBannedWords((prev) => prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w])
                }
                className={`px-3 py-1 rounded-full border ${bannedWords.includes(w) ? 'bg-black text-white' : ''}`}
              >{w}</button>
            ))}
          </div>
          <textarea
            placeholder="other words, comma separated"
            className="mt-4 w-full border p-2"
            onBlur={(e) => setBannedWords((prev) => [...new Set([...prev, ...e.target.value.split(',').map((s) => s.trim()).filter(Boolean)])])}
          />
          <button onClick={submit} className="mt-4 px-4 py-2 bg-black text-white rounded">Finish</button>
        </div>
      )}
    </main>
  );
}
```

- [ ] **Step 6.3: Add the settings page (editable style card)**

Create `src/app/(settings)/voice/page.tsx` — a page that:
- GETs `/api/voice-profile`
- Renders the same structured controls as onboarding, pre-filled
- Adds a large `<textarea>` bound to `extractedStyleCardMd`
- On save, PUTs with `markEdited: true` if the textarea was modified (preserves user edits from being overwritten by the next extraction)
- Exposes a "Re-analyse my voice" button → `POST /api/voice-profile/extract`

Implementation can mirror the onboarding page structure — keep it minimal.

- [ ] **Step 6.4: Add the extract endpoint**

```typescript
// src/app/api/voice-profile/extract/route.ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { enqueueVoiceExtract } from '@/lib/queue/voice-extract';
import { z } from 'zod';

const bodySchema = z.object({ channel: z.string().default('x') });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { channel } = bodySchema.parse(await req.json());
  await enqueueVoiceExtract({
    schemaVersion: 1,
    userId: session.user.id,
    channel: channel as 'x',
    triggerReason: 'manual',
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6.5: Commit**

```bash
git add src/app/api/voice-profile/ \
        src/app/\(onboarding\)/voice/ \
        src/app/\(settings\)/voice/
git commit -m "feat(voice): onboarding (3-step), settings page, GET/PUT + extract endpoints"
```

---

## Task 7: Monthly cron + threshold-triggered re-extraction

- [ ] **Step 7.1: Locate the existing cron scaffold**

Grep for existing cron registrations (search for `BullMQ`, `repeat`, `cron`, `scheduler` in `src/workers/`). Identify where other scheduled jobs (stalled-row-sweep) are registered.

- [ ] **Step 7.2: Register a monthly voice-extract cron**

In the worker bootstrap, add:

```typescript
await voiceExtractQueue.add(
  'monthly-extract-all',
  { schemaVersion: 1, userId: '__all__', channel: 'x', triggerReason: 'monthly_cron' },
  { repeat: { pattern: '0 4 1 * *' } }, // 04:00 UTC on the 1st of every month
);
```

Add a processor branch: when `userId === '__all__'`, fan out one `voice-extract` job per user with a connected X channel — users whose `lastExtractedAt` is older than 30 days OR whose `sampleTweets` count < 10.

- [ ] **Step 7.3: Add threshold-triggered re-extraction**

In the posting success path (find `xPosts` insert / `postingQueue` complete handler), after a post is published:

```typescript
// After successful post insert — check if 50 new posts have accumulated since last extract.
import { voiceProfiles } from '@/lib/db/schema/voice-profiles';
import { enqueueVoiceExtract } from '@/lib/queue/voice-extract';

const [vp] = await db
  .select({
    id: voiceProfiles.id,
    lastExtractedAt: voiceProfiles.lastExtractedAt,
    styleCardEdited: voiceProfiles.styleCardEdited,
  })
  .from(voiceProfiles)
  .where(and(eq(voiceProfiles.userId, userId), eq(voiceProfiles.channel, 'x')))
  .limit(1);

if (vp && !vp.styleCardEdited) {
  const daysSince = vp.lastExtractedAt
    ? (Date.now() - vp.lastExtractedAt.getTime()) / 86_400_000
    : 999;
  if (daysSince > 14) {
    await enqueueVoiceExtract({ schemaVersion: 1, userId, channel: 'x', triggerReason: 'monthly_cron' });
  }
}
```

- [ ] **Step 7.4: Commit**

```bash
git add src/workers/
git commit -m "feat(voice): monthly cron + post-threshold re-extraction"
```

---

## Task 8: Smoke test — end-to-end voice on a real draft

- [ ] **Step 8.1: Seed a voice profile manually**

Pick a test user with a connected X channel. Insert a voice profile:

```sql
INSERT INTO voice_profiles (user_id, channel, register, pronouns, emoji_policy, banned_words)
VALUES ('<userId>', 'x', 'builder_log', 'i', 'sparing', '["delve","leverage"]'::jsonb);
```

- [ ] **Step 8.2: Trigger extraction**

```bash
curl -X POST https://localhost:3000/api/voice-profile/extract \
  -H 'content-type: application/json' \
  -d '{"channel":"x"}'
```

Wait for the job to complete, then query `voice_profiles` — verify `extractedStyleCardMd` is non-null, `sampleTweets` contains tweets, `extractionVersion` is 1+.

- [ ] **Step 8.3: Trigger a calendar-plan run and a reply scan**

Kick off a calendar plan + a reply draft round. Query the resulting drafts.

- [ ] **Step 8.4: Inspect the output**

For each draft, verify by manual read:
- [ ] Tone matches the seeded register (`builder_log` → short, first-person, data-leading)
- [ ] Banned words (`delve`, `leverage`) do not appear
- [ ] No AI-slop patterns (em-dash overuse, `As someone who…`, triple grouping)
- [ ] Voice feels plausibly like the user, not generic

If drafts still feel generic: raise `voiceStrength` to `strict` via the settings page and re-run. If they parrot sample tweets verbatim: that's an over-fitting signal — lower to `loose` and iterate on the extractor prompt.

- [ ] **Step 8.5: Commit any fixture adjustments**

```bash
git commit --allow-empty -m "test(voice): smoke-verified end-to-end injection on seeded profile"
```

---

## Self-review checklist

- [ ] Field names are spelled identically across migration, Drizzle model, Zod schemas, agent prompts, `buildVoiceBlock`, API route, onboarding UI: `register`, `pronouns`, `capitalization`, `emojiPolicy`, `punctuationSignatures`, `humorRegister`, `bannedWords`, `bannedPhrases`, `worldviewTags`, `openerPreferences`, `closerPolicy`, `voiceStrength`, `extractedStyleCardMd`, `sampleTweets`, `styleCardEdited`.
- [ ] Enum values are frozen: `register ∈ {builder_log, operator_essay, shitposter, thought_leader, researcher}`, `voiceStrength ∈ {loose, moderate, strict}`, `closerPolicy ∈ {question, cta, payoff, silent_stop}`.
- [ ] `styleCardEdited = true` disables overwrite in the extractor processor (Task 4.5). This is the user-trust contract — never violate it elsewhere.
- [ ] Every processor that previously called `runSkill` on content / slot-body / reply now loads `voiceBlock` via `loadVoiceBlockForUser()` — no duplicate DB query logic.
- [ ] `voiceBlock: string | null` flows through as an opaque string; no processor parses its contents.
- [ ] The plan does **not** remove any behavior from Plan 1's reply hardening — voice only augments. The AI-slop validator and anchor-token validator still run after drafting; voice-mandated banned words are *additional* hard constraints, not replacements.
- [ ] Plan 2's `priorAnglesThisWeek` and Plan 3's `voiceBlock` both flow into `slot-body` input — both are additive, neither conflicts.
- [ ] Sample tweets are rotated per generation (seeded shuffle in `buildVoiceBlock`). Users do not see the same 5 examples every time.
- [ ] The monthly cron fan-out carefully gates on `styleCardEdited` — users who curated their own style card are never overwritten.
