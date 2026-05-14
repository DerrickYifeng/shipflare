// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the Copywriter Durable Object's SQLite schema.
 *
 * Phase 2 P2-B: opt-in Pro tier employee. Holds the Copywriter's PRIVATE
 * working space — draft outputs the founder may or may not approve, plus
 * voice lessons learned from feedback over time.
 *
 * Per spec §6.1 invariant #1 (extended to Phase 2 pro roles): the
 * Copywriter does NOT write CMO SQLite directly. Approved drafts flow back
 * to the CMO's `addPlanItem` / SMM's drafts pipeline; this schema is the
 * Copywriter's own scratchpad only.
 *
 * SQLite types only — `INTEGER` epoch millis stand in for timestamps,
 * `_json` suffix marks columns holding JSON-encoded TEXT.
 *
 * Tag: v5 in wrangler.jsonc migrations.
 */
export function applyCopywriterSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Generated copy artifacts (headlines, taglines, rewrites, posts, replies).
    -- One row per LLM call output; the founder reviews these in the
    -- Copywriter conversation UI before they get promoted to live drafts in
    -- the SMM pipeline.
    CREATE TABLE IF NOT EXISTS copy_drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      brief TEXT NOT NULL,
      output TEXT NOT NULL,
      voice TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_copy_drafts_kind_created
      ON copy_drafts(kind, created_at);

    -- Voice lessons — patterns the Copywriter has learned about the
    -- founder's voice. Populated by feedback loops (founder edits, slop
    -- rejections, repeat phrasings). Phase 2 P2-B leaves this empty;
    -- Phase 2.x will wire the learning loop.
    CREATE TABLE IF NOT EXISTS voice_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      ok_examples TEXT,
      avoid_examples TEXT,
      learned_at INTEGER NOT NULL
    );
  `);
}
