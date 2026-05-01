export type ConversationStatus = 'idle' | 'running' | 'active';

export type StatusTone = 'accent' | 'success' | 'error' | 'muted' | 'warning';

/**
 * ChatGPT-style sidebar conversation model. Replaces the old
 * SessionMeta (which was keyed by runId). A conversation may contain
 * zero, one, or many runs; the user never sees runs in the sidebar —
 * they see THREADS and click into one to read or reply.
 */
export interface ConversationMeta {
  /** `team_conversations.id` — the thread identity. */
  id: string;
  /** User-visible title; defaults to null until the first user message
   *  auto-derives one from its content. */
  title: string | null;
  /** ISO. Drives sidebar sort order (most recent first). Bumped on
   *  every new user message + every coordinator reply. */
  updatedAt: string;
  /** ISO. Used for tooltip / "started on" details. */
  createdAt: string;
  /**
   * Client-only placeholder flag — true for a new-but-unbriefed
   * conversation the user just opened with the "+ New" button. Gets
   * dropped automatically when the first message lands. Draft rows
   * never hit the server; sending a message is what promotes them.
   */
  isDraft?: boolean;
}

export function toneColor(tone: StatusTone): { fg: string; dot: string } {
  switch (tone) {
    case 'accent':
      return { fg: 'var(--sf-accent)', dot: 'var(--sf-accent)' };
    case 'success':
      return { fg: 'var(--sf-success-ink)', dot: 'var(--sf-success)' };
    case 'error':
      return { fg: 'var(--sf-error-ink)', dot: 'var(--sf-error)' };
    case 'warning':
      return { fg: 'var(--sf-warning-ink)', dot: 'var(--sf-warning)' };
    case 'muted':
    default:
      return { fg: 'var(--sf-fg-3)', dot: 'var(--sf-fg-4)' };
  }
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (isSameDay(d, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `Yesterday ${time}`;
  const dayDiff = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (dayDiff < 7 && dayDiff >= 0) {
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Fall back when the backend hasn't auto-derived a title yet and the
 * conversation has no messages — renders a quiet placeholder so the
 * sidebar row isn't blank.
 */
export const UNTITLED_FALLBACK = 'New conversation';

export function displayTitle(conv: ConversationMeta): string {
  if (conv.title && conv.title.trim().length > 0) return conv.title;
  return UNTITLED_FALLBACK;
}

/**
 * Run-scoped helpers — used by the in-thread SessionDivider, which
 * still renders per-run dividers inside a single conversation so
 * readers can see where a coordinator cycle started. These are not
 * used in the sidebar.
 */
const TRIGGER_LABELS: Record<string, string> = {
  daily: 'Daily run',
  onboarding: 'Onboarding',
  kickoff: 'Kickoff',
  weekly: 'Weekly plan',
  phase_transition: 'Phase transition',
  draft_post: 'Draft post',
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger;
}

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'running':
    case 'pending':
      return 'accent';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'muted';
    default:
      return 'muted';
  }
}

export function formatStart(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (isSameDay(d, now)) return `Today ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} ${time}`;
}
