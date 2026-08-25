# Web editor tests

Four layers, all runnable with plain Node (v18+):

## `validate.mjs` — fast, no browser (runs in CI + on session start)
Checks the client JS parses, every ISO table offset stays inside the read block, the
reference-table parsers still return the expected item/skill counts, and the app shell is
wired (loads `iso.js`, both mode tabs present, service worker precaches `iso.js`).

```bash
node web/tests/validate.mjs
```

## `guide-core.mjs` — the guide-overlay name join, no browser
The save editor annotates character cards with the Suikosource guide data (skill caps, Lv-99
growth ranges, rune-slot unlock levels). Those files are keyed by the ISO's **list1** names
while a save's characters carry **`s3save.ROSTER`** names, so a rename on either side would
silently drop every note with no error anywhere. This drives the real `web/guide-core.js`
against the **committed** JSON and the **real** ROSTER (parsed out of `s3save.py`) and asserts
both the individual lookups and the **coverage counts** — the number that actually moves when
a name drifts.

Coverage today is 71/109 (caps, rune slots) and 70/109 (growth). The rest are list3 support
characters, who don't fight and have no entry in the combat guides, plus a few fighters the
guides omit — all of which correctly render no note.

```bash
node web/tests/guide-core.mjs
```

## `text-core.mjs` — the in-ELF string scanner, no browser
The ISO editor's Text tab has no table of contents to work from: it *finds* editable strings
by scanning the block for printable-ASCII runs and filtering to the ones that read as prose.
That heuristic is the whole feature — a run that slips through is a format string the user can
corrupt, and one wrongly rejected is text they can't reach. This drives the real
`web/text-core.js` over both halves: the filter (prose accepted; format specifiers, paths, hex
literals, identifiers and ALL-CAPS labels rejected) and the scanner (absolute offsets, on-disk
slot lengths, runs split by control bytes, and the safety property that **every returned slot
is entirely printable**, since the editor writes `max` bytes back over it).

`validate.mjs` additionally asserts the heuristic stays in lockstep with the desktop's
`_looks_like_text` in `Editor/s3editor.py` — min length, reject pattern, prose punctuation,
ratio and scan range are compared literal by literal, so the two editors can't drift into
offering different strings for the same disc. The JS port was differential-tested against the
Python over 6,000 randomized strings (0 mismatches).

```bash
node web/tests/text-core.mjs
```

## `save_roundtrip.py` (via `save-roundtrip.mjs`) — save engine, no browser
The Save Editor runs `Editor/s3save.py` unchanged in the browser (Pyodide). This drives that
same module directly against a **synthetic** 53264-byte `gamedata` payload (the repo ships no
real saves): decode → edit → write → re-decode, asserting every field persists and the
gamedata checksum invariant (all u32 words sum to 0) holds. Also unit-checks the memory-card
ECC helper and the file-rejection path. It imports `s3save` for the offsets/checksum, so the
fixture can't drift from the engine. The `.mjs` wrapper lets it ride in `npm test` and
**skips cleanly (exit 0)** if `python3` isn't installed.

```bash
node web/tests/save-roundtrip.mjs        # or: python3 web/tests/save_roundtrip.py
```

## `e2e.mjs` — full end-to-end in headless Chromium (runs in CI)
Drives the real ISO editor against a synthetic in-bounds ISO (`synth-iso.mjs`): load +
version check, rune reskin + presets, spell target edit, per-field revert, undo/redo, gear
DEF→description rewrite, food edit, skill-cap presets, Balance (hard-mode) preset, the
bestiary view, the recruit section (per-character + story fade), the backup-nudge → confirm →
byte-exact save path, **planted-byte assertions that the verified table offsets still decode
correctly** (skill-max +16, growth HP@+0, rune Head/Right/Left), and no horizontal overflow at
320/360px.

It also covers the save editor's **guide overlays** end-to-end: Pyodide is aborted, so the
suite hands `drawSlot()` a synthetic decoded save (the shape `s3save.decode_save` returns) and
asserts the notes reach the DOM — growth range, join level, rune-slot unlock, per-character
skill cap, "can't learn", and that an uncovered support character renders none.

Runs in CI (a dedicated `e2e` job installs Chromium via `playwright-core install`). Locally it
needs `playwright-core` + a Chromium binary and **skips cleanly (exit 0)** if neither is
present, so it never breaks a minimal setup.

```bash
npm --prefix web/tests install          # installs playwright-core
node web/tests/e2e.mjs                   # uses playwright's own chromium
PW_CHROMIUM=/path/to/chrome node web/tests/e2e.mjs   # or point at an existing binary
```

No real ISO is used or needed — the synthetic image is just the editable region with the
USA version word and a few planted records. Verifying a **real** SLUS-20387 disc (edit →
save → re-open → PCSX2 boot) is still a manual step before trusting the editor widely.
