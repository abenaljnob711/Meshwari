const CACHE_NAME = "meshwari-shell-v3";
const MAP_TILE_CACHE = "meshwari-map-tiles-v1";
const MAP_LIBRARY_CACHE = "meshwari-map-library-v1";
const APP_SHELL = ["/", "/admin.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const MAX_MAP_TILES = 180;
const NETWORK_TIMEOUT_MS = 5000;

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
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => ![CACHE_NAME, MAP_TILE_CACHE, MAP_LIBRARY_CACHE].includes(key)).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function fetchWithTimeout(request, timeout = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(request, { signal: controller.signal });
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

  // Cache Leaflet (CORS) and Tailwind (often opaque no-cors) after a successful download.
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

  // Cache only tiles the user has actually viewed; never pre-download map areas.
  if (/^(?:[abc]\.)?tile\.openstreetmap\.org$/.test(url.hostname) && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(MAP_TILE_CACHE);
      const saved = await cache.match(request);
      if (saved) return saved;
      try {
        const response = await fetchWithTimeout(request);
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
    event.respondWith((async () => {
      try {
        const response = await fetchWithTimeout(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      } catch (_) {
        return (await caches.match(request)) ||
          (await caches.match(url.pathname === "/admin.html" ? "/admin.html" : "/")) ||
          new Response("التطبيق غير متاح حالياً. افتح الصفحة بعد عودة الاتصال بالإنترنت.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
