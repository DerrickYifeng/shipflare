/**
 * Inspect prod DB state. Read-only.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun run scripts/inspect-db.ts
 */
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }

  const sql = postgres(url);

  try {
    const schemas = await sql<{ schema_name: string }[]>`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY schema_name
    `;
    console.log('\n=== Schemas ===');
    for (const s of schemas) console.log(' -', s.schema_name);

    const publicTables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;
    console.log(`\n=== public.* tables (${publicTables.length}) ===`);
    for (const t of publicTables) console.log(' -', t.tablename);

    const publicTypes = await sql<{ typname: string }[]>`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public' AND t.typtype = 'e'
      ORDER BY t.typname
    `;
    console.log(`\n=== public.* enums (${publicTypes.length}) ===`);
    for (const t of publicTypes) console.log(' -', t.typname);

    const hasDrizzleSchema = schemas.some((s) => s.schema_name === 'drizzle');
    if (hasDrizzleSchema) {
      const drizzleTables = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'drizzle' ORDER BY tablename
      `;
      console.log(`\n=== drizzle.* tables (${drizzleTables.length}) ===`);
      for (const t of drizzleTables) console.log(' -', t.tablename);

      const hasMigrations = drizzleTables.some((t) => t.tablename === '__drizzle_migrations');
      if (hasMigrations) {
        const rows = await sql<{ id: number; hash: string; created_at: string }[]>`
          SELECT id, hash, created_at FROM drizzle.__drizzle_migrations
          ORDER BY id
        `;
        console.log(`\n=== drizzle.__drizzle_migrations rows (${rows.length}) ===`);
        for (const r of rows) {
          console.log(` - id=${r.id} hash=${r.hash.slice(0, 12)}... at=${r.created_at}`);
        }
      }
    } else {
      console.log('\n=== drizzle schema does not exist ===');
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err);
  process.exit(1);
});
