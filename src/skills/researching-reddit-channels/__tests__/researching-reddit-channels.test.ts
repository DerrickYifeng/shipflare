import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
import {
  __setSkillsRootForTesting,
  getAllSkills,
} from '@/tools/SkillTool/registry';
import {
  researchingRedditChannelsInputSchema,
  researchingRedditChannelsOutputSchema,
} from '../schema';

const SKILL_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Schema — input
// ---------------------------------------------------------------------------

describe('researching-reddit-channels input schema', () => {
  it('accepts a minimal valid input and applies default candidateCount=6', () => {
    const parsed = researchingRedditChannelsInputSchema.parse({
      product: { name: 'Acme', description: 'an indie tool' },
    });
    expect(parsed.product.name).toBe('Acme');
    expect(parsed.candidateCount).toBe(6);
  });

  it('accepts the full input with valueProp + icp + candidateCount', () => {
    const parsed = researchingRedditChannelsInputSchema.parse({
      product: {
        name: 'Acme',
        description: 'an indie tool',
        valueProp: 'ship faster',
      },
      icp: 'indie hackers shipping side projects',
      candidateCount: 8,
    });
    expect(parsed.candidateCount).toBe(8);
    expect(parsed.icp).toBe('indie hackers shipping side projects');
  });

  it('rejects input missing product.name', () => {
    expect(() =>
      researchingRedditChannelsInputSchema.parse({
        product: { name: '', description: 'd' },
      }),
    ).toThrow();
  });

  it('rejects input missing product.description', () => {
    expect(() =>
      researchingRedditChannelsInputSchema.parse({
        product: { name: 'Acme', description: '' },
      }),
    ).toThrow();
  });

  it('rejects candidateCount below 3', () => {
    expect(() =>
      researchingRedditChannelsInputSchema.parse({
        product: { name: 'Acme', description: 'd' },
        candidateCount: 2,
      }),
    ).toThrow();
  });

  it('rejects candidateCount above 12', () => {
    expect(() =>
      researchingRedditChannelsInputSchema.parse({
        product: { name: 'Acme', description: 'd' },
        candidateCount: 13,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema — output
// ---------------------------------------------------------------------------

describe('researching-reddit-channels output schema', () => {
  it('accepts a happy-path output with candidates + costUsd', () => {
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [
        {
          subreddit: 'webdev',
          memberCountApprox: 1234567,
          rulesSummary: '10% rule on self-promo; no AI-generated content.',
          fitRationale:
            'webdev attracts builders working on web apps, which overlaps with the product ICP of indie devs shipping side projects.',
          fitScore: 0.85,
        },
      ],
      costUsd: 0.0042,
    });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0].subreddit).toBe('webdev');
    expect(parsed.costUsd).toBeCloseTo(0.0042);
  });

  it('accepts empty candidates list (xAI returned nothing)', () => {
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [],
      costUsd: 0.001,
    });
    expect(parsed.candidates).toHaveLength(0);
  });

  it('applies default costUsd=0 when omitted', () => {
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [],
    });
    expect(parsed.costUsd).toBe(0);
  });

  it('accepts a candidate without memberCountApprox (optional)', () => {
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [
        {
          subreddit: 'somesub',
          rulesSummary: '',
          fitRationale: 'rationale',
          fitScore: 0.5,
        },
      ],
      costUsd: 0,
    });
    expect(parsed.candidates[0].memberCountApprox).toBeUndefined();
  });

  it('rejects fitScore above 1', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'somesub',
            rulesSummary: '',
            fitRationale: 'rationale',
            fitScore: 1.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects fitScore below 0', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'somesub',
            rulesSummary: '',
            fitRationale: 'rationale',
            fitScore: -0.1,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects more than 12 candidates', () => {
    const candidate = {
      subreddit: 'sub',
      rulesSummary: '',
      fitRationale: 'r',
      fitScore: 0.5,
    };
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: Array.from({ length: 13 }, () => candidate),
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects empty subreddit name', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: '',
            rulesSummary: '',
            fitRationale: 'r',
            fitScore: 0.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SKILL.md loader
// ---------------------------------------------------------------------------

describe('researching-reddit-channels skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('researching-reddit-channels');
    expect(skill!.context).toBe('fork');
  });

  it('declares xai_find_customers as the only allowed tool', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill!.allowedTools).toEqual(['xai_find_customers']);
  });

  it('renders a body referencing xai_find_customers + reddit.com filter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand(
      JSON.stringify({
        product: { name: 'Acme', description: 'd' },
        candidateCount: 6,
      }),
      fakeCtx,
    );
    expect(body).toContain('xai_find_customers');
    expect(body).toContain('reddit.com');
    expect(body).toContain('web_search');
    expect(body).toContain('candidateCount');
    expect(body).toContain('Quality bar');
    expect(body).toContain('NSFW');
    expect(body).toContain('1,000 members');
    expect(body).toContain('defaultSources');
  });
});

// ---------------------------------------------------------------------------
// Bundled registration
// ---------------------------------------------------------------------------

describe('researching-reddit-channels bundled registration', () => {
  // No __resetRegistryForTesting() here on purpose: the bundled-registration
  // side-effect inside `@/skills/_bundled/researching-reddit-channels.ts`
  // runs exactly once per Node process (module cache). Resetting the
  // registry between tests would drop the registration and a static re-
  // import wouldn't re-trigger the side-effect. Tests in this block want
  // to verify the production registration shape, so we let it stand.
  beforeEach(() => {
    __setSkillsRootForTesting('/nonexistent');
  });

  it('registers via the _bundled barrel import', async () => {
    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'researching-reddit-channels');
    expect(skill).toBeDefined();
    expect(skill!.source).toBe('bundled');
    expect(skill!.context).toBe('fork');
    expect(skill!.allowedTools).toEqual(['xai_find_customers']);
    expect(skill!.model).toBe('grok-4.20-non-reasoning');
  });

  it('emits a prompt body covering the quality bar', async () => {
    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'researching-reddit-channels');
    expect(skill).toBeDefined();
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand(
      JSON.stringify({
        product: { name: 'Acme', description: 'd' },
      }),
      fakeCtx,
    );
    expect(body).toContain('xai_find_customers');
    expect(body).toContain('reddit.com');
    expect(body).toContain('web_search');
    expect(body).toContain('Quality bar');
    expect(body).toContain('NSFW');
    expect(body).toContain('1,000 members');
    expect(body).toContain('defaultSources');
    // $ARGUMENTS got substituted with the JSON input
    expect(body).toContain('"name":"Acme"');
  });

  it('emits a body that asks the fork to skip retries when xAI returns nothing', async () => {
    const all = await getAllSkills();
    const skill = all.find((s) => s.name === 'researching-reddit-channels');
    expect(skill).toBeDefined();
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand('{}', fakeCtx);
    expect(body).toMatch(/zero candidates/i);
    expect(body).toMatch(/Do NOT retry/);
  });
});
