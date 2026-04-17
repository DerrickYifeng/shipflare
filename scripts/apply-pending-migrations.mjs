/**
 * Reconcile a DB that was originally bootstrapped via `drizzle-kit push` with
 * the migration folder.
 *
 * Strategy:
 *   1. Skim drizzle/meta/_journal.json for ordered tags.
 *   2. For each tag, compute the SHA-256 hash drizzle uses (over the SQL file
 *      contents — the same recipe drizzle-kit/migrator uses).
 *   3. If __drizzle_migrations already has that hash, skip.
 *   4. Otherwise check "does this migration's main new table(s) already exist?"
 *      — if yes, we assume push had already created them; just record the
 *      migration as applied (hash + created_at) without re-running the DDL.
 *      If no, actually execute the statements (split on `--> statement-breakpoint`).
 *
 * This is conservative: no DROPs, no re-creations, just bring the bookkeeping
 * in sync and run genuinely-new DDL.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '..', 'drizzle');
const journal = JSON.parse(
  readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8'),
);

// Drizzle hashes the raw SQL file contents with SHA-256 hex.
function hashSql(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

async function tablesExist(names) {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY(${names})
  `;
  return new Set(rows.map((r) => r.table_name));
}

// For each entry in the journal, list the new tables that migration is
// primarily responsible for creating. If ALL of these already exist, we treat
// the migration as "push already did this" and just backfill the bookkeeping
// row. If ANY are missing, we execute the SQL file to build them.
const MAIN_TABLES_FOR = {
  '0000_bumpy_machine_man': [
    'users', 'accounts', 'sessions', 'verification_tokens',
  ],
  '0001_omniscient_captain_universe': [
    'products', 'threads', 'drafts', 'posts', 'channels',
  ],
  '0002_rename_subreddit_to_community': [], // rename only
  '0003_add_code_snapshots': ['code_snapshots'],
  '0004_make_url_nullable': [],
  '0005_abnormal_kulan_gath': ['health_scores', 'activity_events'],
  '0006_add_calendar_channel': ['x_content_calendar'],
  '0007_aspiring_kitty_pryde': [
    'x_monitored_tweets', 'x_target_accounts',
    'x_follower_snapshots', 'x_tweet_metrics', 'x_analytics_summary',
  ],
  '0008_milky_lionheart': ['agent_memories', 'agent_memory_logs'],
  '0009_add_discovery_configs': ['discovery_configs'],
  '0010_posting_flow_optimization': [], // ALTER TABLE only — no new tables
  '0011_simple_excalibur': ['todo_items', 'user_preferences'],
  '0012_pipeline_funnel': ['pipeline_events', 'thread_feedback'],
  '0013_cluster1_indexes': [], // CREATE INDEX CONCURRENTLY only — no new tables
};

try {
  // Ensure __drizzle_migrations exists (migrate bootstrap already created it,
  // but be defensive in case this script runs first).
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  const existing = await sql`SELECT hash FROM drizzle.__drizzle_migrations`;
  const existingHashes = new Set(existing.map((r) => r.hash));

  for (const entry of journal.entries) {
    const { tag, when } = entry;
    const sqlPath = resolve(drizzleDir, `${tag}.sql`);
    const sqlText = readFileSync(sqlPath, 'utf8');
    const hash = hashSql(sqlText);

    if (existingHashes.has(hash)) {
      console.log(`  SKIP ${tag} (already recorded)`);
      continue;
    }

    const mainTables = MAIN_TABLES_FOR[tag];
    if (mainTables === undefined) {
      console.error(
        `  UNKNOWN ${tag} — no MAIN_TABLES_FOR entry, aborting to be safe`,
      );
      process.exit(1);
    }

    // Non-table-creation migration (rename, alter nullability, etc.). We
    // assume `drizzle-kit push` already applied the schema change, so just
    // record the bookkeeping row without re-running the DDL.
    if (mainTables.length === 0) {
      console.log(`  MARK ${tag} (alter/rename — push already applied)`);
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${when})
      `;
      continue;
    }

    const present = await tablesExist(mainTables);
    const allPresent = mainTables.every((t) => present.has(t));

    if (allPresent) {
      console.log(`  MARK ${tag} (tables already exist, recording only)`);
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${when})
      `;
      continue;
    }

    console.log(`  APPLY ${tag}`);
    // drizzle splits statements with '--> statement-breakpoint'
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
    // Detect the nontransactional directive and run each statement
    // outside sql.begin() in that case.
    const isNontransactional = sqlText.includes('-- drizzle-orm: nontransactional');

    if (isNontransactional) {
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${when})
      `;
    } else {
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${when})
        `;
      });
    }
  }

  // Final state
  const finalRows = await sql`
    SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
  `;
  console.log(`\nDONE. ${finalRows.length} migrations recorded.`);

  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('pipeline_events', 'thread_feedback', 'todo_items')
    ORDER BY table_name
  `;
  console.log('critical tables present:', tables.map((t) => t.table_name));
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
