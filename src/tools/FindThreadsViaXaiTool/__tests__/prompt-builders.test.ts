import { describe, it, expect } from 'vitest';
import {
  buildXFirstTurnMessage,
  buildRedditFirstTurnMessage,
} from '../prompt-builders';

const product = {
  id: 'p1',
  name: 'ShipFlare',
  description: 'AI marketing team for solo founders',
  valueProp: '5-min approval queue',
  targetAudience: 'pre-PMF solo founders',
  keywords: ['founder-led growth', 'reddit marketing'],
};

describe('buildRedditFirstTurnMessage', () => {
  it('contains Reddit-specific shape (subreddit, score, num_comments, external_id)', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      null,
    );
    expect(msg).toContain('subreddit');
    expect(msg).toContain('score');
    expect(msg).toContain('num_comments');
    expect(msg).toContain('external_id');
    expect(msg).toContain('reddit.com');
  });

  it('does NOT contain X-specific fields', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      null,
    );
    expect(msg).not.toContain('likes_count');
    expect(msg).not.toContain('reposts_count');
    expect(msg).not.toContain('quoted_text');
  });

  it('injects excludeSelfHandle when provided', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      'shipflare-founder',
    );
    expect(msg).toContain('u/shipflare-founder');
    expect(msg).toContain('founder running this product');
  });

  it('omits self-handle line when null', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      null,
    );
    expect(msg).not.toContain('founder running this product');
  });

  it('formats excludeAuthors with u/ prefix (not @)', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      ['alice', 'bob'],
      null,
    );
    expect(msg).toContain('u/alice');
    expect(msg).toContain('u/bob');
    expect(msg).not.toContain('@alice');
  });

  it('mentions seed subreddits and skip-launch guidance', () => {
    const msg = buildRedditFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      null,
    );
    expect(msg).toContain('r/SaaS');
    expect(msg).toContain('r/indiehackers');
    expect(msg).toContain('r/Entrepreneur');
    expect(msg).toMatch(/Skip launch \/ self-promo/i);
  });
});

describe('buildXFirstTurnMessage', () => {
  it('preserves existing X behavior (likes_count, reposts_count present)', () => {
    const msg = buildXFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).toContain('likes_count');
    expect(msg).toContain('reposts_count');
  });

  it('formats excludeAuthors with @ prefix', () => {
    const msg = buildXFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      ['alice'],
      null,
    );
    expect(msg).toContain('@alice');
  });

  it('injects excludeSelfHandle for X with @ prefix', () => {
    const msg = buildXFirstTurnMessage(
      product,
      '',
      undefined,
      10,
      [],
      'shipflare',
    );
    expect(msg).toContain('@shipflare');
    expect(msg).toContain('founder running this product');
  });

  it('omits self-handle line when null', () => {
    const msg = buildXFirstTurnMessage(product, '', undefined, 10, [], null);
    expect(msg).not.toContain('founder running this product');
  });
});
