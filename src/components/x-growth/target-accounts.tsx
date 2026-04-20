'use client';

import { useState, useCallback } from 'react';
import { useTargets } from '@/hooks/use-targets';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const categoryColors: Record<string, 'default' | 'signal' | 'success' | 'warning'> = {
  influencer: 'signal',
  competitor: 'warning',
  peer: 'success',
  media: 'default',
};

export function TargetAccounts() {
  const { targets, isLoading, addTarget, removeTarget } = useTargets();
  const [username, setUsername] = useState('');
  const [category, setCategory] = useState('influencer');
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = useCallback(async () => {
    if (!username.trim()) return;
    setIsAdding(true);
    setError(null);

    try {
      await addTarget(username.trim(), category);
      setUsername('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add target');
    } finally {
      setIsAdding(false);
    }
  }, [username, category, addTarget]);

  const handleRemove = useCallback(
    async (targetId: string) => {
      try {
        await removeTarget(targetId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove target');
      }
    },
    [removeTarget],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Add target form */}
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label className="block text-[12px] tracking-[-0.12px] font-medium text-sf-text-secondary mb-1">
            X Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="@levelsio"
            className="w-full px-3 py-2 text-[14px] tracking-[-0.224px] bg-sf-bg-secondary border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] text-sf-text-primary placeholder:text-sf-text-tertiary focus:outline-none focus:ring-1 focus:ring-sf-accent transition-shadow duration-200"
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
        </div>
        <div>
          <label className="block text-[12px] tracking-[-0.12px] font-medium text-sf-text-secondary mb-1">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2 text-[14px] tracking-[-0.224px] bg-sf-bg-secondary border border-[rgba(0,0,0,0.08)] rounded-[var(--radius-sf-md)] text-sf-text-primary focus:outline-none focus:ring-1 focus:ring-sf-accent transition-shadow duration-200"
          >
            <option value="influencer">Influencer</option>
            <option value="competitor">Competitor</option>
            <option value="peer">Peer</option>
            <option value="media">Media</option>
          </select>
        </div>
        <Button
          onClick={handleAdd}
          disabled={isAdding || !username.trim()}
          title={
            isAdding
              ? 'Adding…'
              : !username.trim()
                ? 'Enter an X username first'
                : undefined
          }
        >
          {isAdding ? 'Adding...' : 'Add Target'}
        </Button>
      </Card>

      {error && (
        <div className="px-4 py-3 rounded-[var(--radius-sf-md)] bg-sf-error-light text-[14px] tracking-[-0.224px] text-sf-error">
          {error}
        </div>
      )}

      {/* Target list */}
      {targets.length === 0 ? (
        <div className="flex flex-col items-center py-16">
          <div className="w-14 h-14 mb-4 rounded-full bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-sf-text-tertiary)" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <p className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary mb-1">
            No targets yet
          </p>
          <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary max-w-[300px] text-center">
            Add X accounts to monitor. The Reply Guy Engine will scan their tweets
            and generate fast, relevant replies.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {targets.map((target) => (
            <Card key={target.id} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-full bg-sf-bg-secondary shadow-[0_1px_3px_rgba(0,0,0,0.06)] flex items-center justify-center flex-shrink-0">
                  <span className="text-[12px] tracking-[-0.12px] font-semibold text-sf-text-secondary">
                    {target.username[0].toUpperCase()}
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary truncate">
                      @{target.username}
                    </span>
                    {target.category && (
                      <Badge variant={categoryColors[target.category] ?? 'default'}>
                        {target.category}
                      </Badge>
                    )}
                  </div>
                  {target.displayName && (
                    <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary truncate">
                      {target.displayName}
                      {target.followerCount != null && (
                        <span className="ml-2">
                          {target.followerCount.toLocaleString()} followers
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRemove(target.id)}
                className="text-sf-text-tertiary hover:text-sf-error transition-colors duration-200 p-1 flex-shrink-0"
                title="Remove target"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 3l8 8M11 3l-8 8" />
                </svg>
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
