import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/platform-deps', () => ({
  createPlatformDeps: vi.fn(),
}));

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

const saveEntryMock = vi.fn();
vi.mock('@/memory/store', () => {
  class MemoryStore {
    saveEntry = saveEntryMock;
  }
  return { MemoryStore };
});

vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: vi.fn(),
}));

vi.mock('@/tools/AgentTool/spawn', () => ({
  buildAgentConfigFromDefinition: vi.fn(() => ({ name: 'search-strategist' })),
}));

vi.mock('@/bridge/agent-runner', () => ({
  runAgent: vi.fn(),
  createToolContext: vi.fn((deps) => ({
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      const d = deps as Record<string, unknown>;
      if (key in d) return d[key] as V;
      throw new Error(`no dep ${key}`);
    },
  })),
}));

import { calibrateSearchStrategyTool } from '../CalibrateSearchTool';
import { createPlatformDeps } from '@/lib/platform-deps';
import { resolveAgent } from '@/tools/AgentTool/registry';
import { runAgent } from '@/bridge/agent-runner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCtx(deps: Record<string, unknown>): any {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

function buildSelectChain(rows: unknown[]) {
  const chain: {
    from: () => typeof chain;
    where: () => typeof chain;
    limit: () => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown) => Promise<unknown>;
  } = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
    then: (resolve) => Promise.resolve(resolve(rows)),
  };
  return chain;
}

describe('calibrate_search_strategy tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    saveEntryMock.mockReset();
  });

  it('returns saved:false when no channel is connected', async () => {
    // createPlatformDeps throws when channel is missing — the tool
    // catches it and short-circuits without spawning the strategist.
    vi.mocked(createPlatformDeps).mockRejectedValueOnce(
      new Error('no channel'),
    );

    const result = await calibrateSearchStrategyTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('no_x_channel');
    expect(resolveAgent).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(saveEntryMock).not.toHaveBeenCalled();
  });

  it('persists strategy to MemoryStore on success', async () => {
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    // Product lookup returns the row the tool needs to build the
    // strategist message body.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship faster',
          valueProp: null,
          keywords: ['ship', 'deploy'],
        },
      ]),
    );
    vi.mocked(resolveAgent).mockResolvedValueOnce({
      name: 'search-strategist',
    } as never);
    vi.mocked(runAgent).mockResolvedValueOnce({
      result: {
        queries: ['solo founder asking', '0 to first user'],
        negativeTerms: ['affiliate'],
        rationale: 'pain-point queries beat keyword queries',
        observedYield: 0.75,
        roundsUsed: 2,
        sampleVerdicts: [],
      },
      usage: { costUsd: 0.04 },
    } as never);

    const result = await calibrateSearchStrategyTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.saved).toBe(true);
    expect(result.platform).toBe('x');
    expect(result.queries).toEqual([
      'solo founder asking',
      '0 to first user',
    ]);
    expect(result.observedYield).toBe(0.75);
    expect(result.roundsUsed).toBe(2);
    expect(saveEntryMock).toHaveBeenCalledTimes(1);

    // The persisted blob must round-trip through JSON.parse to the
    // same shape RunDiscoveryScanTool expects to read back.
    const saveCall = saveEntryMock.mock.calls[0]![0] as {
      name: string;
      type: string;
      content: string;
    };
    expect(saveCall.name).toBe('x-search-strategy');
    expect(saveCall.type).toBe('reference');
    const parsed = JSON.parse(saveCall.content) as {
      platform: string;
      queries: string[];
      schemaVersion: number;
      generatedAt: string;
    };
    expect(parsed.platform).toBe('x');
    expect(parsed.queries).toEqual([
      'solo founder asking',
      '0 to first user',
    ]);
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.generatedAt).toBe('string');
  });

  it('throws when product is missing (data integrity, not user-facing)', async () => {
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));

    await expect(
      calibrateSearchStrategyTool.execute(
        { platform: 'x' },
        makeCtx({ userId: 'u1', productId: 'missing' }),
      ),
    ).rejects.toThrow(/product missing not found/);
    expect(saveEntryMock).not.toHaveBeenCalled();
  });
});
