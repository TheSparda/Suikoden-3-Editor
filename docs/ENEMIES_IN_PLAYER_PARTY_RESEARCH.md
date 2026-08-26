# Enemies in the player party — feasibility research

**Question:** *the Enemies work showed that enemies are character records in character slots —
so couldn't we just put them in the player party?*

**Short answer:** the premise is right, but "enemy" is three different things on this disc, and
only one of them is party-able.

| Class | Example | In the player party? |
|---|---|---|
| **A. Character-slot enemies** (story bosses that are list1 characters) | Luc, Yuber, Sarah, Bazba, Leo, Franz, Ruby, Sasarai, Jimba | **Yes — and the Save Editor can already do it today.** Untested in-game; risks are soft-locks and missing per-area models, not corruption |
| **B. War-battle unit types** (ids 306–359) | ZxnKn, HarmonSldr, MntrLegnnr, Mantor | **No.** Separate id space, no save block, no menu identity; war units aren't field/battle characters |
| **C. Bestiary monsters** (ids 501–599 / 0x1F5–0x257) | BladeBunny, Rock Golem, GhostHolly | **No** — four independent blockers, below. Their *numbers* can be ported onto an ally instead |

The confusion is understandable: **all three use the same 0x8C (140-byte) record**. Sameness of
record is not sameness of identity — what differs is *which id space the record is addressed
from, and who owns the copy that persists across areas*.

---

## 1. The three id spaces

Grounded in the shipped index data, not inference:

- **list1 characters — ids 1..79.** `Editor/s3_names.json` (`list1`): `1 Hugo … 57 Luc,
  58 Yuber, 59 Sarah … 79 Kogoro`. Records at ISO `0x3E3C7C`, stride 140.
- **War unit types — ids 4..359.** `Editor/s3_war_units.json`: `306 ZxnKn`, `327 HarmonSldr`,
  plus low-id "leader unit" nodes (0x12, 0x29, 0x2A, 0x42) that `build_war_index.py` matched to
  Leo / Franz / Ruby / Sarah **by exact (lv, hp) agreement with the bosses guide, not by id** —
  and those ids do *not* line up with list1 (Leo is list1 17 but node 0x12=18; Sarah is list1 59
  but node 0x42=66). It is its own space.
- **Bestiary monsters — ids 501..599.** `Editor/s3_enemy_packs.json`: 72 distinct ids, **none
  below 0x1F5**. Named via the ELF pair table at `0x3B1168` → the 100 × 0x14 truncated-name
  table at `0x3E74E0`.

The engine dispatches on that range at runtime: `0x16C6D08` resolves characters through a lut
(`0x19697A8`) into 0x8C BSS structs filled from list1, and monsters through `0x16C6D70`, which
walks a node list head (`0x196B1F0`) **registered by whichever battle pack is currently
loaded** (see `Editor/Suikoden3_ISO_offsets.md`, "ENEMY STATS — FOUND").

## 2. Class A — bosses are already party-able (no new mechanism needed)

Active-party composition is 6 × u16 char ids at save offset **0x3216**, "ids in the exe list1
space" (`Editor/s3save.py:89`). Nothing in the write path restricts the value
(`apply_edits_to_gamedata` just clamps to u16), and the picker is built from *all 79* list1
names (`web/app.js` → `REF.charById`), Luc / Yuber / Sarah included.

Those characters are not stubs. Each has:

- a 140-byte save block at `0x33AC + rosterIndex*140` (level, EXP, 8 stats, 8 skill slots,
  9 equip slots) — and for ids 1..75, **char id = rosterIndex + 1**, so Luc 57 → roster 56 "Luc",
  Yuber 58 → 57, Sarah 59 → 58. Verified by name-matching list1 against `s3save.ROSTER`;
  the two lists diverge only past index 74 (support-only characters have save blocks but no
  list1 record, and list1 76–79 have no roster slot — treat that tail as unverified).
