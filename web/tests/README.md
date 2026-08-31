# Web editor tests

Twelve suites, all runnable with plain Node (v18+). `npm test` runs the ten browser-free
ones; `npm run test:e2e` runs the Playwright suite; `version-drift.mjs` is a pre-push check
run on its own (see below):

## `version-drift.mjs` — pre-push, catches the collision git can't

Not part of `npm test` (it compares against your last-fetched `origin/main`, so it is a
pre-push check, not a CI one). Run `git fetch` first, then:

```bash
node web/tests/version-drift.mjs
```

It checks **`HEAD` — the commit you would push — not the working tree**, and in this repo that
distinction is load-bearing. Several sessions share one checkout and commit from an explicit
file list, so the tree is *not* what gets pushed. Reading the checkout would both count a peer's
in-flight edits as yours and miss a stale version line that is genuinely committed. When there
are uncommitted `web/` files it says so, rather than quietly ignoring them. `--branch <ref>`
checks another ref; `--worktree` checks the checkout, which is the right mode in an ordinary
single-user repo.

**Why it exists.** Two branches that both bump `web/index.html` and `web/sw.js` to the *same*
number rebase with **no conflict at all** — git sees identical content on both sides, so there
is nothing to flag. The loser's branch ends up byte-identical to main on both lines, its feature
merges, and the only symptom is that everyone still holding the old service-worker cache never
receives it. "Rebased clean" is the signal you would normally trust, which is exactly what makes
this failure mode nasty: the usual alarm cannot fire, and it silently hurts the users least
likely to complain.

