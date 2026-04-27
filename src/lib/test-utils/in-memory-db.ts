// Test-only in-memory Drizzle-like DB for unit-testing domain tools.
//
// The production tools use drizzle-orm query builders against Postgres.
// Rather than spin up a real Postgres per test suite, we:
//
//   1. Intercept `eq` / `and` / `gte` / `lt` / `inArray` / `desc` from
//      drizzle-orm so they emit sentinel objects we can decode.
//   2. Route select / insert / update against in-memory arrays keyed
//      by the schema table object identity.
//
// The resulting `Database` is type-erased by `as unknown as Database`
// because we implement only the narrow subset each tool uses. Coverage
// is asymmetric by design — tests assert on specific row mutations,
// not on the full drizzle API surface.
//
// Callers:
//   const store = createInMemoryStore();
//   store.planItems.push({ ... seed row ... });
//   const deps = { db: store.db, userId: 'u1', productId: 'p1', teamId: 't1' };
//
// Use with `vi.mock('drizzle-orm', ...)` and `vi.mock('@/lib/db', ...)`
// at the top of each test file — see existing SendMessage.test.ts for
// the exact mock shape.

import type { Database } from '@/lib/db';

export interface EqSentinel {
  __eq: { column: unknown; value: unknown };
}
export interface GteSentinel {
  __gte: { column: unknown; value: unknown };
}
export interface LtSentinel {
  __lt: { column: unknown; value: unknown };
}
export interface InArraySentinel {
  __inArray: { column: unknown; values: unknown[] };
}
export interface AndSentinel {
  __and: Array<WhereSentinel>;
}
export interface OrSentinel {
  __or: Array<WhereSentinel>;
}
export interface NotSentinel {
  __not: WhereSentinel;
}
export interface DescSentinel {
  __desc: unknown;
}
export type WhereSentinel =
  | EqSentinel
  | GteSentinel
  | LtSentinel
  | InArraySentinel
  | AndSentinel
  | OrSentinel
  | NotSentinel;

export interface FilterValue {
  op: 'eq' | 'gte' | 'lt' | 'inArray';
  column: unknown;
  value: unknown;
}

export function flattenFilters(
  cond: WhereSentinel | undefined,
): FilterValue[] {
  if (!cond) return [];
  if ('__eq' in cond) {
    return [{ op: 'eq', column: cond.__eq.column, value: cond.__eq.value }];
  }
  if ('__gte' in cond) {
    return [{ op: 'gte', column: cond.__gte.column, value: cond.__gte.value }];
  }
  if ('__lt' in cond) {
    return [{ op: 'lt', column: cond.__lt.column, value: cond.__lt.value }];
  }
  if ('__inArray' in cond) {
    return [
      {
        op: 'inArray',
        column: cond.__inArray.column,
        value: cond.__inArray.values,
      },
    ];
  }
  if ('__not' in cond) {
    // Negation isn't used by any primary key lookup path the fake DB
    // actually runs through; the cancel-race guards inside team-run
    // use it as a safety net that never narrows any integration-test
    // row (no fixture starts in a terminal state). Returning [] treats
    // the clause as a trivially-satisfied no-op.
    return [];
  }
  if ('__or' in cond) {
    // OR clauses can't collapse into the flat AND-list representation.
    // Callers that only support AND (legacy integration tests) see an
    // empty list — i.e., "no filtering". Callers that care should use
    // `rowMatches` instead of `flattenFilters`.
    return [];
  }
  return cond.__and.flatMap((c) => flattenFilters(c));
}

/**
 * Predicate-based matcher that understands AND/OR/NOT recursion —
 * use this instead of `flattenFilters` for any query that may include
 * `or(...)` clauses.
 */
export function rowMatches(
  row: Record<string, unknown>,
  cond: WhereSentinel | undefined,
): boolean {
  if (!cond) return true;
  if ('__and' in cond) {
    return cond.__and.every((c) => rowMatches(row, c));
  }
  if ('__or' in cond) {
    return cond.__or.some((c) => rowMatches(row, c));
  }
  if ('__not' in cond) {
    return !rowMatches(row, cond.__not);
  }
  const leaves = flattenFilters(cond);
  return leaves.every((f) => {
    const key = findRowKey(row, columnKeys(f.column));
    if (key !== null) return matchesFilter(row[key], f);
    if (f.op === 'eq') {
      return Object.values(row).some((v) => matchesFilter(v, f));
    }
    return false;
  });
}

export interface InMemoryStore {
  db: Database;
  tables: Map<unknown, unknown[]>;
  get<T>(table: unknown): T[];
  register<T>(table: unknown, rows: T[]): void;
}

/**
 * Read a column's name from its drizzle metadata. Drizzle column objects
 * carry the DB column name (snake_case) on `.name`. Our in-memory rows
 * mirror the Drizzle `$inferSelect` shape with **camelCase** keys, so we
 * return BOTH variants and let the matcher try each in turn.
 */
function columnKeys(col: unknown): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = col as any;
  const out: string[] = [];
  if (c?.name && typeof c.name === 'string') {
    out.push(c.name);
    // snake_case → camelCase mirror
    if (c.name.includes('_')) {
      out.push(
        c.name.replace(/_([a-z])/g, (_: string, ch: string) =>
          ch.toUpperCase(),
        ),
      );
    }
  }
  if (c?.fieldAlias && typeof c.fieldAlias === 'string') {
    out.push(c.fieldAlias);
  }
  if (out.length === 0) out.push(String(col));
  return out;
}

function findRowKey(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    if (k in row) return k;
  }
  return null;
}

