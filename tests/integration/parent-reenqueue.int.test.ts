import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema/users';
import { teams, teamMembers, agentRuns, teamMessages } from '@/lib/db/schema/team';
import { removeChildAndMaybeWake } from '@/workers/processors/lib/parent-reenqueue';

/**
 * Integration tests for D4's atomic parent-reenqueue helper.
 *
 * Requires a running Postgres (the integration setup reuses the dev DB
 * configured via DATABASE_URL). Each test seeds its own ephemeral
 * user/team/member/agent-run rows with random ids and tears them down in
 * afterAll. We do NOT use a transactional rollback because the helper
 * needs to test Postgres-level row locking semantics, which require
 * COMMIT visibility between callers.
 */

const seededUserIds = new Set<string>();
const seededTeamIds = new Set<string>();

interface ParentSetup {
  userId: string;
  teamId: string;
  memberId: string;
  parentAgentId: string;
}

async function seedParent(opts: {
  waitingFor: string[];
  status: string;
}): Promise<ParentSetup> {
  const userId = `test-user-${randomUUID()}`;
  const teamId = `test-team-${randomUUID()}`;
  const memberId = `test-member-${randomUUID()}`;
  const parentAgentId = `test-parent-${randomUUID()}`;

  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
  });
  seededUserIds.add(userId);

  await db.insert(teams).values({
    id: teamId,
    userId,
    name: 'Test Team',
  });
  seededTeamIds.add(teamId);

  await db.insert(teamMembers).values({
    id: memberId,
    teamId,
    agentType: 'coordinator',
    displayName: 'Test Coordinator',
  });

  await db.insert(agentRuns).values({
    id: parentAgentId,
    teamId,
    memberId,
    agentDefName: 'coordinator',
    status: opts.status,
    waitingFor: opts.waitingFor,
  });

  return { userId, teamId, memberId, parentAgentId };
}

async function getParent(parentAgentId: string) {
  const rows = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      waitingFor: agentRuns.waitingFor,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, parentAgentId))
    .limit(1);
  return rows[0];
}

beforeEach(() => {
  // No-op: each test seeds its own rows with unique ids.
});

afterAll(async () => {
  // Cascading deletes via FK: deleting the user removes teams →
  // team_members → agent_runs in turn.
  for (const userId of seededUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
  seededUserIds.clear();
  seededTeamIds.clear();
});

describe('removeChildAndMaybeWake', () => {
  it('removes child, keeps waiting when array non-empty, returns false', async () => {
    const { parentAgentId } = await seedParent({
      waitingFor: ['c1', 'c2'],
      status: 'waiting_for_children',
    });

    const shouldWake = await removeChildAndMaybeWake(parentAgentId, 'c1');

    expect(shouldWake).toBe(false);
    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual(['c2']);
    expect(row?.status).toBe('waiting_for_children');
  });

  it('removes last child, transitions to running, returns true', async () => {
    const { parentAgentId } = await seedParent({
      waitingFor: ['c1'],
      status: 'waiting_for_children',
    });

    const shouldWake = await removeChildAndMaybeWake(parentAgentId, 'c1');

    expect(shouldWake).toBe(true);
    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual([]);
    expect(row?.status).toBe('running');
  });

  it('handles concurrent removal — only one caller gets shouldWake=true', async () => {
    const { parentAgentId } = await seedParent({
      waitingFor: ['c1', 'c2'],
      status: 'waiting_for_children',
    });

    // Fire both removals "simultaneously". Postgres row lock serialises
    // the underlying UPDATEs; exactly one caller observes the
    // waiting_for_children → running transition.
    const results = await Promise.all([
      removeChildAndMaybeWake(parentAgentId, 'c1'),
      removeChildAndMaybeWake(parentAgentId, 'c2'),
    ]);

    const wakes = results.filter(Boolean).length;
    expect(wakes).toBe(1);

    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual([]);
    expect(row?.status).toBe('running');
  });

  it('idempotent — removing a child not in waiting_for is a no-op, returns false', async () => {
    const { parentAgentId } = await seedParent({
      waitingFor: ['c1'],
      status: 'waiting_for_children',
    });

    const shouldWake = await removeChildAndMaybeWake(
      parentAgentId,
      'non-existent-child',
    );

    expect(shouldWake).toBe(false);
    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual(['c1']);
    expect(row?.status).toBe('waiting_for_children');
  });

  it('only transitions waiting_for_children → running, not other statuses', async () => {
    // Legacy parent: already 'running', empty waiting_for. Calling the
    // helper for a non-tracked child must drain nothing (array_remove on
    // an empty array is a no-op) and must NOT report shouldWake=true even
    // though post-image cardinality is 0 and post-image status is
    // 'running' — those conditions also hold for legacy rows that never
    // entered waiting_for_children.
    const { parentAgentId } = await seedParent({
      waitingFor: [],
      status: 'running',
    });

    const shouldWake = await removeChildAndMaybeWake(parentAgentId, 'c1');

    expect(shouldWake).toBe(false);
    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual([]);
    expect(row?.status).toBe('running');
  });

  it('returns false when parent row does not exist', async () => {
    // Defensive: helper must not throw on a missing parent (FK was
    // cascade-deleted between mailbox insert and re-enqueue call).
    const shouldWake = await removeChildAndMaybeWake(
      `test-parent-missing-${randomUUID()}`,
      'c1',
    );
    expect(shouldWake).toBe(false);
  });

  it('participates in outer transaction — rolls back drain when caller aborts (crash recovery)', async () => {
    // Cross-task integration fix: synthAndDeliverNotification wraps
    // the task_notification INSERT + this drain in db.transaction so
    // a worker crash between them can't strand the parent's
    // waiting_for array. Simulate that crash: insert the mailbox
    // row, drain the child, then THROW inside the transaction. The
    // transaction must roll back, leaving waiting_for unchanged and
    // no task_notification row persisted.
    const { parentAgentId, teamId, memberId } = await seedParent({
      waitingFor: ['c1'],
      status: 'waiting_for_children',
    });

    const sentinel = new Error('simulated worker crash');
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(teamMessages).values({
          teamId,
          type: 'user_prompt',
          messageType: 'task_notification',
          fromMemberId: memberId,
          toAgentId: parentAgentId,
          content: '<task-notification>...</task-notification>',
          summary: 'simulated child completed',
        });
        const shouldWake = await removeChildAndMaybeWake(
          parentAgentId,
          'c1',
          tx,
        );
        // Drain SAW the row inside the tx (sanity: returns true on
        // the unblocking transition), but we throw BEFORE commit so
        // the change should not land.
        expect(shouldWake).toBe(true);
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    // Post-rollback: parent must look untouched.
    const row = await getParent(parentAgentId);
    expect(row?.waitingFor).toEqual(['c1']);
    expect(row?.status).toBe('waiting_for_children');

    // No task_notification row landed either.
    const messages = await db
      .select({ id: teamMessages.id })
      .from(teamMessages)
      .where(eq(teamMessages.teamId, teamId));
    expect(messages).toEqual([]);
  });
});
