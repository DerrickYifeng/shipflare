import { Badge } from '@/components/ui/badge';

interface OriginalContentEmbedProps {
  author: string | null;
  body: string | null;
  title: string | null;
  url: string;
  platform: string;
  postedAt: string | null;
  upvotes: number | null;
  commentCount: number | null;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function OriginalContentEmbed({
  author,
  body,
  title,
  url,
  platform,
  postedAt,
  upvotes,
  commentCount,
}: OriginalContentEmbedProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block rounded-[var(--radius-sf-md)] border-l-2 border-sf-text-tertiary bg-[#f5f5f7] p-3 transition-colors duration-200 hover:bg-sf-bg-tertiary"
    >
      {/* Author */}
      {author && (
        <div className="flex items-center gap-2 mb-1.5">
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
            {platform === 'x' ? '𝕏' : platform}
          </span>
          <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-secondary">
            @{author}
          </span>
          {postedAt && (
            <span className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
              {formatRelativeTime(postedAt)}
            </span>
          )}
        </div>
      )}

      {/* Title (primarily for Reddit threads) */}
      {title && platform !== 'x' && (
        <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary line-clamp-2 mb-1">
          {title}
        </p>
      )}

      {/* Body */}
      {body && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed whitespace-pre-wrap">
          {body}
        </p>
      )}

      {/* If X platform and no body, show title as body */}
      {platform === 'x' && !body && title && (
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary leading-relaxed whitespace-pre-wrap">
          {title}
        </p>
      )}

      {/* Stats footer */}
      {(upvotes != null || commentCount != null) && (
        <div className="flex items-center gap-3 mt-2">
          {upvotes != null && upvotes > 0 && (
            <Badge mono variant="default">
              {platform === 'x' ? '♥' : '▲'} {upvotes}
            </Badge>
          )}
          {commentCount != null && commentCount > 0 && (
            <Badge mono variant="default">
              💬 {commentCount}
            </Badge>
          )}
        </div>
      )}
    </a>
  );
}
