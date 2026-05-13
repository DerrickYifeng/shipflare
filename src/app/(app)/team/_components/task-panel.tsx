'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type {
  AgentRunStatus,
  AgentRunStatusMap,
  DelegationTask,
  ProgressItem,
} from './conversation-reducer';
import { accentForAgentType, colorHexForAgentType } from './agent-accent';
import { TodaysOutput } from './todays-output';

export interface TaskPanelProps {
  tasks: readonly DelegationTask[];
  /**
   * Live agent_runs status map merged with SSE `agent_status_change`
   * events. Used to override `task.status` when the conversation
   * reducer hasn't yet folded the most recent transition into the
   * DelegationTask field (the bug surface: panel kept showing QUEUED
   * for teammates that were actively running and emitting tool_calls).
   * When omitted, the panel falls back to `task.status` only.
   */
  liveAgentRunStatus?: AgentRunStatusMap;
  /**
   * Called when the user clicks a task row. Receives the
   * `messageId` + owning `runId` of the originating Task tool_call —
   * caller selects that run (if different from the current one),
   * scrolls the matching SubtaskCard into view, and expands it so
   * the subagent's output is immediately visible.
   */
  onJumpToTask?: (messageId: string, runId: string | null) => void;
  /**
   * Hover-revealed Stop action on a RUNNING / QUEUED row. Receives the
   * spawned teammate's `agent_runs.id` so both this surface and the
   * inline SubtaskCard route through `/api/team/agent/[agentId]/cancel`.
   */
  onCancelTask?: (agentId: string) => void | Promise<void>;
  /**
   * Hover-revealed Retry action on a DONE / FAILED row. Spawns a fresh
   * teammate run with the same prompt — caller routes to the new session.
   */
  onRetryTask?: (agentId: string) => void | Promise<void>;
  /** Metrics for the THIS WEEK section at the bottom. */
  thisWeek: {
    completed: number;
    awaiting: number;
    inFlight: number;
  };
}

/**
 * Compute the effective DelegationTask status, preferring the live
 * agent_runs status when available. The agent_runs lifecycle has more
 * granularity (`resuming` vs `running` vs `sleeping`); collapse to the
 * coarser DelegationTask vocabulary so the panel's existing filters and
 * label logic don't have to fan out.
 *
 * Defensive override: if the task is reporting `queued` (from either
 * source) but has already emitted progress items (tool calls or text
 * bursts), the agent is provably running — promote to 'working'. This
 * patches a class of stale-status bugs where the queued → running SSE
 * event was dropped (e.g. agent_status_change payloads without a runId
 * filtered out somewhere) but tool_call events still propagated.
 * Without this, the panel can stall on QUEUED forever even though the
 * agent is producing output.
 */
function effectiveStatus(
  task: DelegationTask,
  live: AgentRunStatus | undefined,
): DelegationTask['status'] {
  const base: DelegationTask['status'] = (() => {
    if (!live) return task.status;
    switch (live.status) {
      case 'running':
      case 'resuming':
        return 'working';
      case 'queued':
        return 'queued';
      case 'sleeping':
        return 'working';
      case 'completed':
        return 'done';
      case 'failed':
        return 'failed';
      case 'killed':
        return 'failed';
      default:
        return task.status;
    }
  })();
  // Progress-items override: if the task is "queued" but has produced
  // observable work, it's actually running. Doesn't apply to terminal
  // states (a completed task can have many progress items but should
  // stay 'done').
  if (base === 'queued' && task.progressItems.length > 0) {
    return 'working';
  }
  return base;
}

const RECENT_DEFAULT_LIMIT = 3;

