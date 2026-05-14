// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the DiscordMcpAgent Durable Object's SQLite schema (P2-E).
 *
 * Shape is identical to X / Reddit / LinkedIn / HN — every platform tool MCP
 * shares the same 3-table operational cache (rate-limit, response cache,
 * posted history).
 *
 * Tables:
 *   rate_limits       — per-endpoint rate budget cached from Discord's
 *                       `x-ratelimit-*` headers. Discord enforces
 *                       per-route AND global buckets; tools check before
 *                       calling to avoid 429s.
 *   call_cache        — per-query response cache. Discord doesn't have a
 *                       global search surface for bots — this is reserved
 *                       for forward-compat (e.g. channel-scoped message
 *                       history caching).
 *   posted_externals  — local mirror of every message we've published.
 *                       external_id is the Discord message id (snowflake).
 */
export function applyDiscordSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      endpoint TEXT PRIMARY KEY,
      remaining INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS call_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_call_cache_expires
      ON call_cache(expires_at);

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
