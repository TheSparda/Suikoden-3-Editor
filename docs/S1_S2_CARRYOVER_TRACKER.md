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
| 5 | Find everything else the import writes | **done for the ELF path** — 3 characters get level + runes (§5) |
| 6 | Work out what the flags actually unlock in-game | **partial** — script condition ids `0x248`/`0x249`; per-map EDS scripts not enumerated |
| 7 | Confirm bit meaning of the S2-save byte that gates the S1 half | **open** — see §7 |
| 8 | Confirm the three carryover characters by name in-game | **open** — ids resolve to 7 / 31 / 52 (§5) |
| 9 | Fix the editor's current name-field labels + carryover heuristic | **not started** — see §8 |
| 10 | Add a real Carryover editor (flags + names + per-character import) | **not started** — see §8 |
| 11 | Verify a hand-flagged save in PCSX2 | **not started** — see §9 |

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
indices** — `4`, `9`, `0x29` — maps each to a Suikoden III character id via `0x121CB08`:

| S2 record index | → S3 character id | S3 name per `Editor/s3_names.json` `list1` |
|---|---|---|
| 4 | 7 | Viki (Old) |
| 9 | 0x1F (31) | Bright |
| 0x29 (41) | 0x34 (52) | Mua |

For each, it reads the S2 character record at `S2save + 0x840 + index*0x34`:

- `+0x00` — level, fed through `min(0x34*lvl + lvl/100, 99)` and applied by repeated
  level-up calls (`0x16C8CC0` / `0x16C8FC0`);
- `+0x13`, `+0x15`, `+0x16`, `+0x17` — four equipment/rune ids, remapped through the u16
  table at `0x012139B0` (`0x13D`, `0x149`, `0x145`, `0x14C`, `0x141`, …) and equipped via
  `0x16DD2F8`.

**This is the part a flag flip alone will not reproduce.** Setting `0x31 |= 0x18` by hand
gives you the dialogue/name half of carryover; the character levels and runes are ordinary
save state the editor already edits, so the editor can offer them as a separate "apply the
import's effects" action rather than pretending the flag does it.

The third id (52 → "Mua") is the one to double-check in-game: Viki and Bright are both
plausible Suikoden II returnees, the third is not obviously so, and `list1` in
`Editor/s3_names.json` only covers 79 of the ~109 roster slots.

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

## 8. Editor work

**Fix what is already there** (`Editor/s3save.py`, `web/app.js`):

- [ ] `detect_carryover()` reads `0xCA02` as "SII army/country". That slot (index 6) is
      **never written by the importer**; the imported S2 secondary names are `0xCA46` and
      `0xCA57`. The heuristic should read those.
- [ ] The heuristic itself can go: `0x31 & 0x08` / `0x31 & 0x10` is the real answer.
      Keep the name comparison only as a "names differ from defaults" hint.
- [ ] `NAME_FIELDS` is missing three slots (`0xCA46`, `0xCA57`, and `0xCA02` is mislabelled),
      and the two player names' defaults are `Hideo` / `Budehuc`, not blank.
- [ ] Names are stored full-width Shift-JIS for the imported slots — already handled by
      `_read_str` / `_to_fullwidth`; the new slots need the same treatment.

**Add** (web editor is the only editor — `web/`):

- [ ] A "Carryover" card: two checkboxes bound to `0x31` bit 3 / bit 4, plus the five
      carryover name fields, plus the two player name fields.
- [ ] An "apply Suikoden II bonus" button that additionally sets the three characters'
      levels and equipped runes (§5), since the flags alone do not.
- [ ] Recompute the save checksum on write (existing path already does).
- [ ] Version + `sw.js` cache bump, claimed from `origin/main` immediately before writing.

## 9. Verification plan

1. Clone a sample save, set `0x31 |= 0x18`, fix the checksum, write the five carryover
   names to non-default values.
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
