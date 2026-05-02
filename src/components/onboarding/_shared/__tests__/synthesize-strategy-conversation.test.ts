import { describe, it, expect } from 'vitest';
import {
  synthesizeStrategyConversation,
  friendlyLabelForTool,
  type ToolProgressEvent,
} from '../synthesize-strategy-conversation';

const FIXED_START = 1_700_000_000_000;
const FIXED_NOW = FIXED_START + 5_000;

function callSynthesize(args: {
  events?: readonly ToolProgressEvent[];
  done?: boolean;
  error?: string | null;
  now?: number;
}) {
  return synthesizeStrategyConversation({
    toolProgressEvents: args.events ?? [],
    done: args.done ?? false,
    error: args.error ?? null,
    startedAt: FIXED_START,
    now: args.now ?? FIXED_NOW,
  });
}

describe('synthesizeStrategyConversation', () => {
  it('returns DISPATCH coordinator + RUNNING subtask with no tool calls when no events have arrived', () => {
    const state = callSynthesize({});
    expect(state.coordinator.phase).toBe('DISPATCH');
    expect(state.coordinator.name).toBe('Chief of Staff');
    expect(state.coordinator.body).toMatch(/strategist/i);
    expect(state.subtask.status).toBe('RUNNING');
    expect(state.subtask.toolCalls).toHaveLength(0);
    expect(state.subtask.specialistName).toBe('Strategist');
    expect(state.subtask.title).toBe('Build initial 30-day plan');
    expect(state.elapsedMs).toBe(5_000);
  });

  it('appends a tool call with friendly label when a `start` event arrives', () => {
    const state = callSynthesize({
      events: [
        {
          toolName: 'query_recent_milestones',
          phase: 'start',
          toolUseId: 'tu_1',
        },
      ],
    });
    expect(state.subtask.toolCalls).toHaveLength(1);
    expect(state.subtask.toolCalls[0]).toMatchObject({
      toolUseId: 'tu_1',
      toolName: 'query_recent_milestones',
      friendlyLabel: 'Reading recent shipping signals',
      phase: 'start',
    });
    expect(state.subtask.toolCalls[0].durationMs).toBeUndefined();
    expect(state.subtask.status).toBe('RUNNING');
  });

  it('updates the same tool call to phase=done with durationMs on the matching `done` event', () => {
    const state = callSynthesize({
      events: [
        { toolName: 'query_metrics', phase: 'start', toolUseId: 'tu_2' },
        {
          toolName: 'query_metrics',
          phase: 'done',
          toolUseId: 'tu_2',
          durationMs: 1_234,
        },
      ],
    });
    expect(state.subtask.toolCalls).toHaveLength(1);
    expect(state.subtask.toolCalls[0]).toMatchObject({
      toolUseId: 'tu_2',
      phase: 'done',
      durationMs: 1_234,
      friendlyLabel: 'Reading channel metrics',
    });
  });

  it('preserves insertion order across multiple distinct tool_use_ids', () => {
    const state = callSynthesize({
      events: [
        { toolName: 'query_recent_milestones', phase: 'start', toolUseId: 'a' },
        { toolName: 'query_strategic_path', phase: 'start', toolUseId: 'b' },
        { toolName: 'write_strategic_path', phase: 'start', toolUseId: 'c' },
      ],
    });
    expect(state.subtask.toolCalls.map((t) => t.toolUseId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('falls back to a humanized tool name when no friendly label is registered', () => {
    expect(friendlyLabelForTool('some_unknown_tool')).toBe('some unknown tool');
    const state = callSynthesize({
      events: [
        { toolName: 'some_unknown_tool', phase: 'start', toolUseId: 'tu_x' },
      ],
    });
    expect(state.subtask.toolCalls[0].friendlyLabel).toBe('some unknown tool');
  });

  it('flips coordinator → SYNTHESIS and subtask → DONE when `done=true`', () => {
    const state = callSynthesize({
      done: true,
      events: [
        {
          toolName: 'write_strategic_path',
          phase: 'done',
          toolUseId: 'tu_w',
          durationMs: 4_500,
        },
      ],
    });
    expect(state.coordinator.phase).toBe('SYNTHESIS');
    expect(state.coordinator.body).toMatch(/ready/i);
    expect(state.subtask.status).toBe('DONE');
    expect(state.subtask.toolCalls).toHaveLength(1);
    expect(state.subtask.toolCalls[0].phase).toBe('done');
  });

  it('surfaces the error on subtask + coordinator when `error` is non-null', () => {
    const state = callSynthesize({
      error: 'Plan generation timed out',
    });
    expect(state.coordinator.phase).toBe('DONE');
    expect(state.subtask.status).toBe('ERROR');
    expect(state.subtask.errorMessage).toBe('Plan generation timed out');
    expect(state.coordinator.body).toMatch(/snag|retry/i);
  });

  it('elapsedMs reflects (now - startedAt) and never goes negative', () => {
    const past = callSynthesize({ now: FIXED_START - 1_000 });
    expect(past.elapsedMs).toBe(0);
    const ahead = callSynthesize({ now: FIXED_START + 12_345 });
    expect(ahead.elapsedMs).toBe(12_345);
  });
});
