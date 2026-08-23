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
  Home Screen** and, after the first visit, it works fully offline.
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
  per-character recruitment (recruited toggle + "recruited by").
- **Party** — the active battle party (up to 6), by character name.
- **Recruit** — bulk recruitment: recruit / move / un-recruit everyone shown to a team, plus
  **canonical presets** ("Canonical → Hugo / Chris / Geddoe / Thomas / everyone") that assign
  each Star of Destiny to its story-correct recruiter.
- **Inventory** — every bag (Hugo / Chris / Geddoe / Thomas / Storage), split into Party Items
  vs Key/Valuables, with name-resolved item pickers, quantities, add and remove.

Quality-of-life: **searchable pickers** (type-to-filter, with id + name + in-game
description + category), a **review-changes** confirmation (an explicit old → new list before
anything is written), an **unsaved-changes guard**, and a one-tap **↻ Last opened** chip.
On desktop Chromium the app keeps a writable handle so **Apply & save to file** overwrites
the original in place; other browsers fall back to **Apply & download**. On Android it can
also **Apply & share…** the edited file straight to your file manager or emulator folder.

### ISO Editor (web)

Edit the disc image directly. This tab needs a **Chromium desktop browser**
(Chrome / Edge / Brave / Opera) for the File System Access API used to write in place — it's
blocked with an explanation on unsupported browsers. The editor only reads the ~3.75 MB
executable region of the disc, verifies it's a USA `SLUS-20387` image, and writes just the
changed bytes back in place (the multi-GB disc is never fully loaded or uploaded).

Views: **Characters** (starting stats, equipment, skills + ranks, plus an **experimental
disc-wide rename** of the main cast — Hugo / Chris / Geddoe — written everywhere on the disc
by the streaming save; same-length only, so it can't shift a single byte), **Growth**
(stat-growth rates, rune levels, fixed skills, skill-max caps), **Support**, **Weapons** (ATK
across all 16 sharpen levels), **Shops**, **Spells** (power / cast / element / target / AOE /
status, plus a **rune reskin** that edits every spell a rune grants at once and optional
description rewrites), **Unites** (with editable descriptions), **Gear** (DEF, price, 5 effect
slots), **Food** (effects **and** editable, length-capped descriptions), **Balance**
(idempotent hard-mode multiplier presets), **Enemies** (name reference), and **Reference**
(item/skill id → name lists).

**Share a mod without the disc.** Export a **mod recipe (`.s3mod`)** — a tiny JSON of the
exact byte changes (with original bytes, so it's reversible and **version-checked**; a recipe
for the wrong game/region is rejected). Recipes are built from your staged edits directly, so
you don't have to write the ISO first. Others import it to replay the edits on **their own**
clean disc.

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

- **Text editing** — an in-place editor for the boot-ELF strings (UI / battle / menu / prize /
  error text and character blurbs), each capped to its original length. (Story **dialogue**
  lives in packed event files outside the executable and is not editable.) The web ISO editor
  can only rename the main cast disc-wide (Hugo / Chris / Geddoe, same-length); this full
  string editor is desktop-only.
- **xdelta patches (`.xdelta`)** — a whole-ISO binary diff that captures *everything*,
  including in-place text edits. Needs a pristine ISO to create/apply; the wrong source is
  detected, not silently mis-patched (requires `xdelta3`: macOS `brew install xdelta`).
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
  s3editor.py   local web app (all tabs + JSON API)
  s3patch.py    ISO engine + CLI (verify / set / recipe / xdelta)
  s3save.py     save engine (card / .psu / .psv / gamedata / .sps / .xps / .cbs)
  s3fields.py   verified ISO field tables + schema
  s3_*.json / *_ids.txt   verified id→name / description reference data
web/            the browser editor (also deployed to GitHub Pages)
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
