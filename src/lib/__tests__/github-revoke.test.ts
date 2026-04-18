import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

beforeAll(() => {
  process.env.GITHUB_ID = 'test-client-id';
  process.env.GITHUB_SECRET = 'test-client-secret';
});

// Import after env is set.
const { revokeGitHubGrant } = await import('../github');

describe('revokeGitHubGrant', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the correct endpoint with HTTP Basic auth and the access_token in the body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ok = await revokeGitHubGrant('gho_abc');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/applications/test-client-id/grant');
    expect(init.method).toBe('DELETE');
    const expectedBasic =
      'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedBasic);
    expect(JSON.parse(init.body as string)).toEqual({ access_token: 'gho_abc' });
  });

  it('treats 404 (already revoked) and 422 (invalid token) as success', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await revokeGitHubGrant('t1')).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 422 }));
    expect(await revokeGitHubGrant('t2')).toBe(true);
  });

  it('returns false on unexpected non-success status (does not throw)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect(await revokeGitHubGrant('t')).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await revokeGitHubGrant('t')).toBe(false);
  });

  it('returns false and does not call fetch when GITHUB_ID is missing', async () => {
    const original = process.env.GITHUB_ID;
    delete process.env.GITHUB_ID;
    try {
      const ok = await revokeGitHubGrant('t');
      expect(ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.GITHUB_ID = original;
    }
  });
});
