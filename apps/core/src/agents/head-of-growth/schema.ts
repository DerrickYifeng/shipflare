// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * HoG Durable Object SQLite schema.
 *
 * 5.1c addition: HoG owns its working state (planning_chat,
 * proposal_drafts, audit_findings). CMO never reads these directly —
 * strategic_path proposals shadow-POST to CMO via
 * /internal/strategic-path-proposal (handler in 5.1c.11); audit
 * findings travel back via the consult tool's return value.
 *
 * Per spec §1.2 invariant #1 — no cross-DO SQL.
 */
export function applyHogSchema(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS planning_chat (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			ts INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_planning_chat_ts
			ON planning_chat(ts DESC);

		CREATE TABLE IF NOT EXISTS proposal_drafts (
			id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			theme TEXT NOT NULL,
			narrative_json TEXT NOT NULL,
			generated_at INTEGER NOT NULL,
			mirrored_to_cmo INTEGER NOT NULL DEFAULT 0,
			mirror_error INTEGER             -- HTTP status code from last failed mirror POST (null = no failure)
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_version
			ON proposal_drafts(version);

		CREATE TABLE IF NOT EXISTS audit_findings (
			id TEXT PRIMARY KEY,
			audit_run_id TEXT NOT NULL,
			severity TEXT NOT NULL
				CHECK (severity IN ('high', 'med', 'low')),
			category TEXT NOT NULL
				CHECK (category IN ('gap', 'redundancy', 'risk')),
			finding TEXT NOT NULL,
			affected_plan_items TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_findings_run
			ON audit_findings(audit_run_id, severity);
	`);
}

/**
 * Row shapes for `planning_chat`. Use as the `<T>` argument of `sql.exec<T>(...)`.
 */
export interface PlanningChatRow {
	id: number;
	conversation_id: string | null;
	role: string;
	content: string;
	ts: number;
}

/**
 * Row shapes for `proposal_drafts`.
 */
export interface ProposalDraftRow {
	id: string;
	version: number;
	theme: string;
	narrative_json: string;
	generated_at: number;
	mirrored_to_cmo: number;     // 0 | 1 (SQLite bool)
	mirror_error: number | null; // HTTP status code from last failed mirror POST
}

/**
 * Row shapes for `audit_findings`.
 */
export interface AuditFindingRow {
	id: string;
	audit_run_id: string;
	severity: string;   // 'high' | 'med' | 'low' — CHECK-enforced
	category: string;   // 'gap' | 'redundancy' | 'risk' — CHECK-enforced
	finding: string;
	affected_plan_items: string | null;
	created_at: number;
}
