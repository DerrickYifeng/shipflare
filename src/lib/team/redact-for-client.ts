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

const TOOL_LABEL_MAP: Record<string, PublicToolLabel> = {
  // Platform actions
  x_post: 'posting',
  reddit_post: 'posting',
  reddit_submit_post: 'posting',
  reddit_verify: 'verifying',
  reddit_search: 'searching',
  x_get_mentions: 'monitoring',
  x_get_tweet: 'reading-history',

  // AI vendor binding — hide xai
  xai_find_customers: 'searching',
  find_threads_via_xai: 'searching',
  find_threads: 'searching',

  // Internal queries
  query_strategic_path: 'reading-plan',
  query_plan_items: 'reading-plan',
  query_product_context: 'reading-context',
  query_recent_milestones: 'reading-context',
  query_team_status: 'reading-team',
  query_metrics: 'reading-metrics',
  query_stalled_items: 'reading-metrics',
  query_recent_x_posts: 'reading-history',

  // Plan editing
  add_plan_item: 'planning',
  update_plan_item: 'planning',
  write_strategic_path: 'planning',
  generate_strategic_path: 'planning',

  // Content
  draft_post: 'drafting',
  draft_reply: 'drafting',
  validate_draft: 'reviewing',

  // Pipeline
  process_posts_batch: 'batching',
  process_replies_batch: 'batching',
  persist_queue_threads: 'queueing',

  // Memory
  read_memory: 'reading-context',

  // Meta tools (low IP, normalized)
  Task: 'delegating',
  SendMessage: 'messaging',
  Sleep: 'sleeping',
  TaskStop: 'cancelling',
  StructuredOutput: 'tool',
  SyntheticOutput: 'tool',
};

export function publicToolLabel(rawName: string | null | undefined): PublicToolLabel {
  if (!rawName) return 'tool';
  if (rawName === 'skill' || rawName.startsWith('skill_')) return 'skill';
  return TOOL_LABEL_MAP[rawName] ?? 'tool';
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
