import { describe, it, expect, vi } from 'vitest';
import { findLeadAgentId } from '@/lib/team/find-lead-agent';

function makeDb(rows: { id: string }[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
        })),
      })),
    })),
  };
}

describe('findLeadAgentId', () => {
  it('returns lead agentId when present', async () => {
    const db = makeDb([{ id: 'lead-1' }]);
    const result = await findLeadAgentId('team-1', db as never);
    expect(result).toBe('lead-1');
  });

  it('returns null when no lead row exists yet', async () => {
    const db = makeDb([]);
    const result = await findLeadAgentId('team-1', db as never);
    expect(result).toBeNull();
  });
});
