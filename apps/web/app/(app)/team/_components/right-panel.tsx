"use client";

import type { CSSProperties } from "react";
import type { PlanItemRow, DraftRow } from "./types";

interface RightPanelProps {
  planItems: PlanItemRow[];
  drafts: DraftRow[];
  onApproveDraft: (id: string) => Promise<void>;
  onRejectDraft: (id: string) => Promise<void>;
  loadingDraftId: string | null;
}

const PANEL: CSSProperties = {
  width: 320,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  overflowY: "auto",
  maxHeight: "calc(100vh - 88px)",
  position: "sticky",
  top: 72,
  paddingBottom: 24,
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 10,
  fontFamily: "var(--sf-font-mono)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--sf-fg-3)",
  padding: "6px 0 4px",
};

const CARD: CSSProperties = {
  background: "var(--sf-bg-secondary)",
  borderRadius: "var(--sf-radius-lg)",
  padding: "10px 14px",
  boxShadow: "var(--sf-shadow-card)",
  fontSize: 13,
  fontFamily: "var(--sf-font-text)",
  color: "var(--sf-fg-1)",
};

const EMPTY_TEXT: CSSProperties = {
  fontSize: 13,
  fontFamily: "var(--sf-font-text)",
  color: "var(--sf-fg-4)",
  padding: "4px 0",
};

function statusColor(status: string | null | undefined): string {
  switch (status) {
    case "done":
    case "complete":
      return "var(--sf-success-ink)";
    case "in_progress":
    case "active":
      return "var(--sf-accent)";
    case "pending":
      return "var(--sf-warning-ink)";
    default:
      return "var(--sf-fg-3)";
  }
}

function PlanItemCard({ item }: { item: PlanItemRow }) {
  const badge: CSSProperties = {
    display: "inline-block",
    fontSize: 10,
    fontFamily: "var(--sf-font-mono)",
    color: statusColor(item.status),
    background: "var(--sf-bg-primary)",
    borderRadius: "var(--sf-radius-pill)",
    padding: "2px 8px",
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  };

  return (
    <div style={CARD}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>
        {item.title ?? `Task #${item.id}`}
      </div>
      {item.description && (
        <div
          style={{
            fontSize: 12,
            color: "var(--sf-fg-3)",
            marginBottom: 4,
            lineHeight: 1.4,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.description}
        </div>
      )}
      {item.status && <span style={badge}>{item.status}</span>}
    </div>
  );
}

function DraftCard({
  draft,
  onApprove,
  onReject,
  loading,
}: {
  draft: DraftRow;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
  loading: boolean;
}) {
  const content = typeof draft.content === "string" ? draft.content : "";
  const preview = content.length > 140 ? content.slice(0, 137) + "…" : content;
  const platform =
    typeof draft.platform === "string" ? draft.platform : "draft";

  const pill: CSSProperties = {
    display: "inline-block",
    fontSize: 10,
    fontFamily: "var(--sf-font-mono)",
    color: "var(--sf-fg-3)",
    background: "var(--sf-bg-primary)",
    borderRadius: "var(--sf-radius-pill)",
    padding: "2px 8px",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  };

  const btnRow: CSSProperties = {
    display: "flex",
    gap: 8,
    marginTop: 10,
  };

  const approveBtn: CSSProperties = {
    flex: 1,
    padding: "5px 0",
    borderRadius: "var(--sf-radius-md)",
    border: "none",
    background: "var(--sf-success)",
    color: "#fff",
    fontSize: 12,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.5 : 1,
    transition: `opacity var(--sf-dur-fast) var(--sf-ease)`,
  };

  const rejectBtn: CSSProperties = {
    flex: 1,
    padding: "5px 0",
    borderRadius: "var(--sf-radius-md)",
    border: "1px solid var(--sf-border)",
    background: "transparent",
    color: "var(--sf-fg-2)",
    fontSize: 12,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.5 : 1,
    transition: `opacity var(--sf-dur-fast) var(--sf-ease)`,
  };

  return (
    <div style={CARD}>
      <span style={pill}>{platform}</span>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--sf-fg-1)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {preview}
      </div>
      <div style={btnRow}>
        <button
          type="button"
          style={approveBtn}
          disabled={loading}
          onClick={() => void onApprove()}
          aria-label="Approve draft"
        >
          Approve
        </button>
        <button
          type="button"
          style={rejectBtn}
          disabled={loading}
          onClick={() => void onReject()}
          aria-label="Reject draft"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export function RightPanel({
  planItems,
  drafts,
  onApproveDraft,
  onRejectDraft,
  loadingDraftId,
}: RightPanelProps) {
  return (
    <aside style={PANEL} aria-label="Plan and drafts">
      {/* Plan items */}
      <div>
        <div style={SECTION_TITLE}>Plan Items</div>
        {planItems.length === 0 ? (
          <p style={EMPTY_TEXT}>No plan items yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {planItems.map((item) => (
              <PlanItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Pending drafts */}
      <div>
        <div style={SECTION_TITLE}>Pending Drafts</div>
        {drafts.length === 0 ? (
          <p style={EMPTY_TEXT}>No pending drafts.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {drafts.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                onApprove={() => onApproveDraft(d.id)}
                onReject={() => onRejectDraft(d.id)}
                loading={loadingDraftId === d.id}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
