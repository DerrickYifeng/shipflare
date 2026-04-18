import { describe, expect, it } from 'vitest';
import { runContentValidators } from '../pipeline';

describe('runContentValidators', () => {
  it('passes a clean X reply', () => {
    const r = runContentValidators({
      text: 'shipping is the only validation.',
      platform: 'x',
      kind: 'reply',
    });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('aggregates all three failure types without short-circuiting', () => {
    // Over 240 chars, mentions reddit with no contrast, contains an unsourced stat.
    const text =
      'saw this on reddit: conversion up 40% last month. ' + 'a'.repeat(210);
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
      text: 'a'.repeat(241),
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
});
