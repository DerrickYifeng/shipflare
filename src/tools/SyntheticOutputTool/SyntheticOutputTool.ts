// SyntheticOutputTool — system-only placeholder Tool.
//
// This Tool exists for the type system and the blacklist constant. It is
// NEVER added to ROLE_WHITELISTS, NEVER returned by registry.get() in
// production paths, and isEnabled() always returns false. The actual
// <task-notification> XML synthesis happens in
// `src/workers/processors/lib/synthesize-notification.ts`.
//
// Defense in depth: even if a future contributor accidentally adds
// SyntheticOutput to a whitelist, isEnabled() returning false would
// allow tool-list assembly to skip it. The primary gate, however, is
// `INTERNAL_TEAMMATE_TOOLS` in `src/tools/AgentTool/blacklists.ts` —
// `SYNTHETIC_OUTPUT_TOOL_NAME` is listed there so layer ③ of the
// four-layer filter pipeline drops it for every `member` and
// `subagent` execution role. Two-layer defense: blacklisted AND
// isEnabled-gated, so it can never reach an LLM.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';

export const SYNTHETIC_OUTPUT_TOOL_NAME = 'SyntheticOutput';

const SyntheticOutputInputSchema = z
  .object({
    /** Placeholder; real synthesis is server-side, not LLM-driven. */
    _unused: z.never().optional(),
  })
  .strict();

type SyntheticOutputInput = z.infer<typeof SyntheticOutputInputSchema>;

/**
 * Extension of `ToolDefinition` carrying the architecture-level
 * `isEnabled()` invariant. The base `ToolDefinition` shape does not
 * model this — SyntheticOutput is the only Tool today that opts into
 * being LLM-invisible by construction, so we surface it as an extra
 * field on this single export rather than widening `ToolDefinition`
 * with a field every other Tool would have to default.
 */
export type SystemOnlyToolDefinition<TInput, TOutput> = ToolDefinition<
  TInput,
  TOutput
> & {
  /**
   * Returns false unconditionally. If `assembleToolPool` ever gains an
   * `isEnabled` filter, this Tool will be dropped at that stage too —
   * a second layer of defense beneath the `INTERNAL_TEAMMATE_TOOLS`
   * blacklist that already drops it today.
   */
  isEnabled(): boolean;
};

const baseTool: ToolDefinition<SyntheticOutputInput, never> = buildTool({
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  description:
    '[INTERNAL — system-only] Synthesizes a <task-notification> mailbox row. Never callable by an LLM; isEnabled() always returns false.',
  inputSchema: SyntheticOutputInputSchema,
  async execute(): Promise<never> {
    throw new Error(
      'SyntheticOutputTool.execute() called from an LLM context — this should be impossible. ' +
        'XML synthesis happens server-side via synthesizeTaskNotification(). ' +
        'Check for accidental inclusion in a role whitelist.',
    );
  },
});

export const syntheticOutputTool: SystemOnlyToolDefinition<
  SyntheticOutputInput,
  never
> = {
  ...baseTool,
  /** Two-layer defense: blacklisted in INTERNAL_TEAMMATE_TOOLS AND
   *  isEnabled() returns false. Never reachable from an agent context. */
  isEnabled: () => false,
};
