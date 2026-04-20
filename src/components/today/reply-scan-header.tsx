'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';

interface ReplyScanHeaderProps {
  lastScannedAt: Date | null;
  replyCount: number;
  /**
   * Whether the signed-in user has at least one connected platform channel.
   * Server-rendered truth threaded from the Today page. When `false` the
   * Scan button disables and a deep-link micro-CTA to /settings#connections
   * replaces the toast fallback (toast still fires for mid-session
   * disconnects surfaced via the 400 branch).
   */
  hasConnectedChannel: boolean;
  onScanStarted: (
    scanRunId: string,
    sources: Array<{ platform: string; source: string }>,
  ) => void;
}

interface ScanResponseBody {
  scanRunId: string;
  platforms: string[];
  sources: Array<{ platform: string; source: string }>;
  status?: string;
}

interface RateLimitBody {
  error: 'rate_limited';
  retryAfterSeconds: number;
}

interface ScanErrorBody {
  error: string;
}

/**
 * Header above the Today reply surface. Shows when the last scan ran, how
 * many replies are currently available, and a Scan button that posts to
 * `/api/discovery/scan`. On 429 we surface the server-provided debounce
 * window via toast and shake the button briefly.
 */
export function ReplyScanHeader({
  lastScannedAt,
  replyCount,
  hasConnectedChannel,
  onScanStarted,
}: ReplyScanHeaderProps) {
  const { toast } = useToast();
  const [scanning, setScanning] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/discovery/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as Partial<RateLimitBody>;
        const seconds = body.retryAfterSeconds ?? 60;
        setShakeKey((k) => k + 1);
        toast(`Just scanned — next available in ${seconds}s`, 'info');
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as Partial<ScanErrorBody>;
        toast(
          body.error === 'no connected channels'
            ? 'Connect a channel to start scanning for replies.'
            : body.error ?? 'Scan failed',
          'error',
        );
        return;
      }
      if (!res.ok) {
        throw new Error(`Scan failed (${res.status})`);
      }
      const body = (await res.json()) as ScanResponseBody;
      onScanStarted(body.scanRunId, body.sources);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('shipflare:lastScanRunId', body.scanRunId);
        window.localStorage.setItem(
          'shipflare:lastScanAt',
          new Date().toISOString(),
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Scan failed', 'error');
    } finally {
      setScanning(false);
    }
  }, [onScanStarted, toast]);

  const relTime = lastScannedAt
    ? relativeTime(lastScannedAt)
    : 'Never scanned — try it now.';

  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div className="min-w-0">
        <h3 className="text-[17px] tracking-[-0.374px] font-medium text-sf-text-primary">
          Replies
        </h3>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-tertiary mt-0.5">
          Last scan: {relTime}
          {replyCount > 0 && ` · ${replyCount} replies generated`}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Badge variant="default">Auto-scans every 4h</Badge>
          <Button
            key={shakeKey}
            onClick={handleScan}
            disabled={scanning || !hasConnectedChannel}
            variant="ghost"
            className={shakeKey > 0 ? 'animate-sf-fade-in' : ''}
            title={
              !hasConnectedChannel
                ? 'Connect a channel before scanning for replies'
                : undefined
            }
          >
            {scanning ? 'Scanning…' : 'Scan for replies'}
          </Button>
        </div>
        {!hasConnectedChannel && (
          <Link
            href="/settings#connections"
            className="text-[12px] tracking-[-0.12px] text-sf-accent hover:underline"
          >
            Connect an X account →
          </Link>
        )}
      </div>
    </div>
  );
}

function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