/**
 * Test whether `rowValue` passes `filter`. Comparison semantics:
 *   - eq: `===` with `Date`-aware equality.
 *   - gte / lt: numeric or Date comparison.
 *   - inArray: `.includes`.
 */
function matchesFilter(rowValue: unknown, filter: FilterValue): boolean {
  const cmp = (a: unknown, b: unknown): number => {
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
    return 0;
  };
  if (filter.op === 'eq') {
    if (rowValue instanceof Date && filter.value instanceof Date) {
      return rowValue.getTime() === filter.value.getTime();
    }
    return rowValue === filter.value;
  }
  if (filter.op === 'gte') {
    return cmp(rowValue, filter.value) >= 0;
  }
  if (filter.op === 'lt') {
    return cmp(rowValue, filter.value) < 0;
  }
  if (filter.op === 'inArray') {
    const values = filter.value as unknown[];
    return values.includes(rowValue as never);
  }
  return false;
}

export function createInMemoryStore(): InMemoryStore {
  const tables = new Map<unknown, unknown[]>();

  const store: InMemoryStore = {
    db: null as unknown as Database, // assigned below
    tables,
    get<T>(table: unknown): T[] {
      let rows = tables.get(table);
      if (!rows) {
        rows = [];
        tables.set(table, rows);
      }
      return rows as T[];
    },
    register<T>(table: unknown, rows: T[]): void {
      tables.set(table, rows as unknown[]);
    },
  };

  const db = {
    select(cols?: Record<string, unknown>) {
      let targetTable: unknown = null;
      let filter: WhereSentinel | undefined;
      let limitN = Infinity;
      const builder = {
        from(table: unknown) {
          targetTable = table;
          return builder;
        },
        innerJoin(_table: unknown, _on: unknown) {
          // Joins aren't asserted against in most tests; forward through.
          return builder;
        },
        where(c: WhereSentinel) {
          filter = c;
          return builder;
        },
        orderBy(..._args: unknown[]) {
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return materialize();
        },
        then(resolve: (v: unknown[]) => unknown) {
          return Promise.resolve(materialize()).then(resolve);
        },
      };

      function materialize(): unknown[] {
        const rows = store.get(targetTable);
        const matching = rows.filter((row) =>
          rowMatches(row as Record<string, unknown>, filter),
        );

        // Apply SELECT projection when cols is supplied.
        let projected: unknown[] = matching;
        if (cols && typeof cols === 'object') {
          projected = matching.map((row) => {
            const r = row as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const [alias, colRef] of Object.entries(cols)) {
              const key = findRowKey(r, columnKeys(colRef));
              if (key !== null) out[alias] = r[key];
              else if (alias in r) out[alias] = r[alias];
              else out[alias] = undefined;
            }
            return out;
          });
        }

        if (Number.isFinite(limitN)) {
          return projected.slice(0, limitN);
        }
        return projected;
      }

      return builder;
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown> | Array<Record<string, unknown>>) {
          const rows = Array.isArray(row) ? row : [row];
          const list = store.get<Record<string, unknown>>(table);
          const inserted: Array<Record<string, unknown>> = [];
          for (const r of rows) {
            const withId = {
              ...r,
              id: (r.id as string | undefined) ?? `mem-${list.length + 1}`,
            };
            list.push(withId);
            inserted.push(withId);
          }
          const p = Promise.resolve(inserted) as Promise<
            Array<Record<string, unknown>>
          > & {
            returning: (
              projection?: Record<string, unknown>,
            ) => Promise<Array<Record<string, unknown>>>;
          };
          p.returning = (projection?: Record<string, unknown>) => {
            if (!projection) return Promise.resolve(inserted);
            const keys = Object.keys(projection);
            return Promise.resolve(
              inserted.map((row) => {
                const out: Record<string, unknown> = {};
                for (const k of keys) out[k] = row[k];
                return out;
              }),
            );
          };
          return p;
        },
      };
    },
    update(table: unknown) {
      let patch: Record<string, unknown> = {};
      let filter: WhereSentinel | undefined;
      const builder = {
        set(p: Record<string, unknown>) {
          patch = p;
          return builder;
        },
        where(c: WhereSentinel) {
          filter = c;
          return Promise.resolve().then(() => {
            const rows = store.get<Record<string, unknown>>(table);
            for (const row of rows) {
              if (rowMatches(row as Record<string, unknown>, filter)) {
                Object.assign(row, patch);
              }
            }
          });
        },
      };
      return builder;
    },
  };

  store.db = db as unknown as Database;
  return store;
}

/**
 * vi.mock replacement for 'drizzle-orm'. Import this from each test file.
 */
export function drizzleMockFactory(
  actual: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...actual,
    eq: (col: unknown, value: unknown): EqSentinel => ({
      __eq: { column: col, value },
    }),
    gte: (col: unknown, value: unknown): GteSentinel => ({
      __gte: { column: col, value },
    }),
    lt: (col: unknown, value: unknown): LtSentinel => ({
      __lt: { column: col, value },
    }),
    inArray: (col: unknown, values: unknown[]): InArraySentinel => ({
      __inArray: { column: col, values },
    }),
    and: (...clauses: WhereSentinel[]): AndSentinel => ({ __and: clauses }),
    or: (...clauses: WhereSentinel[]): OrSentinel => ({ __or: clauses }),
    // Negation is only used by the worker's cancel-race guards — it
    // never narrows a row-by-id path in integration tests, so the fake
    // treats it as a passthrough of the inner node (flattenFilters
    // then returns [] for it, a trivially-satisfied no-op).
    not: (inner: WhereSentinel): NotSentinel => ({ __not: inner }),
    desc: (col: unknown): DescSentinel => ({ __desc: col }),
    sql: (..._args: unknown[]) => 'sql-stub',
  };
}
