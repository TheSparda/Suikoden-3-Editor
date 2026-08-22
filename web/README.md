# Web save editor (prototype — Option B)

A **fully client-side** Suikoden III save editor that runs in any modern browser,
including Android. It reuses the real, unmodified `Editor/s3save.py` by running
CPython in the browser via [Pyodide](https://pyodide.org) (WebAssembly).

Your save file **never leaves the device** — there is no server-side upload. This
makes it a natural fit for editing saves on the phone where you already play via a
PS2 emulator (AetherSX2 / NetherSX2 / PCSX2).

## How it works

1. Pyodide boots CPython in the browser and fetches `../Editor/s3save.py`.
2. Your uploaded save is written into Pyodide's in-memory filesystem at `/save.bin`.
3. The page calls the existing path-based functions unchanged —
   `read_all_s3_saves()` to decode and `write_save_edits()` to apply edits (with
   correct gamedata checksum and, for memory cards, per-page ECC).
4. The edited container is read back out of the in-memory FS and downloaded as
   `<name>.edited.<ext>`.

Because it drives the real module, every container the desktop editor supports works
here too: `.ps2` / `.mcd` memory cards, `.psu`, `.psv`, `.cbs`, SharkPort `.xps`,
and raw `gamedata`. The edited container is byte-identical to what the desktop tool
produces (same checksum, same ECC).

## Files

- `index.html` — page shell.
- `style.css` — styling.
- `app.js` — Pyodide bootstrap, reference-table parsing, and the full editor UI.

Reference data pulled from `../Editor/`: `s3save.py`, `Suikoden3_item_ids.txt`,
`Suikoden3_skill_ids.txt`, `s3_names.json`.

## Running locally

Serve the **repository root** (so `../Editor/s3save.py` resolves), then open `/web/`:

```bash
python3 -m http.server 8791
```

Then browse to `http://localhost:8791/web/`.

## Deploying on GitHub Pages

Yes — this hosts on GitHub Pages as-is. The page fetches `../Editor/s3save.py` plus the
three reference files (all committed to the repo), so it just needs to be served from the
repo root:

1. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Pick the branch (e.g. `main`) and folder **`/ (root)`**. Save.
3. The editor lives at `https://<user>.github.io/<repo>/web/`
   (e.g. `https://thesparda.github.io/Suikoden-3-Editor/web/`).

Pages serves over HTTPS, which the service worker and "Add to Home screen" require. On
Android, open that URL in Chrome and use the ⋮ menu → **Install app** / **Add to Home
screen**.

To ship `web/` as a standalone folder instead, copy `Editor/s3save.py`,
`Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt`, and `s3_names.json` next to `app.js`
and change the four `../Editor/` fetch paths in `app.js`.

## Installable PWA / offline

`manifest.webmanifest` + `sw.js` make it an installable Progressive Web App. On first visit
everything downloads from the network; the service worker then caches the app shell, the
`../Editor/` files, and the Pyodide runtime (`.wasm` / `.asm.js` / `python_stdlib.zip`), so
from the **second visit on it works fully offline** — handy on a phone with no signal.
`icons/` holds the home-screen icons (192, 512, and a 512 maskable).

An **"Install app"** button appears in the header only when the browser actually offers
installation (Chrome/Android's `beforeinstallprompt`) and is hidden once installed or when
already running standalone. iOS Safari has no such event — there, use Share → Add to Home
Screen.

### How an installed copy gets updates

Updates are **automatic whenever the phone is online** — an installed PWA is not a frozen
snapshot. The service worker serves same-origin files (`index.html`, `app.js`, `style.css`,
and the `../Editor/` files) **network-first**: each launch fetches the latest from GitHub
Pages and only falls back to the cached copy when offline. So pushing a new commit to the
Pages branch means users get it on their next online launch, with no reinstall.

Two caveats:
- The **Pyodide runtime** is cache-first and version-pinned (`v0.26.2` in `app.js`); it
  changes only when you bump that version, which points at fresh CDN URLs.
- Bumping `CACHE` in `sw.js` (e.g. `s3editor-v2`) forces the old offline cache to be purged
  on activation — do this when you want to guarantee stale *offline* copies are dropped.
  It isn't needed for online users, who are already network-first.

## Scope — full parity with the desktop save editor

The web UI covers everything the desktop save editor does:

- **Overview** — names, gold, playtime, story phase, party leader, Suikoden I/II carryover.
- **Characters** — level / cur HP / max HP / EXP, the 8 stats, equipped runes + armour
  (category-filtered, name-resolved dropdowns), 8 skill slots (id + rank), and recruitment
  (recruited toggle + "recruited by").
- **Party** — the active battle party (up to 6), by character name.
- **Inventory** — every bag (Hugo / Chris / Geddoe / Thomas / Storage), split into Party
  Items vs Key/Valuables, with name-resolved item dropdowns, quantities, add and remove.
- **Multi-slot** memory cards show a slot switcher.

Item / skill / character names come from the same reference files the desktop server uses
(`Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt`, `s3_names.json`, plus
`s3_item_desc.json` / `s3_skill_desc.json` for descriptions), parsed with the same rules and
fetched from `../Editor/` alongside `s3save.py`.

## Quality-of-life

- **Save in place** (desktop Chromium) — when you open a file via **Choose file…** or drag it
  in, the app keeps a writable handle (File System Access API), so "Apply & save to file"
  overwrites the original directly (a "Download copy" button stays available too). Browsers
  without the API — Android Chrome, Firefox, Safari — automatically fall back to
  "Apply & download". The original is only overwritten on an explicit save-to-file, after you
  confirm the change list and grant write permission.
- **Searchable pickers** — items, skills, equipment, and party members open a type-to-filter
  modal instead of a giant native dropdown (essential with 500+ items, especially on mobile).
  Rows show the id, name, in-game description, and category.
- **Review changes before writing** — "Apply" first shows an explicit *old → new* list of
  every field that will change, grouped by character / section. Confirm to download.
- **Unsaved-changes guard** — warns before you close or navigate away with pending edits.
- **Value hints** — number fields carry sensible min/max; the module still clamps to the
  real byte width on write.
- **Boot progress** — the first-load Pyodide download shows staged progress instead of a bare
  spinner.

**ISO patching stays desktop-only** — it needs the multi-GB ISO and does not belong in a
browser tool.
