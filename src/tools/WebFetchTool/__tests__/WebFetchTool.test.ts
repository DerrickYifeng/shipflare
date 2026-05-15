import { describe, it, expect, vi, beforeEach } from 'vitest';

const scrapeWebsiteMock = vi.fn();
vi.mock('@/services/web-scraper', () => ({
  scrapeWebsite: (url: string) => scrapeWebsiteMock(url),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

beforeEach(() => {
  scrapeWebsiteMock.mockReset();
});

describe('web_fetch', () => {
  it('returns markdown for a successful fetch', async () => {
    scrapeWebsiteMock.mockResolvedValueOnce({
      url: 'https://example.com',
      pageMarkdown: '# Hello',
      title: 'Example',
      description: 'desc',
      ogImage: null,
      status: 'success',
    });
    const { webFetchTool } = await import('../WebFetchTool');
    const result = await webFetchTool.execute({ url: 'https://example.com' }, {} as never);
    expect(result).toMatchObject({
      url: 'https://example.com',
      status: 'success',
      pageMarkdown: '# Hello',
      title: 'Example',
      description: 'desc',
      ogImage: null,
      bytes: '# Hello'.length,
    });
    expect(result.code).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces redirect with redirectUrl', async () => {
    scrapeWebsiteMock.mockResolvedValueOnce({
      url: 'https://old.example.com',
      pageMarkdown: '',
      title: '',
      description: '',
      ogImage: null,
      status: 'redirect',
      redirectUrl: 'https://new.example.com',
      error: 'Redirects to https://new.example.com',
    });
    const { webFetchTool } = await import('../WebFetchTool');
    const result = await webFetchTool.execute({ url: 'https://old.example.com' }, {} as never);
    expect(result.status).toBe('redirect');
    expect(result.redirectUrl).toBe('https://new.example.com');
    expect(result.code).toBe(301);
  });

  it('maps not_found to status=not_found code=404', async () => {
    scrapeWebsiteMock.mockResolvedValueOnce({
      url: 'https://example.com/missing',
      pageMarkdown: '',
      title: '',
      description: '',
      ogImage: null,
      status: 'not_found',
      error: 'Page not found (404)',
    });
    const { webFetchTool } = await import('../WebFetchTool');
    const result = await webFetchTool.execute({ url: 'https://example.com/missing' }, {} as never);
    expect(result.status).toBe('not_found');
    expect(result.code).toBe(404);
    expect(result.error).toBe('Page not found (404)');
  });

  it('rejects an invalid URL via input schema', async () => {
    const { webFetchInputSchema } = await import('../WebFetchTool');
    const parse = webFetchInputSchema.safeParse({ url: 'not-a-url' });
    expect(parse.success).toBe(false);
  });
});
