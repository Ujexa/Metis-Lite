const CACHE = "metis-lite-shell-v2";
const SHELL_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/metis.svg",
  "/icons/metis-192.png",
  "/icons/metis-512.png",
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  const navigation = request.mode === "navigate";
  const asset = ["script", "style", "font", "image"].includes(request.destination);
  if (!navigation && !asset) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok && response.type === "basic") {
          void caches.open(CACHE).then(cache => cache.put(request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(request)) || (navigation ? await cache.match("/") : undefined) || Response.error();
      })
  );
});
