/**
 * `<DraftsClient>` — founder approval queue.
 *
 * Lists drafts by status (default `ready`) via CMO.queryDrafts, which RPCs
 * to SMM.list_drafts. Approving calls CMO.approveDraft which flips the
 * matching `approval_queue` row to `decision='approved'`; the post-publisher
 * cron picks it up on its next tick.
 *
 * StrictMode pattern: `cancelled` flag + `clientRef` so the dev-time double-
 * effect doesn't leak SSE connections. Same shape as ConversationList /
 * PlanClient.
 */

"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

type DraftStatus = "drafting" | "ready" | "posted" | "failed" | "rejected";

// Loosely typed against SMM's `list_drafts` row shape. Nullable fields
// (confidence, why_it_works, thread_id, plan_item_id, conversation_id)
// reflect drafts that were generated outside a plan or without a thread.
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

export default function DraftsClient() {
  const clientRef = useRef<CmoClient | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [status, setStatus] = useState<DraftStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    createCmoClient()
      .then(async (c) => {
        if (cancelled) {
          void c.close();
          return;
        }
        clientRef.current = c;
        try {
          const rows = await c.queryDrafts({ status, limit: 50 });
          if (!cancelled) setDrafts(rows as unknown as Draft[]);
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
  }, [status]);

  async function approve(draftId: string): Promise<void> {
    if (!clientRef.current || approvingId) return;
    setApprovingId(draftId);
    try {
      await clientRef.current.approveDraft(draftId);
      // Refresh after approval. Approved drafts leave `status='ready'`
      // (the approval flips approval_queue, not the draft itself) — the
      // post-publisher cron is what eventually moves the draft to `posted`.
      // Re-querying gives the founder the latest snapshot.
      const rows = await clientRef.current.queryDrafts({ status, limit: 50 });
      setDrafts(rows as unknown as Draft[]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: "1rem" }}>
        <label>
          Status:{" "}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as DraftStatus)}
          >
            <option value="ready">Ready (awaiting approval)</option>
            <option value="drafting">Drafting</option>
            <option value="posted">Posted</option>
            <option value="failed">Failed (validation)</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
      </div>

      {error && <p style={{ color: "#c33" }}>Error: {error}</p>}
      {!error && drafts.length === 0 && (
        <p style={{ color: "#888" }}>No {status} drafts.</p>
      )}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {drafts.map((d) => (
          <li key={d.id} style={card}>
            <div style={cardHeader}>
              <strong>
                {d.kind === "reply" ? "↪ Reply" : "✒ Post"} on{" "}
                {d.platform.toUpperCase()}
              </strong>
              <span style={{ color: "#888", fontSize: "0.875em" }}>
                {new Date(d.created_at).toLocaleString()}
              </span>
            </div>
            <pre style={body}>{d.body}</pre>
            {d.why_it_works && (
              <p style={{ fontStyle: "italic", color: "#666", margin: "0.5rem 0" }}>
                Why: {d.why_it_works}
              </p>
            )}
            {status === "ready" && (
              <button
                onClick={() => void approve(d.id)}
                disabled={approvingId === d.id}
                style={approveBtn}
              >
                {approvingId === d.id ? "Approving..." : "Approve & Publish"}
              </button>
            )}
            {d.confidence !== null && (
              <span style={{ marginLeft: "1rem", color: "#888", fontSize: "0.875em" }}>
                confidence: {(d.confidence * 100).toFixed(0)}%
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const card: CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
};
const cardHeader: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: "0.5rem",
};
const body: CSSProperties = {
  whiteSpace: "pre-wrap",
  fontFamily: "inherit",
  margin: "0.5rem 0",
  background: "#fafafa",
  padding: "0.75rem",
  borderRadius: 4,
};
const approveBtn: CSSProperties = {
  padding: "0.5rem 1rem",
  background: "#000",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
