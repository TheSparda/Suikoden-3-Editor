# How fast you walk and run — the movement-speed table

> **BOTTOM LINE.** Field movement speed is **plain data, not code**. Every field object gets a
> walk speed and a run speed at creation time out of a **14-row table of floats at ISO
> `0x3B0BE0`** (vaddr `0x19693E0`), and which row it reads is a **one-byte movement class in the
> character's own `list2` record at `+0x78`**. Walking is `2.0` for the entire cast. Running is
> `6.0`, `5.0` or `4.5` depending on the class — which is why **Hugo (6.0) feels quick, Geddoe
> (5.0) ordinary and Chris (4.5) sluggish**. Mounts are ordinary field objects with their own
> class (Fubar, Bright, Ruby and Koroku are all class 0 = run `6.0`), so "mounted speed" is the
> mount's row, not a separate system.
>
> That makes this the cheapest lever in the repo: **no instruction rewriting at all.** Three
> floats per class, one byte per character.
>
> **Scope: field only.** The battle unit spawner overwrites both fields at spawn from the
> character's *loaded battle asset*, which lives in the packed archives rather than the ELF (§6).
> So this table is what moves the avatar, the party followers, the castle NPCs and cutscene
> actors — and it is not what moves a unit across a battlefield.

Address convention as elsewhere in this repo: `ISO_offset = vaddr - 0x15B8800`
(ELF `PT_LOAD` `p_offset 0xA4800 → vaddr 0x165D000`). Every byte quoted below was read back
from a pristine `SLUS-20387` disc.

---

## 1. The table

**vaddr `0x19693E0` · ISO `0x3B0BE0` · 14 records of 16 bytes:**

```c
struct MoveSpeed {          // 16 bytes
    u32   modelId;          // +0x00  only meaningful in the override list (§4)
    float walk;             // +0x04
    float run;              // +0x08
    float animRate;         // +0x0C  the object's time scale (§5)
};
```

Read off the disc:

| class | ISO | walk | run | animRate |
|---|---|---|---|---|
| **0** | `0x3B0BE0` | 2.0 | **6.0** | 1.0 |
| **1** | `0x3B0BF0` | 2.0 | **5.0** | 1.0 |
| **2** | `0x3B0C00` | 2.0 | **4.5** | 1.0 |
| **3** | `0x3B0C10` | 2.0 | **6.0** | 1.0 |
| **4** | `0x3B0C20` | 2.0 | **5.0** | 1.0 |
| 5 | `0x3B0C30` | 2.0 | 6.0 | 1.0 |
| 6 | `0x3B0C40` | 2.0 | 6.0 | 1.0 |
| 7 | `0x3B0C50` | 2.0 | 6.0 | 1.0 |
| 8 | `0x3B0C60` | 2.0 | 6.0 | 1.0 |
| 9–12 | `0x3B0C70`–`0x3B0CA0` | 2.0 | 6.0 | 1.0 | *(no member — dead rows)* |
| 13 | `0x3B0CB0` | 2.0 | 6.0 | 1.0 | *(doubles as the override sentinel, §4)* |

Only **classes 0–8 have members**. Rows 9–13 are reachable only by editing a character's class
byte to point at them.

## 2. Who is in each class

The class is a **`u8` in the character's `list2` record at `+0x78`** — ISO `0x3E1338 + N*132 + 0x78`,
i.e. `0x3E13B0 + N*132`, where `N` is the editor's existing `list2` record index. That is the same
record the assigned-horse `u16` at `+0x66` lives in
([`MOUNT_SYSTEM_RESEARCH.md`](MOUNT_SYSTEM_RESEARCH.md) §11), so the geometry is already proven.

| class | run | members (`list2` record index) |
|---|---|---|
| **3** | **6.0** | Hugo (1), Lulu (10), Melville (41), Edge (71), Rody (74) — and record 0, the default |
| **0** | **6.0** | Fubar (8), Bright (31), Ruby (37), Koroku (48), Gadget Z (56), Koichi (76), Connie (77), Kosanji (78), Kogoro (79) |
| 5 | 6.0 | Augustine (66) |
| 6 | 6.0 | Gau (25) |
| 7 | 6.0 | Dupa (32), Shiba (33), Bazba (34) |
| 8 | 6.0 | Sgt. Joe (9), Wilder (43), Rhett (44) |
| **1** | **5.0** | Geddoe (3), Fred (5), Roland (12), Reed (14), Samus (15), Ace (16), Leo (17), Beecham (18), Percival (19), Borus (20), Jacques (22), Joker (23), Duke (24), Nicolas (27), Thomas (28), Futch (30), Sasarai (35), Franz (36), Salome (39), Watari (40), Nash (45), Juan (49), Guillaume (50), Piccolo (51), Mua (52), Jimba (55), Luc (57), Yuber (58), Toppo (61), Hallec (63), Kenji (64), Twaikin (65), Landis (67), Wan Fu (72) |
| **4** | **5.0** | Rico (6), Aila (11), Cecile (29), Alanis (42), Belle (46), Mel (47), Shabon (62), Sharon (69), Viki — Young (70), Emily (75) |
| **2** | **4.5** | Chris (2), Lucia (4), Viki — Old (7), Lilly (13), Queen (21), Elaine (26), Ayame (38), Yuiri (53), Yumi (54), Sarah (59), Nei (60), Sanae Y. (68), Estella (73) |

