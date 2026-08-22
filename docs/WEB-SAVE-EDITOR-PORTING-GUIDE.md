# Porting Guide — Client-Side Web Save Editor (Pyodide + GitHub Pages + Android PWA)

This is a complete, self-contained recipe for taking an existing **desktop save editor**
and giving it a **browser-based, install-on-Android, zero-upload** twin — without
rewriting the save logic. It was extracted from the working implementation in the
**Suikoden III Editor** (`TheSparda/Suikoden-3-Editor`, folder `web/`, live at
`https://thesparda.github.io/Suikoden-3-Editor/web/`).

Hand this file to whoever is building the equivalent for **Eiyuden Chronicle**,
**Suikoden Tactics**, **Suikoden IV**, and **Suikoden V**. Follow it top-to-bottom.

---

## 0. What you are building and why it works

**The product:** one static web page that opens a save file the user picks, lets them
edit it, and downloads the edited save back. It runs entirely in the browser. The save
file never leaves the device. It installs to an Android home screen and works offline.

**The trick that makes it cheap:** you do **not** reimplement the save logic in
JavaScript. You run your *existing* Python save module **unchanged** inside
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). The uploaded save is
written into Pyodide's in-memory filesystem, and you call your module's normal
**path-based** `read`/`write` functions exactly as the desktop server does. The edited
bytes are read straight back out of the in-memory FS and handed to the browser as a
download. Checksums, ECC, container formats — all handled by the code you already trust.

```
┌── browser (github.io, HTTPS) ─────────────────────────────────────────┐
│  index.html + app.js + style.css                                       │
│      │                                                                  │
│      ├─ loadPyodide()  ──► CPython in WASM                              │
│      ├─ fetch ../<editor>/savemodule.py  ──► write to Pyodide FS        │
│      ├─ user picks save ──► write bytes to  /save.bin  (Pyodide MEMFS)  │
│      ├─ py: read_all_saves('/save.bin')   ──► decode → JSON → render UI │
│      ├─ py: write_save_edits('/save.bin', …edits…)  ──► edits in MEMFS  │
│      └─ read /save.bin back ──► Blob ──► download  <name>.edited.<ext>  │
└────────────────────────────────────────────────────────────────────────┘
```

**Hard precondition:** your save-editing logic must be (or must be extracted into) a
**pure-Python, stdlib-only module** with **path-based** entry points. See §1. If your
editor's save logic lives in C#/JS/anything else, you must first extract it to such a
module, or reimplement it in JS (this guide's Pyodide path won't run non-Python code).

---

## 1. Assess your editor first (go / no-go)

Answer these before writing any web code. The Suikoden III answers are shown as the
reference.

| Question | Why it matters | S3 reference |
|---|---|---|
| Is the save logic a Python module? | Pyodide runs Python only. | `Editor/s3save.py` |
| Is it **stdlib-only** (no numpy/pydantic/C-ext)? | Pure-Python + a handful of stdlib modules load in Pyodide with zero extra work. | imports: `struct, os, glob, shutil, zlib, re, io, json` — all in Pyodide |
| Are there **path-based** read/write funcs? | You feed them a MEMFS path; no refactor needed. | `read_all_s3_saves(path)`, `write_save_edits(path, folder, edits, …)` |
| Does read return **plain data** (dict/list) you can `json.dumps`? | Crosses the JS boundary as JSON. | `decode_save()` → nested dict |
| Does the module avoid needing the game ISO/disc? | Saves must be editable standalone. | S3 save logic is fully ISO-independent |
| Where do **display names** come from (items/skills/chars)? | You'll fetch + parse the same tables for dropdowns. | `Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt`, `s3_names.json` |

