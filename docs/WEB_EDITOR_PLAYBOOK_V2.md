# Web Editor Playbook v2 — parity, then depth

A complete, self-contained brief for bringing **another game's editor** up to the quality of
the **Suikoden III web editor** (`https://thesparda.github.io/Suikoden-3-Editor/web/`). Hand
this to a Claude Code session working on that other editor.

**This supersedes `WEB_EDITOR_PLAYBOOK.md` (v1).** v1 covered getting to *parity* — reuse the
real engine, mobile-first UI, safety rails, PWA, tests. All of that still holds and is
summarized here in Part A. v2 adds Part B: the **depth** layer we built afterward — enriching
fields with authoritative reference data the ROM doesn't self-describe, *verifying* every
reconstructed offset against ground truth, synthesizing patches, undo/redo, presets, and the
PWA-staleness escape hatch. If you only read one part, read **Part B §12 (offset verification)**
and **§13 (reference-data enrichment)** — those are the ideas that most raise an editor's
quality and are the easiest to get subtly wrong.

Style: every feature says **what**, **why**, and **how** (the technique, not just the idea),
with the gotchas. Suikoden-III specifics are marked as *examples* — swap your game's equivalent.

> **Thesis.** The web editor runs the desktop tool's **real engine unchanged** in the browser,
> wraps it in a mobile-first UI with strong safety rails — and then goes past raw byte-editing
> to **explain the data**: it shows what each value *should* be (from external guides), proves
> its own offsets against a real disc, and lets users act on that (presets, caps, undo). Aim for
> both halves: correct bytes, and a UI that teaches the game.

---

# PART A — Parity (the foundation)

## A0. North-star principles

1. **Reuse the real engine — don't reimplement it.** Save logic is `Editor/s3save.py`, run in
   the browser via **Pyodide** (CPython→WASM); the UI calls the *same* path-based functions the
   desktop app calls, so checksum/ECC/byte-layout come from one battle-tested source. The ISO
   editor is a *faithful JS port* of the Python field tables (the disc is too big for Pyodide's
   FS — see A3) but keeps the same "one source of truth for offsets" discipline: it imports the
   offsets, never guesses.
2. **Nothing leaves the device.** No server, no upload — ever. Say so in the UI; it's the trust
   model that makes editing a save on the same phone you emulate on acceptable.
3. **Mobile-first.** The target is Android retro-handhelds running PS2 emulators. Design for a
   small touch screen first, enhance for desktop.
4. **Never write a byte you can't defend.** Recompute integrity on write; version/region-gate on
   open; only expose *verified* fields; always offer a backup; show an explicit old→new review.
5. **Graceful degradation, never a dead end.** Feature-detect and fall back; block one feature
   with an explanation, never the whole app.
6. **(new) The ROM under-describes itself — so enrich it.** Raw bytes ("Skill max = 5") mean
   nothing to a player. Where the game or a community guide knows more (this skill caps at B+,
   this rune grants these spells, this enemy has 1,200 HP), surface it inline. See Part B.

## A1. Architecture at a glance

```
index.html         # app shell: dual-mode tabs, PWA meta, script load order
style.css          # one stylesheet, mobile-first, two themes, safe-area aware
recruit-core.js    # PURE logic module (no DOM/Pyodide) → unit-testable in Node
vcdiff.js          # PURE VCDIFF (.xdelta) encoder → unit-testable in Node   (v2)
app.js             # Save Editor: Pyodide bootstrap + full UI + update check
iso.js             # ISO Editor: ranged-read disc editor + undo/redo + overlays (v2)
sw.js              # service worker: offline shell + Pyodide cache + share-target
manifest.webmanifest ; icons/
Editor/build_*.py  # generators that turn guide text → committed reference JSON   (v2)
Editor/suikosource/*.txt   # saved guide text the generators parse                (v2)
Editor/s3_*.json           # committed id→name / description / guide reference data
tests/             # validate.mjs (static), *-logic.mjs (pure), desc-merge.mjs,
                   # save_roundtrip.py, vcdiff.mjs, e2e.mjs (headless)
```

