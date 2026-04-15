/**
 * Platform-agnostic metrics collector interface.
 *
 * Each platform implements this interface to collect post-level metrics
 * and user-level snapshots. The metrics processor dispatches to the
 * appropriate implementation based on the `platform` field in the job data.
 *
 * Currently only X is implemented (inline in the metrics processor).
 * When adding Reddit/LinkedIn metrics, create a new class implementing
 * this interface and register it in getMetricsCollector().
 */
export interface MetricsCollector {
  collectPostMetrics(userId: string): Promise<{ collected: number; analyzed: number }>;
  collectUserSnapshot(userId: string): Promise<void>;
}

/**
 * Get the metrics collector for a given platform.
 * Throws for unsupported platforms.
 */
export function getMetricsCollector(platform: string): MetricsCollector | null {
  switch (platform) {
    case 'x':
      // X metrics are currently handled inline in the metrics processor.
      // When extracted, return new XMetricsCollector() here.
      return null;
    default:
      return null;
  }
}
