'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { isPlatformAvailable } from '@/lib/platform-config';

interface ConnectAccountsStepProps {
  onComplete: () => void;
  onBack: () => void;
  redditConnected?: boolean;
  xConnected?: boolean;
}

export function ConnectAccountsStep({
  onComplete,
  onBack,
  redditConnected,
  xConnected,
}: ConnectAccountsStepProps) {
  // Hidden behind the platform registry. When Reddit flips `enabled: true`
  // in platform-config, this section reappears automatically — no copy diff.
  const showReddit = isPlatformAvailable('reddit');

  return (
    <div className="flex flex-col gap-6">
      <p className="text-[17px] tracking-[-0.374px] text-sf-text-secondary leading-[1.47]">
        Connect your X account so ShipFlare can post approved replies on your behalf.
      </p>

      <div className="flex flex-col gap-3">
        {/* Reddit — hidden for the X-only MVP via platform-config enabled flag. */}
        {showReddit && (
        <div className="flex items-center justify-between p-4 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] rounded-[var(--radius-sf-lg)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#FF4500]/10 rounded-[var(--radius-sf-md)] flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#FF4500" aria-hidden="true">
                <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">Reddit</p>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">Posts, comments, community discovery</p>
            </div>
            {redditConnected && (
              <Badge variant="success" className="text-[12px] tracking-[-0.12px]">Connected</Badge>
            )}
          </div>
          {!redditConnected && (
            <Button
              variant="ghost"
              className="text-[14px] tracking-[-0.224px]"
              onClick={() => { window.location.href = '/api/reddit/connect'; }}
            >
              Connect
            </Button>
          )}
        </div>
        )}

        {/* X / Twitter */}
        <div className="flex items-center justify-between p-4 bg-sf-bg-secondary shadow-[0_3px_5px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.06)] rounded-[var(--radius-sf-lg)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-sf-bg-tertiary rounded-[var(--radius-sf-md)] flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-sf-text-primary" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </div>
            <div>
              <p className="text-[14px] tracking-[-0.224px] font-medium text-sf-text-primary">X</p>
              <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">Tweets, replies, topic discovery</p>
            </div>
            {xConnected && (
              <Badge variant="success" className="text-[12px] tracking-[-0.12px]">Connected</Badge>
            )}
          </div>
          {!xConnected && (
            <Button
              variant="ghost"
              className="text-[14px] tracking-[-0.224px]"
              onClick={() => { window.location.href = '/api/x/connect'; }}
            >
              Connect
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" onClick={onComplete}>
          Skip for now
        </Button>
      </div>

      <p className="text-[12px] tracking-[-0.12px] text-sf-text-tertiary">
        You can always connect later from Settings. Discovery and content
        generation work without a connected account, but posting requires it.
      </p>
    </div>
  );
}
