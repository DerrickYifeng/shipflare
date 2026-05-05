import { describe, it, expect, vi } from 'vitest';

const loadEntryMock = vi.hoisted(() => vi.fn());
vi.mock('@/memory/store', () => ({
  MemoryStore: class {
    loadEntry = loadEntryMock;
  },
}));

import { readMemoryTool } from '../ReadMemoryTool';

const fakeCtx = () =>
  ({
    abortSignal: new AbortController().signal,
    get: <V>(key: string) => {
      if (key === 'userId') return 'user-1' as unknown as V;
      if (key === 'productId') return 'prod-1' as unknown as V;
      throw new Error(`missing key ${key}`);
    },
  }) as unknown as Parameters<typeof readMemoryTool.execute>[1];

describe('read_memory tool', () => {
  it('returns found=true with content when the entry exists', async () => {
    loadEntryMock.mockResolvedValueOnce({
      id: 'mem-1',
      productId: 'prod-1',
      name: 'discovery-rubric',
      description: 'ICP rubric',
      type: 'reference',
      content: '## Ideal customer\n...\n',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const out = await readMemoryTool.execute(
      { name: 'discovery-rubric' },
      fakeCtx(),
    );
    expect(out).toEqual({
      found: true,
      name: 'discovery-rubric',
      description: 'ICP rubric',
      type: 'reference',
      content: '## Ideal customer\n...\n',
    });
  });

  it('returns found=false with empty fields when the entry is missing', async () => {
    loadEntryMock.mockResolvedValueOnce(null);
    const out = await readMemoryTool.execute(
      { name: 'no-such-entry' },
      fakeCtx(),
    );
    expect(out).toEqual({
      found: false,
      name: 'no-such-entry',
      description: '',
      type: '',
      content: '',
    });
  });

  it('rejects empty name at the schema boundary', () => {
    expect(() => readMemoryTool.inputSchema.parse({ name: '' })).toThrow();
  });
});
