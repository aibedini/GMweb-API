/*
 * web-01 Service Worker (§4/§5/§30/§45) — wake-up receiver, NOT a transport.
 *
 * Push payloads are CONTENT-LESS ({type:"sync.available"}) per the §30
 * privacy default: the notification says nothing about any message; tapping
 * it opens the PWA which cursor-syncs. Safari/iOS requires every push to
 * surface a visible notification — this satisfies that while revealing
 * nothing.
 */

self.addEventListener("install", (event) => {
  // No precache yet — the shell is server-rendered at /web; caching strategy
  // (offline shell §4) lands with the Phase 4 offline PR.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const newEvents = typeof data.newEvents === "number" ? data.newEvents : 0;
  const title = "Messages";
  const body =
    newEvents > 0
      ? `${newEvents} new event${newEvents === 1 ? "" : "s"} — open to sync`
      : "Open Messages to sync";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // §30: no sender/preview in the default — nothing sensitive on the lock screen.
      silent: false,
      tag: "gmweb-sync", // collapse bursts into one visible notification
      data: { url: "/web/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/web/";
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        if (new URL(client.url).pathname.startsWith("/web")) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
