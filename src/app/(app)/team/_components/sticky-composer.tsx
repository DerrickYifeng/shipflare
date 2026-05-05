'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useToast } from '@/components/ui/toast';

export interface StickyComposerHandle {
  /** Focus the textarea (caret moves to the end). */
  focus: () => void;
  /** Replace the textarea value, focus, and move caret to end. */
  setValue: (next: string) => void;
}

export interface StickyComposerSendResult {
  /**
   * The runId the message was attached to. New run → the freshly-enqueued
   * runId; active run → the existing one; null only when no coordinator
   * could be resolved (edge case where the team has no members).
   */
  runId: string | null;
  /** True when the server returned an existing run instead of creating one. */
  alreadyRunning: boolean;
  /**
   * Phase 2: the conversation this message was attached to. Callers
   * stamp this onto the optimistic `SessionMeta` they insert into the
   * rail so `groupRunsByConversation` correctly collapses the new
   * run with sibling runs in the same conversation — without it, the
   * optimistic row has `conversationId: null` and renders as its own
   * standalone session entry, producing the "new session jumped in"
   * illusion after the user replies to an old thread.
   */
  conversationId: string | null;
}

export interface StickyComposerProps {
  teamId: string;
  /** Header on the current content grid — used to place the composer under the center column. */
  leftColumnWidth: number;
  rightColumnWidth: number;
  gap: number;
  horizontalPadding: number;
  /** Width of the app sidebar so the fixed composer lines up with the main content area. */
  appSidebarWidth?: number;
  /**
   * Fired once the server has accepted the message. Parents use this to
   * switch `selectedRunId` to the new run so the user sees their bubble
   * and the incoming replies under the same session divider.
   */
  onSent?: (result: StickyComposerSendResult) => void;
  /**
   * RunId of a currently-running team_run that the composer should offer
   * a Stop button for. When set, the send icon swaps to a stop icon and
   * submitting calls `onCancel(runId)` instead of POSTing a new message.
   * Matches Claude Code's Esc-to-abort pattern — the user can halt a
   * mistaken dispatch without waiting for it to burn out.
   */
  cancellableRunId?: string | null;
  /** Called with the runId when the user clicks Stop. */
  onCancel?: (runId: string) => void | Promise<void>;
  /**
   * The conversation this composer is currently writing to. When null
   * (e.g. `+ New session` draft state), the composer mints a fresh
   * conversation before posting the first message.
   */
  conversationId?: string | null;
}

// Route zod limit is 8000 — the product convention is ~500 for steering
// messages so the UX stays conversational.
const MAX_LEN = 500;
const MIN_HEIGHT = 28;
const MAX_HEIGHT = 200;

/**
 * Claude-style composer pinned to the bottom of the AI-team page. POSTs
 * the message into the active team conversation via
 * `/api/team/conversations/:id/messages`; the backend creates a new
 * coordinator-rooted team_run or injects into the running one. The
 * user's own bubble lands via SSE — the composer does not insert
 * optimistically.
 */
export const StickyComposer = forwardRef<
  StickyComposerHandle,
  StickyComposerProps
