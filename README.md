# Suikoden III ISO & Save Editor

A browser-based editor for **Suikoden III** (PS2, USA `SLUS-20387`). It does two jobs:

- **ISO editing** — rebalance spells, runes, unite attacks, gear, weapons, foods, shops,
  enemies, war units and characters directly in the disc image. ISO edits apply to a
  **new game**.
- **Save editing** — open a PS2 **memory card** (or a standalone save export) and edit an
  existing playthrough: levels, HP, EXP, stats, skills, equipment, party, inventory, gold,
  recruitment and names. **No ISO required.**

Nothing is uploaded — everything runs on your own device. The repo ships with **no game
data**; supply your own legally-obtained ISO and/or saves.

> ## 🌐 Open it — nothing to install
>
> ### **https://thesparda.github.io/Suikoden-3-Editor/web/**

> **Feature requests / Support** on the **Toran Castle Discord**:
> https://discord.gg/KesHMX5P2Z

---

## The editor

Open **https://thesparda.github.io/Suikoden-3-Editor/web/** in any modern browser. The page
has two tabs — **Save Editor** and **ISO Editor** — and everything happens locally on your
device. The save engine is the project's real Python module running in your browser through
Pyodide/WebAssembly, so the browser and the reference implementation are the same code rather
than two ports that can drift.

- **Works on phones.** The **Save Editor** runs in any modern browser, including Android —
  handy for editing a memory card on the same device you emulate on (AetherSX2 / NetherSX2 /
  PCSX2).
- **Installable / offline.** It's a PWA: use your browser's **Install app** / **Add to Home
  Screen** and, after the first visit, it works fully offline. It updates itself, and a footer
  **↻ Force refresh** button clears the cache and reloads the latest build if one ever gets
  stuck.
- **Your data stays put.** No server, no upload. Saves and ISOs are read and written on your
  device only.

### Save Editor

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

- **Overview** — names (Flame Champion, castle, Suikoden I/II hero & country), gold, chapter,
  playtime, story phase, party leader, and Suikoden I/II carryover detection — plus a
  **JSON snapshot** (⬇ Export / ⬆ Import) of the whole save: a human-readable file you can
  edit or share and re-import, which stages the differences through the normal review-and-Apply
  path rather than writing anything directly.
