import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// prepare: false is required for Supabase connection pooling (PgBouncer)
// ssl: 'require' is needed for Supabase direct connections (especially in Edge runtime)
const client = postgres(connectionString, { prepare: false, ssl: 'require' });

export const db = drizzle(client, { schema });

export type Database = typeof db;
