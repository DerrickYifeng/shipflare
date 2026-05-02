import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
import { judgingOpportunityInputSchema, judgingOpportunityOutputSchema } from '../schema';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('judging-opportunity schema', () => {
  it('accepts a thread + product + platform input', () => {
    expect(() =>
      judgingOpportunityInputSchema.parse({
        thread: {
          title: 't',
          body: 'b',
          author: 'a',
          platform: 'x',
          community: 'x',
          upvotes: 0,
          commentCount: 0,
          postedAt: new Date().toISOString(),
        },
        product: { name: 'p', description: 'd' },
        platform: 'x',
      }),
    ).not.toThrow();
  });

  it('output names which gate failed when pass=false', () => {
    const parsed = judgingOpportunityOutputSchema.parse({
      pass: false,
      gateFailed: 1,
      canMentionProduct: false,
      signal: 'competitor',
      rationale: 'OP is shilling their own tool',
    });
    expect(parsed.gateFailed).toBe(1);
  });

  it('rejects invalid gateFailed values', () => {
    expect(() =>
      judgingOpportunityOutputSchema.parse({
        pass: false,
        gateFailed: 4,
        canMentionProduct: false,
        signal: 'x',
        rationale: 'y',
      }),
    ).toThrow();
  });
});

describe('judging-opportunity skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('judging-opportunity');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual([]);
  });

  it('produces a body referencing gate-rules', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = { abortSignal: new AbortController().signal, get: () => null } as never;
    const body = await skill!.getPromptForCommand(JSON.stringify({}), fakeCtx);
    expect(body).toContain('gate-rules');
  });
});
