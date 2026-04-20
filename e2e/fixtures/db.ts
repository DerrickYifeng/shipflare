import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/db/schema';
import {
  makeThread,
  makeDraft,
  makeHealthScore,
  makeActivityEvent,
  makeChannel,
  makeProduct,
} from './seed-data';

// Ensure .env.local is loaded so we share the same DB as the dev server.
// playwright.config.ts also loads it, but fixtures may initialize before config.
config({ path: '.env.local' });

const connectionString = process.env.DATABASE_URL!;

const client = postgres(connectionString, { prepare: false, ssl: 'require' });
const db = drizzle(client, { schema });

export function getTestDb() {
  return db;
}

export async function seedUser(
  overrides: Partial<{ id: string; name: string; email: string }> = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const name = overrides.name ?? 'Test User';
  const email = overrides.email ?? `test-${id.slice(0, 8)}@shipflare.dev`;

  await db.insert(schema.users).values({ id, name, email });

  return { id, name, email };
}

export async function seedSession(userId: string) {
  const sessionToken = crypto.randomUUID();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await db.insert(schema.sessions).values({ sessionToken, userId, expires });

  return sessionToken;
}

export async function seedProduct(
  userId: string,
  overrides: Partial<{
    url: string;
    name: string;
    description: string;
    keywords: string[];
    valueProp: string;
  }> = {},
) {
  const values = makeProduct(userId, overrides);
  await db.insert(schema.products).values(values);
  return values;
}

export async function seedThreads(userId: string, count: number) {
  const items = Array.from({ length: count }, (_, i) =>
    makeThread(userId, i),
  );
  await db.insert(schema.threads).values(items);
  return items;
}

export async function seedDrafts(
  userId: string,
  threadIds: string[],
) {
  const items = threadIds.map((threadId, i) =>
    makeDraft(userId, threadId, i),
  );
  await db.insert(schema.drafts).values(items);
  return items;
}

export async function seedHealthScore(userId: string, score: number) {
  const values = makeHealthScore(userId, score);
  await db.insert(schema.healthScores).values(values);
  return values;
}

export async function seedActivityEvents(userId: string, count: number) {
  const items = Array.from({ length: count }, (_, i) =>
    makeActivityEvent(userId, i),
  );
  await db.insert(schema.activityEvents).values(items);
  return items;
}

export async function seedChannel(
  userId: string,
  overrides: Partial<{ username: string }> = {},
) {
  const values = makeChannel(userId, overrides);
  await db.insert(schema.channels).values(values);
  return values;
}

/**
 * Phase 2 migration: `todo_items` was dropped and the Today page stub always
 * renders `isFirstRun=true` until plan_items replaces it in Phase 13. This
 * helper stays in the fixture surface so E2E tests that reference it keep
 * compiling, but it is now a no-op that returns a placeholder row.
 */
export async function seedTodoItem(
  userId: string,
  overrides: Partial<{
    status: 'pending' | 'approved' | 'skipped' | 'expired';
    expiresAt: Date;
    todoType: 'approve_post' | 'reply_thread' | 'respond_engagement';
    source: 'calendar' | 'discovery' | 'engagement';
    priority: 'time_sensitive' | 'scheduled' | 'optional';
    platform: string;
  }> = {},
) {
  return {
    id: crypto.randomUUID(),
    userId,
    todoType: overrides.todoType ?? 'approve_post',
    source: overrides.source ?? 'calendar',
    priority: overrides.priority ?? 'optional',
    status: overrides.status ?? 'expired',
    title: 'Test seed (no-op during v2 migration)',
    platform: overrides.platform ?? 'reddit',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() - 60_000),
  };
}

export async function cleanupUser(userId: string) {
  // Cascade delete handles everything
  await db.delete(schema.users).where(eq(schema.users.id, userId));
}
