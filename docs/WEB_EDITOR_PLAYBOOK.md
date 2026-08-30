# Web Editor Playbook — bringing an editor to parity

> **Superseded by [`WEB_EDITOR_PLAYBOOK_V2.md`](./WEB_EDITOR_PLAYBOOK_V2.md).** v2 is
> self-contained: it keeps this parity material (Part A) and adds the depth layer built since —
> offset verification against ground truth, reference-data enrichment, sibling-table description
> derivation, undo/redo, patch synthesis, presets, and the PWA force-refresh. Read v2. This file
> is kept for history.


A complete feature + implementation brief for the **Suikoden III web editor**
(`https://thesparda.github.io/Suikoden-3-Editor/web/`), written so another editor — a
different game, a different tool — can be enhanced to the same quality. Hand this to a Claude
Code session working on that editor.

It is deliberately concrete: every feature lists **what it does**, **why it matters**, and
**how it's implemented** (the technique, not just the idea), plus the gotchas we hit. Where a
detail is Suikoden-III-specific it's called out as an *example* — replace it with your game's
equivalent.

> **The one-sentence thesis.** The web editor is not a rewrite of the desktop tool — it
> **runs the desktop tool's real engine unchanged**, in the browser, and wraps it in a mobile-
> first UI with strong safety rails. Everything below serves that thesis. Aim for the same.

---

## 0. North-star principles

Adopt these first; the features fall out of them.