**Check stdlib-only quickly:**
```bash
grep -rhoE '^\s*(import|from)\s+[a-zA-Z0-9_]+' path/to/savemodule.py | sort -u
```
Every name must be a Python **standard library** module. If you see third-party
packages, either remove them or confirm they're
[pure-Python wheels Pyodide can load](https://pyodide.org/en/stable/usage/packages-in-pyodide.html).

**If the module writes `.bak` files or mutates paths next to the source:** make sure the
write function accepts a "no backup" flag (e.g. `make_backup=False`). In the browser the
original file is never touched (you download a *copy*), so backups are pointless and would
just litter MEMFS.

---

## 2. Per-game adaptation checklist

These are the only things that differ between games. Fill this table in for each editor
**before** copying the templates, then substitute throughout.

| Placeholder | Meaning | S3 value |
|---|---|---|
| `<GAME>` | Human name | `Suikoden III` |
| `<SLUG>` | Short id for caches/manifest | `s3editor` |
| `<EDITOR_DIR>` | Repo folder holding the Python module | `Editor/` |
| `<SAVE_MODULE>` | The stdlib Python save module filename | `s3save.py` |
| `<READ_FN>` | Path→list-of-saves decode function | `read_all_s3_saves` |
| `<WRITE_FN>` | Path+edits→writes-in-place function | `write_save_edits` |
| `<EDIT_KWARGS>` | The keyword args `<WRITE_FN>` accepts | `edits, inv_edits, name_edits, party_edits, recruit_edits, gold, make_backup` |
| `<REF_FILES>` | Name-table files to fetch for dropdowns | item ids, skill ids, char names |
| `<SAVE_FORMATS>` | Container formats the module sniffs | `.ps2/.mcd, .psu, .psv, .cbs, .xps, raw` |
| `<REPO>` | `owner/repo` on GitHub | `TheSparda/Suikoden-3-Editor` |

> **Format note per game.** Suikoden Tactics / IV / V are PS2 titles — expect the same
> family of containers as S3 (PS2 memory-card images `.ps2/.mcd`, `.psu`, `.psv`, plus
> cheat-device exports). **Eiyuden Chronicle** is a PC/modern-console game — its saves are
> a completely different format (Unity/`.sav`/JSON-ish blobs, often per-slot files, no PS2
> memory-card layer). The *web architecture is identical*, but your `<SAVE_MODULE>` and the
> "load a memory card containing multiple slots" assumption will differ: Eiyuden is more
> likely "one file = one save," so the slot-switcher UI may be unnecessary.

---

## 3. File layout

Create a `web/` folder at the repo root:

```
web/
  index.html              # shell + PWA <head> tags
  style.css               # theme (copy your desktop editor's palette)
  app.js                  # Pyodide bootstrap, glue, UI, PWA registration
  manifest.webmanifest    # PWA metadata
  sw.js                   # service worker (installable + offline)
  icons/
    icon-192.png
    icon-512.png
    icon-maskable-512.png # 512 with ~10% safe padding for Android masking
  README.md               # how to run/deploy this folder
.nojekyll                 # (repo root) tell GitHub Pages to serve files verbatim
```

The page fetches your Python module and reference files from `../<EDITOR_DIR>/…` at
runtime, so **the site must be served from the repo root** (see §8). Add a root-level
empty `.nojekyll` file so GitHub Pages doesn't run Jekyll (which can mangle or skip files,
especially anything beginning with `_`).

---

## 4. The engine: Pyodide bootstrap + in-memory round-trip

This is the heart of the port. It reuses your Python module verbatim. Adapt only the
`grab(...)` list, the glue functions, and the edit kwargs.

```js
// app.js  — core engine section
const SAVE_PATH = "/save.bin";        // where the upload lives in Pyodide MEMFS
let pyReady = null;                    // resolves to the pyodide instance
let REF = {};                          // parsed reference tables (names)
let saves = [], curSlot = 0, origName = "save.bin";

async function bootPyodide() {
  const py = await loadPyodide();      // from the CDN <script> in index.html
  const grab = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} (${r.status})`);
    return r;
  };
  // 1) Your real save module — unchanged — into Pyodide's FS:
  py.FS.writeFile("<SAVE_MODULE>", await (await grab("../<EDITOR_DIR>/<SAVE_MODULE>")).text());
  // 2) Reference/name tables (repeat per file in <REF_FILES>):
  py.FS.writeFile("items.txt", await (await grab("../<EDITOR_DIR>/<items file>")).text());
  py.FS.writeFile("skills.txt", await (await grab("../<EDITOR_DIR>/<skills file>")).text());
  py.FS.writeFile("names.json", await (await grab("../<EDITOR_DIR>/<names file>")).text());

  // 3) Thin Python glue so all byte-twiddling stays inside your trusted module.
  //    Import your module and expose JSON-in/JSON-out helpers.
  py.runPython(`
import json
import ${"<SAVE_MODULE>".replace(".py","")} as sav

def load_saves(path):
    out = []
    for dec in sav.<READ_FN>(path):
        # strip anything huge/unneeded before crossing to JS (e.g. raw byte dumps)
        for c in dec.get("characters", []):
            c.pop("raw", None)
        out.append(dec)
    return json.dumps(out)

def apply_edits(path, folder, payload_json):
    p = json.loads(payload_json)
    # JSON object keys are strings; convert the ones your writer expects as ints.
    edits = {int(k): v for k, v in (p.get("edits") or {}).items()}
    res = sav.<WRITE_FN>(
        path, folder, edits,
        make_backup=False,                      # never litter MEMFS
        # --- map the rest of your writer's kwargs from the payload ---
        inv_edits=(p.get("invEdits") or None),
        name_edits=(p.get("nameEdits") or None),
        party_edits=(p.get("partyEdits") or None),
        recruit_edits=(p.get("recruitEdits") or None),
        gold=p.get("gold"),
    )
    return json.dumps(res)
`);
  return py;
}