export function TaskPanel({
  tasks,
  liveAgentRunStatus,
  onJumpToTask,
  onCancelTask,
  onRetryTask,
  thisWeek,
}: TaskPanelProps) {
  // Pre-compute the effective status per task once so all downstream
  // partitions / labels stay consistent. `effectiveStatus` prefers the
  // live agent_runs map when available — the conversation reducer's
  // DelegationTask.status field can lag behind the actual run state.
  const effectiveByMessageId = useMemo(() => {
    const m = new Map<string, DelegationTask['status']>();
    for (const t of tasks) {
      const live = t.agentId
        ? liveAgentRunStatus?.get(t.agentId)
        : undefined;
      m.set(t.messageId, effectiveStatus(t, live));
    }
    return m;
  }, [tasks, liveAgentRunStatus]);
  const statusFor = useCallback(
    (t: DelegationTask): DelegationTask['status'] =>
      effectiveByMessageId.get(t.messageId) ?? t.status,
    [effectiveByMessageId],
  );

  // Partition by status. Running on top (always expanded), terminal
  // below in a capped RECENT section. `queued` gets bucketed with
  // running — it's transient and visually conveys "about to start".
  const running = useMemo(
    () =>
      tasks.filter((t) => {
        const s = statusFor(t);
        return s === 'working' || s === 'queued';
      }),
    [tasks, statusFor],
  );
  const recentAll = useMemo(
    () =>
      tasks
        .filter((t) => {
          const s = statusFor(t);
          return s === 'done' || s === 'failed';
        })
        .slice()
        // Approximate "recency" via messageId reverse — the top-level
        // stitcher emits delegations in chronological order, so later
        // messageIds correspond to later tool_calls. Good enough for
        // a sidebar heuristic; if we wire createdAt later, sort here.
        .reverse(),
    [tasks, statusFor],
  );

  const [showAllRecent, setShowAllRecent] = useState(false);
  const recentVisible = showAllRecent
    ? recentAll
    : recentAll.slice(0, RECENT_DEFAULT_LIMIT);
  const hiddenCount = Math.max(0, recentAll.length - recentVisible.length);

  // Single-expansion mode: at most one row's live progress feed is
  // visible at a time. Clicking another running row collapses the
  // previous and expands the new one — without this, expanding 6
  // concurrent dispatches makes the panel impossible to scan.
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const handleToggleExpand = useCallback((messageId: string) => {
    setExpandedMessageId((curr) => (curr === messageId ? null : messageId));
  }, []);

  const container: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
    overflowY: 'auto',
    padding: 12,
    gap: 14,
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
  };

  const sectionHeader: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 4px 6px',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--sf-fg-3)',
  };

  const badge: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    color: 'var(--sf-fg-4)',
  };

  const empty: CSSProperties = {
    padding: '12px 4px',
    color: 'var(--sf-fg-4)',
    fontSize: 12,
    fontStyle: 'italic',
  };

  const totalRunning = running.length;
  const totalDone = tasks.filter((t) => t.status === 'done').length;
  const totalFailed = tasks.filter((t) => t.status === 'failed').length;

  return (
    <aside style={container} aria-label="Task panel">
      <header style={sectionHeader}>
        <span>Tasks</span>
        <span style={badge}>
          {totalRunning}&nbsp;running · {totalDone}&nbsp;done
          {totalFailed > 0 ? ` · ${totalFailed} failed` : ''}
        </span>
      </header>

      <section aria-label="Running tasks">
        <div style={sectionHeader}>
          <span>Running</span>
        </div>
        {running.length === 0 ? (
          <div style={empty}>No tasks running.</div>
        ) : (
          running.map((task) => (
            <TaskPanelRow
              key={task.messageId}
              task={task}
              effectiveStatus={statusFor(task)}
              expanded={expandedMessageId === task.messageId}
              onToggleExpand={handleToggleExpand}
              onJump={onJumpToTask}
              onCancel={onCancelTask}
              onRetry={onRetryTask}
              variant="expanded"
            />
          ))
        )}
      </section>

      <section aria-label="Recent tasks">
        <div style={sectionHeader}>
          <span>Recent</span>
          {recentAll.length > RECENT_DEFAULT_LIMIT ? (
            <button
              type="button"
              onClick={() => setShowAllRecent((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--sf-font-mono)',
                fontSize: 10,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: 'var(--sf-accent)',
              }}
            >
              {showAllRecent ? 'Show less' : `Show all (${recentAll.length})`}
            </button>
          ) : null}
        </div>
        {recentAll.length === 0 ? (
          <div style={empty}>No completed tasks yet.</div>
        ) : (
          <>
            {recentVisible.map((task) => (
              <TaskPanelRow
                key={task.messageId}
                task={task}
                effectiveStatus={statusFor(task)}
                expanded={false}
                onToggleExpand={handleToggleExpand}
                onJump={onJumpToTask}
                onCancel={onCancelTask}
                onRetry={onRetryTask}
                variant="compact"
              />
            ))}
            {hiddenCount > 0 ? (
              <div style={{ ...empty, padding: '4px 4px 0' }}>
                +{hiddenCount} more hidden
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-label="This week" style={{ marginTop: 'auto' }}>
        <div style={sectionHeader}>
          <span>This week</span>
        </div>
        <TodaysOutput
          completedTasks={thisWeek.completed}
          awaitingApproval={thisWeek.awaiting}
          tasksInFlight={thisWeek.inFlight}
          voiceMatch="—"
        />
      </section>
    </aside>
  );
}

interface TaskPanelRowProps {
  task: DelegationTask;
  /**
   * Effective status — pre-computed by the parent from
   * `liveAgentRunStatus` so the row's label / partition stays in sync
   * with the actual agent_runs lifecycle. Falls back to `task.status`
   * when no live entry exists.
   */
  effectiveStatus: DelegationTask['status'];
  /**
   * Controlled-expansion: parent holds at most ONE expanded messageId
   * at a time so siblings stay visible. Click toggles via
   * `onToggleExpand`. Terminal rows are always passed `expanded=false`.
   */
  expanded: boolean;
  onToggleExpand: (messageId: string) => void;
  onJump?: (messageId: string, runId: string | null) => void;
  onCancel?: (agentId: string) => void | Promise<void>;
  onRetry?: (agentId: string) => void | Promise<void>;
  variant: 'expanded' | 'compact';
}

function TaskPanelRow({
  task,
  effectiveStatus,
  expanded,
  onToggleExpand,
  onJump,
  onCancel,
  onRetry,
  variant,
}: TaskPanelRowProps) {
  const [hover, setHover] = useState(false);
  const [pending, setPending] = useState(false);
  const isRunningRow =
    effectiveStatus === 'working' || effectiveStatus === 'queued';
  // `task.subagentType` is the redacted founder-facing label
  // (e.g. 'Social Media Manager'); when missing fall through to the
  // unknown-label gradient via the empty string.
  const accent = accentForAgentType(task.subagentType ?? '');
  const borderColor = accent?.solid ?? colorHexForAgentType(task.subagentType ?? '');

  const row: CSSProperties = {
    position: 'relative',
    padding:
      variant === 'expanded' ? '10px 10px 10px 14px' : '8px 10px 8px 14px',
    marginBottom: 6,
    borderRadius: 8,
    background: 'var(--sf-bg-secondary)',
    border: '1px solid rgba(0, 0, 0, 0.05)',
    cursor: onJump ? 'pointer' : 'default',
    transition: 'background 140ms var(--sf-ease-swift)',
    display: 'flex',
    flexDirection: 'column',
    gap: variant === 'expanded' ? 4 : 2,
  };
  const leftRule: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    background: borderColor,
  };
  const topLine: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: accent?.ink ?? borderColor,
  };
  const titleStyle: CSSProperties = {
    fontSize: 12.5,
    lineHeight: 1.35,
    color: 'var(--sf-fg-1)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: '-webkit-box',
    WebkitLineClamp: variant === 'expanded' ? 2 : 1,
    WebkitBoxOrient: 'vertical' as const,
  };
  const metaLine: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
    marginTop: 2,
  };

  // Use the effective status everywhere user-visible. Falls back to
  // task.status only when the parent didn't compute one (caller still
  // wires `effectiveStatus={statusFor(task)}` in both render sites).
  const status: DelegationTask['status'] = effectiveStatus;
  const isRunning = status === 'working' || status === 'queued';
  const agentLabel = task.subagentType ?? 'specialist';
  const statusLabel =
    status === 'working'
      ? 'RUNNING'
      : status === 'queued'
        ? 'QUEUED'
        : status === 'done'
          ? 'DONE'
          : 'FAILED';
  const statusColor =
    status === 'done'
      ? 'var(--sf-success-ink)'
      : status === 'failed'
        ? 'var(--sf-error-ink)'
        : 'var(--sf-accent)';

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onCancel || !task.agentId || pending) return;
    setPending(true);
    try {
      await onCancel(task.agentId);
    } finally {
      setPending(false);
    }
  };
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRetry || !task.agentId || pending) return;
    setPending(true);
    try {
      await onRetry(task.agentId);
    } finally {
      setPending(false);
    }
  };

  // Hover-revealed action: Stop on running/queued, Retry on terminal.
  // Gated on `task.agentId` because the reducer can surface a coord-side
  // DelegationTask before the async dispatch receipt has landed (the
  // brief window between Task tool_call and the spawned agent_runs row
  // becoming visible). The `/api/team/agent/[agentId]/...` endpoints
  // need a concrete agentId.
  const canCancel = isRunning && !!onCancel && !!task.agentId;
  const canRetry =
    (status === 'failed' || status === 'done') &&
    !!onRetry &&
    !!task.agentId;
  const showAction = hover && (canCancel || canRetry);

  const actionBtn: CSSProperties = {
    padding: '2px 6px',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 9.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    borderRadius: 4,
    border: '1px solid transparent',
    cursor: pending ? 'wait' : 'pointer',
    background: 'var(--sf-bg-primary)',
    color: 'var(--sf-fg-3)',
    marginLeft: 6,
  };

  // Click semantics:
  //   - On a RUNNING row: toggle expand, revealing the live progress feed.
  //     Holding shift+click jumps to the inline card (existing behavior).
  //   - On a TERMINAL row: jump to the inline card (existing behavior).
  // Pre-A2 the only click action was jump-to-inline. The new toggle is
  // additive — the right Tasks panel becomes the canonical "see what
  // this teammate is doing right now" surface.
  const handleRowClick = (e: React.MouseEvent) => {
    if (isRunning && !e.shiftKey) {
      onToggleExpand(task.messageId);
      return;
    }
    if (onJump) onJump(task.messageId, task.runId);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (isRunning) {
      onToggleExpand(task.messageId);
    } else if (onJump) {
      onJump(task.messageId, task.runId);
    }
  };

  return (
    <div
      style={row}
      onClick={handleRowClick}
      onKeyDown={onJump || isRunning ? handleKey : undefined}
      tabIndex={onJump || isRunning ? 0 : undefined}
      onMouseEnter={(e) => {
        setHover(true);
        (e.currentTarget as HTMLDivElement).style.background =
          'rgba(0, 0, 0, 0.025)';
      }}
      onMouseLeave={(e) => {
        setHover(false);
        (e.currentTarget as HTMLDivElement).style.background =
          'var(--sf-bg-secondary)';
      }}
      data-testid={`task-panel-row-${task.messageId}`}
      data-status={status}
      data-expanded={isRunningRow && expanded ? 'true' : 'false'}
      role={onJump || isRunning ? 'button' : undefined}
      aria-expanded={isRunning ? expanded : undefined}
      aria-label={`${agentLabel}: ${task.label}, ${status}`}
    >
      <span style={leftRule} aria-hidden="true" />
      <div style={topLine}>
        <span>{agentLabel}</span>
        <span style={{ color: statusColor }}>· {statusLabel}</span>
        <ElapsedCounter task={task} isRunning={isRunning} />
        {showAction && canCancel ? (
          <button
            type="button"
            onClick={handleCancel}
            disabled={pending}
            aria-label="Stop this subtask"
            style={{
              ...actionBtn,
              color: 'var(--sf-error-ink)',
              borderColor: 'color-mix(in oklch, var(--sf-error) 30%, transparent)',
            }}
          >
            ◻ Stop
          </button>
        ) : null}
        {showAction && canRetry ? (
          <button
            type="button"
            onClick={handleRetry}
            disabled={pending}
            aria-label="Retry this subtask"
            style={actionBtn}
          >
            ↻ Retry
          </button>
        ) : null}
      </div>
      <div style={titleStyle}>{task.label}</div>
      {variant === 'expanded' && isRunning && !expanded ? (
        <div style={metaLine}>
          <span style={{ color: borderColor }}>⤵</span>
          <span>{deriveLiveActivity(task)}</span>
        </div>
      ) : null}
      {variant === 'expanded' && isRunning && expanded ? (
        <ProgressDetail items={task.progressItems} accentColor={borderColor} />
      ) : null}
    </div>
  );
}

