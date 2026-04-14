'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface TweetMetric {
  tweetId: string;
  impressions: number;
  likes: number;
  retweets: number;
  replies: number;
  bookmarks: number;
  quoteTweets: number;
  sampledAt: string;
}

interface FollowerSnapshot {
  followerCount: number;
  followingCount: number;
  tweetCount: number;
  snapshotAt: string;
}

interface MetricsData {
  range: string;
  totals: {
    impressions: number;
    likes: number;
    retweets: number;
    replies: number;
    bookmarks: number;
  };
  followerGrowth: number;
  followerHistory: FollowerSnapshot[];
  topTweets: TweetMetric[];
}

type Range = '7d' | '30d' | '90d';
type Sort = 'impressions' | 'likes' | 'bookmarks';

export function MetricsPanel() {
  const [range, setRange] = useState<Range>('7d');
  const [sort, setSort] = useState<Sort>('impressions');

  const { data, isLoading } = useSWR<MetricsData>(
    `/api/x/metrics?range=${range}&sort=${sort}`,
    fetcher,
    { refreshInterval: 120_000 },
  );

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const totals = data?.totals ?? { impressions: 0, likes: 0, retweets: 0, replies: 0, bookmarks: 0 };
  const followerGrowth = data?.followerGrowth ?? 0;
  const topTweets = data?.topTweets ?? [];
  const followerHistory = data?.followerHistory ?? [];
  const latestFollowers = followerHistory.length > 0
    ? followerHistory[followerHistory.length - 1].followerCount
    : null;

  return (
    <div className="flex flex-col gap-6">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-medium text-sf-text-secondary uppercase tracking-wider">
          Analytics
        </h3>
        <div className="flex items-center gap-2">
          {(['7d', '30d', '90d'] as Range[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-[var(--radius-sf-md)] transition-colors ${
                range === r
                  ? 'bg-sf-bg-secondary text-sf-text-primary'
                  : 'text-sf-text-tertiary hover:text-sf-text-secondary'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatCard label="Impressions" value={totals.impressions} />
        <StatCard label="Likes" value={totals.likes} />
        <StatCard label="Bookmarks" value={totals.bookmarks} highlight />
        <StatCard label="Retweets" value={totals.retweets} />
        <StatCard
          label="Follower Growth"
          value={followerGrowth}
          prefix={followerGrowth > 0 ? '+' : ''}
          subtitle={latestFollowers != null ? `${latestFollowers.toLocaleString()} total` : undefined}
        />
      </div>

      {/* Top tweets */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-[12px] font-medium text-sf-text-tertiary uppercase tracking-wider">
            Top Tweets
          </h4>
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-sf-text-tertiary mr-1">Sort by</span>
            {(['impressions', 'likes', 'bookmarks'] as Sort[]).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`px-2 py-1 text-[11px] rounded-[var(--radius-sf-sm)] transition-colors ${
                  sort === s
                    ? 'bg-sf-bg-secondary text-sf-text-primary font-medium'
                    : 'text-sf-text-tertiary hover:text-sf-text-secondary'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {topTweets.length === 0 ? (
          <div className="flex flex-col items-center py-12">
            <p className="text-[13px] text-sf-text-tertiary">
              No tweet metrics collected yet. Metrics are sampled every 6 hours.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topTweets.map((tweet, i) => (
              <Card key={tweet.tweetId} className="flex items-center gap-4 py-3">
                <span className="text-[12px] font-mono text-sf-text-tertiary w-5 text-right flex-shrink-0">
                  {i + 1}
                </span>
                <div className="flex items-center gap-4 flex-1 min-w-0 text-[12px] text-sf-text-secondary">
                  <span className="font-mono tabular-nums" title="Impressions">
                    {formatNum(tweet.impressions)} imp
                  </span>
                  <span className="font-mono tabular-nums" title="Likes">
                    {formatNum(tweet.likes)} likes
                  </span>
                  <span className="font-mono tabular-nums" title="Bookmarks">
                    {formatNum(tweet.bookmarks)} bkm
                  </span>
                  <span className="font-mono tabular-nums" title="Retweets">
                    {formatNum(tweet.retweets)} RT
                  </span>
                  <span className="font-mono tabular-nums" title="Replies">
                    {formatNum(tweet.replies)} rep
                  </span>
                </div>
                <a
                  href={`https://x.com/i/status/${tweet.tweetId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-sf-accent hover:underline flex-shrink-0"
                >
                  View
                </a>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Follower history */}
      {followerHistory.length > 1 && (
        <div>
          <h4 className="text-[12px] font-medium text-sf-text-tertiary uppercase tracking-wider mb-3">
            Follower Trend
          </h4>
          <Card className="p-4">
            <div className="flex items-end gap-1 h-24">
              {followerHistory.map((snap, i) => {
                const min = Math.min(...followerHistory.map((s) => s.followerCount));
                const max = Math.max(...followerHistory.map((s) => s.followerCount));
                const range = max - min || 1;
                const height = ((snap.followerCount - min) / range) * 100;

                return (
                  <div
                    key={i}
                    className="flex-1 bg-sf-accent/20 hover:bg-sf-accent/40 transition-colors rounded-t-sm"
                    style={{ height: `${Math.max(height, 4)}%` }}
                    title={`${snap.followerCount.toLocaleString()} followers — ${new Date(snap.snapshotAt).toLocaleDateString()}`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between mt-1 text-[10px] text-sf-text-tertiary">
              <span>{new Date(followerHistory[0].snapshotAt).toLocaleDateString()}</span>
              <span>{new Date(followerHistory[followerHistory.length - 1].snapshotAt).toLocaleDateString()}</span>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  prefix = '',
  highlight,
  subtitle,
}: {
  label: string;
  value: number;
  prefix?: string;
  highlight?: boolean;
  subtitle?: string;
}) {
  return (
    <Card className={`flex flex-col gap-1 ${highlight ? 'border-sf-accent/30' : ''}`}>
      <span className="text-[11px] font-medium text-sf-text-tertiary uppercase tracking-wider">
        {label}
      </span>
      <span className={`text-[20px] font-semibold tabular-nums ${highlight ? 'text-sf-accent' : 'text-sf-text-primary'}`}>
        {prefix}{formatNum(value)}
      </span>
      {subtitle && (
        <span className="text-[11px] text-sf-text-tertiary">{subtitle}</span>
      )}
    </Card>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
