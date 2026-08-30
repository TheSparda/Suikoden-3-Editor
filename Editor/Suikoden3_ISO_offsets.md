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
rate = area_rate * MULT / 100          MULT = 150 running / 120 walking / 100 riding
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

**Which movement mode is which.** `$s4` = dash flag (`0x16E7B48(obj, 0x80000)`). The mode
split comes from two disjoint id classifiers on (obj+2, obj+0xE): 0x16F3860 matches
id 2 / [2,13] / [0x42,0x44] and takes the RAW path (`move $s5,$s1`, an implicit x1.00,
plus `$s7=1` which swaps the cluster threshold for a gp-relative float); 0x16F38A8 matches
id 2 / [0x0E,0x13] / [0x45,0x46] and takes the 120/150 path. If neither matches, `$s5`
stays 0 and no encounter can fire.

**Editable constants (raw ISO offsets, all byte-verified against a pristine dump):**

| ISO offset | Stock word | Instruction | Meaning |
|---|---|---|---|
| 0x149C3C | 0x0220A82D | `move $s5,$s1` | ride path, implicit x1.00 |
| 0x149C40 | 0x10000012 | `b 0x170248C` | ride path skips the scale block |
| 0x149C5C | 0x24020096 | `addiu $v0,$zero,150` | running multiplier |
| 0x149C60 | 0x24020078 | `addiu $v0,$zero,120` | walking multiplier |
| 0x149E44 | 0x24020082 | `addiu $v0,$zero,130` | loiter-in-one-spot bonus |
| 0x149E84 | 0x24040064 | `addiu $a0,$zero,100` | `rand()` modulus |

**How the editor's single percentage works.** Scaling only 0x149C5C/0x149C60 would leave
the ride path at 100%, so the patch gives ride its own multiplier and branches it into the
shared `MULT/100` block:

```
0x149C3C:  addiu $v0,$zero,MULT_ride     (was `move $s5,$s1`)
0x149C40:  b 0x1702464                   (was `b 0x170248C`)  -> $v1=100; $v0=$s1*$v0; /100
```

This is behaviour-preserving: at 100% it computes `s1*100/100 == s1`, exactly stock. The
three multipliers are then `round(base * pct / 100)` for base 100/150/120, and **pct=100
writes the stock words back byte-for-byte**, so "restore" leaves zero staged bytes rather
than merely emulating the default. pct=0 zeroes all three, and `rate <= 0` bails out of
the roll — that's the "no random encounters" case. Cap is 1000% (`addiu`'s immediate is
sign-extended, so the real ceiling is ~21800; 1000 is far past where `rand(100) < rate`
saturates anyway). Encoder/decoder: `s3patch.encounter_words` / `decode_encounter_words`,
mirrored in `web/iso.js` as `encWords` / `decodeEnc` (parity-tested 0..1000 both ways).

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

## Per-area encounter rates — room record fully decoded, table NOT located (2026-08-29)

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
