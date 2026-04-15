# Discovery Auto-Optimizer: Per-User Calibration System

## Context

We manually ran an eval-optimize loop over 7 rounds to improve discovery precision from ~47% to ~88%. Each round:
1. Run discovery pipeline → surface threads
2. Judge each thread: "Is the author a potential user?"
3. Analyze failure patterns (wrong sub-domain, teaching/sharing, competitor promo)
4. Edit strategy files, query templates, scoring rubric, and weights
5. Re-run to verify

**Goal**: Automate this loop per-user. Trigger: user binds a product. Run up to 10 rounds. Target: precision >= 80%. The optimizer can edit strategies, rubrics, query templates, and scoring weights — all stored per-user in DB.

---

## Architecture Overview

```
User binds product (onboarding complete)
    │
    ▼
Calibration Job starts (background, BullMQ)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  CALIBRATION LOOP (up to 10 rounds)                         │
│                                                             │
│  1. Run discovery pipeline with current config              │
│     ├── generate_queries (base + user overrides)            │
│     ├── reddit_search / x_search                            │
│     ├── Discovery agent (base prompt + user strategy layer) │
│     └── score_threads (base weights + user overrides)       │
│                                                             │
│  2. AI Judge evaluates each thread with score > 50          │
│     "Is this author a potential user of {product}?"         │
│     → YES/NO with reason                                    │
│                                                             │
│  3. Compute precision = YES / (YES + NO)                    │
│                                                             │
│  4. If precision >= 0.80 → DONE, save config                │
│                                                             │
│  5. If precision < 0.80 →                                   │
│     Optimizer agent analyzes false positives                 │
│     Generates strategy edits (rules, queries, weights)      │
│     Applies edits to discovery_configs in DB                │
│     → next round                                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
User's discovery pipeline now runs with optimized config
    │
    ▼
Continuous refinement (optional, later):
  User approve/skip on drafts → precision re-check → re-optimize if drifts
```

### Two-Layer Architecture

Can't edit source files per-user in a multi-tenant deployment. Instead:

| Layer | Where | What | Who edits |
|-------|-------|------|-----------|
| **Base layer** | Source code (git) | Default agent prompt, scoring rubric, query templates, platform strategies | Developer |
| **User layer** | Database (`discovery_configs`) | Per-user overrides: custom rubric rules, query phrases, scoring weights, strategy adjustments | Optimizer agent |

At runtime: base + user overrides merged → sent to discovery agent via user message input (preserves prompt cache).

---

## Phase 1: Per-User Config Schema

### New table: `discovery_configs`

```typescript
// src/lib/db/schema/discovery-configs.ts

export const discoveryConfigs = pgTable('discovery_configs', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull().default('reddit'),

  // ---- Numeric tuning ----
  weightRelevance: real('weight_relevance').notNull().default(0.30),
  weightIntent: real('weight_intent').notNull().default(0.45),
  weightExposure: real('weight_exposure').notNull().default(0.10),
  weightFreshness: real('weight_freshness').notNull().default(0.10),
  weightEngagement: real('weight_engagement').notNull().default(0.05),
  intentGate: real('intent_gate').notNull().default(0.50),
  relevanceGate: real('relevance_gate').notNull().default(0.50),
  gateCap: real('gate_cap').notNull().default(0.45),
  enqueueThreshold: real('enqueue_threshold').notNull().default(0.70),

  // ---- Strategy overrides (LLM-generated, per-user) ----

  // Custom pain phrases (override/augment extractPainPhrase output)
  customPainPhrases: text('custom_pain_phrases').array().default([]),

  // Custom query templates (appended to generate_queries output)
  customQueryTemplates: text('custom_query_templates').array().default([]),

  // LLM-generated rubric additions injected into agent prompt
  // e.g., "For this product, SEO-related threads are always irrelevant"
  strategyRules: text('strategy_rules'),  // markdown block

  // Platform-specific strategy overrides
  platformStrategyOverride: text('platform_strategy_override'),  // markdown block

  // Low-relevance override patterns
  // e.g., "Posts about 'passive income' or 'dropshipping' = relevance ≤ 0.1"
  customLowRelevancePatterns: text('custom_low_relevance_patterns'),  // markdown block

  // ---- Calibration metadata ----
  calibrationStatus: text('calibration_status', {
    enum: ['pending', 'running', 'completed', 'failed'],
  }).notNull().default('pending'),
  calibrationRound: integer('calibration_round').notNull().default(0),
  calibrationPrecision: real('calibration_precision'),  // precision at completion
  calibrationLog: jsonb('calibration_log'),  // [{round, precision, changes, timestamp}]

  // ---- Ongoing optimization metadata ----
  optimizationVersion: integer('optimization_version').notNull().default(0),
  runsSinceOptimization: integer('runs_since_optimization').notNull().default(0),
  lastOptimizedAt: timestamp('last_optimized_at'),
  precisionAtOptimization: real('precision_at_optimization'),

  // Rollback support
  previousConfig: jsonb('previous_config'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userPlatformUnique: unique().on(table.userId, table.platform),
}));
```

