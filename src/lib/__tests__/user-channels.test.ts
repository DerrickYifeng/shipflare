import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbSelectMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => dbSelectMock(...args),
  },
}));

import { getUserChannels } from '../user-channels';

function buildSelectChain(rows: Array<{ platform: string }>) {
  const chain = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return chain;
}

const ORIG_XAI = process.env.XAI_API_KEY;

beforeEach(() => {
  dbSelectMock.mockReset();
  // X's envGuard is XAI_API_KEY — set so isPlatformAvailable('x') passes.
  process.env.XAI_API_KEY = 'test-key';
});

afterEach(() => {
  if (ORIG_XAI === undefined) delete process.env.XAI_API_KEY;
  else process.env.XAI_API_KEY = ORIG_XAI;
});

describe('getUserChannels', () => {
  it('always includes reddit even when channels table is empty', async () => {
    dbSelectMock.mockReturnValueOnce(buildSelectChain([]));
    const result = await getUserChannels('user-1');
    expect(result).toContain('reddit');
  });

  it('always includes reddit even when only x has a channels row', async () => {
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ platform: 'x' }]),
    );
    const result = await getUserChannels('user-1');
    expect(result).toEqual(expect.arrayContaining(['x', 'reddit']));
    expect(result).toHaveLength(2);
  });

  it('does not duplicate reddit when a stale reddit row somehow exists', async () => {
    // Defense-in-depth: pre-pivot DBs may still have reddit rows from
    // before binding removal. The Set dedup must collapse them.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([{ platform: 'x' }, { platform: 'reddit' }]),
    );
    const result = await getUserChannels('user-1');
    expect(result.filter((p) => p === 'reddit')).toHaveLength(1);
    expect(result).toHaveLength(2);
  });

  it('drops platforms that fail isPlatformAvailable', async () => {
    // 'unknown_platform' is not registered in PLATFORMS — must be filtered out.
    dbSelectMock.mockReturnValueOnce(
      buildSelectChain([
        { platform: 'x' },
        { platform: 'unknown_platform' },
      ]),
    );
    const result = await getUserChannels('user-1');
    expect(result).not.toContain('unknown_platform');
    expect(result).toContain('x');
    expect(result).toContain('reddit');
  });
});
