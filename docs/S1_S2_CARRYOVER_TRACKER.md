# Tracker — enabling Suikoden I / II carryover in a Suikoden III save

**Goal:** let the web save editor turn "I loaded my Suikoden II memory-card data" on or off
in an existing `gamedata` file, and edit everything that carryover actually controls.

Reverse-engineered 2026-08-30 from `SLUS_203.87` and from the memory-card / title overlay
inside `DATA/ETC.BIN`, both read straight out of `ISO/Suikoden III (USA).iso` (SLUS-20387).
All work was read-only; no bytes were written to the disc.

---

## Status

| # | Task | Status |
|---|---|---|
| 1 | Find where S3 reads a previous game's save at all | **done** — Suikoden II only, dir `BASLUS-00958` |
| 2 | Find the flag primitive and where its array lives in the save | **done** — `GameFlag()` @ `0x16D3930`, array at file `0x30` |
| 3 | Find the "S2 data loaded" / "S1 data loaded" bits | **done** — file `0x31` bit 3 and bit 4 |
| 4 | Map the 8 carryover/player name slots to file offsets | **done** — see §4 |
| 5 | Find everything else the import writes | **done** — level, weapon level and 3 runes for 3 characters (§5) |
| 6 | Work out what the flags actually unlock in-game | **partial** — script condition ids `0x248`/`0x249`; per-map EDS scripts not enumerated |
| 7 | Confirm bit meaning of the S2-save byte that gates the S1 half | **open** — see §7 |
| 8 | Confirm the three carryover characters | **done** — Viki, Futch, Belle (§5) |
| 9 | Fix the editor's name-field map + carryover heuristic | **done** — 8 slots + flag-based `detect_carryover()` |
| 10 | Add a real Carryover editor (flags + names + per-character import) | **done** — see §8 |
| 11 | Verify a hand-flagged save in PCSX2 | **open** — see §9 |

---

## 1. There is no Suikoden I reader

The whole 4 GB disc contains exactly two PS2 memory-card directory names:

| String | ISO (first copy) | Meaning |
|---|---|---|
| `BASLUS-20387sui3_u` | `0x417D5378` | Suikoden III's own save |
| `BASLUS-00958` | `0x417D5750` | **Suikoden II (USA)** |
| `BIHOGE-99999` | `0x417D5760` | debug/dummy slot |

There is no `BASLUS-00292` (Suikoden I) anywhere, and every user-facing string in the
module says "Suikoden II data" — e.g. `Would you like to load Suikoden II data?`,
`The memory card(8MB) … contains no Suikoden II data.`

So **Suikoden I data reaches S3 only through a Suikoden II save**, which itself records the
S1 hero and country. Any UI that offers "load S1 data" and "load S2 data" as two
independent things is modelling the game wrong.

## 2. Address convention

The whole save is one contiguous RAM block:

```
save-file offset = EE address − 0x0196B3F0 + 0x10
```

`0x0196B3F0` is `bzero`'d for `0xD000` bytes on new game (`0x16D3698`), and `0xD000 + 0x10`
= 53,264 = the exact size of an extracted `gamedata` file. So the file is a **0x10-byte
header followed by the live 0xD000 block**. This mapping converts any ELF address (or any
Cheat-Engine/PNACH address) into a save offset, which is worth keeping around beyond this
feature.

## 3. The flag array — and the two flags

`GameFlag(index, bit, op)` @ **`0x16D3930`**:

```
if (index >= 0x200 || bit >= 8) return 0;
byte *p = (u8*)0x0196B410 + index;      // file offset 0x30 + index
if (op == 6) *p |=  (1 << bit);         // set
if (op == 7) *p &= ~(1 << bit);         // clear
return (*p >> bit) & 1;                 // every op also reads
```

So the save carries a **4096-bit flag array at file `0x30` … `0x22F`** (the recruit-word
table at `0x232` starts immediately after it).

The Suikoden II importer sets exactly two of them:

| Flag | Save byte | Mask | Set at (ISO) | Meaning |
|---|---|---|---|---|
| `GameFlag(1, 3)` | **`0x31`** | **`0x08`** | `0x419F9A80` (dup `0x41AD8080`) | Suikoden **II** data loaded |
| `GameFlag(1, 4)` | **`0x31`** | **`0x10`** | `0x419F9B58` (dup `0x41AD8158`) | Suikoden **I** data loaded (via the S2 save) |

All five sample saves in `Saves/_extracted_s3/` have `0x31 == 0x00`, i.e. no carryover —
consistent with their name fields all holding S3's built-in defaults.

**Readers.** `0x17B54C8` is the script-condition evaluator; condition id `0x248` returns
`GameFlag(1,3)` and `0x249` returns `GameFlag(1,4)`. Those two ids are what map scripts and
NPC dialogue tables test, so the visible effect of the flags is script-driven (dialogue
variants, and the substituted hero/country names of §4). Enumerating every EDS script that
tests `0x248`/`0x249` is task 6 and is not done.

## 4. The eight name slots

