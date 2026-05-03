'use client';

// UI-B Task 9: per-teammate transcript drawer.
//
// Right-side slide-out panel that opens when the founder clicks a
// teammate row in <TeammateRoster> or a <TaskNotificationCard>. Loads
// the agent's chronological history from
// `/api/team/agent/[agentId]/transcript` (which wraps `loadAgentRunHistory`)
// and renders it as a chat — user-role bubbles on the left, assistant
// bubbles on the right (matching the founder/lead convention used by
// `team-desk.tsx`'s main chat pane).
//
// Pure presentation + lifecycle: the parent owns whether the drawer is
// open by passing `agentId: string | null`. When `agentId` flips to a
// new value the drawer fetches fresh; when it flips back to `null` the
// drawer disappears. AbortController guards against late responses
// landing after the drawer was closed (or repointed at a different
// agent), which would otherwise flash stale messages.

import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TeammateTranscriptDrawerProps {
  /** `agent_runs.id` to load. Null hides the drawer. */
  agentId: string | null;
  /** Close handler — wired to a button in the header and the backdrop. */
  onClose: () => void;
  /**
   * Optional override for the panel header text. Defaults to "Teammate
   * transcript" — callers that know the teammate's display name should
   * pass it in (e.g. `"Author transcript"`) for clearer affordance.
   */
  title?: string;
}

interface FetchState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  messages: TranscriptMessage[];
  error: string | null;
}

const INITIAL_STATE: FetchState = {
  status: 'idle',
  messages: [],
  error: null,
};

// ---------------------------------------------------------------------------
// Styles (inline + design tokens — matches AgentStatusPill / TaskNotificationCard)
// ---------------------------------------------------------------------------

function drawerStyles(): {
  backdrop: CSSProperties;
  panel: CSSProperties;
  header: CSSProperties;
  title: CSSProperties;
  closeBtn: CSSProperties;
  body: CSSProperties;
  state: CSSProperties;
  empty: CSSProperties;
  errorState: CSSProperties;
} {
  return {
    backdrop: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0, 0, 0, 0.18)',
      zIndex: 49,
      transition: 'opacity 160ms var(--sf-ease-swift, ease-out)',
    },
    panel: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: 'min(420px, 100vw)',
      background: 'var(--sf-bg-primary, #fff)',
      borderLeft: '1px solid var(--sf-border, rgba(0,0,0,0.08))',
      boxShadow: '-12px 0 32px rgba(0,0,0,0.08)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 50,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      padding: '12px 16px',
      borderBottom: '1px solid var(--sf-border, rgba(0,0,0,0.08))',
      background: 'var(--sf-bg-secondary, #fafafa)',
      flexShrink: 0,
    },
    title: {
      fontSize: 14,
      fontWeight: 600,
      color: 'var(--sf-fg-1)',
      margin: 0,
    },
    closeBtn: {
      width: 28,
      height: 28,
      borderRadius: 8,
      border: '1px solid var(--sf-border, rgba(0,0,0,0.12))',
      background: 'transparent',
      color: 'var(--sf-fg-2)',
      cursor: 'pointer',
      fontSize: 16,
      lineHeight: 1,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    body: {
      flex: 1,
      overflowY: 'auto',
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    state: {
      fontSize: 13,
      color: 'var(--sf-fg-3)',
      fontStyle: 'italic',
      padding: '12px 0',
    },
    empty: {
      fontSize: 13,
      color: 'var(--sf-fg-3)',
      padding: '12px 0',
      textAlign: 'center',
    },
    errorState: {
      fontSize: 13,
      color: 'var(--sf-error-ink)',
      padding: '12px',
      borderRadius: 8,
      background: 'var(--sf-error-light)',
    },
  };
}

