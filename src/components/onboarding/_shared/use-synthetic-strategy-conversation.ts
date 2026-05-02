// Synthesizes a `/team`-style chat conversation from real `tool_progress`
// SSE events emitted by /api/onboarding/plan. There is no real coordinator
// running on the backend (Stage 1 of the plan-building refactor switched
// /api/onboarding/plan to invoke `runForkSkill('generating-strategy', …)`
// directly — no team-run, no delegate). The UI pretends there is one so
// the user gets the same "Chief of Staff dispatched a Strategist; here are
// the tools they ran" hierarchy they already see on /team.
//
// Pure function. Easy to unit-test. The component layer feeds in an array
// of events that grows over the request's lifetime and reads back a fully
// derived state object — no internal mutation, no React state, no clock
// dependency beyond what the caller hands in.
//
// This file mirrors the spirit of `conversation-reducer.ts` but is
// intentionally tiny — onboarding doesn't need member lookup tables,
// session merging, or any of the other team-page complexity. We're
// rendering one lead message + one subtask card.

export interface ToolProgressEvent {
  readonly toolName: string;
  readonly phase: 'start' | 'done' | 'error';
  readonly toolUseId: string;
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

export interface SyntheticToolCall {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly friendlyLabel: string;
  readonly phase: 'start' | 'done' | 'error';
  readonly durationMs?: number;
  readonly errorMessage?: string;
}

export type SyntheticPhase = 'DISPATCH' | 'SYNTHESIS' | 'DONE';

export type SyntheticSubtaskStatus = 'RUNNING' | 'DONE' | 'ERROR';

export interface SyntheticConversationCoordinator {
  readonly name: string;
  readonly phase: SyntheticPhase;
  readonly body: string;
  readonly timestamp: Date;
}

export interface SyntheticConversationSubtask {
  readonly title: string;
  readonly specialistName: string;
  readonly specialistRole: string;
  readonly firstMessage: string;
  readonly status: SyntheticSubtaskStatus;
  readonly toolCalls: readonly SyntheticToolCall[];
  readonly errorMessage: string | null;
}

export interface SyntheticConversationState {
  readonly coordinator: SyntheticConversationCoordinator;
  readonly subtask: SyntheticConversationSubtask;
  readonly elapsedMs: number;
}

export interface SyntheticInput {
  readonly toolProgressEvents: readonly ToolProgressEvent[];
  readonly done: boolean;
  readonly error: string | null;
  /**
   * Wall-clock ms when /api/onboarding/plan kicked off — used to derive
   * `elapsedMs`. Caller passes a stable ref-captured value so the hook
   * stays pure (no Date.now() inside).
   */
  readonly startedAt: number;
  /** Wall-clock ms "now" — caller ticks this on a 1s timer. */
  readonly now: number;
}

/**
 * Friendly human label for each tool the `generating-strategy` skill
 * actually calls. Anything not in this map renders the raw tool name as a
 * fallback so a future tool addition still surfaces in the UI without
 * blocking the conversation.
 */
const TOOL_LABELS: Record<string, string> = {
  query_recent_milestones: 'Reading recent shipping signals',
  query_strategic_path: 'Reading existing strategic path',
  query_metrics: 'Reading channel metrics',
  query_product_context: 'Loading product context',
  write_strategic_path: 'Writing the 30-day plan',
};

const COORDINATOR_DISPATCH_BODY =
  "Building your 30-day plan — I'll have the strategist do the research and write the plan.";
const COORDINATOR_SYNTHESIS_BODY = 'Plan ready for your review.';
const COORDINATOR_ERROR_BODY =
  "We hit a snag building the plan. You can retry, or continue with a manual plan.";
const SUBTASK_FIRST_MESSAGE =
  "I'll gather context, then write the plan.";
const SUBTASK_TITLE = 'Build initial 30-day plan';
const COORDINATOR_NAME = 'Chief of Staff';
const SPECIALIST_NAME = 'Strategist';
const SPECIALIST_ROLE = 'STRATEGIST · SUBTASK';

export function friendlyLabelForTool(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, ' ');
}

/**
 * Fold the full event list into a per-tool-call summary. Multiple events
 * for the same `toolUseId` collapse into one row whose `phase` reflects
 * the latest seen — `start` first, then `done` or `error` overrides it
 * along with the duration / error message.
 */
function foldEvents(
  events: readonly ToolProgressEvent[],
): readonly SyntheticToolCall[] {
  // Preserve insertion order. We can't use a plain object for that since
  // duplicate keys would clobber order; Map keeps first-insertion order
  // and lets `set()` update in place without changing ordering.
  const byId = new Map<string, SyntheticToolCall>();
  for (const ev of events) {
    const prev = byId.get(ev.toolUseId);
    const next: SyntheticToolCall = {
      toolUseId: ev.toolUseId,
      toolName: ev.toolName,
      friendlyLabel: friendlyLabelForTool(ev.toolName),
      phase: ev.phase,
      durationMs: ev.durationMs ?? prev?.durationMs,
      errorMessage: ev.errorMessage ?? prev?.errorMessage,
    };
    byId.set(ev.toolUseId, next);
  }
  return Array.from(byId.values());
}

export function useSyntheticStrategyConversation(
  input: SyntheticInput,
): SyntheticConversationState {
  const { toolProgressEvents, done, error, startedAt, now } = input;
  const toolCalls = foldEvents(toolProgressEvents);

  let phase: SyntheticPhase;
  let body: string;
  let subtaskStatus: SyntheticSubtaskStatus;
  if (error) {
    phase = 'DONE';
    body = COORDINATOR_ERROR_BODY;
    subtaskStatus = 'ERROR';
  } else if (done) {
    phase = 'SYNTHESIS';
    body = COORDINATOR_SYNTHESIS_BODY;
    subtaskStatus = 'DONE';
  } else {
    phase = 'DISPATCH';
    body = COORDINATOR_DISPATCH_BODY;
    subtaskStatus = 'RUNNING';
  }

  return {
    coordinator: {
      name: COORDINATOR_NAME,
      phase,
      body,
      timestamp: new Date(startedAt),
    },
    subtask: {
      title: SUBTASK_TITLE,
      specialistName: SPECIALIST_NAME,
      specialistRole: SPECIALIST_ROLE,
      firstMessage: SUBTASK_FIRST_MESSAGE,
      status: subtaskStatus,
      toolCalls,
      errorMessage: error,
    },
    elapsedMs: Math.max(0, now - startedAt),
  };
}
