# The mount system (field + battle)

Reverse-engineered 2026-08-30 from `SLUS_203.87` (USA, SLUS-20387) inside
`Suikoden III (USA).iso`, plus the `cha_/imf_/ctx_` inventory of `DATA/ETC.BIN` and the
per-area `DATA/*.BIN` archives. All work was read-only; no bytes were written to the disc.

Address convention: ELF segment is `p_offset 0x1000 → vaddr 0x165d000`, so
`ISO_offset = 669696 + (vaddr - 0x165c000)`. `$gp = 0x19ec570`.

---

## Bottom line

Mounting is a **real engine subsystem**, not baked cutscene animation. It has three
independent layers, and each layer restricts things differently:

| Layer | What it is | Who it lets ride |
|---|---|---|
| **Link primitive** | `RideLink(riderEobj, mountEobj)` @ `0x16e84c0` | **anyone on anything** — no ID check at all |
| **Field mounting** | EDS event-script opcodes `RideOn` / `RideOff` | anyone the map's script says |
| **Battle mounting** | automatic, gated by a hardcoded pair table @ `0x16e8b78` | **exactly three pairs**, see below |

So: *mechanically* the engine will pair any two objects. What actually stops
"Chris rides Fubar" is (a) a 24-byte hardcoded pair table for battle, and (b) whether the
rider's and mount's **models ship the required animation banks**.

---

## 1. The state: one flag and one back-pointer

`RideLink(rider, mount)` @ `0x16e84c0`:

```
if (!rider || !mount)        return 0;
if (rider->ride_partner)     return 0;   // already mounted
if (mount->ride_partner)     return 0;   // mount already taken
rider->ride_partner = mount;             // EOBJ +0x250
mount->ride_partner = rider;             // symmetric
SetFlag(rider, 0x00000008); SetFlag(rider, 0x00000400);
SetFlag(rider, 0x00080000); SetFlag(mount, 0x00080000);
return 1;
```

`RideUnlink(rider)` @ `0x16e8560` reverses it exactly.

- **EOBJ +0x250** = mount/rider partner pointer (symmetric, `NULL` = not mounted).
- **EOBJ flag `0x00080000`** = "is half of a ride pair". This single bit is what the rest of
  the engine branches on; it is tested at ~35 sites.

There is **no character-ID check anywhere in this primitive.**

The event script can query the state: EDS conditional opcode @ `0x177bdd0` reads a subcommand
and an EOBJ number, and for subcommand `0x28`/`0x29` returns
`eobj->+0x3c->+0x250 != 0` / `== 0`, printing `RIDE(%d)` / `NORIDE(%d)` in debug builds.

## 2. The motion table — one global slot list, shared by every model

A single array of `struct { char name[18]; u8 flagA; u8 flagB; }` (stride 20) at
**vaddr `0x1966610`** maps motion-slot index → clip name. Every model plays clips by *slot
number*, so a model can only be mounted if its own animation set actually contains clips for
these slots:

| slots | contents |
|---|---|
| `0x3C–0x3F` | `rideon_L` / `rideon_R` (mount-up, 2 handedness pairs) |
| `0x40` | `ride_neutral` |
| `0x41` | `rd_inanaki` (rider-side whinny reaction) |
| `0x42–0x49` | `rdwalk_start/rdwalk/rdwalk_stop`, `rdfastrun_loop`, `rdfastwalk`, `rdrun_start/rdrun/rdrun_stop` |
| `0x4A–0x4C` | `rdfloat_start/loop/stop` — **hovering mount** |
| `0x4D–0x4F` | `rdfly_start/loop/stop` — **flying mount** |
| `0x60–0x63` | `uma_neutral`, `uma_tokitama`, `uma_tokitama2`, `uma_inanaki` — **the mount's own** idle/whinny set (`uma` = 馬, horse) |
| `0x73–0x74` | `rided` (being ridden) |
| `0xB8–0xC3` | `b_ride_neutral`, `b_ride_b_start`, `b_rdinanaki`, `b_rdwlk_*`, `b_rdfstrun_loop`, `b_rdfstwalk`, `b_rdrun_*` — **mounted battle** |
| `0xC4–0xC8` | `rdbf_start/loop/stop`, `rdbf_att_start/end` |
| `0xC9–0xDE` | `b_rdN_damage`, `b_rddown_start`, `b_rdhinsi_*` (near-death), `b_rdatt_1/2/end`, `b_rdmagic_start/end`, `b_rdrun_*_L/R` |
| `0xD7–0xD8` | `b_fly_att_start/end` — flying-mount battle attack |
| `0xDF–0xE0` | `b_rdbow_start/end` — firing a bow from the saddle |
| `0x103–0x105` | `rd_spatt_*` — mounted special attack |

