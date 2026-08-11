# Suikoden III ISO & Save Editor

A cross-platform editor for **Suikoden III** (PS2, USA `SLUS-20387`). It runs as a
local web app in your browser and does two things:

- **ISO editing** — change spells, runes, unite attacks, gear, weapons, shops,
  characters, and in-game text directly in the disc image (applies to a new game).
- **Save editing** — open a PS2 **memory card** and edit an existing playthrough:
  levels, stats, skills, equipment, party, inventories, gold, recruitment, and names.
  No ISO required.

Nothing is uploaded — the server runs on your machine and only touches the ISO or
memory-card file you point it at. It contains **no game data**; supply your own
legally-obtained files.

---

## Features

### Characters
- Edit any character by name (dropdown) with a **search box** that filters by name or
  id (decimal/hex).
- **Section** selector across the character data tables:
  1. **Starting Stats / Equipment** — starting skills + ranks, equipped runes
     (L/R hand, head), helmet/armor/shield, starting items.
  2. **Growth · Skill Max · Fixed Skills** — stat growth rates, rune levels, per-skill
     caps, fixed/free skills, starting level.
  3. **Support Skills** — the character's support-skill slots.
  4. **Raw bytes** — fallback hex view.
- Equipment/rune/skill fields are searchable dropdowns with in-game descriptions.

### Spells
- Full spell/rune-effect table, **grouped by rune** and ordered by element family
  (Fire → Rage → True Fire; Wind → Cyclone → True Wind).
- Edit **power**, **cast/movement time**, **element**, **target/size**, **AOE**
  (area vs single), and inflicted **status effect**.
- In-game descriptions inline; live-updating shape/target pill; filter box.

### Runes
- Pick a rune and edit **each of its spells individually**.
- **Bulk-apply** power / cast / element / AOE / status to *every* spell a rune grants.
- Attack- and unit-unique runes are labelled with their **owner** where known.

### Unites
- Co-op **unite attacks** with the **characters involved** in each.
- Edit **power**, **cast time**, and **target**; descriptions inline.

### Gear
- Edit **DEF**, **price**, and up to **5 effect slots** per item.
- Effect types: **HP regen per turn**, **stat bonus** (choose the stat), **grant skill**
  (choose the skill), status protect, elemental resist, evade, and more.
- In-game item descriptions per item.

### Weapons
- Edit each weapon type's **ATK at all 16 sharpen levels** — Suikoden III's "weapon
  power" (weapons grow via sharpening, not a single fixed stat).
- Per-level editing plus a **scale ×** control to raise/lower a whole curve at once.

### Hard Mode
- A **player-nerf difficulty** section with a master **Enable Hard Mode** toggle.
- Presets (**Tougher / Hard / Brutal**) or fully custom per-stat multipliers, driven by
  each character's **stat growth rate** so the whole party grows weaker across all 99
  levels. Optional spell/unite **power** scalers.
- Multipliers scale the ISO's *default* value, so presets are **idempotent** (never
  compound) and **Restore all to default** cleanly reverts. Enemies can't be buffed
  directly (their stats aren't in an editable table), so difficulty comes from a weaker
  party. Lowering growth only affects levels gained *after* the change — best started
  on an early save.

### Other ▾ (grouped in the nav bar)

**Shop** — edit shop stock slots and the price ladder; item slots are dropdowns.

**Enemies** — read-only reference list of all 100 enemy entries by index + name,
searchable. (Enemy HP/attack are set by the battle engine, not a flat table.)

**Text** — edit the game's **UI / battle / menu / prize / error strings** and short
character blurbs, read live from the boot executable in a searchable list. Each edit is
**capped to the original byte length**. *Story dialogue is not here* — it lives in
packed event files outside the executable.

**Reference** — searchable **Item** and **Skill** hex-ID lists.

### Save Editor (PS2 memory card)
Edit an **existing playthrough** — no ISO needed. Unlike ISO edits (new game only),
these change a save you're already playing.

- **Opens 8 MB PS2 memory cards** (`.ps2`, `.mcd`, `.mc2`, `.bin`). Scans nearby folders
  and flags which cards hold a Suikoden III save, offers **Reopen last card**, and has a
  **Browse…** button that opens your OS's native file dialog (restricted to card
  formats) so you can pick a card anywhere on disk. Reads all four save slots.
- **Per-save metadata** (read-only): **Chapter** and **Playtime** (from the PS2-browser
  title), the current **party leader** resolved to a name, and the raw story phase.
- **Suikoden I / II carryover indicator** — whether a linked S1/S2 save was loaded
  (based on the transferred hero/country names).
- **Editable names** — Flame Champion, castle, and imported S1/S2 hero + country names.
- **Gold / potch** — editable per save.
- **Characters** (with a "recruited only" filter): level, current/max HP, EXP-to-next,
  the 8 stats, all **equipped gear** (head/right/left rune, helm, armor, shield, boots,
  gloves, accessory), and all **8 skill slots** (skill + rank).
