import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Reuse the connection pool across hot reloads in dev mode.
// Without this, each hot reload creates a new pool and eventually
// exhausts Supabase's connection limit (53300 too_many_connections).
const globalForDb = globalThis as unknown as { pgClient?: postgres.Sql };

// Configurable in prod so we can grow the pool without a redeploy when
// adding workers or per-tenant concurrency caps. Default 30 covers the
// current BullMQ worker fan-out (agent-run concurrency 8 + the other
// queues summing to ~24) plus headroom for cron + HTTP routes. Bump
// when adding workers, but stay under the Supabase pooler's
// `max_clients` ceiling (Pro: 400, Free: 60). Dev keeps max=1 to
// surface starvation bugs locally and to play nicely with Next.js hot
// reload's connection churn.
//
// Defensive parsing: a typo like `PG_POOL_MAX=thirty` would make
// `parseInt` return NaN; `postgres()` then does `Array(NaN)` and
// throws `RangeError: Invalid array length` synchronously at module
// load — taking the whole worker / Next.js server down with a
// confusing stack. Fall back to 30 on NaN / <=0, and clamp to 200 as a
// sanity upper bound (well below Supabase Pro's 400 ceiling).
const parsedPoolMax = Number.parseInt(process.env.PG_POOL_MAX ?? '30', 10);
const poolMax: number =
  Number.isFinite(parsedPoolMax) && parsedPoolMax > 0
    ? Math.min(parsedPoolMax, 200)
    : 30;

const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    prepare: false, // Required for Supabase PgBouncer
    ssl: 'require',
    max: process.env.NODE_ENV === 'production' ? poolMax : 1,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });

export type Database = typeof db;
