import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/discovery/v3-pipeline', () => ({
  runDiscoveryV3: vi.fn(),
}));
vi.mock('@/lib/discovery/persist-scout-verdicts', () => ({
  persistScoutVerdicts: vi.fn(),
}));
vi.mock('@/lib/platform-deps', () => ({
  createPlatformDeps: vi.fn(),
}));
// db module is mocked per-test below so each test can choose which rows
// its `select(...)` chain returns.
const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

// MemoryStore is mocked so each test can decide whether the cached
// strategy entry exists. When the entry is absent (or at a legacy
// schemaVersion) the tool falls back to scout's inline-mode generation
// instead of skipping — see the inline-fallback tests below.
const loadEntryMock = vi.fn();
vi.mock('@/memory/store', () => {
  class MemoryStore {
    loadEntry = loadEntryMock;
  }
  return { MemoryStore };
});

import { runDiscoveryScanTool } from '../RunDiscoveryScanTool';
import { runDiscoveryV3 } from '@/lib/discovery/v3-pipeline';
import { persistScoutVerdicts } from '@/lib/discovery/persist-scout-verdicts';
import { createPlatformDeps } from '@/lib/platform-deps';

// Build a minimal ToolContext-like object exposing ctx.get(key) — the
// contract the real tool uses via `readDomainDeps`. Plan's
// `{ domain: {...} }` shape predates the ctx.get(...) contract and
// doesn't reach the impl; this adapter stays small and faithful.
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

// Build the select().from().where()[.limit()] thenable the impl uses.
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

/** A valid persisted strategy doc — the shape RunDiscoveryScanTool
 *  expects to find under `loadEntry('${platform}-search-strategy')`. */
function makeStrategyEntry(
  platform: 'x' | 'reddit' = 'x',
  schemaVersion: 1 | 2 = 2,
) {
  return {
    content: JSON.stringify({
      platform,
      schemaVersion,
      generatedAt: '2026-04-26T00:00:00.000Z',
      queries: ['solo founder asking', '0 to first user'],
      negativeTerms: ['affiliate'],
      rationale: 'pain-point queries beat keyword queries',
      observedPrecision: 0.75,
      reachedTarget: true,
      turnsUsed: 8,
      sampleSize: 24,
      sampleVerdicts: [],
    }),
  };
}