`SetName(index, mode, src)` @ **`0x16D49E8`** — `index < 8`, jump-table dispatch, so the
slots are *not* laid out in index order. `mode 2` = set (`strncpy`, 0x10 bytes, or clear if
`src == NULL`), `mode 3` = get (returns the slot pointer, or `NULL` when the slot's first
byte is 0). Defaults are installed on new game from the pointer table at `0x0199F1D0`
(`0x16D3620`).

| idx | Save offset | Default | What it is | Written by the S2 import? |
|---|---|---|---|---|
| 0 | `0xCA13` | `McDohl` | Suikoden I hero | yes — see §7 |
| 1 | `0xCA24` | `Toran` | Suikoden I country | yes — see §7 |
| 2 | `0xCA35` | `Genkaku Jr.` | Suikoden II hero | yes ← S2 save `+0x1812` |
| 3 | `0xCA46` | `Dunan` | Suikoden II name #2 (castle or army) | yes ← S2 save `+0x18B1` |
| 4 | `0xCA57` | `Dunan` | Suikoden II name #3 (army or castle) | yes ← S2 save `+0x189F` |
| 5 | `0xC9E0` | `Hideo` | **Flame Champion** (player-entered) | no |
| 6 | `0xCA02` | `Dunan` | Suikoden II country/state | **no** |
| 7 | `0xC9F1` | `Budehuc` | **Castle** (player-entered) | no |

Slots are 17 bytes apart (`0xC9E0 + n*0x11`) but the *index* order above is what the code
uses. Two slots default to `Dunan` and are imported (3, 4); a third defaults to `Dunan` and
is never touched by the importer (6).

## 5. The import writes more than names

The importer is `0x121CBA0` in the ETC.BIN overlay (ISO `0x419F9990`, second copy at
`0x41AD7F90`; that overlay loads at EE `0x0120…`, calibrated by pinning its mcMan status
strings — `ISO = vaddr + 0x407DCE40`). Its argument is the loaded Suikoden II save buffer.

After the names, it walks a 3-entry table at `0x012139A8` of **Suikoden II character record
indices** — `4`, `9`, `0x29` — and maps each to a Suikoden III character via `0x121CB08`.
The output is a **battle-character id** (the 1..0xD8 space that `0x16C6D08` bounds-checks
and that the "Party Modifier digits" cheat reference lists), *not* a roster index:

| S2 record index | → S3 battle id | roster slot | Character |
|---|---|---|---|
| 4 | 7 | 6 | **Viki** |
| 9 | 0x1F (31) | 29 | **Futch** |
| 0x29 (41) | 0x34 (52) | 45 | **Belle** |

All three are Suikoden II characters, which is the cross-check that the id space is being
read right (reading the same numbers as roster indices or as `s3_names.json` `list1` ids
produces a nonsense trio).

For each, the S2 character record at `S2save + 0x840 + index*0x34` supplies:

- `+0x00` **level** → the S3 character is levelled up (`0x16C8CC0` in a loop) to
  `cur + cur*max(0, s2Level-50)/100`, capped at 99, and a level-99 Suikoden II character is
  worth a further **+5**. It is one-way: the import only ever levels a character *up*.
- `+0x13` **weapon level** → `cur + max(0, s2WeaponLv-10)/2`, capped at 16 (`0x16C9430`).
- `+0x15`, `+0x16`, `+0x17` **three runes** → remapped and equipped into the character's
  three rune slots (`0x16D62B0`, or `0x16DD2F8` slot-by-slot on the other branch).

The rune remap is the 38-entry u16 table at `0x012139B0`, indexed by `s2RuneId - 1`. Only
seven Suikoden III runes are reachable:

| S2 rune id | → S3 item |
|---|---|
| 1, 2 | `0x13D` Fire |
| 3, 4 | `0x149` Water |
| 5, 6 | `0x145` Wind |
| 7, 8 | `0x14C` Earth |
| 9, 10 | `0x141` Lightning |
| 15 | `0x14F` Blinking |
| 17 | `0x151` Pale Gate |

Every other S2 rune maps to 0 — nothing carries over.

**This is the part a flag flip alone will not reproduce**, which is why the editor asks for
the Suikoden II numbers and runs these formulas rather than pretending the bit does it.

## 6. Where the names come from inside the Suikoden II save

Offsets are into the S2 `gamedata` file as S3 loads it:

| S2 offset | Feeds |
|---|---|
| `+0x1812` | S2 hero → slot 2 |
| `+0x1896` | S1 hero → slot 0 |
| `+0x189F` | → slot 4 |
| `+0x18A8` | S1 country → slot 1 |
| `+0x18B1` | → slot 3 |
| `+0x1F3F` bit 1 (`0x02`) | gates the whole S1 half (slots 0/1 and flag `(1,4)`) |

Names are 9 bytes in Suikoden II's own charset, converted by `0x121CA70`. The charset is
simple: `a`–`z` = `0x11`–`0x2A`, `A`–`Z` = `0x3B`–`0x54`. (That is how the two 9-byte blobs
at `0x01213A00` / `0x01213A10` were identified as `McDohl` and `Toran`.)

## 7. Open question — the S1 half looks self-defeating

Reading the code literally:

