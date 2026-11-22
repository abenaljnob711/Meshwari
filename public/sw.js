const CACHE_NAME = "meshwari-shell-v3";
const APP_SHELL = ["/", "/admin.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

async function networkFirst(request, fallbackPath) {
  try {
    // Bypass the browser HTTP cache so a deployment is checked against the server.
    const networkRequest = new Request(request, { cache: "no-cache" });
    const response = await fetch(networkRequest);
    if (response && response.ok && response.type !== "opaque") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallbackPath) {
      const fallback = await caches.match(fallbackPath);
      if (fallback) return fallback;
    }
    return Response.error();
  }
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

  // Keep APIs, mutations, cross-origin map providers, and partial media out of the app-shell cache.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    request.headers.has("range")
  ) return;

  if (request.mode === "navigate") {
    const fallbackPath = url.pathname === "/admin.html" ? "/admin.html" : "/";
    event.respondWith(networkFirst(request, fallbackPath));
    return;
  }

  event.respondWith(networkFirst(request));
});
