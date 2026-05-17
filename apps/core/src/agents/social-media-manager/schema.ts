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
				CHECK (status IN ('pending', 'drafted', 'skipped'))
		);
		CREATE INDEX IF NOT EXISTS idx_inbox_status_platform_judged
			ON threads_inbox(status, platform, judged_at DESC);

		CREATE TABLE IF NOT EXISTS drafts (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			channel TEXT NOT NULL,
			thread_id TEXT,
			plan_item_id TEXT,
			body TEXT NOT NULL,
			body_title TEXT,
			status TEXT NOT NULL
				CHECK (status IN ('ready', 'failed', 'mirrored', 'posted')),
			validation_errors TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			mirrored_at INTEGER,
			mirror_error INTEGER,             -- HTTP status code from last failed mirror POST (null = no failure)
			posted_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS idx_drafts_status
			ON drafts(status, updated_at DESC);
	`);
}

/**
 * Row shapes for `threads_inbox`. Use as the `<T>` argument of `sql.exec<T>(...)`
 * so peer tools don't redeclare these inline.
 */
export interface ThreadInboxRow {
	id: string;
	external_id: string;
	platform: string;
	author: string | null;
	content: string;
	intent: string | null;
	judge_score: number | null;
	judge_reason: string | null;
	judged_at: number | null;
	discovered_at: number;
	status: string;
}

/**
 * Row shapes for `drafts`.
 */
export interface DraftRow {
	id: string;
	kind: string;
	channel: string;
	thread_id: string | null;
	plan_item_id: string | null;
	body: string;
	body_title: string | null;
	status: string;
	validation_errors: string | null;
	created_at: number;
	updated_at: number;
	mirrored_at: number | null;
	mirror_error: number | null;
	posted_at: number | null;
}
