// src/app/(app)/growth/growth-content.tsx
'use client';

/**
 * Growth — module-based progress dashboard.
 *
 * Composition:
 *   - <OverallHero> renders the overall dial + module strip.
 *   - <SocialPanel> renders the live Social Marketing module with X +
 *     Reddit channel cards.
 *
 * Other modules (Search / Performance / Content / Analytics) appear in
 * the module strip as planned placeholders. They get their own panel
 * components when they go live.
 *
 * Data: GET /api/growth/overview (hierarchical shape — see spec).
 */

import useSWR from 'swr';
import { HeaderBar } from '@/components/layout/header-bar';
import { Card } from '@/components/ui/card';
import { OverallHero } from './_components/overall-hero';
import { SocialPanel } from './_components/social-panel';
import type { ChannelOverview } from './_components/channel-card';

interface GrowthOverview {
  overallScore: number | null;
  modules: Array<{
    id: string;
    displayName: string;
    managerTitle: string;
    live: boolean;
    score: number | null;
    channels?: Array<ChannelOverview & { activeSubreddits?: string[] }>;
  }>;
}

const fetcher = async (url: string): Promise<GrowthOverview> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
};

export function GrowthContent() {
  const { data, error } = useSWR<GrowthOverview>('/api/growth/overview', fetcher, {
    revalidateOnFocus: false,
  });

  return (
    <>
      <HeaderBar
        title="Growth"
        meta={
          data?.overallScore == null
            ? "Your marketing team's progress — last 7 days."
            : `Health ${data.overallScore}/100 · Your marketing team's progress — last 7 days.`
        }
      />

      <div style={{ padding: '0 clamp(16px, 3vw, 32px) 48px' }}>
        {error ? (
          <Card padding={24}>
            <p style={{ margin: 0, color: 'var(--sf-fg-3)' }}>
              Couldn&apos;t load Growth — refresh to retry.
            </p>
          </Card>
        ) : (
          <>
            <OverallHero
              overallScore={data?.overallScore ?? null}
              modules={(data?.modules ?? []).map((m) => ({
                id: m.id,
                displayName: m.displayName,
                live: m.live,
                score: m.score,
              }))}
            />

            {(() => {
              const social = data?.modules.find((m) => m.id === 'social');
              if (!social) return null;
              return (
                <div style={{ marginTop: 16 }}>
                  <SocialPanel
                    moduleScore={social.score}
                    channels={social.channels ?? []}
                  />
                </div>
              );
            })()}
          </>
        )}
      </div>
    </>
  );
}
