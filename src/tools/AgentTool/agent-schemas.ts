// Phase B Day 4 — per-agent StructuredOutput schemas.
//
// The loader produces `AgentDefinition` without a Zod schema (AGENT.md is
// Markdown + YAML; Zod lives in code). runAgent needs the schema to
// synthesize a `StructuredOutput` tool on the agent's tool list whose input
// shape matches the agent's terminal payload.
//
// This module is the single lookup point: `getAgentOutputSchema(agentType)`
// returns the schema a runAgent caller hands to `runAgent(…, outputSchema)`.
// Agents without a declared schema return null; runAgent's schema param is
// optional, so those agents terminate via end_turn with plain text.
//
// Phase F: the legacy `growth-strategist` agent was converted to the
// `generating-strategy` fork-mode skill (src/skills/generating-strategy/);
// its terminal output schema lives at
// `@/skills/generating-strategy/schema.ts` and is consumed by
// `runForkSkill` callers, not via this registry.
//
// Phase J Task 2: the legacy `post-writer` agent was deleted —
// content_post drafting is now batched into content-manager(post_batch)
// at the plan-execute-sweeper level. content-manager's terminal output
// schema covers both reply_sweep and post_batch flows.

import type { ZodType } from 'zod';
import { coordinatorOutputSchema } from './agents/coordinator/schema';
import { contentPlannerOutputSchema } from './agents/content-planner/schema';
import {
  contentManagerOutputSchema,
  // Back-compat alias — kept exported below for callers that haven't
  // migrated their import names yet.
  communityManagerOutputSchema,
} from './agents/content-manager/schema';
import { discoveryAgentOutputSchema } from './agents/discovery-agent/schema';

const registry: Record<string, ZodType<unknown>> = {
  coordinator: coordinatorOutputSchema as ZodType<unknown>,
  'content-planner': contentPlannerOutputSchema as ZodType<unknown>,
  'content-manager': contentManagerOutputSchema as ZodType<unknown>,
  'discovery-agent': discoveryAgentOutputSchema as ZodType<unknown>,
};

/**
 * Look up the terminal-output Zod schema for an AGENT.md-loaded agent by
 * its `name` (the `agent_type` column on `team_members`). Returns null
 * when no schema is registered — runAgent treats that as "no forced
 * structured output".
 */
export function getAgentOutputSchema(agentType: string): ZodType<unknown> | null {
  return registry[agentType] ?? null;
}

export {
  coordinatorOutputSchema,
  contentPlannerOutputSchema,
  contentManagerOutputSchema,
  // Re-exported for back-compat — points at the same Zod schema.
  communityManagerOutputSchema,
  discoveryAgentOutputSchema,
};
