import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildRedditHandoffPageUrl } from '../reddit-handoff-url';

describe('buildRedditHandoffPageUrl', () => {
  const orig = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_BASE_URL = orig;
  });

  afterEach(() => {
    if (orig === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BASE_URL = orig;
    }
  });

  it('returns absolute handoff URL using NEXT_PUBLIC_BASE_URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io';
    const url = buildRedditHandoffPageUrl('draft-abc-123');
    expect(url).toBe('https://shipflare.io/handoff/reddit/draft-abc-123');
  });

  it('falls back to localhost for dev', () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    const url = buildRedditHandoffPageUrl('d-1');
    expect(url).toBe('http://localhost:3000/handoff/reddit/d-1');
  });

  it('strips trailing slash from base URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://shipflare.io/';
    const url = buildRedditHandoffPageUrl('d-1');
    expect(url).toBe('https://shipflare.io/handoff/reddit/d-1');
  });

  it('throws on empty draftId', () => {
    expect(() => buildRedditHandoffPageUrl('')).toThrow(/draftId is required/);
  });
});
