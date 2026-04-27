/**
 * Tool name constant for `report_progress`. Lives in its own file so
 * `spawn.ts`'s synthetic-tool whitelist can import it without pulling in
 * `CalibrateSearchTool.ts` (which would re-enter the registry → spawn
 * import cycle). Same shape as `strategy-memory.ts`'s extraction.
 */

export const REPORT_PROGRESS_TOOL_NAME = 'report_progress';
