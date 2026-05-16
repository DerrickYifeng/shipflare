import { describe, expect, it } from 'vitest';
import { ActivityEventSchema, ACTIVITY_KINDS } from '../src/activity-event';

describe('ActivityEventSchema', () => {
  it('parses a minimal turn_start event', () => {
    const evt = {
      id: '00000000-0000-0000-0000-000000000001',
      createdAt: 1715817600000,
      sourceAgent: 'cmo',
      kind: 'turn_start',
      payload: { kind: 'turn_start' },
      conversationId: 'conv-1',
      parentTurnId: null,
      runId: null,
      parentEventId: null,
    };
    expect(ActivityEventSchema.parse(evt)).toEqual(evt);
  });

  it('rejects unknown kinds', () => {
    expect(() =>
      ActivityEventSchema.parse({
        id: '00000000-0000-0000-0000-000000000002',
        createdAt: 1,
        sourceAgent: 'cmo',
        kind: 'invented_kind',
        payload: { kind: 'invented_kind' },
        conversationId: null,
        parentTurnId: null,
        runId: null,
        parentEventId: null,
      }),
    ).toThrow();
  });

  it('exports the full ACTIVITY_KINDS list', () => {
    expect(ACTIVITY_KINDS).toContain('turn_start');
    expect(ACTIVITY_KINDS).toContain('turn_finish');
    expect(ACTIVITY_KINDS).toContain('subagent_dispatch');
    expect(ACTIVITY_KINDS).toContain('skill_invoke');
  });
});
