/**
 * Redaction helpers for the team_messages → client trust boundary.
 *
 * Why: team_messages rows persist raw tool_name / tool_input / tool_output
 * for worker correctness (nested Task() calls, history replay). Those fields
 * leak the multi-agent architecture, AI vendor choices, and proprietary
 * playbook prompts to any paid user who opens DevTools. This module strips
 * them at the API boundary while preserving the founder-facing UI signal
 * (semantic tool labels, friendly agent names, public summaries).
 *
 * All functions are pure: no DB, no I/O, no globals.
 */

export type PublicToolLabel = string;

export function publicToolLabel(_rawName: string | null | undefined): PublicToolLabel {
  throw new Error('not implemented');
}

export function publicAgentLabel(_rawType: string | null | undefined): string {
  throw new Error('not implemented');
}

export function publicSkillLabel(_rawName: string | null | undefined): string {
  throw new Error('not implemented');
}

export function redactMetadataForClient(
  _metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  throw new Error('not implemented');
}

export function redactContentBlocksForClient(_blocks: unknown): unknown {
  throw new Error('not implemented');
}

export interface MessageRowForClient {
  id: string;
  runId: string | null;
  teamId: string;
  conversationId?: string | null;
  fromMemberId?: string | null;
  toMemberId?: string | null;
  fromAgentId?: string | null;
  toAgentId?: string | null;
  type: string;
  messageType?: string;
  content: string | null;
  contentBlocks?: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: Date | string;
}

export function redactMessageRowForClient<T extends MessageRowForClient>(_row: T): T {
  throw new Error('not implemented');
}
