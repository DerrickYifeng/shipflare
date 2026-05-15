// Drizzle schema for the 5 D1 tables that hold cross-team data:
// Better Auth's 4 standard tables + ShipFlare's `channels` table.
//
// Phase 0 spike #4 verified the following constraints against
// @better-auth/drizzle-adapter:
//   - Provider is "sqlite" (not "d1"). D1 is SQLite over HTTP.
//   - Column names MUST be camelCase. The adapter does not transform
//     identifiers — what's declared here is what the SQL must use.
//   - Integers use mode flags so Drizzle marshals JS Date / boolean values
//     correctly. Timestamps are millisecond-precision to match Better Auth's
//     internal Date handling.
//
// FK indexes (session.userId, account.userId, channels.userId,
// channels.(userId, platform)) are emitted in migrations/001_initial.sql
// since SQLite does not auto-index FK columns.

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

// ─── Better Auth standard tables (4) ────────────────────────────────────────

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" })
    .notNull()
    .default(false),
  name: text("name"),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", {
    mode: "timestamp_ms",
  }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
    mode: "timestamp_ms",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
});

// ─── ShipFlare-specific (1) ─────────────────────────────────────────────────

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  platform: text("platform", {
    enum: ["x", "reddit"],
  }).notNull(),
  externalUserId: text("externalUserId").notNull(),
  username: text("username"),
  // OAuth tokens encrypted via @shipflare/crypto AES-GCM envelope (Phase 0 spike #5).
  oauthTokenEncrypted: text("oauthTokenEncrypted").notNull(),
  oauthRefreshEncrypted: text("oauthRefreshEncrypted"),
  scope: text("scope"),
  connectedAt: integer("connectedAt", { mode: "timestamp_ms" }).notNull(),
  lastVerifiedAt: integer("lastVerifiedAt", { mode: "timestamp_ms" }),
  status: text("status", { enum: ["active", "revoked", "error"] })
    .notNull()
    .default("active"),
});

// ─── ShipFlare user preferences (1) ────────────────────────────────────────

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  timezone: text("timezone").notNull().default("UTC"),
  theme: text("theme", { enum: ["light", "dark"] }).notNull().default("light"),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export type UserPreferences = typeof userPreferences.$inferSelect;
export type NewUserPreferences = typeof userPreferences.$inferInsert;

// ─── ShipFlare product profile (1) ─────────────────────────────────────────

export const products = sqliteTable("products", {
  userId: text("userId")
    .primaryKey()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name"),
  description: text("description"),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  valueProp: text("valueProp"),
  url: text("url"),
  state: text("state", {
    enum: ["draft", "pre-launch", "launched", "growing"],
  })
    .notNull()
    .default("draft"),
  launchDate: integer("launchDate", { mode: "timestamp_ms" }),
  launchedAt: integer("launchedAt", { mode: "timestamp_ms" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

// ─── ShipFlare growth snapshots (1) ────────────────────────────────────────

export const growthSnapshots = sqliteTable(
  "growth_snapshots",
  {
    id: text("id").primaryKey().notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: ["x", "reddit"] }).notNull(),
    capturedAt: integer("capturedAt", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    metrics: text("metrics", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    userPlatformCaptured: index("idx_growth_user_platform_captured").on(
      t.userId,
      t.platform,
      sql`${t.capturedAt} DESC`,
    ),
  }),
);

export type GrowthSnapshot = typeof growthSnapshots.$inferSelect;
export type NewGrowthSnapshot = typeof growthSnapshots.$inferInsert;

// ─── ShipFlare allowlist (1) ───────────────────────────────────────────────
//
// Source of truth for "who can sign up". Better Auth's
// databaseHooks.user.create.before queries this on every new sign-up;
// existing accounts are unaffected. Admins manage via /admin/invites.
// SUPER_ADMIN_EMAIL is an env-var bypass so the founder can never lock
// themselves out by clearing the table.

export const allowedEmails = sqliteTable("allowed_emails", {
  /** Lowercased, trimmed email — primary key. */
  email: text("email").primaryKey(),
  /** Admin who invited this address (their email). */
  invitedBy: text("invitedBy").notNull(),
  /** Free-form note (e.g. "Founder of XYZ, met at SF Tech Week"). */
  note: text("note"),
  invitedAt: integer("invitedAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  /** When set, sign-up is blocked. Soft delete to preserve history. */
  revokedAt: integer("revokedAt", { mode: "timestamp_ms" }),
});

export type AllowedEmail = typeof allowedEmails.$inferSelect;
export type NewAllowedEmail = typeof allowedEmails.$inferInsert;

// ─── ShipFlare waitlist signups (1) ────────────────────────────────────────
//
// Captures public /waitlist form submissions. Admins triage each entry in
// /admin/invites → Waitlist tab and either approve (inserts into
// allowed_emails) or dismiss (soft-reject). Idempotent on email so the same
// person submitting twice doesn't create duplicate rows.

export const waitlistSignups = sqliteTable("waitlist_signups", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  submittedAt: integer("submittedAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  approvedAt: integer("approvedAt", { mode: "timestamp_ms" }),
  /** Admin who approved (their email). */
  approvedBy: text("approvedBy"),
  dismissedAt: integer("dismissedAt", { mode: "timestamp_ms" }),
  /** Admin who dismissed (their email). */
  dismissedBy: text("dismissedBy"),
});

export type WaitlistSignup = typeof waitlistSignups.$inferSelect;
export type NewWaitlistSignup = typeof waitlistSignups.$inferInsert;