Script load order: `pyodide.js` → `recruit-core.js` → `vcdiff.js` → `app.js` → `iso.js`.
`app.js`/`iso.js` share one global script scope — keep that or module-ify both together.

**Two engines, two strategies:** run the *real* engine in Pyodide for small files (saves); do a
*JS port* for a multi-GB file you must not load into memory (the disc). If your ROM fits in
memory, run everything through Pyodide and skip the JS port — simpler and more consistent.

## A2. Save Editor — the Pyodide bridge

On boot: `loadPyodide()`, `py.FS.writeFile()` the engine + reference files fetched from the
repo, then a small `runPython` block defines thin adapters (`load_reference`, `load_saves`,
`apply_edits`). The uploaded save is written to Pyodide's FS at a fixed path; the *unchanged*
path-based functions run; edited bytes are read back with `py.FS.readFile`. Keep a **resolved**
Pyodide handle (not just the boot promise) so gesture-gated paths (`navigator.share()`) run
synchronously up to the first `await`.

Containers (all via the real engine): `.ps2`/`.mcd` cards (multi-slot, per-page ECC), `.psu`,
`.psv`, `.xps`/`.sps`, `.cbs`, raw `gamedata`. Every write recomputes checksum + ECC.

Editable: **Overview** (names, gold, story phase, leader), **Characters** (level, HP, EXP,
stats, runes/armour via category-filtered pickers, 8 skill slots with rank tiers, recruitment),
**Party**, **Recruit** (see B16 — reworked), **Inventory** (per-bag, Party vs Key, add/remove).

Load paths funnel into one `handleFile(file, handle?)`: file input, drag-drop, FS Access picker
(keeps a writable handle), Web Share target, and a ↻ Last-opened chip.

## A3. ISO Editor — huge-file techniques

- **Ranged read.** Never load the disc. Read only the bounded region containing every editable
  table (`file.slice(BASE, END).arrayBuffer()` — S3: `[0xA4800, 0x465DF0)`, ~3.75 MB). Keep
  `BUF` (live) + `ORIG` (pristine, for diff/undo). All code offsets are **absolute**; convert
  `- BASE` only at the read/write boundary.
- **Version/region gate.** Read the version word (S3: big-endian u32 == `0x40A69A01` for USA
  `SLUS-20387`) and refuse anything else.
- **In-place write.** `diffRuns()` computes `[start,end)` ranges where `BUF != ORIG`; write only
  those through a `FileSystemWritableFileStream` with `createWritable({ keepExistingData: true })`
  (without that flag the browser truncates the 4 GB file). Progress modal: safe-copy phase
  (animated), write phase (%), finalize. On success reset `ORIG = BUF.slice()`.
- **Browser reach.** In-place needs File System Access (Chromium desktop). Elsewhere, don't
  block — **stream a patched copy** to downloads via a service-worker hand-off, or export a
  recipe/`.xdelta`. (v1 said "block the tab"; v2 corrects this — streaming-save makes the ISO
  editor usable everywhere.)
- **Field registry.** Each field registers `{off, width, kind, label, group}` in `FIELD_REG` so
  dirty-tracking, per-field revert, and the review list are generic.

## A4. Cross-cutting QoL

Searchable pickers (not native `<select>`: type-filter by id/name, show id·name·description·
category, cap DOM to ~300 rows); **review-changes** confirm (explicit old→new, grouped, built
from `buildDiff()`/`buildReview()` so only *effective* changes show); per-field dirty highlight
+ ↺ revert + an "N unsaved" badge (coalesce refreshes with `requestAnimationFrame`);
`beforeunload` guard; **last-opened via IndexedDB** (bytes for small files; **handle-only** for
the 4 GB disc); save-in-place with download/share fallback; Web Share in+out (Android); boot
progress for the ~10 MB Pyodide download; two themes.

## A5. PWA / offline

Manifest (`display: standalone`, `orientation: portrait`, maskable icons, `share_target`).
Service worker: **network-first** for same-origin shell (new deploys picked up next launch),
**cache-first** for the version-pinned Pyodide CDN. Bump the `CACHE` name to purge stale offline
copies; never purge the share-target cache. (See **B17** for the staleness escape hatch.)