1. **Reuse the real engine — don't reimplement it.** The save logic is `Editor/s3save.py`,
   run in the browser via **Pyodide** (CPython → WebAssembly). We call the *same* path-based
   functions the desktop app calls (`read_all_s3_saves()`, `write_save_edits()`), so the
   checksum, memory-card ECC, and every byte layout come from one battle-tested source. No
   second implementation to drift out of sync. (The ISO editor is a *faithful JS port* of the
   Python field tables instead — see §3 for why — but the same "one source of truth for
   offsets" discipline applies: it imports the offsets, never guesses them.)
2. **Nothing leaves the device.** No server, no upload — ever. Say so in the UI. It's the
   whole trust model, and it's what makes editing a save on the same phone you emulate on
   acceptable.
3. **Mobile-first, because that's where it's used.** The target is Android retro-handhelds
   running PS2 emulators. Every layout, control, and interaction is designed for a small
   touch screen first and enhanced for desktop — not the reverse.
4. **Never write a byte you can't defend.** Recompute integrity (checksums/ECC) on every
   write; version/region-gate before opening; only expose fields whose offsets are verified;
   always offer a backup; show an explicit old→new review before committing.
5. **Graceful degradation, never a dead end.** Feature-detect (File System Access, Web Share,
   `beforeinstallprompt`) and fall back — download instead of save-in-place, share instead of
   overwrite — or, where a capability is truly required, block *that one feature* with a clear
   explanation while the rest of the app keeps working.

---

## 1. Architecture at a glance

```
index.html         # app shell: dual-mode tabs, PWA meta, script load order
style.css          # one stylesheet, mobile-first, two themes, safe-area aware
recruit-core.js    # PURE logic module (no DOM/Pyodide) → unit-testable in Node
app.js             # Save Editor: Pyodide bootstrap + full UI
iso.js             # ISO Editor: ranged-read disc editor + mode-tab wiring/init
sw.js              # service worker: offline shell + Pyodide cache + share-target
manifest.webmanifest
icons/             # 192, 512, 512-maskable
tests/             # validate.mjs (static), *-logic.mjs (pure), e2e.mjs (headless), save_roundtrip.py
```

Script load order matters: `pyodide.js` (CDN) → `recruit-core.js` (defines a global used by
app.js) → `app.js` → `iso.js`. `app.js` and `iso.js` share one global script scope (helpers
like `idbGet/idbSet`, `$`/`q`) — keep that or module-ify both together.

**Two engines, two strategies — and why:**

| | Save Editor | ISO Editor |
|---|---|---|
| Engine | real `s3save.py` in **Pyodide** | **JS port** of the Python field tables |
| Why | save files are small (≤ a few MB); running real Python guarantees checksum/ECC correctness with zero reimplementation | the ISO is ~4 GB — you must **not** load it into Pyodide's FS or a tab's memory; you read a ~3.75 MB slice and write bytes back in place, which is trivial in JS and impossible to do cheaply through Pyodide |
| Reach | everywhere, incl. Android | desktop Chromium only (needs File System Access API) |

If your game's "ISO"/ROM is small enough to hold in memory, you can run *both* through the
Pyodide engine and skip the JS port entirely — simpler and more consistent. The split above is
purely a response to a multi-GB disc.

---

## 2. Save Editor — capabilities

### 2.1 The Pyodide bridge (the core move)
- On boot, `loadPyodide()` then `py.FS.writeFile()` the engine + reference files fetched from
  the repo (`../Editor/s3save.py`, id→name tables, description JSON). Then a small `runPython`
  block defines thin adapters: `load_reference()`, `load_saves(path)`, `apply_edits(path, folder, payloadJson)`.
- The uploaded save is written to Pyodide's in-memory FS at a fixed path (`/save.bin`); the
  existing path-based functions run **unchanged**; the edited bytes are read back out with
  `py.FS.readFile`.
- Keep a **resolved** handle to pyodide (`PY`) in addition to the boot promise (`pyReady`), so
  code paths that need a user-activation gesture (e.g. `navigator.share()`) can run
  synchronously up to the first `await` without losing the gesture.

### 2.2 Containers supported (all via the real engine)
`.ps2` / `.mcd` memory cards (full filesystem walk, **multi-slot**, per-page **ECC**
recomputed), `.psu` (EMS), `.psv` (PS3 virtual card), `.xps`/`.sps` (SharkPort/X-Port),
`.cbs` (CodeBreaker; decompressed → edited → re-encoded), and raw `gamedata`. Multi-save cards
render a **slot switcher**; edits are per-slot and reset when you switch. *Every* write
recomputes the save checksum (and card ECC) so the result boots.

### 2.3 What's editable
- **Overview** — names (up to 5 free-text fields, length-capped), gold, playtime (read-only),
  story phase, party leader, and Suikoden I/II carryover detection pills.
- **Characters** — level, cur/max HP, EXP, all 8 stats, equipped runes + armour
  (category-filtered pickers), 8 skill slots (id + **rank tier E…S** as a small native
  `<select>`), and per-character recruitment (recruited toggle + "recruited by").
- **Party** — the active battle party (up to 6) by character name, with an early-game warning
  that story events may overwrite it.
- **Recruit** (bulk) — recruit / move / un-recruit *everyone shown* to a team, plus
  **canonical presets** that assign each character to its story-correct recruiter. The staging
  math lives in `recruit-core.js` (see §5.2) so it's unit-tested without a browser.
- **Inventory** — every bag (per-protagonist + storage), split Party Items vs Key/Valuables,
  name-resolved item pickers, quantities, add/remove of empty slots.

### 2.4 Load paths
`<input type=file>`, drag-and-drop, the File System Access picker (desktop, so a writable
handle is retained), a **Web Share target** (a file shared *into* the installed PWA), and a
one-tap **↻ Last opened** chip. All funnel into a single `handleFile(file, handle?)`.

---

## 3. ISO Editor — capabilities

### 3.1 Ranged read (the key technique for a huge file)
Never load the whole disc. Compute the bounded region that contains every editable table
(for S3: the boot-ELF `[0xA4800, 0x465DF0)`, ~3.75 MB) and read only that:
`file.slice(BASE, END).arrayBuffer()`. Keep two copies: `BUF` (live, editable `Uint8Array` +
`DataView`) and `ORIG` (pristine snapshot for diff/undo). All offsets in code are **absolute
ISO offsets**; convert with `off - BASE` at the read/write boundary.

### 3.2 Version / region gate
Before committing, read the disc's version word (for S3: big-endian u32 at `0x3F2C60`
== `0x40A69A01` for USA `SLUS-20387`) and refuse anything else with a specific message. This
is what stops someone corrupting a PAL/JP disc.

