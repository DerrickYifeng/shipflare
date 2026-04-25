-- Discovery v3 (PR 5): retire the legacy scoring + calibration tables and
-- columns. Scout agent's `scout_confidence` + `scout_reason` replace the
-- numeric `relevance_score`; `discovery_configs` is dropped entirely —
-- per-product tuning now lives in `agent_memories` (onboarding rubric +
-- feedback memories distilled from approve/skip actions).

ALTER TABLE "threads" DROP COLUMN "relevance_score";

DROP TABLE "discovery_configs";
