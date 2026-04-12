'use client';

import { useEffect, useRef, useState } from 'react';

interface ThoughtLine {
  id: string;
  text: string;
  indent?: boolean;
  highlight?: boolean;
  status?: 'active' | 'done';
}

interface ThoughtStreamProps {
  url: string;
  onComplete: (data: {
    product: { name: string; description: string; url: string };
    results: Array<{
      source: string;
      externalId: string;
      title: string;
      url: string;
      subreddit: string;
      upvotes: number;
      commentCount: number;
      relevanceScore: number;
      scores?: {
        relevance: number;
        intent: number;
        exposure: number;
        freshness: number;
        engagement: number;
      };
      postedAt: string;
    }>;
  }) => void;
  onError: (message: string) => void;
}

export function ThoughtStream({ url, onComplete, onError }: ThoughtStreamProps) {
  const [lines, setLines] = useState<ThoughtLine[]>([]);
  const [typedText, setTypedText] = useState('');
  const [isTyping, setIsTyping] = useState(true);
  const [fading, setFading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Typewriter effect for the first line
  const analyzeText = `analyzing ${new URL(url).hostname.replace(/^www\./, '')}...`;

  useEffect(() => {
    if (prefersReducedMotion) {
      setTypedText(analyzeText);
      setIsTyping(false);
      return;
    }

    let i = 0;
    const interval = setInterval(() => {
      i++;
      setTypedText(analyzeText.slice(0, i));
      if (i >= analyzeText.length) {
        clearInterval(interval);
        setIsTyping(false);
      }
    }, 30);

    return () => clearInterval(interval);
  }, [analyzeText, prefersReducedMotion]);

  // SSE connection
  useEffect(() => {
    const controller = new AbortController();

    async function connect() {
      try {
        const res = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const err = await res.json();
          onError(err.error ?? 'Scan failed');
          return;
        }

        const reader = res.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            const eventMatch = part.match(/^event: (.+)$/m);
            const dataMatch = part.match(/^data: (.+)$/m);
            if (!eventMatch || !dataMatch) continue;

            const eventType = eventMatch[1];
            const data = JSON.parse(dataMatch[1]);

            handleEvent(eventType, data);
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          onError((err as Error).message ?? 'Connection failed');
        }
      }
    }

    connect();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  function handleEvent(eventType: string, data: Record<string, unknown>) {
    switch (eventType) {
      case 'scrape_done': {
        const keywords = (data.keywords as string[]) ?? [];
        // Mark analyzing line as done
        setLines((prev) => [
          ...prev,
          {
            id: 'scrape-done',
            text: `\u2192 ${keywords.length > 0 ? keywords.slice(0, 5).join(' \u00b7 ') : (data.productName as string)}`,
            highlight: true,
            status: 'done',
          },
          {
            id: 'searching',
            text: 'searching for conversations...',
            status: 'active',
          },
        ]);
        break;
      }

      case 'tool_call_start': {
        const query = data.query as string;
        setLines((prev) => [
          ...prev,
          {
            id: `search-${Date.now()}`,
            text: `"${query}"`,
            indent: true,
            highlight: true,
            status: 'active',
          },
        ]);
        break;
      }

      case 'tool_call_done': {
        // Mark the most recent active indented line as done
        setLines((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].indent && updated[i].status === 'active') {
              updated[i] = { ...updated[i], status: 'done' };
              break;
            }
          }
          return updated;
        });
        break;
      }

      case 'scoring': {
        // Mark searching line as done, add scoring line
        setLines((prev) => {
          const updated = prev.map((l) =>
            l.id === 'searching' ? { ...l, status: 'done' as const } : l,
          );
          return [
            ...updated,
            { id: 'scoring', text: 'scoring relevance...', status: 'active' as const },
          ];
        });
        break;
      }

      case 'complete': {
        // Mark scoring done, add organizing step
        setLines((prev) =>
          prev.map((l) =>
            l.id === 'scoring' ? { ...l, status: 'done' as const } : l,
          ),
        );

        const resultCount = (data as { results?: unknown[] }).results?.length ?? 0;

        // Brief pause, then show organizing step
        setTimeout(() => {
          setLines((prev) => [
            ...prev,
            {
              id: 'organizing',
              text: `organizing ${resultCount} results...`,
              status: 'active' as const,
            },
          ]);

          // Let organizing breathe for ~1.2s, then mark done and fade
          setTimeout(() => {
            setLines((prev) =>
              prev.map((l) =>
                l.id === 'organizing' ? { ...l, status: 'done' as const } : l,
              ),
            );

            setTimeout(() => {
              setFading(true);
              setTimeout(() => {
                onComplete(data as Parameters<ThoughtStreamProps['onComplete']>[0]);
              }, 200);
            }, 300);
          }, 1200);
        }, 400);
        break;
      }

      case 'error': {
        onError((data.error as string) ?? 'Scan failed');
        break;
      }
    }
  }

  // Auto-scroll to bottom
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, typedText]);

  return (
    <div
      ref={containerRef}
      className={`
        rounded-[var(--radius-sf-lg)] border border-sf-border
        bg-sf-bg-secondary px-5 py-4 min-h-[120px]
        font-mono text-[13px] leading-relaxed
        overflow-hidden transition-opacity duration-200
        ${fading ? 'opacity-0' : 'opacity-100'}
      `}
    >
      {/* First line: typewriter */}
      <div className="flex items-center justify-between">
        <span className="text-sf-text-tertiary">
          {typedText}
          {isTyping && <span className="animate-pulse">|</span>}
        </span>
        {!isTyping && lines.length > 0 && (
          <StatusIcon status="done" />
        )}
      </div>

      {/* Streamed lines */}
      {lines.map((line) => (
        <div
          key={line.id}
          className={`
            flex items-center justify-between
            ${line.indent ? 'pl-4' : ''}
            animate-thought-line
          `}
        >
          <span
            className={
              line.highlight
                ? 'text-sf-accent'
                : 'text-sf-text-tertiary'
            }
          >
            {line.text}
          </span>
          {line.status && <StatusIcon status={line.status} />}
        </div>
      ))}
    </div>
  );
}

function StatusIcon({ status }: { status: 'active' | 'done' }) {
  if (status === 'done') {
    return (
      <span className="text-sf-success text-[11px] shrink-0 ml-3">{'\u2713'}</span>
    );
  }
  return (
    <span className="text-sf-accent text-[11px] shrink-0 ml-3 animate-pulse">
      {'\u25cf'}
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return reduced;
}
