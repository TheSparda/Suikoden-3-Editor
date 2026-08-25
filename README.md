# Suikoden III ISO & Save Editor

A cross-platform editor for **Suikoden III** (PS2, USA `SLUS-20387`) that lets you rebalance
the game and edit your playthroughs. Two things:

- **ISO editing** — rebalance spells, runes, unite attacks, gear, weapons, foods, shops,
  enemies, and characters directly in the disc image. ISO edits apply to a **new game**.
- **Save editing** — open a PS2 **memory card** (or a standalone save export) and edit an
  existing playthrough: levels, HP, EXP, stats, skills, equipment, party, inventory, gold,
  recruitment, and names. **No ISO required.**

Nothing is ever uploaded — everything runs on your own device. The repo ships with **no
game data**; supply your own legally-obtained ISO and/or saves.

> ## 🌐 Use it online — no install
>
> ### **https://thesparda.github.io/Suikoden-3-Editor/web/**
>
> **This is the recommended way to use the editor for almost everyone.** It runs entirely
> in your browser, your files never leave your device, and it now covers everything the
> downloadable app does for day-to-day editing. There's nothing to install and it updates
> itself.

> **Feature requests / Support** on the **Toran Castle Discord**:
> https://discord.gg/KesHMX5P2Z

---

## The web editor (recommended)

Open **https://thesparda.github.io/Suikoden-3-Editor/web/** in any modern browser. The page
has two tabs — **Save Editor** and **ISO Editor** — and everything happens locally on your
device (the save engine runs the real Python module in your browser via Pyodide/WebAssembly;
nothing is uploaded).

- **Works on phones too.** The **Save Editor** works in any modern browser, including
  Android — handy for editing a memory card on the same device you emulate on
  (AetherSX2 / NetherSX2 / PCSX2).
- **Installable app / offline.** It's a PWA: use your browser's **Install app** / **Add to
  Home Screen** and, after the first visit, it works fully offline. It updates itself, and a
  footer **↻ Force refresh** button clears the cache and reloads the latest build if one ever
  gets stuck.
- **Your data stays put.** No server, no upload. Saves and ISOs are read and written on
  your device only.

### Save Editor (web)

Open a save with **Choose file…** or drag it in — no ISO needed. Supported containers:

| Format | Extension | Notes |
|---|---|---|
| PS2 memory card | `.ps2` / `.mcd` / `.mc2` / `.bin` | Full PS2MFS walk; multi-slot; per-page ECC recomputed |
| EMS export | `.psu` | Edited in place |
| PS3 virtual card | `.psv` | Edited in place |
| SharkPort / X-Port | `.sps` / `.xps` | Patched in place |
| CodeBreaker | `.cbs` | Decompressed, edited, re-encoded |
| Raw payload | `gamedata` | The bare save payload |

Multi-save memory cards show a **slot switcher**. Every write recomputes the save's
**checksum** (and card **ECC**) automatically, so the result is byte-compatible with the game.
Editable per save:

- **Overview** — names (Flame Champion, castle, Suikoden I/II hero & country), gold, playtime,
  story phase, party leader, and Suikoden I/II carryover detection.
