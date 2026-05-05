import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
import {
  generatingStrategyInputSchema,
  generatingStrategyOutputSchema,
} from '../schema';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('generating-strategy schema', () => {
  it('accepts a minimal valid input', () => {
    const parsed = generatingStrategyInputSchema.parse({
      product: { name: 'Acme', description: 'an indie tool' },
      state: 'mvp',
      currentPhase: 'foundation',
      channels: ['x'],
      today: '2026-05-01',
      weekStart: '2026-04-27',
    });
    expect(parsed.product.name).toBe('Acme');
  });

  it('accepts the full input shape with optional fields', () => {
    const parsed = generatingStrategyInputSchema.parse({
      product: {
        name: 'Acme',
        description: 'an indie tool',
        category: 'dev_tool',
        valueProp: 'ship faster',
        targetAudience: 'solo devs',
      },
      state: 'launching',
      currentPhase: 'audience',
      channels: ['x', 'reddit'],
      launchDate: '2026-06-01',
      launchedAt: null,
      recentMilestones: [
        {
          title: 'shipped v1',
          summary: 'first cut',
          source: 'release',
          atISO: '2026-04-30',
        },
      ],
      voiceProfile: null,
      today: '2026-05-01',
      weekStart: '2026-04-27',
    });
    expect(parsed.recentMilestones).toHaveLength(1);
    expect(parsed.channels).toEqual(['x', 'reddit']);
  });

  it('rejects an input missing required product fields', () => {
    expect(() =>
      generatingStrategyInputSchema.parse({
        product: { name: '' },
        state: 'mvp',
        currentPhase: 'foundation',
        channels: ['x'],
        today: '2026-05-01',
        weekStart: '2026-04-27',
      }),
    ).toThrow();
  });

  it('accepts a valid terminal output', () => {
    const parsed = generatingStrategyOutputSchema.parse({
      status: 'completed',
      pathId: 'sp_abc',
      summary: 'we are building Acme for indie devs',
      notes: 'week 1 leans data',
    });
    expect(parsed.status).toBe('completed');
    expect(parsed.pathId).toBe('sp_abc');
  });

  it('rejects an output with empty pathId', () => {
    expect(() =>
      generatingStrategyOutputSchema.parse({
        status: 'completed',
        pathId: '',
        summary: 'ok',
        notes: 'ok',
      }),
    ).toThrow();
  });

  it('rejects an output with an unknown status', () => {
    expect(() =>
      generatingStrategyOutputSchema.parse({
        status: 'pending',
        pathId: 'sp_x',
        summary: 'ok',
        notes: 'ok',
      }),
    ).toThrow();
  });
});

describe('generating-strategy skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('generating-strategy');
    expect(skill!.context).toBe('fork');
  });

  it('exposes the expected allowed-tools', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill!.allowedTools).toContain('write_strategic_path');
    expect(skill!.allowedTools).toContain('query_recent_milestones');
    expect(skill!.allowedTools).toContain('query_strategic_path');
  });

  it('produces a body that mentions the strategic-path workflow', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand('test args', fakeCtx);
    expect(body).toContain('write_strategic_path');
    expect(body).toContain('thesisArc');
  });
});
