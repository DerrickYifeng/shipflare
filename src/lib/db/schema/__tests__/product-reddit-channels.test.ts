/**
 * product_reddit_channels schema — column constraints, defaults, indexes,
 * and FK cascade declarations.
 *
 * This file follows the same pattern as `channels-nullable.test.ts`: it
 * asserts on the Drizzle column / index / FK metadata directly rather
 * than round-tripping through Postgres. Vitest in this repo runs against
 * `isolatedModules` and the project's existing schema test suite is
 * metadata-only — there is no shared `getTestDb` for vitest. A future
 * migration that changes a constraint (drops a notNull, flips a default,
 * removes the UNIQUE index, or relaxes the FK cascade) flips the
 * relevant assertion red.
 *
 * Type check: the inserted-row objects below double as compile-time
 * guards. If the inferred `$inferInsert` shape changes incompatibly
 * (e.g. `subreddit` becomes nullable or `activity`'s payload changes),
 * `pnpm tsc --noEmit` rejects this file.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { productRedditChannels } from '@/lib/db/schema';

describe('product_reddit_channels schema', () => {
  it('requires productId, userId, and subreddit', () => {
    expect(productRedditChannels.productId.notNull).toBe(true);
    expect(productRedditChannels.userId.notNull).toBe(true);
    expect(productRedditChannels.subreddit.notNull).toBe(true);
  });

  it('declares optional research metadata columns as nullable', () => {
    expect(productRedditChannels.memberCount.notNull).toBe(false);
    expect(productRedditChannels.fitScore.notNull).toBe(false);
    expect(productRedditChannels.rulesSummary.notNull).toBe(false);
    expect(productRedditChannels.activity.notNull).toBe(false);
    expect(productRedditChannels.lastUsedAt.notNull).toBe(false);
  });

  it('defaults rank, source, and disabled', () => {
    expect(productRedditChannels.rank.default).toBe(99);
    expect(productRedditChannels.source.default).toBe('auto');
    expect(productRedditChannels.disabled.default).toBe(false);
    expect(productRedditChannels.rank.notNull).toBe(true);
    expect(productRedditChannels.source.notNull).toBe(true);
    expect(productRedditChannels.disabled.notNull).toBe(true);
  });

  it('declares CASCADE delete on product_id and user_id', () => {
    const config = getTableConfig(productRedditChannels);
    const productFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'product_id'),
    );
    const userFk = config.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'user_id'),
    );
    expect(productFk).toBeDefined();
    expect(userFk).toBeDefined();
    expect(productFk?.onDelete).toBe('cascade');
    expect(userFk?.onDelete).toBe('cascade');
  });

  it('declares UNIQUE (product_id, subreddit) + composite active index', () => {
    const config = getTableConfig(productRedditChannels);
    const uq = config.indexes.find(
      (i) => i.config.name === 'product_reddit_channels_product_subreddit_uq',
    );
    expect(uq).toBeDefined();
    expect(uq?.config.unique).toBe(true);
    expect(uq?.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'product_id',
      'subreddit',
    ]);

    const active = config.indexes.find(
      (i) => i.config.name === 'product_reddit_channels_product_active_idx',
    );
    expect(active).toBeDefined();
    expect(active?.config.unique).toBeFalsy();
    expect(
      active?.config.columns.map((c) => (c as { name: string }).name),
    ).toEqual(['product_id', 'disabled', 'rank']);
  });

  it('accepts a full auto-discovered insert payload', () => {
    // Compile-time guard: this object must satisfy `$inferInsert`.
    const autoRow: typeof productRedditChannels.$inferInsert = {
      productId: 'p1',
      userId: 'u1',
      subreddit: 'SaaS',
      memberCount: 250_000,
      fitScore: 0.91,
      rulesSummary: 'No self-promo on weekdays.',
      activity: { postsLast7d: 120, commentsLast7d: 800, medianUpvotes: 18 },
      rank: 1,
      source: 'auto',
    };
    expect(autoRow.subreddit).toBe('SaaS');
    expect(autoRow.activity?.postsLast7d).toBe(120);
  });

  it('accepts a minimal manual insert with optional fields null', () => {
    // Compile-time guard: the minimum required shape.
    const manualRow: typeof productRedditChannels.$inferInsert = {
      productId: 'p1',
      userId: 'u1',
      subreddit: 'indiehackers',
      source: 'manual',
      memberCount: null,
      fitScore: null,
      activity: null,
      lastUsedAt: null,
    };
    expect(manualRow.memberCount).toBeNull();
    expect(manualRow.fitScore).toBeNull();
    expect(manualRow.activity).toBeNull();
    expect(manualRow.lastUsedAt).toBeNull();
  });
});
