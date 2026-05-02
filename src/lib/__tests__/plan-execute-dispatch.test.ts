import { describe, it, expect } from 'vitest';
import {
  dispatchPlanItem,
  DISPATCH_TABLE_SNAPSHOT,
} from '../plan-execute-dispatch';

describe('dispatchPlanItem — happy paths', () => {
  it('routes content_post + x to null draft / posting execute / approve', () => {
    // The writer branch in plan-execute owns the DRAFT phase for content_post
    // (spawns post-writer via team-run; the writer reads `plan_items.channel`
    // to pick the right platform guide). The dispatch table's draftSkill for
    // content_post is intentionally null; only the execute path (posting) is
    // still consulted here.
    const route = dispatchPlanItem({ kind: 'content_post', channel: 'x' });
    expect(route).not.toBeNull();
    expect(route!.draftSkill).toBeNull();
    expect(route!.executeSkill).toBe('posting');
    expect(route!.defaultUserAction).toBe('approve');
  });

  it('routes content_reply + x to null draft / posting execute / approve', () => {
    // Phase 6 (agent-cleanup) deleted the draft-single-reply skill —
    // content-manager owns reply drafting end-to-end via the discovery
    // → content-manager Task fan-out. The dispatch route still
    // resolves so the state machine keeps flowing; only the execute
    // path (posting) is consulted from here.
    const route = dispatchPlanItem({ kind: 'content_reply', channel: 'x' });
    expect(route!.draftSkill).toBeNull();
    expect(route!.executeSkill).toBe('posting');
    expect(route!.defaultUserAction).toBe('approve');
  });

  it('routes email_send to manual-completion shell (skills deleted in Phase E)', () => {
    const route = dispatchPlanItem({ kind: 'email_send' });
    expect(route!.draftSkill).toBeNull();
    expect(route!.executeSkill).toBeNull();
    expect(route!.defaultUserAction).toBe('manual');
  });

  it('routes interview to manual no-skill', () => {
    const route = dispatchPlanItem({ kind: 'interview' });
    expect(route!.draftSkill).toBeNull();
    expect(route!.executeSkill).toBeNull();
    expect(route!.defaultUserAction).toBe('manual');
  });

  it('routes metrics_compute and analytics_summary to auto-completion shells', () => {
    // Phase E Day 3: analytics-summarize skill deleted; both kinds fall
    // through the state machine until a replacement lands.
    const compute = dispatchPlanItem({ kind: 'metrics_compute' });
    expect(compute!.draftSkill).toBeNull();
    expect(compute!.executeSkill).toBeNull();
    expect(compute!.defaultUserAction).toBe('auto');

    const summary = dispatchPlanItem({ kind: 'analytics_summary' });
    expect(summary!.draftSkill).toBeNull();
    expect(summary!.executeSkill).toBeNull();
    expect(summary!.defaultUserAction).toBe('auto');
  });
});

describe('dispatchPlanItem — reddit not wired yet', () => {
  it('returns null for content_post + reddit (dispatch table only has x; writer branch owns draft)', () => {
    const route = dispatchPlanItem({
      kind: 'content_post',
      channel: 'reddit',
    });
    expect(route).toBeNull();
  });

  it('returns null for content_reply + reddit', () => {
    const route = dispatchPlanItem({
      kind: 'content_reply',
      channel: 'reddit',
    });
    expect(route).toBeNull();
  });
});

describe('dispatchPlanItem — skillName override', () => {
  it('uses plan_items.skillName for a launch_asset row', () => {
    const route = dispatchPlanItem({
      kind: 'launch_asset',
      skillName: 'custom-launch-skill',
    });
    expect(route!.draftSkill).toBe('custom-launch-skill');
    expect(route!.executeSkill).toBeNull();
  });
});

describe('dispatchPlanItem — unknown kind', () => {
  it('returns null when no route matches', () => {
    const route = dispatchPlanItem({
      // @ts-expect-error — intentionally passing an unknown kind
      kind: 'alien_kind',
    });
    expect(route).toBeNull();
  });
});

describe('DISPATCH_TABLE_SNAPSHOT', () => {
  it('includes routes for every plan_item kind (draft_post can still fall through for execute)', () => {
    const kinds = new Set(DISPATCH_TABLE_SNAPSHOT.map((r) => r.kind));
    for (const required of [
      'content_post',
      'content_reply',
      'email_send',
      'interview',
      'setup_task',
      'launch_asset',
      'runsheet_beat',
      'metrics_compute',
      'analytics_summary',
    ]) {
      expect(kinds).toContain(required);
    }
  });

  it('content_post has only the x route (reddit execute TBD in Phase F)', () => {
    const postRoutes = DISPATCH_TABLE_SNAPSHOT.filter(
      (r) => r.kind === 'content_post',
    );
    expect(postRoutes).toHaveLength(1);
    expect(postRoutes[0].channel).toBe('x');
  });
});
