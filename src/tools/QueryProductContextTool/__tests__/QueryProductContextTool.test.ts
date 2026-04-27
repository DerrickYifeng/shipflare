/**
 * query_product_context unit tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolContext } from '@/core/types';
import {
  createInMemoryStore,
  drizzleMockFactory,
  type InMemoryStore,
} from '@/lib/test-utils/in-memory-db';

vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return drizzleMockFactory(actual as unknown as Record<string, unknown>);
});

vi.mock('@/lib/db', () => ({ db: createInMemoryStore().db }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { queryProductContextTool } from '../QueryProductContextTool';
import { products } from '@/lib/db/schema';

interface ProductRow {
  id: string;
  userId: string;
  name: string;
  description: string;
  valueProp: string | null;
}

function makeCtx(
  store: InMemoryStore,
  deps: Record<string, unknown>,
): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    get<V>(key: string): V {
      if (key in deps) return deps[key] as V;
      if (key === 'db') return store.db as unknown as V;
      throw new Error(`no dep ${key}`);
    },
  };
}

let store: InMemoryStore;
beforeEach(() => {
  store = createInMemoryStore();
});

describe('queryProductContextTool', () => {
  it('returns the product brief for the current (userId, productId)', async () => {
    store.register<ProductRow>(products, [
      {
        id: 'prod-1',
        userId: 'user-1',
        name: 'ShipFlare',
        description: 'Marketing pipeline for indie founders',
        valueProp: 'Turn changelog into X posts',
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });

    const result = await queryProductContextTool.execute({}, ctx);
    expect(result).toEqual({
      name: 'ShipFlare',
      description: 'Marketing pipeline for indie founders',
      valueProp: 'Turn changelog into X posts',
    });
  });

  it('returns null when the product row is missing', async () => {
    store.register<ProductRow>(products, []);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryProductContextTool.execute({}, ctx);
    expect(result).toBeNull();
  });

  it('does NOT return another user\'s product (ownership scoping)', async () => {
    store.register<ProductRow>(products, [
      {
        id: 'prod-1',
        userId: 'user-other',
        name: 'OtherProduct',
        description: 'Not yours',
        valueProp: null,
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryProductContextTool.execute({}, ctx);
    expect(result).toBeNull();
  });

  it('returns null valueProp when the column is null', async () => {
    store.register<ProductRow>(products, [
      {
        id: 'prod-1',
        userId: 'user-1',
        name: 'ShipFlare',
        description: 'Marketing pipeline',
        valueProp: null,
      },
    ]);
    const ctx = makeCtx(store, { userId: 'user-1', productId: 'prod-1' });
    const result = await queryProductContextTool.execute({}, ctx);
    expect(result?.valueProp).toBeNull();
  });

  it('rejects unexpected input keys via strict schema', () => {
    const parse = queryProductContextTool.inputSchema.safeParse({ foo: 'bar' });
    expect(parse.success).toBe(false);
  });
});
