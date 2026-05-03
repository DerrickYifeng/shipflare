import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wake BEFORE importing the SUT so we can assert it is never called.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(),
}));

import { insertPeerDmShadow } from '@/workers/processors/lib/peer-dm-shadow';
import { wake } from '@/workers/processors/lib/wake';

type InsertSpy = ReturnType<typeof vi.fn<(vals: unknown) => void>>;

function makeDbMock(opts: { insertSpy?: InsertSpy } = {}) {
  const insertSpy: InsertSpy = opts.insertSpy ?? vi.fn<(vals: unknown) => void>();
  return {
    insert: () => ({
      values: async (vals: unknown) => {
        insertSpy(vals);
      },
    }),
  };
}

describe('insertPeerDmShadow — Phase C', () => {
  beforeEach(() => {
    vi.mocked(wake).mockClear();
  });

  it('inserts a shadow row addressed to leadAgentId', async () => {
    const insertSpy: InsertSpy = vi.fn<(vals: unknown) => void>();
    const db = makeDbMock({ insertSpy });
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'researcher',
      toName: 'writer',
      summary: 'asking about citations',
      db: db as never,
    });
    expect(insertSpy).toHaveBeenCalledOnce();
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.toAgentId).toBe('lead-agent-id');
    expect(inserted.teamId).toBe('team-1');
    expect(inserted.messageType).toBe('message');
    expect(inserted.content).toContain('<peer-dm');
    expect(inserted.content).toContain('researcher');
    expect(inserted.content).toContain('writer');
    expect(inserted.content).toContain('asking about citations');
    expect(inserted.summary).toBe('asking about citations');
  });

  it('CRITICAL INVARIANT: does NOT call wake()', async () => {
    const db = makeDbMock();
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'a',
      toName: 'b',
      summary: 's',
      db: db as never,
    });
    expect(wake).not.toHaveBeenCalled();
  });

  it('skips insert when leadAgentId is null (Phase B kludge — lead has no agent_runs row yet)', async () => {
    const insertSpy: InsertSpy = vi.fn<(vals: unknown) => void>();
    const db = makeDbMock({ insertSpy });
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: null,
      fromName: 'a',
      toName: 'b',
      summary: 's',
      db: db as never,
    });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });

  it('XML-escapes special chars in the summary inside <peer-dm>', async () => {
    const insertSpy: InsertSpy = vi.fn<(vals: unknown) => void>();
    const db = makeDbMock({ insertSpy });
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: 'lead-agent-id',
      fromName: 'researcher',
      toName: 'writer',
      summary: 'q&a <xml> "quoted" \'apos\'',
      db: db as never,
    });
    const inserted = insertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.content).toContain('&amp;');
    expect(inserted.content).toContain('&lt;xml&gt;');
    expect(inserted.content).toContain('&quot;');
    expect(inserted.content).toContain('&apos;');
    // The inner peer-dm body should not contain raw `<xml>`.
    expect(inserted.content).not.toMatch(/<xml>/);
  });
});