The grouping is a **body type**, and it reads like one: the three teenagers and the two other
small-framed men run 6.0; the adult men run 5.0; the women and the two Vikis run 4.5; the
beast-people (Dupa/Shiba/Bazba), the big men (Sgt. Joe/Wilder/Rhett), Gau and Augustine each got
their own row and all ended up at 6.0; the animals and mounts share class 0.

**Most of these characters are never the field avatar, and that is not a contradiction** — see §6.
A field object is any character the field module walks around: the eight possible avatars, but also
every recruit standing about Budehuc Castle and anyone an event script walks through a scene.

Read against the field, the numbers say Chris covers **25 % less ground per second running** than
Hugo, on the same walk speed. That is the data, not a measurement: it has not been played back
(§7, *what is not established*).

## 3. How a model reaches its row

```
GetMoveSpeedRecord(modelId)                          ; 0x16E8AD8   ISO 0x1302D8
    ; 1. per-model override list (empty on the shipped disc — see §4)
    for (rec = 0x19694B0; rec->modelId != 0; rec += 16)
        if (rec->modelId == modelId) return rec;
    ; 2. otherwise: the model's movement class
    if (1 <= modelId <= 0xD8)
        return 0x19693E0 + GetModelClass(modelId) * 16;
    return 0x19693E0;                                ; class 0 for everything else

GetModelClass(modelId)                               ; 0x16C7310   ISO 0x10EB10
    rec = GetModelRecord(modelId);                   ; 0x16C6E78
    return rec ? rec->0x10 : 0;                      ; = list2 record + 0x78
```

`GetModelRecord` maps **model id → `list2` record index** through the byte table at
vaddr `0x19697A8` (ISO `0x3B0FA8`) — the same indirection `GetCharaRecord` uses, and the reason
the party space and the model space are two numberings of one roster. Three model ids are aliases
that share another character's record and therefore its speed: **202 Masked Luc → Luc's**,
**203 Grasslands Chris → Chris's**, **215 `fuku` → Aila's**. Model ids `210`–`213` bypass the byte
table and index records `76`–`79` directly. Every model id in `0x53`–`0xD1` (the townspeople,
soldiers and enemies) gets **no record at all**, so `GetModelClass` returns `0` and they run at
`6.0`.

The record is consumed at exactly one place, when the field object is built:

```
                                                     ; 0x16F3E20   ISO 0x13B620
rec = GetMoveSpeedRecord(eobj->modelId)
if (rec) { eobj->0x248 = rec->walk                   ; ISO 0x13B634
           eobj->0x24C = rec->run                    ; ISO 0x13B63C
           eobj->0x02C = rec->animRate }             ; ISO 0x13B648
else     { eobj->0x248 = 1.0                         ; the compiled-in fallback
           eobj->0x24C = 2.0
           eobj->0x02C = 1.0 }
```

`GetMoveSpeedRecord` never returns NULL for a live model, so the `1.0 / 2.0` fallback is dead in
practice — but it is what an out-of-range model would get.

### EOBJ fields, and the four accessors

| EOBJ | meaning |
|---|---|
| `+0x248` | **walk speed** (world units / second) |
| `+0x24C` | **run speed** |
| `+0x02C` | current time scale — animation *and* movement (§5) |
| `+0x21C` | the time scale's set-point |

```
GetWalkSpeed(eobj)      @ 0x16E8A00    -> eobj->0x248   (0.0 if eobj is NULL)
GetRunSpeed(eobj)       @ 0x16E8A18    -> eobj->0x24C
SetWalkSpeed(eobj, f)   @ 0x16E8A30
SetRunSpeed(eobj, f)    @ 0x16E8A50
GetSpeedForMode(eobj, mode) @ 0x16E8980 : mode 3 or 8 -> run ; anything else -> walk
```

