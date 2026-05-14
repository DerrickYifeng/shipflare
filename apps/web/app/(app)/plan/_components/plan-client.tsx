/**
 * `<PlanClient>` — read-only table of `plan_items`.
 *
 * One MCP call on mount; no mutations. The CMO clamps `limit` at 200, so
 * we ask for 100 — plenty for a single-founder workspace and keeps the
 * table renderable without virtualisation.
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
}

export default function PlanClient() {
  const [items, setItems] = useState<PlanItem[]>([]);
  const [error, setError] = useState<string | null>(null);
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
          const rows = await c.queryPlanItems({ limit: 100 });
          if (!cancelled) setItems(rows as unknown as PlanItem[]);
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  return (
    <div>
      {error && <p style={{ color: "#c33" }}>Error: {error}</p>}
      {!error && items.length === 0 && (
        <p style={{ color: "#888" }}>
          No plan items yet. Chat with your CMO to generate some.
        </p>
      )}
      {items.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Skill</th>
              <th style={th}>Channel</th>
              <th style={th}>Status</th>
              <th style={th}>Owner</th>
              <th style={th}>Scheduled</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={td}>{i.skill}</td>
                <td style={td}>{i.channel}</td>
                <td style={td}>{i.status}</td>
                <td style={td}>{i.owner_role}</td>
                <td style={td}>
                  {i.scheduled_for
                    ? new Date(i.scheduled_for).toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "0.5rem",
  borderBottom: "2px solid #ddd",
};
const td: CSSProperties = { padding: "0.5rem" };
