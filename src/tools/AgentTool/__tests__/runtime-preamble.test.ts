import { describe, expect, it } from 'vitest';
import {
  renderRuntimePreamble,
  thisMondayUtc,
} from '@/tools/AgentTool/runtime-preamble';
import { buildAgentConfigFromDefinition } from '@/tools/AgentTool/spawn';
import type { AgentDefinition } from '@/tools/AgentTool/loader';

describe('thisMondayUtc', () => {
  it('returns the same Monday when given a Monday at midnight UTC', () => {
    const monday = new Date('2026-04-20T00:00:00.000Z'); // Mon
    expect(thisMondayUtc(monday).toISOString()).toBe(
      '2026-04-20T00:00:00.000Z',
    );
  });

  it('rolls a mid-week timestamp back to Monday 00:00 UTC', () => {
    const wednesday = new Date('2026-04-22T10:43:00.000Z'); // Wed 10:43 UTC
    expect(thisMondayUtc(wednesday).toISOString()).toBe(
      '2026-04-20T00:00:00.000Z',
    );
  });

  it('rolls a Sunday back to the prior Monday, not the following one', () => {
    // Sun 2026-04-26 — must resolve to Mon 2026-04-20, not 2026-04-27.
    const sunday = new Date('2026-04-26T23:59:00.000Z');
    expect(thisMondayUtc(sunday).toISOString()).toBe(
      '2026-04-20T00:00:00.000Z',
    );
  });
});

describe('renderRuntimePreamble', () => {
  it('includes today YMD, now ISO, and weekStart labelled for the agent', () => {
    const now = new Date('2026-04-22T06:43:54.220Z');
    const preamble = renderRuntimePreamble(now);

    expect(preamble).toContain('# Runtime context');
    expect(preamble).toContain('**Today (UTC YMD):** 2026-04-22');
    expect(preamble).toContain('**Now (UTC ISO):** 2026-04-22T06:43:54.220Z');
    expect(preamble).toContain(
      '**This week\'s Monday (UTC ISO, "weekStart"):** 2026-04-20T00:00:00.000Z',
    );
    // Warn the agent off its training-data defaults — this is the whole
    // point of the preamble; assert the instruction is still there.
    expect(preamble).toContain(
      'training data does not reflect the current date',
    );
  });
});

describe('buildAgentConfigFromDefinition', () => {
  const def: AgentDefinition = {
    name: 'content-planner',
    description: 'plans stuff',
    tools: [],
    model: 'claude-haiku-4-5-20251001',
    maxTurns: 20,
    systemPrompt: 'Body of the agent prompt — pretend this is a playbook.',
    sourcePath: '/irrelevant/AGENT.md',
  };

  it('prepends the runtime preamble before the agent body', () => {
    const now = new Date('2026-04-22T06:43:54.220Z');
    const config = buildAgentConfigFromDefinition(def, now);

    const preambleIdx = config.systemPrompt.indexOf('# Runtime context');
    const bodyIdx = config.systemPrompt.indexOf('Body of the agent prompt');

    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(preambleIdx);
    expect(config.systemPrompt).toContain('2026-04-22');
    expect(config.systemPrompt).toContain('2026-04-20T00:00:00.000Z');
  });

  it('regression: never leaks a 2025 date when now is in 2026', () => {
    // The bug we\'re fixing: before this change, agents inferred the date
    // from Haiku\'s training cutoff and scheduled plan_items into 2025.
    // If the preamble ever stops injecting, this test should fail first.
    const now = new Date('2026-04-22T06:43:54.220Z');
    const config = buildAgentConfigFromDefinition(def, now);

    expect(config.systemPrompt).toMatch(/Today \(UTC YMD\):\*\* 2026-/);
    expect(config.systemPrompt).not.toMatch(/Today \(UTC YMD\):\*\* 2025-/);
  });
});
