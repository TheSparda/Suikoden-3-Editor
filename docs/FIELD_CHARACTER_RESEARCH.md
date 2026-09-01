# Who you run around the map as — the field-avatar gate

> **BOTTOM LINE.** The character you walk around as on the field is the **party-leader id at
> save `0x12`**, and the engine loads its model through **one function with a hardcoded
> whitelist of eight ids**: `1` Hugo, `2` Chris, `3` Geddoe, `29` Thomas, `54` Koroku,
> `63` Luc, `202` Masked Luc, `203` Grasslands Chris. That list is not a guess — it is the
> comparison chain of `0x17B7560`, and it is *exactly* the set of characters the game ever
> hands you on the field.
>
> So of the seven asked for, **six are already legal values the engine will load with no code
> change at all** — the feature is a save edit, not a patch. The seventh, **Sarah (66)**, is
> not on the list, and adding her (or anyone else) is a **two-instruction-immediate ISO edit**
> at ISO `0x1FED70` and `0x1FED80` — the same class of constant rewrite the Mounts tab already
> ships.

Address convention as elsewhere in this repo: `ISO_offset = vaddr - 0x15B8800`
(ELF `PT_LOAD` `p_offset 0xA4800 → vaddr 0x165D000`). Every byte quoted below was read back
from a pristine `SLUS-20387` disc.

---

## 1. The party id space *is* the model id space

This is the fact the whole feature rests on, and it was sitting in two files that had never
been compared.

`s3save.PARTY_IDS` (roster index → the id stored at `0x3216` and at the leader byte `0x12`)
and the `roster` cross-reference in [`s3_model_ids.json`](s3_model_ids.json)
(roster id → engine model id, decoded from the banded lookup at `0x1711AC8`) are **the same
75 numbers, in the same order, with zero mismatches** — including all six of the gaps that
make the party space a third numbering in the first place (`0x0C`, `0x21`, `0x25`–`0x27`,
`0x2B`, `0x40`).

| | Hugo | Chris | Geddoe | Thomas | Koroku | Luc | Sarah |
|---|---|---|---|---|---|---|---|
| roster id | 1 | 2 | 3 | 28 | 48 | 57 | 59 |
| **party / model id** | **1** | **2** | **3** | **29** | **54** | **63** | **66** |
| asset code | `syu1` | `syu2` | `syu3` | `thms` | `kork` | `look` | `sera` |

So the byte at save `0x12` does not merely *identify* a character — it **names a model**. That
also settles two questions [`ETC_BIN_MODEL_RESEARCH.md`](ETC_BIN_MODEL_RESEARCH.md) §5 still
lists as open: `syu1`/`syu2`/`syu3` are Hugo / Chris / Geddoe in that order, and Luc's missing
`luc*` code is **`look`** (id 63) — corroborated independently by the corpus save whose party
is `[63, 66, 65]` = Luc + Sarah + Yuber.

## 2. The leader byte drives the field avatar

`0x196B3F2` is save `0x12` in EE RAM (save block base `0x196B3E0`). It has **24 references in
the boot ELF, all of them loads, none of them stores**, and no pointer to it anywhere in the
image — so nothing in the executable writes it directly; it is set by script (§5) and read all
over the field module (`0x1773…`–`0x17B9…`) plus one battle site.

Two of those reads prove what it is:

- `0x17AE570`: `lhu $a0, ($s0)` — an **EOBJ's model id at `+0x00`** — is compared against the
  leader byte, and the object that matches gets a different camera constant (`20.0` vs `40.0`).
  The field object whose model id equals the leader byte *is* the one the camera follows.
- `0x1791D40`: the same comparison against `rec->0x3C`, the per-party-slot EOBJ pointer the
  debug `Toggle Mount` handler uses (see [`MOUNT_SYSTEM_RESEARCH.md`](MOUNT_SYSTEM_RESEARCH.md) §8).

## 3. `0x17B7560` — the whitelist, in full

One function decides whether the leader's model gets requested at all. It is the **only**
caller of `0x16E0FF8`, which is the only thing that issues the request (resource type 6,
group `0x17`, keyed by model id via `0x16B7108`).

```
FieldAvatarModelRequest(charId)              ; 0x17B7560   ISO 0x1FED60
    if (charId == 0x36)             goto LOAD      ; 54  Koroku
    if (charId <u 0x37) {
        if (charId == 0)            return 100
        if (charId <u 4)            goto LOAD      ; 1, 2, 3  Hugo / Chris / Geddoe
        if (charId == 0x1D)         goto LOAD      ; 29  Thomas
        return 100
    }
    if (charId == 0x3F)             goto LOAD      ; 63  Luc
    if (charId <u 0x3F)             return 100
    if (charId >=u 0xCC)            return 100
    if (charId <u 0xCA)             return 100
    ; 0xCA, 0xCB fall through                      ; 202 Masked Luc, 203 Grasslands Chris
LOAD:
    return RequestAvatarModel(charId)        ; 0x16E0FF8
```

`100` means "nothing to do"; only `-1` ("still streaming") is acted on by either caller. A
non-whitelisted leader is therefore not an error — the request is simply **never made**, and
whatever model happens to be resident is what you get.

Its two callers:

- `0x17B73F4`, the tail of `0x17B7338` — a readiness gate that first walks **party slots 1–6
  and guest slots 13–15** (`0x16FFCA8` → `0x196E5F4 + 2n`, i.e. `0x3216` and `0x324E` in the
  save) checking each member's assets, then asks this function about the leader. The leader's
  model is requested **separately from the party's**, which is why the avatar does not have to
  be a party member.
- `0x17B0168`, inside **EDS opcode 346** (handler `0x17B0038`; opcode = `(handler - 0x19828F8)/4`),
  which reads a `u16` character id straight out of the script stream, compares it to the stored
  leader, and asks for that model. This is how the game changes your avatar at a chapter break.

### The eight patch sites, byte-verified

Every id is a 16-bit instruction immediate — the same shape the Mounts tab edits, and the
opcode bytes at `+2,+3` stay put (`02 24` for `addiu $v0,$zero,N`, `82 2C` for `sltiu $v0,$a0,N`).

