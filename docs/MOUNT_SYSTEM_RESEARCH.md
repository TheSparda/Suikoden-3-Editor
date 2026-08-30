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
| **Field ground ride** | EDS opcodes `RideOn` / `RideOff` | anyone the map's script says — but **horses only** |
| **Field flying ride** | EDS opcodes `FlyMove*` (a separate path) | scripted flight; this is the only way Fubar/Bright carry anyone outside battle |
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

## 3. Field mounting: two separate script-driven paths

Field mounts are driven entirely by the map's EDS script, and there are **two independent
mechanisms** that must not be confused:

### 3a. Ground ride — horses only

The opcodes are

`EdsCRideOnSetS` (`0x179ecc0`) · `EdsCRideOnE` · `EdsCRideOffSetS` (`0x179f534`) ·
`EdsCRideOffE` · `EdsCHorseInanakiE` (`0x17a2xxx`) · `EdsCHorseDashSetS`

`EdsCRideOnSetS` takes three u16 params (rider EOBJ no, mount EOBJ no, a motion/param record),
links them, and ends by putting the rider into motion `0x40` (`ride_neutral`).
`EdsCHorseInanakiE` first checks the target's object kind `== 7` and otherwise prints
`!!! evono %x is not horse. !!!`, then plays motion `0x63` (`uma_inanaki`) / `0x60`
(`uma_neutral`) — i.e. **object kind 7 == HORSE**.

There is one character-specific block, and it is the most informative thing in the whole
field path. When the rider is model **1 (Hugo)** and the mount is **325/353 (`krum`/`kru2`,
the Karaya horses)**, the handler calls `0x16d7f60(clump, name)` seven times, for
`ride_neutral`, `rdrun_stop`, `rdrun`, `rdrun_start`, `rdwalk_stop`, `rdwalk`, `rdwalk_start`.
`0x16d7f60` walks the clump's 128-entry clip table (`clump+0x40`, stride `0x20`), finds the
**first** clip with that name, and `bzero`s its record (`0x188b830` is a plain `bzero`) — i.e.
it **deletes** that clip binding.

The natural reading: Hugo's model ships **two** mounted rigs — one built for Fubar and one for
a horse — with colliding clip names, so mounting a horse has to shed the Fubar-rigged copies
first. Model **45 (Salome)** takes a parallel branch that skips the strip and goes straight to
the shared tail. Neither block gates anything; both are rig fix-ups.

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

**Critically, `guli` (Fubar) and `brit` (Bright) are not in this list either.** There is no
saddle offset for a griffon or a dragon, because they are never *ground* mounts. Confirmed by
the call graph: `GetRiderOffset` has exactly two callers, `0x16e8888` and `0x179ef20`, both on
the `RideOn` ground path.

### 3b. Flying ride — how Fubar and Bright actually carry someone on the field

A completely separate set of EDS opcodes (`EdsCFlyMoveE`, `EdsCFlyMoveInfinityE`,
`EdsCFlyPersonPositionMoveE`, `EdsCFlyPosDirSetS`, `EdsCDoveFlyMoveE`) drives airborne
movement. At `0x179c210`:

```
SetMotion(mount, 0x127);                 // fly_loop  — the flyer's own wings
if (TestFlag(mount, 0x00080000)) {       // is it carrying a rider?
     SetMotion(mount->+0x250, 0x4E);     // rdfly_loop — the rider's flying-ride clip
}
```

So the rider slots `0x4A–0x4F` (`rdfloat_*`, `rdfly_*`) belong to **this** path, not to
`RideOn`. The pair still uses the same `+0x250` link and the same `0x00080000` flag, but the
rider's world position comes from the scripted flight path rather than from a saddle-offset
table — which is exactly why `guli`/`brit` need no entry in that table.

This is scripted cutscene flight, not a player-steerable mount.

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

This is what the web editor's **Mounts** tab writes (`drawMounts` in `web/iso.js`), shipped
**beta / testing only** — the byte writes are verified but no re-paired combination has been
played through an emulator yet. It offers
only riders whose model carries the `3xx` bank and only mounts with a battle animation set,
refuses to edit if any of the eight sites is no longer an `addiu $v0,$zero,imm`, and always
writes a rider's delay-slot duplicate alongside its primary site.

