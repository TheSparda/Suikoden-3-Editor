# Suikoden III ISO & Save Editor

A browser-based editor for **Suikoden III** (PS2, USA `SLUS-20387`). Two editors in one page,
sharing one set of verified tables:

- **Save Editor** — open a PS2 **memory card** (or a standalone save export) and edit an
  existing playthrough: levels, stats, skills, equipment, party, inventory, gold, recruitment,
  names, and who you walk around the map as. **No ISO required.**
- **ISO Editor** — rebalance spells, runes, unite attacks, gear, weapons, foods, shops,
  enemies, war units, encounter rates, movement speed and characters directly in the disc
  image. ISO edits apply to a **new game**.

Nothing is uploaded — everything runs on your own device. The repo ships with **no game
data**; supply your own legally-obtained ISO and/or saves.

> ## 🌐 Open it — nothing to install
>
> ### **https://thesparda.github.io/Suikoden-3-Editor/web/**

> **Feature requests / Support** on the **Toran Castle Discord**:
> https://discord.gg/KesHMX5P2Z

---

## What's in it

**Save Editor** — 8 views over one save:

| | |
|---|---|
| **Overview** | names, gold, chapter, playtime, story phase, S1/S2 carryover, JSON snapshot export/import |
| **Characters** | level, sharpen, HP, EXP, 7 stats, runes, armour, 8 skill slots with rank tiers, recruitment |
| **Recruit** | per-character recruited flag + which pre-merge team recruited them |
| **108 Stars** | completion checklist in recruitment-guide order, with each errand's item source, price and prerequisites |
| **Party** | the active battle party (up to 6) |
| **Field character** | who you run around the map as — and the two conditions that have to hold |
| **Inventory** | every bag and storage, per-team before the merge, shared after |
| **Health** | a lint over the save + your pending edits, most findings with a one-click fix |

**ISO Editor** — 22 tabs over the disc:

| | |
|---|---|
| **Characters** | starting stats, equipment, skills — plus disc-wide rename for Hugo, Chris, Geddoe, Koroku |
| **Growth** | growth rates, fixed skills, 43 skill caps, bulk scaling with difficulty presets |
| **Support** · **Weapons** · **Shops** | support-character skill sets; ATK across all 16 sharpen levels; every shop counter's stock and rare finds |
| **Runes** | rename, rewrite menu text, and choose which of the 94 spells each rune grants |
| **Passives** | hand a support rune's effect to chosen characters without equipping it; force Fortune and Prosperity on outright — plus **Rune power**, the 16 constants behind what a passive is worth |
| **Spells** · **Unites** | power/cast/element/target/AOE/status, rune reskin, bulk power scaling |
| **Mounts** | both mount systems: the per-character assigned horse, and the three-pair battle table |
| **Movement** | field walk/run speed and time scale, per character |
| **Story content** | which team's events and dialogue a leader gets — the fix for empty dialogue boxes |
| **Encounter** | global encounter rate, the three per-movement multipliers, per-area base rates, movement rules |
| **Enemies** | per-area enemy stats, rewards, drops, spawn zones and formations, bulk tuning |
| **War** | every war/major-battle unit on the disc, per unit or in bulk |
| **Gear** · **Sets** · **Food** | armour and its 5 effect slots; set composition and the set-bonus constants; dish heal + proc |
| **Text** | in-ELF UI strings — battle messages, menu labels, prompts, character blurbs |
| **Reference** | 8 read-only browsers: Items, Classes, Skills, Item sources, Files, Pickups, Mounts, **Music** |
| **Test** | experimental patches not known to work: the field-character whitelist, the assigned-horse window |
| **Changes** | diff this disc against a pristine one, decoded field by field, with per-row revert |

Everything is **staged**: edited, reviewed as an old → new list, undone, reverted, and
exportable as a `.s3mod` recipe or an `.xdelta` patch without writing the ISO at all.

## How claims are marked

A marker moves on a **play report about that mechanism**, never on a passing test. The suite
proves the editor writes the bytes it means to; it cannot prove the game reads them that way.
So each feature carries its own state, and the editor says so on the tab as well as here:

| Confirmed in play | |
|---|---|
| **Field character** | Koroku walks the map, triggers battles, appears in cutscenes and speaks the protagonist's lines |
| **Story content** | blank dialogue boxes render correctly after the index-0 fallback patch |
| **Movement speed** | field run speed is live and linear — Koroku at 12 ran 2×, at 18 ran 3× against a stock 6.0 |
| **Movement rules** | stock, Koroku rolls encounters walking and never running; with the animal-run range set, running triggers them too |
| **Mount re-pairing** | including across mount types — Hugo+Bright and Chris+Bright both play |
| **Passive rune mechanism** | Sunbeam's walk-heal fired with nobody carrying the rune — but under the *previous* patch shape (see Passives) |

Everything on **Passives** and everything on **Test** reads **untested**, on every row. Where
nothing is known, the tab says so rather than guessing.

## How it runs

The page has two tabs — **Save Editor** and **ISO Editor** — and everything happens locally.
The save engine is the project's real Python module running in your browser through
Pyodide/WebAssembly, so the browser and the reference implementation are the same code rather
than two ports that can drift.

- **Works on phones.** The Save Editor runs in any modern browser, including Android — handy
  for editing a memory card on the same device you emulate on (AetherSX2 / NetherSX2 / PCSX2).
- **Installable / offline.** It's a PWA: use **Install app** / **Add to Home Screen** and,
  after the first visit, it works fully offline. It updates itself, and a footer **↻ Force
  refresh** clears the cache if a build ever gets stuck.
- **Your data stays put.** No server, no upload. Saves and ISOs are read and written on your
  device only.

**How the ISO is written** depends on the browser:

- **Chromium desktop** (Chrome / Edge / Brave / Opera) — writes just the changed bytes back
  **in place** via the File System Access API.
- **Other browsers** (Firefox / Safari / Android) — **stream a patched copy** to your
  downloads that you swap in, or **export a recipe / `.xdelta`** to apply elsewhere.

The editor only reads the ~3.75 MB executable region, verifies it's a USA `SLUS-20387` image,
and never fully loads or uploads the multi-GB file.

---

## Save Editor

Open a save with **Choose file…** or drag it in — no ISO needed. Supported containers:

| Format | Extension | Notes |
|---|---|---|
| PS2 memory card | `.ps2` / `.mcd` / `.mc2` / `.bin` | Full PS2MFS walk; multi-slot; per-page ECC recomputed |
| EMS export | `.psu` | Edited in place |
| PS3 virtual card | `.psv` | Edited in place |
| SharkPort / X-Port | `.sps` / `.xps` | Patched in place |
| CodeBreaker | `.cbs` | Decompressed, edited, re-encoded |
| Raw payload | `gamedata` | The bare save payload |

