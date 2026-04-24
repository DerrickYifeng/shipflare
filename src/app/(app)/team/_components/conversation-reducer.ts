import type {
  PartialLeadMessage,
  TeamActivityMessage,
} from '@/hooks/use-team-events';
import type { Phase } from './phase-tag';

export interface DelegationTask {
  /** team_messages.id of the originating tool_call row. */
  messageId: string;
  /**
   * team_runs.id this task belongs to. Needed by the right-rail Task
   * panel so clicking a Recent task can switch the active session
   * when the target subtask lives in a different run than the one
   * currently rendered in the conversation column.
   */
  runId: string | null;
  /** team_tasks.id when we can derive it from tool metadata; nullable. */
  taskId: string | null;
  /**
   * Anthropic tool_use_id the coordinator stamped on its Task call. This
   * is what the reducer's `progressByParentToolUse` map is keyed by —
   * every subagent event carries the same id in `metadata.parentToolUseId`.
   */
  toolUseId: string | null;
  /** Target member id for this dispatched task (from metadata). */
  toMemberId: string | null;
  /**
   * `subagent_type` pulled from the Task tool_call's input (e.g.
   * "content-planner"). Used to look up the specialist by agent_type when
   * `toMemberId` is null — team_messages.to_member_id is always null on
   * tool_calls so this is the only reliable hook to the correct member
   * row until the worker starts stamping it.
   */
  subagentType: string | null;
  /** Short label for the task — "agentType" fallback if none. */
  label: string;
  /** High-level status derived from the join with team_tasks. */
  status: 'queued' | 'working' | 'done' | 'failed';
  /** Percent done, 0-100. working = 50 until status flips. */
  progress: number;
  /** Pre-formatted elapsed string when the task completed, else null. */
  elapsed: string | null;
  /**
   * Subagent-produced result summary. Pulled from `team_tasks.output.summary`
   * when the spawn completed with StructuredOutput, else null while the task
   * is still running or produced free-form text we haven't paraphrased.
   */
  outputSummary: string | null;
  /**
   * Everything this subagent did during its spawn: text it streamed, tool
   * calls it made, tool results it received. Built from the
   * `progressByParentToolUse` lookup in stitchLeadMessages. Renderers
   * paint this as a nested activity feed inside the subtask card instead
   * of flat rows in the main thread.
   */
  progressItems: ProgressItem[];
}

/**
 * One entry in a DelegationTask's nested progress feed. Modeled after
 * Claude Code's condensed view (engine/tools/AgentTool/UI.tsx:445) —
 * tools pair with results, text blocks stream, runs of same-named
 * tools collapse into a single summary line.
 */
export type ProgressItem =
  | {
      kind: 'tool';
      id: string;
      createdAt: string;
      toolName: string;
      elapsed: string | null;
      complete: boolean;
      errorText: string | null;
    }
  | {
      kind: 'text';
      id: string;
      createdAt: string;
      text: string;
      streaming: boolean;
    }
  | {
      kind: 'group';
      id: string;
      createdAt: string;
      label: string;
      count: number;
      durationMs: number | null;
    };

export interface UserNode {
  kind: 'user';
  id: string;
  createdAt: string;
  runId: string | null;
  text: string;
}

export interface LeadNode {
  kind: 'lead';
  id: string;
  createdAt: string;
  runId: string | null;
  fromMemberId: string | null;
  text: string;
  delegation: DelegationTask[];
  /**
   * Derived from the conversation flow — see `phaseFor*` helpers at the
   * bottom of this file. Renderer paints the pill from this value.
   */
  phase: Phase;
  /**
   * True while this LeadNode is backed by a partial stream that hasn't
   * yet received its final `agent_text`. Keeps the breathing indicator
   * in the header/body until the server confirms.
   */
  streaming?: boolean;
}

