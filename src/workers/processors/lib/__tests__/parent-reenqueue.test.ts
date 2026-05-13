import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db client. `removeChildAndMaybeWake` issues a single
// `db.execute(sql\`...\`)` returning an array of rows shaped like
// `{ new_remaining, new_status, transitioned }`. We stub the array per
// test to simulate Postgres's actual response under each scenario;
// real-DB atomicity is covered by the matching integration test in
// `tests/integration/parent-reenqueue.int.test.ts`.
//
// vi.hoisted is required: vi.mock factories run BEFORE top-level
// `const`s in this file, so a bare `const executeMock = vi.fn()` would
// hit TDZ when the factory below tries to capture it.
const executeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({
  db: {
    execute: executeMock,
  },
}));

import { removeChildAndMaybeWake } from '@/workers/processors/lib/parent-reenqueue';

beforeEach(() => {
  executeMock.mockReset();
});

describe('removeChildAndMaybeWake (unit — contract)', () => {
  it('returns true when row.transitioned=true (the unblocking call)', async () => {
    executeMock.mockResolvedValueOnce([
      { new_remaining: 0, new_status: 'running', transitioned: true },
    ]);
    const result = await removeChildAndMaybeWake('parent-1', 'child-1');
    expect(result).toBe(true);
  });

  it('returns false when row.transitioned=false even if status is running', async () => {
    // Legacy parent: already 'running' with empty waiting_for. The CTE
    // returns post-image status='running' and remaining=0, but the
    // pre-image status was NOT 'waiting_for_children', so transitioned=false.
    // The bug we explicitly guard against: returning true here would
    // double-wake legacy parents on every child completion.
    executeMock.mockResolvedValueOnce([
      { new_remaining: 0, new_status: 'running', transitioned: false },
    ]);
    const result = await removeChildAndMaybeWake('parent-1', 'child-1');
    expect(result).toBe(false);
  });

  it('returns false when siblings still outstanding (remaining > 0)', async () => {
    executeMock.mockResolvedValueOnce([
      {
        new_remaining: 2,
        new_status: 'waiting_for_children',
        transitioned: false,
      },
    ]);
    const result = await removeChildAndMaybeWake('parent-1', 'child-1');
    expect(result).toBe(false);
  });

  it('returns false when parent row is missing (cascade-deleted)', async () => {
    executeMock.mockResolvedValueOnce([]);
    const result = await removeChildAndMaybeWake(
      'parent-missing',
      'child-1',
    );
    expect(result).toBe(false);
  });

  it('only fires ONE UPDATE per call (atomic single-statement contract)', async () => {
    executeMock.mockResolvedValueOnce([
      { new_remaining: 0, new_status: 'running', transitioned: true },
    ]);
    await removeChildAndMaybeWake('parent-1', 'child-1');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