### Why separate from `userPreferences`?

- `userPreferences` = human-facing settings (posting hours, content mix)
- `discoveryConfigs` = machine-tuned parameters (weights, LLM-generated strategy rules)
- Different lifecycle: preferences change on user click, configs change on optimizer run

---

## Phase 2: The Calibration Loop

### Trigger: Product binding

When a user completes onboarding (product saved with name, description, valueProp, keywords):

```typescript
// In the product save handler (onboarding completion or product update)

// 1. Create default discovery_configs for each connected platform
for (const platform of connectedPlatforms) {
  await db.insert(discoveryConfigs).values({
    userId,
    platform,
    calibrationStatus: 'pending',
  }).onConflictDoNothing();  // idempotent
}

// 2. Enqueue calibration job
await enqueueCalibration({ userId, productId });
```

### New queue: `calibrationQueue`

```typescript
// src/lib/queue/types.ts
export interface CalibrationJobData {
  userId: string;
  productId: string;
}

// src/lib/queue/index.ts
export const calibrationQueue = new Queue<CalibrationJobData>('calibration', {
  connection: redis,
  defaultJobOptions: {
    attempts: 1,        // don't retry — partial progress is saved
    timeout: 30 * 60_000,  // 30 min max
  },
});
```

### Calibration processor

```typescript
// src/workers/processors/calibrate-discovery.ts

const MAX_ROUNDS = 10;
const TARGET_PRECISION = 0.80;
const SCORE_THRESHOLD = 50;  // evaluate threads above this score

export async function processCalibration(job: Job<CalibrationJobData>) {
  const { userId, productId } = job.data;

  const product = await loadProduct(productId);
  const platforms = await getConnectedPlatforms(userId);

  for (const platform of platforms) {
    const config = await loadOrCreateConfig(userId, platform);

    // Skip if already calibrated
    if (config.calibrationStatus === 'completed') continue;

    await db.update(discoveryConfigs)
      .set({ calibrationStatus: 'running' })
      .where(eq(discoveryConfigs.id, config.id));

    const calibrationLog: CalibrationLogEntry[] =
      (config.calibrationLog as CalibrationLogEntry[]) ?? [];

    // Resume from last completed round (crash recovery)
    const startRound = config.calibrationRound;

    for (let round = startRound; round < MAX_ROUNDS; round++) {
      log.info(`Calibration round ${round + 1}/${MAX_ROUNDS} for ${platform}, user ${userId}`);

      // Publish progress to UI via SSE
      await publishEvent(userId, {
        type: 'calibration_progress',
        platform,
        round: round + 1,
        maxRounds: MAX_ROUNDS,
      });

      // ── Step 1: Run discovery with current config ──
      const discoveryResult = await runDiscoveryWithConfig(
        product, platform, userId, config,
      );

      // ── Step 2: AI Judge evaluates threads above threshold ──
      const threadsAboveThreshold = discoveryResult.threads
        .filter(t => t.relevanceScore > SCORE_THRESHOLD);

      if (threadsAboveThreshold.length === 0) {
        log.info(`No threads above threshold ${SCORE_THRESHOLD}, skipping round`);
        calibrationLog.push({
          round: round + 1,
          precision: null,
          evaluated: 0,
          changes: 'No threads to evaluate',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      const judgments = await judgeThreadsBatch(
        product, threadsAboveThreshold, platform,
      );

      const potentialUsers = judgments.filter(j => j.isPotentialUser);
      const precision = potentialUsers.length / judgments.length;

      log.info(`Round ${round + 1}: precision=${(precision * 100).toFixed(0)}% (${potentialUsers.length}/${judgments.length})`);

      // ── Step 3: Check if target reached ──
      if (precision >= TARGET_PRECISION) {
        calibrationLog.push({
          round: round + 1,
          precision,
          evaluated: judgments.length,
          changes: 'Target reached',
          timestamp: new Date().toISOString(),
        });

        await db.update(discoveryConfigs).set({
          calibrationStatus: 'completed',
          calibrationRound: round + 1,
          calibrationPrecision: precision,
          calibrationLog,
          updatedAt: new Date(),
        }).where(eq(discoveryConfigs.id, config.id));

        log.info(`✓ Calibration complete for ${platform}: precision=${(precision * 100).toFixed(0)}% after ${round + 1} rounds`);
        break;
      }

      // ── Step 4: Optimize — analyze failures, generate strategy edits ──
      const falsePositives = judgments
        .filter(j => !j.isPotentialUser)
        .map(j => ({ ...j.thread, judgeReason: j.reason }));

      const truePositives = judgments
        .filter(j => j.isPotentialUser)
        .map(j => ({ ...j.thread, judgeReason: j.reason }));

      const optimizerResult = await runOptimizerAgent({
        product,
        platform,
        currentConfig: config,
        falsePositives,
        truePositives,
        precision,
        round: round + 1,
        previousLog: calibrationLog,
      });

      // ── Step 5: Apply edits ──
      const appliedChanges = await applyOptimization(config, optimizerResult);

      calibrationLog.push({
        round: round + 1,
        precision,
        evaluated: judgments.length,
        changes: optimizerResult.analysis,
        appliedChanges,
        timestamp: new Date().toISOString(),
      });

      // Save progress (crash recovery checkpoint)
      await db.update(discoveryConfigs).set({
        calibrationRound: round + 1,
        calibrationLog,
        updatedAt: new Date(),
      }).where(eq(discoveryConfigs.id, config.id));

      // Reload config for next round (it was just updated)
      config = await loadConfig(config.id);
    }

    // If we exhausted 10 rounds without hitting 80%, save best effort
    if (config.calibrationStatus !== 'completed') {
      await db.update(discoveryConfigs).set({
        calibrationStatus: 'completed',  // still "completed" — best effort
        calibrationPrecision: calibrationLog.at(-1)?.precision ?? null,
        calibrationLog,
        updatedAt: new Date(),
      }).where(eq(discoveryConfigs.id, config.id));

      log.info(`Calibration finished for ${platform} after ${MAX_ROUNDS} rounds (best-effort)`);
    }
  }
}
```

