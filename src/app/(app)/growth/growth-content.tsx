'use client';

/**
 * Growth — v3.
 *
 * Centerpiece is the HealthMeter dial reading from /api/health (real data).
 * The lower sections (Communities, Keyword Triggers, ICP profiles) don't
 * have backing endpoints yet — Scout's calibration pipeline is the intended
 * feed but it isn't populating these shapes. Rather than ship fake fixtures
 * that look live, we render honest empty states that explain what will land
 * there when Scout starts emitting the data. Wire the real feeds under
 * /api/growth/{communities,keywords,icps} when the calibration output
 * stabilises — TODOS.md Phase 2 "Adaptive Health Score Engagement Baseline".
 */

import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { SectionBar } from '@/components/ui/section-bar';
import { HealthMeter } from '@/components/ui/health-meter';

interface HealthPayload {
  healthScore: {
    score: number;
    s1Pipeline: number | null;
    s2Quality: number | null;
    s3Engagement: number | null;
    s4Consistency: number | null;
    s5Safety: number | null;
    createdAt: string;
  } | null;
}

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed');
  return res.json();
};

export function GrowthContent() {
  const { data } = useSWR<HealthPayload>('/api/health', fetcher, {
    revalidateOnFocus: false,
  });
  const score = data?.healthScore?.score ?? null;

  return (
    <>
      <HeaderBar
        title="Growth"
        meta={
          score == null
            ? 'Where your AI team is listening. Calibration runs populate the health score after Scout completes its first pass.'
            : `Health ${score}/100 · Where your AI team is listening.`
        }
        action={<Button size="sm" disabled>+ Add community</Button>}
      />

      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        {/* Health centerpiece */}
        <Card padding={28}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 32,
              alignItems: 'center',
            }}
          >
            <HealthMeter value={score ?? 0} variant="dial" size={148} />
            <div>
              <Ops style={{ display: 'block', marginBottom: 8 }}>Signal strength</Ops>
              <h2
                className="sf-h3"
                style={{ margin: 0, color: 'var(--sf-fg-1)', marginBottom: 6 }}
              >
                {score == null ? 'No signal yet' : scoreHeadline(score)}
              </h2>
              <p
                style={{
                  margin: 0,
                  fontSize: 'var(--sf-text-sm)',
                  color: 'var(--sf-fg-3)',
                  maxWidth: 520,
                  lineHeight: 'var(--sf-lh-normal)',
                }}
              >
                {score == null
                  ? 'Your health score appears after Scout runs its first calibration pass. Connect a channel on the Settings page and generate a plan to kick it off.'
                  : scoreDescription(score)}
              </p>
              {data?.healthScore && (
                <div
                  style={{
                    marginTop: 14,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: 12,
                  }}
                >
                  <SubScore label="Pipeline" value={data.healthScore.s1Pipeline} />
                  <SubScore label="Quality" value={data.healthScore.s2Quality} />
                  <SubScore label="Engagement" value={data.healthScore.s3Engagement} />
                  <SubScore label="Consistency" value={data.healthScore.s4Consistency} />
                  <SubScore label="Safety" value={data.healthScore.s5Safety} />
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Communities empty state */}
        <SectionBar>Where we&rsquo;re listening</SectionBar>
        <EmptyState
          eyebrow="Scout is calibrating"
          title="No communities tracked yet"
          body="Once Scout finishes its first calibration pass, the communities it's watching on your behalf show up here with fit scores and last-hit timestamps."
        />

        {/* Keywords + ICP empty states side by side */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 16,
            marginTop: 16,
          }}
        >
          <div>
            <SectionBar>Keyword triggers</SectionBar>
            <EmptyState
              eyebrow="Awaiting calibration"
              title="No triggers yet"
              body="High-intent queries the Analyst surfaces from your plan will appear here as Scout sees them fire."
            />
          </div>

          <div>
            <SectionBar>Who we&rsquo;re writing to</SectionBar>
            <EmptyState
              eyebrow="Awaiting plan signal"
              title="No ICP profiles yet"
              body="ICP cards are derived from your strategic path's target-audience hints. They populate after your first plan runs."
            />
          </div>
        </div>
      </div>
    </>
  );
}

interface EmptyStateProps {
  eyebrow: string;
  title: string;
  body: string;
}

function EmptyState({ eyebrow, title, body }: EmptyStateProps) {
  return (
    <Card padding={24}>
      <div style={{ textAlign: 'left' }}>
        <Ops style={{ display: 'block', marginBottom: 8 }}>{eyebrow}</Ops>
        <div
          style={{
            fontSize: 'var(--sf-text-base)',
            fontWeight: 600,
            color: 'var(--sf-fg-1)',
            marginBottom: 6,
          }}
        >
          {title}
        </div>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--sf-text-sm)',
            color: 'var(--sf-fg-3)',
            lineHeight: 'var(--sf-lh-normal)',
            maxWidth: 560,
          }}
        >
          {body}
        </p>
      </div>
    </Card>
  );
}

function SubScore({ label, value }: { label: string; value: number | null }) {
  const display = value == null ? '—' : Math.round(value * 100);
  return (
    <div>
      <Ops style={{ display: 'block' }}>{label}</Ops>
      <div
        className="sf-mono"
        style={{
          fontSize: 'var(--sf-text-lg)',
          color: 'var(--sf-fg-1)',
          fontWeight: 500,
          marginTop: 2,
        }}
      >
        {display}
      </div>
    </div>
  );
}

function scoreHeadline(score: number): string {
  if (score >= 85) return 'Firing on all cylinders';
  if (score >= 70) return 'Healthy signal across channels';
  if (score >= 50) return 'Some slack — room to improve';
  return 'Needs attention';
}

function scoreDescription(score: number): string {
  if (score >= 85) {
    return 'High-intent threads are landing, drafts are passing gates, and your cadence is steady. Keep the current mix.';
  }
  if (score >= 70) {
    return 'Your team is finding relevant threads and shipping replies on time. A few communities are underperforming — consider tuning fit thresholds.';
  }
  if (score >= 50) {
    return 'Signal is present but noisy. Tighten keyword intent, drop low-fit communities, or tighten your approval threshold.';
  }
  return 'Either not enough discovery volume or gate pass rate has dropped. Broaden your keyword watchlist or revisit your community list.';
}
