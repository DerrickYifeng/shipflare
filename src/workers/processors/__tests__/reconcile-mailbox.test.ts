import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processReconcileMailbox } from '@/workers/processors/reconcile-mailbox';

vi.mock('@/lib/db', () => ({
  db: { execute: vi.fn(), select: vi.fn() },
}));

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(async () => undefined),
}));

import { db } from '@/lib/db';
import { wake } from '@/workers/processors/lib/wake';

describe('processReconcileMailbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries for orphan agents and calls wake() for each', async () => {
    vi.mocked(db.execute).mockResolvedValue([
      { to_agent_id: 'agent-1' },
      { to_agent_id: 'agent-2' },
    ] as never);
    await processReconcileMailbox();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(1, 'agent-1');
    expect(wake).toHaveBeenNthCalledWith(2, 'agent-2');
  });

  it('does nothing when no orphans found', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    await processReconcileMailbox();
    expect(wake).not.toHaveBeenCalled();
  });
});
