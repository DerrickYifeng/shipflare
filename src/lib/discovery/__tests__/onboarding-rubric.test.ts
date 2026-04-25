import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks are hoisted above imports; `vi.hoisted` lets us share the inner
// mocks between the mock factory and the test assertions.
const hoisted = vi.hoisted(() => ({
  saveEntryMock: vi.fn<(entry: unknown) => Promise<void>>(),
  memoryStoreConstructor: vi.fn<(userId: string, productId: string) => void>(),
  createMessageMock: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

vi.mock('@/core/api-client', () => ({
  createMessage: hoisted.createMessageMock,
  calculateCost: vi.fn(() => 0.0042),
}));

vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    saveEntry = hoisted.saveEntryMock;
    constructor(userId: string, productId: string) {
      hoisted.memoryStoreConstructor(userId, productId);
    }
  },
}));

import {
  generateOnboardingRubric,
  ONBOARDING_RUBRIC_MEMORY_NAME,
} from '../onboarding-rubric';

interface SavedEntry {
  name: string;
  description: string;
  type: string;
  content: string;
}

const createMessageMock = hoisted.createMessageMock;
const saveEntryMock = hoisted.saveEntryMock;
const memoryStoreConstructor = hoisted.memoryStoreConstructor;

function savedEntryAt(index: number): SavedEntry {
  const call = saveEntryMock.mock.calls[index];
  if (!call) throw new Error(`saveEntry not called at index ${index}`);
  return call[0] as SavedEntry;
}

function mockLLMResponse(text: string) {
  createMessageMock.mockResolvedValueOnce({
    response: {
      id: 'msg_x',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text }],
      usage: {
        input_tokens: 420,
        output_tokens: 380,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    } as unknown,
    usage: {
      inputTokens: 420,
      outputTokens: 380,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
}

const SAMPLE_RUBRIC = `## Ideal target customer
- Solo founder running a bootstrapped SaaS with < $10k MRR
- Publishes build-in-public updates and distribution questions on X
- Active in r/SaaS / r/indiehackers with concrete feature / pricing posts

## Not a fit
- Direct competitors — other distribution-automation tools
- Info-product sellers pushing "$10k/mo" funnels — audience is not builders
- Agency operators whose only output is client case studies

## Gray zone
- Part-time indie hackers — queue only when the post is about their own product
- VC-backed founders with distribution — queue only if the post reads product-first

## Key signals
- "how do you get your first users"
- "ran out of ideas for distribution"
- "my SEO isn't working"
- "tried ads, didn't work"
- "what content cadence actually works"`;

describe('generateOnboardingRubric', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveEntryMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const input = {
    userId: 'user-1',
    productId: 'product-1',
    product: {
      name: 'ShipFlare',
      description: 'Distribution-automation for bootstrapped SaaS founders',
      valueProp: 'Stop guessing where to post — we queue threads for you',
      keywords: ['distribution', 'indie-hackers', 'SaaS'],
    },
  };

  it('writes the generated rubric to MemoryStore under the canonical name', async () => {
    mockLLMResponse(SAMPLE_RUBRIC);

    const result = await generateOnboardingRubric(input);

    expect(result.rubric).toContain('## Ideal target customer');
    expect(result.usage.costUsd).toBe(0.0042);
    expect(result.usage.model).toBe('claude-sonnet-4-6');
    expect(result.usage.turns).toBe(1);

    expect(memoryStoreConstructor).toHaveBeenCalledWith('user-1', 'product-1');
    expect(saveEntryMock).toHaveBeenCalledOnce();
    const saved = savedEntryAt(0);
    expect(saved.name).toBe(ONBOARDING_RUBRIC_MEMORY_NAME);
    expect(saved.type).toBe('user');
    expect(saved.content).toBe(SAMPLE_RUBRIC);
    expect(saved.description).toContain('ShipFlare');
  });

  it('passes product name, description, value prop, keywords into the prompt', async () => {
    mockLLMResponse(SAMPLE_RUBRIC);
    await generateOnboardingRubric(input);

    const call = createMessageMock.mock.calls[0]![0];
    expect(call.model).toBe('claude-sonnet-4-6');
    expect(call.messages).toHaveLength(1);
    const userContent = call.messages[0]!.content as string;
    expect(userContent).toContain('ShipFlare');
    expect(userContent).toContain(
      'Distribution-automation for bootstrapped SaaS founders',
    );
    expect(userContent).toContain('Stop guessing');
    expect(userContent).toContain('- distribution');
    expect(userContent).toContain('- indie-hackers');
    expect(userContent).toContain('- SaaS');
  });

  it('handles null valueProp and empty keywords', async () => {
    mockLLMResponse(SAMPLE_RUBRIC);

    await generateOnboardingRubric({
      ...input,
      product: {
        name: 'ShipFlare',
        description: 'd',
        valueProp: null,
        keywords: [],
      },
    });

    const userContent = createMessageMock.mock.calls[0]![0].messages[0]!
      .content as string;
    expect(userContent).toContain('(none provided)');
  });

  it('throws when the model returns an unusably short rubric', async () => {
    mockLLMResponse('too short');

    await expect(generateOnboardingRubric(input)).rejects.toThrow(
      /unusable output/,
    );
    expect(saveEntryMock).not.toHaveBeenCalled();
  });

  it('trims whitespace around the model output before persistence', async () => {
    mockLLMResponse(`\n\n\n${SAMPLE_RUBRIC}\n\n\n`);

    await generateOnboardingRubric(input);

    const saved = savedEntryAt(0);
    expect(saved.content).toBe(SAMPLE_RUBRIC);
    expect(saved.content.startsWith('\n')).toBe(false);
    expect(saved.content.endsWith('\n')).toBe(false);
  });
});
