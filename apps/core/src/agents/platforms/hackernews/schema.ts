// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the HackerNewsMcpAgent Durable Object's SQLite schema (P2-E).
 *
 * Shape is identical to X / Reddit / LinkedIn — every platform tool MCP
 * shares the same 3-table operational cache (rate-limit, response cache,
 * posted history).
 *
 * HN is read-only (no programmatic post — HN's API only permits posts
 * via real-user authentication, and bot-style posting is explicitly
 * against HN guidelines). `posted_externals` exists for shape
 * consistency but is never written. `rate_limits` tracks Algolia's
 * 10k-requests/hour budget. `call_cache` caches Algolia search hits.
 */
export function applyHackerNewsSchema(sql: SqlStorage): void {
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
