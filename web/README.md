# Web save editor (prototype — Option B)

A **fully client-side** Suikoden III save editor that runs in any modern browser,
including Android. It reuses the real, unmodified `Editor/s3save.py` by running
CPython in the browser via [Pyodide](https://pyodide.org) (WebAssembly).

Your save file **never leaves the device** — there is no server-side upload. This
makes it a natural fit for editing saves on the phone where you already play via a
PS2 emulator (AetherSX2 / NetherSX2 / PCSX2).

## How it works

1. Pyodide boots CPython in the browser and fetches `../Editor/s3save.py`.
2. Your uploaded save is written into Pyodide's in-memory filesystem at `/save.bin`.
3. The page calls the existing path-based functions unchanged —
   `read_all_s3_saves()` to decode and `write_save_edits()` to apply edits (with
   correct gamedata checksum and, for memory cards, per-page ECC).
4. The edited container is read back out of the in-memory FS and downloaded as
   `<name>.edited.<ext>`.

Because it drives the real module, every container the desktop editor supports works
here too: `.ps2` / `.mcd` memory cards, `.psu`, `.psv`, `.cbs`, SharkPort `.xps`,
and raw `gamedata`. The edited container is byte-identical to what the desktop tool
produces (same checksum, same ECC).

## Files

- `index.html` — page shell.
- `style.css` — styling.
- `app.js` — Pyodide bootstrap, reference-table parsing, and the full editor UI.

Reference data pulled from `../Editor/`: `s3save.py`, `Suikoden3_item_ids.txt`,
`Suikoden3_skill_ids.txt`, `s3_names.json`.

## Running locally

Serve the **repository root** (so `../Editor/s3save.py` resolves), then open `/web/`:

```bash
python3 -m http.server 8791
```

Then browse to `http://localhost:8791/web/`.

## Deploying (e.g. GitHub Pages)

Served from the repo root, `web/index.html` fetches `../Editor/s3save.py`, so publishing
the repo as a Pages site works as-is. To ship `web/` as a standalone folder instead, copy
`Editor/s3save.py` next to `app.js` and change the fetch path in `app.js` to `s3save.py`.

## Scope — full parity with the desktop save editor

The web UI covers everything the desktop save editor does:

- **Overview** — names, gold, playtime, story phase, party leader, Suikoden I/II carryover.
- **Characters** — level / cur HP / max HP / EXP, the 8 stats, equipped runes + armour
  (category-filtered, name-resolved dropdowns), 8 skill slots (id + rank), and recruitment
  (recruited toggle + "recruited by").
- **Party** — the active battle party (up to 6), by character name.
- **Inventory** — every bag (Hugo / Chris / Geddoe / Thomas / Storage), split into Party
  Items vs Key/Valuables, with name-resolved item dropdowns, quantities, add and remove.
- **Multi-slot** memory cards show a slot switcher.

Item / skill / character names come from the same reference files the desktop server uses
(`Suikoden3_item_ids.txt`, `Suikoden3_skill_ids.txt`, `s3_names.json`), parsed with the same
rules. The reference files are fetched from `../Editor/` alongside `s3save.py`.

**ISO patching stays desktop-only** — it needs the multi-GB ISO and does not belong in a
browser tool.
