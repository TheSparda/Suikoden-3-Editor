# Suikoden 3 (PS2) ISO Hex-Edit Reference

Reverse-engineered from `Suikoden3EditorV12b.exe` (.NET 4.7.2 WinForms app
`Suikoden_3_ISO_Editor`, "version 1.2b by Tony H"). All offsets are **raw byte
positions into the ISO file** (the editor uses `BinaryReader/Writer.BaseStream.Position`
directly — no LBA/sector math).

## Target / version check
- Only the **USA** release works: serial **SLUS-20387**. JP version unsupported.
- Validation: read a `uint32` at offset **4136544** (0x3F1E60), byte-swap it
  (big-endian read), and require it to equal **1084660225** (0x40A69A01).
  Mismatch → "Could not tell which ROM you have."
  *(Verified against `Suikoden III (USA).iso`, 4,295,000,064 bytes, 2026-08-09:
  bytes at that offset are `40 A6 9A 01` → matches. Boot serial `SLUS_203.87`
  confirmed in SYSTEM.CNF at 0x8298D.)*
- The app patches **in place with no backup** — copy the ISO first.

## Record tables (indexed by 3-digit character/entry number N)

The name lists in the UI are just `NNN Label` lines; the editor parses the first
3 ASCII digits of the clicked line into N, then `addr = base + N*stride`.

| List | Purpose | Base offset (dec / hex) | Stride | Record layout |
|------|---------|-------------------------|--------|---------------|
| 1 | Character starting stats | 4078716 / 0x3E3C7C | 140 | see below |
| 2 | Stat growth / skill max levels | 4068152 / 0x3E1338 | 132 | mostly bytes |
| 3 | Support character skills | 4089904 / 0x3E6830 | 8 | 8 bytes |
| 4 | (list 4 record) | 4061704 / 0x3DFA08 | 28 | 16 bytes |

### List 1 — starting stats (stride 140), fields relative to record start
- +0  u16  UNVERIFIED (list1_1). NOT a 0/1 flag and NOT an item id — observed 0..1100
           across the roster, exceeding the 612 max item id. Meaning unknown; shown raw.
- +9  u8   weapon-growth CLASS (list1_2), 0..13. Groups the roster by weapon curve
           (Hugo=3; Chris/Geddoe/Borus/Queen=5). Not a 1:1 index into the 28 list4 curves.