| ISO offset | word | instruction | what it gates |
|---|---|---|---|
| `0x1FED64` | `24020036` | `li $v0, 0x36` | **Koroku** (54) |
| `0x1FED70` | `2C820037` | `sltiu $v0,$a0,0x37` | upper bound of the low branch |
| `0x1FED78` | `2402003F` | `li $v0, 0x3F` | **Luc** (63), tested at `0x17B759C` |
| `0x1FED80` | `2C820004` | `sltiu $v0,$a0,4` | **Hugo / Chris / Geddoe** (1–3) |
| `0x1FED88` | `2402001D` | `li $v0, 0x1D` | **Thomas** (29) |
| `0x1FEDA0` | `2C82003F` | `sltiu $v0,$a0,0x3F` | rejects 0x37–0x3E |
| `0x1FEDAC` | `2C8200CC` | `sltiu $v0,$a0,0xCC` | upper bound of the specials |
| `0x1FEDB4` | `2C8200CA` | `sltiu $v0,$a0,0xCA` | lower bound of the specials |

**Widening it to every battle character** takes two words: set both `0x1FED70` and `0x1FED80`
to `2C820053` (`sltiu $v0,$a0,0x53`). Ids `1`–`0x52` (1–82, the full 75-character party space)
then reach `LOAD`; `0` still returns early, and the `0xCA`/`0xCB` specials still work because
ids `≥ 0x53` fall through to the unchanged second half. **Swapping one name in** is a single
word — e.g. `0x1FED78` → `24020042` trades Luc for Sarah (66).

## 4. What the corpus says

Reading `0x12` and `0x3216` out of the five extracted `gamedata` blobs:

| blob | phase | leader | party |
|---|---|---|---|
| `gamedata` | 7 | **1 Hugo** | Hugo, Fubar, Chris, Geddoe, Thomas, Emily |
| `gamedata_u01` | 2 | **203 Grasslands Chris** | (empty) |
| `gamedata_u02` | 5 | **63 Luc** | Luc, Sarah, Yuber |
| `gamedata_u03` | 7 | **1 Hugo** | Hugo, Koroku, Koichi, Connie, Kosanji, Kogoro |
| `gamedata_u04` | 7 | **1 Hugo** | Hugo, Fubar, Chris, Geddoe, Thomas, Emily |

Every leader observed in the wild is a whitelist member, and the leader is party slot 1
wherever the party is non-empty. `gamedata_u02` — leader `63`, party `63/66/65` — is the Luc
scenario, and it is the direct evidence that a non-protagonist id is a working field avatar:
the game itself ships one.

## 5. The honest constraints

1. **Scripts own the byte.** Nothing in the ELF writes `0x196B3F2`, but EDS opcode 346 exists
   precisely to change your avatar, and the save block is written by the generic script
   variable path. A leader set in the save editor **holds until the next scene that sets it**
   — which for a chapter transition is soon. This is the same caveat the Health tab already
   states ("the game sets the leader itself on story transitions"), now with the mechanism
   behind it. It is not a reason not to ship the edit; it is what the note next to it should say.
2. **Residency is a real risk, and §6 now measures it.**
   `0x17B7338` streams party members' and guests' field models per area through the same
   resource path, and any recruited character can be brought anywhere after the merge — so the
   engine already loads arbitrary party models in arbitrary areas. What is *not* proven is that
   an id the scene script never mentions gets streamed in time. Pointing the leader at someone
   the area does not carry gets a missing avatar, not a crash (the request just returns `100`).
3. **Sarah was never an avatar.** She is in Luc's party, not at the head of it, and id 66 is
   absent from the chain. Exposing her is the ISO patch, not the save edit — and she is
   untested where the other six are shipped-and-played by the game itself.
4. **Story coherence is out of scope.** The herrvillain Roaming Code's warning applies here too:
   walking into a scripted scene as the wrong character is the game's problem, not the editor's.

## 6. Which maps carry which avatar

Area archives store asset record names as plain text, so `grep` over the disc answers this
directly. Per-model results are in [`Editor/s3_avatar_areas.json`](../Editor/s3_avatar_areas.json)
(all 75 battle characters plus the specials, generated from a pristine disc); the eight
whitelisted avatars:

| character | id | code | area archives | which |
|---|---|---|---|---|
| **Hugo** | 1 | `syu1` | **15/28** | CRRA, DKVI, HAKA, HGB1, HNKT, ICEW, KRVI, KSKR, KTDO, LAST, LZVI, SOGE, TSVI, VDZK, ZKTR |
| **Chris** | 2 | `syu2` | **12/28** | AKMT, CRRA, HGB1, HNKT, ICEW, IKVI, KRVI, LAST, LZVI, MORI, VDZK, ZKTR |
| **Geddoe** | 3 | `syu3` | **15/28** | AKVI, CRRA, FAKE, HAKA, HGB1, HNKT, ICEW, KRVI, KTDO, LAST, LZVI, MSVI, SOGE, TSVI, ZKTR |
| **Thomas** | 29 | `thms` | **5/28** | HGB1, HNKT, LAST, RVER, ZKTR |
| **Koroku** | 54 | `kork` | **6/28** | FAKE, HNKT, ICEW, KTDO, LZVI, RVER |
| **Luc** | 63 | `look` | **9/28** | AKVI, CVIS, FAKE, HAKA, ICEW, KSKR, LAST, MSVI, ZKTR |
| **Masked Luc** | 202 | `mask` | **6/28** | CVIS, FAKE, HAKA, KRVI, KSKR, MSVI |
| **Grasslands Chris** | 203 | `s2hr` | **13/28** | AKMT, AKVI, CRRA, DKVI, HAKA, HGB1, HNKT, ICEW, IKVI, KSKR, LZVI, TSVI, ZKTR |

Across all 82 models the **median is 4 of 28** archives — per-area sets are small and
purpose-built. `HNKT` carries almost everyone (it is the archive that bundles the cast).

