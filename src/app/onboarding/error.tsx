'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[onboarding error boundary]', error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-2">
        Onboarding hit a snag
      </h1>
      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary max-w-[420px] mb-6 leading-[1.47]">
        Something went wrong while setting up your product. Retrying usually
        works — if not, refresh the page and start again.
      </p>
      {error.digest && (
        <p className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-4">
          Ref: {error.digest}
        </p>
      )}
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
