import { Ops } from '@/components/ui/ops';

interface AgentEntry {
  name: string;
  role: string;
  detail: string;
  live?: boolean;
}

const AGENTS: AgentEntry[] = [
  {
    name: 'CMO',
    role: 'Strategy & coordination',
    detail: 'plans · briefs · approvals · weekly review',
    live: true,
  },
  {
    name: 'SOCIAL',
    role: 'Cadence & community',
    detail: 'x · linkedin · reddit · hn · discord',
    live: true,
  },
  {
    name: 'SEARCH',
    role: 'SEO + GEO unified',
    detail: 'keywords · on-page · llms.txt · citations',
  },
  {
    name: 'PERFORMANCE',
    role: 'Paid media',
    detail: 'meta · google · tiktok · x · reddit ads',
  },
  {
    name: 'CONTENT',
    role: 'Long-form & lifecycle',
    detail: 'blogs · newsletters · changelogs · copy',
  },
  {
    name: 'ANALYTICS',
    role: 'Funnel & attribution',
    detail: 'posthog · stripe · ga4 · experiments',
  },
];

/**
 * The team — paper section, 6-role grid mirroring a real startup marketing org.
 * Cards show role name, one-line job, and the operational surfaces each agent
 * has direct access to.
 */
export function HowItWorks() {
  return (
    <section
      id="how"
      aria-labelledby="how-heading"
      style={{ background: 'var(--sf-bg-primary)', padding: '120px 24px' }}
    >
      <div style={{ maxWidth: 'var(--sf-max-width)', margin: '0 auto' }}>
        <div style={{ maxWidth: 680, marginBottom: 56 }}>
          <Ops tone="signal" style={{ marginBottom: 12, display: 'block' }}>
            The team
          </Ops>
          <h2
            id="how-heading"
            className="sf-h1"
            style={{ margin: 0, color: 'var(--sf-fg-1)', textWrap: 'balance' }}
          >
            Six agents. One marketing org.
          </h2>
          <p className="sf-lede" style={{ marginTop: 16, maxWidth: 560 }}>
            Each agent owns one role with direct operational access to the surfaces of its function. The CMO orchestrates the team and reports up to you.
          </p>
        </div>

        <div
          className="grid"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            background: 'var(--sf-bg-secondary)',
            borderRadius: 'var(--sf-radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--sf-shadow-card)',
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
              aria-label={a.live ? `${a.name} agent — live` : `${a.name} agent — on the roadmap`}
            >
              <div className="flex items-center" style={{ gap: 10, marginBottom: 14 }}>
                <span
                  aria-label={a.live ? 'live' : 'on the roadmap'}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: a.live ? 'var(--sf-success)' : 'var(--sf-fg-4)',
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
          aria-hidden="true"
          className="flex items-center flex-wrap"
          style={{
            marginTop: 20,
            justifyContent: 'flex-end',
            gap: 20,
          }}
        >
          <span className="inline-flex items-center" style={{ gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--sf-success)',
              }}
            />
            <Ops>live</Ops>
          </span>
          <span className="inline-flex items-center" style={{ gap: 6 }}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--sf-fg-4)',
              }}
            />
            <Ops>on the roadmap</Ops>
          </span>
        </div>
      </div>
    </section>
  );
}
