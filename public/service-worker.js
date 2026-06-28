const CACHE_NAME = "qropt-v2";
const BASE = new URL("./", self.location).pathname;
const APP_SHELL = [BASE, `${BASE}index.html`, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
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

  if (request.mode === "navigate") {
    event.respondWith(fetchAndCache(request).catch(() => caches.match(`${BASE}index.html`)));
    return;
  }

  event.respondWith(fetchAndCache(request).catch(() => caches.match(request)));
});

async function fetchAndCache(request) {
  const response = await fetch(request);
  const shouldCache = response.ok && new URL(request.url).origin === self.location.origin;

  if (shouldCache) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }

  return response;
}
