import { describe, it, expect, afterAll } from 'vitest';
import {
  calendarSlotDraftQueue,
  searchSourceQueue,
  discoveryScanQueue,
} from '@/lib/queue';

describe('Generate Week decoupling', () => {
  afterAll(async () => {
    await Promise.all([
      calendarSlotDraftQueue.obliterate({ force: true }),
      searchSourceQueue.obliterate({ force: true }),
      discoveryScanQueue.obliterate({ force: true }),
    ]);
  });

  it('does not enqueue search-source or discovery-scan when planner runs', async () => {
    // We don't run the planner (needs DB + LLM); instead assert that the
    // processor source itself is free of enqueueMonitor/enqueueContentCalendar.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/workers/processors/calendar-plan.ts', 'utf8');
    expect(src).not.toMatch(/enqueueMonitor\b/);
    expect(src).not.toMatch(/enqueueContentCalendar\b/);
    expect(src).not.toMatch(/enqueueDiscovery(Scan)?\b/);
  });
});