**This predicts a real observation.** Of the nine archives carrying Luc, exactly four lack
Masked Luc — `AKVI`, `ICEW`, `LAST`, `ZKTR`. On a map in that group Luc walks around normally
and Masked Luc does not load at all, which is what happens on Plain Amur. Note also that
**Duck Village (`DKVI`) carries neither**.

**The honest limit of this table.** `ETC.BIN` also carries all 82, and a model already
resident is not evicted on an area change — so presence is not a guarantee and absence is not
a verdict. It is the streaming set for that map, which is the strongest signal available
without running the game. The editor therefore says "ships in N of 28 maps" and never
"will not work".

## 7. The leader byte is also *whose story this is*

`0x196B3F2` is read at **29 sites and written at none**. Thirteen of the reads are inside EDS
script-opcode handlers, covering opcodes **6, 7, 16, 26, 27, 40, 50–53, 55, 56, 63, 64, 82,
83, 88, 310, 324, 345, 346**. They split two ways.

**"The player" resolution.** Ops 26/27 put the leader at the head of the actor list they
build; op 40 substitutes it when its parameter is 0; ops 55/56 find the camera target by
matching an EOBJ's model id against it; ops 6/7/50–53 and 88 store it into an actor record.
This is why a chosen avatar works in cutscenes as well as on the field.

**Story-team dispatch.** Seven sites switch on the leader to pick which team's content loads.
Six carry only `1, 2, 3, 0x1D, 0xCB` and route everything else to a default. The seventh, at
**`0x177FEB4`**, is the wide one — it resolves a **team index 0–7** and is the only site that
gives the non-protagonists an index of their own:

| leader | 1 Hugo | 2 Chris | 3 Geddoe | 0xCB | 0x3F Luc | 0xCA M.Luc | 0x11 | 0x42 Sarah | 0x36 Koroku | *default* |
|---|---|---|---|---|---|---|---|---|---|---|
| **index** | 0 | 1 | 2 | 3 | 4 | 4 | 5 | 6 | 7 | **0** |

That index feeds the area's own town-data table (`work->0x12D0`). **Empty dialogue boxes are a
missing row, not a failed lookup**: as Luc the switch correctly asks for index 4, and a town
that ships no index-4 content has nothing to show. Sarah has an index here even though she is
absent from the model whitelist — the engine knows more leaders than it will draw.

### Confirmed in play

**2026-08-31: switching Koroku to Hugo's story content makes text boxes that were blank or
broken render correctly.** This is the one avatar-related patch in this document that is
confirmed to do what it claims, so it has been promoted out of the ISO Editor's `Test` tab into
a **Story content** view of its own. It fixes *empty dialogue*; it does not fix a cutscene that
hangs, which is a separate problem tracked in §9.

### Why the fix is one word

`s0` is zeroed on entry to that switch; the default path only calls the (stubbed) debug printf
at `0x1712238` and falls into the same tail. **An unrecognised leader therefore resolves to
index 0 — Hugo.** So retiring a character's case immediate hands it Hugo's story content, with
no branch surgery and nothing else disturbed. The nine case immediates, byte-verified:

| ISO offset | id | index | character |
|---|---|---|---|
| `0x1C76DC` | 1 | 0 | Hugo — the fallback itself |
| `0x1C76CC` | 2 | 1 | Chris |
| `0x1C76F0` | 3 | 2 | Geddoe |
| `0x1C7740` | 0xCB | 3 | Grasslands Chris |
| `0x1C7724` | 0x3F | 4 | **Luc** |
| `0x1C7738` | 0xCA | 4 | Masked Luc |
| `0x1C76F8` | 0x11 | 5 | id 17 |
| `0x1C770C` | 0x42 | 6 | Sarah |
| `0x1C771C` | 0x36 | 7 | Koroku |

Writing `0x7FFF` (an id the leader byte cannot hold) into one of these retires that case.

## 8. Random encounters: the movement gate

Before the encounter rate is used at all, the roll is gated on the **player object's current
animation**, via two range tests over its motion slot (`obj->+0x0E`) and object kind
(`obj->+0x02`):

```
IsWalking(kind, slot)  @ 0x16F3860 : kind==2 ? [0x64,0x6F] : [2,0x0D] or [0x42,0x44]
IsRunning(kind, slot)  @ 0x16F38A8 : kind==2 ? [0x70,0x72] : [0x0E,0x13] or [0x45,0x46]

walking -> rate = base ; running -> rate = base * (riding ? 150 : 120) / 100
neither -> rate = 0, and the roll is skipped silently
```

Every bound is a 16-bit instruction immediate (ISO `0x13B068`–`0x13B0D8`), so the whole gate
is editable in the same way as everything else here.

### Koroku and Fubar run outside every band

The motion table at `0x1966610` is a **single global slot list** — every model plays clips by
slot number — so a model can only be classed as running if it plays a clip in the run band.
Grepping the disc for clip names (they are plain text) and attributing each to its enclosing
`cha_` record gives every model's locomotion set. Across the 78 models with attributable clips:

| | count |
|---|---|
| have the human run band (`run_start_L/R`, `run_stop_L/R`) | **76 / 78** |
| have the `hasi_*` slope set (slots 20–34) | 3 / 78 |
| **lack the human run band entirely** | **2 / 78 — Fubar (8) and Koroku (54)** |

