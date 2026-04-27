'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { DelegationTask, ProgressItem } from './conversation-reducer';
import { accentForAgentType, colorHexForAgentType } from './agent-accent';
import { MessageMarkdown, stripMarkdownForPreview } from './message-markdown';

export interface DelegationCardMember {
  id: string;
  agentType: string;
  displayName: string;
}

export interface DelegationCardProps {
  tasks: readonly DelegationTask[];
  memberLookup: ReadonlyMap<string, DelegationCardMember>;
  activeMemberId: string | null;
  onSelectMember: (memberId: string) => void;
}

const SUMMARY_COLLAPSED_CHARS = 180;

/**
 * Top-level dispatch container rendered inline beneath a `LeadNode` that
 * has one or more Task tool_calls stitched to it. Visual layout mirrors
 * the reference design: a sectioned card with an uppercase mono header
 * (`⊕ DISPATCH · TEAM LEAD → N SPECIALISTS`) and a stack of subtask
 * cards, each with a signature-colored left border per specialist.
 *
 * Revoke / reassign actions were intentionally left out per product
 * decision — their backend side (BullMQ cancel + re-enqueue) is a
 * separate phase.
 */
export function DelegationCard({
  tasks,
  memberLookup,
  activeMemberId,
  onSelectMember,
}: DelegationCardProps) {
  if (tasks.length === 0) return null;

  // Secondary index for the `subagent_type → member` fallback. Tool_call
  // rows land with `to_member_id = null`, so without this we'd label
  // every subtask "Specialist". Building the index once per render keeps
  // the per-card lookup O(1).
  const membersByAgentType = new Map<string, DelegationCardMember>();
  for (const m of memberLookup.values()) {
    if (m.agentType && !membersByAgentType.has(m.agentType)) {
      membersByAgentType.set(m.agentType, m);
    }
  }

  const resolveMember = (
    task: { toMemberId: string | null; subagentType: string | null },
  ): DelegationCardMember | null => {
    if (task.toMemberId) {
      const m = memberLookup.get(task.toMemberId);
      if (m) return m;
    }
    if (task.subagentType) {
      return membersByAgentType.get(task.subagentType) ?? null;
    }
    return null;
  };

  const wrap: CSSProperties = {
    marginTop: 10,
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
    padding: '14px 14px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    border: '1px solid rgba(0, 0, 0, 0.06)',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--sf-fg-2)',
  };

  const hairline: CSSProperties = {
    flex: 1,
    height: 1,
    background: 'rgba(0, 0, 0, 0.06)',
  };

  const stack: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    margin: 0,
    padding: 0,
    listStyle: 'none',
  };

  const specialistCount = tasks.length;

  return (
    <section style={wrap} aria-label="Dispatched subtasks">
      <div style={header}>
        <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>
          ⊕
        </span>
        <span>Dispatch</span>
        <span aria-hidden="true">·</span>
        <span>Team Lead → {specialistCount}&nbsp;Specialist{specialistCount === 1 ? '' : 's'}</span>
        <span style={hairline} aria-hidden="true" />
      </div>
      <ul style={stack}>
        {tasks.map((task) => {
          const member = resolveMember(task);
          return (
            <SubtaskCard
              key={task.messageId}
              task={task}
              member={member}
              active={!!activeMemberId && !!member && member.id === activeMemberId}
              onSelectMember={onSelectMember}
            />
          );
        })}
      </ul>
    </section>
  );
}

interface SubtaskCardProps {
  task: DelegationTask;
  member: DelegationCardMember | null;
  active: boolean;
  onSelectMember: (memberId: string) => void;
}

