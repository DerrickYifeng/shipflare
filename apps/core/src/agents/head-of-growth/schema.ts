// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the HeadOfGrowth Durable Object's SQLite schema.
 *
 * Per spec §4.2.4: this is HoG's PRIVATE state — its own thinking history
 * (not visible to founder), its in-flight strategy drafts, and audit
 * findings it has produced. Per-conversation scope (D11) where applicable.
 *
 * Per spec §6.1 invariant #1: HoG does NOT own the source-of-truth for the
 * team's strategic_path or plan_items — those live in the CMO DO and are
 * mutated by HoG only via the CMO's RPC tools. Anything in this schema is
 * working space the founder never reads directly.
 *
 * Per Phase 0 spike + S2.0 finding: `super.onStart()` reads the DO name for
 * the McpAgent transport prefix and throws on non-transport names. The
 * schema bootstrap MUST run BEFORE `super.onStart()`. Tests must call
 * `applyHogSchema(sql)` explicitly because `stub.fetch` + getByName-without-
 * a-transport-prefix skips the parent transport-init path.
 *
 * SQLite types only — no Postgres-isms (no SERIAL / TIMESTAMP WITH TIME
 * ZONE / JSONB). `INTEGER` epoch millis stand in for timestamps; `_json`
 * suffix marks columns holding JSON-encoded TEXT.
 */
export function applyHogSchema(sql: SqlStorage): void {
  sql.exec(`
    -- HoG's internal thinking — not surfaced in the founder chat.
    -- Conversation-scoped per D11; resets when the founder starts a new
    -- conversation. Composite PK on (conversation_id, ts, role) tolerates
    -- a 'user' and 'assistant' turn landing at the same epoch ms.
    CREATE TABLE IF NOT EXISTS planning_chat (
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, ts, role)
    );

    -- Strategy options in flight. Committed-to-CMO versions live in CMO's
    -- strategic_path table; this is HoG's working space (multiple drafts,
    -- alternatives, the one we'll eventually commit via the CMO RPC tool).
    CREATE TABLE IF NOT EXISTS proposal_drafts (
      id TEXT PRIMARY KEY,
      theme TEXT NOT NULL,
      narrative_md TEXT NOT NULL,
      status TEXT NOT NULL,
      alternatives_json TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Plan-audit findings — gaps, risks, redundancies HoG spots in the
    -- current plan_items. HoG surfaces these to the CMO via the audit_plan
    -- tool (S3.2); the founder sees a summarized version through the CMO.
    CREATE TABLE IF NOT EXISTS audit_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      target_id TEXT,
      severity TEXT NOT NULL,
      finding TEXT NOT NULL,
      suggested_fix TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_open ON audit_findings(status, severity);
  `);
}