Both are animals. Their run cycle is the *unsuffixed* `run_start` / `run_loop` / `run_stop`,
which live at slots **`0x11A`–`0x11F`** — in the animal block beside `sit_stop` and `naki_*`
(鳴き, an animal's cry). No band reaches there.

Koroku's full locomotion set is `neutral_loop`, the six `walk_*`, `run_RL`/`run_LR`,
`run_start`/`run_loop`/`run_stop`, `fastrun_loop`, `fastwalk_RL/LR` — 15 clips against Hugo's
60. He is missing exactly the four run-band entries `run_start_L/R` and `run_stop_L/R`.

**Confirmed in play (2026-08-31): as Koroku, walking triggers encounters and running does
not.** That also settles his object kind. If he were kind 2 the run test would check
`[0x70,0x72]` — clips he *has* (`fastrun_loop`, `fastwalk_*`) — and running would work. It
doesn't, so he is an ordinary kind and his run falls back to the animal block.

### The fix, and its price

`IsRunning`'s **second** range is `[0x45,0x46]` — the mounted fast-move pair
(`rdfastrun_loop`, `rdfastwalk`). Repointing it covers the animal cycle exactly:

| ISO offset | stock | animal mode |
|---|---|---|
| `0x13B0BC` | `addiu $v0,$a1,-0x45` | `addiu $v0,$a1,-0x11A` |
| `0x13B0C0` | `sltiu $v0,$v0,2` | `sltiu $v0,$v0,6` |

**Confirmed in play (2026-08-31): with this set, running as Koroku triggers random encounters.**
Both directions of the diagnosis are therefore played, not inferred — stock builds roll on his
walk and never on his run, and the repointed range fixes exactly that.

The human bands are untouched, so nothing that works today changes. The price is that mounted
fast-movement stops counting as running — no encounters while galloping, in the four areas
that have a mount. Mounted *walking* still rolls, through `IsWalking`'s own `[0x42,0x44]` range.

### Walking in peace

The same structure gives a QoL setting the rate slider cannot: **zeroing a range's length
makes its test always fail.** Zero all three walk lengths and walking never rolls while running
still does — walk anywhere in peace, run when you want to grind. Zeroing the run lengths gives
the inverse. Both are exposed as plain toggles rather than as a rate of 0, because they are a
different thing: *when* encounters happen, not *how often*.

## 9. Cutscene softlocks — the real limit of the feature

**Observed, three separate characters (2026-08-31):**

| avatar | whitelisted? | result |
|---|---|---|
| **Koroku** (54) | yes, stock | scene hangs — he walks in, then the game waits forever |
| **Yuber** (65) | no, ISO-patched in | softlock loading the scene |
| **Lucia** (4) | no, ISO-patched in | softlock loading the scene |

**Setting Koroku to Hugo's story content did not help**, which rules out the §7 team-index
path as the cause.

### A hypothesis that the data killed

The clip scan found something striking: of the 23 models that ship event animations, **22 have
`evneutral`** — the idle pose an actor holds during a cutscene — and **Koroku is the only one
that does not**, despite owning all five `evwalk_*`. That looked like the mechanism: the scene
walks him in, parks him in an idle pose whose clip does not exist, and waits on a `SetMotion`
(@ `0x16EF4F0`, which does return success/failure) that can never succeed.

**Yuber falsifies it as the general cause.** He *has* `evneutral` and hangs anyway. The clip
gap is a real fact about Koroku's model and may still be why *his* hang looks the way it does,
but it is not the explanation for the feature as a whole. Recorded here as a dead end so it is
not re-derived.

### What the evidence actually supports

Scene scripts address **specific actors**, and they are authored per protagonist. §7 already
showed the engine carries a per-team content index and that a town simply has no row for some
leaders. The three observations are consistent with the simpler and larger claim: **a scripted
scene can only be relied on to work for the protagonist it was written for.** That data lives
in the packed event files outside the boot ELF — the region neither editor can reach — so there
is no flag, table or constant that makes a script accept a substitute actor.

**Superseded — see "SOLVED" below.** The hangs were not about which character you picked; they
were about the leader not being in the party, which leaves the engine's player lookup with
nothing to find.

### The practical rule, and what the editor now does about it

Non-stock avatars are a **roaming** feature. Switch the leader back to a protagonist before
triggering story — one field in the save editor, and the game sets it back itself at chapter
transitions anyway.

As of v1.64.0 the editor is shaped around that rather than just warning about it:

- The **save editor's picker offers only the eight ids the engine ships**, and marks the four
  protagonists apart from the rest as *roaming only*. Widening it to all 75 is no longer
  reachable from the save side at all.
- The **whitelist widening moved to an ISO Editor `Test` tab**, behind a banner that says
  plainly these patches are not known to work and names the three characters that hang.

The patch doing what it says and the game coping with it are different claims, and the second
one is false often enough that the UI should not imply otherwise.

### The clip evidence is exhausted

A third observation narrows it usefully: **ordinary NPC dialogue works fine as Koroku** — he
talks to people with no trouble — and only *event scenes* hang. So the script interpreter, the
text path and the player-actor plumbing are all healthy; whatever is stuck is specific to a
scene.

That points at the `ev*` animation set (`evwalk_*`, `evneutral`) which is what scenes use to
stage actors, and the clip scan looked like it agreed. It does not survive contact:

| avatar | model in N archives | `ev*` clips found in |
|---|---|---|
| Hugo | 15 | **2** (DKVI, LAST) |
| Chris | 12 | 3 |
| Geddoe | 15 | 2 |
| Koroku | 6 | 1 |
| Luc | 9 | **0** |

**Hugo has `ev*` clips in 2 of his 15 archives and works in scenes everywhere**, so those clips
plainly come from `ETC.BIN` for most areas — which is compressed, and therefore invisible to a
text scan. Absence is not evidence here, and that retroactively weakens the "Koroku is the only
model lacking `evneutral`" observation too: it may simply be in `ETC.BIN`.

So this line is done. The clip inventory can say what a model *has*; it cannot say what it
lacks, which is the half we need.

### Reading the hang instead of inferring it

[`tools/pcsx2/edsprobe.py`](../tools/pcsx2/edsprobe.py) samples the EDS interpreter while the
game is stuck and reports the opcode it is spinning on, via
`*(0x196A4D0)` → `+0x150` (the script context, as both interpreter entry points `0x1778768`
and `0x1778D78` compute it) → `+0x0C` (the stream pointer every handler reads through), mapped
against the handler table at `0x19828F8`. It also distinguishes *stuck* from *running*, so a
negative result — the wait is somewhere other than the script interpreter — is a real answer
rather than a shrug. Reads only.

### Scripts name actors two ways, and one of them can return null

The mechanism is no longer a guess. Script actor handles are **packed**: bits 10–13 select a
namespace, the low 10 bits an index. The decoder is `0x17B5A40`, used at **186 call sites** —
this is the whole script actor system.

| namespace | meaning | resolves via |
|---|---|---|
| `0x1400` | **the player** | `0x17B5CC8` → `FindActorByCharId(leader byte, 1)` |
| `0x400 \| N` | **the character whose id is N** | `FindActorByCharId(N, 1)` |
| `0x1800` | by party position | `0x16FFAD8` then the record array |
| `0x800` / `0xC00` | scene object arrays at `ctx->0x64` | — |
| `& 0x8000` | explicit "none" | returns 0 |

```
FindActorByCharId(charId, fixedCount)          ; 0x17B59D0
    ctx = *(0x196A4D0) + 0x150                 ; the scene's actor context
    n   = fixedCount ? 0x0F : ctx->0x03
    rec = ctx->0x58                            ; actor records, stride 0x40
    if (!rec) return 0
    for (i = 0; i < n; i++, rec += 0x40)
        if (i - 6 <u 6) continue               ; slots 6..11 skipped
        if (rec->0x06 == charId) return rec    ; the character id lives at rec+0x06
    return 0                                   ; 0x17B5A38 — no match
```

**What is confirmed** is the code above: the two namespaces exist, and `0x400|N` returns null
for a character who is not in the scene. A scene addressing the player as `0x1400` resolves
through the leader byte and works for any avatar — which is consistent with Koroku walking in
and with NPC dialogue being fine.

**What is NOT confirmed is that this is the softlock.** The fallback patch below was built on
exactly that inference and **tested in play on 2026-08-31: the scene still hangs.** So either
scenes address protagonists some other way — the plain namespace and `0x800`/`0xC00` index
`ctx->0x58` and `ctx->0x64` **by slot**, in which case the lookup returns a real record holding
the wrong character and never goes near the null path — or the null is consumed harmlessly and
the wait is somewhere else entirely.

This does still correct an earlier claim in this document: lines are not *uniformly* addressed
to "the player", since a by-character-id namespace exists. But which namespace a real scene
uses for a protagonist's speaking beat is unknown, and cannot be settled from the ELF alone —
the scripts are in the packed event files.

### The patch — built, shipped as opt-in, and it does not work

The miss-exit is two instructions, and `FindActorByCharId` keeps **no stack frame**, so it can
tail-jump to the player lookup instead of returning null — "an actor nobody can find is you":

| ISO offset | stock | patched |
|---|---|---|
| `0x1FD238` | `03E00008` `jr $ra` | `085ED732` `j 0x17B5CC8` |
| `0x1FD23C` | `0000102D` `move $v0,$zero` | `00000000` `nop` |

**The risk is structural, not incidental.** `0x17B5CC8` calls back into this same function with
the leader byte, so in a scene whose actor table has no record for *your* leader, the fallback
recurses forever — a worse hang than the one it fixes. Two instructions is not enough room for
a guard: the exit can hold `j; nop` or `jr $ra; move`, but not a conditional with both paths.
**Result: tested in play 2026-08-31 — the scene still softlocks.** It stays in the Test tab,
labelled as tried and ineffective, because knowing a patch was built and did not help is worth
as much as the ones that did. Most likely it never fires: if scenes reach protagonists by slot
rather than by character id, `FindActorByCharId` never returns null and this exit is never
taken.

That makes four failed predictions about this hang — the per-team story index, the `evneutral`
clip, "lines belong to the scene", and now the actor fallback. The pattern is consistent: the
ELF says what the engine *can* do, and the scripts that decide what it *does* are in packed
event files outside it. Further patches are guesses at increasingly long odds; the honest next
step is [`tools/pcsx2/edsprobe.py`](../tools/pcsx2/edsprobe.py) on a machine that can run the
emulator, or accepting that non-protagonist avatars are roaming-only.

### Reading the event scripts: encoding recovered, scripts not yet located

The area archives are **not compressed** — that is how clip and asset names were grepped out
of them — so the event scripts are plain bytes on the disc. What was missing was the
*encoding*, which is why the raw opcode search in
[`MOUNT_SYSTEM_RESEARCH.md`](MOUNT_SYSTEM_RESEARCH.md) §9 returned pure noise.

**The encoding is now recovered** ([`Editor/eds_dis.py`](../Editor/eds_dis.py)). Every opcode
handler advances the script pointer by a constant — `lw rX,0xc(rY)` … `addiu rZ,rX,N` …
`sw rZ,0xc(rY)` — and that constant is the instruction length. **240 of the 359 opcodes give
one up, and every recovered length is even**, which is the check that says the reading is right
rather than merely plausible.

**Two negative results, recorded so they are not repeated.**

*The anchor search finds something, but not code.* Searching for `op 346` (set field avatar,
4 bytes) with a protagonist id finds **3055 word-aligned hits, distributed Hugo 1630 / Chris
1034 / Geddoe 364 / Koroku 9 / Masked Luc 8 / Luc 6** — protagonist-weighted, which is far too
structured for a random 4-byte pattern (expected ~1 per 4 GB). But chaining from those anchors
dies after 1–5 instructions, so they are more likely a `(0x015A, charId)` table field than
script text.

*Chain-scanning cannot tell scripts from integer tables.* A backward linear pass finds runs of
validly-chaining instructions across an archive in well under a second. It is useless as it
stands: **any `u16 < 359` with a known length chains**, so a table of small ascending integers
scores as a long instruction run. The top hits decode with their opcodes and parameters
climbing in lockstep (`op 238, op 240, op 241 … 0xEF, 0xF2, 0xF6`) — the giveaway. Zero-fill
does the same, since opcode 0 is a valid 6-byte instruction; an opcode-diversity score kills
that case but not the ascending tables.

**So: the reader works, the locator does not.** Finding the scripts needs their container
identified *structurally*, which is the next section.

### The FSECT sub-file kinds, and what each container looks like

`DATA/FSECT.BIN` classifies all **4403 sub-files** into four kinds, and the split is very
uneven:

| kind | files | bytes | header shape |
|---|---|---|---|
| `map` | 2551 | **2.11 GB** | word 2 ≈ the file size, a recurring `0x00000310` marker, and **`PS2\0`** (`0x00325350`) — present in **166 of 200** sampled, and in *no* other kind |
| `data` | 1434 | 607 MB | `0x80000020` / `0x80000030` tag, counts, then ASCII asset names (`moa_tgms_101`) |
| `battle` | 285 | 8.7 MB | three pointers, then an ASCII name (`akmt_101`) |
| `town` | 133 | 15.8 MB | 4-word header, then records at a **`0x3C` stride** |

**`town` is ruled out.** Its `0x3C` record stride is exactly the room-record size already
documented for the per-area encounter rates, and the records visibly march (`…0x112`, `0x212`,
…). It is area/room data, not scripts — which is worth knowing, because "town" was the obvious
guess.

**`map` is where to look.** It is the only kind carrying a magic, that magic is `PS2\0`, and it
holds 2.11 GB across 2551 files — the bulk of the disc, and the natural home for per-scene
data. Decoding its chunk container (the `PS2\0` magic plus the recurring `0x310` marker) would
enumerate sections and let [`eds_dis.py`](../Editor/eds_dis.py) be pointed at the right one
instead of sweeping raw bytes.

### Every named record on the disc — and why the scripts are not among them

The `map` container turned out to hold **named records**, same shape as `ETC.BIN`
(`btx_ochi_000` sits at word 19 of the header). Grepping the whole disc for that name shape
gives **167,390 records across 25 prefixes** — effectively a map of what the disc is made of:

| | | | |
|---|---|---|---|
| `btx` 58036 | `ctx` 39881 | `cha` 30013 | `mtx` 13010 |
| `chm` 7384 | `moa` 5299 | `imf` 4780 | `mom` 1677 |
| `bca` 1572 | `bgp` 1009 | `bgo` 887 | `img` 749 |
| `btc` 657 | `bgs` 626 | `bgb` 443 | `pri` 412 |
| **`eva` 363** | `rmp` 342 | `etx` 87 | `chf` 28 |
| `emd` 27 | `trin` 24 | `bms` 24 | … |

**There is no script prefix.** No `eds_`, `scr_`, `evt_`, `msg_` — every prefix is an asset
type (textures, models, motions). So the event scripts are **not stored as named records**,
which is why enumerating names cannot find them and why the earlier anchor and chain searches
had nothing to lock onto. They are unnamed data inside the chunks.

**`eva_` is event *animation*, not events.** `eva_<charcode>_<nnn>` sits in the name tables
directly beside `cha_<same code>_<nnn>`, so it is a per-character asset. It looked briefly like
the softlock answer, because among the eight shipped avatars **Koroku is the only one with
zero**:

| Hugo | Chris | Geddoe | Thomas | Luc | Masked Luc | Grassl. Chris | **Koroku** |
|---|---|---|---|---|---|---|---|
| 10 | 8 | 3 | 2 | 3 | 1 | 1 | **0** |

**It is not the answer.** Yuber has 1 and Lucia has 4, and both hang anyway. Recorded so the
clean-looking split does not get mistaken for a cause later. (53 of the 78 party models have
none, so it is not a general requirement for appearing in a scene either.)

### FOUND: the event scripts are in the `town` sub-files

Chaining with a diversity filter over the 133 `town` sub-files (15.8 MB) finds **99 script
blobs, 4646 instructions**. They are code, not tables, and three independent things say so:

1. **`0x1400` — the PLAYER actor handle**, derived from the ELF's decoder at `0x17B5A40`
   *before* any of this — appears as an opcode parameter in the data.
2. **`op 22 RideOnSetS ['0x17','0x18','0xb']`** decodes as rider EOBJ, mount EOBJ, param
   record — exactly the shape [`MOUNT_SYSTEM_RESEARCH.md`](MOUNT_SYSTEM_RESEARCH.md) §9
   describes, in a file that document never managed to locate.
3. A repeating **per-actor staging block** (`112, 111, 157, 114, 127, 120, 129`) run over
   consecutive handles `0x800`–`0x805` with round coordinates (1200, 1000, 800, 500).

`python3 Editor/eds_dis.py towns` reproduces all of it.

### How scenes actually address actors — and what that retires

Only **57 of the 359 opcodes** pass a parameter to the actor lookup, so only those parameters
are handles. That distinction matters: decoding every parameter as a handle makes the
coordinate `0x4B0` (1200) read as "charId 176", inventing references that are not there.

Restricted properly, over **12,055 handles** from every town script on the disc:

| namespace | count | share |
|---|---|---|
| **slot (plain index)** | 8612 | **71.4 %** |
| `sceneObj 0x800` | 2375 | 19.7 % |
| `indirect 0x1000` | 553 | 4.6 % |
| `PLAYER 0x1400` | 240 | 2.0 % |
| none (`0x8000`) | 222 | 1.8 % |
| `partyPos 0x1800` | 33 | 0.3 % |
| **`charId 0x400\|N`** | **0** | **0 %** |

**Scenes never name a character by id.** They address actors by *slot* — an index into the
scene's own actor array.

That **retires the actor fallback** shipped under `Test`. It patched the null return of
`FindActorByCharId`, and the `0x400|N` namespace that reaches it is used **zero** times in any
town script. The patch could never have fired, which is exactly what playtesting found; now
there is a reason rather than a suspicion. It also retires the reasoning in §9 that led to it.

**Where this points instead.** The plain-slot path bounds-checks against `ctx->0x03` and
returns null for an out-of-range slot (`0x17B5B8C`). So the candidate is: a scene stages N
actors by slot, scene setup places fewer than N because the avatar is not the character the
scene was built around, and an opcode acting on the missing slot gets null. Still a
hypothesis — but a slot-shaped one, which is where the evidence actually points.

### Where a scene decides who stands in each slot

Since scenes address actors by **slot**, the slot-to-character binding has to come from
somewhere, and it is not the script: of the 359 opcodes only three touch the character/model
tables, and the two that take an actor handle (`171`, `216`) *read* `rec->0x06` rather than
setting it. The binding is scene-setup data.

The filler is at **`0x1775E00`**:

```
count = *(u8)(scene)          ptr = *(u32)(scene + 8)
for i in 0..count-1:
    rec->0x02 = 0x13                       ; record kind
    rec->0x01 = *(u8)(ptr + 1)
    rec->0x06 = *(u16)(ptr + 6)            ; <-- the CHARACTER ID
    ptr += 0x2A                            ; source stride: 42 bytes
    rec += 0x40                            ; actor-record stride
```

So each scene owns a table of **42-byte actor entries with the character id as a `u16` at
`+0x06`**. That is the byte that decides Hugo stands in a slot rather than anyone else, and
changing it is what "recast this scene" would mean.

**LOCATED.** Scanning for the table by its *contents* — consecutive 42-byte entries with a
valid party id at `+0x06` — returns **28,452 candidates**, because it matches any region where
a small value repeats at that spacing. Anchoring on the **header** instead, and then
*validating the header against its own table* (every id must be a real party id), cuts that to
**386** with visibly coherent casts:

| scene | cast |
|---|---|
| LZVI area 0x03 | Elaine, Jacques, Geddoe, Geddoe, Queen, Leo — *Geddoe's mercenaries* |
| DKVI area 0x04 | Dupa, Hugo ×8 — *Duck Village, Hugo's chapter* |
| HNKT area 0x0C | Samus, Dupa, Samus, Percival, Hugo |
| VDZK area 0x01 | Reed, Samus, Leo, Ace, Ace |

`python3 Editor/eds_dis.py scenes [ARCHIVE]` lists them. **The character id of actor *k* is a
`u16` at `table + k*0x2A + 6`** — that is the byte that casts a role, and changing it is what
recasting a scene means. The header's stored pointer works directly as a file offset, which is
what makes the edit reachable without unpacking anything.

**Answered: the actor array is your party, then the scene's cast.** The other record filler,
`MakeActorRecord(rec, charId)` @ `0x1775AA0`, takes the id as an *argument*, and its caller at
`0x1775DE8` loops calling `0x16FFD88(slot)` — which returns `*(u16)(0x196E5F4 + slot*2)`, the
**party list at save `0x3216`**. So:

| actor slots | filled from |
|---|---|
| 0–5 | **your party**, slot 1 first — so slot 0 is your leader, i.e. your avatar |
| 6–11 | reserved — and exactly the range `FindActorByCharId` skips (`i - 6 <u 6`) |
| 12+ | the scene's own cast table |

That skip is the independent confirmation: the engine's own lookup declines to search the
range between the party block and the staged cast.

So recasting a cast-table entry changes a **staged NPC**, not the character you play — your
avatar arrives via the party list. Which also means a scene that stages Hugo *as cast* while
you play as Koroku ends up with both.

**Karaya Village (`KRVI`), where the hang was reported**, stages Hugo in three tables — the
character id of actor *k* is a `u16` at `table + k*0x2A + 6`:

| table | cast | Hugo's id byte |
|---|---|---|
| `0x4E6BB000` | Hugo, Gau | **ISO `0x4E6BB006`** |
| `0x4E6DDFFC` | Rico, Hugo | **ISO `0x4E6DE02C`** |
| `0x4E6DE804` | Fred, Hugo | **ISO `0x4E6DE834`** |

Writing `36 00` (54, Koroku) over `01 00` recasts that role. **Caveat:** several KRVI
candidates overlap in the file (`0x4E6DE002`, `0x4E6DE01A`, `0x4E6DE022` are within `0x20` of
each other), so some of that cluster are false positives — overlapping tables cannot all be
real. The two clean ones are `0x4E6BB000` and `0x4E6DE804`.

**Also ruled out: renaming the cast list.** Town sub-files carry a string pool of asset names
(`cha_syu1_101` …) alongside scene ids (`0FAKE004`) and format strings (`item %s`), and
`syu1`→`kork` is conveniently the same length. But the engine composes asset names from a model
id through `GetModelCode` (`0x1711AC8`), so the pool is a preload manifest and the id is the
real key — consistent with `ETC_BIN_MODEL_RESEARCH.md` §Test 1, where renaming records changed
nothing. Only 15 of Hugo's 50 staged variants have a Koroku equivalent anyway.

**One dead end worth recording:** the script pointer `ctx->0x0C` is *not* reachable by a
peephole scan. There are 1533 stores to some `+0x0C` in the ELF, 515 of them the interpreter's
own ip advance, and none of the rest resolve through the `*(0x196A4D0) + 0x150` chain — the
context is carried in a saved register across scene setup. Finding the loader means following
that function, not pattern-matching.

*(Aside worth keeping: the scans that appeared to take ten minutes were a bug in the chunked
read loop, which advanced by `len(chunk) - overlap` and therefore stopped advancing on the
final short chunk. Fixed; the same scan now covers 2.74 GB in 2.2 s.)*

## SOLVED: the scene softlock is a broken invariant, not a missing feature

**Reported (2026-08-31):** party contains Hugo; leader byte set to Koroku via the editor;
in Karaya Village, Sgt. Joe appears and speaks, Koroku is on screen, and the game freezes at
what should be the protagonist's reply.

That is fully explained by the two facts established above:

1. A scene's actor records are built **from the party list** — `0x1775DE8` loops
   `0x16FFD88(slot)`, which reads `*(u16)(0x196E5F4 + slot*2)`, i.e. save `0x3216`.
2. The engine finds *the player* with `GetPlayerObj` → `0x17B5CC8` →
   **`FindActorByCharId(leaderByte, 1)`** — matching the leader's character id against those
   records.

So a leader with no matching actor record has no player object: `FindActorByCharId` walks the
array, matches nothing, and returns null.

**Note what the lookup does *not* require.** It scans every record (up to 15, skipping 6–11),
so being in *any* party slot satisfies it — the leader does not have to be first for the player
object to resolve. Yet the reported hang had Koroku in party slot 6 and still froze, and moving
him to slot 1 fixed it. So the binding constraint is stronger than the lookup:

**actor slot 0 is party position 1** (the filler loops `GetPartyMemberId(1..15)` into records
0..14), and scripts address the protagonist as a **plain slot** — 71% of all actor references.
A scene that drives "slot 0" drives whoever is first in your party list, while camera and
control follow the *leader byte*. Put a different character in each and the two disagree: the
script animates one actor and waits on another.

So the invariant is the one every save the game writes obeys — **leader == party slot 1** — and
it is stricter than "the player lookup succeeds". Walking around still works (the avatar's model is
requested from the leader byte independently) and ordinary dialogue still works (it never asks
for the player actor) — but the instant a scene addresses the player, it has no actor and waits
forever. Which is precisely the reported beat.

**Every save the game writes itself keeps the leader in party slot 1** — all five blobs in the
corpus (§4). The editor let that invariant be broken, and this whole thread of hangs followed
from it. Yuber and Lucia hung for the same reason.

*Not to be confused with battle formation.* The order you set in-game is the **formation table
at `0x3240`**, which is a different table from the party list at `0x3216`. Reordering the
formation does not move anyone out of party-list slot 1, which is why the protagonist can look
like they are not "first" in play while the invariant still holds.

*One thing the confirmation does not isolate.* The successful test changed two things at once —
Koroku moved to slot 1 **and** Hugo left the party (the destructive first cut of the fix). So
"leader in slot 1" is established as sufficient; whether Hugo's presence was also part of the
problem is not separately proven. The non-destructive version now ships, so the clean
experiment — `[Koroku, …, Hugo]`, both present — is one save edit away.

**Confirmed fixed in play (2026-08-31): Karaya Village now plays through, and Koroku walks the
scene where Hugo would have.**

**The fix is a save edit, not a patch.** Put the character in party slot 1 as well as in the
leader byte. As of this change the editor does both: the Field character picker sets slot 1
alongside the leader and says so, and the Health tab's `party-leader-absent` finding is
upgraded from an *info* note to an **error** with a one-click fix.

**Doing it without costing a party member.** The first cut of this wrote slot 1 outright, which
loses whoever was there — and when the pick is *already* in the party you end up holding two of
them and one fewer of someone else. That happened: Hugo in slot 1, Koroku in slot 6, picking
Koroku produced two Korokus and no Hugo. `promoteToLead()` now handles all four shapes:

| party before | pick | after | |
|---|---|---|---|
| `[Hugo, Chris, –, –, –, Koroku]` | Koroku | `[Koroku, Chris, –, –, –, Hugo]` | **swap** — nobody lost |
| `[Hugo, Chris, Geddoe, –, –, –]` | Koroku | `[Koroku, Chris, Geddoe, Hugo, –, –]` | occupant parked in a free slot |
| `[–, Chris, Geddoe, –, –, –]` | Koroku | `[Koroku, Chris, Geddoe, –, –, –]` | slot was empty |
| full, pick from outside | Koroku | slot 1 replaced | the only case that drops anyone, and it names them |

The Health fix does the same, and its label says *"(drops X)"* when the party is full.

This also retires, with a cause, the four failed explanations recorded above — the per-team
story index, the `evneutral` clip, "lines belong to the scene", and the actor fallback. None of
them were the problem; a broken save invariant was.

### The one patchable idea, unexplored

Make a motion-wait give up when `SetMotion` reports failure instead of waiting forever, leaving
the actor in their normal pose so the scene continues. `SetMotion` already returns the flag and
the caller ignores it. It would only address hangs of that specific shape — Yuber's may not be
one — and it is a shared path touched by every scripted motion in the game, so it is a
materially bigger blast radius than anything shipped here. Research before it is a feature.

Clip data caveat: measured where records sit in the **uncompressed** area archives. Presence of
a clip is solid evidence; absence is weaker, because `ETC.BIN` payloads are compressed and
opaque.

## 10. What shipped (v1.61.0, extended in v1.62.0 and v1.63.0)

Both halves, because the cheap one covers six of the seven characters asked for and the other
one is two words.

**A — save side, no ISO needed (Hugo, Chris, Geddoe, Thomas, Koroku, Luc).**
`s3save.FIELD_AVATAR_IDS` records the whitelist and `party_reference()` hands it to the web
app; `apply_edits_to_gamedata` takes a `leader=` and writes `0x12` as a **halfword**, so it
owns `0x13` instead of trusting it to be zero (the engine reads the field with `lh`/`lhu` at
all 24 of its references). The Overview gained a **Field character** picker that offers the
whitelisted eight first as *engine default* and every other battle character as *needs ISO
patch*, and a value the picker cannot offer — a dog, a special — is kept rather than dropped.

**B — ISO side, for Sarah and anyone else.** A **Field character** section that rewrites the
immediates in the table above: byte-signature check on `+2,+3`, one button to widen both bounds
to `0x53`, one to restore stock, and — the part worth having — a "currently loadable" readout
that re-runs the game's own comparison chain over the bytes just written, rather than restating
what the buttons were supposed to do.

**v1.62.0 added** the per-map coverage from §6 to both tabs (the save picker names how many
of the 28 area archives ship each character's field model, before you pick) and a **Story
content** control in the ISO tab that retires a character's case at the `0x177FEB4` switch so
it falls through to Hugo's index — the empty-dialogue fix from §7.

**v1.63.0 added** the Encounter tab's **Movement rules** panel from §8: independent
walking/running toggles and the second-run-range mode switch that makes Koroku and Fubar roll
encounters when they run.

**Tested by** `web/tests/field-avatar.mjs` (the restated tables against `s3save.py`, the chain
against both stock and widened immediates, the picker's grouping, and the eight sites against a
pristine disc when one is present), the field-character block in `web/tests/save_roundtrip.py`,
and an end-to-end block in `web/tests/e2e.mjs` that drives the tab and byte-checks what it wrote.

**The one experiment still worth running:** set the leader to `54` (Koroku) on a post-merge save
in an area that already carries `kork`, boot it, and see whether you walk around as the dog and
whether the value survives the first area transition. That settles constraints 1 and 2 together,
and `tools/pcsx2/` can drive it. Everything above is static analysis plus the corpus; nothing
here has been played.
