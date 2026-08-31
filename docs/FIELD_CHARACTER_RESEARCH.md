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
2. **Residency is a real risk, but a smaller one than `ETC_BIN_MODEL_RESEARCH.md` implies.**
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

## 6. Route to a feature

Two independent halves, and the cheap one covers six of the seven characters asked for.

**A — save side, no ISO needed (covers Hugo, Chris, Geddoe, Thomas, Koroku, Luc).**
`Editor/s3save.py` already decodes `partyLeader` at `(0x12, 1)` and `web/app.js` already
renders it read-only on the Overview. Make it a picker over the 75 battle characters, with the
eight whitelisted ids marked as the ones the engine will actually load and everything else
shown as unsupported. Note that `0x12` reads as a `u16` in the engine (`lh`/`lhu`) while
`s3save` treats it as one byte — harmless today because every legal id is `< 0x100`, but the
write path should clear `0x13` rather than assume it.

**B — ISO side, for Sarah and anyone else.** A small section that rewrites the immediates in
the table above, in the shape of the Mounts patch: byte-signature check on `+2,+3`, stock-value
verification, an explicit "widen to all 75" option, and per-name swaps.

**The one experiment worth running before either ships:** set `0x12` to `54` (Koroku) on a
post-merge save in an area that already carries `kork`, boot it, and see whether you walk around
as the dog and whether the value survives the first area transition. That single test settles
constraints 1 and 2 together, and `tools/pcsx2/` can drive it.
