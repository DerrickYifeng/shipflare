export type StatusTone = 'accent' | 'success' | 'error' | 'muted' | 'warning';

export const TRIGGER_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  weekly: 'Weekly plan',
  manual: 'Manual run',
  reply_sweep: 'Reply sweep',
  draft_post: 'Draft post',
  phase_transition: 'Phase transition',
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABELS[trigger] ?? trigger.replace(/_/g, ' ');
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
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
  const dayDiff = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (dayDiff < 7 && dayDiff >= 0) {
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    return `${weekday} ${time}`;
  }
  const dateLabel = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${dateLabel} ${time}`;
}

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'running':
      return 'accent';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'muted';
    case 'draft':
      return 'muted';
    case 'pending':
    default:
      return 'warning';
  }
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

export interface SessionMeta {
  id: string;
  trigger: string;
  goal: string | null;
  status:
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'pending'
    /**
     * Client-only placeholder for a session the user has opened but not yet
     * briefed — no `team_runs` row exists yet. Sending the first message in
     * the composer promotes the draft into a real run.
     */
    | 'draft';
  startedAt: string;
  completedAt: string | null;
  totalTurns: number;
  /** Derived client-side from the first `user_prompt` for this run. */
  title: string | null;
}
