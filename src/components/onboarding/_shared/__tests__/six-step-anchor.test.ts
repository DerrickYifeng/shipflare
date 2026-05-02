import { describe, it, expect } from 'vitest';
import {
  applyToolProgress,
  TOOL_TO_STEP_ANCHORS,
} from '../six-step-anchor';

describe('applyToolProgress', () => {
  it('advances on the first tool start (query_recent_milestones)', () => {
    const next = applyToolProgress(0, {
      toolName: 'query_recent_milestones',
      phase: 'start',
    });
    expect(next).toBe(1);
  });

  it('progresses through the canonical 3-tool happy path', () => {
    let active = 0;
    active = applyToolProgress(active, {
      toolName: 'query_recent_milestones',
      phase: 'start',
    });
    expect(active).toBe(1);
    active = applyToolProgress(active, {
      toolName: 'query_recent_milestones',
      phase: 'done',
    });
    expect(active).toBe(2);
    active = applyToolProgress(active, {
      toolName: 'query_strategic_path',
      phase: 'done',
    });
    expect(active).toBe(3);
    active = applyToolProgress(active, {
      toolName: 'write_strategic_path',
      phase: 'start',
    });
    expect(active).toBe(5);
    active = applyToolProgress(active, {
      toolName: 'write_strategic_path',
      phase: 'done',
    });
    expect(active).toBe(6);
  });

  it('terminal write_strategic_path:done jumps directly to 6 even if earlier tools were skipped', () => {
    const active = applyToolProgress(0, {
      toolName: 'write_strategic_path',
      phase: 'done',
    });
    expect(active).toBe(6);
  });

  it('never moves backward when a later event has a lower anchor', () => {
    // Already on review (5), an earlier tool's done event should NOT regress.
    const active = applyToolProgress(5, {
      toolName: 'query_recent_milestones',
      phase: 'done',
    });
    expect(active).toBe(5);
  });

  it('treats error phase like done (advances forward)', () => {
    const active = applyToolProgress(0, {
      toolName: 'query_strategic_path',
      phase: 'error',
    });
    expect(active).toBe(3);
  });

  it('ignores unknown tool names', () => {
    const active = applyToolProgress(2, {
      toolName: 'some_unknown_tool',
      phase: 'done',
    });
    expect(active).toBe(2);
  });

  it('ignores phases not declared for a tool', () => {
    // query_recent_milestones has start/done/error — give it something else.
    const active = applyToolProgress(1, {
      toolName: 'query_recent_milestones',
      // @ts-expect-error - testing tolerance to unexpected phase strings
      phase: 'cancelled',
    });
    expect(active).toBe(1);
  });

  it('anchor table covers all 4 generating-strategy tools', () => {
    expect(Object.keys(TOOL_TO_STEP_ANCHORS).sort()).toEqual([
      'query_metrics',
      'query_recent_milestones',
      'query_strategic_path',
      'write_strategic_path',
    ]);
  });
});
