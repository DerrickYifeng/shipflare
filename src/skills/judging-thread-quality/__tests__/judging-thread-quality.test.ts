import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
import {
  judgingThreadQualityInputSchema,
  judgingThreadQualityOutputSchema,
} from '../schema';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('judging-thread-quality schema', () => {
  it('accepts a single thread candidate input', () => {
    expect(() =>
      judgingThreadQualityInputSchema.parse({
        candidate: {
          title: 'looking for a tool that does X',
          body: 'tried Y, did not work',
          author: 'someuser',
          url: 'https://x.com/someuser/status/123',
          platform: 'x',
          postedAt: new Date().toISOString(),
        },
        product: { name: 'p', description: 'd' },
      }),
    ).not.toThrow();
  });

  it('output keeps a thread with score + reason + signals', () => {
    const parsed = judgingThreadQualityOutputSchema.parse({
      keep: true,
      score: 0.85,
      reason: 'OP is asking for a tool in the product domain',
      signals: ['help_request', 'in_domain'],
    });
    expect(parsed.score).toBeGreaterThan(0.8);
  });

  it('rejects out-of-bounds score', () => {
    expect(() =>
      judgingThreadQualityOutputSchema.parse({
        keep: true,
        score: 1.5,
        reason: 'x',
        signals: [],
      }),
    ).toThrow();
  });
});

describe('judging-thread-quality skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('judging-thread-quality');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body referencing thread-quality-rules', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('thread-quality-rules');
  });
});
