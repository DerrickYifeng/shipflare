'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { DelegationTask } from './conversation-reducer';
import { accentForAgentType, colorHexForAgentType } from './agent-accent';
import { TodaysOutput } from './todays-output';

export interface TaskPanelProps {
  tasks: readonly DelegationTask[];
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
   * `taskId` (team_tasks.id). Matches the inline SubtaskCard handler
   * so both surfaces point at the same backend endpoint.
   */
  onCancelTask?: (taskId: string) => void | Promise<void>;
  /**
   * Hover-revealed Retry action on a DONE / FAILED row. Spawns a fresh
   * team_run with the same prompt — caller routes to the new session.
   */
  onRetryTask?: (taskId: string) => void | Promise<void>;
  /** Metrics for the THIS WEEK section at the bottom. */
  thisWeek: {
    completed: number;
    awaiting: number;
    inFlight: number;
  };
}

const RECENT_DEFAULT_LIMIT = 3;

export function TaskPanel({
  tasks,
  onJumpToTask,
  onCancelTask,
  onRetryTask,
  thisWeek,
}: TaskPanelProps) {
  // Partition by status. Running on top (always expanded), terminal
  // below in a capped RECENT section. `queued` gets bucketed with
  // running — it's transient and visually conveys "about to start".
  const running = useMemo(
    () =>
      tasks.filter((t) => t.status === 'working' || t.status === 'queued'),
    [tasks],
  );
  const recentAll = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'done' || t.status === 'failed')
        .slice()
        // Approximate "recency" via messageId reverse — the top-level
        // stitcher emits delegations in chronological order, so later
        // messageIds correspond to later tool_calls. Good enough for
        // a sidebar heuristic; if we wire createdAt later, sort here.
        .reverse(),
    [tasks],
  );

  const [showAllRecent, setShowAllRecent] = useState(false);
  const recentVisible = showAllRecent
    ? recentAll
    : recentAll.slice(0, RECENT_DEFAULT_LIMIT);
  const hiddenCount = Math.max(0, recentAll.length - recentVisible.length);

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
  onJump?: (messageId: string, runId: string | null) => void;
  onCancel?: (taskId: string) => void | Promise<void>;
  onRetry?: (taskId: string) => void | Promise<void>;
  variant: 'expanded' | 'compact';
}

function TaskPanelRow({
  task,
  onJump,
  onCancel,
  onRetry,
  variant,
}: TaskPanelRowProps) {
  const [hover, setHover] = useState(false);
  const [pending, setPending] = useState(false);
  const accent = accentForAgentType(task.subagentType ?? 'coordinator');
  const borderColor =
    accent?.solid ?? colorHexForAgentType(task.subagentType ?? 'coordinator');

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

  const isRunning = task.status === 'working' || task.status === 'queued';
  const agentLabel = task.subagentType ?? 'specialist';
  const statusLabel =
    task.status === 'working'
      ? 'RUNNING'
      : task.status === 'queued'
        ? 'QUEUED'
        : task.status === 'done'
          ? 'DONE'
          : 'FAILED';
  const statusColor =
    task.status === 'done'
      ? 'var(--sf-success-ink)'
      : task.status === 'failed'
        ? 'var(--sf-error-ink)'
        : 'var(--sf-accent)';

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onCancel || !task.taskId || pending) return;
    setPending(true);
    try {
      await onCancel(task.taskId);
    } finally {
      setPending(false);
    }
  };
  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRetry || !task.taskId || pending) return;
    setPending(true);
    try {
      await onRetry(task.taskId);
    } finally {
      setPending(false);
    }
  };

  // Hover-revealed action: Stop on running/queued, Retry on terminal.
  // Gated on `task.taskId` because the reducer can surface a coord-side
  // DelegationTask without a DB row (e.g. pre-insert retries) and we
  // need a concrete taskId to hit the `/api/team/task/...` endpoints.
  const canCancel = isRunning && !!onCancel && !!task.taskId;
  const canRetry =
    (task.status === 'failed' || task.status === 'done') &&
    !!onRetry &&
    !!task.taskId;
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

  return (
    <div
      style={row}
      onClick={onJump ? () => onJump(task.messageId, task.runId) : undefined}
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
      data-status={task.status}
      role={onJump ? 'button' : undefined}
      aria-label={`${agentLabel}: ${task.label}, ${task.status}`}
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
      {variant === 'expanded' && isRunning ? (
        <div style={metaLine}>
          <span style={{ color: borderColor }}>⤵</span>
          <span>{deriveLiveActivity(task)}</span>
        </div>
      ) : null}
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
  const startedAtRef = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => {
      setElapsedSeconds(
        Math.floor((Date.now() - startedAtRef.current) / 1000),
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
