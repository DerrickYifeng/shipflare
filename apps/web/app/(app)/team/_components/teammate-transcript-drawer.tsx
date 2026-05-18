"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { useCmoAgent } from "@/hooks/use-cmo-agent";
import { useCmoStub } from "@/hooks/use-cmo-stub";
import { AgentDot } from "./agent-dot";
import { PhaseTag, type PhaseTone } from "./phase-tag";
import { roleCodeForRole } from "./agent-accent";

export interface TranscriptDrawerTarget {
  role: string;
  displayName: string;
}

interface TeammateTranscriptDrawerProps {
  target: TranscriptDrawerTarget | null;
  onClose: () => void;
  /** Founder user id — drives the CMO WebSocket. */
  userId: string;
  /** Bare host of apps/core for the WS — see `useCmoAgent`. */
  coreHost?: string;
}

interface LogEntry {
  id: number;
  conversation_id: string | null;
  from_role: string;
  kind: string;
  summary: string | null;
  payload_json: string | null;
  ts: number;
}

const KIND_TONE: Record<string, PhaseTone> = {
  task_complete: "success",
  task_completed: "success",
  task_failed: "error",
  request_input: "warning",
  peer_dm: "accent",
  status: "neutral",
};

function kindTone(kind: string): PhaseTone {
  return KIND_TONE[kind] ?? "neutral";
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.32)",
  backdropFilter: "blur(2px)",
  display: "flex",
  justifyContent: "flex-end",
  zIndex: 100,
  animation: "sf-fade-in 180ms ease-out",
};

const PANEL: CSSProperties = {
  width: "min(560px, 100%)",
  height: "100%",
  background: "var(--sf-bg-secondary)",
  boxShadow: "var(--sf-shadow-elevated)",
  display: "flex",
  flexDirection: "column",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "16px 20px",
  borderBottom: "1px solid var(--sf-border)",
};

const CLOSE_BTN: CSSProperties = {
  marginLeft: "auto",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--sf-fg-3)",
  fontSize: 20,
  padding: 6,
  borderRadius: 6,
};

const BODY: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const ENTRY: CSSProperties = {
  padding: "10px 14px",
  background: "var(--sf-bg-primary)",
  border: "1px solid var(--sf-border)",
  borderRadius: 8,
};

const ENTRY_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11,
  fontFamily: "var(--sf-font-mono)",
  color: "var(--sf-fg-3)",
  marginBottom: 6,
};

const ENTRY_SUMMARY: CSSProperties = {
  fontSize: 13,
  color: "var(--sf-fg-1)",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const ENTRY_META: CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  fontFamily: "var(--sf-font-mono)",
  color: "var(--sf-fg-4)",
};

const EMPTY: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--sf-fg-3)",
  fontSize: 13,
  padding: 32,
  textAlign: "center",
};

export function TeammateTranscriptDrawer({
  target,
  onClose,
  userId,
  coreHost,
}: TeammateTranscriptDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);

  // Share the same CMO WebSocket the parent page tree already opened —
  // useCmoAgent is idempotent per (agent, name, host), so this hook
  // resolves to the same socket instance as the surrounding TeamDesk's
  // `useCmoAgent` call.
  const { agent } = useCmoAgent({ userId, coreHost });
  const stub = useCmoStub({ agent });

  // Fetch transcript whenever target changes. No init guard: switching
  // between drawer targets (e.g. founder clicks a different role) MUST
  // re-fetch.
  useEffect(() => {
    if (!target) {
      setEntries([]);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const rows = await stub.queryAgentTranscript({
          role: target.role,
          limit: 100,
        });
        if (cancelled) return;
        setEntries(rows);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, stub]);

  // Close on Escape.
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  return (
    <div
      style={BACKDROP}
      role="dialog"
      aria-label={`${target.displayName} transcript`}
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={PANEL}>
        <header style={HEADER}>
          <AgentDot role={target.role} displayName={target.displayName} size={32} />
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: "var(--sf-fg-1)",
                fontFamily: "var(--sf-font-display)",
              }}
            >
              {target.displayName}
            </div>
            <div
              style={{
                fontSize: 10,
                fontFamily: "var(--sf-font-mono)",
                color: "var(--sf-fg-3)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}
            >
              {roleCodeForRole(target.role, target.displayName)} · Transcript
            </div>
          </div>
          <button
            type="button"
            style={CLOSE_BTN}
            onClick={onClose}
            aria-label="Close transcript"
          >
            ✕
          </button>
        </header>

        {loading ? (
          <div style={EMPTY}>Loading transcript…</div>
        ) : error ? (
          <div style={{ ...EMPTY, color: "var(--sf-error-ink)" }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={EMPTY}>
            <span style={{ fontSize: 32, opacity: 0.3 }}>📭</span>
            <div>No transcript yet.</div>
            <div style={{ color: "var(--sf-fg-4)" }}>
              Activity from {target.displayName} will appear here once they
              start working.
            </div>
          </div>
        ) : (
          <div style={BODY}>
            {entries.map((entry) => (
              <article key={entry.id} style={ENTRY}>
                <div style={ENTRY_HEADER}>
                  <PhaseTag label={entry.kind} tone={kindTone(entry.kind)} />
                  <span>{fmtTime(entry.ts)}</span>
                  {entry.conversation_id && (
                    <span title={entry.conversation_id}>
                      · convo{" "}
                      {entry.conversation_id.slice(0, 8)}
                    </span>
                  )}
                </div>
                {entry.summary && <div style={ENTRY_SUMMARY}>{entry.summary}</div>}
                {!entry.summary && entry.payload_json && (
                  <pre
                    style={{
                      ...ENTRY_SUMMARY,
                      ...ENTRY_META,
                      fontFamily: "var(--sf-font-mono)",
                      fontSize: 11,
                      color: "var(--sf-fg-2)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {entry.payload_json}
                  </pre>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
