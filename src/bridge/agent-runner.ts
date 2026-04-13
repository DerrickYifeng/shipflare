/**
 * Bridge agent runner — thin delegation to core/query-loop.ts.
 *
 * This file preserves the original public API so that workers and routes
 * continue to work without import changes. The actual implementation
 * now lives in src/core/query-loop.ts.
 */
export { runAgent, createToolContext } from '../core/query-loop';
