/**
 * Reconcile a DB that was originally bootstrapped via `drizzle-kit push` with
 * the migration folder.
 *
 * Strategy:
 *   1. Skim drizzle/meta/_journal.json for ordered tags.
 *   2. For each tag, compute the SHA-256 hash drizzle uses (over the SQL file
 *      contents — the same recipe drizzle-kit/migrator uses).
 *   3. If __drizzle_migrations already has that hash, skip.
 *   4. Check for a routing directive in the SQL file:
 *
 *      -- drizzle-orm: nontransactional
 *        Run all statements outside any transaction (required for
 *        CREATE INDEX CONCURRENTLY). All DDL MUST use IF NOT EXISTS or
 *        equivalent idempotent guards.
 *
 *      -- drizzle-orm: always-run
 *        Run all statements inside sql.begin() unconditionally (for
 *        ALTER TABLE, CREATE TYPE, ADD CONSTRAINT migrations not applied
 *        by push). All DDL MUST be idempotent via information_schema /
 *        pg_constraint guards or IF NOT EXISTS.
 *
 *      (no directive)
 *        Fall through to MAIN_TABLES_FOR heuristic: if the migration's
 *        primary tables already exist, assume push applied it and only
 *        record the hash. Otherwise execute inside sql.begin().
 *
 * INVARIANTS:
 *   - nontransactional migrations MUST use IF NOT EXISTS on every DDL
 *     statement. Violating this causes duplicate-object errors.
 *   - always-run migrations MUST use information_schema / pg_constraint
 *     guards (or IF NOT EXISTS) on every DDL statement. Violating this
 *     causes errors on envs where the DDL was already applied by push.
 *   - Every journal tag MUST have an entry in MAIN_TABLES_FOR. Missing
 *     entries cause an abort-on-unknown-tag safeguard to fire.
 *
 * This is conservative: no unguarded DROPs or re-creations.
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
  '0014_wave2_constraints': [], // always-run via directive
  '0015_agent_memories_user_id': [], // always-run via directive
  '0016_channel_posts': [], // always-run via directive
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

    // drizzle splits statements with '--> statement-breakpoint'
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);

    // Nontransactional migrations MUST run their DDL every time (idempotent via
    // IF NOT EXISTS). Running inside sql.begin() would break CONCURRENTLY.
    // Check this FIRST, before MAIN_TABLES_FOR heuristics, so migrations like
    // 0013 (index-only, empty mainTables) actually build their indexes on envs
    // that need them.
    if (sqlText.includes('-- drizzle-orm: nontransactional')) {
      console.log(`  APPLY ${tag} (nontransactional — idempotent re-run)`);
      for (const stmt of statements) {
        await sql.unsafe(stmt);
      }
      await sql`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${when})
      `;
      continue;
    }

    // Always-run transactional migrations: ALTER TABLE, CREATE TYPE, ADD CONSTRAINT.
    // DDL must be idempotent (information_schema / pg_constraint guards).
    // Runs unconditionally inside sql.begin() on any env missing this hash.
    if (sqlText.includes('-- drizzle-orm: always-run')) {
      console.log(`  APPLY ${tag} (always-run — idempotent transactional DDL)`);
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${when})
        `;
      });
      continue;
    }

    // Pure ALTER/rename with empty mainTables — assume push already applied.
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
