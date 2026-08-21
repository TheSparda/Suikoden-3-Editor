// Service worker for the Suikoden III Save Editor PWA.
//
// Goal: installable on Android + usable offline after the first successful load.
// Strategy:
//   - same-origin (app shell + ../Editor/ python & reference files): network-first,
//     falling back to cache when offline. Keeps dev edits fresh yet works offline.
//   - cross-origin (the Pyodide CDN — large, immutable, version-pinned URLs):
//     cache-first, so the ~10MB runtime downloads once and is instant thereafter.
const CACHE = "s3editor-v1";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (sameOrigin) {
      try {
        const res = await fetch(req);
        if (res && res.status === 200) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = (await cache.match(req)) ||
          (req.mode === "navigate" ? await cache.match("./index.html") : null);
        if (hit) return hit;
        throw err;
      }
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.status === 200 && (res.type === "basic" || res.type === "cors")) {
      cache.put(req, res.clone());
    }
    return res;
  })());
});