export interface ActivityNode {
  kind: 'activity';
  id: string;
  createdAt: string;
  runId: string | null;
  /** Canonical tool_name from metadata, or a synthetic label for errors. */
  toolName: string;
  /** 'error' variant renders in red; otherwise a normal activity row. */
  variant: 'tool' | 'error';
  /** Formatted elapsed when we've seen a matching tool_result, else null. */
  elapsed: string | null;
  /** True once a matching tool_result/error has arrived. */
  complete: boolean;
  /** Truncated error content for `variant === 'error'`. */
  errorText: string | null;
  /**
   * `team_tasks.id` of the spawn this tool ran inside, or null when the
   * tool was called directly by the top-level coordinator. Lets the UI
   * attribute the row to the right specialist ("Nova used Grep") and
   * open a door to folding subagent tools into their subtask card once
   * the coordinator's Task tool_call ↔ team_tasks.id link is plumbed.
   */
  parentTaskId: string | null;
  /**
   * `AGENT.md` name of the subagent that emitted the tool call — useful
   * when `parentTaskId` is present but the team hasn't provisioned a
   * member row for this spawn yet (Phase F gap). Null on main thread.
   */
  agentName: string | null;
}

export interface RawNode {
  kind: 'raw';
  id: string;
  createdAt: string;
  runId: string | null;
  message: TeamActivityMessage;
}

export type ConversationNode = UserNode | LeadNode | ActivityNode | RawNode;