/**
 * Inline-expanded progress feed for a running row. Mirrors the chat-
 * side DelegationCard's progress list pattern but stripped down: the
 * panel is narrow, so we render tool names + text bursts as a vertical
 * list without the nested indentation. Caps at the most recent 20
 * entries so a 60-tool sweep doesn't push the rest of the panel
 * off-screen.
 */
function ProgressDetail({
  items,
  accentColor,
}: {
  items: readonly ProgressItem[];
  accentColor: string;
}) {
  const wrap: CSSProperties = {
    marginTop: 8,
    padding: '8px 8px 8px 10px',
    borderRadius: 6,
    background: 'var(--sf-bg-primary)',
    borderLeft: `2px solid ${accentColor}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    // Expanded card needs room for tool outputs + multi-line agent text.
    // 360px ≈ ~15-20 progress rows; inner overflow scrolls older items
    // without losing sibling cards.
    maxHeight: 360,
    overflowY: 'auto',
  };
  const row: CSSProperties = {
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
    lineHeight: 1.45,
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
  };
  const tool: CSSProperties = {
    fontWeight: 500,
    color: 'var(--sf-fg-2)',
  };
  const text: CSSProperties = {
    color: 'var(--sf-fg-2)',
    fontFamily: 'inherit',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
  const toolOutput: CSSProperties = {
    marginLeft: 18,
    padding: '4px 8px',
    borderRadius: 4,
    background: 'rgba(0, 0, 0, 0.03)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-2)',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
  const elapsed: CSSProperties = {
    marginLeft: 'auto',
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
  };

  const visible = items.slice(-20);
  const hidden = items.length - visible.length;
  if (items.length === 0) {
    return (
      <div style={wrap}>
        <div style={{ ...row, fontStyle: 'italic', color: 'var(--sf-fg-4)' }}>
          thinking…
        </div>
      </div>
    );
  }
  return (
    <div style={wrap} role="region" aria-label="Live progress">
      {hidden > 0 ? (
        <div style={row}>
          <span>+{hidden} earlier {hidden === 1 ? 'event' : 'events'}</span>
        </div>
      ) : null}
      {visible.map((item) => {
        if (item.kind === 'tool') {
          return (
            <div
              key={item.id}
              style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <div style={row}>
                <span aria-hidden="true">└ ◈</span>
                <span style={tool}>{item.toolName}</span>
                {item.errorText ? (
                  <span style={{ color: 'var(--sf-error-ink)' }}>— {item.errorText}</span>
                ) : null}
                {item.elapsed ? <span style={elapsed}>{item.elapsed}</span> : null}
              </div>
              {item.output ? <div style={toolOutput}>{item.output}</div> : null}
            </div>
          );
        }
        if (item.kind === 'group') {
          return (
            <div key={item.id} style={row}>
              <span aria-hidden="true">└ ⊡</span>
              <span style={tool}>{item.label}</span>
            </div>
          );
        }
        // text — render the full content (multi-line preserved via
        // pre-wrap). The wrap's own maxHeight bounds vertical growth.
        return (
          <div key={item.id} style={text}>
            {item.text}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ticks once per second while the task is running so the elapsed
 * counter stays fresh without a parent re-render. When the task
 * settles we show the final `task.elapsed` from the reducer and stop
 * ticking — no stale "still running 999s" after a fast task.
 */
function ElapsedCounter({
  task,
  isRunning,
}: {
  task: DelegationTask;
  isRunning: boolean;
}) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsedSeconds(
        Math.floor((Date.now() - (startedAtRef.current ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const style: CSSProperties = {
    marginLeft: 'auto',
    color: 'var(--sf-fg-4)',
  };
  if (!isRunning) {
    return task.elapsed ? <span style={style}>{task.elapsed}</span> : null;
  }
  return <span style={style}>{elapsedSeconds}s</span>;
}

/**
 * "What is the subagent doing right now" — derived from
 * `progressItems`. If the last item is a tool, show its name; if text,
 * show "drafting response"; if nothing yet, "thinking…". Mirrors
 * Claude Code's `lastActivity.activityDescription` (engine/Task.ts).
 */
function deriveLiveActivity(task: DelegationTask): string {
  const items = task.progressItems;
  if (items.length === 0) return 'thinking…';
  const last = items[items.length - 1];
  if (last.kind === 'tool') {
    return last.complete ? `ran ${last.toolName}` : `running ${last.toolName}`;
  }
  if (last.kind === 'group') return last.label;
  return 'drafting response';
}
