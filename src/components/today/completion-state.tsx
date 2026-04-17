import Link from 'next/link';
import type { TodayStats } from '@/hooks/use-today';

export interface YesterdayTop {
  id: string;
  platform: string;
  community: string;
  externalUrl: string | null;
  postedAt: Date | string;
  draftType: string | null;
  draftPostTitle: string | null;
  replyBody: string | null;
  threadTitle: string | null;
  threadUpvotes: number | null;
  threadCommentCount: number | null;
}

interface CompletionStateProps {
  stats: TodayStats;
  yesterdayTop: YesterdayTop | null;
}

function communityLabel(platform: string, community: string): string {
  if (platform === 'reddit') return `r/${community}`;
  if (platform === 'x') return community;
  return community;
}

function titleFor(top: YesterdayTop): string {
  if (top.draftType === 'original_post' && top.draftPostTitle) {
    return top.draftPostTitle;
  }
  if (top.threadTitle) return `Re: ${top.threadTitle}`;
  if (top.replyBody) {
    return top.replyBody.length > 80
      ? top.replyBody.slice(0, 77) + '...'
      : top.replyBody;
  }
  return 'Your post';
}

export function CompletionState({ stats, yesterdayTop }: CompletionStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
      <div className="w-16 h-16 rounded-full bg-sf-success/10 flex items-center justify-center mb-6">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-sf-success"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>

      <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
        Today&apos;s marketing is handled.
      </h2>

      {stats.acted_today > 0 && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-1 leading-[1.47]">
          {stats.acted_today} {stats.acted_today === 1 ? 'task' : 'tasks'} completed today.
        </p>
      )}

      {stats.published_yesterday > 0 && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary mb-4 leading-[1.47]">
          {stats.published_yesterday} {stats.published_yesterday === 1 ? 'post' : 'posts'} published yesterday.
        </p>
      )}

      <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary leading-[1.47] mb-6">
        New tasks tomorrow morning.
      </p>

      {yesterdayTop && (
        <div className="w-full max-w-md rounded-[var(--radius-sf-lg)] border border-sf-border p-5 bg-sf-bg-primary mb-4">
          <div className="text-[11px] uppercase tracking-[0.6px] text-sf-text-tertiary mb-2">
            Yesterday&apos;s top post
          </div>
          <div className="text-[13px] text-sf-text-secondary mb-1">
            {communityLabel(yesterdayTop.platform, yesterdayTop.community)}
          </div>
          <div className="text-[14px] tracking-[-0.224px] text-sf-text-primary font-medium mb-3 leading-[1.4]">
            {titleFor(yesterdayTop)}
          </div>
          {(yesterdayTop.threadUpvotes !== null ||
            yesterdayTop.threadCommentCount !== null) && (
            <div className="flex gap-4 text-[12px] text-sf-text-tertiary mb-3">
              {yesterdayTop.threadUpvotes !== null && (
                <span>{yesterdayTop.threadUpvotes} upvotes</span>
              )}
              {yesterdayTop.threadCommentCount !== null && (
                <span>{yesterdayTop.threadCommentCount} comments</span>
              )}
            </div>
          )}
          {yesterdayTop.externalUrl && (
            <a
              href={yesterdayTop.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[13px] text-sf-accent hover:text-sf-accent/80 transition-colors"
            >
              View post &rarr;
            </a>
          )}
        </div>
      )}

      <Link
        href="/dashboard"
        className="text-[14px] tracking-[-0.224px] font-medium text-sf-accent hover:text-sf-accent/80 transition-colors duration-200"
      >
        Open Dashboard
      </Link>
    </div>
  );
}
