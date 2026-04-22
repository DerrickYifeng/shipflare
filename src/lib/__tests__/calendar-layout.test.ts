import { describe, expect, test } from 'vitest';
import { durationForKind, type PlanItemKind } from '../calendar-layout';

describe('durationForKind', () => {
  test.each<[PlanItemKind, number]>([
    ['content_post', 30],
    ['content_reply', 30],
    ['email_send', 30],
    ['analytics_summary', 30],
    ['metrics_compute', 30],
    ['launch_asset', 30],
    ['interview', 60],
    ['setup_task', 60],
    ['runsheet_beat', 60],
  ])('maps %s -> %i min', (kind, minutes) => {
    expect(durationForKind(kind)).toBe(minutes);
  });
});
