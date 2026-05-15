/**
 * /admin/invites — allowlist + waitlist triage.
 *
 * Tabs:
 *   - Invites: existing allowed_emails rows, add new, revoke existing.
 *   - Waitlist: pending / approved / dismissed waitlist_signups, with
 *     approve + dismiss buttons on each.
 *
 * Auth is gated by `(app)/admin/layout.tsx` (ADMIN_EMAILS env). Mutations
 * go through server actions in `./actions.ts` which re-check via
 * requireAdmin() so a stale session can't act.
 */

import Link from "next/link";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  allowedEmails,
  waitlistSignups,
  user as userTable,
  desc,
  eq,
  isNull,
  isNotNull,
  sql,
  and,
} from "@shipflare/db";
import { getDb } from "@/db";
import { InviteForm } from "./_components/invite-form";
import { ActionButton } from "./_components/action-button";
import {
  revokeInvite,
  approveWaitlistSignup,
  dismissWaitlistSignup,
} from "./actions";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ tab?: string; status?: string }>;
}

export default async function AdminInvitesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const tab = sp.tab === "waitlist" ? "waitlist" : "invites";
  const status =
    sp.status === "approved" || sp.status === "dismissed"
      ? sp.status
      : "pending";

  const { env } = getCloudflareContext();
  const db = getDb(env);

  // Tally for the tab badge — uses booleans so D1 SQLite is happy.
  const counts = await db
    .select({
      pending: sql<number>`COUNT(CASE WHEN ${waitlistSignups.approvedAt} IS NULL AND ${waitlistSignups.dismissedAt} IS NULL THEN 1 END)`,
      approved: sql<number>`COUNT(CASE WHEN ${waitlistSignups.approvedAt} IS NOT NULL THEN 1 END)`,
      dismissed: sql<number>`COUNT(CASE WHEN ${waitlistSignups.dismissedAt} IS NOT NULL THEN 1 END)`,
    })
    .from(waitlistSignups)
    .get();
  const pending = Number(counts?.pending ?? 0);
  const approved = Number(counts?.approved ?? 0);
  const dismissed = Number(counts?.dismissed ?? 0);

  return (
    <div>
      {/* Tab strip */}
      <div
        style={{
          display: "flex",
          gap: 24,
          borderBottom: "1px solid var(--sf-border)",
          marginBottom: 24,
        }}
      >
        <TabLink href="/admin/invites" active={tab === "invites"}>
          Invites
        </TabLink>
        <TabLink href="/admin/invites?tab=waitlist" active={tab === "waitlist"}>
          Waitlist {pending > 0 ? `(${pending})` : ""}
        </TabLink>
      </div>

      {tab === "invites" ? (
        <InvitesTabContent />
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=pending"
              active={status === "pending"}
            >
              Pending ({pending})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=approved"
              active={status === "approved"}
            >
              Approved ({approved})
            </FilterChip>
            <FilterChip
              href="/admin/invites?tab=waitlist&status=dismissed"
              active={status === "dismissed"}
            >
              Dismissed ({dismissed})
            </FilterChip>
          </div>
          <WaitlistTab status={status} />
        </>
      )}
    </div>
  );
}

/* ── Invites tab ───────────────────────────────────────────────────── */

