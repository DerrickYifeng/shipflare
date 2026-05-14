// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the LinkedInMcpAgent Durable Object's SQLite schema (P2-E).
 *
 * Shape is identical to XMcpAgent / RedditMcpAgent — every platform tool
 * MCP shares the same 3-table operational cache (rate-limit, response cache,
 * posted history). Keeping schemas structurally identical means future
 * platforms can extract a shared helper without backfilling existing
 * platforms' data.
 *
 * Tables:
 *   rate_limits       — per-endpoint rate budget cached from LinkedIn's
 *                       throttle response headers. Tools check this BEFORE
 *                       calling LinkedIn to avoid 429s.
 *   call_cache        — per-query response cache for read endpoints
 *                       (currently a no-op since LinkedIn search is a
 *                       stub — Phase 2 P2-E.2 will wire this once
 *                       Marketing Developer Platform access is approved).
 *   posted_externals  — local mirror of every UGC Post we've published.
 *                       external_id is the LinkedIn URN
 *                       (`urn:li:share:...` or `urn:li:ugcPost:...`).
 *
 * Per Phase 0 spike + S2.0 finding: `super.onStart()` reads the DO name
 * for the McpAgent transport prefix and throws on non-transport names.
 * The schema bootstrap MUST run BEFORE `super.onStart()`. Tests must call
 * `applyLinkedInSchema(sql)` explicitly because `stub.fetch` +
 * getByName-without-a-transport-prefix skips the parent transport-init
 * path.
 */
export function applyLinkedInSchema(sql: SqlStorage): void {
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
