/**
 * `/notifications` — founder opts the browser in to Web Push (P2-F).
 *
 * Server component is a thin wrapper. The actual permission prompt /
 * service-worker registration / subscription POST happens in the client
 * component (`browser APIs only run in the browser`). Auth gate lives in
 * `(app)/layout.tsx`.
 */

import NotificationsClient from "./_components/notifications-client";

export default function NotificationsPage() {
  return (
    <div>
      <h1>Notifications</h1>
      <p style={{ color: "#666" }}>
        Enable browser push notifications so your CMO can ping you when a draft
        is ready for review, a strategic path is committed, or something else
        important happens. Works in any browser that supports the Web Push API
        (Chrome, Firefox, Edge, Safari 16.4+).
      </p>
      <NotificationsClient />
    </div>
  );
}
