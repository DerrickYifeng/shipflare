import type { ActivityEvent } from '@shipflare/shared';

const AGENT_NAMES: Record<string, string> = {
  cmo: 'CMO',
  'head-of-growth': 'Head of Growth',
  'social-media-manager': 'Social Media Manager',
  'strategic-planner': 'Strategist',
};

/**
 * Convert an agent slug (e.g. 'head-of-growth') to its display name
 * (e.g. 'Head of Growth'). Falls back to titleizing the slug for
 * unknown values so new agents still render reasonably.
 */
export function prettyAgent(slug: string): string {
  if (AGENT_NAMES[slug]) return AGENT_NAMES[slug];
  if (!slug) return 'Agent';
  const tokens = slug.split('-');
  return tokens
    .map((t, i) => (i === 0 ? t.charAt(0).toUpperCase() + t.slice(1) : t))
    .join(' ');
}

export interface ActivityLabel {
  headline: string;
  sub?: string;
  tone: 'work' | 'dispatch' | 'idle' | 'error';
}

type LabelFn = (event: ActivityEvent) => ActivityLabel;

/**
 * Label map keyed by `${sourceAgent}:${kind}` or `${sourceAgent}:${kind}:${tool}`.
 * Most specific key wins; fallback titleizes the kind.
 */
const LABELS: Record<string, LabelFn> = {
  'cmo:turn_start': () => ({ headline: 'Thinking', tone: 'idle' }),
  'cmo:turn_finish': (e) => {
    const p = e.payload as { status?: 'ok' | 'error' };
    return {
      headline: p.status === 'ok' ? 'Done' : 'Error',
      tone: p.status === 'ok' ? 'work' : 'error',
    };
  },
  'cmo:subagent_dispatch': (e) => {
    const p = e.payload as { subAgent?: string; promptPreview?: string };
    return {
      headline: `Asking ${prettyAgent(p.subAgent ?? '')}`,
      sub: p.promptPreview,
      tone: 'dispatch',
    };
  },
  'cmo:subagent_finish': (e) => {
    const p = e.payload as { subAgent?: string; status?: string; summary?: string };
    return {
      headline:
        p.status === 'ok'
          ? `${prettyAgent(p.subAgent ?? '')} finished`
          : `${prettyAgent(p.subAgent ?? '')} failed`,
      sub: p.summary,
      tone: p.status === 'ok' ? 'work' : 'error',
    };
  },
  'strategic-planner:subagent_dispatch': () => ({
    headline: 'Strategist is planning',
    tone: 'work',
  }),
  'strategic-planner:subagent_text_delta': (e) => {
    const p = e.payload as { text?: string };
    return {
      headline: 'Strategist is planning',
      sub: p.text?.slice(-80),
      tone: 'work',
    };
  },
  'strategic-planner:subagent_finish': (e) => {
    const p = e.payload as { status?: string; summary?: string };
    return {
      headline: p.status === 'ok' ? 'Plan ready' : 'Strategist failed',
      sub: p.summary,
      tone: p.status === 'ok' ? 'work' : 'error',
    };
  },
};

/**
 * Look up a friendly label for an activity event. Falls back to a
 * humanized kind when no specific mapping exists.
 */
export function labelEvent(event: ActivityEvent): ActivityLabel {
  const tool = (event.payload as { tool?: string }).tool;
  const keys = [
    tool ? `${event.sourceAgent}:${event.kind}:${tool}` : null,
    `${event.sourceAgent}:${event.kind}`,
  ].filter(Boolean) as string[];
  for (const k of keys) {
    const fn = LABELS[k];
    if (fn) return fn(event);
  }
  return {
    headline: event.kind.replace(/_/g, ' '),
    sub: tool,
    tone: 'work',
  };
}
