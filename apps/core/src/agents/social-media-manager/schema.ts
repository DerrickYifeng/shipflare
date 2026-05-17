// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * SMM Durable Object SQLite schema.
 *
 * 5.1c addition: SMM owns its working state (threads_inbox, drafts).
 * CMO never reads these directly — peer tools mirror ready drafts to
 * CMO.approval_queue via /internal/mirror-draft.
 *
 * Per spec §1.2 invariant #1 — no cross-DO SQL.
 */
export function applySmmSchema(sql: SqlStorage): void {
	sql.exec(`
		CREATE TABLE IF NOT EXISTS threads_inbox (
			id TEXT PRIMARY KEY,
			external_id TEXT NOT NULL,
			platform TEXT NOT NULL,
			author TEXT,
			content TEXT NOT NULL,
			intent TEXT,
			judge_score REAL,
			judge_reason TEXT,
			judged_at INTEGER,
			discovered_at INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending'
		);
		CREATE INDEX IF NOT EXISTS idx_inbox_status_judged
			ON threads_inbox(status, judged_at DESC);
		CREATE INDEX IF NOT EXISTS idx_inbox_platform
			ON threads_inbox(platform);

		CREATE TABLE IF NOT EXISTS drafts (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_id TEXT,
			plan_item_id TEXT,
			body TEXT NOT NULL,
			body_title TEXT,
			status TEXT NOT NULL,
			validation_errors TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			mirrored_at INTEGER,
			mirror_error INTEGER,
			posted_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_drafts_status
			ON drafts(status, updated_at DESC);
	`);
}