`SetWalkSpeed` / `SetRunSpeed` have **exactly one caller each** (`0x17DE224` / `0x17DE230`), and
that caller is the **battle** unit spawner. It overwrites both fields from the character's loaded
battle asset rather than the table — which is what scopes this whole table to the field. See §6.

## 4. The per-model override list is empty, and why that matters

`GetMoveSpeedRecord`'s first act is to walk a **zero-terminated list of `{modelId, walk, run,
animRate}` records at vaddr `0x19694B0`** (ISO `0x3B0CB0`) looking for an exact model-id match.
That address is the class table's **own last row (index 13)**, whose `modelId` field is `0`, so the
loop exits on its first read and no override ever fires.

The developers evidently kept the hook and shipped it disabled. It is a real extension point — a
single record there would give one model its own speeds without touching a class — but the record
immediately after it (ISO `0x3B0CC0`) is **live data belonging to another table** (the `u16`
model-group lists that start `63, 202` = Luc + Masked Luc), so the list has room for exactly one
entry before it would corrupt something. **The editor does not offer it.** Editing a class row, or
moving a character to a different class, is strictly safer and covers every case anyone actually
wants.

## 5. `animRate` is a per-object time scale, not just animation

`+0x0C` of the record lands in `eobj->0x2C`, and `EobjUpdate(eobj, dt)` @ `0x16F4E60` multiplies
`dt` by it before handing the result to **every** subsystem — the animation clock
(`eobj->0x30 += dt * rate`), the physics/collision step (`0x16FCA68`), and four more behaviour
updates at `0x16F5684`–`0x16F56B0`. A mounted pair inherits it: the same function calls itself on
`eobj->0x250` (the ride partner) with the *rider's* `dt`.

So `animRate` is honestly "how fast time runs for this object". It ships at `1.0` for every class.
Two consequences worth knowing before turning it:

- Raising `run` alone makes a character **skate** — covering more ground per stride without the
  legs moving faster. Raising `animRate` with it keeps the stride in sync.
- Raising `animRate` speeds up *everything* about the object, idle animations included, and it is
  clamped to `10000.0` at `0x16F5788`.

The engine already uses it this way: the party-follower catch-up at `0x16F9BF0` temporarily writes
`1.3` / `1.2` into `eobj->0x2C` when a follower has fallen behind, and
`UpdateMoveTimeScale` @ `0x16F6218` pairs a `walk × 1.5` "hurry" state with a rate of `1.2`.

## 6. Field, not battle — and why every character still has a class

The table's floats reach **every** EOBJ, field or battle, because they are copied in by the
generic object builder. What decides the scope is what happens next.

**The battle spawner overwrites them.** `0x17DDF70` — called from four sites in the battle
module, `0x17DEE24`, `0x17DEEFC`, `0x17DEFD4` and `0x17DF08C` — does this:

```
desc = GetBattleUnitDesc(charId)            ; 0x181AA90, or 0x181AB40 for half of a ride pair
if (!desc) return                           ; all four call sites bail here
...
pair = desc->0x18                           ; -> { float walk, float run }
SetRunSpeed (unit, pair[1])                 ; 0x17DE224  -> eobj->0x24C
SetWalkSpeed(unit, pair[0])                 ; 0x17DE230  -> eobj->0x248
```

`GetBattleUnitDesc` resolves through `0x188BF40`, which scans **loaded resource slots 6–13** for
one whose `+0x04` matches the character id. So the pair is inside the character's **battle asset**,
in the packed archives — not in the ELF. There is no null guard on it and no fallback: a battle
unit never keeps the table's values.

**Nothing overwrites a field object.** Those two setters have no other caller anywhere in the
image, so for a field object the table's values are the ones that stay.

| path | source of walk / run speed |
|---|---|
| **field objects** — the avatar, party followers, castle NPCs, cutscene actors | **this table**, via the movement class |
| **battle units** | overwritten at spawn from the character's loaded battle asset (outside the ELF) |

### So why does every party character have a movement class?

Because a field object is not the same thing as *the* field avatar. Only eight ids can be the
character you control ([`FIELD_CHARACTER_RESEARCH.md`](FIELD_CHARACTER_RESEARCH.md) §3) — but
every recruited character is a field object: they stand and walk around Budehuc Castle, and the
EDS scripted mover walks any of them through a cutscene. Dupa, Bazba, Sgt. Joe, Gau and Augustine
are never avatars and still need a walk speed, which is exactly why they are in the table.

It also explains the shape of the classes. They group by **body type** — teenagers, adult men,
women, beast-people, big men — which is what a *walking-around-town* speed would be keyed on, and
not something a battle stat would need at all.

## 7. Where the two speeds are consumed

Every mover reads them through the accessors above. Grouped by module, because that is what
decides whether the *table's* values or the *asset's* values are the ones being read (§6):

- **Field module — the EDS scripted mover.** `0x177EC98` maps script mode `0x11`/`0x14` → walk
  speed and `0x12`/`0x15` → run speed, then calls the mover at `0x16F6BB0`. This is the field
  module's only direct read, and it reads **table** values.
- **Battle module — a movement-mode table.** `0x1805A98` (and a near-identical twin at
  `0x1805B88`) is an 18-entry jump table at vaddr `0x19CECD0` keyed by a movement mode, returning
  either the walk speed or the run speed times one of three hardcoded multipliers: **×1.3**
  (modes 3, 17), **×1.4** (mode 8) and **×1.2** (modes 9–11), stored as gp-relative floats at
  vaddr `0x19E5568`, `0x19E556C`, `0x19E5570` (ISO `0x42CD68`, `0x42CD6C`, `0x42CD70`); the twin's
  own pair sits at `0x19E5574` / `0x19E5578`. Eight of the eleven direct reads of `+0x248`/`+0x24C`
  are here — but on **asset** values, since the spawner already overwrote them, which is why
  editing the table cannot change battle movement. That this module is character battle (not the
  war battle) is pinned by its neighbours: it sits between the armor-set counter/heal constants
  (`0x17FD78C` / `0x17FE5A8`) and the mounted-pair Adrenaline sum (`0x181B4D0`), and `0x1810B10` /
  `0x1810B68` in it request motion slots `0x88` / `0x8B` = `b_run_LR` / `b_run_loop`.
  **Not exposed**, for both reasons: wrong source, and the mode numbering is not pinned to
  anything a player would recognise.
- **EOBJ library — the generic movers.** Three more `GetSpeedForMode` reads at `0x16F6FF8`,
  `0x16F7288` and `0x16F8BA0` sit in the shared object-movement code, which serves both modules.
  Their containing functions have no `jal` call site and are not referenced as data anywhere in
  the image, so they are reached by tail-call or through a pointer installed at runtime
  (`EobjUpdate` calls `eobj->0x2AC` / `0x29C` / `0x2B0` that way) and were not traced to an
  installer.

### What is *not* established

The pad-driven path for the field leader specifically — the code that turns stick deflection into
"walk" or "run" — is reached through those function pointers, so it has no `jal` call site to
follow and was not traced end to end. The evidence that it lands on the same two fields is strong
but circumstantial: the field module (`0x1773000`–`0x17C0000`) **holds no movement speed of its
own** — of the 186 float constants it loads from the rodata pool, not one is `2.0`, `4.5`, `5.0`
or `6.0`, and its handful of speed-shaped `lui`+`mtc1` immediates are distance thresholds or blend
parameters (the `2.0` at `0x17A1470`, for instance, is compared against a vec3 length). Meanwhile
every EOBJ is given `+0x248` / `+0x24C` at creation whether or not a script ever moves it, and the
per-class run values line up exactly with which characters players describe as fast or slow to run
around as. Treat the class values as confirmed data and the leader's use of them as very likely but
unplayed.

Also unestablished: **the battle asset's own walk/run pair**. It is reached as
`resource(slot 6..13 where +0x04 == charId)->0x18->[0 or 1]`, i.e. inside a packed per-character
battle file, so its values were not read and are not comparable with the table's. If they turn out
to be the same numbers, the two systems merely agree; nothing here shows that they do.

## 8. What shipped (v1.67.0, corrected in v1.68.0)

A **Movement speed** section on the ISO editor's **Field character** tab — the natural place, since
that tab already decides *who* you run around the map as.

- **The class table.** Walk, run and animation-rate floats for the nine classes that have members,
  each row listing the characters it governs, read live off the disc through the byte at `list2
  +0x78` rather than from a baked-in list. The five memberless rows are behind a disclosure.
- **Per-character class.** A picker on every `list2` record, so Chris can be moved from class 2
  (4.5) to class 3 (6.0) without changing anyone else — or a whole class can be retuned in one
  edit. Both levers are plain data writes; nothing patches an instruction.
- **Presets.** "Everyone runs at 6.0" (levels the three run values, leaving walk and rate alone),
  a walk/run multiplier pair that scales from the disc's originals rather than stacking, and
  "Restore stock" for the whole section.
- The review list registers each edit under **Movement speed** / **Speed class**, so a staged
  change is inspectable before Save like every other ISO edit.
