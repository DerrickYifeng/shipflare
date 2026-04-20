import { describe, it, expect } from 'vitest';
import {
  dispatchPlanItem,
  DISPATCH_TABLE_SNAPSHOT,
} from '../plan-execute-dispatch';

describe('dispatchPlanItem — happy paths', () => {
  it('routes content_post + x to draft-single-post / posting / approve', () => {
    const route = dispatchPlanItem({ kind: 'content_post', channel: 'x' });
    expect(route).not.toBeNull();
    expect(route!.draftSkill).toBe('draft-single-post');
    expect(route!.executeSkill).toBe('posting');
    expect(route!.defaultUserAction).toBe('approve');
  });

  it('routes content_reply + x to draft-single-reply / posting / approve', () => {
    const route = dispatchPlanItem({ kind: 'content_reply', channel: 'x' });
    expect(route!.draftSkill).toBe('draft-single-reply');
    expect(route!.executeSkill).toBe('posting');
  });

  it('routes email_send to draft-email / send-email / approve (channel null)', () => {
    const route = dispatchPlanItem({ kind: 'email_send' });
    expect(route!.draftSkill).toBe('draft-email');
    expect(route!.executeSkill).toBe('send-email');
    expect(route!.defaultUserAction).toBe('approve');
  });

  it('routes interview to manual no-skill', () => {
    const route = dispatchPlanItem({ kind: 'interview' });
    expect(route!.draftSkill).toBeNull();
    expect(route!.executeSkill).toBeNull();
    expect(route!.defaultUserAction).toBe('manual');
  });

  it('routes metrics_compute to analytics-summarize execute / auto', () => {
    const route = dispatchPlanItem({ kind: 'metrics_compute' });
    expect(route!.executeSkill).toBe('analytics-summarize');
    expect(route!.defaultUserAction).toBe('auto');
  });
});

describe('dispatchPlanItem — reddit not wired yet', () => {
  it('falls back to the channel=null row for content_post + reddit (no draft skill)', () => {
    // Currently no reddit entry for content_post; fallback is the
    // channel=null row, but there isn't one for content_post either.
    // So the dispatcher returns null, signaling "unwired".
    const route = dispatchPlanItem({
      kind: 'content_post',
      channel: 'reddit',
    });
    expect(route).toBeNull();
  });

  it('falls back cleanly for content_reply + reddit', () => {
    const route = dispatchPlanItem({
      kind: 'content_reply',
      channel: 'reddit',
    });
    expect(route).toBeNull();
  });
});

describe('dispatchPlanItem — skillName override', () => {
  it('uses plan_items.skillName for a setup_task that advertises one', () => {
    const route = dispatchPlanItem({
      kind: 'setup_task',
      skillName: 'voice-extractor',
    });
    expect(route!.draftSkill).toBe('voice-extractor');
    // Default userAction stays 'manual' from the route.
    expect(route!.defaultUserAction).toBe('manual');
  });

  it('uses plan_items.skillName for a launch_asset row', () => {
    const route = dispatchPlanItem({
      kind: 'launch_asset',
      skillName: 'draft-waitlist-page',
    });
    expect(route!.draftSkill).toBe('draft-waitlist-page');
    expect(route!.executeSkill).toBeNull();
  });

  it('does NOT override executeSkill for content_post (posting is terminal)', () => {
    const route = dispatchPlanItem({
      kind: 'content_post',
      channel: 'x',
      skillName: 'some-other-draft',
    });
    // draftSkill from the route wins because it's already set — the
    // override only fills a null default, it doesn't replace an
    // existing value.
    expect(route!.draftSkill).toBe('draft-single-post');
    // Execute stays fixed.
    expect(route!.executeSkill).toBe('posting');
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
  it('includes routes for every plan_item kind in the enum', () => {
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

  it('content_post has only the x route (reddit not wired for Phase 7)', () => {
    const postRoutes = DISPATCH_TABLE_SNAPSHOT.filter(
      (r) => r.kind === 'content_post',
    );
    expect(postRoutes).toHaveLength(1);
    expect(postRoutes[0].channel).toBe('x');
  });
});
