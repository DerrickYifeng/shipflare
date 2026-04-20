'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { TimeLeft } from '@/components/ui/time-left';
import type { Draft } from '@/hooks/use-drafts';

/**
 * Pick a one-sentence recap for the DraftCard summary line.
 *
 * Prefers the agent-returned `summaryReason`, but falls back to the first
 * sentence of `whyItWorks` for drafts generated before the schema field
 * existed. Returns null when neither is available so the caller can skip
 * the entire row.
 */
function pickSummaryReason(draft: Draft): string | null {
  if (draft.summaryReason && draft.summaryReason.trim().length > 0) {
    return draft.summaryReason.trim();
  }
  const why = draft.whyItWorks?.trim();
  if (!why) return null;
  // First sentence ending in ".", "!", or "?" — cap at 160 chars.
  const match = why.match(/^[^.!?]+[.!?]/);
  const first = match ? match[0] : why.slice(0, 160);
  return first.trim();
}

interface DraftCardProps {
  draft: Draft;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onRetry?: (id: string) => void;
  /** Highlighted as the current keyboard focus. */
  isActive?: boolean;
}

const verdictConfig = {
  PASS: { color: 'text-sf-success', bg: 'bg-sf-success', label: 'PASS' },
  REVISE: { color: 'text-sf-warning', bg: 'bg-sf-warning', label: 'REVISE' },
  FAIL: { color: 'text-sf-error', bg: 'bg-sf-error', label: 'FAIL' },
} as const;

const sourceLabel: Record<string, string> = {
  monitor: 'Scheduled replies',
  calendar: 'Scheduled posts',
  engagement: 'Engage with my audience',
  discovery: 'Community threads',
};

const urgencyBorder: Record<string, string> = {
  critical: 'border-sf-error',
  high: 'border-sf-warning',
  normal: 'border-sf-border',
};

// Memoized so drafts filter/refresh cycles don't re-render every card — the
// parent (DraftQueue) feeds stable callbacks via useCallback-wrapped hooks.
export const DraftCard = memo(function DraftCard({
  draft,
  onApprove,
  onSkip,
  onRetry,
  isActive = false,
}: DraftCardProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const verdict = draft.review?.verdict as keyof typeof verdictConfig | undefined;
  const vConfig = verdict ? verdictConfig[verdict] : null;
  const isNeedsRevision = draft.status === 'needs_revision';
  const rootRef = useRef<HTMLDivElement>(null);
  const summary = useMemo(() => pickSummaryReason(draft), [draft]);

  useEffect(() => {
    if (isActive) {
      rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  return (
    <div
      ref={rootRef}
      className={`rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] animate-sf-fade-in ${draft.urgency !== 'normal' ? `border ${urgencyBorder[draft.urgency] ?? ''}` : ''} ${isActive ? 'ring-2 ring-sf-accent' : ''}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {/* Platform icon */}
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            {draft.platform === 'x' ? '𝕏' : draft.platform}
          </span>
          <Badge variant="accent">{draft.thread.community}</Badge>
          {/* Source badge */}
          <Badge variant="default">
            {sourceLabel[draft.source] ?? draft.source}
          </Badge>
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary uppercase">
            {draft.draftType === 'original_post' ? 'new post' : 'reply'}
          </span>
          <Badge mono variant={draft.confidenceScore >= 0.7 ? 'success' : 'default'}>
            {(draft.confidenceScore * 100).toFixed(0)}%
          </Badge>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Countdown for monitor-sourced drafts */}
          {draft.replyDeadline && (
            <TimeLeft deadline={draft.replyDeadline} />
          )}
          {/* Urgency dot */}
          {draft.urgency !== 'normal' && (
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                draft.urgency === 'critical'
                  ? 'bg-sf-error animate-pulse'
                  : 'bg-sf-warning'
              }`}
            />
          )}
          {/* Review verdict indicator */}
          {vConfig && (
            <div className="flex items-center gap-1.5">
              <span className={`inline-block w-2 h-2 rounded-full ${vConfig.bg}`} />
              <span className={`font-mono text-[12px] tracking-[-0.12px] ${vConfig.color}`}>
                {vConfig.label}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Post title for original_post */}
      {draft.postTitle && (
        <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary mb-1">
          {draft.postTitle}
        </p>
      )}

      {/* Thread link */}
      <a
        href={draft.thread.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary hover:text-sf-accent transition-colors duration-200 line-clamp-1 mb-2 block"
      >
        {draft.thread.title}
      </a>

      {/* Draft body */}
      <div className="bg-[#f5f5f7] rounded-[var(--radius-sf-md)] p-3 mb-3">
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed whitespace-pre-wrap">
          {draft.replyBody}
        </p>
      </div>

      {draft.ftcDisclosure && (
        <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-3 italic">
          FTC: {draft.ftcDisclosure}
        </p>
      )}

      {/* Review suggestions for REVISE */}
      {isNeedsRevision && draft.review?.suggestions && draft.review.suggestions.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowSuggestions((p) => !p)}
            className="text-[12px] tracking-[-0.12px] font-mono text-sf-warning hover:text-sf-text-secondary transition-colors duration-200 cursor-pointer"
          >
            {showSuggestions ? 'Hide' : 'Show'} review suggestions ({draft.review.suggestions.length})
          </button>
          {showSuggestions && (
            <ul className="mt-2 space-y-1 animate-sf-fade-in">
              {draft.review.suggestions.map((s, i) => (
                <li key={i} className="text-[12px] tracking-[-0.12px] text-sf-text-secondary pl-3 border-l-2 border-sf-warning">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Default-visible one-sentence recap. */}
      {summary && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed mb-2">
          {summary}
        </p>
      )}

      {/* Deep strategy rationale kept behind a toggle — only show when
          there's more to say than the summary line. */}
      {draft.whyItWorks && draft.whyItWorks.trim() !== summary && (
        <Toggle label="See detailed reasoning">
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed">
            {draft.whyItWorks}
          </p>
        </Toggle>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mt-4">
        <Button onClick={() => onApprove(draft.id)}>
          Send
        </Button>
        {isNeedsRevision && onRetry && (
          <Button variant="ghost" onClick={() => onRetry(draft.id)}>
            Retry
          </Button>
        )}
        <Button variant="ghost" onClick={() => onSkip(draft.id)}>
          Skip
        </Button>
      </div>
    </div>
  );
});
