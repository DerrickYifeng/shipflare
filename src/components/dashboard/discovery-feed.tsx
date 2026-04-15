'use client';

import { useDiscovery } from '@/hooks/use-discovery';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function DiscoveryFeed() {
  const { threads, isLoading } = useDiscovery();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-1">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-[17px] tracking-[-0.374px] text-sf-text-secondary mb-1">No threads discovered</p>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary">
          Run a discovery scan to find relevant Reddit threads.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {threads.map((thread) => (
        <a
          key={thread.id}
          href={thread.url}
          target="_blank"
          rel="noopener noreferrer"
          className="
            flex items-center gap-3 px-3 py-2.5
            rounded-[var(--radius-sf-md)]
            hover:bg-sf-bg-secondary transition-colors duration-200
          "
        >
          <Badge mono variant={thread.relevanceScore >= 0.7 ? 'success' : 'default'}>
            {(thread.relevanceScore * 100).toFixed(0)}
          </Badge>
          <span className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary shrink-0">
            {thread.community}
          </span>
          <span className="text-[14px] tracking-[-0.224px] text-sf-text-primary truncate">
            {thread.title}
          </span>
        </a>
      ))}
    </div>
  );
}
