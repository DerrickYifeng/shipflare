"use client";

import type { CSSProperties } from "react";
import type { PlanItemRow, DraftRow } from "./types";
import { AgentDot } from "./agent-dot";
import { PhaseTag } from "./phase-tag";
import { ROLE_REGISTRY } from "@shipflare/shared";

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
  gap: 20,
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
  padding: "6px 0 8px",
  display: "flex",
  alignItems: "baseline",
  gap: 8,
};

const COUNT_BADGE: CSSProperties = {
  fontSize: 10,
  color: "var(--sf-fg-3)",
  fontWeight: 400,
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
  margin: 0,
};

const ACTIVE_STATUSES = new Set([
  "pending",
  "drafting",
  "executing",
  "in_progress",
]);

function displayNameForRole(role: string): string {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[role];
  return entry?.displayName ?? role;
}

function relativeTime(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const diffMs = Date.now() - ts;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

function statusTone(status: string | null | undefined): "neutral" | "accent" | "success" | "warning" | "error" {
  switch (status) {
    case "completed":
    case "done":
      return "success";
    case "executing":
    case "in_progress":
    case "drafting":
      return "warning";
    case "pending":
    case "ready":
      return "accent";
    case "failed":
    case "rejected":
      return "error";
    default:
      return "neutral";
  }
}

/* ── Running-now card ──────────────────────────────────────────────── */

interface RunningRow {
  id: string;
  role: string;
  skill: string;
  channel: string;
  status: string;
  startedAt: number | null;
}

function RunningCard({ row }: { row: RunningRow }) {
  const displayName = displayNameForRole(row.role);
  const time = relativeTime(row.startedAt);
  return (
    <div
      style={{
        ...CARD,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
      }}
    >
      <AgentDot role={row.role} displayName={displayName} size={24} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--sf-fg-1)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={`${row.skill} · ${row.channel}`}
        >
          {row.skill}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--sf-fg-3)",
            fontFamily: "var(--sf-font-mono)",
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span>{row.channel || displayName}</span>
          {time && <span aria-hidden="true">·</span>}
          {time && <span>{time}</span>}
        </div>
      </div>
      <PhaseTag label={row.status} tone={statusTone(row.status)} />
    </div>
  );
}

/* ── Plan card (read-only roadmap) ─────────────────────────────────── */

function PlanItemCard({ item }: { item: PlanItemRow }) {
  const skill = typeof item.skill === "string" ? item.skill : null;
  const channel = typeof item.channel === "string" ? item.channel : null;
  const ownerRole = typeof item.owner_role === "string" ? item.owner_role : "cmo";
  const status = typeof item.status === "string" ? item.status : null;
  const displayName = displayNameForRole(ownerRole);

  return (
    <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
      <AgentDot role={ownerRole} displayName={displayName} size={22} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: "var(--sf-fg-1)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {skill ?? item.title ?? `Task #${item.id}`}
        </div>
        {channel && (
          <div
            style={{
              fontSize: 11,
              color: "var(--sf-fg-3)",
              fontFamily: "var(--sf-font-mono)",
            }}
          >
            {channel}
          </div>
        )}
      </div>
      {status && <PhaseTag label={status} tone={statusTone(status)} />}
    </div>
  );
}

/* ── Draft card (approval / reject) ────────────────────────────────── */

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
  const content =
    typeof draft.content === "string"
      ? draft.content
      : typeof (draft as { body?: string }).body === "string"
        ? ((draft as { body?: string }).body ?? "")
        : "";
  const preview = content.length > 140 ? content.slice(0, 137) + "…" : content;
  const platform =
    typeof draft.platform === "string" ? draft.platform : "draft";
  const kind = typeof (draft as { kind?: string }).kind === "string" ? (draft as { kind?: string }).kind : null;

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
    color: "var(--sf-fg-on-dark-1)",
    fontSize: 12,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.5 : 1,
    transition: `opacity var(--sf-dur-fast) var(--sf-ease-swift)`,
  };

  const rejectBtn: CSSProperties = {
    flex: 1,
    padding: "5px 0",
    borderRadius: "var(--sf-radius-md)",
    border: "1px solid var(--sf-fg-3)",
    background: "transparent",
    color: "var(--sf-fg-1)",
    fontSize: 12,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.5 : 1,
    transition: `opacity var(--sf-dur-fast) var(--sf-ease-swift), background var(--sf-dur-fast) var(--sf-ease-swift)`,
  };

  return (
    <div style={CARD}>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <PhaseTag label={platform} tone="neutral" />
        {kind && <PhaseTag label={kind} tone="accent" />}
      </div>
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
          {loading ? "…" : "Approve"}
        </button>
        <button
          type="button"
          style={rejectBtn}
          disabled={loading}
          onClick={() => void onReject()}
          onMouseEnter={(e) => {
            if (!loading) {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--sf-bg-primary)";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
          aria-label="Reject draft"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/* ── Panel ─────────────────────────────────────────────────────────── */

export function RightPanel({
  planItems,
  drafts,
  onApproveDraft,
  onRejectDraft,
  loadingDraftId,
}: RightPanelProps) {
  const running: RunningRow[] = planItems
    .filter((p) => {
      const status = typeof p.status === "string" ? p.status : null;
      return status !== null && ACTIVE_STATUSES.has(status);
    })
    .map((p) => ({
      id: p.id,
      role: (p as { owner_role?: string }).owner_role || "cmo",
      skill: typeof p.skill === "string" ? p.skill : (p.title ?? `Task #${p.id}`),
      channel: typeof p.channel === "string" ? p.channel : "",
      status: typeof p.status === "string" ? p.status : "pending",
      startedAt:
        (p as { started_at?: number | null }).started_at ??
        (p as { created_at?: number | null }).created_at ??
        null,
    }));

  const upcoming = planItems.filter((p) => {
    const status = typeof p.status === "string" ? p.status : null;
    return !status || !ACTIVE_STATUSES.has(status);
  });

  return (
    <aside style={PANEL} aria-label="Plan and drafts">
      {/* Running now */}
      <div>
        <div style={SECTION_TITLE}>
          <span>Running now</span>
          <span style={COUNT_BADGE}>{running.length}</span>
        </div>
        {running.length === 0 ? (
          <p style={EMPTY_TEXT}>The team is idle.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {running.map((r) => (
              <RunningCard key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>

      {/* Pending drafts */}
      <div>
        <div style={SECTION_TITLE}>
          <span>Awaiting your review</span>
          <span style={COUNT_BADGE}>{drafts.length}</span>
        </div>
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

      {/* Roadmap */}
      <div>
        <div style={SECTION_TITLE}>
          <span>Roadmap</span>
          <span style={COUNT_BADGE}>{upcoming.length}</span>
        </div>
        {upcoming.length === 0 ? (
          <p style={EMPTY_TEXT}>No plan items yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upcoming.map((item) => (
              <PlanItemCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
