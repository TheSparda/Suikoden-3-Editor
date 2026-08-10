# Suikoden III ISO Editor

A cross-platform editor for the **Suikoden III** PlayStation 2 game disc. It runs
as a local web app in your browser (plus a command-line patcher for power users),
and lets you edit spells, runes, unite attacks, gear, shops, and character data
directly in the ISO.

Nothing is uploaded anywhere — the server runs on your own machine and only ever
touches the ISO file you point it at.

---

## What you need

1. **Your own copy of the game as an ISO.**
   Only the **USA release, `SLUS-20387`** is supported. The editor verifies this
   on open and refuses anything else. This project does **not** include the game —
   dump your own disc.
2. **Python 3.8 or newer.** That's the only dependency; the app uses the Python
   standard library only (no `pip install` step).
   - macOS ships with Python 3.
   - Windows: install from <https://www.python.org/downloads/> and tick
     **“Add Python to PATH”** on the first installer screen.
3. A PS2 emulator such as **PCSX2** (or a soft-modded PS2) to actually play your
   edited ISO.

> **Always keep a clean backup of your original ISO.** The editor can make a
> `.bak` automatically before its first write (toggle in the header), but a
> separate untouched copy is the real safety net.

---

## Supported environments

Runs anywhere Python 3 and a modern browser exist:

- **macOS** (Apple Silicon or Intel)
- **Windows** 10 / 11
- **Linux**

The UI works in any current browser (Chrome, Edge, Firefox, Safari). Because a
4 GB ISO can't be uploaded through a browser, the server opens the file **by
path** on the local disk — so the machine running the editor must be able to see
the ISO file.

---

## Getting started

### Easiest — double-click a launcher

From the `Editor/` folder:

- **macOS:** double-click **`Start Editor (Mac).command`**
  (first time only: right-click → **Open**, or run
  `chmod +x "Start Editor (Mac).command"` once).
- **Windows:** double-click **`Start Editor (Windows).bat`**.

A browser tab opens automatically. Keep the little terminal window open while you
work; closing it (or `Ctrl+C`) stops the editor.

### From a terminal

```bash
cd Editor
python3 s3editor.py
```

Then open the printed URL (default **http://127.0.0.1:8747**).

Optional arguments, in any order:

```bash
python3 s3editor.py "/path/to/Suikoden III (USA).iso"   # preload an ISO
python3 s3editor.py 9000                                 # use a different port
python3 s3editor.py "/path/to/game.iso" 9000             # both
```

You can also just start it and **pick your ISO in the browser** — it scans nearby
folders for candidate `.iso` files, remembers the last one you opened, and offers
a one-click **“Reopen last ISO.”**

### Restarting after an update

The server serves the UI once at startup, so if the editor's code changes you need
to **stop and restart it** to pick up the new build:

```bash
pkill -f s3editor.py                                          # stop the running server
cd Editor
python3 s3editor.py "../ISO/Suikoden III (USA).iso" 8747      # start fresh
```

On start it prints the URL and **auto-opens a browser tab** at
**http://127.0.0.1:8747** (a background thread opens it, so a slow browser can't
block the server). Then just hard-refresh any tab you already had open.

The last-opened ISO is remembered in `Editor/.s3editor.json`. If you delete or move
that ISO, edit or remove the `lastIso` path there (or use **Change ISO** in the
header) so it doesn't try to reopen a missing file.

---

## How editing works (read this once)

- **Edits are staged, not written immediately.** As you change fields, they
  accumulate in memory. Nothing touches the ISO until you press **Save to ISO**
  in the top-right. **Revert** discards all unsaved changes.
- **Values are read live from the ISO** when you open it, so what you see always
  matches the file on disk.
- **Changed fields are highlighted** in amber, and each one gets a **↺ Restore to
  default** button that puts it back to the ISO's value.
- **Backup checkbox** (header): when on, one `.bak` copy is made before the first
  save of a session. Turn it off when you're re-editing an ISO you already backed
  up and don't want another copy.

> **Tip:** test edits on a *copy* of your ISO first (see `make_test_iso.sh`), then
> re-apply to a fresh copy once you're happy. On-screen spell/skill *description
> text* in-game is static and won't reflect changed numbers.

---

## Features

