'use client';

import {
  useCallback,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';

export interface SendMessageFormProps {
  teamId: string;
  /**
   * Optional — route the message at a specific member. Omit to target the
   * coordinator (the default in /api/team/message when no memberId is
   * passed).
   */
  memberId?: string;
  /**
   * Friendly label (e.g. "Send a message to Sam") used in the textarea
   * placeholder and the submit button's aria-label.
   */
  recipientName?: string;
  /** `team_members.agent_type`, used to pick a role-aware placeholder. */
  agentType?: string;
  onSent?: () => void;
}

// Route zod limit is 8000, but 500 is plenty for a direct-message steer
// and keeps the form feeling conversational. The counter turns error-
// inked past this bound; submit is disabled once over.
const MAX_LEN = 500;

/**
 * Role-aware placeholder copy. The main page UX is "direct your
 * specialist toward a specific action"; a generic "Send a message"
 * prompts blank-page-syndrome for users who've never messaged an AI
 * teammate before.
 */
const PLACEHOLDER_BY_AGENT_TYPE: Record<string, string> = {
  coordinator: 'Ask Chief of Staff to replan this week…',
  'growth-strategist': 'Direct the growth strategist to rewrite the thesis…',
  'content-planner': 'Tell the content planner what to slot in next…',
};

function placeholderFor(agentType: string | undefined, recipientName: string | undefined): string {
  if (agentType && PLACEHOLDER_BY_AGENT_TYPE[agentType]) {
    return PLACEHOLDER_BY_AGENT_TYPE[agentType];
  }
  if (recipientName) return `Send a message to ${recipientName}…`;
  return 'Send a message to your team…';
}

/**
 * User → team direct-message composer. Phase D Day 3.
 *
 * Semantics:
 * - If the target team has no active team_run, the POST triggers a new
 *   run with the message as the goal (see /api/team/message). The form
 *   doesn't care — it renders the same way either way.
 * - When a run is in-flight, the backend injects the message into the
 *   running coordinator's next turn via the Redis per-run inject channel
 *   (commit e15a2a7). The user's own message is published on the team
 *   messages channel immediately so it lands in the activity log via
 *   `useTeamEvents` without a round-trip here.
 */
export function SendMessageForm({
  teamId,
  memberId,
  recipientName,
  agentType,
  onSent,
}: SendMessageFormProps) {
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const tooLong = trimmed.length > MAX_LEN;
  const disabled = submitting || trimmed.length === 0 || tooLong;

  const handleSubmit = useCallback(
    async (evt: FormEvent<HTMLFormElement>) => {
      evt.preventDefault();
      if (disabled) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch('/api/team/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teamId,
            memberId: memberId ?? undefined,
            message: trimmed,
          }),
        });
        if (!res.ok) {
          const detail = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          const msg =
            typeof detail?.error === 'string'
              ? detail.error
              : `Couldn't send: HTTP ${res.status}`;
          setError(msg);
          toast(msg, 'error');
          return;
        }
        setValue('');
        onSent?.();
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Network error — message not sent.';
        setError(msg);
        toast(msg, 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [disabled, memberId, onSent, teamId, toast, trimmed],
  );

  const wrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--sf-space-sm)',
    padding: 'var(--sf-space-base)',
    background: 'var(--sf-bg-secondary)',
    border: '1px solid var(--sf-border-subtle)',
    borderRadius: 'var(--sf-radius-lg)',
    boxShadow: 'var(--sf-shadow-card)',
  };

  const header: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--sf-space-sm)',
  };

  const labelStyle: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-2)',
    fontWeight: 500,
  };

  const counter: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: tooLong ? 'var(--sf-error)' : 'var(--sf-fg-3)',
    fontVariantNumeric: 'tabular-nums',
  };

  const textarea: CSSProperties = {
    minHeight: 72,
    resize: 'vertical',
    padding: 'var(--sf-space-md)',
    borderRadius: 'var(--sf-radius-md)',
    border: '1px solid var(--sf-border)',
    background: 'var(--sf-bg-primary)',
    color: 'var(--sf-fg-1)',
    fontSize: 'var(--sf-text-base)',
    fontFamily: 'inherit',
    lineHeight: 1.5,
    transition: 'border-color 150ms ease, box-shadow 150ms ease',
    outline: 'none',
  };

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--sf-space-sm)',
  };

  const hint: CSSProperties = {
    fontSize: 'var(--sf-text-xs)',
    color: 'var(--sf-fg-3)',
  };

  const errorText: CSSProperties = {
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-error-ink)',
  };

  const placeholder = placeholderFor(agentType, recipientName);

  const ariaLabel = recipientName
    ? `Send a message to ${recipientName}`
    : 'Send a message to your team';

  return (
    <form
      onSubmit={handleSubmit}
      style={wrap}
      aria-label={ariaLabel}
      data-testid="send-message-form"
    >
      <div style={header}>
        <span style={labelStyle}>Direct message</span>
        <span style={counter} aria-live="polite">
          {trimmed.length}/{MAX_LEN}
        </span>
      </div>
      <textarea
        style={textarea}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl-Enter sends. Matches the convention in most chat UIs
          // and keeps plain Enter available for newlines.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !disabled) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }
        }}
        disabled={submitting}
        aria-label={ariaLabel}
        data-testid="send-message-input"
      />
      {error ? <div style={errorText}>{error}</div> : null}
      <div style={row}>
        <span style={hint}>
          ⌘ + Enter to send. Your team replies in the activity log below.
        </span>
        <Button
          type="submit"
          variant="primary"
          disabled={disabled}
          data-testid="send-message-submit"
        >
          {submitting ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </form>
  );
}
