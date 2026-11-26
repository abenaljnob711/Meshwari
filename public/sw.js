const CACHE_NAME = "meshwari-shell-v2";
const MAP_TILE_CACHE = "meshwari-map-tiles-v1";
const MAP_LIBRARY_CACHE = "meshwari-map-library-v1";
const APP_SHELL = ["/", "/admin.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const MAX_MAP_TILES = 180;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => ![CACHE_NAME, MAP_TILE_CACHE, MAP_LIBRARY_CACHE].includes(key)).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function trimMapTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_MAP_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_MAP_TILES).map(key => cache.delete(key)));
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Keep Leaflet itself available after its first successful download.
  if (url.hostname === "unpkg.com" && /^\/leaflet@1\.9\.4\/dist\/leaflet\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_LIBRARY_CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      const response = await fetch(request);
      if (response && response.ok) await cache.put(request, response.clone());
      return response;
    })());
    return;
  }

  // Cache only tiles the user has actually viewed; never pre-download map areas.
  if (/^(?:[abc]\.)?tile\.openstreetmap\.org$/.test(url.hostname) && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_TILE_CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      try {
        const response = await fetch(request);
        if (response && (response.ok || response.type === "opaque")) {
          await cache.put(request, response.clone());
          await trimMapTileCache(cache);
        }
        return response;
      } catch (_) {
        return new Response("", { status: 503, statusText: "Map tile unavailable offline" });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || (await caches.match(url.pathname === "/admin.html" ? "/admin.html" : "/"))));
    return;
  }
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
