import { Badge } from '@/components/ui/badge';

interface ScoreDimensions {
  relevance: number;
  intent: number;
  exposure: number;
  freshness: number;
  engagement: number;
}

interface DiscoveryCardProps {
  source: string;
  title: string;
  url: string;
  subreddit: string;
  upvotes: number;
  commentCount: number;
  relevanceScore: number;
  scores?: ScoreDimensions;
  postedAt: string;
}

function getSourceIcon(source: string) {
  switch (source) {
    case 'reddit':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#FF4500" aria-hidden="true">
          <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
        </svg>
      );
    case 'hackernews':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#FF6600" aria-hidden="true">
          <path d="M0 0v24h24V0H0zm11.09 13.28V18h1.75v-4.72l4.38-8.1h-1.97l-3.3 6.19-3.29-6.19H6.71l4.38 8.1z" />
        </svg>
      );
    default:
      return (
        <div className="w-4 h-4 rounded-full bg-sf-bg-tertiary" aria-hidden="true" />
      );
  }
}

function formatTimeAgo(isoDate: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  const days = Math.floor(seconds / 86400);

  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;

  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}h ago`;

  return 'just now';
}

const DIMENSION_LABELS: Record<keyof ScoreDimensions, string> = {
  relevance: 'Relevance',
  intent: 'Intent',
  exposure: 'Exposure',
  freshness: 'Freshness',
  engagement: 'Engagement',
};

export function DiscoveryCard({
  source,
  title,
  url,
  subreddit,
  upvotes,
  commentCount,
  relevanceScore,
  scores,
  postedAt,
}: DiscoveryCardProps) {
  const scoreVariant =
    relevanceScore >= 70 ? 'success' : relevanceScore >= 40 ? 'warning' : 'default';

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="
        group relative flex items-start gap-3 px-4 py-3
        border-b border-sf-border-subtle
        hover:bg-sf-bg-secondary transition-colors duration-150
      "
    >
      <div className="shrink-0 mt-0.5">{getSourceIcon(source)}</div>

      <div className="flex-1 min-w-0">
        <p className="text-[15px] text-sf-text-primary font-medium leading-snug line-clamp-2">
          {title}
        </p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <Badge className="shrink-0">
            r/{subreddit}
          </Badge>
          <span className="text-[11px] text-sf-text-tertiary">
            {formatTimeAgo(postedAt)}
          </span>
          <span className="text-[11px] text-sf-text-tertiary flex items-center gap-0.5">
            <ArrowUpIcon />
            {formatCount(upvotes)}
          </span>
          <span className="text-[11px] text-sf-text-tertiary flex items-center gap-0.5">
            <CommentIcon />
            {formatCount(commentCount)}
          </span>
        </div>
      </div>

      <div className="relative shrink-0 mt-0.5">
        <Badge mono variant={scoreVariant}>
          {relevanceScore}
        </Badge>

        {/* Score breakdown tooltip on hover */}
        {scores && (
          <div className="
            absolute right-0 top-full mt-1 z-10
            opacity-0 pointer-events-none scale-95
            group-hover:opacity-100 group-hover:pointer-events-auto group-hover:scale-100
            transition-all duration-150 origin-top-right
          ">
            <div className="
              bg-sf-text-primary text-white rounded-[var(--radius-sf-md)]
              px-3 py-2 shadow-lg min-w-[160px]
            ">
              {(Object.entries(scores) as [keyof ScoreDimensions, number][]).map(
                ([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-4 py-0.5">
                    <span className="text-[11px] text-white/70">
                      {DIMENSION_LABELS[key]}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <div className="w-[48px] h-[3px] bg-white/20 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-white/80 rounded-full"
                          style={{ width: `${value}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-white/90 w-[24px] text-right">
                        {value}
                      </span>
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        )}
      </div>
    </a>
  );
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ArrowUpIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 2l5 6H9v6H7V8H3l5-6z" />
    </svg>
  );
}

function CommentIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M2.5 2A1.5 1.5 0 001 3.5v7A1.5 1.5 0 002.5 12H5l3 3 3-3h2.5a1.5 1.5 0 001.5-1.5v-7A1.5 1.5 0 0013.5 2h-11z" />
    </svg>
  );
}
