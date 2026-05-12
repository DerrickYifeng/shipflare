/**
 * research_reddit_channels unit tests.
 *
 * The tool is a thin wrapper around `runRedditChannelResearch` (which
 * the BullMQ worker already exercises in
 * `src/workers/processors/__tests__/reddit-channel-research.test.ts`).
 * These tests just verify the wrapper:
 *   - reads userId / productId from ctx via readDomainDeps
 *   - default-forces force=false
 *   - passes force=true through
 *   - returns the underlying result verbatim (idempotent + fresh paths)
 *   - rejects unexpected input keys at the strict schema boundary
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';

const runRedditChannelResearchMock = vi.fn();

vi.mock('@/workers/processors/reddit-channel-research', () => ({
  runRedditChannelResearch: (...args: unknown[]) =>
    runRedditChannelResearchMock(...args),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { researchRedditChannelsTool } from '../ResearchRedditChannelsTool';

function makeCtx(deps: Record<string, unknown>): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

beforeEach(() => {
  runRedditChannelResearchMock.mockReset();
});

describe('researchRedditChannelsTool', () => {
  it('forwards userId / productId from ctx and defaults force=false', async () => {
    runRedditChannelResearchMock.mockResolvedValueOnce({
      subreddits: [
        { subreddit: 'SaaS', rank: 1, fitScore: 0.91 },
        { subreddit: 'indiehackers', rank: 2, fitScore: 0.85 },
        { subreddit: 'microsaas', rank: 3, fitScore: 0.72 },
      ],
      written: 3,
    });

    const ctx = makeCtx({ userId: 'u-1', productId: 'p-1' });

    const result = await researchRedditChannelsTool.execute({ force: false }, ctx);

    expect(runRedditChannelResearchMock).toHaveBeenCalledTimes(1);
    const [args, passedCtx] = runRedditChannelResearchMock.mock.calls[0]!;
    expect(args).toEqual({ userId: 'u-1', productId: 'p-1', force: false });
    expect(passedCtx).toBe(ctx);
    expect(result.written).toBe(3);
    expect(result.subreddits.map((s) => s.subreddit)).toEqual([
      'SaaS',
      'indiehackers',
      'microsaas',
    ]);
  });

  it('returns the idempotent payload (written=0 with pre-existing rows) verbatim', async () => {
    runRedditChannelResearchMock.mockResolvedValueOnce({
      subreddits: [{ subreddit: 'preexisting', rank: 1, fitScore: 0.8 }],
      written: 0,
    });

    const ctx = makeCtx({ userId: 'u-1', productId: 'p-1' });

    const result = await researchRedditChannelsTool.execute({ force: false }, ctx);

    expect(result.written).toBe(0);
    expect(result.subreddits).toEqual([
      { subreddit: 'preexisting', rank: 1, fitScore: 0.8 },
    ]);
  });

  it('passes force=true through to the underlying helper', async () => {
    runRedditChannelResearchMock.mockResolvedValueOnce({
      subreddits: [{ subreddit: 'fresh', rank: 1, fitScore: 0.9 }],
      written: 1,
    });

    const ctx = makeCtx({ userId: 'u-1', productId: 'p-1' });

    await researchRedditChannelsTool.execute({ force: true }, ctx);

    const [args] = runRedditChannelResearchMock.mock.calls[0]!;
    expect(args).toEqual({ userId: 'u-1', productId: 'p-1', force: true });
  });

  it('applies the zod default when force is omitted from input', () => {
    const parsed = researchRedditChannelsTool.inputSchema.parse({});
    expect(parsed).toEqual({ force: false });
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parsed = researchRedditChannelsTool.inputSchema.safeParse({
      force: false,
      bogus: 1,
    });
    expect(parsed.success).toBe(false);
  });

  it('throws when userId / productId are missing from ctx', async () => {
    const ctx = makeCtx({}); // no deps
    await expect(
      researchRedditChannelsTool.execute({ force: false }, ctx),
    ).rejects.toThrow(/userId/);
  });
});
