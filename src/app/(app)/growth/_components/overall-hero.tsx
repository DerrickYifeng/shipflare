import { Card } from '@/components/ui/card';
import { Ops } from '@/components/ui/ops';
import { HealthMeter } from '@/components/ui/health-meter';
import { ModuleStrip, type ModuleSummary } from './module-strip';

interface OverallHeroProps {
  overallScore: number | null;
  modules: ModuleSummary[];
}

export function OverallHero({ overallScore, modules }: OverallHeroProps) {
  return (
    <Card padding={28}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '180px 1fr',
          gap: 32,
          alignItems: 'center',
        }}
      >
        <div>
          <HealthMeter value={overallScore ?? 0} variant="dial" size={132} />
          <Ops style={{ display: 'block', textAlign: 'center', marginTop: 12 }}>
            ShipFlare health
          </Ops>
        </div>
        <div>
          <Ops>This week</Ops>
          <h2
            className="sf-h3"
            style={{
              margin: '6px 0 6px',
              color: 'var(--sf-fg-1)',
            }}
          >
            {overallScore == null
              ? 'Awaiting first rollup'
              : 'Your team is shipping on social'}
          </h2>
          <p
            style={{
              margin: '0 0 18px',
              fontSize: 'var(--sf-text-sm)',
              color: 'var(--sf-fg-3)',
              lineHeight: 'var(--sf-lh-normal)',
              maxWidth: 480,
            }}
          >
            {overallScore == null
              ? "Your team hasn't started shipping yet — first rollup runs after kickoff completes."
              : 'Social marketing is live and active. Other modules unlock as we ship them.'}
          </p>
          <ModuleStrip modules={modules} />
        </div>
      </div>
    </Card>
  );
}