- **Characters** — level, current/max HP, EXP, all 8 stats, equipped runes + armour
  (category-filtered, name-resolved pickers), 8 skill slots (id + **rank tier E…S**), and
  per-character recruitment (recruited toggle + "recruited by"). Fields carry the same
  **guide overlays** as the ISO editor: each stat shows its growth rate and expected Lv-99
  range, Max HP the HP row, Level the level that character joins at, each rune slot whether
  it's innate or **opens at Lv N**, and each skill slot that character's **maximum grade**
  (or a note that they can't learn it at all).
- **Party** — the active battle party (up to 6), by character name.
- **Recruit** — per-character recruitment: tick *recruited* and pick the pre-merge team
  (Hugo / Chris / Geddoe / Thomas / shared). Meant for **optional** recruits: **story
  characters that auto-join are faded and tagged ⚠**, since recruiting/un-recruiting them
  manually is unneeded and can soft-lock an early save (the story/optional split is derived
  from the character guide).
- **Inventory** — every bag (Hugo / Chris / Geddoe / Thomas / Storage), split into Party Items
  vs Key/Valuables, with name-resolved item pickers, quantities, add and remove.

Item and skill pickers throughout the save editor show **guide details** — rune effects and
food heals (which lack an in-game description record), plus per-rank skill effects. The
guide data has no entry for the support characters (they don't fight) or for a handful of
units the guides omit; those simply show no note rather than a guess.

Quality-of-life: **searchable pickers** (type-to-filter, with id + name + in-game
description + category), a **review-changes** confirmation (an explicit old → new list before
anything is written), an **unsaved-changes guard**, and a one-tap **↻ Last opened** chip.
On desktop Chromium the app keeps a writable handle so **Apply & save to file** overwrites
the original in place; other browsers fall back to **Apply & download**. On Android it can
also **Apply & share…** the edited file straight to your file manager or emulator folder.

### ISO Editor (web)

Edit the disc image directly. The editor only reads the ~3.75 MB executable region of the
disc, verifies it's a USA `SLUS-20387` image, and never fully loads or uploads the multi-GB
file. How edits are saved depends on the browser:

- **Chromium desktop** (Chrome / Edge / Brave / Opera) — writes just the changed bytes back
  **in place** via the File System Access API.
- **Other browsers** (Firefox / Safari / Android) — **stream a patched copy** to your
  downloads that you swap in, or **export a recipe / `.xdelta`** to apply elsewhere.

Views: **Characters** (starting stats, equipment — rune Head/Right/Left, skills + ranks),
**Growth** (stat-growth rates, fixed skills, and the 43-skill maximum-level caps with
one-click presets: *Set to guide caps*, *Max all*, *Clear*), **Support**, **Weapons** (ATK
across all 16 sharpen levels), **Shops**, **Spells** (power / cast / element / target / AOE /
status, plus a **rune reskin** — with quick presets like *Power 9999*, *Make AOE*, *Add
poison* — that edits every spell a rune grants at once, and optional description rewrites),
**Unites**, **Gear** (DEF, price, 5 effect slots), **Food**, **Text** (in-ELF UI strings —
battle messages, menu labels, prize/error prompts and character blurbs, each capped to its
original byte length), **Balance** (idempotent hard-mode multiplier presets), **Enemies** (a
read-only **bestiary**: Lv, HP, item/food drops, potch and SP per encounter), and
**Reference** (item/skill id → name lists).

> **Text scope.** Story **dialogue** is *not* editable in either editor — it lives in packed
> event files outside the executable. The Text tab covers the strings held in the boot ELF.

**Guide overlays.** Fields show verified reference data inline: per-character skill caps and
Lv-99 growth ranges in Growth, "rune slot opens at Lv N" on the equipment slots, rune/food
effect descriptions in the item pickers, and full per-rank skill effects. All of it is
cross-checked against the Suikosource guides (and the fields were re-verified against a real
disc — see `Editor/Suikoden3_ISO_offsets.md`).

**Undo/redo.** Every edit is undoable (toolbar ↶/↷ or Ctrl/Cmd+Z / Shift+Z), on top of the
existing per-field **↺** restore and **Revert all**.

**Share a mod without the disc.** Two export formats, both built from your staged edits (no
need to write the ISO first):

- **Mod recipe (`.s3mod`)** — a tiny, reversible, **version-checked** JSON of the exact byte
  changes (a recipe for the wrong game/region is rejected). Import it to replay the edits on a
  clean disc. This is the safe, source-verified option.
- **`.xdelta` patch** — a standard VCDIFF patch synthesized directly from the edits (no 4 GB
  diff needed). Apply with any VCDIFF tool: `xdelta3 -d -s "<pristine ISO>" file.xdelta out.iso`.
  ⚠ It carries **no integrity checksum**, so apply it only to a pristine USA `SLUS-20387` disc.

**Apply someone else's mod — `Apply patch…`.** The same button takes both an `.s3mod` recipe
and a standard **`.xdelta` (VCDIFF)** patch (the format is detected from the file's contents,
not its name), so you can install a community mod on a phone without a desktop. The patch is
**staged like any other edit** — reviewable, undoable, revertible — rather than written
straight to the disc, and the multi-GB image is never fully read: only the regions the patch
actually touches are examined. If the patch carries xdelta3's checksum (they normally do),
applying it to the wrong or already-modified disc is **detected and refused**.

Two limits, both reported clearly rather than guessed around:

- xdelta3 **compresses patches with LZMA by default**, which this editor can't read. Ask the
  author for one built with `xdelta3 -e -S none -s <source> <target> <patch>`.
- A patch that changes bytes **outside the editable region** is refused whole (a half-applied
  mod is worse than none) — use `xdelta3 -d` on a desktop for those.

---

## Offline / desktop app (advanced & developers)

The repo also ships a self-contained Python app that runs the same engine locally. Most
people don't need it — reach for it if you want to **script edits from the CLI**, produce
**whole-ISO `xdelta` patches**, edit the disc's **in-ROM text strings**, or work fully offline
from source.

### Run

- **macOS:** double-click `Start Editor (Mac).command`
- **Windows:** double-click `Start Editor (Windows).bat`
- **Any:** `cd Editor && python3 s3editor.py`

Requires Python 3.8+ (standard library only — no `pip install`). The app opens your browser
at `http://127.0.0.1:8747/`. Open your ISO or save with a native file picker, or drop it near
the app and pick it from the scan list. Edits stage in memory and highlight amber; click
**Save** to write them (a `.bak` is made first, a toggle that's on by default). Every field
has a **↺** restore and there's a light/dark theme toggle.

### What the desktop app adds over the web editor

- **Full-diff xdelta patches, and applying them** — a whole-ISO binary diff that captures
  *everything*, including in-place text edits, **plus** applying any `.xdelta` back onto a
  pristine disc. These carry a checksum (wrong source is detected, not silently mis-patched)
  and require `xdelta3` (macOS `brew install xdelta`). The web editor can now *apply* a patch
  as well, but only one whose changes fall inside its editable region and that isn't
  LZMA-compressed; only the desktop app diffs the **whole** disc and applies any patch to it.
- **CLI** — `Editor/s3patch.py` exposes the same engine for scripting:

  ```bash
  cd Editor
  python3 s3patch.py verify   "/path/to/Suikoden III (USA).iso"
  python3 s3patch.py set-field "…" --list 1 --index 2 --off 9 --u8 5
  python3 s3patch.py mod-export "…" --note "my rebalance"      # -> <iso>.s3mod
  python3 s3patch.py mod-apply  "…" --recipe mod.s3mod
  python3 s3patch.py xdelta-make "…" --pristine clean.iso --out mod.xdelta
  ```

  `Editor/s3save.py <memcard.ps2>` dumps the decoded saves on a card.

### Layout

```
Editor/
  s3editor.py         local web app (all tabs + JSON API)
  s3patch.py          ISO engine + CLI (verify / set / recipe / xdelta)
  s3save.py           save engine (card / .psu / .psv / gamedata / .sps / .xps / .cbs)
  s3fields.py         verified ISO field tables + schema
  build_*.py          regenerate the guide reference data (skills, caps, growth, rune slots,
                      bestiary, recruit story/optional flags, rune/food descriptions)
  suikosource/        saved Suikosource guide text the generators parse
  s3_*.json / *_ids.txt   verified id→name / description / guide reference data
web/            the browser editor (also deployed to GitHub Pages)
web/tests/      Node checks + a Playwright e2e suite (npm test / npm run test:e2e)
Start Editor (Mac).command / (Windows).bat   launchers
```

---

## Privacy & scope

The repository contains **no game ROM/ISO, saves, audio, or story assets** — only small
reverse-engineered reference tables (id→name maps, offsets) the editor needs to show
meaningful labels. That's interoperability data, not the game. Whichever editor you use,
nothing you open is uploaded anywhere.

## Support

Feature requests / Support available on the **Toran Castle Discord**:
https://discord.gg/KesHMX5P2Z
