/**
 * DANGER: Drops and recreates the `public` schema on the DB at DATABASE_URL.
 * Wipes EVERY table, index, enum, function, and sequence. Irreversible.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun run scripts/wipe-public-schema.ts
 *
 * Typed confirmation prompt guards against accidental runs.
 */
import postgres from 'postgres';
import * as readline from 'node:readline/promises';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set. Refusing to run.');
    process.exit(1);
  }

  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return '<unparseable>';
    }
  })();

  console.log(`\n⚠  Target DB host: ${host}`);
  console.log('⚠  This will DROP SCHEMA public CASCADE on that database.');
  console.log('⚠  All tables, enums, and data in the `public` schema will be destroyed.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type the host shown above to confirm: ');
  rl.close();

  if (answer.trim() !== host) {
    console.error('Confirmation did not match. Aborting.');
    process.exit(1);
  }

  const sql = postgres(url, { onnotice: () => { /* suppress NOTICE spam */ } });

  try {
    const before = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;
    console.log(`\nTables before wipe (${before.length}):`);
    for (const t of before) console.log(`  - ${t.tablename}`);

    console.log('\nDropping and recreating public + drizzle schemas...');
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS public CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `);

    const after = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    console.log(`\n✓ Done. Tables after wipe: ${after.length}`);
    if (after.length > 0) {
      console.warn('Unexpected tables remain:');
      for (const t of after) console.warn(`  - ${t.tablename}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error('Failed:', err);
  process.exit(1);
});
