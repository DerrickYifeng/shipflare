-- Discovery v3 (PR 4): add scout agent's confidence + reason columns to
-- threads. Both nullable so legacy rows from the old `search-source`
-- path remain valid during the 5-PR rollout. The old `relevance_score`
-- column stays intact until PR 5.

ALTER TABLE "threads" ADD COLUMN "scout_confidence" real;
ALTER TABLE "threads" ADD COLUMN "scout_reason" text;
