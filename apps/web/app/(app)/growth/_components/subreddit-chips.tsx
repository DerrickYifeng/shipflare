import Link from "next/link";
import { Ops } from "@/components/ui/ops";

interface SubredditChipsProps {
  /** Top active subreddits, filtered and ordered server-side. */
  subreddits: string[];
}

export function SubredditChips({ subreddits }: SubredditChipsProps) {
  return (
    <div
      style={{ paddingTop: 14, borderTop: "1px solid rgba(0,0,0,0.06)", marginTop: 8 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <Ops>
          Active subreddits {subreddits.length > 0 ? `· ${subreddits.length}` : ""}
        </Ops>
        <Link
          href="/growth/reddit-channels"
          style={{
            fontSize: 13,
            color: "var(--sf-accent)",
            textDecoration: "none",
          }}
        >
          Manage subreddits →
        </Link>
      </div>
      {subreddits.length === 0 ? (
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: "var(--sf-fg-3)",
          }}
        >
          No active subreddits yet — research runs on next kickoff.
        </p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {subreddits.map((s) => (
            <span
              key={s}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "3px 10px",
                background: "var(--sf-bg-secondary)",
                border: "1px solid rgba(0,0,0,0.06)",
                borderRadius: 999,
                fontSize: 12,
                color: "var(--sf-fg-2)",
                letterSpacing: "-0.12px",
              }}
            >
              r/{s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
