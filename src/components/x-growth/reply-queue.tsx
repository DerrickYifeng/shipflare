'use client';

import { useState, useCallback } from 'react';
import { useMonitoredTweets } from '@/hooks/use-monitored-tweets';
import { useDrafts } from '@/hooks/use-drafts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TimeLeft } from '@/components/ui/time-left';

const statusVariant: Record<string, 'default' | 'success' | 'warning' | 'error' | 'accent'> = {
  pending: 'accent',
  draft_created: 'warning',
  replied: 'success',
  skipped: 'default',
  expired: 'error',
};

export function ReplyQueue() {
  const { tweets, isLoading, triggerScan } = useMonitoredTweets();
  const { drafts, approve, skip } = useDrafts();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      await triggerScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setScanning(false);
    }
  }, [triggerScan]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const pendingTweets = tweets.filter((t) => t.status === 'pending' || t.status === 'draft_created');
  const pastTweets = tweets.filter((t) => t.status !== 'pending' && t.status !== 'draft_created');

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
            Reply Queue
          </h3>
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
            {pendingTweets.length} tweet{pendingTweets.length !== 1 ? 's' : ''} awaiting reply
          </p>
        </div>
        <Button onClick={handleScan} disabled={scanning} variant="secondary">
          {scanning ? 'Scanning...' : 'Scan Now'}
        </Button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light text-[14px] tracking-[-0.224px] text-sf-error">
          {error}
        </div>
      )}

      {/* Active tweets */}
      {pendingTweets.length === 0 && pastTweets.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <div className="w-14 h-14 mb-4 rounded-full bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-1">
            No monitored tweets yet
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary max-w-[300px] text-center">
            Add target accounts first, then the monitor will scan their tweets
            every 15 minutes. You can also click Scan Now.
          </p>
        </div>
      ) : (
        <>
          {pendingTweets.length > 0 && (
            <div className="flex flex-col gap-2">
              {pendingTweets.map((tweet) => {
                // Find matching draft for this tweet (monitor-sourced, pending)
                const matchedDraft = tweet.status === 'draft_created'
                  ? drafts.find((d) => d.source === 'monitor' && d.thread.url?.includes(tweet.tweetId))
                  : undefined;
                return (
                  <TweetCard
                    key={tweet.id}
                    tweet={tweet}
                    draft={matchedDraft}
                    onApproveDraft={approve}
                    onSkipDraft={skip}
                  />
                );
              })}
            </div>
          )}

          {pastTweets.length > 0 && (
            <div>
              <h4 className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-tertiary uppercase mb-2">
                Past
              </h4>
              <div className="flex flex-col gap-2">
                {pastTweets.slice(0, 10).map((tweet) => (
                  <TweetCard key={tweet.id} tweet={tweet} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface TweetCardProps {
  tweet: ReturnType<typeof useMonitoredTweets>['tweets'][number];
  draft?: ReturnType<typeof useDrafts>['drafts'][number];
  onApproveDraft?: (id: string) => void;
  onSkipDraft?: (id: string) => void;
}

function TweetCard({ tweet, draft, onApproveDraft, onSkipDraft }: TweetCardProps) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">
              @{tweet.authorUsername}
            </span>
            <Badge variant={statusVariant[tweet.status] ?? 'default'}>
              {tweet.status.replace('_', ' ')}
            </Badge>
            {(tweet.status === 'pending' || tweet.status === 'draft_created') && (
              <TimeLeft deadline={tweet.replyDeadline} />
            )}
          </div>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed line-clamp-3">
            {tweet.tweetText}
          </p>
        </div>
      </div>

      {/* Inline draft preview + actions for draft_created tweets */}
      {draft && (
        <div className="mt-1 border-t border-sf-border pt-2">
          <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-1">Draft reply:</p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed line-clamp-3 mb-2">
            {draft.replyBody}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={() => onApproveDraft?.(draft.id)}
              className="text-[12px] tracking-[-0.12px] py-1 px-3"
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              onClick={() => onSkipDraft?.(draft.id)}
              className="text-[12px] tracking-[-0.12px] py-1 px-3"
            >
              Skip
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
        <span>via @{tweet.targetUsername}</span>
        <span>{new Date(tweet.postedAt).toLocaleString()}</span>
        <a
          href={tweet.tweetUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sf-accent hover:underline ml-auto"
        >
          View tweet
        </a>
      </div>
    </Card>
  );
}
