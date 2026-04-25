import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@/tools/AgentTool/loader';
import type {
  DiscoveryScoutOutput,
  DiscoveryScoutVerdict,
} from '@/tools/AgentTool/agents/discovery-scout/schema';
import type { DiscoveryReviewerOutput } from '@/tools/AgentTool/agents/discovery-reviewer/schema';
import type { ReviewDecision } from '../review-gate';

const hoisted = vi.hoisted(() => ({
  loadEntryMock: vi.fn<(name: string) => Promise<unknown>>(),
  generateRubricMock: vi.fn<
    (input: unknown) => Promise<{ rubric: string; usage: unknown }>
  >(),
  resolveAgentMock: vi.fn<(name: string) => Promise<AgentDefinition | null>>(),
  runAgentMock: vi.fn(),
  decideReviewMock: vi.fn<(userId: string) => Promise<ReviewDecision>>(),
  logDisagreementsMock: vi.fn(),
  shouldReviewRunMock: vi.fn<(decision: ReviewDecision) => boolean>(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    loadEntry = hoisted.loadEntryMock;
    constructor(_userId: string, _productId: string) {}
  },
}));

vi.mock('../onboarding-rubric', () => ({
  generateOnboardingRubric: hoisted.generateRubricMock,
  ONBOARDING_RUBRIC_MEMORY_NAME: 'discovery-rubric',
}));

vi.mock('../review-gate', () => ({
  decideReview: hoisted.decideReviewMock,
  shouldReviewRun: hoisted.shouldReviewRunMock,
}));

vi.mock('../reviewer-disagreements', () => ({
  logReviewerDisagreements: hoisted.logDisagreementsMock,
}));

vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: hoisted.resolveAgentMock,
}));

vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: (def: AgentDefinition) => ({
    name: def.name,
    systemPrompt: def.systemPrompt,
    model: def.model ?? 'mock-model',
    tools: [],
    maxTurns: def.maxTurns,
  }),
}));

vi.mock('@/bridge/agent-runner', () => ({
  runAgent: hoisted.runAgentMock,
  createToolContext: (deps: Record<string, unknown>) => ({
    abortSignal: new AbortController().signal,
    get<V>(k: string): V {
      if (!(k in deps)) throw new Error(`no dep ${k}`);
      return deps[k] as V;
    },
  }),
}));

import { runDiscoveryV3 } from '../v3-pipeline';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOUT_DEF: AgentDefinition = {
  name: 'discovery-scout',
  description: 'scout',
  tools: [],
  model: 'claude-haiku-4-5-20251001',
  maxTurns: 10,
  systemPrompt: 'scout sys',
  sourcePath: '/scout.md',
};

const REVIEWER_DEF: AgentDefinition = {
  name: 'discovery-reviewer',
  description: 'reviewer',
  tools: [],
  model: 'claude-sonnet-4-6',
  maxTurns: 5,
  systemPrompt: 'reviewer sys',
  sourcePath: '/reviewer.md',
};

function verdict(
  id: string,
  v: 'queue' | 'skip',
  confidence = 0.8,
): DiscoveryScoutVerdict {
  return {
    externalId: id,
    platform: 'x',
    url: `https://x.com/a/status/${id}`,
    title: null,
    body: 'body',
    author: 'alice',
    verdict: v,
    confidence,
    reason: 'r',
  };
}

const BASE_INPUT = {
  userId: 'user-1',
  productId: 'product-1',
  platform: 'x' as const,
  sources: ['"zapier alternative"'],
  product: {
    name: 'ShipFlare',
    description: 'd',
    valueProp: 'v',
    keywords: ['x'],
  },
};

const BASE_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  model: 'mock',
  turns: 1,
};

function mockScoutRun(result: DiscoveryScoutOutput) {
  hoisted.runAgentMock.mockResolvedValueOnce({ result, usage: BASE_USAGE });
}

function mockReviewerRun(result: DiscoveryReviewerOutput) {
  hoisted.runAgentMock.mockResolvedValueOnce({ result, usage: BASE_USAGE });
}

