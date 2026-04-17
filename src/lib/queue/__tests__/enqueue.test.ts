import { describe, it, expect, afterAll } from 'vitest';
import {
  calendarSlotDraftQueue,
  searchSourceQueue,
  enqueueCalendarSlotDraft,
  enqueueSearchSource,
} from '../index';

describe('enqueue helpers (requires Redis)', () => {
  afterAll(async () => {
    await calendarSlotDraftQueue.obliterate({ force: true });
    await searchSourceQueue.obliterate({ force: true });
    await calendarSlotDraftQueue.close();
    await searchSourceQueue.close();
  });

  it('dedupes calendar-slot-draft on calendarItemId', async () => {
    const data = {
      schemaVersion: 1 as const,
      traceId: 't-test',
      userId: 'u-test',
      productId: 'p-test',
      calendarItemId: 'ci-abc',
      channel: 'x',
    };
    const id1 = await enqueueCalendarSlotDraft(data);
    const id2 = await enqueueCalendarSlotDraft(data);
    expect(id1).toBe('cslot-ci-abc');
    expect(id2).toBe('cslot-ci-abc');
    const count = await calendarSlotDraftQueue.getJobCountByTypes(
      'waiting',
      'delayed',
      'active',
    );
    expect(count).toBeLessThanOrEqual(1);
  });

  it('dedupes search-source on (scanRunId, platform, source)', async () => {
    const data = {
      schemaVersion: 1 as const,
      traceId: 't-test',
      userId: 'u-test',
      productId: 'p-test',
      platform: 'reddit',
      source: 'r/SaaS',
      scanRunId: 'scan-xyz',
    };
    const id1 = await enqueueSearchSource(data);
    const id2 = await enqueueSearchSource(data);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^ssrc-scan-xyz-reddit-/);
  });
});
