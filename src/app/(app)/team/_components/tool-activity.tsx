import type { CSSProperties } from 'react';

export interface ToolActivityProps {
  toolName: string;
  variant: 'tool' | 'error';
  elapsed: string | null;
  complete: boolean;
  errorText: string | null;
  /**
   * Human-readable attribution ("Team Lead", "Nova", etc.). When omitted
   * the row falls back to the old "Using tool: X / Used tool: X" copy so
   * legacy rendering paths don't regress.
   */
  actor?: string | null;
}

/**
 * Compact single-line activity row rendered inline in the conversation
 * thread — surfaces non-Task tool_calls (e.g. `query_strategic_path`) and
 * errors that would otherwise be invisible to the user.
 *
 * `complete=false` renders with `--animate-sf-pulse` so an in-flight tool
 * visibly breathes; once the matching tool_result arrives the row dims
 * and shows the elapsed duration.
 *
 * When an `actor` is supplied the row reads as a natural sentence —
 * "Nova used Grep · 1.2s" — instead of the older label-like "Used tool: X"
 * which the design review flagged as log-y.
 */
export function ToolActivity({
  toolName,
  variant,
  elapsed,
  complete,
  errorText,
  actor,
}: ToolActivityProps) {
  const isError = variant === 'error';

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 0 6px 38px',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 12,
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-fg-3)',
    lineHeight: 1.4,
    animation: complete ? undefined : 'var(--animate-sf-pulse)',
    opacity: complete && !isError ? 0.72 : 1,
  };

  const icon: CSSProperties = {
    width: 12,
    height: 12,
    flexShrink: 0,
    color: 'inherit',
  };

  const label: CSSProperties = {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  const name: CSSProperties = {
    color: isError ? 'var(--sf-error-ink)' : 'var(--sf-fg-2)',
  };

  const actorStyle: CSSProperties = {
    color: 'var(--sf-fg-2)',
  };

  const meta: CSSProperties = {
    color: 'var(--sf-fg-4)',
    fontVariantNumeric: 'tabular-nums',
    flexShrink: 0,
  };

  if (isError) {
    return (
      <div style={row} data-testid="tool-activity" data-variant="error">
        <svg
          style={icon}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 1.5l6.5 11.5h-13z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path
            d="M8 6v3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
        </svg>
        <span style={label}>
          <span style={name}>Error</span>
          {errorText ? ` — ${errorText}` : null}
        </span>
      </div>
    );
  }

  // Natural-language attribution when we know who ran the tool.
  // Falls back to the older label-style copy otherwise.
  const verb = complete ? 'used' : 'is using';
  const hasActor = typeof actor === 'string' && actor.length > 0;

  return (
    <div
      style={row}
      data-testid="tool-activity"
      data-variant="tool"
      data-complete={complete ? 'true' : 'false'}
    >
      <svg style={icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M9 1L2.5 9h4L7 15l6.5-8h-4L9 1z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span style={label}>
        {hasActor ? (
          <>
            <span style={actorStyle}>{actor}</span> {verb}{' '}
          </>
        ) : (
          <>{complete ? 'Used tool: ' : 'Using tool: '}</>
        )}
        <span style={name}>{toolName}</span>
      </span>
      {elapsed ? <span style={meta}>· {elapsed}</span> : null}
    </div>
  );
}
