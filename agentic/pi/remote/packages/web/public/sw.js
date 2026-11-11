const CACHE = "pi-remote-shell-v1";
const BUILD_ASSETS = [];
const STATIC = [
  ...BUILD_ASSETS,
  "/",
  "/manifest.webmanifest",
  "/icons/pi.svg",
  "/icons/pi-192.png",
  "/icons/pi-512.png",
  "/icons/pi-1024.png",
  "/icons/pi-touch-pixel-180.png",
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/fonts.css",
  "/startup.css",
  "/startup.js",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      ),
  ),
);
async function navigation(request) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      fetch(request, { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error("Unable to load public shell");
        const body = await response.arrayBuffer();
        const headers = new Headers(response.headers);
        headers.delete("Content-Length");
        headers.delete("Content-Encoding");
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Connection timed out"));
        }, 3000);
      }),
    ]);
  } catch {
    return (
      (await caches.match("/")) ||
      new Response("Pi Remote is offline. Reconnect to the internet and try again.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    event.request.method !== "GET"
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigation(event.request));
    return;
  }
  if (
    !STATIC.includes(url.pathname) &&
    !/^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)
  )
    return;
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        }),
    ),
  );
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {}
  const url =
    typeof data.url === "string" && /^\/session\/[0-9a-f-]{36}$/.test(data.url)
      ? data.url
      : "/";
  event.waitUntil(
    self.registration.showNotification("Pi Remote", {
      body: ["A run finished.", "A run failed."].includes(data.body)
        ? data.body
        : "Pi needs your attention.",
      icon: "/icons/pi-192.png",
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url =
        typeof event.notification.data?.url === "string" &&
        /^\/session\/[0-9a-f-]{36}$/.test(event.notification.data.url)
          ? event.notification.data.url
          : "/";
      const windows = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (existing) {
        existing.postMessage({ type: "notification-open", url });
        await existing.focus();
      } else await clients.openWindow(url);
      for (const notification of await self.registration.getNotifications())
        notification.close();
    })(),
  );
});
