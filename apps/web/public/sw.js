/**
 * ShipFlare service worker — Web Push event handler (P2-F).
 *
 * Three event lifecycles:
 *  - install / activate: claim clients immediately so the SW takes effect
 *    on the same page that registered it (no second navigation needed).
 *  - push: show a notification. P2-F sends empty bodies (encrypted payload
 *    support arrives in P2-F.2); we display a generic "Check ShipFlare"
 *    message and stash the click-through URL in `notification.data`.
 *  - notificationclick: open / focus a ShipFlare tab and navigate.
 *
 * No imports — service workers run in their own global scope and Next.js
 * serves this file from `public/sw.js` verbatim.
 */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Default for the P2-F empty-body path. Will be overwritten if a future
  // P2-F.2 encrypted payload arrives carrying JSON {title, body, url}.
  let payload = { title: "ShipFlare", body: "Check your dashboard.", url: "/chat" };
  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        title: parsed.title || payload.title,
        body: parsed.body || payload.body,
        url: parsed.url || payload.url,
      };
    } catch {
      // Empty / non-JSON payload — fall through to the default.
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/favicon.ico",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/chat";
  event.waitUntil(
    (async () => {
      // If a ShipFlare tab is already open, focus it + navigate; otherwise
      // open a new one. This avoids spawning duplicate tabs on every click.
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of allClients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(url);
            } catch {
              // Some browsers reject cross-document navigation; fall back to openWindow.
              await self.clients.openWindow(url);
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