// Called when the user picks/drops a file.
async function handleFile(file) {
  const py = await pyReady;
  origName = file.name || "save.bin";
  py.FS.writeFile(SAVE_PATH, new Uint8Array(await file.arrayBuffer()));
  saves = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
  if (!saves.length) return setDropMsg("No <GAME> save found in that file.", true);
  curSlot = 0;
  renderEditor();                       // your UI — see §6
}

// Called by the "Apply & download" button.
async function saveAndDownload(payload) {
  const py = await pyReady;
  const folder = saves[curSlot].folder; // whatever your reader used to key a slot
  const out = py.runPython(
    `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(folder)}, ` +
    `${JSON.stringify(JSON.stringify(payload))})`);
  const res = JSON.parse(out);
  if (res.error) return setStatus("Write failed: " + res.error, "err");
  downloadBytes(py.FS.readFile(SAVE_PATH), downloadName());   // pull edited bytes out
  // refresh the decoded view from the now-edited file so the UI matches disk:
  saves = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
  renderEditor();
}

function downloadName() {
  const dot = origName.lastIndexOf(".");
  const stem = dot > 0 ? origName.slice(0, dot) : origName;
  const ext  = dot > 0 ? origName.slice(dot)   : "";
  return `${stem}.edited${ext}`;
}
function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
```

**Key correctness points (do not skip):**

- **Never parse the container in JS.** Format sniffing, checksums, and (for PS2 memory
  cards) per-page ECC are done by your Python module. Sniffing is by *content*, not file
  extension, so writing bytes to `/save.bin` regardless of the real name is fine.
- **Pass `make_backup=False`.** The original upload is untouched; you download a copy.
- **JSON object keys are strings.** Convert to `int` in Python wherever your writer keys
  by roster index / slot number.
- **Strip big fields** (raw byte arrays, etc.) in `load_saves` before `json.dumps` — keeps
  the JS payload small and fast.

---

## 5. Reference/name tables (dropdowns show names, not raw ids)

Your desktop editor already resolves item/skill/character ids to names using some data
files. Reuse the **same files and the same parsing rules** so the web UI matches exactly.
Two options:

**A. Parse in Python glue (recommended — identical to desktop).** Copy your desktop's
small parser functions into the glue string and expose a `load_reference()` that returns
JSON. Example (S3's item/skill/name parsers):

```python
import json, re

def _item_ids(t):     # 'HHH<TAB>Name' pairs
    return {int(m.group(1),16): m.group(2).strip()
            for m in re.finditer(r"\\b([0-9A-Fa-f]{3})\\t([^\\t\\n\\r]+)", t)}
def _item_cats(t):    # '*** Category ***' section headers → per-id category
    out, cur = {}, ""
    for line in t.splitlines():
        h = re.search(r"\\*\\s*(.+?)\\s*\\*", line)
        if h and "\\t" not in line: cur = h.group(1).strip(); continue
        for m in re.finditer(r"\\b([0-9A-Fa-f]{3})\\t([^\\t\\n\\r]+)", line):
            out[int(m.group(1),16)] = cur
    return out
def _skill_ids(t):    # 'NN Name' per line
    out = {}
    for line in t.splitlines():
        p = line.strip().split(None, 1)
        if len(p) == 2:
            try: out[int(p[0],16)] = p[1]
            except ValueError: pass
    return out

