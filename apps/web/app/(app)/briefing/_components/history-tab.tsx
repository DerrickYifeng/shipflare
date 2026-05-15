/**
 * HistoryTab — drafts the founder has already acted on
 * (approved / posted / handed off to platform compose).
 *
 * Mirrors Railway's `/briefing/history` tab (which uses
 * `useBriefingHistory` against `/api/briefing/history`). CF queries the
 * CMO MCP directly via `queryDrafts` with each non-pending status.
 */

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface Draft {
  id: string;
  conversation_id: string | null;
  kind: string;
  plan_item_id: string | null;
  platform: string;
  thread_id: string | null;
  body: string;
  why_it_works: string | null;
  confidence: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

// Must match the Zod enum in apps/core/.../cmo/tools/shared-state.ts's
// queryDrafts inputSchema: drafting | ready | posted | failed | rejected.
// "history" = anything no longer pending the founder's review.
const HISTORY_STATUSES = ["posted", "failed", "rejected"] as const;

interface State {
  loading: boolean;
  error: string | null;
  items: Draft[];
}

export function HistoryTab() {
  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    items: [],
  });
  const clientRef = useRef<CmoClient | null>(null);

  useEffect(() => {
    let cancelled = false;

    createCmoClient()
      .then(async (c) => {
        if (cancelled) {
          void c.close();
          return;
        }
        clientRef.current = c;
        try {
          const buckets = await Promise.all(
            HISTORY_STATUSES.map((status) =>
              c.queryDrafts<Draft>({ status, limit: 50 }),
            ),
          );
          if (cancelled) return;
          const items = buckets
            .flat()
            .sort((a, b) => b.updated_at - a.updated_at);
          setState({ loading: false, error: null, items });
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setState({ loading: false, error: msg, items: [] });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ loading: false, error: msg, items: [] });
      });

    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  if (state.loading) {
    return (
      <div
        className="sf-body"
        style={{ padding: "28px clamp(16px, 3vw, 32px)", color: "var(--sf-fg-3)" }}
      >
        Loading history&hellip;
      </div>
    );
  }

  if (state.error) {
    return (
      <div
        className="sf-body"
        style={{ padding: "28px clamp(16px, 3vw, 32px)", color: "var(--sf-error, #c33)" }}
      >
        {state.error}
      </div>
    );
  }

  return (
    <div
      style={{
        width: "100%",
        padding: "28px clamp(16px, 3vw, 32px) 48px",
        maxWidth: 920,
        margin: "0 auto",
        boxSizing: "border-box",
      }}
    >
      <div
        className="sf-mono"
        style={{
          marginBottom: 16,
          fontSize: "var(--sf-text-xs)",
          color: "var(--sf-fg-3)",
          letterSpacing: "var(--sf-track-mono)",
          textTransform: "uppercase",
        }}
      >
        {state.items.length} drafts · newest first
      </div>

      {state.items.length === 0 ? (
        <p
          style={{
            fontSize: "var(--sf-text-sm)",
            color: "var(--sf-fg-3)",
          }}
        >
          Nothing here yet. Drafts you&apos;ve approved or posted will show up here.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {state.items.map((draft) => (
            <HistoryCard key={draft.id} draft={draft} />
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  posted: "Posted",
  failed: "Failed",
  rejected: "Rejected",
};

const STATUS_COLOR: Record<string, string> = {
  posted: "var(--sf-success, #16a34a)",
  failed: "var(--sf-error, #c33)",
  rejected: "var(--sf-fg-3)",
};

function HistoryCard({ draft }: { draft: Draft }) {
  const cardStyle: CSSProperties = {
    padding: 16,
    border: "1px solid var(--sf-border, rgba(0,0,0,0.08))",
    borderRadius: 8,
    background: "var(--sf-bg-secondary, #fff)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  };

  const tagStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--sf-fg-3)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };

  const statusStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: STATUS_COLOR[draft.status] ?? "var(--sf-fg-3)",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  };

  const bodyStyle: CSSProperties = {
    margin: 0,
    fontSize: 14,
    color: "var(--sf-fg-1)",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const metaStyle: CSSProperties = {
    fontSize: 12,
    color: "var(--sf-fg-3)",
  };

  return (
    <article style={cardStyle}>
      <div style={headerStyle}>
        <span style={tagStyle}>
          {draft.kind === "reply" ? "↪ Reply" : "✒ Post"} · {draft.platform.toUpperCase()}
        </span>
        <span style={statusStyle}>
          {STATUS_LABEL[draft.status] ?? draft.status}
        </span>
      </div>
      <p style={bodyStyle}>{draft.body}</p>
      <span style={metaStyle}>
        {new Date(draft.updated_at).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </span>
    </article>
  );
}
