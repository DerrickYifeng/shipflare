/**
 * Bridge build-tool — thin delegation to core/tool-system.ts.
 *
 * This file preserves the original public API so that tool files
 * continue to work without import changes.
 */
export { buildTool, toAnthropicTool } from '../core/tool-system';
