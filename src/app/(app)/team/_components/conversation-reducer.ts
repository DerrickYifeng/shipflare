import type {
  PartialLeadMessage,
  TeamActivityMessage,
} from '@/hooks/use-team-events';
import type { Phase } from './phase-tag';

export interface DelegationTask {
  /** team_messages.id of the originating tool_call row. */
  messageId: string;
  /**
   * Free-text grouping handle pointing at the originating user_prompt
   * team_messages.id. Needed by the right-rail Task panel so clicking a
   * Recent task can switch the active session when the target subtask
   * lives in a different request than the one currently rendered in the
   * conversation column.
   */
  runId: string | null;
  /**
   * Anthropic tool_use_id the coordinator stamped on its Task call. This
   * is what the reducer's `progressByParentToolUse` map is keyed by —
   * every subagent event carries the same id in `metadata.parentToolUseId`.
   * Also the join key against `agent_runs.parentToolUseId` for status
   * lookups.
   */
  toolUseId: string | null;
  /** Target member id for this dispatched task (from metadata). */
  toMemberId: string | null;
  /**
   * `agent` (founder-friendly label) pulled from the Task tool_call's
   * redacted input. Used to look up the specialist by agent_type when
   * `toMemberId` is null — team_messages.to_member_id is always null on
   * tool_calls so this is the only reliable hook to the correct member
   * row until the worker starts stamping it. The wire key is `agent`
   * (not `subagent_type`) to suppress Anthropic Task-tool fingerprint
   * (see redact-for-client.ts).
   */
  subagentType: string | null;
  /** Short label for the task — "agentType" fallback if none. */
  label: string;
  /** High-level status derived from the matching `agent_runs` row. */
  status: 'queued' | 'working' | 'done' | 'failed';
  /** Percent done, 0-100. working = 50 until status flips. */
  progress: number;
  /** Pre-formatted elapsed string when the task completed, else null. */
  elapsed: string | null;
  /**
   * Subagent-produced result summary. Back-filled from the
   * `task_notification` row's `summary` field by `reconcileAsyncCompletion`
   * once the teammate exits. Null while the task is still running.
   */
  outputSummary: string | null;
  /**
   * `agent_runs.id` of the spawned teammate. Pulled either from the Task
   * tool's async dispatch receipt (`tool_result` content with
   * `{status: 'async_launched', agentId}`) or via the parent-tool-use
   * index against the AgentRunStatusMap. Null for sync Task calls or
   * before the dispatch receipt lands.
   */
  agentId: string | null;
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
      /**
       * Anthropic tool_use_id stamped on this tool_call. Used by
       * `populateDelegationProgress` to look up nested sub-events
       * (e.g. fork-skill calls spawned inside this tool) from the
       * `progressByParentToolUse` map and graft them as `subItems`.
       */
      toolUseId?: string;
      /**
       * Sub-events emitted while this tool was running — typically
       * `runForkSkill` invocations whose own messages carry
       * `parent_tool_use_id = <this tool's tool_use_id>`. Surfaced as
       * a nested ProgressList in the UI so multi-fork tools like
       * `find_threads_via_xai` show live activity instead of a blank
       * RUNNING card. Recursive: a sub-fork can itself spawn forks.
       */
      subItems?: ProgressItem[];
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
   * `AGENT.md` name of the subagent that emitted the tool call when the
   * tool ran inside a spawn (via `spawnMeta.agentName`). Null on the
   * main thread. Used by the activity-log UI to label rows like
   * "Researcher used Grep" vs surface them under the coordinator.
   */
  agentName: string | null;
  /**
   * Live progress lines emitted by the running tool via `ctx.emitProgress`
   * — surfaced as compact mono log rows below the activity row so the
   * founder can see "Searching x with 6 inline queries" / "Resolved
   * 18/22 bios" while a slow tool is running. Frozen once the matching
   * tool_result arrives. Always [] for tools that don't emit progress.
   */
  progress: string[];
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
  conversationId?: string | null;
}

export type TeamRunLookup = ReadonlyMap<string, TeamRunMeta>;

export interface SessionGroup {
  /** Stable key — the runId, or '__no_run__' sentinel for orphan messages. */
  key: string;
  runId: string | null;
  run: TeamRunMeta | null;
  nodes: ConversationNode[];
}

