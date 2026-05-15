"use client";

import { useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";
import { HeaderBar } from "@/components/layout/header-bar";

/**
 * Mirrors the Subreddit shape written by SMM's `research_reddit_channels`
 * tool (apps/core/src/agents/social-media-manager/tools/research-reddit-channels.ts).
 *
 * Fields: `subreddit` (not `name`), `rank`, `fitScore` only — the tool does
 * not persist memberCount, rulesSummary, or activity.
 */
interface Subreddit {
  subreddit: string;
  rank: number;
  fitScore: number;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "empty" } // CMO connected, no subreddits key yet
  | { kind: "done"; subreddits: Subreddit[] }
  | { kind: "error"; message: string };

export function RedditChannelsContent() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const clientRef = useRef<CmoClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const client = await createCmoClient();
        if (cancelled) {
          await client.close().catch(() => {});
          return;
        }
        clientRef.current = client;

        const ctx = await client.queryFounderContext();
        if (cancelled) return;

        const raw = ctx["subreddits"];
        if (!raw) {
          setState({ kind: "empty" });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          setState({ kind: "error", message: "Could not parse subreddit data" });
          return;
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
          setState({ kind: "empty" });
        } else {
          setState({ kind: "done", subreddits: parsed as Subreddit[] });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        });
      }
    })();

    return () => {
      cancelled = true;
      const c = clientRef.current;
      clientRef.current = null;
      if (c) c.close().catch(() => {});
    };
  }, []);

  return (
    <>
      <HeaderBar title="Reddit communities" />
      <div
        style={{
          padding: "var(--sf-space-6)",
          maxWidth: 760,
          margin: "0 auto",
        }}
      >
        {state.kind === "loading" && <LoadingState />}
        {state.kind === "empty" && <EmptyState />}
        {state.kind === "error" && <ErrorState message={state.message} />}
        {state.kind === "done" && (
          <SubredditList subreddits={state.subreddits} />
        )}
      </div>
    </>
  );
}

function LoadingState() {
  return (
    <div className="sf-body" style={{ color: "var(--sf-fg-3)" }}>
      Loading…
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="sf-body"
      style={{ color: "var(--sf-fg-3)", padding: "var(--sf-space-6) 0" }}
    >
      No subreddits researched yet. Your SMM will run research on the next
      kickoff. To trigger now, ask the team in{" "}
      <a href="/team" style={{ color: "var(--sf-accent)" }}>
        chat
      </a>
      : &ldquo;research reddit channels&rdquo;.
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="sf-body"
      style={{ color: "var(--sf-error)", padding: "var(--sf-space-6) 0" }}
    >
      {message}
    </div>
  );
}

function SubredditList({ subreddits }: { subreddits: Subreddit[] }) {
  return (
    <ul
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        listStyle: "none",
        padding: 0,
        margin: 0,
      }}
    >
      {subreddits.map((sub, idx) => (
        <SubredditCard key={`${sub.subreddit}-${idx}`} sub={sub} />
      ))}
    </ul>
  );
}

function SubredditCard({ sub }: { sub: Subreddit }) {
  const fitPct = Math.round(sub.fitScore * 100);
  return (
    <li
      style={{
        padding: "var(--sf-space-5)",
        border: "1px solid var(--sf-fg-4)",
        borderRadius: "var(--sf-radius-lg)",
        background: "var(--sf-bg-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span className="sf-h3">r/{sub.subreddit}</span>
        <span
          className="sf-ops"
          style={{ color: fitPct >= 70 ? "var(--sf-accent)" : "var(--sf-fg-3)" }}
        >
          Fit {fitPct}%
        </span>
      </div>
      <div className="sf-caption" style={{ color: "var(--sf-fg-3)" }}>
        Rank #{sub.rank}
      </div>
    </li>
  );
}
