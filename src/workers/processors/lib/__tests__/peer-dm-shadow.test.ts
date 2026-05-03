import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wake BEFORE importing the SUT so we can assert it is never called.
vi.mock('@/workers/processors/lib/wake', () => ({
  wake: vi.fn(),
}));

// Mock the Redis publisher BEFORE importing the SUT so the SSE publish
// doesn't try to open a real connection during the test. The publish
// payload is captured for assertion.
const publishSpy = vi.hoisted(() =>
  vi.fn<(channel: string, payload: string) => Promise<void>>(async () => {}),
);
vi.mock('@/lib/redis', () => ({
  getPubSubPublisher: () => ({ publish: publishSpy }),
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
    publishSpy.mockClear();
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

  it('UI-B Task 10: publishes a `peer_dm` SSE event after the durable insert', async () => {
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
    expect(publishSpy).toHaveBeenCalledOnce();
    const call = publishSpy.mock.calls[0];
    const channel = call[0];
    const json = call[1];
    expect(channel).toBe('team:team-1:messages');
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(payload.type).toBe('peer_dm');
    expect(payload.teamId).toBe('team-1');
    expect(payload.from).toBe('researcher');
    expect(payload.to).toBe('writer');
    expect(payload.summary).toBe('asking about citations');
    expect(typeof payload.messageId).toBe('string');
    expect(typeof payload.createdAt).toBe('string');
    // Insert ordering: durable row first, then SSE — both observed.
    expect(insertSpy).toHaveBeenCalledOnce();
  });

  it('UI-B Task 10: skips SSE publish when leadAgentId is null (matches insert short-circuit)', async () => {
    const db = makeDbMock();
    await insertPeerDmShadow({
      teamId: 'team-1',
      leadAgentId: null,
      fromName: 'a',
      toName: 'b',
      summary: 's',
      db: db as never,
    });
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('UI-B Task 10: SSE publish failures do not fail the insert', async () => {
    publishSpy.mockRejectedValueOnce(new Error('redis down'));
    const insertSpy: InsertSpy = vi.fn<(vals: unknown) => void>();
    const db = makeDbMock({ insertSpy });
    await expect(
      insertPeerDmShadow({
        teamId: 'team-1',
        leadAgentId: 'lead-agent-id',
        fromName: 'a',
        toName: 'b',
        summary: 's',
        db: db as never,
      }),
    ).resolves.toBeUndefined();
    expect(insertSpy).toHaveBeenCalledOnce();
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
