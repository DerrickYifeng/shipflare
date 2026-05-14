// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the XMcpAgent Durable Object's SQLite schema (spec §4.2.6).
 *
 * XMcpAgent is a LEAF platform tool MCP — no LLM autonomy, no plan opinion,
 * no sub-agent fan-out. Its SQLite tables hold operational caches that make
 * the platform tools (`x_search` / `x_post` / `x_metrics`, landing in S5.1)
 * efficient + safe to retry.
 *
 * Tables:
 *   rate_limits       — per-endpoint rate-limit budget cached from X's
 *                       `x-rate-limit-*` headers. Tools check this BEFORE
 *                       calling X to avoid 429s.
 *   call_cache        — per-query response cache for read endpoints
 *                       (search, user lookup, metrics). `expires_at` is
 *                       the cache TTL; the index lets a background sweep
 *                       evict expired rows.
 *   posted_externals  — local mirror of every item we've published. Used
 *                       to prevent double-posting and to surface deletion /
 *                       moderation events on follow-up checks.
 *
 * Per Phase 0 spike + S2.0 finding: `super.onStart()` reads the DO name for
 * the McpAgent transport prefix and throws on non-transport names. The schema
 * bootstrap MUST run BEFORE `super.onStart()`. Tests must call
 * `applyXSchema(sql)` explicitly because `stub.fetch` + getByName-without-
 * a-transport-prefix skips the parent transport-init path.
 *
 * SQLite types only — no Postgres-isms. INTEGER epoch millis stand in for
 * timestamps; `_json` suffix marks columns holding JSON-encoded TEXT.
 */
export function applyXSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Per-endpoint rate budget. Tools update remaining/reset_at from
    -- response headers and consult before the next call.
    CREATE TABLE IF NOT EXISTS rate_limits (
      endpoint TEXT PRIMARY KEY,
      remaining INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    -- Response cache for read endpoints. cache_key is built by the tool
    -- (e.g. "search:<query>:<maxResults>"); idempotency comes from the
    -- caller using a stable shape.
    CREATE TABLE IF NOT EXISTS call_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_cache_expires
      ON call_cache(expires_at);

    -- Posted history. external_id is X's tweet id. kind distinguishes
    -- post / reply / quote-retweet at write time so downstream metrics
    -- queries don't have to re-classify. deleted_at is set when a
    -- follow-up check finds the item gone (moderation / user-delete).
    -- json holds the full original publish response for audit.
    CREATE TABLE IF NOT EXISTS posted_externals (
      external_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      posted_by_role TEXT,
      posted_at INTEGER NOT NULL,
      deleted_at INTEGER,
      json TEXT
    );
  `);
}
