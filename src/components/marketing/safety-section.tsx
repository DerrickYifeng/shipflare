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
      'A second model grades every artifact on relevance, value-first, tone, authenticity, compliance, and risk. Two-agent consensus to pass.',
  },
  {
    title: 'Conservative rate limits',
    detail: 'Per-account caps for posting, per-domain caps for outreach, per-budget caps for ads. Always well below platform thresholds.',
  },
  {
    title: 'Shadowban detection',
    detail:
      'We watch for silent drops and back off automatically. The agent pauses, you get notified.',
  },
  {
    title: 'Human approval, by default',
    detail: 'Outbound, outreach, paid spend, public content — all gated by an explicit tap from you. No "ship all" autopilot.',
  },
];

const GRID_COLS = '74px 80px 54px 64px 1fr';

function verdictVariant(verdict: ReviewCase['verdict']): BadgeVariant {
  if (verdict === 'PASS') return 'success';
  if (verdict === 'REVISE') return 'warning';
  return 'error';
}

/**
 * Safety — paper section, two-up: narrative copy + adversarial-review log.
 */
export function SafetySection() {
  return (
    <section
      id="safety"
      aria-labelledby="safety-heading"
      style={{
        background: 'var(--sf-bg-primary)',
        color: 'var(--sf-fg-1)',
        padding: '120px 24px',
      }}
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
            <span
              className="sf-ops"
              style={{
                color: 'var(--sf-link)',
                marginBottom: 12,
                display: 'block',
              }}
            >
              The authenticity question
            </span>
            <h2
              id="safety-heading"
              className="sf-h1"
              style={{
                margin: 0,
                color: 'var(--sf-fg-1)',
                textWrap: 'balance',
              }}
            >
              Real accounts. Adversarial review. You approve every artifact.
            </h2>
            <p
              className="sf-lede"
              style={{ marginTop: 16, color: 'var(--sf-fg-2)' }}
            >
              Spam networks create fake accounts to deceive at scale. ShipFlare operates your real accounts under your real identity. Every agent&rsquo;s output is graded by a second model and gated by your approval before anything ships.
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
          background: 'var(--sf-success-light)',
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
    background: 'var(--sf-bg-secondary)',
    borderRadius: 'var(--sf-radius-lg)',
    padding: 24,
    boxShadow: 'var(--sf-shadow-card)',
  };
  return (
    <div style={cardStyle}>
      <div className="flex items-center" style={{ gap: 10, marginBottom: 18 }}>
        <StatusDot state="warning" />
        <span
          className="sf-ops"
          style={{ color: 'var(--sf-fg-1)', fontWeight: 600 }}
        >
          REVIEW · adversarial pass
        </span>
        <span
          className="sf-mono"
          style={{
            marginLeft: 'auto',
            fontSize: 'var(--sf-text-2xs)',
            color: 'var(--sf-fg-4)',
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
          borderBottom: '1px solid var(--sf-border)',
        }}
      >
        <Ops>verdict</Ops>
        <Ops>tone</Ops>
        <Ops>acc</Ops>
        <Ops>spam</Ops>
        <Ops>note</Ops>
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
              borderBottom: last ? 'none' : '1px solid var(--sf-border)',
            }}
          >
            <Badge variant={verdictVariant(c.verdict)} mono>
              {c.verdict}
            </Badge>
            <span
              className="sf-mono"
              style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-2)' }}
            >
              {c.tone}
            </span>
            <span
              className="sf-mono"
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: c.accuracy === '✓' ? 'var(--sf-success-ink)' : 'var(--sf-error-ink)',
              }}
            >
              {c.accuracy}
            </span>
            <span
              className="sf-mono"
              style={{ fontSize: 'var(--sf-text-sm)', color: 'var(--sf-fg-2)' }}
            >
              {c.spam}
            </span>
            <span
              style={{
                fontSize: 'var(--sf-text-sm)',
                color: 'var(--sf-fg-2)',
                lineHeight: 'var(--sf-lh-normal)',
              }}
            >
              {c.note}
            </span>
          </div>
        );
      })}

      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Ops>showing 3 of 31,204 · live</Ops>
      </div>
    </div>
  );
}
