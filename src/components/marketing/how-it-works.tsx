import { Ops } from '@/components/ui/ops';

interface AgentEntry {
  name: string;
  role: string;
  detail: string;
  accent?: 'signal' | 'flare' | 'success';
}

const AGENTS: AgentEntry[] = [
  { name: 'SCOUT', role: 'Reads your product', detail: 'meta · docs · changelog · GitHub' },
  { name: 'DISCOVERY', role: 'Finds conversations', detail: 'reddit · x · hn search + crawl' },
  { name: 'ANALYST', role: 'Scores intent', detail: 'asking · venting · discussing' },
  { name: 'CONTENT', role: 'Drafts replies', detail: 'in your voice · with citations' },
  { name: 'REVIEW', role: 'Adversarial pass', detail: 'tone · accuracy · spam risk', accent: 'flare' },
  { name: 'POSTING', role: 'You approve, we post', detail: 'rate-limited · shadowban aware', accent: 'success' },
];

function dotColor(accent?: AgentEntry['accent']): string {
  if (accent === 'flare') return 'var(--sf-flare)';
  if (accent === 'success') return 'var(--sf-success)';
  return 'var(--sf-signal)';
}

/**
 * How it works — paper section, 6-agent grid + bottom Metric row.
 * Uses `.app-dark` inheritance, so this re-themes automatically if a
 * parent flips dark (marketing page sits on an `.app-dark` root).
 */
export function HowItWorks() {
  return (
    <section
      id="how"
      aria-labelledby="how-heading"
      style={{ background: 'var(--sf-paper)', padding: '120px 24px' }}
    >
      <div style={{ maxWidth: 'var(--sf-max-width)', margin: '0 auto' }}>
        <div style={{ maxWidth: 680, marginBottom: 56 }}>
          <Ops tone="signal" style={{ marginBottom: 12, display: 'block' }}>
            How it works
          </Ops>
          <h2
            id="how-heading"
            className="sf-h1"
            style={{ margin: 0, color: 'var(--sf-fg-1)', textWrap: 'balance' }}
          >
            Six agents. One pipeline. Runs while you sleep.
          </h2>
          <p className="sf-lede" style={{ marginTop: 16, maxWidth: 560 }}>
            Each agent has one job and hands off to the next. Every draft is reviewed by an adversarial pass before it ever hits your queue.
          </p>
        </div>

        <div
          className="grid"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            background: 'var(--sf-paper-raised)',
            borderRadius: 'var(--sf-radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--sf-shadow-sm)',
          }}
        >
          {AGENTS.map((a, i) => (
            <div
              key={a.name}
              style={{
                padding: '28px 24px',
                borderRight: '1px solid var(--sf-border-subtle)',
                borderBottom: '1px solid var(--sf-border-subtle)',
                position: 'relative',
              }}
            >
              <div className="flex items-center" style={{ gap: 10, marginBottom: 14 }}>
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor(a.accent),
                  }}
                />
                <span
                  className="sf-ops"
                  style={{ color: 'var(--sf-fg-1)', fontWeight: 600 }}
                >
                  {String(i + 1).padStart(2, '0')} · {a.name}
                </span>
              </div>
              <div
                style={{
                  fontSize: 'var(--sf-text-base)',
                  fontWeight: 600,
                  color: 'var(--sf-fg-1)',
                  letterSpacing: 'var(--sf-track-tight)',
                  marginBottom: 6,
                }}
              >
                {a.role}
              </div>
              <div
                className="sf-mono"
                style={{
                  fontSize: 'var(--sf-text-xs)',
                  color: 'var(--sf-fg-3)',
                  letterSpacing: 'var(--sf-track-mono)',
                  lineHeight: 'var(--sf-lh-normal)',
                }}
              >
                {a.detail}
              </div>
            </div>
          ))}
        </div>

        <div
          className="flex items-center justify-center flex-wrap"
          style={{ marginTop: 40, gap: 28 }}
        >
          <Metric label="avg time to first draft" value="8.4s" />
          <Divider />
          <Metric label="drafts rejected by review" value="31%" />
          <Divider />
          <Metric label="replies you approve" value="< 10s each" />
        </div>
      </div>
    </section>
  );
}

interface MetricProps {
  label: string;
  value: string;
}

function Metric({ label, value }: MetricProps) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="sf-h2" style={{ color: 'var(--sf-fg-1)' }}>
        {value}
      </div>
      <Ops style={{ marginTop: 4, display: 'block' }}>{label}</Ops>
    </div>
  );
}

function Divider() {
  return (
    <span
      aria-hidden="true"
      style={{ width: 1, height: 28, background: 'var(--sf-border)' }}
    />
  );
}