async function InvitesTabContent() {
  const { env } = getCloudflareContext();
  const db = getDb(env);
  const rows = await db
    .select({
      email: allowedEmails.email,
      invitedAt: allowedEmails.invitedAt,
      invitedBy: allowedEmails.invitedBy,
      note: allowedEmails.note,
      revokedAt: allowedEmails.revokedAt,
      userId: userTable.id,
    })
    .from(allowedEmails)
    .leftJoin(userTable, sql`LOWER(${userTable.email}) = ${allowedEmails.email}`)
    .orderBy(desc(allowedEmails.invitedAt));

  return (
    <div>
      <p
        style={{
          marginTop: 0,
          fontSize: 13,
          color: "var(--sf-fg-3)",
          marginBottom: 18,
        }}
      >
        Manage allowlisted emails. Sign-up is rejected for any address not on
        this list (unless it matches <code>SUPER_ADMIN_EMAIL</code>).
      </p>

      <InviteForm />

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--sf-fg-3)" }}>
            <Th>Email</Th>
            <Th>Note</Th>
            <Th>Invited</Th>
            <Th>Status</Th>
            <Th align="right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isRevoked = row.revokedAt !== null;
            const hasJoined = row.userId !== null;
            return (
              <tr
                key={row.email}
                style={{ borderTop: "1px solid var(--sf-border)" }}
              >
                <Td>
                  <div style={{ fontFamily: "var(--sf-font-mono)" }}>
                    {row.email}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--sf-fg-4)" }}>
                    by {row.invitedBy}
                  </div>
                </Td>
                <Td>
                  <span style={{ color: "var(--sf-fg-2)" }}>
                    {row.note ?? "—"}
                  </span>
                </Td>
                <Td>{formatDate(row.invitedAt)}</Td>
                <Td>
                  <StatusPill
                    state={
                      isRevoked ? "revoked" : hasJoined ? "joined" : "pending"
                    }
                  />
                </Td>
                <Td align="right">
                  {isRevoked ? (
                    <span style={{ fontSize: 11, color: "var(--sf-fg-4)" }}>
                      revoked {formatDate(row.revokedAt!)}
                    </span>
                  ) : (
                    <ActionButton
                      label="Revoke"
                      busyLabel="Revoking…"
                      variant="danger"
                      confirm={`Revoke access for ${row.email}? Their active session will be terminated.`}
                      action={async () => {
                        "use server";
                        const fd = new FormData();
                        fd.set("email", row.email);
                        return revokeInvite(fd);
                      }}
                    />
                  )}
                </Td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={5}
                style={{
                  padding: 24,
                  textAlign: "center",
                  color: "var(--sf-fg-4)",
                }}
              >
                No invites yet. Add the first design partner above.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ── Waitlist tab ──────────────────────────────────────────────────── */

async function WaitlistTab({ status }: { status: "pending" | "approved" | "dismissed" }) {
  const { env } = getCloudflareContext();
  const db = getDb(env);

  const where =
    status === "pending"
      ? and(
          isNull(waitlistSignups.approvedAt),
          isNull(waitlistSignups.dismissedAt),
        )
      : status === "approved"
        ? isNotNull(waitlistSignups.approvedAt)
        : isNotNull(waitlistSignups.dismissedAt);

  const rows = await db
    .select()
    .from(waitlistSignups)
    .where(where)
    .orderBy(desc(waitlistSignups.submittedAt));

  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: 32,
          textAlign: "center",
          color: "var(--sf-fg-4)",
          border: "1px dashed var(--sf-border)",
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        No {status} signups.
      </div>
    );
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "var(--sf-fg-3)" }}>
          <Th>Email</Th>
          <Th>Submitted</Th>
          {status === "approved" && <Th>Approved by</Th>}
          {status === "dismissed" && <Th>Dismissed by</Th>}
          <Th align="right">Actions</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} style={{ borderTop: "1px solid var(--sf-border)" }}>
            <Td>
              <span style={{ fontFamily: "var(--sf-font-mono)" }}>{row.email}</span>
            </Td>
            <Td>{formatDate(row.submittedAt)}</Td>
            {status === "approved" && (
              <Td>
                <span style={{ color: "var(--sf-fg-3)", fontSize: 12 }}>
                  {row.approvedBy}
                </span>
                <div style={{ fontSize: 11, color: "var(--sf-fg-4)" }}>
                  {row.approvedAt ? formatDate(row.approvedAt) : "—"}
                </div>
              </Td>
            )}
            {status === "dismissed" && (
              <Td>
                <span style={{ color: "var(--sf-fg-3)", fontSize: 12 }}>
                  {row.dismissedBy}
                </span>
                <div style={{ fontSize: 11, color: "var(--sf-fg-4)" }}>
                  {row.dismissedAt ? formatDate(row.dismissedAt) : "—"}
                </div>
              </Td>
            )}
            <Td align="right">
              {status === "pending" ? (
                <div
                  style={{ display: "inline-flex", gap: 8, justifyContent: "flex-end" }}
                >
                  <ActionButton
                    label="Approve"
                    busyLabel="Approving…"
                    variant="accent"
                    action={async () => {
                      "use server";
                      return approveWaitlistSignup(row.id);
                    }}
                  />
                  <ActionButton
                    label="Dismiss"
                    busyLabel="…"
                    variant="ghost"
                    action={async () => {
                      "use server";
                      return dismissWaitlistSignup(row.id);
                    }}
                  />
                </div>
              ) : (
                <span style={{ fontSize: 11, color: "var(--sf-fg-4)" }}>—</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Cells + chrome ────────────────────────────────────────────────── */

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: "10px 0",
        borderBottom: active
          ? "2px solid var(--sf-accent)"
          : "2px solid transparent",
        color: active ? "var(--sf-fg-1)" : "var(--sf-fg-3)",
        textDecoration: "none",
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        marginBottom: -1,
      }}
    >
      {children}
    </Link>
  );
}

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: "4px 12px",
        borderRadius: 999,
        background: active ? "var(--sf-bg-tertiary)" : "transparent",
        color: active ? "var(--sf-fg-1)" : "var(--sf-fg-3)",
        border: "1px solid var(--sf-border)",
        fontSize: 12,
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        padding: "8px 10px",
        fontWeight: 500,
        fontSize: 10,
        fontFamily: "var(--sf-font-mono)",
        letterSpacing: 0.5,
        textTransform: "uppercase",
        textAlign: align,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "10px",
        verticalAlign: "top",
        textAlign: align,
        color: "var(--sf-fg-1)",
      }}
    >
      {children}
    </td>
  );
}

function StatusPill({ state }: { state: "pending" | "joined" | "revoked" }) {
  const palette: Record<typeof state, { bg: string; fg: string; label: string }> = {
    pending: {
      bg: "var(--sf-bg-tertiary)",
      fg: "var(--sf-fg-3)",
      label: "pending",
    },
    joined: {
      bg: "var(--sf-success-light)",
      fg: "var(--sf-success-ink)",
      label: "joined",
    },
    revoked: {
      bg: "var(--sf-error-light)",
      fg: "var(--sf-error-ink)",
      label: "revoked",
    },
  };
  const { bg, fg, label } = palette[state];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 10,
        background: bg,
        color: fg,
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {label}
    </span>
  );
}

function formatDate(d: Date | number): string {
  const ms = typeof d === "number" ? d : d.getTime();
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
