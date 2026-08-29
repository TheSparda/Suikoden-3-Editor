# Web editor tests

Five layers, all runnable with plain Node (v18+):

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

## `vcdiff.mjs` — the .xdelta encoder **and** decoder
The encoder synthesizes a patch from known edits; the decoder reads patches back, which is
what lets the editor apply a community mod. Those are very different problems: the encoder
only has to emit one shape, while the decoder must cope with whatever xdelta3 produced — the
full RFC 3284 default code table, all nine address modes with both caches, RUN, app headers
and the VCD_ADLER32 extension. So the decode tests run **real xdelta3 output** (nine file
shapes × four encoder settings) rather than our own encoder's, and the encoder round-trips now
go through the *shipped* decoder so the two halves check each other.

Also asserted: the derived-diff property the ISO editor depends on (skipping windows whose
`plan()` is empty and diffing the rest must reproduce the true diff **exactly**, while reading
a fraction of the file), and the refusals — LZMA-compressed patches (xdelta3's default) are
reported with the `-S none` fix rather than mis-decoded, and a patch applied to the wrong
source fails its stored checksum.

Install `xdelta3` to get any of that; without it those checks self-skip (CI installs it).

```bash
node web/tests/vcdiff.mjs
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

The **Text** tab is driven against planted strings (one prose, one format string that must
*not* be offered): byte-exact write, NUL padding, no write past the slot, over-length
rejection, undo/redo and per-field revert.

**Applying patches** is driven with patches built by real `xdelta3` against the synthetic ISO
— apply → staged (not written) → one-step undo → save writes the right bytes — plus every
refusal: a patch reaching outside the editable block, an LZMA-compressed one, a wrong-size
one, and one built against a different source disc (caught by its checksum). An `.s3mod`
recipe deliberately named `.xdelta` proves the format is sniffed from content, not the name.

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
save → re-open → PCSX2 boot) is a step no synthetic fixture can cover — every table the
editor writes lives in the boot ELF, so "right about the file, wrong about the game" is a
failure only the game can catch. [`tools/pcsx2/`](../../tools/pcsx2/) now scripts that
half (`boot-verify`: boot the disc, snapshot EE RAM, compare the tables byte-for-byte
against the disc), and its own logic is covered offline by
`python3 tools/pcsx2/selftest.py`, which runs in CI. Running `boot-verify` still needs a
disc and a PS2 BIOS, which CI does not have.
