// Service worker for the Suikoden III Save Editor PWA.
//
// Goal: installable on Android + usable offline after the first successful load.
// Strategy:
//   - same-origin (app shell + ../Editor/ python & reference files): network-first,
//     falling back to cache when offline. Keeps dev edits fresh yet works offline.
//   - cross-origin (the Pyodide CDN — large, immutable, version-pinned URLs):
//     cache-first, so the ~10MB runtime downloads once and is instant thereafter.
const CACHE = "s3editor-v14";
const SHELL = [
  "./", "./index.html", "./style.css", "./recruit-core.js", "./rename-core.js", "./vcdiff.js", "./app.js", "./iso.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  const keep = [CACHE, SHARE_CACHE];      // never purge a pending shared-in file
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const SHARE_CACHE = "s3editor-share";   // must match app.js

// ---- streaming download (the ISO editor's Android/Firefox "save patched ISO") -------------
// A patched ~4 GB ISO can't be held in memory, and Android has no showSaveFilePicker. The page
// builds a ReadableStream (the source disc with the edited ~3.75 MB region spliced in) and
// transfers it here; we serve it as a file download from a same-origin URL, streamed straight
// to the device with backpressure. Fully local — nothing is uploaded, no third-party helper.
const DL = new Map();   // id -> { stream, filename, size }
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "dl-register" && d.id && d.stream) {
    DL.set(d.id, { stream: d.stream, filename: d.filename || "patched.iso", size: d.size || 0 });
    if (e.ports && e.ports[0]) e.ports[0].postMessage("ok");   // ack so the page can start the download
  }
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  // Streaming download hand-off: serve a previously-registered patched-ISO stream as a file.
  const dlUrl = new URL(req.url);
  if (req.method === "GET" && dlUrl.pathname.includes("/_dl/")) {
    const id = dlUrl.pathname.split("/_dl/")[1];
    const entry = DL.get(id);
    if (entry) {
      DL.delete(id);
      const headers = { "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${String(entry.filename).replace(/"/g, "")}"` };
      if (entry.size) headers["Content-Length"] = String(entry.size);
      e.respondWith(new Response(entry.stream, { headers }));
      return;
    }
    e.respondWith(new Response("gone", { status: 404 }));
    return;
  }
  // Web Share Target: a save shared into the installed PWA arrives as a POST. Stash the
  // file, then redirect to the app which picks it up (?shared=1). See app.js pickupSharedFile.
  if (req.method === "POST" && new URL(req.url).pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get("save");
        if (file) {
          const c = await caches.open(SHARE_CACHE);
          await c.put("shared-save", new Response(file,
            { headers: { "X-Filename": encodeURIComponent(file.name || "shared.bin") } }));
        }
      } catch (err) { /* ignore — app just shows the loader */ }
      return Response.redirect("./?shared=1", 303);
    })());
    return;
  }
  if (req.method !== "GET") return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (sameOrigin) {
      try {
        // no-store: bypass the browser HTTP cache so each online launch pulls the freshest app
        // shell/engine (GitHub Pages sets max-age; without this, updates can lag ~10 min).
        const res = await fetch(req, { cache: "no-store" });
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
