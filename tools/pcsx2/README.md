# PCSX2 harness

Scripted control of a PCSX2 run: boot a disc, read and write the emulated PS2's memory,
snapshot RAM, diff snapshots, compare screenshots. Pure standard library — no pip
install.

Why it exists and what it's for is in [`docs/PCSX2_AUTOMATION.md`](../../docs/PCSX2_AUTOMATION.md).

## Start here

```bash
python3 -m tools.pcsx2.cli doctor      # what's present, what's missing, what each unlocks
python3 tools/pcsx2/selftest.py        # 112 offline checks; needs no emulator
```

Run everything from the repo root — the package import expects it.

## Setup

1. **PCSX2 2.x** on `PATH` (`pcsx2-qt`), or set `PCSX2_BIN=/path/to/pcsx2-qt`. An
   AppImage in `~/Applications` or `~/Downloads` is found automatically.
2. **PINE server**: Settings → Advanced → **Enable PINE Server**, slot 28011.
3. A PS2 BIOS configured in PCSX2 (the harness can't supply one; without it the process
   exits during boot and `wait_ready` says so).
4. Headless only: `xvfb` (the launch is wrapped in `xvfb-run` when `DISPLAY` is unset).
5. Screenshots only: `xdotool` and a real X display.

Optional environment: `S3_ISO`, `PINE_SOCKET`, `PCSX2_STATES_DIR`, `PCSX2_SNAPS_DIR`.

## Commands

| Command | Needs | What it does |
|---|---|---|
| `doctor` | nothing | Reports which pieces are available. |
| `boot-verify [ISO]` | PCSX2 + BIOS + ISO | Boots the disc, calibrates the ELF→RAM mapping against a live dump, and checks every editor table byte-for-byte against the disc. Exits 77 (skip) with no PCSX2. |
| `snapshot OUT` | running PCSX2 | Saves a state and writes its 32 MB EE RAM image to `OUT`. |
| `diff A B` | nothing | Summarises where two RAM dumps differ, largest runs first. |
| `scan --changed A B [...]` | nothing | Narrows candidate addresses across snapshot pairs. |
| `codes DUMP [--iso ...]` | nothing | Finds `ETC.BIN` asset names (`cha_`, `imf_`, …) resident in a dump, mapping ELF hits back to disc offsets. |
| `read ADDR` / `poke ADDR VALUE` | running PCSX2 | Single memory read/write. |
| `states` | nothing | Where PCSX2 keeps savestates and screenshots. |

## Modules

| File | Responsibility |
|---|---|
| `pine.py` | PINE IPC client — memory r/w, savestate control, disc identity. Probes whether the server accepts batched commands and falls back if not. |
| `savestate.py` | Pulls the EE RAM image out of a `.p2s` (a zip). Whole-RAM snapshots in one step. |
| `ramscan.py` | Differential scanning: seed from a change, narrow with what must not have changed, subtract the noise floor. |
| `eemap.py` | ISO file offset ↔ EE address, calibrated per boot against an anchor rather than trusting the documented constant. |
| `pngdiff.py` | PNG decode + 64-bit perceptual hash, so "did the picture change" is answerable without Pillow. |
| `harness.py` | Launches and tears down PCSX2; Xvfb wrapping, boot waiting, snapshots, screenshots. |
| `cli.py` | The commands above. |
| `selftest.py` | Offline tests for all of it. |

## `edsprobe.py` — what is the event script waiting on?

Written for one open question: a scripted scene **hangs** when the field avatar is not one of
the four protagonists (seen with Koroku, Yuber and Lucia), while ordinary NPC dialogue works
fine for all of them. Guessing has already produced two wrong answers, so this reads the state
instead of inferring it.

While the game is stuck, the EDS interpreter is parked on one opcode. Sampling the script
pointer twice says whether it is spinning; the opcode number says on what.

```bash
python3 -m tools.pcsx2.edsprobe --watch 20     # while the game is hung
```

It prints `STUCK` with the opcode and its handler address, or `RUNNING` if the pointer moves —
in which case the wait is not in the script interpreter at all, which is just as useful to
know. Reads only; nothing is written.

The pointer chain, so it can be re-checked rather than trusted: `*(0x196A4D0)` is the
field/scene work struct; both interpreter entry points (`0x1778768`, `0x1778D78`) compute the
script context as `work + 0x150`; every opcode handler reads its operands through
`ctx + 0x0C`; and `0x19828F8` is the 359-entry handler table, so
`opcode = (handler - table) / 4`. Handlers advance past the opcode word before reading
operands, so the probe prints the value at the pointer *and* the one behind it — a
mis-derivation shows up rather than passing silently.

Covered by `selftest.py` against a fake client: the chain resolution, the opcode round-trip,
both verdicts, and the two "not in a scene" error paths.

## What the tests do and don't cover

`selftest.py` runs with no emulator, ISO or BIOS. It drives the PINE client against a
**mock server** (both batched and unbatched), the savestate reader against a hand-built
zip, the scanner against dumps with a planted character id and a planted noise floor, the
ELF calibration against a planted anchor, and the PNG hash against images it encodes
itself — one per filter type, since a hand-written PNG reader is exactly where a silent
decode bug would hide.

It cannot check the half only a real PCSX2 can answer: that the opcode numbers match the
emulator's, that batching is framed as assumed, and that the ELF loads where the docs
say. Those are handled at runtime instead — the client probes and falls back, and
`boot-verify` re-derives the load address from a live dump. Nothing here reports success
by skipping a check: `doctor` names what's missing, and `boot-verify` exits 77 rather
than passing vacuously.
