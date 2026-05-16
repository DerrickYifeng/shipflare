import { describe, expect, it } from 'vitest';
import { labelEvent, prettyAgent } from '../activity-labels';

describe('prettyAgent', () => {
  it('maps known slugs to friendly names', () => {
    expect(prettyAgent('head-of-growth')).toBe('Head of Growth');
    expect(prettyAgent('social-media-manager')).toBe('Social Media Manager');
    expect(prettyAgent('strategic-planner')).toBe('Strategist');
    expect(prettyAgent('cmo')).toBe('CMO');
  });
  it('falls back to titleizing the slug', () => {
    expect(prettyAgent('unknown-slug')).toBe('Unknown slug');
  });
  it('handles empty slug', () => {
    expect(prettyAgent('')).toBe('Agent');
  });
});

describe('labelEvent', () => {
  function evt(over: Record<string, unknown>) {
    return {
      id: '1', createdAt: 0, conversationId: null, parentTurnId: null,
      runId: null, sourceAgent: 'cmo', parentEventId: null,
      kind: 'turn_start', payload: { kind: 'turn_start' },
      ...over,
    } as any;
  }

  it('labels cmo:turn_start as "Thinking"', () => {
    expect(labelEvent(evt({})).headline).toBe('Thinking');
  });
  it('labels cmo:turn_finish ok as "Done"', () => {
    expect(labelEvent(evt({
      kind: 'turn_finish',
      payload: { kind: 'turn_finish', status: 'ok', durationMs: 0 },
    })).headline).toBe('Done');
  });
  it('labels cmo:turn_finish error', () => {
    const l = labelEvent(evt({
      kind: 'turn_finish',
      payload: { kind: 'turn_finish', status: 'error', durationMs: 0 },
    }));
    expect(l.headline).toBe('Error');
    expect(l.tone).toBe('error');
  });
  it('labels subagent_dispatch with the agent name', () => {
    expect(labelEvent(evt({
      kind: 'subagent_dispatch',
      payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth', promptPreview: 'plz' },
    })).headline).toBe('Asking Head of Growth');
  });
  it('labels strategic-planner skill_invoke fallback (sourceAgent + kind only)', () => {
    expect(labelEvent(evt({
      sourceAgent: 'strategic-planner',
      kind: 'subagent_dispatch',
      payload: { kind: 'subagent_dispatch', subAgent: 'strategic-planner' },
    })).headline).toBe('Strategist is planning');
  });
  it('falls back gracefully for unmapped events', () => {
    const out = labelEvent(evt({
      sourceAgent: 'mystery-agent',
      kind: 'tool_call_start',
      payload: { kind: 'tool_call_start', tool: 'never_seen' },
    }));
    expect(out.headline).toBeTruthy();
    expect(out.tone).toBe('work');
  });
});
