/**
 * QROPT service worker.
 *
 * Navigations go network-first so a fresh deploy is picked up immediately and
 * fall back to the cached shell offline. Hashed build assets are immutable, so
 * they are served cache-first (this is what makes the app work offline after
 * the first visit).
 */
const CACHE_NAME = "qropt-v3";
const BASE = new URL("./", self.location).pathname;
const APP_SHELL = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (
      (await caches.match(request)) ??
      (await caches.match(`${BASE}index.html`)) ??
      new Response("Offline", { status: 503, statusText: "Offline" })
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  return cached ?? (await network) ?? new Response("Offline", { status: 503 });
}