/**
 * Status snapshot of an `agent_runs` row. The team page seeds this from
 * SSR (recent agent_runs rows scoped to the user's team) and the live
 * SSE channel keeps it fresh via `agent_status_change` events. The reducer
 * joins each DelegationTask to its matching entry by `parentToolUseId`
 * (which equals the coordinator's Task tool_use_id) — making `agent_runs`
 * the single source of truth for "is this dispatch still running?".
 */
export interface AgentRunStatus {
  agentId: string;
  /**
   * Literal `agent_runs.status` value. The reducer maps this to the
   * DelegationTask's compact `'queued' | 'working' | 'done' | 'failed'`
   * status via `deriveStatus()`.
   */
  status:
    | 'queued'
    | 'running'
    | 'sleeping'
    | 'resuming'
    | 'completed'
    | 'failed'
    | 'killed';
  /**
   * Anthropic tool_use_id of the parent's `Task` call that spawned this
   * agent. Stamped at spawn time in AgentTool.launchAsyncTeammate so the
   * reducer can index agent_runs rows by the same key DelegationTask uses
   * for its `toolUseId` field. Null for top-level lead runs.
   */
  parentToolUseId: string | null;
  spawnedAt: string | null;
  lastActiveAt: string | null;
  /**
   * Paraphrased subagent output surfaced on dispatch cards. Back-filled
   * from the `task_notification` row's `summary` field by
   * `reconcileAsyncCompletion` once the teammate exits. Null while running.
   */
  outputSummary: string | null;
}

/** Keyed by `agent_runs.id`. */
export type AgentRunStatusMap = ReadonlyMap<string, AgentRunStatus>;

/** Window (ms) within which an adjacent tool_call is attributed to the preceding lead text. */
const STITCH_WINDOW_MS = 5_000;

