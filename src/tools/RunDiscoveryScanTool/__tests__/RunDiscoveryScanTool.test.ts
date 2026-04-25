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

describe('run_discovery_scan tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectMock.mockReset();
  });

  it('returns skipped:true when user has no channel for the platform', async () => {
    // Channel preflight: zero rows → preflight hits the skip path.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));

    const result = await runDiscoveryScanTool.execute(
      { platform: 'x' },
      makeCtx({ userId: 'u1', productId: 'p1' }),
    );

    expect(result.skipped).toBe(true);
    expect(result.queued).toHaveLength(0);
  });

  it('returns persisted queued threads with thread ids', async () => {
    // First select() → channel preflight with an 'x' row.
    dbSelectMock.mockReturnValueOnce(buildSelectChain([{ platform: 'x' }]));
    // Second select() → product lookup.
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
    // Third select() (and any subsequent) → empty fallback so persistScoutVerdicts
    // can safely call db internally via its own mock path.
    dbSelectMock.mockReturnValue(buildSelectChain([]));

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
  });
});
