'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';

interface DraftCardProps {
  draft: {
    id: string;
    replyBody: string;
    confidenceScore: number;
    whyItWorks: string;
    ftcDisclosure: string;
    thread: {
      title: string;
      subreddit: string;
      url: string;
    };
  };
  onApprove: (id: string) => void;
  onSkip: (id: string) => void;
}

export function DraftCard({ draft, onApprove, onSkip }: DraftCardProps) {
  return (
    <div className="border border-sf-border rounded-[var(--radius-sf-lg)] p-4 bg-sf-bg-primary animate-sf-fade-in">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant="accent">r/{draft.thread.subreddit}</Badge>
          <Badge mono variant={draft.confidenceScore >= 0.7 ? 'success' : 'default'}>
            {(draft.confidenceScore * 100).toFixed(0)}%
          </Badge>
        </div>
      </div>

      <a
        href={draft.thread.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[13px] font-medium text-sf-text-primary hover:text-sf-accent transition-colors line-clamp-1 mb-2 block"
      >
        {draft.thread.title}
      </a>

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

      <Toggle label="Why this works">
        <p className="text-[13px] text-sf-text-secondary leading-relaxed">
          {draft.whyItWorks}
        </p>
      </Toggle>

      <div className="flex items-center gap-2 mt-4">
        <Button onClick={() => onApprove(draft.id)}>
          Approve
        </Button>
        <Button variant="ghost" onClick={() => onSkip(draft.id)}>
          Skip
        </Button>
      </div>
    </div>
  );
}
