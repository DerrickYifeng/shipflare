'use client';

import { useEngagement } from '@/hooks/use-engagement';
import { useDrafts } from '@/hooks/use-drafts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function EngagementAlerts() {
  const { recentPosts, engagementDrafts, isLoading } = useEngagement();
  const { approve, skip } = useDrafts();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h3 className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-secondary uppercase">
          Engagement
        </h3>
        <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mt-0.5">
          First-hour engagement window &mdash; respond to replies on your tweets
        </p>
      </div>

      {/* Recent posts with engagement stats */}
      {recentPosts.length > 0 && (
        <div>
          <h4 className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-tertiary uppercase mb-2">
            Recent X Posts
          </h4>
          <div className="flex flex-col gap-2">
            {recentPosts.map((post) => (
              <Card key={post.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Badge variant={post.status === 'verified' ? 'success' : 'default'}>
                    {post.status}
                  </Badge>
                  <span className="text-[14px] tracking-[-0.224px] text-sf-text-secondary truncate">
                    {post.community}
                  </span>
                  <span className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
                    {new Date(post.postedAt).toLocaleString()}
                  </span>
                </div>
                {post.externalUrl && (
                  <a
                    href={post.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] tracking-[-0.12px] text-sf-accent hover:underline flex-shrink-0"
                  >
                    View
                  </a>
                )}
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Engagement draft replies */}
      {engagementDrafts.length > 0 ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[12px] tracking-[-0.12px] font-medium text-sf-text-tertiary uppercase">
              Draft Replies ({engagementDrafts.length})
            </h4>
            <a
              href="/today"
              className="text-[12px] tracking-[-0.12px] text-sf-accent hover:underline"
            >
              View all in Queue
            </a>
          </div>
          <div className="flex flex-col gap-2">
            {engagementDrafts.map((draft) => (
              <Card key={draft.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-1">
                      Replying to: {draft.thread.title || draft.thread.community}
                    </p>
                    <p className="text-[14px] tracking-[-0.224px] text-sf-text-primary leading-relaxed">
                      {draft.replyBody}
                    </p>
                  </div>
                  {draft.confidenceScore > 0 && (
                    <Badge
                      variant={draft.confidenceScore >= 0.8 ? 'success' : draft.confidenceScore >= 0.6 ? 'warning' : 'error'}
                      mono
                    >
                      {Math.round(draft.confidenceScore * 100)}%
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={() => approve(draft.id)} className="text-[12px] tracking-[-0.12px] py-1 px-3">
                    Approve &amp; Post
                  </Button>
                  <Button variant="ghost" onClick={() => skip(draft.id)} className="text-[12px] tracking-[-0.12px] py-1 px-3">
                    Skip
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center py-16">
          <div className="w-14 h-14 mb-4 rounded-full bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.5">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
          </div>
          <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-1">
            No engagement alerts
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary max-w-[320px] text-center">
            After you post tweets, the engagement monitor checks for replies
            at +15, +30, and +60 minutes and generates response drafts.
          </p>
        </div>
      )}
    </div>
  );
}
