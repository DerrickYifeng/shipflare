// apps/web/app/(app)/growth/growth-content.tsx
"use client";

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
 * Data: GET /api/growth/overview (hierarchical shape from Task 6.3).
 */

import useSWR from "swr";
import { HeaderBar } from "@/components/layout/header-bar";
import { Card } from "@/components/ui/card";
import { OverallHero } from "./_components/overall-hero";
import { SocialPanel } from "./_components/social-panel";
import type { ModuleSummary } from "./_components/module-strip";

/** Shape returned by /api/growth/overview (Task 6.3). */
export interface ChannelCard {
  platform: "x" | "reddit";
  live: boolean;
  username: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
}

export interface GrowthModule {
  id: string;
  displayName: string;
  managerTitle: string;
  live: boolean;
  score: number;
  channels: ChannelCard[];
}

export interface GrowthOverview {
  overallScore: number;
  modules: GrowthModule[];
}

/**
 * Static ordered list of all planned modules.
 * Live data from the API fills in score + live status; modules not
 * returned by the API stay as planned placeholders with score null.
 */
const PLANNED_MODULES: Array<Pick<ModuleSummary, "id" | "displayName">> = [
  { id: "social", displayName: "Social" },
  { id: "search", displayName: "Search" },
  { id: "performance", displayName: "Performance" },
  { id: "content", displayName: "Content" },
  { id: "analytics", displayName: "Analytics" },
];

const fetcher = async (url: string): Promise<GrowthOverview> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
};

export function GrowthContent() {
  const { data, error } = useSWR<GrowthOverview>(
    "/api/growth/overview",
    fetcher,
    { revalidateOnFocus: false },
  );

  // Merge API modules with the full planned-module list so the strip
  // always shows all 5 chips even before API returns anything.
  const moduleStrip: ModuleSummary[] = PLANNED_MODULES.map((planned) => {
    const live = data?.modules.find((m) => m.id === planned.id);
    return {
      id: planned.id,
      displayName: planned.displayName,
      live: live?.live ?? false,
      score: live?.score ?? null,
    };
  });

  const social = data?.modules.find((m) => m.id === "social");

  return (
    <>
      <HeaderBar
        title="Growth"
        meta={
          !data
            ? "Your marketing team's progress — last 7 days."
            : `Health ${data.overallScore}/100 · Your marketing team's progress — last 7 days.`
        }
      />

      <div style={{ padding: "0 clamp(16px, 3vw, 32px) 48px" }}>
        {error ? (
          <Card padding={24}>
            <p style={{ margin: 0, color: "var(--sf-fg-3)" }}>
              Couldn&apos;t load Growth — refresh to retry.
            </p>
          </Card>
        ) : (
          <>
            <OverallHero
              overallScore={data?.overallScore ?? null}
              modules={moduleStrip}
            />

            {social && (
              <div style={{ marginTop: 16 }}>
                <SocialPanel
                  moduleScore={social.score}
                  managerTitle={social.managerTitle}
                  channels={social.channels}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