Mounted combat is therefore a **complete parallel animation state**: its own guard, damage,
knockdown, near-death, magic-cast, bow and special-attack clips. That is not decoration —
someone built mounted battle as a first-class mode.

The battle stance selector @ `0x16e7c18` shows exactly how it is chosen:

```
if (TestFlag(eobj, 0x00080000))          // is in a ride pair
     if (!SetMotion(eobj, 0xB9))         // b_ride_b_start
          SetMotion(eobj, 0xB8);         // fall back to b_ride_neutral
else     SetMotion(eobj, 0x93);          // b_start (normal)
```

`SetMotion` @ `0x16ef4f0` returns nonzero on success, so a model with no ride clips
**fails silently** and keeps its previous pose rather than crashing.

## 3. Field mounting: an event-script command

Field mounts are driven entirely by the map's EDS script. The opcodes are

`EdsCRideOnSetS` (`0x179ecc0`) · `EdsCRideOnE` · `EdsCRideOffSetS` (`0x179f534`) ·
`EdsCRideOffE` · `EdsCHorseInanakiE` (`0x17a2xxx`) · `EdsCHorseDashSetS`

`EdsCRideOnSetS` takes three u16 params (rider EOBJ no, mount EOBJ no, a motion/param record),
links them, and ends by putting the rider into motion `0x40` (`ride_neutral`).
`EdsCHorseInanakiE` first checks the target's object kind `== 7` and otherwise prints
`!!! evono %x is not horse. !!!`, then plays motion `0x63` (`uma_inanaki`) / `0x60`
(`uma_neutral`) — i.e. **object kind 7 == HORSE**.

The only character-specific code in the whole field path is a cosmetic fix-up: when the rider
is model **1 (Hugo)** on mount **325/353 (`krum`/`kru2`, the Karaya horses)**, or the rider is
model **45 (Salome)**, the handler calls `0x16d7f60(clump, name)` seven times to strip the
clips named `ride_neutral`, `rdrun_stop`, `rdrun`, `rdrun_start`, `rdwalk_stop`, `rdwalk`,
`rdwalk_start` from the rider's clump (a duplicate-clip cleanup). It does not gate anything.

### The rideable-mount whitelist (saddle offsets)

`GetRiderOffset(mountModelId, fwd, up, out, mode)` @ `0x16e85e8` classifies the **mount's**
model id into one of three saddle-offset presets and otherwise prints
`can't ride this animal!`:

| preset | forward | vertical | mount model ids |
|---|---|---|---|
| P1 | 0.30 | 0.70 | **325 `krum`**, **353 `kru2`** — Karaya horses |
| P2 | 0.40 | 0.70 | **308 `zkum`** (Zexen-knight horse), **309 `s2um`** (Chris's horse) |
| P3 | 0.00 | 0.70 | **42 `mskr`** (Ruby), **209 `mskn`**, **359 `msx1`**, **360 `msx2`** (Le Buque horses) |
| — | 0.00 | 0.00 | anything else → debug print, rider sits at the mount's origin |

Note the fall-through: riding a non-whitelisted model **still works**, the rider just gets a
zero saddle offset. This is a placement table, not a permission check.

`uma1` (the plain ambient horse), `usi1` (cow) and `pig1` are **not** in the list — the
scenery horses genuinely cannot be ridden properly.

## 4. Battle mounting: the hardcoded three-pair table

This is the real gate. `IsValidRidePair(riderModelId, mountModelId)` @ **`0x16e8b78`**:

```
if (!rider || !mount)                 return 0;
if (rider ==  1 && mount ==  8)       return 1;   // Hugo  + Fubar   (syu1 + guli)
if (rider == 31 && mount == 32)       return 1;   // Futch + Bright  (futi + brit)
if (rider == 41 && mount == 42)       return 1;   // Franz + Ruby    (mstk + mskr)
return 0;
```

Twelve call sites use it (battle setup, party formation, menu). In battle, `0x17df6e8`
looks up the character's partner, and only if `IsValidRidePair` passes does it call
`Mount(riderSlot, mountSlot)` @ `0x17de7b8`, which writes into the battle work struct:

- `btlWork = *(0x196A4BC)`, character records at `btlWork + 0x500 + slot*0x630`, **14 slots max**
- record **`+0x600`** = u16 slot of the mount I am riding
- record **`+0x602`** = u16 slot of the rider on me (`-1` = none)

then calls `RideLink` on the two EOBJs.

### Exact patch bytes (USA ISO)

Every entry is the 16-bit immediate of an `addiu $v0, $zero, N`, stored **little-endian in the
first two bytes** of the word:

| ISO offset | current bytes | meaning |
|---|---|---|
| `0x130384` | `01 00 02 24` | rider #1 = 1 (Hugo) |
| `0x130390` | `08 00 02 24` | mount #1 = 8 (Fubar) |
| `0x13038C` | `1F 00 02 24` | rider #2 = 31 (Futch) |
| `0x130398` | `1F 00 02 24` | rider #2, duplicated in the delay slot — **must match** |
| `0x1303A4` | `20 00 02 24` | mount #2 = 32 (Bright) |
| `0x1303A0` | `29 00 02 24` | rider #3 = 41 (Franz) |
| `0x1303AC` | `29 00 02 24` | rider #3, duplicated in the delay slot — **must match** |
| `0x1303B4` | `2A 00 02 24` | mount #3 = 42 (Ruby) |

Riders #2 and #3 each appear **twice** because the compiler hoisted the next comparison's
constant into a branch delay slot. Change only one of the pair and the check breaks.

The ids are **model ids**, not the roster ids the ISO editor's list 1 uses — see
[`s3_model_ids.json`](s3_model_ids.json) for the full 517-entry map and the roster
cross-reference (e.g. roster 2 Chris = model **2**, roster 39 Salome = model **45**,
roster 20 Borus = model **21**).

### How the model-id table was decoded

`GetModelCode(id)` @ `0x1711ac8` is a five-band lookup returning a pointer to the model's
4-char asset code:

| id range | pointer table |
|---|---|
| 1–99 | `0x1967FB0` |
| 100–199 | `0x19680F8` |
| 200–299 | `0x1968190` |
| 300–500 | `0x19681D8` |
| 501–611 | `0x1968370` |

Ids 140–154, 202–216 and 300–342 are **three repeats of the same NPC bank** (so `zkum` is
164 / 226 / 308, `krum` is 181 / 243 / 325). The ride whitelist happens to name the
third-bank ids.

There is a second, separate table at `0x19e6c20`: the **roster** id → code map, stored in
*descending* id order (`addr = 0x19e6e78 - 8*roster_id`, 8-byte stride). It confirmed the
roster alignment 1–75 exactly against `Editor/s3_names.json`.

## 5. Which models can actually be mounted or ridden

From the `cha_<code>_NNN` variant sets in `ETC.BIN` (`docs/etc_inventory.json`).
**Exactly ten models carry the `3xx` animation bank** — the mounted bank:

| code | character | 3xx variants |
|---|---|---|
| `syu1` | **Hugo** | 300 301 310 311 320 340 360 371 372 380 |
| `futi` | **Futch** | 300 301 310 311 320 340 360 371 372 380 |
| `mstk` | **Franz** | 301 310 311 320 340 360 371 372 380 |
| `syu2` | **Chris** | 300 301 310 320 321 322 340 360 371 372 380 |
| `bols` | **Borus** | same as Chris |
| `psvl` | **Percival** | same as Chris |
| `leoo` | **Leo** | same as Chris |
| `loll` | **Roland** | 300 301 310 320 321 322 **341** 360 371 372 380 |
| `zkk1` | generic Zexen knight NPC | same as Chris |
| `mria` | Sharon | 300 301 310 311 only (partial) |

Two profiles: the three battle riders (+ Sharon) carry **311**; the five Zexen knights and the
knight NPC carry **321/322** instead. The exact meaning of the individual variant numbers is
**not confirmed** — only the presence/absence of the bank is.

And the mounts, split by whether they have a battle animation set (`1xx`/`14x`/`16x`/`18x`/`19x`):

| code | model ids | what | battle set? |
|---|---|---|---|
| `guli` | 8 | **Fubar** (griffon) | **yes** — 101 111 140 160 171 172 180 190 |
| `brit` | 32 | **Bright** (dragon) | **yes** — 111 140 160 171 172 180 190 201 |
| `mskr` | 42 | **Ruby** (Franz's horse) | **yes** — 111 140 160 171 172 180 190 201 |
| `msx1` | 277 / 359 | Le Buque horse | yes (140 160 171 172 180 190) |
| `mskn` | 147 / 209 | Le Buque named NPC/horse | yes (140 160 171 172 180 190) |
| `msx2` | 278 / 360 | Le Buque horse | no |
| `s2um` | 165 / 227 / 309 | **Chris's horse** | **no** — 001 002 004 005 010 020 021 060 171 172 |
| `zkum` | 164 / 226 / 308 | Zexen-knight horse | **no** — same set |
| `krum` | 181 / 243 / 325 | Karaya horse | **no** — 001 002 005 010 020 021 060 |
| `kru2` | 271 / 353 | Karaya horse #2 | **no** |
| `uma1` | 388 | plain scenery horse | no — only 001 010 |

Consistent with the roster data: Fubar, Bright and Ruby are the three party members with **no
weapon level** and a fixed head rune (`s3_rune_slots.json`), and Ruby "joins with Franz".

## 6. Where each mount model is bundled

Scanned every `DATA/*.BIN` for `cha_/imf_/ctx_` names. Assets are bundled **per area** (as
established in [`ETC_BIN_MODEL_RESEARCH.md`](ETC_BIN_MODEL_RESEARCH.md)), so a model can only
appear in a scene whose archive carries it:

| code | archives |
|---|---|
| `guli` (Fubar) | HNKT, KRVI, KSKR, LZVI, MORI, TSVI, ZKTR |
| `brit` (Bright) | CRRA, HNKT, YMMT |
| `mskr` (Ruby) | HNKT, MSVI, TSVI |
| `zkum` (Zexen horse) | AKMT, HNKT, KRVI, ZKTR |
| `krum` (Karaya horse) | HGB1, HNKT, KRVI |
| `kru2` | KRVI |
| **`s2um` (Chris's horse)** | **AKMT only** |
| `uma1` (scenery horse) | AKVI, CRRA, HGB2, HNKT |

## 7. Answers to the questions that started this

**Can someone else ride Fubar / Bright?**
In battle, no — not without patching the three-pair table at ISO `0x130384`–`0x1303B4`. The
patch itself is trivial (eight 2-byte immediates, remembering the two duplicated delay-slot
constants). But a substituted rider will only *animate* correctly if their model carries the
`3xx` bank, which is only Hugo, Futch, Franz, Chris, Borus, Percival, Leo, Roland, `zkk1` and
(partially) Sharon. Anyone else pairs up and then silently keeps their normal battle pose,
because `SetMotion` fails on the missing `0xB8`+ clips.

On the field there is no pair check at all — an EDS `RideOn` will link any two EOBJs. The mount
just needs to be one of the eight whitelisted models to get a correct saddle offset.

**Can Hugo ride on multiple maps? Can Chris?**
Field mounting is per-scene script, so "which maps" is a property of each map's EDS script plus
whether that area's archive bundles the models. Chris's horse `s2um` is bundled in **AKMT
(Kuput Forest) only**, so putting her on horseback elsewhere means getting `s2um` into that
area's archive — which runs straight into the repacking blocker already documented in
`ETC_BIN_MODEL_RESEARCH.md` (compressed variable-length payloads, no offset table found).
Hugo/Fubar is the easiest case: `guli` is already bundled in seven archives.

**Hugo does not have a horse.** His mount is Fubar the griffon (`guli`), which is why the
rider set includes `rdfloat_*` and `rdfly_*` (slots `0x4A–0x4F`) and the battle set includes
`b_fly_att_start/end`.

---

## Not established

- What `mskn` (model 147/209) actually is — a Le Buque named NPC with a face portrait that is
  nonetheless in the rideable whitelist.
- The meaning of individual `3xx` variant numbers, and the `311` vs `321/322` split.
- Whether the field ride state survives a map transition. The field state lives on per-scene
  EOBJs (`+0x250`) and the battle state lives in `btlWork`; no save-file field was traced.
- The `Toggle Mount` / `Mount-Dismount Selectable Characters` debug-menu handler (labels found
  at `0x19caac8` / `0x19cae20`, handler table not located).
- Nothing here has been tested in an emulator. Every claim above is static analysis.