## A6. Mobile

`viewport-fit=cover` + `env(safe-area-inset-*)`; fluid `repeat(auto-fill, minmax(150px,1fr))`
grids with `width:100%; min-width:0` inputs (no content media queries); horizontal-scroll tab
strip; sticky bottom toolbar; full-width modal sheets (centered cards ≥600px). **Hard test:
zero horizontal overflow at 320 px and 360 px.**

## A7. Safety model

No uploads; backups (desktop `.bak`; web nudges "back up / export a recipe"); integrity on
every write; version/region gate on open + version-check on recipe import; **never expose an
unverified field**; explicit review before destructive writes; unsaved guards.

---

# PART B — Depth (what v2 adds)

This is the layer that turns a competent byte-editor into one that *understands* the game.

## B12. Verify every reconstructed offset against ground truth  ← read this first

**The lesson that cost the most.** Offsets reverse-engineered from a decompiled tool are
*hypotheses*, not facts. We shipped several that were subtly wrong until a user reported bad
values. Two real examples from S3 (github issue #2):

- **Skill-max array read 3 bytes too early.** The reconstruction started the 43-skill cap array
  at `+13`; it actually starts at `+16`. The encoding was *also* suspected wrong but turned out
  correct. Symptom: every skill showed the *previous* skill's cap.
- **Rune slots were mislabeled** (Head/Right/Left were permuted vs the real layout).
- A growth-rate block was **shifted by one** (used a padding byte), and a "rune level" field was
  actually **HP growth** misread.

**The method that found and fixed them** — copy this workflow whenever you expose a table:

1. **Get external ground truth.** Community guides (Suikosource here) list per-character caps,
   growth, drops, rune slots. Save the pages as text in-repo (`Editor/suikosource/*.txt`) so the
   check is reproducible and offline.
2. **Brute-force the offset.** For a candidate table, sweep plausible start offsets and score
   each against ground truth across the *whole roster*. The right offset wins by a landslide
   (S3: `+16` matched **988/1100** known caps; every other offset ≈ 12–17%). Don't eyeball one
   character — one character can match the wrong offset by luck.
3. **Confirm the encoding separately.** Map each stored byte value to the guide's grade and take
   the mode per grade. (S3: this proved `1=A+` — a genuinely non-monotonic encoding — was
   *correct*, so we did **not** "fix" it. Verifying saved us from breaking a right thing.)
4. **Correlate when values aren't equal.** Growth *rate* in the guide is a coarse class, not the
   raw byte — so exact-match fails. Pearson-correlate each byte column against each stat across
   the roster; the diagonal reveals the mapping (S3: `+4=PWR … +0=HP`, matching the exe's own
   write-set exactly).
5. **Cross-check against a second oracle.** The desktop tool's decompiled write-order, a
   different guide, or the save editor's independent code path. When two independent sources
   agree, trust it. (Rune-slot order was confirmed by *both* the guide and the save editor.)
6. **Distinguish "the table is 60 long" from "62".** Walk one past the end and you read adjacent
   data that *looks* valid. S3's food table is 60 dishes; records 60–61 resolved to consumable
   *item* names ("Sacrificial Jizo", "Escape Scroll") — the tell was name↔category mismatch, not
   a crash. Validate table *length* by "do all rows still look like this kind of thing?".
7. **Add a regression guard keyed to ground truth.** After fixing, commit a test that re-derives
   from the guide so the mapping can't silently drift again. Where CI can't hold the real ROM,
   guard the *constant* (`SKILLMAX_START === 16`) and keep the correctness proof in a doc.

**Corollary — keep web and desktop in lockstep.** Both editors embed the same offsets; a fix in
one must land in both. Add a validate check that asserts the two files agree.

## B13. Reference-data enrichment (the biggest quality lever)

**What.** Show, inline with each editable field, what the value *means* and what's *normal*:
per-character skill caps and Lv-99 growth ranges, "rune slot opens at Lv N", rune/food effect
descriptions, per-rank skill effects, an enemy's HP/drops. Faded/secondary styling so it informs
without competing with the input.

**Why.** It's the difference between "Skill 3 max = 5" and "Damage · max **B+** · guide cap B".
Users edit with intent instead of guessing, and it doubles as documentation.

**How — the pipeline:**

1. **Save guide text in-repo** (`Editor/suikosource/*.txt`) — provenance + reproducibility.
2. **Commit a generator** (`Editor/build_guide_refs.py`) that parses that text into small JSON
   keyed by the same id/name the UI uses. Idempotent; re-runnable; ISO-free where possible.
   Outputs (S3): `s3_skill_ref.json` (per-rank effects, all 43 skills), `s3_skill_caps.json`
   (per-char caps), `s3_growth_ref.json` (rate + start/end ranges), `s3_rune_slots.json`
   (opens-at levels), `s3_bestiary.json` (Lv/HP/drops), `s3_recruit_meta.json` (story vs
   optional — see B16).
3. **Fetch them defensively at load** (`grabOpt`): a missing file just hides its notes, never
   breaks the editor.
4. **Render as a small `.fnote` under the field** (or an `<option>`/button `title` tooltip). Key
   the lookup off the field's character name + id.

**Gotchas.** Guide names ≠ ROM names — normalize (lowercase, strip punctuation) and keep a small
alias map for the stubborn few (S3: "Sgt. Joe" ↔ "Sgt. Jordi (Joe)"). Guides have typos
("Bujitsu"); fold them. Accept < 100% coverage gracefully (2 characters had no guide entry →
they simply show no note). A guide's displayed number may be a *derived class*, not the raw byte
(see B12 §4) — label it as "guide" context, don't assert equality.

## B14. Derive missing descriptions from *sibling* tables — and pre-extract for the no-ROM editor

Some domains have **no description record at all** in the game data. Runes and food in S3 aren't
in the equipment name↔desc table; the equipment "pool" either left them blank or paired them
with **drifted garbage** (a rune showed "Sword of Rage"). Two techniques fixed this:

- **Cross-reference a sibling table.** Command/attack runes share their *name* with a spell-table
  entry → read that spell's real description. Magic runes map via a rune→spell-set table →
  summarize ("Grants Flaming Arrows, …"). Food items match the food/recipe table by name →
  "Heals NNN HP". Scope each lookup to the right *category* so names don't collide (a "Fire
  Amulet" rune-spell name must not override the "Fire Amulet" *accessory*). Skip non-ASCII
  "unused" placeholder strings; fall back to a computed value (the heal number).
- **Correct-or-blank, never wrong.** If you can't resolve it confidently, show nothing. A wrong
  description erodes trust faster than a missing one. We actively *blanked* the drifted pool
  entries so the fallback is empty, not garbage.
- **Static extraction for the editor that can't read the ROM.** The ISO editor reads these live
  from the loaded disc. The **save editor can't open an ISO** — so a committed generator
  (`Editor/build_item_desc_extra.py`) extracts them once into `s3_rune_food_desc.json`, which the
  save editor merges (`extra[id] || pool[id]`). Same data, two delivery mechanisms; one is live,
  one is pre-baked. This is the general answer to "feature X needs the ROM but editor Y doesn't
  have it": extract to a committed reference file.

## B15. Read-only reference tabs for non-editable domains

Not everything is editable — S3's enemy stats aren't a flat table. Don't drop the domain; ship
it **read-only**. The Enemies tab is a full **bestiary** (Lv, HP, item/food drops, potch, SP per
encounter) parsed from the guide into `s3_bestiary.json`, filterable by enemy/drop/food name.
Players value the reference even when they can't change it. Same pipeline as B13.

## B16. Recruitment / roster classification from a guide

**What changed from v1.** v1 had bulk "recruit/move/un-recruit everyone" + "canonical presets".
We **removed** both — free-form bulk isn't meaningful for this game, and mass-recruiting
story-locked characters soft-locks saves. The section is now **per-character** editing plus a
**guide-derived safety signal**:

- A generator reads the character guide's "Automatic: Yes/No" field into `s3_recruit_meta.json`
  (story auto-join vs optional recruit). **Rule that mattered:** treat *only an explicit "No"* as
  optional; "Yes" *and* any conditional/post-game unlock (e.g. a "recruit all 108" character)
  count as story — don't encourage manually toggling those.
- **Story characters are faded + ⚠-tagged** in the list; the header recommends using the tool for
  *optional* recruits. Players immediately see which recruits are theirs to make.

**Reusable pattern — preview before a bulk/irreversible action.** Even though we dropped bulk
here, the technique is worth keeping for any mass action: dry-run the action on a *clone* of the
staging map, diff before/after, and show exactly what will change (grouped, with a heads-up for
risky entries) before committing. Keep the diff logic **pure** (`recruit-core.previewChanges`) so
it's unit-tested without a browser.

## B17. PWA staleness — the force-refresh escape hatch

Network-first (A5) keeps online users current *in theory*, but a stuck service worker or an
offline shell can serve an old build indefinitely. Two mechanisms:

- **Version-behind check.** On load, compare the running footer version to a **cache-busted**
  fetch of `index.html` (`?cb=<time>`, `cache:"no-store"` — bypasses both HTTP and SW caches). If
  it's behind, reveal an update prompt.
- **Manual "↻ Force refresh".** A permanent footer button that **unregisters the service worker,
  deletes all caches, and reloads**. This is the reliable escape hatch — the version check can't
  fire if the *whole* shell is stale, but the button is always there once a user has any build
  that includes it.

**Honest caveat to document:** neither can reach a client stuck on a build from *before* these
existed — that one needs a manual hard-refresh once. Ship it early so future updates self-heal.

## B18. Advanced techniques worth stealing

- **Undo/redo via an auto-commit transaction model.** Hook the *single* low-level write function
  (`writeW`/`writeBytes`) to record each byte's before-image into a pending map; commit that map
  as one undo step on the next **microtask** (`queueMicrotask`). One user action = one undo step,
  with **zero per-call-site wrapping** — every edit path (fields, presets, recipe import) is
  covered automatically. Undo/redo restore bytes directly (not through `writeW`, so they don't
  re-record) and re-render. Reset the stacks on load and on Revert-all. Bound the stack.
- **Synthesize a patch instead of diffing.** To emit a standard `.xdelta` (VCDIFF) for a 4 GB
  disc without diffing two 4 GB files: you already know the changed byte ranges, so **build the
  VCDIFF directly** — COPY-from-source windows for unchanged spans + ADD windows for edits,
  tiling the whole target. No WASM, no full read; the patch is a few KB. Keep the encoder a pure
  module (`vcdiff.js`) and round-trip it against the real `xdelta3` in tests. *Caveat:* a
  hand-built patch has no integrity checksum, so tell users to apply it only to a pristine disc
  (or compute one, which costs a full source read).
- **Presets that fill, or apply, staged edits.** Skill-cap presets ("Set to guide caps / Max all
  / Clear") write the whole array from the reference data; rune-reskin presets pre-fill a form
  the user then applies. Both are just staged edits — revertible, reviewed, undoable — so they're
  safe and cost almost nothing on top of B13's data.

---

## B19. Testing — behavioral vs guards, and the honesty matrix

v1's four layers still stand (static `validate`, pure-logic unit tests, synthetic-fixture engine
round-trip that skip-cleans without Python, headless e2e that stubs the FS handle + aborts the
CDN). v2 adds hard-won refinements:

- **Distinguish *behavioral* tests from *wiring guards*.** A grep in `validate.mjs` that asserts
  `function undo()` exists is a guard, not a test. Back the important features with something that
  *exercises* them: `vcdiff.mjs` round-trips patches through a self-decoder **and** real
  `xdelta3`; `desc-merge.mjs` asserts the actual merged strings (Rage → "Grants …", *not* the old
  drift); e2e byte-verifies undo/redo and the "Max all" preset. Be able to say, per feature,
  which kind of coverage it has.
- **e2e that isn't in CI goes stale silently.** Our Playwright suite is a *local* step (needs a
  browser). Two of its assertions had rotted against earlier offset/UI changes and nobody knew.
  Either run it in CI, or add cheap `validate.mjs` guards for the same invariants so CI still
  catches the regression. When you change an offset, grep the tests for the old value.
