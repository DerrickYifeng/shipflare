import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryScoutVerdict } from '@/tools/AgentTool/agents/discovery-scout/schema';
import type { DiscoveryReviewerJudgment } from '@/tools/AgentTool/agents/discovery-reviewer/schema';

const hoisted = vi.hoisted(() => ({
  appendLogMock: vi.fn<(entry: string) => Promise<void>>(),
  storeConstructor: vi.fn<(userId: string, productId: string) => void>(),
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
    appendLog = hoisted.appendLogMock;
    constructor(userId: string, productId: string) {
      hoisted.storeConstructor(userId, productId);
    }
  },
}));

import {
  logReviewerDisagreements,
  MIN_REVIEWER_CONFIDENCE,
} from '../reviewer-disagreements';

function scout(
  externalId: string,
  verdict: 'queue' | 'skip',
  confidence: number,
  reason = 'scout reason',
): DiscoveryScoutVerdict {
  return {
    externalId,
    platform: 'x',
    url: `https://x.com/a/status/${externalId}`,
    title: null,
    body: null,
    author: null,
    verdict,
    confidence,
    reason,
  };
}

function reviewer(
  externalId: string,
  verdict: 'queue' | 'skip',
  confidence: number,
  reasoning = 'reviewer reason',
): DiscoveryReviewerJudgment {
  return { externalId, verdict, confidence, reasoning };
}

describe('logReviewerDisagreements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.appendLogMock.mockResolvedValue(undefined);
  });

  const baseInput = { userId: 'user-1', productId: 'product-1' };

  it('logs only disagreements at or above the confidence floor', async () => {
    const summary = await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [
        scout('a', 'queue', 0.9),
        scout('b', 'queue', 0.5),
        scout('c', 'skip', 0.3),
        scout('d', 'queue', 0.8),
      ],
      reviewerJudgments: [
        reviewer('a', 'queue', 0.9), // agree → not logged
        reviewer('b', 'skip', 0.9), // disagree + high confidence → log
        reviewer('c', 'queue', 0.4), // disagree but BELOW floor → skip
        reviewer('d', 'skip', MIN_REVIEWER_CONFIDENCE), // exactly at floor → log
      ],
    });

    expect(summary).toEqual({
      total: 3,
      logged: 2,
      skippedLowConfidence: 1,
      unmatched: 0,
    });
    expect(hoisted.appendLogMock).toHaveBeenCalledTimes(2);

    const lines = hoisted.appendLogMock.mock.calls.map((c) => c[0]);
    expect(lines.every((l) => l.startsWith('[reviewer-disagreement]'))).toBe(
      true,
    );
    expect(lines[0]).toContain('url=https://x.com/a/status/b');
    expect(lines[0]).toContain('scout=queue(0.50)');
    expect(lines[0]).toContain('reviewer=skip(0.90)');
  });

  it('never logs when scout and reviewer agree on every thread', async () => {
    const summary = await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [
        scout('a', 'queue', 0.9),
        scout('b', 'skip', 0.3),
      ],
      reviewerJudgments: [
        reviewer('a', 'queue', 0.85),
        reviewer('b', 'skip', 0.9),
      ],
    });

    expect(summary).toEqual({
      total: 0,
      logged: 0,
      skippedLowConfidence: 0,
      unmatched: 0,
    });
    expect(hoisted.appendLogMock).not.toHaveBeenCalled();
  });

  it('reports unmatched externalIds on either side', async () => {
    const summary = await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [scout('a', 'queue', 0.9), scout('b', 'queue', 0.9)],
      reviewerJudgments: [
        reviewer('a', 'queue', 0.9),
        reviewer('x-not-in-scout', 'skip', 0.9),
      ],
    });

    // b was in scout, not in reviewer → unmatched (+1)
    // x-not-in-scout was in reviewer, not in scout → unmatched (+1)
    expect(summary.unmatched).toBe(2);
    // a agrees → no log; b not paired → no log
    expect(summary.logged).toBe(0);
  });

  it('swallows appendLog failures and continues with the remaining entries', async () => {
    hoisted.appendLogMock
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    const summary = await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [
        scout('a', 'queue', 0.9),
        scout('b', 'queue', 0.9),
      ],
      reviewerJudgments: [
        reviewer('a', 'skip', 0.9),
        reviewer('b', 'skip', 0.9),
      ],
    });

    expect(hoisted.appendLogMock).toHaveBeenCalledTimes(2);
    expect(summary.total).toBe(2);
    expect(summary.logged).toBe(1);
  });

  it('opens the store scoped to (userId, productId)', async () => {
    await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [scout('a', 'queue', 0.9)],
      reviewerJudgments: [reviewer('a', 'skip', 0.9)],
    });

    expect(hoisted.storeConstructor).toHaveBeenCalledWith(
      'user-1',
      'product-1',
    );
  });

  it('skips constructing the store when there is nothing worth logging', async () => {
    // Agreement everywhere → no need to open the MemoryStore.
    await logReviewerDisagreements({
      ...baseInput,
      scoutVerdicts: [scout('a', 'queue', 0.9)],
      reviewerJudgments: [reviewer('a', 'queue', 0.9)],
    });

    expect(hoisted.storeConstructor).not.toHaveBeenCalled();
    expect(hoisted.appendLogMock).not.toHaveBeenCalled();
  });
});