>(function StickyComposer(
  {
    teamId,
    leftColumnWidth,
    rightColumnWidth,
    gap,
    horizontalPadding,
    appSidebarWidth = 220,
    onSent,
    cancellableRunId,
    onCancel,
    conversationId,
  },
  ref,
) {
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {
          // Some browsers throw when the textarea isn't mounted yet —
          // the focus call above is already sufficient in that case.
        }
      },
      setValue: (next: string) => {
        setValue(next);
        // Focus + caret-to-end on the next tick so the new value is
        // committed before we move the cursor.
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const len = el.value.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            // ignore — see note above.
          }
        });
      },
    }),
    [],
  );

  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_LEN;
  const disabled = submitting || trimmed.length === 0 || tooLong;

  const handleResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(
      MIN_HEIGHT,
      Math.min(MAX_HEIGHT, el.scrollHeight),
    )}px`;
  }, []);

  useEffect(() => {
    handleResize();
  }, [value, handleResize]);

  const send = useCallback(async () => {
    if (disabled) return;
    // Optimistic clear — the textarea empties the instant the user
    // clicks Send so the app feels responsive even when the POST
    // round-trip is slow. We capture the text first so we can restore
    // it if the request fails.
    const payload = trimmed;
    setSubmitting(true);
    setValue('');
    try {
      // Chat refactor: messages flow through
      // `/api/team/conversations/:id/messages`. If the user has no
      // focused conversation (landing state, no rows yet), mint one
      // first, then POST the message into it. The server never has to
      // guess which thread a message belongs to.
      let targetConversationId = conversationId;
      if (!targetConversationId) {
        const createRes = await fetch('/api/team/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId }),
        });
        if (!createRes.ok) {
          const detail = (await createRes.json().catch(() => ({}))) as {
            error?: string;
          };
          toast(
            typeof detail?.error === 'string'
              ? detail.error
              : `Couldn't start conversation: HTTP ${createRes.status}`,
            'error',
          );
          setValue((current) => (current.length === 0 ? payload : current));
          return;
        }
        const created = (await createRes.json()) as { id?: string };
        if (typeof created.id !== 'string') {
          toast("Couldn't start conversation: malformed response.", 'error');
          setValue((current) => (current.length === 0 ? payload : current));
          return;
        }
        targetConversationId = created.id;
      }

      const res = await fetch(
        `/api/team/conversations/${encodeURIComponent(targetConversationId)}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teamId, message: payload }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        runId?: string | null;
        alreadyRunning?: boolean;
        conversationId?: string | null;
        error?: string;
      };
      if (!res.ok) {
        const msg =
          typeof body?.error === 'string'
            ? body.error
            : `Couldn't send: HTTP ${res.status}`;
        toast(msg, 'error');
        // Restore only if the user hasn't started typing a new message.
        setValue((current) => (current.length === 0 ? payload : current));
        return;
      }
      onSent?.({
        runId: typeof body.runId === 'string' ? body.runId : null,
        alreadyRunning: body.alreadyRunning === true,
        conversationId:
          typeof body.conversationId === 'string'
            ? body.conversationId
            : targetConversationId,
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Network error — message not sent.';
      toast(msg, 'error');
      setValue((current) => (current.length === 0 ? payload : current));
    } finally {
      setSubmitting(false);
    }
  }, [disabled, teamId, toast, trimmed, onSent, conversationId]);

  const handleSubmit = useCallback(
    (evt: FormEvent<HTMLFormElement>) => {
      evt.preventDefault();
      void send();
    },
    [send],
  );

  const handleKeyDown = useCallback(
    (evt: KeyboardEvent<HTMLTextAreaElement>) => {
      if (evt.key !== 'Enter') return;
      // Shift+Enter → newline (native default).
      if (evt.shiftKey) return;
      // IME guard: during Chinese / Japanese / Korean composition the
      // first Enter commits the in-progress candidate, it is not a
      // send. React normalises the `isComposing` flag onto the native
      // event; the 229 `keyCode` fallback covers the older WebKit
      // / Safari path where `isComposing` isn't populated.
      if (evt.nativeEvent.isComposing || evt.keyCode === 229) return;
      // Plain Enter or ⌘/Ctrl+Enter → submit.
      evt.preventDefault();
      void send();
    },
    [send],
  );

  const outer: CSSProperties = {
    position: 'fixed',
    left: appSidebarWidth,
    right: 0,
    bottom: 0,
    paddingLeft: horizontalPadding,
    paddingRight: horizontalPadding,
    paddingBottom: 20,
    zIndex: 20,
    pointerEvents: 'none',
  };

  const gridClass = 'ai-team-composer-grid';

  const grid: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `${leftColumnWidth}px 1fr ${rightColumnWidth}px`,
    gap,
    position: 'relative',
  };

  const centerCell: CSSProperties = {
    gridColumn: '2 / span 1',
    pointerEvents: 'auto',
    position: 'relative',
    // Match the thread's readable width so the composer card doesn't
    // stretch past the bubbles above it on wide monitors.
    maxWidth: 740,
    width: '100%',
    margin: '0 auto',
  };

  const card: CSSProperties = {
    background: 'var(--sf-bg-secondary)',
    borderRadius: 20,
    border: '1px solid var(--sf-border)',
    padding: '14px 14px 10px',
    boxShadow:
      '0 4px 12px rgba(0, 0, 0, 0.04), 0 20px 40px rgba(0, 0, 0, 0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  };

  const textareaStyle: CSSProperties = {
    width: '100%',
    border: 'none',
    outline: 'none',
    resize: 'none',
    background: 'transparent',
    color: 'var(--sf-fg-1)',
    fontSize: 15,
    letterSpacing: '-0.01em',
    lineHeight: 1.5,
    padding: '4px 4px 6px',
    minHeight: MIN_HEIGHT,
    maxHeight: MAX_HEIGHT,
    fontFamily: 'inherit',
    overflowY: 'auto',
  };

  const footer: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  };

  const attachBtn: CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: 'transparent',
    border: 'none',
    color: 'rgba(0, 0, 0, 0.56)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'not-allowed',
    opacity: 0.6,
  };

  const sendBtn: CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: '50%',
    background: disabled ? 'rgba(0, 0, 0, 0.08)' : 'var(--sf-fg-1)',
    color: disabled ? 'rgba(0, 0, 0, 0.32)' : 'var(--sf-bg-secondary)',
    border: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 200ms var(--sf-ease-swift)',
  };

  const counter: CSSProperties = {
    marginLeft: 'auto',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: tooLong ? 'var(--sf-error-ink)' : 'rgba(0, 0, 0, 0.4)',
    fontVariantNumeric: 'tabular-nums',
  };

  const footerCaption: CSSProperties = {
    textAlign: 'center',
    marginTop: 6,
    fontSize: 11,
    color: 'rgba(0, 0, 0, 0.4)',
  };

  return (
    <div className="ai-team-composer-wrap" style={outer} aria-hidden={false}>
      <div className={gridClass} style={grid}>
        <div style={centerCell}>
          <form
            onSubmit={handleSubmit}
            style={card}
            aria-label="Send a message to your Team Lead"
            data-testid="sticky-composer"
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message your Team Lead…"
              style={textareaStyle}
              aria-label="Send a message to your Team Lead"
              disabled={submitting}
              data-testid="sticky-composer-input"
            />
            <div style={footer}>
              <button
                type="button"
                disabled
                aria-label="Attach (coming soon)"
                style={attachBtn}
                data-testid="sticky-composer-attach"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 3v10M3 8h10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <span style={counter} aria-live="polite">
                {`${trimmed.length}/${MAX_LEN}`}
              </span>
              {cancellableRunId ? (
                <button
                  type="button"
                  disabled={cancelling}
                  aria-label="Stop the current run"
                  style={{
                    ...sendBtn,
                    background: 'var(--sf-error, #d00)',
                    color: 'white',
                    cursor: cancelling ? 'wait' : 'pointer',
                  }}
                  data-testid="sticky-composer-stop"
                  onClick={async () => {
                    if (!onCancel || cancelling) return;
                    setCancelling(true);
                    try {
                      await onCancel(cancellableRunId);
                    } finally {
                      setCancelling(false);
                    }
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <rect x="3" y="3" width="8" height="8" rx="1.5" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={disabled}
                  aria-label="Send message"
                  style={sendBtn}
                  data-testid="sticky-composer-send"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M8 13V3M4 7l4-4 4 4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            <div style={footerCaption}>
              Team Lead is always here · spawns specialists in parallel ·
              nothing posts without your approval
            </div>
          </form>
        </div>
      </div>
    </div>
  );
});
