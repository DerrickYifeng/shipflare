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

export type PublicToolLabel =
  | 'searching' | 'searching-web' | 'drafting' | 'reviewing' | 'posting' | 'planning'
  | 'reading-plan' | 'reading-context' | 'reading-page' | 'reading-team' | 'reading-metrics'
  | 'reading-history' | 'monitoring' | 'verifying' | 'batching' | 'queueing'
  | 'delegating' | 'messaging' | 'sleeping' | 'cancelling' | 'skill' | 'tool';

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
  query_code_changes: 'reading-context',
  web_search: 'searching-web',
  web_fetch: 'reading-page',
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
  'social-media-manager': 'Social Media Manager',
};

export function publicAgentLabel(rawType: string | null | undefined): string {
  if (!rawType) return 'agent';
  return AGENT_DISPLAY_NAMES[rawType] ?? 'agent';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- skill gerund names are intentionally hidden; the parameter exists to document accepted input type
export function publicSkillLabel(_rawName: string | null | undefined): string {
  return 'skill';
}

const MAX_DESCRIPTION_LEN = 200;

/**
 * Triggers that mean the founder typed this message themselves.
 * Content for these rows displays verbatim — must NOT be replaced
 * with a friendly default, because the user's own input is the
 * point. Allowlist; everything else is treated as internal automation.
 */
const USER_FACING_TRIGGERS = new Set<string>(['conversation_message']);

/**
 * Default founder-friendly content for known internal triggers when
 * `metadata.publicContent` isn't set. Defense in depth: any new caller
 * that forgets `publicSummary`, plus historical rows from before
 * publicSummary support was added, fall back to one of these instead
 * of leaking the raw goal text.
 */
const TRIGGER_DEFAULTS: Record<string, string> = {
  kickoff: 'Building your first-week plan and drafting your first reply candidates.',
  phase_transition: 'Updating your strategy for the new product phase.',
  daily: 'Running your daily automation.',
  weekly: 'Running your weekly automation.',
  onboarding: 'Working through onboarding.',
  task_retry: 'Retrying a previously failed task.',
};

/**
 * The fallback when a row has an unknown internal trigger and no
 * publicContent. Generic enough to be useful, vague enough to not
 * fingerprint the system.
 */
const UNKNOWN_INTERNAL_TRIGGER_DEFAULT = 'Working on automated work.';

interface NormalizedKeys {
  toolUseIdKey: 'tool_use_id' | 'toolUseId' | null;
  toolNameKey: 'tool_name' | 'toolName' | null;
  toolInputKey: 'tool_input' | 'toolInput' | null;
  parentKey: 'parent_tool_use_id' | 'parentToolUseId' | null;
  agentKey: 'agent_name' | 'agentName' | null;
}

/**
 * Detects which casing variant of each metadata key is present.
 *
 * Priority: snake_case > camelCase. If a row has both `tool_name` and
 * `toolName`, the snake_case value wins (canonical DB column name).
 * The other variant is silently dropped.
 */
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
  // Rename `subagent_type` → `agent` on the wire. The raw key reveals
  // Anthropic's Task tool primitive; `agent` is a founder-friendly
  // shape that doesn't fingerprint the underlying SDK.
  if (typeof r.subagent_type === 'string') {
    out.agent = publicAgentLabel(r.subagent_type);
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

  // Pass-through scalars: low-IP values needed by founder UI grouping.
  // trigger is an enum like 'kickoff' | 'daily' | 'weekly' — no architectural detail.
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

/**
 * Given a row's metadata, return the founder-friendly content if one
 * applies (publicContent override OR internal-trigger fallback). Returns
 * null if the row's own content should be displayed verbatim
 * (assistant/tool turns OR user-facing triggers like
 * `conversation_message`).
 *
 * Exported so the transcript history loader can apply the same swap
 * rule when projecting `Anthropic.MessageParam` shape — the loader
 * builds messages directly from rows without going through
 * `redactMessageRowForClient`, so without this helper it would
 * silently bypass the kickoff override.
 */
export function resolveOverrideContent(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const publicContent =
    typeof metadata.publicContent === 'string' ? metadata.publicContent : null;
  if (publicContent) return publicContent;
  const trigger =
    typeof metadata.trigger === 'string' ? metadata.trigger : null;
  if (trigger && !USER_FACING_TRIGGERS.has(trigger)) {
    return TRIGGER_DEFAULTS[trigger] ?? UNKNOWN_INTERNAL_TRIGGER_DEFAULT;
  }
  return null;
}

export function redactMessageRowForClient<T extends MessageRowForClient>(row: T): T {
  const meta = row.metadata ?? null;
  const override = resolveOverrideContent(meta);

  const resolvedContent: string | null = override ?? row.content;

  // When `content` is replaced (kickoff / internal-trigger fallback /
  // explicit publicContent), the `contentBlocks` array would otherwise
  // still carry the raw goal text — `dispatchLeadMessage` writes BOTH
  // `content` AND `contentBlocks: [{ type: 'text', text: <goal> }]`,
  // so a UI consumer that prefers contentBlocks (e.g., transcript
  // assembly that hands rows straight to Anthropic.MessageParam) would
  // see the raw text. Synthesize a single text block matching the
  // redacted content so both shapes carry the same swapped value.
  let resolvedContentBlocks: unknown;
  if (override !== null) {
    resolvedContentBlocks = [{ type: 'text', text: override }];
  } else if (row.contentBlocks) {
    resolvedContentBlocks = redactContentBlocksForClient(row.contentBlocks);
  } else {
    resolvedContentBlocks = row.contentBlocks;
  }

  return {
    ...row,
    content: resolvedContent,
    contentBlocks: resolvedContentBlocks,
    metadata: redactMetadataForClient(meta),
  };
}
