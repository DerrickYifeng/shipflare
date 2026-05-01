-- Enforce at most one pending draft per (user_id, thread_id).
--
-- Pre-fix, DraftReplyTool was a plain INSERT — re-spawning
-- community-manager / x-reply-writer on the same thread would land a
-- second pending row, surfacing as a duplicate tweet card in /today.
-- The tool is now idempotent (SELECT-then-UPDATE on existing pending),
-- and this partial unique index backs that at the DB level so any code
-- path that bypasses the tool fails fast instead of accumulating duplicates.
--
-- Backfill: collapse pre-existing duplicates first by deleting older
-- pending rows per (user_id, thread_id), keeping the newest. The
-- aggregation-side dedup in /api/today already hid these from the UI;
-- this migration removes the orphaned rows from `drafts` so they don't
-- leak through other consumers (analytics, audit, fix-up scripts).

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, thread_id
      ORDER BY created_at DESC, id DESC
    ) AS rn
  FROM drafts
  WHERE status = 'pending'
)
DELETE FROM drafts
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint

CREATE UNIQUE INDEX "drafts_user_thread_pending_uq"
  ON "drafts" ("user_id", "thread_id")
  WHERE "status" = 'pending';