- a recruit word at `0x232 + rosterIndex*2` (the Save Editor's "recruited" toggle),
- a list2 growth/skill-cap record and list3 support record, so they level like anyone else.

So "put an enemy in the party" for class A is: set the recruit word, fill a party slot, and give
the block a sane level/stats. **All of that is existing editor functionality** — no new decode.

**What is *not* proven** (needs PCSX2, which this research had no disc/emulator for):

1. **Field and battle models per area.** `docs/ETC_BIN_MODEL_RESEARCH.md` established that
   character assets are re-embedded per scene bundle — `cha_syu1_700` exists in 6 copies,
   `imf_syu1_000` in 28 — and are resolved by precomputed index, not by name. A character whose
   bundle is absent from the area you walk into has nothing to load. This is the same rule the
   Enemies tab already enforces on spawn slots ("monsters from other packs would spawn without
   their models loaded and crash the game"), and a party member visits *every* area.
2. **Story overwrites.** 0x3216 is the map's *current* party; early-chapter events set it
   wholesale (the editor already warns about this).
3. **Menu/soft-lock behaviour** — party-leader checks, chapter-locked teams, the pre-merge
   three-party split, and 108-Stars/ending logic all key off the recruit table.

Verdict: **plausible and cheap to try, unproven in-game.** Under the repo's correct-or-absent
rule it stays a save-edit users can already perform, not a promoted "Add boss to party" button,
until someone boots it.

## 3. Class C — bestiary monsters: four independent blockers

Each of these alone is fatal; there is no ordering that avoids them.

1. **No addressable identity.** Party slots hold list1 ids. Monster ids are 501–599 and resolve
   down a different branch of `0x16C6D08`. Writing 501 into a party slot indexes the character
   lut out of range.
2. **No persistent record.** A monster's 0x8C stat record lives *inside an area pack*
   (`s3_enemy_packs.json`: 81 packs, ~1,960 variants, each pack duplicated ~3–4× as streaming
   copies) and is registered only while that pack is resident. There is no ELF-side or save-side
   copy to carry the creature between areas — the exact opposite of what a party member needs.
3. **No save representation.** Save character blocks are indexed by roster slot (100 of them);
   there is no slot for id 501, no recruit word, no EXP/growth record, no equip or rune slots.
   Monsters also have no skill array — their `+0x38` bytes are resist/AI values (`0x09 ×8` on
   plain monsters), not the (skill id, rank) pairs a character block carries at `+0x10`.
4. **No menu or field identity.** Monster names come from the truncated 100-entry enemy name
   table (`"BladeBunny"`, 10 chars), not the character name table; there is no portrait, no walk
   or run animation set, no field model outside its own battle bundle — and per the ETC.BIN
   research, supplying one is a full-archive rebuild plus compression RE, not an editor feature.

Class B (war unit types) fails 1, 3 and 4 for the same reasons, and additionally isn't a
field-battle entity at all — war units are a separate battle mode whose *own* army side already
reads its strength from the characters' save stats.

## 4. What the 0x8C coincidence actually means

Worth pinning down, because it is the strongest part of the premise. Comparing the two decoded
layouts:

| Offset | Save character block (`s3save.py`) | Monster on-disc record (`build_enemy_index.py`) |
|---|---|---|
| +0x00 | u32 EXP to next level | — |
| +0x08 | u16 current HP | — |
| +0x0C | u8 char id · +0x0D u8 level | u32 EXP-ish reward |
| +0x10 | 8 × (skill id, rank) | u32 potch-ish reward |
| **+0x20** | **u16[8] stats (PWR…LUK)** | **u16[8] stats (PWR…LUK)** |
| **+0x30** | **u16 max HP** | **u16 HP · +0x32 u16 max HP** |
| +0x38 | — | 8 resist/AI bytes |
| +0x40 | — | u16 level (+0x41 runtime variant index) |

**Same size, same stat block, same HP word — different everything else.** So the honest
statement is: characters and monsters are filled into the *same* 0x8C combat struct at runtime
(chars from list1 + save, monsters from the pack node), but the two on-disc serializations are
**not interchangeable**. Copying a monster record over a character block would move level and
rewards into skill and id fields. A clean confirmation is cheap in an emulator: dump
`0x196E700 + n*0x8C` for an ally and the monster struct from `0x196B1F0`, and diff.

## 5. The thing that *is* both possible and safe: port the numbers

What people usually want from "put the Rock Golem in my party" is its **statline**, not its
mesh. Every field needed for that is already decoded on both sides:

- source: `s3_enemy_packs.json` — per variant `lv`, `hp`, `stats[8]`, and the aux block's
  EXP / SP / potch / 5 drop slots;
- destination: the Save Editor's per-character level, HP and 8 stats — or, for a new game, the
  ISO Characters/Growth tabs.

That's a "give Hugo the Rock Golem's numbers" preset, entirely inside proven write paths, with
no new reverse-engineering and no crash surface. It is not implemented here — it is the
recommended shape if this line of work turns into a feature.

## 6. Recommendation / next steps

1. **Try class A in PCSX2 first** — one save, Luc into a party slot with the recruit word set,
   then walk between two areas and enter a battle. That single test decides whether "recruit a
   boss" is a supportable editor feature or a crash generator, and it costs one evening.
2. **Don't build anything for classes B and C.** The blockers are structural (id space, pack
   residency, save representation, assets), and the asset half is the same wall that already
   stopped the model swap.
3. **If a feature is wanted now**, ship the stat port (§5), which needs no proof beyond what the
   Enemies and Save editors already verify.

---

## Addendum — "can we make Dios playable?" (2026-08-26)

Follow-up question, and a useful contrast: **Dios is not the Luc/Yuber case.** Luc, Yuber and
Sarah are battle characters the game happens to point at you. Dios is a **support-only star**,
and every table on the disc says so.

**Table side.** The four record tables split the cast cleanly:

| Table | Count | Who |
|---|---|---|
| list1 (starting stats, 0x3E3C7C, stride 140) | **79** | the fighting cast: `1 Hugo … 75 Emily`, then `76–79` Koichi/Connie/Kosanji/Kogoro |
| list2 (growth + skill caps, 0x3E1338) | **79** | same 79, same order |
| **list3 (support skills, 0x3E6830, stride 8)** | **34** | `1 Apple … 33 Dios … 34 Iku` |

Dios is **list3 #33**. He has no list1 record (no starting stats, no equip/rune slots, no
weapon-growth class → no list4 ATK curve) and no list2 record (no growth rates, no skill caps).
The Suikosource data agrees: `skills.txt` gives him one support skill, *Discount: C*;
`s3_recruit_meta.json` says `auto: true, "he joins with Sasarai"`; the character guide says
"Dios doesn't do anything in the castle."

