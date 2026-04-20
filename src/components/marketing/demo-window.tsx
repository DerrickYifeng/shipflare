'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Ops } from '@/components/ui/ops';
import { StatusDot } from '@/components/ui/status-dot';
import { ThoughtStream, type ThoughtStep } from '@/components/ui/thought-stream';

/**
 * Auto-playing hero demo window. Types a URL, narrates agent thinking via
 * ThoughtStream, then reveals discovered threads with staggered entrance.
 * Timings copied verbatim from source/landing/hero_demo.jsx — do not re-tune.
 */

const DEMO_URL = 'linear.app';

interface DemoStep extends ThoughtStep {
  ms: number;
}

const DEMO_STEPS: DemoStep[] = [
  {
    label: 'Reading page',
    detail: 'linear.app · issue tracking for software teams',
    ms: 900,
  },
  {
    label: 'Inferring ICP',
    detail: 'engineering leads · IC-first tooling · Jira migration',
    ms: 1100,
  },
  {
    label: 'Querying sources',
    detail: 'reddit · x · hn · ~40 candidate threads',
    ms: 1100,
  },
  {
    label: 'Ranking by intent',
    detail: 'asking > venting > discussion · recency weighted',
    ms: 900,
  },
  {
    label: 'Adversarial review',
    detail: '3 drafts failed tone check · 2 revised · 5 approved',
    ms: 1200,
  },
];

interface DemoThread {
  source: 'reddit' | 'x';
  community: string;
  score: number;
  when: string;
  title: string;
}

const DEMO_THREADS: DemoThread[] = [
  {
    source: 'reddit',
    community: 'r/startups',
    score: 92,
    when: '12m',
    title: 'What are you using for issue tracking? Jira is getting unbearable.',
  },
  {
    source: 'x',
    community: '@founders',
    score: 88,
    when: '34m',
    title: 'Anyone moved off Jira recently? My eng team is at breaking point.',
  },
  {
    source: 'reddit',
    community: 'r/ExperiencedDevs',
    score: 81,
    when: '1h',
    title: 'Hot take: modern PM tools over-engineer for PMs and ignore ICs',
  },
];

type Phase = 'typing' | 'thinking' | 'results';

export function DemoWindow() {
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState<Phase>('typing');
  const [typed, setTyped] = useState('');
  const [stepIdx, setStepIdx] = useState(-1);
  const [threadIdx, setThreadIdx] = useState(-1);

  // React's "reset state on prop change" pattern:
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  // Resetting during render (when `cycle` changes) commits the reset in the
  // SAME paint as the cycle bump — no 1-tick flash of the previous cycle's
  // final state, and no `setState-in-effect` lint violation. Mirrors the
  // synchronous reset at source/landing/hero_demo.jsx:86.
  const [prevCycle, setPrevCycle] = useState(cycle);
  if (prevCycle !== cycle) {
    setPrevCycle(cycle);
    setTyped('');
    setStepIdx(-1);
    setThreadIdx(-1);
    setPhase('typing');
  }

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    DEMO_URL.split('').forEach((_, i) => {
      timers.push(
        setTimeout(() => setTyped(DEMO_URL.slice(0, i + 1)), 80 * (i + 1)),
      );
    });
    const afterType = 80 * DEMO_URL.length + 400;

    timers.push(setTimeout(() => setPhase('thinking'), afterType));
    let t = afterType + 200;
    DEMO_STEPS.forEach((s, i) => {
      timers.push(setTimeout(() => setStepIdx(i), t));
      t += s.ms;
    });

    timers.push(setTimeout(() => setPhase('results'), t));
    DEMO_THREADS.forEach((_, i) => {
      timers.push(setTimeout(() => setThreadIdx(i), t + 300 + i * 450));
    });
    const afterResults = t + 300 + DEMO_THREADS.length * 450 + 2400;
    timers.push(setTimeout(() => setCycle((c) => c + 1), afterResults));

    return () => timers.forEach(clearTimeout);
  }, [cycle]);

  const chromeStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid var(--sf-border-on-dark)',
    background: 'oklch(22% 0.012 260)',
  };

  const inputRowStyle: CSSProperties = {
    padding: '18px 20px',
    borderBottom: '1px solid var(--sf-border-on-dark)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  };

  const urlFieldStyle: CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    background: 'oklch(16% 0.012 260)',
    border: '1px solid var(--sf-border-on-dark)',
    borderRadius: 'var(--sf-radius-md)',
    padding: '10px 14px',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 'var(--sf-text-sm)',
    color: 'var(--sf-fg-on-dark-1)',
  };

  return (
    <div
      style={{
        borderRadius: 'var(--sf-radius-lg)',
        overflow: 'hidden',
        background: 'var(--sf-ink-raised)',
        border: '1px solid var(--sf-border-on-dark)',
        boxShadow: 'var(--sf-shadow-lg)',
        maxWidth: 640,
        margin: '0 auto',
        width: '100%',
      }}
    >
      {/* Chrome */}
      <div style={chromeStyle}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--sf-danger)' }} />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--sf-warning)' }} />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--sf-success)' }} />
        <Ops tone="onDark" style={{ marginLeft: 16, color: 'var(--sf-fg-on-dark-4)' }}>
          shipflare · scan · live
        </Ops>
        <span className="inline-flex items-center gap-[6px]" style={{ marginLeft: 'auto' }}>
          <StatusDot state="success" size={6} />
          <Ops tone="onDark">agent live</Ops>
        </span>
      </div>

      {/* Input */}
      <div style={inputRowStyle}>
        <div style={urlFieldStyle}>
          <span style={{ color: 'var(--sf-fg-on-dark-4)', marginRight: 6 }}>https://</span>
          <span>{typed}</span>
          {phase === 'typing' && (
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 1.5,
                height: 14,
                background: 'var(--sf-fg-on-dark-1)',
                marginLeft: 2,
                animation: 'sfCaret 1s step-end infinite',
              }}
            />
          )}
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          style={{
            minHeight: 40,
            padding: '0 18px',
            borderRadius: 'var(--sf-radius-md)',
            border: 'none',
            background: phase === 'typing' ? 'var(--sf-ink)' : 'var(--sf-signal)',
            color: 'var(--sf-fg-on-dark-1)',
            fontSize: 'var(--sf-text-sm)',
            letterSpacing: 'var(--sf-track-normal)',
            fontFamily: 'inherit',
            fontWeight: 500,
            opacity: phase === 'typing' ? 0.5 : 1,
            transition: 'background var(--sf-dur-base) var(--sf-ease-swift), opacity var(--sf-dur-base) var(--sf-ease-swift)',
            cursor: 'default',
          }}
        >
          {phase === 'thinking' ? 'Scanning…' : phase === 'results' ? 'Done' : 'Scan'}
        </button>
      </div>

      {/* Body */}
      <div style={{ minHeight: 320, padding: '20px 22px', position: 'relative' }}>
        {phase !== 'results' ? (
          <ThoughtStream steps={DEMO_STEPS} activeIdx={stepIdx} onDark header="Thinking…" />
        ) : (
          <ResultsList threadIdx={threadIdx} />
        )}
      </div>

      <style>{`@keyframes sfCaret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }`}</style>
    </div>
  );
}

