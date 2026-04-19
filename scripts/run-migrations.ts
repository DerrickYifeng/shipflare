/**
 * Apply drizzle migrations with full error output. Bypasses drizzle-kit's
 * TUI spinner which can overwrite the real SQL error.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... bun run scripts/run-migrations.ts
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set.');
    process.exit(1);
  }

  const migrationClient = postgres(url, { max: 1 });
  const db = drizzle(migrationClient);

  try {
    console.log('Applying migrations from ./drizzle ...');
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('✓ All migrations applied successfully.');
  } catch (err: unknown) {
    console.error('\n✗ Migration failed:');
    console.error(err);
    if (err instanceof Error && err.stack) {
      console.error('\nStack:');
      console.error(err.stack);
    }
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

main();