function SubtaskCard({
  task,
  member,
  active,
  onSelectMember: _onSelectMember,
}: SubtaskCardProps) {
  const [hover, setHover] = useState(false);
  // Default: expand on RUNNING (user wants to see live progress),
  // collapse on any terminal state (history shouldn't dominate). The
  // auto-fold-on-transition below keeps the user's manual toggle
  // sticky after that first settle.
  const [expanded, setExpanded] = useState<boolean>(
    () => task.status === 'working',
  );
  const prevStatusRef = useRef(task.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = task.status;
    if (prev === 'working' && task.status !== 'working') {
      // Task just settled — fold once. User can reopen by clicking.
      // queueMicrotask defers the setState past the current render cycle.
      queueMicrotask(() => setExpanded(false));
    }
  }, [task.status]);

  // Right-rail Task panel dispatches `sf:task-focus` when the user
  // clicks a Recent row so the matching subtask card force-expands
  // alongside the scroll-into-view. Without this the user lands on a
  // collapsed terminal card and has to click again to see details.
  useEffect(() => {
    const handler = (evt: Event): void => {
      const detail = (evt as CustomEvent<{ messageId: string }>).detail;
      if (detail?.messageId === task.messageId) {
        setExpanded(true);
      }
    };
    window.addEventListener('sf:task-focus', handler);
    return () => window.removeEventListener('sf:task-focus', handler);
  }, [task.messageId]);

  const agentType = member?.agentType ?? 'coordinator';
  const accent = accentForAgentType(agentType);
  const borderColor = accent?.solid ?? colorHexForAgentType(agentType);
  const memberName = member?.displayName ?? 'Specialist';

  const card: CSSProperties = {
    position: 'relative',
    padding: '10px 12px 10px 16px',
    borderRadius: 8,
    background: active
      ? 'var(--sf-bg-secondary)'
      : hover
        ? 'rgba(0, 0, 0, 0.02)'
        : 'var(--sf-bg-secondary)',
    border: '1px solid rgba(0, 0, 0, 0.05)',
    transition: 'background 160ms var(--sf-ease-swift)',
    listStyle: 'none',
    boxShadow: active
      ? '0 0 0 1px rgba(0, 113, 227, 0.18), 0 1px 3px rgba(0, 0, 0, 0.04)'
      : undefined,
  };

  const leftRule: CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 10,
    bottom: 10,
    width: 3,
    borderRadius: 2,
    background: borderColor,
  };

  const topRow: CSSProperties = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  };

  const title: CSSProperties = {
    fontSize: 13.5,
    fontWeight: 500,
    color: 'var(--sf-fg-1)',
    letterSpacing: '-0.01em',
    lineHeight: 1.35,
    flex: 1,
    minWidth: 0,
  };

  const metaRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: task.outputSummary ? 6 : 0,
  };

  const memberStyle: CSSProperties = {
    color: accent?.ink ?? borderColor,
  };

  const subtaskStyle: CSSProperties = {
    color: 'var(--sf-fg-4)',
  };

  const summaryStyle: CSSProperties = {
    margin: 0,
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--sf-fg-2)',
    letterSpacing: '-0.005em',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const expandBtn: CSSProperties = {
    marginTop: 4,
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    cursor: 'pointer',
  };

  // Collapsed preview: strip markdown markers so a one-liner stays
  // clean (no stray `##` / `**` cut mid-syntax) and truncate on the
  // flattened string. Expanded mode renders the full markdown tree
  // via MessageMarkdown below.
  const previewSource = task.outputSummary
    ? stripMarkdownForPreview(task.outputSummary)
    : null;
  const collapsedSummary =
    previewSource && previewSource.length > SUMMARY_COLLAPSED_CHARS
      ? `${previewSource.slice(0, SUMMARY_COLLAPSED_CHARS).trimEnd()}…`
      : previewSource;

  const toggleExpand = () => {
    setExpanded((v) => !v);
  };

  const hasProgress = task.progressItems.length > 0;
  const showThinking = task.status === 'working' && !hasProgress;

  return (
    <li
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={card}
      data-testid={`subtask-card-${task.messageId}`}
      data-member-id={member?.id ?? ''}
      data-status={task.status}
      aria-label={`${task.label}, ${task.status}`}
    >
      <span style={leftRule} aria-hidden="true" />

      {/* Clickable header — toggles expand/collapse. The chevron +
          title + status pill form the expand hit target. */}
      <button
        type="button"
        onClick={toggleExpand}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          width: '100%',
          display: 'block',
        }}
      >
        <div style={topRow}>
          <span style={title}>{task.label}</span>
          <StatusBadge status={task.status} elapsed={task.elapsed} />
          <ExpandChevron expanded={expanded} />
        </div>
        <div style={metaRow}>
          <span style={memberStyle}>{memberName}</span>
          <span aria-hidden="true">·</span>
          <span style={subtaskStyle}>Subtask</span>
        </div>
      </button>

      {/* Body: progress feed + thinking placeholder + summary. Expanded
          renders the full progressItems list; collapsed shows only the
          final summary as a one-liner (if any). */}
      {expanded ? (
        <div style={{ marginTop: 2 }}>
          {hasProgress ? (
            <ProgressList items={task.progressItems} accentColor={borderColor} />
          ) : null}
          {showThinking ? <ThinkingRow accentColor={borderColor} /> : null}
          {task.outputSummary && task.status !== 'working' ? (
            <ResultSummary text={task.outputSummary} status={task.status} />
          ) : null}
        </div>
      ) : (
        <>
          {collapsedSummary ? (
            <p style={summaryStyle}>{collapsedSummary}</p>
          ) : showThinking ? (
            <ThinkingRow accentColor={borderColor} />
          ) : null}
        </>
      )}
    </li>
  );
}