- **Recruitment** — a per-character **recruited** checkbox plus a **"recruited by"**
  dropdown (Hugo / Chris / Geddoe / Thomas) for the pre-merge protagonist who owns a
  unit.
- **Party composition** — pick who fills each of the 6 active battle-party slots.
- **Inventory** — grouped by bag. Early game, **Hugo / Chris / Geddoe** (and Thomas)
  carry separate inventories before they merge; each bag is editable on its own, split
  into **Party Items** vs **Key / Valuables**. You can **add new items** to free slots.
- **Safe writes** — a `.bak` of the card is made before the first write, and the save
  **checksum** and per-page **ECC** are recomputed so the edited card still loads. Best
  practice: after editing, load the save in-game, re-save, and play from that.

> Stat-column labels are a best-effort decode (one slot is unused in-game); level / HP /
> EXP / skills / equipment / names / party / recruitment are confirmed. Per-character
> *weapon (sharpen) level* is intentionally **not** exposed — its save offset couldn't be
> confirmed, so it's omitted rather than risk clobbering the level byte it aliases.

### Quality-of-life
- **Edits are staged**, applied on **Save to ISO**; **Revert** discards; unsaved-changes
  indicator. Save-editor writes go straight to the card (with a `.bak`).
- **Changed-from-default** highlighting + per-field **↺ Restore to default**.
- Numeric inputs are clamped to each field's size.
- Remembers your last-opened ISO / memory card.
- Two themes — **Crimson & Gold** (dark) and **Parchment** (light), remembered across
  sessions. Inspired styling only; no game art is used.
- One-click launchers for macOS and Windows.

---

## Getting started

**Requirements:** Python 3.8+ (standard library only — no `pip install`) and a modern
browser. For ISO editing you also need your own USA `SLUS-20387` disc image; for save
editing, your own PS2 memory-card file. Runs on macOS, Windows, and Linux.

**Easiest — double-click a launcher** at the top of the repo:
- macOS: **`Start Editor (Mac).command`** (first time: right-click → Open).
- Windows: **`Start Editor (Windows).bat`**.

**From a terminal:**

```bash
cd Editor
python3 s3editor.py                                      # then pick an ISO in the browser
python3 s3editor.py "/path/to/Suikoden III (USA).iso"    # or preload one
python3 s3editor.py "/path/to/game.iso" 9000             # optional custom port
```

It opens a browser tab at **http://127.0.0.1:8747** (or your chosen port). Keep the
terminal window open while you work. The last-opened ISO is remembered in
`Editor/.s3editor.json`. Because a 4 GB ISO can't be uploaded through a browser, the
server opens files **by path** on the local disk.

> **Keep a clean backup of your original ISO.** The editor can make a `.bak` before its
> first write (header toggle), but a separate untouched copy is the real safety net.
> Test edits on a *copy* first (see `Editor/make_test_iso.sh`).

---

## Command-line patcher (advanced)

`Editor/s3patch.py` is the underlying ISO engine and a standalone CLI:

```bash
cd Editor
python3 s3patch.py verify      "/path/to/game.iso"
python3 s3patch.py spells      "/path/to/game.iso"
python3 s3patch.py reskin-rune "/path/to/game.iso" --rune fire --power 3000 --aoe on
python3 s3patch.py -h                                    # full command list
```

`Editor/s3save.py` is the memory-card engine (read/write + checksum + ECC) and can also
be run directly for research.

---

## Repository layout

| Path | What it is |
|---|---|
| `Start Editor (Mac).command` / `(Windows).bat` | Double-click launchers (top level) |
| `Editor/s3editor.py` | The web app (server + embedded UI) |
| `Editor/s3patch.py` | Core ISO logic + command-line patcher |
| `Editor/s3save.py` | PS2 memory-card save reader/writer (checksum + ECC) |
| `Editor/s3fields.py` | Character record field schemas |
| `Editor/s3_*.json` | Extracted names, descriptions, rune owners, unite casts |
| `Editor/Suikoden3_ISO_offsets.md` | Reverse-engineering notes / offset reference |
| `Editor/make_test_iso.sh` | Clone-and-test helper |

---

## Credits & acknowledgements

This project stands on community research.

- **[Suikosource](https://suikosource.com/)** and its guides — the *Skills List* by
  **Blue Moon**, the *Initial Equipment / Rune Slot List* by **wataru14 / genso710**,
  and the unite-attack guides — used to identify characters, skills, and unites.
- **`Suikoden3EditorV12b.exe`** — the original Windows editor, whose embedded name/label
  lists were the source for the character-name dropdowns and field mappings.
  Reverse-engineered here for reference and reimplemented cross-platform.
- Item descriptions and offset tables were extracted from the game's own data by this
  project (see `Editor/Suikoden3_ISO_offsets.md`).

If any attribution is missing or incorrect, please open an issue.

## Legal

This tool contains **no game data or copyrighted game code**. Supply your own
legally-obtained ISO / memory-card files, for personal use only. Suikoden III is
© Konami. Referenced guides remain the property of their respective authors and
Suikosource.