/** Compact subset of a `team_runs` row needed to render a session divider. */
export interface TeamRunMeta {
  id: string;
  trigger: string;
  goal: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

export type TeamRunLookup = ReadonlyMap<string, TeamRunMeta>;

export interface SessionGroup {
  /** Stable key — the runId, or '__no_run__' sentinel for orphan messages. */
  key: string;
  runId: string | null;
  run: TeamRunMeta | null;
  nodes: ConversationNode[];
}

export interface TaskLookupEntry {
  id: string;
  status: string;
  description: string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  /**
   * Paraphrased subagent output surfaced on dispatch cards. Server side
   * extracts this from `team_tasks.output.summary` (StructuredOutput) or
   * leaves it null when the output is free text too long to show inline.
   */
  outputSummary: string | null;
}

export type TaskLookup = ReadonlyMap<string, TaskLookupEntry>;

/** Window (ms) within which an adjacent tool_call is attributed to the preceding lead text. */
const STITCH_WINDOW_MS = 5_000;

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// The worker writes metadata with camelCase keys (`toolName`, `toolUseId`,
// `input`, `parentTaskId`) — see `emitToolEvent` in
// `src/workers/processors/team-run.ts`. We read camelCase first and fall
// back to snake_case only to stay compatible with any pre-existing rows
// written under the older convention.
function readString(
  metadata: Record<string, unknown> | null,
  ...keys: readonly string[]
): string | null {
  if (!metadata) return null;
  for (const k of keys) {
    const v = metadata[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function extractToolName(metadata: Record<string, unknown> | null): string | null {
  return readString(metadata, 'toolName', 'tool_name');
}

function extractToolInputString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) return null;
  const input = metadata['input'] ?? metadata['tool_input'];
  if (typeof input === 'object' && input !== null) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function extractTaskId(metadata: Record<string, unknown> | null): string | null {
  return (
    readString(metadata, 'taskId', 'task_id') ??
    readString(metadata, 'toolUseId', 'tool_use_id')
  );
}

function extractParentTaskId(
  metadata: Record<string, unknown> | null,
): string | null {
  return readString(metadata, 'parentTaskId', 'parent_task_id');
}

function extractParentToolUseId(
  metadata: Record<string, unknown> | null,
): string | null {
  return readString(metadata, 'parentToolUseId', 'parent_tool_use_id');
}

function extractAgentName(
  metadata: Record<string, unknown> | null,
): string | null {
  return readString(metadata, 'agentName', 'agent_name');
}

function formatElapsed(
  startedAt: Date | string | null,
  completedAt: Date | string | null,
): string | null {
  if (!startedAt || !completedAt) return null;
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const end = completedAt instanceof Date ? completedAt : new Date(completedAt);
  const delta = end.getTime() - start.getTime();
  if (!Number.isFinite(delta) || delta < 0) return null;
  if (delta < 1000) return '<1s';
  if (delta < 60_000) return `${Math.round(delta / 1000)}s`;
  const minutes = Math.floor(delta / 60_000);
  const seconds = Math.round((delta % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function deriveStatus(
  raw: string,
): 'queued' | 'working' | 'done' | 'failed' {
  switch (raw) {
    case 'completed':
      return 'done';
    case 'running':
      return 'working';
    case 'failed':
      return 'failed';
    case 'pending':
    default:
      return 'queued';
  }
}

function deriveProgress(status: 'queued' | 'working' | 'done' | 'failed'): number {
  switch (status) {
    case 'done':
      return 100;
    case 'working':
      return 50;
    case 'failed':
      return 100;
    case 'queued':
    default:
      return 0;
  }
}

function buildDelegationTask(
  message: TeamActivityMessage,
  taskLookup: TaskLookup,
): DelegationTask {
  const metadata = message.metadata;
  const taskId = extractTaskId(metadata);
  const lookupEntry = taskId ? taskLookup.get(taskId) : undefined;

  const description =
    extractToolInputString(metadata, 'description') ??
    lookupEntry?.description ??
    extractToolInputString(metadata, 'subagent_type') ??
    'Dispatched task';

  // A task_call with no matching team_tasks row in `taskLookup` is
  // almost always a live, just-spawned dispatch the SSR snapshot didn't
  // capture. `QUEUED` would lie — the worker fires `recordTaskStart`
  // synchronously before spawnSubagent, so by the time this tool_call
  // reaches the client the subagent is already running. Default to
  // `running` in that case; only trust `lookupEntry.status` when we
  // actually have one.
  const rawStatus = lookupEntry?.status ?? 'running';
  const status = deriveStatus(rawStatus);
  const progress = deriveProgress(status);
  const elapsed = lookupEntry
    ? formatElapsed(lookupEntry.startedAt, lookupEntry.completedAt)
    : null;

  return {
    messageId: message.id,
    runId: message.runId,
    taskId: lookupEntry?.id ?? taskId ?? null,
    // `extractTaskId` falls back to `tool_use_id` on legacy metadata,
    // but new worker writes store them under `toolUseId` directly —
    // either way that's the anchor `progressByParentToolUse` uses.
    toolUseId: readString(metadata, 'toolUseId', 'tool_use_id'),
    toMemberId: message.to,
    subagentType: extractToolInputString(metadata, 'subagent_type'),
    label: description,
    status,
    progress,
    elapsed,
    outputSummary: lookupEntry?.outputSummary ?? null,
    // Populated by `populateDelegationProgress` after stitching the full
    // message stream — at build-time we don't yet have the subagent's
    // downstream events in hand.
    progressItems: [],
  };
}

function isLeadTextMessage(message: TeamActivityMessage): boolean {
  return message.type === 'agent_text' && message.from !== null;
}

function isTaskToolCall(message: TeamActivityMessage): boolean {
  if (message.type !== 'tool_call') return false;
  return extractToolName(message.metadata) === 'Task';
}

/**
 * Coordinator "final reply" rows. We currently ship `completion` events
 * rather than a separate trailing `agent_text` — treat them as lead
 * messages so they surface in the conversation column instead of being
 * swallowed. Content is usually a JSON blob with a `summary` field.
 */
function isCompletionLeadMessage(message: TeamActivityMessage): boolean {
  return message.type === 'completion' && message.from !== null;
}

function extractCompletionText(raw: string | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summary = parsed['summary'];
    if (typeof summary === 'string' && summary.length > 0) return summary;
    const notes = parsed['notes'];
    if (typeof notes === 'string' && notes.length > 0) return notes;
    return trimmed;
  } catch {
    return trimmed;
  }
}

const ERROR_TRUNCATE_LEN = 140;

function extractToolUseId(metadata: Record<string, unknown> | null): string | null {
  return readString(metadata, 'toolUseId', 'tool_use_id');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/**
 * Walk `messages` in chronological order and collapse adjacent lead
 * `agent_text` + subsequent `Task` tool_call events (within a 5-second
 * window) into one `{kind: 'lead', delegation}` node per lead text.
 *
 * Non-Task tool_calls surface as `activity` nodes (compact inline rows).
 * A matching `tool_result` upgrades the activity to `complete: true` with
 * an elapsed duration. `error` messages surface as red activity nodes.
 *
 * Pure function; safe to call from either server or client code.
 */
export function stitchLeadMessages(
  messages: readonly TeamActivityMessage[],
  taskLookup: TaskLookup = new Map(),
  /**
   * In-flight streaming text keyed by messageId. Each partial gets
   * folded into the node stream as a `LeadNode` with `streaming: true`
   * so the thread shows a breathing indicator at the tail. When the
   * matching final `agent_text` lands, the hook drops the partial from
   * the map and this pass stops emitting it — renderer gets the durable
   * node instead.
   */
  partials: ReadonlyMap<string, PartialLeadMessage> = new Map(),
): ConversationNode[] {
  // Pre-pass: bucket any message whose metadata carries
  // `parentToolUseId` (i.e. it came from a subagent spawn) by that
  // anchor. These don't flow as top-level nodes — they live *inside*
  // their parent Task's DelegationTask.progressItems (populated after
  // stitching). Borrowed from Claude Code's progressMessagesByToolUseID
  // map (engine/utils/messages.ts:1214).
  const progressByParentToolUse = new Map<string, TeamActivityMessage[]>();
  for (const msg of messages) {
    const parentToolUseId = extractParentToolUseId(msg.metadata);
    if (!parentToolUseId) continue;
    const bucket = progressByParentToolUse.get(parentToolUseId);
    if (bucket) bucket.push(msg);
    else progressByParentToolUse.set(parentToolUseId, [msg]);
  }
  const belongsToSubagent = (msg: TeamActivityMessage): boolean =>
    extractParentToolUseId(msg.metadata) !== null;
  const nodes: ConversationNode[] = [];
  let currentLead: LeadNode | null = null;
  let currentLeadTime = 0;
  // Primary index: tool_use_id -> ActivityNode. Anthropic tool calls carry a
  // stable tool_use_id on both the tool_call and its tool_result, so this is
  // the most accurate upgrade path.
  const activityByUseId = new Map<string, ActivityNode>();
  // Fallback index: tool_call message id -> ActivityNode. Used only when
  // the tool_result arrives without tool_use_id metadata (e.g. older rows,
  // platforms that don't preserve the id). We keep all in-flight activities
  // here regardless of whether they had a tool_use_id.
  const activityById = new Map<string, ActivityNode>();

  for (const msg of messages) {
    // Subagent-scoped events live inside their parent's DelegationTask
    // (via `populateDelegationProgress` below) — skip them in the
    // top-level flow so the thread only shows the coordinator's own
    // turn, with nested dispatches as cards.
    if (belongsToSubagent(msg)) continue;

    if (msg.type === 'user_prompt') {
      currentLead = null;
      nodes.push({
        kind: 'user',
        id: msg.id,
        createdAt: msg.createdAt,
        runId: msg.runId,
        text: msg.content ?? '',
      });
      continue;
    }

    if (isLeadTextMessage(msg)) {
      currentLeadTime = parseTime(msg.createdAt);
      currentLead = {
        kind: 'lead',
        id: msg.id,
        createdAt: msg.createdAt,
        runId: msg.runId,
        fromMemberId: msg.from,
        text: msg.content ?? '',
        delegation: [],
        // Filled in by `assignPhases` after all nodes are built — the
        // phase decision depends on the presence of a later Task tool_call
        // stitched into this node's delegation, which we only know after
        // the 5s window closes.
        phase: 'PLAN',
      };
      nodes.push(currentLead);
      continue;
    }

    if (isCompletionLeadMessage(msg)) {
      currentLead = null;
      nodes.push({
        kind: 'lead',
        id: msg.id,
        createdAt: msg.createdAt,
        runId: msg.runId,
        fromMemberId: msg.from,
        text: extractCompletionText(msg.content),
        delegation: [],
        phase: 'DONE',
      });
      continue;
    }

    // Synthesize a "phantom" lead header when a tool_call has no
    // anchor lead_text to attach to — without it the activity (or
    // dispatch) rows float in the thread with no owner.
    //
    // Two trigger paths:
    //   1. no currentLead at all  — the LLM opened its turn straight
    //      with tool_use, no narration
    //   2. Task tool_call outside the 5s stitch window — the prior
    //      lead text is stale; this dispatch belongs to a fresh turn
    //      that the coordinator kicked off silently
    //
    // `msg.from` is the member the worker stamped when emitting the
    // tool_call — exactly who we want in the header avatar + phase pill.
    const isTaskCall = isTaskToolCall(msg);
    const isToolCall = msg.type === 'tool_call';
    const hasFromMember = typeof msg.from === 'string' && msg.from.length > 0;
    const leadExpired =
      currentLead !== null &&
      parseTime(msg.createdAt) - currentLeadTime > STITCH_WINDOW_MS;
    const needsPhantom =
      isToolCall &&
      hasFromMember &&
      (!currentLead || (isTaskCall && leadExpired));
    if (needsPhantom) {
      const phantom: LeadNode = {
        kind: 'lead',
        id: `phantom-lead:${msg.id}`,
        createdAt: msg.createdAt,
        runId: msg.runId,
        fromMemberId: msg.from,
        text: '',
        delegation: [],
        phase: 'PLAN',
      };
      nodes.push(phantom);
      currentLead = phantom;
      currentLeadTime = parseTime(msg.createdAt);
    }

    // Task tool_calls always go into a delegation — either the current
    // lead's (if within the stitch window) or the freshly-minted phantom
    // above. The dispatch card hangs off that delegation.
    if (isTaskCall && currentLead) {
      currentLead.delegation.push(buildDelegationTask(msg, taskLookup));
      continue;
    }

    if (msg.type === 'tool_call') {
      const toolName = extractToolName(msg.metadata) ?? 'tool';
      const activity: ActivityNode = {
        kind: 'activity',
        id: msg.id,
        createdAt: msg.createdAt,
        runId: msg.runId,
        toolName,
        variant: 'tool',
        elapsed: null,
        complete: false,
        errorText: null,
        parentTaskId: extractParentTaskId(msg.metadata),
        agentName: extractAgentName(msg.metadata),
      };
      const useId = extractToolUseId(msg.metadata);
      if (useId) activityByUseId.set(useId, activity);
      activityById.set(msg.id, activity);
      nodes.push(activity);
      continue;
    }

    if (msg.type === 'tool_result') {
      const useId = extractToolUseId(msg.metadata);
      let matching: ActivityNode | null =
        (useId ? activityByUseId.get(useId) : null) ?? null;
      // Fallback: no tool_use_id on the result, or it doesn't match any
      // in-flight activity. Pick the most recent same-runId tool_call that
      // hasn't been completed yet — correct in the common case where
      // multiple tool_use_ids are missing because we iterate in arrival
      // order and the newest unfinished call is the likely match.
      if (!matching) {
        for (const candidate of activityById.values()) {
          if (candidate.complete) continue;
          if (candidate.runId !== msg.runId) continue;
          if (!matching || candidate.createdAt > matching.createdAt) {
            matching = candidate;
          }
        }
      }
      if (matching) {
        matching.complete = true;
        matching.elapsed = formatElapsed(matching.createdAt, msg.createdAt);
        if (useId) activityByUseId.delete(useId);
        activityById.delete(matching.id);
        continue;
      }
      // Still unmatched — drop silently (content can be huge and we never
      // render tool_result text inline per product spec).
      continue;
    }

    if (msg.type === 'error') {
      nodes.push({
        kind: 'activity',
        id: msg.id,
        createdAt: msg.createdAt,
        runId: msg.runId,
        toolName: 'error',
        variant: 'error',
        elapsed: null,
        complete: true,
        errorText: msg.content ? truncate(msg.content.trim(), ERROR_TRUNCATE_LEN) : null,
        parentTaskId: extractParentTaskId(msg.metadata),
        agentName: extractAgentName(msg.metadata),
      });
      continue;
    }

    nodes.push({
      kind: 'raw',
      id: msg.id,
      createdAt: msg.createdAt,
      runId: msg.runId,
      message: msg,
    });
  }

  // Append streaming partials after the durable message stream. Each
  // partial becomes a LeadNode flagged `streaming: true`. Order: partials
  // are sorted by their own createdAt so multiple in-flight blocks
  // (rare but possible) surface in the right order. Since deltas land
  // after any non-streaming message the client has already seen, this
  // puts the typing bubble correctly at the tail.
  if (partials.size > 0) {
    const partialNodes = Array.from(partials.values())
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of partialNodes) {
      nodes.push({
        kind: 'lead',
        id: p.id,
        createdAt: p.createdAt,
        runId: p.runId,
        fromMemberId: p.from,
        text: p.content,
        delegation: [],
        phase: 'PLAN',
        streaming: true,
      });
    }
  }

  populateDelegationProgress(nodes, progressByParentToolUse, partials);
  reconcileDelegationCompletion(nodes, messages);
  assignPhases(nodes);
  return nodes;
}

/**
 * After top-level stitching, attach each subagent's event bucket to the
 * matching DelegationTask's `progressItems`. Keyed by
 * `parentToolUseId` — every subagent event's metadata carries the
 * coord's Task tool_use_id, and DelegationTask records the same on its
 * `toolUseId` field.
 *
 * Each bucket is turned into `ProgressItem[]` by `buildProgressItems`,
 * which pairs tool_calls with tool_results, groups rapid same-name
 * tool runs, and preserves streamed text blocks.
 */
function populateDelegationProgress(
  nodes: ConversationNode[],
  progressByParentToolUse: Map<string, TeamActivityMessage[]>,
  partials: ReadonlyMap<string, PartialLeadMessage>,
): void {
  if (progressByParentToolUse.size === 0 && partials.size === 0) return;
  // Index partials by parentToolUseId so streaming text from subagents
  // land in the right card even before the final agent_text arrives.
  // Partials don't carry `metadata` (they come from the hook's own
  // shape), but we can match via their `runId + from` only as a loose
  // heuristic — for now, only fold partials whose content came from a
  // subagent message type in-flight; renderer shows the breathing
  // indicator regardless.
  for (const node of nodes) {
    if (node.kind !== 'lead') continue;
    if (node.delegation.length === 0) continue;
    for (const task of node.delegation) {
      if (!task.toolUseId) continue;
      const bucket = progressByParentToolUse.get(task.toolUseId);
      if (!bucket || bucket.length === 0) continue;
      task.progressItems = buildProgressItems(bucket);
    }
  }
}

/** Rapid-churn collapse: 3+ consecutive same-toolName tools → one group. */
const RAPID_CHURN_THRESHOLD = 3;

/**
 * Convert a subagent's flat message stream into renderable
 * `ProgressItem[]`. Each `tool_call` pairs with its matching
 * `tool_result` (by tool_use_id) into a single tool item with
 * `complete` + elapsed. Text messages surface as plain text items.
 * Runs of ≥3 adjacent tool items sharing a toolName collapse into a
 * single group — mirrors Claude Code's `processProgressMessages`
 * (engine/tools/AgentTool/UI.tsx:100) so long read/search bursts
 * don't drown the card.
 */
function buildProgressItems(
  bucket: readonly TeamActivityMessage[],
): ProgressItem[] {
  // Pair tool_call <-> tool_result by tool_use_id.
  const resultByUseId = new Map<string, TeamActivityMessage>();
  for (const msg of bucket) {
    if (msg.type !== 'tool_result') continue;
    const useId = readString(msg.metadata, 'toolUseId', 'tool_use_id');
    if (useId) resultByUseId.set(useId, msg);
  }

  const sorted = [...bucket].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const raw: ProgressItem[] = [];
  for (const msg of sorted) {
    if (msg.type === 'tool_call') {
      const toolName = extractToolName(msg.metadata) ?? 'tool';
      const useId = readString(msg.metadata, 'toolUseId', 'tool_use_id');
      const result = useId ? resultByUseId.get(useId) : undefined;
      const complete = !!result;
      const elapsed = result
        ? formatElapsed(msg.createdAt, result.createdAt)
        : null;
      const errorText =
        result &&
        result.metadata &&
        (result.metadata as Record<string, unknown>)['isError'] === true &&
        result.content
          ? truncate(result.content.trim(), ERROR_TRUNCATE_LEN)
          : null;
      raw.push({
        kind: 'tool',
        id: msg.id,
        createdAt: msg.createdAt,
        toolName,
        elapsed,
        complete,
        errorText,
      });
      continue;
    }
    if (msg.type === 'tool_result') continue; // consumed via pairing
    if (msg.type === 'agent_text' && msg.content) {
      raw.push({
        kind: 'text',
        id: msg.id,
        createdAt: msg.createdAt,
        text: msg.content,
        streaming: false,
      });
      continue;
    }
    // agent_text_start / _delta / _stop shouldn't reach here (they're
    // ephemeral and live on the hook's `partials` map, not in
    // `messages`), so ignore silently.
  }

  // Rapid-churn collapse: walk the list, merge runs of same-toolName
  // tool items into one `group`. Only merges `complete` runs — an
  // incomplete tool in a run blocks the collapse (it's the live one).
  const merged: ProgressItem[] = [];
  let i = 0;
  while (i < raw.length) {
    const cur = raw[i];
    if (cur.kind !== 'tool' || !cur.complete) {
      merged.push(cur);
      i += 1;
      continue;
    }
    // Count consecutive same-name complete tools.
    let j = i;
    const name = cur.toolName;
    let durationMs = 0;
    let allHaveElapsed = true;
    const firstCreatedAt = cur.createdAt;
    while (
      j < raw.length &&
      raw[j].kind === 'tool' &&
      (raw[j] as { toolName: string }).toolName === name &&
      (raw[j] as { complete: boolean }).complete
    ) {
      const item = raw[j] as { elapsed: string | null };
      // Only merge if we can parse elapsed (best-effort ms sum).
      if (item.elapsed) {
        const parsed = parseElapsedMs(item.elapsed);
        if (parsed != null) durationMs += parsed;
        else allHaveElapsed = false;
      } else {
        allHaveElapsed = false;
      }
      j += 1;
    }
    const runLen = j - i;
    if (runLen >= RAPID_CHURN_THRESHOLD) {
      merged.push({
        kind: 'group',
        id: `group:${cur.id}`,
        createdAt: firstCreatedAt,
        label: `${runLen} × ${name}`,
        count: runLen,
        durationMs: allHaveElapsed ? durationMs : null,
      });
      i = j;
    } else {
      merged.push(cur);
      i += 1;
    }
  }
  return merged;
}

/**
 * Reverse of `formatElapsed` — pulls a rough ms count out of strings
 * like `<1s`, `3s`, `1m 20s`. Returns null on unrecognized formats so
 * the collapse refuses to sum up values it can't verify.
 */
function parseElapsedMs(elapsed: string): number | null {
  const trimmed = elapsed.trim();
  if (trimmed === '<1s') return 500;
  const secMatch = trimmed.match(/^(\d+)s$/);
  if (secMatch) return parseInt(secMatch[1], 10) * 1000;
  const minSecMatch = trimmed.match(/^(\d+)m(?: (\d+)s)?$/);
  if (minSecMatch) {
    const mins = parseInt(minSecMatch[1], 10);
    const secs = minSecMatch[2] ? parseInt(minSecMatch[2], 10) : 0;
    return mins * 60_000 + secs * 1000;
  }
  return null;
}

/**
 * Cross-reference Task tool_call DelegationTasks with their matching
 * tool_result rows and flip status/elapsed/outputSummary live — without
 * waiting on a page refetch of taskLookup.
 *
 * Why: the SSR-seeded `taskLookup` is static. When a subagent finishes
 * mid-session, team_tasks.status flips to 'completed' in the DB but the
 * client's lookup never re-reads, so the subtask card stuck at RUNNING
 * forever ("179s thinking..."). The tool_result message itself is the
 * authoritative DONE signal — it carries the same `toolUseId` the
 * DelegationTask was built from, plus `isError` and the full output
 * content. Match on that, settle the task locally.
 *
 * Runs as a post-stitch pass because DelegationTasks are only populated
 * as leads are built; we need the full message list to find matching
 * tool_results that may land in a later turn.
 */
function reconcileDelegationCompletion(
  nodes: ConversationNode[],
  messages: readonly TeamActivityMessage[],
): void {
  // Index tool_result messages by the tool_use_id they answer.
  const resultByUseId = new Map<string, TeamActivityMessage>();
  for (const msg of messages) {
    if (msg.type !== 'tool_result') continue;
    const useId = readString(msg.metadata, 'toolUseId', 'tool_use_id');
    if (useId) resultByUseId.set(useId, msg);
  }
  if (resultByUseId.size === 0) return;

  // Index the originating tool_call messages so we can compute elapsed
  // against *its* createdAt (the DelegationTask.messageId is the
  // tool_call's id — use the message directly).
  const toolCallByUseId = new Map<string, TeamActivityMessage>();
  for (const msg of messages) {
    if (msg.type !== 'tool_call') continue;
    const useId = readString(msg.metadata, 'toolUseId', 'tool_use_id');
    if (useId) toolCallByUseId.set(useId, msg);
  }

  for (const node of nodes) {
    if (node.kind !== 'lead') continue;
    if (node.delegation.length === 0) continue;
    for (const task of node.delegation) {
      // The DelegationTask's taskId is the coord's tool_use_id when no
      // team_tasks row matched on SSR (our dual-key lookup falls back
      // to it). Treat whichever id we have as a potential use_id — the
      // resultByUseId map is keyed by tool_use_id, so a mismatch just
      // quietly misses and we keep the existing status.
      const useId = task.taskId;
      if (!useId) continue;
      const result = resultByUseId.get(useId);
      if (!result) continue;

      // Already settled by a real taskLookup entry — don't overwrite
      // authoritative server state with our inferred one.
      if (task.status === 'done' || task.status === 'failed') continue;

      const isError =
        result.metadata !== null &&
        (result.metadata as Record<string, unknown>)['isError'] === true;
      task.status = isError ? 'failed' : 'done';
      task.progress = isError ? 100 : 100;
      const callMsg = toolCallByUseId.get(useId);
      if (callMsg) {
        task.elapsed = formatElapsed(callMsg.createdAt, result.createdAt);
      }
      if (!task.outputSummary) {
        task.outputSummary = extractSummaryFromResultContent(result.content);
      }
    }
  }
}

/**
 * Best-effort `outputSummary` pull from a tool_result's raw `content`
 * string. Subagents that terminate with `StructuredOutput` emit a JSON
 * blob whose `summary` (or `notes`) field is the human-readable line
 * we want on the card. Free-form results fall back to a truncated
 * first-line preview; if the content is empty or looks like a stack
 * trace we return null and let the card's error display handle it.
 */
function extractSummaryFromResultContent(content: string | null): string | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const summary = parsed['summary'];
      if (typeof summary === 'string' && summary.trim().length > 0) {
        return summary.trim();
      }
      const notes = parsed['notes'];
      if (typeof notes === 'string' && notes.trim().length > 0) {
        return notes.trim();
      }
    } catch {
      // not JSON — fall through to text truncation
    }
  }
  const firstLine = trimmed.split('\n')[0] ?? trimmed;
  if (firstLine.length > 240) {
    return `${firstLine.slice(0, 240).trimEnd()}…`;
  }
  return firstLine;
}

/**
 * Second pass that fills in `phase` on every `LeadNode`. Needs a full pass
 * because a lead message's phase depends on the 5s-windowed delegation
 * attached to it AND on whether any prior dispatch in the same run has
 * already happened (that's what makes the message a synthesis vs a plan).
 *
 * Per-run bookkeeping: once a lead node in run R has a non-empty
 * delegation, any subsequent plain lead node in R is classified as
 * SYNTHESIS — the coordinator is folding subagent results back into a
 * human-facing summary.
 */
function assignPhases(nodes: ConversationNode[]): void {
  const seenDispatch = new Map<string | null, boolean>();
  for (const node of nodes) {
    if (node.kind !== 'lead') continue;
    // DONE is stamped at creation time for completion messages — respect it.
    if (node.phase === 'DONE') continue;

    const runKey = node.runId ?? null;
    const hadPrior = seenDispatch.get(runKey) ?? false;

    if (node.delegation.length >= 2) {
      node.phase = 'PARALLEL DISPATCH';
      seenDispatch.set(runKey, true);
    } else if (node.delegation.length === 1) {
      node.phase = 'DISPATCH';
      seenDispatch.set(runKey, true);
    } else if (hadPrior) {
      node.phase = 'SYNTHESIS';
    } else {
      node.phase = 'PLAN';
    }
  }
}

const NO_RUN_KEY = '__no_run__';

/**
 * Fold `ConversationNode[]` into `SessionGroup[]`, one group per runId
 * (plus a sentinel group for messages whose runId is null). Groups keep
 * the chronological order of their first message, which matches the
 * ordering of runs themselves (oldest-first). Within a group, nodes
 * stay in their stitched order.
 */
export function groupByRun(
  nodes: readonly ConversationNode[],
  runLookup: TeamRunLookup = new Map(),
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const node of nodes) {
    const runId = node.runId ?? null;
    const run = runId ? runLookup.get(runId) ?? null : null;
    // Defensive: drop onboarding groups in case a server-rendered page
    // forgot to filter them at the DB boundary.
    if (run && run.trigger === 'onboarding') continue;
    const key = runId ?? NO_RUN_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        runId,
        run,
        nodes: [],
      };
      groups.set(key, group);
    }
    group.nodes.push(node);
  }
  return Array.from(groups.values());
}
