
const CACHE_NAME = "meshwari-cache-v2";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png"
];

// تثبيت التطبيق وحفظ الملفات الأساسية المتاحة
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      await Promise.all(
        APP_FILES.map(async (file) => {
          try {
            const response = await fetch(file, { cache: "reload" });

            if (response.ok) {
              await cache.put(file, response);
            }
          } catch (error) {
            console.warn("تعذر تخزين الملف:", file);
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

// تفعيل الإصدار الجديد دون حذف مخازن الموقع الأخرى
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("meshwari-cache-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// الشبكة أولاً، ثم النسخة المحفوظة عند انقطاع الإنترنت
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/admin")
  ) {
    return;
  }

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);

        if (response && response.ok) {
          const copy = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, copy);
        }

        return response;
      } catch (error) {
        const cached = await caches.match(request);

        if (cached) {
          return cached;
        }

        if (request.mode === "navigate") {
          return (
            await caches.match("/index.html")
          ) || new Response("التطبيق غير متاح دون اتصال", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }

        return new Response("أنت غير متصل بالإنترنت", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    })()
  );
});