So the assertion is **inverted** from the usual — an *identical* version line is the failure,
and only when `web/` has otherwise changed. It also rejects a half-bump (app version moved but
sw cache didn't, or vice versa). Self-skips when there is no git or no `origin/main`.

Real incident, 2026-08-30: two sessions both took v1.45.0 / `s3editor-v65`. The rebase reported
success and zero conflicts.

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

## `health-core.mjs` — the save health check, no browser
The Health panel's job is to tell someone their save is fine, so a **false negative is worse
than no feature at all** — it blesses a broken file — and a false positive trains people to
ignore the panel. This drives the real `web/health-core.js` both ways: a consistent save must
produce **zero** findings, and each defect must produce exactly its own. It also asserts the
property that makes the Fix buttons trustworthy — staging a finding's `fix.ops` back through
the same edit maps the UI uses and re-auditing makes that finding **go away** — and that the
audit sees *pending* edits, not just the bytes on disk. Finally it keeps the item
classification (stackable bands, the nine exceptions, `ITEM_QTY_MAX` / `ITEM_ID_MAX`) in
lockstep with `Editor/s3save.py`; that copy now lives in `health-core.js` and is what the
inventory UI uses too, so a drift would misclassify items in both places at once.

```bash
node web/tests/health-core.mjs
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

`validate.mjs` additionally pins the heuristic's literals (min length, reject pattern, prose
punctuation, ratio) and checks the accept/reject behaviour on known-good and known-bad runs.
These used to be compared against a second copy in the desktop editor; that editor is gone and
`text-core.js` is now the only implementation, so the literals are pinned here directly. The JS
port was differential-tested against the Python over 6,000 randomized strings (0 mismatches).

```bash
node web/tests/text-core.mjs
```

## `recruit-logic.mjs` — recruit bit math, no browser
The save editor's Recruit and 108 Stars views stage recruitment by rewriting bits 2-5 of each
character's recruit word. That staging math is the part a wrong edit corrupts, and the UI
around it needs Pyodide (unavailable headless). This drives the real `web/recruit-core.js`
against the committed team map: bulk recruit / move / un-recruit, the team presets, and the
per-team counts.

```bash
node web/tests/recruit-logic.mjs
```

## `rename-core.mjs` — the disc-wide rename, no browser
The ISO editor's character rename is a same-length global byte replacement applied during a
streaming save, so a bug writes wrong bytes across the whole disc. This drives the real
`web/rename-core.js`: the same-length rule, space padding of shorter names, rejection of
longer ones, and the streaming replacer across chunk boundaries.

```bash
node web/tests/rename-core.mjs
```

## `desc-merge.mjs` — the description merge, no browser
Item and skill pickers show merged descriptions: rune/food text from `s3_rune_food_desc.json`
overrides the drifted equipment pool in `s3_item_desc.json`, and skills prefer the per-rank
effects in `s3_skill_ref.json`. The save editor stubs Pyodide in e2e, so this is the only
place the merged strings are asserted — against the real committed data.

```bash
node web/tests/desc-merge.mjs
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

## `field-avatar.mjs` — the field-character gate, no browser
The ISO tab's **Field character** section patches a hardcoded comparison chain in the boot ELF
(`FieldAvatarModelRequest` @ vaddr `0x17B7560` — see
[`docs/FIELD_CHARACTER_RESEARCH.md`](../../docs/FIELD_CHARACTER_RESEARCH.md)). Two things there
can go wrong silently, and both are checked here.

`web/iso.js` has no save engine to ask, so it **restates** `s3save.PARTY_IDS` and
`FIELD_AVATAR_IDS`. If the Python ever changes, the tab keeps rendering — with every chip
labelled as the wrong character. Both tables are parsed back out of `Editor/s3save.py` and
compared. Second, the tab's "currently loadable" readout is the *only* feedback a user gets
that a patch worked, and it works by re-running the game's own chain over the bytes just
written; that simulation is driven against the stock immediates (must reproduce the eight
whitelisted ids exactly, and reject Sarah) and against the widened ones (must admit all 75
battle ids, keep the two specials, and still refuse id 0).

When an `ISO/` folder is present in the checkout — following the `.git` pointer file, so it
also finds the disc from a worktree — the five patch sites and the three read-only bounds are
byte-checked against the pristine disc, which is what makes the constants *this disc's* rather
than merely self-consistent. That half self-skips in CI.

```bash
node web/tests/field-avatar.mjs
```

## `e2e.mjs` — full end-to-end in headless Chromium (runs in CI)
Drives the real ISO editor against a synthetic in-bounds ISO (`synth-iso.mjs`): load +
version check, rune reskin + presets, spell target edit, per-field revert, undo/redo, gear
DEF→description rewrite, food edit, skill-cap presets, Balance (hard-mode) preset, the
bestiary view, the recruit section (per-character + story fade), the backup-nudge → confirm →
byte-exact save path, **planted-byte assertions that the verified table offsets still decode
correctly** (skill-max +16, growth HP@+0, rune Head/Right/Left), and no horizontal overflow at
320/360px.

It also drives the **Health panel** against a synthetic save with planted defects: the tab
badge, the rendered findings, and — the part that matters — that clicking a **Fix** only
*stages* an edit (it lands in the review list and the finding disappears) rather than writing
anything.

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

## `stream-save.mjs` — the phone save path, byte for byte

`e2e.mjs` saves through a **stubbed** `FileSystemWritable`, which only exists on desktop
Chromium. Every phone takes the other path: no `showSaveFilePicker`, so the editor re-streams
the whole disc with the edited region spliced in, hands the stream to the real service worker,
and downloads it. That loop — chunked reads, the splice, the disc-wide rename, the service
worker hand-off — had no coverage, and its failure modes (a chunk boundary landing mid-region,
a splice off by one, a rename that lands in only one chunk) are all invisible to the in-place
path.

This test runs it for real: no FS Access API, a real registered service worker, a real
download, then the downloaded image is compared to the source byte for byte. Everything
outside the editable block must be identical *except* a "Hugo" planted at 0x1000 — outside
the block on purpose, since reaching it is the entire reason the streaming save exists.

```bash
node web/tests/stream-save.mjs      # or: npm --prefix web/tests run test:stream
```

Skips cleanly (exit 0) without playwright-core/Chromium, and if the service worker never
takes control.
