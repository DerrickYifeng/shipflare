import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "../src/agents/platforms/_shared/guards";
import { applyXSchema } from "../src/agents/platforms/x/schema";
import type { CMO } from "../src/agents/cmo/CMO";
import type { ChannelConnection } from "../src/lib/channel";

/**
 * Tool-layer contract tests for XMcpAgent's 3 tools (S5.1).
 *
 * Why not invoke the registered handlers end-to-end:
 *   1. The X_MCP wrangler binding is intentionally commented until S5.3
 *      (so there's no `env.X_MCP` to `getByName()` against), and
 *   2. `super.onStart()` would attempt to set up an MCP transport for a
 *      non-transport-prefixed DO name, which is the same pattern every
 *      other S5.* / SMM / HoG / CMO test sidesteps.
 *
 * Instead we test the guard layer (the only piece of "business logic"
 * we own — the rest is platform-API plumbing). Combined with the
 * persistence-shape test, this covers the writes that downstream tools
 * (x_post insert, x_metrics update) make against posted_externals.
 *
 * Schema queries on a borrowed CMO DO instance mirror x-mcp-schema.test.ts
 * — we drive `applyXSchema(state.storage.sql)` and exercise the SQL the
 * tools emit verbatim. The CMO instance is never `onStart()`ed as a CMO;
 * we only touch its raw SqlStorage handle.
 */

describe("XMcpAgent guards", () => {
  const channel: ChannelConnection = {
    accessToken: "tok-abc",
    refreshToken: null,
    externalUserId: "x-uid-1",
    username: "alice",
    scope: null,
  };

  describe("requirePublishPermission", () => {
    it("allows role='lead' regardless of caller", () => {
      expect(() =>
        requirePublishPermission({ userId: "u1", caller: "cmo", role: "lead" }),
      ).not.toThrow();
      expect(() =>
        requirePublishPermission({
          userId: "u1",
          caller: "external",
          role: "lead",
        }),
      ).not.toThrow();
      expect(() =>
        requirePublishPermission({ userId: "u1", caller: "peer", role: "lead" }),
      ).not.toThrow();
    });

    it("allows caller='external' regardless of role", () => {
      expect(() =>
        requirePublishPermission({
          userId: "u1",
          caller: "external",
          role: "member",
        }),
      ).not.toThrow();
      expect(() =>
        requirePublishPermission({ userId: "u1", caller: "external" }),
      ).not.toThrow();
    });

    it("rejects role='member' from non-external callers", () => {
      expect(() =>
        requirePublishPermission({
          userId: "u1",
          caller: "cmo",
          role: "member",
        }),
      ).toThrow(/role='lead' or caller='external'/);
      expect(() =>
        requirePublishPermission({
          userId: "u1",
          caller: "peer",
          role: "member",
        }),
      ).toThrow(/role='lead' or caller='external'/);
      expect(() =>
        requirePublishPermission({
          userId: "u1",
          caller: "cron",
          role: "member",
        }),
      ).toThrow(/role='lead' or caller='external'/);
    });

    it("rejects missing role from non-external callers (default-deny)", () => {
      expect(() =>
        requirePublishPermission({ userId: "u1", caller: "cmo" }),
      ).toThrow();
      expect(() => requirePublishPermission(undefined)).toThrow();
    });
  });

  describe("requireChannel", () => {
    it("returns the channel when non-null", () => {
      expect(requireChannel(channel, "X")).toBe(channel);
    });

    it("throws a clear error when channel is null", () => {
      expect(() => requireChannel(null, "X")).toThrow(
        /X channel not connected/,
      );
    });
  });

  describe("requireUserId", () => {
    it("returns userId when present", () => {
      expect(
        requireUserId({ userId: "abc", caller: "external" }, "XMcpAgent"),
      ).toBe("abc");
    });

    it("throws when userId missing", () => {
      expect(() => requireUserId(undefined, "XMcpAgent")).toThrow(
        /userId in props/,
      );
    });
  });
});

describe("XMcpAgent tool persistence shape", () => {
  it("x_post path: posted_externals row keyed on tweet id (post / reply)", async () => {
    const stub = env.CMO.getByName("x-tools-post-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyXSchema(sql);

      // Mirror what registerXPostTool's handler INSERTs after a
      // successful publish. Two writes — one standalone post, one
      // reply — verify both `kind` values are accepted by the schema
      // and stored verbatim.
      const now = Date.now();
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "tweet-9001",
        "post",
        "lead",
        now,
        JSON.stringify({ id: "tweet-9001", text: "hello world" }),
      );
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "tweet-9002",
        "reply",
        "external",
        now,
        JSON.stringify({ id: "tweet-9002", text: "great point" }),
      );

      const rows = sql
        .exec<{ external_id: string; kind: string; posted_by_role: string }>(
          `SELECT external_id, kind, posted_by_role
             FROM posted_externals
            ORDER BY external_id`,
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        external_id: "tweet-9001",
        kind: "post",
        posted_by_role: "lead",
      });
      expect(rows[1]).toMatchObject({
        external_id: "tweet-9002",
        kind: "reply",
        posted_by_role: "external",
      });
    });
  });

  it("x_metrics path: UPDATE on existing posted_externals row refreshes json", async () => {
    const stub = env.CMO.getByName("x-tools-metrics-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyXSchema(sql);

      // Seed a post then simulate the x_metrics UPDATE — same query the
      // tool runs after a successful metrics fetch.
      sql.exec(
        `INSERT INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "tweet-7000",
        "post",
        "lead",
        100,
        JSON.stringify({ id: "tweet-7000", text: "initial publish" }),
      );

      const metricsEnvelope = {
        data: {
          id: "tweet-7000",
          public_metrics: {
            impression_count: 123,
            like_count: 4,
            reply_count: 1,
            retweet_count: 0,
            bookmark_count: 2,
            quote_count: 0,
          },
        },
      };
      sql.exec(
        `UPDATE posted_externals SET json = ? WHERE external_id = ?`,
        JSON.stringify(metricsEnvelope),
        "tweet-7000",
      );

      const row = sql
        .exec<{ json: string }>(
          `SELECT json FROM posted_externals WHERE external_id = ?`,
          "tweet-7000",
        )
        .one();
      const parsed = JSON.parse(row.json) as typeof metricsEnvelope;
      expect(parsed.data.public_metrics.impression_count).toBe(123);
      expect(parsed.data.public_metrics.like_count).toBe(4);
    });
  });

  it("x_metrics UPDATE on missing row is a no-op (third-party tweet)", async () => {
    const stub = env.CMO.getByName("x-tools-metrics-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyXSchema(sql);

      // No INSERT first — verify the UPDATE doesn't create a row when
      // metricsing a tweet we didn't publish. This matches the tool's
      // "best-effort mirror" semantics.
      sql.exec(
        `UPDATE posted_externals SET json = ? WHERE external_id = ?`,
        JSON.stringify({ ignored: true }),
        "tweet-not-ours",
      );

      const rows = sql
        .exec("SELECT COUNT(*) AS n FROM posted_externals")
        .toArray() as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });
  });
});