describe('run_discovery_scan tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
    loadEntryMock.mockReset();
  });

  it('returns skipped:true when user has no channel for the platform', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no_x_channel');
    expect(result.queued).toHaveLength(0);
  });

  it('falls back to scout-inline mode when MemoryStore has no strategy', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(null);
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: 'inline scan ran',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x', inlineQueryCount: 12 },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toBeUndefined();
    expect(callArg.negativeTerms).toBeUndefined();
    expect(callArg.inlineQueryCount).toBe(12);
  });

  it('treats a v1 strategy entry as missing (auto-recalibration trigger)', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x', 1));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: 'inline scan ran (v1 strategy ignored)',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toBeUndefined();
    // The caller did not pass inlineQueryCount and there's no strategy —
    // the spread should omit the key entirely (not forward it as undefined).
    expect(callArg.inlineQueryCount).toBeUndefined();
    expect('inlineQueryCount' in callArg).toBe(false);
  });

  it('surfaces scoutNotes and passes presetQueries from the cached strategy', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship', 'deploy'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes:
        'Searched 22 tweets; rejected all (competitor reposts dominated).',
      usage: { scout: { costUsd: 0.018 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    expect(result.queued).toHaveLength(0);
    expect(result.scoutNotes).toContain('rejected all');
    const callArg = vi.mocked(runDiscoveryV3).mock.calls[0]![0];
    expect(callArg.presetQueries).toEqual([
      'solo founder asking',
      '0 to first user',
    ]);
    expect(callArg.negativeTerms).toEqual(['affiliate']);
  });

  it('persists queued verdicts and returns thread summaries', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship', 'deploy'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [
        {
          verdict: 'queue',
          externalId: 'tweet-1',
          platform: 'x',
          title: '',
          body: 'looking for shipflare alternatives',
          author: 'alice',
          url: 'https://x.com/alice/status/1',
          confidence: 0.92,
          reason: 'matches keywords + asking for tools',
        },
      ],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: '1 queueable found.',
      usage: { scout: { costUsd: 0.012 }, reviewer: null },
      rubricGenerated: false,
    } as never);
    vi.mocked(persistScoutVerdicts).mockResolvedValueOnce({ queued: 1 } as never);

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(false);
    expect(result.queued).toHaveLength(1);
    expect(result.queued[0].externalId).toBe('tweet-1');
    expect(result.queued[0].confidence).toBe(0.92);
    expect(result.scanned).toBe(1);
    expect(result.scoutNotes).toBe('1 queueable found.');
  });

  it('emits pre-scan and post-scan tool_progress events around the scout run', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(makeStrategyEntry('x'));
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);

    // Capture call order: emit happens before runDiscoveryV3 if we
    // record the emit-call-count when runDiscoveryV3 is invoked.
    let emitCountAtScanStart = -1;
    const emit = vi.fn();
    vi.mocked(runDiscoveryV3).mockImplementationOnce(async () => {
      emitCountAtScanStart = emit.mock.calls.length;
      return {
        verdicts: [],
        review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
        scoutNotes: '',
        usage: { scout: { costUsd: 0.01 }, reviewer: null },
        rubricGenerated: false,
      } as never;
    });

    const ctx = makeCtx({ userId: 'u1', productId: 'p1' });
    ctx.emitProgress = emit;

    await runDiscoveryScanTool.execute({ platform: 'x' }, ctx);

    // Two events total — pre-scan and post-scan.
    expect(emit).toHaveBeenCalledTimes(2);

    // Pre-scan fires before runDiscoveryV3 (call count was 1 when scan started).
    expect(emitCountAtScanStart).toBe(1);

    // Pre-scan call shape.
    const [pre, post] = emit.mock.calls;
    expect(pre![0]).toBe('run_discovery_scan');
    expect(pre![1]).toMatch(/^Searching x /);
    expect(pre![2]).toMatchObject({ platform: 'x', mode: 'calibrated' });
    expect(pre![2]).toHaveProperty('queryCount', 2);

    // Post-scan call shape.
    expect(post![0]).toBe('run_discovery_scan');
    expect(post![1]).toMatch(/^Scanned/);
    expect(post![2]).toMatchObject({
      platform: 'x',
      scanned: 0,
      queued: 0,
      mode: 'calibrated',
    });
  });

  it('omits queryCount from pre-scan metadata when running inline without an explicit count', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        {
          id: 'p1',
          name: 'Shipflare',
          description: 'ship things',
          valueProp: null,
          keywords: ['ship'],
        },
      ]),
    );
    dbSelectMock.mockReturnValue(buildSelectChain([]));

    loadEntryMock.mockResolvedValueOnce(null);
    vi.mocked(createPlatformDeps).mockResolvedValueOnce({} as never);
    vi.mocked(runDiscoveryV3).mockResolvedValueOnce({
      verdicts: [],
      review: { ran: false, decision: { mode: 'skip' }, disagreements: null },
      scoutNotes: '',
      usage: { scout: { costUsd: 0.01 }, reviewer: null },
      rubricGenerated: false,
    } as never);

    const emit = vi.fn();
    const ctx = makeCtx({ userId: 'u1', productId: 'p1' });
    ctx.emitProgress = emit;

    // No inlineQueryCount input.
    await runDiscoveryScanTool.execute({ platform: 'x' }, ctx);

    const pre = emit.mock.calls[0]!;
    expect(pre[1]).toMatch(/^Searching x with broad inline queries/);
    // Honest about not knowing the count — omit the field entirely.
    expect(pre[2]).not.toHaveProperty('queryCount');
    expect(pre[2]).toMatchObject({ platform: 'x', mode: 'inline' });
  });
});