function bubbleStyles(role: 'user' | 'assistant'): {
  outer: CSSProperties;
  bubble: CSSProperties;
  roleLabel: CSSProperties;
  body: CSSProperties;
} {
  // Mirror the founder/lead convention from team-desk: incoming "user"
  // messages (the founder's prompt to this teammate) align left, the
  // teammate's "assistant" replies align right. This makes the drawer
  // feel like a per-teammate chat rather than a flat log.
  const isAssistant = role === 'assistant';
  return {
    outer: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: isAssistant ? 'flex-end' : 'flex-start',
      gap: 4,
      maxWidth: '100%',
    },
    bubble: {
      maxWidth: '85%',
      padding: '10px 12px',
      borderRadius: 12,
      background: isAssistant
        ? 'var(--sf-accent-light)'
        : 'var(--sf-bg-secondary, #f4f4f5)',
      color: 'var(--sf-fg-1)',
      border: isAssistant
        ? '1px solid color-mix(in oklch, var(--sf-accent) 30%, transparent)'
        : '1px solid var(--sf-border, rgba(0,0,0,0.06))',
    },
    roleLabel: {
      fontSize: 10,
      fontFamily: 'var(--sf-font-mono)',
      color: 'var(--sf-fg-3)',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    body: {
      fontSize: 13,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      margin: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeammateTranscriptDrawer({
  agentId,
  onClose,
  title,
}: TeammateTranscriptDrawerProps): ReactNode {
  // First render: if agentId is set, start in loading immediately so
  // the drawer skeleton + spinner render synchronously with mount
  // (matches the pre-fix behavior where the in-effect setState fired
  // on the same commit as the initial render).
  const [state, setState] = useState<FetchState>(() =>
    agentId ? { status: 'loading', messages: [], error: null } : INITIAL_STATE,
  );

  // Reset on agentId change BEFORE the fetch effect runs, via the
  // state-during-render pattern (sanctioned by React's "Storing
  // information from previous renders" guidance — see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // This avoids the cascading-render risk of setState-in-effect AND
  // ensures the drawer never flashes the previous teammate's messages
  // while a new fetch is in flight: the loading-flash setState happens
  // synchronously with the agentId change, batched into the same
  // render cycle.
  const [prevAgentId, setPrevAgentId] = useState(agentId);
  if (prevAgentId !== agentId) {
    setPrevAgentId(agentId);
    setState(
      agentId ? { status: 'loading', messages: [], error: null } : INITIAL_STATE,
    );
  }

  useEffect(() => {
    if (!agentId) return;
    const controller = new AbortController();
    // setState({ status: 'loading' }) was hoisted to the ref-compare
    // block above so the loading flash happens synchronously with the
    // agentId change, not on the next render.
    fetch(`/api/team/agent/${encodeURIComponent(agentId)}/transcript`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          // Surface the status code so the founder can distinguish "not
          // mine" (404) from a transient server hiccup. The error state
          // doesn't try to render a fancy retry — it just tells the user
          // what happened so they can close + reopen.
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { messages?: TranscriptMessage[] };
        if (controller.signal.aborted) return;
        setState({
          status: 'ready',
          messages: Array.isArray(data.messages) ? data.messages : [],
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', messages: [], error: message });
      });
    return () => {
      controller.abort();
    };
  }, [agentId]);

  if (!agentId) return null;

  const styles = drawerStyles();
  return (
    <>
      <div
        style={styles.backdrop}
        onClick={onClose}
        aria-hidden="true"
        data-testid="teammate-transcript-backdrop"
      />
      <aside
        style={styles.panel}
        role="dialog"
        aria-label={title ?? 'Teammate transcript'}
        data-testid="teammate-transcript-drawer"
        data-agent-id={agentId}
      >
        <header style={styles.header}>
          <h3 style={styles.title}>{title ?? 'Teammate transcript'}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            data-testid="teammate-transcript-close"
            style={styles.closeBtn}
          >
            ×
          </button>
        </header>
        <div style={styles.body}>
          {state.status === 'loading' ? (
            <div style={styles.state} data-testid="teammate-transcript-loading">
              Loading transcript…
            </div>
          ) : null}
          {state.status === 'error' ? (
            <div style={styles.errorState} data-testid="teammate-transcript-error">
              Failed to load transcript ({state.error ?? 'unknown error'}).
            </div>
          ) : null}
          {state.status === 'ready' && state.messages.length === 0 ? (
            <div style={styles.empty} data-testid="teammate-transcript-empty">
              No messages yet.
            </div>
          ) : null}
          {state.status === 'ready'
            ? state.messages.map((msg, i) => (
                <TranscriptBubble
                  // History rows have no stable id, so we key by index +
                  // role + content prefix. Index alone is enough because
                  // the list is append-only on the server side; the rest
                  // are belt-and-braces against React's key warning.
                  key={`${i}-${msg.role}-${msg.content.slice(0, 16)}`}
                  message={msg}
                />
              ))
            : null}
        </div>
      </aside>
    </>
  );
}

interface TranscriptBubbleProps {
  message: TranscriptMessage;
}

function TranscriptBubble({ message }: TranscriptBubbleProps): ReactNode {
  const styles = bubbleStyles(message.role);
  return (
    <div
      style={styles.outer}
      data-testid="teammate-transcript-message"
      data-role={message.role}
    >
      <span style={styles.roleLabel}>{message.role}</span>
      <div style={styles.bubble}>
        <p style={styles.body}>{message.content}</p>
      </div>
    </div>
  );
}
