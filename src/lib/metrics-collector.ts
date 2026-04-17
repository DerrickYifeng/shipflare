/**
 * Platform-agnostic metrics collector interface.
 *
 * Each platform implements this interface to collect post-level metrics
 * and user-level snapshots. The metrics processor dispatches to the
 * appropriate implementation based on the `platform` field in the job data.
 *
 * Registry lives in `src/lib/collectors/index.ts`. To add a new platform:
 *   1. Create `src/lib/collectors/<platform>-metrics-collector.ts` that
 *      implements `MetricsCollector`.
 *   2. Add an entry to the `collectors` map in `src/lib/collectors/index.ts`.
 *   3. Nothing else — `getMetricsCollector()` will pick it up.
 */
export interface MetricsCollector {
  collectPostMetrics(userId: string): Promise<{ collected: number; analyzed: number }>;
  collectUserSnapshot(userId: string): Promise<void>;
}

/**
 * Get the metrics collector for a given platform. Returns null for
 * platforms that don't have a collector registered yet — callers should
 * treat that as a no-op (matches the previous return-null behaviour).
 *
 * Re-exported from the collectors registry so existing callers
 * (`import { getMetricsCollector } from '@/lib/metrics-collector'`)
 * keep working.
 */
export { getCollector as getMetricsCollector } from './collectors';
