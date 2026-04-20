import { describe, it, expect } from 'vitest';
import {
  tacticalPlanSchema,
  tacticalPlanItemSchema,
  type TacticalPlan,
  type TacticalPlanItem,
} from '@/agents/schemas';

// ---------------------------------------------------------------------------
// Fixture helpers. The tactical-planner test suite covers:
//  1. Schema validation (accept / reject each axis).
//  2. A "channel filter" contract test: when a candidate plan includes items
//     for channels not in the active-channels list, the schema still accepts
//     it (the filter is a prompt-level rule, not a schema-level rule) — so
//     the test here asserts that we can MECHANICALLY filter at the caller
//     side and still end up with schema-valid output. This mirrors what the
//     Phase 7 dispatcher will enforce.
//  3. A "dedupe" contract test: items whose titles match
//     completedLastWeek titles (case-insensitive) should be rejected by the
//     caller's post-filter. Same rationale — validated at the orchestration
//     layer, not in Zod.
// ---------------------------------------------------------------------------

function makeValidItem(
  overrides: Partial<TacticalPlanItem> = {},
): TacticalPlanItem {
  const base: TacticalPlanItem = {
    kind: 'content_post',
    userAction: 'approve',
    phase: 'audience',
    channel: 'x',
    scheduledAt: '2026-04-22T17:00:00Z',
    skillName: 'draft-single-post',
    params: {
      angle: 'data',
      anchor_theme: 'Week theme',
      pillar: 'build-in-public',
    },
    title: 'Data post: what shipping reply-guy engine revealed',
    description: 'Lead with the number. Unpack why it matters in 2 sentences.',
  };
  return { ...base, ...overrides };
}