- **Some correctness can't live in CI.** Real-ROM offset verification (B12) needs the multi-GB
  file CI doesn't have. Guard the *constant* in CI, keep the *proof* in a doc
  (`Suikoden3_ISO_offsets.md`), and run the real-data check by hand when the mapping changes.
- **Synthetic fixtures still come from the engine's own constants** so they can't drift; keep the
  "no horizontal overflow at 320/360 px" hard check.

## B20. Sharp edges (v2 additions to v1's list)

- **`navigator.share()` needs user activation**; **rAF pauses when hidden** (don't assert the
  badge headlessly); **store handles, not bytes, for huge files** in IDB; **absolute vs relative
  offsets** — pick one; **version word may be big-endian**; **`keepExistingData:true`** or you
  truncate the disc; **clear stale status on success**. *(all from v1 — still true.)*
- **Global-scope name collisions.** `app.js` and `iso.js` share one scope. We defined a second
  `openConfirm` in one and it silently shadowed the other's (a review modal), breaking it at
  runtime. Grep for a helper name before adding it; prefer reusing the existing one.
- **`let`/`const` used before its line but *called* later is fine** in the shared IIFE (functions
  run after the whole body evaluates) — but a *duplicate* `function` declaration hoists and the
  **last one wins**. That's how the collision above happened.