Multi-save memory cards show a **slot switcher**. Every write recomputes the save's
**checksum** (and card **ECC**), so the result is byte-compatible with the game.

**Overview** — names (Flame Champion, castle, Suikoden I/II hero & country), gold, chapter,
playtime, story phase and Suikoden I/II carryover detection — plus a **JSON snapshot**
(⬇ Export / ⬆ Import) of the whole save: a human-readable file you can edit or share and
re-import, which stages the differences through the normal review-and-Apply path rather than
writing anything directly.

**Characters** — level, weapon (sharpen) level, current/max HP, EXP, all 7 stats, equipped
runes + armour (category-filtered, name-resolved pickers), 8 skill slots (id + **rank tier
E…S**), and per-character recruitment. Fields carry the same **guide overlays** as the ISO
editor: each stat shows its growth rate and expected Lv-99 range, Max HP the HP row, Level the
level that character joins at, each rune slot whether it's innate or **opens at Lv N**, and
each skill slot that character's **maximum grade** (or a note that they can't learn it at all).

**Recruit** — tick *recruited* and pick the pre-merge team (Hugo / Chris / Geddoe / Thomas /
shared). Meant for **optional** recruits: **story characters that auto-join are faded and
tagged ⚠**, since recruiting them manually is unneeded and can soft-lock an early save (the
story/optional split is derived from the character guide).

**108 Stars** — a completion checklist over the Stars of Destiny, laid out in the
**recruitment guide's order** — the order you can actually get them in — and cut into that
order's stages (Chapter 1's four parties, the Budehuc-era optional recruits, each story block,
the Chapter 6 four), **each stage with its own progress** and foldable once it's done. It
shows how many you have, each star's Star of Destiny name and guide position, the Hugo /
Chris / Geddoe / Thomas / shared spread, filters (recruited vs missing, optional vs story),
the guide's how-to line under each missing **optional** star, **next in guide order**, and a
**＋ recruit** button that stages it without leaving the list.

Under each how-to it spells out **what that errand needs**:

- **where the item comes from and when** — the disc's own shop counters (town, regular stock
  vs rare find, the rare find's per-visit chance and which story stages carry it), enemy drops
  with the enemy, level, odds and area, and treasure chests;
- **the potch price measured against your purse**;
- **any star you have to bring along or recruit first**, with a ✓/✗ for whether you have them.

Each can be **handed over**: an item goes into the bag of the party the save is currently
playing (derived from the field-leader byte and that character's team — before the parties
merge each protagonist carries their own bag, so "your inventory" is not one place), and a
potch price is topped up by exactly the shortfall. An errand that says **buy** is money, not
goods — Dominic joins when you *buy* the Mole Armor from him, so that one is priced off the
disc (600 potch) and offers the top-up, never a free copy. Both only stage the change, so they
go through **Review changes** — and the **Inventory** tab opens on the list the item actually
landed in, with the row marked *staged*, so an add is visible where you'd look for it.

**Party** — the active battle party (up to 6), by character name.

