/**
 * `<NotificationsClient>` — Web Push opt-in flow (P2-F).
 *
 * State machine:
 *   permission: "default" | "granted" | "denied" | "unknown" (pre-mount)
 *   subscribed: did `pushManager.getSubscription()` return non-null?
 *
 * Click "Enable" →
 *   1. Notification.requestPermission()
 *   2. navigator.serviceWorker.register("/sw.js")
 *   3. await navigator.serviceWorker.ready
 *   4. registration.pushManager.subscribe({ applicationServerKey })
 *   5. POST subscription.toJSON() to /api/push/subscribe
 *
 * `NEXT_PUBLIC_VAPID_PUBLIC` is inlined into the client bundle at build
 * time by Next.js. Set it in `apps/web/.env.local` for local dev (one
 * line, value is the base64url 65-byte uncompressed P-256 public key)
 * and pass via wrangler vars in production. The value MUST match what
 * apps/core's `VAPID_PUBLIC` secret holds — same public key both sides.
 */

"use client";

import { useEffect, useState } from "react";

type PermissionState = NotificationPermission | "unknown";

export default function NotificationsClient() {
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // NEXT_PUBLIC_VAPID_PUBLIC is inlined at build time. If missing we show a
  // friendly diagnostic instead of crashing on subscribe.
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC ?? "";

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setPermission(Notification.permission);
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then((reg) => {
          if (!reg) return;
          return reg.pushManager.getSubscription();
        })
        .then((sub) => {
          if (sub) setSubscribed(true);
        })
        .catch(() => {
          // Browsers may throw if push isn't supported (older iOS). Show the
          // button anyway — the click handler surfaces a clearer error.
        });
    }
  }, []);

  async function enable(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      if (typeof Notification === "undefined") {
        setError("This browser does not support notifications.");
        return;
      }
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        setError(
          "Permission denied. Re-enable from your browser's site settings.",
        );
        return;
      }
      if (!("serviceWorker" in navigator)) {
        setError("Service workers are not supported in this browser.");
        return;
      }
      if (!vapidPublic) {
        setError(
          "VAPID public key is not configured (NEXT_PUBLIC_VAPID_PUBLIC). Add it to apps/web/.env.local and rebuild.",
        );
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      // `applicationServerKey` accepts `BufferSource`. We pass the
      // underlying ArrayBuffer to dodge a TS DOM-lib quirk where
      // `Uint8Array<ArrayBufferLike>` doesn't structurally satisfy
      // `BufferSource` (the lib types restrict to ArrayBuffer-not-Shared).
      const appKey = urlBase64ToUint8Array(vapidPublic);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appKey.buffer as ArrayBuffer,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        setError(`Failed to register subscription: ${res.status}`);
        return;
      }
      setSubscribed(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p style={{ marginTop: "1rem" }}>
        Status: <strong>permission = {permission}</strong>,{" "}
        subscribed = <strong>{subscribed ? "yes" : "no"}</strong>
      </p>
      {!subscribed && (
        <button
          onClick={() => void enable()}
          disabled={loading}
          style={{
            padding: "0.6rem 1rem",
            borderRadius: 6,
            border: "1px solid #888",
            background: "#fff",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Enabling..." : "Enable push notifications"}
        </button>
      )}
      {subscribed && (
        <p style={{ color: "#0a7" }}>
          Subscribed. You will get notified when drafts are ready or strategy
          updates land.
        </p>
      )}
      {error && (
        <p style={{ color: "crimson", marginTop: "1rem" }}>{error}</p>
      )}
      <p style={{ color: "#888", fontSize: "0.875em", marginTop: "2rem" }}>
        Phase 2 P2-F ships the subscription + delivery plumbing. Notifications
        currently appear as a generic &ldquo;Check ShipFlare&rdquo; message;
        encrypted payloads with specific content arrive in P2-F.2.
      </p>
    </div>
  );
}

/**
 * Convert a base64url-encoded VAPID public key into the Uint8Array
 * `pushManager.subscribe` expects as `applicationServerKey`.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}
