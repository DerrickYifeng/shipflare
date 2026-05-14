// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the SocialMediaMgr Durable Object's SQLite schema.
 *
 * Per spec §4.2.5: SMM's working state. NOT cross-team data (channels lives
 * in D1; strategic_path / plan_items live in CMO SQLite via §6.1 invariant).
 *
 * Tables:
 *   threads_inbox  — short-TTL cache of discovery results (per platform)
 *   drafts         — in-flight reply / post drafts (status flows
 *                    drafting → ready → posted / rejected / failed)
 *   posted         — local mirror of published items + their metrics
 *   voice_audit    — log of drafts that deviated from brand voice
 *
 * Per Phase 0 spike + S2.0 finding: `super.onStart()` reads the DO name for
 * the McpAgent transport prefix and throws on non-transport names. The
 * schema bootstrap MUST run BEFORE `super.onStart()`. Tests must call
 * `applySmmSchema(sql)` explicitly because `stub.fetch` + getByName-without-
 * a-transport-prefix skips the parent transport-init path.
 *
 * SQLite types only — no Postgres-isms (no SERIAL / TIMESTAMP WITH TIME
 * ZONE / JSONB). `INTEGER` epoch millis stand in for timestamps; `_json`
 * suffix marks columns holding JSON-encoded TEXT.
 */
export function applySmmSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Discovery cache. Threads here are pre-filtered by judging-thread.
    -- expires_at is for soft cleanup; nothing depends on auto-eviction.
    CREATE TABLE IF NOT EXISTS threads_inbox (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      author TEXT,
      content TEXT NOT NULL,
      score REAL,
      judged_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_platform_judged
      ON threads_inbox(platform, judged_at);

    -- Drafts in flight. The 'conversation_id' is the founder conversation
    -- that triggered the work (for plan-execute audit trail); may be null
    -- for cron-initiated batches.
    CREATE TABLE IF NOT EXISTS drafts (
      conversation_id TEXT,
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,             -- 'reply' | 'post'
      plan_item_id TEXT,              -- nullable: replies aren't plan-driven
      platform TEXT NOT NULL,
      thread_id TEXT,                 -- for replies: which thread
      body TEXT NOT NULL,
      why_it_works TEXT,
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'drafting',
      audit_notes_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_plan_item ON drafts(plan_item_id);

    -- Posted history. external_id is the X / Reddit id of the published
    -- item. metrics_json snapshots engagement at each fetch.
    CREATE TABLE IF NOT EXISTS posted (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT,
      posted_at INTEGER NOT NULL,
      metrics_json TEXT,
      last_metrics_at INTEGER
    );

    -- Voice deviation log — used for self-improvement signal in S6 (voice
    -- skill iterations).
    CREATE TABLE IF NOT EXISTS voice_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id TEXT NOT NULL,
      deviation TEXT NOT NULL,
      why TEXT,
      fixed INTEGER NOT NULL DEFAULT 0
    );
  `);
}
