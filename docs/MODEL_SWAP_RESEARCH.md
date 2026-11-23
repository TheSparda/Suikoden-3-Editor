# Model swap research (archived, paused)

Status: paused as of 2026-11-23. Summary and conclusions: issue #18, "Model swapping: research findings (battle binding solved, battle completion blocked, work paused)". What follows is the full lab record of the model-swap sessions, copied verbatim from the research notes.

# Suikoden III - visual model swap feasibility (Hugo renders as Koroku)

Tested live in PCSX2 on 2026-11-22 (private instance, PINE slot 28016, copied
memcards, pristine ISO untouched). This study supersedes the static-only
infeasibility verdict in the editor repo's `docs/ETC_BIN_MODEL_RESEARCH.md`
for the route that matters: that verdict correctly killed in-place ETC.BIN
payload swaps, but it never tested the resource-binding layer, because the
lab had no working emulator automation at the time. Tested live, the binding
layer is exactly where a clean swap exists.

## Verdict

**Feasible via a reference-level swap at the model-resource binding, proven
in game on the field. Battle uses the identical binding mechanism and the
same swap was applied to the battle resources in the same session, but no
battle was reached to screenshot it, so the battle half is
mechanism-identical and unproven on screen, not proven.**

What was proven on the field, in one session, with screenshots:

- Hugo's unit (party slot 1, leader byte still 1, his stats, runes and party
  untouched) walked around Budehuc Castle rendered as Koroku the dog:
  correct dog model, dog locomotion animation, no T-pose, no crash, NPCs
  unaffected.
- The swap is a pair of u32 writes. No payload bytes move, nothing is
  repacked, and it is fully reversible.

What was refuted in game (same session):

- The obvious reference table, `GetModelCode`'s id-to-code-string pointers,
  is NOT the model binding. Swapping Hugo's and Koroku's entries on an ISO
  copy, verified live in RAM, changed nothing on the field.
- Swapping the payload pointers inside the loaded resource objects changed
  nothing either: actors cache their binding when they are created, so the
  swap only takes effect at the next actor (re)creation (a room change).

## The characters and their assets

Party id space and model id space are the same numbers (editor repo,
`docs/FIELD_CHARACTER_RESEARCH.md` section 1, and `docs/s3_model_ids.json`,
decoded from the banded lookup at ELF 0x1711AC8):

| character | model/party id | asset code |
|---|---|---|
| Hugo | 1 | `syu1` |
| Koroku | 54 | `kork` |

