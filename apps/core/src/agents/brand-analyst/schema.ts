// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the BrandAnalyst Durable Object's SQLite schema.
 *
 * Phase 2 P2-B: opt-in Pro tier employee. Holds the Brand Analyst's
 * PRIVATE working space — competitor analyses and positioning suggestions
 * the founder can adopt or reject.
 *
 * Per spec §6.1 invariant #1 (extended to Phase 2 pro roles): the
 * BrandAnalyst does NOT write CMO SQLite directly. Approved positioning
 * lands in CMO's strategic_path via `commitStrategicPath` once Phase 2.x
 * wires the handoff; for now these tables are the analyst's scratchpad.
 *
 * SQLite types only — `INTEGER` epoch millis stand in for timestamps,
 * `_json` suffix marks columns holding JSON-encoded TEXT.
 *
 * Tag: v6 in wrangler.jsonc migrations.
 */
export function applyBrandAnalystSchema(sql: SqlStorage): void {
  sql.exec(`
    -- One row per competitor analyzed. themes_json / channels_json hold
    -- arrays the LLM extracts; voice is a free-text impression of the
    -- competitor's brand voice.
    CREATE TABLE IF NOT EXISTS competitor_analyses (
      id TEXT PRIMARY KEY,
      competitor TEXT NOT NULL,
      voice TEXT,
      themes_json TEXT,
      channels_json TEXT,
      analyzed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_analyses_analyzed_at
      ON competitor_analyses(analyzed_at);

    -- Positioning theses the Brand Analyst proposes based on the
    -- competitor analyses + founder_context. confidence ∈ [0, 1].
    -- Phase 2.x: approved theses promote to CMO.commitStrategicPath.
    CREATE TABLE IF NOT EXISTS positioning_suggestions (
      id TEXT PRIMARY KEY,
      thesis TEXT NOT NULL,
      evidence_json TEXT,
      confidence REAL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_positioning_created_at
      ON positioning_suggestions(created_at);
  `);
}
