// Shared numeric limits referenced from multiple call sites. Constants
// land here when more than one module needs the same magic number — a
// drift between worker truncation and UI display, or between an
// in-memory cap and a DB column length, is silent and hard to debug.

/**
 * Maximum length (in characters) of `team_messages.content` for a
 * `tool_result` row. The full output is preserved in
 * `metadata.tool_output`; this cap keeps the displayed text reasonable
 * in the activity log without paying the full cost of large JSON tool
 * results in the row.
 *
 * Owners:
 *   - `src/workers/processors/agent-run.ts` (writer — truncates before
 *     INSERT into `team_messages`).
 *   - Any UI renderer that wants to show "truncated to N chars" — it
 *     should reference this constant rather than hardcoding 4000 so the
 *     renderer stays aligned with the writer when this value evolves.
 */
export const TOOL_RESULT_TRUNCATION_LIMIT = 4000;
