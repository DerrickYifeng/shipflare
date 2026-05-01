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

import type { ZodType } from 'zod';
import { coordinatorOutputSchema } from './agents/coordinator/schema';
import { growthStrategistOutputSchema } from './agents/growth-strategist/schema';
import { contentPlannerOutputSchema } from './agents/content-planner/schema';
import { postWriterOutputSchema } from './agents/post-writer/schema';
import { communityManagerOutputSchema } from './agents/community-manager/schema';
import { postingOutputSchema } from './agents/posting/schema';
import { discoveryAgentOutputSchema } from './agents/discovery-agent/schema';

const registry: Record<string, ZodType<unknown>> = {
  coordinator: coordinatorOutputSchema as ZodType<unknown>,
  'growth-strategist': growthStrategistOutputSchema as ZodType<unknown>,
  'content-planner': contentPlannerOutputSchema as ZodType<unknown>,
  'post-writer': postWriterOutputSchema as ZodType<unknown>,
  'community-manager': communityManagerOutputSchema as ZodType<unknown>,
  posting: postingOutputSchema as ZodType<unknown>,
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
  growthStrategistOutputSchema,
  contentPlannerOutputSchema,
  postWriterOutputSchema,
  communityManagerOutputSchema,
  postingOutputSchema,
  discoveryAgentOutputSchema,
};
