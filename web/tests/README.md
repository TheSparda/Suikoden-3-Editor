# Web editor tests

Three layers, all runnable with plain Node (v18+):

## `validate.mjs` — fast, no browser (runs in CI + on session start)
Checks the client JS parses, every ISO table offset stays inside the read block, the
reference-table parsers still return the expected item/skill counts, and the app shell is
wired (loads `iso.js`, both mode tabs present, service worker precaches `iso.js`).

```bash
node web/tests/validate.mjs
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