```
if (S2save[0x1F3F] & 2) {
    memcpy(S2buf + 0x1896, "McDohl", 9);   // constants from 0x01213A00
    memcpy(S2buf + 0x18A8, "Toran",  9);   //          and 0x01213A10
    SetName(0, 2, decode(S2buf + 0x1896));
    SetName(1, 2, decode(S2buf + 0x18A8));
    GameFlag(1, 4, SET);
}
```

It seeds the canonical defaults **into the source buffer** and then reads them back, so on
this path the S1 hero/country always come out as `McDohl`/`Toran` regardless of what the
player's actual Suikoden I hero was called. Two readings fit:

- bit `0x02` means "this S2 save has **no** Suikoden I carryover", the seeding is
  deliberate, and the flag means "S1 names are valid (as defaults)"; or
- bit `0x02` means "S1 data present" and the seeding is a retail bug that discards it.

Nothing else on the disc writes slots 0/1 from an S2 save, so one of the two is true.
Resolving it needs a real Suikoden II memory-card save (task 7) — it does not block the
editor work, because either way the editor's job is to let the user type the names.

## 8. Editor work — done

`Editor/s3save.py` (the engine the web editor runs under Pyodide):

- `FLAG_BASE`/`FLAG_COUNT` + `game_flag()` / `set_game_flag()` — the engine's whole boolean
  store, now addressable. Useful well beyond this feature.
- `CARRYOVER_FLAGS` and a rewritten `detect_carryover()`: the answer is the flag, with the
  name comparison kept only as a secondary "these are still the defaults" hint. The old
  heuristic also read `0xCA02`, a slot the importer never writes.
- `NAME_FIELDS` grew from five slots to all eight, with `NAME_DEFAULTS` for each.
- `carryover_level()` / `carryover_weapon_level()` / `carryover_bonus_edits()` — the
  importer's own arithmetic, returning edits in the shape `apply_edits_to_gamedata()` takes.
- `apply_edits_to_gamedata(..., carryover={"s1": bool, "s2": bool})`, threaded through
  `write_save_edits()` and every container writer. Setting a bit that is already set is not
  counted as a change, so ticking a box back and forth doesn't force a write.

`web/app.js`:

- A **Suikoden I / II carryover** card at the top of the save editor: one checkbox per game,
  each labelled with the actual byte/bit (`0x31 bit 3`, `0x31 bit 4`) and the current
  contents of that game's name slots. Ticking one stages like any other edit — it appears in
  the review modal and goes out in the write payload.
- All eight name fields are now editable in the Names grid.
- A **Suikoden II bonus** modal: enter what Viki, Futch and Belle were in your Suikoden II
  save (level, weapon level, up to three runes from the seven that can carry over) and it
  stages the resulting character edits, ticking the Suikoden II flag alongside them.
- Carryover state round-trips through the save JSON export/import.

Tests: `web/tests/save_roundtrip.py` gains a carryover section (flag address, round trip,
clear, the formulas, the name-slot layout) and `web/tests/e2e.mjs` gains a headless UI
section (rows render with the byte/bit, staging reaches the payload, the bonus modal stages
character edits). `npm test` and `node e2e.mjs` both pass.

## 9. Verification plan

1. In the web editor, tick both carryover boxes on a clone of a real save and set the five
   carryover names to non-default values. (By hand: `0x31 |= 0x18`, then fix the checksum.)
2. Boot the clone under the PCSX2 harness (`docs/PCSX2_AUTOMATION.md`) and read the names
   back where the game prints them (Budehuc library text / NPC dialogue that substitutes
   the S1 and S2 hero names).
3. Confirm `GameFlag(1,3)`/`(1,4)` survive a save→load round trip, i.e. that the game does
   not recompute them from the memory card on load.
4. Diff a real "loaded S2 data" save against the same save without it, to catch anything
   this pass missed outside `0x31` and the name slots.

## 10. Addresses touched

| Symbol | EE vaddr | ISO |
|---|---|---|
| `GameFlag(index, bit, op)` | `0x16D3930` | `0x11AE30`-ish (ELF) |
| `SetName(index, mode, src)` | `0x16D49E8` | ELF |
| name defaults installer | `0x16D3620` | ELF |
| name defaults pointer table | `0x0199F1D0` | ELF |
| new-game init (`bzero 0xD000`) | `0x16D3698` | ELF |
| script condition evaluator (`0x248`/`0x249`) | `0x17B54C8` | ELF |
| **S2 importer** | `0x121CBA0` (overlay) | `0x419F9990`, `0x41AD7F90` |
| S2 charset decoder | `0x121CA70` (overlay) | — |
| S2→S3 character id map | `0x121CB08` (overlay) | — |
| S2 char list / rune map | `0x012139A8` / `0x012139B0` | — |
| mcMan strings (`BASLUS-00958`, prompts) | `0x006A0110` … | `0x417D5750` … |

Overlay calibration: copy 1 `ISO = vaddr + 0x41135640`; copy 2 (the one holding the
importer) `ISO = vaddr + 0x407DCE40`. Both were pinned by matching the mcMan status-string
block (`OK` / `NOPERMIT` / `NOFILE` / …) against its pointer table.