### 3.3 In-place write via File System Access
Writes only the **changed byte-runs** (`diffRuns()` computes `[start,end)` ranges where
`BUF != ORIG`) back through a `FileSystemWritableFileStream` at their absolute offsets —
`createWritable({ keepExistingData: true })` so the 4 GB around them is untouched. A progress
modal shows the safe-copy phase (no progress events → animated bar + elapsed timer), the write
phase (real %), and finalize. On success, reset `ORIG = BUF.slice()` so the baseline is clean.

### 3.4 Views (12)
Characters, Growth, Support, Weapons, Shops, Spells (+ a **rune reskin** that edits every spell
a rune grants at once, and optional description rewrites), Unites, Gear, Food, Balance
(idempotent hard-mode multiplier presets, scaled from disk so they don't compound), Enemies
(name reference), Reference (item/skill id→name). Each field is registered (`FIELD_REG`) with
its offset/width/kind/label so dirty-tracking, per-field revert, and the review list are
generic.

### 3.5 Mod recipe (`.s3mod`) — share edits without the disc
Export staged edits as a tiny JSON of byte-runs *with original bytes*:
```json
{ "format": "s3mod", "version": 1, "game": "SLUS-20387", "versionWord": 1084791297,
  "patchCount": 3, "patches": [ { "off": 4043168, "old": "03", "new": "0b" } ] }
```
Built from staged edits directly (you don't write the ISO first). Import replays it in place,
**version-checks** (`versionWord`) and **warns on any byte that doesn't match the author's
recorded original** (so a recipe against the wrong revision is caught, not silently
mis-applied). This is how users share a rebalance without passing around a multi-GB file.

> **Desktop-only extras (parity boundary).** The downloadable app additionally offers **in-ROM
> text-string editing** and **whole-ISO `xdelta` patches**, and a **CLI**. The web ISO editor
> intentionally omits these (text editing isn't ported; xdelta needs a native binary + a
> pristine disc). Note this so porters know where "parity" ends.

---

## 4. Cross-cutting QoL (this is what makes it feel good)

Each of these is small on its own; together they're the difference in quality. Port the whole set.

- **Searchable pickers instead of native `<select>`.** With 500+ items a native dropdown is
  unusable on mobile. A shared modal (`openPicker(title, list, current, onPick, idFmt)`)
  type-filters by id or name, shows id · name · in-game description · category per row, caps
  the DOM to ~300 rows with a "keep typing" hint, and closes on pick/escape/backdrop. Reused
  for items, skills, equipment (category-filtered), and party/character selection.
- **Review-changes confirmation.** Nothing is written until an explicit **old → new** list,
  grouped by character/section, is confirmed. Build it by diffing staged edits against the
  loaded values (`buildDiff()` / `buildReview()`), so it shows *effective* changes only (a
  value re-typed to its original doesn't appear). Confirm button label states the destination
  ("Apply & save to <file>" / "…download" / "…share…").
- **Per-field dirty highlighting + revert.** Changed fields get a `.dirty` class; each has a
  **↺** restore to its original. An **unsaved badge** ("N unsaved") and a dot on the Save
  button reflect live state. Coalesce badge refreshes to one per frame with
  `requestAnimationFrame` (edit handlers fire many times per render). *Gotcha:* rAF is paused
  while the tab/page is hidden — fine in practice, but don't assert badge state in a
  headless/hidden context.
- **Unsaved-changes guard.** `beforeunload` warns before closing/navigating with pending
  edits. Both editors register their own.
- **Remember last opened.** Persist in **IndexedDB** (a tiny kv wrapper). For *saves*: the
  bytes + name (+ the writable handle on desktop). For the *ISO*: **the `FileSystemFileHandle`
  only — never the 4 GB of bytes** (handles are structured-cloneable and survive in IDB). A
  one-tap **↻ Last opened** chip reopens it; a ✕ forgets it. On desktop, reopening an ISO
  re-grants write permission so save-in-place is restored. The ISO side also **reopens itself**
  when you enter the tab (an `auto-reopen` checkbox next to the chip, persisted in
  `localStorage`, turns it off). It fires at most once per page load and never once a disc has
  been opened, so **Close** stays closed instead of bouncing back in. Silent only when
  `queryPermission` already says `granted` (Chrome's *allow on every visit* / installed PWA);
  otherwise it prompts while the tab click's user activation is still live, and falls back to
  the chip when there's no activation left.
- **Save-in-place with fallback.** If you opened via the FS Access picker you hold a writable
  handle → **Apply & save to file** overwrites the original (after `queryPermission` /
  `requestPermission`). Browsers without the API (Android Chrome, Firefox, Safari) transparently
  fall back to **Apply & download**. The original is only ever touched on an explicit
  save-to-file, after the review confirm.
- **Web Share, both directions (Android).**
  - *In:* the manifest declares a `share_target` (POST, multipart); the service worker catches
    the POST, stashes the file in a cache, and redirects to `?shared=1`; the app picks it up on
    boot. Turns "download → find file → choose file" into "Share → editor".
  - *Out:* **Apply & share…** hands the edited file to `navigator.share({ files })`. Must run
    inside the user-activation gesture — do the synchronous engine work before the first
    `await`, and fall back to download if share is unavailable/aborted.
- **Boot progress.** The first-load Pyodide download (~10 MB) shows staged progress
  (`bootProgress(pct, msg)`), not a bare spinner.
- **Value hints + clamping.** Number fields carry sensible min/max; the engine still clamps to
  the real byte width on write (belt and suspenders).
- **Themes.** Two, toggled in the footer, persisted in `localStorage`, with a matching
  `theme-color` meta update.

---

## 5. Testing strategy (ships no game data, still covers the engine)

The repo contains **no ROM/ISO/saves**. Tests use **synthetic fixtures** built from the
engine's own constants, so they can't drift. Four layers, all under `npm test` except the
heavy browser one:

1. **`validate.mjs`** — fast, no browser: every client JS file parses, every ISO table offset
   stays inside the read block, reference parsers still return the expected item/skill counts,
   and the app shell is wired (script tags, both mode tabs, SW precache list). Runs in CI and
   on session start.
2. **`recruit-logic.mjs`** — imports the pure `recruit-core.js` and tests the staging math
   directly (recruit/move/un-recruit pruning, canonical presets, counts). *Extracting pure
   logic into a DOM-free module purely so it's unit-testable is a pattern worth copying* for
   anything non-trivial that otherwise needs Pyodide/DOM.
3. **`save_roundtrip.py`** (wrapped by `save-roundtrip.mjs` for `npm test`) — builds a valid
   **synthetic `gamedata`** by *importing the real `s3save` module* (so offsets + checksum are
   the engine's own), then drives `read_all_s3_saves` → `write_save_edits` → re-read, asserting
   every field persists, the **checksum invariant** holds (all u32 words sum to 0), size is
   preserved, the **ECC helper** is correct, and unrecognized files are rejected. The `.mjs`
   wrapper **skips cleanly (exit 0)** if `python3` is absent.
4. **`e2e.mjs`** — full headless Chromium (playwright-core) against a **synthetic in-bounds
   ISO** (`synth-iso.mjs`): load + version check, edits across every view, per-field revert,
   the backup-nudge → confirm → byte-exact save path, recipe round-trip, and **no horizontal
   overflow at 320/360 px**. It **aborts the Pyodide CDN** (too heavy for CI) and **stubs the
   FS Access handle** (`showOpenFilePicker` → a fake handle whose `createWritable` records
   writes) so it can exercise the save path without a real file. Self-skips (exit 0) if
   playwright/Chromium isn't present.

**Patterns to copy:** synthetic fixtures from the engine's own constants; skip-clean when a
heavy dep is missing (never break minimal CI); stub `showOpenFilePicker` + a recording
`createWritable` to test the in-place-save path headlessly; assert mobile has no horizontal
overflow at 320/360 px as a hard check.

---

## 6. PWA / offline

- **Manifest:** `display: standalone`, `orientation: portrait`, maskable + regular icons,
  `theme_color`, and the `share_target` block.
- **Service worker caching strategy — split by origin:**
  - *Same-origin (app shell + engine/reference files):* **network-first**, fall back to cache
    offline. So a new deploy is picked up on the next online launch (no reinstall) yet the app
    still works with no signal.
  - *Cross-origin (the Pyodide CDN — large, immutable, version-pinned URLs):* **cache-first**,
    so the ~10 MB runtime downloads once and is instant thereafter.
- **Cache versioning:** bump the `CACHE` name to purge stale offline copies on `activate`;
  never purge the share-target cache (it may hold a pending shared-in file).
- **Install button:** show your own button only when `beforeinstallprompt` fires (Chromium),
  hide it once installed or when already `display-mode: standalone`. iOS has no such event —
  document "Share → Add to Home Screen" for Safari.
- **Updates are automatic** for online users because the shell is network-first; only the
  version-pinned runtime is frozen until you bump its version.

---

## 7. Mobile / small-screen / retro-handheld support

This is a first-class requirement (Android retro devices), not an afterthought.

- **Viewport + notch:** `<meta viewport ... viewport-fit=cover>` and pad the body with
  `env(safe-area-inset-*)` so nothing hides under a notch/rounded corners. The sticky toolbar
  also adds `safe-area-inset-bottom`.
- **Fluid layouts, no fixed widths:** grids are
  `repeat(auto-fill, minmax(150px, 1fr))` (equipment/skills use 210px), inputs are
  `width:100%; max-width:100%; min-width:0` inside `flex-direction:column` fields — so they
  reflow from one column on a phone to many on desktop with **no media queries** for the
  content itself.
- **Tab strips scroll horizontally:** the ISO view tabs are `flex-wrap:nowrap; overflow-x:auto;
  -webkit-overflow-scrolling:touch` — 12 tabs stay one swipeable row instead of wrapping into a
  wall.
- **Sticky action toolbar** at the bottom so Save/Reset are always reachable without scrolling
  a long form.
- **Pickers, not native selects** (see §4) — the single biggest mobile usability win with big
  lists.
- **Modals are full-width sheets on small screens**, centered cards at `min-width:600px`
  (`max-height:85vh`, internal scroll).
- **Hard test:** the e2e suite asserts **zero horizontal overflow at 320 px and 360 px**. Keep
  that check; it catches the most common mobile regression.
- **Portrait-locked** via the manifest, matching how the devices are held.

---

## 8. Capability gating & graceful degradation

Feature-detect, then adapt — one required-capability feature may block, but the app never dies:

| Capability | Detect | If absent |
|---|---|---|
| File System Access | `"showOpenFilePicker" in window` | Save editor → download instead of save-in-place. ISO editor → **block that tab** with a clear card ("needs desktop Chrome/Edge/Brave/Opera; the Save editor works everywhere including mobile"). |
| Web Share w/ files | `navigator.canShare({files:[…]})` | hide the Share button; keep download. |
| Install prompt | `beforeinstallprompt` event | hide the Install button; document manual Add-to-Home-Screen. |
| Service worker | `"serviceWorker" in navigator` | app still runs online; just no offline/PWA. |

The ISO "blocked" card is the model for a hard requirement: explain *what* is needed, *why*,
*which browsers* qualify, and *what still works* — never a blank screen.

---

## 9. Safety model

- **No uploads, ever.** Reinforce it in copy so users trust editing on the same device.
- **Backups.** Desktop keeps a `.bak`; the web ISO editor can't silently back up a 4 GB file,
  so it **nudges** ("back up first, or Export a recipe") on the first save and offers the
  recipe as a reversible record.
- **Integrity on every write:** recompute the save checksum and memory-card ECC; for the ISO,
  write only changed runs so nothing else can be disturbed.
- **Version/region gate** before opening an ISO; **version-check** recipes on import.
- **"Never write an unverified field."** If a byte's meaning isn't confirmed on real data,
  don't expose it (S3 example: per-character weapon level was left out because its offset
  aliases the level byte). This discipline is why edited files boot.
- **Explicit review** before any destructive write; **unsaved guards** against accidental loss.

---

## 10. Porting checklist

Concrete order of operations to bring another editor to parity:

- [ ] **Engine reuse:** boot Pyodide, `FS.writeFile` your engine + reference data, expose thin
      `load_*/apply_*` adapters; drive the *existing* path-based functions. (Or run everything
      through Pyodide if your ROM fits in memory.)
- [ ] **Single ingest funnel** `handleFile(file, handle?)` feeding: input, drag-drop, FS picker,
      share-target, last-opened.
- [ ] **Reference-resolved, searchable pickers** for every id-based field.
- [ ] **Staged edits + review-changes confirm + per-field dirty/revert + unsaved badge +
      `beforeunload` guard.**
- [ ] **Last-opened via IndexedDB** (bytes for small files; **handle-only** for huge ones).
- [ ] **Save-in-place (FS Access) with download fallback**; **Web Share in + out** on Android.
- [ ] **PWA:** manifest (+ `share_target`), service worker (network-first shell, cache-first
      CDN, share POST handler), install button, icons.
- [ ] **Mobile CSS:** safe-area insets, fluid `auto-fill minmax` grids, horizontal-scroll tab
      strip, sticky toolbar, full-width modals; **assert no overflow at 320/360 px**.
- [ ] **Huge-file editor (if applicable):** ranged `Blob.slice` read, absolute-offset model,
      version gate, diff-runs in-place write with a progress modal, recipe export/import.
- [ ] **Safety:** checksum/ECC on write, version/region gates, backup nudge, unverified-field
      discipline.
- [ ] **Capability gating** with explain-don't-die fallbacks.
- [ ] **Tests:** static `validate`, a pure-logic module + its unit test, a synthetic-fixture
      engine round-trip (skip-clean without the interpreter), and a headless e2e that stubs the
      FS handle and aborts the CDN.
- [ ] **Copy the trust + parity messaging** into the UI and README (web-first; desktop for
      CLI/xdelta/text).

---

## 11. Sharp edges we hit (read before you port)

- **`navigator.share()` needs user activation.** Run the engine work synchronously up to the
  first `await` inside the click handler, or the gesture is spent and share throws.
- **rAF is paused when the page is hidden** → the dirty badge won't refresh in a
  background/headless tab. It's cosmetic and self-corrects on focus; just don't assert on it
  headlessly.
- **Store `FileSystemFileHandle`, not bytes, for huge files** in IndexedDB — handles are
  structured-cloneable; permission must be re-granted on reopen (`queryPermission` →
  `requestPermission`).
- **Absolute vs relative offsets:** pick one convention (we use absolute ISO offsets in code,
  converting `- BASE` only at the byte read/write). Mixing them is the #1 source of
  off-by-region bugs.
- **Version word endianness:** ours is **big-endian** at its offset even though most fields are
  little-endian. Confirm on a real disc.
- **`createWritable({ keepExistingData: true })`** — without it the browser truncates the file
  before your ranged writes and you destroy the disc.
- **Clear stale status on success.** After a failed load then a good one, reset the status line
  or a "not found" error lingers above a working editor. (We fixed exactly this.)
- **Service worker cache name is your deploy lever:** network-first keeps online users current;
  bump the cache version only when you must purge *offline* copies.
- **Keep one source of truth for offsets.** Tests build fixtures by importing the engine's
  constants; UI reads the same tables. Never hand-copy an offset into a test.

---

*Questions or "how did S3 do X" — read `web/app.js` (save), `web/iso.js` (ISO),
`web/recruit-core.js` (pure logic), `web/sw.js` + `manifest.webmanifest` (PWA),
`web/style.css` (mobile), and `web/tests/` (all four test layers). Every feature above maps to
named functions in those files.*
