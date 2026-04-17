'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';

interface FirstRunProps {
  onItemsReady: () => void;
  /** Whether the user has at least one connected publishing channel. */
  hasChannel?: boolean;
}

export function FirstRun({ onItemsReady, hasChannel = true }: FirstRunProps) {
  // hasChannel drives the timeout copy — see the SSE-driven rewrite that
  // replaces this placeholder.
  void hasChannel;
  const [status, setStatus] = useState<'seeding' | 'polling' | 'timeout'>('seeding');
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    let pollInterval: ReturnType<typeof setInterval>;
    let tickInterval: ReturnType<typeof setInterval>;
    const maxWaitMs = 120_000;
    const startTime = Date.now();

    async function seed() {
      try {
        await fetch('/api/today/seed', { method: 'POST' });
      } catch {
        // Seed failed silently, will still poll
      }
      setStatus('polling');

      // Start polling
      pollInterval = setInterval(async () => {
        try {
          const res = await fetch('/api/today');
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            clearInterval(pollInterval);
            clearInterval(tickInterval);
            onItemsReady();
          }
        } catch {
          // Continue polling
        }

        if (Date.now() - startTime > maxWaitMs) {
          clearInterval(pollInterval);
          clearInterval(tickInterval);
          setStatus('timeout');
        }
      }, 5000);
    }

    // Elapsed counter for progress bar
    tickInterval = setInterval(() => {
      const sec = Math.floor((Date.now() - startTime) / 1000);
      setElapsed(Math.min(sec, 120));
    }, 1000);

    seed();

    return () => {
      clearInterval(pollInterval);
      clearInterval(tickInterval);
    };
  }, [onItemsReady]);

  const progress = Math.min((elapsed / 120) * 100, 100);

  if (status === 'timeout') {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
        <div className="w-16 h-16 rounded-full bg-sf-bg-secondary flex items-center justify-center mb-6">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-sf-text-tertiary"
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>

        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
          No tasks yet
        </h2>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-4 text-center max-w-sm leading-[1.47]">
          Your marketing team is still warming up. This usually takes a few minutes on your first day.
        </p>
        <Link
          href="/calendar"
          className="text-[14px] tracking-[-0.224px] font-medium text-sf-accent hover:text-sf-accent/80 transition-colors duration-200"
        >
          Open Calendar
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 animate-sf-fade-in">
      <div
        className="w-full max-w-md rounded-[var(--radius-sf-lg)] p-8 text-center"
        style={{ backgroundColor: '#f0f5ff' }}
      >
        {/* Animated icon */}
        <div className="w-14 h-14 rounded-full bg-sf-accent/10 flex items-center justify-center mx-auto mb-6">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-sf-accent animate-pulse"
          >
            <path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m11.314 11.314l.707.707" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </div>

        <h2 className="text-[21px] font-bold tracking-[-0.12px] text-sf-text-primary mb-2">
          Your marketing team is getting ready...
        </h2>
        <p className="text-[14px] tracking-[-0.224px] text-sf-text-secondary mb-6 leading-[1.47]">
          {status === 'seeding'
            ? 'Setting up your first batch of tasks.'
            : 'Scanning for opportunities and generating your daily todo list.'}
        </p>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-sf-bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-sf-accent rounded-full transition-all duration-1000 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}
