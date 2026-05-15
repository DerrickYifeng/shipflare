/**
 * TodayTab — approval inbox for the Briefing page.
 *
 * Ported from Railway's TodayBody. Replaces the Railway SWR + `/api/today`
 * pattern with a direct browser→core CmoClient call (CF spec D13).
 *
 * Data model difference:
 *   Railway: flat TodoItem list from `/api/today` (Postgres)
 *   CF: `queryPlanItems` + `queryDrafts` via CMO MCP tools
 *
 * The Railway TodayBody drove approve/skip via `/api/today/<id>/approve`
 * REST endpoints. Here we use `approveDraft` on the CmoClient directly.
 *
 * Visual chrome (Section headers, card layout, empty states) mirrors
 * Railway's layout so the UX stays consistent.
 */

"use client";

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

/* ── Types mirroring the CMO tool return shapes ─────────────────────── */

/** Row emitted by `queryDrafts` (SMM's list_drafts shape). */
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

interface BriefingData {
  pendingDrafts: Draft[];
}

interface BriefingState {
  loading: boolean;
  error: string | null;
  data: BriefingData | null;
  approvingId: string | null;
}

/* ── Hook ────────────────────────────────────────────────────────────── */

function useBriefing(): BriefingState & {
  approveDraft: (draftId: string) => Promise<void>;
} {
  const [state, setState] = useState<BriefingState>({
    loading: true,
    error: null,
    data: null,
    approvingId: null,
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
          const pendingDrafts = await c.queryDrafts<Draft>({
            status: "ready",
            limit: 50,
          });
          if (cancelled) return;
          setState((s) => ({
            ...s,
            loading: false,
            data: { pendingDrafts },
          }));
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setState((s) => ({ ...s, loading: false, error: msg }));
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, loading: false, error: msg }));
      });

    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  const approveDraft = useCallback(async (draftId: string) => {
    const c = clientRef.current;
    if (!c || state.approvingId) return;
    setState((s) => ({ ...s, approvingId: draftId }));
    try {
      await c.approveDraft(draftId);
      // Refresh the drafts list after approval.
      const pendingDrafts = await c.queryDrafts<Draft>({ status: "ready", limit: 50 });
      setState((s) => ({
        ...s,
        approvingId: null,
        data: s.data ? { ...s.data, pendingDrafts } : null,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, approvingId: null, error: msg }));
    }
  }, [state.approvingId]);

  return { ...state, approveDraft };
}

/* ── Component ───────────────────────────────────────────────────────── */

export function TodayTab() {
  const { loading, error, data, approvingId, approveDraft } = useBriefing();

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

  if (!data) return null;

  const { pendingDrafts } = data;

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
  draft: Draft;
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
        {draft.confidence !== null && (
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
