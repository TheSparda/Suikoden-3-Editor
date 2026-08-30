# `web/` — the browser editor

The **primary** Suikoden III editor: a fully client-side app with two modes — a **Save
Editor** and an **ISO Editor** — deployed to GitHub Pages at
<https://thesparda.github.io/Suikoden-3-Editor/web/>. New work lands here first; the Python
app in `Editor/` is the legacy local build.

Nothing is uploaded. Saves and ISOs are read and written on the device only, which is what
makes it usable on the phone you already emulate on (AetherSX2 / NetherSX2 / PCSX2).

For the user-facing feature list, see the [root README](../README.md). This file covers how
the folder is put together.

## The two engines

**Save Editor — the real Python module, in the browser.** [Pyodide](https://pyodide.org)
boots CPython (WebAssembly) and runs `../Editor/s3save.py` *unmodified*:

1. Pyodide fetches `s3save.py`; your file is written into its in-memory FS at `/save.bin`.
2. The page calls the existing path-based functions unchanged — `read_all_s3_saves()` to
   decode, `write_save_edits()` to apply (correct gamedata checksum, and per-page ECC for
   memory cards).
3. The edited container is read back out and saved in place, downloaded, or shared.

So every container the desktop editor supports works here, byte-identically: `.ps2` / `.mcd` /
`.mc2` / `.bin` memory cards, `.psu`, `.psv`, SharkPort `.sps` / `.xps`, `.cbs`, and raw
`gamedata`.

**ISO Editor — a JS port.** `iso.js` is a client-side port of `Editor/s3patch.py` +
`s3fields.py`. It reads only the ~3.75 MB executable region, verifies a USA `SLUS-20387`
image, and never loads the multi-GB file. Saving is per-browser: Chromium desktop writes the
changed bytes **in place** (File System Access API); elsewhere it **streams a patched copy**
to downloads through the service worker (a ~4 GB image can't be held in memory), or exports a
`.s3mod` recipe / `.xdelta` patch. It also *applies* both formats, sniffed by content.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell: mode tabs, loader, footer (version string lives here) |
| `style.css` | All styling, plus the two themes (Crimson & Gold / Parchment) |
| `app.js` | Pyodide bootstrap, reference-table parsing, and the whole save-editor UI |
| `iso.js` | The ISO editor: field tables, all 16 views, staging, save/patch paths |
| `recruit-core.js` | Recruit bit math (recruited flag + per-team bits), shared by UI and tests |
| `rename-core.js` | Same-length disc-wide character rename used by the streaming save |
| `guide-core.js` | Joins Suikosource guide data onto characters by name (overlay notes) |
| `health-core.js` | Save-rule constants (item stackability, field caps, slot categories) + the health audit |
| `text-core.js` | In-ELF string scanner + prose filter for the Text tab |
| `vcdiff.js` | `.xdelta` (RFC 3284 VCDIFF) encoder **and** decoder |
| `sw.js` | Service worker: offline cache, share target, streaming ISO download |
| `manifest.webmanifest`, `icons/` | PWA install metadata and home-screen icons |
| `tests/` | Node checks + Playwright e2e — see [`tests/README.md`](tests/README.md) |

Reference data is fetched from `../Editor/` rather than duplicated: `s3save.py`,
`Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt`, `s3_names.json`, `s3_item_desc.json`,
`s3_skill_desc.json`, `s3_rune_food_desc.json`, `s3_skill_ref.json`, `s3_skill_caps.json`,
`s3_growth_ref.json`, `s3_rune_slots.json`, `s3_recruit_meta.json`, `s3_bestiary.json`,
`s3_enemy_packs.json`, `s3_war_ref.json`, `s3_war_units.json`.

## Running locally

Serve the **repository root** (so the `../Editor/` fetches resolve), then open `/web/`:

```bash
python3 -m http.server 8791
```

Then browse to `http://localhost:8791/web/`.

Tests:

```bash
npm --prefix web/tests test
```

`npm --prefix web/tests run test:e2e` runs the headless-Chromium suite (needs
`playwright-core` + a Chromium binary; skips cleanly without them). CI runs both on any push
touching `web/**` or `Editor/**` (`.github/workflows/web-tests.yml`).

## Deploying on GitHub Pages

It hosts as-is, served from the repo root (the page fetches `../Editor/` files, all committed):

1. **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
2. Branch `main`, folder **`/ (root)`**. Save.
3. It lives at `https://<user>.github.io/<repo>/web/`.

Pages serves over HTTPS, which the service worker and "Add to Home screen" require.

To ship `web/` standalone instead, copy the `../Editor/` files listed above next to `app.js`
and rewrite the fetch paths in `app.js` / `iso.js`.

## PWA, offline, and updates

`manifest.webmanifest` + `sw.js` make it installable. Same-origin files (app shell +
`../Editor/`) are **network-first**, so an installed copy picks up new commits on its next
online launch — no reinstall. The Pyodide runtime is **cache-first** and version-pinned
(`v0.26.2` in `app.js`); it changes only when that pin moves. Offline works from the second
visit on.

**Releasing a change:** bump the version string in `index.html` *and* `CACHE` in `sw.js`
(`s3editor-vNN`) in the same commit. Bumping `CACHE` purges the old offline cache on
activation, which is what guarantees stale installed copies drop it. The footer's **↻ Force
refresh** button does the same from the user's side if a build ever gets stuck.

An **"Install app"** button appears in the header only when the browser offers installation
(Chrome/Android's `beforeinstallprompt`), and is hidden once installed. iOS Safari has no such
event — there, Share → Add to Home Screen.

## Android specifics

- **Share target.** The installed PWA registers as one, so **Share → S3 Save Editor** in a
  file manager opens the card straight in the editor. **Apply & share…** hands the edited file
  back to the share sheet. True in-place overwrite isn't possible on Android (File System
  Access API is desktop-only), so this is the fastest round trip a web app can offer.
- **Last opened.** The most recent save (bytes, plus the writable handle on desktop) is kept
  in on-device IndexedDB, so a **↻ Last opened** chip reopens it in one tap. A ✕ forgets it.