Models live in `DATA/ETC.BIN` (386,756,608 bytes at ISO offset 0x375AD800;
ISO offset = ETC offset + 0x375AD800) as plaintext serialized node trees,
duplicated per scene bundle, plus embedded copies in the per-area FSECT
archives. Name occurrences in ETC (editor's `etc_inventory.json`):

| code | cha | imf | ctx | variant coverage |
|---|---|---|---|---|
| `syu1` | 79 | 32 | 24 | field set 001/010/020, battle animation set 100-190, plus 040-076 story poses, 200, 300-380, 700, 970-976 |
| `kork` | 44 | 22 | 16 | field set 001/010/020 (multiple copies), battle animation set 100-190 (subset), 426 |

Field and battle use the same base model; battle adds the `1xx` animation
payloads. There is no separate "battle model" asset for either character.

Measured payload spans exist only for `syu1`: it is the one character whose
ETC entries carry the true directory shape (16-byte name, flags 0x00010000
at +0x10, in-RAM footprint at +0x14), and all 65 such records in ETC are
`syu1`. From the lab extraction (`data/ETC/`): `cha_syu1_001` stored span
7,924 bytes (footprint word 163,840), `cha_syu1_010` 24,888 bytes,
`cha_syu1_020` 23,664 bytes, `cha_syu1_040` 40,536 bytes,
`cha_syu1_200` 499,052 bytes. Koroku has no directory records, so no
equivalent span table exists for `kork`; his payloads sit in bundles
without that record shape. This asymmetry is also why in-place payload
replacement was never viable: stored spans are variable, tightly packed,
and (for Koroku) not even delimited by a size word.

## The reference mechanism (the part the old verdict was missing)

Models are not loaded by name string and not by a disc offset table. They
are loaded into fixed memory regions and bound to characters by a numeric
tag at actor-creation time:

- A region base table sits in the boot ELF at RAM 0x19933A0 (u32 base per
  region id; accessor 0x188A7E8). Model resources occupy two region sets:
  the field set (regions 14-22) and the battle set (regions 6-13).
- Each loaded model resource has an object at `region_base + 0x40`:
  `+0x00` is the set type (3 = field, 4 = battle) and `+0x04` is the
  character-id tag.
- Field actor creation (`0x1775AE8`, right after `MakeActorRecord`) binds
  each actor through `FindResourceSlotFor` (0x1775A40), which scans field
  regions 14-22 and returns the first resource whose `+0x04` equals the
  character id. Battle spawn resolves the unit descriptor through the same
  kind of scan over battle regions 6-13 (`0x188BF40`, used by
  `GetBattleUnitDesc`).
- Measured live in the test session (Hugo + Koroku + the four other dogs in
  the party, at Budehuc): field region 14 held tag 1 (Hugo), region 15 held
  tag 54 (Koroku), regions 16-19 held tags 210-213 (Koichi, Connie,
  Kosanji, Kogoro); battle region 8 held tag 1, region 9 held tag 54,
  regions 10-13 held 210-213.

So the "index" the Phase 1 research went looking for on disc is a RAM-side
tag written by the loader, and the binding is a single u32 comparison per
actor. Whoever controls the tag controls which model a unit renders with,
without touching the unit's stats, runes or identity, which all key off the
character id everywhere else.

`GetModelCode` (0x1711AC8) does exist and does map model id to the 4-char
asset code through a banded pointer table (band 1 at RAM 0x1967FB0, entry
index = id - 1; Hugo's entry at ISO 0x3ACFB0 points at the string `syu1`,
Koroku's at ISO 0x3AD084 points at `kork`). Its callers use the code for
name composition in manifests and motion lookup, but the live test below
shows the model loader does not resolve through it.

## What the editor already has (and why this question is still new)

The editor's Test-tab "Field character" subtab widens a hardcoded whitelist
in `FieldAvatarModelRequest` (0x17B7560; gates at ISO 0x1FED70 and
0x1FED80) so the party-leader byte at save 0x12 can name characters beyond
the stock eight, and the Save Editor's leader pick then sets that byte.
Koroku (id 54) is one of the stock eight, so today you can already walk
around AS Koroku with no patch at all. But that replaces the unit: the
leader becomes Koroku, with Koroku's identity in the leader slot. It does
not keep Hugo's unit (his stats, runes, story role) and change only its
model, it does not apply per party member, and it says nothing about
battle, where party members spawn from the battle resource set. The
per-character model-versus-identity split tested here is the genuinely new
question.

## Routes tried, in order, with live results

All dynamic work used a private PCSX2 copy at
`suikoden3-debug/scratch/pcsx2-modelswap/` (PINE slot 28016), copied
memcards (card 1 = a copy of the fixture "Mcd001 (Main).ps2", File03 =
Hugo Chp. 5 at Budehuc, party Hugo / Koroku / Koichi / Connie / Kosanji /
Kogoro), and ISO copies under `suikoden3-debug/scratch/`. The pristine ISO
and the original saves were never written.

### Route (a1): reference swap at GetModelCode (ISO copy) - REFUTED in game

Built `scratch/modelswap-hugo-kork.iso`: at ISO 0x3ACFB0 the pointer
0x19E6E70 (`syu1`) and at ISO 0x3AD084 the pointer 0x19E6CF8 (`kork`) were
swapped, stock bytes asserted before writing. Booted it, confirmed via PINE
that RAM held the swap (id 1 resolved to the string `kork`, id 54 to
`syu1`), loaded the Hugo save: **Hugo rendered as Hugo on the field**,
idle and running animations normal. The code-string table is not the model
binding. (Battle was not separately tested under this route; the field
result already removes its reason to exist.)

### Route (a2): payload-pointer swap inside the resource objects - REFUTED in game

With both models resident, the three payload pointers (+0x08, +0x0C, +0x18)
of Hugo's and Koroku's field resource objects were swapped via PINE.
**No visual change.** The actor had cached its binding at creation; the
resource object's pointers are not re-read per frame. A savestate taken
before the writes was used to restore clean RAM.

### Route (a3): character-id tag swap on the resources (RAM) - PROVEN on the field

Via PINE, the `+0x04` tags were swapped: field region 14 (Hugo's payload)
1 to 54, field region 15 (Koroku's payload) 54 to 1, and the same for
battle regions 8 and 9. Nothing changed on screen until Hugo walked
through a door into the next room, at which point scene setup rebuilt the
actors and **the player avatar came back as Koroku's dog model**:
orange shiba, patterned scarf, dog walk cycle, fully player-controlled
across several rooms, NPCs (maids, a duck clansman, a guard, a man in a
plumed hat) all rendering as themselves. No T-posing, no crash, no missing
model. RAM readback during the swapped state: leader byte still 1, party
list unchanged (Hugo, Koroku, Koichi, Connie, Kosanji, Kogoro by id),
so the unit's identity, stats and runes were Hugo's throughout; only the
rendered model was Koroku's. Because the tags were swapped as a pair,
Koroku's own actor would likewise bind Hugo's payload wherever the game
stages him; a one-way variant (write tag 1 onto Koroku's resource and
retire Hugo's tag to an unused value) was not separately tested.

Evidence (in `suikoden3-debug/scratch/shots/`):

- `loadscreen_dog_party.png` - the save used: Hugo Lv64, Koroku Lv72 and
  the four dogs.
- `field_stock_hugo_closeup.png` - stock binding under the route (a1) ISO:
  Hugo renders as Hugo (route a1 refuted).
- `field_swap_koroku_avatar.png`, `field_swap_koroku_rear.png`,
  `field_swap_koroku_front.png` - after the tag swap and a room change:
  the player avatar is Koroku, from three angles, NPCs normal.

### Route (b): in-place payload replacement - not attempted, already dead

Not attempted in this session. The earlier structural work stands and this
session added nothing against it: payloads are variable-length, tightly
packed, Koroku's are not even size-delimited, and route (a3) makes the
whole idea unnecessary.

### Route (c): repack with index fix - not attempted, unnecessary

There is no disc offset table to fix; the binding is the RAM tag described
above. A repack would solve a problem the game does not have.

## Battle: what is established and what is not

(SUPERSEDED in part by the third extension session below: the world map
proof is now PROVEN, and the battle half was tested on screen and came
out NEGATIVE for post-load RAM swaps - battle renders stock and the
swaps destabilise battles. Read that section for the current verdict.)

Established statically and by live RAM inspection:

- Battle units spawn from the battle resource set (regions 6-13) through
  the same tag scan (`0x188BF40` compares resource `+0x04` against the
  character id, exactly as the field scan does).
- In the test session both battle resources were resident before any
  battle (region 8 = Hugo's battle asset, region 9 = Koroku's), and their
  tags were swapped along with the field pair, so the swap was armed for
  battle in the same state that produced the field screenshots.

Not established: the on-screen battle result. No battle was reached in the
session. The save sits inside Budehuc Castle, which has no random
encounters; reaching one meant navigating the dog avatar out of the castle
and across the world map with the party at Lv 64-72, and that exit run was
still in progress when the session's emulator budget (about 90 minutes)
ran out. That is the only blocker: access to an encounter, not a mechanism
question. The follow-up is cheap for whoever runs it next: with the tag
swap applied (script below), leave Budehuc, take one random encounter, and
screenshot the first battle round. Expected from the mechanism: Hugo's
unit spawns with Koroku's battle model and dog battle animations, and
Koroku's unit with Hugo's; the risk to watch is the battle descriptor's
extra fields (movement pair, weapon reach) coming from the donor asset,
which the movement research already documents as asset-sourced.

(2026-11-22, later session: the exit run was attempted again at length and
the castle exit was still not found; see the extension section below for
exactly which doors were tested and how they behaved. The battle
screenshot remains open, and "leave Budehuc" is now a documented blocker
in its own right for this save state, not a formality.)

## Extension session 2026-11-22 (later): new-game opening, dialogue, menu portraits

Same private instance, same prototype script, same rules (copied memcards,
pristine ISO untouched, verified by hash before and after). Three
questions were put to the swap this time.

### 1. New game, Hugo Chapter 1 opening: the swap CANNOT be applied there

A fresh new game was started (POV select: Hugo) and the resource tags were
scanned repeatedly through the whole opening sequence: the FMV-exit ride
across the plain (Hugo mounted on Fubar), the arrival above Karaya
village, the close-up shots, and the first dialogue scene in the village
(Hugo to Lulu: "You know a better way to get their attention? With their
help, I'll be the best rider in the village."). At every checkpoint the
field set held exactly three resources: region 14 tag 1 (Hugo), region 15
tag 9 (Fubar), region 16 tag 8 (Sgt. Joe); regions 17-22 were empty (tag
0). The battle set mirrored it (region 8 tag 1, region 9 tag 9, region 10
tag 8). **No resource tagged 54 exists anywhere in the opening.** Koroku's
model is simply never loaded in Hugo Chapter 1's opening scenes, so the
tag swap has nothing to bind Hugo to: the mounted opening cutscene and
its dialogue render stock Hugo, and no tag write can change that (writing
an unused tag value onto Hugo's resource would leave the actor scan with
no match for id 1, which is a break risk, not a swap). Kevin's separate
report that Koroku's model works in Chapter 1 scenes is not contradicted
for Chapter 1 in general, but for the opening sequence specifically the
RAM evidence is unambiguous: the resource is absent. The first moment the
swap can appear in any run is the first scene change after both models
are resident, which is the Budehuc situation below. Stock evidence:
`newgame_opening_dialogue_stock.png` (the "best rider" dialogue, Hugo's
own model), `newgame_51_opening.png` (mounted ride).

### 2. Dialogue with the swap active: works (Budehuc, File03)

With the swap applied on File03 and bound by the hall-to-corridor scene
change, an NPC dialogue was triggered and completed normally: the castle
guard by the corridor junction double doors, line "I believe the guests
are from Harmonia. You know, I think I saw the Bishop's robes..." The
dialogue box types, advances and closes correctly; the game is stable; no
crash or hang with the swapped binding in a conversation. Framing caveat
for screenshots: S3 frames the speaking NPC in the upper frame and the
dialogue box covers the lower frame, so at dog height the player avatar
stands at the NPC's feet largely behind the box (Hugo's taller model
would clear it; Koroku's does not). The dog is on screen at the guard's
feet at the box's top edge. Evidence: `cutscene_dialogue_11_knight.png`,
`cutscene_dialogue_17_knight_full.png` (completed line),
`field_dog_knight_cat.png` (the same spot just after closing: dog avatar
at the guard's feet, resident cat beside). Interaction note: field talk
(Cross) has a tight range/facing window; the maids, the duck clansman and
the staff-holding woman gave no response at apparently adjacent
positions, while the guard responded at point-blank range. The party
menu opens on Square, not Triangle.

### 3. Bonus: the party menu portraits follow the same binding

With the swap active, the party menu shows the portraits swapped as well:
Hugo's entry (Lv 64, displayed as "Sparda", the Flame Champion name on
this save) carries Koroku's dog portrait, and Koroku's entry (Lv 72)
carries Hugo's portrait. The menu portrait is drawn from the same bound
resource, so the remap reaches UI as well as the field. Evidence:
`menu_portraits_swapped.png`.

### Persistence and one caution

The tag swap survived repeated map changes inside Budehuc (hall to 2F
corridor and back), consistent with the party resources staying resident
across room loads. Caution: once, after extended camera-relative movement
near the corridor junction, the avatar left the visible frame while the
camera kept tracking an off-screen point (cause not determined; possibly
a collision seam at the junction's south edge). It was recovered by
reloading the stock savestate and re-running the script, which restored
the exact pre-swap state and re-applied cleanly.

### World map and battle: still not screenshotted

The exit hunt this session was systematic and came up empty. From
File03's hall: the south wall was pushed at four separate x positions
(wall every time); the west wall likewise; the hall's NW double doors
(carpet, handles) were walked into and examined with Cross at
point-blank: no response. The corridor junction double doors and the
corridor side door by the rubble behaved the same (walk-in and Cross: no
response). In this chapter state (Hugo Ch.5, Harmonian delegation in the
castle, per the guard's dialogue) those doors read as locked or
decorative, and no other exit from the hall/corridor maps was found. So
the world map proof and the battle proof remain open for the same reason
as before, now with the tested-and-failed routes documented. The battle
half is unchanged otherwise: battle tags were swapped and read back in
RAM this session too (regions 8 and 9 exchanged), so a battle entered in
this state would be expected to spawn Hugo's unit with Koroku's battle
model; it has still never been on screen.

## Extension session 2026-11-22 (third): Route 1 - a Hugo Ch.1 field save (Plain Amur)

The Budehuc exit blocker was bypassed by changing saves instead of doors.
The save-slot scan (editor `s3save` tooling over every card in
`suikoden3-debug/saves/` plus the scratch cards) found the editor fixture
card `Card1.ps2`, whose saves u07/u08/u09 are Hugo Chapter 1 states with
Koroku in the party. File08 (folder `BASLUS-20387sui3_u08`) is the pick:
Hugo Story Chp. 1 at **Plain Amur** (an encounter field area), party
Koroku (54) / Fubar (9) / Sgt. Joe (8) / Lulu (10) / Hugo (1), levels
5-15. Its stored leader byte was 54, so on the scratch COPY of the card
only, the leader byte was patched 54 to 1 with the editor's
`write_save_edits` (checksum fixed, verified), making Hugo the field
avatar unit. The pristine card and ISO were never written (ISO sha256
`36622eee...f78424b` before the session).

Load-menu mechanics worth recording: the file list pages four files at a
time; Up/Down wrap within the visible page and Left/Right switch pages.
What first looked like dropped inputs in this session was the wrap.

Tag state on loading File08 at Plain Amur: field regions 14-18 held tags
54, 8, 10, 9, 1 (party order); battle regions 8-12 held the same five
tags, battle regions 6/7 held 308/309. The prototype script swapped the
1/54 tags in both sets cleanly (field 18/14, battle 12/8), and the tags
were re-read mid-battle later and were still swapped, so the resources
were not reloaded by the battle.

### Battle result: the battle-set tag swap alone does NOT swap battle models (negative, on screen)

Walking south from the Plain Amur save point triggered a random
encounter (3 BladeBunnies) with the swap already applied. Command-phase
evidence identifies each commanded unit two ways at once: the orange
selection arrow sits over the unit being commanded and the pair label
names it. "Koroku" was commanded over the DOG model; "Hugo" (pair
"Hugo / Fubar") was commanded over the BLOND Hugo model. In other words
both units rendered stock, even though their resources' tags were
swapped before the battle and remained swapped during it. The dog unit
was also captured mid-action (leap/attack run) during the round, but as
Koroku's own unit, not Hugo's. Screenshots: `battle_02_start.png`,
`battle_03_cmd1.png`, `battle_04_cmd1b.png`, `battle_09_joe_cmd.png`,
`battle_10_hugo_target.png`, `battle_24_exec.png`, `battle_25_exec.png`
in `suikoden3-debug/scratch/shots/`.

So the static claim "battle spawn resolves through the same tag scan"
needs a qualifier: whatever `GetBattleUnitDesc` / the `0x188BF40` scan
feeds, the party's battle model binding was already fixed before this
battle started (most consistent with the binding being cached when the
area staged its battle roster, i.e. at area load, before the swap was
applied). The field binding, by contrast, demonstrably re-resolves at
actor creation. Next lever for battle, untested: swap the battle
resources' payload pointers (+0x08/+0x0C/+0x18, the route (a2) writes)
in addition to the tags, before entering a battle - battle actors are
created fresh each battle, so the (a2) "cached at creation" refutation
does not cover them.

### Post-battle soft-lock (observed once)

After the party won that battle, the game settled into a static
post-battle scene (Lulu, the dog and Fubar visible, no HUD) and ignored
all input for several minutes while the emulator stayed live (PINE
status 0, process at ~55% CPU). The session was recovered by restarting
the private emulator. Whether the tag swap caused the hang (e.g. in the
battle-exit field-actor recreation) is undetermined; it is recorded
here so the next session watches for it instead of rediscovering it.

### Environment recipe (this VM, rediscovered the hard way)

The private instance needs more than its binary path on this box:
Xvfb on a free display (:77 here; :84 belongs to the Suikoden V
session), `LD_LIBRARY_PATH` including
`ps2-re/tools/glib-fix/minlib`, `__EGL_VENDOR_LIBRARY_DIRS` pointing at
the glib-fix extracted `usr/share/glvnd/egl_vendor.d`,
`LIBGL_ALWAYS_SOFTWARE=1`, a private mount namespace with a fresh tmpfs
over /dev/shm (`unshare -rm`, per the S5 wrapper, because sibling
instances exhaust the shared 794 MB /dev/shm), and xdotool/xwd taken
from the glib-fix extracted `usr/bin` with minlib on the library path.
Input that works: `windowfocus` + XTEST keydown/keyup, ~0.3 s holds.

### World map: PROVEN (same session, after the baseline control)

The Plain Amur exit (south end of the area, past the stone arch) deposits
the party on the world map at the junction where the light path meets the
main road. Procedure that produced the proof: (1) baseline control first -
with NO swap, a Furrfly battle on Plain Amur was fought to completion
(results screen, Cash 1326p, field return all normal), so battles in this
environment are healthy unswapped; (2) the tag swap was then applied in
the field and Hugo walked straight out the south exit with no battle in
between. **The world map avatar is Koroku**: the orange shiba with the
patterned scarf, standing at the junction node and walking the roads,
while the unit is still Hugo (leader byte 1, his party and stats).
Evidence: `worldmap_hugo_as_koroku.png` (full map view),
`worldmap_dog_walk1.png`, `worldmap_dog_walk2.png`, and the control
`worldmap_00_stock_avatar.png` (same exit taken earlier under a
tag+pointer double swap whose two halves cancel, avatar stock Hugo).
So the world map scene creates its avatar through the same tag binding
at scene entry, exactly like a room change at Budehuc.

### Battle: the post-load RAM swaps do NOT swap battle models, and they destabilise battles (negative, on screen, with control)

Two configurations were tested against random encounters on Plain Amur,
both applied in the field after the area had loaded:

- Tag swap only (run 1): the battle rendered STOCK. Command-phase
  evidence is two-way: the orange selection arrow sits over the unit
  being commanded and the pair label names it - "Koroku" was commanded
  over the dog model, "Hugo" (pair "Hugo / Fubar") over the blond Hugo
  model. The tags were re-read mid-battle and were still swapped, so the
  resources had not been reloaded: the battle binding simply does not
  consult the region objects' +0x04 at battle time.
- Payload-pointer swap only (+0x08/+0x0C/+0x18 crossed, tags stock;
  run 4): same stock rendering in the command phase ("Koroku" over the
  dog), so the battle binding does not consult those pointers at battle
  time either.

Worse, both configurations destabilised the battle flow, against a clean
unswapped control battle in the same environment: with the tag swap, the
round executed and the enemies died, but the game then hung in the
post-battle gather scene (party visible, no HUD, no input response for
minutes, emulator live); with the pointer swap, the game hung mid-round
during an attack animation. The consistent reading is that the party's
battle unit descriptors are built before any field-applied swap can
matter (most plausibly when the area stages its battle roster at load),
and tampering with the resource objects afterwards leaves references the
battle/post-battle code trips over. The one variant not tested: a swap
already in RAM before an encounter area's FIRST load of the session
(e.g. applied on the world map, then entering the area) - it could not
be reached this session because re-entering Plain Amur from the world
map could not be triggered (the exit deposits you at the junction node;
neither Cross on the node nor stepping across it re-enters, and long
traversals of the surrounding roads produced no transition and no
world-map encounters). A code-level remap inside the scan functions
(the follow-on feature below) remains the credible route for battle,
since it would translate the id at descriptor-build time whenever that
build happens.

Session hygiene: the pristine ISO's sha256 was recorded before
(`36622eee...f78424b`) and re-verified after - unchanged. All work ran
on the scratch copy of `Card1.ps2` (original preserved; the pre-session
scratch card is backed up as `Mcd001.ps2.pre-route1` in the modelswap
memcards folder). One environment caution for the next session: check
`ps` for stray pcsx2-qt processes before launching - a leftover instance
from an earlier run kept the display's first "Suikoden III" window and
the PINE socket path, and a second instance launched alongside it made
screenshots read the wrong (black) window and moved the PINE socket to
the newer instance.

## Follow-on feature candidate (prototype left in scratch)

`suikoden3-debug/scratch/modelswap_tag_swap.py` is the tested prototype:
it connects to PINE slot 28016, finds the resources tagged 1 and 54 in both
the field set (regions 14-22) and the battle set (regions 6-13), swaps the
tags, and `--restore` undoes it. It was run in exactly this form (same
writes, done interactively) for the proof above.

A shippable editor form would move the same remap into the game code
instead of live RAM: translate the requested character id inside the two
scan functions (field 0x1775A40, battle 0x188BF40) or at their call sites,
so a per-character "renders as" choice survives area loads and battles
with no payload edits. That needs a small code cave or a pnach that
re-applies the tag swap, neither of which was built here; this study only
proves the binding point is real, single, and safe to flip.

## Extension session 2026-11-22 (fourth): the battle fix - code-level id remap in the scan functions

The RAM swaps are refuted for battle (third session), so this session
implements the route the third session pointed at: translate the
character id inside the two resource scan functions, so every lookup -
whenever it runs, at area load or at battle spawn - resolves the swapped
resource from the start.

Static facts established first:

- Both scans take the id in `$a0` and copy it to `$s1` at +0x0C
  (`daddu $s1,$a0,$zero`), then loop regions calling the region getter
  `0x188BEF0` and compare resource `+0x04` against `$s1`. Field scan
  `0x1775A40` covers regions 14-22; battle scan `0x188BF40` covers 6-13.
- Battle scan callers (whole-ELF jal scan): `0x16F449C` inside
  `func_016F4450` (battle unit render setup; the scan path is taken when
  the unit word has bit 0x20000 set, taking resource `+0x08` as the
  model handle), `0x181AAA4` inside `func_0181AA90` and `0x181AB54`
  inside `func_0181AB40` (both follow resource `+0x18` onwards). Field
  scan caller: only `0x1775B20` inside field actor creation
  `0x1775AE8`. All callers pass raw character ids, so an in-scan remap
  covers every resolution path that uses the scan at all.
- Correction to the constant used elsewhere: ISO offset = VA - 0x15B8800
  (verified empirically against the pristine ISO: the ELF sits at ISO
  0xA3800 and both scan entries land exactly; the 0x15B8000 figure is
  off by one sector, 0x800).
- No in-place rewrite fits (a full remap + scan rewrite is ~34 words vs
  the battle scan's 24), so the patch hooks +0x0C of each scan with a
  jump to a small cave in section padding. Cave A: VA 0x191F6D0, the
  48 zero bytes between .text end (0x191F6D0) and .vutext start
  (0x191F700). Cave B: VA 0x1917394, the 44 zero bytes after the
  function ending at 0x1917390, before the syscall stub block at
  0x19173C0. Both verified all-zero in the pristine ISO.

Patch design (symmetric 1 <-> 54; the pair is encoded as the two
compare constants -1 / -54 and the two result constants 54 / 1):

- Hook, field scan +0x0C: VA 0x1775A4C, ISO 0x1BD24C,
  0x0080882D -> 0x08647DB4 (`j 0x191F6D0`). The original +0x10
  `sd $ra,0x20($sp)` runs as the jump's delay slot; resume at +0x14.
- Hook, battle scan +0x0C: VA 0x188BF4C, ISO 0x2D374C,
  0x0080882D -> 0x08645CE5 (`j 0x1917394`). Same delay-slot/resume
  shape (resume 0x188BF54).
- Cave body (11 words; identical except the resume jump target,
  field 0x085DD695 = `j 0x1775A54`, battle 0x086237D5 = `j 0x188BF54`):

      addiu $v0,$a0,-1        0x2482FFFF
      beq   $v0,$zero,+5      0x10400005   ; id==1 -> word 7
      addiu $v0,$a0,-54       0x2482FFCA   ; delay slot
      beq   $v0,$zero,+5      0x10400005   ; id==54 -> word 9
      daddu $s1,$a0,$zero     0x0080882D   ; delay slot: s1 = id
      j     resume                         ; other ids: s1 unchanged
      nop                     0x00000000   ; delay slot
      j     resume                         ; id==1 path
      addiu $s1,$zero,54      0x24110036   ; delay slot: s1 = 54
      j     resume                         ; id==54 path
      addiu $s1,$zero,1       0x24110001   ; delay slot: s1 = 1

  The displaced `daddu $s1,$a0,$zero` is reproduced inside the cave
  (word 4, where it doubles as the second beq's delay slot; on the
  id==54 path it is overwritten by the final delay-slot write). $a0 is
  never modified; only $v0 (a caller-saved temp at function entry) and
  $s1 (the intended output) are touched.
- Field cave: VA 0x191F6D0, ISO 0x366ED0, words
  2482FFFF 10400005 2482FFCA 10400005 0080882D 085DD695 00000000
  085DD695 24110036 085DD695 24110001 (last padding word stays 0).
- Battle cave: VA 0x1917394, ISO 0x35EB94, words
  2482FFFF 10400005 2482FFCA 10400005 0080882D 086237D5 00000000
  086237D5 24110036 086237D5 24110001 (exactly fills the 44 bytes).
- A different id pair (A,B) re-encodes as: compares -A / -B in words
  0/2, results B / A in words 8/10.

Live test follows below (PINE-applied on the private instance, patch in
place before the File08 save is loaded, so any load-time descriptor
build runs under the remap; no tag swap this time - the code patch
replaces it).

Correction to the spec above, caught at apply time: the battle cave's
resume jump word as printed (0x086237D5) is a hand-arithmetic error.
The correct word for `j 0x188BF54` is 0x08622FD5, and that is what was
written to RAM and verified by readback. The field resume word
0x085DD695 (j 0x1775A54) is correct as printed.

### Attempt 1 live result (2026-11-23): scan remap is INERT for binding, and SAFE

Applied via PINE before loading File08 (Plain Amur, party
Koroku/Fubar/Lulu/Sgt. Joe/Hugo); all 24 words verified by readback.
Observed, in order:

- Field at load: leader avatar is stock Hugo (battle_fix_10/17_field).
- Party menu portraits: stock (battle_fix_11_menu).
- World map after walking out the south exit: avatar is stock Hugo
  (battle_fix_20_walk3). The tag swap DID swap the world map avatar at
  this same scene entry in the earlier session, so scene-entry avatar
  binding does not flow through the field scan 0x1775A40.
- Random encounter (Purple Creeper) fought under the patch: command
  phase pair 1 shows Koroku's unit as the dog (battle_fix_31_pair1);
  pair 3 shows Hugo's unit as Hugo, arrow + "Hugo" label
  (battle_fix_34_pair3). Battle models are stock.
- The battle completed cleanly: execution, victory, results screen
  (Koroku level up, 150p; battle_fix_36/37), clean return to the field
  (battle_fix_38). So the scan remap neither swaps battle models nor
  hangs battles: the scans are simply not the binding path for party
  field avatars, portraits, or battle units. (Their real callers are
  narrower: the field scan serves func_01775AE8 actor records; the
  battle scan serves the flagged 0x20000 subset and the two
  0x181AA90/0x181AB40 helpers.)

### Attempt 2 design: remap the id inside the battle unit render setup

Static follow-up on the descriptor path:

- func_017152E0 is the battle roster builder: it walks the roster word
  array (count at roster+0x12, words at roster+0x14; word = id in the
  low bits plus flag bits 0x10000/0x20000) and calls the per-unit
  render setup func_016F4450(unitRecord, wordPtr, ctx) for every unit.
- func_016F4450 computes $s2 = word & 0xFFFF (the id) at 0x16F448C and
  uses $s2 for EVERY model-related lookup: the flagged path's battle
  scan, and the registry lookups func_01713B28(ctx, id) (the model
  handle, passed to the attach func_016F3D40) and func_01713D00 with
  keys id, id|0x30000, id|0x40000, id|0x70000 (animation/pose
  sub-resources). The registry functions match sub-objects INSIDE the
  loaded resources by key fields (id low 16, category high 16), which
  is why the resource tag swap never touched battle models: battle
  binding is key-based, not tag-based.
- Patch point: replace the single instruction at VA 0x16F448C
  (`andi $s2,$v0,0xFFFF`, word 0x3052FFFF, ISO 0x13BC8C) with a jump to
  a cave that reloads the word from 0($s4) (the delay slot at
  0x16F4490, `and $v0,$v0,$v1`, destroys the raw word's low bits, so
  the cave re-reads it), masks it, remaps 1 <-> 54 into $s2, and
  returns to 0x16F4494 with $v0 (the flag test result) preserved. Game
  logic elsewhere keeps the true id: the roster loops in
  func_017152E0 read the roster words directly, so only render-setup
  lookups swap. Cave reuses the field cave space at VA 0x191F6D0
  (ISO 0x366ED0) after Attempt 1 is reverted.

### Attempt 2 live result (2026-11-23): unit-setup remap is INERT too, and SAFE

Attempt 1 reverted in RAM, Attempt 2 applied and readback-verified
(hook word at VA 0x16F448C, ISO 0x13BC8C: 0x3052FFFF -> 0x08647DB4;
cave at VA 0x191F6D0, ISO 0x366ED0: 8E920000 3252FFFF 2648FFFF
11000005 2648FFCA 11000003 00000000 085BD126 00000000 36520037
085BD126 00000000). A different pair (A,B) re-encodes as compares
-A / -B in words 2/4 and XOR constant A^B in word 9 (here 1^54 = 55).

Observed in a full random battle (3x Furrfly, Plain Amur), patch in
place before the battle spawned:

- Command phase pair 1: Koroku's unit is the dog (battle_fix_43).
  Pair 3's Hugo was likewise stock in the preceding checks. Battle
  models are stock under the remap.
- The battle played to completion cleanly: execution, victory,
  skill-point results screen (battle_fix_50/51), return to field.
  No hang, so the patch is safe; it just does not bind party battle
  models. Conclusion: func_016F4450 / func_017152E0 (the boot-ELF
  roster builder) is not the spawn path that binds party models in
  random battles, or its registry lookups are scoped per-resource so a
  foreign key cannot resolve. Either way this patch point is closed.

### Descriptor-level probe (2026-11-23): post-build node fields are inert

A full-RAM scan during the Furrfly battle for the battle resources'
model handles (Koroku res 0x320040 +0x08 = 0x35A100; Hugo res
0x520040 +0x08 = 0x54E0C0) found model-instance nodes in the heap:
Koroku nodes at 0x12FAFF8 and 0x12FE3F8, a Hugo node at 0x131F138,
all sharing the layout +0x00 = 0x104C, +0x0C/+0x10 = model handle
(twice), +0x1C/+0x20 = model-region sub-objects, +0x28 = shared
"join" template at ELF 0x1969D80. Exchanging the four model fields
(+0x0C/+0x10/+0x1C/+0x20) between the Koroku and Hugo nodes mid-battle
changed nothing on screen (battle_fix_46; fields restored after).
The nodes are build-time inputs already consumed (geometry uploaded
at spawn), so a descriptor swap, like the earlier resource payload
swap, cannot rebind a live battle. The binding decision is made once,
at battle spawn, inside the battle module.

### Where the binding actually lives (state of the hunt)

- Regions 35 (0x891000) and 47 (0xC11000) hold the battle overlay
  slots during a battle, but a mid-battle RAM dump of both slots
  showed a module header + data, no plain MIPS code: the battle code
  module is loaded/decoded on demand (compare the region-5 rotating
  code-module system, CODE_MODULES.md) and was not resident in those
  slots at dump time. Disassembling the ETC battle module from the
  extracted archives is the identified next step: find its unit-spawn
  function and the id it resolves models by (key-based registry match
  and capture-at-area-load registration both remain consistent with
  all evidence; the tag scan, the boot-ELF roster builder, and
  post-build descriptor fields are all excluded by the tests above).
- A poison variant of the Attempt 2 cave (id 1 -> $s2 = 0x3FF inside
  func_016F4450) was armed to test whether that function executes at
  all for party units, but the test battle never triggered before the
  lab environment restarted and killed the emulator instance, so that
  specific question stays open. It does not affect the Attempt 2
  verdict, which rests on a completed battle.
- Environment note: the private PCSX2 instance was killed twice by
  outside events during this session (a parallel session's pkill, and
  a service restart that also wiped /tmp helpers). All findings above
  were captured in screenshots (battle_fix_*.png in the scratch shots
  folder) before those events; the pristine ISO was never written.

### Bottom line for the battle fix

No proven battle model swap yet. What is proven: the swap cannot be
had at the resource tag (earlier sessions), the resource payload
pointers, either boot-ELF scan function, the boot-ELF battle roster
builder's id, or the live model-instance nodes. The one place all
evidence points to is the ETC battle module's unit spawn, which
captures each unit's model at battle entry from an id-keyed source.
That module is the next excavation, and Attempts 1 and 2 above are
complete, byte-exact patch specs that can be reused as known-inert
controls when it is opened up.

## Bottom line for the old verdict

The 2026-08-22 verdict "in-place model swapping is NOT feasible" remains
true of ETC.BIN payload editing, and its two test results (name relabels
ignored, payload overwrites corrupt neighbours) are consistent with
everything measured here. Its broader implication, that a model swap needs
a full archive rebuild plus a disc offset table fix, does not survive live
testing: the runtime binding is a numeric tag in RAM, one u32 per loaded
model, and flipping it swaps what a unit renders as while leaving the unit
itself alone. On the field that is now a demonstrated fact, with
screenshots. In battle it is the same code path with the swap already
applied in the test session, awaiting one encounter screenshot to close.

## Extension session 2026-11-23 (fifth): the battle spawn binding is the model header id; battles still soft-lock after round 1

This session set out to disassemble the ETC battle module and find its
unit-spawn model resolution. The module framing turned out to be wrong
for random battles, and correcting it is what cracked the binding.

### Premise correction: no ETC code overlay takes part in random-battle spawn

A word-level diff of full RAM dumps taken on the field and at a battle
command phase (same area load, File08 Plain Amur) shows what a battle
actually loads: regions 36-47 and 49/63/66 change wholesale (battle
stage, effects and texture data), the battle resource regions 8-11
change 1-2% (animation state), and everything else is untouched.
Region 35 changes 95 words in 0x80000, region 5 changes 4 words. No
code module is loaded for the battle: at battle start the only code
resident is the boot ELF plus region 5, which content-matches
SOGE/0002_town.bin (the area module, resident since area load), and
region 48, which holds SOGE/0044_battle.bin (the area's battle data
file, also resident since area load). The Fortune item-check chunk at
ETC 0x7E39138 / 0x7E41938 (VA 0x892138 / 0xC12138, regions 35/47) is a
results-phase overlay: its pattern is not in RAM at battle start, and
region 35's field content survives into battle almost byte-identical.
The spawn is boot-ELF code working on data staged at area load.

### The spawn path (boot ELF)

- Battle init lives in the cluster around 0x17DE000-0x17DED00: its
  per-unit setup calls func_016F4640 (attach from registry) at
  0x17DE164 and 0x17DE918, and the roster builder func_017152E0 at
  0x17DECC4. The roster builder calls the render setup func_016F4450
  at 0x1715414. Attempt 2's remap inside func_016F4450 was inert
  because the binding is not decided by the id at that site (below).
- Char id to model key: func_016FFCA8 reads a u16 table at ELF
  0x196E5F0, indexed by func_016FFAD8(char id). For the File08 party
  the mapping is the identity: indices 1-5 hold 54, 9, 8, 10, 1
  (Koroku, Fubar, Sgt. Joe, Lulu, Hugo).
- Two different registry searches exist, and they do different jobs:
  - func_017000A0(key, region) returns the resource object at region
    base + 0x40 iff its tag (object +0x04) equals the key;
    func_01700110 scans battle regions 6-13 with it, func_01700180
    scans regions 25-27 and 37-39. This tag search drives unit
    enumeration and unit-record order only (live proof below).
  - func_01713B28(ctx, key) is the model resolution. With ctx = 0 it
    walks the static region descriptors (func_01713A10) for regions
    48, 49, 50, 24, 36, 60; each descriptor's +0x0C array lists
    candidate model objects (count u16 at descriptor +0x14). Every
    candidate's model header is parsed (func_016B6FD0 ->
    func_01725F80 -> func_01725C88, a verbatim 0x2C-byte header copy)
    and matched on: header u16 at +0x26 == the mapped char id
    (func_01712548 mapping; identity except the 0x201 family),
    header u16 at +0x24 == 0, and header byte at +0x14 == the key's
    category (key >> 16). func_016B7008(modelObj) returns the same
    +0x26 id, and the attach path (func_016F3D40, node creator
    func_016D7A50, sole caller 0x16F3DC4) builds the unit's
    model-instance node from the matched resource: node +0x00 =
    0x104C, +0x0C/+0x10 = model handle (resource object +0x08),
    +0x1C/+0x20 = payload sub-objects, +0x28 = the shared "join"
    template at ELF 0x1969D80.
- Unit records: table pointer at ELF 0x196A31C, stride 0x2DC; the
  node pointer sits at record +0x100 (it points at node + 8). Record
  word +0x00: low u16 = char id; the high u16 is model-derived (3 for
  the Koroku and Sgt. Joe models, 0 for Hugo, Fubar and Lulu here).

### The model header (the binding)

Each battle model payload carries a 0x2C-byte identity header:
+0x00 = the model name, 12 bytes ("chm_syu1_003", "chm_kork_003",
"chm_dgns_003"); +0x20 u16 = 1; +0x24 u16 = 0; +0x26 u16 = the char
id the spawn matches on; +0x28 u16 = a count of face sub-entries,
followed by that many 0x1C-byte entries naming facial-expression
meshes (face_nor_mal, face_blink, face__NR, face__NL, face__RL,
face_talk, face_close, face_half_close). Hugo's model has 8 entries
(it is the only party model with face_talk); Koroku's and Fubar's
have 7. A second copy of the header sits elsewhere in each payload
(its char id is at +0x12 there); swapping only the primary header's
+0x26 was sufficient to move the binding, so the second copy is not
the spawn's match source.

Fixture addresses (File08 Plain Amur load; the region bases are
fixed, so these RAM addresses are stable for this area):

- Hugo: region 12 base 0x520000, header at 0x582000 (payload offset
  0xC2000); the id u32 at 0x582024 is 0x00010000 (id u16 at +0x26).
  Second header copy at 0x592E40.
- Koroku: region 8 base 0x320000, header at 0x3757C0 (payload offset
  0x157C0); id u32 at 0x3757E4 is 0x00360000. Second copy at
  0x381700, third at 0x375904.
- Fubar: region 11 base 0x4A0000, header at 0x500040 (payload offset
  0x60040); id u32 at 0x500064 is 0x00090000. Second copy at
  0x511040.

### Patch spec (spawn swap)

To swap the battle models of char ids A and B: write B's id as the
u16 at A's header +0x26, and A's id as the u16 at B's header +0x26
(the u16 at +0x24 must stay 0, so the u32 at +0x24 becomes
(id << 16)). For the 1 <-> 54 pair: Hugo's header u32 0x00010000 ->
0x00360000, Koroku's header u32 0x00360000 -> 0x00010000. Any pair
re-encodes the same way from the two char ids. This is proven as a
RAM patch (applied on the field before the battle; the payloads are
resident from area load). The disc form is the same two u16s inside
the ETC-resident battle-model files; the payload offsets above are
offsets within the loaded resource image, and pinning each model
file's exact ETC offset per area is the remaining step before this
can be written as an ISO patch spec.

### Live results (this session; screenshots battle_mod_*.png)

Control first: an unswapped battle in this same setup was fought to
victory, through the results screen (Cash 1401p) and back to the
field cleanly (battle_mod_55, battle_mod_57).

1. Field-node field exchange (context): swapping +0x0C/+0x10/+0x1C/
   +0x20 between Hugo's and Koroku's field model-instance nodes made
   the field avatar invisible. The nodes are coherent objects;
   cherry-picked fields break rendering. Battle spawn builds fresh
   nodes, so this route was already dead for battle.
2. Battle-resource tag swap (resource object +0x04, regions 8 and
   12): the unit records reordered (char 1's record took slot 0) but
   the battle models stayed stock (battle_mod_22). The tag search
   enumerates units; it does not bind models. This also explains the
   third session's result, where the tag swap left battle models
   stock: the tag was never the battle binding.
3. Header id swap only (Hugo <-> Koroku): THE BINDING SWAPPED,
   proven two independent ways. Unit records: char 1 -> model handle
   0x35A100 (Koroku's payload), char 54 -> 0x54E0C0 (Hugo's). On
   screen, identified by pair label and selection arrow as required:
   the pair labelled "Koroku" stands in Hugo's model
   (battle_mod_27), and the pair labelled "Hugo"/"Fubar" has
   Koroku's dog beside Fubar (battle_mod_31). Field rendering is
   unaffected (the field uses the separate type-3 resources).
   BUT the battle soft-locks after round 1: every unit returns to
   formation, then no enemy phase and no round-2 command phase ever
   appears; idle animations keep playing and the emulator stays
   healthy. Reproduced identically with manual commands and with
   Auto battle.
4. Header swap plus the payload key tables (the +0x10 table head
   keys at 0x582140/0x35A180, Hugo's extra category-1 key word at
   0x57325C, the +0x0C table head ids at 0x592DC0/0x3816C0, the
   second-header +0x12 ids): same soft-lock.
5. The above plus every "chm_" name string in both payloads swapped:
   same soft-lock.
6. Header swap plus Hugo's 15 attachment key words (categories 3, 4
   and 5, at 0x520268, 0x5249E8, 0x5351A8, 0x545968, 0x54E178,
   0x582200, 0x584180, 0x584200, 0x58A520, 0x58A580, 0x575980,
   0x575AC0, 0x575C00, 0x575DC0, 0x575F40) rekeyed from id 1 to id
   54, so Koroku's unit would resolve Hugo's attachments: same
   soft-lock.
7. Hugo <-> Fubar header swap: binding swapped (char 1 -> Fubar
   handle 0x4DA100, char 9 -> Hugo handle 0x54E0C0); same soft-lock,
   with the stuck marker on char 9.
8. Koroku <-> Fubar header swap (no Hugo involvement): binding
   swapped (char 54 -> Fubar's model, char 9 -> Koroku's); same
   soft-lock, marker on char 54, camera parked on the acting pair
   (battle_mod_79, battle_mod_80).

Blocker signature: in every swapped battle exactly one unit record
keeps +0x10C = 7 (it is 0 at spawn and 0 throughout the healthy
control) and +0x118 = 0xEC; all other units finish. Which unit
sticks depends on the pair swapped: char 54 wearing Hugo's or
Fubar's model sticks; char 9 wearing Hugo's model sticks, but char
9 wearing Koroku's model completes; char 1 (Hugo) completes in
every foreign model tried. Clearing +0x10C live does not release
the battle (the engine then zeroes +0x118 and stays stuck), so
+0x10C is a state marker, not the wait flag itself. The pattern
fits a motion-index mismatch: a unit's action script requests
motions by index from its own move set, and on a foreign model's
bank some requested index is a non-terminating or missing motion,
so the pair/action sequence never signals completion. The fix, if
one exists at this level, is to move the unit's motion/action
tables with the model (they live on the character-data side, not
in the model payload), or to remap the motion indices. That is the
next excavation; a PCSX2 watchpoint on the stuck unit's record
+0x10C during a stock battle would show who sets state 7 and what
clears it.

### Bottom line for the battle fix (supersedes the fourth session's)

The battle model binding is solved: it is the char id at +0x26 of
the model's own "chm_" header inside its battle payload, matched by
func_01713B28 at spawn. A two-u16 header swap moves the binding for
any pair, proven on screen with pair labels and selection arrows.
What is not yet had is a full clean battle with swapped models:
every swapped battle soft-locks after the first round, on a
unit-and-model-specific action that never completes. The ETC battle
module the fourth session pointed at does not carry the spawn; the
results-phase overlay in regions 35/47 is real but irrelevant here.
Issue #17 stays parked until a swapped battle completes.

### Sixth extension (2026-11-23): Kevin's duplicate-model hypothesis, tested

Kevin's hypothesis: the round-1 soft-lock may be caused by TWO
units bound to the same model in one battle (the real Koroku plus
Hugo-as-Koroku). Test: remove Koroku from the party, swap Hugo
into Koroku's battle model as its only user, and see whether a
full battle completes. Screenshots battle_nokoroku_*.png.

The save edit (protocol step 1, done literally). On a scratch
copy of the File08 memcard, s3save write_save_edits with
party_edits={0: 0} removed Koroku from the ACTIVE PARTY (roster
untouched). Re-read: party [9, 8, 10, 1, 0, 0], formation rebuilt
to [0, 2, 3, 1, 4, 0], leader still 1. Party representation in
the save: gamedata +0x3216 holds 6 u16 party member ids (the ids
are the char/model ids: Koroku 54, Fubar 9, Sgt. Joe 8, Lulu 10,
Hugo 1), mounts at +0x3222, formation at +0x3240; party edits
rebuild the formation automatically. Loaded in game, the party
menu showed exactly Fubar/Lulu/Sgt. Joe/Hugo with Hugo as field
avatar. Caveat: the load-screen file preview still lists Koroku;
it is a stored snapshot, not the live party.

Residency finding (the protocol's adaptation point, triggered).
Battle model payloads stage per PARTY MEMBER at area load. With
Koroku out of the party, chm_kork_003 is nowhere in RAM, so Hugo
has nothing to bind to and the literal protocol cannot run. The
experiment was therefore run in live RAM instead, by the lightest
route that preserves its one condition (no second unit on
Koroku's model): load the full-party File08 (every payload
resident), edit the live gamedata party in RAM exactly as the
save edit did, and drive the spawn from there. What the spawn
does with that setup forced one more change, below.

Spawn mechanism, corrected by three probe battles. The roster
builder enumerates the CURRENT PARTY MEMBERS' MODEL PAYLOADS as
its candidate set and spawns ONE UNIT PER CANDIDATE PAYLOAD,
keyed by the payload's header id at +0x26, attaching that id's
char data if any. Evidence: with the party edited down to four,
the two-way header swap spawned records keyed [9, 8, 10, 54] and
NO char-1 record (Koroku's payload was not a candidate, Hugo's
payload wore id 54 and spawned Koroku's unit). Forcing Koroku's
payload to claim 1 and Hugo's to claim 999 spawned a record keyed
999 wearing Hugo's payload handle: the unit record's +0x00 low
u16 is the SPAWN KEY (the bound payload's header id), not
intrinsically a char id; enemy keys work the same way (BladeBunny
503, Furrfly 545/546/547, Purple Creeper 576). A second copy of
the party block lives at 0x196E5F6 (the func_016FFCA8 slot-table
region) and mirrors gamedata edits on its own; it is not an
independent stale copy.

The decisive configuration. Full party restored in the live
gamedata (so Koroku's payload is resident), headers set one-way:
Koroku's payload claims id 1, Hugo's payload claims id 999.
Spawn (verified from the unit records): key 1 on Koroku's payload
handle 0x35A100 (Hugo's unit, the ONLY unit on the dog model),
keys 9/8/10 on their own payloads, key 999 on Hugo's payload
handle 0x54E0C0, and NO key-54 record: Koroku's unit never
spawns, which is Kevin's condition. The key-999 unit is a
data-less ghost (no char data, no command pair, dark status row);
it is an artifact of this construction, declared here because two
of the three runs hinge on it.

Battles 4 and 5 (all pairs ordered Defend): HUNG. After the
party's defend actions the sequence froze with no enemy phase and
no round-2 commands. Signature differs from the two-way-swap
lock: key 1 and the ghost both sit at +0x118 = 0xE4 (all other
units back at the 0xC4 formation state), the ghost's +0x10C reads
0x14, and the dog lies in its defend crouch. Reproduced twice
(1 Purple Creeper; 3 Furrflys).

Battle 6 (Hugo's pair ordered Attack, other pair Defend):
COMPLETED, all three rounds. Round 1: the swapped pair's attack
killed FurrflyA, with the dog visibly performing Hugo's attack as
a leap at the target (battle_nokoroku_79); the enemy phase
executed (Fubar 111 -> 110 HP). Round-2 commands were offered and
played (FurrflyB and FurrflyC died), round-3 commands followed,
the last enemy (Purple Creeper) died, and the battle closed
through the victory/results screen (Hugo Exp 301; Get 285p) to a
clean field return (battle_nokoroku_80 to _89). No unit record
showed +0x10C = 7 at any poll in this run; the ghost's +0x10C
read 0 mid-round-1. Two side observations: Koroku's save HP fell
69 -> 13 during the battle although his unit never spawned
(damage dealt to the ghost's formation position was written
through to the char data owning that member slot; his Exp stayed
0), and the ghost's own results row was empty.

Verdict. Kevin's duplicate-model hypothesis is SUPPORTED for the
attack path: with Hugo as the only unit on Koroku's model, a
swapped battle ran three full rounds to victory, where every
two-way swap (two units sharing the pairing, fifth session, five
variants and three pairs) locked after round 1 with +0x10C = 7.
Two honest limits. First, battles 4 and 5 show a residual hang in
the same no-duplicate configuration under Defend orders, with a
different signature (+0x118 = 0xE4 on Hugo's unit and the ghost,
ghost +0x10C = 0x14); whether that hang is the dog model's defend
motion under Hugo's script or the data-less ghost's phantom
presence cannot be separated with this data. Second, the ghost
itself is a test artifact: an editor-grade swap would re-point
the displaced payload at a real char id, so the ghost branch may
not exist in practice. The clean follow-up is the guest variant
(Hugo's payload claims a real non-party char id, e.g. Chris 2, so
every spawned unit carries char data) with Defend orders for
Hugo's pair. For the editor feature, the design consequence
stands either way: a model swap must avoid leaving two units on
one model (three-way rotation, or point the displaced unit at a
third model).

## Seventh extension (2026-11-23): hiding a battle model - the unit-record scale triple

Question (Kevin): can a battle unit's model be set hidden -
invisible, but still fighting? Answer: yes, proven live. The
lever is not in the model node or the payload header; it is a
scale triple on the unit record.

The mechanism. func_016F3D40 (attach) finishes by writing the
float 1.0 three times into the unit record at +0x264, +0x268,
+0x26C (the swc1 trio after the func_018A6EC0 call). Those are
the unit model's scale factors. Writing 0.0 to all three,
mid-battle, collapses the model to a point: the unit renders
nothing, while everything else about it keeps working. The
value is read continuously, not just at spawn: zeroing it at
the command phase hid the unit from that frame on, and writing
1.0 back mid-battle restored the model in the same battle.
Attach re-initialises the triple to 1.0 at every battle spawn,
so a RAM hide must be applied after spawn (a disc form would
patch the attach writes or their source instead).

Live proof (File08 Plain Amur, stock party, Lulu as the test
unit; screenshots battle_hide_*.png):

- Battle 1 (2 BladeBunnies): scale zeroed at the Fight/Auto
  menu; Lulu's formation spot is empty in the formation view
  (battle_hide_18) and in her own pair's command view, where the
  pair label, her HP row and her Attack command all work
  normally (battle_hide_21). The battle ran to a clean victory
  and results screen (battle_hide_37/38) and a clean field
  return; Lulu earned Exp normally.
- Battle 2 (FurrflyA/B, BladeBunnyA/B): Lulu visible at spawn
  (control: attach had reset the scale), zeroed again. She
  attacked FurrflyA for 42 damage with no visible attacker in
  the attack camera - only the hit effect, the damage number
  and a shadow blob at her position (battle_hide_61). In the
  enemy phase an enemy attacked her: her HP fell 89 -> 80, so
  she remains targetable while invisible. Round 2 was played
  (Auto) to a clean victory, results (Lulu SKILL points 54,
  HP 80/89; battle_hide_75) and field return.
- Classification: (a) invisible + fully functional. She takes
  commands, moves, attacks, deals damage, is targeted, takes
  damage, earns Exp and skill points, and the battle completes
  cleanly. Her shadow still renders (a flat blob at her feet,
  visible in battle_hide_61 and the formation shots); the hide
  removes the model, not the shadow.

Negative results, same session (all classification (d), no
effect, each restored after):

- Model-instance node fields are not per-frame visibility
  inputs (extending the fourth session's binding result):
  node +0x30 (the constant 1 word) -> 0; node +0x0C/+0x10 model
  handle -> 0; node +0x08 (the constant 7 word) -> 0; node
  +0x1C/+0x20 payload sub-objects -> 0. The model rendered
  unchanged after each (battle_hide_80 to _83).
- Payload header spawn-time flags: the matcher reads only
  header +0x14 (byte), +0x24 (== 0) and +0x26 (id). Of the
  unchecked fields, +0x20 (u16, stock 1; the u32 at +0x20 is
  0x80000001) set to 0 before a battle: Koroku spawned fully
  visible (battle_hide_87). The other unchecked "= 1" field,
  the u32 at +0x10, was likewise set to 0 before a battle:
  Koroku again spawned fully visible (battle_hide_103). The
  header carries no visibility flag among its unchecked
  fields. (The first +0x10 attempt's roam was cut short when
  the lab environment killed the emulator instance and wiped
  /tmp; the test was re-run to completion on a fresh instance
  before this was written up as negative.)
- Header layout measured live (both party models agree):
  +0x0C/+0x0E hold a 0xCDCDCD00 padding pattern, +0x10 u32 = 1,
  +0x14 byte = category with byte +0x15 = 9, +0x16..+0x1F = 0,
  +0x20 u32 = 0x80000001, +0x28 = face-entry count.

Static notes: the node creator func_016D7A50 writes no
visibility-shaped field (its stores are the model object at
+0x04, a derived object at +0x08, a child at +0x0C, and
sub-objects at +0x14/+0x18 of the allocation). No death-fade or
other in-game render suppression was found in the attach /
node-create path; the game's own despawn is record teardown,
not a flag flip. The record table base pointer (ELF
0x196A31C) is re-allocated per battle, so record addresses
must be re-read each battle; the scale offsets within the
record are constant.

Hygiene: all pokes were RAM-only on the scratch memcard's
fixture; nothing was written to any save or to the ISO.
Savestates used: slots 40 (field), 41/43/44 (battles), in the
private instance's savestates folder.

## Eighth extension (2026-11-23): the shadow switch hunt, and
hiding inside the swapped battle

Two experiments in one session, both building on the seventh
extension's hide. Same fixture (File08, Plain Amur, private
PCSX2, PINE slot 28016). Screenshots battle_shadow_*.png
(experiment A) and battle_swaphide_*.png (experiment B) in the
scratch shots folder.

### Experiment A: what controls the hidden unit's shadow?

The seventh session left the blob shadow rendering full-size
under a scale-zeroed unit. This session hunted the switch.

Setup: Lulu's hide was replicated (scale triple zeroed at the
Fight menu; her pair-2 spot empty, commands/HP normal,
battle_shadow_03 to _05). Her blob in the pair views is a
faint smudge, hard to judge small changes against, so the
hunt switched subjects: Furrfly A (crisp dark ellipse, same
mechanism) for record/resource pokes, and Koroku (hidden in
the pair-1 view, battle_shadow_16) as a second subject.

Attempts, all restored after each poke unless noted:

- Unit record +0x248 -> 0 and -> 8.0, +0x24C -> 0 and
  -> 12.0 (Lulu): (d) no effect on the shadow. Repeated on
  Furrfly A (+0x248 -> 9.0, +0x24C -> 0): (d).
  (battle_shadow_06 to _08, _17, _18.)
- Furrfly A record +0x2C -> 0, +0x120 -> 0, and
  +0x17C/+0x208/+0x21C -> 0 together: (d) each; the ellipse
  never changed. (battle_shadow_19 to _21.)
- Lulu node +0x1C -> 0, eyes on the shadow this time: (d).
  Her node +0x1C is an attachment object (Furrfly's is NULL
  and it still casts a shadow, so +0x1C is not the shadow).
  (battle_shadow_09.)
- Lulu node +0x20 -> 0 (the model resource-object pointer):
  UNSAFE, do not repeat. The poke itself showed no visual
  change (battle_shadow_10), but shortly afterwards the EE
  frame froze hard: two screenshots 4 s apart byte-identical
  (battle_shadow_12/_13), the record arena found zeroed /
  repurposed, the battle gone behind the last GS frame.
  Causality rests on timing alone, but a NULL resource
  pointer hanging the EE fits; this contradicts the seventh
  session's (d) score for the same poke and the difference
  is unexplained. Recovery was a savestate reload (state 45,
  this session's clean battle-start state; the reloaded
  battle reproduced the stock layout byte-for-byte).
- Resource object +0x0C/+0x5C (the per-model float pair):
  test VOID. The value is a live hover/bob animation
  parameter (read back oscillating 0.88 to 1.69 across
  seconds); the engine overwrote the poked 4.0 immediately.
  It is a motion value, not a shadow field.
  (battle_shadow_22.)
- Payload header +0x23 (the high byte of the u32 0x80000001
  at header +0x20; the seventh session had zeroed only the
  low u16) -> 0 before a battle, on Koroku's header:
  INCONCLUSIVE. The test was voided when a stray menu input
  selected Run at the Fight/Auto menu and the party escaped
  before Koroku was observed in battle. Not re-run; the
  flag theory is weak (the low half already tested negative)
  and experiment B had priority.
- Static trace: attach func_016F3D40 copies record
  +0x248/+0x24C/+0x2C from the per-character data table
  returned by func_016E8AD8 (a runtime list at D_19694B0 in
  0x10-byte entries {id, A, B, C}, with a static fallback
  table at D_19693E0 whose index comes from func_016C7310;
  defaults A=1.0, B=2.0, C=1.0). +0x248/+0x24C are read
  elsewhere only through trivial getters (func_016E8A00 /
  func_016E8A18). Nothing shadow-specific exists in the
  attach path, the node creator, or the resource object's
  scalar fields. The runtime list is empty on the field (it
  is built at battle spawn), and the static fallback's index
  mapping was not cracked, so a pre-spawn source-table poke
  could not be targeted this session; that route stays open
  but unproven. One untested suspect is named for the
  record: the resource object's +0x34 chunk, which carries
  0x80808080 vertex-colour-style bytes next to vertex-like
  floats and could be the blob's own geometry.

Conclusion A: NO per-unit shadow switch was found among the
unit record's floats, the node's pointers, the resource
object's fields, or the payload header's flags. The blob
survives scale-0 and every live poke; the best-supported
remaining theory is that it is drawn from model-payload data
sampled at spawn, so an editor-form shadow removal would be
a payload-side patch, not a flag flip. Because no winner
emerged, the planned independent confirmation (shadow switch
alone, model visible, clean battle) was never runnable.

### Experiment B: does hiding a swapped unit release the
round-1 soft-lock?

The two-way Hugo<->Koroku header-id swap was rebuilt exactly
as in the fifth extension (field pokes: Hugo header u32 at
0x582024 -> 0x00360000, Koroku header u32 at 0x3757E4 ->
0x00010000; state 40 reloaded fresh for each variant, so all
RAM pokes reset between variants). In every variant battle
the binding was verified from the records before any hide:
char 1's record carried Koroku's model handle 0x35A100 and
char 54's record carried Hugo's handle 0x54E0C0, and the
command phase identified the units by pair label + model as
before (battle_swaphide_02: pair label "Koroku" standing in
Hugo's model). All pairs were given Attack commands in every
variant (the fifth session's lock condition).

- Variant 1, hide char 1 only (Hugo's unit in Koroku's
  model; Purple Creeper battle): round 1 executed, then the
  scene froze with Sgt. Joe's unit mid-swing. Char 54
  (Koroku's unit in Hugo's model, VISIBLE) stuck at
  +0x10C = 7, +0x118 = 0xEC, persisting across ~70 s of
  polls. The enemy phase never completed and no round-2
  commands were offered. LOCKED.
  (battle_swaphide_02 to _07.)
- Variant 2, hide char 54 only (the unit that sticks;
  Purple Creeper battle): the pair-1 command view showed
  Koroku's spot empty with only his blob under the selection
  arrow (battle_swaphide_09). Execution froze identically:
  char 54, hidden, stuck at +0x10C = 7, +0x118 = 0xEC across
  ~70 s; frame byte-near-identical between polls; no enemy
  phase completion, no round-2 commands. LOCKED.
  (battle_swaphide_09 to _12.)
- Variant 3, hide both swapped units (4x Furrfly battle):
  the pair-1 view showed the empty spot with TWO orphaned
  shadow blobs (battle_swaphide_17). Execution froze
  identically: char 54 stuck at +0x10C = 7, +0x118 = 0xEC;
  char 1 cycled +0x10C 19 / +0x118 0xE5 -> 0 / 0xE4 without
  completing. No round-2 commands. LOCKED.
  (battle_swaphide_17 to _20.)

Interpretation: hiding changes nothing in any configuration,
including hiding the stuck unit itself and hiding both
swapped units. The lock is in the unit action state machine,
independent of model rendering: the sequencer still steps
the hidden unit's action against the foreign model's motion
data and waits on a completion condition that never fires,
whether or not a single vertex is drawn. Scale-hiding is
therefore NOT a workaround for the swap lock. This sharpens
the fifth extension's motion-index theory: the wait is on
motion STATE, not on presented frames, so a fix has to give
the unit a motion bank its script can complete (or patch the
completion check), not suppress the draw.

Side note: with the swap applied, spawn/record order changes
(char 1's record spawns first), and pair groupings follow
record order; the pair label remains the reliable unit
identification, as in the fifth extension.

Environment note: the lab's glib-fix minlib libEGL currently
fails GS initialisation on this VM (eglGetDisplay error in
emulog); this session ran PCSX2 with the system libEGL on
Xvfb :77 instead, which worked. launch_s3.sh's env will need
that adjustment until the minlib is fixed.

Hygiene: all pokes were RAM-only on the scratch fixture;
savestate 40 was reloaded per variant and nothing was
written to any save. Pristine ISO sha256 verified unchanged
at session end (36622eee766beba71455066ac63d9f12d363e89139
e25eb146dec90a7f78424b). The emulator and Xvfb were shut
down by exact PID.
