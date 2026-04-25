-- Phase 2b — Anthropic-native content blocks per row.
--
-- Lets the conversation-history loader emit well-formed messages
-- without a reconstruction state machine. Each row carries its
-- ready-to-replay `ContentBlockParam[]` so the loader becomes a
-- one-pass merge-by-role instead of pairing tool_use_ids across
-- rows by timestamp.
--
-- Nullable because legacy rows (pre-migration) are not backfilled —
-- the loader still synthesizes blocks from `content` + `metadata`
-- for those (see `normalizeRowContent` in team-conversation.ts).

ALTER TABLE "team_messages"
  ADD COLUMN "content_blocks" jsonb;
