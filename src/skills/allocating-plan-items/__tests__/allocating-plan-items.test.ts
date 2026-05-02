// Schema + loader smoke tests for the allocating-plan-items fork-mode
// skill. The skill receives the strategic_path + this week's signals
// (stalled items, last-week completions, recent milestones, X timeline
// snapshots) and emits a JSON array of plan_item rows for the next 7
// days. Pure transformation — no DB, no writes.

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { loadSkill } from '@/tools/SkillTool/loadSkillsDir';
import {
  allocatingPlanItemsInputSchema,
  allocatingPlanItemsOutputSchema,
} from '../schema';

const SKILL_DIR = path.resolve(__dirname, '..');

describe('allocating-plan-items schema', () => {
  it('accepts a valid input shape', () => {
    expect(() =>
      allocatingPlanItemsInputSchema.parse({
        strategicPath: {
          thesis: 't',
          phase: 'foundation',
          contentPillars: ['lesson', 'milestone'],
          channelMix: { x: { perWeek: 3 }, reddit: { perWeek: 1 } },
        },
        signals: {
          stalledItems: [],
          lastWeekCompletions: [],
          recentMilestones: [],
        },
        connectedChannels: ['x', 'reddit'],
        targetWeekStart: '2026-05-04',
      }),
    ).not.toThrow();
  });

  it('accepts the full input shape with optional fields', () => {
    const parsed = allocatingPlanItemsInputSchema.parse({
      strategicPath: {
        thesis: 'ship faster, tell better stories',
        phase: 'audience',
        contentPillars: ['speed', 'reliability', 'ux'],
        channelMix: {
          x: { perWeek: 3, repliesPerDay: 5, preferredHours: [13, 15] },
          email: { perWeek: 1 },
        },
        thesisArc: [
          {
            weekStart: '2026-05-04',
            theme: 'first paying customer',
            angleMix: ['claim', 'story'],
          },
        ],
      },
      signals: {
        stalledItems: [{ id: 'plan_1', title: 'shipped feature' }],
        lastWeekCompletions: [{ id: 'plan_2', title: 'old post' }],
        recentMilestones: [{ title: 'launched v1', source: 'release' }],
        recentXPosts: [{ body: 'shipped pricing today', metrics: { likes: 12 } }],
      },
      connectedChannels: ['x', 'email'],
      targetWeekStart: '2026-05-04',
      now: '2026-05-04T08:00:00Z',
    });
    expect(parsed.signals.stalledItems).toHaveLength(1);
    expect(parsed.connectedChannels).toEqual(['x', 'email']);
  });

  it('rejects an input missing required fields', () => {
    expect(() =>
      allocatingPlanItemsInputSchema.parse({
        signals: { stalledItems: [], lastWeekCompletions: [], recentMilestones: [] },
        connectedChannels: ['x'],
        targetWeekStart: '2026-05-04',
      }),
    ).toThrow();
  });

  it('output is an array of plan_items rows', () => {
    const parsed = allocatingPlanItemsOutputSchema.parse({
      planItems: [
        {
          kind: 'content_post',
          channel: 'x',
          phase: 'foundation',
          userAction: 'approve',
          title: 'Day 1: shipping the pricing page',
          description: 'Anchor post for the week.',
          scheduledAt: '2026-05-04T13:00:00Z',
          params: { pillar: 'milestone' },
          skillName: null,
        },
      ],
      stalledCarriedOver: [],
      notes: '',
    });
    expect(parsed.planItems).toHaveLength(1);
    expect(parsed.stalledCarriedOver).toEqual([]);
  });

  it('rejects an output with an unknown kind', () => {
    expect(() =>
      allocatingPlanItemsOutputSchema.parse({
        planItems: [
          {
            kind: 'rumination',
            channel: 'x',
            phase: 'foundation',
            userAction: 'approve',
            title: 'oops',
            scheduledAt: '2026-05-04T13:00:00Z',
            params: {},
            skillName: null,
          },
        ],
        stalledCarriedOver: [],
        notes: '',
      }),
    ).toThrow();
  });

  it('accepts stalledCarriedOver entries describing reschedules', () => {
    const parsed = allocatingPlanItemsOutputSchema.parse({
      planItems: [],
      stalledCarriedOver: [
        { planItemId: 'pi_abc', newScheduledAt: '2026-05-05T13:00:00Z' },
      ],
      notes: 'Carried over one stalled X post from last week.',
    });
    expect(parsed.stalledCarriedOver).toHaveLength(1);
  });
});

describe('allocating-plan-items skill loader', () => {
  it('loads from disk with correct frontmatter', async () => {
    const skill = await loadSkill(SKILL_DIR);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('allocating-plan-items');
    expect(skill!.context).toBe('fork');
  });

  it('produces a body referencing allocation-rules', async () => {
    const skill = await loadSkill(SKILL_DIR);
    const fakeCtx = {
      abortSignal: new AbortController().signal,
      get: () => null,
    } as never;
    const body = await skill!.getPromptForCommand(
      JSON.stringify({}),
      fakeCtx,
    );
    expect(body).toContain('allocation-rules');
  });
});
