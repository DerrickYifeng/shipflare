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
  const t = metadata['tool_name'];
  return typeof t === 'string' ? t : null;
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
}: ActivityLogProps) {
  const { messages, isConnected, reconnecting } = useTeamEvents({
    teamId,
    initialMessages,
    filter: (msg) => msg.from === memberId || msg.to === memberId,
  });

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
          title="No activity yet."
          hint={
            messages.length === 0
              ? 'Messages will appear here when this member starts working.'
              : 'Nothing matches the current filters.'
          }
        />
      ) : (
        <ol
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sf-space-md)',
          }}
        >
          {filtered.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              members={members}
              currentMemberId={memberId}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: TeamActivityMessage;
  members: ActivityLogMemberRef[];
  currentMemberId: string;
}

function MessageRow({ message, members, currentMemberId }: MessageRowProps) {
  const { type, content, metadata, createdAt, from, to, runId } = message;
  const isError = type === 'error';
  const fromOther = from !== currentMemberId;

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

  return (
    <li style={row}>
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