- +12..+25  14× u8 (list1_3 … list1_14) — skills/runes/equip block
- +64 u16, +72 u16, +80 u16, +88 u16, +96 u16, +104 u16 (list1_15…20) — equip block:
  **rune Head @+64, rune Right @+72, rune Left @+80**, helmet @+88, armor @+96, shield @+104.
  *(Rune-slot order VERIFIED vs `suikosource/initial.txt` and the save editor: Fubar Head=Shining
  Wind, Chris Left=Phoenix, Elaine Right=Water/Left=Fire. The exe's write-order naming had Head
  and Left swapped — corrected in s3fields.py / iso.js. See issue #2.)*
- +112 u16 + u8, +120 u16 + u8, +128 u16 + u8 (list1_21…26)

### List 2 — growth/skill limits (stride 132)
- **Growth rates** (u8 each), stat↔byte VERIFIED by correlation vs `suikosource/statgrowth.txt`
  across the roster: `+4`=PWR `+5`=SKL `+6`=MAG `+7`=REP `+9`=MDF `+10`=SPD `+11`=LUK `+0`=HP.
  This is the exe's own Patch write-set `{+0,+4,+5,+6,+7,+9,+10,+11}`. `+1..+3` are always 0
  (padding) and `+8` is a sparse non-growth field (nonzero on only ~12/79 records).
  *(Correction: earlier notes labeled `+0/+1/+2` as Head/RH/LH "rune level" — WRONG. `+0` is HP
  growth; `+1/+2` are padding; there are no per-character rune-level bytes here. See issue #2.)*
- **Skill max-level array**: 43 skills (ids `0x01..0x2B`) as consecutive u8 at **`+16..+58`**
  (skill id N → byte `+16+(N-1)`). VERIFIED vs `suikosource/skills.txt`: 988/1100 known caps
  match at `+16` (~90%; remainder is guide-vs-data variance plus a few lead chars stored as
  all-S), vs ~12% at the old `+13`. *(The exe exposed `+13..+58` as generic fields `list2_9..54`;
  `+13/+14/+15` are 3 non-cap bytes before the array — do not treat them as skills 1-3.)*
- Skill max-level encoding (UNCHANGED, correct): 0=Can't get, 1=A+, 2=D, 3=C, 4=B, 5=B+, 6=A, 7=S.
  Note 1=A+ is non-monotonic: A+ ranks between A (6) and S (7) but is stored as 1.
  **Max is 7** as of v1.2b (8 caused in-game problems). Rank ladder confirmed vs the Suikosource
  Skills List guide: E<D<C<B<B+<A<A+<S.
- **`+102` (0x66) u16 — ASSIGNED HORSE** (model id). The game reads this to decide whether a
  character rides in the field *and* in battle: `hasAssignedHorse(chara) || isValidRidePair(...)`.
  Stock, six records carry one — Chris = 309 (`s2um`, her own horse), Roland/Leo/Percival/Borus/
  Salome = 308 (`zkum`, the Zexen-knight horse); every other record is 0. The consumer at
  `0x16c76e4` tests `(value - 308) < 2` unsigned, so **only 308 and 309 are honoured** — any
  other mount id is read and silently discarded. See `docs/MOUNT_SYSTEM_RESEARCH.md` §11.
- **`+120` (0x78) u8 — MOVEMENT CLASS.** Picks the character's row in the field walk/run speed
  table at **ISO `0x3B0BE0`** (14 records of `{u32 modelId, f32 walk, f32 run, f32 timeScale}`).
  `GetModelClass` @ `0x16c7310` reads it; `0x16f3e20` copies the row's floats into the field
  object at `+0x248` / `+0x24C` / `+0x2C` when it is built. Stock, **walk is 2.0 for every
  record** and run is 6.0 (classes 0, 3, 5–8), 5.0 (classes 1, 4) or 4.5 (class 2) — Hugo is
  class 3, Geddoe class 1, Chris class 2, which is why running as Chris is visibly slower.
  Classes 9–13 have no member. See `docs/MOVEMENT_SPEED_RESEARCH.md`.
- `+12` u8 (unknown; values like 5/9/17/18/34/81/98). `+80..+96` 17×u8 (list2_60…76, fixed-skills
  block); `+100..+101` 2×u8 (list2_80,81, starting level + relative flag).

### List 3 — support skills (stride 8): 8 consecutive bytes.
### List 4 — (stride 28): 16 consecutive bytes at record start.

## Fixed shop / inventory tables (not indexed)
| Offset (dec / hex) | Count × width | Meaning |
|--------------------|---------------|---------|
| 4136564 / 0x3F1E74 | 3 × u32 | item1 group (item1_1..3) — verified `[1000, 200000, 12000]` |
| 3970620 / 0x3C963C | 15 × u32 | **price ladder**, verified `[100,300,600,1500,2700,3500,4500,7000,11000,18000,27000,35000,43000,52000,60000]` (potch) — NOT item IDs |
| 4105552 / 0x3EA550 | 10 × u16 | item3 shop slots 1–10 — verified IDs `[1,10,9,299,301,0…]` |
| 4054224 / 0x3DDCD0 | 16 × u16 | item3 shop slots 21–36 — verified IDs `[162,184,195,208,224,252,238,264,273,274,290,0…]` |

## Notes on encoding
- Item IDs are **3-digit hex** (see `Suikoden3_item_ids.txt`, range 001–264).
- Skill IDs are **2-digit hex** 01–2B (see `Suikoden3_skill_ids.txt`).
- Reads/writes are little-endian **except** the version check, which is read
  big-endian via `ReverseBytes32`. Helpers `ReverseBytes16/32/64` exist in the
  binary but only the 32-bit one is used (for the SLUS check).
- Editing starting-stat / growth values must be done **before starting a new
  game**; skills/runes changed in list 1 must match list 2.

## Files in this folder
- `Suikoden3EditorV12b.exe` — original editor.
- `Suikoden3Editor_decompiled.cs` — full ilspycmd decompilation (source of the above).
- `Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt` — extracted ID tables.

## Suikosource data (fetched 2026-08-09 via Playwright + system Chrome)
The site is behind **Anubis** (a JS proof-of-work wall) that plain HTTP fetches
can't clear. A headless real-Chrome session solves the challenge and returns the
pages. Saved copies are in `suikosource/`:
- `skills.txt` — Skills List (Blue Moon): skill-point progression chart per rank
  (E→S) and full skill descriptions. Cross-references the 01–2B skill IDs.
- `initial.txt` — Initial Equipment / Rune Slot List (wataru14/genso710): per
  character Lv, WLv, rune head/R.hand/L.hand, helmet, armor, shield, and 3 "Other"
  item slots. This is the human-readable form of **list 1** (starting stats).
  `<NN>` in a rune column = number of free/removable rune slots.
- `statgrowth.txt` — Stat Growth Charts (genso710/Kuromimi/KoRnholio): per
  character growth rate + per-level ranges for PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK/HP.
  This is the human-readable form of **list 2** (growth rates / skill max levels).

Other relevant S3 guide URLs (same fetch method): `/games/gs3/guides/` has
Antiques, Duel, Endings, MP, Misc Items, Rare Armor, Recipes, Rune Casting,
Story Bosses, Unites, Weapon Growth. Character/rune master lists live at
`/chars/list` and `/runes/list`.

### Mapping guides → editor tables
The editor keys each record by the **3-digit number** prefixing a name in its
own list, then `addr = base + N*stride`. Suikosource's alphabetical guides don't
carry those indices, so to edit a specific character you still read the index
from the editor's name list (or the game), then apply the layout in this doc.
Use the Suikosource guides to know *what values are legal/normal* for each field.

## External references
- Item list credited to **Pyrieal**; "easier to read" copy at
  `http://herrvillain.net/cheats/suikoden/codes/digits.htm` (returned HTTP 502 on 2026-08-09).

## Spell / Rune-Effect table (located & validated 2026-08-09)
Found by resolving rune-name string pointers inside the boot ELF. **94 records ×
0x20 bytes**, starting at **file 0x3EC2A0** (verified against the live ISO).

ELF map: ELF header @ file 0xA3800; PT_LOAD file 0xA4800 → vaddr 0x165D000.
`file_off = (vaddr - 0x165D000) + 0xA4800`.

Per-record layout (0x20 bytes):
| Off | Type | Field | Status |
|-----|------|-------|--------|
| +0x00 | u16 | linkA (anim/effect index) | unconfirmed |
| +0x02 | u16 | linkB | unconfirmed |
| +0x04 | u16 | `kind` — **low byte = element** (Fire=1,Water=2,Wind=3,Earth=4,Lightning=5); high byte = rune id | confirmed element |
| +0x06 | u8 | misc | — |
| +0x08 | u32 | → name string (vaddr) | **confirmed anchor** |
| +0x0C | u32 | → description string (vaddr) — e.g. "Fire MGC. 700DMG to target+foes+allies in area." | confirmed |
| +0x10 | u32 | **cast MOV / cast time** | confirmed vs Suikosource casting-time guide |
| +0x14 | u32 | **targeting bitfield** — see decode below | **AOE bit CONFIRMED** |
| +0x18 | u32 | flags/target mask (status effects, heal targets) | unconfirmed |
| +0x1C | u32 | **spell power / damage** | strong: matches "NNNDMG" in description text |

Notes:
- The description string literally states damage and target shape, so it's the
  ground-truth for validating edits (e.g. change power at +0x1C, the number in
  the description will NOT auto-update — it's static text).
- Rune "attack" skills (Phoenix, Double Tusk, etc.) use `power` as a multiplier
  context (descriptions say "DMGx2") rather than a flat number.
### flags14 targeting bitfield (decoded across all 94 records, 0 exceptions)
The **target byte** = bits 8–15 of flags14. Structure:
- **bit 15 (0x8000) = AREA-of-effect.** Set for every "in area" spell, clear for
  every non-area spell — a clean, exception-free discriminator. This IS the AOE flag.
- **bit 12 (0x1000) = LINE / front / LOS** ("in front", "beyond", "divided among").
- **low nibble of target byte** = who is hit:
  `0xA` = single ("1 foe"/"1 ally"), `0x2` = all foes, `0x3` = foes+allies,
  `0x1` = self/buff (heals, stat-ups).
- The low byte (bits 0–7) is typically `0x0A` for damage spells / `0x42`,`0x87` for
  heals+status; not fully mapped but not needed for target shape.

Examples: Flaming Arrows `0x0A0A` (single) vs Explosion `0x830A` (area:foes+allies)
vs Thunder Runner `0x120A` (line:foes). To make a single-target spell AOE, set
bit 15: `0x0A0A → 0x8A0A` (or match a real area spell's `0x830A`).

### flags14 low byte (bits 0–7) = damage/effect kind
Validated against descriptions: `0x0A`=direct damage (44 of 63 say "DMG"),
`0x87`=pure heal (5/5 restore HP), `0x42`=status/utility (sleep, silence),
`0x4A`=damage+status (`0x0A | 0x40`; the 0x40 bit adds a status rider to a damage
spell — Funeral Wind, instant-death), `0x02`=utility, `0x83`=cure-all,
`0x46`=heal+status, `0x06`=none/placeholder.

### flags18 (+0x18) = status-effect / enhance bitmask
Isolated from spells that carry exactly one effect (0 ambiguity on those):
| Bit | Mask | Effect | Proof spell |
|-----|------|--------|-------------|
| 1 | 0x00000002 | poison | Ripple |
| 3 | 0x00000008 | instant death | Funeral Wind, Open Gate |
| 4 | 0x00000010 | unbalance | Isshin |
| 9 | 0x00000200 | teleport / chant-speed | Ready!, Go!, Song of Skylark |
| 10 | 0x00000400 | sleep | Wind of Sleep |
| 13 | 0x00002000 | silence / berserk | Silent Lake, Battle Oath |
| 14 | 0x00004000 | MGC boost | Battlefield |
| 15 | 0x00008000 | MGC shield (once) | Canopy Defense |
| 19 | 0x00080000 | MGC-immune once | Vengeful Child |
| 21 | 0x00200000 | buff PDF/MDF | Clay Guardian |
| 22–24 | 0x00400000.. | sword-enhance fire/lightning/wind | Sword of Rage/Thunder/Cyclone |
| 25–27 | 0x02000000.. | elemental resist fire/lightning/wind | Fire/Thunder/Wind Amulet |

Full heal/restore spells (Healing Wind, Kindness Drops/Rain, Mother Ocean, Great
Blessing) set the composite mask **0x1DE7** = "restore HP + clear all status/combat
state at once", rather than one bit.

`linkA` (+0x00) high byte loosely tracks spell tier but is not a clean index;
`linkB` (+0x02) is a constant `0x8080` on ~all records (fixed marker). Neither is
useful for editing — leave them alone.

`dump-spell` now prints all of this decoded (element / target / kind / status).

### Patcher commands
```
python3 s3patch.py spells      "ISO"                 # list all 94 with cast/power/kind/flags
python3 s3patch.py dump-spell  "ISO" --index 3       # decode one record + resolve name/desc
python3 s3patch.py set-spell   "ISO" --index 3 --field power    --value 1500
python3 s3patch.py set-spell   "ISO" --index 3 --field cast_mov --value 50
python3 s3patch.py set-aoe     "ISO" --index 0 --on     # make Flaming Arrows area-of-effect
python3 s3patch.py set-aoe     "ISO" --index 3 --off    # make Explosion single-target
python3 s3patch.py set-spell   "ISO" --index 0 --field flags14  --value 0x830A   # full manual flag write
```

## Custom runes — rune→spell mapping (partially located 2026-08-09)
A **spell-index list table** sits at **file 0x3B0FA8** (preceded by a pointer
0x019E7690). It is runs of 1-byte spell indices (into the 94-entry spell table)
separated by `0x00` bytes, e.g. `00 01 02 03 | 04..0B | 0C..1F | 20 21 22 | ...`.
A second identical copy starts at 0x3B1088.

Status: **mechanism found, keying NOT yet confirmed.** These index-lists are how
the game says "this group grants spells X,Y,Z,W", which is exactly what you'd edit
to build a custom rune's spell set. What's still unverified is which group maps to
which rune *item ID* (13D+) — needs a cross-reference pass (find the struct that
holds both a rune id and a pointer/offset into this list).

What IS fully editable today (spell effect table @0x3EC2A0): for any of the 94
spells you can change damage (+0x1C), cast time (+0x10), element (+0x04),
target/AOE (+0x14), and status effect (+0x18). So "make rune X's spells hit harder
/ become AOE / add poison" works right now. "Make rune X grant a completely
different set of spells" needs the keying above confirmed first.

## Custom rune — Level 1 (reskin) vs Level 2 (reassign spells)
**Level 1 (WORKS NOW): change what a rune's existing spells do.** The `reskin`
command rewrites any spell's power / cast / element / AOE / status in one call:
```
python3 s3patch.py reskin "ISO" --index 5 --power 3000 --aoe on --element Water --status sleep
```
`--status` accepts: none, poison, instant-death, unbalance, sleep, teleport/chant,
silence/berserk, buff-pdf/mdf, sword-*, resist-*. Shows before/after decode and
backs up first (--no-backup to skip). To reskin a whole rune, reskin each of its
4 spell indices.

**Level 2 (NOT cracked): make a rune grant a DIFFERENT set of spells.**
Investigated three candidate tables, none is the rune→spell binding:
- 0x3B0FA8 = sequential item remap (0..0x6D), not rune grouping.
- 0x42EE90 = spell UNLOCK-LEVEL thresholds, 4×u16 per group (e.g. [1,20,60,99]).
  *(This one IS useful on its own: it sets the character levels at which each of a
  rune's 4 spells becomes available — editable, just not the spell identity.)*
- spell `kind` high byte = loose element/class tag, mixes runes; not a selector.
The actual binding is likely a rune-definition struct keyed by rune item ID (13D+)
pointing into the spell table — still needs a dedicated hunt to confirm before any
Level-2 edits are safe.

## Level 2 rune→spell binding — investigation status (2026-08-09)
Ground truth from Suikosource: Fire Rune grants spells [0,1,2,3], True Fire
[2,3,4,5], Lightning [6,7,8,9], Earth [24,25,26,27], etc.

Why byte-search FAILS to find the binding: those quads are contiguous ascending
runs (0,1,2,3…), which match generic counter/index arrays all over the ELF —
every hit at 0x3C91xx/0x3C93xx is a false positive (literally `01 00 02 00 03 00…`).
So value-matching cannot isolate the table. Confirmed dead ends this session:
0x3B0FA8 (item remap), 0x42EE90 (unlock-level thresholds), spell `kind` hi byte.

What WOULD crack it (needs a disassembler pass, not byte search):
1. Load the boot ELF in Ghidra/IDA (base vaddr 0x165D000) and find the function
   that reads the spell table (base vaddr 0x019A4AA0, stride 0x20). Its caller
   passes the spell index — trace back to where that index comes from per rune.
2. OR find the rune ITEM definition struct (keyed by item id 13D+) and look for a
   field that is a small int / pointer resolving to a spell index or index-list.
Until then, Level-2 (reassign a rune's spell lineup) is UNSOLVED and must not be
attempted by blind byte edits.

## Level-1 rune reskin — shipped & tested (2026-08-09)
Two commands, both validated on an APFS clone of the ISO (original never touched):
```
# one spell
python3 s3patch.py reskin      "ISO" --index 3 --power 3000 --aoe on --status poison
# a whole rune's spell set at once (resolves spells by name from RUNE_SPELLS map)
python3 s3patch.py reskin-rune "ISO" --rune fire --power 3000 --aoe on
```
Known runes: fire, rage, truefire, lightning, thunder, truelightning, cyclone,
flowing, earth, motherearth, trueearth, shield, blinking, jongleur, palegate,
swordofrage, swordofthunder, swordofcyclone.

Safe testing: `Editor/make_test_iso.sh "ISO"` makes a clone (instant on APFS via
`cp -c`), applies an example Fire-rune buff, and prints PCSX2 verification steps.
Rule going forward: test writes on a clone, never the original.

Confirmed NOT possible from this table: visual/animation reskin (link fields
correlate with behavior/kind, not graphics assets; visuals live in separate
asset files). Level-2 spell reassignment remains unsolved (needs Ghidra).

## Cross-platform GUI: s3editor.py (web app, 2026-08-09)
Stdlib-only local web app (no pip installs). Reuses all s3patch logic.
```
python3 Editor/s3editor.py "ISO/Suikoden III (USA).iso"      # opens browser at 127.0.0.1:8747
python3 Editor/s3editor.py "ISO/...TEST.iso" 8748            # custom port
```
Tabs: Spells (per-spell power/cast/element/AOE/status, live filter), Runes
(bulk-edit a rune's whole spell set), Shop (item pickers with names + price
fields), Characters (raw byte editor for list1-4 records). Makes ONE backup on
first write per session. Verified end-to-end on an APFS clone; original untouched.
Env S3_NO_BROWSER=1 skips auto-opening the browser (for headless/testing).
Works on macOS/Linux/Windows with any Python 3 + a browser.

## Web app — exe feature parity (2026-08-09)
s3editor.py now mirrors the original exe's editable fields, with named inputs:
- **Characters tab**: list1 Starting Stats (skill 1-6 + ranks, L/R/Head rune, helmet,
  armor, shield, 3 Other items+amounts), list2 Growth rates + rune levels + the full
  43-entry Skill Maximum Levels array (each named by skill), list3 Support Skills.
  Item/skill fields show the resolved name; field labels/offsets taken from the
  decompiled exe (see s3fields.py).
- **Reference tab**: the exe's "Item hex list" / "Skill hex list" as a searchable table.
- Plus Spells + Runes tabs, which the exe did NOT have (our additions).

NOT ported (and why): the exe's character NAME lists were empty in the binary —
users pasted a numbered list from an offline cheat site. No canonical name->index
map exists in the exe or on Suikosource (its char list is alphabetical, unnumbered),
so the web app uses the same numeric character index the exe operated on.

## Web app — in-browser ISO selection (2026-08-09)
s3editor.py now starts WITHOUT an ISO argument:
```
python3 Editor/s3editor.py          # then pick an ISO in the browser
python3 Editor/s3editor.py 9000     # custom port, still browser-picks
python3 Editor/s3editor.py "ISO/Suikoden III (USA).iso"   # still works: preloads
```
Header has a "Select ISO…/Change ISO" button. The picker scans nearby folders
(launch dir, parent, ./ISO, Editor/, ../ISO) up to 2 levels deep and lists .iso
files with size, plus a full-path text field. Selection is server-side by PATH
(a 4 GB file can't be uploaded through a browser). Opening runs the SLUS-20387
version check and rejects the wrong release. Data endpoints return a clean
{"error":"no ISO loaded"} until one is chosen; the server never crashes.

## One-click launchers (2026-08-09)
- macOS: double-click **Editor/Start Editor (Mac).command**. First time only, if
  Gatekeeper blocks it, right-click -> Open. It finds python3/python, starts the
  server, and the browser opens itself.
- Windows: double-click **Editor/Start Editor (Windows).bat**. Uses the `py`
  launcher or `python`. If Python is missing it points to python.org and reminds
  you to tick "Add Python to PATH".
Both keep a small console window open; closing it (or Ctrl+C) stops the editor.
No install step, no dependencies — plain Python 3 + a browser.

## Web app — Spells tab grouped by rune (2026-08-09)
The Spells tab now renders one card/section per rune (Fire Rune, True Fire Rune,
Lightning Rune, …) instead of one flat table. Each spell appears once, under the
first rune that grants it (runes share spells, so first-match avoids duplicate
editable rows). Spells not tied to a magic rune (rune-attacks, unite, misc) fall
into a final "Other" section. Verified partition: 18 rune sections + Other, all 94
spells covered with no dupes. The filter box searches across every section.

## Spell target / "size" editing (2026-08-09)
Investigated whether spells carry a numeric area RADIUS: they do NOT. Verified by
dumping every byte of all area spells — e.g. Explosion ("in area") and Hellfire
("all in area") are byte-identical in structure; the +0x06 misc byte only varies
on heal/buff spells and doesn't track area size. The game determines target shape
entirely from the flags14 TARGET BYTE (bits 8-15), not a radius number.

So the editable control is a **Target / Size dropdown** (Spells + Runes tabs),
writing the whole target byte while preserving flags14's low byte (damage kind):
  0x0A Single · 0x02 All foes · 0x03 All foes+allies · 0x12 Line/in front ·
  0x82 Area (foes) · 0x83 Area (foes+allies) · 0x01 Self/ally buff ·
  0x09 Heal single · 0x81 Heal area
Backend: write_spell accepts fields.target (0..255); it sets bits 8-15 of flags14.
Verified round-trip Single<->Area on a clone; AOE flag + Shape pill update live.

## Character editor — full exe parity (2026-08-09)
The web app's Characters tab now covers every field the exe edited, as named
inputs with dropdowns for equipment/rune/skill fields (pick "Fire" not 0x13D):
- **list1 Starting Stats**: skills 1-6 + ranks, L/R/Head rune, helmet, armor,
  shield, 3 Other items + amounts, skill points, relative indicator.
- **list2**: Growth rates (PWR/SKL/MAG/REP/MDF/SPD/LUK/HP) + Head/RH/LH rune
  levels; 43-entry Skill Maximum Levels; **Fixed Skills block** (Fixed Skill 1-8
  ids + "level learned", Number of Free Skills, Starting level + relative flag)
  at +80..+96 / +100..+101 — the block I'd previously omitted.
- **list3 Support Skills**: 8 skill-id bytes.
Equipment/skill dropdowns are populated from /api/items (508) and /api/skills (43).
Verified on a clone: list2 shows 3 groups, fixed-skills resolve real skill names,
list1 equipment resolves item names, a dropdown write (Rune Head Phoenix->Fire)
round-trips, original untouched.

Character NAME is intentionally NOT a field: the exe never edited names either
(its name lists were user-pasted from an offline cheat site). No canonical
name->index map exists in the exe or on Suikosource, so both tools key by the
same numeric character index. Skill-Maximum array is surfaced in skill-id order
(0x01..0x2B); the exe's grid used the same underlying bytes.

## Unite attacks + Spells-tab regrouping (2026-08-09)
UNITES: unite names/descriptions live inside the ELF (~0x424400 string cluster,
e.g. Twister, Bow-Wow, Mercenary B/D, Triangle Strike, Tinto). Pointers to them
form a clean array: **38 records x 0x28 bytes at file 0x3ECF90**, each using the
SAME field layout as spells (cast +0x10, target +0x14, power +0x1C). My earlier
'0x168 nested struct' read was wrong — the real stride is 0x28. Field map verified
vs Suikosource unite guide: Twister 50/40, Bow-Wow 300/95, Triangle Strike 200/65,
Pretty Girl 70/55 all match. NOW EDITABLE.

SPELLS TAB: the former flat "Other" bucket is now split — each remaining named
spell renders as its own "<Name> Rune" card under an "Attack Runes & Other
Abilities" divider (Phoenix, Double Tusk, Ripple, weapon-innate skills, plus a
few extra magic-rune spells beyond the 4 in RUNE_SPELLS). Truly-blank slots go to
"Unused / placeholder slots". Verified partition: 18 magic + 45 ability + 3 unused
= all 94, no dupes.

## Rune family ordering + character-name dropdown investigation (2026-08-09)
RUNE ORDER: Spells tab + Runes-tab dropdown now order magic runes by element
family (Fire->Rage->TrueFire, Lightning->Thunder->TrueLightning,
Earth->MotherEarth->TrueEarth, then Cyclone/Flowing, Shield/Blinking/Jongleur/
PaleGate, Sword-of-* runes), instead of alphabetically.

CHARACTER NAME DROPDOWN: CORRECTED. The names ARE in the exe after all — stored
as plain-ASCII 'NNN - Name' lines in the list1RTB/list2RTB/list3RTB/list4RTB.Text
resources (my earlier UTF-16-only scan missed them). Extracted to s3_names.json:
  list1/list2 = 79 main characters (Hugo=1, Chris=2, Geddoe=3 ...),
  list3 = 34 support characters (Apple=1 ...), list4 = 28 weapon attack types.
The web app loads this JSON and shows a NAME dropdown per section; the index it
writes is the same one the exe used (verified: Geddoe=3 loads his real record).

## Character NAME dropdown — shipped (2026-08-09)
Extracted the exe's built-in name lists (they were plain ASCII in the RichTextBox
.Text resources, not RTF/UTF-16). Saved to Editor/s3_names.json and wired into the
Characters tab as a per-section name dropdown ("001 — Hugo"). Switching section
repopulates the list. Verified on a clone (Geddoe=index 3 -> loads Lightning head rune).

## Unite editing — shipped (2026-08-09)
UNITE_TABLE_FILE=0x3ECF90, UNITE_COUNT=38, UNITE_STRIDE=0x28. Same field offsets
as spells. Added to s3patch.py (constants) and s3editor.py (read_unites/write_unite,
/api/unites, /api/unite) with a new "Unites" tab: editable power / cast / target,
searchable by name or effect text. Verified on a clone: Twister power 50->9999 and
target change round-trip; original untouched. Values pre-validated against Suikosource.

## In-game descriptions surfaced (2026-08-09)
- Spells / Runes / Unites tabs: each row now shows the game's own description
  string (read from the record's desc pointer) as an italic caption line beneath.
- Character tab skill fields: show the skill's description (from Suikosource skills
  guide, parsed to Editor/s3_skill_desc.json, 32 skills) in the row's note column,
  updating live when you change the skill dropdown; also as an <option> tooltip.

## Item descriptions — authoritative extraction (2026-08-09)
Found the item RECORD table: stride 0x44, **desc pointer at +0x00, name pointer at
+0x40**, in the ELF data region (~0x3DC800+). Walked it to pair each equipment name
with its exact description (e.g. Wooden Shield -> "DEF(+78)/ SPD(+10)/ Status
Protect"). Saved 226 verified equipment descriptions to Editor/s3_item_desc.json.
Surfaced in: Shop tab rows, Character-tab equipment dropdowns (note line + live
refresh), and as <option> tooltips.

IMPORTANT LIMIT: only EQUIPMENT (weapons/armor/shields/accessories) has a name<->desc
pointer record. Consumables, runes, food, misc are stored positionally in a string
pool with NO name back-pointer (their name strings are referenced 0 times; shared
descs like "Heals 250HP" are referenced many times). Pairing those by pool order
DRIFTS and produced wrong results (e.g. "Medicine D :: Performs an accidental
attack") — so they are intentionally left blank rather than shown incorrectly.
Correct-or-blank, never wrong.

## Equipment effects — mapped + editable (2026-08-09)
Gear record (stride 0x44): desc ptr +0x00, price u32 +0x08, DEF u16 +0x10,
name ptr +0x40. Effect slots: up to 5, each 8 bytes at +0x14,+0x1C,+0x24,+0x2C,+0x34
= (type u16, value u16, skill_id u16, pad u16). Effect types (verified vs
descriptions across 148 gear records):
  1=HP regen/turn  2=SPD  3=PWR  4=MDF  5=Grant skill (3rd word = skill id,
  e.g. Prosperity Hat = Fire Magic 0x0E + Lightning Magic 0x12)  6=Status Protect
  7=Elemental Resist  8=Evade ATK.
find_gear_records() in s3patch keys records by item id (validates desc has '(',
DEF<500, price<2M to reject false pointer matches). New "Gear" tab in s3editor
edits DEF, price, and all 5 effect slots per item (type dropdown + amount + skill
dropdown when type=5). Verified on a clone: read 148 items with correct effects;
added HP-regen 25 + Fire-Magic grant + DEF 99 to New Robe, round-tripped; original
untouched. Auto-heal gear present: Feathered Hat/Sun Badge/Chaos Shield (5HP),
Damaged Robe/Fine Robe (10HP), Patched Leather.

## 1/battle usage limit — investigation (2026-08-09), UNRESOLVED
Traced whether the "1/battle" rune-attack limit is an editable data flag.
Findings:
- Byte-correlation lead (+0x02/+0x03 = 0x01 on limited, 0x80 on unlimited) is NOT
  a clean flag: Shrike has 0x01/0x01 but is not 1/battle. So 0x01 marks a broader
  rune-attack category, not the limit itself.
- Disassembled the boot ELF (MIPS R5900, /tmp/s3boot.elf, PT_LOAD vaddr 0x165D000)
  with capstone. The spell record's +0x02/+0x03 bytes: generic struct-offset loads
  exist but nothing spell-specific isolates a usage check.
- Attack runes (Eight-Devil 0x156, Phoenix 0x153, etc.) are NOT in the equipment
  0x44 record table, so the limit isn't a gear-record field.
Conclusion: the 1/battle limit is enforced in battle code (a per-battle usage
counter compared in the cast routine), not exposed as a simple editable byte in
the spell/rune/item data tables I can address. Removing it would require patching
the compare/branch in the battle code (a code patch, not a data edit) — identified
as the real mechanism but not implemented (needs full battle-routine RE to do safely).

## Unites tab — characters involved (2026-08-09)
Added a "Characters" column to the Unites tab. Source: Suikosource unite guide
(parsed to Editor/s3_unite_chars.json, keyed by unite INDEX so duplicate names
like Han x3 / Adonis x2 stay distinct — the two Adonis records disambiguated via
their in-game descriptions: Pretty Boy=Futch/Franz/Fred vs Handsome Clan=Bazba/
Sgt.Joe/Ruby). 33 of 38 mapped. The 5 unmatched (Griffon, Duck, Han x3) are not
in Suikosource's unite guide (likely NPC/enemy or unused) and show "—" rather than
a guessed roster. Filter box searches character names too. Reference data (external),
not read from the ISO.

## Batched edits + Save button (2026-08-09)
The editor no longer writes on the fly. All edits stage in memory (PENDING dict,
offset->byte) via a StagingIso wrapper: reads overlay pending values so the UI
shows unsaved changes, writes accumulate. Nothing touches the ISO until you hit
"Save to ISO" (top-right), which flushes all staged bytes at once and — only then —
makes the backup (if the backup checkbox is on). A "Revert" button discards staged
edits; a beforeunload guard warns on close with unsaved changes. Reads always come
from the real ISO (StagingIso.rd reads the file, overlays pending), so opening any
ISO reflects its actual current values. Endpoints: POST /api/save, POST /api/revert;
meta.pending reports staged byte count. Verified on a clone: edit stages (disk
unchanged, no backup), save flushes + backs up, revert clears without touching disk.

## Enemy stats — research spike (2026-08-09, INCONCLUSIVE)
Goal: a "hard mode" that multiplies enemy HP/damage. Requires the enemy stat table.

FOUND (solid):
- Enemy NAME table: file 0x3E74E0, 100 entries, stride 0x14, names inline
  (10-char truncated, e.g. "ZombUnicrn","TrollDragn"). Names indexed by number,
  NOT by pointer — a scan for u32 pointers to name-string starts returned 0.

NOT FOUND (the stat/HP table):
Ground truth: 68 enemies' Lv+HP parsed from Suikosource bestiary
(bestiary.php, fetched past Anubis with headed Chromium). Tests run against a clone:
- Parallel-to-names array (base+i*stride, HP at fixed field): best 8/65 (Blade
  Bunny only — coincidence). Tried strides 0x18..0x48, all u16 fields.
- Dense HP+level co-location clusters in ELF: two hotspots (0x3AC800, 0x3E6xxx)
  both turned out to be repetitive non-stat blocks (animation/identity matrices,
  0x08-0x0A spacing).
- Disassembled the ONE code site that loads the name-table address (code va
  0x16C70BC / file 0x10E8BC — corrected 2026-08-29, this line read 0x10E8B4).
  Addresses it computes nearby:
    0x3E13A0, 0x3E69F0, 0x3E74E0(names), 0x3B0FA8, 0x3B1088, 0x3E0B68, 0x400BC0.
  The candidate at 0x3E69F0 is exactly 0x1C*100 below the name table (structurally
  a parallel 100xrecord table!) but its columns are NOT HP: +0x12 is constant 100,
  +0x0A/+0x0C only 10-14/100 land in the HP set, in no consistent order. This looks
  like an AI/encounter/identity table, not base stats.
- ETC.BIN (386MB): HP values appear everywhere (compressed/asset data); no isolable
  table via raw u16 search.

CONCLUSION: base enemy HP/ATK is not a plain flat u16 table adjacent to the names.
Most likely either (a) packed inside a big .BIN archive that must be unpacked first,
or (b) HP is derived from level via a growth formula in battle code (so there is no
HP field to scale). A reliable hard-mode needs deeper RE (disassemble the battle
damage/HP-init routine) or archive unpacking — not shipped.

ALTERNATIVE that IS shippable with what we control: tune player-side knobs
(reduce party spell/unite power, nerf healing runes) for a harder game without the
enemy table. Not attempted yet.

## Unpacking the .BIN archives (2026-08-09, DEAD END for stats)
Attempted to unpack DATA/*.BIN looking for the enemy stat table.
- FSECT.BIN (89KB): monotonic u32 array of EE RAM addresses (~0x0157xxxx) — a
  pointer/relocation table, not a file sector index.
- ETC.BIN (386MB): proprietary nested container. Header has a count + 12-byte
  entries and a "PS2" tag; embedded named sub-assets like "imf_acee_000".
  Asset-name tokens are ALL graphics/animation: face*, walk_*, run_*, cha_*,
  imf_* (image format), ctx_*. Zero enemy/battle/stat-type tokens. => ETC.BIN is
  a character graphics/model/animation archive.
- *VI.BIN (KRVI/DKVI/TSVI/etc, 60-200MB each): headers look like streamed video.
- SD.BIN: starts "IECSsreV" (SCEI VerS...) — Sony sound container.
None of the archives are the enemy stat store; the readable one is graphics.
Combined with the ELF spike, base enemy stats are most plausibly initialized by
battle CODE (level -> HP via a growth curve) rather than a shippable flat table.
Definitive next step would be disassembling the battle HP-init routine — a large
task, deferred.

## Gear effect-type correction (2026-08-10, bug fix)
A tester reported gear effects "off by 1" (e.g. Worn-Out Helm slot showing SPD when
its description says PWR+15). Root cause: the effect-type map hard-coded types 2/3/4
as SPD/PWR/MDF and treated the 3rd u16 as a skill id. Re-derived vs descriptions:
- Effect slot = (type u16, value u16, PARAM u16, pad u16) @ 0x14/0x1C/0x24/0x2C/0x34.
- type 2 = generic STAT BONUS; PARAM selects the stat by S3 stat index
  (0=PWR 1=SKL 2=MAG 3=REP 4=PDF 5=MDF 6=SPD 7=LUK). Only 0/1/3/6 occur in gear
  (PWR/SKL/REP/SPD), verified vs single-stat item descriptions and the
  "PWR+SPD+SKL+REP(+20)" armor.
- type 5 = Grant skill; PARAM = skill id (unchanged).
- Newly identified: 3=Accuracy+% (1 sample), 9=Weak-vs-thrust/mobility,
  10=Lowers ATK effect %, 11=Chance to reflect MGC, 12=Counter-attack rate +%.
  type 4 has ZERO occurrences in this ROM -> left "unverified".
Editor now: relabels type 2 as "Stat bonus" with a stat dropdown, keeps the skill
dropdown for type 5, toggling which shows per type. read_gear returns param/paramRole/
statName; write_gear accepts `param` (legacy `skill` still honored).
Audit of the other editors (spells/unites/characters/shop) vs descriptions & ranges:
0 power/desc mismatches (94 spells, 38 unites), all growth rates in 0..15, all 26
shop item slots resolve — gear was the only mislabel.

## Rebalance-capability investigation (2026-08-10)
Investigated four rebalance requests. Results:

1. WEAPON POWER — SUPPORTED (was hiding in plain sight). list4 (0x3DFA08, stride 28,
   28 records) IS the weapon ATK growth/sharpen table: first 16 bytes = ATK at
   sharpen levels 1..16 (clean monotonic curves, e.g. Axe 8..250, 1H Sword 6..180),
   followed by a 5-byte tail (per-level sharpen cost/material amounts, unconfirmed
   exact meaning). "Weight" is NOT a Suikoden III mechanic — does not exist.
   ACTION: surface list4 as a proper "Weapons" editor (ATK-per-level) instead of raw
   bytes.

2. RUNE AFFINITY — NOT A SEPARATE FIELD. char list1 record is fully mapped except
   +8 (a per-character sequential id / portrait or weapon-type link; Fubar=72
   outlier) and +60 (constant 1, validity flag). No innate element/affinity byte.
   In S3 "affinity" = the character's rune slots + fixed rune, which we already edit
   (L/R/Head slots + rune levels). Nothing new to add.

3. SHOP RARE-FIND / % APPEARANCE — NOT PRESENT. Shop item3 tables are flat u16
   item-ID arrays; empty slots and surrounding bytes are zero, no interleaved or
   adjacent rate/probability field. S3 shops are fixed inventories (stocked or not).
   The original exe also only edited item IDs. Nothing to add.

4. ENEMY DROP TABLES + RATES — BLOCKED (same as enemy HP). Known drops (Blade Bunny
   Medicine D, Shadow Dog Double-Strike Rune 0x1C7, etc.) do not appear in the aux
   table at 0x3E7CB0 in name-table order; drops live in the same un-located enemy
   record structure that defeated the earlier HP spike. Not editable without deeper
   RE / archive unpacking.

## Weapons editor shipped (2026-08-10)
list4 (0x3DFA08, 28 records, stride 28) surfaced as a proper "Weapons" tab.
Bytes 0..15 = ATK at sharpen levels 1..16 (edited per-level, u8, clamped 0..255),
plus a scale-x control per weapon. Bytes 16..27 (sharpen cost/material tail,
meaning unconfirmed) are preserved untouched on save. Endpoints /api/weapons (GET,
includes atkDefault) + /api/weapon (POST {index, levels:{lvIdx:atk}}). The old
"list4 (raw bytes)" section in the character editor still exists for hex access.

## Weapons: layout + character grouping (2026-08-10)
- Weapons tab ATK fields now use a wrapping CSS grid (8/row, 4 on narrow) instead
  of a single overflowing row.
- Character->weapon link: list1 byte +9 groups the roster into 14 weapon-growth
  classes (verified: +9=5 = Chris/Geddoe/Borus/Queen; +9=3 = Hugo). It is NOT a 1:1
  index into the 28 list4 curves (e.g. +9=5 mixes sword users and Aila=bow), so the
  editor shows the class->members table as a REFERENCE panel and only labels a
  specific curve with a character when the record name says so explicitly
  ("Thomas Weapon", "(Chris)"). A precise per-curve character map would need more RE.

## Weapon -> character mapping VERIFIED (2026-08-10)
Matched all 28 list4 ATK curves to Suikosource's Weapon Growth Guide by EXACT
ATK-value comparison (wpngrowth.php, fetched past Anubis). 27/28 matched a weapon
family directly; idx19 = Thomas' unique weapon. Each family lists the fighters that
use it + their 3 weapon names (First/Second/Third). Saved to s3_weapon_chars.json
{byIndex:{i:{family,fighters:[{name,weapons}]}}, families:{...}}. Weapons tab now
shows "Used by: Name (Wpn1 / Wpn2 / Wpn3), ..." inline per curve; search matches
character + weapon names too. Note: multiple sub-variant curves share one family
(Axe 1/2/3, Halberd 1-5) so the same fighter roster shows on each variant — that's
the family grouping, accurate per the guide.

## Sharpen COST — not in list4 (2026-08-10)
Requested: edit per-upgrade sharpen cost. The 12-byte list4 tail (bytes 16..27) is
NOT a per-level cost table: +16..+20 are small per-weapon values (unclear), and the
only round-number field (+26 u16) is 2000/1000 on just 2 of 28 weapons. No 16-value
cost curve fits 12 bytes. The Suikosource guide has no cost data. Conclusion:
sharpen cost is formula-driven or in a separate global table (not located). Not
exposed rather than ship a wrong field. Would need dedicated RE.

## Shop RE spike — shops are SCRIPT-driven (2026-08-10, inconclusive for full mapping)
Investigated mapping every shop by location + full inventory. Findings:
- There is a large shop-data region ~0x3D0000..0x3EB000, and a 50-entry pointer
  table at 0x3D23F8 whose targets are shop records.
- BUT each record is event-SCRIPT data, not a flat inventory: records interleave a
  0x0198 marker, incrementing script/dialogue IDs (0x9C58, 0x9BE0...), IEEE floats
  (0x4334.., 0x3F80..), and item IDs. The 0x0198 token appears 1069x in one 64KB
  window but only 389 are followed by a valid item id -> it is NOT a clean
  "sell item" opcode.
- Conclusion: shop inventories live inside the game's event script. Enumerating
  "shop = town + item list" reliably would require writing a script interpreter for
  the format, and there is NO external guide (Suikosource has no shop-by-town list)
  to source location names from. Both halves of the request are blocked.
- Our existing 3 SHOP tables (item1/item3_a/item3_b) remain valid flat editable
  slots (they sit in the same region and edit fine); they're a subset, not the whole
  shop system. Not expanding shop editing to avoid corrupting script data.

> **SUPERSEDED (2026-08-30).** The conclusion above is wrong, and the reason it was
> wrong is worth keeping: the spike searched for shop *records* by pattern in the
> 0x3D0000..0x3EB000 data, found event-script noise, and stopped. Asking instead
> *which code reads the tables we already had* answered it in one step — `item3_a`
> and `item3_b` are record 0 of two of three flat, non-script arrays covering every
> shop in the game. See "Shop counters — the whole system, decoded" below.

## Starting stats + EXP curve spike (2026-08-10, both NOT flat tables)
Requested: edit character starting stats + the EXP/level curve.
- STARTING STATS: parsed all 78 chars' starting PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK/HP
  from suikosource/statgrowth.txt. Searched the ELF for these as consecutive u8 and
  u16 (PWR-REP signatures, 7-stat sequences) and inside each char's own list1/list2
  record: 0 matches anywhere. The displayed "Starting" values are computed (base +
  level-1 growth), not stored literally -> no editable starting-stat table.
- EXP CURVE: searched for a monotonic ~90-99 entry table (u32 and u16) starting
  small and ending large. Only false positives (a +9 pointer ramp; a linear +25
  math table). No XP-per-level table -> the level curve is formula-driven in code.
Both would require ASM/formula patching, not data edits. Not shipped.
What list2 DOES hold and we already edit: per-stat GROWTH RATES (how fast stats
rise per level) — that remains the lever for stat rebalancing (see Hard Mode).

## Sharpen cost — global-table hunt (2026-08-10, NOT a flat table, closed)
Second, deeper look for sharpen/upgrade cost after the per-weapon tail was ruled out:
- No dedicated sharpen/blacksmith guide on Suikosource; the weapon-growth guide has
  ZERO potch/cost figures.
- Data immediately after list4 (0x3DFD18+) is more of the same 5-byte weapon-tail
  fragments, not a global potch-per-level curve.
- The 12-byte per-weapon tails are almost all UNIQUE per weapon (only 1 pair shares),
  so they're per-weapon attributes, not a shared cost table; values (e.g. 3c 50 32 19)
  don't decode to obvious potch amounts.
Conclusion: sharpen cost is formula-driven in code (typically f(next ATK)), as in
other Suikoden titles. No editable cost table exists; not exposed. Would need ASM.
This closes the rebalance-capability exploration: all remaining requests
(enemy stats/drops, shop-by-location, starting stats, EXP curve, sharpen cost) are
code/script-driven, not flat data. Editable-as-data set is fully mapped.

## War battle spike (2026-08-10, no editable unit table)
Investigated S3's war/tactical battles. Findings:
- No war-unit name list or unit-stat table found. String searches for army/unit
  vocabulary (Cavalry, Battalion, Bow Unit, Morale, Formation-as-army, etc.) hit only
  UI menu labels (Formation = party menu), item names (War Horse, War Bounty), story
  text (Unification War), or debug tags (SecWar/WarSch) — none are war-battle data.
- The 0x4046xx cluster near "Zexen/Chisha/Alma Kinan" is a MAP/LOCATION name table
  (Ancient Highway, Brass Castle, Vinay del Zexay...), not war units.
- Suikosource has no S3 war-battle guide (only a Suikoden Tactics link).
Conclusion: unlike Suikoden II's large army-battle system, S3's war battles are a
few STORY-SCRIPTED tactical skirmishes using the characters' own stats + scripted
setups (same event-script domain as shops). No standalone editable army-unit table
exists; editing would mean the script layer (not flat data). Not shippable as a
data editor. (Bonus: found a clean location-name table at 0x404648 if ever useful.)

## Community cheat-code research (2026-08-10)
Checked external hex/cheat sources to see if anyone located the tables our
structural search couldn't (enemy stats/drops, EXP, starting stats, shop):
- Sources: gamehacking.org (game 105083), etherealgames, drummerscheattables
  forum, PCSX2 forum "post your cheats", xs1l3n7x/pcsx2_cheats_collection (GitHub),
  scribd PNACHs. Game CRC = 5F3DD929 (NTSC-U SLUS-20387).
- Retrieved a working PNACH: Max Money patch=1,EE,05DBB63A,... . Forum code sets
  cover Cur/Max HP, all-character PDF/MDF-to-max, Head/RH/LH Rune, equipped item.
- KEY POINT: every code targets HIGH EE RAM (~0x05DBxxxx) = live/save-state game
  memory, NOT the boot-ELF static tables (~0x00100000 range) we edit in the ISO.
  Cheats overwrite the runtime copy the game already derived from base data. So they
  neither expose nor contradict our tables — and crucially, NO community code targets
  enemy HP/drops, the EXP curve, or shop inventories. If those existed as easy static
  tables, "9999 enemy HP"/"max EXP" codes would be common; their absence corroborates
  that those live in code/script, not editable flat data.
CONCLUSION: external research confirms the editable-data boundary rather than
extending it. Nothing new to add to the ISO editor from cheat codes.

## Local cheat-PDF validation (2026-08-10)
Checked the local "Sure Fire" Suikoden III cheat reference PDFs
(Cheat files/Cheat info/*.pdf, from herrvillain.net). Used as an authoritative ID
dictionary to validate our editor:
- ITEM IDs: 12/12 spot-checks match exactly (Medicine D=0x1, Fire rune=0x13D,
  Sword Of Rage=0x140, Double-Strike=0x1C7, Letter Fragment=0x264, ...).
- SKILL IDs: match exactly, incl. 03=Damage 05=Counter Attack 06=Heavy Damage
  0E=Fire Magic 1E=Healing 2B=Magic Rationing — confirms the gear stat/skill fix.
- The PDF's "Party Modifier / Battle-Character digits" (Hugo=01..Emily=52, with
  gaps at 0x0C/0x21/0x25-27/0x40/0x53) are a DIFFERENT index space than our list1
  stat-record table. Verified via the weapon-class byte (list1 +9): Roland's data
  is at OUR list1 index 12 (+9=5 = sword class, correct), NOT the PDF id 0x0D
  (+9=7). So our list1 names are aligned to the stat table; the PDF ids are the
  cheat/party-roster ids. No fix needed — cross-check confirms our indexing.
- The PDF also documents Recruit digits + skill/item/weapon-level value caps
  (skill 0-8, weapon level 1-16, item qty 0-9) — all consistent with our editor.
Net: external reference corroborates our data; no corrections required.

## Codebreaker PDF + Suikosource thread audit (2026-08-10)
Checked the newly-added Pyriel Codebreaker FAQ PDF and two Suikosource threads
(t=922 "[Codes] Codebreaker", t=14832 "Question About Stat Modifier Codes"),
following every external link (Wayback for the dead ones).

Codebreaker/GameShark PDF (Pyriel v1.00, GameFAQs id 22704):
- Same author/content family as the local GS/CB text. Every code writes LIVE EE RAM:
  Fast-Level-Up per char at 0x2Bxxxxxx, stat mods at 0x4Bxx8664/0x09xxxxxx,
  skill-slot 5-8 mods at 0x0Bxxxxxx, party/support/recruit at 0x11xx / 0x1Bxxxxxx.
  NONE touch the boot-ELF static tables we edit. Re-confirms the boundary; no new offsets.
- Skill-slot codes enumerate the full 79+ playable roster in the same canonical order
  we use (Hugo, Chris, Geddoe, Lucia, Fred, Rico, Viki, Fubar, SgtJoe, Lulu, Aila,
  Roland, Lilly, ...). Corroborates our list ordering.

Suikosource threads: purely usage discussion (buying a Codebreaker, recruit codes for
Lulu/Jimba = 1196B624/1196B67E, a controller-hook stat=100 MIPS snippet at 0x200C4FF4).
All live-RAM. No static ISO offsets. Links: herrvillain.com (dead, 410),
cmgsccc.com (now codetwink.com, live), piedpiperplayers.com (dead), gamehacking.org (live).

** Wayback recovery of herrvillain.com/codebreaker/suikoden (the real prize) **
- codes/digits.htm: Skill-digit table matches ours EXACTLY (00 Nothing, 01 Swing,
  02 Accuracy, 03 Damage, 05 Counter, 06 Heavy Damage, 08 Freeze, 0E Fire Magic ...
  2A Precision, 2B Magic Rationing). Independent confirmation of the skill IDs and
  the gear stat/skill fix.
- updates/offsets.htm = a SAVE-FILE offset map (memory base 0x0196xxxx, live save RAM):
  * Each character block is 0x8C = 140 bytes -> EXACTLY our list1 stat-record stride.
    Order: Flame Champion(real), Hugo, Chris, Geddoe, Lucia, Fred, Rico, Viki, Fubar,
    Sgt.Joe, Lulu, Aila, Roland, Lilly, Reed, Samus, Ace, Leo, Beecham, Percival, Borus,
    Queen, Jacques, Joker, Duke, Gau, ... (matches our roster). Strong cross-check that
    our 140-byte character records + ordering are correct.
  * Other save regions: Recruit Modifiers 0x0232, Mountain Pass chest 0x1460, party
    0x3216, Party/Storage Inventory 0x7060-0x76EF, Kidd Investigations 0xC7F0,
    Book of Beasts 0xCDD0, Treasure Boss Timers 0xCE20. All are SAVE-FILE structures,
    not ISO/boot-ELF tables -> not something our ISO editor writes, but useful as a
    roster/stride oracle.
CONCLUSION: All three sources are live-RAM / save-file oriented. They independently
VALIDATE our skill IDs, character ordering, and 140-byte stat-record stride, but expose
no new static ISO tables (enemy HP/drops, EXP curve, shop inventory remain code/script).
No editor changes required.

## Save-file write support: checksum + ECC solved (2026-08-10)
Turned the read-only Save Editor into a full editor. Two pieces were needed to
write a modified PS2 memory-card save that the game will accept:

1) gamedata checksum (word@0): the sum of ALL little-endian u32 words in the
   53264-byte gamedata == 0 (mod 2^32). So word@0 = (-(sum of words[1:])) & 0xFFFFFFFF.
   Verified across 4 real saves; edit any byte, recompute word@0, sum returns to 0.

2) PS2 memory-card page ECC: cards store 528-byte pages (512 data + 16 spare;
   12 ECC bytes + 4 zero). ECC is the mymc Hamming code (Ross Ridge, public domain,
   ps2dev/mymc ps2mc_ecc.py): per 128-byte chunk -> [column_parity, lp0, lp1] with
   column_parity_masks built from bit-parity masks [0x55,0x33,0x0F,0x00,0xAA,0xCC,0xF0],
   inits cp=0x77/lp0=0x7F/lp1=0x7F, lp0^=~i and lp1^=i for odd-parity bytes, return
   [cp, lp0&0x7F, lp1]. Validated against a real card: 0 mismatches on all data pages
   (only erased 0xFF pages differ, which is expected/ignored).

Implementation (Editor/s3save.py): apply field edits into a gamedata clone, fix the
checksum, repack the file into its FAT cluster chain, recompute ECC for every touched
page, and write the whole card back (a .bak is made first). Editable fields exposed in
the web "Save Editor" tab: per-character level, current HP, EXP-to-next, and the 8-stat
block. Tested end-to-end on card clones (never the originals): edits persist, gamedata
u32 sum stays 0, and page ECC re-validates. Best practice for players: after editing,
load the save in-game and resave, then play from that.

## Save Editor v2: roster off-by-one fix + inventory (2026-08-10)
- OFF-BY-ONE FIX: CHAR_BASE 0x33AC is HUGO, not the Flame Champion. The real story
  Flame Champion record is the (all-zero, non-recruitable) block one stride earlier at
  0x3320. Earlier code prepended "Flame Champion" to the roster, shifting every name
  down one (what displayed as Flame Champion was Hugo's data, etc.). Removed it;
  ROSTER[0]=Hugo. Verified: leveled slots 0-6 now read Hugo,Chris,Geddoe,Lucia,Fred,
  Rico,Viki in the map's order. (Note: the per-record +0x0C "id" byte is a global
  character id, e.g. Fubar=72, NOT the slot index — so id==index only for the first 7.)
- INVENTORY: party + storage items start at file offset 0x7060 (herrvillain map),
  8-byte entries = item id (u16) + quantity (u16) + 4 reserved (0). Empty slot id=0.
  ~400 slots span party inventories + storage. Consumables show real stack counts;
  validated by editing qty and reading back. Exposed as an editable Inventory sub-tab
  (item-id dropdown + qty), writing through the same checksum+ECC path.
- NOT exposed (decoded but not trustworthy enough to write): equipped weapon/armor/rune
  ids in the char block's 0x10-0x1F region don't cleanly map to item ids, and the potch
  (money) u32 candidate (~0x1E4) is unconfirmed. Left read-safe rather than risk
  corrupting playthroughs.
- UI: wide stat table wrapped in a horizontal-scroll container with a sticky name column
  and compact inputs, so it no longer overflows the card. Characters/Inventory sub-tabs.

## Save Editor v3: equipped gear + item categories (2026-08-10)
Used the herrvillain per-character RAM code page (codes/hugo.htm, Wayback) to confirm
the in-block layout. NOTE the SAVE layout differs from the RAM layout for some scalars
(save level is @0x0D, RAM level is a different offset), but the EQUIP slots share the
RAM map's 8-byte spacing and were verified empirically against real saves:
  Character block equip slots (u16 item id), offsets within the 140-byte record:
    0x44 Head rune, 0x4C Right rune, 0x54 Left rune,
    0x5C Helm, 0x64 Armor, 0x6C Shield,
    0x74 Boots, 0x7C Gloves, 0x84 Accessory.
  Each decodes to a real rune/armor/accessory name across all 4 sample saves
  (e.g. Hugo: True Wind / True Fire / Champion's / Blessed Casque / Blessed Robe /
  Winged Boots / Power Gloves / Fish Badge). Also confirmed: maxHP @0x30 (u16).
Exposed in the Save Editor: per-character Equipment dropdowns (9 slots, item picker),
plus maxHP. Item inventory is now split by category for editing:
  item_category(id): id>=0x200 -> "key" (seeds/medals/recipes/trade goods/books/stones),
  0xA0-0x1FF -> "equipment", else "consumable". UI shows "Party Items" vs
  "Key / Valuables" sub-tabs.
UI: overrode the global sticky-thead offset inside the save table (it was landing the
header row mid-table); header now pins to the top of its own scroll container.

## Save Editor v4: separate party inventories (2026-08-10)
Early game, Hugo/Chris/Geddoe (and Thomas) each carry a SEPARATE item bag; they merge
into one shared inventory + storage after the Flame Champion is chosen. The herrvillain
map documents each bag; validated against real saves. 8-byte entries (id u16 + qty u16),
30 slots each:
  Hugo    0x7060, Chris 0x7150, Geddoe 0x7240, Thomas 0x7330, Storage 0x7420 (90 slots).
Empty slots may hold a high-bit sentinel (e.g. 0x81xx) rather than 0, so we treat any id
> 0x2FF as empty. Inventory is now decoded/edited per-bag (grouped in the UI as Hugo /
Chris / Geddoe / Thomas / Storage), each with the Party-Items vs Key/Valuables split.
Slots are addressed by absolute index from the first bag so writes round-trip. Verified:
per-bag counts render, a Hugo-bag qty edit persisted, checksum sum stayed 0, ECC clean.

## Save Editor v5: metadata display + editable names (2026-08-10)
- Save metadata now surfaced (read-only): from the icon.sys PS2-browser title
  (Shift-JIS full-width, e.g. "Suikoden3 [01] Cpt.3 L41 / 28:39") we parse CHAPTER,
  party LEVEL, and PLAYTIME. Plus story phase (0x14) and party leader (0x12).
- Leader id -> name: 0x12 is the first entry of the party-member id list at 0x3216
  (ids are the exe's list1 character-id space: 1=Hugo, 2=Chris, 3=Geddoe, 63=Hallec...).
  Resolved via s3_names.json list1. Ids >= ~200 (203, 210-213) are guests/story NPCs
  not in the recruitable roster -> shown as "id N (guest/NPC)".
- Editable NAME fields (fixed 16-char ASCII, 0-terminated, 17-byte slots -> safe
  in-place writes): Flame Champion 0xC9E0, Castle 0xC9F1, Suikoden I hero 0xCA13,
  SI country 0xCA24, Suikoden II hero 0xCA35. Verified: edited Flame Champion name,
  persisted, checksum sum stayed 0.
- GOLD/potch @0x3210 (u32): CONFIRMED CORRECT — user verified in-game 2026-08-17. Exposed
  and editable in the save editor. (Earlier notes below called this "unverified"; that is
  now resolved.)

## Save Editor v6: Suikoden I/II carryover indicator (2026-08-10)
S3 seeds the carryover name fields (SI hero 0xCA13 / SI country 0xCA24 / SII hero 0xCA35
/ SII army-country 0xCA02) with canonical DEFAULTS — McDohl/Toran (S1), Genkaku Jr./Dunan
(S2) — unless a real Suikoden I/II memory-card save is loaded, which overwrites them with
that save's hero/country. There is NO separate boolean load-flag byte in the region (all 4
sample saves are byte-identical here and hold the defaults). So detect_carryover() infers
"S1/S2 data loaded" when those names differ from the defaults, else reports "not detected".
Surfaced as read-only pills in the Save Editor meta card. Honest limitation: with only
default-bearing saves available, this is a name-based heuristic, not a confirmed flag.

## Save Editor v7: skills, weapon level, party composition, recruited flag (2026-08-10)
- SKILLS: 8 slots per character at block +0x10, each (skill id u8, rank u8). Verified vs
  the skill-id table (Hugo: Heavy Damage/Counter/Continual/Parry/Healing/Swing/Wind/Fire;
  Chris: Parry/Damage/Repel/Armor Protect/...). Editable per slot (skill + rank 0-15).
- WEAPON LEVEL: block +0x0D (u8, 1-16), now editable alongside level.
- PARTY COMPOSITION: 6 u16 member char-ids at file 0x3216 (exe list1 id space), 0=empty.
  New "Party" sub-tab picks who fills each of the 6 battle slots. Verified: read real
  names (Hugo/Fubar/Chris/Geddoe/Cecile), edit persisted, checksum stayed 0.
- RECRUITED flag: a character block is "recruited" when initialized (level>0 or any
  stat>0) vs all-zero. Shown as a per-character badge; a "recruited only" filter (default
  on) hides the ~4 empty roster slots.
All verified end-to-end on card clones (600 skill dropdowns render, party + skill edits
persist, ECC + checksum valid).

## Save Editor v8: add-items, honest recruited/party UX (2026-08-10)
- ADD ITEMS: each inventory bag now shows slot usage (used/capacity) with a "+ Add item"
  button that opens the next free slot as an editable blank row, and a ✕ to remove an item
  (sets id 0, zeroes qty + reserved bytes). New items with no qty default to 1. decode_inventory
  now returns firstSlot/capacity/used/freeSlots per bag.
- RECRUITED indicator was WRONG: the char block is pre-initialized with base stats/level for
  every roster entry, so "level>0 or stat>0" flagged ~75/109 identically on ALL saves
  (early AND late) — it measured "has a definition," not recruitment. Real recruit flag lives
  in the 0x232 region but is a complex state word (e.g. active Viki reads 0x0000), not a clean
  bit, and all sample saves are similar-state so it can't be isolated without an early save.
  FIX: removed the false "recruited" badge; relabeled the filter to "hide empty slots" (truly
  empty = level 0 AND HP 0), which is what it actually does.
- PARTY empty on early saves is CORRECT, not a bug: 0x3216 (map's "current party") is genuinely
  empty in the phase-2 save (early chapters set the field party via story events). Added a note
  explaining this; later saves populate it correctly (u04: Hugo/Fubar/Chris/Geddoe/Cecile).

## Save Editor v9: REAL recruit flag cracked + editable (2026-08-10)
Cracked the recruit flag by diffing the 4 sample saves in PLAYTIME order (not chapter #,
which is a per-protagonist label): 28:39 < 37:31 < 38:32 < 40:33. The recruit-table word
at 0x232 + rosterIndex*2 is nonzero exactly when recruited, and the nonzero COUNT is
strictly monotonic in playtime (80 -> 97 -> 100 -> 100) — the signature of a true recruit
flag. Characters going 0 -> nonzero across saves are all sensible late recruits (Sasarai,
Luc, Yuber, Sarah, Albert...). Earlier "level>0/stat>0" heuristic was wrong (blocks are
pre-initialized for all 109 slots -> flagged ~75 identically on every save).
- READ: decode_character now returns recruited=(word!=0) + recruitWord. UI shows a real
  "recruited"/"not recruited" badge; "recruited only" filter uses it.
- WRITE: a per-character "recruited" checkbox sets the flag. Recruit keeps an existing
  nonzero value or writes 0x1D (common fresh-recruit value); un-recruit writes 0. The
  specific value encodes join type/orderability per character (0x1C/0x1D/0x21/0x09/...).
  Verified: unlocking Viki (0x00 -> 0x1D) persists, checksum sum stays 0.
Also: playtime (HH:MM) is now shown in the save metadata line alongside chapter/level.

## Save Editor v10: "recruited by" (pre-merge party owner) (2026-08-10)
The recruit word (0x232 + ridx*2) also encodes WHICH protagonist recruited a character in
bits 2..5 — before the Flame Champion is chosen, S3 runs three separate parties and a unit
is only usable by the hero who recruited them. Decoded by grouping the early save's recruits:
  Hugo 0x04, Chris 0x08, Geddoe 0x10, Thomas 0x20  (bit0 0x01 = recruited; 0x40/0x80 status).
Verified anchors: Hugo=0x205, Chris=0x209, Geddoe=0x211, Thomas=0x221; and the groupings
match lore (Chris -> Zexen knights, Geddoe -> mercenaries, Thomas -> Chisha crew, Hugo ->
Grasslands allies; Duke/Gau/etc = shared/story = no recruiter bit).
- READ: decode_character returns recruiter (Hugo/Chris/Geddoe/Thomas or "").
- WRITE: a "recruited by" dropdown per character rewrites bits 2..5 (RECRUITER_MASK 0x3C),
  preserving the other bits. Choosing a recruiter also sets recruited. Verified: moving
  Fubar Hugo->Chris flips word 0x85 -> 0x89, persists, checksum stays 0.

## Save Editor v11: playtime (confirmed) + gold (likely) via playtime-diff (2026-08-10)
Applied the playtime-ordered diff to find progression counters:
- PLAYTIME @0x28 (u32 seconds) — CONFIRMED: 1719==28:39, 2251==37:31, 2312==38:32,
  2433==40:33, exact match to the save title on all 4. Shown as H:MM:SS (read-only).
- GOLD @0x3210 (u32) — CONFIRMED CORRECT (user verified in-game 2026-08-17). Money-shaped,
  varies like spendable gold (390965/341256/475076/23800), sits just before the party list
  (0x3216); single field, not per-party
  (0x3208/0x320C are zero). Exposed editable-but-flagged (low risk; wrong value is easily
  fixed in-game). To confirm: edit to a distinctive value, load in-game, check the amount.
- 0x1E4 (u32) is strictly monotonic too but reaches 4.19M (> gold cap) -> a running
  "total earned/score" stat, not gold; left unexposed.

---

## v12 — Status effects, magic sword runes, and the consumable/food table

### Status effects are NOT a tunable data table (confirmed)
Searched the boot ELF for a status-parameter table (poison dmg/turn, sleep/unbalance
durations, proc chances stored per status). Found only:
- item/spell *description* strings ("Poisons character", "Silences character"), and
- engine debug strings: "PartyStatus %x is iregal", "charaStatusReadDestroy",
  "funcStatus = %d" — i.e. status is a code-side enum handled by battle logic.
There is no per-status struct of numbers to edit. So the *strength/duration* of a status
(how long sleep lasts, poison dmg/turn) is engine-coded, not data-driven — it cannot be
exposed by a data editor without patching game code. WHICH status a spell/rune applies is
already editable via the spell f18 bitfield (see F18_BITS; the sword-fire/lightning/wind
bits are the Sword of Rage/Thunder/Cyclone elemental adds).

### Magic sword runes
Sword of Rage=+Fire, Sword of Thunder=+Lightning, Sword of Cyclone=+Wind on physical
attacks (Suikosource runes guide). These are the sword-* bits in F18_BITS. There is no
Water sword rune. Effect potency is fixed (engine), not configurable — matches the
above: only the applied element/status is data, its strength is code.

### Consumable / food table (editable — heal amount + proc chance)
The "foods get weird" items live in their OWN record array, distinct from gear:
- BASE (file) 0x3E91D0, STRIDE 0x48, **60 recipe/dish records (0..59)**. Records 60-61
  are NOT dishes: their +0x44 name pointers resolve to consumable ITEMS (Sacrificial Jizo =
  Curative 0x09E, Escape Scroll = Spell Scroll 0x0A0), i.e. the walk has run past the recipe
  table into adjacent item strings — so their name/desc/heal don't correspond and must be
  excluded. Verified: records 0-59 all have "Food Items"-category names with heal matching the
  "Heals NNN HP" desc; 60+ do not. (FOOD_COUNT was 62 → corrected to 60.)
- +0x00  u32 -> description string (vaddr)      [CONFIRMED]
- +0x14  u16  heal amount (HP)                   [CONFIRMED: 7/7 + clean run vs "Heals NNN HP"]
- +0x1E  u16  proc chance %  (e.g. 30/60)        [CONFIRMED: 7/7 vs "NN% chance of ..."]
- +0x44  u32 -> name string (vaddr)              [CONFIRMED anchor]
- status-id field (which status the food inflicts/cures) lives in the 0x08..0x12 region
  (small ids / bitflags) — NOT yet fully mapped; do not write until confirmed like the
  heal/proc fields.
Medicines, Antitoxin, and stat "Stone of X" items share this structure (heal=0 for the
stones; a separate field carries the stat/spell they grant). "Medals" are key/valuable
items (id >= 0x200) with no stat record — editable only as inventory entries in the save
editor, not here.

---

## v13 — Cross-validation against a PCSX2 Cheat Engine table

Source: "Suikoden III NTSC PCSX2 1_7_5_320.CT" (community Cheat Engine trainer for the
NTSC release under PCSX2 1.7.5). Its addresses are LIVE EE-RAM (a runtime pointer +
per-slot offset, e.g. FirstPartyExpPtr + [iPartySlot]+2C), NOT memory-card `gamedata`
offsets, so they do not transfer to the save editor directly. Used here only to
independently corroborate our own reverse-engineering.

**Item id -> name list: CONFIRMED.** The CT's equipped-item dropdown lists 508 ids with
names; it matches our `Suikoden3_item_ids.txt` 508/508. The only differences are
cosmetic: HTML entity encoding ("Beef &amp; Potatoes") and one CT typo ("Tomator Seeds"
vs our "Tomatoe Seeds"). Our item list is correct and complete.

**Character stat block: CONFIRMED.** The CT's in-RAM stat layout (relative to its EXP
field) is PWR +0x20 / SKL +0x22 / MAG +0x24 / RPL +0x26 / PDF +0x28 / MDF +0x2A /
SPD +0x2C / LUK +0x2E — exactly matching our gamedata OFF_STATS = 0x20 with the same 8
u16 order (the CT's "RPL" = our "REP"). Confirms the save-editor stat decode.

**Not usable from the CT:**
- RAM struct != save struct beyond the stat block — the CT places curHP/maxHP at
  RAM base +0x2C/+0x2E, whereas our gamedata has curHP @0x08 and maxHP @0x30.
- The CT's character dropdown ids (e.g. 0x834 "Ace") are RAM handles, not the roster
  indices the save uses.
- Trainer entries (infinite HP, MAGIC/SP multipliers) are Auto-Assembler scripts that
  hook running code; nothing to translate into a static save/ISO edit.

**Open lead — "SP" (skill points):** the CT edits a per-character SP field we do not
expose. Its RAM offset (EXP+4) does not map to a confirmed gamedata offset — the word
at gamedata char+0x04 did not read as plausible SP across a real save. Needs a known
on-screen SP value to RE and confirm before exposing (per the never-write-unverified rule).

---

## Enemy stats — research round 2 (2026-08-17, still not editable; major structural lead)

Re-attempted with post-spike techniques. Ground truth: the full Suikosource bestiary
(name, Lv, HP, 3 drop slots, food drop, Potch, SP) re-fetched via Playwright + headed
system Chrome past Anubis and SAVED to `suikosource/bestiary.txt` (68 enemies) so future
rounds don't need to re-fetch.

**Ruled out this round (with data):**
- Name-table entry tails: the 10 bytes after each 10-char name at 0x3E74E0 are ALL ZERO —
  pure padding, no record ids.
- The parallel table at 0x3E69F0 (stride 0x1C): correlated every u8/u16/BCD column against
  Lv/HP/Potch/SP for 74 name-matched enemies — best "match" was 14/74 from zero-valued
  columns (junk). Definitively not the stat table.
- Whole-ISO windowed scans for (HP,Potch,SP) triples: all hits in MOVIE/*.PSS are video
  noise; u32-ID list regions in area BINs (FAKE/DKVI/TSVI) are coincidental u16 fragments.

**NEW LEAD — per-area opcode streams (DATA/*.BIN):**
The DATA folder's ~30 BINs are per-chapter/area archives (AKVI, VDZK, MORI, ICEW, RVER,
LAST, ...), not just AV. Inside at least AKVI.BIN (int. 0x562xx) and VDZK.BIN
(int. 0x1AD39xx region, abs 0x2B4939xx) sits a recurring tagged record stream:
    9d 00 [idx u16] [00 10] [01 00] [V1 u16] [02|03 00] [V2 u16]
    72 00 [idx u16] [02 00] [Vs u16]
    7f 00 [idx u16] ...
with V1/V2 in HP/potch scale (300..4500) and Vs in SP scale (35, 150, 160...). Red Mantik's
exact HP (3500) and SP (35) appear on records sharing idx 0x0803 in VDZK; Shadow Dog's HP
1200 appears in the AKVI stream. Interpretation: these look like SCRIPT/OPCODE streams
(0x9d/0x72/0x7f = opcodes) that set encounter battle parameters per area — consistent with
round 1's conclusion that no global flat stat table exists.

**Why it's still not editable:** no identity anchor. The stream's idx values (0x0801..)
don't map to the 100-entry name table by any obvious rule, and V1/V2 don't consistently
align to a single enemy's (HP,potch) pair — adjacent records interleave values, so which
record belongs to which enemy is unproven. Writing here blind risks corrupting area
scripts.

**Path to an enemy editor (future round):** decode the opcode stream properly — find the
stream's header/dispatch in the area-BIN container, enumerate records per area, and match
each area's record set against that area's bestiary enemy list (the bestiary is organized
by area, so set-equality of HP multisets per area would give the anchor without
disassembly). Alternatively disassemble the battle-init code that consumes these streams.

---

## Enemy stats — research round 3 (2026-08-17): 9D-stream hypothesis REJECTED; P3 gated on RAM

Executed the phased plan (containers -> stream enumeration -> identity anchoring).

**Container format (P0):** the ~30 DATA/*.BIN area/chapter files are CHUNKED STREAM
containers — 0x40-byte chunk descriptors with incrementing ids and 'B'/'C'/'D' type tags
(distinct from ETC.BIN's count+12-byte-entry TOC). Key practical point: in-place,
same-length edits never need the container framing, and the 9D streams are uncompressed.
FSECT.BIN is SECTIONED (EE-RAM-address-like u32s early — 0x157xxxx region — then packed
non-address entries); parked, savestate diffing is the better RAM anchor.

**Stream enumeration (P1):** structural scanner (grammar-validated runs, not value hits)
found 1,128 records across 15 BINs. Grammar:
  9D 00 [idx u16] [mode u16: 0x13|0x1000|0x0801] [tag u16 <0x20] [V1] [tag] [V2]
  72 00 [idx] [tag] [Vs]      7F 00 [idx]      also 70/7C/6F/79/81/8F/DB records
  (8F records carry idx PAIRS — link/formation-like.)
Saved artifacts: /tmp scans + `suikosource/bosses.txt` (story bosses: Lv/HP/drops/Potch/SP,
fetched past Anubis same as the bestiary).

**Identity anchoring (P2) — FAILED, decisively:**
- Per-area multiset matching: SP overlap ~0% in every BIN; HP overlaps driven entirely by
  generic round numbers (many BINs "matched" the same small areas).
- Distinctive boss (HP,Potch) pairs (e.g. Man in Black 2500/10000): every hit lands in
  DIFFERENT records of the same dense stream — the cross-record coincidence pattern.
- Strict same-record test (V1,V2)==(HP,Potch) across all streams vs 159 known pairs:
  25 hits, incoherent (same enemy in unrelated BINs, both value orders, all from the same
  ~17 round values) = chance level.
CONCLUSION: the 9D/72/7F streams are generic script commands (amounts/rewards/prices),
NOT enemy stat records. Do not edit them expecting enemy changes.

**What remains (the two decisive paths):**
1. P3 RAM anchoring — needs ONE PCSX2 battle savestate (player-assisted): savestate at the
   start of a battle vs a known enemy (e.g. Blade Bunny, HP 40, Amur Plains). The .p2s
   contains full EE RAM; locate the live battle HP struct, then search its byte
   neighborhood back into the ISO/area BINs for the load source. PCSX2 is not installed on
   this Mac (play happens on the Windows desktop per the memcard sync names).
2. MIPS fallback — capstone 5.0.7 with MIPS support IS available locally; disassemble the
   battle-init path in the boot ELF (known code anchor: name-table loader at file
   0x10E8BC / va 0x16C70BC) and trace where enemy HP is computed/copied from. Larger
   effort, fully autonomous.

---

## PS3 .PSV export format + per-party gold RULED OUT (2026-08-17)

**.PSV support added** (PS3-XMB-exported PS2 save, verified vs a real BASLUS-20387 export):
magic `\0VSP`; +0x08 salt+HMAC (PS3 crypto, NOT recomputed on edit — resign externally for
real-PS3 import); folder name @+0x80; file entries from +0xA0, stride 0x3C:
[created 8][modified 8][size u32][mode u32][name 32][data offset u32]. The S3 gamedata is
the 0xD010-byte entry (observed @+0x590); trailing ~76KB is the 3D icon model. Read/write
in place with checksum fix, same path as SharkPort.

**Per-party gold: RULED OUT with pre-merge evidence.** A 20-save real playthrough series
(Cpt.1→5, .xps) with active parties Hugo/Chris/Geddoe/Thomas/etc shows 0x3200/0x3204/
0x3208/0x320C are ZERO in every save, pre- and post-merge. S3 keeps a single active-party
gold at 0x3210 (rewritten on chapter switch). The earlier "needs pre-merge saves to
validate" question is now closed — there is no per-party gold structure in gamedata.

Bonus validation: the whole 21-file .xps series + a .cbs decoded/round-tripped through the
shipped SharkPort/CBS paths without issue.

---

## Armor sets — composition table + bonus code CRACKED (2026-08-24)

**Set composition table @ 0x3DDAB8** (boot ELF data; single copy in the whole ISO):
5 records × 8 bytes = 4 × u16 item ids in equip-slot order **Head, Body, Shield,
Accessory** (0 = slot not in set). Row order = in-code set number (1-based):
1=Mole 2=Prosperity 3=Destiny 4=Guardian 5=Pale Moon.

**Set-detect routine** ELF va 0x16CAD90 (`which_set(char) -> 1..5 | 0`): walks the
table via base 0x19962B0+8, compares equip slots 4/5/6 and all 3 accessory
sub-slots against each row; empty (0) row entries are skipped, not required.

**All call sites found (jal scan across the full 4GB ISO) + what the code does:**
- **Potch ×3 per wearer** — battle-result overlay, TWO identical copies:
  `sll $v0,$s6,1; addu $s6,$v0,$s6` at ISO **0x3F3E699C** and **0x3F3EF19C**
  (get_set via wrapper 0x181B370, test `andi 2` → matches Prosperity(2) AND
  Destiny(3); stacks per party member — 2 wearers = ×9).
- **Bonus counter chance 30%** — counter routine 0x17FD580: a char without the
  Counter Attack skill wearing set **3 (Destiny)** counters on `rand(100) < 30`:
  `slti $v0,$v0,0x1E` at ISO **0x244F8C** and **0x2452F8**; counter damage =
  (own PWR + support PWR) / 3 (the /3 divides by the set number register — cute).
- **Pale Moon heal 25% of damage dealt** — set == 5 check, then signed /4:
  `addiu $v0,$s1,3` @ ISO **0x245DA8** + `sra $v0,$v0,2` @ **0x245DB4**.
- **Counter-damage halving** — attack-resolution site 0x17FF620 tests
  `andi set,4` (matches Guardian 4 **and** Pale Moon 5 — likely dev bug) and
  halves the counter amount (`sra 1` @ va 0x17FF638). Info-only in the editor.
- **Mole squeak** — field code 0x16E9B60 checks set == 1 while walking.

**Guide discrepancies (Suikosource Rare Armor page):** code says Prosperity is
×3/wearer (not ×7) and the free-counter bonus belongs to Destiny (guide credits
Guardian with "counter rate +50%"). The ×7 legend probably came from testing
Prosperity with its pieces' own Potch Finder skills stacking on the set ×3.

**New "Sets" tab (v1.15.0, web + desktop):** edits the 5×4 composition table (item dropdowns
filtered by slot category) and the three bonus constants — potch multiplier
(encodable set {1,2,3,4,5,8,9,16,17} via sll/sll+addu re-encode, both overlay
copies patched together), Destiny counter % (0–100), Pale Moon heal share
(100/50/25/12.5/6.25% via shift+bias re-encode). All writes go through the
normal staging layer, so .s3mod export/restore-to-default work as usual. Every
patched word byte-verified against a pristine dump before shipping.

### Effect OWNERSHIP — which set grants which effect (2026-08-24)

There is no table of set effects; each is a hard-coded comparison against the set
number returned by `which_set`. Those comparisons are patchable, so any effect can
be moved onto any set (and several can be stacked on one). All 7 selector words
verified byte-exact on a pristine dump:

| Effect | ISO offset(s) | Stock word | Shape |
|---|---|---|---|
| Potch bonus | 0x3F3E6994, 0x3F3EF194 | `30420002` andi $v0,$v0,2 | MASK |
| Bonus counter | 0x244F78, 0x2452E4 | `24020003` addiu $v0,$zero,3 | EQ (Destiny) |
| Heal on hit | 0x245D98 | `24140005` addiu $s4,$zero,5 | EQ (Pale Moon) |
| Counter-dmg halving | 0x246E28 | `30420004` andi $v0,$v0,4 | MASK |
| Squeaky footsteps | 0x131354 | `24110001` addiu $s1,$zero,1 | EQ (Mole) |

**MASK sites are bit tests, not equality** — the game computes `setNumber & mask`.
With sets numbered 1–5 the reachable groups are only: bit0→{1,3,5}, bit1→{2,3},
bit2→{4,5}, so exactly 8 subsets exist. (Stock mask 2 = {2,3} = Prosperity +
Destiny, which independently confirms the row order.) EQ sites take a set number;
6 is unreachable, so writing 6 disables the effect. Writing **0 does NOT disable**
it — `which_set` returns 0 for "wearing no set", so 0 would grant the effect to
everyone not wearing one.

**Two behavioral couplings, both inherent to the original code:**
- *Counter damage is divided by the set number itself* (the routine reuses the
  register holding `which_set`'s return). Stock Destiny = #3 → ÷3. Moving the
  effect to Mole (#1) means no division; Pale Moon (#5) divides by 5.
- *`$s4` is dual-use in the heal routine*: the set-number comparison at 0x245D98
  AND the divisor of `div $zero,$v0,$s4` at 0x245E20 (the compiler's guard
  constant proves the intended divisor is 5). Changing the owner alone would
  silently corrupt that second calculation. The fix: 0x245E1C holds a **dead
  store** (`addiu $a0,$zero,0x64` — $a0 is next *written* at 0x17FE650, never
  read, and no branch targets that address; both verified by scan), so the editor
  repurposes it as `addiu $s4,$zero,5` whenever the heal owner moves off 5, and
  reverts it when the owner moves back (round-trip leaves zero bytes changed).

**Web editor note — AUX WINDOWS.** The web ISO editor only holds the ~3.75 MB ELF
block, but the two potch instruction pairs live ~1 GB into the disc. iso.js now
also reads two 16-byte "aux windows" (0x3F3E6994, 0x3F3EF194 — each covering the
set-ownership `andi` mask at +0 and the multiplier sll/addu pair at +8) on load and threads
them through every write path: in-place save, streaming save, .s3mod export AND
import, .xdelta export AND import, Revert all, and the save review (which decodes
them into a "Potch multiplier ×3 → ×5" row). If a disc can't serve those ranges the
control degrades to "unavailable" rather than silently doing nothing.

---

## Enemy stats / drops / formations — WHERE THEY ARE NOT (2026-08-24)

Investigated making enemy HP, drops, formations and zone placement editable.
**Result: they are not plain data anywhere on the disc.** Recording the evidence so
nobody repeats these scans — each one is a multi-GB pass.

**What was ruled out (all four are exhaustive, not spot checks):**
1. **Whole-disc 4-field fingerprint.** Using s3_bestiary.json's `(lv, hp, potch, sp)`
   tuples as a correlated probe (e.g. Ghost Knight 58 / 6700 / 9500 / 700), scanned
   all 4.3 GB for an HP u16 with the matching SP and potch within ±96 bytes. **One**
   hit, at 0xE6F706A5 — inside SD/STR.BIN, and visibly ADPCM audio (a `24 00`/`44 00`
   cadence every 15 bytes). No real match.
2. **u32 encoding.** Same probe with HP and potch as u32, ±128-byte window: **zero** hits.
3. **Flat table keyed to the enemy index.** The enemy NAME table (0x3E74E0, 100 × 0x14,
   names truncated to ~10 chars — "BladeBunny", not "Blade Bunny", which is why a plain
   text search for guide names finds nothing) was fuzzy-matched to the bestiary, giving
   69/100 indices with known HP. Then every `(base, stride)` pair implied by any two
   anchors was scored across strides 4–0x100 over the whole ELF. **Best score: 5/69** —
   indistinguishable from chance. There is no index-keyed enemy stat array in the ELF.
   (This supersedes the older "+0x0A/+0x0C gets 10-14/100" note: that was also noise.)
4. **Name adjacency.** Enemy names appear ONLY in that ELF table — nowhere else on the
   disc — so there is no name-plus-stats record anywhere.

**Conclusion:** enemy stats live compressed/encoded inside the per-area archives. Making
them editable requires cracking that container format first; it is not a table-offset job.

**Disc layout (ISO9660 walk) — the actual lead for anyone continuing.** `/DATA` holds
one archive per game area plus two shared ones, and the names are Japanese-derived
(MORI ≈ 森 forest, HAKA ≈ 墓 tomb, ICEW ice, RVER river, LAST final dungeon — inferred,
not confirmed), which is exactly where per-zone encounter tables would live:

| File | ISO offset | Size |
|---|---|---|
| FSECT.BIN | 0x4F6000 | 89,388 — small; looks like a sector//directory index for the rest |
| ETC.BIN | 0x375AD800 | 386 MB — shared assets; **has a `PS2\0` magic + named TLV entries** |
| VDZK / KRVI / LZVI / DKVI / TSVI / IKVI / MSVI / ZKTR / AKVI / CRRA / CVIS / HNKT / MORI / SOGE / KTDO / YMMT / KSKR / AKMT / HGB1 / HGB2 / HAKA / FAKE / ICEW / RVER / LAST / SKBN / GDOP / LKOE | see the walk in git history | 1.8 MB – 648 MB each |

Two different container formats: ETC.BIN is the `PS2\0` TLV one (its first 64 MB is
character animation assets — `face`, `walk_start`, `run_stop`, `skin`, `atari`), while
every zone archive starts with a u32 (0x21F0A8, 0x220DA8, 0x22F828 …) followed by small
u16 fields — a consistent, still-undecoded directory header. **Start there:** decode the
zone-archive header, then look for encounter tables inside a small area like SKBN.BIN
(1.8 MB) rather than fighting HNKT.BIN (648 MB).

---

## Random encounter rate — SOLVED as a global multiplier (2026-08-24, v1.17.0)

The encounter *formula* is in the boot ELF and is now editable; the per-area *base rate*
is still map data (see the caveat at the end).

**Anchors that cracked it.** Retail still ships the development debug menu, including
`Toggle Random Encounter ON/OFF` (ELF va 0x19CAD38) and `Random Encounters: AUTHORIZED`
(0x19CA9F0) — proof of a global switch. The Champion's Rune description is in plain text
too: `No encounters with foes weaker than you.` (0x19DD6B0). The encounter module's own
debug printfs sit at 0x19BC388-0x19BC3C0 (`enable Num %d`, `partyInfo %d prob %d`,
`selectProb %d`, `selectPartyNo %d`) — the monster-party picker, one caller down.

**The roll — ELF va 0x17023A8** (single caller, 0x1774014):

```
rate = area_rate * MULT / 100          MULT = 100 walking / 120 running / 150 running mounted
if (rate <= 0) return NO_BATTLE        <- 0 disables encounters outright
accum += distance_moved
if (accum <= 0.5) return NO_BATTLE     <- one sample per 0.5 units travelled
accum = 0
<5-slot ring buffer of positions; take the centroid>
if (all 5 samples within 1.5 walking / 3.5 running of the centroid)
    rate = rate * 130 / 100            <- +30% for milling around in one spot
if (dist_since_last_battle <= grace) return NO_BATTLE
if (rand(100) < rate) -> pick monster party (0x1702290), start battle
```

Note `mult` here is the R5900 3-operand form (`mult $v0,$s1,$v0` writes LO to rd), which
is why the following `div $zero,$v0,$v1` divides the *product*.

**Which movement mode is which** (corrected 2026-08-31 — this section previously had the
walking and riding paths swapped). `$s4` = the **ride** flag `0x16E7B48(obj, 0x80000)`, the
same "is half of a ride pair" bit `docs/MOUNT_SYSTEM_RESEARCH.md` §1 documents. The mode split
comes from two disjoint id classifiers on (obj+2, obj+0xE): **IsWalking** 0x16F3860 matches
id 2 / [2,13] / [0x42,0x44] and takes the RAW path (`move $s5,$s1`, an implicit x1.00, plus
`$s7=1` which swaps the cluster threshold for a gp-relative float); **IsRunning** 0x16F38A8
matches id 2 / [0x0E,0x13] / [0x45,0x46] and takes the 120/150 path, where `$s4` picks **150
if mounted, 120 on foot**. Its `[0x42,0x44]` range is `rdwalk_*`, so **mounted walking takes
the walk path** and the 150 is specifically a gallop. If neither classifier matches, `$s5`
stays 0 and no encounter can fire.

**Editable constants (raw ISO offsets, all byte-verified against a pristine dump):**

| ISO offset | Stock word | Instruction | Meaning |
|---|---|---|---|
| 0x149C3C | 0x0220A82D | `move $s5,$s1` | **walk** path, implicit x1.00 |
| 0x149C40 | 0x10000012 | `b 0x170248C` | walk path skips the scale block |
| 0x149C5C | 0x24020096 | `addiu $v0,$zero,150` | **running mounted** multiplier |
| 0x149C60 | 0x24020078 | `addiu $v0,$zero,120` | **running** multiplier |
| 0x149E44 | 0x24020082 | `addiu $v0,$zero,130` | loiter-in-one-spot bonus |
| 0x149E84 | 0x24040064 | `addiu $a0,$zero,100` | `rand()` modulus |

**How the editor's single percentage works.** Scaling only 0x149C5C/0x149C60 would leave
walking at 100%, so the patch gives walking its own multiplier and branches it into the
shared `MULT/100` block:

```
0x149C3C:  addiu $v0,$zero,MULT_walk     (was `move $s5,$s1`)
0x149C40:  b 0x1702464                   (was `b 0x170248C`)  -> $v1=100; $v0=$s1*$v0; /100
```

This is behaviour-preserving: at 100% it computes `s1*100/100 == s1`, exactly stock. The
three multipliers are then `round(base * pct / 100)` for base 100 walk / 150 mounted-run /
120 run, and **pct=100 writes the stock words back byte-for-byte**, so "restore" leaves zero
staged bytes rather
than merely emulating the default. pct=0 zeroes all three, and `rate <= 0` bails out of
the roll — that's the "no random encounters" case. Cap is 1000% (`addiu`'s immediate is
sign-extended, so the real ceiling is ~21800; 1000 is far past where `rand(100) < rate`
saturates anyway). Encoder/decoder: `s3patch.encounter_words` / `decode_encounter_words`,
mirrored in `web/iso.js` as `encWords` / `decodeEnc` (parity-tested 0..1000 both ways).

**The three multipliers, exposed individually (v1.64.0).** The web editor also offers them as
plain numbers — walking / running / running-mounted — so the *shape* of the risk can change and
not just its size, and a `0` in one mode means that mode never starts a battle. Walking keeps
its stock `move` + `b` whenever its multiplier is x1.00, so editing only the run or mounted
value stages two words instead of four; `encMultWords` / `decodeEncMults` in `web/iso.js`.

Exposed as its own **Encounter** tab in both UIs — the web editor's `drawEncounter`
and the s3editor server's `renderEncounter` (`GET/POST /api/encounter`) — with None /
Quarter / Half / Stock / Double / Triple presets alongside the free-form percentage.

**Still NOT editable: per-area base rates.** `area_rate` and the post-battle grace
distance are read from a **60-byte room record** — `+0x02` = grace (u16), `+0x04` = rate
(u16) — fetched by `0x17B7750`:

```
work = *(0x196A4D0); idx = work->[7]; tbl = *(work->[0x12D0] + 0xC); return tbl + idx*0x3C
```

`work->0x12D0` is set at 0x1773D44 from resource type 5 (`0x188B758(5)`), i.e. the loaded
town data — inside the `DATA/*.BIN` area archives. There is also a script opcode (0x1791148)
that sets both fields at runtime from a 6-byte operand stream, which is why they're
script-driven rather than a flat ELF table.

**Update (2026-08-25):** the "undecoded container" framing above is superseded — see the
ENEMY STATS section, which locates raw 0x8C enemy records in those same zone archives via a
(hp,hp,lv) fingerprint. The same approach should work here: the room record's shape is known
(0x3C stride, `+0x02` grace, `+0x04` rate), so a fingerprint over plausible rate/grace pairs
near each pack's node tables is the obvious next attempt at a per-area encounter-rate list.
Note packs are duplicated ~3x per area, so any editor must write through every copy.

---

## ENEMY STATS — FOUND, raw on disc (2026-08-25)

The earlier "not plain data anywhere" conclusion was WRONG in a precise way: the
stats aren't near potch/SP as guessed, and enemy names never sit near records —
but the records themselves are raw, uncompressed, and now fully located. Chain of
evidence, each step verified on the pristine dump:

**1. Monsters are characters.** The ELF ships an id→name mapping as plain data at
file **0x3B1168** (vaddr 0x1969968): u16 pairs (monster type id, enemy-name-table
index), ids **0x1F5..0x257**, name idx 0..99 (the 100×0x14 name table @0x3E74E0 —
names are TRUNCATED, "BladeBunny" not "Blade Bunny", which is why text searches
failed). The tail maps boss "monsters" to CHARACTER ids (Sarah, Yuber…).

**2. The resolver.** `0x16C6D08` (id→combat struct): chars via a lut @0x19697A8
into 0x8C-stride runtime structs @0x196E700 (BSS, filled from list1). Monsters
via `0x16C6D70`: walks a runtime node list head @**0x196B1F0** of
`{u32 id, u32 count, u32 recPtr[count]}` — count = encounter variants; each rec
is **0x8C (140) bytes**, sub-index stamped at +0x41 at registration.

**3. The register function** `0x1714FA8(nodeTable)` stores the table head. Its
only on-disc caller sits in a battle overlay inside ETC.BIN (ISO 0x417EA768),
registering a node table at overlay vaddr 0x7AF950. That pack's file↔vaddr delta:
**K = 0x4103A640** (derived by node-pointer delta matching, then verified by
decoding: table @ISO 0x417E9FB0 = 29 nodes: GhostArmor/BoneSldr/Chimera/Mirage/
Rock Golem/Siren + character nodes — a Mt. Senai / Ceremonial Site battle set).

**4. Monster record layout (0x8C, decoded + bestiary-verified):**
| Off | Field |
|---|---|
| +12 u32 | EXP-ish reward value |
| +16 u32 | potch-ish reward value |
| +32 8×u16 | combat stats (PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK order per char convention) |
| +48 u16 | **HP** · +50 u16 **Max HP** (equal on disc) |
| +56 8×u8 | resist/skill-ish bytes (0x09 ×8 on plain monsters) |
| +64 u16 | **Level** |
| +0x41 u8 | runtime-stamped variant index (0 on disc) |
Rock Golem (Ceremonial Site): rec 950/950 HP, Lv 55 — exact bestiary match.

**5. Where all the records are.** Fingerprint `u16 hp@X == u16 @X+2, u16 lv@X+16`
against every bestiary (lv,hp) pair finds **4,430 record hits in 167 clusters**
across the zone archives — see `docs/enemy_record_clusters.json` (per-archive
counts: MORI 15, SOGE 20, AKMT 20, YMMT/KSKR 16, FAKE 13, LAST 13, …). Packs are
duplicated ~3× per area (streaming copies at fixed strides, e.g. MORI copies at
+0x298000 intervals) — an editor MUST patch every copy, exactly like the potch
overlay pair. One cluster is ELF-resident (file ~0x3EA58E, stride 0x7C — a
different, smaller record type; tutorial-forest values lv2/hp10; layout TBD).

**Next steps for an editor feature:** per-pack node-table discovery (find each
pack's K via the node-pointer delta trick), id→name via the 0x3B1168 mapping,
then expose per-area enemy HP/level/stats/rewards with all-copies write-through.
Formations/zone-spawn lists likely sit near the node tables in the same packs.

---

## Enemies EDITOR shipped (v1.19.0, 2026-08-25) — full pack decode

Follow-up to "ENEMY STATS — FOUND": the per-monster container is now fully
decoded and the web editor edits it.

**True node layout** (supersedes the first guess): each monster is stored as
`[count × 0x8C stat records][count × 0x34 aux blocks][node {u32 id, u32 count,
u32 recsVa, u32 auxVa}]` — the node FOLLOWS its arrays, and rewards are PER
VARIANT, not per node. Aux block (0x34 bytes):
| Off | Field |
|---|---|
| +0x04 u32 | EXP value |
| +0x0C u16 | SP · +0x0E u16 = 1000 constant (drop-rate denominator, used as a validation marker) |
| +0x10 u32 | potch |
| +0x14 | 12 AI/resist bytes |
| +0x20 | 5 × (u16 item id, u16 weight/1000) drop slots |
Verified vs Suikosource: GhostHolly's three Kuput/Mountain variants read SP
55/460/490 and potch 5,500/30,000/33,000 — exact; drops decode to Byakko Chain
Mail (0xD4, w64) + Guardian Casque (0xA7, w5) etc. Index-wide crosscheck: 736
of 752 (lv,hp)-matched variants agree with the guide on BOTH potch and SP; the
16 outliers are distinct in-game variants the guide conflates.

**Pipeline:** `Editor/build_enemy_index.py <pristine ISO>` fingerprints records
(hp==maxhp @+48/+50, bestiary (lv,hp) @+64), recovers each pack copy's
file↔vaddr delta K by exact-cover voting of (recordBase − recsVa), decodes
nodes with three validations (record sanity, the 1000 marker per variant, and
K-consistency), and merges byte-identical streaming copies. Output:
`Editor/s3_enemy_packs.json` — 41 logical packs, 1,071 variants, 4,592
offsets, every one out-of-block and on-disc (validate.mjs asserts this).

**Web editor:** aux windows generalized to tagged variable-length spans
("potch" | "enemy"); enemy spans are coalesced and read once at ISO load, ride
every save/export/import path like the potch pair, and every edit fans out to
all pack copies. Enemies view = per-pack collapsible editor (lazy-rendered) +
the Suikosource bestiary as reference. Fields registered for the save review
with old → new formatting and a ×copies note.

---

## SPAWN ZONES & FORMATIONS — decoded + editable (v1.21.0, 2026-08-25)

The random-encounter data sits in the same battle packs as the monster records,
as per-map-zone battle-area objects. Chain (all disassembly-anchored):

**ELF side.** `0x1702290` picks the monster party after the encounter roll, via a
party-info API: `0x1715058` (count) / `0x17150A0` (record, stride 0x1C) /
`0x1715198` (spawn slot, stride 0x14) — all reading the battle master object
(`0x1713AB8()`)->0x20, which the pack loader points at the in-pack zone object.
There is also a small per-area (chance, threshold) table as plain ELF data at
file 0x3C1498 (6-byte stride, 0xFFFF-terminated).

**Pack side (per zone, pack-local vaddrs, per-copy K):**
```
zone object : { u32 slotListVa, u32 partyListVa, u32 extraVa, u32 0, char name[] }  e.g. "mori_101"
slotList    : { u32 count, u32 arrayVa } -> 0x14-stride SPAWN SLOTS:
              { u32 monsterId, u32 variantIdx, f32, f32, u32 nodeVa }
partyList   : { u32 count, u32 arrayVa } -> 0x1C-stride FORMATIONS:
              { u16 type, u16 probWeight, u32 ?, u64 -1,
                u16 formationLayoutId, u16 memberCount, u32 membersVa -> u8 slotIdx[] }
```
The slot's `variantIdx` selects which of the monster node's stat variants spawns;
members index the slot array. Verified: mori_101 = HollyShrub/Creeper/Vermitor/
DemonSeed/GrandHolly with 16 weighted formations (w25/50/75), matching in-game
Kuput Forest encounters; zone names are the game's own map ids.

**Indexer (build_enemy_index.py) upgrades:**
- Multi-pass K recovery: regions holding several streaming copies closer than the
  cluster gap (MORI!) previously indexed only ONE copy — now each pass decodes a
  copy, removes its explained fingerprint hits, excludes its K, and repeats. This
  roughly doubled coverage: **81 logical packs, 1,961 variants** (was 41/1,071 —
  the "new" packs are chapter variants with genuinely different stats), bestiary
  crosscheck 1,297/1,329 on potch+SP.
- Copy deltas now come from K differences, NOT node positions — node objects can
  alias across byte-identical copies (they validate under every copy's K), which
  produced duplicate write-through offsets before.
- Zones: found via the name-tagged object signature near each cluster, validated
  against the copy's K, deduped by data offsets (headers repeat in-file), and
  write-through offsets are derived per copy with byte verification — a zone only
  writes the copies whose bytes actually match (chapter variants differ).
- Index: **96 zones, 1,540 formations** (12 packs legitimately zone-less: ETC
  boss/story sets etc.).

**Editor:** each pack card grows a "Zones & spawn formations" section — per zone:
spawn slots (monster picker restricted to the pack's roster — out-of-pack
monsters would spawn without loaded models — plus variant), and formations
(weight 0-100, size capped at the on-disc allocation, member dropdowns labeled
live by slot monster). All writes fan out to every verified copy; review rows
show old → new with the copy count. Verified on the real ISO: swapping mori_101
slot 0 Dark Hare → GhostHolly + weight 50 → 90 produced exactly 6 recipe runs
(3 copies × 2 fields).
## WAR UNITS — FOUND (2026-08-24, supersedes the 2026-08-10 "no editable unit table" spike)

The 2026-08-10 spike searched for war data by STRING vocabulary and concluded war
battles were purely script-driven. That predates the battle-pack breakthrough. A
node-invariant scan (the enemies-editor container: `[count × 0x8C stat records]
[count × 0x34 aux blocks][node {u32 id, u32 count, u32 recsVa, u32 auxVa}]`, found
by `auxVa == recsVa + count*0x8C` over the whole disc) shows the war-battle FIELD
FIGHTS use the same containers — they were invisible to the bestiary fingerprint
because war soldiers aren't in the bestiary.

**What exists (indexed in `s3_war_units.json` by `build_war_index.py`):**
- **Shared war pack in ETC.BIN** (~0x417E4800–0x417E9860, single copy): every
  faction soldier with per-chapter level tiers — ZxnInf ×12 variants (lv17→51),
  KarayaFtr ×8, LizardFtr ×8, MntrLegnnr ×4, Mantor ×2, DuckFtr ×2 — plus the
  chapter-5 war monsters (GhostArmor, BoneSldr, Chimera, Mirage, Rock Golem) and
  nine small-id "leader unit" nodes (ids 0x4, 0x13, 0x22, 0x23, 0x24, 0x28, 0x29,
  0x2A, 0x42) with paired level tiers.
- **Per-battle packs in chapter archives**: ZxnKn (8 variants, lv20–33) in VDZK /
  KRVI / LZVI / ZKTR / HGB1; HarmonSldr (4 variants, lv38–55) in TSVI / ZKTR /
  SOGE; leader nodes alongside. Same-archive byte-identical copies are merged;
  different archives are kept separate so battles can be tuned individually.
- Soldier ids resolve through the ELF pair table (0x3B1168): 0x132 ZxnKn,
  0x133 ZxnInf, 0x136 KarayaFtr, 0x13F LizardFtr, 0x141 DuckFtr, 0x147 HarmonSldr,
  0x165/0x166 MntrLegnnr, 0x167/0x168 Mantor, 0x17C ZxnMarshll.

**Verification vs the Suikosource bosses guide (exact lv/hp):** ZxnKn lv20 hp230 =
Thomas ch.2 war battle; leader id **0x12 = Leo** (23/600 and 35/800 both exact);
**0x42 = Sarah** (six exact matches incl. 60/3200); **0x29 = Franz** and
**0x2A = Ruby** (both 38/400; Ruby has the Mantor-style non-zero PDF column).
The small ids are the game's own actor enum — NOT list1 ids (Leo is 17 in list1
but 0x12 here only by coincidence of adjacency; Sarah is 59 vs 0x42=66).

**War aux blocks are unused** (no EXP/SP/potch/drops — war battles pay no rewards;
the 1000 drop-rate marker is absent), so the index carries `aux: []` and the web
editor edits records only. The editor must keep war offsets DISJOINT from
`s3_enemy_packs.json` — several war clusters sit inside zone archives whose
monsters the Enemies view already edits; `build_war_index.py` excludes any node
whose record offsets the enemy index owns (validate.mjs asserts disjointness).

**Player-side war units** use the characters' own save data (HP/stats/equipment),
so the save editor already covers them. **Per-character war SKILLS (Riding /
Tactics / Valor / Control / runes) are code-embedded, not flat data**: full-ISO
differential scans keyed by both list1 ids and save-ROSTER ids (equality within
same-skill-set groups from the RPGClassics army guide, e.g. Tuta=Yun,
Thomas=Anne; inequality across groups) found nothing but noise, and the war
overlay in ETC.BIN (skill-name strings at ~0x41B1A930, `<type>_wart_<map>` asset
modules, `imf_<char>_100` portrait table at ~0x41B19B20) exposes no assignment
table. The guide's skill list ships as read-only reference (`s3_war_ref.json`).

## Save Editor v5: character-record + inventory layout corrected (2026-08-30, issue #5)

Two user-reported bugs — "Chris is Lv31 in game but the editor says Lv8" and "runes I
added to a bag disappear" — turned out to be one class of problem: several fields had been
read from plausible-looking but wrong bytes, and nothing in the editor could tell.

**Method.** Re-derived the layout from a 28-save corpus (every distinct S3 save in
`Saves/`: 20 sequential `.xps` saves from one playthrough, four memory cards, a PS3 `.psv`,
the multi-team test card, and the extracted raw payloads) — 2100 non-empty character
records and 2327 inventory entries. The key lever: **the PS2 browser title of an S3 save
states the chapter protagonist's level** (`Suikoden3〔07〕Cpt.4 L54/ 61:15`), so each save
carries its own ground truth for the field that was wrong.

### Character record (stride 0x8C) — corrections

| field | was | is | how it was established |
|---|---|---|---|
| level | 0x0D | **0x40** | matches the save-title level in 20/20 titled saves, across all four protagonists |
| weapon (sharpen) level | not exposed | **0x0D** | domain over the corpus is exactly 1..16 (the documented cap) and reads 1 for all five non-human units (Fubar/Bright/Ruby/Koroku/Gadget Z) |
| current HP | 0x08 | **0x30** | cur ≤ max holds 2100/2100 with (0x30, 0x32); the old (0x08, 0x30) pair violates it 47 times |
| max HP | 0x30 | **0x32** | as above; 0x30 == 0x32 for a character saved at full health, and they differ exactly for the wounded ones |
| EXP | u32 @0x00 | **u16 @0x00**, 0..999 | 0x02/0x03 are zero in all 2100 records; the value rises while fighting, resets on level-up, and never reaches 1000 (max 990 at every level band) → progress inside the level, level-up at 1000 |
| stats | 8 names incl. "PDF" | **7 names** | S3 has seven stats (`s3_growth_ref.json`: PWR/SKL/MAG/REP/MDF/SPD/LUK + HP). The phantom "PDF" mapped to 0x28, which is zero for every human record and non-zero only for the five non-human units. The seven real stats keep their offsets (0x20/0x22/0x24/0x26/0x2A/0x2C/0x2E) |

0x08 is a separate u32 counter of unknown meaning — no longer read or written. So is the
u32 at 0x04. Per the "never write unverified fields" rule, neither is exposed.

**Roster mapping is NOT off** (the other candidate explanation). The id byte at +0x0C
agrees with the roster order unanimously across all 28 saves. That mapping is now pinned in
`ROSTER_IDS` and checked on decode, so a future shift is reported instead of silently
mislabeling the roster. Ids are rosterIndex+1 except the non-human units, which use their
own band: Fubar 72, Bright 73, Ruby 74, Koroku 75. Roster slots past 74 are the non-combat
108 Stars and have no character record at all.

### Inventory — corrected model

The region is a uniform array of **eight 30-entry bags** at `0x7060 + n*0xF0`
(0x7060..0x77DF). Block 8 onward is always zero; the item-shaped data further on
(0x7A00..) is the castle **decoration-placement** table, a different structure.

What the eight blocks mean depends on the story phase at 0x14:

- **phase < 5 (pre-merge):** blocks 0-3 = the four teams' carried bags, blocks 4-7 = the
  same four teams' storage. Established by which block moves when the phase changes across
  the corpus's chapter sequence: phase 1 → {0,4}, 2 → {1,5}, 3 → {2,6}, 4 → {3,7}, with no
  cross-talk.
- **phase ≥ 5 (post-merge):** block 0 = the single shared party bag, blocks 1-7 = ONE
  contiguous 210-slot shared storage. Established on a fully-stocked endgame save where
  blocks 1-7 form a single ascending run (each block's last id equals the next block's
  first) and fill strictly in order — block n+1 only holds items once block n is full.

The previous model (four bags + one 90-slot "Storage" at 0x7420) mislabeled blocks 1-3
after the merge, invented a single list spanning three independent pre-merge lists, and
never exposed block 7 at all (30 slots invisible).

### Entry format — the 8 bytes are not what the v2 note said

`u16 item id | 0x8000, u16 count, 4 bytes of per-item state`

- **Bit 15 of the id is a flag, not part of the id.** Every id seen with it set is a castle
  ornament (Graffiti, Peeing Boy, Hex Doll, the paintings, the urns, Plant Vase, …), the
  same ids appear unflagged elsewhere, and the decoration-placement table at 0x7A00 lists
  exactly these items → **0x8000 = currently on display in the castle**. The old
  `iid > ITEM_ID_MAX` test treated these as EMPTY slots, which both hid a real item and
  offered its slot to "+ Add item". On a real chapter-2 save in the corpus, `freeSlots[0]`
  for Chris's bag was the slot holding a displayed Graffiti — adding an item destroyed it.
- **The count is only meaningful for stackable items.** Over 2327 real entries:
  consumables/food (< 0xA0) count 0..6; equipment and runes (0xA0-0x1EF) count **0 in
  986/986**; trade goods (0x1F0-0x1FF) count 1..9; key items/valuables (0x200+) count 0 in
  443/444. Domain 0..9, matching the herrvillain doc's "item qty 0-9".
  The bands are the default but not the whole rule — nine observed ids contradict a pure
  band test and are embedded as exceptions: the **stat stones** (0x0B-0x11; six of the seven
  observed, all count 0, 0x0F by interpolation within the contiguous category block) plus
  **Sacrificial Jizo 0x9E** and **Dragon Incense 0x9F** are one-per-slot despite sitting in
  the consumable band, and **Grape 0x202** carries a count despite being a key item. With
  those exceptions the classification agrees with the game's own count on **2327/2327** real
  entries — zero disagreements.
  Coverage caveat: only **213 of the 508** item ids appear in the corpus at all, so for the
  remaining 58% the band rule is a reasoned guess. `item_stackable_for()` therefore refines
  it using the save being edited — if the player already holds the item, their own entries
  settle it. That override is **one-directional** (it may only demote an item to
  one-per-slot, never promote it): a save written by an older build can contain runes
  carrying a bogus count of 1, and promoting on that evidence would keep writing the broken
  shape for exactly the players who hit the bug. Demotion also requires every entry for
  that id to read 0, so one stray zero cannot demote an item the save holds properly.
  The game holds N copies of a one-per-slot item as **N separate slots, each with count 0**
  — never as one slot with count N (Escape Scroll ×6, New Chain Mail ×6, Graffiti ×6,
  Power Gloves ×5 all appear that way). The editor used to default a new item's count to 1,
  producing a rune entry the game never writes: it displays, but the whole slot is freed the
  moment one item leaves it. That is exactly the reported "attach one Fury Rune and the
  other two disappear", and why editor-added runes did not survive a chapter transition.
- **The trailing 4 bytes are per-item state, not padding.** 27 entries in the corpus carry
  non-zero values there, exclusively on cooking ingredients and food (Okonomiyaki, Minced
  Chicken, Fire Cake, Lunch Box, Mapo Bun, Asian Herbs, Grape). They are now cleared only
  when the slot's item actually changes.
- **Bags are packed from the base**, and the game appends new pickups at the tail (each bag
  shows a sorted prefix plus a jumbled recent-acquisition tail, re-sorted on some event).
  So `appendSlots` — the empty slots *after* the last used entry — is the only safe place to
  add, not "the first slot the decoder called empty".

### Ruled out

- **No per-bag or global item-count field exists.** Exhaustive u8 and u16 scan of all
  53264 bytes against per-bag and total used counts across 28 saves: zero candidates.
- **No mirror/master copy of the bag** anywhere in the payload.

### Guard rails (so this cannot silently recur)

`validate_save()` runs on every decode and returns warnings the web editor shows as a
banner. It checks record-id vs roster, cur ≤ max HP, level/weapon-level caps, item ids past
the table, the bag layout's structural signature vs the story phase, and — the strongest
check — the decoded protagonist level against the level the save's own title reports.
`web/tests/save_roundtrip.py` asserts the layout invariants (no overlapping writable field,
the bag layout tiles the region exactly in both phases, stackable classification, one-per-
slot write semantics, count clamping, flag preservation) and that each guard actually fires
when the corresponding offset is broken.

---

## Per-area encounter rates — room record decoded (2026-08-29)

> **RESOLVED the same day — see the section that follows.** The table WAS located, via
> FSECT.BIN rather than a savestate. This section is kept because its decode of the record
> is what made the find possible, and because the two scans it records still do not work.

Spike against the standing gap in the Encounter tab: the rate is a global multiplier
because each zone's own `area_rate` lives in a "room record" in the map archives, not in
the ELF. The record is now decoded and its rate field is confirmed end to end by
disassembly. **Locating the record TABLE on disc failed** — it needs a live-memory anchor,
same gate as the 2026-08-17 enemy round. Recorded here so the next round starts from the
decode instead of re-deriving it, and does not repeat the two scans that don't work.

**Correction to an earlier note.** This section's VAs use the real mapping
`file = vaddr - 0x165D000 + 0xA4800` (delta **0x15B8800**), read straight from the ELF
program header (PT_LOAD, filesz 0x38D430). The 2026-08-25 enemy note's anchor pair "code
va 0x16C70BC / file 0x10E8B4" is 8 low — the correct file offset is 0x10E8BC. Shipped code
was never affected (`s3patch.ELF_PL_VADDR` and `iso.js` already use 0x165D000); it is only
that one doc line, but disassembling at the doc's delta lands you 8 bytes into the previous
function's epilogue, which reads as `jr $ra` and looks like a dead end.

**The fetch — VA 0x17B7750** (17 callers), exactly as the 2026-08-24 note guessed:

```
work = *(0x196A4D0)
idx  = work->[7]                 ; u8, so at most 256 rooms per loaded map
tbl  = *(work->[0x12D0] + 0xC)   ; work->0x12D0 = resource type 5 ("town data")
return tbl + idx * 0x3C
```

**`+0x04` IS the encounter rate — proved, not inferred.** `0x17B7978` copies the two fields
into the movement object, and the roll's caller reads them straight back out:

```
0x17B7978:  room = getRoom(); obj->0x52 = room->0x02;  obj->0x54 = room->0x04
0x1774014:  lhu $a2, 0x52($s0)   ; grace
            lhu $a1, 0x54($s0)   ; area_rate
            jal 0x17023A8        ; the encounter roll — $a1 is the `rate` of rate*MULT/100
```

**Room record field map (0x3C bytes).** Every offset below is a load or store observed at
one of the 17 call sites; the 0x3C stride is fully accounted for, which is itself a check.

| Off | Width | What |
|---|---|---|
| +0x00 | u16 | `mPartyRank` — named by the printf `townDatNo=%d mPartyRank=0x%x` (0x19C9488) |
| +0x02 | u16 | post-battle grace distance |
| +0x04 | u16 | **area encounter rate** |
| +0x06 | u16 | ? |
| +0x08 | u16 | BgData id — passed to `EdsBgDataLoadReq` (0x19C2EA0) |
| +0x0A | u8 | ? |
| +0x0C | u32 | pointer (tested non-zero at 5 sites; NULL is normal) |
| +0x10/+0x14/+0x18 | f32 | three floats, read with `lwc1` |
| +0x1C | s16 | flag, tested non-zero at 6 sites |
| +0x1F | s8 | ? |
| +0x22, +0x24 | u16 | ? |
| +0x28…+0x38 | u32 ×5 | ? (read as words; likely more pointers) |

**FSECT.BIN is a directory after all** (superseding the 2026-08-09 "relocation table"
verdict). The loader is at 0x1734278 (`\DATA\FSECT.BIN;1` @0x19BE018) and the entry
accessors decode the record exactly:

```
0x171F500(e):  sect = *(u32)e & 0x000FFFFF     ; sector
0x171F520(e):  size = *(u32)e >> 20            ; size in sectors
0x171F5C8(e):  name = e + 4
```

printed by `%s: No.=%02xH sect=%6xH size=%6xH name=%s` (0x19BD7A0). But it is **not
directly parseable from the file**: FSECT.BIN (ISO 0x4F6000, 89,388 bytes) is a serialized
pointer graph — 9,095 of its 22,347 words are absolute EE addresses in 0x1572078…0x1587D28
— and the three "get" accessors above are reached through vtables at 0x197AE28…0x197AE58,
so entries come in several flavours. The load base must satisfy
`0x01572000 <= L <= 0x01572078` (max pointer must stay inside the file, min pointer must not
go negative), a 31-candidate window that no structural scoring separated. It contains no
name strings at all, so the `name` an entry reports belongs to a different flavour of the
same interface. Pinning `L` needs the same RAM anchor as everything else below.

**Two scans that DO NOT work — do not repeat them:**

1. **Sequential-id scan.** Premise was that `+0x00` is a table index counting 0,1,2,… A
   vectorised sweep for 0x3C-stride runs of ≥8 records with `u16@+0x00` incrementing found
   **0 hits in all 29 DATA archives**. The premise was simply wrong: the printf's argument
   order makes `+0x00` `mPartyRank`, not `townDatNo`.
2. **Field-shape scan.** Runs of ≥6 records with `mPartyRank ≤ 64`, `rate ≤ 200`,
   `grace ≤ 20000`, `bgId ≤ 4096`, ≥2 non-zero `+0x0C` pointers agreeing in their top byte,
   and at least one non-zero rate. Result: **~3,000–4,000 candidate tables per archive** —
   chance level. Mostly-zero data satisfies every constraint, and there is no
   cross-validating pointer (the enemy index gets its power from recovering each copy's
   file↔vaddr delta K and validating pointers against it; a room table found in isolation
   has no K to check against).

**The unblock — one PCSX2 savestate, taken on a field map with random encounters** (Kuput
Forest is ideal: `mori_101` is already indexed with its spawn slots). The .p2s holds full EE
RAM, so the chain is mechanical: read `*(0x196A4D0)` → `+0x12D0` → `+0xC` = the live table
address, dump 0x3C×N from it, then search those bytes back into the DATA archives to find
the on-disc source and its copies. That single artifact converts this from a search problem
into a lookup — exactly as it would for the 2026-08-17 enemy round, which was gated on the
same thing before the (hp,hp,lv) fingerprint made it unnecessary. There is no equivalent
fingerprint here: a rate is a small number with no redundant partner to check it against.

**Second, code-only path if no savestate is available:** recover FSECT's load base by
disassembling the walker that consumes it (callers of 0x171F500/0x171F520 and the vtables
at 0x197AE28…0x197AE58), then use the directory to enumerate and extract sub-files by
sector/size and look for the town-data one directly. Larger, but fully autonomous.


---

## FSECT.BIN CRACKED → per-area encounter rates FOUND (2026-08-29)

The section above concluded that finding the room table needed a PCSX2 savestate. It did
not. The way in was the file the 2026-08-09 note had written off as a relocation table.

**1. FSECT.BIN is the archive directory.** Its entries decode exactly as the ELF accessors
say (`sect = w & 0xFFFFF`, `size = w >> 20`, both in 2048-byte sectors) — the catch is that
**the sectors are relative to the containing archive**, which is why they looked like EE
addresses: `0x0157xxxx` read as a pointer is really sector `0x73518` with size `0x15`. The
test that settles it is that a directory's entries **tile its archive exactly**: 23.8% of
all consecutive pairs in the file satisfy `sect[i] + size[i] == sect[i+1]`, and those pairs
form runs that each end precisely on one archive's own sector count.

| Run | Entries | Ends at sector | Archive |
|---|---|---|---|
| word 19983 | 1001 | 316,822 | HNKT.BIN (648,851,456 B) |
| word 19289 | 475 | 151,234 | ZKTR.BIN |
| word 17944 | 315 | 99,220 | VDZK.BIN |
| … | … | … | … |

**28 of the 29 archives resolve, with no unmatched runs at all** (ETC.BIN is absent, as
expected — it carries its own count+12-byte-entry TOC). So the whole disc's sub-file layout
is now enumerable: every archive's sub-files, by offset and size.

**2. The room table is the head of an archive's town-data sub-file.** With sub-file
boundaries in hand the search space collapses from 3.5 GB to ~100 candidates per archive,
and the table falls straight out: a short header (8, 0x10, 0x18, 0x44 or 0x224 bytes,
depending on the archive) followed by N × 0x3C room records. `MORI` sub-file 0 is the
canonical example — six records, then float soup:

```
 idx  rank grace RATE  BgData
 [ 0]    5     6    4   0x010D      BgData = (room number << 8) | area id
 [ 1]    5     6    4   0x020D      so this is area 0x0D, rooms 1..6
 [ 2]    5     6    4   0x030D
 ...
 [ 5]    5     6    4   0x060D
 [ 6]  junk — 0x43xxxxxx floats, the next structure
```

The area id is the discriminator that makes this safe: a run is accepted only while the low
byte of `+0x08` stays constant and the high byte counts up by one, and the whole archive
must then agree on one area id.

**Cross-checks, all independent of each other:**

- Every archive gets a **distinct** area id, and they run 0x01…0x19 with gaps exactly where
  an archive has no table.
- The zone ids the *enemy* index found land in the matching archive every time — `mori_*` in
  the MORI table's archive, `icew_*` in ICEW's, `last_*` in LAST's, and so on.
- The rates are per-room and behave like the game does: town and interior rooms read **0**,
  field and dungeon rooms read 2–9. KSKR rooms 1 and 6 are 0 while 2–5 are 9; ICEW's 14
  rooms alternate 0 and 4 exactly where you would expect a town-then-field layout.
- Every one of the 3,224 emitted offsets is on-disc, **outside** the ELF block (so the ISO
  editor's in-block buffer cannot double-edit it), unique, and re-reads the value the index
  stores for it.
- Unlike the enemy packs there are **no streaming duplicates**: a table's byte signature
  occurs exactly once in its archive, so a write has one target, not three.

**Index:** `Editor/build_room_index.py <pristine ISO>` → `Editor/s3_rooms.json` —
**23 areas, 133 tables, 1,612 room records**. The 133 tables are chapter variants (they
differ in `mPartyRank`, and sometimes in the rates too: KSKR's later variants zero every
room, ICEW's second variant deactivates half of them), so an editor should treat a variant
as its own row rather than assume they agree. Five small archives (CVIS, GDOP, HGB2, LKOE,
SKBN) have no table and are reported as such rather than guessed at.

The disc's whole vocabulary of base rates is **0, 2, 3, 4, 5, 6, 9**.

**Still open:** the other 15 fields of the room record (the three floats at +0x10/+0x14/+0x18,
the pointer at +0x0C, the +0x28…+0x38 words) are located but not interpreted; nothing needs
them yet. `mPartyRank` at +0x00 is very likely the enemy-difficulty tier the area uses per
chapter — worth confirming against the enemy index's chapter variants before exposing it.


---

## Enemy index: FSECT copy recovery (2026-08-30)

The fingerprint pass can only find a pack copy that contains an enemy whose (level, HP) is
in the Suikosource bestiary. FSECT shows how much that misses: the disc holds **285 battle
sub-files** and the fingerprint reaches **172** of them. A copy nobody knows about is a copy
an edit does not reach — the same class of bug as the potch overlay pair.

`build_enemy_index.py` now runs a second pass over FSECT. A battle sub-file *starts* with its
zone object, so with the object's three pointers plus the sub-file's own length, K is
over-determined: sampling 61 sub-files gave **49 unique K, 0 ambiguous** (the 12 with none are
zones with no spawn slots — Budehuc's castle maps — which have nothing to edit anyway). The
pass decodes **214 zones** that way and merges any copy whose slot AND formation spans are
byte-identical to the one already indexed.

Result: **2 zones (`haka_102`, `mori_103`) gained a second write target, +72 offsets.** Before
this, editing either wrote one copy and left the other alone, so the change applied in one
chapter and silently not in the other. Everything else in the index is byte-for-byte
unchanged.

Note the sign convention, which cost a debugging round: `solve_k` returns
`vaddr - offsetWithinSubfile`, while `parse_zones` wants `fileAbs - vaddr`. They are not the
same K and not even the same direction.

**Still uncovered: 148 of the 214 FSECT zones have no entry in the index at all** — chapter
variants whose monster packs the fingerprint never decoded (KTDO 18, MORI 16, AKMT 16, LAST
15, KSKR 12, RVER 12 …). Their spawn slots and formations are real, editable data we do not
expose. Closing that means decoding a pack without a bestiary anchor: with the sub-file bounds
and K both known, the node walk (`[records][aux][node]`) can be driven directly from the zone
object's slot list — each slot names a monster id and its node vaddr — instead of being found
by fingerprint. That is the obvious next round.

---

## Pickups (chests / corpses / herbs) — located; their CONTENTS are not (2026-08-30)

With sub-file bounds in hand, the town sub-files turn out to carry the map's **named scene
objects**: 32-byte, 16-aligned name fields with the object's romaji name. Three of those
names are pickups, and the game says what they are:

| Name | Kanji | What it is |
|---|---|---|
| `takara01`, `takara_huta` | 宝 / 宝蓋 | treasure chest (and its lid) |
| `emono` | 獲物 | a lootable corpse |
| `herb_a01` | — | a herb-picking spot |

**Verified against the walkthrough, not assumed.** MORI's town data holds 3 × `herb_a01` and
1 × `emono`; the GameFAQs walkthrough describes Kuput Forest as having herbs on the
north-west path and exactly one corpse. That is the object vocabulary confirmed from outside
the disc. `build_subfile_index.py` now counts them, so the Files view labels a town sub-file
"area 0x0D · 6 rooms · 1 corpse · 3 herbs" — a per-map pickup census, per chapter variant.

Disc-wide: chests in DKVI, FAKE, KTDO and YMMT; corpses in HAKA, ICEW, MORI, RVER and YMMT;
herbs in AKMT, ICEW, LAST, MORI, RVER and YMMT.

**What is NOT established: which bytes hold a pickup's contents.** The near miss is worth
recording so it isn't re-run as a discovery. About 300 bytes past each `emono`/`herb` name
sits a 0x30-stride record, identical in shape across all five MORI chapter variants:

```
04 00 | 02 00 | 0b 00 | fd ff | 78 d6 21 00 | 00 00 00 00 |
63 01 | 0d 02 | 46 01 | 00 00 | 06 00 | 01 00 | 00 00 | ff ff | fe ff ...
```

`0x0146` is **Cyclone**, which the walkthrough names as the rare drop for Kuput Forest's
corpse — a tempting hit. It is not one. **`0x0163` and `0x0146` appear in EVERY such record,
the herb ones as well as the corpse one**, and a herb spot and a corpse do not share a drop
table. They are script operands that happen to fall in item-id range. This is the same
coincidence class that sank the 2026-08-17 "9D stream" round; the lesson holds — a value in
item range is not an item.

No pickup editor should ship until a field is proved. Ground truth is the obstacle: the
walkthrough yields only **two** fixed-content pickups on the whole disc ("Old Book Vol. 1"
and "Old Book Vol. 9", both at the Flame Champion Hideaway), because corpse loot is random by
design. Two anchors cannot separate a real field from a coincidence. The realistic routes are
(a) find the drop-roll code the way the encounter roll was found — the pickup handler must
read the table, so disassembling it names the field outright, or (b) an emulator watch on the
item the player receives.

## Opcode streams — relocated, still unattributed (2026-08-30)

The 2026-08-17 round enumerated 1,128 tagged records across 15 archives and failed to
attribute any of them to an entity ("no identity anchor"). Two things have changed:

- **They have bounds.** Those streams sit inside `town` and `data` sub-files, which FSECT now
  delimits exactly. A record is no longer a hit at an offset in a 200 MB blob; it belongs to
  one named sub-file of one area.
- **They have neighbours.** In the town sub-files the streams run immediately after the
  named scene objects, in 0x30-stride records punctuated by 0xFFFD / 0xFFFE / 0xFFFF
  sentinels and carrying pack-local pointers (`0x0021xxxx`) — the same shape the earlier round
  saw, now with a named object a few hundred bytes above it.

What has **not** changed is the thing that mattered: nothing proves which record belongs to
which object. The per-record index at `+0x02` counts globally (2, 3, 5 …) rather than per
object, so proximity is the only link, and proximity is what produced the last round's false
positives. Recording the shape and the sentinels here is the useful part; the attribution
needs the same disassembly anchor the pickup contents do — find the consumer, and the
operand layout follows.

---

## Pickup subsystem — disassembled (2026-08-30). Layout proved, enumeration still missing

Following the plan from the section above: find the handler, and the operand layout follows.
The handler was found. Retail keeps the whole subsystem's debug printfs:

| VA | String |
|---|---|
| 0x19C5C48 | `ItemPointInitS %s` |
| 0x19C5C18 / 0x19C5C30 | `FLAG:%s ITEM 0x%x:(%s)` / `FLAG:%s ITEM %d:(%s)` |
| 0x19CB228 | `BOX[%d]:Frist Item(%d)` *(sic)* |
| 0x19CB250 | `!!Takara No Error %d!!` |
| 0x19C8D58 / 0x19C8E20 | `ECPLAYERPICKUPHERB_E` / `GET ITEM wno:%d` |
| 0x19C8E20 | inside `ECPLAYEROPENITEMBOX_E` |

**The runtime item-point table — 0x16D4580(idx, kind, val).** Decompiled exactly:

```
if (idx >= 0xF8) return 0;
base = 0x196B3F0;                            // lui 0x197 / addiu -0x4C10
if (kind == 2) *(u16)(base + idx*12 + 0x1030) = val;     // set
return *(s16)(base + idx*12 + 0x1030);                   // get
```

So the live pickup state is **248 entries × 12 bytes at VA 0x196C420**, the item id being the
u16 at +0 — and the caller masks it `& 0x7FFF` before resolving a name, so **bit 15 is a
flag**, exactly as it is in the save file's item entries. `0x16D4458(idx>>3, idx&7, kind)` is
the companion bitfield (whether the point has been taken). The printf splits behaviour at
idx < 0x10 and idx < 0x28, so the 248 slots are banded by pickup class.

**Treasure-box contents — 0x17B4FF0(boxObj).** Also decompiled, not guessed:

```
$fp = 0x1C                                   // entry stride
$s6 = *(u32)(boxObj + 8)                     // entry array
item = *(u32)($s6 + i*0x1C + 4)              // <- the item field
0x17B54C8(boxIdx, item):
    if (item & 0x4000) { ... 0x16D47A0(kind 6) }   // flagged entry
    if (item == 0x249) ... ; if (item == 0x248) ... // two special ids
```

So a chest's contents are an array of **0x1C-byte entries with the item id as a u32 at +4**,
carrying a `0x4000` flag bit and two reserved ids. That is the field the previous section
could not prove, and it is nothing like the 0x30-stride script records that looked promising —
those really were operands.

**Town sub-file K is free.** A town sub-file's **first word points at its own end**, so
`K = firstWord - fileLength` exactly. Verified on several: MORI[0] `0x00220DA8 - 0x8800 =
0x2185A8`, and every pointer in the file resolves in range under it. This is a general result
— it is the anchor the opcode-stream work also needs, and it costs nothing to compute.

**Why no editor ships yet.** Reading the entries works, and they decode to coherent loot
("Medicine A, Thunder Runner, Stone Of Mag-Def, Berserk Blow"). The missing piece is
*enumeration*: town data is full of 0x1C-stride tables — shop stock and food lists among them —
and neither the item-run fingerprint nor "a pointer under K that lands on a valid run"
separates a chest's list from a shop's. Both accept sequential runs like "Medicine D, C, B, A,
Mega Medicine D, C, B, A" that are obviously a shop.

The box object is the anchor and it is one step away: `0x17B4FF0` is called only from
`0x17B4B34`, so walking back from there to wherever `boxObj` is fetched gives the object's own
signature, and every chest becomes addressable by construction rather than by fingerprint.
That is the next session's first move, and it is a bounded one — a single call chain, with the
layout already proved so the result is immediately checkable.

**Follow-up: the box-object signature does NOT enumerate chests either (2026-08-30).**
`0x17B4FF0`'s only caller is the dispatcher `0x17B4AA8`, which switches on `*(u8)(box+1)`
(type 0/1/2 → `0x17B4C70` / `0x17B4D08` / `0x17B4FF0`), and the outer frame rolls
`*(u16)(box+6)` against `rand(100)`. So the object is at least
`{u8 index<0x28, u8 type<3, .., u16 chance<=100 @+6, u32 entries @+8}` — four constrained
fields plus a pointer that must land on a valid entry run. That was tried as a scan and it
still does not separate chests from anything else: it fires in archives with **no `takara`
object at all** (HNKT, VDZK, ZKTR produce dozens), it returns adjacent 4-byte-apart duplicates
pointing at the same target, and its best-looking hits include 40-entry runs in item-id order
that are plainly the item table or a shop list, not a chest.

The reason is structural: box objects are **not in a flat array**. They are reached through
the scene graph the script builds, so there is no self-validating on-disc signature to anchor
on — which is exactly the property that made the enemy records (redundant hp==maxhp plus a
bestiary level) and the room table (area id plus a counting room number) findable. A chest's
entry has no redundant field; every constraint is independently satisfiable by ordinary data.

So: **the layout is proved and reading works, but enumeration from the disc alone has now
failed twice on the same rock.** The remaining route is the one artifact that converts the
search into a lookup — a PCSX2 savestate taken with a chest open. EE RAM then holds the live
248×12 item-point table at 0x196C420 and the box object itself, and its bytes can be searched
straight back into the town sub-file. Until someone produces that, no chest editor should
ship; reading contents by hand through the Files view's Peek is what is honestly available.

**Guide ground truth exists — and it rules the static search OUT (2026-08-30).**
The Suikosource *Rare Armor* guide (`Guides/…Rare Armor….pdf`) does list chest contents, by
location: 60 rare items, each tagged `Treasure Chest: <location> - Guardian: <boss>`, giving
six sets of 4–13 items. All 60 map cleanly to item ids. That is exactly the multi-item anchor
the earlier note said was missing, so it was worth testing properly. Three results:

1. **Exact 0x1C runs: zero.** No item run anywhere in any town sub-file contains even 3 of
   any location's set.
2. **Stride-agnostic clustering: chance level.** Sliding a 2 KB window for ≥4 distinct
   set members returns 1,000–20,000 "hits" per archive, and the best window in *every*
   archive contains the *entire* set. The rare-armor ids are 60 values packed into
   0xA7–0x141, so any dense binary region satisfies them. Same failure mode as the 2026-08-17
   value matching.
3. **Guardian drop tables are NOT chest contents.** Checked against the enemy index: Chimera
   guards the North Cavern chest holding a Guardian Casque, but drops Gold Beak /
   BladeTailOrnmt / Feather Earrings. (The index does reproduce the guide's *drop* lines
   exactly — Troll Dragon drops Pale Moon Casque at w64, as the guide says — so the check is
   sound; drops and chests are simply different systems.)

Read with the walkthrough's own description — a looted chest **re-spawns with more loot and
more cash**, on a timer — the conclusion is that **chest contents are generated at runtime,
not stored**. The 0x1C entry array proved from `0x17B4FF0` is then the *live* box contents
built in RAM when the chest is rolled, which explains why five independent static searches
(item-run fingerprint, pointer-under-K, box-object signature, guide-set exact, guide-set
clustering) all found nothing: there is very likely nothing static to find.

If that is right, the editable thing is not a chest's item list but the **pool and tier the
roll draws from**. Finding it means following what fills `box+8` rather than reading it —
`0x17B54C8`'s callers and the allocator behind the entry array. Worth stating plainly: a
"chest editor" in the sense of "type in what this chest contains" may not be a thing this
game has.

## Rune item table — every rune's own menu text (2026-08-30)
The "IMPORTANT LIMIT" above (runes have no name↔desc record) turns out to be wrong for runes
specifically. There **is** a rune item table, and it is indexed by **item id**, not by rune
number:

```
record   = 0x3EAF78 + item_id * 0x20
  +0x00  u32 -> name string (vaddr)
  +0x04  u32 -> description string (vaddr)
```

Rows for non-rune item ids are zeroed. All 72 rune items line up name-for-name against
`Suikoden3_item_ids.txt` on a pristine SLUS-20387: ids **317–365** (magic / attack / weapon
runes) and ids **440–462** (the passive support runes). Both editors re-run that name check per
record before trusting a description, so a shifted or modded table degrades to "no text" rather
than showing the wrong rune's line.

Why it matters: the 23 support runes — Balance, Fury, Fortune, Skunk, Drain, Wall, … — have no
spell-table entry at all, so the spell-name join that covered the magic runes left them
completely blank in the pickers. This table is their only source. Examples straight off the
disc: Balance → "Maintains balance.", Fury → "Always berserk.", Drain → "Right-hand rune. Heals
33% HP from critical hits.", Wall → "PDF doubles, but no other movement is allowed."

Located by searching the ELF string pool for a support-rune name ("Balance" @ file 0x424D18),
then finding the single word in the block pointing at it (0x3EE7B8) — a (name, desc) pair whose
0x20 stride and item-id indexing then reproduced all 72 runes exactly.

Read by `s3patch.read_rune_descs()` (bakes `Editor/s3_rune_food_desc.json` for the save editor,
which has no ISO) and live by `iso.js:runeTblDesc()` in the ISO editor. For magic runes the
editors append the spell set the rune grants, e.g.
`"A more powerful Fire Rune. — Grants Dancing Flames, Blazing Wall, Explosion, Final Flame"`.

Related: the ISO editor now drops its name→description caches on every staged edit, undo and
revert (`dropDescCaches`), and reads gear descriptions live from the gear record, so text
rewritten on the Spells / Food / Gear tabs shows up in the item pickers straight away instead of
after an ISO reload.

---

## The pickup ROLL, decoded — and why there is still nothing to edit (2026-08-30)

> Tracked as **[issue #9](https://github.com/TheSparda/Suikoden-3-Editor/issues/9)**, which
> carries the self-contained summary: every decoded structure, the six searches that don't
> work, and the savestate procedure that would unblock it.

Chased the "find what fills `box+8`" plan. The roll itself is now fully decompiled.

**Box type dispatch** — `0x17B4AA8(box)` switches on `*(u8)(box+1)`:
type 0 → `0x17B4C70` (weighted single-item pool), type 1 → `0x17B4D08`,
type 2 → `0x17B4FF0` (the 0x1C multi-item list). `0x17B5230` validates
`*(u8)(box+0) < 0x28` and prints `!!Takara No Error %d!!` when it doesn't.

**The roll — `0x17B4B88(pool, boxIdx)`:**

```
if (!flag(boxIdx, kind 3)) {          // not rolled before
    first = *(u32)(pool);             // slot 0 is the guaranteed item
    if (validate(boxIdx, first) == 0) return first;
}
r = rand(100);  pool += 8;
for (i = 1; i < 6; i++) {             // at most 6 slots
    item = *(u32)(pool); if (!item) break;
    if (r < *(u32)(pool+4) && validate(boxIdx, item)) return item;
    r -= *(u8)(pool+4);               // walk the weights
    pool += 8;
}
return 0;
```

So a pool is **`{u32 item, u32 weight}` × ≤6, slot 0 guaranteed, weights as percentages
walked against `rand(100)`** — exactly the "pool and tier" shape the previous note predicted.
Type 0's result is then written into the item-point table via `0x16D4580(idx, 2, item)`, with
`0x8000` OR'd in when `0x16DBEF8(item)` is true.

**The `0x0146` "Cyclone" reading is now DISPROVED, not just doubted.** In MORI's town data
those words always pair as `[u16 0x0163][u16 0x0Dnn]` and `[u16 0x0146][u16 0x0006]`, and
`0x0Dnn` is a **BgData id** — `(room << 8) | areaId`, and MORI's area id is `0x0D`. The
operand is a map reference, so `0x0163`/`0x0146` are script opcodes. That closes the question
the last two notes left open.

**A real static table, found and understood** — `0x17B52B0(itemId, k)` reads
**VA 0x1985D80 (file 0x3CD580)**:

```
if (item <= 0) return item;
if (item < 5)  return tbl[k];          // Medicine D/C/B/A  (ids 1-4)
if (item < 9)  return tbl[k + 6];      // Mega Medicine D/C/B/A (ids 5-8)
return item;
```

with `tbl = [1,4,3,2,1,1, 5,8,7,6,5,5]` — a **grade-substitution table**: k=1 gives the
strongest grade, k=0/4/5 the weakest. `0x17B4ED0` calls it with a hard-coded `k = 4`, i.e.
that path always downgrades to Medicine D / Mega Medicine D. It is static, in-block and
editable — but it is a *grade remap for the eight medicine ids*, not a chest's contents, and
shipping it under that name would misrepresent it.

**Where this leaves the pools.** The format is known exactly, so a pool is trivially editable
once located — and it still cannot be located. Searching MORI for `{item, weight}×≤6` anchored
by a box object (`+0` index < 0x28, `+1` type < 3, `+8` pointer) returns **zero**. That is
now six independent failed searches: item-run fingerprint, pointer-under-K, box-object
signature, guide-set exact match, guide-set clustering, and pool-shape. Every one fails the
same way, and the guide's own "chests re-spawn with more loot" points at the same conclusion:
**the pools are built at runtime, not shipped on the disc.**

Six searches is enough to stop guessing. The next person should not repeat any of them. The
one thing that settles it is a PCSX2 savestate taken with a pickup in view: EE RAM holds the
248×12 item-point table at **0x196C420**, the box object, and `box+8` pointing straight at a
live `{item, weight}` pool — and every one of those structures is now specified precisely
enough to be recognised on sight.

## Unite membership — who performs a unite is NOT on the disc as data (2026-08-30)
The Unites tab now shows each unite's roster (web editor, v1.31.0). It is **guide reference
only**, read from `Editor/s3_unite_chars.json`, and there is no editable field behind it —
here is why, so nobody re-runs these searches.

Four independent searches for a member list, all negative:

1. **Inside the 0x28-byte unite record.** Every u8 and every u16 slot in the record was
   correlated against the 33 rosters we know. Best hit is `+0x26`, which names a character in
   only **15/33** rows (Geddoe for Mercenary B, Lucia for Clan Chief/Lovely Woman, Viki for
   Pretty Girl, Chris for the three Knight B rows) and mismatches the rest (Griffon→0,
   Bow-Wow→Yumi, Twister→Edge). With `+0x27` carrying flag bits (0x01/0x02/0x04/0x08/0x10/
   0x20/0x40) it reads as an animation/model id that happens to correlate with the unite's
   lead actor — not the party requirement. `+0x00`/`+0x04` are the same anim/effect link
   halfwords the spell table has (Mercenary B at #24 holds the run 0x01D2..0x01D5); no
   correlation at all (0/33).
2. **Per-character field in list1/list2.** Inverted the map (character → unite indices they
   appear in) and correlated every byte column of both stat tables: best is 6/55, i.e. noise.
3. **Party bitmask.** Searched the whole boot ELF for a 10-byte window whose set bits are
   exactly a known roster, at both `bit = id` and `bit = id-1`. No table; the few hits are
   isolated and don't repeat per unite.
4. **Contiguous id list anywhere in the ELF.** Scanned every 24-byte window for one that
   contains all of a roster's ids as u8. The only unite with a distinctive enough roster to
   settle it is Bow-Wow (Koroku 0x30 + the four dogs 0x4C-0x4F): **4 hits, all ASCII**
   (`"LMNO"` inside debug format strings). The two `32,33,34` hits are the sequential remap
   tables at 0x3B0FCA/0x3B10AA, and the `31,32,33` hit at 0x3ED990 is skill-rank data in the
   table that follows the unites (0x3ED718, stride 0x20, name/desc ptr + cost + rank quad).

Conclusion: the party check lives in battle code, not in a data table this editor can address
— same shape of answer as the once-per-battle rune limit. Power/cast/target/AoE/description
stay editable; the roster is displayed and searchable but read-only. Making it editable needs
the battle-side party-scan routine disassembled first.

`s3_unite_chars.json` is keyed by unite INDEX (names repeat: Han ×3, Adonis ×2, Knight B ×3).
33 of 38 are covered; Griffon (#2), Duck (#18) and the three Han rows (#26/#32/#33) are absent
from Suikosource's guide and render as "roster unknown" rather than a guess.


## Shop counters — the whole system, decoded (2026-08-30)
Supersedes the 2026-08-10 spike above, which concluded shop inventories were script data.
They are not. Every shop in the game is a flat record in one of three arrays, and the arrays
were already half-exposed: the editor's `item3_a` and `item3_b` were record 0 of two of them.

**How it fell out.** `re_elf.py xref` on the four SHOP table addresses returned nothing,
because no code materialises them directly. Widening the search to *near* hits (any lui+lo
pair landing within ±0x400) put a single reference 0x1F0 below `item3_a` — and 0x30 later in
the same function, another 0x1F0 below `item3_b`. That function is the accessor:

```
0x170DDF8(kind, loc, stage):
    if (kind < 1 || kind > 3) return 0
    if (loc >= 0x10) return 0
    return BASE[kind] + loc*0x1F0 + stage*0x7C            // 0x1F0 == 4 * 0x7C
```

so the two known tables are `loc 0, stage 0` of a 3 x 14 x 4 array, and `kind 3` names a
third array the editor had never seen at all.

| kind | array base (file / VA) | what it sells |
|------|------------------------|---------------|
| 1 | 0x3EA550 / 0x19A2D50 | item shop (medicines, scrolls, accessories) |
| 2 | 0x3DDCD0 / 0x19964D0 | armour shop (helms, armour, robes, shields, boots) |
| 3 | 0x3EEB48 / 0x19A7348 | rune shop |

14 locations, not 16: the bound in the accessor is `loc < 0x10`, but the stage picker at
0x170DCD8 that feeds it jumps through a **14-entry** table at VA 0x19BCA40 and returns 0 for
`loc >= 0xE`. 14 x 0x1F0 also lands each array exactly under the next known table
(item -> spells @0x3EC2A0, armour -> list4 @0x3DFA08, rune -> item1 @0x3F1E74), which is a
free consistency check and is asserted in `web/tests/validate.mjs`.

**The 0x7C record.**

| offset | size | meaning |
|--------|------|---------|
| +0x00 | 30 x u16 | stock, **zero-terminated** — the enumerator at 0x176C948 caps its scan with `slti $s2, 0x1e` and breaks on the first zero |
| +0x3C | 4 x 16B | "rarity" (rare-find) entries |

30 slots x 2 bytes is exactly the 60 bytes before +0x3C, so the two halves tile the record.
The rarity block's shape is proved outright by its own accessor:

```
0x170DFB0(kind, loc, n):
    rec = 0x170DEB8(kind, loc)                 // wrapper: picks the stage for this loc
    if (!rec || n >= 4) return 0
    return rec + (n << 4) + 0x3C
```

**The rarity entry (16 bytes).** Field offsets from `re_elf.py fields 0x170DFB0`; the three
named ones are read straight out of the roll at 0x170E63C:

```
if (*(u16)(e+0) == 0) return 0                              // empty slot
qty = *(u8)(e+0x0B) + (int)(*(u8)(e+0x0C) * (rand(100) - 50) / 100)
if (qty < 0) qty = 0
return  *(u8)(e+0x0A) < rand(100) ? 0 : qty                 // appearance test
```

| offset | size | meaning |
|--------|------|---------|
| +0x00 | u16 | item id |
| +0x02, +0x04, +0x06, +0x08 | u16 | read by a separate price computation at 0x170E5E0 (`(total - *+8) / *+6`); **not identified**, left alone |
| +0x0A | u8 | appearance chance out of 100 |
| +0x0B | u8 | base quantity when it appears |
| +0x0C | u8 | quantity spread (base +/- spread/2) |

This also retires the 2026-08-09 audit line "SHOP RARE-FIND / % APPEARANCE — NOT PRESENT".
It is present; it just lives past the 60-byte stock array the old flat view stopped at.

**Naming the 14 locations.** The ELF has no shop-name strings, so names come from outside
and each is pinned by an item only that town stocks. The Suikosource *Rare Armor* guide's
"Rarity at <Item|Armor> Shop in <town>" lines and the GameFAQs walkthrough both key on rarity
items, which is exactly the +0x3C block. Ten of the eleven stocked locations resolve, several
of them twice over on two different counters:

| loc | town | what pins it |
|-----|------|--------------|
| 0 | Vinay del Zexay | Yellow Scarf is a rarity at stage 3 and regular stock at stage 4 — the guide says it becomes a regular item at VdZ in chapter 5; Custom Armor / Custom Leather armour rarities |
| 1 | Karaya Village | the Sacrificial Jizo the walkthrough sends you to the "Karaya Village Item Hut" for; clan bandanas / feather bands on its armour counter; one stage only, matching the village burning |
| 2 | Duck Village | Hazy Rune rarity (guide: Duck Village / Alma Kinan) + the only rune counter stocking the Skunk Rune |
| 3 | Great Hollow | DragonTail Ornament ("found at Great Hollow") + Crown of Destiny armour rarity |
| 4 | Chisha Village | LionGod Ring + Prosperity Ring items, Prosperity Hat armour — all three guide-named at Chisha |
| 5 | Alma Kinan | Killer Rune is a rarity at stage 1 and regular stock at stage 2, exactly as the guide describes; Hazy Rune too |
| 6 | Iksay Village | Rose Brooch — guide lists it only at the Iksay item shop |
| 7 | Le Buque | Custom Tunic armour rarity |
| 8 | Caleria | WhiteRose Brooch item + Guardian Chain Mail armour |
| 9 | Brass Castle | Custom Casque + Gold Emblem armour |
| 10 | **unidentified** | one item counter, one stage, rarities are all generic consumables (Mega Medicine A, Kindness Drops, Dancing Flames, Berserk Blow). Not the VdZ Guild Hall — the guide's two Guild Hall rarities (Hunter Rune, Gold Emblem) are absent. Left unnamed rather than guessed. |

Locs 11-13 are zero on all three counters.

Emitted to `Editor/s3_shops.json` by `Editor/build_shop_index.py`; the web editor's Shops tab
reads that file for the names and draws the counters from the geometry above.

**Still open.** The four u16s at +0x02..+0x08; what selects the stage (0x170DCD8 reads a
halfword table at VA 0x196A138 after two calls into 0x16D3700/0x16D3AC8 — presumably chapter
and party); and loc 10's identity, which one savestate or one line of a walkthrough would settle.

## Shining Wind's damage+heal split — CRACKED (2026-08-30)
"Wind MGC. 500DMG to foes. Heals 300HP for allies." is the only spell in the game that does
two *different* things to the two sides. Empty World rules out any data explanation: same
flags14 (`0x0001030A`), same flags18 (`0`), same radius, same everything the record carries —
and its allies take damage ("900DMG to foes. 45DMG to allies"). The split is a hardcoded
`if (spellId == 17)` in the boot ELF.

### The record's real shape (from the engine's own accessor)
`0x16DC888` is `spellRecord(id)`:
```
beq  a0,zero,ret0 ; sltiu v0,a0,0x66 ; ... ; lui v0,0x19A ; sll v1,a0,5
addiu v0,v0,0x4A88 ; jr ra ; addu v0,v1,v0        ->  0x019A4A88 + id*0x20
```
So the id is **1-based** (game id = this editor's row + 1, because `0x019A4A88 + 1*0x20` is
row 0's *name pointer*), and a record actually begins at the name field:

| Off | Field | Getter |
|-----|-------|--------|
| +0x00 | name ptr | 0x16E1C98 |
| +0x04 | description ptr | 0x16E1CC0 |
| +0x08 | cast MOV (u16 read) | 0x16E1D38 |
| +0x0C | flags14 | 0x16E1CE8 |
| +0x10 | flags18 | 0x16E1D60 |
| +0x14 | **power (u16)** | 0x16E1D88 (setter 0x16E1DB0) |
| +0x18 | kind byte (bits 0x02 magic / 0x08+0x10 weapon / 0x20 turn-last / 0x80 lose-balance) | 0x16E1D10 |
| +0x19 | radius | |
| +0x1A | 0x8080 marker | |
| +0x1C | element (low byte) / rune tag (high) | 0x16E1E08 |
| +0x1E | status chance % | |

That is exactly the web editor's layout shifted by one record — the "tail fields live one
record ahead" rule is just this base offset seen from the wrong anchor. Power being a **u16**
is new: the editor writes 4 bytes, but the engine reads `lhu` and its own setter (0x16E1DB0)
does `andi $s0,$a1,0xFFFF ; sw $s0,0x14($v0)` — a full word with the top half zeroed. All 94
stock records have that upper half at 0, so the editor's u32 write is byte-identical to what
the game would do; values above 65535 simply wrap, they don't clobber a neighbouring field.

Ids 102..181 resolve to a second table at VA `0x019AF7F0` (same stride) — not investigated.

### The two hardcoded sites
1. **Which spell splits** — file `0x25A8A4`, VA `0x18130A4`, `addiu $v0,$zero,0x11`, feeding
   `bne $s6,$v0` two instructions later. On a match the applier throws away the record's own
   flags and substitutes a whole profile *per side*:
   ```
   ally: flags14 = 0x00110186, flags18 = 0x1DE7   (heal HP + clear status, whole ally side)
   foe : flags14 = 0x0001020A, flags18 = 0        (plain damage, whole foe side)
   ```
   Both profiles are ordinary values from elsewhere in the table — `0x…0186` is Great
   Blessing's shape, `0x0001020A` is Eternal Wind's. The record's own target byte `0x03` is
   what puts both sides in the target list to begin with; this substitution is what makes the
   two sides get different things. Every other `0x03` spell takes the damage branch on both
   sides, which is Empty World's "45DMG to allies" and Explosion's "target+foes+allies".
2. **How much it heals** — file `0xE1C90`/`0xE1C9C`, VA `0x169A490`/`0x169A49C`:
   ```
   addiu $s2,$zero,0x12C     ; 300
   jal   getPower($s6)
   xori  $v1,$s6,0x11
   movn  $s2,$v0,$v1         ; s2 = (id == 17) ? 300 : power
   ```
   The heal is then clamped to the target's missing HP. So the *mechanism* is generic — every
   other spell that reaches this path heals for its own Power — and only Shining Wind's
   **number** is special-cased, which is why it heals 300 while dealing 500.

A whole-ELF scan for `addiu/xori/andi/slti … , 0x11` within ±14 instructions of any spell-table
getter finds **exactly these two sites**, so nothing else keys on spell 17.

### What that buys
Both are single 16-bit immediates, so "which spell splits" and "how much it heals" are each one
`writeW`. Repointing them hands the whole behaviour to another spell, byte-for-byte reversibly.
The game has **one** such slot: this moves the trick, it can't clone it. Shipped as the
**Damage + heal** card at the top of the web editor's Spells tab (`SPLIT` in `web/iso.js`),
which also offers to set the chosen spell's Target to "All foes + allies" — without both sides
in the target list the ally profile has nobody to land on.

Not attempted: making the check data-driven (e.g. "any spell whose target byte is 0x03 and
whose kind byte is 0x02"). There are only two instruction slots to spend at the branch and the
obvious rewrites would also catch Set!, Dancing Flames and Explosion, all of which currently
damage allies on purpose.
---

## Enemies as party members — id-space analysis (2026-08-26, no new offsets)

Follow-up question to the Enemies/War work: "enemies are character records in
character slots, so can they join the player party?" Analysis lives in
[`docs/ENEMIES_IN_PLAYER_PARTY_RESEARCH.md`](../docs/ENEMIES_IN_PLAYER_PARTY_RESEARCH.md);
the offsets-relevant conclusions:

- **Three disjoint id spaces**, all serialized into the same 0x8C record: list1
  characters **1..79** (`s3_names.json`), war unit types **4..359**
  (`s3_war_units.json`, the actor enum — not list1 ids, as noted above), and
  bestiary monsters **0x1F5..0x257 / 501..599** (`s3_enemy_packs.json`; the
  index contains no id below 0x1F5). `0x16C6D08` dispatches on that range —
  characters via the lut at `0x19697A8`, monsters via `0x16C6D70` walking the
  node list registered by the resident battle pack.
- **Same size ≠ same layout.** Save character block vs monster record agree on
  `u16[8]` stats at **+0x20** and the HP word at **+0x30**, and disagree
  everywhere else (save: EXP@+0x00, id@+0x0C, level@+0x0D, skills@+0x10;
  monster: rewards@+0x0C/+0x10, resist bytes@+0x38, level@+0x40). They are two
  serializations of one runtime struct, **not interchangeable bytes**.
- **Boss characters need no new mechanism**: Luc / Yuber / Sarah etc. have save
  blocks at `0x33AC + rosterIndex*140` and recruit words at `0x232 + rosterIndex*2`,
  and the party list at `0x3216` accepts them — via `s3save.party_id_of()`, not
  their list1 ids (see "The party list is a THIRD id space" below; Luc is list1 57
  but party id 63). What is *proven* is only the write path: putting a roster
  character into an empty party slot does now work in-game (below). The
  boss-specific risks — per-area model residency, story overwrite of 0x3216,
  soft-locks — are still untested; PCSX2 test required before any UI promotes it.
- **Monster ids cannot be party members** (no save block, no persistent record
  outside the resident pack, no character-table name/portrait/field model). Their
  stats *can* be ported onto a character through existing write paths.

---

## The party list is a THIRD id space — party edits never reached the game (2026-08-30)

**Symptom, from a user:** add characters to the party in the Save Editor, reload the save in
the editor and they are there; boot the game and the slots are empty.

**Cause.** `0x3216` (and the leader byte at `0x12`) do **not** hold exe list1 ids. The
`PARTY COMPOSITION` entry under *Save Editor v7* above says "exe list1 id space" and that is
wrong. They hold what the herrvillain reference calls **Party Modifier digits**
(`Cheat files/Cheat info/Suikoden III Cheat Codes.pdf` → *Party Modifier Digits* → *Battle
Characters*) — a third numbering, alongside list1 and the record id at block `+0x0C`:

| | Roland | Bright | Koroku | Emily |
|---|---|---|---|---|
| list1 (what the editor wrote) | 12 | 31 | 48 | 75 |
| record id at `+0x0C` (`ROSTER_IDS`) | 12 | 73 | 75 | 71 |
| **party id (what the game reads)** | **13** | **32** | **54** | **82** |

The party space agrees with list1 for `0x01`–`0x0B` (Hugo…Aila) and then diverges, because it
reserves ids the roster does not: gaps at `0x0C`, `0x21`, `0x25`–`0x27`, `0x2B`, `0x40`. So the
editor's party tab worked for the first eleven characters and silently loaded *somebody else*
for the other sixty-four — and because the decoder used the same wrong table, re-opening the
save showed the pick back, which is exactly why this survived so long.

**Why this reading is right.** Under it every party in the 20-save playthrough corpus + the 5
extracted `gamedata` blobs decodes to a party the game actually builds; under list1 none of
them did:

| `0x3216` | party space | list1 (the old, wrong reading) |
|---|---|---|
| `2,13,18,20,21,45` | Chris + Roland + Leo + Percival + Borus + Salome — the Zexen knights | Chris, Lilly, Beecham, Borus, Queen, Nash |
| `3,17,22,24,23,11` | Geddoe + Ace + Queen + Joker + Jacques + Aila — his mercenaries | Geddoe, Leo, Jacques, Duke, Joker, Aila |
| `2,13,21` (Chris Ch.1) | Chris + Roland + Borus | Chris, Lilly (not recruited in that save), Queen (Geddoe's) |
| `1,54,210,211,212,213` | Hugo + Koroku + Koichi + Connie + Kosanji + Kogoro — the dog chapter | Hugo, Yumi, and four ids that decode to nothing |
| `63,66,65` | Luc + Sarah + Yuber | Hallec, Augustine, Twaikin |
| leader `29` on both phase-4 saves | Thomas — the Thomas chapter | Cecile |

The same table also explains every "guest/NPC" id the editor used to show as a bare number:
`0xD2`–`0xD5` are Koroku's four dogs (list1 76–79, no roster slot) and `0xCA`–`0xD7` are the
reference's *Special Characters* — `0xCA` "Masked Luc" leads two corpus saves.

**Fix.** `s3save.PARTY_IDS` (roster index → party id) + `party_name` / `party_roster_index` /
`party_reference`. The web app's `REF.charById` is now that space, so the picker, the leader
line, the review-changes diff, the JSON export/import and the health audit all speak it;
`health-core.audit` takes a `partyRoster(id)` lookup instead of matching on the record id.
Pinned by `web/tests/save_roundtrip.py` ("Party id space") and by `health-core.mjs`, which
parses `PARTY_IDS` out of `s3save.py` rather than restating it.

**Not changed, deliberately.** The picker offers the 75 battle characters that have a
character block. The dogs, the Special Characters and the *Support Characters* digits
(`0x54`+ — a different field, the support slot at `0x3252`) are named on read but not
offered: they have no recruit word or character block, so the editor cannot make them
coherent, and the reference's support list is missing five roster names (Anne, Kidd, Mike,
Jefferson, Kathy sit in the `0x7A`–`0x7F` gap, six slots for five names, so the alignment
there is undetermined). Correct or absent.

---

## The battle formation at 0x3240 — the other half of a party edit (2026-08-30)

The party-id fix above was necessary but not sufficient: with the right ids written, added
members still did not appear. **`0x3240`–`0x3245` is the "Current Party Formation"** already
listed in the herrvillain save-offset map, and it is what the game reads to decide *how many*
party members to build.

**Layout.** Six bytes, one per formation position, each holding the **1-based index of the
party-list member standing there** (0 = position unused). Unanimous across the 25-save corpus:
the count of nonzero bytes always equals the count of nonzero entries at `0x3216`, and the
nonzero values are always a permutation of `1..n`. Three shapes occur, all written by the game
itself:

| shape | example | where |
|---|---|---|
| dense | `01 02 03 00 00 00` | most saves, every n from 1 to 6 |
| reordered | `01 03 04 02 06 05` | a battle order the player set |
| spread | `01 00 02 00 03 00` | Chris Ch.1, a 3-member party at positions 0/2/4 |

**Why the editor's party tab was invisible in-game.** The same reference's party codes come in
two flavours, and its own note is exactly the symptom:

- *Type One* — "will add a character to an empty slot" — writes **both** `0196E621 = 2` (this
  table) **and** `1196E5F8 = id` (the party list).
- *Type Two* — "will only replace a character" — writes the party list alone, and: **"if a code
  is entered for slot two and no one is in slot two, nothing visible will happen."**

`write_save_edits` was doing a Type Two write. Replacing an existing member worked; dropping
someone into an empty slot left this table still describing the smaller party, so the game
built the old number of members and the new ones never showed up — no error, no crash, just an
empty slot. Combined with the wrong id space, a party edit had to clear *both* hurdles to do
anything, which is why the tab looked completely inert.

**Fix.** `s3save.FORMATION_OFF` / `decode_formation` / `formation_is_valid`, and
`apply_edits_to_gamedata` re-derives the table whenever party edits are applied: surviving
members keep their relative order, new members are appended, and the party list is compacted so
its members sit in slots `0..n-1` (no real save has a gap, and a gap makes "member index"
ambiguous). A same-size swap leaves an existing custom battle order untouched; only a change in
party *size* flattens it, which is when the table has to be rewritten anyway. `decode_save`
exposes `partyFormation`, and the health audit flags a save whose formation and party list
disagree — which is what saves written by the older build look like — with a Fix that re-derives
it through the normal write path.

**Scan for a third gate.** Every file offset whose zero/nonzero pattern tracks party-slot
occupancy across the corpus was enumerated: only `0x3216`–`0x3220` (the party list) and
`0x3240`–`0x3245` (this table) qualify. There is no separate member count and no third
structure to satisfy.

---

## Party edits confirmed working in-game (2026-08-30)

The two fixes above (the party id space, then the formation table at 0x3240) were derived from
the save corpus and the herrvillain reference, not from a running game — the ISO offsets doc's
usual caveat. **They are now confirmed on real hardware/emulator by the user who reported the
bug:** with v1.50.0, Bright (party id 32) and Koroku (54) written into previously empty slots
of a Hugo-led save appear in the party in-game.

That closes both halves at once, and it is the only test that could: each bug alone was enough
to make a party edit inert, so nothing short of an in-game boot could tell "the ids are wrong"
from "the formation is wrong" from "there is a third gate we have not found". There is no third
gate.

**What this does and does not establish.**

- **Established:** a roster battle character, recruited with the right team bits, written into
  an *empty* party slot with `party_id_of()` + a re-derived formation, is built by the game and
  is usable. The two tables at `0x3216` and `0x3240` are together sufficient.
- **Not established:** the same for the **Special Characters** (`0xCA`–`0xD7`) and Koroku's
  dogs (`0xD2`–`0xD5`), which is why the picker still does not offer them; and nothing about
  per-area model residency for characters who are not normally party members, which is the
  open risk in `docs/ENEMIES_IN_PLAYER_PARTY_RESEARCH.md`. Bright and Koroku are ordinary
  roster members with field models everywhere — they are not evidence about bosses.

## Item-record dispatcher — all five item tables, from the game's own accessor (2026-08-31)

`itemRecord(id)` at **VA `0x16DBCD8`** is the disc's own id → record mapping, and it settles the
geometry of every item table at once. It masks `id & 0x7FFF` (bit 15 is a flag, same convention as
the save file's item entries) and bands the id space:

| ids | base VA | base file | stride | what |
|---|---|---|---|---|
| 1–160 | `0x19A14BC` | `0x3E8CBC` | `0x24` | consumables, scrolls, herbs |
| 161–316 | `0x1990E84` | `0x3D8684` | `0x44` | weapons / armour / shields / accessories |
| 317–462 | `0x19A3778` | `0x3EAF78` | `0x20` | runes — the same table as `RUNE_TBL` |
| 463–514 | `0x19A734C` | `0x3EEB4C` | `0x14` | statues, fruit |
| 515–612 | `0x199EE80` | `0x3E6680` | `0x10` | hammers, quest items |

Every band uses **name pointer at `+0`, description pointer at `+4`**, indexed by the *raw* id (not
`id - lo`). Verified 15/15 by reading names back against `Suikoden3_item_ids.txt` — ids 1, 2, 160,
161, 162, 316, 317, 318, 462, 463, 464, 514, 515, 516, 612 all resolve to the expected item.

`getName(id)` is at VA `0x16DBE00`-ish and `getDesc(id)` at **VA `0x16DBE48`**: both call
`itemRecord`, and `getDesc` returns `*(u32*)(rec + 4)` unless bit 15 of the id is set, in which case
ids `0x1CF..0x1D6` and `0x1D7..0x1DD` come from two small alternate string arrays instead.

The last two bands have **no view in the editor** — that is a gap, not a decode problem.

## Rune descriptions are stored TWICE — issue #11 (2026-08-31)

**Symptom.** An edited Kite rune description never appeared in game.

**Cause.** 27 descriptions exist at *two* addresses on the disc, each reached from a different
table, and until v1.58.0 the editor could only write the copy the game does not read.

Census on a pristine SLUS-20387, built from the pointer tables (not by matching text):

- **27 groups, exactly 2 copies each**, and every pair has the same slot length.
- **20** are the attack runes (ids 339–365): `RUNE_TBL[id].desc` **and** the spell record of the
  attack the rune grants. Kite (365) is `0x424F20` (rune) and `0x4232E8` (spell #77).
- **7** are the magic scrolls (item ids 18–26): the item's own desc **and** the spell it casts.
- The 22 magic runes (317–338) and 23 support runes (440–462) have a single copy — which is why
  this never showed up before.

**Which copy the game reads.** `getDesc` (VA `0x16DBE48`) → `itemRecord` (VA `0x16DBCD8`) maps
317–462 to `RUNE_TBL` and reads `+4`. So the rune menu shows **`RUNE_TBL`'s copy**.

**Why the Text tab could not reach it.** `TextCore.looksLikeText` rejects every one of the 27:
`DMGx0.4` trips its `[A-Za-z]\d` reject. Confirmed by running the real filter over them. So the only
editable copy was the spell record's — the wrong one, 100% of the time, for anyone who tried.

**Fix (v1.58.0).** The Runes browser now owns the rune's menu text (in place, slot-capped), and
every description write mirrors all copies. The alias index is built from the desc pointers of the
five item bands + `SPELL` + `UNITE` + `FOOD`, and two copies are only linked when reached from
**different** tables — within one table, repeated text is just repeated text. On a pristine disc the
cross-table rule finds all 27 real groups and **zero** false ones.

## Status effect STRENGTH — code constants, and they are editable (2026-08-31)

Supersedes the v12 note "Status effects are NOT a tunable data table". That conclusion is right
about *data* and wrong about *reachable*: the magnitudes are `addiu $rt, $zero, imm` immediates in
the battle code, the same class of patch as the encounter rate, the potch multiplier, the mount
pairs and the damage+heal slot. All shipped in v1.58.0.

**The flags18 bit is only a selector.** The translator at **VA `0x1816400`** is a pure bit remap:

```c
out[0] = flags18 & 0x0007BFFF;                 // low bits copied verbatim
if (flags18 & 0x00080000) out[4]  = 0x40;      // bit19 mgc-immune-once
if (flags18 & 0x00200000) out[4] |= 0x80;      // bit21 buff PDF/MDF
if (flags18 & 0x02000000) out[4] |= 0x01;      // bit25 resist-fire
if (flags18 & 0x04000000) out[4] |= 0x04;      // bit26 resist-lightning
if (flags18 & 0x08000000) out[4] |= 0x02;      // bit27 resist-wind
if (flags18 & 0x01C00000) out[4] |= 0x10000000;// bits 22|23|24 -> ONE "enchanted" flag
```

Note the last line: the three sword-enhance bits **collapse into a single flag and lose even the
element**. So there is no per-bit strength field anywhere to expose.

**Where the element comes back, and the percentages.** VA `0x16BFC50` re-reads the mask and turns it
into a percentage, adds the chanter's Sword of Magic (skill `0x29`) rank, then `base * pct / 100`:

| tunable | stock | file site(s) | VA |
|---|---|---|---|
| sword-fire added | 20 | `0x107470` | `0x16BFC70` |
| sword-lightning added | 20 | `0x107480` | `0x16BFC80` |
| sword-wind / fall-through | 15 | `0x107478` | `0x16BFC78` |
| any enchanted weapon, extra | 30 | `0x102488` | `0x16BAC88` |
| resist: weak | 120 | `0x0E3868`, `0x24765C` | `0x169C068`, `0x17FFE5C` |
| resist: neutral | 100 | `0x0E3870` | `0x169C070` |
| resist: tier 1 | 80 | `0x0E3878`, `0x247664` | `0x169C078`, `0x17FFE64` |
| resist: tier 2 | 60 | `0x0E3880`, `0x247668` | `0x169C080`, `0x17FFE68` |
| resist: tier 3 | 40 | `0x0E3884`, `0x24768C` | `0x169C084`, `0x17FFE8C` |
| PDF/MDF buff | 85 | `0x104810`, `0x1053DC` | `0x16BD010`, `0x16BDBDC` |
| mask-0x4000 status | 150 | `0x10540C`, `0x105420`, `0x1054B8`, `0x1054CC` | `0x16BDC0C/20`, `0x16BDCB8/CC` |

**Nineteen sites for eleven tunables — the duplication is the trap.** The resistance ladder exists
**twice**: a 5-entry jump table at VA `0x169C040` (table of targets at VA `0x19B8830`, file
`0x400030`) and a branch chain at VA `0x17FFE3C`. The 150 sits at **four** sites: two functions,
each testing both sides of the field with the value duplicated into a branch delay slot. A partial
write does not error — the game just behaves differently depending on which path runs, so each
tunable must write all of its sites. The editor registers each site separately and numbers it
("site 3 of 4") precisely so the unsaved-field count and the review list make a partial write
visible before saving.

**Duration is still out of reach, and here is exactly why.** `setStatus(side, mask, level)` at
**VA `0x16BE920`** does take a strength: the poison handler at VA `0x16BEA98` stores
`(level & 7) << 2` into a per-side status word at VA `0x196B150` — a real 3-bit level, and the
RPGClassics status page independently says poison damage "depend[s] on the type of poison". But
every one of the 42 live call sites computes that level at runtime. The one routine that reads
per-status levels out of a **record** — VA `0x16BF1E0`, whose argument carries a byte array of them
at `+0x00..+0x22` — has **no references anywhere in the ELF**: no `jal`, no `j`, no `lui/addiu`
materialisation, no data pointer. It is dead code.

**Guide cross-check.** The Suikosource Rare Armor guide says resistance reduces damage by
20 / 30 / 40 percent at levels 1/2/3. The decoded ladder gives reductions of 20 / 40 / 60. Level 1
agrees exactly; 2 and 3 do not, and no arithmetic on the decoded values produces 30/40. The jump
table is read straight off the disc, so the **values** stand; what is an inference is the
tier → "level N" naming, and that is the likely site of the disagreement. Flagged in the UI.

**Still open, with the numbers to look for.** The RPGClassics status page says Alert doubles
offensive magic with a 20% chance to backfire, Berserk raises strength 50%, and Boost lasts three
turns. A 150 (= +50%) exists but is gated on mask `0x4000`, which this repo labels *mgc-boost*
rather than berserk — so it is deliberately **not** presented as the berserk figure.

## Spell target and element bytes — the complete sets (2026-08-31)

`TARGET_OPTS` and `ELEMENTS` both stopped short of the data, so 15 of the 94 spells rendered as
`custom 0xNN` and 17 as a bare `undefined`.

**Target byte** = `(flags14 >> 8) & 0x7F`. The complete set in use is nine bytes: `0x01 0x02 0x03
0x05 0x06 0x09 0x0A 0x12 0x41`. The three that were missing decode straight from the bit meanings
and are confirmed by every description that carries them:

| byte | bits | meaning | n | evidence |
|---|---|---|---|---|
| `0x05` | `0x04\|0x01` | the **chanter alone** | 7 | "Enhances chanter's…", "Raises chanter's…" (×6) + Wrath, a self-heal |
| `0x09` | `0x08\|0x01` | **one ally** | 2 | Healing Wind "of 1 ally", Mother Ocean "1 ally's HP" |
| `0x12` | `0x10\|0x02` | a **line** of foes through the target | 6 | "target+foes in front" / "in line" / "LOS foes beyond", and each carries a non-zero radius, which no `0x0A` single-target spell does |

**Element byte** (`SPELL.elem`, the tail field) is really a magic **family**. 1–5 are proven outright
— all 32 of those spells open with the matching `"<X> MGC."` prefix (Fire 8/8, Water 6/6, Wind 6/6,
Earth 6/6, Lightning 6/6). 6 is the Pale Gate rune. **7–10 are not elemental at all**; each is
exactly one rune's spell set: 7 = the six Sword-of-\* / \*-Amulet spells, 8 = the four Jongleur
songs, 9 = the Shield rune, 10 = Ready!/Set!/Go! (Blinking).

## Unit class / role — DERIVED from skills, there is no class byte (2026-08-31, issue #13)

The class the game shows per unit (Hugo a Slasher, Lulu a Knight, Fubar a Slasher) is **not stored
anywhere**. It is recomputed from the character's own skill list every time it is drawn. Chain:

| what | address |
|---|---|
| display routine | VA `0x169B5F8` |
| skill id of slot *i* | VA `0x16C7758` → `*(u8)(rec + 0x10 + i*2)` |
| skill rank of slot *i* | VA `0x16C7878` → `*(u8)(rec + 0x11 + i*2)` |
| live 140-byte character record | VA `0x16C6D08` |
| class table, 43 rows × 47 pairs | VA `0x19605C0`, file **`0x3A7DC0`** |
| word pool, 78 string pointers | VA `0x1960480`, file **`0x3A7C80`** (index 0 blank) |

The routine keeps the skill slots with rank > 0, selection-sorts them by rank descending (stable),
takes the top two, and reads `table[(skillA-1)*94 + (skillB-1)*2]` → `(type word, modifier word)`,
both indices into the pool.

**The table's column index is the skill id, all 43 of them** — `0x0C` Shield Protect → "Shield
Knight", `0x0D` Armor Protect → "Armored Knight", `0x0E` Fire Magic → "Fire Cmdr.", `0x1F` Cook →
"Cook Fighter", `0x28` Pale Gate Magic → "Gate Cmdr.". Pool indices 1–21 are the class words
(Slasher, Knight, Cmdr., LeRsnt, Guard, Mage, Herculn, Magicn, Priest, Rider, Shield, Armored, Fire,
Ice, Storm, Earth, Thunder, Gate, Magic, Healer, Fighter); 22–77 are the modifier words.

**Verified against the three known units.** Re-running the derivation over `list1` gives Hugo
(Heavy Damage r2 + Counter Attack r1) → Slasher, Fubar (Damage r2 + Accuracy r1) → Slasher, Lulu
(Swing r2 + Repel r2) → Knight. All 79 rows produce plausible types (Fred → Shield Knight, Leo →
Armored Knight, Nicolas → Guard, Luc → Storm Magicn).

**What this rules out.** The candidates the issue proposed are all wrong: there is no role enum at
list2 `+12`, list1 `+0`, list2 `+13/14/15`, or in list 4. The way to change a unit's class is to
change its **skills**.

Shipped read-only as **Reference → Classes** in v1.58.0, recomputed live so editing skills moves the
class with them.

**Side finding:** the character skill array is **7 slots**, not 6 — the game reads `i < 7`, and
Guillaume and Rody both use the 7th pair (list1 `+24/+25`). `LIST1_FIELDS` and `skillHoldersLive()`
still stop at 6, so that slot is neither shown nor counted.
