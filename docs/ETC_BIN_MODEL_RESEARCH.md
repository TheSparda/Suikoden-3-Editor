# ETC.BIN model-swap research

> **BOTTOM LINE (Phase 1 tested 2026-08-22): in-place model swapping is NOT feasible.**
> Two in-emulator/structural tests killed both viable mechanisms:
> 1. **Name-swap test** (relabel `syu1`↔`syu2`, 79 same-size labels): booted, **no visible change** →
>    the game loads models by **precomputed index/offset**, not by the embedded name strings (those
>    are debug labels).
> 2. **Payload structure**: the inline "size" word is the **uncompressed** size. On disk the
>    payloads are **compressed and variable-length, packed tightly** (e.g. `cha_syu1_001`:
>    size-word 163,840 but only **7,924 bytes on disk** — ~20:1). So you cannot overwrite one
>    model's bytes with another's: compressed lengths differ, and any write past the real on-disk
>    length corrupts the neighbouring records (verified — a payload-swap clone came back corrupted
>    before it was ever booted).
>
> A real swap would therefore require: decompress both models, recompress the replacement, **repack
> the entire 386 MB archive** because sizes change, and **fix the game's offset table** (location
> not yet found — likely in the ELF or `FSECT.BIN`). That's a full archive-rebuild + Konami
> compression RE effort, not an editor feature. **No "Model Swap" section should be added to the
> offline editor.** The sections below are the decode groundwork that led here.

