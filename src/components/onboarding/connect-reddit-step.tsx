'use client';

import { Button } from '@/components/ui/button';

interface ConnectRedditStepProps {
  onComplete: () => void;
}

export function ConnectRedditStep({ onComplete }: ConnectRedditStepProps) {
  const handleConnect = () => {
    // Redirect to Reddit OAuth flow
    window.location.href = '/api/reddit/connect';
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="text-[15px] text-sf-text-secondary leading-relaxed">
        <p>
          Connect your Reddit account so ShipFlare can post approved replies on your behalf.
        </p>
        <p className="mt-3">
          We request read and submit permissions. You can disconnect at any time
          from Settings.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={handleConnect}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <path d="M9 0C4.03 0 0 4.03 0 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm5.39 10.16c.03.18.04.36.04.55 0 2.83-3.3 5.12-7.37 5.12S-.31 13.54-.31 10.71c0-.18.01-.37.04-.55a1.43 1.43 0 01-.57-1.14c0-.79.64-1.43 1.43-1.43.37 0 .71.14.96.38 1.34-.96 3.18-1.59 5.23-1.66l.98-4.62a.31.31 0 01.37-.24l3.27.69a1.02 1.02 0 011.95.37c0 .56-.46 1.02-1.02 1.02s-1.02-.46-1.02-1.02l-.01-.09-2.93-.61-.88 4.13c2.02.08 3.83.71 5.15 1.65.25-.23.58-.37.95-.37.79 0 1.43.64 1.43 1.43 0 .45-.21.86-.55 1.13zM6.27 10.71c-.56 0-1.02.46-1.02 1.02s.46 1.02 1.02 1.02 1.02-.46 1.02-1.02-.46-1.02-1.02-1.02zm5.46 0c-.56 0-1.02.46-1.02 1.02s.46 1.02 1.02 1.02 1.02-.46 1.02-1.02-.46-1.02-1.02-1.02zm-5.16 3.66a.3.3 0 01-.02-.43.3.3 0 01.43-.02c.6.51 1.48.79 2.48.79s1.88-.28 2.48-.79a.3.3 0 01.43.02.3.3 0 01-.02.43c-.71.6-1.71.94-2.89.94s-2.18-.34-2.89-.94z"/>
          </svg>
          Connect Reddit
        </Button>
        <Button variant="ghost" onClick={onComplete}>
          Skip for now
        </Button>
      </div>

      <p className="text-[11px] text-sf-text-tertiary">
        You can always connect later from Settings. Discovery and content
        generation work without a connected account, but posting requires it.
      </p>
    </div>
  );
}
