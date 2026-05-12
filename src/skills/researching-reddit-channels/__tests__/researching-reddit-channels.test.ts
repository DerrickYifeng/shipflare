import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
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

  it('accepts memberCountApprox: null (xAI saw the page but could not read the figure)', () => {
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [
        {
          subreddit: 'somesub',
          memberCountApprox: null,
          rulesSummary: '',
          fitRationale: 'rationale',
          fitScore: 0.5,
        },
      ],
      costUsd: 0,
    });
    expect(parsed.candidates[0].memberCountApprox).toBeNull();
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

  // Reddit's actual subreddit naming rules: 3..21 chars, [A-Za-z0-9_]+.
  // These tests catch the xAI-hallucination patterns we care about
  // (stray `r/` prefix, punctuation, too-short / too-long names).
  it('rejects subreddit with a stray `r/` prefix', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'r/webdev',
            rulesSummary: '',
            fitRationale: 'r',
            fitScore: 0.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects subreddit with punctuation or special chars', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'web-dev',
            rulesSummary: '',
            fitRationale: 'r',
            fitScore: 0.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects subreddit shorter than 3 chars', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'go',
            rulesSummary: '',
            fitRationale: 'r',
            fitScore: 0.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('rejects subreddit longer than 21 chars', () => {
    expect(() =>
      researchingRedditChannelsOutputSchema.parse({
        candidates: [
          {
            subreddit: 'a'.repeat(22),
            rulesSummary: '',
            fitRationale: 'r',
            fitScore: 0.5,
          },
        ],
        costUsd: 0,
      }),
    ).toThrow();
  });

  it('accepts subreddit at the 21-char boundary with underscores and digits', () => {
    const name = 'Awesome_Subreddit_123'; // 21 chars exactly
    const parsed = researchingRedditChannelsOutputSchema.parse({
      candidates: [
        {
          subreddit: name,
          rulesSummary: '',
          fitRationale: 'r',
          fitScore: 0.5,
        },
      ],
      costUsd: 0,
    });
    expect(parsed.candidates[0].subreddit).toBe(name);
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
    // The fork-driver model is Claude (Haiku — mechanical 1-tool-call work);
    // xAI Grok is invoked separately via the xai_find_customers tool.
    expect(skill!.model).toBe('claude-haiku-4-5-20251001');
    // Body forbids retries → 1 xAI call + 1 StructuredOutput = 2 turns;
    // keep one turn of headroom but no more.
    expect(skill!.maxTurns).toBe(3);
  });

  it('declares xai_find_customers as the only allowed tool', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill!.allowedTools).toEqual(['xai_find_customers']);
  });

  it('renders a body that instructs the fork to call xai_find_customers with web_search + reddit.com filter', async () => {
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
    // Tool wiring
    expect(body).toContain('xai_find_customers');
    expect(body).toContain('web_search');
    expect(body).toContain('reddit.com');
    expect(body).toContain('allowed_domains');
    // The fork must surface a stable response_format name so xAI
    // structured-output validation key matches downstream parsing.
    expect(body).toContain('reddit_channel_research_result');
  });

  it("renders a body that defines the response_format JSON schema's required fields", async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand('{}', fakeCtx);
    // The output JSON schema fields the worker (Task 4) will read.
    expect(body).toContain('candidates');
    expect(body).toContain('subreddit');
    expect(body).toContain('member_count_approx');
    expect(body).toContain('rules_summary');
    expect(body).toContain('fit_rationale');
    expect(body).toContain('fit_score');
    // Regression guard: drop `notes` field — neighbors don't carry one
    // and the Zod output schema doesn't model it.
    expect(body).not.toContain('"notes"');
  });

  it('renders a body that spells out the quality bar', async () => {
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
    expect(body).toContain('Quality bar');
    expect(body).toContain('NSFW');
    expect(body).toContain('1,000 members');
    expect(body).toContain('defaultSources');
    // $ARGUMENTS got substituted with the JSON input
    expect(body).toContain('"name":"Acme"');
  });

  it('renders a body that forbids retries on empty xAI result', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand('{}', fakeCtx);
    expect(body).toMatch(/zero candidates/i);
    expect(body).toMatch(/Do NOT retry/);
  });
});
