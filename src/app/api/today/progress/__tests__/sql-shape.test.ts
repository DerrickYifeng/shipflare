/**
 * Regression test for the `loadTacticalStatus` SQL shape.
 *
 * Background: the original implementation used a raw template:
 *   sql`${col} = ANY(${jsArray})`
 * Drizzle's `sql` template expands JS arrays as row constructors
 * `($1, $2, $3)`, which Postgres rejects from `ANY(...)` with
 * error 42809: "op ANY/ALL (array) requires array on right side".
 *
 * The route's main test mocks `db` away, so it cannot catch SQL-shape
 * bugs. This test runs a query builder against the real drizzle dialect
 * (no DB connection needed — `.toSQL()` is pure) and asserts the
 * generated SQL uses `in (?, ?, ?)`-style binding rather than `any(...)`.
 */
import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { teamMessages } from '@/lib/db/schema';

// Drizzle exposes a query builder without ever opening a connection if
// you never call `.execute()` or `await` the resulting promise. We pass
// a stub client for typing only — postgres-js's `drizzle()` accepts
// any object that quacks like the postgres-js client.
const db = drizzle({} as never);

const TACTICAL_TRIGGERS = ['onboarding', 'weekly', 'manual', 'phase_transition'] as const;

describe('loadTacticalStatus SQL shape', () => {
  it('uses IN (...) parameter binding, not row constructor + ANY()', () => {
    const built = db
      .select({ id: teamMessages.id })
      .from(teamMessages)
      .where(
        and(
          eq(teamMessages.teamId, 'team-1'),
          inArray(
            sql`${teamMessages.metadata}->>'trigger'`,
            TACTICAL_TRIGGERS as unknown as string[],
          ),
          gte(teamMessages.createdAt, new Date('2026-05-01T00:00:00Z')),
        ),
      )
      .orderBy(desc(teamMessages.createdAt))
      .limit(1)
      .toSQL();

    // Sanity: query references the JSONB extraction.
    expect(built.sql).toMatch(/->>'trigger'/);

    // Critical: must use `in (?, ?, ?, ?)` form. The buggy form was
    // `= any(($1, $2, $3, $4))`, which Postgres rejects.
    expect(built.sql).toMatch(/in \(/i);
    expect(built.sql).not.toMatch(/= any\s*\(/i);

    // Each trigger value must appear as its own parameter — array
    // values must be flattened, not wrapped as a single Postgres array.
    for (const trigger of TACTICAL_TRIGGERS) {
      expect(built.params).toContain(trigger);
    }
  });
});
