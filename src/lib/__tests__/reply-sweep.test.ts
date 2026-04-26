/**
 * maybeEnqueueReplySweep unit tests.
 *
 * After the daily-cron refactor the helper:
 *   - finds today's `content_reply` plan_item slots (state='planned')
 *   - throttles to "skip if a reply_sweep already started today (UTC)"
 *   - drops the legacy "empty inbox in last 24h" check (the new daily
 *     session runs discovery itself)
 *   - injects each slot's planItemId + channel + targetCount into the
 *     team-run goal so the coordinator can drive the retry loop.
 *
 * Tests cover: happy enqueue, no_team / no_product / no_coordinator
 * skips, no_slots_today skip, throttled (today already swept),
 * already_running, slot ignored when targetCount is missing/0, slots
 * filtered to today's UTC date.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});
vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));
// Stub createAutomationConversation so we don't hit the real DB writer
// for the conversation row inside the helper.
vi.mock('@/lib/team-conversation-helpers', () => ({
  createAutomationConversation: async () => 'conv-stub',
}));

import { maybeEnqueueReplySweep } from '../reply-sweep';
import type { Database } from '@/lib/db';
import { planItems, teamMembers, teamRuns, teams } from '@/lib/db/schema';

interface TeamRow {
  id: string;
  userId: string;
  productId: string | null;
}
interface MemberRow {
  id: string;
  teamId: string;
  agentType: string;
}
interface TeamRunRow {
  id: string;
  teamId: string;
  trigger: string;
  status: string;
  startedAt: Date;
}
interface PlanItemRow {
  id: string;
  userId: string;
  productId: string;
  kind: string;
  state: string;
  channel: string | null;
  scheduledAt: Date;
  params: unknown;
}

// 2026-04-26 12:00 UTC — used as `now` so today's UTC bounds are
// 2026-04-26 00:00 → 2026-04-27 00:00.
const NOW = new Date('2026-04-26T12:00:00Z');
const TODAY_NOON = new Date('2026-04-26T14:00:00Z'); // inside today
const YESTERDAY_NOON = new Date('2026-04-25T14:00:00Z'); // outside today
const TOMORROW_NOON = new Date('2026-04-27T14:00:00Z'); // outside today

function seedTeam(
  store: InMemoryStore,
  params: {
    teamId?: string;
    userId?: string;
    productId?: string | null;
    withCoordinator?: boolean;
  } = {},
): { teamId: string; userId: string; productId: string; coordinatorId: string } {
  const teamId = params.teamId ?? 'team-1';
  const userId = params.userId ?? 'user-1';
  const productId = params.productId === null
    ? null
    : (params.productId ?? 'prod-1');
  const coordinatorId = `${teamId}-coord`;
  store.register<TeamRow>(teams, [{ id: teamId, userId, productId }]);
  if (params.withCoordinator !== false) {
    store.register<MemberRow>(teamMembers, [
      { id: coordinatorId, teamId, agentType: 'coordinator' },
    ]);
  } else {
    store.register<MemberRow>(teamMembers, []);
  }
  store.register<TeamRunRow>(teamRuns, []);
  store.register<PlanItemRow>(planItems, []);
  return {
    teamId,
    userId,
    productId: productId ?? '',
    coordinatorId,
  };
}

function seedSlot(
  store: InMemoryStore,
  override: Partial<PlanItemRow> & {
    userId: string;
    productId: string;
  },
): PlanItemRow {
  const list = store.get<PlanItemRow>(planItems);
  const row: PlanItemRow = {
    id: `slot-${list.length}`,
    kind: 'content_reply',
    state: 'planned',
    channel: 'x',
    scheduledAt: TODAY_NOON,
    params: { targetCount: 5 },
    ...override,
  };
  list.push(row);
  return row;
}

let store: InMemoryStore;
let enqueueTeamRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store = createInMemoryStore();
  enqueueTeamRun = vi.fn();
});

function deps() {
  return {
    db: store.db as Database,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    enqueueTeamRun: enqueueTeamRun as any,
    now: NOW,
  };
}

describe('maybeEnqueueReplySweep', () => {
  it('enqueues a reply_sweep with slot details when today has a planned content_reply', async () => {
    const { teamId, userId, productId, coordinatorId } = seedTeam(store);
    const slot = seedSlot(store, { userId, productId });
    enqueueTeamRun.mockResolvedValue({
      runId: 'run-1',
      traceId: 't-1',
      alreadyRunning: false,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({
      status: 'enqueued',
      runId: 'run-1',
      teamId,
      slotCount: 1,
    });
    expect(enqueueTeamRun).toHaveBeenCalledTimes(1);
    const arg = enqueueTeamRun.mock.calls[0]![0];
    expect(arg.teamId).toBe(teamId);
    expect(arg.trigger).toBe('reply_sweep');
    expect(arg.rootMemberId).toBe(coordinatorId);
    // Goal carries the slot's planItemId + channel + targetCount.
    expect(arg.goal).toContain(`planItemId=${slot.id}`);
    expect(arg.goal).toContain('channel=x');
    expect(arg.goal).toContain('targetCount=5');
    // And the retry-loop instructions.
    expect(arg.goal).toContain('run_discovery_scan');
    expect(arg.goal).toContain('community-manager');
    expect(arg.goal).toContain('update_plan_item');
  });

  it('skips with no_team when the user has no team', async () => {
    store.register<TeamRow>(teams, []);
    const result = await maybeEnqueueReplySweep('orphan-user', deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId: null,
      reason: 'no_team',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with no_product when the team is not bound to a product', async () => {
    const { teamId, userId } = seedTeam(store, { productId: null });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_product',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with no_coordinator when the team has no coordinator member', async () => {
    const { teamId, userId, productId } = seedTeam(store, {
      withCoordinator: false,
    });
    seedSlot(store, { userId, productId });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_coordinator',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with no_slots_today when no content_reply plan_item exists for today', async () => {
    const { teamId, userId } = seedTeam(store);
    // No planItems seeded → no slots.
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_slots_today',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips slots scheduled outside today\'s UTC window (yesterday/tomorrow)', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId, scheduledAt: YESTERDAY_NOON });
    seedSlot(store, { userId, productId, scheduledAt: TOMORROW_NOON });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_slots_today',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('skips with no_slots_today when the only slot has targetCount = 0', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId, params: { targetCount: 0 } });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_slots_today',
    });
  });

  it('skips with no_slots_today when targetCount is missing from params', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId, params: {} });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_slots_today',
    });
  });

  it('skips drafted/completed slots — only state="planned" counts', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId, state: 'drafted' });
    seedSlot(store, { userId, productId, state: 'completed' });
    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'no_slots_today',
    });
  });

  it('skips with throttled when a reply_sweep already started earlier today', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId });
    store.get<TeamRunRow>(teamRuns).push({
      id: 'today-earlier-run',
      teamId,
      trigger: 'reply_sweep',
      // 8h before NOW — same UTC date.
      startedAt: new Date(NOW.getTime() - 8 * 60 * 60_000),
      status: 'completed',
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'throttled',
    });
    expect(enqueueTeamRun).not.toHaveBeenCalled();
  });

  it('allows a sweep when the prior reply_sweep was on a different UTC date', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId });
    store.get<TeamRunRow>(teamRuns).push({
      id: 'yesterday-run',
      teamId,
      trigger: 'reply_sweep',
      // 30h before NOW — definitely yesterday.
      startedAt: new Date(NOW.getTime() - 30 * 60 * 60_000),
      status: 'completed',
    });
    enqueueTeamRun.mockResolvedValue({
      runId: 'run-2',
      traceId: 't-2',
      alreadyRunning: false,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result).toEqual({
      status: 'enqueued',
      runId: 'run-2',
      teamId,
      slotCount: 1,
    });
  });

  it('skips with already_running when enqueueTeamRun returns alreadyRunning=true', async () => {
    const { teamId, userId, productId } = seedTeam(store);
    seedSlot(store, { userId, productId });
    enqueueTeamRun.mockResolvedValue({
      runId: 'existing-run',
      traceId: '',
      alreadyRunning: true,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());
    expect(result).toEqual({
      status: 'skipped',
      teamId,
      reason: 'already_running',
    });
  });

  it('handles multiple slots (one per channel) by listing all of them in the goal', async () => {
    const { userId, productId } = seedTeam(store);
    const xSlot = seedSlot(store, { userId, productId, channel: 'x' });
    const redditSlot = seedSlot(store, {
      userId,
      productId,
      channel: 'reddit',
      params: { targetCount: 2 },
    });
    enqueueTeamRun.mockResolvedValue({
      runId: 'run-multi',
      traceId: 't',
      alreadyRunning: false,
    });

    const result = await maybeEnqueueReplySweep(userId, deps());

    expect(result.status).toBe('enqueued');
    if (result.status !== 'enqueued') return;
    expect(result.slotCount).toBe(2);
    const goal = enqueueTeamRun.mock.calls[0]![0].goal;
    expect(goal).toContain(`planItemId=${xSlot.id}`);
    expect(goal).toContain(`planItemId=${redditSlot.id}`);
    expect(goal).toContain('targetCount=5');
    expect(goal).toContain('targetCount=2');
  });
});