- **Table length is a decode parameter, not a constant to trust.** Reading one row past the end
  yields plausible-looking garbage (B12 §6).
- **Reference lookups are name-keyed → normalize + alias.** Off-by-a-space or a guide typo drops
  a row silently. Validate coverage counts in a test.
- **A "fix" to an encoding might break a correct oddity.** Verify before changing (B12 §3): S3's
  `1 = A+` looks like a bug and isn't.

## B21. Porting checklist — v2 additions

v1's checklist (engine reuse, single ingest funnel, searchable pickers, staged edits + review +
dirty/revert + guards, IndexedDB last-opened, save-in-place + Web Share, PWA, mobile CSS,
huge-file ranged editor, safety, capability gating, the four test layers, trust/parity copy) is
the baseline. Then add:

- [ ] **Verify every exposed table's offset + encoding + length against external ground truth**
      (B12); commit the guide text and a regression guard; keep web/desktop offsets in lockstep.
- [ ] **Reference-data pipeline** (B13): guide text → committed generator → small JSON → defensive
      fetch → `.fnote`/tooltip inline. Normalize names; alias the stragglers.
- [ ] **Derive missing descriptions from sibling tables** (B14); scope by category;
      correct-or-blank; **pre-extract to a committed file** for any editor that can't read the ROM.