function makeValidPlan(overrides: Partial<TacticalPlan> = {}): TacticalPlan {
  const base: TacticalPlan = {
    plan: {
      thesis: 'Marketing is an approval queue, not a second job.',
      notes:
        "This week we lean into the approval-queue thesis with 4 X posts, one reddit post in r/SideProject, and one weekly drip email. Two stalled items from last week — check them before Tuesday's post lands.",
    },
    items: [
      makeValidItem(),
      makeValidItem({
        scheduledAt: '2026-04-23T14:00:00Z',
        params: {
          angle: 'story',
          anchor_theme: 'Week theme',
          pillar: 'solo-dev-ops',
        },
        title: 'Story post: the 40 minute tweet that started ShipFlare',
      }),
      makeValidItem({
        kind: 'email_send',
        channel: 'email',
        scheduledAt: '2026-04-24T13:00:00Z',
        skillName: 'draft-email',
        params: { emailType: 'drip_week_1' },
        title: 'Weekly drip email to waitlist',
        description: 'One shipped milestone + one pre-launch date update.',
      }),
    ],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('tacticalPlanItemSchema', () => {
  it('accepts a content_post item with draft-single-post skill', () => {
    expect(() => tacticalPlanItemSchema.parse(makeValidItem())).not.toThrow();
  });

  it('accepts a setup_task with skillName: null', () => {
    const valid = makeValidItem({
      kind: 'setup_task',
      userAction: 'manual',
      channel: null,
      skillName: null,
      params: { targetCount: 5 },
      title: 'Run 5 discovery interviews',
    });
    expect(() => tacticalPlanItemSchema.parse(valid)).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    const invalid = { ...makeValidItem(), kind: 'smoke_break' };
    expect(() => tacticalPlanItemSchema.parse(invalid)).toThrow();
  });

  it('rejects an unknown userAction', () => {
    const invalid = { ...makeValidItem(), userAction: 'yolo' };
    expect(() => tacticalPlanItemSchema.parse(invalid)).toThrow();
  });

  it('rejects a title over 200 chars', () => {
    const invalid = makeValidItem({ title: 'a'.repeat(201) });
    expect(() => tacticalPlanItemSchema.parse(invalid)).toThrow();
  });

  it('rejects a description over 600 chars', () => {
    const invalid = makeValidItem({ description: 'a'.repeat(601) });
    expect(() => tacticalPlanItemSchema.parse(invalid)).toThrow();
  });

  it('rejects an empty params record via missing key', () => {
    // params is required; setting it to undefined trips the schema.
    const invalid = { ...makeValidItem() } as Record<string, unknown>;
    delete invalid.params;
    expect(() => tacticalPlanItemSchema.parse(invalid)).toThrow();
  });
});

describe('tacticalPlanSchema', () => {
  it('accepts a minimal valid 3-item plan', () => {
    expect(() => tacticalPlanSchema.parse(makeValidPlan())).not.toThrow();
  });

  it('rejects a plan with fewer than 3 items', () => {
    const invalid = makeValidPlan({ items: [makeValidItem()] });
    expect(() => tacticalPlanSchema.parse(invalid)).toThrow();
  });

  it('rejects a plan with more than 40 items', () => {
    const invalid = makeValidPlan({
      items: Array.from({ length: 41 }, (_, i) =>
        makeValidItem({
          scheduledAt: `2026-04-${String(20 + (i % 7)).padStart(2, '0')}T17:00:00Z`,
          title: `Item ${i}`,
        }),
      ),
    });
    expect(() => tacticalPlanSchema.parse(invalid)).toThrow();
  });

  it('rejects an empty thesis', () => {
    const invalid = makeValidPlan({
      plan: { thesis: '', notes: 'notes' },
    });
    expect(() => tacticalPlanSchema.parse(invalid)).toThrow();
  });

  it('rejects notes over 1200 chars', () => {
    const invalid = makeValidPlan({
      plan: { thesis: 't', notes: 'a'.repeat(1201) },
    });
    expect(() => tacticalPlanSchema.parse(invalid)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Channel filter contract — validated at the orchestration layer, not the
// schema. These tests pin the downstream filter behaviour so the Phase 7
// dispatcher implements them the same way.
// ---------------------------------------------------------------------------

/**
 * Caller-side filter that rejects items targeting channels not in the
 * user's active-channels list. Mirrors the hard rule in the planner prompt
 * and the dispatcher will enforce it at ingest time.
 */
function filterByChannels(
  plan: TacticalPlan,
  activeChannels: readonly string[],
): TacticalPlan {
  const allowed = new Set(activeChannels);
  return {
    plan: plan.plan,
    items: plan.items.filter((i) => i.channel === null || allowed.has(i.channel)),
  };
}

describe('channel filter contract', () => {
  it('strips reddit + email items when channels=["x"]', () => {
    const planWithAllChannels = makeValidPlan({
      items: [
        makeValidItem({ channel: 'x', title: 'x-1' }),
        makeValidItem({
          channel: 'reddit',
          skillName: null,
          title: 'reddit-1',
        }),
        makeValidItem({
          channel: 'email',
          kind: 'email_send',
          skillName: 'draft-email',
          title: 'email-1',
          params: { emailType: 'welcome' },
        }),
        makeValidItem({ channel: 'x', title: 'x-2' }),
      ],
    });
    const filtered = filterByChannels(planWithAllChannels, ['x']);
    // Two items remain — both on x.
    expect(filtered.items).toHaveLength(2);
    expect(filtered.items.every((i) => i.channel === 'x')).toBe(true);
  });

  it('keeps channel: null items (channel-agnostic setup_tasks)', () => {
    const plan = makeValidPlan({
      items: [
        makeValidItem({ channel: 'x', title: 'x-1' }),
        makeValidItem({
          channel: null,
          kind: 'setup_task',
          userAction: 'manual',
          skillName: null,
          title: 'Nail positioning one-liner',
          params: {},
        }),
        makeValidItem({ channel: 'x', title: 'x-2' }),
      ],
    });
    const filtered = filterByChannels(plan, ['x']);
    expect(filtered.items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Dedupe contract — validated at the orchestration layer.
// ---------------------------------------------------------------------------

/**
 * Caller-side dedupe: drop items whose title (case-insensitive) matches
 * anything already in `completedLastWeek` or `currentLaunchTasks`.
 */
function dedupeByCompleted(
  plan: TacticalPlan,
  completedTitles: readonly string[],
): TacticalPlan {
  const done = new Set(completedTitles.map((t) => t.toLowerCase()));
  return {
    plan: plan.plan,
    items: plan.items.filter((i) => !done.has(i.title.toLowerCase())),
  };
}

describe('dedupe contract', () => {
  it('drops items whose title appears in completedLastWeek (case-insensitive)', () => {
    const plan = makeValidPlan({
      items: [
        makeValidItem({ title: 'Data post about reply-guy engine' }),
        makeValidItem({
          scheduledAt: '2026-04-23T14:00:00Z',
          title: 'STORY POST: THE 40 MINUTE TWEET THAT STARTED SHIPFLARE',
        }),
        makeValidItem({
          scheduledAt: '2026-04-24T13:00:00Z',
          title: 'Week 1 baseline analytics',
        }),
      ],
    });
    const completed = [
      'Story post: the 40 minute tweet that started ShipFlare',
    ];
    const deduped = dedupeByCompleted(plan, completed);
    expect(deduped.items).toHaveLength(2);
    expect(
      deduped.items.every(
        (i) => i.title.toLowerCase() !== completed[0].toLowerCase(),
      ),
    ).toBe(true);
  });

  it('leaves the plan untouched when nothing completed matches', () => {
    const plan = makeValidPlan();
    const deduped = dedupeByCompleted(plan, ['unrelated task']);
    expect(deduped.items).toHaveLength(plan.items.length);
  });
});
