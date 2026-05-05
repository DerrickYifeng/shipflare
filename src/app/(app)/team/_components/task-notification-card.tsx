import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';

import {
  AgentStatusPill,
  type AgentStatus,
} from './agent-status-pill';

// Mirrors `synthesizeTaskNotification` in
// `src/workers/processors/lib/synthesize-notification.ts`. The XML schema
// is engine PDF §3.6 verbatim — the `<r>` (result) tag name and the
// `<usage>` sub-tags are deliberate engine choices.
export type TaskNotificationStatus = 'completed' | 'failed' | 'killed';

export interface TaskNotificationData {
  taskId: string;
  status: TaskNotificationStatus;
  summary: string;
  result: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

const TAG_PATTERNS = {
  taskId: /<task-id>([\s\S]*?)<\/task-id>/,
  status: /<status>([\s\S]*?)<\/status>/,
  summary: /<summary>([\s\S]*?)<\/summary>/,
  result: /<r>([\s\S]*?)<\/r>/,
  totalTokens: /<total_tokens>(\d+)<\/total_tokens>/,
  toolUses: /<tool_uses>(\d+)<\/tool_uses>/,
  durationMs: /<duration_ms>(\d+)<\/duration_ms>/,
} as const;

const XML_UNESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

// Reverse of `escapeXml` in `synthesize-notification.ts`. The synthesizer
// only emits these 5 entities, so a fixed table is sufficient — no DOM
// parser required.
function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_UNESCAPES[m] ?? m);
}

function isTerminalStatus(s: string): s is TaskNotificationStatus {
  return s === 'completed' || s === 'failed' || s === 'killed';
}

/**
 * Parse a `<task-notification>` XML payload. Returns `null` when the
 * payload is missing the two required tags (`<task-id>`, `<status>`) or
 * the status is not one of the three terminal values. Optional `<usage>`
 * sub-tags are only attached when all three are present.
 */
export function parseTaskNotification(
  xml: string,
): TaskNotificationData | null {
  const taskIdMatch = xml.match(TAG_PATTERNS.taskId);
  const statusMatch = xml.match(TAG_PATTERNS.status);
  if (!taskIdMatch || !statusMatch) return null;

  const taskId = unescapeXml(taskIdMatch[1].trim());
  const rawStatus = statusMatch[1].trim();
  if (!taskId || !isTerminalStatus(rawStatus)) return null;

  const summary = unescapeXml(
    xml.match(TAG_PATTERNS.summary)?.[1].trim() ?? '',
  );
  const result = unescapeXml(
    xml.match(TAG_PATTERNS.result)?.[1].trim() ?? '',
  );

  const totalTokensRaw = xml.match(TAG_PATTERNS.totalTokens)?.[1];
  const toolUsesRaw = xml.match(TAG_PATTERNS.toolUses)?.[1];
  const durationMsRaw = xml.match(TAG_PATTERNS.durationMs)?.[1];

  const usage =
    totalTokensRaw != null && toolUsesRaw != null && durationMsRaw != null
      ? {
          totalTokens: Number(totalTokensRaw),
          toolUses: Number(toolUsesRaw),
          durationMs: Number(durationMsRaw),
        }
      : undefined;

  return { taskId, status: rawStatus, summary, result, usage };
}

export interface TaskNotificationCardProps {
  /** Raw `<task-notification>` XML body (engine §3.6). */
  xml: string;
  /** Human-friendly teammate display name from `team_members`. */
  teammateName?: string;
  /** Click/keyboard handler — typically opens the transcript drawer. */
  onClickAgent?: (agentId: string) => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

function formatToolUses(n: number): string {
  return `${n} tool call${n === 1 ? '' : 's'}`;
}

/**
 * Render a `<task-notification>` XML payload as a compact card with the
 * teammate name, an `AgentStatusPill` reflecting the terminal status, the
 * synthesized summary, and (when present) a usage chip showing tokens,
 * tool calls, and wall-clock duration.
 *
 * Pure presentation. The caller (typically `<TeamDesk>` or a transcript
 * subscriber) is responsible for plucking the XML from the
 * `team_messages.content` field and supplying the optional `teammateName`
 * + `onClickAgent` props.
 *
 * Returns `null` when the XML is malformed or missing required fields,
 * matching the common "render nothing rather than throw on bad input"
 * convention used by the other team components.
 */
export function TaskNotificationCard({
  xml,
  teammateName,
  onClickAgent,
}: TaskNotificationCardProps) {
  const data = parseTaskNotification(xml);
  if (!data) return null;

  const interactive = typeof onClickAgent === 'function';

  const wrap: CSSProperties = {
    padding: 12,
    borderRadius: 10,
    border: '1px solid rgba(0, 0, 0, 0.08)',
    background: 'var(--sf-bg-secondary, #fafafa)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    cursor: interactive ? 'pointer' : 'default',
    transition: 'background 120ms var(--sf-ease-smooth, ease)',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  };

  const teammate: CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--sf-fg-1)',
  };

  const summary: CSSProperties = {
    fontSize: 13,
    color: 'var(--sf-fg-2)',
    lineHeight: 1.5,
    margin: 0,
    whiteSpace: 'pre-wrap',
  };

  const usageRow: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.04)',
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    alignSelf: 'flex-start',
  };

  function handleClick(_e: MouseEvent<HTMLDivElement>): void {
    onClickAgent?.(data!.taskId);
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (!interactive) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClickAgent?.(data!.taskId);
    }
  }

  return (
    <div
      style={wrap}
      data-testid="task-notification-card"
      data-status={data.status}
      data-task-id={data.taskId}
      role={interactive ? 'button' : 'article'}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKey : undefined}
      aria-label={
        teammateName
          ? `Task notification from ${teammateName}: ${data.status}`
          : `Task notification: ${data.status}`
      }
    >
      <div style={header}>
        <span style={teammate}>{teammateName ?? data.taskId}</span>
        <AgentStatusPill status={data.status as AgentStatus} />
      </div>
      {data.summary ? <p style={summary}>{data.summary}</p> : null}
      {data.usage ? (
        <span style={usageRow} data-testid="task-notification-usage">
          {formatTokens(data.usage.totalTokens)} tokens ·{' '}
          {formatToolUses(data.usage.toolUses)} ·{' '}
          {formatDuration(data.usage.durationMs)}
        </span>
      ) : null}
    </div>
  );
}