---

## Phase 3: The AI Judge

The judge replaces manual human evaluation. It's a simple YES/NO classification — much easier for an LLM than nuanced scoring.

### Judge tool

```typescript
// src/lib/discovery/judge.ts

const JUDGE_SYSTEM = `You evaluate whether a thread author is a potential user of a product.

A potential user satisfies ALL THREE:
1. Has a pain point the product specifically solves
2. Is open to solutions (asking questions, seeking tools, describing struggles)
3. Is NOT a competitor promoting their own solution

Respond with JSON: {"isPotentialUser": true/false, "reason": "one sentence"}`;

export async function judgeThreadsBatch(
  product: Product,
  threads: ScoredThread[],
  platform: string,
): Promise<Judgment[]> {
  // Batch all threads into a single Haiku call for cost efficiency
  const userMessage = JSON.stringify({
    product: {
      name: product.name,
      description: product.description,
      valueProp: product.valueProp,
    },
    threads: threads.map(t => ({
      id: t.id,
      title: t.title,
      community: t.community,
      reason: t.reason,
      scores: t.scores,
    })),
  });

  const result = await callModel({
    model: 'claude-haiku-4-5-20251001',
    system: JUDGE_SYSTEM,
    userMessage: `Evaluate each thread. For each, answer: is the author a potential user of "${product.name}"?\n\n${userMessage}`,
    outputSchema: z.object({
      judgments: z.array(z.object({
        id: z.string(),
        isPotentialUser: z.boolean(),
        reason: z.string(),
      })),
    }),
  });

  return result.judgments.map(j => ({
    ...j,
    thread: threads.find(t => t.id === j.id)!,
  }));
}
```

### Cost per round

| Component | Cost |
|-----------|------|
| Discovery pipeline (Haiku, 3 sources × fan-out) | ~$0.04-0.12 |
| AI Judge (Haiku, batch ~5-15 threads) | ~$0.005-0.01 |
| Optimizer agent (Sonnet, single call) | ~$0.02-0.05 |
| **Total per round** | **~$0.07-0.18** |
| **Full calibration (up to 10 rounds)** | **~$0.70-1.80 per user** |

This is a one-time cost at product binding. Acceptable for user onboarding.