/**
 * Mini chevron — rotates 90° when expanded. Decorative; the whole
 * header is already a button so focus/ARIA lives there, not here.
 */
function ExpandChevron({ expanded }: { expanded: boolean }) {
  const style: CSSProperties = {
    display: 'inline-block',
    transition: 'transform 160ms var(--sf-ease-swift, ease)',
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
    color: 'var(--sf-fg-4)',
    fontSize: 10,
    marginLeft: 4,
    flexShrink: 0,
  };
  return (
    <span style={style} aria-hidden="true">
      ▶
    </span>
  );
}

/**
 * Renders a subagent's progress feed — a scoped mini-timeline inside
 * the subtask card. `kind: 'tool'` items are a single line like
 * `└ ◈ query_plan_items · 1s`. `kind: 'group'` items collapse runs of
 * same-named tools into `└ ⊡ 5 × add_plan_item · 2s` (Claude Code's
 * processProgressMessages pattern). `kind: 'text'` items show the
 * subagent's narration indented under the tool list.
 */
function ProgressList({
  items,
  accentColor,
}: {
  items: readonly ProgressItem[];
  accentColor: string;
}) {
  const list: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '6px 0 4px',
  };
  return (
    <div style={list} aria-label="Subagent progress">
      {items.map((item) => (
        <ProgressRow key={item.id} item={item} accentColor={accentColor} />
      ))}
    </div>
  );
}

function ProgressRow({
  item,
  accentColor,
}: {
  item: ProgressItem;
  accentColor: string;
}) {
  const base: CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
    lineHeight: 1.5,
  };
  const treeMark: CSSProperties = {
    color: 'var(--sf-fg-4)',
    flexShrink: 0,
  };
  const elapsed: CSSProperties = {
    color: 'var(--sf-fg-4)',
    marginLeft: 'auto',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };
  if (item.kind === 'tool') {
    const isError = !!item.errorText;
    return (
      <div
        style={{ ...base, color: isError ? 'var(--sf-error-ink)' : base.color }}
      >
        <span style={treeMark}>└ ◈</span>
        <span style={{ fontWeight: 500, color: 'var(--sf-fg-2)' }}>
          {item.toolName}
        </span>
        {isError ? (
          <span style={{ color: 'var(--sf-error-ink)' }}>— {item.errorText}</span>
        ) : null}
        {item.elapsed ? <span style={elapsed}>{item.elapsed}</span> : null}
      </div>
    );
  }
  if (item.kind === 'group') {
    const dur =
      item.durationMs != null
        ? item.durationMs < 1000
          ? '<1s'
          : item.durationMs < 60_000
            ? `${Math.round(item.durationMs / 1000)}s`
            : `${Math.floor(item.durationMs / 60_000)}m`
        : null;
    return (
      <div style={base}>
        <span style={treeMark}>└ ⊡</span>
        <span style={{ fontWeight: 500, color: 'var(--sf-fg-2)' }}>
          {item.label}
        </span>
        {dur ? <span style={elapsed}>{dur}</span> : null}
      </div>
    );
  }
  // text — agent narration between tool calls. Render as markdown so
  // `##` / `**` / `` ` `` don't leak as literals; keep the accent
  // left-rule so the progress stream still visually threads.
  const textWrap: CSSProperties = {
    margin: '4px 0 4px 14px',
    fontSize: 12.5,
    lineHeight: 1.5,
    color: 'var(--sf-fg-2)',
    borderLeft: `2px solid ${accentColor}`,
    paddingLeft: 8,
  };
  return (
    <div style={textWrap}>
      <MessageMarkdown text={item.text} />
    </div>
  );
}

/**
 * Final result block — shows up inside an expanded subtask card after
 * the subagent returned. Greys out with a ✕ prefix for `failed`.
 */
