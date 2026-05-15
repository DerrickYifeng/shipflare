import type { Metadata } from "next";
import { HeaderBar } from "@/components/layout/header-bar";

export const metadata: Metadata = { title: "Reddit communities" };
export const dynamic = "force-dynamic";

/**
 * /growth/reddit-channels — founder-managed view of subreddits ShipFlare
 * uses for Reddit content_post plan_items.
 *
 * Reachable from the Reddit card on /growth ("Manage subreddits →").
 *
 * Full subreddit research UI (RedditResearchCard) ships in a follow-up task.
 * Auth gate is handled by (app)/layout.tsx.
 */
export default function RedditChannelsPage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: "var(--sf-bg-primary)",
      }}
    >
      <HeaderBar title="Reddit communities" />
      <main
        style={{
          flex: 1,
          maxWidth: 720,
          width: "100%",
          margin: "0 auto",
          padding: "24px 16px 48px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <p style={{ margin: 0, color: "var(--sf-fg-2)" }}>
          Manage the subreddits ShipFlare uses when planning your Reddit posts.
          Subreddit research management is coming soon.
        </p>
      </main>
    </div>
  );
}
