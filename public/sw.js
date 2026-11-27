const CACHE_NAME = "meshwari-shell-v4";
const MAP_TILE_CACHE = "meshwari-map-tiles-v1";
const MAP_LIBRARY_CACHE = "meshwari-map-library-v1";
const APP_SHELL = ["/", "/index.html", "/admin.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const MAX_MAP_TILES = 180;
const NETWORK_TIMEOUT_MS = 12000;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(APP_SHELL.map(async path => {
      try {
        const response = await fetch(path, { cache: "reload" });
        if (response.ok) await cache.put(path, response);
      } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith("meshwari-shell-") && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT_MS, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

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

  const isLeaflet = url.hostname === "unpkg.com" && /^\/leaflet@1\.9\.4\/dist\/leaflet\.(?:js|css)$/.test(url.pathname);
  const isTailwind = url.hostname === "cdn.tailwindcss.com";
  if (isLeaflet || isTailwind) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_LIBRARY_CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      try {
        const response = await fetchWithTimeout(request);
        if (response && (response.ok || response.type === "opaque")) {
          try { await cache.put(request, response.clone()); } catch (_) {}
        }
        return response;
      } catch (_) {
        return new Response("", { status: 503, statusText: "Library unavailable offline" });
      }
    })());
    return;
  }

  if (/^(?:[abc]\.)?tile\.openstreetmap\.org$/.test(url.hostname) && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_TILE_CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      try {
        const response = await fetchWithTimeout(request);
        if (response && (response.ok || response.type === "opaque")) {
          try {
            await cache.put(request, response.clone());
            await trimMapTileCache(cache);
          } catch (_) {}
        }
        return response;
      } catch (_) {
        return new Response("", { status: 503, statusText: "Map tile unavailable offline" });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin ||
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/socket.io/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Always revalidate the document with the origin; do not reuse an old browser HTTP cache entry.
        const response = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS, { cache: "no-store" });
        if (response.ok) {
          await cache.put("/", response.clone());
          await cache.put("/index.html", response.clone());
          if (url.pathname === "/admin.html") await cache.put("/admin.html", response.clone());
        }
        return response;
      } catch (_) {
        const fallbackPath = url.pathname === "/admin.html" ? "/admin.html" : "/";
        return (await cache.match(fallbackPath)) ||
          (await cache.match(fallbackPath === "/" ? "/index.html" : "/")) ||
          new Response("التطبيق غير متاح حالياً. افتح الصفحة بعد عودة الاتصال بالإنترنت.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
      }
    })());
    return;
  }

  if (!/\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|json|webmanifest)$/i.test(url.pathname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetchWithTimeout(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
