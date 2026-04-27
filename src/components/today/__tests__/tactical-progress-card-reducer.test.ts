import { describe, it, expect } from 'vitest';
import {
  reduceToolProgress,
  type ToolProgressViewState,
  type ToolProgressEventInput,
} from '../tactical-progress-card';

const empty: ToolProgressViewState = {
  discovery: {},
  ticker: null,
};

describe('reduceToolProgress', () => {
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
      toolName: 'run_discovery_scan',
      callId: 'c1',
      message: 'second pass',
      metadata: { platform: 'x' },
      ts: 1000,
    };
    const older: ToolProgressEventInput = {
      type: 'tool_progress',
      toolName: 'run_discovery_scan',
      callId: 'c1',
      message: 'first pass',
      metadata: { platform: 'x' },
      ts: 500,
    };
    const afterNewer = reduceToolProgress(empty, newer);
    const afterOlder = reduceToolProgress(afterNewer, older);
    expect(afterOlder.discovery['x']!.message).toBe('second pass');
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
