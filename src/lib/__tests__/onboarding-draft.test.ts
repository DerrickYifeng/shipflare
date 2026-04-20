import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvStore = new Map<string, string>();
const kvMock = {
  get: vi.fn(async (k: string) => kvStore.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => {
    kvStore.set(k, v);
    return 'OK';
  }),
  del: vi.fn(async (k: string) => {
    kvStore.delete(k);
    return 1;
  }),
};

vi.mock('@/lib/redis', () => ({
  getKeyValueClient: () => kvMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
}));

beforeEach(() => {
  kvStore.clear();
  kvMock.get.mockClear();
  kvMock.set.mockClear();
  kvMock.del.mockClear();
});

describe('onboarding-draft', () => {
  it('getDraft returns null when no draft exists', async () => {
    const { getDraft } = await import('../onboarding-draft');
    const out = await getDraft('u-1');
    expect(out).toBeNull();
  });

  it('putDraft + getDraft round-trip', async () => {
    const { putDraft, getDraft } = await import('../onboarding-draft');
    await putDraft('u-1', { name: 'ShipFlare', state: 'mvp' });
    const out = await getDraft('u-1');
    expect(out?.name).toBe('ShipFlare');
    expect(out?.state).toBe('mvp');
    expect(out?.updatedAt).toBeTruthy();
  });

  it('putDraft merges instead of replacing', async () => {
    const { putDraft, getDraft } = await import('../onboarding-draft');
    await putDraft('u-1', { name: 'ShipFlare', keywords: ['a', 'b'] });
    await putDraft('u-1', { state: 'launching' });
    const out = await getDraft('u-1');
    expect(out?.name).toBe('ShipFlare');
    expect(out?.state).toBe('launching');
    expect(out?.keywords).toEqual(['a', 'b']);
  });

  it('putDraft replaces nested fields wholesale', async () => {
    const { putDraft, getDraft } = await import('../onboarding-draft');
    await putDraft('u-1', {
      previewPath: { v1: 'first' } as unknown,
    });
    await putDraft('u-1', {
      previewPath: { v2: 'second' } as unknown,
    });
    const out = await getDraft('u-1');
    expect(out?.previewPath).toEqual({ v2: 'second' });
  });

  it('deleteDraft clears the key', async () => {
    const { putDraft, deleteDraft, getDraft } = await import('../onboarding-draft');
    await putDraft('u-1', { name: 'ShipFlare' });
    expect(await getDraft('u-1')).not.toBeNull();
    await deleteDraft('u-1');
    expect(await getDraft('u-1')).toBeNull();
  });

  it('scopes drafts per userId', async () => {
    const { putDraft, getDraft } = await import('../onboarding-draft');
    await putDraft('u-1', { name: 'A' });
    await putDraft('u-2', { name: 'B' });
    expect((await getDraft('u-1'))?.name).toBe('A');
    expect((await getDraft('u-2'))?.name).toBe('B');
  });

  it('getDraft swallows parse errors and returns null', async () => {
    const { getDraft } = await import('../onboarding-draft');
    kvStore.set('onboarding:u-3', '{not-json');
    const out = await getDraft('u-3');
    expect(out).toBeNull();
  });

  it('writes with EX and refreshes TTL on each put', async () => {
    const { putDraft } = await import('../onboarding-draft');
    await putDraft('u-1', { name: 'ShipFlare' });
    expect(kvMock.set).toHaveBeenCalledWith(
      'onboarding:u-1',
      expect.any(String),
      'EX',
      60 * 60,
    );
  });
});