- **Characters** — level, weapon (sharpen) level, current/max HP, EXP, all 7 stats, equipped runes + armour
  (category-filtered, name-resolved pickers), 8 skill slots (id + **rank tier E…S**), and
  per-character recruitment (recruited toggle + "recruited by"). Fields carry the same
  **guide overlays** as the ISO editor: each stat shows its growth rate and expected Lv-99
  range, Max HP the HP row, Level the level that character joins at, each rune slot whether
  it's innate or **opens at Lv N**, and each skill slot that character's **maximum grade**
  (or a note that they can't learn it at all).
- **Recruit** — per-character recruitment: tick *recruited* and pick the pre-merge team
  (Hugo / Chris / Geddoe / Thomas / shared). Meant for **optional** recruits: **story
  characters that auto-join are faded and tagged ⚠**, since recruiting/un-recruiting them
  manually is unneeded and can soft-lock an early save (the story/optional split is derived
  from the character guide).
- **108 Stars** — a completion dashboard over the Stars of Destiny: how many you have, the
  Hugo / Chris / Geddoe / Thomas / shared spread, filters (recruited vs missing, optional vs
  story), the guide's how-to line under each missing **optional** star, and a **＋ recruit**
  button that stages it without leaving the list. It reflects staged edits live, so it doubles
  as a worklist for a completion run.
- **Party** — the active battle party (up to 6), by character name.
- **Inventory** — every bag, split into Party Items vs Key/Valuables, with name-resolved
  item pickers, quantities, add and remove. The bag layout follows the save: before the
  parties merge each of Hugo / Chris / Geddoe / Thomas has their own bag *and* their own
  storage; afterwards it's one shared party bag plus one shared 210-slot storage. Runes,
  armour and key items are **one per slot** (the game holds three Fury Runes as three
  slots, not one slot with a count of 3), so only stackables show a quantity, and new
  items are appended after a bag's last entry rather than dropped into a gap.

- **Health** — a lint over the save. It reads the file **plus your pending edits** and reports
  the states the game never writes itself, split into *problems* (an unrecruited character
  sitting in the active party; current HP above max HP), *warnings* (a rune carrying a stack
  count — the shape that used to make spare copies vanish; a value the engine will clamp on
  write, quoting what will actually land; the same skill in two slots; gear in a slot that
  doesn't take it; items sitting after a gap in a bag) and *notes* (a party leader who isn't
  in the party, a skill above the guide's cap for that character). Most findings carry a
  one-click **Fix** — and a Fix only *stages* its change like any other edit, so it still
  goes through **Review changes** before a byte is written. The tab badges the problem count,
  and the decode-time layout checks are folded in so it's the one place to look.

Item and skill pickers throughout the save editor show **guide details** — rune effects and
food heals (which lack an in-game description record), plus per-rank skill effects. The
guide data has no entry for the support characters (they don't fight) or for a handful of
units the guides omit; those simply show no note rather than a guess.

Quality-of-life: **searchable pickers** (type-to-filter, with id + name + in-game
description + category), a **review-changes** confirmation (an explicit old → new list before
anything is written), an **unsaved-changes guard**, a one-tap **↻ Last opened** chip, and two
themes (*Crimson & Gold*, *Parchment*).
On desktop Chromium the app keeps a writable handle so **Apply & save to file** overwrites
the original in place; other browsers fall back to **Apply & download**. On Android it can
also **Apply & share…** the edited file straight to your file manager or emulator folder.

Every save is **cross-checked against invariants a correct layout can't violate** as it
decodes (including the level it reads against the level the save's own PS2 browser title
reports). A save that doesn't decode cleanly says so loudly before you edit it; benign
discrepancies with a known explanation get a quiet note instead, so the loud warning keeps
its meaning.

### ISO Editor

Edit the disc image directly. The editor only reads the ~3.75 MB executable region of the
disc, verifies it's a USA `SLUS-20387` image, and never fully loads or uploads the multi-GB
file. How edits are saved depends on the browser:

- **Chromium desktop** (Chrome / Edge / Brave / Opera) — writes just the changed bytes back
  **in place** via the File System Access API.
- **Other browsers** (Firefox / Safari / Android) — **stream a patched copy** to your
  downloads that you swap in, or **export a recipe / `.xdelta`** to apply elsewhere.

Views: **Characters** (starting stats, equipment — rune Head/Right/Left, skills + ranks, and
an experimental **disc-wide rename** for the playable cast — the new name replaces the old
everywhere on the disc, menus, battle and dialogue alike, so it's same-length only and needs
the streaming *save patched copy* path, which the in-place write can't reach),
**Growth** (stat-growth rates, fixed skills, and the 43-skill maximum-level caps with
one-click presets: *Set to guide caps*, *Max all*, *Clear*), **Support**, **Weapons** (ATK
across all 16 sharpen levels), **Shops**, **Spells** (power / cast / element / target / AOE /
status, plus a **rune reskin** — with quick presets like *Power 9999*, *Make AOE*, *Add
poison* — that edits every spell a rune grants at once, and optional description rewrites),
**Unites**, **Mounts** (**beta — testing only**: both of the game's mount systems — the
per-character **assigned horse** that puts the six Zexen Knights on horseback in the field *and*
in battle, and the hard-coded **three-pair** battle table, stock *Hugo+Fubar / Futch+Bright /
Franz+Ruby* — plus the **pair mechanics**, including the HP pooling that re-splits a pair's HP
proportionally the moment they mount; byte-verified but not yet confirmed in-game; see below),
**Gear** (DEF, price, 5 effect slots), **Sets** (armor-set composition, the
set-bonus constants patched straight into the game code — potch multiplier, counter chance,
heal share — and **which set grants which effect**, since each bonus is a hard-coded check on
the set number that can be pointed at a different set), **Food**, **Text** (in-ELF UI strings —
battle messages, menu labels, prize/error prompts and character blurbs, each capped to its
original byte length), **Balance** (idempotent hard-mode multiplier presets), **Encounter**
(a global **random-encounter rate** as a plain percentage — see below), **Enemies** (the full
per-area enemy editor — stats, rewards, drops, bulk multipliers, and each zone's spawns &
formations; see below), **War** (every war/major-battle unit on the disc; see below) and
**Reference** — the read-only half, with sub-tabs for item and skill id → name lists, **Item
sources** (where each item comes from), **Mounts** (the decoded mount system — rider and mount
capability, which areas bundle a mount, and the mechanics that can't be exposed as fields) and
**Files** (a browser over the disc's **4,403 packed
sub-files** — every archive's contents by offset, size and kind, with a *Peek* hex dump; see
below).

> **Text scope.** Story **dialogue** is *not* editable in either editor — it lives in packed
> event files outside the executable. The Text tab covers the strings held in the boot ELF.

**Random encounter rate — the Encounter tab.** One number controls how often random battles
trigger across the whole game, as a percentage of the stock rate:

| Rate | Effect |
|---|---|
| **0** | no random encounters at all |
| **25 / 50** | a quarter / half as often |
| **100** | unchanged (the disc's own rate) |
| **200 / 300** | twice / three times as often |

Presets (*None · Quarter · Half · Stock · Double · Triple*) sit next to a free-form box that
takes anything from 0 to 1000. It's a single global multiplier, so **each area keeps its own
character** — a quiet field stays quieter than a dungeon, everything just shifts together.

Useful for a replay where you already know the story and don't want to be stopped every ten
steps, for grinding runs in the other direction, or — at 0 — for walking a dungeon to map it
without fighting. Like every other edit it's *staged*: undoable, revertible, and carried into
a `.s3mod` recipe or `.xdelta` patch. Setting it back to **100** restores the original bytes
exactly, so a round trip leaves nothing pending rather than re-writing a "default".

<details>
<summary>How it works, and what it can't do</summary>

Suikoden III has no encounter-rate table to edit. Every field encounter is one roll inside the
executable — roughly *rate = area\_rate × multiplier ÷ 100*, sampled as you move, then
`rand(100) < rate`. The editor rewrites the multiplier, so the tab patches game **code**, not
data (four instruction words; see `Editor/Suikoden3_ISO_offsets.md` for the full
reverse-engineering write-up).

There are three separate multipliers, one per movement mode — walking, running, and riding —
and the riding path originally had no multiplier at all, taking an implicit ×1.00. It gets one
grafted in and pointed at the shared divide, which is why 100% still behaves exactly like the
unmodified game: it computes ×100÷100.

**Per-area base rates — editable too.** Under the global slider the tab lists **every area on
the disc** with its own per-map rate: **23 areas, 133 chapter-variant tables, 1,612 map
records**. Towns and interiors read **0** (no random battles); field and dungeon maps read
**2–9** — Karaya 9, Brass Castle and the Great Hollow 6, Budehuc 5, Kuput Forest 4, Amur
Plains 3, the mountain path 2. Each area gets *None / Half / Stock / Double* presets that
scale from the disc's own numbers (so re-applying never compounds and **Stock** is a
byte-exact restore), plus a row per map for the rate and the post-battle **grace distance**.
Where an area's chapter tables agree, one row writes all of them; where they disagree the map
is split into a row each rather than showing one value that would be wrong for the others.

> Lowering is always safe. **Raising a rate from 0 is not** — a map the game never fights on
> has no monster party loaded, so rows at 0 are tagged and zone-less archives are flagged.

Getting here meant cracking **`DATA/FSECT.BIN`**, which turns out to be the disc's sub-file
directory rather than the relocation table it was long taken for, and decoding the 60-byte
room record it leads to (the rate is its `+0x04` halfword, traced by disassembly all the way
into the encounter roll). `Editor/build_room_index.py` rebuilds the index from a pristine
disc; the full trail is in `Editor/Suikoden3_ISO_offsets.md`.

</details>

**Enemies — the per-area enemy editor.** Suikoden III keeps no global monster table: every
area's battle pack carries its own copies of each enemy, so the *same* Blade Bunny is a
different record — different level, HP, rewards, drops — in every region it appears in. The
Enemies tab decodes all of it, straight from the disc (**81 packs, ~1,960 encounter
variants**, indexed by `Editor/build_enemy_index.py` and cross-checked against the
Suikosource bestiary at 97%+ on potch/SP), and lets you edit per variant:

- **Level** and **HP**, the **8 combat stats** (PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK — monsters
  are character records in this engine, same stat order),
- **rewards**: EXP value, SP and potch,
- the **5-slot drop table** — item (full item picker) and weight out of 1000 (128 ≈ 12.8%),
  so a rare rune can become a guaranteed drop or vice versa.

**Bulk tuning** sits at the top of the tab: multipliers for HP / stats / level / EXP / SP /
potch / drop weights, applied to every variant (or only the packs matching the filter box —
type `LAST` to buff just the final dungeon). Every value recomputes from the disc's original
numbers, so Apply is idempotent: running it twice changes nothing, and ×3 after ×2 gives ×3
of the original, not ×6. Fields left at ×1 aren't touched, and a Reset button returns the
scope to the disc's own values.

**Spawn zones & formations** turn the same tab into an encounter designer. Each map zone
(shown under the game's own names — `mori_101`, `icew_105` …) has **spawn slots** (which
monster occupies the slot, and *which stat variant* of it) and **formations** — the actual
encounter groups, each with a relative weight and one member pick per slot. Swap a slot's
monster and every formation using it spawns the new one; raise a formation's weight and that
group shows up more often. The slot picker is restricted to the pack's own roster on purpose:
monsters from other packs would spawn without their models loaded and crash the game.

<details>
<summary>How it works, and the fine print</summary>

Enemy data lives duplicated across the disc — each area pack exists as several **streaming
copies** (and separate chapter variants with genuinely different stats). Every edit is
written through to *every byte-verified copy* automatically, and the save review says so
("Potch: 33000 → 44444 (×4 copies)"). Bulk edits are summarized as a byte count instead of
thousands of rows. A pack whose offsets can't be verified ships read-only rather than wrong
— the same correct-or-absent rule as the rest of the editor. Formation sizes can shrink but
not grow past the group's original size (fixed allocation on disc). The full
reverse-engineering trail — record layout, reward blocks, zone objects, the multi-pass copy
indexer — is in `Editor/Suikoden3_ISO_offsets.md`.

</details>

**Files — the sub-file browser** (a *Reference* sub-tab, alongside Items, Skills and Item
sources). `DATA/FSECT.BIN` is the disc's archive directory (one u32 per sub-file: sector
relative to the archive, plus size, both in 2048-byte sectors), so the whole packed layout is
enumerable: **4,403 sub-files across 28 archives**. The browser lists
them per archive with each one's ISO offset, size and what it turned out to be — **battle**
packs (monster records, spawn slots and formations, tagged with the game's own map id like
`mori_101`), **town** data (which holds the room table the Encounter tab edits), **map**
geometry, and **data** for the ~1,400 still unidentified. **Peek** reads the first 256 bytes
straight off your disc as a hex dump. Town entries also carry a **pickup census** — the
chests, lootable corpses and herb spots on that map, counted from the game's own object names
(`takara` 宝, `emono` 獲物, `herb_*`) and cross-checked against the walkthrough. What a pickup
*contains* is not decoded, so nothing here edits loot; see the offsets doc for why the
obvious candidate field turned out to be script operands. It is deliberately **read-only**: everything editable
inside these files has its own tab, and a raw byte editor over thousands of unknown blobs
would be a footgun rather than a feature. Rebuild the index from a pristine disc with
`Editor/build_subfile_index.py`.

**War battles — the War tab.** Every war/major-battle combatant on the disc is editable:
Zexen Knights & Infantry, Karaya/Lizard/Duck Fighters, Mantor Legionnaires, Harmonian
Soldiers, the chapter-5 war monsters, and the enemy **leader units** (Leo, Sarah, Franz and
Ruby, identified exactly against the Suikosource guide) — **level, HP and all 8 combat
stats** per unit. Units are grouped per region archive, so the same soldier type can be
tuned battle-by-battle (make the Brass Castle defense brutal but leave Chisha winnable).
Your *own* army units draw their strength from the characters' save-file stats, so they're
edited in the Save Editor instead; the RPGClassics army-skill list (Riding / Tactics /
Valor / Control and rune skills per character) ships as a read-only reference, since war
skills are embedded in code rather than data. War-unit edits ride the same machinery as
everything else: staged, undoable, written to every copy, and exportable in a recipe.

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
  mod is worse than none) — use `xdelta3 -d` for those.

---

## Repo layout

`web/` is the editor. There is no second one — a self-contained Python desktop app
(`Editor/s3editor.py`) was retired in v1.48.0 once the web editor covered everything it did,
because keeping two implementations of the same ISO tables in step cost more than it caught.
What it uniquely offered is covered:

- **`.s3mod` recipes and `.xdelta` patches** — the web editor exports *and* applies both,
  natively (`web/vcdiff.js` is a full VCDIFF encoder/decoder; no `xdelta3` needed).
- **Diffing two arbitrary discs** — the one thing the web editor can't do, since it only knows
  about edits made in it. That's one shell command:

  ```bash
  xdelta3 -e -S none -s clean.iso modded.iso out.xdelta
  ```

  `-S none` matters: the web editor reads any VCDIFF patch except a secondary-compressed one.

```
web/                the editor (also deployed to GitHub Pages)
web/tests/          Node checks + a Playwright e2e suite (npm test / npm run test:e2e)

Editor/
  s3save.py         the save engine. NOT legacy — web/app.js fetches it and runs it under
                    Pyodide, so this file *is* the save editor. Also runs standalone:
                    `python3 Editor/s3save.py <memcard.ps2>` dumps a card's saves.
  s3patch.py        ISO reader library + verified field tables. Its one consumer is
                    build_item_desc_extra.py; it is not a second editor.
  build_*.py        regenerate the guide reference data (skills, caps, growth, rune slots,
                    bestiary, recruit flags, rune/food descriptions, room and sub-file
                    indexes) from a pristine disc + the saved guide text
  suikosource/      saved Suikosource guide text the generators parse
  s3_*.json / *_ids.txt    verified id->name / description / guide reference data
  Suikoden3_ISO_offsets.md the reverse-engineering notebook — the source of truth for offsets

tools/pcsx2/        PCSX2 automation: boot a patched ISO and read the tables back out of the
                    running game, plus RAM snapshot/diff tooling for research
docs/               research write-ups (see below)
```

### Verifying a change against the real game — `tools/pcsx2/`

The test suite proves the editor writes the bytes it means to. It cannot prove the *game*
reads them the way we think. `tools/pcsx2/` closes that gap by driving PCSX2 over its PINE
socket (stdlib only, nothing to install):

```bash
python3 -m tools.pcsx2.cli doctor
```

`boot-verify` boots an edited disc and reads the tables back out of EE RAM — the one check no
synthetic fixture can make. `snapshot` / `diff` / `scan` are the RAM research tooling behind
new offset work: snapshot memory around a known in-game action, diff the states, and narrow
to the bytes that moved. `read` / `poke` / `codes` / `states` round it out. Full guide in
[`docs/PCSX2_AUTOMATION.md`](docs/PCSX2_AUTOMATION.md).

`python3 tools/pcsx2/selftest.py` covers everything under the emulator — PINE framing,
savestate parsing, scan narrowing, ELF calibration, PNG hashing — and runs in CI, where no
disc or BIOS exists.

### Research notes

The offsets notebook ([`Editor/Suikoden3_ISO_offsets.md`](Editor/Suikoden3_ISO_offsets.md))
is the primary record. Longer investigations get their own doc:

| | |
|---|---|
| [`MOUNT_SYSTEM_RESEARCH.md`](docs/MOUNT_SYSTEM_RESEARCH.md) | both mount systems, the pair HP-pooling mechanics |
| [`ENEMIES_IN_PLAYER_PARTY_RESEARCH.md`](docs/ENEMIES_IN_PLAYER_PARTY_RESEARCH.md) | why enemies can't join the party; the three disjoint id spaces |
| [`ETC_BIN_MODEL_RESEARCH.md`](docs/ETC_BIN_MODEL_RESEARCH.md) | character model swapping — decoded, and why it stays infeasible |
| [`RECRUITMENT_RANDOMIZER_RESEARCH.md`](docs/RECRUITMENT_RANDOMIZER_RESEARCH.md) | recruitment-randomizer groundwork |
| [`PCSX2_AUTOMATION.md`](docs/PCSX2_AUTOMATION.md) | driving the emulator for verification and RAM research |

Several document things that turned out **not** to work. Those are kept deliberately — a
recorded dead end is worth more than a question re-opened every few months.

### Tests

```bash
cd web/tests && npm test          # Node checks: offsets, reference data, save round-trips, VCDIFF
npm run test:e2e                  # Playwright against a synthetic ISO fixture
python3 tools/pcsx2/selftest.py   # PCSX2 harness, no emulator required
```

Contributor conventions are in [`CLAUDE.md`](CLAUDE.md).

---

## Privacy & scope

The repository contains **no game ROM/ISO, saves, audio, or story assets** — only small
reverse-engineered reference tables (id→name maps, offsets) the editor needs to show
meaningful labels. That's interoperability data, not the game. The editor runs entirely in
your browser — nothing you open is uploaded anywhere.

## Support

Feature requests / Support available on the **Toran Castle Discord**:
https://discord.gg/KesHMX5P2Z