---

## Phase 4: The Optimizer Agent

The optimizer is Sonnet — it sees the false positives and true positives from the judge, analyzes failure patterns, and generates concrete strategy edits.

### Agent prompt

```markdown
# src/agents/optimize-discovery.md
---
name: optimize-discovery
description: Analyzes discovery precision failures and generates strategy edits
model: claude-sonnet-4-6
---

You are a Discovery Optimization Agent. You analyze why false-positive threads
were surfaced and generate targeted strategy edits to improve precision.

## Input

- Product context (name, description, valueProp)
- Platform being optimized
- Current config (weights, thresholds, existing strategy rules)
- False positives: threads the judge said are NOT potential users (with reasons)
- True positives: threads the judge confirmed ARE potential users
- Current precision rate
- Calibration round number and history of previous rounds

## Your Task

1. **Analyze failure patterns** in the false positives. Group by root cause:
   - Wrong sub-domain (topic overlaps but author's specific need doesn't match)
   - Teaching/sharing (author giving advice, not seeking help)
   - Competitor self-promotion
   - Generic venting without actionable pain point
   - Other pattern (describe it)

2. **For each pattern, choose the right fix type**:

   a. **Strategy rule** (highest impact — new rubric rule for the agent):
      Write a product-specific rule the discovery agent should follow.
      Example: "For this scheduling tool, threads about project management
      methodology are irrelevant — the author needs scheduling, not methodology"

   b. **Query fix** (fix what gets searched):
      Add custom pain phrases that better match this product's users.
      Remove/replace queries that attract the wrong audience.

   c. **Numeric fix** (adjust scoring math):
      Tune weights or thresholds only if the pattern is systematic.
      - Too many low-intent threads → raise intent weight or intent gate
      - Wrong sub-domain consistently leaking → raise relevance gate

   d. **Low-relevance pattern** (blocklist for this product):
      Specific topics/patterns that should always score low for this product.
      Example: "Threads about 'dropshipping' or 'passive income' = relevance ≤ 0.1"

3. **Review previous rounds** (in the calibration history). Don't repeat changes
   that didn't work. If a previous fix made precision worse, undo it.

## Output

Return JSON:

{
  "analysis": "2-3 sentence summary of what's wrong and what you're fixing",
  "numericChanges": {
    "weightRelevance": 0.30,  // only include fields that changed
    "weightIntent": 0.48
  },
  "strategyRules": "Markdown rules to ADD (not replace existing rules)",
  "customLowRelevancePatterns": "Markdown patterns that should score ≤ 0.2",
  "customPainPhrases": ["phrase targeting actual users of this product"],
  "customQueryTemplates": ["query template targeting this product's user base"],
  "platformStrategyOverride": "Platform-specific adjustment if needed",
  "undoFromPreviousRound": ["description of any previous rules to remove"]
}

## Constraints

- Strategy rules MUST be specific to this product's domain, not generic.
- Custom queries MUST target question-askers and struggle-describers.
- Be incremental — make 1-3 targeted changes per round, not wholesale rewrites.
- If precision is already 70%+, make only surgical adjustments.
- If a round's changes made things worse (check history), revert that change.
```

### Round-over-round learning

The optimizer sees the full calibration log, so it can learn from previous rounds:

```typescript
const optimizerInput = {
  product: { name, description, valueProp },
  platform,
  currentConfig: {
    weights: { relevance, intent, exposure, freshness, engagement },
    intentGate, relevanceGate, gateCap,
    strategyRules: config.strategyRules,
    customLowRelevancePatterns: config.customLowRelevancePatterns,
    customPainPhrases: config.customPainPhrases,
    customQueryTemplates: config.customQueryTemplates,
  },
  falsePositives,  // from this round's judge
  truePositives,   // from this round's judge
  precision,       // this round
  round,
  previousLog: calibrationLog,  // all previous rounds: {precision, changes}
};
```

---

## Phase 5: Strategy Injection at Runtime

After calibration, every subsequent discovery run loads the user's config and injects it.

### 5a. score_threads — accept optional weight overrides

```typescript
// score-threads.ts — input schema change
config: z.object({
  weights: z.object({ relevance, intent, exposure, freshness, engagement }).optional(),
  intentGate: z.number().optional(),
  relevanceGate: z.number().optional(),
  gateCap: z.number().optional(),
}).optional(),

// In execute():
const weights = input.config?.weights ?? SCORE_WEIGHTS;
const intentGate = input.config?.intentGate ?? 0.50;
const relevanceGate = input.config?.relevanceGate ?? 0.50;
const gateCap = input.config?.gateCap ?? 0.45;
```

