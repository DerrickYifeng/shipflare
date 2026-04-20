import type { CSSProperties } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Ops } from '@/components/ui/ops';
import { StatusDot } from '@/components/ui/status-dot';

interface ReviewCase {
  verdict: 'PASS' | 'REVISE' | 'FAIL';
  tone: string;
  accuracy: '✓' | '×';
  spam: string;
  note: string;
}

const REVIEW_CASES: ReviewCase[] = [
  {
    verdict: 'PASS',
    tone: 'casual',
    accuracy: '✓',
    spam: '0.04',
    note: 'Answers the question, cites docs, no plug until asked.',
  },
  {
    verdict: 'REVISE',
    tone: 'salesy',
    accuracy: '✓',
    spam: '0.31',
    note: 'Rewritten to remove "game-changer" and lead with the user\'s problem.',
  },
  {
    verdict: 'FAIL',
    tone: 'defensive',
    accuracy: '×',
    spam: '0.62',
    note: "Claimed a feature we don't ship. Dropped.",
  },
];

const SAFETY_ITEMS: { title: string; detail: string }[] = [
  {
    title: 'Adversarial review',
    detail:
      'A second model tries to find reasons to reject every draft. Two-agent consensus required to pass.',
  },
  {
    title: 'Rate limits & cooldowns',
    detail: 'Per-subreddit, per-account caps. Never more than 1 reply / thread / day.',
  },
  {
    title: 'Shadowban detection',
    detail:
      'We watch for silent drops and back off automatically. Pipeline pauses, you get notified.',
  },
  {
    title: 'You approve everything',
    detail: 'Nothing posts without an explicit tap. No autopilot "ship all", ever.',
  },
];

const GRID_COLS = '74px 80px 54px 64px 1fr';

function verdictVariant(verdict: ReviewCase['verdict']): BadgeVariant {
  if (verdict === 'PASS') return 'success';
  if (verdict === 'REVISE') return 'warning';
  return 'danger';
}

/**
 * Safety — paper section, two-up: narrative copy + adversarial-review log.
 */
export function SafetySection() {
  return (
    <section
      id="safety"
      aria-labelledby="safety-heading"
      style={{ background: 'var(--sf-paper)', padding: '120px 24px' }}
    >
      <div style={{ maxWidth: 'var(--sf-max-width)', margin: '0 auto' }}>
        <div
          className="grid items-start"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: 56,
          }}
        >
          <div>
            <Ops tone="flare" style={{ marginBottom: 12, display: 'block' }}>
              Safety by default
            </Ops>
            <h2
              id="safety-heading"
              className="sf-h1"
              style={{ margin: 0, color: 'var(--sf-fg-1)', textWrap: 'balance' }}
            >
              Every draft fights for its life before you see it.
            </h2>
            <p className="sf-lede" style={{ marginTop: 16 }}>
              An adversarial review agent grades every draft on tone, factual accuracy, and spam risk. Roughly one in three drafts is revised or dropped before it enters your queue.
            </p>

            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: '36px 0 0',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              {SAFETY_ITEMS.map((item) => (
                <SafetyItem key={item.title} title={item.title} detail={item.detail} />
              ))}
            </ul>
          </div>

          <ReviewLogCard />
        </div>
      </div>
    </section>
  );
}

interface SafetyItemProps {
  title: string;
  detail: string;
}

function SafetyItem({ title, detail }: SafetyItemProps) {
  return (
    <li
      className="items-start"
      style={{
        display: 'grid',
        gridTemplateColumns: '24px 1fr',
        gap: 14,
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center"
        style={{
          marginTop: 4,
          width: 16,
          height: 16,
          borderRadius: 'var(--sf-radius-sm)',
          background: 'var(--sf-success-tint)',
          color: 'var(--sf-success-ink)',
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="1.5,5 4,7.5 8.5,2.5" />
        </svg>
      </span>
      <div>
        <div
          style={{
            fontSize: 'var(--sf-text-base)',
            fontWeight: 600,
            color: 'var(--sf-fg-1)',
            letterSpacing: 'var(--sf-track-tight)',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-2)',
            marginTop: 2,
            lineHeight: 'var(--sf-lh-normal)',
          }}
        >
          {detail}
        </div>
      </div>
    </li>
  );
}

function ReviewLogCard() {
  const cardStyle: CSSProperties = {
    background: 'var(--sf-ink-raised)',
    borderRadius: 'var(--sf-radius-lg)',
    padding: 24,
    boxShadow: 'var(--sf-shadow-lg)',
  };
  return (
    <div style={cardStyle}>
      <div className="flex items-center" style={{ gap: 10, marginBottom: 18 }}>
        <StatusDot state="warning" />
        <span
          className="sf-ops"
          style={{ color: 'var(--sf-fg-on-dark-1)', fontWeight: 600 }}
        >
          REVIEW · adversarial pass
        </span>
        <span
          className="sf-mono"
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--sf-text-2xs)',
            color: 'var(--sf-fg-on-dark-4)',
          }}
        >
          log (31,204)
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLS,
          gap: 12,
          paddingBottom: 10,
          borderBottom: '1px solid var(--sf-border-on-dark)',
        }}
      >
        <Ops tone="onDark">verdict</Ops>
        <Ops tone="onDark">tone</Ops>
        <Ops tone="onDark">acc</Ops>
        <Ops tone="onDark">spam</Ops>
        <Ops tone="onDark">note</Ops>
      </div>

      {REVIEW_CASES.map((c, i) => {
        const last = i === REVIEW_CASES.length - 1;
        return (
          <div
            key={c.verdict + c.tone}
            className="items-start"
            style={{
              display: 'grid',
              gridTemplateColumns: GRID_COLS,
              gap: 12,
              padding: '14px 0',
              borderBottom: last ? 'none' : '1px solid var(--sf-border-on-dark)',
            }}
          >
            <Badge variant={verdictVariant(c.verdict)} mono>
              {c.verdict}
            </Badge>
            <span
              className="sf-mono"
              style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-on-dark-2)' }}
            >
              {c.tone}
            </span>
            <span
              className="sf-mono"
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: c.accuracy === '✓' ? 'var(--sf-success)' : 'var(--sf-danger)',
              }}
            >
              {c.accuracy}
            </span>
            <span
              className="sf-mono"
              style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-on-dark-2)' }}
            >
              {c.spam}
            </span>
            <span
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-on-dark-2)',
                lineHeight: 'var(--sf-lh-normal)',
              }}
            >
              {c.note}
            </span>
          </div>
        );
      })}

      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Ops tone="onDark">showing 3 of 31,204 · live</Ops>
      </div>
    </div>
  );
}
