'use client';

/**
 * Growth — v2 single-route rebuild.
 *
 * Centerpiece: HealthMeter dial reading from /api/health. The rest of the page
 * mirrors the handoff prototype: communities table, keyword triggers, ICP
 * profiles, KPI strip. Data surfaces fall back to representative defaults when
 * the real backend hasn't surfaced the value yet — see TODOS.md Phase 2 item
 * "Adaptive Health Score Engagement Baseline" for the backlog that feeds this.
 */

import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Ops } from '@/components/ui/ops';
import { SectionBar } from '@/components/ui/section-bar';
import { HealthMeter } from '@/components/ui/health-meter';
import { PlatformTag } from '@/components/ui/platform-tag';

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

interface Community {
  platform: 'reddit' | 'x' | 'hn';
  handle: string;
  members: string;
  health: number;
  fit: 'HIGH' | 'MEDIUM' | 'LOW';
  lastHit: string;
}

const COMMUNITIES: Community[] = [
  { platform: 'reddit', handle: 'r/ExperiencedDevs', members: '289k', health: 0.94, fit: 'HIGH', lastHit: '14m' },
  { platform: 'reddit', handle: 'r/SaaS', members: '182k', health: 0.88, fit: 'HIGH', lastHit: '28m' },
  { platform: 'reddit', handle: 'r/startups', members: '1.7M', health: 0.72, fit: 'MEDIUM', lastHit: '8m' },
  { platform: 'reddit', handle: 'r/webdev', members: '2.3M', health: 0.51, fit: 'LOW', lastHit: '2h' },
  { platform: 'x', handle: '@founders', members: '—', health: 0.84, fit: 'HIGH', lastHit: '11m' },
  { platform: 'x', handle: '#buildinpublic', members: '—', health: 0.66, fit: 'MEDIUM', lastHit: '34m' },
  { platform: 'hn', handle: 'Ask HN · who\u2019s hiring', members: '—', health: 0.45, fit: 'LOW', lastHit: '1d' },
];

interface KeywordRow {
  word: string;
  hits: number;
  watchers: string[];
  intent: 'BUYING' | 'RESEARCH' | 'BROWSING';
}

const KEYWORDS: KeywordRow[] = [
  { word: 'jira alternative', hits: 42, watchers: ['Nova'], intent: 'BUYING' },
  { word: 'linear vs', hits: 18, watchers: ['Nova'], intent: 'RESEARCH' },
  { word: 'project management tool', hits: 91, watchers: ['Nova'], intent: 'BROWSING' },
  { word: 'moved off jira', hits: 7, watchers: ['Nova'], intent: 'BUYING' },
];

const ICP_LIST = [
  {
    name: 'Engineering manager',
    weight: 1.0,
    details: '3–50 engineers · frustrated with Jira bloat',
  },
  {
    name: 'Early-stage founder',
    weight: 0.8,
    details: 'Pre-series-B · shipping weekly · small team',
  },
  {
    name: 'Senior IC / tech lead',
    weight: 0.6,
    details: 'Opinions on tooling · influences team adoption',
  },
];

