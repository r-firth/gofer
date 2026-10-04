// Only the connection screen is stored offline. Workspace data and app builds
// always come from the server, so installation cannot pin an old frontend.
const CACHE = "hub-offline-v2";
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/offline.html"]))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("hub-offline-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    request.mode !== "navigate" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  )
    return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status >= 500)
          throw new Error("Gofer unavailable");
        return response;
      })
      .catch(async () =>
        (await caches.open(CACHE)).match("/offline.html").then(
          (response) =>
            response ||
            new Response(
              "Gofer is unreachable. Connect to Tailscale and try again.",
              {
                status: 503,
                headers: { "Content-Type": "text/plain; charset=utf-8" },
              },
            ),
        ),
      ),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { /* Show a generic alert for malformed payloads. */ }
  event.waitUntil(self.registration.showNotification(
    typeof data.title === "string" ? data.title.slice(0, 160) : "Gofer",
    { body: typeof data.body === "string" ? data.body.slice(0, 300) : "There’s an update in your workspace.", icon: "/icons/hub-192.png", badge: "/icons/hub-192.png", tag: typeof data.tag === "string" ? data.tag : "workspace", data: {chat_id: typeof data.chat_id === "string" ? data.chat_id : ""} }
  ));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chat = event.notification.data?.chat_id || "";
  const url = new URL("/", self.location.origin); if (chat) url.searchParams.set("chat", chat);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(url.href); await existing.focus(); }
    else await self.clients.openWindow(url.href);
  })());
});
