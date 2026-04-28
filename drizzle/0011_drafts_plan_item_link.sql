-- Add plan_item_id FK so drafts can be looked up by the originating plan_item.
-- Nullable so legacy rows remain untouched; new draft inserts (community-manager,
-- post-writer) are responsible for populating this when they have the linkage.
ALTER TABLE "drafts"
  ADD COLUMN "plan_item_id" text REFERENCES "plan_items"("id") ON DELETE SET NULL;

CREATE INDEX "drafts_plan_item_idx" ON "drafts" ("plan_item_id")
  WHERE "plan_item_id" IS NOT NULL;

-- New status: draft handed off to the user's browser via X intent URL.
-- Treated as terminal — same as 'posted' for feed-exclusion purposes — but
-- distinguished so we can later add verify-by-poll and audit trails.
ALTER TYPE "draft_status" ADD VALUE IF NOT EXISTS 'handed_off';