**Field character** — who you run around the map as, with the whole mechanism written out on
the tab: what the leader byte does, why the pick has to sit in party slot 1, and why the
character being stood in for has to leave the party. Picking someone stages both. (Details
under [Field character](#field-character--run-around-the-map-as-someone-else).)

**Inventory** — every bag, split into Party Items vs Key/Valuables, with name-resolved item
pickers, quantities, add and remove. The bag layout follows the save: before the parties merge
each of Hugo / Chris / Geddoe / Thomas has their own bag *and* their own storage; afterwards
it's one shared party bag plus one shared 210-slot storage. Runes, armour and key items are
**one per slot** (the game holds three Fury Runes as three slots, not one slot with a count of
3), so only stackables show a quantity, and new items are appended after a bag's last entry
rather than dropped into a gap. Sub-tab badges and each bag's used/free tally count staged
slots.

**Health** — a lint over the save. It reads the file **plus your pending edits** and reports
the states the game never writes itself:

- *problems* — an unrecruited character in the active party; current HP above max HP;
- *warnings* — a rune carrying a stack count (the shape that used to make spare copies
  vanish); a value the engine will clamp on write, quoting what will actually land; the same
  skill in two slots; gear in a slot that doesn't take it; items sitting after a gap in a bag;
- *notes* — a party leader who isn't in the party; a skill above the guide's cap.

Most findings carry a one-click **Fix**, and a Fix only *stages* its change like any other
edit. The tab badges the problem count, and the decode-time layout checks are folded in so
it's the one place to look.

**Throughout**: item and skill pickers show **guide details** — rune effects and food heals
(which lack an in-game description record), plus per-rank skill effects. The guide data has no
entry for the support characters (they don't fight) or for a handful of units the guides omit;
those show no note rather than a guess.

**Quality of life** — **searchable pickers** (type-to-filter over id + name + in-game
description + category), a **review-changes** confirmation before anything is written, an
**unsaved-changes guard**, a one-tap **↻ Last opened** chip, and two themes (*Crimson & Gold*,
*Parchment*). On desktop Chromium the app keeps a writable handle so **Apply & save to file**
overwrites the original in place; other browsers fall back to **Apply & download**. On Android
it can also **Apply & share…** the edited file straight to your file manager or emulator
folder.

Every save is **cross-checked against invariants a correct layout can't violate** as it
decodes (including the level it reads against the level the save's own PS2 browser title
reports). A save that doesn't decode cleanly says so loudly before you edit it; benign
discrepancies with a known explanation get a quiet note instead, so the loud warning keeps its
meaning.

---

## ISO Editor

### Characters, Growth, Support, Weapons, Shops

**Characters** — starting stats, equipment (rune Head/Right/Left, skills + ranks), and an
experimental **disc-wide rename** for **Hugo, Chris, Geddoe and Koroku**: the new name replaces
the old everywhere on the disc — menus, battle and dialogue alike — so it's same-length only
and needs the streaming *save patched copy* path, which the in-place write can't reach. The
list is limited to names that never occur inside a longer word, since a same-length replace
would corrupt those too — which is why *Luc* isn't offered ("Lucia", "Luck").

**Growth** — stat-growth rates, fixed skills, starting level, and the 43-skill maximum-level
caps with one-click presets (*Set to guide caps*, *Max all*, *Clear*), plus **bulk scaling**
that multiplies every character's growth rate at once and carries the idempotent *Tougher /
Hard / Brutal* difficulty presets, optionally scoped to whatever the filter box is showing.

**Support** — the support characters' skill sets, 8 skill ids each. **Weapons** — ATK across all
16 sharpen levels.

**Shops** — every shop counter on the disc, by town: what the item, armour and rune shops sell
at each of their **four story stages**, and the **four rare finds** each one can roll. Town
names are matched to the Suikosource guides. This is the same data the 108-Stars checklist reads
when it tells you where an errand's item comes from and how likely the rare find is.

### Runes, Passives, Rune power, Spells, Unites

**Runes** — every rune in the game: **rename** it, rewrite the **menu text** the game shows for
it, and **choose which spells it grants**. Every rune record carries **four spell slots**, and
a rune with fewer spells is simply zero-padded — so *Kite* grants one attack and has **three
free slots**, and filling one is how a rune is given a spell it never had. Each of the game's
94 spells can go in any slot; all 27 special-attack runes have the same three slots spare.
Each filled slot links straight into the **Spells** tab with that record open, which stays the
one place a spell's own power / cast / element / target / status is edited — and it is the only
route from an attack rune to its numbers, since Kite and Phoenix carry no status effect for an
effect editor to hang off. The passive support runes ship with all four slots empty: what they
do is engine code, not a spell — and **Passives** is where that code is reached.

Two caveats, both written into the tab: the character levels that gate a rune's later spells
are **not** in this record and are not editable yet, and whether an attack rune will surface
more than one spell is untested on hardware.

Names and menu text are rewritten in place, so each is capped to the slot the disc reserves for
it, and both are **mirrored across every copy**: the 20 attack runes and 7 magic scrolls store
their description twice, and 43 names are stored twice as well — *Kite* the rune and *Kite* the
spell it grants each hold their own — so one edit keeps the rune menu, the battle command and
the item list agreeing. A rename shows up immediately in every picker, tooltip and list for
that ISO, and the rune stays findable under its original name.

**Passives** — the **support runes** the engine actually asks about (*Wall*, *Fury*, *Hunter*,
*Champion's*, *Sunbeam's* and the rest). 22 of them can be handed to **the characters you
choose**, without equipping the rune and without spending a rune slot; the 23rd, *Fortune*, is
a global switch instead, for the reason below.

A support rune grants no spells and has no battle command: each is one question the engine asks
at the moment it matters — *"does this character have item N equipped?"* — always through the
same three seven-slot equipment lookups, and this repo has all **51** places it is asked. Every
one is reachable, because the answer is not a word written over the call: it is a **retargeted
call**. The site's `jal` keeps being a `jal` and its branch delay slot is never touched, so
exactly one word per site changes; the new target is a 288-byte helper relocated over a routine
in the executable that nothing in the image references, plus a 22×16-byte table of one bit per
character. The helper identifies the character the way the game does, by where its record sits
in the static 112-entry array the engine indexes — which is also what keeps a forced in-battle
passive **off enemies**, since an enemy's record is heap-allocated and can never land inside
that array. So *Wall* can be given to Hugo alone, and everybody else — every ally, every enemy
— gets the disc's own stock answer. Every site is byte-checked against a pristine disc before
anything is written, and clearing a rune restores the stock instruction exactly; clearing every
rune puts the borrowed routine back byte-for-byte.

> **Nothing here has been watched working in play**, and the tab says so on every row. One
> nearby thing has: on 2026-09-06 Sunbeam's field walk-heal healed the party by walking with
> nobody carrying the rune — but that was the editor's *previous* patch shape, which dropped
> the call instead of retargeting it. That report proves the site and the effect; it says
> nothing about the trampoline, its register handling, the bitmap lookup, or whether the
> borrowed routine is as dead in a running game as it is in the image. Keep a backup.

**Fortune — the 23rd, and a different shape.** Its check isn't in the executable at all; it
lives in a **streaming battle overlay** ~1 GB into the disc, which is why three exhaustive
searches of the executable found nothing. It asks exactly the same question as the other 22,
but the per-character machinery above reaches the ELF block only — so Fortune gets a plain
**on/off tickbox** instead: the battle-results loop is answered *yes* for every party member,
without a helper call. That is not a downgrade in effect, because the loop only tests whether
the count is nonzero — **one Fortune is as good as six**, so forcing it is exactly as strong as
handing one character the rune. What it multiplies by is the **EXP multiplier** under Rune
power, which is editable on a stock disc.

**Prosperity, on the same switch.** The same overlay loop, 0x54 bytes later, asks each member
*which armour set they are wearing* and multiplies the potch award once per member whose set is
in the ownership mask. It gets the same tickbox, shown here and again on the **Sets** tab beside
the numbers it multiplies. Unlike Fortune this one **compounds** — the multiplier applies per
member, so a full party of six at the stock ×3 pays 3⁶ = **×729**, and the control says so
rather than leaving it to be found out. Setting the mask to *no set (off)* on the Sets tab turns
the bonus off for everyone, forced or not.

Both are patched in the older two-word shape rather than the relocated helper — the delay-slot
instruction moves up into the `jal`'s word and the answer goes in the word it vacated, so
nothing is inserted and the instruction order stays stock. Both streaming copies of the overlay
always move together; a disc where they disagree reads as *mixed* and goes read-only, so it can
never be left half-patched. Only these two of the overlay's checks are offered: both run after
the fight is over, walk your own party and nobody else, and neither answer has a per-unit
consequence — no enemy is ever asked, and nothing downstream re-reads who said yes.

**Not offered:** Koroku's four dogs, whose character records live outside the array the
per-character table indexes.

**Rune power**, on the same tab — not *whether* a passive fires but **how much it is worth**:
16 constants across 13 runes, read out of the instruction each rune runs right after it has
asked whether you have it. *Sunbeam heals 15 HP a combat turn and 3.33 HP a second of walking*,
and both are editable — here, and on Sunbeam's own row on the **Runes** tab under **Strength**,
which is the same bytes from either side. So are Killer's and Counter's ×150%, Gale's SPD
boost, Haziness' real dodge chance (30%, which its menu text never states), Drain's and
Barrier's divisors, Hunter's damage clamp, Violence's half-HP trigger, and the doubling/halving
shifts behind Wall, Double-Strike, Fire Sealing, Wizard and Warrior. These need **no switch**
and work on a stock disc — every site sits inside the rune's own *if equipped* branch, so the
rune still has to be equipped — but like every code constant here they are **global**: raising
Killer raises it for everyone who wears one, enemies included. Each control rewrites only the
value inside an instruction the game already runs, checks the site is still the shape it
decoded, and reverts byte-for-byte.

**Spells** — power / cast (MOV) / element / target / AOE / status, plus the **damage+heal
slot** (Shining Wind's split effect, movable onto any spell), a **rune reskin** (with quick
presets like *Power 9999*, *Make AOE*, *Add poison*) that edits every spell a rune grants at
once, for any of the 49 runes that grant something — it reads each rune's slots off the disc, so
it follows a reassignment — a **bulk Power scale** for the whole table, and optional description
rewrites.

**Unites** — the unite-attack table: power, cast, target and area-of-effect, plus the same bulk
Power scale (the difficulty presets' unite half). Which characters perform each unite is shown
as guide reference; the roster itself isn't an editable field.

### Mounts

Both of the game's mount systems: the per-character **assigned horse** that puts the six Zexen
Knights on horseback in the field *and* in battle, and the hard-coded **three-pair** battle
table — stock *Hugo+Fubar / Futch+Bright / Franz+Ruby* — which can be re-pointed so **any rider
with a mounted-battle animation bank rides Fubar, Bright or Ruby**. Re-pairing is **confirmed
in-game**, including across mount types (*Hugo+Bright*, *Chris+Bright*), and every combination
carries its own confidence marker: *confirmed / expected / untested / rough / won't animate*.
The tab also writes out the **pair mechanics**, including the HP pooling that re-splits a
pair's HP proportionally the moment they mount.

Full decode in [`docs/MOUNT_SYSTEM_RESEARCH.md`](docs/MOUNT_SYSTEM_RESEARCH.md).

### Movement

Its own tab, and *not* a code patch: **field** movement speed is a **table**. Every field
object is handed a walk speed and a run speed from one of 14 rows, and which row it reads is a
**movement class** stored on the character. Stock, **walking is 2.0 for the entire cast** and
running is **6.0**, **5.0** or **4.5** by class:

| Run | Class | Who |
|---|---|---|
| **6.0** | 3 | Hugo, Lulu, Melville, Edge, Rody |
| **6.0** | 0 | Fubar, Bright, Ruby, Koroku, Gadget Z |
| **6.0** | 5–8 | Augustine · Gau · Dupa/Shiba/Bazba · Sgt. Joe/Wilder/Rhett |
| **5.0** | 1 | Geddoe, Fred, Percival, Borus, Thomas, Luc, Yuber, … (34) |
| **5.0** | 4 | Rico, Aila, Cecile, Belle, Viki (Young), Emily, … (10) |
| **4.5** | 2 | Chris, Lucia, Lilly, Ayame, Sarah, Nei, Estella, … (13) |

So **running as Chris covers a third less ground than as Hugo** — `4.5` against `6.0`, on the
same walk speed. Mounts are ordinary field objects with their own class, so a mount's row *is*
the mounted speed.

**Pick a character, type a speed.** The engine has no per-character speed — a character points
at a shared class row — so the tab does the bookkeeping. Choose someone, set walk / run / time
scale, press *Give this speed*, and it takes the cheapest of four routes:

| | what it does | cost |
|---|---|---|
| already that speed | nothing | — |
| nobody else in their class | retunes that row in place | free |
| another row already holds it | points them at that row | free |
| otherwise | takes a row nobody uses, writes it, points them there | 1 row |

The budget is **distinct speeds, not characters**: give four characters the same speed and it
costs one row. There are 14 rows and 9 are in stock use, so you start with 5 spare, shown live.
*Reset this character* puts them back — and when the last character leaves a row the editor
restores that row's bytes too, so nothing orphaned stays staged. Collapsed underneath is
**manual class editing**: retune a whole class at once, see which row each character points at,
or reach the rows nobody is in. Members are read live off the disc, so a reassignment shows up
immediately.

**Time scale**, the third column, is that object's **clock multiplier** — not animation-only.
Each frame the engine multiplies elapsed time by it and hands the result both to the animation
clock and to the step that moves the character, so `2.0` animates *and* travels at double rate
while `0.5` is slow motion for one character. That makes it a different lever from run speed:
**run** changes stride length only, so raising it alone makes a character *skate*; **time
scale** speeds up the whole character so the feet keep up, but also speeds up idle fidgets and
the wind-up at each end of a walk. A small rise in both beats a big rise in either. The engine
uses it the same way — a follower who has fallen behind gets a temporary 1.2–1.3, and one
movement state computes it as *current speed ÷ intended speed*. What you set is the *starting*
clock; those situations write over it while they last.

**Confirmed in play, and linear.** Koroku is class 0, which ships at run `6.0`; set to **12** he
ran at **2×**, and at **18** at **3×**. So the value is a plain speed in units where the class's
own stock number is 1× — double it to go twice as fast — and the tab shows the multiple you
have typed rather than leaving `12` to mean nothing on its own. It also settles that the table
really is what moves a field object, which until then was an argument from the absence of an
overwrite rather than a measurement. The walk value, the time scale and the whole battle side
are still unmeasured.

> **Field only.** The table's values reach every object, but the **battle** unit spawner
> immediately overwrites both speeds from the character's *loaded battle asset* — packed archive
> data, not executable — so this cannot change how fast a unit crosses a battlefield.
>
> Most of the cast in the table can never be the character you walk around *as*; that is a
> separate list of eight ids. They are there because a field object is anyone the field walks
> around — the recruits standing about Budehuc Castle, and anyone an event script walks through
> a scene. Hence the grouping by body type rather than by anything a battle stat would need.

Table, disassembly and byte offsets:
[`docs/MOVEMENT_SPEED_RESEARCH.md`](docs/MOVEMENT_SPEED_RESEARCH.md).

### Field character — run around the map as someone else

The on-field avatar is the **party-leader byte** in your save, and that byte names a *model*.
The engine loads the model of **eight hardcoded ids** and no others — Hugo, Chris, Geddoe,
Thomas, **Koroku**, **Luc**, and the two specials *Masked Luc* and *Grasslands Chris*. That is
exactly the set the game hands you itself across its chapters and bonus scenarios.

Pick one from **Save Editor → Field character**, which explains the mechanism in full. It's a
save edit — no ISO patch, no new game. **Confirmed in play: Koroku walks the map, triggers
battles, appears in cutscenes and speaks the protagonist's lines.**

**Two conditions have to hold, and the picker sets both for you:**

| | why |
|---|---|
| your pick is in **party slot 1** | scenes drive the protagonist as *actor slot 0*, which **is** party slot 1, while the camera follows the leader byte — if those are different people a scene animates one and waits on the other |
| the character they stand in for is **removed from the party** | a scene that also stages them as cast ends up with two actor records bound to their single character model, and stalls |

Both were established by playing it each way round. So picking a field character puts them in
slot 1 **and removes the stand-in**, and says what it did. The alternative — keeping them — is
still one click away, labelled with the fact that it freezes scenes. The **Health** tab flags a
save already in the broken state, with the same one-click fix.

**The area doesn't limit the pick.** Field models ship per area archive and the per-area sets
are small — a median of **4 of the 28** — so the editor used to print a coverage figure next to
each character ("ships in 9/28 maps"). Playing them retired it: **every character the picker
offers worked in every area it was taken to**, which is what `ETC.BIN` carrying all of them and
a resident model not being evicted on an area change would predict. The measured table is kept
as research in [`docs/FIELD_CHARACTER_RESEARCH.md`](docs/FIELD_CHARACTER_RESEARCH.md) §6.

**Known limitations, from playing each one.** **Koroku ✕ field pickups freeze** — picking up a
herb or looting a skeleton plays a motion his model has no clip for: his animal rig carries
**15 clips against Hugo's 60**, which is also why his running needed its own fix. As **Luc ✓**
the same objects pick up fine, which is what proves it's the clip set rather than the feature.
Nothing is said about the rest, because untested isn't the same as fine. The picker row and the
pick-time note carry the same verdict.

**No fix for Koroku's pickups — the search was closed off.** Three mechanisms were tried and
played; none helped, and the attempts were removed rather than left in the editor pretending.
What came out of it is in the research doc: the engine's motion table is decoded
(`char name[16]; u32 flags`, with `check_*` at slots 46–51 and `pickup_*` at 52–59), and
**Koroku's model provably carries none of those fourteen clips** while Luc's carries them. The
disproof is there too — the engine functions that test the *motion finished* flag turn out not
to be reachable from any of the 359 event-script opcode handlers, so a script never blocks on
it. The search has moved to the blocking opcode. Play as Koroku and walk past the herbs.

**Whose story you get — the Story content tab.** The leader byte is also *which team's events
and dialogue load*. One switch turns it into a team index, and Luc, Koroku, Sarah and Masked
Luc each have their own — so in a town that ships nothing for their index you get **empty
dialogue boxes**. Hugo is index 0, and 0 is also where an unrecognised leader falls, so **Story
content** can hand any of them Hugo's events by retiring a single instruction immediate.
**Confirmed in play:** blank text boxes render correctly afterwards. It fixes *empty* dialogue,
not a scene that *hangs* — that's the party condition above.

The tab is the standalone twin of the save-editor one, and carries the whole recipe, since the
fix is two edits to two different files. **Setting it up** walks the order — patch the disc
here, pick the character in **Save Editor → Field character**, then load the two together — and
**How it works** covers the id→index switch, the index-0 fallback the trick depends on, and the
line between a blank box (this tab) and a frozen scene (that one).

Two things elsewhere exist because of this feature: **Koroku had no random encounters** until
the run-cycle gate under **Movement rules** was repointed (confirmed in play), and the
disc-wide **rename** covers him alongside Hugo, Chris and Geddoe.

> One caveat throughout: **story scripts set the leader byte at chapter transitions**, so a
> pick holds until the next scene that sets it. The mechanism — the disassembled chains, the
> per-map scan, the byte-verified patch sites, and the four explanations that turned out to be
> wrong along the way — is in
> [`docs/FIELD_CHARACTER_RESEARCH.md`](docs/FIELD_CHARACTER_RESEARCH.md).

### Encounter

**Movement rules.** Before the rate is used at all, the game checks which **animation** you're
playing: walking and running are separate range tests over the player's motion slot, and if
neither matches, the roll is skipped entirely. Two plain toggles fall out of that:

- **Walking triggers encounters — off.** Walk anywhere in peace and run when you want to fight.
  This isn't a rate of 0; running still rolls normally. It's *when* encounters happen, not how
  often.
- **The second run range → animal run cycle.** **Koroku and Fubar are the only two playable
  models with no `run_start_L/R` clips** (76 of 78 have them) — their run cycle sits at slots
  `0x11A–0x11F` in the animal block, outside every band, so running as them never triggered a
  battle. **Both halves are confirmed in play.** The trade is named in the tab: that range
  currently holds the mounted fast-move slots, so you lose encounters while galloping.

**Random encounter rate.** One number controls how often random battles trigger across the
whole game, as a percentage of the stock rate:

| Rate | Effect |
|---|---|
| **0** | no random encounters at all |
| **25 / 50** | a quarter / half as often |
| **100** | unchanged (the disc's own rate) |
| **200 / 300** | twice / three times as often |

Presets (*None · Quarter · Half · Stock · Double · Triple*) sit next to a free-form box taking
0–1000. It's a single global multiplier, so **each area keeps its own character** — a quiet
field stays quieter than a dungeon, everything just shifts together. Setting it back to **100**
restores the original bytes exactly, so a round trip leaves nothing pending.

**Walking, running and galloping — separately.** Under the slider sit the three multipliers it
is made of:

| Mode | Stock | What it covers |
|---|---|---|
| **Walking** | **100** | also *mounted* walking |
| **Running** | **120** | on foot |
| **Running mounted** | **150** | galloping only |

Pull them apart to change the *shape* of the risk rather than its size, and a **0** in any one
mode means that mode never starts a battle. That is a different mechanism from the movement
toggle above: this leaves the roll happening and sets its rate to zero, so an area's own base
rate still decides everything else. The readout states the result in relative terms (*running
1.20× · galloping 1.50×*), and restoring **100 / 120 / 150** writes the disc's original four
words back byte-for-byte.

<details>
<summary>How it works, and what it can't do</summary>

Suikoden III has no encounter-rate table to edit. Every field encounter is one roll inside the
executable — roughly *rate = area\_rate × multiplier ÷ 100*, sampled as you move, then
`rand(100) < rate`. The editor rewrites the multiplier, so the tab patches game **code**, not
data (four instruction words; see `Editor/Suikoden3_ISO_offsets.md`).

Stock, **walking is ×1.00, running ×1.20 and galloping ×1.50** — and walking has no multiplier
of its own at all, taking the ×1.00 by skipping the multiply entirely. To make walking
configurable it gets one grafted in and pointed at the shared divide, which is why 100% still
behaves exactly like the unmodified game: it computes ×100÷100.

**Per-area base rates — editable too.** Under the global slider the tab lists **every area on
the disc** with its own per-map rate: **23 areas, 133 chapter-variant tables, 1,612 map
records**. Towns and interiors read **0** (no random battles); field and dungeon maps read
**2–9** — Karaya 9, Brass Castle and the Great Hollow 6, Budehuc 5, Kuput Forest 4, Amur Plains
3, the mountain path 2. Each area gets *None / Half / Stock / Double* presets that scale from
the disc's own numbers (so re-applying never compounds and **Stock** is a byte-exact restore),
plus a row per map for the rate and the post-battle **grace distance**. Where an area's chapter
tables agree, one row writes all of them; where they disagree the map is split into a row each
rather than showing one value that would be wrong for the others.

> Lowering is always safe. **Raising a rate from 0 is not** — a map the game never fights on
> has no monster party loaded, so rows at 0 are tagged and zone-less archives are flagged.

Getting here meant cracking **`DATA/FSECT.BIN`**, which turns out to be the disc's sub-file
directory rather than the relocation table it was long taken for, and decoding the 60-byte room
record it leads to (the rate is its `+0x04` halfword, traced by disassembly all the way into
the encounter roll). `Editor/build_room_index.py` rebuilds the index from a pristine disc.

</details>

### Enemies

Suikoden III keeps no global monster table: every area's battle pack carries its own copies of
each enemy, so the *same* Blade Bunny is a different record — different level, HP, rewards,
drops — in every region it appears in. The Enemies tab decodes all of it straight from the disc
(**81 packs, ~1,960 encounter variants**, indexed by `Editor/build_enemy_index.py` and
cross-checked against the Suikosource bestiary at 97%+ on potch/SP), and lets you edit per
variant:

- **Level** and **HP**, the **8 combat stats** (PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK — monsters are
  character records in this engine, same stat order),
- **rewards**: EXP value, SP and potch,
- the **5-slot drop table** — item (full item picker) and weight out of 1000 (128 ≈ 12.8%), so
  a rare rune can become a guaranteed drop or vice versa.

**Bulk tuning** sits at the top: multipliers for HP / stats / level / EXP / SP / potch / drop
weights, applied to every variant (or only the packs matching the filter box — type `LAST` to
buff just the final dungeon). Every value recomputes from a fixed base, so Apply is idempotent:
running it twice changes nothing, and ×3 after ×2 gives ×3 of the original, not ×6. Fields left
at ×1 aren't touched, and Reset returns the scope to the disc's own values.

That base is normally the **stock disc's** numbers, not the file's. The pack index is built from
a pristine USA disc and stores each variant's stock lv/hp/stats/rewards/drops next to its
offsets, so re-opening an ISO you already tuned recovers what was done to it: a whole field
group at one consistent ratio *is* the multiplier that was applied. The tab says so ("already
tuned: HP ×1.2"), prefills the boxes with it, and keeps multiplying the stock numbers — so
re-applying ×1.2 stays ×1.2 instead of stacking to ×1.44, and **Restore stock values** writes
the original numbers back, which is the only way to undo a scale already saved into a file. On
a disc the index doesn't describe, the editor says so and falls back to this file's own values
rather than writing someone else's numbers over yours.

**Spawn zones & formations** turn the same tab into an encounter designer. Each map zone (under
the game's own names — `mori_101`, `icew_105` …) has **spawn slots** (which monster occupies the
slot, and *which stat variant* of it) and **formations** — the actual encounter groups, each
with a relative weight and one member pick per slot. Swap a slot's monster and every formation
using it spawns the new one; raise a formation's weight and that group shows up more often. The
slot picker is restricted to the pack's own roster on purpose: monsters from other packs would
spawn without their models loaded and crash the game.

<details>
<summary>How it works, and the fine print</summary>

Enemy data lives duplicated across the disc — each area pack exists as several **streaming
copies** (and separate chapter variants with genuinely different stats). Every edit is written
through to *every byte-verified copy* automatically, and the save review says so ("Potch:
33000 → 44444 (×4 copies)"). Bulk edits are summarized as a byte count instead of thousands of
rows. A pack whose offsets can't be verified ships read-only rather than wrong — the same
correct-or-absent rule as the rest of the editor. Formation sizes can shrink but not grow past
the group's original size (fixed allocation on disc). The full trail — record layout, reward
blocks, zone objects, the multi-pass copy indexer — is in `Editor/Suikoden3_ISO_offsets.md`.

</details>

### War

Every war/major-battle combatant on the disc is editable: Zexen Knights & Infantry,
Karaya/Lizard/Duck Fighters, Mantor Legionnaires, Harmonian Soldiers, the chapter-5 war
monsters, and the enemy **leader units** (Leo, Sarah, Franz and Ruby, identified exactly against
the Suikosource guide) — **level, HP and all 8 combat stats** per unit. Units are grouped per
region archive, so the same soldier type can be tuned battle-by-battle (make the Brass Castle
defense brutal but leave Chisha winnable). Your *own* army units draw their strength from the
characters' save-file stats, so they're edited in the Save Editor instead; the RPGClassics
army-skill list (Riding / Tactics / Valor / Control and rune skills per character) ships as a
read-only reference, since war skills are embedded in code rather than data.

**Bulk tuning** works here too — the same engine as the Enemies tab, over the war half of the
packs, with **HP / all 8 stats / level** multipliers (war battles pay no EXP/SP/potch and drop
nothing). Because the whole army you fight is in these records and yours is not, one Apply is
the difficulty dial for every major battle in the game. Scope picks which half of the opposition
moves: *all war units*, *packs matching filter*, *leader units only*, or *soldier tiers & war
monsters only*. Level alone is the gentlest knob; HP makes battles longer, the 8 stats make them
harder. Everything else is as on the Enemies tab: idempotent, recomputed from the stock disc,
prefilled from what the file already carries, and undoable with Restore stock values.

### Gear, Sets, Food, Text

**Gear** — name, DEF, price, custom description and all 5 effect slots (type / amount / stat or
skill). **Sets** — which items complete each of the 5 armor sets, the set-bonus constants
patched straight out of the game code (potch multiplier, Destiny counter chance, Pale Moon heal
share), and **which set grants which effect**, since each bonus is a hard-coded check on the set
number that can be pointed at a different set. The **Prosperity** switch from the Passives tab
appears here too, beside the potch numbers it multiplies — including the ×729 a full party
compounds to. **Food** — rename a dish, rewrite its
description, set its heal amount and proc chance. **Text** — in-ELF UI strings: battle messages, menu
labels, prize/error prompts and character blurbs, each capped to its original byte length.

> **Text scope.** Story **dialogue** is *not* editable in either editor — it lives in packed
> event files outside the executable. The Text tab covers the strings held in the boot ELF.

> **Names and descriptions are written in place**, over the bytes they already occupy, so each
> is capped to the slot the disc reserves for it (the field shows the cap and refuses anything
> longer rather than truncating). Where the disc stores one string **twice** — 27 descriptions
> and 43 names, e.g. *Kite* the rune and *Kite* the spell it grants, or the Wind Amulet and its
> spell — an edit writes **every copy**, and the field says so.

### Reference — the read-only half

Eight browsers over what the disc *describes* rather than what you can change. Everything
editable has its own tab; these are deliberately read-only.

| | |
|---|---|
| **Items** | every item id, with category and in-game description |
| **Classes** | the war-battle class each unit shows — and why there is no class field to edit (it's derived from the character's skills) |
| **Skills** | every skill: what each rank is worth, who can learn it and how far, who has it on this disc |
| **Item sources** | where each item comes from — drops decoded off this disc, plus labelled guide notes |
| **Files** | every packed sub-file: archive, offset, size, and what it turned out to be |
| **Pickups** | the chests, lootable corpses and herb spots on each map, counted off your disc |
| **Mounts** | the decoded mount system — rider and mount capability, which areas bundle a mount, and the mechanics that can't be exposed as fields |
| **Music** | where the game decides which track plays — and the 29 streams themselves, playable in the browser |

**Files.** `DATA/FSECT.BIN` is the disc's archive directory (one u32 per sub-file: sector
relative to the archive, plus size, both in 2048-byte sectors), so the whole packed layout is
enumerable: **4,403 sub-files across 28 archives**. The browser lists them per archive with each
one's ISO offset, size and kind — **battle** packs (monster records, spawn slots and formations,
tagged with the game's own map id like `mori_101`), **town** data (which holds the room table
the Encounter tab edits), **map** geometry, and **data** for the ~1,400 still unidentified.
**Peek** reads the first 256 bytes straight off your disc as a hex dump. A raw byte editor over
thousands of unknown blobs would be a footgun rather than a feature. Rebuild the index from a
pristine disc with `Editor/build_subfile_index.py`.

**Pickups.** Counted from the game's own object names — `takara` (宝, a chest), `emono` (獲物, a
lootable corpse) and `herb_*` — and cross-checked against the walkthrough. What a pickup
*contains* is not decoded, so nothing here edits loot; chest contents are guide-only and always
will be, because the disc rolls them at runtime. See the offsets doc for why the obvious
candidate field turned out to be script operands.

**Music.** Two halves, deliberately not joined. The **cues** are where the game decides which
track plays: every cue in the event scripts, plus the BGM/ambient pair on every room record
(indexed by `Editor/build_bgm_index.py`). It's read-only because the track ids have no names
yet. The **streams** are the music itself: `/SD/STR.BIN` holds **29 `Svag` streams** — Sony
interleaved VAG, i.e. plain PS-ADPCM — located by a 29-record table in `MODULES/SD_CALL.IRX`
whose every entry lands exactly on a stream header. Each row lists length, sample rate, channels
and size, with a **▶ Play** that decodes it in the browser straight off your open disc; nothing
is uploaded. (The decoder is `web/svag-core.js`, DOM-free so it can be unit-tested headlessly.)
The two lists are not cross-linked because nothing on the disc links them yet: putting a ▶ next
to a track id would claim a mapping that hasn't been established, and most ids probably refer to
sequenced music, which isn't in this file at all.

### Test — experimental, not known to work

Two patches live here because *the patch working* is not the same as *the game coping*.
Everything on this tab is **untested in play**.

- **Field character whitelist** — widening the engine's hardcoded eight to all 75 battle
  characters is two instruction immediates. Everyone past the stock eight is untested. The tab
  shows the resulting loadable set by re-running the engine's own comparison chain over the
  patched bytes, rather than restating what the buttons were meant to do.
- **Assigned-horse window** — a character's assigned horse is one u16 on the **Mounts** tab, and
  the engine throws away any value outside a narrow window. Widening it adds the **Karaya
  horses** (325, 353) and the **Le Buque pair** (359, 360) to the dropdown. The one that matters
  is 325: **Hugo has no assigned horse at all**, and the Karaya horse is the mount he was seen
  with. On its own it does nothing — only six characters are wired to use an assigned horse —
  and the mount list is written when the party is **re-formed**, so a change needs the party
  rebuilt before it can show.

### Changes — what is already on this disc

Every other tab reports what *you* staged this session; the review list is built as you edit, so
it is a history, not a map. Open a disc somebody patched last month — or last release — and the
editor had nothing to say about it. **Changes** answers that instead: point it once at a
**pristine** copy of the disc and it lists every byte that differs, decoded field by field —
*"Kite · description: … → …"*, *"Kite · power: 40 → 199"* — grouped by what they are, with the
address, and a **↺** on each row that stages a revert to the base disc's value. Bytes no known
field claims are still listed, as hex, because a change the tab quietly omitted would defeat the
point of consulting it. You can export the result as an `.s3mod` recipe to replay that disc's
edits onto a clean one.

Nothing about a stock disc ships with this editor — it is the game's own executable — so the
base disc has to be your own pristine copy. It is opened read-only, never written to, and
remembered for next time. Two halves work without one: the **staged** list (this session's
unsaved edits) and a check of every **code patch site** against the stock word this repo has
decoded for it, which names any code patch on the disc with no second file at all.

Use it when a patched disc and the game disagree. That is exactly how the duplicated rune
descriptions (issue #11) stayed invisible for a release: the edit was on the disc, just on the
copy the rune menu doesn't read.

### Sharing a mod without the disc

Two export formats, both built from your staged edits (no need to write the ISO first):

- **Mod recipe (`.s3mod`)** — a tiny, reversible, **version-checked** JSON of the exact byte
  changes (a recipe for the wrong game/region is rejected). Import it to replay the edits on a
  clean disc. This is the safe, source-verified option.
- **`.xdelta` patch** — a standard VCDIFF patch synthesized directly from the edits (no 4 GB
  diff needed). Apply with any VCDIFF tool:
  `xdelta3 -d -s "<pristine ISO>" file.xdelta out.iso`. ⚠ It carries **no integrity checksum**,
  so apply it only to a pristine USA `SLUS-20387` disc.

**Apply someone else's mod — `Apply patch…`.** The same button takes both an `.s3mod` recipe and
a standard **`.xdelta` (VCDIFF)** patch (the format is detected from the file's contents, not
its name), so you can install a community mod on a phone without a desktop. The patch is
**staged like any other edit** — reviewable, undoable, revertible — rather than written straight
to the disc, and the multi-GB image is never fully read: only the regions the patch touches are
examined. If the patch carries xdelta3's checksum (they normally do), applying it to the wrong
or already-modified disc is **detected and refused**.

Two limits, both reported clearly rather than guessed around:

- xdelta3 **compresses patches with LZMA by default**, which this editor can't read. Ask the
  author for one built with `xdelta3 -e -S none -s <source> <target> <patch>`.
- A patch that changes bytes **outside the editable region** is refused whole (a half-applied
  mod is worse than none) — use `xdelta3 -d` for those.

### Across the whole ISO editor

**Guide overlays.** Fields show verified reference data inline: per-character skill caps and
Lv-99 growth ranges in Growth, "rune slot opens at Lv N" on the equipment slots, rune/food
effect descriptions in the item pickers, and full per-rank skill effects. All of it is
cross-checked against the Suikosource guides and re-verified against a real disc.

**Undo/redo.** Every edit is undoable (toolbar ↶/↷ or Ctrl/Cmd+Z / Shift+Z), on top of the
per-field **↺** restore and **Revert all**.

---

## Repo layout

`web/` is the editor. There is no second one — a self-contained Python desktop app
(`Editor/s3editor.py`) was retired in v1.48.0 once the web editor covered everything it did,
because keeping two implementations of the same ISO tables in step cost more than it caught.
What it uniquely offered is covered:

- **`.s3mod` recipes and `.xdelta` patches** — the web editor exports *and* applies both,
  natively (`web/vcdiff.js` is a full VCDIFF encoder/decoder; no `xdelta3` needed).
- **Diffing two arbitrary discs** — the one thing the web editor can't do, since it only knows
  about edits made in it. That's one shell command:

  ```bash
  xdelta3 -e -S none -s clean.iso modded.iso out.xdelta
  ```

  `-S none` matters: the web editor reads any VCDIFF patch except a secondary-compressed one.

```
web/                the editor (also deployed to GitHub Pages)
web/*-core.js       DOM-free logic that is unit-tested headlessly: health lint, recruit data,
                    changes diff, rename, text, guide overlays, VCDIFF, Svag audio decode
web/tests/          Node checks + a Playwright e2e suite (npm test / npm run test:e2e)

Editor/
  s3save.py         the save engine. NOT legacy — web/app.js fetches it and runs it under
                    Pyodide, so this file *is* the save editor. Also runs standalone:
                    `python3 Editor/s3save.py <memcard.ps2>` dumps a card's saves.
  s3patch.py        ISO reader library + verified field tables. Its one consumer is
                    build_item_desc_extra.py; it is not a second editor.
  build_*.py        regenerate the guide reference data (skills, caps, growth, rune slots,
                    bestiary, recruit flags, recruitment order and prerequisites, rune/food
                    descriptions, room, sub-file and BGM indexes) from a pristine disc + the
                    saved guide text
  suikosource/      saved Suikosource guide text the generators parse
  s3_*.json / *_ids.txt    verified id->name / description / guide reference data
  Suikoden3_ISO_offsets.md the reverse-engineering notebook — the source of truth for offsets

tools/pcsx2/        PCSX2 automation: boot a patched ISO and read the tables back out of the
                    running game, plus RAM snapshot/diff tooling for research
docs/               research write-ups (see below)
```

### Verifying a change against the real game — `tools/pcsx2/`

The test suite proves the editor writes the bytes it means to. It cannot prove the *game* reads
them the way we think. `tools/pcsx2/` closes that gap by driving PCSX2 over its PINE socket
(stdlib only, nothing to install):

```bash
python3 -m tools.pcsx2.cli doctor
```

`boot-verify` boots an edited disc and reads the tables back out of EE RAM — the one check no
synthetic fixture can make. `snapshot` / `diff` / `scan` are the RAM research tooling behind new
offset work: snapshot memory around a known in-game action, diff the states, and narrow to the
bytes that moved. `read` / `poke` / `codes` / `states` round it out. Full guide in
[`docs/PCSX2_AUTOMATION.md`](docs/PCSX2_AUTOMATION.md).

`python3 tools/pcsx2/selftest.py` covers everything under the emulator — PINE framing, savestate
parsing, scan narrowing, ELF calibration, PNG hashing — and runs in CI, where no disc or BIOS
exists.

### Research notes

The offsets notebook ([`Editor/Suikoden3_ISO_offsets.md`](Editor/Suikoden3_ISO_offsets.md)) is
the primary record. Longer investigations get their own doc:

| | |
|---|---|
| [`MOUNT_SYSTEM_RESEARCH.md`](docs/MOUNT_SYSTEM_RESEARCH.md) | both mount systems, the pair HP-pooling mechanics |
| [`MOVEMENT_SPEED_RESEARCH.md`](docs/MOVEMENT_SPEED_RESEARCH.md) | the walk/run speed table and the per-character movement class |
| [`FIELD_CHARACTER_RESEARCH.md`](docs/FIELD_CHARACTER_RESEARCH.md) | the field-avatar whitelist, per-map coverage, the story-content switch |
| [`ENEMIES_IN_PLAYER_PARTY_RESEARCH.md`](docs/ENEMIES_IN_PLAYER_PARTY_RESEARCH.md) | why enemies can't join the party; the three disjoint id spaces |
| [`ETC_BIN_MODEL_RESEARCH.md`](docs/ETC_BIN_MODEL_RESEARCH.md) | character model swapping — decoded, and why it stays infeasible |
| [`RECRUITMENT_RANDOMIZER_RESEARCH.md`](docs/RECRUITMENT_RANDOMIZER_RESEARCH.md) | recruitment-randomizer groundwork |
| [`PCSX2_AUTOMATION.md`](docs/PCSX2_AUTOMATION.md) | driving the emulator for verification and RAM research |

Several document things that turned out **not** to work. Those are kept deliberately — a
recorded dead end is worth more than a question re-opened every few months.

### Tests

```bash
cd web/tests && npm test          # Node checks: offsets, reference data, save round-trips, VCDIFF
npm run test:e2e                  # Playwright against a synthetic ISO fixture
python3 tools/pcsx2/selftest.py   # PCSX2 harness, no emulator required
```

Contributor conventions are in [`CLAUDE.md`](CLAUDE.md).

---

## Privacy & scope

The repository contains **no game ROM/ISO, saves, audio, or story assets** — only small
reverse-engineered reference tables (id→name maps, offsets) the editor needs to show meaningful
labels. That's interoperability data, not the game. The editor runs entirely in your browser —
nothing you open is uploaded anywhere.

## Support

Feature requests / Support available on the **Toran Castle Discord**:
https://discord.gg/KesHMX5P2Z
