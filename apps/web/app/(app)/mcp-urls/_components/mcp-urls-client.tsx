"use client";

/**
 * Client component for `/mcp-urls`. Per-role buttons issue a token + URL
 * via POST `/api/external-mcp/issue`, then render the result inline for
 * copy-paste into Claude Desktop / Cursor config.
 *
 * Three preset scope tiers:
 *   - Read-only: chat + query (safe to share with read-only MCP clients)
 *   - Read + draft: agent can plan + draft, but not publish
 *   - Full access: includes publish + admin (hire/fire, post directly)
 */

import { useState } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";

interface IssueResponse {
  token: string;
  mcpUrl: string;
  scope: string[];
  expiresInSeconds: number;
}

const ROLES = (Object.entries(ROLE_REGISTRY) as Array<
  [string, (typeof ROLE_REGISTRY)[keyof typeof ROLE_REGISTRY]]
>).map(([slug, entry]) => ({ slug, ...entry }));

const SCOPE_PRESETS: Array<{ label: string; scope: string[] }> = [
  { label: "Read-only", scope: ["read"] },
  { label: "Read + draft", scope: ["read", "draft"] },
  { label: "Full access", scope: ["read", "draft", "publish", "admin"] },
];

export default function McpUrlsClient() {
  const [issued, setIssued] = useState<Record<string, IssueResponse>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue(role: string, scopes: string[]): Promise<void> {
    setLoading(`${role}-${scopes.join(",")}`);
    setError(null);
    try {
      const res = await fetch("/api/external-mcp/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role, scope: scopes }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const body = (await res.json()) as IssueResponse;
      setIssued((m) => ({ ...m, [role]: body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(null);
    }
  }

  return (
    <div>
      {error && (
        <div
          style={{
            background: "#fee",
            border: "1px solid #fcc",
            color: "#900",
            padding: "0.75rem 1rem",
            borderRadius: 4,
            marginBottom: "1rem",
          }}
          role="alert"
        >
          Failed to issue token: {error}
        </div>
      )}

      {ROLES.map(({ slug, displayName, tier }) => (
        <section
          key={slug}
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: "1rem",
            marginBottom: "1rem",
            maxWidth: 720,
          }}
        >
          <h2 style={{ margin: 0 }}>
            {displayName}{" "}
            <span style={{ fontSize: "0.75em", color: "#888" }}>({tier})</span>
          </h2>
          <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {SCOPE_PRESETS.map(({ label, scope }) => {
              const key = `${slug}-${scope.join(",")}`;
              return (
                <button
                  key={key}
                  onClick={() => issue(slug, scope)}
                  disabled={loading !== null}
                  style={{
                    padding: "0.5rem 0.75rem",
                    borderRadius: 4,
                    border: "1px solid #ccc",
                    background: loading === key ? "#eee" : "#fff",
                    cursor: loading !== null ? "not-allowed" : "pointer",
                  }}
                >
                  {loading === key ? "Issuing..." : `Generate ${label} URL`}
                </button>
              );
            })}
          </div>
          {issued[slug] && (
            <div
              style={{
                marginTop: "1rem",
                padding: "1rem",
                background: "#fafafa",
                borderRadius: 4,
                border: "1px solid #eee",
              }}
            >
              <p style={{ margin: 0, fontWeight: "bold" }}>
                Scopes: {issued[slug]!.scope.join(", ")}
              </p>
              <p style={{ margin: "0.75rem 0 0.25rem" }}>MCP URL:</p>
              <pre
                style={{
                  margin: 0,
                  background: "#fff",
                  padding: "0.5rem",
                  borderRadius: 4,
                  border: "1px solid #eee",
                  overflow: "auto",
                  fontSize: "0.85em",
                }}
              >
                {issued[slug]!.mcpUrl}
              </pre>
              <p style={{ margin: "0.75rem 0 0.25rem" }}>
                Token (expires in 30 days — store it like an API key):
              </p>
              <pre
                style={{
                  margin: 0,
                  background: "#fff",
                  padding: "0.5rem",
                  borderRadius: 4,
                  border: "1px solid #eee",
                  overflow: "auto",
                  wordBreak: "break-all",
                  fontSize: "0.75em",
                }}
              >
                {issued[slug]!.token}
              </pre>
            </div>
          )}
        </section>
      ))}
      <p style={{ marginTop: "2rem" }}>
        <a href="/docs/mcp">→ See docs for wiring this into Claude Desktop</a>
      </p>
    </div>
  );
}
