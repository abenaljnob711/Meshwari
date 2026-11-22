const CACHE_NAME = "meshwari-shell-v2";
const APP_SHELL = ["/", "/admin.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

async function cacheSuccessfulResponse(request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith("meshwari-shell-") && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache API responses, non-GET requests, or third-party map/search tiles.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    request.headers.has("range")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        event.waitUntil(cacheSuccessfulResponse(request, response));
        return response;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fallback = url.pathname === "/admin.html" ? "/admin.html" : "/";
        return (await caches.match(fallback)) || Response.error();
      }
    })());
    return;
  }

  // Serve cached same-origin assets immediately while refreshing them in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    const refresh = fetch(request).then(response => {
      event.waitUntil(cacheSuccessfulResponse(request, response));
      return response;
    });

    if (cached) {
      event.waitUntil(refresh.catch(() => undefined));
      return cached;
    }

    try {
      return await refresh;
    } catch (error) {
      return Response.error();
    }
  })());
});
