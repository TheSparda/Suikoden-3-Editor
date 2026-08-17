# Suikoden III ISO & Save Editor

A cross-platform editor for **Suikoden III** (PS2, USA `SLUS-20387`). It runs as a local
web app in your browser and does two things:

- **ISO editing** — rebalance spells, runes, unite attacks, gear, weapons, foods, shops,
  enemies, characters, and in-game text directly in the disc image. ISO edits apply to a
  **new game**.
- **Save editing** — open a PS2 **memory card** (or a standalone save export) and edit an
  existing playthrough: levels, HP, EXP, stats, skills, equipment, party, inventory, gold,
  recruitment, and names. **No ISO required.**

Everything runs locally — nothing is uploaded, and the server only touches the file you
point it at. The repo ships with **no game data**; supply your own legally-obtained ISO
and/or saves. Writes are guarded by an optional `.bak` backup (a header toggle, on by
default).

## Run

- **macOS:** double-click `Start Editor (Mac).command`
- **Windows:** double-click `Start Editor (Windows).bat`
- **Any:** `cd Editor && python3 s3editor.py`

Requires Python 3.8+ (standard library only — no `pip install`). The app opens your
browser at `http://127.0.0.1:8747/`. Open your ISO with **Browse… / Open** (a native file
picker), or drop it near the app and pick it from the scan list.

> Edits stage in memory and highlight amber; click **Save** to write them to disk (a
> `.bak` is made first). Every field has a **↺** restore, and there's a light/dark theme
> toggle. The nav bar groups the less-used tabs under **Other ▾**.

---

## ISO editing

### Characters
Edit any character by name (searchable dropdown, filters by name or id). A **Data section**
selector switches between the character tables:
- **Starting Stats / Equipment** — starting skills + **ranks (E–S tier dropdowns)**,
  equipped runes (L/R hand, head), helmet / armor / shield, and starting items. Equipment
  and rune fields are category-filtered dropdowns with in-game descriptions.
- **Growth / Skill Max / Fixed Skills** — per-stat growth rates, rune levels, **Skill
  Maximum Levels** (grade-tier dropdowns, with a **bulk "set all"** control to cap every
  skill at once), and the Fixed-Skill block (skill picker + the character level each is
  learned at).
- **Support Skills** — the character's support-skill slots.
- **Raw bytes** — fallback hex view.

### Spells
The full spell / rune-effect table, **grouped by rune** and ordered by element family
(Fire → Rage → True Fire, etc.). Edit **power**, **cast/movement time**, **element**,
**target/size**, **AOE** (area vs single), and inflicted **status effect**, with in-game
descriptions and a live target/shape pill.

### Runes
Pick a rune and edit **each of its spells individually**, or reskin the whole rune's
spell set at once.

### Unites
Every co-op unite attack (verified vs the Unites guide) — edit power, cast time, element,
target, and status.

### Gear
Weapons, armor, shields, and accessories: DEF, buy/sell price, and up to five effect slots
(stat bonuses, granted skills, elemental flags), each a typed dropdown. The in-game
description is shown for reference.

### Weapons
Each weapon type's ATK across all 16 sharpen levels, in a wrapping grid. A reference panel
maps weapon-growth classes to their characters.

### Foods
Consumable heal amounts and status-cure chances, with an opt-in **live description
preview** that rewrites the item's in-game text to match your edited values (length-capped).

### Hard Mode
Scale enemy/growth power with idempotent, fully-restorable multiplier presets.

### Shop
Shop stock slots and the price ladder, by item name.

### Enemies
Reference list of enemy names + indices (S3 has no flat editable enemy-stat table).

### Text
In-place editor for the boot-ELF strings (UI / battle / menu / prize / error text and
character blurbs), each capped to its original length. Story **dialogue** lives in packed
event files outside the executable and is **not** editable here.

### Reference
Clean id → name lists (items, skills) for lookup.

---

## Save editing

Open a save by **file picker** or folder scan — no ISO needed. Supported containers:

| Format | Extension | Notes |
|---|---|---|
| PS2 memory card | `.ps2` / `.mcd` / `.mc2` / `.bin` | Full PS2MFS walk; per-page ECC recomputed |
| EMS export | `.psu` | In-place |
| Raw payload | `gamedata` | The bare 53264-byte save |
| SharkPort / X-Port | `.sps` / `.xps` | Patched in place |
| CodeBreaker | `.cbs` | Decompressed, edited, re-encoded (RC4+zlib) |

Every write recomputes the save's **checksum** (and card ECC) automatically, and keeps a
`.bak`. Editable per save:
- **Per character:** level, current/max HP, EXP, all 8 stats, equipped runes + gear, and
  skill slots with **rank tier dropdowns** (— / E … S).
- **Whole save:** gold, castle name, active party, and recruitment (with "recruited by").
- **Inventory:** item slots + quantities, via item-name dropdowns.

---

## Share / Patch

Share your edits as a small file so others can apply them to **their own** clean ISO —
without passing around the multi-GB disc. Under **Other → Share / Patch**:

- **Mod recipe (`.s3mod`)** — a tiny JSON of the exact byte changes (with original bytes,
  so it's reversible and **version-checked**; a recipe for the wrong game/region is
  rejected). It's built from your **staged edits directly** — you do **not** have to write
  the ISO first. Export, then share the file. Applying replays it in place (with a `.bak`)
  and warns on any byte that doesn't match the author's original.
- **xdelta patch (`.xdelta`)** — a whole-ISO binary diff that captures *everything*,
  including in-place text edits. Needs a pristine ISO to create/apply; the wrong source is
  detected, not silently mis-patched (requires `xdelta3`: macOS `brew install xdelta`).

---

## CLI

`Editor/s3patch.py` exposes the same engine for scripting:

```bash
cd Editor
python3 s3patch.py verify   "/path/to/Suikoden III (USA).iso"
python3 s3patch.py set-field "…" --list 1 --index 2 --off 9 --u8 5
python3 s3patch.py mod-export "…" --note "my rebalance"      # -> <iso>.s3mod
python3 s3patch.py mod-apply  "…" --recipe mod.s3mod
python3 s3patch.py xdelta-make "…" --pristine clean.iso --out mod.xdelta
```

`Editor/s3save.py <memcard.ps2>` dumps the decoded saves on a card.

## Layout

```
Editor/
  s3editor.py   local web app (all tabs + JSON API)
  s3patch.py    ISO engine + CLI (verify / set / recipe / xdelta)
  s3save.py     save engine (card / .psu / gamedata / .sps / .xps / .cbs)
  s3fields.py   verified ISO field tables + schema
  s3_*.json / *_ids.txt   verified id→name / description reference data
Start Editor (Mac).command / (Windows).bat   launchers
```

## Privacy & scope

The repository contains **no game ROM/ISO, saves, audio, or story assets** — only small
reverse-engineered reference tables (id→name maps, offsets) the editor needs to show
meaningful labels. That's interoperability data, not the game.
