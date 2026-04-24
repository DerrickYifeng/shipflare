'use client';

import {
  type CSSProperties,
  type ReactNode,
  useMemo,
  useState,
} from 'react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  useTeamEvents,
  type TeamActivityMessage,
  type TeamMessageType,
} from '@/hooks/use-team-events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityLogMemberRef {
  id: string;
  displayName: string;
  agentType: string;
}

export interface ActivityLogProps {
  teamId: string;
  memberId: string;
  /** All known members on the team, used to label from/to of messages. */
  members: ActivityLogMemberRef[];
  initialMessages: TeamActivityMessage[];
  /**
   * Test-only — skip the SSE subscription and render straight from
   * `initialMessages`. Lets vitest drive `activity-log` in jsdom without
   * needing an EventSource polyfill or test server.
   */
  __disableLiveUpdates?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_TYPES: readonly TeamMessageType[] = [
  'user_prompt',
  'agent_text',
  'tool_call',
  'tool_result',
  'completion',
  'error',
  'thinking',
];

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function extractToolName(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  // Worker writes `toolName` (see emitToolEvent). Keep `tool_name` as a
  // historical fallback for rows persisted before the key was normalized.
  const camel = metadata['toolName'];
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = metadata['tool_name'];
  return typeof snake === 'string' && snake.length > 0 ? snake : null;
}

function shortId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

function labelMember(
  memberId: string | null,
  members: ActivityLogMemberRef[],
): string {
  if (!memberId) return 'You';
  const m = members.find((x) => x.id === memberId);
  if (m) return m.displayName;
  return shortId(memberId);
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActivityLog({
  teamId,
  memberId,
  members,
  initialMessages,
  __disableLiveUpdates,
}: ActivityLogProps) {
  // Hook must always be called (rules of hooks), but we ignore its output when
  // live updates are disabled (tests) and render from `initialMessages`
  // directly. The hook internally guards on `teamId` so passing a dummy id
  // is cheap; we pass the real one so the test still exercises the import.
  const live = useTeamEvents({
    teamId,
    initialMessages,
    filter: (msg) => msg.from === memberId || msg.to === memberId,
  });
  const messages = __disableLiveUpdates ? initialMessages : live.messages;
  const isConnected = __disableLiveUpdates ? false : live.isConnected;
  const reconnecting = __disableLiveUpdates ? false : live.reconnecting;

  const [typeFilter, setTypeFilter] = useState<'all' | TeamMessageType>('all');
  const [runFilter, setRunFilter] = useState<string>('all');
  const [showThinking, setShowThinking] = useState(false);

  const runOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) if (m.runId) set.add(m.runId);
    return Array.from(set);
  }, [messages]);

  const filtered = useMemo(() => {
    return messages.filter((m) => {
      if (typeFilter !== 'all' && m.type !== typeFilter) return false;
      if (runFilter !== 'all' && m.runId !== runFilter) return false;
      if (!showThinking && m.type === 'thinking') return false;
      return true;
    });
  }, [messages, typeFilter, runFilter, showThinking]);

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sf-space-lg)',
  };

  const toolbarStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sf-space-md)',
    flexWrap: 'wrap',
    padding: 'var(--sf-space-md) var(--sf-space-base)',
    background: 'var(--sf-bg-secondary)',
    border: '1px solid var(--sf-border-subtle)',
    borderRadius: 'var(--sf-radius-lg)',
  };

  const labelStyle: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    fontFamily: 'var(--sf-font-mono)',
    textTransform: 'lowercase',
    letterSpacing: 0.4,
  };

  const selectStyle: CSSProperties = {
    height: 28,
    padding: '0 8px',
    borderRadius: 'var(--sf-radius-md)',
    background: 'var(--sf-bg-secondary)',
    border: '1px solid var(--sf-border)',
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-1)',
    fontFamily: 'inherit',
  };

  const statusStyle: CSSProperties = {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 'var(--sf-text-xs)',
    color: reconnecting
      ? 'var(--sf-warning-ink)'
      : isConnected
        ? 'var(--sf-success-ink)'
        : 'var(--sf-fg-3)',
  };

  const statusDot: CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: reconnecting
      ? 'var(--sf-warning)'
      : isConnected
        ? 'var(--sf-success)'
        : 'var(--sf-fg-4)',
    transition: 'background 200ms ease',
  };

  return (
    <section style={containerStyle} aria-label="Activity log">
      <div style={toolbarStyle}>
        <span style={labelStyle}>type</span>
        <select
          aria-label="Filter by message type"
          style={selectStyle}
          value={typeFilter}
          onChange={(e) =>
            setTypeFilter(e.target.value as 'all' | TeamMessageType)
          }
        >
          <option value="all">all</option>
          {KNOWN_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <span style={labelStyle}>run</span>
        <select
          aria-label="Filter by run"
          style={selectStyle}
          value={runFilter}
          onChange={(e) => setRunFilter(e.target.value)}
        >
          <option value="all">all runs</option>
          {runOptions.map((r) => (
            <option key={r} value={r}>
              {shortId(r)}
            </option>
          ))}
        </select>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-2)',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={showThinking}
            onChange={(e) => setShowThinking(e.target.checked)}
          />
          show thinking
        </label>

        <div style={statusStyle} aria-live="polite">
          <span style={statusDot} aria-hidden="true" />
          {reconnecting
            ? 'Reconnecting…'
            : isConnected
              ? 'Live'
              : 'Offline'}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No activity for this member yet."
          hint={
            messages.length === 0
              ? 'Messages will appear here when this member starts working.'
              : 'Nothing matches the current filters.'
          }
        />
      ) : (
        <ol
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sf-space-md)',
          }}
          data-testid="activity-log-list"
        >
          {filtered.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              members={members}
              currentMemberId={memberId}
              depth={messageDepth(msg)}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Threading depth. Phase D Day 2 supports a single level of indent —
 * messages whose `metadata.parentTaskId` is populated were emitted from
 * inside a specialist's subagent run (spawned by the coordinator's Task
 * tool). We render those indented so the coordinator→specialist
 * delegation is visible at a glance. Deeper nesting is possible but
 * rare in the Phase B 3-agent roster; when it matters we can walk the
 * parentTaskId chain to compute true depth.
 */
