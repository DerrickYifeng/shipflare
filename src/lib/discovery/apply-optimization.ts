import { db } from '@/lib/db';
import { discoveryConfigs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import type { OptimizerResult } from './optimizer';

const log = createLogger('discovery:apply');

// ---------------------------------------------------------------------------
// Numeric weight keys that the optimizer can adjust
// ---------------------------------------------------------------------------

const WEIGHT_KEYS = [
  'weightRelevance',
  'weightIntent',
  'weightExposure',
  'weightFreshness',
  'weightEngagement',
] as const;

type GateKey = 'intentGate' | 'relevanceGate' | 'gateCap';

/**
 * Map from optimizer output key names to DB column names.
 */
const NUMERIC_KEY_MAP: Record<string, (typeof WEIGHT_KEYS)[number] | GateKey> = {
  weightRelevance: 'weightRelevance',
  weightIntent: 'weightIntent',
  weightExposure: 'weightExposure',
  weightFreshness: 'weightFreshness',
  weightEngagement: 'weightEngagement',
  intentGate: 'intentGate',
  relevanceGate: 'relevanceGate',
  gateCap: 'gateCap',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply optimizer edits to a discovery config row.
 *
 * - Clamps numeric weights to [0.01, 0.90] and re-normalizes to sum = 1.0
 * - Appends (not replaces) strategy rules and low-relevance patterns
 * - Handles undoFromPreviousRound by removing matching lines
 * - Saves previousConfig snapshot for rollback
 *
 * Returns a summary string of what was changed.
 */
export async function applyOptimization(
  configId: string,
  optimizerResult: OptimizerResult,
): Promise<string> {
  const [config] = await db
    .select()
    .from(discoveryConfigs)
    .where(eq(discoveryConfigs.id, configId))
    .limit(1);

  if (!config) {
    throw new Error(`Discovery config not found: ${configId}`);
  }

  // Save snapshot for rollback
  const snapshot = {
    weightRelevance: config.weightRelevance,
    weightIntent: config.weightIntent,
    weightExposure: config.weightExposure,
    weightFreshness: config.weightFreshness,
    weightEngagement: config.weightEngagement,
    intentGate: config.intentGate,
    relevanceGate: config.relevanceGate,
    gateCap: config.gateCap,
    strategyRules: config.strategyRules,
    customLowRelevancePatterns: config.customLowRelevancePatterns,
    customPainPhrases: config.customPainPhrases,
    customQueryTemplates: config.customQueryTemplates,
  };

  const changes: string[] = [];
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  // ---- 1. Numeric changes ----
  if (optimizerResult.numericChanges) {
    const weights: Record<string, number> = {
      weightRelevance: config.weightRelevance,
      weightIntent: config.weightIntent,
      weightExposure: config.weightExposure,
      weightFreshness: config.weightFreshness,
      weightEngagement: config.weightEngagement,
    };

    for (const [key, value] of Object.entries(optimizerResult.numericChanges)) {
      const dbKey = NUMERIC_KEY_MAP[key];
      if (!dbKey) continue;

      const clamped = Math.max(0.01, Math.min(0.90, value));

      if (WEIGHT_KEYS.includes(dbKey as (typeof WEIGHT_KEYS)[number])) {
        weights[dbKey] = clamped;
        changes.push(`${key}: ${(config[dbKey] as number).toFixed(2)} -> ${clamped.toFixed(2)}`);
      } else {
        updates[dbKey] = clamped;
        changes.push(`${key}: ${(config[dbKey] as number).toFixed(2)} -> ${clamped.toFixed(2)}`);
      }
    }

    // Re-normalize score weights to sum = 1.0
    const weightSum = WEIGHT_KEYS.reduce((s, k) => s + weights[k]!, 0);
    if (weightSum > 0) {
      for (const k of WEIGHT_KEYS) {
        updates[k] = weights[k]! / weightSum;
      }
    }
  }

  // ---- 2. Strategy rules (append) ----
  if (optimizerResult.strategyRules) {
    let existing = config.strategyRules ?? '';

    // Handle undos first
    if (optimizerResult.undoFromPreviousRound) {
      for (const undo of optimizerResult.undoFromPreviousRound) {
        existing = existing
          .split('\n')
          .filter((line) => !line.includes(undo))
          .join('\n');
        changes.push(`Undo: removed rule containing "${undo.slice(0, 50)}"`);
      }
    }

    const newRules = optimizerResult.strategyRules.trim();
    updates.strategyRules = existing ? `${existing.trim()}\n\n${newRules}` : newRules;
    changes.push(`Added strategy rules: ${newRules.slice(0, 80)}...`);
  }

  // ---- 3. Low-relevance patterns (append) ----
  if (optimizerResult.customLowRelevancePatterns) {
    const existing = config.customLowRelevancePatterns ?? '';
    const newPatterns = optimizerResult.customLowRelevancePatterns.trim();
    updates.customLowRelevancePatterns = existing
      ? `${existing.trim()}\n\n${newPatterns}`
      : newPatterns;
    changes.push(`Added low-relevance patterns: ${newPatterns.slice(0, 80)}...`);
  }

  // ---- 4. Custom pain phrases (append, dedupe) ----
  if (optimizerResult.customPainPhrases && optimizerResult.customPainPhrases.length > 0) {
    const existing = new Set(config.customPainPhrases ?? []);
    for (const phrase of optimizerResult.customPainPhrases) {
      existing.add(phrase);
    }
    updates.customPainPhrases = [...existing];
    changes.push(`Added ${optimizerResult.customPainPhrases.length} pain phrases`);
  }

  // ---- 5. Custom query templates (append, dedupe) ----
  if (optimizerResult.customQueryTemplates && optimizerResult.customQueryTemplates.length > 0) {
    const existing = new Set(config.customQueryTemplates ?? []);
    for (const template of optimizerResult.customQueryTemplates) {
      existing.add(template);
    }
    updates.customQueryTemplates = [...existing];
    changes.push(`Added ${optimizerResult.customQueryTemplates.length} query templates`);
  }

  // ---- 6. Platform strategy override ----
  if (optimizerResult.platformStrategyOverride) {
    updates.platformStrategyOverride = optimizerResult.platformStrategyOverride;
    changes.push('Updated platform strategy override');
  }

  // Save previous config + apply updates
  updates.previousConfig = snapshot;

  await db
    .update(discoveryConfigs)
    .set(updates)
    .where(eq(discoveryConfigs.id, configId));

  const summary = changes.length > 0 ? changes.join('; ') : 'No changes applied';
  log.info(`Applied optimization to config ${configId}: ${summary}`);
  return summary;
}
