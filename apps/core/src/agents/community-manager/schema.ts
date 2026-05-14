// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the CommunityManager Durable Object's SQLite schema.
 *
 * Phase 2 P2-B: opt-in Pro tier employee. Holds the Community Manager's
 * PRIVATE working space — sentiment pulses, mention summaries, troll
 * observations the founder reviews in the Community Manager UI.
 *
 * Per spec §6.1 invariant #1 (extended to Phase 2 pro roles): the
 * CommunityManager does NOT write CMO SQLite directly. When findings
 * justify a plan_item (e.g. "respond to recurring complaint"), the handoff
 * goes through CMO.addPlanItem in a future Phase 2.x iteration.
 *
 * SQLite types only — `INTEGER` epoch millis stand in for timestamps,
 * `_json` suffix marks columns holding JSON-encoded TEXT.
 *
 * Tag: v7 in wrangler.jsonc migrations.
 */
export function applyCommunityManagerSchema(sql: SqlStorage): void {
  sql.exec(`
    -- One row per finding produced by analyzeCommunityPulse /
    -- summarizeMentions. The kind column discriminates the rows shape;
    -- the json column holds kind-specific structured detail (sentiment
    -- scores, topic clusters, troll patterns, mention links).
    CREATE TABLE IF NOT EXISTS community_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      kind TEXT NOT NULL,
      finding TEXT NOT NULL,
      json TEXT,
      observed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_community_findings_kind_observed
      ON community_findings(kind, observed_at);
    CREATE INDEX IF NOT EXISTS idx_community_findings_platform_observed
      ON community_findings(platform, observed_at);
  `);
}
