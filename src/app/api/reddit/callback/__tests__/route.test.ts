import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { GET } from '../route';

describe('GET /api/reddit/callback (legacy redirect)', () => {
  it('returns 308 redirect to /onboarding', async () => {
    const req = new Request('http://localhost/api/reddit/callback?code=stale');
    const res = await GET(req);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(
      'http://localhost/onboarding?reconnect=reddit&from=oauth_legacy',
    );
  });

  it('redirects regardless of query params', async () => {
    const req = new Request('http://localhost/api/reddit/callback');
    const res = await GET(req);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toContain(
      '/onboarding?reconnect=reddit&from=oauth_legacy',
    );
  });
});