### 5b. generate_queries — accept custom phrases

```typescript
// generate-queries.ts — input schema addition
customPainPhrases: z.array(z.string()).optional(),
customQueryTemplates: z.array(z.string()).optional(),

// After standard 6 queries, append user's custom ones
for (const phrase of input.customPainPhrases ?? []) {
  queries.push(phrase);
}
for (const template of input.customQueryTemplates ?? []) {
  queries.push(template);
}
```

### 5c. Strategy rules via user message input

Injected into the JSON input the agent receives (NOT the system prompt — preserves prompt cache):

```typescript
// discovery processor — when building skill input
const config = await loadDiscoveryConfig(userId, platform);

const input = {
  productName: product.name,
  productDescription: product.description,
  keywords: product.keywords,
  valueProp: product.valueProp,
  sources,
  platform,
  // Per-user config
  scoringConfig: config ? {
    weights: extractWeights(config),
    intentGate: config.intentGate,
    relevanceGate: config.relevanceGate,
    gateCap: config.gateCap,
  } : undefined,
  customPainPhrases: config?.customPainPhrases ?? [],
  customQueryTemplates: config?.customQueryTemplates ?? [],
  additionalRules: config?.strategyRules ?? null,
  additionalLowRelevancePatterns: config?.customLowRelevancePatterns ?? null,
};
```

In `discovery.md`, add:
```markdown
## User-Specific Rules

If the input contains `additionalRules`, apply them as additional scoring criteria.
If the input contains `additionalLowRelevancePatterns`, treat them as additional
low-relevance overrides (score ≤ 0.2 when pattern matches).
Pass `scoringConfig` through to the `score_threads` tool call as the `config` parameter.
```

### 5d. Enqueue threshold from config

```typescript
const enqueueThreshold = config?.enqueueThreshold ?? 0.7;
if (relevanceScore >= enqueueThreshold && inserted) {
  await enqueueContent({ userId, threadId: inserted.id, productId });
}
```

---

## Phase 6: Continuous Refinement (Post-Calibration)

After initial calibration, precision can drift as the user's product evolves or community landscapes shift. Two refinement signals:

### 6a. User feedback signal

```typescript
// When user approves/skips a draft → propagate to source thread
if (action === 'approve' || action === 'skip') {
  await db.update(threads).set({
    validated: action === 'approve',
    validatedAt: new Date(),
  }).where(eq(threads.id, draft.threadId));
}
```

### 6b. Periodic re-optimization

After every 10 discovery runs (tracked by `runsSinceOptimization`), compute precision from user feedback. If it drops below 70%, re-run a mini calibration (3 rounds max, not 10):

```typescript
// In discovery processor, after persisting threads
config.runsSinceOptimization++;

if (config.runsSinceOptimization >= 10) {
  const { precision, total } = await computePrecisionFromFeedback(userId, platform);
  if (total >= 5 && precision < 0.70) {
    await enqueueCalibration({ userId, productId, maxRounds: 3 }); // mini re-cal
  }
  config.runsSinceOptimization = 0;
}
```

---

## What the Optimizer Can Edit (Summary)

| What | Storage | Injection Point | Example |
|------|---------|-----------------|---------|
| Score weights | 5 real columns | `score_threads` tool `config.weights` | intent: 0.45 → 0.50 |
| Gate thresholds | 3 real columns | `score_threads` tool `config.intentGate` | intentGate: 0.50 → 0.55 |
| Enqueue threshold | 1 real column | Discovery processor | 0.70 → 0.65 |
| Custom pain phrases | text[] column | `generate_queries` custom queries | `["can't get users for my saas"]` |
| Custom query templates | text[] column | `generate_queries` custom queries | `["what tools do you use for outreach"]` |
| Strategy rules | text (markdown) | Agent reads from `additionalRules` in input | `"Threads about hiring are irrelevant for this product"` |
| Low-relevance patterns | text (markdown) | Agent reads from `additionalLowRelevancePatterns` | `"Dropshipping/passive income = relevance ≤ 0.1"` |
| Platform strategy | text (markdown) | Agent reads from input | `"For X: only score explicit questions"` |

---

## Deployment Architecture

### Job flow

