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
- +0  u16  starting item/rune id (list1_1)
- +9  u8   (list1_2)
- +12..+25  14× u8 (list1_3 … list1_14) — skills/runes/equip block
- +64 u16, +72 u16, +80 u16, +88 u16, +96 u16, +104 u16 (list1_15…20)
- +112 u16 + u8, +120 u16 + u8, +128 u16 + u8 (list1_21…26)

### List 2 — growth/skill limits (stride 132)
- +0 u8; +4..+8 5×u8; +9..+11 3×u8; +13..+66 54×u8 (list2_9…54);
  +80..+96 17×u8 (list2_60…76); +100..+101 2×u8 (list2_80,81)
- Skill max-level encoding: 0=Can't get, 1=A+, 2=D, 3=C, 4=B, 5=B+, 6=A, 7=S.
  **Max is 7** as of v1.2b (8 caused in-game problems).

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
  0x16C70BC / file 0x10E8B4). Addresses it computes nearby:
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