function setAgentsAvailable(opts: {
  scout?: AgentDefinition | null;
  reviewer?: AgentDefinition | null;
}) {
  hoisted.resolveAgentMock.mockImplementation(async (name: string) => {
    if (name === 'discovery-scout') {
      return 'scout' in opts ? opts.scout ?? null : SCOUT_DEF;
    }
    if (name === 'discovery-reviewer') {
      return 'reviewer' in opts ? opts.reviewer ?? null : REVIEWER_DEF;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDiscoveryV3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.logDisagreementsMock.mockResolvedValue({
      total: 0,
      logged: 0,
      skippedLowConfidence: 0,
      unmatched: 0,
    });
    hoisted.shouldReviewRunMock.mockImplementation(
      (d) => d.sampleRate >= 1,
    );
    hoisted.loadEntryMock.mockResolvedValue({ name: 'discovery-rubric' });
    setAgentsAvailable({});
  });

  it('runs scout + reviewer in cold mode and logs disagreements', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 5,
    });
    mockScoutRun({
      verdicts: [verdict('a', 'queue'), verdict('b', 'skip')],
      notes: 'scout notes',
    });
    mockReviewerRun({
      judgments: [
        {
          externalId: 'a',
          verdict: 'skip',
          confidence: 0.9,
          reasoning: 'reviewer disagrees on a',
        },
        {
          externalId: 'b',
          verdict: 'skip',
          confidence: 0.8,
          reasoning: 'agrees on b',
        },
      ],
      notes: 'reviewer notes',
    });
    hoisted.logDisagreementsMock.mockResolvedValue({
      total: 1,
      logged: 1,
      skippedLowConfidence: 0,
      unmatched: 0,
    });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.verdicts).toHaveLength(2);
    expect(res.review.ran).toBe(true);
    expect(res.review.decision.mode).toBe('cold');
    expect(res.review.disagreements?.logged).toBe(1);
    expect(res.usage.reviewer).toBeDefined();
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(2);
    expect(hoisted.logDisagreementsMock).toHaveBeenCalledOnce();
  });

  it('skips reviewer in hot mode', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'hot',
      sampleRate: 0,
      labelCount: 200,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [verdict('a', 'queue')], notes: '' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.review.ran).toBe(false);
    expect(res.usage.reviewer).toBeUndefined();
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(1);
    expect(hoisted.logDisagreementsMock).not.toHaveBeenCalled();
  });

  it('runs reviewer when warm-sample roll succeeds', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'warm',
      sampleRate: 0.1,
      labelCount: 50,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(true);
    mockScoutRun({ verdicts: [verdict('a', 'queue')], notes: '' });
    mockReviewerRun({
      judgments: [
        {
          externalId: 'a',
          verdict: 'queue',
          confidence: 0.8,
          reasoning: 'agrees',
        },
      ],
      notes: '',
    });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.review.ran).toBe(true);
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(2);
  });

  it('skips reviewer when warm-sample roll fails', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'warm',
      sampleRate: 0.1,
      labelCount: 50,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [verdict('a', 'queue')], notes: '' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.review.ran).toBe(false);
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('skips reviewer when scout produced zero verdicts', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 0,
    });
    mockScoutRun({ verdicts: [], notes: 'nothing relevant' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.verdicts).toEqual([]);
    expect(res.review.ran).toBe(false);
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(1);
  });

  it('generates onboarding rubric when missing and proceeds', async () => {
    hoisted.loadEntryMock.mockResolvedValueOnce(null);
    hoisted.generateRubricMock.mockResolvedValueOnce({
      rubric: '## Ideal target customer\nstuff',
      usage: BASE_USAGE,
    });
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'hot',
      sampleRate: 0,
      labelCount: 150,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [verdict('a', 'queue')], notes: '' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(hoisted.generateRubricMock).toHaveBeenCalledOnce();
    expect(hoisted.generateRubricMock.mock.calls[0]![0]).toMatchObject({
      userId: 'user-1',
      productId: 'product-1',
      product: BASE_INPUT.product,
    });
    expect(res.rubricGenerated).toBe(true);
  });

  it('does not regenerate rubric when it already exists', async () => {
    hoisted.loadEntryMock.mockResolvedValueOnce({ name: 'discovery-rubric' });
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'hot',
      sampleRate: 0,
      labelCount: 150,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [], notes: '' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(hoisted.generateRubricMock).not.toHaveBeenCalled();
    expect(res.rubricGenerated).toBe(false);
  });

  it('throws when scout agent definition is missing from registry', async () => {
    setAgentsAvailable({ scout: null });
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 0,
    });

    await expect(runDiscoveryV3(BASE_INPUT, {})).rejects.toThrow(
      /discovery-scout agent definition not found/,
    );
  });

  it('continues with scout-only output when reviewer def is missing', async () => {
    setAgentsAvailable({ reviewer: null });
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 0,
    });
    mockScoutRun({ verdicts: [verdict('a', 'queue')], notes: 'ok' });

    const res = await runDiscoveryV3(BASE_INPUT, {});

    expect(res.review.ran).toBe(false);
    expect(res.verdicts).toHaveLength(1);
    expect(hoisted.runAgentMock).toHaveBeenCalledTimes(1); // no reviewer call
  });

  it('marks coldStart=true in scout message when in cold mode', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 0,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [], notes: '' });

    await runDiscoveryV3(BASE_INPUT, {});

    const scoutCall = hoisted.runAgentMock.mock.calls[0]!;
    const userMessage = scoutCall[1] as string;
    const parsed = JSON.parse(userMessage);
    expect(parsed.coldStart).toBe(true);
  });

  it('marks coldStart=false in scout message when warm or hot', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'warm',
      sampleRate: 0.1,
      labelCount: 50,
    });
    hoisted.shouldReviewRunMock.mockReturnValue(false);
    mockScoutRun({ verdicts: [], notes: '' });

    await runDiscoveryV3(BASE_INPUT, {});

    const userMessage = hoisted.runAgentMock.mock.calls[0]![1] as string;
    expect(JSON.parse(userMessage).coldStart).toBe(false);
  });

  it('strips scout verdicts from reviewer message (reviewer judges independently)', async () => {
    hoisted.decideReviewMock.mockResolvedValue({
      mode: 'cold',
      sampleRate: 1,
      labelCount: 0,
    });
    mockScoutRun({
      verdicts: [verdict('a', 'queue', 0.95)],
      notes: '',
    });
    mockReviewerRun({
      judgments: [
        {
          externalId: 'a',
          verdict: 'skip',
          confidence: 0.9,
          reasoning: 'r',
        },
      ],
      notes: '',
    });

    await runDiscoveryV3(BASE_INPUT, {});

    const reviewerMessage = hoisted.runAgentMock.mock.calls[1]![1] as string;
    const parsed = JSON.parse(reviewerMessage);
    // threads must NOT expose scout's verdict/confidence/reason
    for (const t of parsed.threads) {
      expect(t).not.toHaveProperty('verdict');
      expect(t).not.toHaveProperty('confidence');
      expect(t).not.toHaveProperty('reason');
    }
    expect(parsed.threads[0].externalId).toBe('a');
  });
});
