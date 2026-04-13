import { Badge } from '@/components/ui/badge';
import type { IntentClassification } from '@/types/discovery';

interface DiscoveryCardProps {
  source: string;
  title: string;
  url: string;
  community: string;
  relevanceScore: number;
  postedAt: string;
  reason?: string;
  metadata?: {
    upvotes?: number;
    commentCount?: number;
    points?: number;
    author?: string;
  };
  intent?: IntentClassification;
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
    case 'web':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-sf-text-tertiary" aria-hidden="true">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
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

const BUYER_STAGE_LABELS: Record<string, string> = {
  purchase_ready: 'Ready to buy',
  product_aware: 'Comparing products',
  solution_aware: 'Exploring solutions',
  problem_aware: 'Problem aware',
  recently_purchased: 'Recently purchased',
};

function IntentBadge({ intent }: { intent: IntentClassification }) {
  if (intent.buyerStage === 'purchase_ready' || intent.buyerStage === 'product_aware') {
    return <Badge variant="success" className="text-[10px]">{BUYER_STAGE_LABELS[intent.buyerStage]}</Badge>;
  }
  if (intent.posterNeed.present && intent.posterNeed.strength > 0.6) {
    return <Badge variant="warning" className="text-[10px]">Seeking solution</Badge>;
  }
  if (intent.readerNeed.present && intent.readerNeed.strength > 0.6) {
    return <Badge variant="accent" className="text-[10px]">Audience fit</Badge>;
  }
  return null;
}

export function DiscoveryCard({
  source,
  title,
  url,
  community,
  relevanceScore,
  postedAt,
  reason,
  metadata,
  intent,
}: DiscoveryCardProps) {
  const upvotes = metadata?.upvotes ?? metadata?.points;
  const commentCount = metadata?.commentCount;

  const scoreColor =
    relevanceScore >= 70
      ? 'text-sf-success'
      : relevanceScore >= 40
        ? 'text-sf-accent'
        : 'text-sf-text-tertiary';

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="
        group flex items-stretch px-4 py-3
        border-b border-sf-border-subtle
        hover:bg-sf-bg-secondary transition-colors duration-150
      "
    >
      {/* Content — left side */}
      <div className="flex-1 min-w-0 flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{getSourceIcon(source)}</div>

        <div className="flex-1 min-w-0">
          <p className="text-[15px] text-sf-text-primary font-medium leading-snug line-clamp-2">
            {title}
          </p>

          {/* Preview snippet */}
          {reason && (
            <p className="mt-1 text-[12px] text-sf-text-secondary leading-relaxed line-clamp-2">
              {reason}
            </p>
          )}

          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <Badge className="shrink-0">
              {community}
            </Badge>
            {intent && <IntentBadge intent={intent} />}
            <span className="text-[11px] text-sf-text-tertiary">
              {formatTimeAgo(postedAt)}
            </span>
            {upvotes != null && (
              <span className="text-[11px] text-sf-text-tertiary flex items-center gap-0.5">
                <ArrowUpIcon />
                {formatCount(upvotes)}
              </span>
            )}
            {commentCount != null && (
              <span className="text-[11px] text-sf-text-tertiary flex items-center gap-0.5">
                <CommentIcon />
                {formatCount(commentCount)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Score — right side */}
      <div className="shrink-0 flex items-center justify-center w-14 ml-3">
        <span className={`text-[22px] font-semibold tabular-nums ${scoreColor}`}>
          {relevanceScore}
        </span>
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
