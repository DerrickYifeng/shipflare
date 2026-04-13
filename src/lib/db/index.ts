import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// Reuse the connection pool across hot reloads in dev mode.
// Without this, each hot reload creates a new pool and eventually
// exhausts Supabase's connection limit (53300 too_many_connections).
const globalForDb = globalThis as unknown as { pgClient?: postgres.Sql };

const client =
  globalForDb.pgClient ??
  postgres(connectionString, {
    prepare: false, // Required for Supabase PgBouncer
    ssl: 'require',
    max: process.env.NODE_ENV === 'production' ? 10 : 1,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });

export type Database = typeof db;