### Spells
- Full spell/rune-effect table, **grouped by rune** and ordered by element family
  (e.g. Fire → Rage → True Fire; Wind → Cyclone → True Wind).
- Edit **power**, **cast/movement time**, **element**, **target/size**, **AOE**
  (area vs single target), and **status effect** inflicted.
- In-game **descriptions** shown inline; live-updating **shape/target pill**.
- Filter/search box.

### Runes
- Pick a rune and edit **each of its spells individually**.
- **Bulk-apply** power / cast / element / AOE / status to *every* spell a rune
  grants at once.
- Attack-runes and unit-unique runes are labelled with their **owner** where known.

### Unites
- Co-op **unite attacks** table with the **characters involved** in each unite.
- Edit **power** (damage/multiplier), **cast time**, and **target**; descriptions
  shown inline.

### Gear
- Edit **DEF**, **price**, and up to **5 effect slots** per item.
- Effect types include **HP regen per turn (auto-heal)**, SPD/PWR/MDF bonuses,
  **grant skill** (pick the skill), status protect, elemental resist, and evade.
- In-game item descriptions shown per item.

### Shop
- Edit shop stock slots and the price ladder; item slots are name/description
  dropdowns.

### Characters
- **Section** selector for the different character data tables:
  1. **Starting Stats / Equipment** — starting skills + ranks, equipped runes
     (L/R hand, head), helmet/armor/shield, starting items.
  2. **Growth · Skill Max · Fixed Skills** — stat growth rates, rune levels,
     per-skill maximum caps, fixed/free skills, starting level.
  3. **Support Skills** — the character's support-skill slots.
  4. **Raw bytes** — fallback hex view.
- **Characters chosen by name** (dropdown), sourced from the original editor's
  name lists. Equipment/rune/skill fields are searchable dropdowns with
  descriptions.

### Hard Mode
- A **player-nerf difficulty** section with a master **Enable Hard Mode** toggle.
- Difficulty **presets** (Tougher / Hard / Brutal) plus fully custom per-stat
  multipliers, driven by each character's in-game **stat growth rate** so the whole
  party grows weaker across all 99 levels.
- Optional spell/unite **power** scalers. All multipliers scale the ISO's *default*
  value, so applying a preset is idempotent (never compounds), and **Restore all to
  default** cleanly reverts. Enemies can't be buffed directly (their stats aren't in
  an editable table), so difficulty comes from a weaker party.

### Enemies
- Read-only reference list of all **100 enemy entries** by index + name, searchable.
  (Enemy HP/attack are set by the battle engine, not a flat table, so they aren't
  editable — see Hard Mode for raising difficulty.)

### Reference
- Searchable **Item** and **Skill** hex-ID lists for looking up values.

### Quality-of-life
- Batched save with **Save / Revert**, unsaved-changes indicator.
- **Changed-from-default** highlighting + per-field restore.
- Optional automatic `.bak` before first write.
- Remembers and pre-fills your last-opened ISO.
- One-click launchers for macOS and Windows.

---

## Hard Mode in depth

Hard Mode makes the game harder by **weakening your own party**, not by buffing
enemies. Enemy HP/attack are computed by the battle engine and aren't stored in an
editable table (confirmed by reverse-engineering — see
`Editor/Suikoden3_ISO_offsets.md`), so the reliable lever is the party side.

**How it works.** Every playable character has a per-stat **growth rate** byte
(one each for HP, PWR/Attack, MAG/Magic, SKL, MDF, SPD, REP, LUK — values roughly
2–6). That rate controls how much the stat rises on each level-up. Hard Mode
multiplies those growth-rate bytes across the **whole 79-character roster** at once,
so the party gets weaker gradually over all 99 levels. It can also scale spell and
unite **power**.

**Using it (Hard Mode tab):**
1. Flip **Enable Hard Mode** (the controls stay disabled until you do).
2. Pick a **preset**, or choose **Custom** and set per-stat multipliers by hand.
3. Optionally set the **spell power** / **unite power** multipliers (leave at 1.00
   to nerf via growth rates only — see the note below).
4. Click **Apply to staged edits**, review the numbers, then **Save to ISO** in the
   header. Nothing is written until you Save.

