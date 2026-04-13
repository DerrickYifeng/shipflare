'use client';

import { useEffect, useRef, useState } from 'react';
import type { LegacyScanResult } from '@/types/discovery';

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
    results: LegacyScanResult[];
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

  // Track per-community state outside React state to avoid stale closures
  const agentState = useRef<Record<string, { queries: number; results: number }>>({});

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
        const productName = data.productName as string;
        const oneLiner = (data.oneLiner as string) ?? '';
        const keywords = (data.keywords as string[]) ?? [];

        const newLines: ThoughtLine[] = [
          {
            id: 'product-name',
            text: `\u2192 ${productName}`,
            highlight: true,
            status: 'done',
          },
        ];

        if (oneLiner) {
          const truncated = oneLiner.length > 80
            ? oneLiner.slice(0, 80).trimEnd() + '...'
            : oneLiner;
          newLines.push({
            id: 'one-liner',
            text: truncated,
            indent: true,
            status: 'done',
          });
        }

        if (keywords.length > 0) {
          newLines.push({
            id: 'keywords',
            text: keywords.slice(0, 6).join(' \u00b7 '),
            indent: true,
            highlight: true,
            status: 'done',
          });
        }

        newLines.push({
          id: 'searching',
          text: 'searching for conversations...',
          status: 'active',
        });

        setLines((prev) => [...prev, ...newLines]);
        break;
      }

      case 'community_discovery_start': {
        setLines((prev) => prev.map((l) =>
          l.id === 'searching'
            ? { ...l, text: 'discovering communities...', status: 'active' as const }
            : l,
        ));
        break;
      }

      case 'community_discovery_done': {
        const communities = (data.communities as Array<{ name: string }>) ?? [];
        const fallback = data.fallback as boolean | undefined;
        setLines((prev) => {
          const updated = prev.map((l) =>
            l.id === 'searching'
              ? { ...l, text: fallback ? 'using default communities' : `found ${communities.length} communities`, status: 'done' as const }
              : l,
          );
          const communityLines: ThoughtLine[] = communities.slice(0, 8).map((c) => ({
            id: `community-${c.name}`,
            text: c.name,
            indent: true,
            highlight: true,
            status: 'done' as const,
          }));
          return [...updated, ...communityLines];
        });
        break;
      }

      case 'discovery_start': {
        const total = data.totalCommunities as number;
        setLines((prev) => [
          ...prev,
          {
            id: 'thread-searching',
            text: `searching ${total} communities for threads...`,
            status: 'active' as const,
          },
        ]);
        break;
      }

      // --- Per-community agent lines (update in place) ---

      case 'tool_call_start': {
        const query = data.query as string;
        const sub = data.community as string;
        if (!sub || !query) break;

        // Init state for this community
        if (!agentState.current[sub]) {
          agentState.current[sub] = { queries: 0, results: 0 };
        }
        agentState.current[sub].queries++;

        const lineId = `agent-${sub}`;

        setLines((prev) => {
          const exists = prev.some((l) => l.id === lineId);
          if (exists) {
            // Update existing line with current query
            return prev.map((l) =>
              l.id === lineId
                ? { ...l, text: `r/${sub} \u2014 "${query}"`, status: 'active' as const }
                : l,
            );
          }
          // Create new line for this community
          return [
            ...prev,
            {
              id: lineId,
              text: `r/${sub} \u2014 "${query}"`,
              indent: true,
              status: 'active' as const,
            },
          ];
        });
        break;
      }

      case 'tool_call_done': {
        const sub = data.community as string;
        const resultCount = data.resultCount as number | undefined;
        if (!sub) break;

        const state = agentState.current[sub];
        if (state && resultCount) {
          state.results += resultCount;
        }

        const lineId = `agent-${sub}`;
        const total = state?.results ?? 0;

        setLines((prev) =>
          prev.map((l) =>
            l.id === lineId
              ? { ...l, text: `r/${sub} \u2014 ${total > 0 ? `${total} found so far...` : 'searching...'}`, status: 'active' as const }
              : l,
          ),
        );
        break;
      }

      case 'scoring': {
        const sub = data.community as string;
        if (sub) {
          // Per-agent scoring — update the community line
          const lineId = `agent-${sub}`;
          const total = agentState.current[sub]?.results ?? 0;
          setLines((prev) =>
            prev.map((l) =>
              l.id === lineId
                ? { ...l, text: `r/${sub} \u2014 scoring ${total} threads...`, status: 'active' as const }
                : l,
            ),
          );
        } else {
          // Global scoring event (fallback)
          setLines((prev) => {
            if (prev.some((l) => l.id === 'scoring')) return prev;
            return [
              ...prev,
              { id: 'scoring', text: 'scoring relevance...', status: 'active' as const },
            ];
          });
        }
        break;
      }

      case 'complete': {
        // Mark all agent lines as done with final thread counts
        setLines((prev) => {
          const updated = prev.map((l) => {
            if (l.id.startsWith('agent-')) {
              const sub = l.id.replace('agent-', '');
              const total = agentState.current[sub]?.results ?? 0;
              return { ...l, text: `r/${sub} \u2014 ${total} threads`, status: 'done' as const };
            }
            if (l.id === 'thread-searching') {
              return { ...l, status: 'done' as const };
            }
            if (l.id === 'scoring') {
              return { ...l, status: 'done' as const };
            }
            return l;
          });
          return updated;
        });

        const resultCount = (data as { results?: unknown[] }).results?.length ?? 0;

        setTimeout(() => {
          setLines((prev) => [
            ...prev,
            {
              id: 'organizing',
              text: `organizing ${resultCount} results...`,
              status: 'active' as const,
            },
          ]);

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

      case 'agent_error': {
        const sub = data.community as string;
        const lineId = `agent-${sub}`;
        setLines((prev) => {
          const exists = prev.some((l) => l.id === lineId);
          if (exists) {
            return prev.map((l) =>
              l.id === lineId
                ? { ...l, text: `r/${sub} \u2014 failed`, status: 'done' as const }
                : l,
            );
          }
          return [
            ...prev,
            { id: lineId, text: `r/${sub} \u2014 failed`, indent: true, status: 'done' as const },
          ];
        });
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