def load_reference():
    it = open("items.txt", encoding="latin1").read()
    ids, cats = _item_ids(it), _item_cats(it)
    items  = [{"id": k, "name": v, "cat": cats.get(k, "")} for k, v in sorted(ids.items())]
    skills = [{"id": k, "name": v} for k, v in sorted(_skill_ids(open("skills.txt", encoding="latin1").read()).items())]
    charById = json.load(open("names.json")).get("list1", {})
    return json.dumps({"items": items, "skills": skills, "charById": charById})
```

Then in JS after boot: `REF = JSON.parse(py.runPython("load_reference()"));` and build
`<option>` lists once, reusing them across renders. Category info (`cat`) lets you filter
equipment dropdowns to the right item type per slot.

**B. Parse in JS.** Fine too, but you risk drifting from the desktop's parsing rules.
Prefer A.

---

## 6. The UI (index.html + app.js render + style.css)

Build the UI **incrementally** — prove the pipeline first, then reach feature parity.

**Milestone 1 — prove the round-trip.** Load a save; edit one obvious field (gold/money);
Apply & download; re-read the downloaded file through the module and confirm the change +
valid checksum. Do this before building anything else. It de-risks the whole port.

**Milestone 2 — full parity.** Mirror your desktop save editor's screens. For S3 that was:
Overview (names, money, story meta), Characters (level/HP/stats, equipment via
category-filtered name dropdowns, skills with rank, recruitment), Party, and Inventory
(per-bag, add/remove, name dropdowns). Your game's tabs will differ — mirror whatever the
desktop tool exposes, feeding the same edit dicts to `<WRITE_FN>`.

**Edit-accumulation model that works well:** keep per-slot pending-edit objects
(`EDITS`, `INV`, `NAMES`, …) reset on slot switch; each input's `onchange` writes into
them and toggles a `.dirty` class by comparing to a `data-def` (loaded) value. On
"Apply", assemble the payload from those objects and call `saveAndDownload(payload)`.

**index.html shell** (note the PWA tags in `<head>`):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#17110d">
  <title><GAME> Save Editor (Web)</title>
  <link rel="stylesheet" href="style.css">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="icons/icon-192.png">
</head>
<body>
  <div class="wrap">
    <header>
      <h1><GAME> Save Editor</h1>
      <button id="installBtn" class="chip hidden" style="margin-left:auto">⬇ Install app</button>
    </header>
    <div class="card" id="loaderCard">
      <div class="drop" id="drop">
        <div><b>Drop a save file here</b> or</div>
        <label class="file"><button type="button" id="pickBtn" disabled>Choose file…</button>
          <input type="file" id="file"></label>
        <div class="muted" id="engineStatus"><span class="spinner"></span>Starting Python engine…</div>
        <div class="muted">Supports <SAVE_FORMATS>.</div>
      </div>
    </div>
    <div id="editor"></div>
    <footer>
      <span class="credit">Made by <b><AUTHOR></b> ·
        <a href="https://github.com/<REPO>" target="_blank" rel="noopener noreferrer">GitHub</a>
        · <VERSION></span>
    </footer>
  </div>
  <script src="https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

> **Pin the Pyodide version** (here `v0.26.2`) in both the `<script>` URL and (if you
> precache it) the service worker. Bumping it later is a deliberate one-line change.

**style.css — match your desktop editor.** Copy your desktop app's CSS custom properties
(the `:root` palette, fonts, accent colors) verbatim so the web app looks like the same
product. If your desktop app has light/dark themes, port them as a class toggle on
`<html>` (not `<body>` — so the background covers the full viewport) and persist the choice
in `localStorage`:

```js
function applyTheme(t) {
  document.documentElement.classList.toggle("theme-light", t === "light");
  try { localStorage.setItem("<SLUG>-theme", t); } catch (e) {}
}
```

**Boot wiring (end of app.js):**

```js
window.addEventListener("DOMContentLoaded", () => {
  // file input + drag/drop
  const drop = document.getElementById("drop");
  const fileInput = document.getElementById("file");
  const pickBtn = document.getElementById("pickBtn");
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // start the engine
  pyReady = bootPyodide().then(py => {
    REF = JSON.parse(py.runPython("load_reference()"));  // if using §5A
    setDropMsg("Python engine ready — load a save file.", false);
    pickBtn.disabled = false;
    return py;
  }).catch(e => { setDropMsg("Engine failed to start: " + e.message, true); throw e; });

  registerPWA();   // see §7
});
```

---

## 7. PWA: installable on Android + offline

Three files + a bit of JS. Copy verbatim, substituting `<GAME>`/`<SLUG>`/colors.

**`manifest.webmanifest`:**

```json
{
  "name": "<GAME> Save Editor",
  "short_name": "<SLUG>",
  "description": "Edit <GAME> saves entirely on your device.",
  "start_url": ".",
  "scope": ".",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#17110d",
  "theme_color": "#17110d",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

**`sw.js` — service worker.** Strategy: same-origin app shell + your `../<EDITOR_DIR>/`
Python & reference files are **network-first** (fresh when online, cached fallback when
offline); the large, version-pinned **Pyodide CDN** assets are **cache-first** (download
once, instant thereafter).

```js
const CACHE = "<SLUG>-v1";                 // bump this string to force a cache refresh
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
    if (sameOrigin) {                              // network-first
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
    const hit = await cache.match(req);            // cross-origin: cache-first
    if (hit) return hit;
    const res = await fetch(req);
    if (res && res.status === 200 && (res.type === "basic" || res.type === "cors")) {
      cache.put(req, res.clone());
    }
    return res;
  })());
});
```

**Registration + custom install button (in app.js):**

```js
function registerPWA() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));
  }
  const installBtn = document.getElementById("installBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let deferredPrompt = null;
  if (!standalone) {
    window.addEventListener("beforeinstallprompt", (e) => {   // Chrome/Android only
      e.preventDefault();
      deferredPrompt = e;
      installBtn.classList.remove("hidden");
    });
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add("hidden");
    };
    window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
  }
}
```

**Icons.** Provide `icon-192.png`, `icon-512.png`, and a **maskable** `icon-512.png` with
~10% transparent padding around the art (Android crops maskable icons to various shapes).

**Offline reality check.** The app shell caches fully. Pyodide core caches after first
online run. *Pyodide may still lazily fetch stdlib packages on demand* (e.g. the first
time your module imports something); those get cached as they're requested, so the
reliable rule is: **first run must be online; after that it works offline.** If you need
guaranteed cold-offline, precache Pyodide's package files explicitly — heavier, usually
not worth it.

---

## 8. GitHub Pages hosting

The app fetches `../<EDITOR_DIR>/<SAVE_MODULE>` and the reference files at runtime, so
**Pages must serve from the repo root** (not `/web` as the site root), and the repo must
be **public** (or you need Pages on a paid plan).

**Add `.nojekyll`** at the repo root (empty file) and commit it, so Pages serves `.py`
and any `_`-prefixed files verbatim:

```bash
touch .nojekyll && git add .nojekyll && git commit -m "Pages: serve files verbatim (.nojekyll)"
```

**Enable Pages — CLI (fastest):** deploy from the `main` branch, root folder:

```bash
gh api -X POST /repos/<REPO>/pages \
  -H "Accept: application/vnd.github+json" \
  -f 'source[branch]=main' -f 'source[path]=/'
```

**Enable Pages — web UI:** repo **Settings → Pages → Build and deployment → Source:
"Deploy from a branch" → Branch: `main` / `/ (root)` → Save**.

Your site will be at:
```
https://<owner>.github.io/<repo-name>/web/
```
(For S3: `https://thesparda.github.io/Suikoden-3-Editor/web/`.)

**Triggering a rebuild:**
- **Automatic:** every push to `main` triggers a Pages rebuild. This is the normal path —
  you rarely do anything manual.
- **Manual (no new commit):**
  ```bash
  gh api -X POST /repos/<REPO>/pages/builds
  ```
- **Check status:**
  ```bash
  gh api /repos/<REPO>/pages/builds/latest \
    --jq '.status + " | commit " + (.commit // "?")[0:7] + " | " + (.error.message // "no error")'
  ```
  Wait for `status: built`. First deploy can take a couple of minutes.

**Custom domain (optional):** Settings → Pages → Custom domain, add a `CNAME` DNS record,
and commit a `CNAME` file. Not required.

---

## 9. Verification (do this before calling it done)

**Local:** serve the **repo root** so `../<EDITOR_DIR>/…` resolves:
```bash
python3 -m http.server 8791
# open http://localhost:8791/web/
```
Then:
1. Engine reaches "ready"; no console errors.
2. Load each `<SAVE_FORMATS>` you support; confirm decode renders.
3. **Round-trip proof:** edit fields across every category, Apply & download, then re-read
   the downloaded bytes through the module and assert each change persisted **and the
   checksum recomputed**. Automate it in the browser console, e.g.:
   ```js
   // after making edits and applying:
   const py = await pyReady;
   const v = JSON.parse(py.runPython(`json.dumps(sav.<READ_FN>('/save.bin')[0])`));
   console.log(v.global.gold, v.checksumWord);   // compare to what you set
   ```
4. Multi-slot containers: confirm slot switching (if applicable).

**Live:** after Pages says `built`, `curl -I` each critical URL and confirm `200`:
```bash
for u in web/ web/app.js web/sw.js web/manifest.webmanifest \
         <EDITOR_DIR>/<SAVE_MODULE> <EDITOR_DIR>/<items file>; do
  echo "$(curl -s -o /dev/null -w '%{http_code}' "https://<owner>.github.io/<repo>/$u")  $u"
done
```
Then load it on an actual Android phone, install via the button (or ⋮ → Install app), and
confirm it opens offline on the second launch.

---

## 10. Android end-user flow (put this in your README)

1. Open the Pages URL in Chrome on Android. First load pulls the Pyodide runtime
   (~10 MB) — wait for "engine ready."
2. Tap **⬇ Install app** to add it to the home screen (works offline after 2nd visit).
3. In your PS2 emulator (AetherSX2 / NetherSX2 / PCSX2), **export/copy the memory-card
   file** out to storage (or locate the app's memory-card image).
4. Open it in the web app → edit → **Apply & download** → the edited copy lands in
   Downloads.
5. Copy the edited file **back** into the emulator's memory-card location.
6. For Eiyuden / PC saves the middle steps differ (copy the save file from the game's save
   folder instead of a memory-card image), but load→edit→download→copy-back is the same.

---

## 11. Gotchas & troubleshooting

- **404 on `../<EDITOR_DIR>/<SAVE_MODULE>`:** Pages isn't serving from repo root, or the
  path/case is wrong. Fix the Pages source to `/ (root)` and check exact casing.
- **Blank page / Jekyll ate a file:** add the root `.nojekyll`.
- **`fetch(...).text()` on the `.py` works regardless of content-type** — don't fight the
  MIME type; you only need the source text.
- **Third-party import fails in Pyodide:** the module isn't stdlib-only. Remove the dep or
  load a pure-Python wheel via `micropip`. Re-check §1.
- **Numeric keys became strings:** you forgot `int(k)` in the glue. See §4.
- **Edits "don't stick":** you re-read from the wrong path, or `<WRITE_FN>` wrote a `.bak`
  instead of the target. Confirm you read back the exact `SAVE_PATH` and pass
  `make_backup=False`.
- **Install button never appears:** `beforeinstallprompt` fires only on HTTPS, only in
  Chromium, only when a valid manifest + registered SW exist, and only if not already
  installed. iOS Safari has no prompt — users install via Share → Add to Home Screen.
- **Stale app after deploy:** bump `CACHE` in `sw.js` (and hard-reload once) so old caches
  are purged.
- **Mixed content:** everything must be HTTPS. The Pyodide CDN is HTTPS; keep all fetches
  relative or HTTPS.
- **Large save payloads slow the UI:** strip raw byte arrays in `load_saves` (§4) and build
  `<option>` lists once, not per row.
- **Keep ISO/disc editing OUT of the web app.** It needs multi-GB assets and doesn't belong
  in a browser tool. Web = saves only.

---

## 12. Definition of done

- [ ] `web/` folder with the 5 files + icons, served from repo root.
- [ ] Reuses the existing stdlib Python save module unchanged via Pyodide.
- [ ] Round-trip verified across every supported format, checksums recomputed by the module.
- [ ] Feature parity with the desktop save editor (all editable categories).
- [ ] Styling matches the desktop editor; footer shows author + GitHub + version.
- [ ] PWA installs on Android and works offline after first load.
- [ ] GitHub Pages live; README documents the URL and the Android copy-in/out flow.
- [ ] `.nojekyll` committed; Pyodide version pinned.

---

*Reference implementation: `TheSparda/Suikoden-3-Editor` → `web/` (see its `web/README.md`).
The same four files (`index.html`, `style.css`, `app.js`, plus the PWA trio) are ~800 lines
total and took one focused session on top of an already-working Python save module.*