**Presets** (multipliers applied to the ISO's default growth rate / power):

| Preset  | HP   | Attack/Magic | Speed | Spell & Unite power | Feel |
|---------|------|--------------|-------|---------------------|------|
| Tougher | ×0.80 | ×0.85       | ×0.95 | ×0.90               | Gentle nerf |
| Hard    | ×0.65 | ×0.70       | ×0.90 | ×0.75               | Fights need real thought |
| Brutal  | ×0.50 | ×0.55       | ×0.85 | ×0.60               | Every battle is a threat |

**Key behaviors:**
- **Idempotent.** Multipliers scale the ISO's *default* value, never the current one,
  so re-applying or switching presets won't compound. **Restore all to default**
  cleanly reverts every touched byte.
- **Gradual, not retroactive.** Lowering growth rates only affects levels gained
  *after* the change — it won't shrink a character who's already high-level. Best
  started on a fresh or early save.
- **Shared spell records.** A spell's power record is shared between party and enemy
  casts, so the *spell power* multiplier affects both. Leave it at 1.00 if you only
  want to weaken the party through growth rates.
- Review per-character results anytime in **Characters → Growth · Skill Max · Fixed
  Skills** before saving.

---

## Command-line patcher (advanced)

`Editor/s3patch.py` is the underlying engine and also a standalone CLI for
scripting and research. Examples:

```bash
cd Editor
python3 s3patch.py verify      "/path/to/game.iso"    # confirm it's the USA release
python3 s3patch.py spells      "/path/to/game.iso"    # list the spell table
python3 s3patch.py dump-spell  "/path/to/game.iso" --index 0
python3 s3patch.py reskin-rune "/path/to/game.iso" --rune fire --power 3000 --aoe on
python3 s3patch.py ids skill                          # print the skill ID list
```

Run `python3 s3patch.py -h` for the full command list (verify, dump-char,
dump-shop, set-shop, set-field, find-bytes, dump-region, spells, dump-spell,
set-spell, set-aoe, reskin, reskin-rune, ids).

### Safe test workflow

```bash
cd Editor
./make_test_iso.sh "/path/to/Suikoden III (USA).iso"
```

This clones your ISO to a `*.TEST.iso`, applies an example edit to the **copy**
only, and prints PCSX2 verification steps. Your original is never touched.

---

## Repository layout

| Path | What it is |
|---|---|
| `Editor/s3editor.py` | The web app (server + embedded UI) |
| `Editor/s3patch.py` | Core ISO logic + command-line patcher |
| `Editor/s3fields.py` | Character record field schemas |
| `Editor/s3_*.json` | Extracted names, descriptions, rune owners, unite casts |
| `Editor/Suikoden3_ISO_offsets.md` | Reverse-engineering notes / offset reference |
| `Editor/Start Editor (Mac).command` / `(Windows).bat` | Double-click launchers |
| `Editor/make_test_iso.sh` | Clone-and-test helper |
| `Editor/Suikoden3EditorV12b.exe`, `*_decompiled.cs` | Original Windows editor + decompile (reference only) |

---

## Credits & acknowledgements

This project stands on community research and would not exist without it.

- **[Suikosource](https://suikosource.com/)** and its community gameplay guides,
  used to identify characters, skills, and unite line-ups:
  - *Skills List* by **Blue Moon** — skill names and descriptions.
  - *Initial Equipment / Rune Slot List* by **wataru14 / genso710** — starting
    equipment, rune slots, and character data.
  - Unite-attack guides — the characters involved in each unite.
- **`Suikoden3EditorV12b.exe`** — the original Windows editor by its author, whose
  embedded name/label lists were the source for the character-name dropdowns and
  field mappings. Reverse-engineered here for reference and reimplemented
  cross-platform.
- Item descriptions and offset tables were extracted directly from the game's own
  data by this project's reverse-engineering (see `Editor/Suikoden3_ISO_offsets.md`).

If any attribution is missing or incorrect, please open an issue — credit is owed
and will be fixed.

## Legal

This tool contains **no game data or copyrighted game code**. You must supply your
own legally-obtained ISO of Suikoden III. Editing your own game files for personal
use only. Suikoden III is © Konami. All referenced guides and their text remain the
property of their respective authors and Suikosource.
