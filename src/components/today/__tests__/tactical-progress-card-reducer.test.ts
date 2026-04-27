import { describe, it, expect } from 'vitest';
import {
  reduceToolProgress,
  type ToolProgressViewState,
  type ToolProgressEventInput,
} from '../tactical-progress-card';

const empty: ToolProgressViewState = {
  calibration: {},
  discovery: {},
  ticker: null,
};

describe('reduceToolProgress', () => {
  it('routes calibrate_search_strategy events to the calibration map', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 12/60 · precision 0.58',
      metadata: { round: 12, maxTurns: 60, precision: 0.58, sampleSize: 47 },
      ts: 1000,
    };
    const next = reduceToolProgress(empty, event);
    const row = next.calibration['default']!;
    expect(row).toBeDefined();
    expect(row.round).toBe(12);
    expect(row.maxTurns).toBe(60);
    expect(row.precision).toBeCloseTo(0.58);
    expect(row.message).toBe('Round 12/60 · precision 0.58');
    expect(row.ts).toBe(1000);
  });

  it('routes run_discovery_scan events to the discovery map keyed by platform', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'run_discovery_scan',
      callId: 'c2',
      message: 'Searching x with 12 inline queries',
      metadata: { platform: 'x', queryCount: 12, mode: 'inline' },
      ts: 2000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.discovery['x']).toBeDefined();
    expect(next.discovery['x']!.message).toBe('Searching x with 12 inline queries');
  });

  it('drops out-of-order events for the same toolName + callId', () => {
    const newer: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 12',
      metadata: { round: 12, maxTurns: 60 },
      ts: 1000,
    };
    const older: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 8',
      metadata: { round: 8, maxTurns: 60 },
      ts: 500,
    };
    const afterNewer = reduceToolProgress(empty, newer);
    const afterOlder = reduceToolProgress(afterNewer, older);
    expect(afterOlder.calibration['default']!.round).toBe(12);
    expect(afterOlder.calibration['default']!.message).toBe('Round 12');
  });

  it('falls through to ActivityTicker for unknown toolNames', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'some_future_tool',
      callId: 'c3',
      message: 'doing a thing 5/10',
      ts: 3000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.ticker?.message).toBe('doing a thing 5/10');
    expect(next.ticker?.toolName).toBe('some_future_tool');
  });

  it('routes calibrate_search_strategy events keyed by metadata.platform when present', () => {
    const event: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'calibrate_search_strategy',
      callId: 'c1',
      message: 'Round 5/60',
      metadata: { platform: 'x', round: 5, maxTurns: 60 },
      ts: 1000,
    };
    const next = reduceToolProgress(empty, event);
    expect(next.calibration['x']).toBeDefined();
    expect(next.calibration['default']).toBeUndefined();
    expect(next.calibration['x']!.platform).toBe('x');
  });

  it('drops out-of-order ticker events even when toolName + callId differ', () => {
    const newer: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'tool_a',
      callId: 'c1',
      message: 'A new',
      ts: 5000,
    };
    const olderFromOtherTool: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'tool_b',
      callId: 'c2',
      message: 'B old',
      ts: 4000,
    };
    const afterNewer = reduceToolProgress(empty, newer);
    const afterOlder = reduceToolProgress(afterNewer, olderFromOtherTool);
    // The older B event must NOT clobber the newer A event in the ticker slot.
    expect(afterOlder.ticker?.message).toBe('A new');
    expect(afterOlder.ticker?.toolName).toBe('tool_a');
  });
});
