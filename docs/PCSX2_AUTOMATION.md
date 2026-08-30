# Automating PCSX2 — what's possible, and what it buys this project

Short answer to the two questions that prompted this: **yes, PCSX2 can be driven
entirely from a script**, and that capability changes the model-swap picture — not by
making the ISO-level swap in `ETC_BIN_MODEL_RESEARCH.md` work, but by making the one
question that killed it (*where is the model index table?*) into a search a machine can
run instead of a thing a human has to guess.

The harness lives in [`tools/pcsx2/`](../tools/pcsx2/); this document is the reasoning.

---

## 1. What PCSX2 actually exposes

| Facility | Automatable? | What it gives us |
|---|---|---|
| **Command line** (`-batch`, `-nogui`, `-fastboot`, `-turbo`, `-state`, `-statefile`, `-elf`, `-logfile`) | ✅ fully | Start a run and have the process *exit* when emulation stops, so a test can wait on it. `-batch -nogui` is the closest thing to headless. |
| **PINE** (Settings → Advanced → Enable PINE Server, slot 28011) | ✅ fully | Read/write emulated memory at 8/16/32/64-bit while the game runs, plus save/load state, disc serial, title, run status. This is the backbone. |
| **Savestates** (`.p2s`) | ✅ fully | A `.p2s` is a **zip** whose members include the raw 32 MB EE RAM image. Save via PINE, unzip, and you have a whole-RAM snapshot in one step — vs. hours over the socket. |
| **Texture replacement** (dump → `replacements/`) | ✅ fully | Re-skin anything on screen without touching the ISO. |
| **Cheat/patch files** (`.pnach`) | ✅ fully | Apply memory writes every frame at boot, with no ISO edit and no external process. The delivery format for any runtime swap we find. |
| **Screenshots** | ⚠️ via hotkey | No CLI or PINE command. Needs the screenshot hotkey driven by `xdotool` on an X display. |
| **Controller input** | ⚠️ via hotkey/uinput | Same story. In practice you avoid it: savestates are the checkpoints, so nothing has to be *played*. |
| **Debugger** (breakpoints, memory watch) | ❌ GUI only | Not scriptable. Anything a write-breakpoint would answer has to be reframed as a differential RAM scan. |
| **Lua / built-in scripting** | ❌ doesn't exist | Unlike some emulators, there is no script host — automation is always out-of-process. |

Headless caveat: `-nogui` hides the *main window*, not the game output, so a CI box still
needs a display. The harness wraps the launch in `xvfb-run` when `DISPLAY` is unset.

## 2. Three loops this makes possible

### 2.1 Boot verification — regression-testing the editor itself

This is the immediate, unglamorous win, and it closes a gap the test suite already names:
`web/tests/README.md` ends with *"Verifying a real SLUS-20387 disc (edit → save →
re-open → PCSX2 boot) is still a manual step."*

Every table the editor writes — `list1`..`list4`, the shop tables, the 94-record rune
table — lives inside the boot ELF, which the PS2 loads into RAM as one contiguous block.
`Editor/Suikoden3_ISO_offsets.md` already records the mapping
(`file_off = (vaddr - 0x165D000) + 0xA4800`). So:

    patch the ISO → boot it in PCSX2 → snapshot EE RAM → read the patched bytes back

…is a complete end-to-end test with no human, no controller and no screenshot. It
catches the whole class of failure that unit tests structurally cannot: an offset that
is right about the file and wrong about the game.

    python3 -m tools.pcsx2.cli boot-verify "ISO/Suikoden III (USA).iso"

Note that the harness **re-derives** the ELF load address from the live dump instead of
trusting the documented constant (`eemap.calibrate` finds a known 64-byte anchor from
the disc inside the RAM image). If the doc constant ever drifts, or the game relocates
its executable, that shows up as a calibration failure rather than as a table of
convincing garbage.

### 2.2 RAM archaeology — asking questions the ISO can't answer

Two RAM snapshots taken under controlled conditions, differenced, answer questions that
static analysis of a 4.3 GB disc cannot. `tools/pcsx2/ramscan.py` is a scripted Cheat
Engine for this: seed a candidate set from what *changed*, then narrow it with what must
*not* have changed.

The noise floor is the thing to plan for — timers, RNG and audio buffers move on every
single snapshot and survive naive scans. Take three or four snapshots with *nothing*
changed, feed them to `volatile_addresses()`, and subtract that from every later scan.

`RECRUITMENT_RANDOMIZER_RESEARCH.md` proposes a PCSX2 write-breakpoint study for its Q1
("is recruitment centralized?"). That needs the GUI debugger, which isn't scriptable —
but the same question restated as *"which words change when a unit is recruited, and are
they in the ELF or in heap?"* is a differential scan, and that runs unattended.

### 2.3 Swap experiments — poke, then look

