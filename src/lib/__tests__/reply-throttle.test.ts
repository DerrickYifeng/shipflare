import { describe, it, expect, beforeEach, vi } from 'vitest';
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

import { hasRecentReplyToAuthor, listRecentEngagedAuthors } from '../reply-throttle';
import { drafts, threads } from '@/lib/db/schema';

const USER = 'u_test';
const NOW = new Date('2026-05-05T12:00:00Z');

function seed(store: InMemoryStore, threadAuthor: string, draftStatus: string, draftCreatedDaysAgo: number) {
  const threadId = `t_${threadAuthor}_${draftCreatedDaysAgo}`;
  store.tables.set(threads, [
    {
      id: threadId,
      userId: USER,
      externalId: 'ext_' + threadId,
      platform: 'x',
      community: 'topic',
      title: 't',
      url: 'https://x.com/' + threadAuthor,
      body: null,
      author: threadAuthor,
      authorBio: null,
      authorFollowers: null,
      upvotes: null,
      commentCount: null,
      scoutConfidence: null,
      postedAt: null,
      discoveredAt: NOW,
      canMentionProduct: null,
      mentionSignal: null,
    },
  ] as never);
  const created = new Date(NOW.getTime() - draftCreatedDaysAgo * 86_400_000);
  store.tables.set(drafts, [
    {
      id: 'd_' + threadId,
      userId: USER,
      threadId,
      status: draftStatus,
      draftType: 'reply',
      replyBody: 'hi',
      confidenceScore: 0.5,
      whyItWorks: null,
      ftcDisclosure: null,
      reviewVerdict: null,
      reviewScore: null,
      reviewJson: null,
      engagementDepth: 0,
      planItemId: null,
      media: [],
      postTitle: null,
      createdAt: created,
      updatedAt: created,
    },
  ] as never);
}

describe('hasRecentReplyToAuthor', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('returns false when no draft exists for the author', async () => {
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns true when a posted draft exists within the window', async () => {
    seed(store, 'alice', 'posted', 2);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(true);
  });

  it('returns true when only a pending draft exists within the window', async () => {
    seed(store, 'alice', 'pending', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(true);
  });

  it('returns false when the only draft is older than the window', async () => {
    seed(store, 'alice', 'posted', 30);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns false when the only draft is in a non-blocking status (skipped, failed, flagged)', async () => {
    seed(store, 'alice', 'skipped', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('scopes by userId — does not leak across founders', async () => {
    seed(store, 'alice', 'posted', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: 'other_user', platform: 'x', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('scopes by platform — reddit drafts do not block X candidates', async () => {
    seed(store, 'alice', 'posted', 1);
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'reddit', author: 'alice', withinDays: 7,
    });
    expect(got).toBe(false);
  });

  it('returns false when author is null', async () => {
    const got = await hasRecentReplyToAuthor(store.db, {
      userId: USER, platform: 'x', author: null, withinDays: 7,
    });
    expect(got).toBe(false);
  });
});

describe('listRecentEngagedAuthors', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = createInMemoryStore();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it('returns distinct authors engaged within the window', async () => {
    const recent = new Date(NOW.getTime() - 1 * 86_400_000);
    const middle = new Date(NOW.getTime() - 3 * 86_400_000);
    store.tables.set(threads, [
      { id: 't1', userId: USER, externalId: 'e1', platform: 'x', author: 'alice', community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
      { id: 't2', userId: USER, externalId: 'e2', platform: 'x', author: 'bob',   community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
      { id: 't3', userId: USER, externalId: 'e3', platform: 'x', author: 'alice', community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null, upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null, discoveredAt: NOW, canMentionProduct: null, mentionSignal: null },
    ] as never);
    store.tables.set(drafts, [
      { id: 'd1', userId: USER, threadId: 't1', status: 'posted', draftType: 'reply', replyBody: 'a', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: middle, updatedAt: middle },
      { id: 'd2', userId: USER, threadId: 't2', status: 'pending', draftType: 'reply', replyBody: 'b', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: recent, updatedAt: recent },
      { id: 'd3', userId: USER, threadId: 't3', status: 'posted', draftType: 'reply', replyBody: 'c', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null, reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0, planItemId: null, media: [], postTitle: null, createdAt: recent, updatedAt: recent },
    ] as never);

    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER, platform: 'x', withinDays: 7, limit: 50,
    });
    expect(new Set(got)).toEqual(new Set(['alice', 'bob']));
  });

  it('respects the limit argument', async () => {
    const tRows = ['a','b','c','d','e'].map((name, i) => ({
      id: `t${i}`, userId: USER, externalId: `e${i}`, platform: 'x', author: name,
      community: '', title: '', url: '', body: null, authorBio: null, authorFollowers: null,
      upvotes: null, commentCount: null, scoutConfidence: null, postedAt: null,
      discoveredAt: NOW, canMentionProduct: null, mentionSignal: null,
    }));
    const dRows = tRows.map((t, i) => ({
      id: `d${i}`, userId: USER, threadId: t.id, status: 'posted', draftType: 'reply',
      replyBody: 'x', confidenceScore: 0.5, whyItWorks: null, ftcDisclosure: null,
      reviewVerdict: null, reviewScore: null, reviewJson: null, engagementDepth: 0,
      planItemId: null, media: [], postTitle: null, createdAt: NOW, updatedAt: NOW,
    }));
    store.tables.set(threads, tRows as never);
    store.tables.set(drafts, dRows as never);

    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER, platform: 'x', withinDays: 7, limit: 2,
    });
    expect(got.length).toBe(2);
  });

  it('returns [] when withinDays is 0', async () => {
    const got = await listRecentEngagedAuthors(store.db, {
      userId: USER, platform: 'x', withinDays: 0, limit: 50,
    });
    expect(got).toEqual([]);
  });
});
