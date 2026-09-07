# Trinity Sight System — what the chapter-select screen reads out of a save

**Status:** offsets and semantics proved from the game's own code plus a 69-save corpus.
**Editing them has not been play-tested** — see [§6](#6-what-is-not-proven).

Suikoden III's Trinity Sight is the between-chapters screen with the flames on it: pick a
point of view, get that character's next chapter. Six flames — Hugo, Chris, Geddoe, then
Thomas (lit mid-way through Geddoe's chapter 1), Koroku (lit when you adopt the dog) and Luc
(lit after clearing the game with all 108 Stars).

The question this doc answers: **which bytes of a save decide what that screen offers.**

---

## 1. The menu builder names its own inputs

The builder is not in the boot ELF — there is no read of the flag bank's byte 4 anywhere in
`SLUS_203.87`. It is in the **`DATA/ETC.BIN` overlay**, the same one that holds the memory-card
code and the Suikoden II importer (see
[`S1_S2_CARRYOVER_TRACKER.md`](S1_S2_CARRYOVER_TRACKER.md) for that overlay's calibration).

At **ISO `0x41A054EC`** (copy 2 of the overlay), inside a loop bounded by
`slti $v0, $s1, 6` — six entries:

```
    stage = Counter(table[entry].id - 1)      ; 0x16D39C8, get mode
    if GameFlag(4, entry, TEST)  state |= 1   ; "this flame is lit"
    if GameFlag(5, entry, TEST)  state |= 2   ; a second per-entry bit
    if stage                     state |= 4   ; "this point of view has been started"
```

`$s1` is the entry index and is passed straight through as the **bit number**, so the six
points of view are the six low bits of flag byte 4 and one counter each.

Three inputs, then: **flag byte 4**, **flag byte 5**, and **one progress counter per POV**.

## 2. Flag byte 4 = the flame mask — save offset `0x34`

The flag array is 0x200 bytes at RAM `0x196B410`, which is save offset `0x30`
(`s3save.FLAG_BASE`), so flag index 4 is **save offset `0x34`**. Accessor `0x16D3930`
(index, bit, mode; mode 6 = set, 7 = clear, 3 = test).

| bit | flame | lit when |
|---|---|---|
| 0 | Hugo (1st) | new game |
| 1 | Chris (2nd) | new game |
| 2 | Geddoe (3rd) | new game |
| 3 | Thomas (4th) | mid Geddoe chapter 1 |
| 4 | **Luc (6th)** | game cleared with 108 Stars |
| 5 | **Koroku (5th)** | Koroku is adopted |

Note bits 4 and 5 are **not** in on-screen flame order.

Two independent confirmations:

- **New-game init** (ELF `0x17B9C68`–`0x17B9C94`) sets flag 4 bits 0, 1 and 2 back-to-back
  and nothing else — exactly the three starting flames.
- **The corpus.** Across the 20-save sequential playthrough in `Saves/S3 Saves` (which
  follows the GameFAQs walkthrough's order), `0x34` reads:

  | save | in chapter | `0x34` |
  |---|---|---|
  | `_01`–`_03` | Hugo 1, Chris 1 | `0x07` |
  | `_04` | Geddoe 1 | `0x0F` — the walkthrough's "Thomas' flame at the Trinity Site will be lit" |
  | `_08` onward | Geddoe 2 | `0x2F` — the save where Koroku is adopted |
  | `_20` | Luc's chapter | `0x3F` |

  Bits 6 and 7 are 0 in all 69 corpus saves.

## 3. Flag byte 5 — a second bit per POV, unidentified

Same bit-per-POV layout at save offset `0x35`, read by the builder into a different state
bit. It is **not** an unlock: across the playthrough it goes `0x20` → `0x21` (Hugo's chapter
3) → `0x25` (Geddoe's chapter 3) → back to `0x20`, i.e. it is set and cleared as chapters
run. Best guess is an "in progress / awaiting" marker per entry. The editor does not touch it.

## 4. The progress counters — eight u16 at save offset `0x3B0`

Accessor `0x16D39C8`: 8 slots (`sltiu $a3, 8`), u16 each, at RAM `0x196B790`; modes include
**2 = set** and **3 = get**. The bank sits at +0x3A0 in the same RAM struct whose +0x20 is
the flag array, and the flag array is save `0x30` — so the counters are **save `0x3B0`**.

| slot | offset | owner |
|---|---|---|
| 0 | `0x3B0` | unused (0 in all 69 saves) |
| 1 | `0x3B2` | Hugo |
| 2 | `0x3B4` | Chris |
| 3 | `0x3B6` | Geddoe |
| 4 | `0x3B8` | Thomas |
| 5 | `0x3BA` | Luc |
| 6 | `0x3BC` | Koroku (by elimination — weakest row here) |
| 7 | `0x3BE` | the merged main story (chapters 4–5) |

Slots 1–4 are pinned by the playthrough: each one moves in exactly the save where that
protagonist's chapter advances, and in no other. Slot 5 is 0 everywhere except the two
Luc-POV saves. Slot 6 is 0 in the playthrough that never walked around as the dog and 9 in
the two that did.

These are **stage** numbers, not chapter numbers: a chapter spans several values, and each
POV has its own scale.

| stage | Hugo | Chris | Geddoe | Thomas | Luc | Koroku | main |
|---|---|---|---|---|---|---|---|
| chapter 1 | 1, 2, 3 | 1, 3 | 3 | 3 | 1 | 9 | — |
| chapter 2 | 4 | 5 | 4 | 7 | — | — | — |
| chapter 3 | 8 | 7, 8 | 8 | — | — | — | — |
| chapter 4 | 9, 10 | 9, 10 | 9, 10 | — | — | — | 9, 10 |
| chapter 5 | 11 | 11 | 11 | — | 11 | — | 11 |
| cleared | 12 | 12 | 12 | — | — | — | 12 |

Two behaviours in this table are also in the code rather than only in the data:

- **8 is the engine's own "reached chapter 3" line.** `0x17B8AC0` reads slots 1, 2 and 3 and
  tests each with `slti $v0, $v0, 8`.
- **The merged story drags H/C/G along with it.** Script handler `0x17B1BF0` reads slot 7 and
  writes it into slots 1, 2 and 3 — which is why all four read 9/10/11/12 together from the
  merge onwards.

## 5. What the editor does with this

`Editor/s3save.py`: `TRINITY_POVS`, `STAGE_BASE`, `decode_trinity()`, `apply_trinity_edits()`,
`trinity_reference()`. The web editor's **Trinity Sight** panel is six flame checkboxes over
`0x34` plus one chapter dropdown per POV over `0x3B0`, and a row for the merged story.

The dropdowns offer the **lowest stage a real save was seen holding in that chapter** — the
chapter's opening state, which is what "put this POV at chapter N" wants. A save whose
current stage is mid-chapter keeps that value as a selectable "stage N (as saved)" option, so
opening the panel and changing nothing cannot quietly rewind anyone.

Covered by `web/tests/save_roundtrip.py` (engine: bits, slots, chapter decode, no-op rules)
and the Trinity block in `web/tests/e2e.mjs` (UI → review list → write payload).

## 6. What is **not** proven

- **No play test.** Nothing here has been verified in-game. In particular, lighting Luc's
  flame on a save that has not cleared the game may lead somewhere the game is not ready
  for — his chapter expects post-clear state. Keep a backup.
- **The chapter-select value is inferred.** Every observed stage comes from a *mid-chapter*
  save, since that is when people save. That chapter N's opening stage is the value which
  makes the screen offer chapter N is the obvious reading, not a demonstrated one.
- **Slot 6 = Koroku** is elimination plus two saves, not a proof.
- **Flag byte 5** is unexplained (§3).
- **Stage → label** for Luc and Koroku is one row each; their middle stages are unsampled.

## 7. Incidental correction: story phase 5 is Luc, not "merged"

`s3save` read `storyPhase` (`0x14`) as "≥ 5 means the parties have merged". The corpus is
narrower than that: **1** Hugo, **2** Chris, **3** Geddoe, **4** Thomas, **5** Luc's POV,
**7** the merged chapters 4–5. 6 is unobserved. The inventory layout is the same for 5 and 7
(one shared bag), so `MERGE_PHASE` stays correct as a bag-layout test — but the phase byte
names a point of view, not a stage of the story.