```
Onboarding complete (product saved)
    │
    ▼
POST /api/products → save product → enqueueCalibration()
    │
    ▼
calibrationQueue.add('calibrate', { userId, productId })
    │
    ▼
[Worker] processCalibration(job)
    ├── For each platform (reddit, x):
    │   └── Loop up to 10 rounds:
    │       ├── Run discovery skill (Haiku, fan-out, ~$0.08)
    │       ├── AI Judge batch (Haiku, ~$0.01)
    │       ├── If precision >= 0.80 → DONE
    │       ├── Optimizer agent (Sonnet, ~$0.04)
    │       ├── Apply edits to discovery_configs
    │       └── Publish progress SSE event to UI
    └── Publish calibration_complete event
```

### UI progress

The user sees calibration progress in real-time via SSE:

```typescript
// Frontend: onboarding completion screen or dashboard
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'calibration_progress') {
    showProgress(`Optimizing ${data.platform} discovery: round ${data.round}/${data.maxRounds}`);
  }
  if (data.type === 'calibration_complete') {
    showSuccess(`Discovery calibrated! Precision: ${data.precision}%`);
  }
};
```

### Timing

| Phase | Time per round | Total (10 rounds, 2 platforms) |
|-------|---------------|-------------------------------|
| Discovery (3 sources) | ~60-120s | 10-20 min |
| AI Judge | ~5-10s | ~1-2 min |
| Optimizer | ~5-10s | ~1-2 min |
| **Per round** | **~70-140s** | |
| **Full calibration** | | **~15-25 min** |

Typically converges in 3-5 rounds, so real-world time is ~5-12 min.

### Cost

| Component | Per round | Full calibration (10 rounds × 2 platforms) |
|-----------|-----------|-------------------------------------------|
| Discovery (Haiku) | $0.04-0.12 | $0.80-2.40 |
| Judge (Haiku) | $0.005-0.01 | $0.10-0.20 |
| Optimizer (Sonnet) | $0.02-0.05 | $0.40-1.00 |
| **Total** | **$0.07-0.18** | **$1.30-3.60** |

One-time cost per user at onboarding. Acceptable as customer acquisition cost.

### Crash recovery

The calibration log and round counter are checkpointed to DB after each round. If the worker crashes, the job retries and resumes from `config.calibrationRound`.

---

## Implementation Sequence

### Sprint 1: Foundation (3-5 days)
- [ ] Create `discovery_configs` table (Drizzle migration)
- [ ] Modify `score_threads` to accept optional config overrides
- [ ] Modify `generate_queries` to accept custom phrases/templates
- [ ] Modify discovery processor to load config and inject into skill
- [ ] Add `additionalRules` handling to `discovery.md`
- [ ] Modify enqueue threshold to read from config
- [ ] Create `calibrationQueue` and wire into BullMQ worker

### Sprint 2: Judge + Optimizer (3-5 days)
- [ ] Implement `judgeThreadsBatch()` (Haiku batch evaluator)
- [ ] Create optimizer agent prompt (`src/agents/optimize-discovery.md`)
- [ ] Implement `applyOptimization()` with clamping and normalization
- [ ] Implement `processCalibration()` — the 10-round loop
- [ ] Add SSE events for calibration progress

### Sprint 3: Trigger + UI (2-3 days)
- [ ] Wire calibration trigger into product save handler
- [ ] Build calibration progress UI (onboarding or dashboard)
- [ ] Add calibration status to settings page (show config, precision, round history)
- [ ] Handle re-calibration trigger (product update, manual button)

### Sprint 4: Continuous Refinement (2-3 days)
- [ ] Add `validated` / `validatedAt` to `threads` table
- [ ] Propagate approve/skip signals from drafts API
- [ ] Implement `computePrecisionFromFeedback()`
- [ ] Wire periodic re-optimization check into discovery processor
- [ ] Auto re-calibrate (mini, 3 rounds) when precision drifts below 70%

---

## Key Design Decisions

1. **Calibration at product binding, not gradual** — user gets optimized discovery from day 1
2. **AI judge as primary signal** — no waiting for weeks of user feedback to bootstrap
3. **Strategy edits in DB, not files** — multi-tenant safe, per-user, rollbackable
4. **Injection via user message, not system prompt** — preserves prompt cache (90% cost savings)
5. **Sonnet as optimizer, Haiku as judge + worker** — smart supervisor, cheap execution
6. **Checkpoint after each round** — crash recovery, progress visibility
7. **Continuous refinement as Phase 2** — user feedback tightens what calibration started
8. **Cost ~$1.30-3.60 per user** — one-time onboarding cost, amortized over lifetime value
