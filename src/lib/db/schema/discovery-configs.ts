import {
  pgTable,
  text,
  timestamp,
  real,
  integer,
  jsonb,
  unique,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Per-user, per-platform discovery configuration.
 *
 * Two-layer design:
 * - Base layer: source code defaults (shared across all users)
 * - User layer: this table — per-user overrides tuned by the optimizer
 *
 * At runtime the discovery processor merges base + user config and injects
 * the result into the skill input (via user message, not system prompt,
 * to preserve prompt cache).
 */
export const discoveryConfigs = pgTable(
  'discovery_configs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().default('reddit'),

    // ---- Numeric tuning ----
    weightRelevance: real('weight_relevance').notNull().default(0.3),
    weightIntent: real('weight_intent').notNull().default(0.45),
    weightExposure: real('weight_exposure').notNull().default(0.1),
    weightFreshness: real('weight_freshness').notNull().default(0.1),
    weightEngagement: real('weight_engagement').notNull().default(0.05),
    intentGate: real('intent_gate').notNull().default(0.5),
    relevanceGate: real('relevance_gate').notNull().default(0.5),
    gateCap: real('gate_cap').notNull().default(0.45),
    enqueueThreshold: real('enqueue_threshold').notNull().default(0.7),

    // ---- Strategy overrides (LLM-generated, per-user) ----
    customPainPhrases: text('custom_pain_phrases').array().default([]),
    customQueryTemplates: text('custom_query_templates').array().default([]),
    strategyRules: text('strategy_rules'),
    platformStrategyOverride: text('platform_strategy_override'),
    customLowRelevancePatterns: text('custom_low_relevance_patterns'),

    // ---- Calibration metadata ----
    calibrationStatus: text('calibration_status', {
      enum: ['pending', 'running', 'completed', 'failed'],
    })
      .notNull()
      .default('pending'),
    calibrationRound: integer('calibration_round').notNull().default(0),
    calibrationPrecision: real('calibration_precision'),
    calibrationLog: jsonb('calibration_log'),

    // ---- Ongoing optimization metadata ----
    optimizationVersion: integer('optimization_version').notNull().default(0),
    runsSinceOptimization: integer('runs_since_optimization')
      .notNull()
      .default(0),
    lastOptimizedAt: timestamp('last_optimized_at', { mode: 'date' }),
    precisionAtOptimization: real('precision_at_optimization'),
    previousConfig: jsonb('previous_config'),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    userPlatformUnique: unique().on(table.userId, table.platform),
  }),
);