`poke a candidate → force a scene reload → screenshot → compare` is a closed loop, so
hundreds of candidates can be tried without a human watching. `pngdiff.py` does the
comparison with a 64-bit perceptual hash (and decodes PNG with `zlib` rather than pulling
in Pillow, to match the repo's zero-dependency habit).

---

## 3. So: Hugo → Luc?

### 3.1 What we already know, and what it doesn't rule out

`ETC_BIN_MODEL_RESEARCH.md` is right and its verdict stands: you cannot swap models by
editing `ETC.BIN` in place. Payloads are compressed, variable-length and tightly packed,
the archive is addressed by precomputed index, and a name-swap test booted with no
visible change. A real disc-level swap needs a full archive rebuild plus a fix to an
offset table **whose location was never found**.

That last clause is the opening. "We couldn't find the table" is not the same as "there
is no table" — and finding a structure in 32 MB of live memory is exactly what a scanner
is for. The doc's Phase 1 stopped where a human's patience does; the harness doesn't
have that limit.

### 3.2 Route A — find the index and patch it at runtime

If the loader picks a model by index, that index is a value in RAM at the moment a scene
loads. Change the value, get a different model — no repack, no compression RE, and the
result ships as a `.pnach` rather than a modified ISO.

Suikoden III makes the A/B experiment unusually cheap. The Trinity Sight System runs
three protagonists' chapters through **overlapping areas**, so you can stand in the same
place with a different lead character — same map bundle, different actor. That is a
controlled pair handed to you by the game's own structure:

1. Savestates at the same spot in Hugo's, Chris's and Geddoe's chapters.
2. Snapshot each; snapshot one of them 3× more without moving, for the noise floor.
3. `first_changed(hugo, chris)` → `keep_changed(chris, geddoe)` →
   `keep_unchanged(hugo, hugo₂)` → `exclude_near(noise)` → `keep_value_between(0, 255)`.
4. Poke each survivor, reload the scene, diff the screenshot.

```bash
python3 -m tools.pcsx2.cli scan \
    --changed hugo.ee chris.ee --changed chris.ee geddoe.ee \
    --unchanged hugo.ee hugo2.ee --max 255
```

Step 3 also settles, for free, the identity question §5 of the research doc left open —
which of `syu1/syu2/syu3` is Hugo. Whichever index value corresponds to the Hugo
snapshot is the answer.

**Finding Luc's code** is the same trick pointed at a different scene. The research doc
couldn't find a `luc*` entry among the 194 codes and couldn't tell whether `luis`/`lusi`
are Luc, Lucia, or neither. But a savestate in a scene where Luc is *on screen* has his
assets resident, so:

```bash
python3 -m tools.pcsx2.cli codes luc_scene.ee --iso "ISO/Suikoden III (USA).iso"
```

lists the asset names live in memory; set-difference that against the same dump from a
Luc-free scene and the residue is Luc's. Any hit that maps back inside the ELF is
better still — that's the resident table, at a **file offset the editor could patch**.

### 3.3 Route B — texture replacement (works today, no RE at all)

PCSX2 can dump every texture the game uploads and load replacements from a folder. Hugo
wearing Luc's textures is a few hours of dumping and mapping, needs no reverse
engineering, no ISO edit, and cannot corrupt anything. It changes the skin, not the mesh
or the skeleton — Hugo-shaped Luc, not Luc.

If the goal is "make Hugo look different", this is the honest first answer, and the
harness helps only as a driver (boot to a scene, dump, repeat).

### 3.4 Route C — swap who's in the party, not what they look like

The repo already edits saves (`Editor/s3save.py`) and has recruit tooling. Putting Luc
in a party slot is a data edit, not a graphics one. It won't touch story-locked
appearances, but for "play as someone else" it's the shortest path and it exists now.

### 3.5 Constraints that still apply to Route A

Automation removes the search problem, not the physics:

- **Per-scene duplication.** Each area bundle re-embeds the characters it uses. Pointing
  the index at a character whose assets aren't resident gets you a missing model or a
  crash, not Luc. Realistic scope is a swap between two characters already co-present in
  the loaded bundle — which is why the Trinity overlap areas are the right place to work.
- **Skeleton compatibility** is unverified. Both are bipeds, which is the best case, but
  animation data may be per-model.
- **Expect crashes.** That's fine and cheap here: savestates make every attempt
  restartable in seconds, which is the whole reason to automate rather than hand-test.

None of this promises a working Hugo→Luc swap. It says the next unanswered question is
now a scriptable experiment rather than a wall, and it names the exact command to run.

---

## 4. Honest limits of the harness as shipped

- The **PINE opcode numbers and batch framing follow the protocol spec, not a verified
  handshake with a real emulator** — none was available here. The client therefore
  probes batching on connect and silently falls back to one command per message if the
  reply isn't the expected length, and `selftest.py` drives both paths against a mock
  server. If the opcodes are ever wrong, `cli.py doctor` and `boot-verify` fail loudly
  on the first read rather than returning plausible numbers.
- The **ELF load address is treated as a guess** and re-derived per boot, as above.
- **Screenshots need X + `xdotool`.** Without them the harness still runs; it just can't
  answer "did the picture change", so swap verification degrades to memory reads.
- Nothing here has been run against a real disc, BIOS or emulator. Every layer that
  *could* be tested without one is tested (112 checks in `tools/pcsx2/selftest.py`); the
  rest is gated behind `doctor` reporting what's missing.
