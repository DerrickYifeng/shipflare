import { describe, expect, it } from 'vitest';
import { runContentValidators } from '../pipeline';

describe('runContentValidators', () => {
  it('passes a clean X reply', () => {
    const r = runContentValidators({
      text: 'shipped 5 days ago. still tweaking the onboarding.',
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('aggregates all three failure types without short-circuiting', () => {
    // Over 280 chars, mentions reddit with no contrast, contains an unsourced stat.
    const text =
      'saw this on reddit: conversion up 40% last month. ' + 'a'.repeat(260);
    const r = runContentValidators({
      text,
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(false);
    const validators = r.failures.map((f) => f.validator).sort();
    expect(validators).toEqual(['hallucinated_stats', 'length', 'platform_leak']);
  });

  it('only reports length failure when that is the only issue', () => {
    const r = runContentValidators({
      text: 'a'.repeat(281),
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].validator).toBe('length');
  });

  it('allows a post with sourced stats under the cap', () => {
    const r = runContentValidators({
      text: 'retention rose 12% per Mixpanel.',
      platform: 'x',
      kind: 'post',
    });
    expect(r.ok).toBe(true);
  });

  it('allows a sibling mention inside a contrast sentence', () => {
    const r = runContentValidators({
      text: 'unlike reddit, X is a speed game.',
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(true);
  });

  describe('warnings (severity: warning — do not affect ok)', () => {
    it('flags anchor-token absence on X replies as a warning, not a failure', () => {
      const r = runContentValidators({
        text: 'agreed completely.',
        platform: 'x',
        kind: 'reply',
      });
      expect(r.ok).toBe(true);
      const anchor = r.warnings.find((w) => w.validator === 'anchor_token');
      expect(anchor).toBeDefined();
    });

    it('does not run anchor-token check on posts', () => {
      const r = runContentValidators({
        text: 'just a generic post body without any concrete signal.',
        platform: 'x',
        kind: 'post',
      });
      const anchor = r.warnings.find((w) => w.validator === 'anchor_token');
      expect(anchor).toBeUndefined();
    });

    it('flags too many hashtags on an X post as a warning', () => {
      const r = runContentValidators({
        text: 'shipping #buildinpublic #saas #startup #indiehackers #devs',
        platform: 'x',
        kind: 'post',
      });
      expect(r.ok).toBe(true);
      const tag = r.warnings.find((w) => w.validator === 'hashtag_count');
      expect(tag).toBeDefined();
      if (tag && tag.validator === 'hashtag_count') {
        expect(tag.count).toBeGreaterThan(tag.max);
      }
    });

    it('flags any hashtag on an X reply as a warning', () => {
      const r = runContentValidators({
        text: 'agreed last week #buildinpublic',
        platform: 'x',
        kind: 'reply',
      });
      const tag = r.warnings.find((w) => w.validator === 'hashtag_count');
      expect(tag).toBeDefined();
    });

    it('flags links inside a reply body as a warning', () => {
      const r = runContentValidators({
        text: 'check out https://example.com last week',
        platform: 'x',
        kind: 'reply',
      });
      const link = r.warnings.find((w) => w.validator === 'links_in_reply');
      expect(link).toBeDefined();
    });

    it('flags links inside a post body as a warning (use first-reply)', () => {
      const r = runContentValidators({
        text: 'try our beta at https://example.com',
        platform: 'x',
        kind: 'post',
      });
      const link = r.warnings.find(
        (w) => w.validator === 'links_in_post_body',
      );
      expect(link).toBeDefined();
    });
  });

  describe('thread support', () => {
    it('reports per-segment length failures for an X thread', () => {
      const text = 'short tweet.\n\n' + 'a'.repeat(281);
      const r = runContentValidators({ text, platform: 'x', kind: 'post' });
      expect(r.ok).toBe(false);
      const length = r.failures.find((f) => f.validator === 'length');
      expect(length).toBeDefined();
      if (length && length.validator === 'length') {
        expect(length.isThread).toBe(true);
        expect(length.segmentCount).toBe(2);
        expect(length.segments?.[1].ok).toBe(false);
      }
    });
  });
});
