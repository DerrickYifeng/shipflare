import type { MetricsCollector } from '@/lib/metrics-collector';
import { XMetricsCollector } from './x-metrics-collector';

/**
 * Registry of per-platform MetricsCollector factories. Adding a new
 * platform = one entry here + one implementation file. Workers and
 * `getMetricsCollector()` in `src/lib/metrics-collector.ts` route
 * through this map.
 *
 * Factories (rather than singletons) keep instantiation cheap and let
 * collectors hold per-call state without accidental cross-user leaks.
 */
const collectors: Record<string, () => MetricsCollector> = {
  x: () => new XMetricsCollector(),
};

export function getCollector(platform: string): MetricsCollector | null {
  const factory = collectors[platform];
  return factory ? factory() : null;
}

export { XMetricsCollector };
