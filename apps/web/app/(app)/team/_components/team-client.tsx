/**
 * `<TeamClient>` — founder-facing roster manager.
 *
 * Mounts a single `CmoClient`, pulls `queryRoster`, and lets the founder
 * hire / fire roles. Available-to-hire is the set difference between
 * `ROLE_REGISTRY` (compile-time catalog of every role we ship) and the
 * currently active rows — minus CMO, which is implicit and rejected
 * server-side by `hireEmployee` / `fireEmployee` anyway.
 *
 * The connection lifecycle mirrors `<ChatStream>` from S7.A: use a ref +
 * cancelled flag so React 19 StrictMode's double-mount in dev doesn't leak
 * an orphan SSE transport.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";

interface RosterEntry {
  role: string;
  hired_at: number;
  status: string;
  hire_config_json: string | null;
}

export default function TeamClient() {
  const [client, setClient] = useState<CmoClient | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        setClient(c);
        try {
          const rows = await c.queryRoster();
          if (!cancelled) setRoster(rows);
        } catch (err: unknown) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setConnectError(msg);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setConnectError(msg);
      });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  async function refresh() {
    if (!client) return;
    try {
      setRoster(await client.queryRoster());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectError(msg);
    }
  }

  async function hire(role: string) {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.hireEmployee(role);
      await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function fire(role: string) {
    if (!client || busy || role === "cmo") return;
    setBusy(true);
    try {
      await client.fireEmployee(role);
      await refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConnectError(msg);
    } finally {
      setBusy(false);
    }
  }

  const activeRoles = new Set(
    roster.filter((r) => r.status === "active").map((r) => r.role),
  );
  const allRoleSlugs = Object.keys(ROLE_REGISTRY);
  const availableToHire = allRoleSlugs.filter(
    (slug) => slug !== "cmo" && !activeRoles.has(slug),
  );

  const activeRoster = roster.filter((r) => r.status === "active");

  return (
    <div>
      {connectError && (
        <p style={{ color: "#c33" }}>Error: {connectError}</p>
      )}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Active Roster</h2>
        {activeRoster.length === 0 && (
          <p style={{ color: "#888" }}>No active employees yet.</p>
        )}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {activeRoster.map((r) => {
            const entry =
              (ROLE_REGISTRY as Record<string, { displayName: string }>)[r.role];
            return (
              <li
                key={r.role}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <span style={{ flex: 1 }}>
                  <strong>{entry?.displayName ?? r.role}</strong>
                  <span style={{ color: "#888", marginLeft: "0.5rem" }}>
                    hired {new Date(r.hired_at).toLocaleDateString()}
                  </span>
                </span>
                <button
                  onClick={() => void fire(r.role)}
                  disabled={busy || r.role === "cmo"}
                >
                  Fire
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h2>Available to Hire</h2>
        {availableToHire.length === 0 && (
          <p style={{ color: "#888" }}>All available roles are hired.</p>
        )}
        <ul style={{ listStyle: "none", padding: 0 }}>
          {availableToHire.map((slug) => {
            const entry =
              (ROLE_REGISTRY as Record<
                string,
                { displayName: string; tier: string }
              >)[slug];
            return (
              <li
                key={slug}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid #f0f0f0",
                }}
              >
                <span style={{ flex: 1 }}>
                  <strong>{entry?.displayName ?? slug}</strong>
                  <span style={{ color: "#888", marginLeft: "0.5rem" }}>
                    ({entry?.tier ?? "?"})
                  </span>
                </span>
                <button
                  onClick={() => void hire(slug)}
                  disabled={!client || busy}
                >
                  Hire
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
