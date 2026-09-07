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
| **Battle mounting** | automatic, gated by a hardcoded pair table @ `0x16e8b78` | **exactly three pairs** — but the pairs are editable constants, and re-pairing is confirmed in-game (§4a) |

So: *mechanically* the engine will pair any two objects. What actually stops
"Chris rides Fubar" is (a) a 24-byte hardcoded pair table for battle, and (b) whether the
rider's and mount's **models ship the required animation banks**. (a) is an editable set of
immediates — Hugo+Bright and Chris+Bright are both confirmed re-pairings, so **"Chris rides a
flyer" is answered: she does** — which leaves (b), plus one unplayed direction, a flyer-rigged
rider on Ruby (§4a).

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

This is what the web editor's **Mounts** tab writes (`drawMounts` in `web/iso.js`). Re-pairing is
**confirmed in-game**, twice over (both 2026-08-31):

- **Hugo (1) + Bright (32)** — the first non-stock combination played through an emulator. It
  settles two things that had only been inferred: the eight-site patch rewrites the comparison
  chain cleanly, and a rider's mounted-battle bank drives a mount it was **never authored for**
  (Hugo's clips were built for Fubar, a griffon; Bright is a dragon).
- **Chris (2) + Bright (32)** — the harder case, and the one §4a was written around: a rider whose
  mounted clips were authored around a **horse** (`s2um`) driving a **flyer**. It mounts and
  fights, and it looks right. Crossing rig *classes* therefore works, not just crossing mounts
  within a class.

**The menu does not surface a re-pairing.** Observed with Chris+Bright: the formation/party menu
shows no sign of the pair, and the pair mounts in battle regardless. `IsValidRidePair` has menu
call sites (§4, twelve callers), so the menu's mounted indicator evidently reads a different
source — that source was not traced. Practical consequence: judge a patched pair at battle entry,
not in the menu.

The tab offers every model carrying the `3xx` bank against all three battle mounts, marks each
combination with its own confidence tier (§4a), refuses to edit if any of the eight sites is no
longer an `addiu $v0,$zero,imm`, and always writes a rider's delay-slot duplicate alongside its
primary site.

Because the comparisons fall through cleanly, setting two pairs to the **same rider with
different mounts** works — e.g. Hugo+Fubar and Hugo+Bright lets Hugo take either.

### 4a. Which combinations work — permission vs. rig geometry

Nothing in code discriminates between combinations. `IsValidRidePair` is a pure id compare with
no per-character special-casing, so **every rider × mount pairing is equally *permitted***; what
differs is whether the rider's mounted-battle rig suits that class of mount. Battle seating does
**not** read the ground saddle-offset table (`GetRiderOffset` is on the `RideOn` path only), so
the rider's position comes from the mounted animation rig itself and nothing corrects it.

So each rider carries a **rig class** — the kind of mount their `3xx` clips were authored around:

| rider | rig authored around | class |
|---|---|---|
| Hugo | Fubar (griffon) | flyer |
| Futch | Bright (dragon) | flyer |
| Franz | Ruby | horse |
| Chris | `s2um`, her own horse | horse |
| Roland, Leo, Percival, Borus | `zkum`, the Zexen-knight horse | horse |
| Sharon | — (partial bank, `300/301/310/311` only) | unknown |

What is claimed for a combination is derived from **which directions have been played** — a
direction being the rider's rig class against the mount's class:

| direction | precedent |
|---|---|
| flyer → flyer | Hugo+Fubar, Futch+Bright (stock), Hugo+Bright (played) |
| horse → horse | Franz+Ruby (stock) |
| **horse → flyer** | **Chris+Bright (played)** |
| flyer → horse | **none** |

Crossed against the three battle mounts:

| rider | Fubar · flyer | Bright · flyer | Ruby · horse |
|---|---|---|---|
| **Hugo** · flyer-rigged | ✓ confirmed (stock) | ✓ **confirmed** (2026-08-31) | ? untested |
| **Futch** · flyer-rigged | • expected | ✓ confirmed (stock) | ? untested |
| **Franz** · horse-rigged | • expected | • expected | ✓ confirmed (stock) |
| **Chris** · horse-rigged | • expected | ✓ **confirmed** (2026-08-31) | • expected |
| **Roland / Leo / Percival / Borus** · horse-rigged | • expected | • expected | • expected |
| **Sharon** · partial bank | ≈ rough | ≈ rough | ≈ rough |
| **Geddoe / Thomas / Salome / Juan** · no battle bank | ✗ won't animate | ✗ won't animate | ✗ won't animate |

- **✓ confirmed** — played through an emulator; mounts, animates and fights correctly.
- **• expected** — a rider with this rig class has been played on this class of mount, so the
  geometry should carry over. This exact pair has not been played.
- **? untested** — accepted by the code, but no rider with this rig class has been played on this
  class of mount. As of now that is only **flyer-rigged riders on Ruby**: Hugo or Futch, whose
  mounted clips were built around a griffon and a dragon, driving a horse.
- **≈ rough** — only part of the mounted-battle bank exists, so expect missing or wrong clips
  whichever mount is picked.
- **✗ won't animate** — no `3xx` bank at all: the pair links up and the rider keeps their normal
  battle pose. Predicted from the failing `SetMotion` on slots `0xB8`+, not yet played. The tab
  lists these four behind an opt-in specifically as the negative control.

The Zexen knights inherit Chris's result on strong grounds rather than by analogy: `zkum` and
`s2um` are **the same rig at byte level** — identical variant lists, identical `cha_bytes`
(1,933,312) — so a horse-rigged knight on a flyer is the case Chris+Bright already played. Franz
is the weaker "expected": his rig was authored around Ruby, not `zkum`, so only the class matches.

Still open, tracked in [issue #14](https://github.com/TheSparda/Suikoden-3-Editor/issues/14):
**Hugo + Ruby** or **Futch + Ruby** (the one direction with no precedent), **Sharon** on anything
(what "partial bank" looks like in play), and the **Geddoe negative control**.

Two constraints come with any re-pairing, both independent of animation:

- **Both halves must be in the party and deployed** — the candidate mount is drawn from party
  membership (`0x17dede4`), so Chris+Bright still needs Futch recruited, because that is how
  Bright joins.
- **There are only three slots.** Giving a new rider a mount means overwriting a stock pair or
  spending a slot. Adding a fourth is out of reach: the chain has three comparisons and no spare
  instruction space, so it would take new code rather than a constant rewrite.

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

> **Corrected 2026-08-30.** An earlier revision of this document read the `3xx` bank as *the*
> mounted bank and concluded Geddoe was never rigged to ride. That was wrong. `3xx` is only the
> **battle** half; the field half is `07x`/`97x`, and **Geddoe has a complete field ride set**.
> The battle list below is unchanged and still correct.

Attribution here is **exact, not inferred**: ride clip names sit 48–80 bytes inside their own
`cha_` record's payload header, so each clip can be assigned to the record that contains it.
Scanning `ETC.BIN` that way gives a clean, model-independent legend:

| variant | clips it holds |
|---|---|
| `070` / `970` | `rideon_L`, `rideon_R` — mounting up |
| `071` / `971` | `rdwalk_start`, `rdwalk`, `rdwalk_stop` |
| `072` / `972` | `rdfastwalk` |
| `073` / `973` | `rdfastrun_loop` (or the `rdrun_*` set) |
| `074` / `974` | `ride_neutral` |
| `075` / `975` | `rd_inanaki` |
| `080` | `rdfly_*` / `rdfloat_*` — **riding a flyer** |
| `301` / `320` / `340` | `b_ride_neutral` / `b_rdwlk` / `b_rdatt_1` — **mounted battle** |

`07x` and `97x` are two parallel copies of the same ground-ride set (which rig each belongs to
is not established). So:

| code | character | field ride (`07x`/`97x`) | fly (`080`) | battle (`301/320/340`) |
|---|---|---|---|---|
| `syu1` | **Hugo** | yes — **the only model with both** (`070/071/073/074/076` + `970–976`) | — | **yes** |
| `syu2` | **Chris** | yes `070–075` | — | **yes** |
| `bols` | **Borus** | yes `071–075` | — | **yes** |
| `leoo` | **Leo** | yes `071–075` | — | **yes** |
| `loll` | **Roland** | yes `071–075` | — | **yes** |
| `psvl` | **Percival** | yes `071–075` | — | **yes** |
| `futi` | **Futch** | yes `071/073/074` | **yes** | **yes** |
| `mstk` | **Franz** | yes `071/073/074` | **yes** | **yes** |
| `zkk1` | Zexen knight NPC | yes `071–075` | — | **yes** |
| `mria` | Sharon | — | — | partial (`301` only) |
| **`syu3`** | **Geddoe** | **yes `970–975`** | — | **no** |
| **`thms`** | **Thomas** | **yes `970–975`** | — | **no** |
| `s2hr` | named NPC | yes `970–975` | — | no |
| `msk1`/`msk2` | Le Buque villagers | yes `070/071/073/074` | yes | no |
| `jyan` | Juan | `074` only | — | no |

### The `311` vs `321/322` split — it tracks which mount system the rider was built for

Earlier revisions listed this split as unexplained. The distribution is now mapped, off the
`cha_` record names in `ETC.BIN`, and it is not random — it separates the riders into exactly the
two mount systems:

| bank shape | models | what they ride in the retail game |
|---|---|---|
| `300 301 310` **`311`** `320 340` | `syu1` Hugo, `futi` Futch, `mstk` Franz, `mria` Sharon (partial) | the **three-pair table** — Fubar, Bright, Ruby |
| `300 301 310 320` **`321 322`** `340` | `syu2` Chris, `loll` Roland, `leoo` Leo, `psvl` Percival, `bols` Borus, `zkk1` knight NPC | the **assigned horse** (`s2um` / `zkum`), §11 |

The correlation is exact. The `311` family is precisely the three stock pair riders (plus Sharon);
the `321/322` family is precisely the models that carry an assigned horse in their list2 record —
Chris on 309, the four knights on 308, and `zkk1` getting 308 from a hard-coded case. Salome is not
a counter-example: `sarm` has no `3xx` bank at all, which is why §5 lists her field-only.

**What the clips are is still unknown** — only that a rider has one shape or the other, never both,
and that the shape says which mount system authored them. Two consequences worth having:

- It is a **structural** difference between the two rider families, not just a difference in which
  mount they happen to be paired with. Franz sits in the `311` family even though his mount (Ruby)
  is a horse, so the split is *not* flyer-vs-horse.
- It did **not** stop Chris+Bright. Chris is `321/322` — authored for the assigned-horse system —
  and she rides a pair-table flyer correctly (§4a). So the split is a reason to *test* a crossing,
  not a reason to predict it fails.

One anomaly, worth knowing before reading a test result as a bug: **Roland carries `341` where every
other full-bank rider carries `340`** (`b_rdatt_1`, the mounted attack). `cha_loll_341` exists and
`cha_loll_340` does not. If exactly one Zexen knight animates oddly while mounted, expect it to be
Roland, and expect it in the attack rather than the idle.

**Geddoe and Thomas can be shown mounted on the field but not in battle.** That is why the
editor's Mounts tab — which edits the *battle* pair table — keeps Geddoe out of its default rider
list: he would link to a mount and keep his normal battle pose. (He is offered behind an opt-in,
marked *won't animate*, so that prediction can be tested; see §4a.) The ten models with
`301/320/340` are exactly the tab's default rider list, justified by clip containment rather than
by bank presence.

And the mounts, split by whether they have a battle animation set (`1xx`/`14x`/`16x`/`18x`/`19x`):

| code | model ids | what | battle set? |
|---|---|---|---|
| `guli` | 8 | **Fubar** (griffon) | **yes** — 101 111 140 160 171 172 180 190 |
| `brit` | 32 | **Bright** (dragon) | **yes** — 111 140 160 171 172 180 190 201 |
| `mskr` | 42 | **Ruby** (Franz's horse) | **yes** — 111 140 160 171 172 180 190 201 |
| `msx1` | 277 / 359 | Le Buque horse | yes (140 160 171 172 180 190) |
| `mskn` | 147 / 209 | Le Buque named NPC/horse | yes (140 160 171 172 180 190) |
| `msx2` | 278 / 360 | Le Buque horse | no |
| `s2um` | 165 / 227 / 309 | **Chris's horse** | **partial** — `171` `b_N_damage`, `172` `b_down_start` |
| `zkum` | 164 / 226 / 308 | Zexen-knight horse | **partial** — same two clips |
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
**Yes — confirmed in-game, twice.** In battle it takes patching the three-pair table at ISO
`0x130384`–`0x1303B4` (eight 2-byte immediates, remembering the two duplicated delay-slot
constants). **Hugo + Bright** has been played through an emulator, and so has **Chris + Bright** —
which is the answer to the question this section originally hedged on: a rider whose mounted clips
were authored around a *horse* drives a *flyer* correctly. So both the patch and the riskiest-looking
rig crossing are evidence-backed. A substituted rider still only animates at all if their model
carries the `3xx` bank — Hugo, Futch, Franz, Chris, Borus, Percival, Leo, Roland, `zkk1` and
(partially) Sharon. Anyone else pairs up and then silently keeps their normal battle pose, because
`SetMotion` returns failure on the missing `0xB8`+ clips. Within the ten that do carry the bank,
one direction is still unplayed: a **flyer**-rigged rider on **Ruby**. See §4a for the grid.

Note also that the **formation menu does not show a re-paired pair** — it mounts in battle anyway
(§4).

On the field there is no pair check at all — an EDS `RideOn` will link any two EOBJs — but the
mount must be one of the eight whitelisted **horses** to get a correct saddle offset, and
there is no ground-ride entry for a griffon or dragon to borrow.

**Can Hugo ride on multiple maps? Can Chris?**

> **Superseded by §14 (2026-09-06).** The answer below reasons from *asset residency*, and
> playtesting has since shown that test is not decisive: Chris rides despite `s2um`
> appearing complete in no area archive. Read §14 instead — the question turns on which
> scenes issue a mount and what selects the horse, not on which archive names a model.
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

## 9. Which maps can actually mount — a disc census

**The area archives are uncompressed.** Dialogue is plain ASCII in `DATA/*.BIN`, and so are the
asset record names (`cha_/imf_/ctx_`) and the animation clip names. That makes a direct census
possible without a decompressor. Machine-readable output: [`s3_mount_areas.json`](s3_mount_areas.json).

Two independent signals were scanned across all 28 area archives:

- **Mount models** — `krum`/`kru2`/`zkum`/`s2um` (ground horses), `mskr`/`msx1`/`msx2`/`mskn`
  (Le Buque horses), `guli`/`brit` (flyers), `uma1` (scenery). `ground_complete` in the JSON
  means the archive carries the full `001/002/005/010/020/021` field ride set. That test is
  krum-shaped and deliberately does not fit `mskr`/`msx1` (party-character rigs) or the flyers.
- **Rider models with their `07x` bank** — the **field** half of the mounted animation set.
  `3xx` is the battle half; the same ten models carry both, plus `msk1`/`msk2`/`jyan`, which
  are field-only. `syu3` (Geddoe) has neither, in any archive.

| area | mounts present (**bold** = complete ground set) | riders with the `07x` field-mount bank |
|---|---|---|
| HGB1 · Yaza Plain (Budehuc gate) | **krum** | zkk1 |
| HNKT · Budehuc Castle | **krum**, brit, guli, mskr, msx1, uma1, zkum | bols futi jyan leoo loll mstk psvl syu1 syu2 zkk1 |
| KRVI · Karaya Village | **krum**, kru2, guli, zkum | loll zkk1 |
| ZKTR · Brass Castle | **zkum**, guli | bols leoo loll psvl syu1 syu2 zkk1 |
| MSVI · Le Buque | mskr, msx1 | msk1 msk2 mstk |
| TSVI · Chisha Village | mskr, msx1, guli | msk1 mstk psvl syu1 zkk1 |
| CRRA · Caleria | brit, uma1 | futi |
| YMMT · Mountain Path | brit | futi mstk |
| AKMT · Kuput Forest | s2um, zkum (single clip each) | — |
| VDZK · Vinay del Zexay | guli | bols leoo psvl syu2 zkk1 |
| LAST · Ceremonial Site | guli | syu1 syu2 zkk1 |
| LZVI · Great Hollow | guli | syu2 zkk1 |
| KSKR · Ancient Highway | guli | — |
| MORI · Zexen Forest | guli | — |
| AKVI, HGB2 | uma1 (scenery only) | — |
| DKVI, IKVI, ICEW, FAKE, HAKA, SOGE | — | riders bundled, no mount |
| CVIS, GDOP, KTDO, LKOE, RVER, SKBN | — | — |

**Only four archives ship a mount with a complete ground-ride set: HGB1, HNKT, KRVI (all `krum`)
and ZKTR (`zkum`).** Everything else is a flyer, a scenery horse, a party-character rig, or a
single stray clip.

Read this as **asset residency, not proof the game mounts you there**. A bundled rider model
carries its ride clips whether or not that scene ever uses them — which is why DKVI, IKVI and
friends list riders but no mount.

### Which units can be shown mounted in each mount-bearing area

Cross-referencing the mount models present against the riders whose ride clips are bundled in
that same archive. "full" = all six ground clips present; "partial" lists what is there.

| area | mounts bundled | units with ride clips there |
|---|---|---|
| **HGB1** · Yaza Plain (Budehuc gate) | Karaya horse | **Hugo** (full), Zexen knight NPC (full) |
| **HNKT** · Budehuc Castle | Karaya horse, Zexen horse, Ruby, Le Buque horse, Fubar, Bright | **Hugo** (full), **Chris** (full), Borus, Leo, Roland, Percival (full), Zexen knight NPC (full), Futch, Franz (partial), Juan (`074` only) |
| **KRVI** · Karaya Village | Karaya horse ×2, Zexen horse, Fubar | **Hugo** (full), Roland (full), Zexen knight NPC (full); Borus + Chris carry only the battle bank here |
| **ZKTR** · Brass Castle | Zexen horse, Fubar | **Chris** (full), Borus, Leo, Roland, Percival (full), Zexen knight NPC (full); Hugo partial (`074`) |
| **MSVI** · Le Buque | Ruby, Le Buque horse | Franz, Le Buque villagers 1 & 2 (partial + fly) |
| **TSVI** · Chisha Village | Ruby, Le Buque horse, Fubar | Percival (full), Zexen knight NPC (full), Franz + villager (partial), Hugo partial |
| **CRRA** · Caleria | Bright | Futch (partial) |
| **YMMT** · Mountain Path | Bright | Futch, Franz (partial) |
| **VDZK** · Vinay del Zexay | Fubar | Borus, Leo, Percival, Zexen knight NPC (full) |
| **LZVI** · Great Hollow | Fubar | Chris (full), Zexen knight NPC (full) |
| **LAST** · Ceremonial Site | Fubar | Chris (full), Zexen knight NPC (full), Hugo partial |
| **AKMT** · Kuput Forest | Chris's horse, Zexen horse (1 clip each) | Borus, Chris — battle bank only |

Two things worth noting. **Hugo is the only unit with the full ground set alongside a Karaya
horse** (HGB1, KRVI, and HNKT) — which is exactly the pair the EDS handler hard-codes (§3a).
And **the Zexen knight NPC `zkk1` is bundled ride-ready almost everywhere a mount is**, which is
what makes the Zexen cavalry scenes work without bundling five named knights each time.

Note also that "carries the clips" is still not "the script mounts them" — see the caveat above.

### What was tried and did not work

Scanning the archives for the `RideOn` opcode directly. The EDS interpreter reads a u16 opcode
from the script stream and indexes a 359-entry handler table at **`0x19828F8`**
(`opcode = (handler - 0x19828F8) / 4`), which gives **op 22 = `EdsCRideOnSetS`**,
**24 = `RideOffSetS`**, **108 = `HorseDashSetS`**, **109 = `HorseInanakiE`**; `RideOnSetS` is an
8-byte instruction (opcode, rider EOBJ, mount EOBJ, param record). Searching for that byte shape
is pure noise: MORI and KTDO, which contain no mount at all, return *more* even-aligned hits
(6,673 and 7,384) than HGB1 does (5,654). Locating the script blobs first would be needed to
make this work, and that was not done.

## 10. "Always mounted in those areas" — why it isn't an editor feature

The operation itself is small; §8 shows the debug build doing exactly it. The problem is where
to put it and what it can reach.

1. **There is no flag to flip.** Mounting is an *action*, invoked by a script opcode or by the
   (dead) debug handler. Making it happen automatically needs a per-scene or per-frame hook —
   new MIPS code plus a redirected call. Every code patch the editor ships today rewrites an
   existing instruction in place; this is a different class of change.
2. **It can only reach scenes that already assign a mount.** Both the debug toggle
   (`0x178ccc8`) and the party-warp code (`0x1777b98`) read the assigned mount from `+0x1bc`,
   and nothing writes it. See §10a — `+0x1bc` holds a **pointer to a live EOBJ**, so there is no
   constant to write into it, and it is populated by scene setup, which means precisely the
   places the game already intends you to ride.

### 10a. Why `+0x1bc` cannot be forced on — it is a pointer, not an id

> **Superseded by §14 (2026-09-06).** Everything below about the *type* of `+0x1bc` is
> correct — it is an EOBJ pointer with no literal writer. The conclusion drawn from that
> ("unforceable") is not. `0x180 + 0x3c = 0x1bc`, and `+0x3c` is the EOBJ pointer of an
> actor record: **`+0x1bc` is simply the `+0x3c` of the actor six slots along**, which is
> where the engine stages a character's assigned horse. It has no writer because it needs
> none — the generic actor setup fills it. What forces it on is staging that horse actor,
> and that *is* reachable from data. See §14.

> **Corrects an earlier note.** A previous revision said "the only two literal writers
> (`0x1712894`, `0x1713458`) clear the field-work global". Those two are on a **different struct
> that merely shares the offset** and has nothing to do with mounting — see below. The mount
> `+0x1bc` has no writer at all.

Scanning the whole `PT_LOAD` for a `0x1bc` immediate gives 16 instructions. Discarding `$sp`
frame slots and the floating-point ops leaves two distinct fields:

**(a) A global callback slot — unrelated.** `0x1712894` and `0x1713458` both store through
`lui 0x197 / addiu -0x5cf0` = the fixed global **`0x196A310`**, so they touch `0x196A4CC`. What
lives there is a **function pointer**: `0x17055A0` does `lw $v0, 0x1bc($s0)` immediately followed
by `jalr $v0`, and `0x1713450` is an unregister (`if (slot == arg) slot = 0`). Nothing to do with
mounting; the earlier note attributed these to the mount field by offset alone.

**(b) The mount field — on the per-character scene record.** Its base is the record returned by
`GetSceneCharaRecord` @ **`0x17b5a40`**, the same struct that carries `+0x3c` (the character's
EOBJ) and `+0x250` (the mount back-pointer of §1). Running the struct mapper over all **186** call
sites of that accessor:

```
  +0x3C   {'lw': 79}          <- EOBJ pointer      : 79 reads, 0 writes
  +0x1BC  {'lw':  1}  @ 0178CD18   <- assigned mount : 1 read,  0 writes
  +0x250  {'lw':  4}          <- mount back-pointer : 4 reads,  0 writes
```

**It holds a pointer.** Three independent confirmations:

1. It is `lw` (32-bit), and it is passed straight through as `$a1` to `RideOn` @ `0x179ec68`,
   which forwards it to `RideLink(riderEobj, mountEobj)` @ `0x16e84c0` and to a flag helper
   (`0x179ebe0` → `0x16e7b18`) that dereferences it.
2. In the party-warp reader the zero-fallback is `beql $s0, $zero, …` with `lui $s0, 0x19c` in
   the delay slot — the substitute value is a global **address**, so the field is address-typed.
3. The loaded value is then handed to the same two calls (`0x17b6b28`, `0x177da48`) that the
   surrounding code makes for `$s3`, a known live object.

So there is no immediate that could be written here, or substituted at the read site, that would
be a valid mount: the value has to be the address of an EOBJ the scene actually allocated, which
differs every scene and does not exist at all in a scene with no horse. A fabricated pointer is
dereferenced by `RideLink` on the next instruction — a crash, not a mount. **This closes the
question as a negative rather than leaving it open: the field is unforceable by constant rewrite,
which is also why no writer exists — you cannot store a pointer as an immediate.**

### And the field ride path has exactly one live caller

`RideOn` @ `0x179ec68` has **two** callers in the whole ELF:

| caller | what it is |
|---|---|
| `0x178cd24` | the **dead** debug-menu Toggle Mount handler (§8) — no caller of its own |
| `0x179ee4c` | the **EDS `RideOn` opcode** handler |

So on the field, a script opcode is the only thing that ever mounts anybody, which is §3a from the
other direction. Reviving the debug handler would not help either: it reads `+0x1bc`, so it needs
the same pointer nobody can supply.

`RideLink` itself has four callers — `0x179ec10` (the field path above) and three inside
`Mount()`'s region at `0x17de814` / `0x17de9cc` / `0x17deaf0`, the **battle** path. That is the
asymmetry that matters: battle `Mount()` links two **battle slots**, objects the engine has
already built for deployed party members, so it needs no scene-supplied pointer. Which is exactly
why **Ruby in the pair table is forceable and an assigned horse is not** (§11).

Net: such a hook would keep you mounted across scripted dismounts inside the four areas that
already mount you. It cannot add mounting to a map that has no mount in it — the same wall
§7 and §8 hit from two other directions.

## 11. The *other* mount system — a per-character assigned horse

> **Corrects §5/§6.** Those said the ground horses have "no battle animation set at all". By
> exact clip containment they have exactly two — `171` = `b_N_damage`, `172` = `b_down_start` —
> which is precisely what a *passive* battle mount needs: react when hit, fall when knocked
> down. They never attack or cast, which is why they lack the `101/140/160/180` that Fubar,
> Bright and Ruby carry. Chris genuinely does fight mounted.

The three-pair table in §4 is not the only gate. Both call sites evaluate

```
hasAssignedHorse(charaId) || isValidRidePair(rider, mount)
```

and the first half (`0x16c76b8`) is **pure data**. It fetches the character's record and reads a
u16 at **`+0x66`**:

```
rec = GetCharaRecord(charaId)              ; 0x16c6e18
if (charaId == 203) return 0               ; s2hr explicitly excluded
v = rec->0x66
return (v - 308) < 2 ? v : 0               ; ONLY 308 / 309 are honoured
```

`GetCharaRecord` indexes a byte table at `0x19697A8 + modelId` to get a row number, then
`0x1999B38 + row*0x84`. That row number is the **roster id**, and that table is the editor's
existing **list2** — so the field is simply:

**`list2 record N, +0x66, u16` — ISO `4068152 + N*132 + 102`.**

It sits just past the starting-level bytes at `+100/+101` and was undocumented. Read off the
disc, exactly six characters carry one:

| roster | character | value | ISO offset |
|---|---|---|---|
| 2 | **Chris** | 309 — her own horse (`s2um`) | `0x3E14A6` |
| 12 | **Roland** | 308 — Zexen-knight horse (`zkum`) | `0x3E19CE` |
| 17 | **Leo** | 308 | `0x3E1C62` |
| 19 | **Percival** | 308 | `0x3E1D6A` |
| 20 | **Borus** | 308 | `0x3E1DEE` |
| 39 | **Salome** | 308 | `0x3E27BA` |

The six Zexen Knights, exactly. Two code-side extras: the generic knight NPC `zkk1` (306) gets
308 from a hard-coded case when it has no record, and `s2hr` — a Chris variant that *shares her
record*, hence the same 309 — is explicitly rejected regardless.

### Why this is the better lever

Compared with the three-pair table it is strictly more capable, and it is the mechanism behind
"Chris rides her horse in some battles":

- **Plain data.** One u16 per character, no instruction rewriting, no delay-slot duplicates.
- **No party membership needed.** The pair table draws its candidate from the party roster, so a
  mount must be a recruitable character. `zkum`/`s2um` are ordinary NPC models, so this route
  sidesteps that entirely.
- **Both paths honour it.** Field ride and battle mounting both consult it.
- **It reaches Geddoe.** He has the `97x` field bank but no mounted-battle bank, so the pair
  table can never help him — but an assigned horse puts him on horseback outside combat.

### …and the matching limitation: what it does *not* reach

> **Corrected 2026-09-06.** This section used to be titled "it grants permission, it does
> not stage a horse", and that headline was wrong. `+0x66` **does** stage the horse: the
> party-put path reads it and inserts the horse at party position `pos + 6` (§14). The
> real limitation is narrower and is stated below — the horse still has to be a *model the
> area archive carries*, and a script still has to issue the mount.

The same property that gives this route its reach takes away its reliability, and the two routes
fail in exactly opposite ways:

| | pair table (§4) | assigned horse |
|---|---|---|
| mount must be a recruited character | **yes** | no |
| mount holds a battle slot of its own | **yes** | **no** |
| fires from party membership alone | **yes** | no — the scene must stage the horse |
| reaches a non-recruitable mount | no | **yes** |
| reaches a rider with no `3xx` bank | no (pairs, then no animation) | **yes**, on the field |

`Mount(riderSlot, mountSlot)` links two **slots** in the 14-entry battle array, and the pair path
gets its candidate by walking party members (`0x17dede4`). A recruited mount therefore always has
somewhere to be, which is why a re-paired Chris+Bright fires in any battle with both deployed and
needs no scene support at all — that is what the 2026-08-31 test showed.

`zkum`/`s2um` hold no slot. `+0x66` says the character *may* be mounted; something still has to put
a horse in the scene. That is the `+0x1bc` question in §10 — the per-object assigned mount, which
no code path writes with a literal offset — and it is why Chris rides in some battles and not
others despite her record having said 309 the whole time.

**Practical consequence.** Setting `+0x66` on a new character makes them eligible wherever the game
already stages a horse; it cannot add a horse to a fight that has none. To *force* a horse mount in
battle from the editor as it stands, the route is **Ruby in the pair table** — she is a Star of
Destiny with a full battle bank, so she brings her own slot. Whether the `zkum`/`s2um` path could be
forced at all depends on what populates `+0x1bc`, which is **not established** (see the closing
list); it is not something a constant rewrite can reach today.

The hard limit is the consumer's own clamp: `(v - 308) < 2` unsigned means **only 308 and 309
work**. Writing the Karaya horse, Ruby or a flyer here is read and silently discarded, so the
editor offers exactly three options.

## 12. How a mounted pair works in battle

### HP is per-half. There is no shared pool.

The single entry point for every HP change is `0x16c8670(charaPtr, mode, amount)`:

```
cur = *(u16*)(ptr + 0x30)      ; current HP
max = *(u16*)(ptr + 0x32)      ; max HP
mode 0 : cur = min(cur + amount, max)          ; heal
mode 1 : cur = (cur < amount) ? 0 : cur-amount ; damage, clamped at 0
mode 2 : cur = min(amount, max)                ; set
mode 3 : (read only)
*(u16*)(ptr + 0x30) = cur
```

It takes **one** `charaPtr`, and the chain that produces it —
`slot → 0x181b738 → 0x17dc568 (btlRec->0xc) → 0x17bbb20` — contains **no rider/mount
indirection at any step**. So a hit resolves against exactly one half's HP bar. Rider and mount
keep separate pools, and the same is true of every other stat: nothing in the lookup path
substitutes one for the other.

That matches the roster data — Fubar, Bright and Ruby each have their own HP growth curve,
their own skill caps and their own fixed head rune.

### What the pairing actually does

`Mount(riderSlot, mountSlot)` @ `0x17de7b8` links two slots in the 14-entry battle array
(`btlWork + 0x500 + slot*0x630`) and flags them **asymmetrically**:

| | `rec->0x600` | `rec->0x602` | flags set | flags cleared |
|---|---|---|---|---|
| rider | mount's slot | `-1` | `0x00080000`, `0x40000000` | `0x00008000` |
| mount | `-1` | rider's slot | `0x00100000`, `0x80000000`, `0x00008000` | — |

Accessors `GetMountOf` (`0x17de718`) and `GetRiderOf` (`0x17debf0`) return the partner slot or
`-1`, and are consulted from ~48 sites.

### Effects propagate rider → mount

In the damage/effect path at `0x188a2e0` the engine walks the target list (`count` at `+0xb2`,
a `0x14`-stride array at `+0xb8`) and calls `0x17fc8b8` on each target. That helper does:

```
mount = GetMountOf(target)
if (valid(mount) && testFlag(mount, 0x400))  setFlag(mount, 0x8000)
if (testFlag(target, 0x400))                 setFlag(target, 0x8000)
```

— i.e. a flag landing on a rider is explicitly mirrored onto its mount (battle-record word
`+0x30`, a different word from the one `Mount` writes). Since the horses carry exactly
`b_N_damage` and `b_down_start` and nothing else, the obvious reading is that this is what makes
the horse react and fall when its rider is hit. **That is an inference from the clip inventory,
not proven** — the propagated bit is a flag, not HP, and HP is demonstrably not shared.

Death while mounted has its own state machine, separate from the normal death path:
`CHARA_DEAD_HORSE_START / INIT_END / END_START / END` at `0x17ee7e0`.

### Editing the stats

Nothing new is needed. **Fubar (roster 8), Bright (31) and Ruby (37) are ordinary roster
entries** with their own list1 record (starting stats, equipment, rune slots — Fubar's head rune
is Shining Wind, Bright's Spreading Flame, Ruby's Shining wing) and their own list2 record
(growth rates, the 43 skill caps, starting level). All of that is already editable in the
**Characters** and **Growth** tabs, and because the stat path never redirects across the pair,
what you set there is what that half uses. They have no weapon level, which is what marks them
as mounts rather than fighters.

### Not established

- Whether both halves can be independently *targeted* by the player, or whether the UI presents
  the pair as one unit. Flag `0x00008000` is cleared on the rider and set on the mount by
  `Mount`, which smells like a targetable/selectable bit, but its meaning was not confirmed.
- The meanings of `0x00100000`, `0x40000000`, `0x80000000` (set by `Mount`) and of `0x400` /
  `0x8000` in battle-record word `+0x30`.
- Whether a mount dying forces the rider off, or vice versa.

## 13. How stats combine when a unit mounts another

There is **no blanket multiplier**. Instead the engine has a handful of hand-written,
per-mechanic combining rules, and the base stats are not among them.

### HP is pooled and re-split — the one exact formula

Immediately after `Mount()` succeeds (`0x17df724`), and only when the battle mode
(`0x17bb538`) is **2**, the code at `0x17df744` does this:

```
combinedCur = curHP(rider) + curHP(mount)          ; 0x181b760(slot, 3, 0)
combinedMax = maxHP(rider) + maxHP(mount)          ; 0x181b7a0(slot, 3, 0)

rider = min( combinedCur * maxHP(rider) / combinedMax + 1, maxHP(rider) )
mount = min( combinedCur * maxHP(mount) / combinedMax + 1, maxHP(mount) )
```

Both are written back with **mode 2 = SET**. Verified instruction by instruction, including the
R5900 second-pipeline ops that compute the two shares in parallel:

| addr | encoding | meaning |
|---|---|---|
| `0x17df7c8` | `02113018` | `mult $a2,$s0,$s1` -> combinedCur x riderMax |
| `0x17df7d0` | `72028018` | `mult1 $s0,$s0,$v0` -> combinedCur x mountMax (pipeline 1) |
| `0x17df7e4/ec` | `div`/`mflo` | / combinedMax -> rider's share |
| `0x17df7e8/f0` | `div1`/`mflo1` | / combinedMax -> mount's share |

So **mounting equalises the pair's HP *percentage***. It is a redistribution, not a merge: if
Hugo is at full and Fubar is nearly dead, mounting leaves both at the same fraction of their own
maximum. Total HP is conserved, plus the `+1` rounding sweetener on each side.

**This is directly editable today, and it is the lever that matters.** The split is weighted by
each half's **max HP**, so changing a mount's HP growth curve in the **Growth** tab changes how
much of the pair's pool that half carries -- and therefore how much damage the pair absorbs
before either half drops.

### Damage itself is not combined

`0x16c8670` still takes a single `charaPtr` with no rider/mount indirection (see the section
above), so an incoming hit reduces exactly one half's HP. The pooling happens *at mount time*,
not per hit, and nothing re-balances the pair again once the fight is under way.

### Other combining rules found

| mechanic | rule | where |
|---|---|---|
| **Adrenaline Power** (skill `0x27`, "Death's Door") | `riderProc + mountProc` -- each half rolls independently and the results are **summed**, giving 0/1/2 | `0x181b470` |
| unidentified property `0x9e` | **OR** across the pair -- true if either half has it | `0x181b4f0` |
| three fields of the action block (`btlRec->0x628` `+0xa2`, `+0xa4`, `+0xa6`) | rider's values **plus** the mount's, with `+0xa2` **halved** on both sides | `0x1819a70` |
| base stats (PWR/SKL/MAG/...) | **not combined** -- the stat path never redirects | previous section |

The third row is the one I could not name. `+0xa4` is elsewhere set to `0x28` (40) and can be
zeroed by a gate at `0x1815650`, and the routine ends up computing `s5 + s4` from the summed
values. The shape -- a base value plus a halved second value, contributed by both halves --
reads like a movement or reach budget (a horse carries you further), but **that is a guess and
is not established**.

### Summary

- **HP**: pooled at mount time and re-split in proportion to each half's max HP. Editable via
  the mount's HP growth.
- **Damage**: lands on one half only.
- **A few specific skills/params**: summed, one halved, one OR'd.
- **Everything else**: each half uses its own numbers.


## 14. Forcing field horse mounting — the handle bit, and what actually blocks it

Added 2026-09-06, after [`Editor/eds_dis.py`](../Editor/eds_dis.py) recovered the EDS
encoding that §9 lacked. It supersedes §10a's "unforceable" verdict and corrects §11.

### 14a. Handle bit `0x4000` means "that actor's own horse"

The actor-handle decoder `0x17B5A40` is documented in
[`FIELD_CHARACTER_RESEARCH.md`](FIELD_CHARACTER_RESEARCH.md) as a namespace split on bits
10–13. Bit **14** is separate, and it is the whole field mount system:

```
017B5A7C  andi $v0, $s0, 0x4000
017B5A84  andi $s3, $v0, 0xffff      ; remembered across the namespace dispatch
   ...
017B5BA0  addiu $v0, $s2, 0x180      ; $s2 = the resolved actor record
017B5BA4  movz  $v0, $s2, $s3        ; bit clear -> the record itself
```

Actor records are **`0x40` bytes** — `MakeActorRecord` @ `0x1775AA0` does
`bzero(rec, 0x40)` then writes `+0x06 = charId`, `+0x01 = 4`, `+0x02 = 0x13`. So
`0x180 = 6 × 0x40`, and **`handle | 0x4000` resolves to the actor six slots later**.

That is the actor block's reserved range: party actors occupy 0–5 and their mounts 6–11,
which is exactly the window `FindActorByCharId` declines to search (`i - 6 <u 6`). It also
retires §10a: `+0x1bc` is `0x180 + 0x3c`, i.e. the `+0x3c` EOBJ pointer **of the mount
actor**, not a mystery field. The one instruction that reads it (`0x178CD18`, the dead
debug toggle) is asking "does the actor six slots along have an EOBJ yet".

### 14b. `+0x66` stages the horse — §11's headline was wrong

Two functions close the loop, and neither needs a scene-supplied pointer:

```
HorseActorPos(partyPos)                         ; 0x16FFEE0
    if ((partyPos - 1) <u 6)                    ; real party positions only
        if (hasAssignedHorse(charAt(partyPos)))  ; 0x16C76B8 -> list2 +0x66
            return partyPos + 6
    return 0

PartyPut(charId, pos)                           ; 0x16FF8xx
    s2 = hasAssignedHorse(charId)
    place(charId, pos)
    if (s2) place(s2, 1, pos + 6)               ; 0x16FFAB4 — the HORSE, at pos+6
```

and `StageActor` @ `0x1791B58` then recurses into that position to build the horse as a
real actor (`0x16FFEE0` → `0x16FFCA8` → `MakeActorRecord`). Its teardown twin at
`0x1791DF0` is the tell: on `hasAssignedHorse`, it also tears down `rec + 0x180`.

So `+0x66` is not a permission flag that waits for a scene to cooperate. **It is the switch
that makes the horse exist**, and it is one u16 of ordinary list2 data.

### 14c. The scripts already say "mount the player on their own horse"

`RideOn(h, h | 0x4000)` — self-mount — needs no chain validation to find: requiring
`param2 == param1 | 0x4000` with a valid namespace is a coincidence in the millions, which
is why this finds signal where §9's raw opcode search found only noise.
`python3 Editor/eds_dis.py rides` reproduces it. **136 self-mounts in `town` scripts**, and
the rider is the *player* in four areas:

| area | `RideOn(PLAYER, PLAYER.mount)` | complete ground horse in that archive |
|---|---|---|
| **ZKTR** · Brass Castle | **58** | `zkum` **308** ✔ |
| **MORI** · Zexen Forest | 10 | none (`guli_005` only) |
| **VDZK** · Vinay del Zexay | 9 | none (`guli_005/080` only) |
| **HNKT** · Budehuc Castle | 3 | **`krum` 325** ✔ |

The rest are `objA:N` self-mounts — staged scene NPCs — in ZKTR (17), LZVI (16), KRVI (7),
SOGE (4), AKMT (3), HNKT (3, plus one `charId:2`), MORI (1), VDZK (4).

They are unambiguously code. The Budehuc block at ISO `0x903B401A` mounts the player and
three scene objects, then drives them with `op 157` moves carrying round coordinates and
speeds — and the moves address `0x5400`, i.e. **the player's horse**, because when you are
mounted the thing that walks is the mount:

```
903B401A  op  22 RideOnSetS  [0x1400 0x5400 0xfffe]   PLAYER  PLAYER.mount
903B4022  op  22 RideOnSetS  [0x0801 0x4801 0x0017]   objA:1  objA:1.mount
903B403A  op 155             [0x000f 0x4052]
903B4064  op 157             [0x5400 0x000f 0x0000 0x04b0 0x0002 0x0a8c]  PLAYER.mount …
903B407A  op 157             [0x4801 0x5400 0x0000 0x05dc 0x0003 0x012c]
```

`actor_str` used to print `0x5400` as a bare `PLAYER`, hiding the bit; it now suffixes
`.mount`.

### 14d. What blocks Hugo — and why nothing blocks Chris

> **Corrected 2026-09-06, same day, by playtest report.** An earlier revision of this
> section argued that Chris never rides because `s2um` is not resident in any area archive.
> **She does ride** — confirmed from play, in Brass Castle and elsewhere — so the model
> loads fine and the residency argument was wrong. The `cha_` census in §6 measures what an
> archive *names*, which is evidently not the same as what a scene can *load*. Hugo
> likewise already rides in the plains from chapter 3–4. Nothing is broken; "sometimes"
> simply means "the scenes that contain the instruction". The lever that survives is
> §14e, and it is about Hugo, who has no assigned horse at all.


The asymmetry between the two is one byte. **Chris carries `+0x66 = 309` and Hugo carries
`0`** — so Chris has a horse staged beside her in the party actor block on every map, and
Hugo has none. His plains riding comes the other way, from scenes that stage a `krum` as a
scene object and name it explicitly in `RideOn`; that is why it is confined to the scenes
that were built for it.

The clamp is what stops him being given one properly:

```
016C76E4  lhu   $a1, 0x66($v1)
016C76E8  addiu $v0, $a1, -0x134     ; -308
016C76EC  sltiu $v0, $v0, 2          ; 308 or 309, nothing else
```

308 is `zkum` and 309 is `s2um` — the two Zexen horses. **Hugo's horse is `krum`, 325**, and
the engine says so itself: the `RideOn` handler at `0x179ED2C` carries a fix-up written for
exactly one pair, rider model **1** on mount **325**/**353**, stripping the Fubar-rigged
copies of `ride_neutral`, `rdwalk*` and `rdrun*` from his clump so the horse-rigged ones
resolve (§3a). Hugo is authored for the Karaya horse and no other, and 325 is on the wrong
side of the clamp.

### 14e. The lever: give Hugo an assigned horse

Widen the clamp, then set `+0x66 = 325`. Six sites, all the same `sltiu rX, rY, 2`, each
preceded by `addiu rX, rY, -0x134`:

| ISO | bytes | function |
|---|---|---|
| `0x10EEEC` | `02 00 42 2C` | `hasAssignedHorse` |
| `0x10EF0C` | `02 00 63 2C` | `hasAssignedHorse`, second path |
| `0x146EDC` | `02 00 42 2C` | party helpers |
| `0x14711C` | `02 00 42 2C` | party helpers |
| `0x1471A8` | `02 00 42 2C` | `PartyPut` position 7–12 guard |
| `0x14762C` | `02 00 42 2C` | party helpers |

The immediate is the low u16, little-endian in the first two bytes of the word — the same
shape the Mounts tab already edits. Raising it to `0x100` admits 308–563, bringing in
`krum` 325, `kru2` 353, `msx1` 359, `msx2` 360. Then Hugo's `+0x66` (ISO `0x3E1422`,
currently `00 00`) becomes `45 01`.

He then carries a Karaya horse in the party actor block the way Chris carries hers, instead
of only where a scene stages one — so every player self-mount site (§14c) reaches him,
including the three in Budehuc Castle.

The clamp patch is inert on its own: only six characters have a nonzero `+0x66` today, all
308/309, every one of which stays inside the widened window.

**MEASURED, not inferred (2026-09-06).** That last sentence used to be a reading of the
`STOCK` map rather than of the disc, and the editor's *Party formation* restore rests on it:
zeroing the other 74 records is only safe if they really are zero. All 80 `list2` records were
walked on a pristine `SLUS-20387` and **exactly six carry a nonzero `+0x66`** —

| rec | ISO | value | who |
|---|---|---|---|
| 2 | `0x3E14A6` | 309 | Chris, her own horse (`s2um`) |
| 12 | `0x3E19CE` | 308 | Roland |
| 17 | `0x3E1C62` | 308 | Leo |
| 19 | `0x3E1D6A` | 308 | Percival |
| 20 | `0x3E1DEE` | 308 | Borus |
| 39 | `0x3E27BA` | 308 | Salome |

— i.e. the six Zexen Knights and nobody else, matching `MOUNTS.horse.STOCK` value for value.
`web/tests/party-fix.mjs` re-runs that walk against the disc in `ISO/` on every test run, so
the claim cannot rot into prose again.

### 14f. Why this is the first thing to check when the party stops forming

`HorseActorPos` and `PartyPut` above are the whole reason: a character with an assigned horse
does not merely *become mountable*, they **consume a party-list position** — theirs, plus
`pos + 6` for the horse. Party actors are 0–5 and their mounts 6–11, so handing horses out
changes how many of positions 7–12 are already occupied before anything is added, and the
game then has to stage and load each one in every area.

Three consequences worth stating, because each one shows up as a different complaint:

1. **It is disc state read at party-build time**, so a save that forms a party correctly on a
   pristine disc need not on a patched one — which is exactly the shape of the report this
   section was extended for.
2. **It is also save state.** The party list is written when the party is *built*, so a list
   formed on a patched disc keeps its staged horses after the disc is put back. Re-form the
   party in game.
3. **The clamp is not separable from it.** Three of the six clamp sites are party helpers and
   the fourth is `PartyPut`'s own 7–12 guard, so the two have to be checked and restored
   together — which is why the editor's card treats them as one repair.

The editor exposes all of this on the **Changes** tab's *Party formation* card: every site
checked against the stock value pinned above, with no base disc needed, and a one-click
restore. See `README.md`.

**The 308 shortcut, and why not to take it.** Hugo could be given 308 with no code patch at
all, since it is already inside the clamp. Predicted failure: the `0x179ED2C` fix-up fires
only for mount 325/353, so on `zkum` it would not strip his Fubar-rigged duplicates and the
clump's clip lookup would resolve `ride_neutral`/`rdwalk*`/`rdrun*` to the griffon-rigged
copies — Hugo sitting on a horse in a griffon pose. That is a cheap, falsifiable test of
whether the strip does what §3a says, and a bad way to actually ship him a horse.

### 14f. What this does not reach, and what is still unplayed

**Where Hugo can be mounted at all is fixed by asset containment, and it is three areas.**
Scanning `cha_syu1_9??`/`cha_syu1_0??` against `krum`/`kru2` across every archive:

| archive | Hugo's ground-ride bank | Karaya horse | chapters its scripts cover |
|---|---|---|---|
| **HGB1** · Yaza Plain | `970 971 972 973 974 975` — the only **complete** set on the disc | complete | **no chapter tags** |
| **HNKT** · Budehuc Castle | `970 971 972 973 974` | complete | 0, 1, 2, 3, 4, 6 |
| **KRVI** · Karaya Village | `970 971 972 973 974` | complete | 1, 2, 3, 5 |

Everywhere else he carries `074` alone — `ride_neutral`, one seated pose, no mount-up, walk
or run — so no script could mount him usefully there.

The chapter column comes from scene id tags of the form `<chapter><AREA><nnn>`
(`3KRVI002`, `1HNKT001`), one chapter per `town` sub-file. That is what "he rides in some
chapters" is: the area ships a different script per story state. Note the gaps — **no
chapter 5 in Budehuc, no chapter 4 in Karaya**. HGB1 carries no tags and is not
chapter-partitioned, consistent with it being the area you ride *into*.


- **MORI and VDZK** hold 19 player self-mounts between them and **no complete ground horse
  in either archive**. Those need a model added to the archive, which is the repacking
  blocker in [`ETC_BIN_MODEL_RESEARCH.md`](ETC_BIN_MODEL_RESEARCH.md), not a constant.
- **HGB1 and KRVI** carry a complete `krum` but **no player self-mount at all** (KRVI's
  seven are `objA:N`). Reaching those means editing a rider handle in a script from
  `objA:N` to `0x1400`, an in-place u16 — cheap, but it takes the horse away from the NPC
  the scene staged it for.
- **None of §14 has been played.** It is static analysis over the ELF plus a disc census.
  The specific thing to watch on a first test is whether a mounted player breaks the
  scene's own choreography, since the `op 157` moves target `PLAYER.mount` and will now
  find one.
- **The `rides` census undercounts, and the missing form is now confirmed in the wild.**
  `RideOn(h, 0)` is a second self-mount spelling: the handler at `0x179ED10` defaults a zero
  mount operand to `rider + 0x180`. `cmd_rides` only matches `h | 0x4000`, so 136 is a floor.
  Chain-validating the zero form finds four `RideOn(PLAYER, 0x0000)` in SOGE (§14i); a bare
  pattern scan cannot, because `op 22` followed by a zero word is indistinguishable from
  filler. `RideOff` needs no self-mount form at all — it reads the partner off the rider.
- **§6's archive census measures naming, not loadability.** Chris rides despite `s2um`
  appearing in no area archive as a complete set, so a scene can evidently load a model the
  `cha_` scan does not attribute to it. Every residency argument in this document is
  weakened by that and should not be used to predict that something *cannot* appear.
- Whether the clamp's six sites are the *only* 308/309 gates. They are the only
  `addiu −0x134` / `sltiu` pairs in `PT_LOAD`, but a gate written some other way would not
  show up in that scan.


### 14g. Chris's areas, and the `070` signature

Same containment test as §14f, for `syu2` and the two Zexen horses. Her ground-ride bank is
the `07x` family (§5): `070` = `rideon_L/R` mount-up, `071` walk, `072` fastwalk, `073` run,
`074` `ride_neutral`, `075` `rd_inanaki`.

| archive | Chris's `07x` | ground horse in the same archive | chapters |
|---|---|---|---|
| **ZKTR** · Brass Castle | `070 071 072 073 074 075` | **`zkum` complete** | 0, 1, 2, 3, 4, 5 |
| **HNKT** · Budehuc Castle | `070 071 072 073 074 075` | **`krum` complete** (`zkum` only `172`) | 0, 1, 2, 3, 4, 6 |
| **LZVI** · Great Hollow | `070 071 072 073 074 075` | none (`guli_005` only) | 0, 1, 2, 3, 4, 5 |
| **VDZK** · Vinay del Zexay | **`070` only** | none | 1, 2, 3 (+3 untagged) |
| **LAST** · Ceremonial Site | `071 072 073 074 075` — **no `070`** | none | 0, 5 |
| **ICEW** | `071 072 073 074 075` — **no `070`** | none | 0, 5 |

**The presence or absence of `070` tells you what an area is for**, and it corroborates the
persistence result independently:

- **`071–075` without `070`** (LAST, ICEW) — every ride clip *except* mounting up. You
  cannot mount there; you can only arrive already mounted and keep riding. That is the same
  shape as HGB1 for Hugo, arrived at from clip containment rather than from play.
- **`070` alone** (VDZK) — mount-up and nothing else: you get on and the scene takes you
  out. VDZK also holds **9** `RideOn(PLAYER, PLAYER.mount)` sites (§14c), the second-highest
  on the disc, which is exactly what that clip set implies.
- **The full set** (ZKTR, HNKT, LZVI) — mount, ride and dismount locally.

So Chris is bundled ride-ready in **six** areas to Hugo's three, but only **two** of them
carry a ground horse: Brass Castle and Budehuc Castle. The other four depend on her arriving
mounted, or on a horse the area archive does not name.

### 14h. Settled from the save corpus: the party list carries the mount, and `ETC.BIN` loads

The five extracted saves in `Saves/_extracted_s3/` confirm §14b directly. `gamedata` and
`gamedata_u04` hold the party **Hugo, Fubar, Chris, Geddoe, Thomas, Emily** and a **309** at
party position **9**. Chris is at position **3**. That is `pos + 6`, on disc, in a real save
— the layout `PartyPut` writes and the layout handle bit `0x4000` reads.

So the party table at save `0x3216` is **twelve** u16s, not six: positions 1–6 are the
members and 7–12 are their mounts. `s3save.decode_party_mounts` reads them and the save
editor shows them in a Mount column.

**And it answers the `ETC.BIN` question below: Chris is on `s2um`.** Not `zkum`, not `krum`
— the exact model her `+0x66` names, whose only complete copy is in `ETC.BIN`. A model can
therefore be staged from `ETC.BIN` without the area archive naming it, so **the per-area
`cha_` census is not a ceiling**. Every "ships in / does not ship in" statement in this
document is about what an archive *names*; it cannot be used to predict that a model will
not appear. The `krum` duplication argument below is wrong, or at least not decisive.

That widens §14f considerably: Hugo's three areas are where his ride clips and a Karaya
horse are *bundled together*, not necessarily the only places he could be mounted.

---

**Superseded — kept for the reasoning.** Whole-ISO scans place a
complete `s2um` — Chris's own horse, and the value in her `+0x66` — **only** in `ETC.BIN`,
plus a single stray `cha_s2um_172` in AKMT. She demonstrably rides, so either `ETC.BIN` is
reachable at run time or she is riding `zkum`/`krum` in practice. Two observations pull in
opposite directions and neither settles it:

- *Against* `ETC.BIN` being resident: `krum` is duplicated into HGB1, HNKT and KRVI even
  though `ETC.BIN` already holds a complete copy. Duplication is pointless if the master is
  always loaded.
- *For* it: `ETC_BIN_MODEL_RESEARCH.md` describes bundle 0 as the **shared** field/character
  bundle, holding `syu1`/`syu2`/`syu3` together.

Until that is settled, every residency claim in this document is a statement about what an
archive *names*, not a proof of what a scene can *load* — see the warning in §14f.


### 14i. What the herb pickup shows — the remount is generic, and it is guarded

Reported from play 2026-09-06: while Chris is mounted, picking up a herb makes her **dismount,
take the herb, and remount**. Follow-up test, same source: doing it **on foot does not mount
her**. Both halves matter.

**The remount is generic, and that is the useful half.** A herb pickup is reusable script; it
cannot know which scene object is her horse. Neither opcode needs to be told:

- `EdsCRideOffSetS` @ `0x179F534` resolves only the **rider**, then reads the mount straight
  off it — `lw $s5, 0x3c($s6)` then `lw $s1, 0x250($s5)`. Its second operand is a flag, not a
  mount. That is why §14c's self-mount census found no `RideOff` self-mounts: the form is
  unnecessary.
- `RideOn` accepts a **zero** mount operand and defaults to `rider + 0x180` (`beqz $s1` at
  `0x179ED10`). Confirmed in the wild by this hunt: **four `RideOn(PLAYER, 0x0000)` in SOGE**,
  chain-validated. This is the second self-mount spelling §14f recorded as an undercount.

So the whole dismount/remount cycle runs off `rider + 0x180` — the actor six slots along,
exactly what `+0x66` stages (§14b). The herb cycle is therefore the first **behavioural**
confirmation that the assigned-horse path works in ordinary play; everything before it was
static analysis plus save bytes.

**The remount is guarded, and that closes a shortcut.** The obvious hope was that the pickup
remounts unconditionally, which would have made any herb a free mount trigger for anyone with
`+0x66`. It does not: on foot, a pickup leaves you on foot. The script is
`if RIDE(player) { RideOff; …; RideOn }`, and the guard is the EDS conditional at
`0x177BDD0`, subcommand `0x28`:

```
0177BE60  lw   $v1, 0x3c($s1)      ; rider EOBJ
0177BE64  lw   $v0, 0x250($v1)     ; its ride partner
0177BE6C  sltu $v0, $zero, $v0     ; RIDE  = (partner != 0)      ISO 0x1C366C, 2b100200
```
(subcommand `0x29` is `NORIDE`, the negation.)

**Do not reach for that instruction yet.** Forcing `RIDE` true — `addiu $v0, $zero, 1` at
`0x1C366C` — would make the pickup's guard pass, but it lies to *every* script that asks
whether the player is mounted, and the dismount half would then run against no mount:
`0x179F58C` loads a null partner and hands it straight to `0x17B5E20`. That is a plausible
crash in exactly the case the patch exists to create, and the clean route (`+0x66` plus a
scene that already mounts the player, §14c) is still untested. Recorded so the option is
known, not because it is advisable.

**The herb routine itself was not located.** There is no `RideOff(PLAYER, …)` in any town
script, so it almost certainly addresses the player as **slot 0** — and `op 24` followed by a
zero word is indistinguishable from zero-fill, the same false-positive class that defeated
§9's raw opcode search. Pattern matching cannot find it. Narrowing needs the area and chapter
the pickup was seen in, which reduces the haystack to one town sub-file.


### 14j. The herb pickup, decoded

Located, after the play report narrowed it to **Zexen Forest (MORI), Chris's first chapter**.
The routine repeats **28 times** across MORI's town sub-files, and six instances compared
byte-for-byte are **identical in 26 of 27 halfwords** — one routine, stamped out per pickup:

```
0037 0028 1400 fffd      op 55  Cond(0x28 = RIDE, PLAYER)   <- the guard
00ff fffc 0000           op 255                             <- the branch that consumes it
0071 5400 0002           op 113 (PLAYER.mount)
0018 1400 0002 fffe      op 24  RideOffSetS(PLAYER, 2)      <- dismount
00b7 1400 0000 0032 0000 00ff fffe            op 183        <- the pickup itself
00b5 0000 00NN 0000      op 181  ( NN = the only field that varies: 0x10 / 0x11 / 0x12 / 0x00 )
00b5 0000 00ff fffc 0000 op 181
0070 5400 0000           op 112 (PLAYER.mount)              <- re-pose the horse
0016 1400 0000 fffe      op 22  RideOnSetS(PLAYER, 0)       <- remount, ZERO operand
```

Three things fall out of it.

**The guard is real and it is the first instruction.** `op 55` with subcommand `0x28` is
"is the player mounted?", which is exactly why picking up a herb on foot leaves you on foot —
confirmed in play. The whole sandwich sits inside that branch.

**The remount uses the zero-operand form**, `RideOn(PLAYER, 0)`, which the handler resolves to
`rider + 0x180` (§14i). Not `0x5400`. So the single most reused mount instruction in the game
addresses the horse purely as "the actor six slots along" — the slot `+0x66` fills. Nothing
about the horse's identity appears anywhere in the routine.

**`RideOff` is given `2`, not a mount.** Consistent with §14i: its second operand is a flag and
the mount comes off the rider's `+0x250`.

#### op 55/56 are conditionals, not `CameraTarget`

`eds_dis.py` guessed those names and they were wrong; corrected. Both share handler
`0x17AE4A8`, which reads a **subcommand** from param0 and a 32-bit value from params 1+2
(`$a1 + ($v1 << 16)`), then dispatches on the subcommand through `0x17AE1E0`. Subcommands
`0x28`/`0x29` are `RIDE`/`NORIDE`, evaluated at `0x177BDD0` — a function with **no `jal`
callers**, i.e. reached through a table of condition evaluators, which is why the earlier
call-graph work never connected it to anything.

That also makes `op 55` the branch to look at for any "only when mounted" behaviour, and gives
a second, safer place to force the mounted state than the global `sltu` at ISO `0x1C366C`
(§14i): a single `0x0028` → `0x0029` in one script flips one pickup's guard without lying to
every other `RIDE` test on the disc. Untested, and it would only ever affect that one pickup.

**Still not established:** what `op 183` and `op 181` do individually — neither has a
recoverable instruction length, which is what stops the chainer dead one instruction into the
sandwich and is why this had to be found by byte-comparison rather than disassembly. The
varying field at halfword 13 (`0x10`/`0x11`/`0x12`/`0x00`) is presumably which item, or which
of several pickup animations, but that was not chased.


### 14k. Who tests for "is the player mounted?" — and where

`op 55/56` with subcommand `0x28`/`0x29` is a searchable 4-byte signature, so the question of
how widely the engine cares about the ride state has a direct answer. **101 sites in `town`
scripts, and 97 of them test `PLAYER`** (the other four test staged cast slots 36-38).

It is not everywhere. Seven of the twenty-eight area archives carry one:

| archive | RIDE/NORIDE tests | complete ground horse bundled? |
|---|---|---|
| **RVER** | 25 | no |
| **LAST** · Ceremonial Site | 24 | no — `guli` only |
| **MORI** · Zexen Forest | 20 | no — `guli_005` only |
| **HAKA** | 10 | no |
| **ICEW** | 10 | no |
| **AKMT** · Kuput Forest | 8 | no — single stray clips |
| **HNKT** · Budehuc Castle | 4 | **yes** — `krum` |
| **ZKTR** · Brass Castle | **0** | **yes** — `zkum` |
| **KRVI** · Karaya Village | **0** | **yes** — `krum` |
| **HGB1** · Yaza Plain | **0** | **yes** — `krum` |

**The distribution is inverted from the obvious guess, and the inversion is the point.** The
three archives that actually stage a ground horse and do the mounting ask the question
**zero** times. A scene that mounts you knows you are mounted; it has no reason to test. The
guard exists for scenes that must cope with a player who **arrived** already mounted from
somewhere else.

So the RIDE test is effectively a **ride-through marker**, and it corroborates two earlier
results that were reached by unrelated routes:

- Field ride survives a map transition (§14f). If it did not, none of these 101 tests could
  ever fire — every one of them is in an area that cannot mount you itself.
- The `070` signature (§14g). LAST and ICEW carry every ride clip *except* mount-up, which was
  read as "you can only ride into here". They are second and fifth on this list.

RVER topping it at 25 is unexplained; its town files carry no readable scene ids and it was
listed in §9 as having neither a mount nor a bundled rider.

**Correction to §14j.** That section put `RideOffSetS` immediately after the guard. It does
not: `op 255` sits between them, and the same `op 55 → op 255` pairing accounts for 97 of the
101 sites. So `op 55` is the *test* and `op 255` is the *branch* that consumes it — which also
means `op 255` is worth identifying if anyone wants to redirect one of these conditionals.


## Not established

- What `mskn` (model 147/209) actually is — a Le Buque named NPC with a face portrait that is
  nonetheless in the rideable whitelist.
- The meaning of individual `3xx` variant numbers. The **distribution** of the `311` vs `321/322`
  split is now mapped and tracks which mount system authored the rider (§5), but what those clips
  actually animate is still unread — as is why Roland uses `341` for the mounted attack where every
  other rider uses `340`.
- ~~Whether the field ride state survives a map transition.~~ **It does** — confirmed from
  play 2026-09-06: Hugo mounts in Karaya Village and walks into Yaza Plain still mounted.
  That is load-bearing, because `RideOn` (the EDS opcode) is the only thing on the field
  that ever mounts anybody — `RideLink` has four callers, one field and three battle, and
  the field one is reached only from the opcode handler and the dead debug toggle. **HGB1
  contains no mount instruction at all**, so the state cannot have been re-issued there; it
  arrived. Which mechanism carries it is *not* established. The natural candidate is that
  the horse is a **party actor** rather than a scene object — party membership is saved
  state and survives the transition, scene objects do not — but that was not traced, and
  KRVI has no `RideOn(PLAYER, PLAYER.mount)` to support it either.

  Practical consequence, and the reason this matters more than it looks: **a mount only has
  to fire once.** Forcing field riding in a set of areas does not need an instruction in
  each one, only in the area you enter from, plus the ride clips and horse model bundled in
  each destination.
- The rest of the `0x84`-byte list2 record — `+0x66` is now known (§11) but most of the row
  past the skill-cap array is still unmapped.
- Which scene-setup code writes `rec->+0x1bc`. **No longer open in the way that matters**: §10a
  establishes the field is an **EOBJ pointer** with no writer anywhere and only one live reader, so
  it is unforceable by any constant rewrite regardless of who fills it. What remains unknown is
  merely the identity of the scene code that does — of academic interest now, since knowing it
  would not make the field patchable.
- Where the EDS script blobs actually live inside an area archive, which is what a reliable
  "does this scene call RideOn" scan would need (see §9).
- **Emulator coverage is two data points.** The battle pair patch has been played through
  (Hugo + Bright and Chris + Bright, 2026-08-31, §4a); every other claim in this document is still
  static analysis, including the whole field-ride side and the remaining combinations.
- Whether a **flyer**-rigged rider (Hugo, Futch) sits correctly on **Ruby** — the one direction
  with no precedent — and whether the full mounted clip set (attack / magic / bow / damage /
  knockdown / near-death) reads correctly on a cross-class pair. Chris+Bright was judged as
  "mounts and appears to work" in play, not clip by clip.
- Why the formation menu shows no sign of a re-paired pair when battle mounting honours it. The
  menu's mounted indicator reads something other than `IsValidRidePair`; not traced.
- Whether the HP re-split formula (§13) holds in play as well as in the disassembly — it has not
  been read off an emulator.