function parseTime(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// The worker writes metadata with camelCase keys (`toolName`, `toolUseId`,
// `input`) — see the assistant_text_stop / tool_call insert blocks in
// `src/workers/processors/agent-run.ts`. We read camelCase first and fall
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
  raw: AgentRunStatus['status'] | undefined,
): 'queued' | 'working' | 'done' | 'failed' {
  // Missing row → render as QUEUED. That's the truthful answer: the lead
  // just emitted a Task tool_call but the agent_runs INSERT either hasn't
  // landed yet (live race) or never will (sync test/CLI path). Don't
  // default to RUNNING — that's the exact lie this refactor exists to kill.
  if (!raw) return 'queued';
  switch (raw) {
    case 'completed':
      return 'done';
    case 'running':
    case 'resuming':
      return 'working';
    case 'failed':
    case 'killed':
      return 'failed';
    case 'sleeping':
      // Sleeping teammates haven't terminated — they're yielding their
      // worker slot until a wake() fires. Surface as 'working' so the card
      // keeps its RUNNING badge instead of falsely appearing settled.
      return 'working';
    case 'queued':
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
  agentRunByParentToolUse: ReadonlyMap<string, AgentRunStatus>,
): DelegationTask {
  const metadata = message.metadata;
  const toolUseId = readString(metadata, 'toolUseId', 'tool_use_id');

  const description =
    extractToolInputString(metadata, 'description') ??
    extractToolInputString(metadata, 'agent') ??
    'Dispatched task';

  // Look up the spawned agent_runs row by the Task tool's tool_use_id —
  // launchAsyncTeammate stamps `agent_runs.parentToolUseId` with this
  // exact value at spawn time, so the join is direct. A miss means we
  // haven't seen the agent_runs row yet (live SSE race, or a sync
  // Task path in tests/CLI). Either way the truthful answer is QUEUED
  // — `deriveStatus(undefined)` returns 'queued', not the legacy
  // 'running' default that caused dispatch cards to lie forever.
  const lookupEntry = toolUseId ? agentRunByParentToolUse.get(toolUseId) : undefined;
  const status = deriveStatus(lookupEntry?.status);
  const progress = deriveProgress(status);
  const elapsed =
    lookupEntry && lookupEntry.spawnedAt && lookupEntry.lastActiveAt
      ? // Only show elapsed once terminal — for in-flight rows the lastActiveAt
        // keeps moving with each turn and a stale elapsed would be misleading.
        status === 'done' || status === 'failed'
        ? formatElapsed(lookupEntry.spawnedAt, lookupEntry.lastActiveAt)
        : null
      : null;

  return {
    messageId: message.id,
    runId: message.runId,
    toolUseId,
    toMemberId: message.to,
    subagentType: extractToolInputString(metadata, 'agent'),
    label: description,
    status,
    progress,
    elapsed,
    outputSummary: lookupEntry?.outputSummary ?? null,
    // Populated below from the lookup entry when available — the
    // agent_runs row carries `id` (agentId). Pre-existing reducer code
    // also stamped `agentId` from the async dispatch receipt via
    // `reconcileDelegationCompletion`; that path still works as a
    // fallback for the brief window between Task-tool return and the
    // agent_runs SELECT landing on the client.
    agentId: lookupEntry?.agentId ?? null,
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
  // The redactor at the API boundary maps raw tool name `'Task'` to the
  // semantic label `'delegating'` (see src/lib/team/redact-for-client.ts).
  // The UI receives the redacted shape, so we match on the label here.
  return extractToolName(message.metadata) === 'delegating';
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
  if (!trimmed.startsWith('{')) return stripTaskNotificationXml(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const summary = parsed['summary'];
    if (typeof summary === 'string' && summary.length > 0) {
      return stripTaskNotificationXml(summary);
    }
    const notes = parsed['notes'];
    if (typeof notes === 'string' && notes.length > 0) {
      return stripTaskNotificationXml(notes);
    }
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

// Backstop for an LLM-side bug: the lead occasionally hallucinates a
// `<task-notification>` XML block in its own assistant text — a
// stylized paraphrase of the user-role notification that was injected
// into its inbox (see synthesize-notification.ts for the real shape).
// `coordinator/AGENT.md` §4 forbids this, but the model still slips,
// and react-markdown renders the raw tag as visible text. Strip the
// block on the render path so legacy / cached transcripts don't show
// XML in the SYNTHESIS message either.
const TASK_NOTIFICATION_XML_PATTERN =
  /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>/gi;

function stripTaskNotificationXml(text: string): string {
  if (!text || !text.includes('<task-notification')) return text;
  return text
    .replace(TASK_NOTIFICATION_XML_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  agentRunStatus: AgentRunStatusMap = new Map(),
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
  // Apply any `agent_status_change` events that arrived through the SSE
  // stream on top of the SSR-seeded map. The hook delivers each one as a
  // TeamActivityMessage of type `agent_status_change` with the status
  // payload nested in `metadata`. Latest-wins keeps the map fresh without
  // requiring a separate hook subscription.
  const liveAgentRunStatus = applyStatusChanges(messages, agentRunStatus);

  // Secondary index for buildDelegationTask: the join key is the Task
  // tool's tool_use_id, which equals `agent_runs.parentToolUseId`.
  const byParentToolUseId = new Map<string, AgentRunStatus>();
  for (const entry of liveAgentRunStatus.values()) {
    if (entry.parentToolUseId) {
      byParentToolUseId.set(entry.parentToolUseId, entry);
    }
  }
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
  // Two signals routes a message into a subagent's delegation card
  // instead of the top-level thread:
  //   1. `parentToolUseId` — the canonical anchor stamped by the Task
  //      tool's spawnMeta wrapping. Always present in well-behaved spawns.
  //   2. `agentName` — defensive backstop. Subagents (and only subagents)
  //      get `agentName` written to their message metadata via spawnMeta;
  //      coordinator never has it set. If `parentToolUseId` is missing
  //      for any reason (worker race, legacy row, future regression),
  //      `agentName` keeps the routing correct.
  //
  // Without #2, subagent text whose parentToolUseId failed to land would
  // bubble up as a LeadNode and the UI's `node.fromMemberId ?? coordinatorId`
  // fallback (conversation.tsx:256) would render it as the coordinator's
  // avatar — which is exactly the "Chief of Staff SYNTHESIS pasting JSON"
  // mis-attribution observed in production traces 2026-05-02.
  const hasSubagentName = (metadata: Record<string, unknown> | null): boolean => {
    // Use extractAgentName so both `agentName` (camelCase, defensively
    // tolerated) and `agent_name` (snake_case, the shape agent-run.ts
    // actually persists) are read. The earlier inline readString only
    // matched camelCase, so this safety net never fired for any real
    // persisted row — defeating the comment above's promise.
    const name = extractAgentName(metadata);
    return (
      typeof name === 'string' && name.length > 0 && name !== 'coordinator'
    );
  };
  const belongsToSubagent = (msg: TeamActivityMessage): boolean =>
    extractParentToolUseId(msg.metadata) !== null ||
    hasSubagentName(msg.metadata);
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
    // `agent_status_change` events flow through the message stream so
    // the SSE channel keeps the AgentRunStatusMap fresh, but they don't
    // render as nodes themselves. `applyStatusChanges` above already
    // folded them into `liveAgentRunStatus`.
    if (msg.type === 'agent_status_change') continue;

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
        text: stripTaskNotificationXml(msg.content ?? ''),
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
      currentLead.delegation.push(buildDelegationTask(msg, byParentToolUseId));
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
        agentName: extractAgentName(msg.metadata),
        progress: [],
      };
      const useId = extractToolUseId(msg.metadata);
      if (useId) activityByUseId.set(useId, activity);
      activityById.set(msg.id, activity);
      nodes.push(activity);
      continue;
    }

    if (msg.type === 'tool_progress') {
      // Attach to the most-recent in-flight ActivityNode whose toolName
      // matches the progress event's toolName. The emitProgress lambda
      // doesn't carry parentToolUseId today, so we match by toolName +
      // recency. If no toolName match, fall back to the most-recent
      // in-flight tool_call in the same runId — this lets fork-skill
      // progress (emitted by runForkSkill, where the toolName is the
      // skill name not the calling tool's name) attach to the parent
      // tool's card. If still no match, drop silently — it's UI
      // decoration, not load-bearing.
      const progressToolName = extractToolName(msg.metadata);
      const line = (msg.content ?? '').trim();
      if (!line) continue;
      let target: ActivityNode | null = null;
      if (progressToolName) {
        for (const candidate of activityById.values()) {
          if (candidate.complete) continue;
          if (candidate.runId !== msg.runId) continue;
          if (candidate.toolName !== progressToolName) continue;
          if (!target || candidate.createdAt > target.createdAt) {
            target = candidate;
          }
        }
      }
      if (!target) {
        for (const candidate of activityById.values()) {
          if (candidate.complete) continue;
          if (candidate.runId !== msg.runId) continue;
          if (!target || candidate.createdAt > target.createdAt) {
            target = candidate;
          }
        }
      }
      if (target) {
        // Fork progress events carry their skill name in metadata so
        // multiple parallel forks under one parent card stay legible
        // ("[judging-thread-quality] fork done in 8200ms" × 5).
        const skillName = (msg.metadata as { skillName?: string } | undefined)
          ?.skillName;
        const prefix =
          skillName && skillName !== target.toolName ? `[${skillName}] ` : '';
        target.progress.push(prefix + line);
      }
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
        agentName: extractAgentName(msg.metadata),
        progress: [],
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
  //
  // Subagent partials are filtered out — they carry parentToolUseId (the
  // parent Task's tool_use_id) or agentName from the worker's spawnMeta
  // stamp. Without this filter, a teammate's mid-stream text would render
  // as the LEAD'S bubble, then vanish when the durable agent_text lands
  // (which gets correctly routed under the DelegationCard via the
  // `belongsToSubagent` check above). Founder UX: keep the main thread
  // showing the lead's persona only; subagent activity surfaces inside
  // the DelegationCard and the right-side TaskPanel.
  if (partials.size > 0) {
    const partialNodes = Array.from(partials.values())
      .filter((p) => p.parentToolUseId === null && p.agentName === null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of partialNodes) {
      nodes.push({
        kind: 'lead',
        id: p.id,
        createdAt: p.createdAt,
        runId: p.runId,
        fromMemberId: p.from,
        text: stripTaskNotificationXml(p.content),
        delegation: [],
        phase: 'PLAN',
        streaming: true,
      });
    }
  }

  populateDelegationProgress(nodes, progressByParentToolUse, partials);
  reconcileAsyncDispatchReceipts(nodes, messages, liveAgentRunStatus);
  reconcileAsyncCompletion(nodes, messages);
  assignPhases(nodes);
  return nodes;
}

/**
 * Merge SSE-delivered `agent_status_change` events on top of the
 * SSR-seeded `AgentRunStatusMap`. Each event lands as a TeamActivityMessage
 * of type `agent_status_change` with the payload nested in `metadata`
 * (see `publishStatusChange` in `src/workers/processors/agent-run.ts`).
 * Latest-wins across the iteration order.
 *
 * Returns a fresh map; the original `seed` is left untouched so the prop
 * identity is stable when no live events have landed (lets React's memo
 * boundaries dedup downstream).
 */
export function applyStatusChanges(
  messages: readonly TeamActivityMessage[],
  seed: AgentRunStatusMap,
): Map<string, AgentRunStatus> {
  // Skip the copy when neither SSR nor SSE contributed anything — the
  // common case during empty-state renders and tests.
  let hasUpdate = false;
  for (const m of messages) {
    if (m.type === 'agent_status_change') {
      hasUpdate = true;
      break;
    }
  }
  if (!hasUpdate) return new Map(seed);

  const merged = new Map<string, AgentRunStatus>(seed);
  for (const m of messages) {
    if (m.type !== 'agent_status_change') continue;
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    const agentId = typeof meta['agentId'] === 'string' ? meta['agentId'] : null;
    const status = typeof meta['status'] === 'string' ? meta['status'] : null;
    if (!agentId || !isAgentRunStatusValue(status)) continue;
    const existing = merged.get(agentId);
    const parentToolUseId =
      typeof meta['parentToolUseId'] === 'string' && meta['parentToolUseId'].length > 0
        ? (meta['parentToolUseId'] as string)
        : existing?.parentToolUseId ?? null;
    const lastActiveAt =
      typeof meta['lastActiveAt'] === 'string'
        ? (meta['lastActiveAt'] as string)
        : m.createdAt;
    merged.set(agentId, {
      agentId,
      status,
      parentToolUseId,
      spawnedAt: existing?.spawnedAt ?? lastActiveAt,
      lastActiveAt,
      outputSummary: existing?.outputSummary ?? null,
    });
  }
  return merged;
}

function isAgentRunStatusValue(v: unknown): v is AgentRunStatus['status'] {
  return (
    v === 'queued' ||
    v === 'running' ||
    v === 'sleeping' ||
    v === 'resuming' ||
    v === 'completed' ||
    v === 'failed' ||
    v === 'killed'
  );
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
      if (bucket && bucket.length > 0) {
        task.progressItems = buildProgressItems(bucket);
      }
      // Recurse into the just-built progressItems so any tool whose
      // tool_use_id is itself a parent for a nested bucket (e.g.
      // `find_threads_via_xai` running ~10-20 `runForkSkill` calls)
      // gets its sub-events grafted onto `subItems`. Without this,
      // the tool card sits at "RUNNING 4m 55s" with no live progress
      // even though sub-event rows are persisted under
      // `parent_tool_use_id = <find_threads_via_xai's id>`.
      if (task.progressItems.length > 0) {
        attachNestedProgress(task.progressItems, progressByParentToolUse);
      }
    }
  }
}

/**
 * For each tool ProgressItem with a `toolUseId`, look up sub-events
 * keyed by that id in the parentToolUseId bucket map and attach them
 * as `subItems`. Recurses one level deeper to handle multi-level
 * nesting (rare but possible — e.g. a fork-skill that itself calls
 * another tool that fans out further).
 */
function attachNestedProgress(
  items: readonly ProgressItem[],
  map: ReadonlyMap<string, TeamActivityMessage[]>,
): void {
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    if (!item.toolUseId) continue;
    const bucket = map.get(item.toolUseId);
    if (!bucket || bucket.length === 0) continue;
    const sub = buildProgressItems(bucket);
    item.subItems = sub;
    attachNestedProgress(sub, map);
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
      // Engine pattern (engine/tools/AgentTool/UI.tsx): the inline
      // tool row shows toolName + elapsed only — never the raw payload
      // — so we don't leak internal IDs (uuids, plan_item rows, etc.)
      // to the founder. Errors stay visible via `errorText`. A future
      // verbose/transcript drawer can read the full content from the
      // durable team_messages row.
      raw.push({
        kind: 'tool',
        id: msg.id,
        createdAt: msg.createdAt,
        toolName,
        elapsed,
        complete,
        errorText,
        // Carry the tool_use_id forward so populateDelegationProgress
        // can graft nested sub-events (runForkSkill spawns, etc.)
        // onto this item's `subItems` after pairing is done.
        ...(useId ? { toolUseId: useId } : {}),
      });
      continue;
    }
    if (msg.type === 'tool_result') continue; // consumed via pairing
    if (msg.type === 'agent_text' && msg.content) {
      raw.push({
        kind: 'text',
        id: msg.id,
        createdAt: msg.createdAt,
        text: stripTaskNotificationXml(msg.content),
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
 * Capture the spawned `agent_runs.id` from each Task tool's async dispatch
 * receipt and stash it on the DelegationTask.
 *
 * The Task tool returns immediately with
 * `{status: 'async_launched', agentId}` — that's a dispatch receipt, not
 * completion. Two consumers need the agentId:
 *
 *  1. `buildDelegationTask` already looks up status via the
 *     `agent_runs.parentToolUseId` index; this pass adds the agentId as
 *     a fallback when the agent_runs row hasn't reached the client yet
 *     (live SSE race / brief window between Task tool return and the
 *     periodic agent_runs refetch).
 *  2. `reconcileAsyncCompletion` keys task_notifications by agentId to
 *     back-fill `outputSummary` once the teammate exits.
 *
 * This pass does NOT touch `status` — that is sourced exclusively from
 * the AgentRunStatusMap. Status inference from tool_result content was
 * the original sin behind the "stuck at RUNNING" bug, so it's gone for
 * good.
 */
function reconcileAsyncDispatchReceipts(
  nodes: ConversationNode[],
  messages: readonly TeamActivityMessage[],
  liveAgentRunStatus: ReadonlyMap<string, AgentRunStatus>,
): void {
  // Index tool_result messages by the tool_use_id they answer.
  const resultByUseId = new Map<string, TeamActivityMessage>();
  for (const msg of messages) {
    if (msg.type !== 'tool_result') continue;
    const useId = readString(msg.metadata, 'toolUseId', 'tool_use_id');
    if (useId) resultByUseId.set(useId, msg);
  }
  if (resultByUseId.size === 0) return;

  for (const node of nodes) {
    if (node.kind !== 'lead') continue;
    if (node.delegation.length === 0) continue;
    for (const task of node.delegation) {
      if (task.agentId) continue; // already known (e.g. from agent_runs row)
      const useId = task.toolUseId;
      if (!useId) continue;
      const result = resultByUseId.get(useId);
      if (!result) continue;
      const asyncDispatch = parseAsyncDispatchPayload(result.content);
      if (!asyncDispatch) continue;
      task.agentId = asyncDispatch.agentId;
      // Opportunistically refresh status if the agent_runs row reached
      // the client between buildDelegationTask and now. Otherwise the
      // existing 'queued' default holds until the next status event.
      const entry = liveAgentRunStatus.get(asyncDispatch.agentId);
      if (entry) {
        task.status = deriveStatus(entry.status);
        task.progress = deriveProgress(task.status);
        if (!task.outputSummary && entry.outputSummary) {
          task.outputSummary = entry.outputSummary;
        }
      }
    }
  }
}

/**
 * Detect the Task tool's async dispatch receipt:
 *   `{result: null, cost: 0, ..., agentId: "<uuid>", status: "async_launched"}`
 *
 * Returns the parsed `{agentId}` only when both `status === 'async_launched'`
 * AND a non-empty `agentId` are present. Returns null for sync results, free-
 * form strings, error payloads, or malformed JSON — all of which should fall
 * through to the normal completion-flip path.
 */
function parseAsyncDispatchPayload(
  content: string | null,
): { agentId: string } | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed['status'] !== 'async_launched') return null;
    const agentId = parsed['agentId'];
    if (typeof agentId !== 'string' || agentId.length === 0) return null;
    return { agentId };
  } catch {
    return null;
  }
}

/**
 * Back-fill `outputSummary` on async-dispatched DelegationTasks once their
 * `task_notification` arrives. Status itself is sourced exclusively from
 * the AgentRunStatusMap (the `agent_status_change` SSE channel keeps it
 * fresh, the SSR query seeds the initial state), so this pass touches
 * only the summary text + the elapsed string the card displays once the
 * teammate exits.
 */
function reconcileAsyncCompletion(
  nodes: ConversationNode[],
  messages: readonly TeamActivityMessage[],
): void {
  // Index task_notifications by the agentId they're about. Latest-wins on
  // the off-chance the worker republishes for the same agent (idempotency
  // is enforced upstream by `delivered_at`, but the wire is best-effort).
  const notificationByAgentId = new Map<string, TeamActivityMessage>();
  for (const msg of messages) {
    if (msg.type !== 'task_notification') continue;
    const agentId = readNotificationField(msg, 'agentId');
    if (agentId) notificationByAgentId.set(agentId, msg);
  }
  if (notificationByAgentId.size === 0) return;

  const toolCallByMessageId = new Map<string, TeamActivityMessage>();
  for (const msg of messages) {
    if (msg.type === 'tool_call') toolCallByMessageId.set(msg.id, msg);
  }

  for (const node of nodes) {
    if (node.kind !== 'lead') continue;
    if (node.delegation.length === 0) continue;
    for (const task of node.delegation) {
      if (!task.agentId) continue;
      const notification = notificationByAgentId.get(task.agentId);
      if (!notification) continue;

      if (!task.outputSummary) {
        task.outputSummary = readNotificationField(notification, 'summary');
      }
      // Stamp elapsed against the originating tool_call when the agent_runs
      // status hasn't given us one yet. (buildDelegationTask only fills
      // elapsed if the row is in a terminal state — task_notification is
      // another reliable terminal signal, so use it when available.)
      if (!task.elapsed) {
        const callMsg = toolCallByMessageId.get(task.messageId);
        if (callMsg) {
          task.elapsed = formatElapsed(callMsg.createdAt, notification.createdAt);
        }
      }
    }
  }
}

/**
 * task_notification payloads land with the relevant fields either at
 * top-level (the SSE wire spreads the publisher's JSON onto the message
 * shape) or under `metadata` (when serialized through the durable team_
 * messages row). Read both and prefer the first non-empty.
 */
function readNotificationField(
  msg: TeamActivityMessage,
  key: string,
): string | null {
  const meta = msg.metadata as Record<string, unknown> | null;
  const raw = msg as unknown as Record<string, unknown>;
  const top = raw[key];
  if (typeof top === 'string' && top.length > 0) return top;
  const inMeta = meta?.[key];
  if (typeof inMeta === 'string' && inMeta.length > 0) return inMeta;
  return null;
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
 * Fold `ConversationNode[]` into `SessionGroup[]`, one group per runId.
 * Orphan messages (runId=null — typically founder DMs to the lead that
 * arrive between runs) start a NEW group every time they appear after
 * a run group. Without that split, a DM sent mid-conversation collapses
 * back into the first orphan bucket at the top of the thread, making
 * "interactive" replies look like a stack of upfront prompts.
 *
 * Groups keep the chronological order of their first message — Map
 * preserves insertion order, so the natural input ordering carries.
 */
export function groupByRun(
  nodes: readonly ConversationNode[],
  runLookup: TeamRunLookup = new Map(),
): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  let lastKey: string | null = null;
  let orphanSeq = 0;

  for (const node of nodes) {
    const runId = node.runId ?? null;
    const run = runId ? runLookup.get(runId) ?? null : null;
    // Defensive: drop onboarding groups in case a server-rendered page
    // forgot to filter them at the DB boundary.
    if (run && run.trigger === 'onboarding') continue;

    let key: string;
    if (runId) {
      key = runId;
    } else {
      // Open a fresh orphan bucket whenever the previous group wasn't
      // an orphan, so a DM that interrupts a run later in the timeline
      // renders where it was actually sent rather than at the top.
      // Consecutive orphan messages still coalesce into one bucket.
      const prevWasOrphan =
        lastKey !== null && lastKey.startsWith(NO_RUN_KEY);
      if (lastKey !== null && !prevWasOrphan) {
        orphanSeq += 1;
      }
      key = orphanSeq === 0 ? NO_RUN_KEY : `${NO_RUN_KEY}:${orphanSeq}`;
    }

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
    lastKey = key;
  }
  return Array.from(groups.values());
}