- [ ] **Read-only reference tabs** for non-editable domains (B15).
- [ ] **Roster/recruit classification from a guide** (B16) with story-vs-optional shading;
      per-record editing over free-form bulk; keep any bulk action behind a **pure, previewed**
      dry-run diff.
- [ ] **PWA force-refresh + version-behind check** (B17).
- [ ] **Undo/redo via the one-write-hook + microtask transaction model** (B18).
- [ ] **Patch synthesis** (B18) if you have a huge file: build the VCDIFF from known edits; pure
      module; round-trip against the real tool in tests; warn about the missing checksum.
- [ ] **Presets** that stage reviewable/undoable edits from the reference data (B18).
- [ ] **Behavioral tests, not just guards** (B19); run e2e in CI or mirror its invariants in
      static guards; keep real-ROM proofs in a doc.

---

*Where S3 did each thing: `web/app.js` (save editor, update check), `web/iso.js` (ISO editor,
undo/redo, overlays, presets), `web/recruit-core.js` + `web/vcdiff.js` (pure logic + patch
encoder), `web/sw.js` + `manifest.webmanifest` (PWA), `web/style.css` (mobile),
`Editor/build_*.py` + `Editor/suikosource/*.txt` (reference generators + sources),
`Editor/Suikoden3_ISO_offsets.md` (the offset-verification record), `web/tests/` (all test
layers). Every feature above maps to named functions/files there.*
