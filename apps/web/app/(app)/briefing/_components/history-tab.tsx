/**
 * HistoryTab — drafts the founder has already acted on
 * (approved / posted / handed off / rejected).
 *
 * Migrated to the useCmoAgent + useCmoStub pattern (Task 11 — callable
 * RPC migration). The legacy code looped over per-status `queryDrafts`
 * calls; the new @callable surface (DraftRow) no longer takes a status
 * arg, so we make ONE call and filter client-side on `decision`.
 */

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useCmoAgent } from "@/hooks/use-cmo-agent";
import { useCmoStub } from "@/hooks/use-cmo-stub";
import type { DraftRow } from "@shipflare/shared";

interface State {
  loading: boolean;
  error: string | null;
  items: DraftRow[];
}

export interface HistoryTabProps {
  /** Founder user id — drives the CMO WebSocket. */
  userId: string;
  /** Bare host of apps/core for the WS — see `useCmoAgent`. */
  coreHost?: string;
}

export function HistoryTab({ userId, coreHost }: HistoryTabProps) {
  const { agent } = useCmoAgent({ userId, coreHost });
  const stub = useCmoStub({ agent });

  const [state, setState] = useState<State>({
    loading: true,
    error: null,
    items: [],
  });
  // One-shot init guard — JWT refresh churns the agent ref and would
  // re-fire this effect with stale data.
  const initRanRef = useRef(false);

  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await stub.queryDrafts({ limit: 200 });
        if (cancelled) return;
        const items = rows
          .filter((r) => r.decision !== null && r.decision !== undefined)
          .sort((a, b) => {
            const aT = a.decided_at ?? a.created_at;
            const bT = b.decided_at ?? b.created_at;
            return bT - aT;
          });
        setState({ loading: false, error: null, items });
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ loading: false, error: msg, items: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stub]);

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

const DECISION_LABEL: Record<string, string> = {
  approved: "Approved",
  rejected: "Rejected",
  posted: "Posted",
  handed_off: "Handed off",
  failed: "Failed",
};

const DECISION_COLOR: Record<string, string> = {
  approved: "var(--sf-success, #16a34a)",
  posted: "var(--sf-success, #16a34a)",
  rejected: "var(--sf-fg-3)",
  failed: "var(--sf-error, #c33)",
  handed_off: "var(--sf-accent)",
};

function HistoryCard({ draft }: { draft: DraftRow }) {
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

  const decision = draft.decision ?? "";
  const statusStyle: CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: DECISION_COLOR[decision] ?? "var(--sf-fg-3)",
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

  const ts = draft.decided_at ?? draft.created_at;

  return (
    <article style={cardStyle}>
      <div style={headerStyle}>
        <span style={tagStyle}>
          {draft.kind === "reply" ? "↪ Reply" : "✒ Post"} · {draft.channel.toUpperCase()}
        </span>
        <span style={statusStyle}>
          {DECISION_LABEL[decision] ?? decision}
        </span>
      </div>
      <p style={bodyStyle}>{draft.preview}</p>
      <span style={metaStyle}>
        {new Date(ts).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })}
      </span>
    </article>
  );
}
