import { describe, it, expect, vi, beforeEach } from 'vitest';

// `dispatchLeadMessage` calls `ensureLeadAgentRun` (resolves the lead's
// agent_runs row) and then inserts a `team_messages` row. We don't have a
// real DB / Redis here, so:
//   - Stub `ensureLeadAgentRun` to return a fixed leadAgentId.
//   - Stub `wake` to a no-op (BullMQ would otherwise try to open Redis).
//   - Pass an in-memory db whose `insert(...).values(row)` captures `row`.
vi.mock('@/lib/team/spawn-lead', () => ({
  ensureLeadAgentRun: vi.fn().mockResolvedValue({ agentId: 'lead-1' }),
}));

vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn().mockResolvedValue(undefined),
}));

import { dispatchLeadMessage } from '@/lib/team/dispatch-lead-message';

interface InsertedRow {
  id: string;
  teamId: string;
  conversationId: string;
  content: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

function buildDb(captureSpy: (row: InsertedRow) => void) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: InsertedRow) => {
        captureSpy(row);
        return [{ id: row.id }];
      }),
    })),
  } as unknown as Parameters<typeof dispatchLeadMessage>[1];
}

describe('dispatchLeadMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists metadata.publicContent when publicSummary is provided', async () => {
    let captured: InsertedRow | null = null;
    const db = buildDb((row) => {
      captured = row;
    });

    const result = await dispatchLeadMessage(
      {
        teamId: 'team-1',
        conversationId: 'conv-1',
        goal: 'INTERNAL_RAW',
        publicSummary: 'PUBLIC_FACE',
        trigger: 'kickoff',
      },
      db,
    );

    expect(result.runId).toBeTruthy();
    expect(result.traceId).toBe('lead-1');
    expect(result.alreadyRunning).toBe(false);

    expect(captured).not.toBeNull();
    const row = captured as unknown as InsertedRow;
    expect(row.content).toBe('INTERNAL_RAW');
    expect(row.metadata).toEqual({
      trigger: 'kickoff',
      publicContent: 'PUBLIC_FACE',
    });
  });

  it('omits publicContent from metadata when publicSummary is not provided', async () => {
    let captured: InsertedRow | null = null;
    const db = buildDb((row) => {
      captured = row;
    });

    await dispatchLeadMessage(
      {
        teamId: 'team-1',
        conversationId: 'conv-1',
        goal: 'INTERNAL_RAW',
        trigger: 'cron',
      },
      db,
    );

    expect(captured).not.toBeNull();
    const row = captured as unknown as InsertedRow;
    expect(row.content).toBe('INTERNAL_RAW');
    expect(row.metadata).toEqual({ trigger: 'cron' });
    expect('publicContent' in (row.metadata as object)).toBe(false);
  });
});
