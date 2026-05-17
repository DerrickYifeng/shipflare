import { describe, it, expect, vi } from 'vitest';
import { writeAgentEvent } from '../src/telemetry';

describe('writeAgentEvent', () => {
  it('writes tool_invocation with correct blob/double/index slots', () => {
    const writeDataPoint = vi.fn();
    const env = { TELEMETRY: { writeDataPoint } } as any;
    writeAgentEvent(env, {
      kind: 'tool_invocation',
      userId: 'u_1',
      runId: 'r_1',
      blobs: ['draft_post', 'ok', 'sonnet-4-6', 'inline'],
      doubles: [123, 100, 50],
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['tool_invocation', 'u_1', 'r_1'],
      blobs: ['draft_post', 'ok', 'sonnet-4-6', 'inline'],
      doubles: [123, 100, 50],
    });
  });

  it('substitutes empty string when runId is missing', () => {
    const writeDataPoint = vi.fn();
    const env = { TELEMETRY: { writeDataPoint } } as any;
    writeAgentEvent(env, {
      kind: 'skill_invocation',
      userId: 'u_2',
      blobs: ['drafting-single-post', 'ok'],
      doubles: [200],
    });
    expect(writeDataPoint.mock.calls[0]![0].indexes).toEqual(['skill_invocation', 'u_2', '']);
  });

  it('does not throw when TELEMETRY binding is absent', () => {
    const env = {} as any;
    expect(() => writeAgentEvent(env, {
      kind: 'agent_run', userId: 'u_3', blobs: ['CMO', 'ok'], doubles: [50],
    })).not.toThrow();
  });
});
