'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import type { Draft } from '@/hooks/use-drafts';

interface DraftCardProps {
  draft: Draft;
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
  onRetry?: (id: string) => void;
}

const verdictConfig = {
  PASS: { color: 'text-sf-success', bg: 'bg-sf-success', label: 'PASS' },
  REVISE: { color: 'text-sf-warning', bg: 'bg-sf-warning', label: 'REVISE' },
  FAIL: { color: 'text-sf-error', bg: 'bg-sf-error', label: 'FAIL' },
} as const;

export function DraftCard({ draft, onApprove, onSkip, onRetry }: DraftCardProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const verdict = draft.review?.verdict as keyof typeof verdictConfig | undefined;
  const vConfig = verdict ? verdictConfig[verdict] : null;
  const isNeedsRevision = draft.status === 'needs_revision';

  return (
    <div className="border border-sf-border rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-primary animate-sf-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <Badge variant="accent">r/{draft.thread.subreddit}</Badge>
          <span className="font-mono text-[11px] text-sf-text-tertiary uppercase">
            {draft.draftType === 'original_post' ? 'new post' : 'reply'}
          </span>
          <Badge mono variant={draft.confidenceScore >= 0.7 ? 'success' : 'default'}>
            {(draft.confidenceScore * 100).toFixed(0)}%
          </Badge>
        </div>
        {/* Review verdict indicator */}
        {vConfig && (
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`inline-block w-2 h-2 rounded-full ${vConfig.bg}`} />
            <span className={`font-mono text-[11px] ${vConfig.color}`}>
              {vConfig.label}
            </span>
          </div>
        )}
      </div>

      {/* Post title for original_post */}
      {draft.postTitle && (
        <p className="text-[13px] font-medium text-sf-text-primary mb-1">
          {draft.postTitle}
        </p>
      )}

      {/* Thread link */}
      <a
        href={draft.thread.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[13px] font-medium text-sf-text-primary hover:text-sf-accent transition-colors line-clamp-1 mb-2 block"
      >
        {draft.thread.title}
      </a>

      {/* Draft body */}
      <div className="bg-sf-bg-secondary rounded-[var(--radius-sf-md)] p-3 mb-3">
        <p className="text-[13px] text-sf-text-primary leading-relaxed whitespace-pre-wrap">
          {draft.replyBody}
        </p>
      </div>

      {draft.ftcDisclosure && (
        <p className="text-[11px] text-sf-text-tertiary mb-3 italic">
          FTC: {draft.ftcDisclosure}
        </p>
      )}

      {/* Review suggestions for REVISE */}
      {isNeedsRevision && draft.review?.suggestions && draft.review.suggestions.length > 0 && (
        <div className="mb-3">
          <button
            type="button"
            onClick={() => setShowSuggestions((p) => !p)}
            className="text-[11px] font-mono text-sf-warning hover:text-sf-text-secondary transition-colors cursor-pointer"
          >
            {showSuggestions ? 'Hide' : 'Show'} review suggestions ({draft.review.suggestions.length})
          </button>
          {showSuggestions && (
            <ul className="mt-2 space-y-1 animate-sf-fade-in">
              {draft.review.suggestions.map((s, i) => (
                <li key={i} className="text-[12px] text-sf-text-secondary pl-3 border-l-2 border-sf-warning">
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Toggle label="Why this works">
        <p className="text-[13px] text-sf-text-secondary leading-relaxed">
          {draft.whyItWorks}
        </p>
      </Toggle>

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
}