> **PHASE 2 (2026-08-29): the disc-level verdict above stands — but it is not the only route.**
> The finding that killed Phase 1 ("loads by precomputed index, and we can't find the index
> table") reframes the problem rather than closing it: an index is a *value in RAM at scene-load
> time*, and changing it needs no repack, no compression RE and no ISO edit — it ships as a
> `.pnach`. Locating it is a search over 32 MB of live memory, which is a machine's job, and
> [`tools/pcsx2/`](../tools/pcsx2/) is now that machine. See
> [`PCSX2_AUTOMATION.md`](PCSX2_AUTOMATION.md) §3 for the plan, including how the Trinity Sight
> System's overlapping areas supply free A/B snapshot pairs, and how a savestate in a Luc scene
> answers §5's unresolved `syu1/2/3` identity and missing-`luc*` questions directly. Nothing is
> proven yet — this records the route, not a result.

---

## Phase 0 — decode (retained for reference)

Reverse-engineering notes for a future **model-swap** feature in the *offline* editor
(`Editor/s3editor.py` / `Editor/s3patch.py`). **No swap has been tested in-game yet** — this
document is the decode/mapping groundwork only. Nothing here should be wired into a write path
until Phase 1 (a single in-emulator proof) confirms the mechanism.

Data captured **2026-08-22** from the real disc: `DATA/ETC.BIN`, 386,756,608 bytes, from
`Suikoden III (USA).iso` (SLUS-20387). Companion machine-readable data:
- [`etc_char_summary.json`](etc_char_summary.json) — per-code counts + first offset.
- [`etc_inventory.json`](etc_inventory.json) — every `cha_/imf_/ctx_` entry with absolute
  offset and the two words following its name field.

---

## 1. Where models live

Character models/graphics are **not** in the boot ELF the current editor edits — they are packed
sub-assets inside **`DATA/ETC.BIN`** (a 386 MB "etc" grab-bag that also holds dialogue text,
face-animation names, and spell FX names). This matches the earlier note in
`Editor/Suikoden3_ISO_offsets.md` ("ETC.BIN is a character graphics/model/animation archive").

## 2. Container format (confirmed by inspection)

`ETC.BIN` is a **nested, tagged tree**, not a flat table:
- Section markers `PS2\0` and a recurring 4-byte tag `10 03 00 00` (= `0x310`) appear throughout
  as node/type delimiters.
- Named assets are stored as a **fixed 16-byte name field** (ASCII name + NUL padding),
  immediately followed by two little-endian u32 words:

  | bytes | meaning (confirmed) |
  |------|----------------------|
  | 0x00–0x0F | asset name, NUL-padded to 16 bytes (e.g. `cha_syu1_010\0\0\0\0`) |
  | 0x10 | u32 flags/version — **always `0x00010000`** on every `cha_` entry sampled |
  | 0x14 | u32 **payload size**, always a multiple of `0x8000` (32 KB); e.g. `cha_syu1_040` = `0x88000` (544 KB) |

  The size word being **inline, right next to the entry**, is the single most encouraging fact
  for feasibility (see §6): a same-size swap is a byte copy, and even a different-size swap is
  plausible *if* the loader trusts this inline size rather than a global offset table.
- The directory/name portion is **plaintext / uncompressed** — we can read and locate everything
  without a decompressor. (Whether the *payloads* are compressed is not yet determined.)

### Naming scheme
`{type}_{code}_{nnn}` where:
- **type**: `cha` (model + animation), `imf` (image/texture set — "image format"),
  `ctx` (context / cutscene variant). Also present: `face_*`, `walk_*`, `run_*` child nodes.
- **code**: a **4-char mnemonic** identifying the character/entity (194 distinct — see §4).
- **nnn**: a variant number (see §3).

Totals: **9,652** numbered `cha/imf/ctx` records across **194** codes.

## 3. Variant-number legend (inferred from distribution — not yet confirmed)

| number(s) | count | likely meaning |
|-----------|-------|----------------|
| `imf_*_000` | 2568 | base texture/portrait set (one per character) |
| `imf_*_100` | 362 | secondary texture set (alt costume / battle) |
| `cha_*_700` | 505 | a shared/base pose or "loop" set (child nodes like `g51_loop` seen) |
| `cha_*_001/010/020` | ~200 each | field model + LOD/state variants |
| `cha_*_040/041/050/060` | main chars only | extra poses (story/event) |
| `cha_*_1xx/17x/18x/19x` | many | battle animations / poses |
| `ctx_*_001..004` | ~600–1000 | cutscene/context variants |

These are **educated guesses from frequency + which codes carry them** (main characters carry the
`04x`/`05x`/`06x` ranges; minor NPCs do not). Confirming the exact meaning needs Phase 1.

## 4. The blocker that dwarfs the rest: **per-scene duplication**

A character's assets are **not stored once**. Each area/scene bundle re-embeds the characters it
uses, so the same entry recurs many times across the 386 MB:
- `cha_syu1_700` → 6 copies; `imf_syu1_000` → 28 copies; `cha_kork_001` → 6 copies.
- Summing payload sizes across all duplicates gives absurd totals (e.g. `mria` ≈ 19 GB of
  summed copies) — a direct measure of how heavily duplicated the data is.

Consequences for a swap:
1. There is **no single "Hugo model"** to repoint — there are dozens of copies in dozens of
   bundles.
2. A global "Hugo→Luc" swap means patching **every bundle**, and an in-place same-size swap is
   only possible **in bundles where both characters already appear**. Hugo and Luc rarely share
   scenes, so many bundles won't contain Luc's data to point at.

This is why a naive "rename the file" idea can't work globally — and why Phase 1 should target
**one specific bundle** first.

## 5. Character-code → name mapping (the critical missing piece)

The codes are romanized-Japanese abbreviations. **No public reference maps them**, and the repo
has no table linking these 4-char codes to character indices. Below is split by confidence.

**High confidence:**
| code | character |
|------|-----------|
| `kork` | Koroku (the dog; Chima Star) |
| `syu1` / `syu2` / `syu3` | the three protagonists (*shujinkou* 1/2/3) — Hugo / Chris / Geddoe, **order unverified** |

**Plausible (romanization match — NOT verified, do not write against these):**
`thms`→Thomas, `fred`→Fred, `nash`→Nash, `jack`→Jacques, `lily`→Lilly, `cecl`→Cecile,
`duke`→Duke, `mria`→Maria(?), `leoo`→Leo(?), `s2hr`→a Suikoden-II carryover(?).

**Directly relevant to the request — and currently UNRESOLVED:**
- **Hugo** is one of `syu1/syu2/syu3`. `syu1` is the most likely (protagonist #1), but this must
  be confirmed in-game before use.
- **Luc** has **no obvious code** among the 194. There is no `luc*` entry; the `l*` codes are
  `lba1 lead leoo lett lily loll look luis lulu lusi lzk1 lzm1`. Candidates like `luis`/`lusi`
  are just as likely to be *Lucia* (Hugo's mother) or another character. **Pinning down Luc
  cannot be done from the archive alone** — it needs either a reference table or in-game testing.

> Net: even the two characters you picked aren't fully identified yet. Resolving the code↔name
> map (at least for Hugo and Luc) is the first thing Phase 1 must settle.

## 6. Feasibility summary

| factor | status |
|--------|--------|
| Directory readable without decompression | ✅ yes |
| Inline per-entry size word | ✅ yes (helps same-size swaps) |
| Entries are self-contained, sector-aligned blobs | ✅ likely (sizes are 32 KB multiples) |
| Single swap point | ❌ no — duplicated per scene bundle |
| Hugo/Luc share bundles (for in-place swap) | ❌ rarely |
| Runtime resolves by name string vs precomputed index | ❓ **unknown — the make-or-break question** |
| Payloads compressed? | ❓ unknown |
| Skeleton/animation compatibility between two chars | ❓ unknown (Hugo↔Luc both biped = best case) |

## 7. What Phase 1 (in-emulator) must resolve, in order

1. **Name-vs-index**: rename one `cha_` string in one bundle and see if the game loads a
   different model, or ignores it. This alone decides whether a swap is "edit the key" or
   "repoint offsets".
2. **Code identity**: confirm which of `syu1/2/3` is Hugo, and find Luc's real code.
3. **Size tolerance**: does the loader honor the inline size word (allowing different-size
   swaps) or does it use a fixed buffer (requiring same-size only)?
4. **Payload format**: are the blobs compressed? (Determines whether we can ever build *new*
   models vs only swap existing ones.)

Only after #1–#3 are known should a "Model Swap" section be added to the offline editor, scoped
to exactly what the proof supports (most likely: same-size, per-bundle swaps between two
already-co-present characters).
