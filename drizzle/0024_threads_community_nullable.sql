-- Make `threads.community` nullable. Previously NOT NULL forced X-thread
-- inserts to write 'x' as a placeholder (community has no meaning on X);
-- that value then leaked into the drafting-reply skill's input and
-- occasionally tempted the LLM to call get_subreddit_rules with
-- subreddit='x', producing a noisy `Reddit GET /r/x/about/rules: 404` on
-- every misroute.
--
-- After this migration:
--   - Reddit threads keep `community = '<subreddit>'` (real semantic value)
--   - X threads carry `community = NULL` (no equivalent concept)
--
-- Renderers must treat NULL as "no community badge" and fall back on the
-- platform label.

ALTER TABLE "threads" ALTER COLUMN "community" DROP NOT NULL;--> statement-breakpoint

-- Backfill: any existing X rows with the 'x' placeholder become NULL so
-- the data shape matches the new contract. Reddit rows are untouched.
UPDATE "threads" SET "community" = NULL WHERE "platform" = 'x' AND "community" = 'x';
