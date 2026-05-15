import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyCmoSchema } from "../src/agents/cmo/schema";
import { generateVapidKeypair } from "../src/lib/web-push";
import type { CMO } from "../src/agents/cmo/CMO";

/**
 * P2-F — Web Push subscription persistence + VAPID keypair generation.
 *
 * We don't test the full `sendWebPush` round-trip here — it would require
 * standing up a fake push service or hitting Apple/Google/Mozilla
 * endpoints, both unfit for unit tests. Instead we exercise:
 *
 *  1. The `push_subscriptions` table comes online with the right
 *     columns when `applyCmoSchema` runs.
 *  2. The `/internal/push-subscribe` handler upserts on conflict.
 *  3. `generateVapidKeypair()` produces correctly-shaped base64url
 *     output (round-tripping through WebCrypto = the imported jwk
 *     would not round-trip if shape were wrong, so this also
 *     transitively validates the signing key shape).
 *
 * VAPID JWT round-trip (sign + verify against a freshly generated
 * keypair) is a follow-up test once we have a stable way to import
 * the public key half for `verify`.
 */

const INTERNAL_HEADERS = {
  "x-shipflare-internal": "1",
  "content-type": "application/json",
};

describe("P2-F push_subscriptions schema", () => {
  it("table + columns exist after applyCmoSchema", async () => {
    const stub = env.CMO.getByName("push-schema-test-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
      const cols = state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM pragma_table_info('push_subscriptions')",
        )
        .toArray()
        .map((r) => r.name);
      expect(cols).toEqual(
        expect.arrayContaining([
          "endpoint",
          "p256dh",
          "auth",
          "subscribed_at",
          "last_used",
          "last_error",
        ]),
      );
    });
  });
});

describe("CMO /internal/push-subscribe", () => {
  it("inserts a new subscription row", async () => {
    const stub = env.CMO.getByName("push-sub-test-1");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
    });

    const res = await stub.fetch(
      new Request("https://x/internal/push-subscribe", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({
          endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
          p256dh: "BAbCdEfGhIjK",
          auth: "auth-secret",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("subscribed");

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const rows = state.storage.sql
        .exec<{ endpoint: string; p256dh: string; auth: string }>(
          "SELECT endpoint, p256dh, auth FROM push_subscriptions",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
        p256dh: "BAbCdEfGhIjK",
        auth: "auth-secret",
      });
    });
  });

  it("upserts on conflict — same endpoint, new keys", async () => {
    const stub = env.CMO.getByName("push-sub-test-2");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
    });

    const subscribe = (p256dh: string, auth: string) =>
      stub.fetch(
        new Request("https://x/internal/push-subscribe", {
          method: "POST",
          headers: INTERNAL_HEADERS,
          body: JSON.stringify({
            endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz",
            p256dh,
            auth,
          }),
        }),
      );

    expect((await subscribe("key-v1", "auth-v1")).status).toBe(200);
    expect((await subscribe("key-v2", "auth-v2")).status).toBe(200);

    await runInDurableObject(stub, async (_instance: CMO, state) => {
      const rows = state.storage.sql
        .exec<{ p256dh: string; auth: string }>(
          "SELECT p256dh, auth FROM push_subscriptions",
        )
        .toArray();
      // Still one row (upsert collapsed them) but with the newer keys.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ p256dh: "key-v2", auth: "auth-v2" });
    });
  });

  it("rejects without the internal header (403)", async () => {
    const stub = env.CMO.getByName("push-sub-test-3");
    const res = await stub.fetch(
      new Request("https://x/internal/push-subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://x/y",
          p256dh: "a",
          auth: "b",
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects malformed payload (400)", async () => {
    const stub = env.CMO.getByName("push-sub-test-4");
    await runInDurableObject(stub, async (_instance: CMO, state) => {
      applyCmoSchema(state.storage.sql);
    });
    const res = await stub.fetch(
      new Request("https://x/internal/push-subscribe", {
        method: "POST",
        headers: INTERNAL_HEADERS,
        body: JSON.stringify({ endpoint: "", p256dh: "x", auth: "y" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("VAPID keypair generation", () => {
  it("generateVapidKeypair produces correctly-shaped base64url output", async () => {
    const { publicKey, privateKey } = await generateVapidKeypair();
    // Public key: 65 raw bytes → 87 base64url chars (no padding).
    //   ceil(65 * 4 / 3) = 88 → minus 1 for the omitted '=' padding = 87.
    // The encoder strips '=' padding so any 65-byte input lands at 87 chars.
    expect(publicKey.length).toBe(87);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // Private key: 32 raw bytes → 43 base64url chars (no padding).
    //   ceil(32 * 4 / 3) = 43 (no padding needed for 32 bytes anyway).
    expect(privateKey.length).toBe(43);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("two consecutive calls yield distinct keypairs", async () => {
    const a = await generateVapidKeypair();
    const b = await generateVapidKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});