export function GrowthContent() {
  const { data } = useSWR<HealthPayload>('/api/health', fetcher, {
    revalidateOnFocus: false,
  });
  const score = data?.healthScore?.score ?? 72;

  return (
    <>
      <HeaderBar
        title="Growth"
        meta={`Health ${score}/100 · Where your AI team is listening. Tune targeting, watch keywords, prioritize ICP.`}
        action={<Button size="sm">+ Add community</Button>}
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
            <HealthMeter value={score} variant="dial" size={148} />
            <div>
              <Ops style={{ display: 'block', marginBottom: 8 }}>Signal strength</Ops>
              <h2
                className="sf-h3"
                style={{ margin: 0, color: 'var(--sf-fg-1)', marginBottom: 6 }}
              >
                {scoreHeadline(score)}
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
                {scoreDescription(score)}
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

        {/* KPI strip */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 12,
            marginTop: 16,
          }}
        >
          {[
            { val: String(COMMUNITIES.length), label: 'ACTIVE COMMUNITIES' },
            // TODO: wire to real trackedKeywordCount when /api/keywords ships.
            // For now, reflect the visible watchlist length (no magic padding).
            { val: String(KEYWORDS.length), label: 'TRACKED KEYWORDS' },
            { val: '38', label: 'THREADS / DAY AVG' },
            { val: '86%', label: 'GATE PASS RATE' },
          ].map((k) => (
            <Card key={k.label} padding={16}>
              <div
                className="sf-mono"
                style={{
                  fontSize: 'var(--sf-text-h2)',
                  fontWeight: 500,
                  color: 'var(--sf-fg-1)',
                  lineHeight: 1,
                }}
              >
                {k.val}
              </div>
              <Ops style={{ display: 'block', marginTop: 6 }}>{k.label}</Ops>
            </Card>
          ))}
        </div>

        {/* Communities table */}
        <SectionBar count={`${COMMUNITIES.length} sources`}>
          Where we&rsquo;re listening
        </SectionBar>
        <Card padding={0}>
          <div
            className="growth-comm-header"
            style={{
              display: 'grid',
              gridTemplateColumns: '32px minmax(0, 1.6fr) 80px 100px 80px 90px 60px',
              gap: 16,
              alignItems: 'center',
              padding: '10px 18px',
              borderBottom: '1px solid var(--sf-border-subtle)',
              fontFamily: 'var(--sf-font-mono)',
              fontSize: 10,
              letterSpacing: 'var(--sf-track-mono)',
              color: 'var(--sf-fg-3)',
              textTransform: 'uppercase',
            }}
          >
            <span />
            <span>Source</span>
            <span>Members</span>
            <span>Health</span>
            <span>Fit</span>
            <span>Last hit</span>
            <span />
          </div>
          {COMMUNITIES.map((c, i) => (
            <div
              key={c.handle}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px minmax(0, 1.6fr) 80px 100px 80px 90px 60px',
                gap: 16,
                alignItems: 'center',
                padding: '14px 18px',
                borderBottom:
                  i === COMMUNITIES.length - 1
                    ? 'none'
                    : '1px solid var(--sf-border-subtle)',
                fontSize: 'var(--sf-text-sm)',
              }}
            >
              <PlatformTag platform={c.platform} />
              <span style={{ color: 'var(--sf-fg-1)', fontWeight: 500 }}>{c.handle}</span>
              <span className="sf-mono" style={{ color: 'var(--sf-fg-2)' }}>
                {c.members}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <HealthMeter value={c.health} />
                <span className="sf-mono" style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>
                  {Math.round(c.health * 100)}
                </span>
              </div>
              <Badge variant={fitVariant(c.fit)} mono>
                {c.fit}
              </Badge>
              <span className="sf-mono" style={{ color: 'var(--sf-fg-3)', fontSize: 11 }}>
                {c.lastHit} ago
              </span>
              <button
                type="button"
                aria-label={`Actions for ${c.handle}`}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--sf-fg-3)',
                  cursor: 'pointer',
                  fontSize: 16,
                  padding: 4,
                  fontFamily: 'inherit',
                }}
              >
                ⋯
              </button>
            </div>
          ))}
        </Card>

        {/* Keywords + ICP */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 16,
            marginTop: 16,
          }}
        >
          <div>
            <SectionBar count={`${KEYWORDS.length} watchlist`}>Keyword triggers</SectionBar>
            <Card padding={0}>
              {KEYWORDS.map((k, i) => (
                <div
                  key={k.word}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 18px',
                    borderBottom:
                      i === KEYWORDS.length - 1
                        ? 'none'
                        : '1px solid var(--sf-border-subtle)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: 'var(--sf-font-mono)',
                        fontSize: 'var(--sf-text-sm)',
                        color: 'var(--sf-fg-1)',
                        fontWeight: 600,
                      }}
                    >
                      &ldquo;{k.word}&rdquo;
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
                      <Badge variant={intentVariant(k.intent)} mono>
                        {k.intent}
                      </Badge>
                      <span style={{ fontSize: 11, color: 'var(--sf-fg-3)' }}>
                        {k.watchers.join(' + ')} watches
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div
                      className="sf-mono"
                      style={{
                        fontSize: 'var(--sf-text-h4)',
                        fontWeight: 500,
                        color: 'var(--sf-fg-1)',
                        lineHeight: 1,
                      }}
                    >
                      {k.hits}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        color: 'var(--sf-fg-3)',
                        letterSpacing: 'var(--sf-track-mono)',
                        fontFamily: 'var(--sf-font-mono)',
                        marginTop: 2,
                      }}
                    >
                      HITS · 7D
                    </div>
                  </div>
                </div>
              ))}
            </Card>
          </div>

          <div>
            <SectionBar count={`${ICP_LIST.length} profiles`}>
              Who we&rsquo;re writing to
            </SectionBar>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {ICP_LIST.map((icp) => (
                <Card key={icp.name} padding={18}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      marginBottom: 8,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 28,
                        height: 28,
                        borderRadius: '50%',
                        background: `conic-gradient(var(--sf-accent) ${icp.weight * 360}deg, var(--sf-bg-tertiary) 0)`,
                        padding: 3,
                      }}
                    >
                      <span
                        style={{
                          width: '100%',
                          height: '100%',
                          borderRadius: '50%',
                          background: 'var(--sf-bg-primary)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 700,
                          color: 'var(--sf-fg-2)',
                          fontFamily: 'var(--sf-font-mono)',
                        }}
                      >
                        {Math.round(icp.weight * 100)}
                      </span>
                    </span>
                    <div
                      style={{
                        fontSize: 'var(--sf-text-base)',
                        fontWeight: 600,
                        color: 'var(--sf-fg-1)',
                      }}
                    >
                      {icp.name}
                    </div>
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 'var(--sf-text-sm)',
                      color: 'var(--sf-fg-3)',
                      lineHeight: 'var(--sf-lh-normal)',
                    }}
                  >
                    {icp.details}
                  </p>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function fitVariant(fit: Community['fit']): 'success' | 'accent' | 'default' {
  if (fit === 'HIGH') return 'success';
  if (fit === 'MEDIUM') return 'accent';
  return 'default';
}

function intentVariant(intent: KeywordRow['intent']): 'success' | 'accent' | 'default' {
  if (intent === 'BUYING') return 'success';
  if (intent === 'RESEARCH') return 'accent';
  return 'default';
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
  return 'Either not enough discovery volume or gate pass rate has dropped. Re-run a voice scan or broaden your keyword watchlist.';
}
