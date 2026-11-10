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
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    event.request.method !== "GET"
  )
    return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
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
      body:
        data.body === "A run finished."
          ? "A run finished."
          : "Pi needs your attention.",
      icon: "/icons/pi-192.png",
      data: { url },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "/"));
});
