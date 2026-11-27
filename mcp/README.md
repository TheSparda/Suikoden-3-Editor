# Suikoden III Editor MCP server

A local Model Context Protocol (MCP) server that lets an AI tool (Claude Code,
Claude Desktop, or any MCP client) do what the web editor does: inspect and edit
a Suikoden III (USA) disc image and Suikoden III saves, with the same staged
review model, the same validation, and the same disabled features.

## Architecture

Node.js, zero dependencies, stdio transport. The server holds no editing logic
of its own; it is a tool surface over the editor's canonical cores:

- **ISO side (Node):** table and patch constants are sliced out of `web/iso.js`
  at startup, the same technique the repo's own Node tests use
  (`web/tests/mp-charges-real-iso.mjs` slices `MPCAST_T1` out of the shipped
  file rather than re-typing it). The change list runs the repo's
  `web/changes-core.js` and the .xdelta export runs `web/vcdiff.js`, both loaded
  the way `web/tests/` loads them. Nothing about the disc format is
  reimplemented here, so offsets cannot drift from the shipped editor.
- **Save side (Python bridge):** `mcp/save_bridge.py` translates JSON requests
  into calls on `Editor/s3save.py`, the exact module the web save editor runs
  under Pyodide. All decoding, clamping, checksum and memory-card ECC work is
  s3save's.

Why Node as the host: two of the three cores are JavaScript and load in-process
with no glue, and the third (s3save) is one small stateless bridge process per
operation. A Python host would have inverted that, needing a Node bridge for
the larger side.

## Install and run

Requirements: Node 18 or newer, Python 3 (for the save bridge), and a checkout
of this repository. There is nothing to install: no npm dependencies.

```sh
node /path/to/Suikoden-3-Editor/mcp/server.mjs
```

The server speaks MCP over stdin/stdout; run it through your AI tool, not by
hand.

## Register it in an AI tool

Claude Code:

```sh
claude mcp add suikoden-3-editor -- node /path/to/Suikoden-3-Editor/mcp/server.mjs
```

Claude Desktop (or any client that takes an `mcpServers` config):

```json
{
  "mcpServers": {
    "suikoden-3-editor": {
      "command": "node",
      "args": ["/path/to/Suikoden-3-Editor/mcp/server.mjs"]
    }
  }
}
```

Replace `/path/to/Suikoden-3-Editor` with your checkout path.

## The rules the server enforces

- **Working copies only.** Opening an ISO or save copies it into `mcp/.work/`
  (or stages edits in memory). The file a thing was opened from is never
  written, and every export refuses that path as its target. Outputs go only
  where the caller says.
- **Stage, review, commit.** Field edits and code patches stage into a change
  set. `iso_list_changes` and `save_list_changes` show what is staged. Nothing
  reaches a file until `iso_export_iso`, `iso_export_recipe`,
  `iso_export_xdelta` or `save_export` is called. `iso_discard_changes` and
  `save_discard_changes` throw a staged set away.
- **Disabled features stay disabled.** The attack-rune spell lists global patch
  (Option B) was disabled in editor v1.159.0 with every apply route closed, and
  MCP is not a back door: no tool exposes it, `iso_set_patch` refuses it by
  name, and raw writes at its four offsets are refused byte-wise, mirroring
  `atkBlockedAt()` in `web/iso.js`. The per-rune spell-list control (Option A)
  is a working, play-tested feature and is available as
  `iso_rune_set_spell_list`.
- **Trinity Sight is read-only.** `save_get` with section `trinity` returns the
  recorded state. Unlock and stage writes are refused everywhere, including in
  the Python bridge, because the game rebuilds chapter availability from story
  progress when a save loads.
- **Legible errors.** Tool failures come back as plain-language MCP error
  results (what was refused and why), not stack traces.

## Tools

ISO:

| Tool | Purpose |
| --- | --- |
| `iso_open` | Open an ISO (copied to the work area, USA version verified) |
| `iso_list_views` | The editor's 23 views, from `web/iso.js`, with record-editing marks |
| `iso_describe_view` | A record view's table and editable fields |
| `iso_list_records` | Records of a table view (spells, unites, runes, enemies, skill effects, characters) |
| `iso_get_field` / `iso_set_field` | Read or stage one field of one record |
| `iso_read_word` / `iso_stage_word` | Raw 1/2/4 byte access anywhere in the editable region (disabled-patch offsets refused) |
| `iso_list_patches` / `iso_set_patch` | The enabled Test-tab patches: unlimited casts tier 1 and 2, free training, free sharpening, smith cap removed |
| `iso_rune_set_spell_list` | The per-rune spell-list control (Option A) |
| `iso_list_changes` / `iso_discard_changes` | Review or discard the staged change set |
| `iso_export_iso` | Write a full patched ISO copy |
| `iso_export_recipe` | Write the staged changes as a recipe JSON |
| `iso_export_xdelta` | Write a standard VCDIFF patch, built by `web/vcdiff.js` |

Saves:

| Tool | Purpose |
| --- | --- |
| `save_open` | Open a memory card (.ps2), .psu, or raw gamedata; decodes every S3 save via s3save |
| `save_get` | Decoded state: summary, characters, inventory, party, names, trinity (read-only) |
| `save_stage_character` | Stage character edits: level, weapon level, HP, EXP, stats, skills, equip, rune charges |
| `save_stage_misc` | Stage gold, leader, party, party mounts, recruits (the 108 Stars worklist), inventory, names, carryover |
| `save_list_changes` / `save_discard_changes` | Review or discard staged save edits |
| `save_export` | Apply staged edits through s3save and write to a chosen path |

## Tests

```sh
node mcp/test.mjs
```

The harness speaks to the server as a real MCP client over stdio and runs
against synthetic fixtures (the ISO fixture from `web/tests/synth-iso.mjs`, a
synthetic gamedata save from the bridge). It covers the handshake and tool
listing, ISO discovery, field edit round trips for both halves, patch staging,
the Option B and Trinity refusals, every export, and the working-copy guarantee
(source hashes unchanged). Optional real-data smoke tests:

```sh
S3_ISO="/path/to/Suikoden III (USA).iso" S3_CARD=/path/to/card.ps2 node mcp/test.mjs
```

Both are read-path safe: the server never writes a source file, and the harness
asserts the hashes afterwards.

## Known gaps

Operations the cores could not expose without reimplementing editor logic, and
which are therefore not offered rather than faked:

- **Most ISO views are discovery-only.** Only the table views whose field maps
  are plain data in `web/iso.js` (spells, unites, runes, skill effects, plus
  raw character records) get named field editing. The other views (Shops, Gear,
  Sets, Food, Weapons, Growth, Support, Enemies' stats, War, Encounter,
  Movement, Story, Text) are built by DOM rendering code with no headless field
  registry; their bytes remain reachable through `iso_read_word` and
  `iso_stage_word`, and their view names are listed by `iso_list_views`, but
  there is no per-view field schema. The web editor's static Changes map
  (FIELD_REG) is likewise a runtime registry built by its render path, so
  `iso_list_changes` reports byte runs rather than the web tab's labelled rows.
- **Forced passive support runes** (the Passives tab's per-character forcing)
  are not exposed: their site model does not slice as plain patch words.
- **Text and description editing** (the Text tab, spell and item descriptions)
  is not exposed: it depends on the editor's runtime string scan and
  dual-description index, which are built inside the browser session.
- **Presets and bulk edits** (difficulty presets, rune reskin, power bulk edit)
  are UI compositions over the same field writes; an MCP client can compose
  them from the field tools, but they are not single tools here.
- **Save formats:** everything s3save supports is supported (memory cards,
  .psu, raw gamedata, .cbs, .sps/.xps, .psv) because the bridge calls s3save
  itself. PAL saves remain detection-only, exactly as in the web editor.
- One ISO and one save are open at a time, matching the web editor's session
  model.
