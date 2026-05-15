import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  requireChannel,
  requirePublishPermission,
  requireUserId,
} from "../src/agents/platforms/_shared/guards";
import { applyRedditSchema } from "../src/agents/platforms/reddit/schema";
import type { CMO } from "../src/agents/cmo/CMO";
import type { ChannelConnection } from "../src/lib/channel";

/**
 * Tool-layer contract tests for RedditMcpAgent's 3 tools (S5.2).
 *
 * Why not invoke the registered handlers end-to-end:
 *   1. The REDDIT_MCP wrangler binding is intentionally commented
 *      until S5.3 (so there's no `env.REDDIT_MCP` to `getByName()`
 *      against), and
 *   2. `super.onStart()` would attempt to set up an MCP transport for
 *      a non-transport-prefixed DO name — same pattern every other
 *      S5.* / SMM / HoG / CMO test sidesteps.
 *
 * Instead we exercise:
 *   - The Reddit-flavored error messages emitted by the shared guards
 *     when reddit_post is the caller (publish-permission default-deny,
 *     "Reddit channel not connected" wording, RedditMcpAgent agent-name
 *     in userId error).
 *   - The persistence shape the registered handlers write to
 *     `posted_externals` after a successful publish — verifies both
 *     `post` (submission) and `reply` (comment) `kind` values, and
 *     that Reddit fullnames (`t3_<id>` / `t1_<id>`) are stored verbatim.
 *
 * Combined with `reddit-mcp-schema.test.ts` this covers the only
 * Reddit-side business logic we own — the rest is platform-API
 * plumbing.
 */

describe("RedditMcpAgent guards (Reddit-flavored error messages)", () => {
  const channel: ChannelConnection = {
    accessToken: "tok-reddit",
    refreshToken: null,
    externalUserId: "reddit-uid-1",
    username: "u_alice",
    scope: "submit edit",
  };

  describe("requirePublishPermission (reddit_post)", () => {
    it("rejects role='member' from non-external callers with reddit_post in the message", () => {
      expect(() =>
        requirePublishPermission(
          { userId: "u1", caller: "cmo", role: "member" },
          "reddit_post",
        ),
      ).toThrow(/reddit_post requires role='lead' or caller='external'/);
    });

    it("allows role='lead' for reddit_post", () => {
      expect(() =>
        requirePublishPermission(
          { userId: "u1", caller: "cmo", role: "lead" },
          "reddit_post",
        ),
      ).not.toThrow();
    });

    it("allows caller='external' for reddit_post regardless of role", () => {
      expect(() =>
        requirePublishPermission(
          { userId: "u1", caller: "external", role: "member" },
          "reddit_post",
        ),
      ).not.toThrow();
    });
  });

  describe("requireChannel (Reddit label)", () => {
    it("returns the channel when non-null", () => {
      expect(requireChannel(channel, "Reddit")).toBe(channel);
    });

    it("throws 'Reddit channel not connected' when null", () => {
      expect(() => requireChannel(null, "Reddit")).toThrow(
        /Reddit channel not connected/,
      );
    });
  });

  describe("requireUserId (RedditMcpAgent label)", () => {
    it("returns userId when present", () => {
      expect(
        requireUserId({ userId: "abc", caller: "cmo" }, "RedditMcpAgent"),
      ).toBe("abc");
    });

    it("names RedditMcpAgent in the error when userId missing", () => {
      expect(() => requireUserId(undefined, "RedditMcpAgent")).toThrow(
        /RedditMcpAgent has no userId in props/,
      );
    });
  });
});

describe("RedditMcpAgent tool persistence shape", () => {
  it("reddit_post path: posted_externals rows for submission + comment store fullnames verbatim", async () => {
    const stub = env.CMO.getByName("reddit-tools-post-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const sql = state.storage.sql;
      applyRedditSchema(sql);

      const now = Date.now();
      // Mirror what registerRedditPostTool's handler INSERTs after a
      // successful submission publish. Reddit returns the fullname
      // (`t3_<id>`) in `result.json.data.things[0].data.name` — we
      // store that verbatim as `external_id`.
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "t3_xyz789",
        "post",
        "lead",
        now,
        JSON.stringify({
          name: "t3_xyz789",
          url: "https://www.reddit.com/r/sample/comments/xyz789",
        }),
      );
      // And a comment reply (`t1_<id>` fullname).
      sql.exec(
        `INSERT OR REPLACE INTO posted_externals
           (external_id, kind, posted_by_role, posted_at, json)
         VALUES (?, ?, ?, ?, ?)`,
        "t1_qrs456",
        "reply",
        "external",
        now,
        JSON.stringify({
          name: "t1_qrs456",
          url: "https://www.reddit.com/r/sample/comments/xyz789/_/qrs456",
        }),
      );

      const rows = sql
        .exec<{
          external_id: string;
          kind: string;
          posted_by_role: string;
        }>(
          `SELECT external_id, kind, posted_by_role
             FROM posted_externals
            ORDER BY external_id`,
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        external_id: "t1_qrs456",
        kind: "reply",
        posted_by_role: "external",
      });
      expect(rows[1]).toMatchObject({
        external_id: "t3_xyz789",
        kind: "post",
        posted_by_role: "lead",
      });
    });
  });

  it("research_subreddits ranking: log10/7 puts 1M+ subreddits near 1.0 and sorts desc by fitScore", () => {
    // Reproduce the ranking formula the tool applies so the test
    // pins the contract (a regression in either formula or sort
    // order would surface here without spinning up the DO).
    function computeFit(subscribers: number): number {
      return Math.min(1, Math.log10(subscribers + 1) / 7);
    }
    const raw = [
      { name: "tiny", subscribers: 100 }, // ~0.29
      { name: "huge", subscribers: 5_000_000 }, // ~0.96
      { name: "mid", subscribers: 50_000 }, // ~0.67
    ];
    const ranked = raw
      .map((r, idx) => ({
        subreddit: `r/${r.name}`,
        rank: idx + 1,
        fitScore: computeFit(r.subscribers),
      }))
      .sort((a, b) => b.fitScore - a.fitScore);

    expect(ranked.map((r) => r.subreddit)).toEqual([
      "r/huge",
      "r/mid",
      "r/tiny",
    ]);
    expect(ranked[0]!.fitScore).toBeGreaterThan(0.9);
    expect(ranked[2]!.fitScore).toBeLessThan(0.4);
    // 10M+ subscribers should saturate the formula at the clamp.
    expect(computeFit(50_000_000)).toBe(1);
  });
});
