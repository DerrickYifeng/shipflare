/**
 * PlanTab — calendar view of plan_items.
 *
 * Mirrors Railway's `/briefing/plan` tab (which renders `<CalendarContent />`).
 * Here we keep it simple: a chronologically sorted list of plan items
 * with status dots + scheduled times, grouped by day.
 */

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface PlanItem {
  id: string;
  skill: string;
  channel: string;
  status: string;
  owner_role: string;
  scheduled_for: number | null;
  started_at: number | null;
  completed_at: number | null;
  params_json: string | null;
}

interface State {
  loading: boolean;
  error: string | null;
  items: PlanItem[];
}

export function PlanTab() {
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
          const items = await c.queryPlanItems<PlanItem>({ limit: 100 });
          if (cancelled) return;
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
        Loading plan&hellip;
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

  // Group by day (using scheduled_for, falling back to "Unscheduled").
  const groups = groupByDay(state.items);

  return (
    <div style={{ width: "100%", padding: "28px clamp(16px, 3vw, 32px) 48px" }}>
      <SectionHeader label="Plan" count={state.items.length} />
      {state.items.length === 0 ? (
        <p
          className="sf-mono"
          style={{ fontSize: "var(--sf-text-xs)", color: "var(--sf-fg-3)", margin: 0 }}
        >
          No plan items yet. Chat with your CMO to generate some.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {groups.map(({ key, label, items }) => (
            <div key={key}>
              <div
                className="sf-mono"
                style={{
                  fontSize: "var(--sf-text-xs)",
                  letterSpacing: "var(--sf-track-mono)",
                  color: "var(--sf-fg-3)",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                {label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {items.map((item) => (
                  <PlanItemRow key={item.id} item={item} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupByDay(items: PlanItem[]): Array<{ key: string; label: string; items: PlanItem[] }> {
  const map = new Map<string, { label: string; items: PlanItem[] }>();
  for (const item of items) {
    const key = item.scheduled_for
      ? new Date(item.scheduled_for).toISOString().slice(0, 10)
      : "unscheduled";
    const label = item.scheduled_for
      ? new Date(item.scheduled_for).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : "Unscheduled";
    const entry = map.get(key);
    if (entry) {
      entry.items.push(item);
    } else {
      map.set(key, { label, items: [item] });
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a === "unscheduled" ? 1 : b === "unscheduled" ? -1 : a.localeCompare(b)))
    .map(([key, value]) => ({ key, ...value }));
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 10,
        marginBottom: 14,
      }}
    >
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
  );
}

function PlanItemRow({ item }: { item: PlanItem }) {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--sf-border, rgba(0,0,0,0.06))",
    borderRadius: 6,
    background: "var(--sf-bg-secondary, #fff)",
  };

  const labelStyle: CSSProperties = {
    flex: 1,
    fontSize: 14,
    color: "var(--sf-fg-1)",
    fontWeight: 500,
  };

  const metaStyle: CSSProperties = { fontSize: 12, color: "var(--sf-fg-3)" };

  const statusColor: Record<string, string> = {
    completed: "var(--sf-success, #16a34a)",
    failed: "var(--sf-error, #c33)",
    in_progress: "var(--sf-warning, #ca8a04)",
    cancelled: "var(--sf-fg-3)",
  };

  const dotColor = statusColor[item.status] ?? "var(--sf-fg-3)";

  return (
    <div style={rowStyle} role="listitem">
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
        }}
      />
      <span style={labelStyle}>
        {item.skill}
        {item.channel ? ` · ${item.channel}` : ""}
      </span>
      <span style={metaStyle}>{item.status}</span>
      {item.scheduled_for && (
        <span style={metaStyle}>
          {new Date(item.scheduled_for).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      )}
    </div>
  );
}
