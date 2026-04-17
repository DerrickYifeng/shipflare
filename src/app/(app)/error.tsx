'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Error boundary for the authenticated app segment. Rendered by Next.js when
 * a Server Component throws beneath (app)/layout.tsx.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console so users pasting a screenshot into support
    // include the stack; server errors are already captured by the logger.
    console.error('[app error boundary]', error);
  }, [error]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div className="w-14 h-14 mb-4 rounded-full bg-sf-error-light flex items-center justify-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-sf-error)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h1 className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19] mb-2">
        Something went wrong
      </h1>
      <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary max-w-[420px] mb-6 leading-[1.47]">
        We couldn&apos;t load this page. Try again — if the problem keeps
        happening, the error has been logged on our side.
      </p>
      {error.digest && (
        <p className="font-mono text-[12px] tracking-[-0.12px] text-sf-text-tertiary mb-4">
          Ref: {error.digest}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button variant="ghost" onClick={() => { window.location.href = '/today'; }}>
          Go to Today
        </Button>
      </div>
    </div>
  );
}