Because the comparisons fall through cleanly, setting two pairs to the **same rider with
different mounts** works — e.g. Hugo+Fubar and Hugo+Bright lets Hugo take either.

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
| **`s2um` (Chris's horse)** | **AKMT only, and only the single record `cha_s2um_172`** |
| `uma1` (scenery horse) | AKVI, CRRA, HGB2, HNKT |

Presence is not the same as usability. Only these archives carry a **complete** ground-ride
variant set (`cha_*_001/002/005/010/020/021`):

| mount | complete in |
|---|---|
| `krum` (Karaya horse — Hugo's) | HGB1, HNKT, KRVI |
| `zkum` (Zexen-knight horse) | ZKTR only (AKMT/HNKT/KRVI carry just `cha_zkum_172`) |
| `s2um` (Chris's horse) | **nowhere** — only `cha_s2um_172` in AKMT |
| `mskr` (Ruby), `msx1` | MSVI, TSVI (both including the `111/140/160/171/172/180` battle bank) |

## 7. Answers to the questions that started this

**Hugo's field mount is a Karaya horse, not Fubar.** The engine says so directly: the only
rider/mount pair hardcoded anywhere in the *field* path is Hugo (model 1) on `krum`/`kru2`
(models 325/353), the Karaya horses. `guli` is absent from the ground-mount table entirely.
Fubar carries Hugo only through the separate scripted-flight path (§3b) and is otherwise a
battle-only party member. Ditto Bright for Futch.

`krum` is bundled with a complete field ride set (`cha_krum_001/002/005/010/020/021` +
three `ctx_`) in **HGB1 (Yaza Plain), HNKT (Budehuc Castle) and KRVI (Karaya Village)** —
three areas. `kru2` adds `ctx_` entries in KRVI.

**Can someone else ride Fubar / Bright?**
In battle, only by patching the three-pair table at ISO `0x130384`–`0x1303B4` (eight 2-byte
immediates, remembering the two duplicated delay-slot constants). The patch is trivial; the
animation is not. A substituted rider only animates correctly if their model carries the `3xx`
bank — Hugo, Futch, Franz, Chris, Borus, Percival, Leo, Roland, `zkk1` and (partially) Sharon.
Anyone else pairs up and then silently keeps their normal battle pose, because `SetMotion`
returns failure on the missing `0xB8`+ clips.

On the field there is no pair check at all — an EDS `RideOn` will link any two EOBJs — but the
mount must be one of the eight whitelisted **horses** to get a correct saddle offset, and
there is no ground-ride entry for a griffon or dragon to borrow.

**Can Hugo ride on multiple maps? Can Chris?**
Hugo already does: three areas ship the full `krum` set. Adding a fourth means getting `krum`
into that area's archive, which runs into the repacking blocker documented in
`ETC_BIN_MODEL_RESEARCH.md` (compressed variable-length payloads, no offset table found).

Chris is the harder case despite her model being fully rigged (`syu2` carries the complete
`3xx` bank). **No area archive carries a usable copy of her horse**: `s2um` appears in AKMT as
the single record `cha_s2um_172` and nowhere else; the full set exists only inside `ETC.BIN`.
By contrast the Zexen-knight horse `zkum` does ship complete in **ZKTR (Brass Castle)**
(`cha_zkum_001/002/004/005/010/020/021/171/172`), and `zkum` and `s2um` are the same rig at
byte level — identical variant lists and identical `cha_bytes` (1,933,312). So the nearest
thing to "Chris on horseback in more places" is a scene that already has `zkum`.

## 8. The debug menu's `Toggle Mount` — and why it can't be switched back on

The retail ELF still carries the development debug menu: 37 entries, each with a short label
and a long description, in two parallel pointer arrays sharing a base at **`0x19832F8`**
(label `N` at `+4N`, its description at `+4(N+38)`). Entry **12** is `Toggle Mount` /
`Mount-Dismount Selectable Characters`. The action dispatch is a 37-way jump table at
**`0x19C4C00`**, so entry 12's handler is `0x1787d38`, which tail-calls the real routine:

```
DebugToggleMount()                            ; 0x178ccc8
  work = *(0x196A4D0)                         ; the field/scene work pointer
  sel  = (s8)work->0x156                      ; debug "selected character"
  if (sel >= 6) return                        ; party slots 0..5 only
  rec  = GetEobjRecord(sel)
  obj  = rec->0x3c
  if (!obj) return
  if (!TestFlag(obj, 0x00080000))             ; not currently mounted
       mount = rec->0x1bc                     ; the character's ASSIGNED mount for this scene
       if (!mount) return                     ; <-- nothing to ride: silent no-op
       RideOn(obj)                            ; 0x179ec68, the same tail EdsCRideOnSetS calls
  else RideOff(obj, EobjNoOf(obj->0x250), 2)  ; 0x179f478
```

**It never spawns a mount.** It toggles the selected character onto whatever is already in
`rec->+0x1bc` — the per-character assigned-mount pointer the scene sets up (the same field the
party-warp code at `0x1777b98` follows when it drags your horse along to a new position). On a
map with no mount assigned, the dev tool does nothing at all. That is independent confirmation
of §7: even Konami's own debug build could not mount you on a map that has no mount in it.

### The menu is orphaned code

Re-enabling it is not a flag flip. Three separate things were cut:

1. **The dispatch has no caller.** The function owning the jump table (`0x1787be8`) has zero
   `jal` references. Its only entry is a vtable slot at `0x1982720`.
2. **That vtable is unreferenced.** `0x1982710` has no `lui`/`addiu` materializing it, no
   `$gp`-relative reference, and no data word pointing at it. Nothing constructs the class.
3. **The selection field is write-dead.** `work->+0x156`, which every debug handler reads to
   know which character you picked, is read at five sites (all inside the debug module) and
   **written by none**.

On top of that the debug printf itself (`0x1712238`) is stubbed: it stores the vararg registers
to the stack and returns without formatting anything, which is why ~39,000 debug strings survive
in the ELF while the retail build prints nothing.

So "expose the debug menu as a setting" would mean writing new code — construct the window,
route pad input to it, and populate `+0x156` — not patching a constant. What *is* cheap is that
the individual handlers survive intact and are ordinary callable functions; `0x178ccc8` in
particular is self-contained. Hooking a call to it from somewhere reachable is a far smaller
injection than reviving the menu, though it still only does anything where `+0x1bc` is set.

## Not established

- What `mskn` (model 147/209) actually is — a Le Buque named NPC with a face portrait that is
  nonetheless in the rideable whitelist.
- The meaning of individual `3xx` variant numbers, and the `311` vs `321/322` split.
- Whether the field ride state survives a map transition. The field state lives on per-scene
  EOBJs (`+0x250`) and the battle state lives in `btlWork`; no save-file field was traced.
- What populates `rec->+0x1bc` (a character's assigned mount for the scene) — presumably the
  scene/party setup, but the writer was not traced.
- Nothing here has been tested in an emulator. Every claim above is static analysis.