**So there is no id that means "Dios" in the party's id space.** Party slots at 0x3216 hold
*list1* ids; support stars live in a disjoint 34-entry table. Writing 33 there gives you
**Shiba** (list1 33), not Dios. His save block is roster index **107**, past the editor's
`CHAR_COUNT = 100` decode window and past the ~99 blocks the offset map documents — the Save
Editor doesn't even surface him as a character.

**Asset side — independent confirmation.** `docs/etc_char_summary.json` counts `cha`
(model + animation) nodes per character code. The distribution is sharply bimodal:

- **78 codes carry ≥ 21 `cha` nodes** — the fighting cast (`syu2` 89, `leoo` 64, `kork`
  Koroku 44, `yuba` 42, `duke` 38, `bzba`/`ziba` 35, `quen` 34). 30 of them sit at 34–35.
- **25 codes carry exactly 8** — and `deos` (Dios) is one, alongside `appl` (Apple), `iiku`
  (Iku), `elot` (Elliot), `luis` (Louis). Cross-check on the inference: `luis` = 8 (Louis, a
  support) while `lusi` = 35 (Lucia, a fighter).

Eight `cha` nodes is a standing/talking NPC. The `1xx`/`17x`/`18x` battle-pose ranges the
ETC.BIN research identified simply do not exist for him — and authoring them is the wall
`docs/ETC_BIN_MODEL_RESEARCH.md` already hit (compressed payloads, per-scene duplication,
index-based resolution, full-archive rebuild).

**The tempting shortcut, and why it fails.** list1/list2 **76–79** look like four free battle
slots — Koichi, Connie, Kosanji and Kogoro, the game's other four dogs, with complete starting
stats *and* growth rates on disc and in the Suikosource guides, but no save-roster block. They
are also **the only character codes with `cha: 0`** (`koit`/`koni`/`kosn`/`kogr`: 0 cha, 18 imf,
8 ctx — textures, no model). Cut content, not a usable donor slot.

**What is actually achievable: a reskin, not a port.** Give a battle slot you don't use a "Dios"
build (ISO Characters + Growth tabs: stats, rune slots, skills, growth, caps) and rename it.
`web/rename-core.js` already does whole-disc, same-length, zero-shift renaming — but it is
deliberately limited to `Hugo / Chris / Geddoe`, the names distinctive enough to global-replace
safely. Generalizing it needs the same two guards: the donor name must be **≥ 4 chars** (`"Dios"`
padded to length) and must not be a substring that appears elsewhere — `Mel`, `Ace`, `Gau`,
`Nash`, `Belle` are unsafe; **`Sasarai` → `Dios`** is the safe pick, and fittingly leaves the
bishop's attendant standing in for the bishop. You get a playable unit *named* Dios wearing
someone else's model.

**Verdict:** properly playable — no. He has no battle record, no battle animations, and no
addressable id in the party's id space; all three would have to be authored, and the third is
gated on the archive rebuild that stopped the model swap. A named stat-reskin of an existing
fighter is the honest ceiling, and it needs one small, low-risk change (extend `rename-core`'s
allow-list with the same length/distinctiveness rules) rather than any new reverse-engineering.