function messageDepth(msg: TeamActivityMessage): number {
  const parentTaskId = msg.metadata?.['parentTaskId'];
  return typeof parentTaskId === 'string' && parentTaskId.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: TeamActivityMessage;
  members: ActivityLogMemberRef[];
  currentMemberId: string;
  depth: number;
}

const INDENT_PER_DEPTH_PX = 24;

function MessageRow({
  message,
  members,
  currentMemberId,
  depth,
}: MessageRowProps) {
  const { type, content, metadata, createdAt, from, to, runId } = message;
  const isError = type === 'error';
  const fromOther = from !== currentMemberId;
  const indent = depth * INDENT_PER_DEPTH_PX;

  const wrap: CSSProperties = {
    position: 'relative',
    marginLeft: indent,
    // A vertical connector line for indented messages makes the
    // parent→child relationship visually explicit without a separate DOM
    // element per child.
    ...(depth > 0
      ? {
          borderLeft: '2px solid var(--sf-border)',
          paddingLeft: 'var(--sf-space-md)',
        }
      : {}),
  };

  const row: CSSProperties = {
    position: 'relative',
    padding: 'var(--sf-space-base) var(--sf-space-lg)',
    background: isError ? 'var(--sf-error-light)' : 'var(--sf-bg-secondary)',
    border: isError
      ? '1px solid var(--sf-error)'
      : '1px solid var(--sf-border-subtle)',
    borderRadius: 'var(--sf-radius-lg)',
    boxShadow: 'var(--sf-shadow-card)',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  };

  const headerRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
  };

  const speakerRow: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  };

  const speakerName: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    fontWeight: 600,
    color: 'var(--sf-fg-1)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const toLabel: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
  };

  const timeStyle: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
    fontVariantNumeric: 'tabular-nums',
  };

  const agentName =
    typeof metadata?.['agentName'] === 'string'
      ? (metadata['agentName'] as string)
      : null;

  return (
    <li style={wrap} data-depth={depth} data-testid={`activity-row-${type}`}>
      <div style={row}>
        <div style={headerRow}>
          <div style={speakerRow}>
            <span style={speakerName}>{labelMember(from, members)}</span>
            {to && to !== from ? (
              <>
                <span style={toLabel}>→</span>
                <span style={toLabel}>{labelMember(to, members)}</span>
              </>
            ) : null}
            <TypeBadge type={type} />
            {agentName && depth > 0 ? (
              <span style={{ ...toLabel, color: 'var(--sf-fg-4)' }}>
                · via {agentName}
              </span>
            ) : null}
            {runId ? (
              <span
                style={{
                  ...toLabel,
                  fontFamily: 'var(--sf-font-mono)',
                  color: 'var(--sf-fg-4)',
                }}
                aria-label="Run id"
              >
                run:{shortId(runId)}
              </span>
            ) : null}
          </div>
          <time style={timeStyle} dateTime={createdAt}>
            {formatTimestamp(createdAt)}
          </time>
        </div>

        <MessageBody
          type={type}
          content={content}
          metadata={metadata}
          fromOther={fromOther}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface MessageBodyProps {
  type: TeamActivityMessage['type'];
  content: string | null;
  metadata: Record<string, unknown> | null;
  fromOther: boolean;
}

function MessageBody({ type, content, metadata, fromOther }: MessageBodyProps) {
  const textStyle: CSSProperties = {
    margin: 0,
    fontSize: 'var(--sf-text-sm)',
    color: fromOther ? 'var(--sf-fg-1)' : 'var(--sf-fg-2)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  if (type === 'tool_call' || type === 'tool_result') {
    const toolName = extractToolName(metadata);
    const summary = type === 'tool_call' ? 'Called' : 'Result of';
    return (
      <Collapsible
        summary={
          <>
            {summary} <code style={codeInline}>{toolName ?? 'tool'}</code>
            {content ? <span style={previewTail}> · {firstLine(content)}</span> : null}
          </>
        }
      >
        {content ? <p style={textStyle}>{content}</p> : null}
        {metadata ? (
          <pre style={prePre}>
            <code>{prettyJson(metadata)}</code>
          </pre>
        ) : null}
      </Collapsible>
    );
  }

  if (type === 'thinking') {
    return (
      <Collapsible summary={<em style={{ color: 'var(--sf-fg-3)' }}>thinking…</em>}>
        {content ? <p style={{ ...textStyle, color: 'var(--sf-fg-3)' }}>{content}</p> : null}
      </Collapsible>
    );
  }

  return content ? <p style={textStyle}>{content}</p> : null;
}

// ---------------------------------------------------------------------------
// Collapsible
// ---------------------------------------------------------------------------

function Collapsible({
  summary,
  children,
}: {
  summary: ReactNode;
  children: ReactNode;
}) {
  const detailsStyle: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
  };
  const summaryStyle: CSSProperties = {
    cursor: 'pointer',
    color: 'var(--sf-fg-2)',
    fontSize: 'var(--sf-text-sm)',
    userSelect: 'none',
  };
  return (
    <details style={detailsStyle}>
      <summary style={summaryStyle}>{summary}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function TypeBadge({ type }: { type: TeamActivityMessage['type'] }) {
  switch (type) {
    case 'user_prompt':
      return <Badge variant="accent">user</Badge>;
    case 'agent_text':
      return <Badge variant="default">text</Badge>;
    case 'tool_call':
      return <Badge variant="default">tool</Badge>;
    case 'tool_result':
      return <Badge variant="default">result</Badge>;
    case 'completion':
      return <Badge variant="success">done</Badge>;
    case 'error':
      return <Badge variant="error">error</Badge>;
    case 'thinking':
      return <Badge variant="default">think</Badge>;
    default:
      return <Badge variant="default">{String(type)}</Badge>;
  }
}

// ---------------------------------------------------------------------------
// Small style constants used in multiple places
// ---------------------------------------------------------------------------

const codeInline: CSSProperties = {
  fontFamily: 'var(--sf-font-mono)',
  background: 'var(--sf-bg-tertiary)',
  padding: '1px 6px',
  borderRadius: 'var(--sf-radius-sm)',
  fontSize: 'var(--sf-text-xs)',
};

const previewTail: CSSProperties = {
  color: 'var(--sf-fg-3)',
  fontSize: 'var(--sf-text-xs)',
};

const prePre: CSSProperties = {
  marginTop: 8,
  marginBottom: 0,
  padding: 'var(--sf-space-md)',
  background: 'var(--sf-bg-tertiary)',
  borderRadius: 'var(--sf-radius-md)',
  overflowX: 'auto',
  fontFamily: 'var(--sf-font-mono)',
  fontSize: 'var(--sf-text-xs)',
  color: 'var(--sf-fg-2)',
  maxHeight: 280,
};

function firstLine(s: string): string {
  const line = s.split('\n')[0];
  if (line.length > 80) return `${line.slice(0, 80)}…`;
  return line;
}
