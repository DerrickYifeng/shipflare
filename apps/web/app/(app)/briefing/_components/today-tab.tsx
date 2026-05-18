/**
 * TodayTab — approval inbox for the Briefing page.
 *
 * Ported from Railway's TodayBody. Migrated to the useCmoAgent +
 * useCmoStub pattern (Task 11 — callable RPC migration) — one
 * WebSocket per page tree, typed @callable surface.
 *
 * Data-model gap from the legacy `Draft` shape:
 *   The new @callable `queryDrafts` returns the approval-queue row
 *   (DraftRow from @shipflare/shared): `preview`, `decision`, `channel`,
 *   `employee` — no `body`, `why_it_works`, `confidence`, `status`. The
 *   card renders `body` from `preview` and treats the dropped fields as
 *   undefined. Acceptable for this migration; fuller cards can come back
 *   when CmoCallableSurface adds detail-shape methods.
 */

"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useCmoAgent } from "@/hooks/use-cmo-agent";
import { useCmoStub } from "@/hooks/use-cmo-stub";
import type { DraftRow } from "@shipflare/shared";

/* ── Local view-model ────────────────────────────────────────────────── */

/**
 * Local shape consumed by `DraftCard`. Maps `DraftRow.preview` to `body`
 * and leaves Railway-era fields (`why_it_works`, `confidence`) as
 * `undefined` since the @callable surface no longer returns them.
 */
interface DraftView {
  id: string;
  kind: string;
  platform: string;
  body: string;
  why_it_works?: string | null;
  confidence?: number | null;
}

function rowToView(row: DraftRow): DraftView {
  return {
    id: row.id,
    kind: row.kind,
    platform: row.channel,
    body: row.preview,
  };
}

/* ── Component ───────────────────────────────────────────────────────── */

export interface TodayTabProps {
  /** Founder user id — drives the CMO WebSocket. */
  userId: string;
  /** Bare host of apps/core for the WS — see `useCmoAgent`. */
  coreHost?: string;
}

export function TodayTab({ userId, coreHost }: TodayTabProps) {
  const { agent } = useCmoAgent({ userId, coreHost });
  const stub = useCmoStub({ agent });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<DraftView[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // One-shot init guard: JWT refresh (60s TTL) churns the agent
  // reference → stub re-memos → without this guard the effect re-fires
  // and clobbers state on every refresh.
  const initRanRef = useRef(false);

  useEffect(() => {
    if (initRanRef.current) return;
    initRanRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await stub.queryDrafts({ limit: 50 });
        if (cancelled) return;
        // Only show drafts the founder hasn't decided on yet.
        const pending = rows
          .filter((r) => r.decision === null || r.decision === undefined)
          .map(rowToView);
        setPendingDrafts(pending);
        setLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stub]);

  const approveDraft = useCallback(
    async (draftId: string) => {
      if (approvingId) return;
      setApprovingId(draftId);
      try {
        await stub.approveDraft({ draftId });
        const rows = await stub.queryDrafts({ limit: 50 });
        const pending = rows
          .filter((r) => r.decision === null || r.decision === undefined)
          .map(rowToView);
        setPendingDrafts(pending);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setApprovingId(null);
      }
    },
    [approvingId, stub],
  );

  if (loading) {
    return (
      <div
        className="sf-body"
        style={{ padding: "24px clamp(16px, 3vw, 32px)", color: "var(--sf-fg-3)" }}
      >
        Loading today&apos;s briefing&hellip;
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="sf-body"
        style={{ padding: "24px clamp(16px, 3vw, 32px)", color: "var(--sf-error, #c33)" }}
      >
        {error}
      </div>
    );
  }

  return (
    <div style={{ width: "100%", padding: "28px clamp(16px, 3vw, 32px) 48px" }}>
      <Section label="Awaiting approval" count={pendingDrafts.length}>
        {pendingDrafts.length === 0 ? (
          <p
            className="sf-mono"
            style={{ fontSize: "var(--sf-text-xs)", color: "var(--sf-fg-3)", margin: 0 }}
          >
            No drafts pending. Your team is working on it.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {pendingDrafts.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                approving={approvingId === draft.id}
                onApprove={approveDraft}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ── DraftCard ───────────────────────────────────────────────────────── */

interface DraftCardProps {
  draft: DraftView;
  approving: boolean;
  onApprove: (id: string) => Promise<void>;
}

function DraftCard({ draft, approving, onApprove }: DraftCardProps) {
  const cardStyle: CSSProperties = {
    padding: 16,
    border: "1px solid var(--sf-border-1, rgba(0,0,0,0.08))",
    borderRadius: 8,
    background: "var(--sf-surface-1, #fff)",
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

  const bodyStyle: CSSProperties = {
    margin: 0,
    fontSize: 14,
    color: "var(--sf-fg-1)",
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const whyStyle: CSSProperties = {
    margin: 0,
    fontSize: 13,
    color: "var(--sf-fg-3)",
    fontStyle: "italic",
  };

  const approveBtnStyle: CSSProperties = {
    padding: "6px 14px",
    background: "var(--sf-fg-1, #000)",
    color: "var(--sf-bg-1, #fff)",
    border: "none",
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 500,
    cursor: approving ? "default" : "pointer",
    opacity: approving ? 0.5 : 1,
    alignSelf: "flex-start",
  };

  return (
    <article style={cardStyle}>
      <div style={headerStyle}>
        <span style={tagStyle}>
          {draft.kind === "reply" ? "↪ Reply" : "✒ Post"} · {draft.platform.toUpperCase()}
        </span>
        {draft.confidence !== null && draft.confidence !== undefined && (
          <span style={{ fontSize: 12, color: "var(--sf-fg-3)" }}>
            {(draft.confidence * 100).toFixed(0)}% confidence
          </span>
        )}
      </div>
      <p style={bodyStyle}>{draft.body}</p>
      {draft.why_it_works && <p style={whyStyle}>{draft.why_it_works}</p>}
      <button
        style={approveBtnStyle}
        disabled={approving}
        onClick={() => void onApprove(draft.id)}
      >
        {approving ? "Approving…" : "Approve & publish"}
      </button>
    </article>
  );
}

/* ── Section ─────────────────────────────────────────────────────────── */

interface SectionProps {
  label: string;
  count: number;
  children: React.ReactNode;
}

function Section({ label, count, children }: SectionProps) {
  const wrapperStyle: CSSProperties = { marginBottom: 32 };
  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 10,
    marginBottom: 14,
  };

  return (
    <section style={wrapperStyle}>
      <div style={headerStyle}>
        <h2 className="sf-h3" style={{ margin: 0, color: "var(--sf-fg-1)" }}>
          {label}
        </h2>
        <span
          className="sf-mono"
          style={{
            fontSize: "var(--sf-text-xs)",
            color: "var(--sf-fg-3)",
            letterSpacing: "var(--sf-track-mono)",
          }}
        >
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}
