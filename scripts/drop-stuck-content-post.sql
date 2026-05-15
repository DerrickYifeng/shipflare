-- One-off cleanup for the 2026-05-11 stuck Reddit content_post that
-- predates the kickoff-research feature. The plan_item, its synthetic
-- thread, and the pending draft are all dropped; the plan_item state is
-- set to 'skipped' so the re-planner regenerates it cleanly.
--
-- Safe to re-run: WHERE clauses are exact-id matches and the DELETE +
-- UPDATE statements no-op on already-clean state.
BEGIN;

DELETE FROM drafts
WHERE plan_item_id = '233588e6-0281-4da7-9d85-9d18c48a81fb';

DELETE FROM threads
WHERE external_id = 'content-post:233588e6-0281-4da7-9d85-9d18c48a81fb';

UPDATE plan_items
SET state = 'skipped', user_action = 'skip', updated_at = now()
WHERE id = '233588e6-0281-4da7-9d85-9d18c48a81fb';

COMMIT;

-- Verify (optional):
-- SELECT state, user_action FROM plan_items
--  WHERE id = '233588e6-0281-4da7-9d85-9d18c48a81fb';
-- Expected: state='skipped', user_action='skip'
