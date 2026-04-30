import { Ops } from '@/components/ui/ops';

interface PhaseEntry {
  name: string;
  window: string;
  goal: string;
  peak?: boolean;
}

const PHASES: PhaseEntry[] = [
  {
    name: 'FOUNDATION',
    window: 'T-6+ weeks',
    goal: 'De-risk positioning, seed early audience.',
  },
  {
    name: 'AUDIENCE',
    window: 'T-28 to T-8d',
    goal: 'Build a launch-ready audience. Weekly cadence matters most.',
  },
  {
    name: 'MOMENTUM',
    window: 'T-7 to T-1',
    goal: 'Maximize launch-day reach. Tighten every asset. Pre-launch proof.',
  },
  {
    name: 'LAUNCH',
    window: 'T-0',
    goal: 'Execute the runsheet. No new plan items.',
    peak: true,
  },
  {
    name: 'COMPOUND',
    window: 'T+0 to T+30',
    goal: 'Convert launch-day viewers into retention and a second wave.',
  },
  {
    name: 'STEADY',
    window: 'T+30 onward',
    goal: 'Sustained rhythm. No panic moves.',
  },
];

/**
 * Phase section — paper bg, 6-phase horizontal timeline. The CMO Agent
 * adjusts team intensity per phase; the LAUNCH column gets visual peak
 * (larger accent dot) to anchor T-0.
 */
export function PhaseSection() {
  return (
    <section
      id="lifecycle"
      aria-labelledby="lifecycle-heading"
      style={{
        background: 'var(--sf-bg-dark)',
        color: 'var(--sf-fg-on-dark-1)',
        padding: '120px 24px',
      }}
    >
      <div style={{ maxWidth: 'var(--sf-max-width)', margin: '0 auto' }}>
        <div style={{ maxWidth: 680, marginBottom: 56 }}>
          <span
            className="sf-ops"
            style={{
              color: 'var(--sf-link-dark)',
              marginBottom: 12,
              display: 'block',
            }}
          >
            The lifecycle
          </span>
          <h2
            id="lifecycle-heading"
            className="sf-h1"
            style={{
              margin: 0,
              color: 'var(--sf-fg-on-dark-1)',
              textWrap: 'balance',
            }}
          >
            Six phases. Built for product launches.
          </h2>
          <p
            className="sf-lede"
            style={{
              marginTop: 16,
              maxWidth: 640,
              color: 'var(--sf-fg-on-dark-2)',
            }}
          >
            A launch isn&rsquo;t a single event. It&rsquo;s a six-phase lifecycle, and the team&rsquo;s intensity shifts with each. The CMO recognizes which phase you&rsquo;re in and adjusts agent priorities accordingly.
          </p>
        </div>

        <ol
          className="shipflare-phase-grid"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(6, 1fr)',
            gap: 24,
          }}
        >
          {PHASES.map((p) => (
            <li key={p.name}>
              <PhaseColumn phase={p} />
            </li>
          ))}
        </ol>
      </div>

      <style>{`
        @media (max-width: 1023px) {
          .shipflare-phase-grid {
            grid-template-columns: repeat(3, 1fr) !important;
            row-gap: 40px !important;
          }
        }
        @media (max-width: 640px) {
          .shipflare-phase-grid {
            grid-template-columns: 1fr !important;
            row-gap: 32px !important;
          }
        }
      `}</style>
    </section>
  );
}

interface PhaseColumnProps {
  phase: PhaseEntry;
}

function PhaseColumn({ phase }: PhaseColumnProps) {
  const dotSize = phase.peak ? 12 : 8;
  return (
    <div>
      <Ops tone="onDark" style={{ display: 'block', marginBottom: 14 }}>
        {phase.window}
      </Ops>
      <div style={{ marginBottom: 16, height: 12, display: 'flex', alignItems: 'center' }}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: dotSize,
            height: dotSize,
            borderRadius: '50%',
            background: phase.peak ? 'var(--sf-accent)' : 'var(--sf-fg-on-dark-1)',
          }}
        />
      </div>
      <div
        style={{
          fontSize: 'var(--sf-text-base)',
          fontWeight: 700,
          color: 'var(--sf-fg-on-dark-1)',
          letterSpacing: 'var(--sf-track-tight)',
          marginBottom: 6,
        }}
      >
        {phase.name}
      </div>
      <div
        style={{
          fontSize: 'var(--sf-text-sm)',
          color: 'var(--sf-fg-on-dark-2)',
          lineHeight: 'var(--sf-lh-normal)',
        }}
      >
        {phase.goal}
      </div>
    </div>
  );
}