function ResultSummary({
  text,
  status,
}: {
  text: string;
  status: DelegationTask['status'];
}) {
  const isError = status === 'failed';
  const wrap: CSSProperties = {
    marginTop: 8,
    padding: '8px 10px',
    borderRadius: 6,
    background: isError
      ? 'color-mix(in oklch, var(--sf-error) 8%, transparent)'
      : 'color-mix(in oklch, var(--sf-success) 6%, transparent)',
    borderLeft: `2px solid ${
      isError ? 'var(--sf-error)' : 'var(--sf-success)'
    }`,
    color: 'var(--sf-fg-1)',
  };
  const markerStyle: CSSProperties = {
    display: 'inline-block',
    marginRight: 8,
    fontWeight: 600,
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-success-ink)',
    float: 'left',
    lineHeight: 1.55,
  };
  return (
    <div style={wrap}>
      <span style={markerStyle} aria-hidden="true">
        {isError ? '✕' : '✓'}
      </span>
      <MessageMarkdown text={text} />
    </div>
  );
}

/**
 * Live-updating "still thinking, been N seconds" line rendered inside a
 * subtask card that's RUNNING but hasn't produced a summary yet. Fills
 * the perceptual gap between Task dispatch and the subagent's first
 * visible output (LLM TTFB + any silent tool calls). Mounts the moment
 * the card goes into running state and unmounts as soon as a summary or
 * terminal status replaces it — no explicit reset needed.
 */
function ThinkingRow({ accentColor }: { accentColor: string }) {
  const startedAtRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    startedAtRef.current = Date.now();
    const id = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - (startedAtRef.current ?? Date.now())) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
    letterSpacing: 0.2,
  };
  const dotBase: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: accentColor,
    animation: 'sf-subtask-pulse 1.2s ease-in-out infinite',
  };
  const elapsed: CSSProperties = {
    marginLeft: 'auto',
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
  };
  return (
    <div style={row}>
      <span style={{ display: 'inline-flex', gap: 3 }}>
        <span style={{ ...dotBase, animationDelay: '0ms' }} />
        <span style={{ ...dotBase, animationDelay: '180ms' }} />
        <span style={{ ...dotBase, animationDelay: '360ms' }} />
      </span>
      <span>thinking…</span>
      {elapsedSeconds >= 1 ? <span style={elapsed}>{elapsedSeconds}s</span> : null}
      <style jsx>{`
        @keyframes sf-subtask-pulse {
          0%,
          80%,
          100% {
            opacity: 0.3;
            transform: scale(0.85);
          }
          40% {
            opacity: 1;
            transform: scale(1.1);
          }
        }
      `}</style>
    </div>
  );
}

function StatusBadge({
  status,
  elapsed,
}: {
  status: DelegationTask['status'];
  elapsed: string | null;
}) {
  let label: string;
  let fg: string;
  let bg: string;
  const isRunning = status === 'working';
  switch (status) {
    case 'done':
      label = elapsed ? `DONE · ${elapsed}` : 'DONE';
      fg = 'var(--sf-success-ink)';
      bg = 'color-mix(in oklch, var(--sf-success) 18%, transparent)';
      break;
    case 'working':
      label = 'RUNNING';
      fg = 'var(--sf-accent)';
      bg = 'color-mix(in oklch, var(--sf-accent) 14%, transparent)';
      break;
    case 'failed':
      label = 'FAILED';
      fg = 'var(--sf-error-ink)';
      bg = 'color-mix(in oklch, var(--sf-error) 16%, transparent)';
      break;
    case 'queued':
    default:
      label = 'QUEUED';
      fg = 'var(--sf-fg-3)';
      bg = 'rgba(0, 0, 0, 0.05)';
      break;
  }
  const pill: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    borderRadius: 4,
    background: bg,
    color: fg,
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 9.5,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    // A slow breathing opacity while the subtask is running. Matches
    // the conversation-level typing indicator's visual rhythm so the
    // whole page reads as "alive" instead of "frozen waiting for an
    // API response that may or may not come".
    animation: isRunning ? 'sf-running-breath 1.8s ease-in-out infinite' : undefined,
  };
  return (
    <span style={pill}>
      {label}
      <style jsx>{`
        @keyframes sf-running-breath {
          0%,
          100% {
            opacity: 0.7;
          }
          50% {
            opacity: 1;
          }
        }
      `}</style>
    </span>
  );
}