interface ResultsListProps {
  threadIdx: number;
}

function ResultsList({ threadIdx }: ResultsListProps) {
  return (
    <div>
      <div className="flex items-center gap-[8px]" style={{ marginBottom: 12 }}>
        <Ops tone="onDark">Discovered</Ops>
        <Ops tone="onDark">·</Ops>
        <Ops tone="success">
          {Math.max(0, threadIdx + 1)}/{DEMO_THREADS.length}
        </Ops>
      </div>
      <div className="flex flex-col" style={{ gap: 10 }}>
        {DEMO_THREADS.map((t, i) => {
          const hidden = i > threadIdx;
          return (
            <div
              key={t.title}
              style={{
                opacity: hidden ? 0 : 1,
                transform: hidden ? 'translateY(8px)' : 'translateY(0)',
                transition: 'opacity 400ms var(--sf-ease-swift), transform 400ms var(--sf-ease-swift)',
                background: 'oklch(16% 0.012 260)',
                border: '1px solid var(--sf-border-on-dark)',
                borderRadius: 'var(--sf-radius-md)',
                padding: '12px 14px',
                willChange: 'transform, opacity',
              }}
            >
              <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 6 }}>
                <Ops tone="onDark">{t.source === 'x' ? '𝕏' : t.source}</Ops>
                <span
                  style={{
                    padding: '1px 7px',
                    borderRadius: 'var(--sf-radius-sm)',
                    fontSize: 'var(--sf-text-xs)',
                    fontWeight: 500,
                    background: 'var(--sf-signal-tint)',
                    color: 'var(--sf-signal-ink)',
                  }}
                >
                  {t.community}
                </span>
                <span
                  className="sf-mono"
                  style={{
                    padding: '1px 7px',
                    borderRadius: 'var(--sf-radius-sm)',
                    fontSize: 'var(--sf-text-xs)',
                    fontWeight: 500,
                    background:
                      t.score >= 85 ? 'var(--sf-success-tint)' : 'var(--sf-paper-sunken)',
                    color: t.score >= 85 ? 'var(--sf-success-ink)' : 'var(--sf-fg-2)',
                  }}
                >
                  {t.score}%
                </span>
                <span
                  className="sf-mono"
                  style={{
                    marginLeft: 'auto',
                    fontSize: 'var(--sf-text-2xs)',
                    color: 'var(--sf-fg-on-dark-4)',
                  }}
                >
                  {t.when}
                </span>
              </div>
              <div
                style={{
                  fontSize: 'var(--sf-text-sm)',
                  color: 'var(--sf-fg-on-dark-1)',
                  letterSpacing: 'var(--sf-track-normal)',
                  lineHeight: 'var(--sf-lh-snug)',
                }}
              >
                {t.title}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
