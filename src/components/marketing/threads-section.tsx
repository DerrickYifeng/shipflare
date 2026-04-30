import type { CSSProperties } from 'react';
import { Ops } from '@/components/ui/ops';

interface RealThread {
  source: 'reddit' | 'x';
  community: string;
  when: string;
  score: number;
  title: string;
  reply: string;
  meta: string;
}

const REAL_THREADS: RealThread[] = [
  {
    source: 'reddit',
    community: 'r/indiehackers',
    when: '2h ago',
    score: 94,
    title: 'How are solo founders doing marketing in 2026 without burning out?',
    reply:
      'We replaced weekly cold outreach with one agent that posts 3-4 contextual replies a day. Seven months in, 40% of signups cite a Reddit thread.',
    meta: '142 upvotes · 38 comments',
  },
  {
    source: 'x',
    community: '@devtools',
    when: '5h ago',
    score: 89,
    title: 'what do people use to find where to talk about their product?',
    reply:
      'Built ShipFlare for this exact problem — searches r/, x, hn for high-intent threads and drafts replies you review before posting. Beta is free.',
    meta: '2.1k views · 24 replies',
  },
  {
    source: 'reddit',
    community: 'r/SaaS',
    when: '1d ago',
    score: 87,
    title: 'Tired of posting into the void on Reddit. Nobody cares about my launch.',
    reply:
      "Launches rarely land. What works is showing up in threads where someone is already asking your problem. That's ~2-5 threads a week for most tools.",
    meta: '318 upvotes · 71 comments',
  },
];

/**
 * Real threads / real replies — dark `--sf-bg-dark` section.
 * Scroll-snap row on narrow viewports; auto-fit grid from md up.
 */
export function ThreadsSection() {
  return (
    <section
      id="threads"
      aria-labelledby="threads-heading"
      style={{
        background: 'var(--sf-bg-primary)',
        color: 'var(--sf-fg-1)',
        padding: '120px 24px',
      }}
    >
      <div style={{ maxWidth: 'var(--sf-max-width)', margin: '0 auto' }}>
        <div style={{ maxWidth: 680, marginBottom: 56 }}>
          <Ops tone="signal" style={{ marginBottom: 12, display: 'block' }}>
            ▸ Social Agent in action
          </Ops>
          <h2
            id="threads-heading"
            className="sf-h1"
            style={{
              margin: 0,
              color: 'var(--sf-fg-1)',
              textWrap: 'balance',
            }}
          >
            The conversations you&rsquo;ve been missing.
          </h2>
          <p
            className="sf-lede"
            style={{
              marginTop: 16,
              maxWidth: 560,
            }}
          >
            A cross-section of threads the Social Agent surfaces for developer-tool products — matched on intent, drafted in voice, reviewed before you see them.
          </p>
        </div>

        <ul
          className="shipflare-threads-row"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
            gap: 20,
          }}
        >
          {REAL_THREADS.map((t) => (
            <li key={t.title}>
              <ThreadCard thread={t} />
            </li>
          ))}
        </ul>

        <div
          className="flex items-center justify-center flex-wrap"
          style={{ marginTop: 48, gap: 20 }}
        >
          <Ops>customer logos coming soon</Ops>
          <Ops>·</Ops>
          <Ops>beta · 40+ indie devs</Ops>
          <Ops>·</Ops>
          <Ops>1,284 threads surfaced this week</Ops>
        </div>
      </div>

      {/* Below the md breakpoint: flatten the grid into a scroll-snap row. */}
      <style>{`
        @media (max-width: 767px) {
          .shipflare-threads-row {
            grid-template-columns: none !important;
            grid-auto-flow: column;
            grid-auto-columns: minmax(300px, 85%);
            overflow-x: auto;
            scroll-snap-type: x mandatory;
            -webkit-overflow-scrolling: touch;
            scroll-padding-left: 24px;
            padding-bottom: 8px;
          }
          .shipflare-threads-row > li { scroll-snap-align: start; }
        }
      `}</style>
    </section>
  );
}

interface ThreadCardProps {
  thread: RealThread;
}

function ThreadCard({ thread }: ThreadCardProps) {
  const cardStyle: CSSProperties = {
    background: 'var(--sf-bg-secondary)',
    borderRadius: 'var(--sf-radius-lg)',
    padding: 22,
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    height: '100%',
    boxShadow: 'var(--sf-shadow-card)',
  };
  return (
    <article style={cardStyle}>
      <div>
        <div className="flex items-center flex-wrap" style={{ gap: 8, marginBottom: 10 }}>
          <Ops>{thread.source === 'x' ? '𝕏' : thread.source}</Ops>
          <span
            style={{
              padding: '2px 7px',
              borderRadius: 'var(--sf-radius-sm)',
              fontSize: 'var(--sf-text-xs)',
              fontWeight: 500,
              background: 'var(--sf-accent-light)',
              color: 'var(--sf-link)',
            }}
          >
            {thread.community}
          </span>
          <span
            className="sf-mono"
            style={{
              padding: '2px 7px',
              borderRadius: 'var(--sf-radius-sm)',
              fontSize: 'var(--sf-text-xs)',
              fontWeight: 500,
              background: 'var(--sf-success-light)',
              color: 'var(--sf-success-ink)',
            }}
          >
            {thread.score}%
          </span>
          <span
            className="sf-mono"
            style={{
              marginLeft: 'auto',
              fontSize: 'var(--sf-text-2xs)',
              color: 'var(--sf-fg-4)',
            }}
          >
            {thread.when}
          </span>
        </div>
        <div
          style={{
            fontSize: 'var(--sf-text-base)',
            fontWeight: 500,
            color: 'var(--sf-fg-1)',
            letterSpacing: 'var(--sf-track-tight)',
            lineHeight: 'var(--sf-lh-snug)',
          }}
        >
          {thread.title}
        </div>
        <div style={{ marginTop: 8 }}>
          <Ops>{thread.meta}</Ops>
        </div>
      </div>

      <div
        style={{
          background: 'var(--sf-accent-light)',
          border: '1px solid oklch(62% 0.19 255 / 0.20)',
          borderRadius: 'var(--sf-radius-md)',
          padding: '14px 16px',
        }}
      >
        <div className="flex items-center" style={{ gap: 8, marginBottom: 8 }}>
          <span
            className="sf-ops"
            style={{ color: 'var(--sf-link)', fontWeight: 600 }}
          >
            draft · content agent
          </span>
          <span
            className="sf-mono"
            style={{
              marginLeft: 'auto',
              fontSize: 'var(--sf-text-2xs)',
              color: 'var(--sf-fg-4)',
            }}
          >
            {thread.reply.length}/280
          </span>
        </div>
        <div
          style={{
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-1)',
            letterSpacing: 'var(--sf-track-normal)',
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          {thread.reply}
        </div>
      </div>
    </article>
  );
}
