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

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  coordinator: 'Team Lead',
  'social-media-manager': 'Content Specialist',
};

export function publicAgentLabel(rawType: string | null | undefined): string {
  if (!rawType) return 'agent';
  return AGENT_DISPLAY_NAMES[rawType] ?? 'agent';
}

export function publicSkillLabel(_rawName: string | null | undefined): string {
  return 'skill';
}

const MAX_DESCRIPTION_LEN = 200;

interface NormalizedKeys {
  toolUseIdKey: 'tool_use_id' | 'toolUseId' | null;
  toolNameKey: 'tool_name' | 'toolName' | null;
  toolInputKey: 'tool_input' | 'toolInput' | null;
  parentKey: 'parent_tool_use_id' | 'parentToolUseId' | null;
  agentKey: 'agent_name' | 'agentName' | null;
}

function detectKeys(meta: Record<string, unknown>): NormalizedKeys {
  return {
    toolUseIdKey:
      'tool_use_id' in meta ? 'tool_use_id' : 'toolUseId' in meta ? 'toolUseId' : null,
    toolNameKey:
      'tool_name' in meta ? 'tool_name' : 'toolName' in meta ? 'toolName' : null,
    toolInputKey:
      'tool_input' in meta ? 'tool_input' : 'toolInput' in meta ? 'toolInput' : null,
    parentKey:
      'parent_tool_use_id' in meta
        ? 'parent_tool_use_id'
        : 'parentToolUseId' in meta
          ? 'parentToolUseId'
          : null,
    agentKey:
      'agent_name' in meta ? 'agent_name' : 'agentName' in meta ? 'agentName' : null,
  };
}

function redactToolInput(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.description === 'string') {
    out.description = r.description.slice(0, MAX_DESCRIPTION_LEN);
  }
  if (typeof r.subagent_type === 'string') {
    out.subagent_type = publicAgentLabel(r.subagent_type);
  }
  return out;
}

export function redactMetadataForClient(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;
  const keys = detectKeys(metadata);
  const out: Record<string, unknown> = {};

  if (keys.toolUseIdKey) out[keys.toolUseIdKey] = metadata[keys.toolUseIdKey];
  if (keys.toolNameKey) {
    out[keys.toolNameKey] = publicToolLabel(metadata[keys.toolNameKey] as string);
  }
  if (keys.toolInputKey) {
    out[keys.toolInputKey] = redactToolInput(metadata[keys.toolInputKey]);
  }
  if (keys.parentKey) out[keys.parentKey] = metadata[keys.parentKey];
  if (keys.agentKey) {
    out[keys.agentKey] = publicAgentLabel(metadata[keys.agentKey] as string);
  }

  // Pass-through scalars (no IP value).
  if ('is_error' in metadata) out.is_error = metadata.is_error;
  if ('duration_ms' in metadata) out.duration_ms = metadata.duration_ms;
  if ('trigger' in metadata) out.trigger = metadata.trigger;

  return out;
}

interface AnthropicBlock {
  type: string;
  [key: string]: unknown;
}

function redactBlock(block: AnthropicBlock): AnthropicBlock {
  if (block.type === 'tool_use') {
    return {
      type: 'tool_use',
      id: block.id,
      name: publicToolLabel(block.name as string),
      input: redactToolInput(block.input),
    };
  }
  if (block.type === 'tool_result') {
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      is_error: block.is_error ?? false,
      content: '[redacted]',
    };
  }
  // text, image, document, etc. — pass through
  return block;
}

export function redactContentBlocksForClient(blocks: unknown): unknown {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) =>
    typeof b === 'object' && b !== null ? redactBlock(b as AnthropicBlock) : b,
  );
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
