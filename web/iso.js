// Suikoden III ISO Editor — web front-end (client-side, in-place, no upload).
//
// Unlike the save editor (which loads a tiny file wholesale into Pyodide), the ISO is
// ~4.3 GB and can't live in memory. But every editable table sits in ONE contiguous
// ~3.7 MB region near the front of the disc (the boot ELF's PT_LOAD segment). So we:
//   • read that single block once via a ranged Blob.slice() (nothing else is loaded),
//   • edit entirely in memory against that block,
//   • on save, diff the block vs its pristine copy and write ONLY the changed byte runs
//     back to the original file via the File System Access API (in place).
//
// All offsets/strides/field layouts mirror Editor/s3patch.py + Editor/s3fields.py exactly.
// This tab is desktop-Chromium only (needs showOpenFilePicker for a writable handle);
// unsupported browsers get a clear "why" notice instead.
(function () {
  "use strict";

  // ---- constants (raw byte offsets into the ISO; decimal is authoritative) ----
  const VERSION_OFF = 4136544;              // u32 big-endian
  const VERSION_VAL = 0x40A69A01;           // SLUS-20387 (USA)
  const ELF_BASE = 0xA4800;                 // PT_LOAD file offset
  // Read to the end of the ELF text/string region (0x465DF0) so every editable table AND
  // every description string it points into is inside the block we hold.
  const ELF_LEN = 0x465DF0 - 0xA4800;       // ~3.75 MB
  const ELF_VADDR = 0x165D000;              // PT_LOAD virtual address (for name/desc pointers)
  const ELF_END = ELF_BASE + ELF_LEN;

  const TABLES = { list1: [4078716, 140], list2: [4068152, 132], list3: [4089904, 8], list4: [4061704, 28] };
  const LIST_COUNT = { list1: 80, list2: 80, list3: 35, list4: 28 };
  // Shop counters. What earlier versions exposed as two unlabelled slot lists ("item3_a",
  // "item3_b") turned out to be record 0 of two of these arrays — Vinay del Zexay's item and
  // armour counters at their first story stage. Geometry is proved from the disc's accessors;
  // see the drawShops comment and Editor/build_shop_index.py.
  const SHOPS = {
    stride: 0x7C, varStride: 0x1F0, stock: 30, rarOff: 0x3C, rarStride: 0x10, rarCount: 4,
    locs: 14, stages: 4,
    kinds: [{ k: 1, name: "Item Shop", base: 0x3EA550 },
            { k: 2, name: "Armor Shop", base: 0x3DDCD0 },
            { k: 3, name: "Rune Shop", base: 0x3EEB48 }],
  };
  const PRICE_LADDER = [3970620, 15, 4];    // 15 x u32 potch — a shared price scale
  const ITEM1 = [4136564, 3, 4];            // 3 x u32, meaning not identified
  // Each record's LAST 8 bytes are stored one record AHEAD of the name/desc/power they belong
  // to, so a spell reads every tail field at (own base + stride + x). Element was already known
  // to sit there; two more tail fields are now pinned, each against both tables at once:
  //   radius (+0x01 into the tail) — the size of the area/line template. Nonzero for every AREA
  //     or LINE record and zero for every single/all-target one, 130/130 across the 94 spells
  //     and 38 unites with no exception. Spells run 1..4 (Dancing Flames 2 -> Blazing Wall 3 ->
  //     Explosion 4), every area unite is 3.
  //   chance (+0x06 into the tail for spells, +0x04 for unites) — % chance the status lands.
  //     Nonzero for exactly the records with flags14 bit21 set, again 130/130, and it reads
  //     straight off the text: unite "Knight B" = 30 vs "30% chance of deathblow", Wind of
  //     Sleep 60, Funeral Wind 80, Open Gate 80 (deathblow), Ready!/Go! 100.
  // A unite record is 8 bytes longer than a spell record, so the same shift leaves its tail
  // INSIDE its own record (+0x20..+0x27) — no next-record guard needed there.
  const SPELL = { off: 0x3EC2A0, count: 94, stride: 0x20, elem: 0x24, radius: 0x21, chance: 0x26 };
  const UNITE = { off: 0x3ECF90, count: 38, stride: 0x28, radius: 0x21, chance: 0x24 };
  // ---- Split spell: damage the foe side, heal the ally side (Shining Wind) ----
  // Shining Wind is the only thing in the game that hits BOTH sides with two different
  // effects ("500DMG to foes. Heals 300HP for allies."), and that is not a data flag —
  // it is a hardcoded `if (spellId == 17)` in the boot ELF. Empty World proves it: same
  // flags14 (0x0001030A), same flags18 (0), same radius, and its allies take damage.
  //
  // The engine indexes the spell table by a 1-BASED id (`rec = 0x019A4A88 + id*0x20`, so
  // game id = this editor's row + 1) and a record really begins at the name pointer:
  // name +0x00, desc +0x04, cast +0x08, flags14 +0x0C, flags18 +0x10, power +0x14 (u16),
  // then the tail bytes this editor reads one record ahead. Two sites carry Shining Wind:
  //   • ROUTE, file 0x25A8A4 = `addiu $v0,$zero,0x11`, feeding `bne $s6,$v0` two
  //     instructions later. On a match the applier DISCARDS the record's own flags and
  //     substitutes a whole profile per side: allies get flags14 0x00110186 + flags18
  //     0x1DE7 (heal HP and clear status, whole ally side), foes get flags14 0x0001020A
  //     + flags18 0 (plain damage, whole foe side). The record's own target byte 0x03
  //     is what puts both sides in the target list to begin with; this substitution is
  //     what makes the two sides get different things. Any other 0x03 spell takes the
  //     damage branch on both sides — hence Empty World's "45DMG to allies".
  //   • AMOUNT, file 0xE1C90/0xE1C9C = `addiu $s2,$zero,300` + `xori $v1,$s6,0x11`
  //     feeding `movn $s2,$v0,$v1` — the heal number is 300 for spell 17 and the spell's
  //     own Power for everything else. That single hack is the only reason Shining Wind
  //     heals 300 while dealing 500.
  // A whole-ELF scan finds no third id-17 site, so "which spell splits" and "how much it
  // heals" are each exactly one 16-bit immediate. Repointing them moves the behaviour to
  // another spell byte-for-byte reversibly. The game has ONE such slot: this relocates
  // the trick, it can't clone it.
  const SPLIT = {
    route: 0x25A8A4, amtSel: 0xE1C9C, amt: 0xE1C90,
    stockRoute: 0x24020011, stockAmtSel: 0x3AC30011, stockAmt: 0x2412012C,
    routeOp: 0x24020000,      // addiu $v0,$zero,imm
    amtSelOp: 0x3AC30000,     // xori  $v1,$s6,imm
    amtOp: 0x24120000,        // addiu $s2,$zero,imm
    stockSpell: 16, stockHeal: 300, maxHeal: 9999,
    allyF14: 0x00110186, foeF14: 0x0001020A,   // the substituted per-side profiles
  };
  const splitWord = (op, imm) => (op | (imm & 0xFFFF)) >>> 0;
  const splitImm = (w, op) => (((w >>> 0) & 0xFFFF0000) === op ? (w & 0xFFFF) : null);
  // 60 recipe/dish records (0..59). Records 60-61 name-resolve to consumable ITEMS (Sacrificial
  // Jizo = Curative, Escape Scroll = Spell Scroll), i.e. past the recipe table — excluded. (#food)
  const FOOD = { off: 0x3E91D0, stride: 0x48, count: 60, desc: 0x00, heal: 0x14, proc: 0x1E, name: 0x44 };
  // Equipment records, 0x44 apart. These offsets are relative to the STATS record, which sits
  // one record after the one carrying the name pointer — so the name pointer reads back at
  // base-0x04 (= +0x40 of the preceding record). scanGear explains how a record is anchored.
  const GEAR = { stride: 0x44, def: 0x10, price: 0x08, name: -0x04, effs: [0x14, 0x1C, 0x24, 0x2C, 0x34] };
  // RUNE item table — the text the game itself shows in the rune/equip menu. Indexed by ITEM
  // ID (record = off + id*stride), name ptr @+0x00 and description ptr @+0x04. Verified on a
  // pristine SLUS-20387: all 72 rune items line up, ids 317-365 (magic/attack) and 440-462
  // (the passive support runes — Balance, Fury, Fortune … — which have no spell-table entry
  // at all, which is why they used to show nothing). Records for non-rune ids are zeroed, so
  // every read is guarded by a name check against the item list before its desc is trusted.
  const RUNE_TBL = { off: 0x3EAF78, stride: 0x20, name: 0x00, desc: 0x04, lo: 317, hi: 462 };
  const ENEMY = { off: 0x3E74E0, count: 100, stride: 0x14 };   // names only (no editable stat table)

  // ---- Armor sets (see Editor/Suikoden3_ISO_offsets.md "Armor sets ... CRACKED") ----
  // Composition table: 5 records x 8 bytes = 4 x u16 item ids (Head/Body/Shield/Accessory,
  // 0 = slot unused). Row order = in-code set number: 1=Mole 2=Prosperity 3=Destiny
  // 4=Guardian 5=Pale Moon. The bonus constants are instruction immediates; every stock
  // word below was byte-verified against a pristine SLUS-20387 dump.
  // ---- mounted rider/mount pairs (battle) -------------------------------------
  // IsValidRidePair @ vaddr 0x16e8b78 is three hard-coded (rider, mount) model-id
  // comparisons and nothing else gates mounting in battle; the candidates themselves
  // come from party membership (0x17dede4 asks IsValidRidePair(partyLeader, otherMember)).
  // Every id is the 16-bit immediate of an `addiu $v0,$zero,N`, so only the low half-word
  // of the instruction changes and the opcode bytes (02 24) stay put.
  //
  // Riders #2 and #3 each live at TWO sites: the compiler hoisted the next comparison's
  // constant into a branch delay slot, so both copies must be written together or the
  // comparison chain silently stops matching. Rider #1 has only one site (its delay slot
  // belongs to the null-argument guard above it).
  //
  // These are MODEL ids (the engine's own chara numbering, 1..611), NOT the list-1 roster
  // index the other tabs use — see docs/s3_model_ids.json for the full cross-reference.
  const MOUNTS = {
    sig: [0x02, 0x24],                        // addiu $v0,$zero,imm — bytes at +2,+3 of each site
    pairs: [
      { riderSites: [0x130384],           mountSite: 0x130390 },
      { riderSites: [0x13038C, 0x130398], mountSite: 0x1303A4 },
      { riderSites: [0x1303A0, 0x1303AC], mountSite: 0x1303B4 },
    ],
    // Only models carrying the 3xx mounted animation bank can actually ride. Anyone else
    // links to the mount and then keeps their normal battle pose, because the motion set
    // call for slots 0xB8+ fails on the missing clips.
    //
    // Rider columns: [modelId, name, rig, bank, note]
    //   rig  — which class of mount the model's mounted-battle clips were authored around.
    //          Hugo's were built for a griffon and Futch's for a dragon ("flyer"); Chris's and
    //          the Zexen knights' around a horse, Franz's around Ruby ("horse"). Battle seating
    //          does NOT read the ground saddle-offset table (that is on the RideOn path only),
    //          so the rider's position comes from the mounted rig itself — which is why the
    //          open question on a cross-class pairing is geometry, never permission.
    //   bank — "full" = the whole 301/320/340 mounted-battle set; "partial" = some clips only.
    riders: [
      [1, "Hugo", "flyer", "full"], [2, "Chris", "horse", "full"],
      [13, "Roland", "horse", "full"], [18, "Leo", "horse", "full"],
      [20, "Percival", "horse", "full"], [21, "Borus", "horse", "full"],
      [31, "Futch", "flyer", "full"], [41, "Franz", "horse", "full"],
      [76, "Sharon", "?", "partial", "partial bank — 300/301/310/311 only"],
    ],
    // Party members with a FIELD ride bank but no mounted-battle one. The comparison chain is a
    // pure id compare, so it accepts them perfectly well — they link to the mount and then keep
    // their normal battle pose. Offered behind an opt-in, chiefly as the negative control.
    ridersNoBank: [
      [3, "Geddoe", "—", "none"], [29, "Thomas", "—", "none"],
      [45, "Salome", "—", "none"], [55, "Juan", "—", "none"],
    ],
    // Party members whose model carries a battle animation bank (111/140/160/171/172/180).
    // The field-only horses (zkum / s2um / krum / kru2) have no battle set at all.
    // Mount columns: [modelId, name, class, what it is]
    mounts: [[8, "Fubar", "flyer", "griffon"], [32, "Bright", "flyer", "dragon"], [42, "Ruby", "horse", "horse"]],
    STOCK: [[1, 8], [31, 32], [41, 42]],      // Hugo+Fubar, Futch+Bright, Franz+Ruby

    // Combinations played through an emulator and seen to mount, animate and fight correctly.
    // The first three are the retail pairs. The two after them are re-pairings (issue #14,
    // 2026-08-31): Hugo+Bright showed a rider's bank drives a mount it was never authored for,
    // and Chris+Bright showed it survives crossing rig CLASSES — a horse-rigged rider on a
    // flyer. Everything else on the grid is inferred from these; see DIRS and TIERS below.
    //
    // Observed with Chris+Bright and not yet explained: the formation/party menu does not show
    // the pairing, but battle mounting happens anyway. `IsValidRidePair` has menu call sites, so
    // the menu's mounted indicator evidently reads something else. Not traced.
    CONFIRMED: [[1, 8], [31, 32], [41, 42], [1, 32], [2, 32]],

    // What the tab claims per combination. Ordered most to least confident; `cls` picks the
    // badge colour. `why` is the tooltip, and the legend text, so it has to stand alone.
    TIERS: {
      confirmed: { cls: "ok", mark: "✓", label: "confirmed",
        why: "played through an emulator: the pair mounts, animates and fights correctly." },
      expected: { cls: "exp", mark: "•", label: "expected",
        why: "a rider with this rig class has been played on this class of mount — either it matches (horse rig on Ruby) or the crossing itself is confirmed (a horse-rigged rider on a flyer, via Chris+Bright). This exact pair has not been played." },
      untested: { cls: "unt", mark: "?", label: "untested",
        why: "the pairing is accepted, but nothing with this rider's rig class has been played on this class of mount — currently only flyer-rigged riders on Ruby. Seat height, angle and scale are unknown." },
      rough: { cls: "rough", mark: "≈", label: "rough",
        why: "this rider carries only part of the mounted-battle bank, so expect missing or wrong clips whichever mount you pick." },
      nobank: { cls: "bad", mark: "✗", label: "won't animate",
        why: "this rider has no mounted-battle bank at all: they link to the mount and then keep their normal battle pose. Predicted, not played." },
      unknown: { cls: "unt", mark: "?", label: "unknown model",
        why: "this id isn't a model this tab knows about, so nothing is predicted about it." },
      off: { cls: "off", mark: "–", label: "disabled",
        why: "one half of the pair is unset, so this comparison never matches." },
    },

    // ---- the OTHER mount system: a per-character assigned horse ----------------
    // Separate from the three-pair table above and strictly more capable. The game asks
    // `hasAssignedHorse(chara) || isValidRidePair(rider, mount)`, and the first half reads a
    // u16 out of the character's own list2 record at +0x66 — undocumented space until now,
    // sitting just past the starting-level bytes at +100/+101.
    //
    // Stock: Chris carries her own horse (309), and Roland / Leo / Percival / Borus / Salome
    // carry the Zexen-knight horse (308) — i.e. exactly the six Zexen Knights. The generic
    // knight NPC gets 308 from a hard-coded case, and `s2hr` (a Chris variant sharing her
    // record) is explicitly excluded in code no matter what its record says.
    //
    // The consumer at 0x16c76e4 does `(value - 308) < 2` unsigned, so **only 308 and 309 are
    // honoured**; any other id is read and silently discarded. Hence a fixed 3-option list.
    // Unlike the pair table this needs no party membership — the horse is a plain NPC model —
    // and it feeds both the field ride path and the battle one.
    horse: {
      off: 0x66, VALID: [[0, "— none —"], [308, "Zexen-knight horse"], [309, "Chris's horse"]],
      // roster ids whose model carries ride animation, with what it can actually do.
      // field = the 07x/97x ground bank; battle = the 301/320/340 mounted-battle bank.
      riders: [
        [1, "Hugo", "field+battle"], [2, "Chris", "field+battle"], [3, "Geddoe", "field"],
        [12, "Roland", "field+battle"], [17, "Leo", "field+battle"], [19, "Percival", "field+battle"],
        [20, "Borus", "field+battle"], [28, "Thomas", "field"], [30, "Futch", "field+battle"],
        [36, "Franz", "field+battle"], [39, "Salome", "field"], [49, "Juan", "field (partial)"],
        [69, "Sharon", "battle only"],
      ],
      STOCK: { 2: 309, 12: 308, 17: 308, 19: 308, 20: 308, 39: 308 },
    },

    // ---- what actually happens when a pair mounts, in battle -------------------
    // Verified at 0x17df744, which runs immediately after Mount() succeeds:
    //
    //   combinedCur = curHP(rider) + curHP(mount)
    //   combinedMax = maxHP(rider) + maxHP(mount)
    //   rider = min(combinedCur * maxHP(rider) / combinedMax + 1, maxHP(rider))
    //   mount = min(combinedCur * maxHP(mount) / combinedMax + 1, maxHP(mount))
    //
    // i.e. mounting equalises the pair's HP *percentage* — a redistribution, not a merge, with
    // total conserved. Damage after that lands on one half only; nothing rebalances again.
    //
    // Each entry is a whole-instruction rewrite with both stock and patched encodings pinned,
    // so the tab can refuse to touch a disc whose bytes don't match.
    mech: {
      pool: { off: 0x226F64, stock: 0x10400030, alt: 0x10000030,   // beqz $v0 -> beq $zero,$zero
        label: "HP pooling when a pair mounts",
        opts: [["0x10400030", "Pool and re-split proportionally (stock)"],
               ["0x10000030", "Leave each half's HP alone"]] },
      roundRider: { off: 0x226FF4, word: 0x24c60001, label: "Rider rounding bonus" },  // addiu $a2,$a2,N
      roundMount: { off: 0x226FF8, word: 0x26100001, label: "Mount rounding bonus" },  // addiu $s0,$s0,N
      adren: { off: 0x262CD0, stock: 0x02228821, alt: 0x00000000,  // addu $s1,$s1,$v0 -> nop
        label: "Adrenaline Power (Death's Door) from the mount",
        opts: [["0x02228821", "Mount's roll adds to the rider's (stock)"],
               ["0x0", "Rider's roll only"]] },
    },
  };

  // ---- field character (who you walk around the map as) -----------------------
  // The avatar is the party-leader byte at save 0x12, and that byte holds a MODEL id — the
  // party id space and the engine's model id space are the same 75 numbers with the same
  // gaps. One function decides whether the avatar's model is ever requested:
  // FieldAvatarModelRequest @ vaddr 0x17B7560, the sole caller of the sole routine that
  // issues the request (0x16E0FF8). It is a plain comparison chain over eight ids, and the
  // ids are 16-bit instruction immediates, so widening it is a constant rewrite like the
  // Mounts table above. A non-whitelisted leader is not an error: the request is simply
  // never made, so the area keeps whatever model it already has resident.
  // See docs/FIELD_CHARACTER_RESEARCH.md for the full chain and the byte verification.
  const AVATAR = {
    eqSig: [0x02, 0x24],                 // addiu $v0,$zero,imm — bytes at +2,+3
    ltSig: [0x82, 0x2C],                 // sltiu $v0,$a0,imm
    // The two range bounds. Setting BOTH to the same N admits every id 1..N-1 through the
    // first branch, which is the whole "allow everyone" patch.
    gates: [
      { off: 0x1FED70, stock: 0x37, label: "upper bound of the low branch" },
      { off: 0x1FED80, stock: 0x04, label: "ids below this always load" },
    ],
    // Single-id slots: each admits exactly one character, and each is one word.
    slots: [
      { off: 0x1FED64, stock: 0x36, label: "single id (stock: Koroku)" },
      { off: 0x1FED78, stock: 0x3F, label: "single id (stock: Luc)" },
      { off: 0x1FED88, stock: 0x1D, label: "single id (stock: Thomas)" },
    ],
    // The second half of the chain, which admits the two "Special Characters". Read by the
    // simulation below so the readout stays truthful, but not offered as an edit: the pair
    // is contiguous and there is nothing useful to point it at.
    lo: 0x1FEDA0, hiTop: 0x1FEDAC, hiBot: 0x1FEDB4,
    WIDE: 0x53,                          // 0x53 = one past Emily (82), the last battle id
    STOCK_SET: [1, 2, 3, 29, 54, 63, 202, 203],
    // model id -> name needs the party id space, which lives in Editor/s3save.py. Restated
    // here because iso.js has no save engine to ask; web/tests/iso-avatar.mjs parses
    // PARTY_IDS out of s3save.py and fails if the two ever drift.
    PARTY_IDS: [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13,
      14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      26, 27, 28, 29, 30, 31, 32, 34, 35, 36, 40, 41,
      42, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
      55, 56, 57, 58, 59, 60, 61, 62, 63, 65, 66, 67,
      68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
      80, 81, 82,
    ],
    // Named ids with no roster slot, so the readout can label them (s3save.PARTY_EXTRA_NAMES).
    EXTRA: { 202: "Masked Luc", 203: "Grasslands Chris", 204: "Masked Kidd" },

    // ---- the scene softlock, and the one place it can be attacked -------------
    // Script actor handles are packed: bits 10-13 pick a namespace, the low 10 bits an
    // index (decoder at 0x17B5A40, 186 call sites). Two namespaces matter here:
    //
    //   0x1400        "the player"        -> 0x17B5CC8 -> FindActorByCharId(leaderByte, 1)
    //   0x400 | N     "the character N"   -> FindActorByCharId(N, 1)
    //
    // FindActorByCharId @ 0x17B59D0 walks the scene's actor records (ctx->0x58, stride
    // 0x40, character id at +0x06) and RETURNS NULL when nobody matches. So a Hugo-chapter
    // scene that addresses Hugo as `0x400|1` gets null the moment your avatar is anyone
    // else, and the beat that was going to make him speak has no actor. That is why the
    // hang lands exactly on the protagonist's line while ordinary NPC dialogue is fine —
    // dialogue never asks for a character who isn't there.
    //
    // The miss-exit is two instructions and the function keeps no stack frame, so it can
    // tail-jump to the player lookup instead of returning null: "an actor nobody can find
    // is you". That is as close as this gets to Koroku delivering Hugo's lines.
    //
    // The risk is stated in the UI rather than hidden: 0x17B5CC8 calls back into this same
    // function with the leader byte, so if a scene's actor table has no record for YOUR
    // leader, the fallback recurses forever. Two instructions is not enough room for a
    // guard — the exit can hold `j; nop` or `jr $ra; move`, but not a conditional with both
    // paths — so this ships as an opt-in experiment, not a fix.
    ACTORFB: {
      sites: [
        { off: 0x1FD238, stock: 0x03E00008, alt: 0x085ED732 },   // jr $ra   -> j 0x17B5CC8
        { off: 0x1FD23C, stock: 0x0000102D, alt: 0x00000000 },   // move v0,0 -> nop
      ],
      target: 0x17B5CC8,
    },

    // ---- which story content a leader gets -----------------------------------
    // The leader byte is also "whose story is this". Seven sites switch on it; six carry
    // the four protagonists (+ 0xCB) and route everything else to a default. The seventh,
    // at vaddr 0x177FEB4, is the wide one: it turns the leader into a per-team INDEX 0-7
    // that indexes the area's own town-data table, and it is the ONLY site that gives Luc,
    // Koroku, Sarah, Masked Luc and id 17 an index of their own.
    //
    // Its default path is the whole reason this is cheap. `s0` is zeroed on entry, the
    // default only calls the (stubbed) debug printf, and then falls into the same tail —
    // so an unrecognised leader silently resolves to **index 0, which is Hugo**. Blanking
    // one case immediate therefore hands that character Hugo's story content, with no
    // branch surgery and nothing else touched.
    //
    // That is what fixes the empty dialogue boxes: a town whose table has no entry for
    // index 4 (Luc) has one for index 0.
    STORY: {
      switchVa: 0x177FEB4,
      OFF: 0x7FFF,          // an id the leader byte can never hold, so the case never fires
      // off = the `addiu $v0,$zero,N` holding the compared id; idx = the team index it selects
      cases: [
        { off: 0x1C76DC, id: 1,    idx: 0, fixed: true },   // Hugo — the fallback itself
        { off: 0x1C76CC, id: 2,    idx: 1 },                // Chris
        { off: 0x1C76F0, id: 3,    idx: 2 },                // Geddoe
        { off: 0x1C7740, id: 0xCB, idx: 3 },                // Grasslands Chris
        { off: 0x1C7724, id: 0x3F, idx: 4 },                // Luc
        { off: 0x1C7738, id: 0xCA, idx: 4 },                // Masked Luc
        { off: 0x1C76F8, id: 0x11, idx: 5 },                // id 17
        { off: 0x1C770C, id: 0x42, idx: 6 },                // Sarah
        { off: 0x1C771C, id: 0x36, idx: 7 },                // Koroku
      ],
    },
  };

  // ---- what counts as "moving" for a random encounter -------------------------
  // Before the rate is even computed, the roll is gated on the PLAYER OBJECT's current
  // motion slot (`obj->+0x0E`) and object kind (`obj->+0x02`):
  //
  //   IsWalking(kind, slot) @ 0x16F3860 : kind==2 ? slot in [0x64,0x6F] : [2,0x0D] or [0x42,0x44]
  //   IsRunning(kind, slot) @ 0x16F38A8 : kind==2 ? slot in [0x70,0x72] : [0x0E,0x13] or [0x45,0x46]
  //
  //   walking -> rate = base ; running -> rate = base * (riding ? 150 : 120) / 100 ;
  //   neither -> rate = 0 and the roll is SKIPPED, silently.
  //
  // Two useful things fall out of that, and both are single instruction immediates.
  //
  // 1. Zeroing a range's length makes that test always fail, so "no encounters while
  //    walking" is a real, clean setting rather than a rate fudge — you still get battles
  //    when you run, so it reads as a QoL option, not as turning encounters off.
  //
  // 2. Koroku and Fubar are the only two playable models with no `run_start_L/R` or
  //    `run_stop_L/R` (checked against every model's clip set on disc: 76 of 78 have them).
  //    Their run cycle is the unsuffixed `run_start`/`run_loop`/`run_stop`, which live at
  //    slots 0x11A-0x11F in the animal block next to `naki_*` (a bark) and `sit_stop` —
  //    outside every band, so running as them never rolls. Both halves are confirmed in
  //    play (2026-08-31): as Koroku, stock builds trigger encounters when walking and never
  //    when running, and with the run test's SECOND range repointed at that block running
  //    triggers them too. The cost is named in the UI: that range currently holds the
  //    mounted fast-move slots, so trading it means no encounters while galloping (mounted
  //    *walking* still rolls, via IsWalking's own second range).
  //
  // Every site below is the 16-bit immediate half of one instruction; `opc` is the other
  // half and is checked before anything is offered, so a non-stock build is refused.
  const ENCMOVE = {
    walk: [
      { off: 0x13B06C, opc: 0x2C42, stock: 0x0C, what: "slots 2-0x0D" },
      { off: 0x13B078, opc: 0x2C42, stock: 0x03, what: "slots 0x42-0x44 (mounted walk)" },
      { off: 0x13B090, opc: 0x2C63, stock: 0x0C, what: "slots 0x64-0x6F (object kind 2)" },
    ],
    run: [
      { off: 0x13B0B4, opc: 0x2C42, stock: 0x06, what: "slots 0x0E-0x13" },
      { off: 0x13B0D8, opc: 0x2C63, stock: 0x03, what: "slots 0x70-0x72 (object kind 2)" },
    ],
    // The run test's second range, which is the one worth repointing.
    runAlt: {
      base: { off: 0x13B0BC, opc: 0x24A2 },     // addiu $v0,$a1,-N  (N stored negated)
      len:  { off: 0x13B0C0, opc: 0x2C42 },     // sltiu $v0,$v0,N
      modes: [
        { key: "stock",  base: 0x45,  len: 2, label: "mounted fast-movement (stock)", note: "slots 0x45-0x46 — rdfastrun_loop / rdfastwalk" },
        { key: "animal", base: 0x11A, len: 6, label: "animal run cycle (Fubar, Koroku) — confirmed", note: "slots 0x11A-0x11F — run_start / run_loop / run_stop. Confirmed in play: running as Koroku triggers encounters with this set. Costs the mounted fast-move slots, so no encounters while galloping." },
      ],
    },
  };

  // ---- how fast you walk and run (boot ELF, pure data) ------------------------
  // Field movement speed is a table, not code. Every field object is handed a walk speed
  // and a run speed when it is built (0x16F3E20, ISO 0x13B620) out of 14 records at ISO
  // 0x3B0BE0:
  //
  //     struct { u32 modelId; float walk; float run; float animRate; }   // 16 bytes
  //
  // and the record it reads is picked by a one-byte MOVEMENT CLASS in the character's own
  // list2 record at +0x78 (GetModelClass @ 0x16C7310 reads it; the model id -> list2 index
  // byte table at ISO 0x3B0FA8 is the same indirection GetCharaRecord uses, so the geometry
  // is the one MOUNT_SYSTEM_RESEARCH.md §11 already proved for the assigned horse at +0x66).
  //
  // Stock: walk is 2.0 for the ENTIRE cast; run is 6.0, 5.0 or 4.5 by class. That is the
  // mechanism behind "Chris is slow" — Hugo's class runs 6.0, Geddoe's 5.0, Chris's 4.5.
  // Mounts are ordinary field objects (Fubar, Bright, Ruby and Koroku are all class 0), so
  // mounted speed is the mount's own row rather than a separate system.
  //
  // The record's first field only matters in the per-model override list that
  // GetMoveSpeedRecord scans first — which points at this table's own last row, whose id is
  // 0, so it always terminates immediately and no override ships. We never touch the id
  // fields, so that stays true. See docs/MOVEMENT_SPEED_RESEARCH.md.
  const MOVESPD = {
    tbl: 0x3B0BE0, rows: 14, stride: 16,
    cols: [
      { key: "walk", off: 0x04, label: "Walk", hint: "units/sec", stock: 2 },
      { key: "run", off: 0x08, label: "Run", hint: "units/sec", stock: 6 },
      { key: "rate", off: 0x0C, label: "Time scale", hint: "\u00d71.0 = normal", stock: 1 },
    ],
    classOff: 0x78,          // u8, in the list2 record
    MAXCLASS: 13,            // the last row; classes 9-13 have no stock member
    MAX: 200,                // editor-side sanity clamp on a speed
    LEVEL: 6,                // "everyone runs at" target: the fastest stock run speed
  };

  const SETS = {
    table: 0x3DDAB8, count: 5, stride: 8,
    slots: ["Head", "Body", "Shield", "Accessory"],
    slotCats: [["Headgear"], ["Armor"], ["Shields"], ["Rings", "Gloves", "Misc Gear", "Footwear"]],
    counterSites: [0x244F8C, 0x2452F8],     // slti $v0,$v0,imm — Destiny bonus-counter chance
    healBias: 0x245DA8, healShift: 0x245DB4, // addiu $v0,$s1,(2^k)-1 ; sra $v0,$v0,k — Pale Moon heal
    potchChoices: [1, 2, 3, 4, 5, 8, 9, 16, 17],
    // ---- which set OWNS each effect (the comparison the code makes on the set number) ----
    // Two shapes. MASK sites are `andi $v0,$v0,m` — a set numbered n matches when (n & m).
    // EQ sites are `addiu $rX,$zero,n` feeding a branch — exact set number, so 6 disables.
    counterOwnerSites: [0x244F78, 0x2452E4],   // addiu $v0,$zero,n  (both must agree)
    healOwnerSite: 0x245D98,                   // addiu $s4,$zero,n
    squeakOwnerSite: 0x131354,                 // addiu $s1,$zero,n
    halveMaskSite: 0x246E28,                   // andi  $v0,$v0,m
    // $s4 is dual-use: the heal set number AND the divisor at 0x245E1C's `div $zero,$v0,$s4`
    // (the compiler's guard constant proves the intended divisor is 5). Changing the owner
    // therefore needs the divisor restored right before that div. The slot below holds a
    // DEAD store (`addiu $a0,$zero,0x64`; $a0 is next written, never read, and nothing
    // branches here — both verified), so it is safe to repurpose as the repair.
    healDivRepair: 0x245E1C, healDivWord: 0x24140005,   // addiu $s4,$zero,5
    OWNER_OFF: 6,                              // an unreachable set number = effect disabled
    meta: [
      { name: "Mole Set", bonus: "Squeaky footsteps when walking (not in battle)",
        guide: "Make squeaky noises when you walk (not in battle)." },
      { name: "Prosperity Set", bonus: "Potch won after battle ×3 per wearer (stacks)",
        guide: "Potch won after battle multiplied by 7." },
      { name: "Destiny Set", bonus: "Potch ×3 per wearer (stacks) + 30% counter chance if the wearer lacks the Counter Attack skill",
        guide: "Potch won after battle multiplied by 3." },
      { name: "Guardian Set", bonus: "Counter-related damage involving the wearer is halved (the code's `set & 4` check — Pale Moon matches it too)",
        guide: "Counter rate +50%." },
      { name: "Pale Moon Set", bonus: "Heal 25% of damage dealt after each standard attack",
        guide: "Heal 25% of damage dealt after each standard attack." },
    ],
  };
  // MIPS re-encoders for the three editable constants (little-endian words).
  const ADDU_S6_V0_S6 = (2 << 21) | (22 << 16) | (22 << 11) | 0x21;
  // ---- global random-encounter rate (boot ELF) --------------------------------
  // Every field encounter is one roll at ELF va 0x17023A8:
  //   rate = area_rate * MULT / 100 ; ... ; if (rand(100) < rate) -> battle
  // MULT is chosen by how you are moving, and the disc ships three values:
  //
  //   walking            x1.00   — no multiply at all: `move $s5,$s1` then `b` past the block
  //   running            x1.20   — addiu $v0,$zero,0x78   (0x149C60)
  //   running mounted    x1.50   — addiu $v0,$zero,0x96   (0x149C5C), chosen by the ride flag
  //
  // Mounted *walking* takes the walk path, so the 1.5 is specifically a gallop. Anything
  // that is neither walking nor running (see ENCMOVE) skips the roll entirely.
  //
  // Walking has no immediate of its own to edit, so to make it configurable we hand it
  // one: site 0 becomes `addiu $v0,$zero,N` and site 1 becomes a branch into the shared
  // MULT/100 block instead of past it. That is behaviour-preserving — at N=100 the block
  // computes s1*100/100 == s1 — and the stock triple (100/120/150) writes the original
  // four words back byte-for-byte, so returning to it stages nothing.
  const ENC = {
    // walk multiplier / walk branch / mounted-run multiplier / run multiplier
    sites: [0x149C3C, 0x149C40, 0x149C5C, 0x149C60],
    labels: ["walking multiplier", "walking branch", "mounted running multiplier", "running multiplier"],
    stock: [0x0220A82D, 0x10000012, 0x24020096, 0x24020078],
    STOCK_MULT: { walk: 100, run: 120, ride: 150 },
    brJoin: 0x10000008,          // b 0x1702464 — the walk path joins the scale block
    addiuV0: 0x24020000,         // addiu $v0,$zero,imm
    max: 1000,
  };
  const encClampMult = (v) => Math.max(0, Math.min(ENC.max, Math.round(+v || 0)));
  // The four words for an arbitrary {walk, run, ride} triple. Walking keeps its stock
  // move + branch whenever its multiplier is x1.00, so changing only the run or mounted
  // number stages two words instead of four — and the stock triple always writes the
  // original four back byte-for-byte.
  const encMultWords = (m) => {
    const walk = encClampMult(m.walk), run = encClampMult(m.run), ride = encClampMult(m.ride);
    const s = ENC.STOCK_MULT;
    const head = walk === s.walk ? [ENC.stock[0], ENC.stock[1]]
      : [(ENC.addiuV0 | walk) >>> 0, ENC.brJoin];
    return head.concat([(ENC.addiuV0 | ride) >>> 0, (ENC.addiuV0 | run) >>> 0]);
  };
  // The triple currently in the buffer, or null if these aren't words this editor writes.
  const decodeEncMults = (w) => {
    const isImm = (x) => ((x & 0xFFFF0000) >>> 0) === ENC.addiuV0;
    if (!isImm(w[2]) || !isImm(w[3])) return null;
    const stockWalk = w[0] === ENC.stock[0] && w[1] === ENC.stock[1];
    if (!stockWalk && !(w[1] === ENC.brJoin && isImm(w[0]))) return null;
    return { walk: stockWalk ? ENC.STOCK_MULT.walk : w[0] & 0xFFFF, ride: w[2] & 0xFFFF, run: w[3] & 0xFFFF };
  };
  // The one-percentage view: scale all three from their stock values at once.
  const encWords = (pct) => {
    const p = Math.round(pct);
    if (!(p >= 0 && p <= ENC.max)) return null;
    if (p === 100) return ENC.stock.slice();
    const sc = (b) => Math.floor((b * p + 50) / 100);
    const s = ENC.STOCK_MULT;
    return encMultWords({ walk: sc(s.walk), run: sc(s.run), ride: sc(s.ride) });
  };
  const decodeEnc = (w) => {
    if (ENC.stock.every((x, i) => x === w[i])) return 100;
    if (w[1] !== ENC.brJoin || (w[0] & 0xFFFF0000) >>> 0 !== ENC.addiuV0) return null;
    const p = w[0] & 0xFFFF, enc = encWords(p);
    return enc && enc.every((x, i) => x === w[i]) ? p : null;
  };

  const mipsSll = (rd, rt, sa) => (rt << 16) | (rd << 11) | (sa << 6);
  function potchWords(m) {      // -> [sll word, addu word] or null if unsupported
    if (m === 1) return [0, 0];
    for (let k = 1; k <= 4; k++) {
      if (m === (1 << k)) return [mipsSll(22, 22, k), 0];            // x2^k
      if (m === (1 << k) + 1) return [mipsSll(2, 22, k), ADDU_S6_V0_S6]; // x2^k+1
    }
    return null;
  }
  function decodePotch(w1, w2) {
    for (const m of SETS.potchChoices) { const w = potchWords(m); if (w[0] === w1 && w[1] === w2) return m; }
    return null;
  }
  const healWords = (k) => [(9 << 26) | (17 << 21) | (2 << 16) | ((1 << k) - 1),   // addiu bias
    (2 << 16) | (2 << 11) | (k << 6) | 3];                                        // sra k
  const counterWord = (p) => ((0x0A << 26) | (2 << 21) | (2 << 16) | (p & 0x7FFF)) >>> 0;
  // `addiu $rt,$zero,imm` — rewrite just the immediate of an existing instruction word
  const withImm = (word, imm) => (((word >>> 0) & 0xFFFF0000) | (imm & 0xFFFF)) >>> 0;
  // Set numbers are 1..5, so an `andi` mask selects a UNION of three fixed groups:
  // bit0 → sets 1,3,5 · bit1 → sets 2,3 · bit2 → sets 4,5. Only these 8 subsets exist.
  const setsForMask = (m) => [1, 2, 3, 4, 5].filter((n) => (n & m) !== 0);
  const maskSetNames = (m) => {
    const s = setsForMask(m);
    return s.length ? s.map((n) => SETS.meta[n - 1].name.replace(/ Set$/, "")).join(" + ") : "no set (off)";
  };

  // ---- aux windows: tiny out-of-block ranges we also edit ---------------------
  // The potch bonus lives in a battle-results overlay ~1 GB into the disc (two identical
  // copies) — far outside the ELF block. Each 16-byte window holds the whole sequence:
  //   +0 andi $v0,$v0,mask   (which sets earn potch)   +4 beqz
  //   +8 sll / +12 addu      (the multiplier)
  // Read once on ISO load, then ride along every save/export path. No undo integration:
  // the Sets view gives each aux field its own restore control instead.
  const AUX_WINDOWS = [0x3F3E6994, 0x3F3EF194];   // the potch overlay pair (16 bytes each)
  const AUX_LEN = 16;
  const AUX_MASK = 0, AUX_MULT = 8;        // offsets within a potch window
  // AUX holds three kinds of window, told apart by `tag`:
  //   "potch" — the two fixed 16-byte overlay windows (Sets view). Read when the disc opens.
  //   "enemy" — coalesced spans covering enemy and war stat records, reward blocks and spawn
  //             zones, from Editor/s3_enemy_packs.json + s3_war_units.json (Enemies/War views)
  //   "room"  — the per-area encounter-rate tables, from s3_rooms.json (Encounter view)
  // The last two are NOT read on open — see loadDiscTables(). Until they are, inAux() and
  // auxWin() do not know their offsets, which is why every path that resolves an out-of-block
  // offset has to load them first.
  let AUX = [];       // [{off, len, tag, buf, orig}] — empty until an ISO loads
  const auxHasPotch = () => AUX.some((w) => w.tag === "potch");
  const inAux = (off, n) => AUX.some((w) => off >= w.off && off + n <= w.off + w.len);
  function auxWin(off, n) { return AUX.find((w) => off >= w.off && off + n <= w.off + w.len) || null; }
  function auxR32(off) { const w = auxWin(off, 4); return w ? new DataView(w.buf.buffer).getUint32(off - w.off, true) : null; }
  function auxO32(off) { const w = auxWin(off, 4); return w ? new DataView(w.orig.buffer).getUint32(off - w.off, true) : null; }
  function auxW32(off, v) { const w = auxWin(off, 4); if (w) new DataView(w.buf.buffer).setUint32(off - w.off, v >>> 0, true); }
  function auxR8(off) { const w = auxWin(off, 1); return w ? w.buf[off - w.off] : null; }
  function auxO8(off) { const w = auxWin(off, 1); return w ? w.orig[off - w.off] : null; }
  function auxW8(off, v) { const w = auxWin(off, 1); if (w) w.buf[off - w.off] = v & 0xFF; }
  function auxR16(off) { const w = auxWin(off, 2); return w ? new DataView(w.buf.buffer).getUint16(off - w.off, true) : null; }
  function auxO16(off) { const w = auxWin(off, 2); return w ? new DataView(w.orig.buffer).getUint16(off - w.off, true) : null; }
  function auxW16(off, v) { const w = auxWin(off, 2); if (w) new DataView(w.buf.buffer).setUint16(off - w.off, v & 0xFFFF, true); }
  function auxWriteBytes(off, bytes) { const w = auxWin(off, bytes.length); if (w) w.buf.set(bytes, off - w.off); }
  function auxRuns() {          // dirty runs across all windows, ABSOLUTE offsets
    const out = [];
    for (const w of AUX) {
      let i = 0;
      while (i < w.len) {
        if (w.buf[i] !== w.orig[i]) {
          const s = i; while (i < w.len && w.buf[i] !== w.orig[i]) i++;
          out.push({ off: w.off + s, old: w.orig.slice(s, i), bytes: w.buf.slice(s, i) });
        } else i++;
      }
    }
    return out;
  }
  const auxDirty = () => auxRuns().length > 0;
  const auxRevertAll = () => AUX.forEach((w) => w.buf.set(w.orig));
  // Potch-only per-field variants: the same relative span across the two potch windows
  // (identical code copies), so one control's ↺ can't revert another's edit.
  const auxDirtyAt = (rel, len) => AUX.some((w) => {
    if (w.tag !== "potch") return false;
    for (let i = rel; i < rel + len; i++) if (w.buf[i] !== w.orig[i]) return true;
    return false;
  });
  const auxRevertAt = (rel, len) => AUX.forEach((w) => { if (w.tag === "potch") w.buf.set(w.orig.subarray(rel, rel + len), rel); });
  const auxMarkSaved = () => AUX.forEach((w) => { w.orig = w.buf.slice(); });
  // Multi-offset field helpers for enemy edits: one logical field lives at the same
  // relative spot in every pack copy; write all, dirty/revert consider all.
  function eRead(offs, w) { return w === 1 ? auxR8(offs[0]) : w === 2 ? auxR16(offs[0]) : auxR32(offs[0]); }
  function eOrig(offs, w) { return w === 1 ? auxO8(offs[0]) : w === 2 ? auxO16(offs[0]) : auxO32(offs[0]); }
  function eWrite(offs, w, v) { for (const o of offs) (w === 1 ? auxW8(o, v) : w === 2 ? auxW16(o, v) : auxW32(o, v)); }
  function eDirty(offs, w) {
    return offs.some((o) => { const win = auxWin(o, w); if (!win) return false;
      for (let i = 0; i < w; i++) if (win.buf[o - win.off + i] !== win.orig[o - win.off + i]) return true;
      return false; });
  }
  function eRevert(offs, w) {
    for (const o of offs) { const win = auxWin(o, w); if (win) win.buf.set(win.orig.subarray(o - win.off, o - win.off + w), o - win.off); }
  }

  // Known table starts, sorted — used to stop a record write from spilling into the next
  // table (list1's last record physically abuts list3; see nextBoundary/drawRecords).
  const BOUNDARIES = [3970620, 4054224, 4061704, 4068152, 4078716, 4089904, 4093152, 4100560, 4105552, 4113056, 4115344, 4136544, 4136564]
    .sort((a, b) => a - b);
  const nextBoundary = (off) => { for (const b of BOUNDARIES) if (b > off) return b; return ELF_END; };

  // ---- Hard Mode / bulk balance (mirror s3editor apply_hard_mode) ------------
  const GROWTH_OFFS = { PWR: 4, SKL: 5, MAG: 6, REP: 7, MDF: 8, SPD: 9, LUK: 10, HP: 11 };
  const HM_STATS = ["HP", "PWR", "MAG", "SKL", "MDF", "SPD", "REP", "LUK"];
  const HM_PRESETS = {
    tougher: { label: "Tougher", desc: "A gentle nerf — the party grows a bit slower.",
      growth: { HP: 0.8, PWR: 0.85, MAG: 0.85, SKL: 0.9, MDF: 0.9, SPD: 0.95, REP: 1, LUK: 1 }, spell: 0.9, unite: 0.9 },
    hard: { label: "Hard", desc: "Noticeably weaker party. Fights take real thought.",
      growth: { HP: 0.65, PWR: 0.7, MAG: 0.7, SKL: 0.8, MDF: 0.8, SPD: 0.9, REP: 0.9, LUK: 1 }, spell: 0.75, unite: 0.75 },
    brutal: { label: "Brutal", desc: "Punishing. Low HP, weak hits — every battle is a threat.",
      growth: { HP: 0.5, PWR: 0.55, MAG: 0.55, SKL: 0.7, MDF: 0.7, SPD: 0.85, REP: 0.85, LUK: 1 }, spell: 0.6, unite: 0.6 },
  };

  // The spell "element" byte is really a magic FAMILY, and 1..5 are proven outright: every one of
  // those 32 spells opens its description with the matching "<X> MGC." prefix (Fire 8/8, Water 6/6,
  // Wind 6/6, Earth 6/6, Lightning 6/6). 6 is the Pale Gate rune's four spells. 7..10 carry no
  // "MGC." prefix because they aren't elemental at all — each is exactly one rune's spell set:
  //   7  Sword of Rage / Thunder / Cyclone + the Fire / Thunder / Wind Amulets   (6 spells)
  //   8  Song of Skylark / Serenity / Madness / a Hero — the Jongleur rune       (4 spells)
  //   9  Battle Oath / Great Blessing / Battlefield — the Shield rune            (4 spells)
  //   10 Ready! / Set! / Go! — the Blinking rune                                (3 spells)
  // Before these were named the Spells tab rendered a bare "undefined" for 17 of the 94 records,
  // so unknown values now fall back to a readable label instead of leaking undefined into the UI.
  const ELEMENTS = { 0: "None", 1: "Fire", 2: "Water", 3: "Wind", 4: "Earth", 5: "Lightning", 6: "Pale (Dark)",
    7: "Enhance (Sword/Amulet)", 8: "Song (Jongleur)", 9: "Blessing (Shield)", 10: "Blinking" };
  const elemName = (v) => ELEMENTS[v] || `Family ${v}`;
  const AREA_BIT = 0x8000;                  // flags14 bit15 = area-of-effect
  const F18_BITS = { 1: "poison", 3: "instant-death", 4: "unbalance", 9: "teleport/chant",
    10: "sleep", 13: "silence/berserk", 14: "mgc-boost", 15: "mgc-shield", 19: "mgc-immune-once",
    21: "buff-pdf/mdf", 22: "sword-fire", 23: "sword-lightning", 24: "sword-wind",
    25: "resist-fire", 26: "resist-lightning", 27: "resist-wind" };
  // Same bits in plain language, for the checkbox editor. flags18 is a bit SET, not an enum —
  // the full heal/restore spells carry 0x1DE7 (restore HP + clear every status at once) — so the
  // editor has to be able to author and preserve combinations. The mask is shown beside each
  // label for anyone cross-referencing Editor/Suikoden3_ISO_offsets.md.
  const F18_TEXT = { 1: "inflicts poison", 3: "instant death", 4: "unbalances the target",
    9: "teleport / chant speed", 10: "puts the target to sleep",
    13: "silence / berserk", 14: "raises MGC", 15: "magic shield (one hit)",
    19: "immune to magic once", 21: "raises PDF/MDF", 22: "adds fire damage to physical attacks",
    23: "adds lightning damage to physical attacks", 24: "adds wind damage to physical attacks",
    25: "resists fire", 26: "resists lightning", 27: "resists wind" };
  // Sword-enhance and elemental-resist bits, in the order the runes that grant them appear.
  // Used to explain a rune's effect in the Runes browser without the reader knowing bit numbers.
  const F18_ORDER = Object.keys(F18_BITS).map(Number).sort((a, b) => a - b);
  // What the engine fixes and data cannot move: strength and duration. Stated up front so nobody
  // goes looking for a "sleep lasts N turns" field — a full search found only description and
  // debug strings (see the offsets doc, "Status strength/duration").
  const F18_NOTE = "Which element or status an effect applies is data and editable here. " +
    "How much it is WORTH is a code constant, editable under \u201cStatus effect strength\u201d on the " +
    "Spells tab \u2014 but globally, not per rune. How long it lasts still isn\u2019t reachable.";
  const decodeF18Plain = (v) => {
    if (!v) return "no status effect";
    const out = [];
    for (let b = 0; b < 32; b++) if ((v >>> b) & 1) out.push(F18_TEXT[b] || F18_BITS[b] || `unknown bit ${b}`);
    return out.length > 6 ? "restores HP and clears all status" : out.join(", ");
  };
  const RANK_OPTS = [[0, "— (not learned)"], [1, "E"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [7, "A+"], [8, "S"]];
  const MAX_OPTS = [[0, "Can't get"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [1, "A+"], [7, "S"]];
  const MAX_BY_GRADE = {}; MAX_OPTS.forEach(([v, l]) => (MAX_BY_GRADE[l] = v));   // "B+"->5, "A+"->1, "S"->7
  // spell/unite target byte (flags14 bits 8..15). AOE is a separate bit (0x8000).
  // The byte is a bit set, not an enum: 0x01 = ally side, 0x02 = foe side (0x03 = both),
  // 0x04 = centred on the CASTER (no aiming step), 0x08 = aim at one unit, 0x10 = line/front,
  // 0x40 = pick ONE ally pair instead of the whole side. So 0x0A = one foe, 0x09 = one ally
  // (Healing Wind / Mother Ocean: "Restores ... of 1 ally"), 0x05 = the caster alone (the
  // Sword/Amulet runes: "Enhances chanter's ..."), 0x41 = one ally pair (Kindness Drops /
  // Vengeful Child = 0x41 vs Clay Guardian / Canopy Defense = 0x01 — same side, pair bit only).
  // 0x06 = 0x04|0x02: an area of foes centred on the caster, with nothing to aim at. Every
  // spell carrying it is a self-centred burst — War Horse (Cecile), Watari Special ("Explosion.
  // DMGx1.5 to foes in area") and Goss (the axe swing) — and their descriptions say "to foes in
  // area" where the aimed area spells at 0x82 all say "to TARGET+foes in area".
  // Three more bytes the disc actually uses were missing from this list, so 15 of the 94 spells
  // showed as "custom 0xNN" and could only be changed by picking a different targeting mode
  // altogether. All three are read straight off the bit meanings above and confirmed by every
  // description that carries them — no guesswork, and the counts are exhaustive for a pristine
  // SLUS-20387 (the nine bytes below are the complete set in use across all 94 spells):
  //   0x05 = 0x04|0x01  caster-centred + ally side -> the CHANTER ALONE. 7 spells, and all seven
  //          say so: "Enhances chanter's direct ATK with fire MGC.", "Raises chanter's fire
  //          resistance." (x6 Sword/Amulet) plus Wrath, a self-heal ("Heals half of lost HP").
  //   0x09 = 0x08|0x01  aim one unit + ally side -> ONE ALLY. 2 spells, both explicit: Healing
  //          Wind "Restores 300HP+status of 1 ally", Mother Ocean "Restore 1 ally's HP+status".
  //   0x12 = 0x10|0x02  line/front + foe side -> a LINE of foes through the target. 6 spells, all
  //          six say it: "to target+foes in front" (Thunder Runner, Sickle-Weasel, Unicorn),
  //          "to target+foes in line" (Shining Wind, Shining Wing), "target+LOS foes beyond"
  //          (Furious Blow) — and each carries a non-zero radius, which the single-target 0x0A
  //          spells never do.
  const TARGET_OPTS = [[0x0A, "Single target"], [0x02, "All foes"], [0x03, "All foes + allies"],
    [0x01, "All allies"], [0x09, "Single ally"], [0x41, "Single ally (pair)"],
    [0x05, "Caster only (chanter)"], [0x12, "Line of foes (target + behind)"],
    [0x06, "Foes around caster"]];
  // Every target byte a pristine disc uses. The Spells tab must never show "custom" on a stock
  // ISO; a regression here means a byte lost its name again (see tests/validate.mjs).
  const TARGET_BYTES_IN_USE = [0x01, 0x02, 0x03, 0x05, 0x06, 0x09, 0x0A, 0x12, 0x41];

  // gear effect-slot semantics (mirror s3patch.py)
  const GEAR_EFFECT_TYPES = { 0: "(none)", 1: "HP regen/turn", 2: "Stat bonus", 3: "Accuracy +%",
    4: "type 4 (unverified)", 5: "Grant skill", 6: "Status Protect", 7: "Elemental Resist",
    8: "Evade single-target ATK", 9: "Weak vs thrust / mobility", 10: "Lowers ATK effect %",
    11: "Chance to reflect MGC", 12: "Counter-attack rate +%" };
  const GEAR_STAT_SELECTOR = { 0: "PWR", 1: "SKL", 2: "MAG", 3: "REP", 4: "PDF", 5: "MDF", 6: "SPD", 7: "LUK" };
  const GEAR_TYPE_PARAM = { 2: "stat", 5: "skill" };   // type -> what `param` means

  // Rune -> ordered spell names it grants (resolved to table indices by name at runtime).
  const RUNE_SPELLS = {
    fire: ["Flaming Arrows", "Dancing Flames", "Blazing Wall", "Explosion"],
    rage: ["Dancing Flames", "Blazing Wall", "Explosion", "Final Flame"],
    truefire: ["Blazing Wall", "Explosion", "Final Flame", "Hellfire"],
    lightning: ["Thunder Runner", "Berserk Blow", "Soaring Bolt", "Furious Blow"],
    thunder: ["Berserk Blow", "Soaring Bolt", "Furious Blow", "Thunder Storm"],
    truelightning: ["Soaring Bolt", "Furious Blow", "Thunder Storm", "Hammer of Raijin"],
    wind: ["Wind of Sleep", "Healing Wind", "The Shredding", "Funeral Wind"],
    cyclone: ["Healing Wind", "The Shredding", "Funeral Wind", "Shining Wind"],
    truewind: ["The Shredding", "Funeral Wind", "Shining Wind", "Eternal Wind"],
    water: ["Kindness Drops", "Breath of Ice", "Kindness Rain", "Silent Lake"],
    flowing: ["Breath of Ice", "Kindness Rain", "Silent Lake", "Mother Ocean"],
    truewater: ["Kindness Rain", "Silent Lake", "Mother Ocean", "Heavenly Drops"],
    earth: ["Clay Guardian", "Vengeful Child", "Guardian Earth", "Earthquake"],
    motherearth: ["Vengeful Child", "Guardian Earth", "Earthquake", "Canopy Defense"],
    trueearth: ["Guardian Earth", "Earthquake", "Canopy Defense", "Land of Eternity"],
    shield: ["Battle Oath", "Great Blessing", "Battlefield"],
    blinking: ["Ready!", "Set!", "Go!"],
    jongleur: ["Song of Skylark", "Song of Serenity", "Song of Madness", "Song of a Hero"],
    palegate: ["Open Gate", "Royal Passage", "Pale Palace", "Empty World"],
    swordofrage: ["Sword of Rage", "Fire Amulet"],
    swordofthunder: ["Sword of Thunder", "Thunder Amulet"],
    swordofcyclone: ["Sword of Cyclone", "Wind Amulet"],
  };

  // ---- field schemas for the character/growth/support/weapon record tables ----
  // [label, offsetInRecord, widthBytes, kind]  (kind: item | skill | rank | num)
  const LIST1_FIELDS = [
    ["Unknown (u16 @+0)", 0, 2, "num"], ["Weapon growth class", 9, 1, "num"],
    ["Skill 1 (id)", 12, 1, "skill"], ["Skill 1 rank", 13, 1, "rank"],
    ["Skill 2 (id)", 14, 1, "skill"], ["Skill 2 rank", 15, 1, "rank"],
    ["Skill 3 (id)", 16, 1, "skill"], ["Skill 3 rank", 17, 1, "rank"],
    ["Skill 4 (id)", 18, 1, "skill"], ["Skill 4 rank", 19, 1, "rank"],
    ["Skill 5 (id)", 20, 1, "skill"], ["Skill 5 rank", 21, 1, "rank"],
    ["Skill 6 (id)", 22, 1, "skill"], ["Skill 6 rank", 23, 1, "rank"],
    // Rune slots are Head/Right/Left (VERIFIED vs suikosource + save editor), not Left/Right/Head:
    // +64=Head, +72=Right, +80=Left. The exe's write-order label swapped Head and Left. See issue #2.
    ["Rune Head", 64, 2, "item"], ["Rune Right hand", 72, 2, "item"], ["Rune Left hand", 80, 2, "item"],
    ["Helmet", 88, 2, "item"], ["Armor", 96, 2, "item"], ["Shield", 104, 2, "item"],
    ["Other item 1", 112, 2, "item"], ["Other item 1 amount", 114, 1, "num"],
    ["Other item 2", 120, 2, "item"], ["Other item 2 amount", 122, 1, "num"],
    ["Other item 3", 128, 2, "item"], ["Other item 3 amount", 130, 1, "num"],
  ];
  // Growth-rate byte<->stat mapping VERIFIED by correlation vs suikosource statgrowth across
  // the roster: PWR/SKL/MAG/REP at +4..+7, MDF/SPD/LUK at +9..+11, HP at +0 (the exe's own
  // write-set {+0,+4,+5,+6,+7,+9,+10,+11}). Bytes +1..+3 are always 0 (padding) and +8 is a
  // sparse non-growth field — the old "Head/RH/LH Rune Level" fields at +0/+1/+2 were a
  // misread (+0 is HP growth; +1/+2 are padding). See github issue #2.
  const LIST2_GROWTH = [
    ["PWR growth", 4, 1, "num"], ["SKL growth", 5, 1, "num"], ["MAG growth", 6, 1, "num"], ["REP growth", 7, 1, "num"],
    ["MDF growth", 9, 1, "num"], ["SPD growth", 10, 1, "num"], ["LUK growth", 11, 1, "num"], ["HP growth", 0, 1, "num"],
  ];
  const LIST2_FIXED = [
    ["Fixed Skill 1 (id)", 80, 1, "skill"], ["Skill 1 level learned", 81, 1, "num"],
    ["Fixed Skill 2 (id)", 82, 1, "skill"], ["Skill 2 level learned", 83, 1, "num"],
    ["Fixed Skill 3 (id)", 84, 1, "skill"], ["Skill 3 level learned", 85, 1, "num"],
    ["Fixed Skill 4 (id)", 86, 1, "skill"], ["Skill 4 level learned", 87, 1, "num"],
    ["Fixed Skill 5 (id)", 88, 1, "skill"], ["Skill 5 level learned", 89, 1, "num"],
    ["Fixed Skill 6 (id)", 90, 1, "skill"], ["Skill 6 level learned", 91, 1, "num"],
    ["Fixed Skill 7 (id)", 92, 1, "skill"], ["Skill 7 level learned", 93, 1, "num"],
    ["Fixed Skill 8 (id)", 94, 1, "skill"], ["Skill 8 level learned", 95, 1, "num"],
    ["Number of Free Skills", 96, 1, "num"], ["Starting level", 100, 1, "num"], ["Starting level relative (0/1)", 101, 1, "num"],
  ];
  const LIST2_SKILLMAX_START = 16;          // 43 skills (id 0x01..0x2B) at +16..+58 (VERIFIED: 90% of known caps match here vs ~12% at +13). See issue #2.
  const LIST3_FIELDS = Array.from({ length: 8 }, (_, i) => [`Support skill ${i + 1} (id)`, i, 1, "skill"]);
  const LIST4_FIELDS = Array.from({ length: 16 }, (_, i) => [`ATK Lv${i + 1}`, i, 1, "num"]);

  // ---- environment / capability ---------------------------------------------
  const SUPPORTS_FS = typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
  // Streaming "save patched ISO" fallback (Android/Firefox/Safari — no File System Access).
  // We can't overwrite a 4 GB file in place there, but we CAN read it in chunks and stream a
  // patched copy to the device via our own service worker. Needs transferable ReadableStreams
  // (to hand the stream to the SW). Everything stays local — nothing is uploaded.
  const CAN_TRANSFER_STREAM = (() => {
    try { const rs = new ReadableStream(); new MessageChannel().port1.postMessage(rs, [rs]); return true; }
    catch (e) { return false; }
  })();
  const CAN_STREAM_SAVE = typeof navigator !== "undefined" && "serviceWorker" in navigator && CAN_TRANSFER_STREAM;

  // ---- state -----------------------------------------------------------------
  let isoHandle = null, isoName = "", isoFile = null;   // isoFile: the source File (for streaming)
  let RENAMES = {};   // { "Hugo": "Rex", ... } staged character renames (applied disc-wide on streaming save)
  let EPACKS = [], EPACKS_META = null, EPACKS_SKIPPED = 0;   // loaded enemy packs (Enemies view)
  let ROOMS = [], ROOMS_SKIPPED = 0;        // per-area room tables (Encounter view)
  let WPACKS_SKIPPED = 0;                                    // war packs unavailable on this disc (War view)
  const EREG = {};    // enemy-field review registry: key -> {group,label,offs,w,fmt}
  let BUF = null, DV = null;                // live editable block (Uint8Array + DataView)
  let ORIG = null, ODV = null;              // pristine snapshot for diffing/undo
  let REF = null;                           // { items:{id:name}, cats:{id:cat}, idesc:{id:desc}, skills:{id:name}, names:{...}, shops:{...} }
  let VIEW = "chars", SEARCH = "";
  let spDescOn = true, unDescOn = true, gearDescOn = true, foodDescOn = true;   // "also rewrite description" toggles
  let spdQuickRec = null;                   // Movement tab: character selected in the quick-set card
  let spdQuickMsg = null;                   // ...and the result line from its last apply, {rec, msg, kind}
  let mntAllRiders = false;                 // Mounts tab: also offer riders with no mounted-battle
                                            // bank (they pair, then keep their normal pose)
  let spSplitOpen = false, spReskinOpen = false;   // Spells-tab tool cards: collapsed until asked for,
                                                   // and kept open across the drawView() an Apply triggers
  let gearCache = null;                     // {itemId: absStatsOffset}
  let gearAlias = {};                       // renamed gear: newName -> itemId. scanGear anchors a
                                            // record by its on-disc name, so a rename would hide it
                                            // from the next rescan without this.
  const FIELD_REG = {};                     // absOff -> {group,label,off:absOff,width,kind}
  const dec = new TextDecoder("latin1");

  // ---- shared helpers from app.js (same global script scope) -----------------
  const q = (s, r = document) => (r || document).querySelector(s);
  const qa = (s, r = document) => Array.from((r || document).querySelectorAll(s));
  const esc2 = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w, "0");

  // ---- block read/write (all offsets are ABSOLUTE ISO offsets) ---------------
  const inBlk = (off, n) => off >= ELF_BASE && off + n <= ELF_END;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v || 0)));
  function r8(o) { return BUF[o - ELF_BASE]; }
  function r16(o) { return DV.getUint16(o - ELF_BASE, true); }
  function r32(o) { return DV.getUint32(o - ELF_BASE, true); }
  function o8(o) { return ORIG[o - ELF_BASE]; }
  function o16(o) { return ODV.getUint16(o - ELF_BASE, true); }
  function o32(o) { return ODV.getUint32(o - ELF_BASE, true); }
  function readW(o, w) { return w === 1 ? r8(o) : w === 2 ? r16(o) : r32(o); }
  function origW(o, w) { return w === 1 ? o8(o) : w === 2 ? o16(o) : o32(o); }
  // IEEE-754 floats (movement speeds). Writes go through writeW so undo, dirty state and
  // the review list all keep working without a second code path.
  const F32 = new DataView(new ArrayBuffer(4));
  function rF32(o) { return DV.getFloat32(o - ELF_BASE, true); }
  function oF32(o) { return ODV.getFloat32(o - ELF_BASE, true); }
  function writeF32(o, v) { F32.setFloat32(0, v, true); writeW(o, 4, F32.getUint32(0, true)); }
  const f32Of = (u32) => { F32.setUint32(0, u32 >>> 0, true); return F32.getFloat32(0, true); };
  function writeW(o, w, v) {
    if (!inBlk(o, w)) return;
    const rel = o - ELF_BASE;
    for (let i = 0; i < w; i++) recByte(rel + i);          // undo: capture before-image
    if (w === 1) BUF[rel] = v & 0xFF;
    else if (w === 2) DV.setUint16(rel, v & 0xFFFF, true);
    else DV.setUint32(rel, v >>> 0, true);
  }
  // ---- undo / redo -----------------------------------------------------------
  // Every edit funnels through writeW/writeBytes; we record each byte's before-image and
  // auto-commit the batch on the next microtask, so one user action (a field change, a preset,
  // a recipe import) becomes one undo step — no per-call-site wrapping needed.
  let UNDO = [], REDO = [], REC = null;
  function recByte(rel) {
    if (REC === null) { REC = new Map(); queueMicrotask(commitEdit); }
    if (!REC.has(rel)) REC.set(rel, BUF[rel]);
  }
  function commitEdit() {
    const rec = REC; REC = null;
    if (!rec) return;
    const entries = [];
    rec.forEach((before, rel) => { if (before !== BUF[rel]) entries.push({ rel, before, after: BUF[rel] }); });
    if (!entries.length) return;
    dropDescCaches();                                      // staged bytes may be a name/description
    UNDO.push(entries); if (UNDO.length > 200) UNDO.shift();
    REDO.length = 0; updateUndoUI();
  }
  function undo() {
    if (!UNDO.length) return;
    const e = UNDO.pop(); e.forEach((c) => { BUF[c.rel] = c.before; }); REDO.push(e);
    dropDescCaches(); updateUndoUI(); drawView();
  }
  function redo() {
    if (!REDO.length) return;
    const e = REDO.pop(); e.forEach((c) => { BUF[c.rel] = c.after; }); UNDO.push(e);
    dropDescCaches(); updateUndoUI(); drawView();
  }
  function resetUndo() { UNDO = []; REDO = []; REC = null; updateUndoUI(); }
  function updateUndoUI() {
    const u = q("#isoUndoBtn"), r = q("#isoRedoBtn");
    if (u) u.disabled = !UNDO.length;
    if (r) r.disabled = !REDO.length;
  }
  function strAt(vaddr) {
    const rel = vaddr - ELF_VADDR;
    if (rel < 0 || rel >= BUF.length) return "";
    let e = BUF.indexOf(0, rel); if (e < 0) e = Math.min(rel + 48, BUF.length);
    return dec.decode(BUF.subarray(rel, e));
  }
  const vaOff = (v) => v - ELF_VADDR + ELF_BASE;                 // vaddr -> absolute file offset
  const offVa = (o) => o - ELF_BASE + ELF_VADDR;                 // and back
  const latin1Enc = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o[i] = c < 256 ? c : 63; } return o; };
  function writeBytes(off, bytes) { for (let i = 0; i < bytes.length; i++) if (inBlk(off + i, 1)) { recByte(off - ELF_BASE + i); BUF[off - ELF_BASE + i] = bytes[i]; } }
  // decode a null-terminated string from a given block copy (BUF or ORIG), bounded by maxlen
  function strFrom(arr, off, maxlen) {
    const rel = off - ELF_BASE; if (rel < 0 || rel >= arr.length) return "";
    let e = arr.indexOf(0, rel); if (e < 0 || e > rel + maxlen) e = rel + maxlen;
    return dec.decode(arr.subarray(rel, e));
  }
  // original on-disk slot length for a description pointer (the hard cap for edits)
  function origSlotLen(dptr) {
    const rel = vaOff(dptr) - ELF_BASE; if (rel < 0 || rel >= ORIG.length) return 0;
    let e = ORIG.indexOf(0, rel); if (e < 0) e = rel; return e - rel;
  }
  // ---- descriptions stored twice ---------------------------------------------
  // 27 descriptions on this disc live at TWO addresses, each pointed at by a different table:
  // the 20 attack runes (RUNE_TBL's desc + the spell record of the attack the rune grants) and
  // the 7 magic scrolls (the item's desc + the spell the scroll casts). Editing one copy left
  // the other stale — issue #11, where a Kite rune description edit never showed in game. The
  // game's rune menu resolves an item description through getDesc (VA 0x16DBE48) -> itemRecord
  // (VA 0x16DBCD8), which maps ids 317..462 to RUNE_TBL and reads +4, so RUNE_TBL's copy is the
  // one that matters there; the Text tab happened to list the *spell* copy first (0x4232E8 <
  // 0x424F20 for Kite), which is the copy a reader would pick. Rather than expect anyone to
  // know which of two identical rows is which, every description write now writes both.
  //
  // The index is built from the pointer TABLES, never by matching text across the ELF: two
  // unrelated UI strings that happen to read alike must not become aliases. Verified on a
  // pristine SLUS-20387: 27 groups, exactly 2 copies each, and every pair has the same slot
  // length, so a mirrored write can never overflow one copy while fitting the other.
  //
  // The five item-record bands come from the disc's own dispatcher at VA 0x16DBCD8, which is
  // also where the two bands the editor has no view for (463..514 stride 0x14, 515..612 stride
  // 0x10) are documented. Every band uses name @+0, desc @+4.
  const DESC_BANDS = [
    [1, 160, 0x3E8CBC, 0x24],       // consumables, scrolls, herbs
    [161, 316, 0x3D8684, 0x44],     // weapons / armour / shields / accessories
    [317, 462, 0x3EAF78, 0x20],     // runes — the same table as RUNE_TBL
    [463, 514, 0x3EEB4C, 0x14],     // statues, fruit
    [515, 612, 0x3E6680, 0x10],     // hammers, quest items
  ];
  // Two copies are only treated as one string when they are reached from DIFFERENT tables. That
  // is the actual mechanism — a description is duplicated because two tables each want their own
  // copy — and the restriction matters: within a single table, repeated text is just repeated
  // text and linking it would make editing one spell silently rewrite three others. On a
  // pristine disc the cross-table rule finds all 27 real groups and nothing else (0 same-table
  // groups), every group is exactly 2 copies, and every pair shares its slot length.
  let DESC_ALIAS = null;            // Map<fileOff, fileOff[]> — every offset holding that string
  function descAlias() {
    if (DESC_ALIAS) return DESC_ALIAS;
    const byText = new Map(), tableOf = new Map();
    const note = (table, va) => {
      if (!va) return;
      const off = vaOff(va), len = origSlotLen(va);
      if (len <= 0 || !inBlk(off, len)) return;
      const t = strFrom(ORIG, off, len);        // keyed on the ORIGINAL text so the index is
      if (!t) return;                           // stable no matter what is staged on top of it
      let a = byText.get(t); if (!a) byText.set(t, (a = []));
      if (!a.includes(off)) a.push(off);
      let k = tableOf.get(off); if (!k) tableOf.set(off, (k = new Set()));
      k.add(table);
    };
    DESC_BANDS.forEach(([lo, hi, base, stride], n) => {
      for (let id = lo; id <= hi; id++) { const o = base + id * stride + 4; if (inBlk(o, 4)) note("band" + n, o32(o)); }
    });
    for (let i = 0; i < SPELL.count; i++) note("spell", o32(SPELL.off + i * SPELL.stride + 0x0C));
    for (let i = 0; i < UNITE.count; i++) note("unite", o32(UNITE.off + i * UNITE.stride + 0x0C));
    for (let i = 0; i < FOOD.count; i++) note("food", o32(FOOD.off + i * FOOD.stride + FOOD.desc));
    const m = new Map();
    for (const offs of byText.values()) {
      if (offs.length < 2) continue;
      const tables = new Set();
      offs.forEach((o) => (tableOf.get(o) || []).forEach((t) => tables.add(t)));
      if (tables.size < 2) continue;                                  // same table: not an alias
      const len = origSlotLen(offVa(offs[0]));
      if (offs.some((o) => origSlotLen(offVa(o)) !== len)) continue;   // never mirror unequal slots
      for (const o of offs) m.set(o, offs);
    }
    return (DESC_ALIAS = m);
  }
  // Every offset holding the same original description as `off`, itself included. One entry
  // when the string is unique, which is the case for all but 27 of them.
  const descCopies = (off) => descAlias().get(off) || [off];
  const descCopyCount = (off) => descCopies(off).length;
  // Write one description's bytes to every copy of it, and register each so the review list and
  // the dirty badge account for both. Callers have already length-checked against the slot; the
  // index guarantees the other copies share that length.
  function writeDescAll(off, padded, group, label) {
    const copies = descCopies(off);
    for (const o of copies) {
      writeBytes(o, padded);
      FIELD_REG[o] = { group, label: copies.length > 1 ? `${label} (copy ${copies.indexOf(o) + 1} of ${copies.length})` : label,
        off: o, width: padded.length, kind: "text" };
    }
    return copies.length;
  }
  // Rewrite an in-place description string. transform(currentText)->newText. Capped to the
  // ORIGINAL slot length, null-padded. Returns a status object. Registers a review entry.
  function rewriteDesc(dptr, transform, group, label) {
    const off = vaOff(dptr), maxlen = origSlotLen(dptr);
    if (maxlen <= 0 || !inBlk(off, maxlen)) return { skip: true };
    const cur = strFrom(BUF, off, maxlen), next = transform(cur);
    if (next === cur) return { noNumber: true };
    const enc = latin1Enc(next);
    if (enc.length > maxlen) return { truncated: true };
    const padded = new Uint8Array(maxlen); padded.set(enc);
    return { ok: true, copies: writeDescAll(off, padded, group, label) };
  }
  // Set a description to explicit text (gear custom desc). Rejects text longer than the slot.
  function setDescText(dptr, text, group, label) {
    const off = vaOff(dptr), maxlen = origSlotLen(dptr);
    if (maxlen <= 0 || !inBlk(off, maxlen)) return { skip: true, max: 0 };
    const enc = latin1Enc(text);
    if (enc.length > maxlen) return { tooLong: true, max: maxlen };
    const padded = new Uint8Array(maxlen); padded.set(enc);
    return { ok: true, max: maxlen, copies: writeDescAll(off, padded, group, label) };
  }
  // description-number transforms (mirror the desktop's regex rewrites)
  const descPower = (t, pw) => /DMGx\d+(?:\.\d+)?/.test(t) ? t.replace(/DMGx\d+(?:\.\d+)?/, "DMGx" + String(pw / 100))
    : /\d+DMG/.test(t) ? t.replace(/\d+DMG/, pw + "DMG") : t;
  const descDef = (t, def) => /DEF\(\+?\d+\)/.test(t) ? t.replace(/DEF\(\+?\d+\)/, "DEF(+" + def + ")") : t;
  const descHeal = (t, h) => t.replace(/Heals \d+HP/, "Heals " + h + "HP");
  const descProc = (t, p) => t.replace(/\d+% chance/, p + "% chance");

  // ---- reference tables (parsed in JS so the ISO tab needs no Pyodide) -------
  async function loadRef() {
    if (REF) return REF;
    const grab = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`fetch ${u} (${r.status})`); return r; };
    const itemsTxt = await (await grab("../Editor/Suikoden3_item_ids.txt")).text();
    const skillsTxt = await (await grab("../Editor/Suikoden3_skill_ids.txt")).text();
    const idesc = await (await grab("../Editor/s3_item_desc.json")).json();
    const names = await (await grab("../Editor/s3_names.json")).json();
    // Optional guide reference overlays — never fatal: a missing file just hides its notes.
    const grabOpt = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : {}; } catch (e) { return {}; } };
    const [runeSlots, skillRef, skillCaps, growthRef, bestiary, enemyPacks, warUnits, warRef] = await Promise.all([
      grabOpt("../Editor/s3_rune_slots.json"), grabOpt("../Editor/s3_skill_ref.json"),
      grabOpt("../Editor/s3_skill_caps.json"), grabOpt("../Editor/s3_growth_ref.json"),
      grabOpt("../Editor/s3_bestiary.json"), grabOpt("../Editor/s3_enemy_packs.json"),
      grabOpt("../Editor/s3_war_units.json"), grabOpt("../Editor/s3_war_ref.json"),
    ]);
    const rooms = await grabOpt("../Editor/s3_rooms.json");        // per-area encounter rates
    const subfiles = await grabOpt("../Editor/s3_subfiles.json");  // FSECT sub-file layout
    const uniteChars = await grabOpt("../Editor/s3_unite_chars.json");  // who is in each unite
    const itemSources = await grabOpt("../Editor/s3_item_sources.json");   // where items come from
    const shops = await grabOpt("../Editor/s3_shops.json");        // shop counter map + town names
    const runeFood = await grabOpt("../Editor/s3_rune_food_desc.json");    // rune/food menu text + spell lists
    const runeOwner = await grabOpt("../Editor/s3_rune_owner.json");       // whose rune each signature rune is
    const avatarAreas = await grabOpt("../Editor/s3_avatar_areas.json");   // which maps carry each field model
    const items = {}, cats = {};
    let cur = "";
    for (const line of itemsTxt.split(/\r?\n/)) {
      const h = /\*\s*(.+?)\s*\*/.exec(line);
      if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
      const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
      while ((m = re.exec(line))) { const id = parseInt(m[1], 16); items[id] = m[2].trim(); cats[id] = cur; }
    }
    const skills = {};
    for (const line of skillsTxt.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/); if (p.length >= 2) { const id = parseInt(p[0], 16); if (!isNaN(id)) skills[id] = p.slice(1).join(" "); }
    }
    REF = { items, cats, idesc, skills, names, runeSlots, skillRef, skillCaps, growthRef, bestiary,
            enemyPacks, warUnits, warRef, rooms, subfiles, uniteChars, itemSources,
            runeFood, runeOwner, shops, avatarAreas };
    return REF;
  }

  // ---- label / option helpers ------------------------------------------------
  const itemName = (id) => gearName(id) || REF.items[id] || "#" + id;
  const skillName = (id) => REF.skills[id] || "#" + id;
  const itemLabel = (id) => id ? `${hex(id, 3)} · ${itemName(id)}` : "— none —";
  const skillLabel = (id) => id ? `${hex(id, 2)} · ${skillName(id)}` : "— none —";
  const rankLabel = (v) => (RANK_OPTS.find((t) => t[0] === v) || [v, "?"])[1];
  const maxLabel = (v) => (MAX_OPTS.find((t) => t[0] === v) || [v, "?"])[1];
  function itemOpts(cat) {
    const list = Object.keys(REF.items).map(Number).filter((id) => !cat || REF.cats[id] === cat)
      .sort((a, b) => a - b).map((id) => ({ id, name: itemName(id), cat: REF.cats[id], desc: itemDesc(id) }));
    return [{ id: 0, name: "— none —" }, ...list];
  }
  function skillOpts() {
    const list = Object.keys(REF.skills).map(Number).sort((a, b) => a - b).map((id) => ({ id, name: skillName(id), desc: skillEffectText(id) }));
    return [{ id: 0, name: "— none —" }, ...list];
  }
  // map a list1 item-slot label to its item category, so pickers show the right gear only
  function slotCat(label) {
    if (/Rune/.test(label)) return "Runes";
    if (/Helmet/.test(label)) return "Headgear";
    if (/Armor/.test(label)) return "Armor";
    if (/Shield/.test(label)) return "Shields";
    return "";
  }

  function decodeF18(v) {
    if (!v) return "-";
    const names = [];
    for (let b = 0; b < 32; b++) if ((v >>> b) & 1) names.push(F18_BITS[b] || "bit" + b);
    return names.length > 6 ? "heal/restore-all" : names.join("|");
  }
  function decodeTarget(f14) {
    const tb = (f14 >>> 8) & 0xFF, area = !!(f14 & AREA_BIT), low = tb & 0x0F;
    let who = { 0xA: "single", 0x2: "all-foes", 0x3: "foes+allies", 0x1: "all-allies",
      0x5: "chanter", 0x9: "one-ally", 0x6: "foes-around-caster" }[low] || "who" + low;
    if (tb & 0x40) who += "(1 pair)";       // pair-select bit: target one ally pair, not the side
    // The caster bit (0x04) without an area is a self-only cast — the Sword/Amulet runes read
    // "spread:who5" before this, which named neither the shape nor the target.
    const shape = area ? "AREA" : (tb & 0x10) ? "LINE" : (tb & 0x04) ? "self"
      : low === 0xA ? "single" : "spread";
    return `${shape}:${who}`;
  }

  // ---- edit application ------------------------------------------------------
  // Register a field's location so the review/save diff can label it, then apply.
  function reg(off, width, kind, group, label) { FIELD_REG[off] = { group, label, off, width, kind }; }
  function isDirty(off, width) {
    for (let i = 0; i < width; i++) if (BUF[off - ELF_BASE + i] !== ORIG[off - ELF_BASE + i]) return true;
    return false;
  }
  // restore a field's original bytes from the pristine snapshot
  function revertRange(off, width) { for (let i = 0; i < width; i++) if (inBlk(off + i, 1)) BUF[off - ELF_BASE + i] = ORIG[off - ELF_BASE + i]; }
  // Toggle a control's changed-highlight AND attach/refresh a ↺ "restore original" button
  // next to it. The button appears only while the field differs from the on-disk value; its
  // tooltip shows that original value; clicking it reverts just this field and re-renders.
  function markField(el, off, width, kind) {
    const dirty = isDirty(off, width);
    el.classList.toggle("dirty", dirty);
    let btn = el._revBtn;
    if (!btn) {
      if (!dirty) return;                    // clean fields don't need a button yet
      btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); revertRange(off, width); drawView(); };
      (kind === "raw" && el.parentElement && el.parentElement.hasAttribute("data-eff")
        ? el.parentElement.appendChild(btn) : el.insertAdjacentElement("afterend", btn));
      el._revBtn = btn;
    }
    btn.classList.toggle("show", dirty);
    if (dirty) {
      const ov = kind === "text" ? `"${strFrom(ORIG, off, width)}"`
        : kind === "raw" ? "original" : fmtVal(kind, origW(off, width));
      btn.title = `Restore original (${ov})`;
      btn.setAttribute("aria-label", `Restore original value (${ov})`);
    }
    scheduleBadge();
  }
  // Like markField, but only the bits in `mask` of a u32 field count as "this control's".
  // Lets Target and Area-of-effect (which share one flags word) highlight/revert independently.
  function markFlagsField(el, off, mask) {
    const cur = readW(off, 4) >>> 0, orig = origW(off, 4) >>> 0, dirty = ((cur ^ orig) & mask) !== 0;
    el.classList.toggle("dirty", dirty);
    let btn = el._revBtn;
    if (!btn) {
      if (!dirty) { scheduleBadge(); return; }
      btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation();
        const c = readW(off, 4) >>> 0, o = origW(off, 4) >>> 0; writeW(off, 4, ((c & ~mask) | (o & mask)) >>> 0); drawView(); };
      el.insertAdjacentElement("afterend", btn); el._revBtn = btn;
    }
    btn.classList.toggle("show", dirty);
    scheduleBadge();
  }
  // Coalesce dirty-badge refreshes to once per frame — markField fires many times per render.
  let badgePending = false;
  function scheduleBadge() {
    if (badgePending) return; badgePending = true;
    (window.requestAnimationFrame || setTimeout)(() => { badgePending = false; updateDirtyBadge(); }, 0);
  }
  function fmtVal(kind, v) {
    if (kind === "item") return itemLabel(v);
    if (kind === "skill") return skillLabel(v);
    if (kind === "rank") return rankLabel(v);
    if (kind === "max") return maxLabel(v);
    if (kind === "elem") return ELEMENTS[v & 0xFF] || "0x" + (v & 0xFF).toString(16);
    if (kind === "aoe") return (v & AREA_BIT) ? "AOE on" : "AOE off";
    if (kind === "flags14") return decodeTarget(v);
    if (kind === "status") return decodeF18(v);
    if (kind === "imm16") return String(v & 0xFFFF);   // a patched MIPS word: only the immediate moved
    if (kind === "f32") { const f = f32Of(v); return Number.isFinite(f) ? String(+f.toFixed(3)) : "?"; }
    if (kind === "spellid") {                          // ...and that immediate is a 1-based spell number
      const i = (v & 0xFFFF) - 1;
      const nm = i >= 0 && i < SPELL.count ? strAt(r32(SPELL.off + i * SPELL.stride + 0x08)) : "";
      return nm ? `${nm} (#${i})` : `spell no. ${v & 0xFFFF}`;
    }
    return String(v);
  }
  function anyChanges() { return BUF && ORIG && (diffRuns(1).length > 0 || auxDirty()); }
  // relative [start,end) runs where BUF != ORIG; pass limit to early-out on the first run
  function diffRuns(limit) {
    const runs = []; const N = BUF.length; let i = 0;
    while (i < N) {
      if (BUF[i] !== ORIG[i]) { const s = i; while (i < N && BUF[i] !== ORIG[i]) i++; runs.push([s, i]); if (limit && runs.length >= limit) return runs; }
      else i++;
    }
    return runs;
  }

  // ---- ISO load --------------------------------------------------------------
  async function openIso() {
    let handle;
    try {
      // No type filter: some platforms (notably Android's picker) map .iso to a MIME the
      // filter doesn't list and grey it out. Allow any file; the version-word check validates.
      [handle] = await window.showOpenFilePicker({ multiple: false });
    } catch (e) { if (e && e.name !== "AbortError") setStatus("Could not open ISO: " + e.message, "err"); return; }
    loadFromHandle(handle);
  }
  // Open via a writable handle (desktop FS Access → in-place save + one-tap reopen).
  async function loadFromHandle(handle) {
    let file;
    try { file = await handle.getFile(); }
    catch (e) { return setStatus("Could not read that file: " + e.message, "err"); }
    return commitIso(file, handle);
  }
  // Open via a plain <input type=file> (Android/Firefox/Safari — no handle; save streams a copy).
  async function loadFromInputFile(file) { return commitIso(file, null); }

  // ---- ranged disc reads -----------------------------------------------------
  // Opening a disc needs ~400 small windows scattered over 3.6 GB — enemy and war stat
  // records, reward blocks, spawn zones, room encounter tables. Issued one at a time they
  // dominated the load: on a phone the File arrives through a content:// / Files provider,
  // so every Blob.slice() is an IPC round trip with no readahead benefit (consecutive
  // windows are hundreds of MB apart), and awaiting each in turn stacked ~400 latencies
  // end to end. "Reading enemy data…" sat there for tens of seconds.
  //
  // Two separate gaps fix that without retaining more memory than before:
  //   KEEP_GAP    how tightly the windows AUX RETAINS are merged. Unchanged, so AUX still
  //               holds ~1 MB and the per-tag dirty accounting is byte-for-byte identical.
  //   FETCH_GAP   how tightly the READS are merged. Much looser: bridging unwanted bytes
  //               to save a round trip pays off whenever gap/throughput < latency, which
  //               is ~2.5 MB on a phone and ~250 KB on a desktop. At 512 KB the shipped
  //               index goes from 395 reads to 46, and merging further buys almost nothing
  //               (44 reads) for twice the bytes.
  // The wide chunks are carved into the tight windows and dropped, so the bridged bytes
  // are transient and never reach AUX.
  const KEEP_GAP = 0x2000, FETCH_GAP = 0x80000, READ_CONC = 8;
  // Merge [start, end) ranges lying within `gap` bytes of each other. Input need not be
  // sorted; the result is sorted and disjoint.
  function coalesce(ranges, gap) {
    const out = [];
    for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
      const last = out[out.length - 1];
      if (last && s - last[1] <= gap) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }
  // Read every range with at most `conc` requests in flight. Returns {chunks, threw}: `chunks`
  // is parallel to `ranges`, null where that read threw or came up short; `threw` counts the
  // ones that threw. The two failures mean different things and get different UI — a short read
  // is a window this disc genuinely doesn't have, while a throw is the file having moved or
  // lost permission, which is worth offering a retry for. Errors are not rethrown: one
  // unreadable region must not cost the whole disc.
  async function readRanges(file, ranges, conc, onDone) {
    const out = new Array(ranges.length).fill(null);
    let next = 0, done = 0, threw = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= ranges.length) return;
        const [s, e] = ranges[i];
        try {
          const a = new Uint8Array(await file.slice(s, e).arrayBuffer());
          if (a.length === e - s) out[i] = a;
        } catch (err) { threw++; }
        if (onDone) onDone(++done, ranges.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, ranges.length) }, worker));
    return { chunks: out, threw };
  }

  // ---- blocking "opening a disc" overlay -------------------------------------
  // Opening a disc is seconds of work (longer on a phone, reading a 4 GB image through a
  // content:// provider), and with auto-reopen on it starts with no click at all — so the
  // loader shell must stop looking idle while it runs. Without this the picker underneath
  // stays live and a second pick races the first, and the only sign anything is happening
  // is one line of status text nobody is looking at.
  let LOADBOX = null;
  // Reuses the open box if there is one, so the auto-reopen can raise it before the file is
  // even fetched and commitIso then just keeps writing into it.
  function loadBox(title) {
    if (LOADBOX) { if (title) LOADBOX.title(title); return LOADBOX; }
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Opening ISO" tabindex="-1" style="max-width:420px">
        <div class="modal-h"><b id="ldTitle"></b></div>
        <div class="pg-body" aria-live="polite" aria-busy="true">
          <div class="muted" id="ldMsg" style="margin-bottom:12px"></div>
          <div class="bar indet"><div class="bar-fill" id="ldFill" style="width:35%"></div></div>
          <div class="muted ld-note">Nothing is uploaded — only a ~3.7 MB slice of the disc is read.</div>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const bar = ov.querySelector(".bar"), fill = ov.querySelector("#ldFill");
    const msgEl = ov.querySelector("#ldMsg"), ttlEl = ov.querySelector("#ldTitle");
    // The picker under the overlay keeps keyboard focus after its click, so Enter would fire
    // it a second time straight through the backdrop; take focus into the dialog.
    const box = ov.querySelector(".modal");
    try { box.focus(); } catch (e) {}
    LOADBOX = {
      title(t) { ttlEl.textContent = t; },
      phase(msg, pct) {
        msgEl.innerHTML = `<span class="spinner"></span>${esc2(msg)}`;
        const indet = pct == null;
        bar.classList.toggle("indet", indet);
        if (!indet) fill.style.width = Math.max(2, Math.min(100, pct)) + "%";
      },
      close() { ov.remove(); },
    };
    LOADBOX.title(title || "Opening ISO…");
    LOADBOX.phase("Reading the disc…");
    return LOADBOX;
  }
  function closeLoadBox() { if (LOADBOX) { LOADBOX.close(); LOADBOX = null; } }
  // One progress line, both surfaces: the status strip (which outlives the overlay and is
  // what a failed load leaves its message in) and the overlay's own text + bar.
  function loadStep(msg, pct) { setStatus(msg, ""); if (LOADBOX) LOADBOX.phase(msg, pct); }

  // Every ISO load funnels through here, so the overlay is raised and dropped in one place —
  // including the error paths, which all return out of the loader below.
  async function commitIso(file, handle) {
    if (!LOADBOX) loadBox(`Opening ${file.name || "ISO"}…`);
    try { return await commitIsoLoad(file, handle); }
    finally { closeLoadBox(); }
  }

  // Read + validate + commit an ISO from a File. Nothing large is held — only the ~3.75 MB
  // editable region is read (via a ranged Blob.slice); the source File is kept for streaming.
  async function commitIsoLoad(file, handle) {
    loadStep("Reading disc region… (a moment on a large disc)");
    if (file.size < ELF_END) return setStatus(`That file is only ${fmtSize(file.size)} — not a full Suikoden III ISO.`, "err");
    let ab;
    try { ab = await file.slice(ELF_BASE, ELF_END).arrayBuffer(); }
    catch (e) { return setStatus("Read failed: " + e.message, "err"); }
    const buf = new Uint8Array(ab);
    if (buf.length < ELF_LEN) return setStatus("Could not read the full disc region (file too short or unreadable).", "err");
    const dv = new DataView(ab);
    const ver = dv.getUint32(VERSION_OFF - ELF_BASE, false);   // big-endian
    if (ver !== VERSION_VAL) {
      return setStatus(`Not a USA (SLUS-20387) Suikoden III ISO — version word 0x${hex(ver, 8)} ≠ 0x${hex(VERSION_VAL, 8)}. ` +
        `Only the USA release is supported.`, "err");
    }
    // The only windows read on open are the potch overlay pair — two 16-byte reads that keep
    // the Sets view synchronous. Everything else the disc needs (enemy, war and room tables,
    // ~45 ranged reads scattered over 3.6 GB) is deferred to loadDiscTables(); see the note
    // there. Optional the same way it always was: an unreadable window just makes that one
    // control read-only, never blocks the load.
    const potch = coalesce(AUX_WINDOWS.map((off) => [off, off + AUX_LEN]), FETCH_GAP)
      .map(([s, e]) => [s, Math.min(e, file.size)]).filter(([s, e]) => e > s);
    const pr = await readRanges(file, potch, READ_CONC);
    const aux = [];
    for (let i = 0; i < potch.length; i++) {
      const c = pr.chunks[i];
      if (!c) { aux.length = 0; break; }
      for (const off of AUX_WINDOWS) {
        if (off < potch[i][0] || off + AUX_LEN > potch[i][1]) continue;
        const b = c.slice(off - potch[i][0], off - potch[i][0] + AUX_LEN);
        aux.push({ off, len: AUX_LEN, tag: "potch", buf: b, orig: b.slice() });
      }
    }
    if (aux.length !== AUX_WINDOWS.length) aux.length = 0;
    // commit
    BUF = buf; DV = dv; ORIG = buf.slice(); ODV = new DataView(ORIG.buffer);
    AUX = aux;
    resetTables();                              // deferred tables belong to the disc being replaced
    Object.keys(EREG).forEach((k) => delete EREG[k]);
    isoHandle = handle; isoFile = file; isoName = file.name || "game.iso";
    gearCache = null; gearAlias = {}; dropDescCaches(); TEXTS = null; DESC_ALIAS = null; RUNE_FX_OPEN = new Set(); resetUndo(); Object.keys(FIELD_REG).forEach((k) => delete FIELD_REG[k]);
    recipeExported = false; saveNudged = false; RENAMES = {};
    VIEW = "chars"; SEARCH = "";
    autoReopenDone = true;                      // one disc per page load decides itself; Close must stay closed
    if (handle) rememberIso(isoName, handle);   // persist the handle for one-tap reopen (FS only)
    renderEditor(file.size);
    q("#isoRoot").scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Loaded ${isoName} — USA verified.`, "ok");
  }

  // ---- deferred disc tables --------------------------------------------------
  // The enemy, war and room tables are ~45 ranged reads scattered over 3.6 GB, and only three
  // of the seventeen views ever touch them. Reading them on open charged that price to every
  // session, including the majority that never open those tabs, so they load on first use
  // instead. Opening a disc is now three ranged reads: the ~3.75 MB ELF block and the potch
  // pair.
  //
  // Anything that needs these windows must go through loadDiscTables() first, and that is NOT
  // just the three views. importRecipe() and the .xdelta apply both resolve offsets through
  // inAux(), to which a window that hasn't loaded yet is indistinguishable from an offset this
  // editor cannot edit — the recipe path would have skipped those runs silently, neither
  // applied nor reported.
  let TABLES_STATE = "idle";        // idle | loading | ready | failed
  let TABLES_PROMISE = null;
  let TABLES_ERR = "";
  // Bumped whenever the open disc changes. A read still in flight when that happens must not
  // write its windows into the new session's AUX, and must not flip the new session's state.
  let DISC_GEN = 0;
  const TABLE_VIEWS = new Set(["enemies", "war", "encounter"]);
  function resetTables() {
    TABLES_STATE = "idle"; TABLES_PROMISE = null; TABLES_ERR = ""; DISC_GEN++;
    EPACKS = []; EPACKS_META = null; EPACKS_SKIPPED = 0; WPACKS_SKIPPED = 0;
    ROOMS = []; ROOMS_SKIPPED = 0;
  }
  // Idempotent: concurrent callers (two tabs clicked quickly, or a view and a patch apply at
  // once) share one read. Never rejects — the outcome is in TABLES_STATE.
  function loadDiscTables() {
    if (TABLES_PROMISE) return TABLES_PROMISE;
    if (TABLES_STATE === "ready" || TABLES_STATE === "failed") return Promise.resolve();
    const gen = DISC_GEN, file = isoFile;
    if (!file) { TABLES_STATE = "failed"; TABLES_ERR = "no disc is open"; return Promise.resolve(); }
    TABLES_STATE = "loading";
    TABLES_PROMISE = readDiscTables(file, gen).catch((e) => {
      if (gen !== DISC_GEN) return;
      TABLES_STATE = "failed"; TABLES_ERR = (e && e.message) || String(e);
    });
    return TABLES_PROMISE;
  }
  async function readDiscTables(file, gen) {
    // ---- window plan ---------------------------------------------------------
    // Every window is planned before a single byte is read, so the scattered reads can be
    // merged and issued together (see KEEP_GAP/FETCH_GAP above). A plan entry is a tag plus
    // the tight ranges AUX keeps under it; building one touches no I/O.
    const plan = [];
    // enemy windows: spans over every stat record, reward block and spawn zone listed in
    // s3_enemy_packs.json (all pack copies). Optional — a pack whose offsets can't be read
    // (short disc / test fixture) is skipped, and the Enemies view reports it as unavailable
    // instead of showing wrong data.
    let epacks = [], eskipped = 0, wskipped = 0;
    const epsrc0 = (typeof window !== "undefined" && window.S3_TEST_ENEMY_PACKS) || (REF && REF.enemyPacks);
    // war-unit packs (s3_war_units.json) share the exact record layout and ride the
    // same tagged spans; they render in the War view instead of the Enemies view.
    const wpsrc = (typeof window !== "undefined" && window.S3_TEST_WAR_UNITS) || (REF && REF.warUnits);
    const epsrc = (() => {
      const base = (epsrc0 && Array.isArray(epsrc0.packs)) ? epsrc0 : null;
      const war = (wpsrc && Array.isArray(wpsrc.packs)) ? wpsrc : null;
      if (!base && !war) return null;
      const meta = base || war;
      return { recLayout: meta.recLayout, auxLayout: meta.auxLayout, zoneLayout: (base && base.zoneLayout) || undefined,
               packs: [...(base ? base.packs : []), ...(war ? war.packs : [])] };
    })();
    if (epsrc && Array.isArray(epsrc.packs)) {
      const rl = epsrc.recLayout, al = epsrc.auxLayout;
      const zl = epsrc.zoneLayout || { slotSize: 0x14, partySize: 0x1C };
      const spans = [];
      for (const p of epsrc.packs) {
        const offs = [];
        for (const e of p.enemies) for (const v of e.variants) {
          for (const o of v.rec) offs.push([o, o + rl.size]);
          for (const o of v.aux) offs.push([o, o + al.size]);
        }
        for (const z of (p.zones || [])) {
          for (const s of z.slots) for (const o of s.off) offs.push([o, o + zl.slotSize]);
          for (const pa of z.parties) {
            for (const o of pa.off) offs.push([o, o + zl.partySize]);
            for (const o of pa.memOff) offs.push([o, o + Math.max(pa.members.length, 1)]);
          }
        }
        if (offs.some(([, e]) => e > file.size)) { if (p.war) wskipped++; else eskipped++; continue; }
        epacks.push(p); spans.push(...offs);
      }
      if (spans.length) plan.push({ tag: "enemy", keep: coalesce(spans, KEEP_GAP) });
    }
    // room windows: the per-area encounter-rate tables from s3_rooms.json. Each room
    // record contributes its 4-byte [grace, rate] pair; a table's records are 0x3C apart
    // so one table coalesces into one window. Unlike the enemy packs there are no
    // streaming duplicates — a room's rate lives at exactly one offset per chapter
    // variant (see Suikoden3_ISO_offsets.md, "FSECT.BIN CRACKED").
    let rareas = [], rskipped = 0;
    const rsrc = (typeof window !== "undefined" && window.S3_TEST_ROOMS) || (REF && REF.rooms);
    if (rsrc && Array.isArray(rsrc.areas)) {
      const rspans = [];
      for (const a of rsrc.areas) {
        const offs = [];
        for (const t of a.tables) for (const r of t.rooms) offs.push([r.graceOff, r.graceOff + 4]);
        if (offs.some(([, e]) => e > file.size)) { rskipped++; continue; }
        rareas.push(a); rspans.push(...offs);
      }
      // A window another tag already covers can serve these reads and writes (auxWin searches
      // every window, including the potch pair already in AUX); a second, overlapping one
      // would split the dirty tracking in two, so drop it. Nothing overlaps on the shipped
      // index — this guards an offset table that one day does.
      const taken = plan.flatMap((p) => p.keep).concat(AUX.map((w) => [w.off, w.off + w.len]));
      const keep = coalesce(rspans, KEEP_GAP).filter(([s, e]) => !taken.some(([cs, ce]) => s >= cs && e <= ce));
      if (keep.length) plan.push({ tag: "room", keep });
    }
    // ---- one batched pass over the disc --------------------------------------
    // Ranges are clamped to the file so a window planted past the end of a short disc fails
    // only its own tag, instead of short-reading a chunk that other tags were sharing.
    const fetchRanges = coalesce(plan.flatMap((p) => p.keep), FETCH_GAP)
      .map(([s, e]) => [s, Math.min(e, file.size)]).filter(([s, e]) => e > s);
    let chunks = [], threw = 0;
    if (fetchRanges.length) {
      setStatus("Reading area data… 0%", "");
      ({ chunks, threw } = await readRanges(file, fetchRanges, READ_CONC,
        (n, t) => { if (gen === DISC_GEN) setStatus(`Reading area data… ${Math.round(n * 100 / t)}%`, ""); }));
    }
    if (gen !== DISC_GEN) return;               // the disc changed under us — drop everything
    // A read that THREW is the file having moved or lost permission since the disc was opened
    // — a state that couldn't arise when these reads happened during open, and one worth a
    // retry rather than a wrong "this disc doesn't have those offsets".
    if (threw) throw new Error(`${threw} of ${fetchRanges.length} disc reads failed`);
    // Carve the tight windows out of the wide chunks, then drop the chunks so the bytes
    // bridged between windows stay transient. A tag that loses any window loses all of
    // them: half a table would show wrong values and write wrong bytes, which is worse
    // than reporting the feature unavailable.
    const aux = [];
    const lost = new Set();
    for (const p of plan) {
      const win = [];
      for (const [s, e] of p.keep) {
        const i = fetchRanges.findIndex(([cs, ce]) => s >= cs && e <= ce);
        if (i < 0 || !chunks[i]) { lost.add(p.tag); break; }
        const b = chunks[i].slice(s - fetchRanges[i][0], e - fetchRanges[i][0]);
        win.push({ off: s, len: e - s, tag: p.tag, buf: b, orig: b.slice() });
      }
      if (!lost.has(p.tag)) aux.push(...win);
    }
    chunks = null;
    if (lost.has("enemy")) {
      epacks = [];
      eskipped = epsrc.packs.filter((p) => !p.war).length;
      wskipped = epsrc.packs.filter((p) => p.war).length;
    }
    if (lost.has("room")) { rareas = []; rskipped = rsrc.areas.length; }
    // Commit in one assignment, onto whatever AUX holds NOW — a potch edit made while this
    // read was in flight has to survive it.
    AUX = AUX.concat(aux);
    EPACKS = epacks; EPACKS_META = epsrc || null; EPACKS_SKIPPED = eskipped; WPACKS_SKIPPED = wskipped;
    ROOMS = rareas; ROOMS_SKIPPED = rskipped;
    TABLES_STATE = "ready";
  }
  // Gate for the three views that need the deferred tables. Returns true when the caller can
  // draw, false when it has put a placeholder up and will re-draw itself once the read lands.
  // Synchronous on purpose: drawView() stays synchronous, and a view whose tables are already
  // in draws in the same tick it always did.
  function needTables(host) {
    if (!host) return false;
    if (TABLES_STATE === "ready") return true;
    if (TABLES_STATE === "failed") {
      host.innerHTML = `<div class="warnbox">Couldn't read this disc's area tables${TABLES_ERR ? ` — ${esc2(TABLES_ERR)}` : ""}.
        The file may have moved, been changed, or lost permission since you opened it.
        <button class="chip mini" id="tblRetry">Retry</button></div>`;
      const b = q("#tblRetry", host);
      if (b) b.onclick = () => { TABLES_STATE = "idle"; TABLES_PROMISE = null; TABLES_ERR = ""; drawView(); };
      return false;
    }
    host.innerHTML = `<div class="muted" id="tblLoading">Reading area data off the disc…</div>`;
    const gen = DISC_GEN;
    loadDiscTables().then(() => { if (gen === DISC_GEN && TABLE_VIEWS.has(VIEW)) drawView(); });
    return false;
  }
  // Patch applies resolve out-of-block offsets through inAux(), so the windows have to be in
  // before the first lookup. Returns an error string when they couldn't be, so the caller can
  // refuse the whole patch: applying the in-block half of a recipe and silently dropping the
  // enemy half is the one outcome worse than not applying it.
  async function tablesForPatch() {
    setStatus("Reading area data off the disc…", "");
    await loadDiscTables();
    return TABLES_STATE === "failed"
      ? `Couldn't read this disc's area tables (${TABLES_ERR}) — nothing was applied, because a patch ` +
        `touching enemy or encounter data would only have gone in halfway. Retry, or reopen the disc.`
      : "";
  }
  // How this browser can write edits back: overwrite in place, stream a patched copy, or neither.
  function saveMode() {
    if (SUPPORTS_FS && isoHandle) return "inplace";
    if (CAN_STREAM_SAVE && isoFile) return "stream";
    return "none";
  }

  // ---- remember last opened ISO (persist the file HANDLE; the 4 GB bytes are never stored) --
  function rememberIso(name, handle) { idbSet("lastIso", { name, handle, at: Date.now() }).catch(() => {}); }
  // Auto-reopen fires at most once per page load, and never after an ISO has already been
  // opened here — otherwise "Close" would bounce straight back into the disc you just closed.
  let autoReopenDone = false;
  const AUTO_KEY = "s3isoAutoReopen";
  function autoReopenOn() { try { return localStorage.getItem(AUTO_KEY) !== "off"; } catch (e) { return true; } }
  async function showLastIso() {
    const el = q("#isoRecent"); if (!el) return;
    let rec; try { rec = await idbGet("lastIso"); } catch (e) { return; }
    if (!rec || !rec.handle) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="recent">Last opened:
        <button class="chip" id="isoReopen">↻ ${esc2(rec.name)}</button>
        <button class="chip mini" id="isoForget" title="forget" aria-label="forget last ISO">✕</button>
        <label class="autochk" title="Reopen this ISO by itself whenever the ISO Editor opens">
          <input type="checkbox" id="isoAuto"${autoReopenOn() ? " checked" : ""}> auto-reopen</label></div>`;
    q("#isoReopen", el).onclick = () => reopenLastIso(rec);
    q("#isoForget", el).onclick = async () => { await idbDel("lastIso").catch(() => {}); el.innerHTML = ""; };
    q("#isoAuto", el).onchange = (e) => {
      try { localStorage.setItem(AUTO_KEY, e.target.checked ? "on" : "off"); } catch (err) {}
      if (e.target.checked && !autoReopenDone) autoReopen(rec);
    };
    if (autoReopenOn()) autoReopen(rec);
  }
  // Reopen the last disc with no click at all. The browser only lets us do that silently when
  // it already holds readwrite permission for the handle (Chrome's "allow on every visit", or
  // an installed PWA); otherwise a permission prompt needs user activation, which we still
  // have if the user just clicked into the ISO Editor tab. Anything else falls back to the
  // one-tap chip — never a dead end.
  async function autoReopen(rec) {
    if (autoReopenDone || BUF) return;
    autoReopenDone = true;
    let st;
    try { st = await rec.handle.queryPermission({ mode: "readwrite" }); } catch (e) { return; }
    if (st === "denied") return;
    if (st !== "granted") {
      const act = typeof navigator !== "undefined" && navigator.userActivation;
      if (act && !act.isActive) return setStatus(`Tap ↻ ${rec.name} to reopen — this browser wants a click before it re-grants access to the file.`, "");
      try { if ((await rec.handle.requestPermission({ mode: "readwrite" })) !== "granted") return; }
      catch (e) { return; }
    }
    if (BUF) return;                       // a manual pick beat us to it
    setStatus(`Reopening ${rec.name}…`, "");
    // Nobody clicked for this load, so the overlay goes up before the file is even fetched:
    // until it does the loader shell looks idle and invites a pick that would race this one.
    loadBox(`Reopening ${rec.name}…`).phase("Opening the file…");
    try { await loadFromHandle(rec.handle); }
    catch (e) { setStatus("Could not reopen the last ISO — it may have moved. Pick it again.", "warn"); }
    finally { closeLoadBox(); }            // commitIso closes it too; a second close is a no-op
  }
  async function reopenLastIso(rec) {
    autoReopenDone = true;
    try {
      if (!(await ensureWritable(rec.handle))) return setStatus("Reopen cancelled — write permission denied.", "warn");
      loadBox(`Reopening ${rec.name}…`).phase("Opening the file…");
      await loadFromHandle(rec.handle);
    } catch (e) { setStatus("Could not reopen — the file may have moved. Pick it again.", "err"); }
    finally { closeLoadBox(); }
  }

  // ---- save (in place) -------------------------------------------------------
  function buildReview() {
    const rows = [];
    let covered = 0;
    for (const off in FIELD_REG) {
      const m = FIELD_REG[off];
      if (!isDirty(m.off, m.width)) continue;
      covered += m.width;
      let ov, nv;
      if (m.kind === "text") { ov = `"${strFrom(ORIG, m.off, m.width)}"`; nv = `"${strFrom(BUF, m.off, m.width)}"`; }
      else { ov = fmtVal(m.kind, origW(m.off, m.width)); nv = fmtVal(m.kind, readW(m.off, m.width)); }
      if (ov !== nv) rows.push({ g: m.group, t: `${m.label}: ${ov} → ${nv}` });
    }
    // Aux windows (potch overlay pair): decode the multiplier for a readable review row.
    if (auxHasPotch() && auxDirty()) {
      const w0 = AUX_WINDOWS[0];
      const oldM = decodePotch(auxO32(w0 + AUX_MULT), auxO32(w0 + AUX_MULT + 4));
      const newM = decodePotch(auxR32(w0 + AUX_MULT), auxR32(w0 + AUX_MULT + 4));
      if (oldM !== newM)
        rows.push({ g: "Armor sets", t: `Potch multiplier per set wearer: ${oldM ? "×" + oldM : "?"} → ${newM ? "×" + newM : "?"} (both overlay copies)` });
      const oldMask = auxO32(w0 + AUX_MASK) & 0xFFFF, newMask = auxR32(w0 + AUX_MASK) & 0xFFFF;
      if (oldMask !== newMask)
        rows.push({ g: "Armor sets", t: `Potch bonus applies to: ${maskSetNames(oldMask)} → ${maskSetNames(newMask)}` });
    }
    // Enemy and room fields (registered on edit; dirty state re-checked live so reverts
    // drop out of the list). Room rows are counted apart so the per-area bulk summary
    // below can't be inflated by labelled enemy edits, or vice versa.
    let enemyCovered = 0, roomCovered = 0;
    for (const k in EREG) {
      const m = EREG[k];
      if (!eDirty(m.offs, m.w)) continue;
      if (m.room) roomCovered += m.offs.length * m.w;
      else enemyCovered += m.offs.length * m.w;
      const ov = m.fmt(eOrig(m.offs, m.w)), nv = m.fmt(eRead(m.offs, m.w));
      if (ov !== nv) rows.push({ g: m.group, t: `${m.label}: ${ov} → ${nv}${m.offs.length > 1 ? ` (×${m.offs.length} copies)` : ""}` });
    }
    // Bulk enemy multipliers touch thousands of bytes without per-field registration —
    // summarize whatever enemy dirt the labeled rows don't account for.
    const enemyDirty = AUX.reduce((a, w) => {
      if (w.tag !== "enemy") return a;
      let n = 0; for (let i = 0; i < w.len; i++) if (w.buf[i] !== w.orig[i]) n++;
      return a + n;
    }, 0);
    if (enemyDirty > enemyCovered)
      rows.push({ g: "Enemies", t: `${enemyDirty - enemyCovered} more enemy byte(s) changed (bulk multipliers), all pack copies included` });
    // Same for the Encounter view's whole-area presets, which rewrite every room record
    // in an area without registering each one.
    const roomDirty = AUX.reduce((acc, w) => {
      if (w.tag !== "room") return acc;
      let n = 0; for (let i = 0; i < w.len; i++) if (w.buf[i] !== w.orig[i]) n++;
      return acc + n;
    }, 0);
    if (roomDirty > roomCovered)
      rows.push({ g: "Encounters", t: `${roomDirty - roomCovered} more room byte(s) changed (per-area rate presets)` });
    // Bulk edits (Balance presets) change many bytes not tied to one labeled field.
    const totalDirty = diffRuns().reduce((a, r) => a + (r[1] - r[0]), 0);
    if (totalDirty > covered) rows.push({ g: "Bulk / other", t: `${totalDirty - covered} more byte(s) changed (e.g. Balance multipliers)` });
    return rows;
  }
  let recipeExported = false, saveNudged = false;
  function saveIso() {
    const hasRename = Object.keys(RENAMES).length > 0;
    if (!anyChanges() && !hasRename) return setStatus("No changes to save.", "warn");
    // Renames are disc-wide and only the streaming save can reach every copy.
    if (hasRename && saveMode() !== "stream") {
      setStatus("Character renames apply disc-wide and are only written by the streaming “save patched copy” (Android/Firefox/Safari, or a full rebuild) — the in-place desktop save can't include them.", "warn");
      if (!anyChanges()) return;   // nothing else to write in place → stop
    }
    if (saveMode() === "none")
      return setStatus("This browser can't write the ISO. Use “Export recipe…” and apply it on a desktop Chromium browser (or the desktop app).", "warn");
    // One-time nudge to export a reversible recipe before the first write of a session.
    if (!recipeExported && !saveNudged) { saveNudged = true; return backupNudge(confirmAndSave); }
    confirmAndSave();
  }
  function confirmAndSave() {
    const rows = buildReview();
    const bytes = diffRuns().reduce((a, r) => a + (r[1] - r[0]), 0);
    RenameCore.buildRenames(RENAMES).list.forEach((r) => rows.push({ g: "Rename", t: `${r.origName} → ${r.newName} (disc-wide)` }));
    if (!rows.length) rows.push({ g: "Raw", t: `${bytes} byte(s)` });
    if (saveMode() === "stream") {
      openConfirm(rows, doStreamSave,
        `Save patched ISO (~${fmtSize(isoFile.size)} download)`);
    } else {
      openConfirm(rows, doSave, `Write ${bytes} byte(s) to ${isoName}`);   // in-place
    }
  }
  // "Back up first?" prompt shown once before the first save; offers a one-click recipe export.
  function backupNudge(onContinue) {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Back up before saving" style="max-width:460px">
        <div class="modal-h"><b>Back up before saving?</b></div>
        <div class="pg-body">
          <p class="sub" style="margin:0 0 6px">Editing an ISO writes changes into your disc image. Export a tiny <b>.s3mod recipe</b> first — it records every change so you can undo, and it takes a second (no 4&nbsp;GB copy).</p>
          <p class="muted" style="margin:0">You can also keep your own backup copy of the ISO.</p>
        </div>
        <div class="modal-f">
          <button id="bnCancel">Cancel</button>
          <button id="bnSkip">Save without backup</button>
          <button class="primary" id="bnExport">Export recipe &amp; continue</button>
        </div></div>`;
    document.body.appendChild(ov);
    const close = modalA11y(ov, () => ov.remove(), q("#bnExport", ov));
    q("#bnCancel", ov).onclick = () => close();
    ov.onclick = (e) => { if (e.target === ov) close(); };
    q("#bnSkip", ov).onclick = () => { close(); onContinue(); };
    q("#bnExport", ov).onclick = () => { close(); exportRecipe(); onContinue(); };
  }
  async function doSave() {
    const runs = diffRuns();
    const aux = auxRuns();
    const total = runs.length + aux.length,
      totalBytes = runs.reduce((a, r) => a + (r[1] - r[0]), 0) + aux.reduce((a, r) => a + r.bytes.length, 0);
    const pg = progressModal();
    setBusy(true);
    try {
      // Phase 1: the browser makes a safe (atomic) copy of the disc before applying writes.
      // There are no progress events for this, so show an animated bar + elapsed timer.
      pg.phase("Preparing", `Making a safe copy of ${isoName} before writing… ` +
        `Large discs can take a while — nothing is uploaded, and the original stays intact until this finishes.`, { indet: true });
      const w = await isoHandle.createWritable({ keepExistingData: true });

      // Phase 2: apply just the changed byte-runs. These are tiny and fast; show real progress.
      let done = 0, wrote = 0;
      pg.phase("Writing", `Applying ${total} change${total === 1 ? "" : "s"} (${totalBytes} bytes) in place…`, { pct: 0 });
      for (const [s, e] of runs) {
        await w.write({ type: "write", position: ELF_BASE + s, data: BUF.slice(s, e) });
        done++; wrote += e - s;
        pg.phase("Writing", `Applying change ${done} of ${total}…`, { pct: (done / total) * 100 });
      }
      for (const r of aux) {                       // out-of-block aux windows (potch overlay)
        await w.write({ type: "write", position: r.off, data: r.bytes });
        done++; wrote += r.bytes.length;
        pg.phase("Writing", `Applying change ${done} of ${total}…`, { pct: (done / total) * 100 });
      }

      // Phase 3: commit/rename the copy over the original.
      pg.phase("Finalizing", "Committing changes to the disc…", { indet: true });
      await w.close();

      ORIG = BUF.slice(); ODV = new DataView(ORIG.buffer);   // now clean
      auxMarkSaved();
      drawView();
      pg.done(`Wrote ${wrote} byte(s) across ${total} run(s) to ${isoName}.`, false);
      setStatus(`Saved — ${wrote} byte(s) written in place to ${isoName}.`, "ok");
    } catch (e) {
      pg.done("Write failed: " + e.message + ". Your staged edits are still here — you can retry or export a recipe.", true);
      setStatus("Write failed: " + e.message, "err");
    } finally { setBusy(false); }
  }

  // Streaming save (Android/Firefox/Safari): there's no in-place API for a 4 GB file, so read
  // the source disc in chunks, splice the edited ~3.75 MB region over it, and stream the whole
  // patched copy straight to the device's downloads through our own service worker. Bounded
  // memory (backpressure via the stream's pull()); nothing is uploaded; no third-party helper.
  async function doStreamSave() {
    if (!isoFile) return setStatus("The original ISO isn't available to copy — reopen it and try again.", "err");
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller)
      return setStatus("Saving needs the offline helper active — reload the page once, then reopen the ISO and save.", "warn");

    const m = isoName.match(/\.[^.]+$/);
    const outName = (m ? isoName.slice(0, isoName.length - m[0].length) : isoName || "s3") + ".patched" + (m ? m[0] : ".iso");
    const total = isoFile.size;
    const region = BUF.slice();          // snapshot so mid-save edits can't corrupt the copy
    const auxSnap = auxRuns();           // out-of-block aux edits (potch overlay), same reason
    // Staged character renames → a same-length disc-wide replacer (empty list = pass-through).
    const rn = RenameCore.buildRenames(RENAMES);
    rn.warnings.forEach((w) => setStatus(w, "warn"));
    const replacer = RenameCore.streamReplacer(rn.list);
    const renameNote = rn.list.length ? ` Renaming ${rn.list.map((r) => `${r.origName}→${r.newName.trim()}`).join(", ")}.` : "";
    const pg = progressModal(); setBusy(true);
    try {
      pg.phase("Preparing", `Building a patched copy of ${isoName} (~${fmtSize(total)}).${renameNote} ` +
        `This can take a few minutes for a full disc — keep this tab open and your screen awake. ` +
        `It streams straight to your downloads; nothing is uploaded.`, { indet: true });

      let pos = 0, finished, failed;
      const done = new Promise((res, rej) => { finished = res; failed = rej; });
      // Read the disc in big explicit slices rather than isoFile.stream(). The default stream
      // hands back ~64 KB chunks, so a 4 GB disc becomes ~65,000 round trips — each one a pull,
      // a structured-clone hop into the service worker, and a progress repaint. At 4 MB that
      // is ~1,000, and the next slice is already being read while the current one streams out
      // (the double-buffer below), so disc reads overlap the download instead of alternating.
      const CHUNK = 4 * 1024 * 1024;
      const readAt = (off) => off >= total ? Promise.resolve(null)
        : isoFile.slice(off, Math.min(off + CHUNK, total)).arrayBuffer().then((ab) => new Uint8Array(ab));
      const prefetch = (off) => { const p = readAt(off); p.catch(() => {}); return p; };
      let ahead = prefetch(0);
      // Repainting the modal once per chunk is cheap now, but keep it time-based anyway so the
      // UI can never become the bottleneck if CHUNK is ever lowered.
      let lastUi = 0;
      const uiNow = () => (performance && performance.now ? performance.now() : Date.now());
      const report = () => {
        const t = uiNow();
        if (t - lastUi < 150 && pos < total) return;
        lastUi = t;
        pg.phase("Writing", `Streaming patched ISO to your downloads… ${fmtSize(pos)} / ${fmtSize(total)}`,
          { pct: total ? (pos / total) * 100 : 0 });
      };
      const stream = new ReadableStream({
        async pull(controller) {
          let chunk;
          try { chunk = await ahead; }
          catch (e) { controller.error(e); failed(e); return; }
          if (!chunk) { const tail = replacer.flush(); if (tail.length) controller.enqueue(tail); controller.close(); finished(); return; }
          const start = pos, end = pos + chunk.length;          // bytes at [start, end)
          ahead = prefetch(end);                                // read the next slice meanwhile
          // The chunk is our own freshly-read buffer, so every splice is in place — no defensive
          // copy, and typed-array set() instead of a byte loop over the ~3.75 MB region.
          if (end > ELF_BASE && start < ELF_END) {              // overlaps the editable region
            const a = Math.max(start, ELF_BASE), b = Math.min(end, ELF_END);
            chunk.set(region.subarray(a - ELF_BASE, b - ELF_BASE), a - start);
          }
          for (const r of auxSnap) {                            // aux windows (potch overlay)
            const re = r.off + r.bytes.length;
            if (re > start && r.off < end) {
              const a = Math.max(start, r.off), b = Math.min(end, re);
              chunk.set(r.bytes.subarray(a - r.off, b - r.off), a - start);
            }
          }
          controller.enqueue(replacer.push(chunk));             // disc-wide same-length rename
          pos = end;
          report();
        },
        cancel(reason) { failed(new Error("download cancelled")); },
      });

      // Hand the stream to the service worker, wait for its ack, then trigger the download.
      const id = "iso-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const sw = navigator.serviceWorker.controller;
      await new Promise((res, rej) => {
        const ch = new MessageChannel();
        const to = setTimeout(() => rej(new Error("the offline helper didn't respond")), 5000);
        ch.port1.onmessage = () => { clearTimeout(to); res(); };
        try { sw.postMessage({ type: "dl-register", id, filename: outName, size: total, stream }, [stream, ch.port2]); }
        catch (e) { clearTimeout(to); rej(e); }
      });
      const ifr = document.createElement("iframe");
      ifr.style.display = "none"; ifr.src = "_dl/" + id;
      document.body.appendChild(ifr);

      await done;                                                // resolves when fully streamed
      ORIG = BUF.slice(); ODV = new DataView(ORIG.buffer);       // treat as saved
      auxMarkSaved();
      drawView();
      setTimeout(() => ifr.remove(), 1000);
      pg.done(`Streamed a patched copy — check your downloads for “${outName}”. Replace your ISO with it to play the edits.`, false, { bytes: total });
      setStatus(`Saved a patched copy (${fmtSize(total)}) to your downloads: ${outName}.`, "ok");
    } catch (e) {
      pg.done("Save failed: " + e.message + ". Your edits are still staged — retry, or export a recipe instead.", true);
      setStatus("Save failed: " + e.message, "err");
    } finally { setBusy(false); }
  }

  // Disable the toolbar while a write is in flight (prevents double-saves / racing edits).
  function setBusy(b) {
    ["#isoSaveBtn", "#isoRecipeBtn", "#isoXdeltaBtn", "#isoImportBtn", "#isoResetBtn"].forEach((s) => { const el = q(s); if (el) el.disabled = b; });
  }

  // Non-dismissable progress modal with phase text, a bar (animated or %), and an elapsed timer.
  function progressModal() {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Saving to ISO" style="max-width:460px">
        <div class="modal-h"><b id="pgTitle">Saving to ISO</b></div>
        <div class="pg-body" aria-live="polite">
          <div class="muted" id="pgMsg" style="margin-bottom:12px"></div>
          <div class="bar indet"><div class="bar-fill" id="pgFill" style="width:35%"></div></div>
          <div class="muted pg-meta" id="pgMeta" style="margin-top:8px"></div>
        </div>
        <div class="modal-f" id="pgFoot" style="display:none"><button class="primary" id="pgClose">Done</button></div>
      </div>`;
    document.body.appendChild(ov);
    const el = (id) => ov.querySelector("#" + id), bar = ov.querySelector(".bar"), fill = el("pgFill");
    const t0 = (performance && performance.now) ? performance.now() : Date.now();
    const now = () => ((performance && performance.now) ? performance.now() : Date.now());
    const tick = () => (el("pgMeta").textContent = `elapsed ${((now() - t0) / 1000).toFixed(1)}s`);
    const timer = setInterval(tick, 100); tick();
    return {
      phase(title, msg, { indet = false, pct = null } = {}) {
        el("pgTitle").textContent = title; el("pgMsg").textContent = msg;
        bar.classList.toggle("indet", indet);
        if (!indet) fill.style.width = Math.max(2, Math.min(100, pct == null ? 100 : pct)) + "%";
      },
      done(msg, isErr, extra) {
        clearInterval(timer);
        const ms = now() - t0;
        el("pgTitle").textContent = isErr ? "Save failed" : "Done";
        el("pgMsg").textContent = msg;
        bar.classList.remove("indet"); fill.style.width = "100%"; fill.classList.toggle("err", !!isErr);
        // Completion readout: time taken, plus size + average throughput when a byte total is given.
        const parts = [`⏱ ${fmtDuration(ms)}`];
        if (!isErr && extra && extra.bytes) {
          parts.push(fmtSize(extra.bytes));
          const s = ms / 1000; if (s > 0.2) parts.push(`${fmtSize(extra.bytes / s)}/s`);
        }
        el("pgMeta").textContent = parts.join("  ·  ");
        el("pgFoot").style.display = "flex"; el("pgClose").onclick = () => ov.remove();
        setTimeout(() => el("pgClose").focus(), 20);
      },
    };
  }

  // ---- shareable .s3mod recipe (tiny, reversible, version-checked) -----------
  function exportRecipe() {
    if (!anyChanges()) return setStatus("No changes to export.", "warn");
    const patches = [];
    for (const [s, e] of diffRuns()) {
      let oldHex = "", newHex = "";
      for (let i = s; i < e; i++) { oldHex += hex(ORIG[i], 2).toLowerCase(); newHex += hex(BUF[i], 2).toLowerCase(); }
      patches.push({ off: ELF_BASE + s, old: oldHex, new: newHex });
    }
    for (const r of auxRuns()) {                    // aux windows (potch overlay)
      let oldHex = "", newHex = "";
      for (let i = 0; i < r.bytes.length; i++) { oldHex += hex(r.old[i], 2).toLowerCase(); newHex += hex(r.bytes[i], 2).toLowerCase(); }
      patches.push({ off: r.off, old: oldHex, new: newHex });
    }
    recipeExported = true;
    const mod = { format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
      note: "made with the web ISO editor", patchCount: patches.length, patches };
    const blob = new Blob([JSON.stringify(mod, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (isoName.replace(/\.[^.]+$/, "") || "s3") + ".s3mod";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus(`Exported ${patches.length} patch run(s) as a .s3mod recipe.`, "ok");
  }
  // Export a standard .xdelta (VCDIFF) patch synthesized from the staged edits. Unlike the
  // desktop tool (which shells out to xdelta3 to diff two 4 GB files), we build the patch
  // directly from the edits we already track — no diffing, no upload. Apply anywhere with
  // `xdelta3 -d -s <pristine ISO> file.xdelta out.iso`.
  function exportXdelta() {
    if (!anyChanges()) return setStatus("No changes to export.", "warn");
    if (!isoFile) return setStatus("The original ISO isn't available — reopen it and try again.", "err");
    if (typeof Vcdiff === "undefined") return setStatus("VCDIFF module didn't load — reload the page.", "err");
    const edits = diffRuns().map(([s, e]) => ({ off: ELF_BASE + s, data: BUF.slice(s, e) }))
      .concat(auxRuns().map((r) => ({ off: r.off, data: r.bytes })));   // aux offsets sort after the block
    let patch;
    try { patch = Vcdiff.buildXdelta(isoFile.size, edits); }
    catch (e) { return setStatus("Couldn't build the xdelta patch: " + e.message, "err"); }
    recipeExported = true;
    const blob = new Blob([patch], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (isoName.replace(/\.[^.]+$/, "") || "s3") + ".xdelta";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const nb = edits.reduce((s, e) => s + e.data.length, 0);
    const renameNote = Object.keys(RENAMES).length ? " Character renames are NOT included — those only apply via the streaming save." : "";
    // No integrity checksum (that would need reading the whole 4 GB source), so the patch must
    // be applied to the ORIGINAL pristine disc or it will corrupt silently. Make that explicit.
    setStatus(`Exported an .xdelta patch (${fmtSize(patch.length)}, ${nb} byte(s) changed).${renameNote} ` +
      `⚠ Apply ONLY to a pristine USA SLUS-20387 ISO — this patch has no integrity check, so a wrong or ` +
      `already-modified source corrupts silently (use the .s3mod recipe if you want source-verified edits). ` +
      `Apply with: xdelta3 -d -s "<pristine ISO>" file.xdelta out.iso`, "warn");
  }
  async function importRecipe(file) {
    let mod;
    try { mod = JSON.parse(await file.text()); } catch (e) { return setStatus("Not a valid recipe file.", "err"); }
    if (mod.format !== "s3mod") return setStatus("Not an s3mod recipe.", "err");
    if (mod.versionWord && mod.versionWord !== VERSION_VAL) return setStatus("Recipe is for a different game/region.", "err");
    // Only pay for the deferred tables when the recipe actually reaches outside the ELF
    // block — most don't, and a recipe that stays inside it has no reason to wait on a read.
    if ((mod.patches || []).some((p) => !inBlk(+p.off, (p.new || "").length >> 1))) {
      const err = await tablesForPatch();
      if (err) return setStatus(err, "err");
    }
    let applied = 0, mism = 0;
    for (const p of mod.patches || []) {
      const nb = hexBytes(p.new), ob = p.old ? hexBytes(p.old) : null;
      const off = +p.off;
      if (!inBlk(off, nb.length)) {
        if (inAux(off, nb.length)) {                 // aux windows (potch overlay)
          const w = auxWin(off, nb.length);
          if (ob) for (let i = 0; i < ob.length; i++) if (w.buf[off - w.off + i] !== ob[i]) { mism++; break; }
          auxWriteBytes(off, nb); applied += nb.length;
        }
        continue;
      }
      if (ob) for (let i = 0; i < ob.length; i++) if (BUF[off - ELF_BASE + i] !== ob[i]) { mism++; break; }
      for (let i = 0; i < nb.length; i++) writeW(off + i, 1, nb[i]);
      applied += nb.length;
    }
    drawView();
    setStatus(`Applied recipe — ${applied} byte(s)${mism ? `, ${mism} run(s) didn't match expected originals` : ""}. Review, then Save to write.`, mism ? "warn" : "ok");
  }
  const hexBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };

  // ---- apply an .xdelta (VCDIFF) patch ---------------------------------------
  // The editor could already publish a patch; this lets it consume one, so a phone user can
  // take a community mod without owning a desktop. We do NOT reconstruct the 4 GB target:
  //
  //   1. walk the patch's windows and ask each for its `plan()` — the target spans that
  //      aren't provably an identity copy. A window with none is untouched, and is skipped
  //      without reading a single byte of the disc. Real mod patches touch a few windows.
  //   2. for each touched window, read only ITS source segment + ITS target range from the
  //      disc, decode (the adler32 xdelta3 stores verifies we decoded against the right
  //      source), and diff — giving the exact changed bytes, over-reporting from step 1
  //      washed out.
  //   3. stage those bytes like any other edit, so the import is reviewable, undoable and
  //      revertible instead of being written straight to the disc.
  //
  // Changes outside the editable block can't be staged, so a patch containing any are
  // refused outright rather than applied by halves — a partly-applied mod is worse than none.
  async function applyXdelta(file) {
    if (!isoFile) return setStatus("Load an ISO first.", "err");
    setBusy(true);
    setStatus("Reading patch…", "");
    try {
      const patch = new Uint8Array(await file.arrayBuffer());
      const wins = [];
      const total = Vcdiff.eachWindow(patch, (w) => wins.push(w));
      if (total !== isoFile.size)
        return setStatus(`This patch builds a ${fmtSize(total)} file, but the loaded disc is ` +
          `${fmtSize(isoFile.size)} — it was made for a different image.`, "err");
      if (wins.some((w) => w.fromTarget))
        return setStatus("This patch uses VCD_TARGET windows, which this editor can't apply. " +
          "Apply it with xdelta3 instead.", "err");

      const edits = [];                 // {off, bytes} — exact changed runs, absolute offsets
      let scanned = 0;
      for (let wi = 0; wi < wins.length; wi++) {
        const w = wins[wi];
        if (!w.plan().length) continue;                       // untouched window — no disc I/O
        scanned++;
        setStatus(`Checking patched region ${scanned}… (${fmtSize(w.targetLen)})`, "");
        const src = new Uint8Array(await isoFile.slice(w.sourceStart, w.sourceStart + w.sourceLen).arrayBuffer());
        const out = w.decode(src);                            // throws on checksum mismatch
        const cur = new Uint8Array(await isoFile.slice(w.targetStart, w.targetStart + w.targetLen).arrayBuffer());
        for (let i = 0; i < out.length;) {
          if (out[i] === cur[i]) { i++; continue; }
          const from = i;
          while (i < out.length && out[i] !== cur[i]) i++;
          edits.push({ off: w.targetStart + from, bytes: out.subarray(from, i) });
        }
      }
      if (!edits.length) return setStatus("This patch changes nothing on this disc — it may already be applied.", "warn");

      if (edits.some((e) => !inBlk(e.off, e.bytes.length))) {
        const err = await tablesForPatch();
        if (err) return setStatus(err, "err");
      }
      const outside = edits.filter((e) => !inBlk(e.off, e.bytes.length) && !inAux(e.off, e.bytes.length));
      if (outside.length) {
        const n = outside.reduce((a, e) => a + e.bytes.length, 0);
        return setStatus(`This patch changes ${n} byte(s) outside the region this editor can edit ` +
          `(first at 0x${hex(outside[0].off, 8)}) — nothing was applied. Apply it with xdelta3 instead: ` +
          `xdelta3 -d -s "<pristine ISO>" patch.xdelta out.iso`, "err");
      }
      edits.forEach((e) => (inBlk(e.off, e.bytes.length) ? writeBytes(e.off, e.bytes) : auxWriteBytes(e.off, e.bytes)));
      const n = edits.reduce((a, e) => a + e.bytes.length, 0);
      TEXTS = null; gearCache = null; dropDescCaches();         // staged bytes can move strings
      drawView();
      setStatus(`Applied patch — ${n} byte(s) in ${edits.length} run(s), checksum-verified. ` +
        `Review, then Save to write.`, "ok");
    } catch (e) {
      setStatus(e.message || String(e), "err");
    } finally {
      setBusy(false);
    }
  }

  // ---- top-level render ------------------------------------------------------
  const VIEWS = [["chars", "Characters"], ["growth", "Growth"], ["support", "Support"], ["weapons", "Weapons"],
    ["shops", "Shops"], ["spells", "Spells"], ["unites", "Unites"], ["mounts", "Mounts"], ["gear", "Gear"], ["sets", "Sets"], ["food", "Food"],
    ["balance", "Balance"], ["movement", "Movement"], ["encounter", "Encounter"], ["enemies", "Enemies"], ["war", "War"],
    ["text", "Text"], ["ref", "Reference"], ["test", "Test"]];

  function renderEditor(size) {
    const root = q("#isoRoot");
    const sm = saveMode();
    const saveLabel = sm === "stream" ? "Apply &amp; save patched ISO" : "Apply &amp; save to ISO";
    const saveNote = sm === "stream" ? ` · <span class="muted">saves a patched copy to downloads</span>`
      : sm === "none" ? ` · <span style="color:var(--warn)">read-only here — export a recipe</span>` : "";
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div><b class="acc2">${esc2(isoName)}</b>
            <span class="muted"> · ${fmtSize(size)} · USA SLUS-20387 ✓</span>${saveNote}</div>
          <button id="isoClose" class="chip mini">Close</button>
        </div>
      </div>
      <div class="card">
        <div class="subtabs" id="isoTabs">${VIEWS.map(([k, l]) =>
          `<button class="chip${k === VIEW ? " on" : ""}" data-v="${k}">${l}</button>`).join("")}</div>
        <input class="search" id="isoSearch" placeholder="filter…">
        <div class="muted" id="isoHint" style="margin:2px 0 10px"></div>
        <div id="isoView"></div>
        <div class="toolbar">
          <button class="primary" id="isoSaveBtn"${sm === "none" ? " disabled" : ""}>${saveLabel}</button>
          <span class="pill" id="isoDirty" hidden></span>
          <button id="isoUndoBtn" title="Undo (Ctrl/Cmd+Z)" disabled>↶ Undo</button>
          <button id="isoRedoBtn" title="Redo (Ctrl/Cmd+Shift+Z)" disabled>↷ Redo</button>
          <button id="isoRecipeBtn">Export recipe…</button>
          <button id="isoXdeltaBtn" title="Standard VCDIFF patch (no checksum — apply ONLY to a pristine USA SLUS-20387 ISO): xdelta3 -d -s <pristine ISO> file.xdelta out.iso">Export .xdelta…</button>
          <label class="file" style="margin:0"><button type="button" id="isoImportBtn"
            title="Apply a mod: an .s3mod recipe from this editor, or a standard .xdelta (VCDIFF) patch — built with xdelta3 -S none">Apply patch…</button>
            <input type="file" id="isoRecipeFile" accept=".s3mod,.json,.xdelta,.vcdiff,.xd"></label>
          <button id="isoResetBtn">Revert all</button>
          <span class="status" id="isoStatus"></span>
        </div>
      </div>`;
    qa("[data-v]", root).forEach((b) => (b.onclick = () => { VIEW = b.dataset.v; SEARCH = ""; q("#isoSearch").value = ""; drawView(); }));
    q("#isoSearch").oninput = (e) => { SEARCH = e.target.value.toLowerCase(); drawView(); };
    q("#isoClose").onclick = () => { if (anyChanges() && !confirm("Discard staged edits and close this ISO?")) return; BUF = DV = ORIG = ODV = isoHandle = isoFile = null; AUX = []; resetTables(); renderLoader(); };
    q("#isoSaveBtn").onclick = saveIso;
    q("#isoRecipeBtn").onclick = exportRecipe;
    q("#isoXdeltaBtn").onclick = exportXdelta;
    q("#isoImportBtn").onclick = () => q("#isoRecipeFile").click();
    // One import button, two formats — dispatch on the VCDIFF magic rather than the file
    // name, so a patch saved as "mod.bin" (or a recipe as ".txt") still lands in the right path.
    q("#isoRecipeFile").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      const isVcdiff = head[0] === 0xd6 && head[1] === 0xc3 && head[2] === 0xc4;
      if (isVcdiff) applyXdelta(f); else importRecipe(f);
    };
    q("#isoResetBtn").onclick = () => { if (!anyChanges()) return setStatus("Nothing to revert.", "warn"); BUF.set(ORIG); auxRevertAll(); dropDescCaches(); resetUndo(); drawView(); setStatus("Reverted all staged changes.", "ok"); };
    q("#isoUndoBtn").onclick = undo;
    q("#isoRedoBtn").onclick = redo;
    updateUndoUI();
    drawView();
  }

  // Live "unsaved changes" indicator: count of labeled field changes, or a dot for
  // bulk (Balance) edits that aren't tied to a single field. Also annotates the Save button.
  function updateDirtyBadge() {
    const badge = q("#isoDirty"), btn = q("#isoSaveBtn"); if (!badge || !btn) return;
    const n = buildReview().length;
    if (n > 0) { badge.hidden = false; badge.textContent = `${n} unsaved`; }
    else if (anyChanges()) { badge.hidden = false; badge.textContent = "unsaved changes"; }
    else { badge.hidden = true; }
    btn.textContent = anyChanges() ? "Apply & save to ISO ●" : "Apply & save to ISO";
  }

  function drawView() {
    qa("#isoTabs [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === VIEW));
    const hints = {
      chars: "Character starting stats (list 1): starting skills, ranks, equipped runes and gear.",
      growth: "Per-character stat-growth rates, rune levels, fixed skills, and starting level (list 2).",
      support: "Support-character skill sets (list 3), 8 skill ids each.",
      weapons: "Weapon ATK sharpen curves (list 4): base attack at sharpen levels 1–16.",
      shops: "Every shop counter on the disc, by town: what the item, armour and rune shops sell at each of their four story stages, and the four rare finds each one can roll. Town names are matched to the Suikosource guides; the price ladder and item1 group are the two shared tables that sit alongside them.",
      spells: "Spell / rune-effect table: power, cast (MOV), element, target, area-of-effect, status — plus the damage+heal slot (Shining Wind's split effect, movable to any spell), a rune reskin that edits every spell a rune grants at once, and optional description rewrites.",
      unites: "Unite (co-op) attack table: power, cast (MOV), target, and area-of-effect — plus which characters perform each one (guide reference; the roster itself isn't an editable field).",
      mounts: "Which rider sits on which mount in battle. The game hard-codes exactly three pairs (stock: Hugo+Fubar, Futch+Bright, Franz+Ruby); this rewrites those three comparisons, so any rider with a mounted-battle animation bank can be put on Fubar, Bright or Ruby. Re-pairing is confirmed in-game, including across mount types (Hugo+Bright, Chris+Bright); each combination carries its own confidence marker. Both halves of a pair still have to be in your party for it to trigger, and the formation menu won't show the pairing even when it works.",
      movement: "How fast every character walks and runs on the FIELD \u2014 not in battle. Unlike most of this editor's field work it is not a code patch: speed is a table of 14 rows holding a walk speed, a run speed and a time scale, and a one-byte movement class on each character picks the row. Stock, walking is 2.0 for the whole cast and running is 6.0, 5.0 or 4.5 by class, so running as Hugo covers a third more ground than as Chris. Battle units get these same two fields overwritten at spawn from the character's loaded battle asset, which sits in the packed archives outside the executable, so battle movement is not editable here. Most of the cast can never be the field avatar (that is eight hardcoded ids, on the Test tab) \u2014 they are in the table because every recruit walks around Budehuc Castle and event scripts walk anyone through a scene. Edit a row to retune everyone in it, or change one character's class to give them someone else's speed. Mounts are ordinary field objects with their own class, so a mount's row is the mounted speed. The third column, time scale, is that object's clock multiplier \u2014 the engine multiplies each frame's elapsed time by it before advancing both the character's animation and the step that moves them, so 2.0 both animates and travels at double rate, while raising run alone makes a character skate. Untested in play.",
      test: "Experimental patches that are not known to work. Right now: Field character \u2014 who you run around the map as. That is the party-leader byte at save 0x12, and it names a model \u2014 but the engine only ever requests the model of eight hardcoded ids (Hugo, Chris, Geddoe, Thomas, Koroku, Luc, Masked Luc, Grasslands Chris), which is exactly the set the game hands you itself. This widens that whitelist so the Save Editor's Field character picker can name anyone; the pick itself is a save edit, not an ISO one. Everyone beyond the stock eight is untested \u2014 the model still has to be resident in the area, and story scripts rewrite the leader byte at chapter transitions. Scripted scenes are authored for a specific protagonist and have been seen to hang with anyone else, so treat all of it as roaming-only and keep a backup save.",
      gear: "Equipment records: name, DEF, price, custom description, and all 5 effect slots (type / amount / stat or skill). Names and descriptions are rewritten in place, so each is capped to the character slot the disc already reserves for it — the new name then shows everywhere the game names that item.",
      sets: "Armor sets: which items complete each of the 5 sets, plus the set-bonus constants patched out of the game code (potch multiplier, Destiny counter chance, Pale Moon heal share).",
      food: "Consumable / food table: heal amount and proc chance %.",
      text: "In-ELF UI text: battle messages, menu labels, prize/error prompts and character blurbs. Each string is capped to its original byte length (growing one would need repointing). Story dialogue lives in packed event files off the ELF and is not editable.",
      balance: "Bulk difficulty levers: scale every character's stat-growth rate (and optionally spell/unite power) by a multiplier. Scaled from the ISO's original values, so presets don't compound.",
      encounter: "How often random battles trigger, as one global percentage of the game's stock rate. 100 = unchanged, 50 = half as often, 200 = twice, 0 = none. Per-area base rates live in the packed map archives and aren't editable. Below that, Movement rules control what counts as moving at all \u2014 the game checks which animation you are playing before it rolls, so walking and running can be switched off independently (walk in peace, run to fight), and the run test's second range can be pointed at the animal run cycle so Koroku and Fubar trigger encounters when they run.",
      enemies: "Per-area enemy editor: level, HP, the 8 combat stats, EXP/SP/potch rewards and the drop table, decoded from each area's battle packs and written back to every streaming copy. Suikosource bestiary included as reference.",
      war: "War / major-battle units: level, HP and the 8 combat stats of every war-battle soldier (Zexen, Karaya, Lizard, Duck, Mantor, Harmonian), enemy leader unit and chapter-5 war monster. Your own units use the characters' save stats. Army skill list included as reference.",
      ref: "Reference (read-only): searchable item, rune and skill lookups, where each item comes from, and every packed sub-file on the disc.",
    };
    q("#isoHint").textContent = (VIEW === "ref" && REF_HINT[REF_KIND]) || hints[VIEW] || "";
    const host = q("#isoView");
    // remember which records are expanded so a re-render (e.g. a per-field revert) keeps your place
    const detKey = (d) => d.dataset.i ?? d.dataset.rec ?? d.dataset.base;
    const open = new Set(qa("details.char[open]", host).map(detKey));
    const y = window.scrollY;
    if (VIEW === "chars") { drawCharsView(host); }
    else if (VIEW === "growth") drawGrowth(host);
    else if (VIEW === "support") drawRecords(host, "list3", REF.names.list3, LIST3_FIELDS, false);
    else if (VIEW === "weapons") drawRecords(host, "list4", REF.names.list4, LIST4_FIELDS, false);
    else if (VIEW === "shops") drawShops(host);
    else if (VIEW === "spells") drawSpells(host);
    else if (VIEW === "unites") drawUnites(host);
    else if (VIEW === "mounts") drawMounts(host);
    else if (VIEW === "movement") drawMoveSpeed(host);
    else if (VIEW === "test") drawTest(host);
    else if (VIEW === "gear") drawGear(host);
    else if (VIEW === "sets") drawSets(host);
    else if (VIEW === "food") drawFood(host);
    else if (VIEW === "text") drawText(host);
    else if (VIEW === "balance") drawBalance(host);
    else if (VIEW === "encounter") drawEncounter(host);
    // The three views whose data is read on demand. drawEncounter draws its own global
    // half first — that lives in the ELF block — and gates only the per-area table.
    else if (VIEW === "enemies") { if (needTables(host)) drawEnemies(host); }
    else if (VIEW === "war") { if (needTables(host)) drawWar(host); }
    else if (VIEW === "ref") drawReference(host);
    if (open.size) qa("details.char", host).forEach((d) => {
      if (open.has(detKey(d))) { d.open = true; d.dispatchEvent(new Event("toggle")); }
    });
    window.scrollTo(0, y);
    scheduleBadge();
  }

  // ---- generic record editor (list1 / list3 / list4) ------------------------
  // Characters view = a global "rename character" panel (streaming save applies it disc-wide)
  // followed by the list1 stat records.
  function drawCharsView(host) {
    const rn = (RenameCore.RENAMEABLE || []).map((nm) =>
      `<label class="field" style="max-width:220px"><span>${nm} <span class="muted">(max ${nm.length})</span></span>
         <input type="text" class="rename${RENAMES[nm] ? " dirty" : ""}" data-orig="${nm}" maxlength="${nm.length}" placeholder="${esc2(nm)}" value="${esc2(RENAMES[nm] || "")}"></label>`).join("");
    host.innerHTML = `<div class="card" style="margin:0 0 12px">
        <div class="bag-h">Rename characters <span class="u">experimental · same length only</span></div>
        <div class="warnbox" style="margin:0 0 8px">Replaces the name <b>everywhere on the disc</b> (menus, battle, dialogue). Written by the streaming <b>“save patched copy”</b> — the desktop in-place save can't reach most copies. Same length only (shorter is space-padded). Back up first.</div>
        <div class="grid">${rn}</div></div>
      <div id="charRecs"></div>`;
    qa("input.rename", host).forEach((el) => (el.oninput = () => {
      const orig = el.dataset.orig, v = el.value.trim();
      if (v && v !== orig) RENAMES[orig] = v; else delete RENAMES[orig];
      el.classList.toggle("dirty", !!RENAMES[orig]);
    }));
    drawRecords(q("#charRecs", host), "list1", REF.names.list1, LIST1_FIELDS, true);
  }
  function drawRecords(host, listKey, names, fields, lazy) {
    const [base, stride] = TABLES[listKey];
    const cnt = LIST_COUNT[listKey];
    const rows = [];
    for (let i = 0; i < cnt; i++) {
      const nm = names[String(i)];
      if (!nm && listKey !== "list4") continue;                 // only named roster entries
      const label = nm || `#${i}`;
      if (SEARCH && !label.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, label, base: base + i * stride });
    }
    if (!rows.length) { host.innerHTML = `<div class="muted">no matches</div>`; return; }
    host.innerHTML = rows.map((r) =>
      `<details class="char" data-rec="${r.base}"><summary>
         <span class="chev">▸</span><span class="nm">${esc2(r.label)}</span>
         <span class="muted">#${r.i}</span></summary>
         <div class="char-body"><div class="grid">${lazy ? "" : recFields(r.base, fields, r.label, listKey)}</div></div>
       </details>`).join("");
    qa("details.char", host).forEach((d) => {
      const rec = +d.dataset.rec, lbl = d.querySelector(".nm").textContent;
      if (lazy) d.addEventListener("toggle", () => {
        if (d.open && !d.dataset.built) { d.querySelector(".grid").innerHTML = recFields(rec, fields, lbl, listKey); wireFields(d, rec, lbl); d.dataset.built = "1"; }
      });
      else wireFields(d, rec, lbl);
    });
  }
  // Support characters (list3) don't fight, so only their utility skills (the 0x1C..0x26 block:
  // Potch Finder..Bath) actually do anything — verified 27/27 vs the character guide. Their
  // combat skill slots hold leftover data that never activates, so we fade them for clarity.
  const supportActive = (id) => id >= 0x1C && id <= 0x26;
  function recFields(recBase, fields, group, listKey) {
    // Records physically abut the next table (e.g. list1's last record overlaps list3).
    // Drop any field whose bytes would spill past that boundary so an edit can't corrupt it.
    const safeEnd = Math.min(recBase + 200, nextBoundary(recBase));
    let dropped = 0;
    const html = fields.map(([label, off, w, kind]) => {
      if (recBase + off + w > safeEnd) { dropped++; return ""; }
      let note = "", faded = false;
      if (kind === "item" && /^Rune (Head|Right|Left)/.test(label)) note = runeSlotNote(group, label);
      else if (kind === "num" && /growth/.test(label)) note = growthNote(group, label);
      else if (kind === "skill" && listKey === "list3") {          // Support view: fade unused combat skills
        const v = readW(recBase + off, w);
        if (v && !supportActive(v)) { faded = true; note = `<span class="dim">not used (support characters don't fight)</span>`; }
      }
      return fieldHTML(recBase + off, w, kind, label, note, faded);
    }).join("");
    return html + (dropped ? `<div class="muted" style="grid-column:1/-1">${dropped} field(s) hidden — they overlap the next table and aren't safe to edit on this record.</div>` : "");
  }
  function fieldHTML(off, w, kind, label, note, faded) {
    const v = readW(off, w), dirty = isDirty(off, w) ? " dirty" : "";
    const n = note ? `<div class="fnote">${note}</div>` : "";
    const fc = faded ? " faded" : "";
    if (kind === "item" || kind === "skill") {
      const tip = kind === "skill" ? skillEffectText(v) : itemDesc(v);
      return `<label class="field${fc}"><span>${esc2(label)}</span>
        <button type="button" class="picker${dirty}" data-off="${off}" data-w="${w}" data-kind="${kind}"${tip ? ` title="${esc2(tip)}"` : ""}>${esc2(kind === "item" ? itemLabel(v) : skillLabel(v))}</button>${n}</label>`;
    }
    if (kind === "rank" || kind === "max") {
      const opts = (kind === "rank" ? RANK_OPTS : MAX_OPTS).map(([val, l]) => `<option value="${val}"${val === v ? " selected" : ""}>${l}</option>`).join("");
      return `<label class="field${fc}"><span>${esc2(label)}</span>
        <select class="fsel${dirty}" data-off="${off}" data-w="${w}" data-kind="${kind}">${opts}</select>${n}</label>`;
    }
    const max = w === 1 ? 255 : w === 2 ? 65535 : 4294967295;
    return `<label class="field${fc}"><span>${esc2(label)}</span>
      <input type="number" class="fnum${dirty}" min="0" max="${max}" value="${v}" data-off="${off}" data-w="${w}" data-kind="num">${n}</label>`;
  }
  // ---- guide reference overlays (notes shown under fields) --------------------
  const GRADE_ORDER = ["E", "D", "C", "B", "B+", "A", "A+", "S"];
  // growth stat label (e.g. "PWR growth") -> stat key used in s3_growth_ref.json
  function growthNote(charName, label) {
    const g = REF.growthRef && REF.growthRef[charName]; if (!g) return "";
    const m = /^([A-Z]{2,3}) growth/.exec(label); if (!m) return "";
    const s = g[m[1]]; if (!s) return "";
    const bits = [];
    if (s.rate) bits.push(`rate ${s.rate}`);
    if (s.end) bits.push(`Lv99 ≈ ${s.end}`);
    return bits.length ? `guide: ${esc2(bits.join(" · "))}` : "";
  }
  // per-character skill cap (from the Suikosource skills guide), shown under a Max: field
  function skillCapNote(charName, skillId) {
    const c = REF.skillCaps && REF.skillCaps[charName]; if (!c) return "";
    const g = c[String(skillId)];
    return g ? `guide max: <b>${esc2(g)}</b>` : `<span class="dim">guide: can't learn</span>`;
  }
  // rune-slot state (opens-at level / empty) for a list1 rune field
  function runeSlotNote(charName, label) {
    const r = REF.runeSlots && REF.runeSlots[charName]; if (!r) return "";
    const key = /Head/.test(label) ? "head" : /Right/.test(label) ? "right" : /Left/.test(label) ? "left" : null;
    if (!key || !r[key]) return "";
    const s = r[key];
    if (s.state === "opens") return `guide: slot opens at <b>Lv ${s.lv}</b>`;
    if (s.state === "rune") return `guide: ${esc2(s.rune)}`;
    return `<span class="dim">guide: empty/none</span>`;
  }
  // ---- unite rosters (guide reference — NOT an ISO field) ---------------------
  // Editor/s3_unite_chars.json is the Suikosource unite guide keyed by unite INDEX, because
  // the disc reuses names (Han x3, Adonis x2, Knight B x3) and only the index is unique. 33 of
  // the 38 records are covered; the other five (Griffon, Duck and the three Han rows) aren't in
  // the guide at all — likely enemy/unused — so they say "unknown" rather than show a guess.
  //
  // Membership is READ-ONLY here on purpose: it is not in the 0x28-byte unite record. Every
  // byte/halfword slot in that record was correlated against the 33 known rosters and none
  // holds a member list (the best, +0x26, matches a member in only 15/33 rows — it tracks an
  // animation/model id, not the party requirement). Nor is it a per-character field in list1/
  // list2, nor a 79-bit party bitmask, nor a contiguous id list anywhere in the boot ELF (all
  // four searched, 2026-08-30). The party check lives in battle code, so there is nothing to
  // expose as an editable field. See Editor/Suikoden3_ISO_offsets.md.
  let CHAR_NEEDLES = null;
  function charNeedles() {
    if (CHAR_NEEDLES) return CHAR_NEEDLES;
    const l = (REF.names && REF.names.list1) || {}, out = [];
    for (const k in l) out.push([l[k].toLowerCase(), +k]);
    // the guide spells a few of them its own way
    out.push(["viki(big)", 7], ["viki(small)", 70], ["sanae y", 68]);
    out.sort((a, b) => b[0].length - a[0].length);   // longest first: "Melville" before "Mel"
    return (CHAR_NEEDLES = out);
  }
  const uniteRoster = (i) => {
    const e = REF.uniteChars && REF.uniteChars[String(i)];
    return (e && e.chars) || "";
  };
  // Character ids named in a roster string, in the order they appear. Matching is longest-name
  // first with a claimed-span mask so "Mel" can't be found inside "Melville", and it copes with
  // the guide's prose forms ("Chris and any two: Leo/Percival/Borus", "Futch mounted on Bright").
  function uniteMembers(i) {
    const raw = uniteRoster(i); if (!raw) return [];
    const s = raw.toLowerCase(), taken = new Array(s.length).fill(false), found = [];
    for (const [needle, id] of charNeedles()) {
      for (let p = s.indexOf(needle); p >= 0; p = s.indexOf(needle, p + needle.length)) {
        let free = true;
        for (let k = p; k < p + needle.length; k++) if (taken[k]) { free = false; break; }
        if (!free) continue;
        for (let k = p; k < p + needle.length; k++) taken[k] = true;
        found.push({ id, at: p });
      }
    }
    found.sort((a, b) => a.at - b.at);
    const seen = new Set();
    return found.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  }
  // one-line skill description + a couple of key per-rank effects (for tooltips / reference)
  function skillEffectText(skillId) {
    const r = REF.skillRef && REF.skillRef[String(skillId)]; if (!r) return "";
    let t = r.desc || "";
    if (r.effects && r.effects.length) {
      const e = r.effects[0];
      const at = (g) => e.ranks && e.ranks[g] ? `${g} ${e.ranks[g]}` : null;
      const span = [at("E"), at("A"), at("S")].filter(Boolean).join(" · ");
      if (span) t += `  [${e.label}: ${span}]`;
    }
    return t;
  }
  // Runes are missing from the equipment desc pool (that pool drifts — it's the stray "no" text),
  // but the disc does carry their real menu text in RUNE_TBL, plus the spell table for the spells
  // a magic rune grants. Everything below is read live out of the loaded ISO, so a description
  // edited on the Text/Spells tab shows up in the pickers straight away.
  let SPELL_DESC_BY_NAME = null;   // cache; cleared on ISO load and on every staged byte edit
  function spellDescByName() {
    if (SPELL_DESC_BY_NAME) return SPELL_DESC_BY_NAME;
    const m = {};
    for (let i = 0; i < SPELL.count; i++) {
      const o = SPELL.off + i * SPELL.stride, nm = strAt(r32(o + 0x08));
      if (nm && !(nm in m)) m[nm] = strAt(r32(o + 0x0C));
    }
    return (SPELL_DESC_BY_NAME = m);
  }
  // The rune's own menu text, straight out of RUNE_TBL. The table is item-id indexed and its
  // unused rows are zeroed, so we only trust a record whose name string still matches the item
  // (case/punctuation-insensitive — the disc writes "Sword of Rage", the id list "Sword Of Rage").
  const nameKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  function runeTblDesc(id) {
    if (id < RUNE_TBL.lo || id > RUNE_TBL.hi) return "";
    const o = RUNE_TBL.off + id * RUNE_TBL.stride;
    if (!inBlk(o, RUNE_TBL.stride)) return "";
    const nm = strAt(r32(o + RUNE_TBL.name));
    if (!nm || nameKey(nm) !== nameKey(REF.items[id] || "")) return "";
    return strAt(r32(o + RUNE_TBL.desc));
  }
  function runeDesc(id) {
    if (!BUF || REF.cats[id] !== "Runes") return "";     // only runes; avoids name clashes (e.g. Fire Amulet)
    const nm = REF.items[id]; if (!nm) return "";
    const own = runeTblDesc(id);                          // what the game prints in the rune menu
    const byName = spellDescByName();
    const key = nm.toLowerCase().replace(/\s+/g, "").replace(/rune$/, "");   // magic rune → RUNE_SPELLS
    const set = RUNE_SPELLS[key];
    if (set && set.length) {                              // magic rune: name the spells it grants
      const grants = `Grants ${set.join(", ")}`;
      if (own) return `${own} — ${grants}`;
      const d0 = byName[set[0]];
      return grants + (d0 ? ` — ${set[0]}: ${d0}` : "");
    }
    return own || byName[nm] || "";                       // command/attack rune (name == spell)
  }
  // Food items also lack a name<->desc record, but the Food effect table (0x3E91D0) has a name
  // pointer + desc/heal — so we map food item -> its dish record and show "Heals NNN HP" (live,
  // and it reflects Food-tab edits). Unused dishes carry a non-ASCII placeholder; we skip those.
  let FOOD_DESC_BY_NAME = null;   // cache; cleared on ISO load
  function foodDescByName() {
    if (FOOD_DESC_BY_NAME) return FOOD_DESC_BY_NAME;
    const m = {};
    for (let i = 0; i < FOOD.count; i++) {
      const o = FOOD.off + i * FOOD.stride, nm = strAt(r32(o + FOOD.name));
      if (!nm) continue;
      let d = strAt(r32(o + FOOD.desc));
      if (!/^[\x20-\x7E]+$/.test(d)) { const heal = readW(o + FOOD.heal, 2); d = heal ? `Heals ${heal}HP` : ""; }
      if (d && !(nm.toLowerCase() in m)) m[nm.toLowerCase()] = d;
    }
    return (FOOD_DESC_BY_NAME = m);
  }
  function foodDesc(id) {
    if (!BUF || REF.cats[id] !== "Food Items") return "";
    const nm = REF.items[id]; return nm ? (foodDescByName()[nm.toLowerCase()] || "") : "";
  }
  // Both maps above are keyed by a name string read out of the ISO, so a staged edit can change
  // either side of the pair. Every edit funnels through commitEdit/undo/redo, which calls this —
  // the next picker or tooltip then rebuilds from the current bytes (94 + 60 records, cheap).
  // Rune and gear text is read per call, so it needs no cache to drop.
  // CLASS_NAMES reads strings out of BUF, so a staged edit to a class word must drop it too.
  // DESC_ALIAS is keyed on ORIG and so never goes stale mid-session — only on a new ISO (below).
  function dropDescCaches() { SPELL_DESC_BY_NAME = null; FOOD_DESC_BY_NAME = null; CLASS_NAMES = null; }
  // Equipment carries its description in its own gear record, so read that live too — a
  // description rewritten on the Gear tab then shows up in every picker and tooltip. The
  // bundled s3_item_desc.json stays as the fallback for items scanGear can't pin down.
  // Equipment carries its own name string as well as its description, so read that live too — a
  // rename made on the Gear tab then shows up in every picker, tooltip and review row.
  function gearName(id) {
    if (!BUF || !REF) return "";
    const g = scanGear()[id];
    if (!g) return "";
    const np = r32(g + GEAR.name);
    return np ? strAt(np) : "";
  }
  function gearDesc(id) {
    if (!BUF) return "";
    const g = scanGear()[id];
    return g ? strAt(r32(g + 0x00)) : "";
  }
  // desc to show for an item id in pickers/tooltips: rune text (rune table + spell table) or
  // food effect (food table) win for those categories, otherwise the equipment desc record.
  const itemDesc = (id) => runeDesc(id) || foodDesc(id) || gearDesc(id) || REF.idesc[id] || "";
  function wireFields(scope, recBase, group) {
    qa("button.picker[data-off]", scope).forEach((btn) => {
      const off = +btn.dataset.off, w = +btn.dataset.w, kind = btn.dataset.kind;
      const label = btn.parentElement.querySelector("span").textContent;
      btn.onclick = () => {
        const cur = readW(off, w);
        const opts = kind === "item" ? itemOpts(slotCat(label)) : skillOpts();
        if (cur && !opts.some((o) => o.id === cur)) opts.splice(1, 0, { id: cur, name: kind === "item" ? itemName(cur) : skillName(cur) });
        openPicker(label, opts, cur, (id) => {
          writeW(off, w, id); reg(off, w, kind, group, label);
          btn.textContent = kind === "item" ? itemLabel(id) : skillLabel(id);
          const tip = kind === "skill" ? skillEffectText(id) : itemDesc(id);
          if (tip) btn.title = tip; else btn.removeAttribute("title");
          markField(btn, off, w, kind);
        }, (id) => hex(id, kind === "item" ? 3 : 2));
      };
      markField(btn, off, w, kind);          // initialise ↺ / highlight for already-changed fields
    });
    qa("select.fsel[data-off]", scope).forEach((sel) => {
      const off = +sel.dataset.off, w = +sel.dataset.w, kind = sel.dataset.kind;
      const label = sel.parentElement.querySelector("span").textContent;
      sel.onchange = () => { writeW(off, w, +sel.value); reg(off, w, kind, group, label); markField(sel, off, w, kind); };
      markField(sel, off, w, kind);
    });
    qa("input.fnum[data-off]", scope).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      const label = inp.parentElement.querySelector("span").textContent;
      inp.onchange = () => {
        writeW(off, w, Math.max(0, Math.min(+inp.value || 0, w === 1 ? 255 : w === 2 ? 65535 : 4294967295)));
        reg(off, w, "num", group, label); markField(inp, off, w, "num");
      };
      markField(inp, off, w, "num");
    });
  }

  // ---- growth (list2: growth + fixed skills + skill-max array) ---------------
  function drawGrowth(host) {
    const [base, stride] = TABLES.list2, names = REF.names.list2, cnt = LIST_COUNT.list2;
    const rows = [];
    for (let i = 0; i < cnt; i++) {
      const nm = names[String(i)]; if (!nm) continue;
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, label: nm, base: base + i * stride });
    }
    if (!rows.length) { host.innerHTML = `<div class="muted">no matches</div>`; return; }
    host.innerHTML = rows.map((r) =>
      `<details class="char" data-rec="${r.base}"><summary>
         <span class="chev">▸</span><span class="nm">${esc2(r.label)}</span><span class="muted">#${r.i}</span></summary>
         <div class="char-body"></div></details>`).join("");
    qa("details.char", host).forEach((d) => {
      const rec = +d.dataset.rec, lbl = d.querySelector(".nm").textContent;
      const build = () => {
        const body = d.querySelector(".char-body");
        const skillmax = [];
        for (let k = 0; k < 43; k++) skillmax.push(fieldHTML(rec + LIST2_SKILLMAX_START + k, 1, "max", "Max: " + skillName(k + 1), skillCapNote(lbl, k + 1)));
        const hasCaps = REF.skillCaps && REF.skillCaps[lbl];
        const presets = `<div class="subtabs" style="margin:4px 0 8px">
          ${hasCaps ? `<button class="chip" data-cap="guide">Set to guide caps</button>` : ""}
          <button class="chip" data-cap="max">Max all (S)</button>
          <button class="chip" data-cap="none">Clear all</button></div>`;
        body.innerHTML =
          `<h4>Growth rates</h4><div class="grid">${recFields(rec, LIST2_GROWTH, lbl)}</div>
           <h4>Fixed skills &amp; start</h4><div class="grid">${recFields(rec, LIST2_FIXED, lbl)}</div>
           <h4>Skill maximum levels</h4>${presets}<div class="grid">${skillmax.join("")}</div>`;
        wireFields(d, rec, lbl);
        qa("[data-cap]", body).forEach((b) => (b.onclick = () => { applyCapPreset(rec, lbl, b.dataset.cap); build(); }));
      };
      d.addEventListener("toggle", () => { if (d.open && !d.dataset.built) { build(); d.dataset.built = "1"; } });
    });
  }
  // Bulk-set a character's 43 skill-max bytes: guide caps (from the Suikosource guide),
  // all-S, or all "Can't get". Staged like any edit (revertible; nothing written until Save).
  function applyCapPreset(rec, lbl, mode) {
    const caps = (REF.skillCaps && REF.skillCaps[lbl]) || {};
    for (let k = 0; k < 43; k++) {
      const off = rec + LIST2_SKILLMAX_START + k;
      let v;
      if (mode === "max") v = 7;
      else if (mode === "none") v = 0;
      else { const g = caps[String(k + 1)]; v = g != null && MAX_BY_GRADE[g] != null ? MAX_BY_GRADE[g] : 0; }
      writeW(off, 1, v); reg(off, 1, "max", lbl, "Max: " + skillName(k + 1));
    }
  }

  // ---- shops -----------------------------------------------------------------
  // Three parallel counters (item / armour / rune), each 14 locations x 4 story stages of a
  // 0x7C record. Address arithmetic straight out of the disc's own accessor at VA 0x170DDF8:
  //     rec(kind, loc, stage) = base[kind] + loc*0x1F0 + stage*0x7C      (0x1F0 == 4 * 0x7C)
  // A record is 30 zero-terminated u16 stock slots at +0x00 (the enumerator at 0x176C948 caps
  // its scan at 30, which is exactly the 60 bytes before the rarity block), then four 16-byte
  // "rarity" / rare-find entries at +0x3C (accessor 0x170DFB0: `if (n >= 4) return 0;
  // return rec + (n << 4) + 0x3C`). Town names come from Editor/s3_shops.json — see
  // Editor/build_shop_index.py for how each one is pinned to a guide-attested rarity item.
  //
  // The rarity roll itself is decoded from 0x170E63C, which is what makes three of the entry's
  // fields editable here rather than raw bytes:
  //     if (item == 0) return 0;                                  // empty slot
  //     qty = max(0, base + (int)(spread * (rand(100) - 50) / 100));
  //     return chance < rand(100) ? 0 : qty;                      // <- appearance test
  // with chance = u8 @+0x0A, base = u8 @+0x0B, spread = u8 @+0x0C. The u16s at +0x02..+0x08
  // feed a separate price computation and are left alone.
  let SHOP_LOC = 0, SHOP_STAGE = 0, SHOP_EMPTY = false;

  function shopRec(kind, loc, stage) {
    const k = SHOPS.kinds.find((x) => x.k === kind);
    return k.base + loc * SHOPS.varStride + stage * SHOPS.stride;
  }
  // Which stages of a counter carry anything (a stock head or a rarity item).
  function shopStages(kind, loc) {
    let n = 0;
    for (let v = 0; v < SHOPS.stages; v++) {
      const rec = shopRec(kind, loc, v);
      if (readW(rec, 2) || readW(rec + SHOPS.rarOff, 2)) n = v + 1;
    }
    return n;
  }
  const shopLocName = (loc) => {
    const m = (REF.shops && REF.shops.locationNames && REF.shops.locationNames[loc]) || null;
    return m ? m.name : `Location ${loc} (unidentified)`;
  };
  // Buy price, when the item has a gear record. Consumables have none, so they show "—".
  function shopPrice(id) {
    const g = id && scanGear()[id];
    return g ? readW(g + GEAR.price, 4) : null;
  }

  function drawShops(host) {
    // locations with at least one stocked counter, so the picker never offers a dead entry
    const locs = [];
    for (let l = 0; l < SHOPS.locs; l++) {
      const kinds = SHOPS.kinds.filter((k) => shopStages(k.k, l) > 0);
      if (kinds.length) locs.push({ loc: l, kinds });
    }
    if (!locs.some((x) => x.loc === SHOP_LOC)) SHOP_LOC = locs.length ? locs[0].loc : 0;
    const here = locs.find((x) => x.loc === SHOP_LOC) || { loc: SHOP_LOC, kinds: [] };
    const maxStage = Math.max(1, ...here.kinds.map((k) => shopStages(k.k, SHOP_LOC)));
    if (SHOP_STAGE >= maxStage) SHOP_STAGE = 0;

    const meta = (REF.shops && REF.shops.locationNames && REF.shops.locationNames[SHOP_LOC]) || null;
    const locOpts = locs.map((x) => `<option value="${x.loc}"${x.loc === SHOP_LOC ? " selected" : ""}>${esc2(shopLocName(x.loc))} — ${x.kinds.map((k) => k.name.replace(" Shop", "")).join("/")}</option>`).join("");
    const stageOpts = Array.from({ length: maxStage }, (_, i) =>
      `<option value="${i}"${i === SHOP_STAGE ? " selected" : ""}>Stage ${i + 1} of ${maxStage}</option>`).join("");

    let h = `<div class="card" style="margin-bottom:10px">
      <div style="display:grid;gap:8px;justify-items:start">
        <label style="display:block;width:100%;max-width:26em">Location
          <select id="shopLoc" style="display:block;width:100%">${locOpts}</select></label>
        <label style="display:block;width:100%;max-width:26em">Story stage
          <select id="shopStage" style="display:block;width:100%">${stageOpts}</select></label>
        <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="shopEmpty"${SHOP_EMPTY ? " checked" : ""}> <span>show empty slots</span></label>
      </div>
      <div class="muted" style="margin-top:6px">Each counter keeps four inventories and the game
        swaps between them as the story advances, so stage 1 is the earliest stock and the last
        stage the richest. The stock list ends at the first empty slot — anything after a gap is
        invisible in-game.</div>
      ${meta ? `<div class="muted" style="margin-top:4px"><b>${esc2(meta.name)}</b> — ${esc2(meta.evidence)}</div>`
             : `<div class="muted" style="margin-top:4px">This counter's rarities are all generic
                consumables, so no town could be pinned to it. It is left unnamed rather than guessed.</div>`}
    </div>`;

    for (const k of here.kinds) {
      const stages = shopStages(k.k, SHOP_LOC);
      if (SHOP_STAGE >= stages) {
        h += `<div class="bag"><div class="bag-h">${k.name} — ${esc2(shopLocName(SHOP_LOC))}
          <span class="u">not open at this stage (only ${stages} of ${SHOPS.stages})</span></div></div>`;
        continue;
      }
      const rec = shopRec(k.k, SHOP_LOC, SHOP_STAGE);
      // find the last used slot so we can hide the empty tail unless asked
      let last = -1, gap = false;
      for (let i = 0; i < SHOPS.stock; i++) if (readW(rec + i * 2, 2)) last = i;
      for (let i = 0; i < last; i++) if (!readW(rec + i * 2, 2)) gap = true;
      const show = SHOP_EMPTY ? SHOPS.stock : Math.min(SHOPS.stock, last + 2);

      let rows = "";
      for (let i = 0; i < show; i++) {
        const o = rec + i * 2, v = readW(o, 2), pr = shopPrice(v);
        const cut = !v && i <= last ? ` <span class="shop-gap">gap — hides the rest</span>` : "";
        rows += `<tr><td class="sl">${i + 1}</td><td>
          <button type="button" class="picker shopitem" data-off="${o}" data-kind="${k.k}"${v && itemDesc(v) ? ` title="${esc2(itemDesc(v))}"` : ""}>${esc2(itemLabel(v))}</button>${cut}</td>
          <td class="num">${pr == null ? "—" : pr.toLocaleString() + " potch"}</td></tr>`;
      }
      let rar = "";
      for (let n = 0; n < SHOPS.rarCount; n++) {
        const ro = rec + SHOPS.rarOff + n * SHOPS.rarStride, v = readW(ro, 2);
        const num = (o, cls, max, tip) =>
          `<input type="number" class="${cls}" min="0" max="${max}" title="${esc2(tip)}" data-off="${o}" value="${readW(o, 1)}">`;
        rar += `<tr><td class="sl">${n + 1}</td><td>
          <button type="button" class="picker shoprare" data-off="${ro}" data-kind="${k.k}"${v && itemDesc(v) ? ` title="${esc2(itemDesc(v))}"` : ""}>${esc2(itemLabel(v))}</button></td>
          <td class="num rar"><div class="rar-n">${num(ro + 0x0A, "shopchance", 100, "Appearance chance out of 100 — the item is absent this visit when the roll beats it")}
            ${num(ro + 0x0B, "shopqty", 255, "How many are in stock when it does appear")}
            ${num(ro + 0x0C, "shopspread", 255, "Random swing on that quantity: base ± spread/2")}</div></td></tr>`;
      }
      h += `<div class="bag"><div class="bag-h">${k.name} — ${esc2(shopLocName(SHOP_LOC))}
          <span class="u">stage ${SHOP_STAGE + 1} of ${stages} · record @0x${hex(rec, 6)}</span></div>
        ${gap ? `<div class="muted" style="color:var(--warn);margin:4px 0">This list has an empty slot before its last item — the game stops reading there, so the items past the gap never appear.</div>` : ""}
        <table class="invtbl fixed"><thead><tr><th>Slot</th><th>Item on sale</th><th class="num">Price</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="bag-h" style="margin-top:8px">Rarity <span class="u">rare finds — each is rolled on entry: it appears if a 1-in-100 draw comes in under its %, then stocks qty ± spread/2</span></div>
        <table class="invtbl fixed"><thead><tr><th>#</th><th>Item</th><th class="num rar">% · qty · ±</th></tr></thead><tbody>${rar}</tbody></table>
      </div>`;
    }

    const numBlk = (title, spec, note) => {
      const [off, cnt, w] = spec;
      let rows = "";
      for (let i = 0; i < cnt; i++) {
        const o = off + i * w, v = readW(o, w);
        rows += `<tr><td class="sl">${i}</td><td>
          <input type="number" class="shopnum" min="0" max="4294967295" style="width:140px" data-off="${o}" data-w="${w}" value="${v}"></td></tr>`;
      }
      return `<div class="bag"><div class="bag-h">${title} <span class="u">${note}</span></div>
        <table class="invtbl"><thead><tr><th>#</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    // Neither of these belongs to a town — they are single global tables that would otherwise
    // dominate the page under every counter, so they fold away.
    h += `<details class="shop-extra"><summary>Shared tables — price ladder and the item1 group</summary>
        ${numBlk("Price ladder", PRICE_LADDER, "15 potch steps, u32 — a shared price scale, not item ids")}
        ${numBlk("item1 group", ITEM1, "3 x u32, meaning not yet identified")}</details>`;
    host.innerHTML = h;

    q("#shopLoc", host).onchange = (e) => { SHOP_LOC = +e.target.value; SHOP_STAGE = 0; drawView(); };
    q("#shopStage", host).onchange = (e) => { SHOP_STAGE = +e.target.value; drawView(); };
    q("#shopEmpty", host).onchange = (e) => { SHOP_EMPTY = e.target.checked; drawView(); };

    const wireItem = (sel, what) => qa(sel, host).forEach((btn) => {
      const off = +btn.dataset.off, kind = +btn.dataset.kind;
      const group = `${shopLocName(SHOP_LOC)} ${SHOPS.kinds.find((x) => x.k === kind).name}`;
      const label = `Stage ${SHOP_STAGE + 1} ${what}`;
      btn.onclick = () => {
        const cur = readW(off, 2);
        const opts = itemOpts(kind === 3 ? "Runes" : "");
        if (cur && !opts.some((o) => o.id === cur)) opts.splice(1, 0, { id: cur, name: itemName(cur), desc: itemDesc(cur) });
        openPicker(`${group} — ${label}`, opts, cur, (id) => {
          writeW(off, 2, id); reg(off, 2, "item", group, label);
          drawView();                                  // price / gap warning move with the pick
        }, (id) => hex(id, 3));
      };
      markField(btn, off, 2, "item");
    });
    wireItem("button.shopitem", "stock slot");
    wireItem("button.shoprare", "rarity");

    for (const [sel, what, cap] of [["input.shopchance", "rarity chance %", 100],
                                    ["input.shopqty", "rarity quantity", 255],
                                    ["input.shopspread", "rarity spread", 255]]) {
      qa(sel, host).forEach((inp) => {
        const off = +inp.dataset.off, group = `${shopLocName(SHOP_LOC)} shops`;
        inp.onchange = () => {
          const v = Math.min(cap, Math.max(0, +inp.value || 0));
          inp.value = v; writeW(off, 1, v);
          reg(off, 1, "num", group, `Stage ${SHOP_STAGE + 1} ${what}`); markField(inp, off, 1, "num");
        };
        markField(inp, off, 1, "num");
      });
    }
    qa("input.shopnum", host).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      inp.onchange = () => { writeW(off, w, Math.max(0, +inp.value || 0)); reg(off, w, "num", "Shops", `value @0x${hex(off, 6)}`); markField(inp, off, w, "num"); };
      markField(inp, off, w, "num");
    });
  }

  // ---- spells ----------------------------------------------------------------
  function spellNameIndex() {
    const m = {};
    for (let i = 0; i < SPELL.count; i++) { const n = strAt(r32(SPELL.off + i * SPELL.stride + 0x08)); if (!(n in m)) m[n] = i; }
    return m;
  }
  // Shared edit engine for a spell record (used by per-spell controls AND rune reskin).
  function applySpell(idx, f, updateDesc) {
    const off = SPELL.off + idx * SPELL.stride, name = strAt(r32(off + 0x08));
    let descRes = null;
    if (f.power != null) {
      writeW(off + 0x1C, 4, Math.max(0, f.power)); reg(off + 0x1C, 4, "num", name, "Power");
      if (updateDesc) descRes = rewriteDesc(r32(off + 0x0C), (t) => descPower(t, Math.max(0, f.power)), name, "Description");
    }
    if (f.cast != null) { writeW(off + 0x10, 4, Math.max(0, f.cast)); reg(off + 0x10, 4, "num", name, "Cast"); }
    if (f.elementId != null && idx + 1 < SPELL.count) {
      const eo = off + SPELL.elem; writeW(eo, 2, (r16(eo) & 0xFF00) | (f.elementId & 0xFF)); reg(eo, 2, "elem", name, "Element");
    }
    if (f.target != null) { let v = r32(off + 0x14); v = (v & 0xFFFF80FF) | ((f.target & 0x7F) << 8); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Target"); }
    if (f.aoe != null) { let v = r32(off + 0x14); v = f.aoe ? (v | AREA_BIT) : (v & ~AREA_BIT); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Area of effect"); }
    // statusMask writes flags18 whole, so a composite record (e.g. the 0x1DE7 restore-all
    // spells) survives an edit instead of being flattened to a single bit. f.status is the older
    // one-of form, still used by the rune-reskin card's dropdown.
    if (f.statusMask != null) { writeW(off + 0x18, 4, f.statusMask >>> 0); reg(off + 0x18, 4, "status", name, "Status"); }
    else if (f.status != null) { const rev = {}; for (const b in F18_BITS) rev[F18_BITS[b]] = 1 << b; writeW(off + 0x18, 4, f.status === "none" ? 0 : (rev[f.status] || 0)); reg(off + 0x18, 4, "status", name, "Status"); }
    if (f.radius != null && idx + 1 < SPELL.count) {
      const ro = off + SPELL.radius; writeW(ro, 1, clampInt(f.radius, 0, 255)); reg(ro, 1, "num", name, "Radius");
    }
    if (f.chance != null && idx + 1 < SPELL.count) {
      const co = off + SPELL.chance; writeW(co, 2, clampInt(f.chance, 0, 100)); reg(co, 2, "num", name, "Status chance %");
    }
    return descRes;
  }
  // ---- the flags18 effect editor ---------------------------------------------
  // One checkbox per known bit, plus a checkbox for any bit that is SET but unlabelled (so an
  // unknown bit is visible and preserved rather than silently dropped), plus a raw-hex escape
  // hatch for authoring a bit nobody has named yet. The mask is rebuilt from the boxes on every
  // change, which is what keeps a composite record composite.
  const f18UnknownBits = (v) => {
    const out = [];
    for (let b = 0; b < 32; b++) if (((v >>> b) & 1) && !(b in F18_BITS)) out.push(b);
    return out;
  };
  function f18CtlHTML(i, v) {
    const box = (b, unknown) => `<label class="row" style="gap:6px;cursor:pointer;margin:0;align-items:baseline">
        <input type="checkbox" class="sp18" data-i="${i}" data-b="${b}"${((v >>> b) & 1) ? " checked" : ""}>
        <span${unknown ? ' class="warn"' : ""}>${esc2(F18_TEXT[b] || `bit ${b} — unknown, keep unless you know better`)}
          <span class="u">0x${hex(1 << b, 4)}</span></span></label>`;
    const known = F18_ORDER.map((b) => box(b, false)).join("");
    const unk = f18UnknownBits(v).map((b) => box(b, true)).join("");
    return `<div class="field" style="grid-column:1/-1">
        <span>Effects / status <span class="muted">(flags18 · any combination)</span></span>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:2px 14px;margin:4px 0 6px">${known}${unk}</div>
        <label class="row" style="gap:6px;margin:0;align-items:baseline"><span class="muted">raw mask 0x</span>
          <input type="text" class="sp18hex" data-i="${i}" value="${hex(v, 8)}" style="width:11ch" spellcheck="false"></label>
        <div class="muted" style="margin-top:4px">${esc2(F18_NOTE)}</div></div>`;
  }
  // Same escape hatch the target dropdown has: a byte with no named option still shows, and
  // still round-trips, instead of silently reading back as whatever option happens to be first.
  const elemOptsHTML = (cur) => {
    let html = Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}"${+v === cur ? " selected" : ""}>${l}</option>`).join("");
    if (!(cur in ELEMENTS)) html += `<option value="${cur}" selected>${elemName(cur)} (0x${hex(cur, 2)})</option>`;
    return html;
  };
  const targetOptsHTML = (cur) => {
    let html = TARGET_OPTS.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
    if (!TARGET_OPTS.some(([v]) => v === cur)) html += `<option value="${cur}" selected>custom 0x${hex(cur, 2)}</option>`;
    return html;
  };
  // ---- Status effect STRENGTH (engine constants) ------------------------------
  // What a status effect actually DOES — how much damage "adds lightning damage to physical
  // attacks" adds, how much an Amulet's resistance cuts incoming damage, how much the PDF/MDF
  // buff and the MGC boost are worth. None of it is a data table; every one of these is an
  // `addiu $rt, $zero, imm` instruction immediate in the battle code, which is the same class
  // of patch the editor already makes for encounter rates, the potch multiplier, the mount
  // pairs and the damage+heal slot.
  //
  // How they were found (all re-checkable with Editor/re_elf.py):
  //   * The flags18 bit is only a SELECTOR. The translator at VA 0x1816400 remaps flags18 into a
  //     character state word and carries no magnitude at all — bits 22|23|24 (sword fire /
  //     lightning / wind) collapse into ONE "weapon enchanted" flag 0x10000000, losing even the
  //     element. So no per-bit strength field exists to edit, which is why the effect editor on
  //     the Spells tab can only change WHICH effect fires.
  //   * VA 0x16BFC50 is where the enchant's element is recovered and turned into a percentage:
  //     bit22 -> 20, bit23 -> 20, otherwise 15, plus the chanter's Sword of Magic (skill 0x29)
  //     rank, then `base * percent / 100`.
  //   * VA 0x16BAC7C adds a further flat +30% when the weapon is enchanted at all.
  //   * VA 0x17FFE3C is the elemental resistance ladder: incoming damage is scaled to
  //     120 / 80 / 60 / 40 percent by tier, each an immediate.
  //   * VA 0x16BD010 and VA 0x16BDBDC both scale by 85 under the buff-PDF/MDF bit (two sites,
  //     one constant — they are written together, like the potch overlay pair).
  //   * VA 0x16BDC0C is the mgc-boost multiplier, 150.
  //
  // Cross-checked against the guides in Guides/. Two results worth keeping:
  //   * The RPGClassics status page says poison deals damage "depending on the type of poison" —
  //     independent corroboration that poison carries a strength, which is exactly what the setter
  //     at VA 0x16BE920 stores for it: `(level & 7) << 2`, a 3-bit value.
  //   * The Suikosource Rare Armor guide says elemental resistance reduces damage by 20% / 30% /
  //     40% at levels 1/2/3. The decoded ladder is 80 / 60 / 40 percent DAMAGE TAKEN, i.e.
  //     reductions of 20 / 40 / 60. Level 1 agrees exactly; levels 2 and 3 do not, and no
  //     arithmetic on the decoded values produces 30/40. The jump table is read directly off the
  //     disc and is unambiguous, so the values stand; what is an inference is the tier -> "level N"
  //     naming, and that is the likely site of the disagreement. Flagged in the UI, not smoothed over.
  //
  // Still open, with the numbers to look for if anyone wants them: the RPGClassics page says Alert
  // doubles offensive magic with a 20% chance to backfire, Berserk raises strength 50%, and Boost
  // lasts three turns. A 150 (= +50%) does exist here but it is gated on mask 0x4000, which this
  // repo labels mgc-boost rather than berserk, so it is NOT presented as the berserk figure.
  //
  // Two honest limits, stated in the UI as well:
  //   * These are CODE constants, so they are global. Raising the fire-enchant percentage raises
  //     it for every character and every Sword of Rage in the game — there is no per-rune copy.
  //   * Duration (how many turns sleep lasts, how long poison ticks) is still not reachable. The
  //     status setter at VA 0x16BE920 does take a level argument — poison stores `(level & 7) << 2`,
  //     a real 3-bit strength — but every live call site computes that level at runtime rather than
  //     reading an immediate, and the one routine that does read per-status levels out of a record
  //     (VA 0x16BF1E0, a byte array of them at +0x00..+0x22) has ZERO references anywhere in the
  //     ELF: no jal, no j, no lui/addiu materialisation, no data pointer. It is dead code.
  const STATUSFX = [
    { g: "Weapon enchant", key: "swFire", stock: 20, max: 500,
      label: "Sword of Rage — fire damage added",
      help: "Percent of the base value added when the weapon is enchanted with fire (flags18 bit 22).",
      sites: [[0x107470, 0x24100014]] },
    { g: "Weapon enchant", key: "swLightning", stock: 20, max: 500,
      label: "Sword of Thunder — lightning damage added",
      help: "Percent added when the weapon is enchanted with lightning (flags18 bit 23).",
      sites: [[0x107480, 0x24030014]] },
    { g: "Weapon enchant", key: "swWind", stock: 15, max: 500,
      label: "Sword of Cyclone — wind damage added",
      help: "The fall-through percentage, which is what wind (flags18 bit 24) gets. Shared with any "
        + "enchant that is neither fire nor lightning, so treat it as the default rather than wind-only.",
      sites: [[0x107478, 0x2410000F]] },
    { g: "Weapon enchant", key: "swAny", stock: 30, max: 500,
      label: "Any enchanted weapon — extra bonus",
      help: "A further flat percentage added whenever the weapon is enchanted at all, on top of the "
        + "per-element figure above. Gated on the single \u201cweapon enchanted\u201d state flag "
        + "(0x10000000) that bits 22|23|24 all collapse into.",
      sites: [[0x102488, 0x2402001E]] },
    { g: "Elemental resistance", key: "resWeak", stock: 120, max: 500,
      label: "Weak to the element — damage taken",
      help: "Incoming elemental damage is scaled to this percent when the target is weak to it.",
      sites: [[0xE3868, 0x24040078], [0x24765C, 0x24020078]] },
    { g: "Elemental resistance", key: "resNeutral", stock: 100, max: 500,
      label: "Neither weak nor resistant — damage taken",
      help: "The neutral tier. Only the jump-table ladder has an explicit entry for it, so this is a "
        + "single site — and because it is the default for most damage, changing it is a broad nerf or "
        + "buff to elemental magic across the board.",
      sites: [[0xE3870, 0x24040064]] },
    { g: "Elemental resistance", key: "res1", stock: 80, max: 500,
      label: "Resistant (tier 1) — damage taken",
      help: "What an Amulet-level resistance cuts incoming damage to \u2014 a 20% reduction, which is the "
        + "one figure the Suikosource Rare Armor guide agrees with exactly.",
      sites: [[0xE3878, 0x24040050], [0x247664, 0x24020050]] },
    { g: "Elemental resistance", key: "res2", stock: 60, max: 500,
      label: "Resistant (tier 2) — damage taken",
      help: "The middle resistance tier: a 40% reduction. NOTE the Suikosource Rare Armor guide says level 2 "
        + "resistance is 30%, which does not match this. The value here is read straight out of the game\u2019s "
        + "own 5-entry jump table (120/100/80/60/40 at VA 0x169C040), so the disc is the stronger evidence \u2014 "
        + "but the tier-to-\u201clevel N\u201d naming is an inference, and that is where the two could differ.",
      sites: [[0xE3880, 0x2404003C], [0x247668, 0x2402003C]] },
    { g: "Elemental resistance", key: "res3", stock: 40, max: 500,
      label: "Resistant (tier 3, best) — damage taken",
      help: "The strongest resistance tier: a 60% reduction (the guide says level 3 is 40% \u2014 see the note on "
        + "tier 2). Set it to 0 for outright immunity.",
      sites: [[0xE3884, 0x24040028], [0x24768C, 0x24040028]] },
    { g: "Other statuses", key: "buffDef", stock: 85, max: 500,
      label: "PDF/MDF buff — damage taken",
      help: "Incoming damage is scaled to this percent while the buff-PDF/MDF status is up "
        + "(flags18 bit 21). Two code sites carry it; both are written together.",
      sites: [[0x104810, 0x24020055], [0x1053DC, 0x24020055]] },
    { g: "Other statuses", key: "mgcBoost", stock: 150, max: 500,
      label: "MGC-boost status — multiplier",
      help: "The multiplier applied while the status gated by mask 0x4000 (flags18 bit 14) is up. Four "
        + "code sites carry it \u2014 two functions, each testing both sides of the field with the "
        + "value duplicated into a branch delay slot \u2014 and all four are written together.",
      sites: [[0x10540C, 0x24020096], [0x105420, 0x24020096], [0x1054B8, 0x24020096], [0x1054CC, 0x24020096]] },
  ];
  // A site is only editable if the instruction is still the one we decoded — same opcode and
  // same registers. That check is why a wrong-region or already-modded disc degrades to
  // read-only here instead of having a number written into whatever now occupies the address.
  function fxSiteOk(off, stockWord) {
    if (!inBlk(off, 4)) return false;
    return ((readW(off, 4) >>> 0) & 0xFFFF0000) === ((stockWord >>> 0) & 0xFFFF0000);
  }
  function fxState(e) {
    const ok = e.sites.every(([off, wd]) => fxSiteOk(off, wd));
    if (!ok) return { known: false };
    const vals = e.sites.map(([off]) => readW(off, 4) & 0xFFFF);
    const agree = vals.every((v) => v === vals[0]);
    return { known: true, agree, value: vals[0], vals,
      dirty: e.sites.some(([off]) => isDirty(off, 4)) };
  }
  // Register each site as the 2-byte IMMEDIATE, not the 4-byte instruction: the word is
  // little-endian so the immediate is the low two bytes, which makes the review list read
  // "150 -> 300" instead of the whole opcode as a meaningless decimal. Numbering the sites is
  // what makes a partial write visible — four rows that all say the same thing read as
  // duplicates, "site 3 of 4" does not.
  function fxWrite(e, v) {
    const n = clampInt(v, 0, e.max);
    e.sites.forEach(([off], i) => {
      writeW(off, 4, withImm(readW(off, 4), n));
      reg(off, 2, "num", "Status effects",
        e.sites.length > 1 ? `${e.label} (site ${i + 1} of ${e.sites.length})` : e.label);
    });
    return n;
  }
  let spFxOpen = false;
  function fxCard() {
    const groups = [];
    for (const e of STATUSFX) if (!groups.includes(e.g)) groups.push(e.g);
    const rows = groups.map((g) => {
      const fields = STATUSFX.filter((e) => e.g === g).map((e) => {
        const st = fxState(e);
        if (!st.known) return `<label class="field"><span>${esc2(e.label)}</span>
          <input type="number" value="" disabled title="This disc's code doesn't match the instruction this control patches, so it is read-only."></label>`;
        return `<label class="field"><span>${esc2(e.label)}
            <span class="u" title="${esc2(e.help)}">stock ${e.stock}%</span></span>
          <input type="number" class="fx" data-k="${e.key}" min="0" max="${e.max}" value="${st.value}"></label>`;
      }).join("");
      return `<div class="bag-h" style="margin-top:10px">${esc2(g)}</div><div class="grid">${fields}</div>`;
    }).join("");
    const unknown = STATUSFX.filter((e) => !fxState(e).known).length;
    return `<details class="card" id="spFxBox"${spFxOpen ? " open" : ""}>
      <summary><b>Status effect strength</b> <span class="u">what an effect is actually worth · ${STATUSFX.length} engine constants</span></summary>
      <div class="warnbox" style="margin:8px 0">These are <b>code</b> constants, not table entries, so each one is
        <b>global</b>: raising the fire figure raises it for every character and every Sword of Rage in the game.
        Percentages are of the value the battle code already computed. ${unknown ? `<b>${unknown}</b> control(s) are
        read-only because this disc's instructions don't match what they patch.` : ""}</div>
      <div class="muted" style="margin:0 0 8px">The Spells tab picks <b>which</b> effect fires; this picks <b>how much
        it is worth</b>. Turn duration is still not editable — the status setter does take a strength argument, but every
        live caller computes it at runtime, and the one routine that reads per-status strengths out of a record is dead
        code with no references anywhere in the executable.</div>
      ${rows}
      <div class="row" style="margin-top:10px"><button class="chip mini" id="fxReset">Restore all to stock</button></div>
    </details>`;
  }
  function wireFx(host) {
    const box = q("#spFxBox", host); if (box) box.ontoggle = () => { spFxOpen = box.open; };
    qa("input.fx", host).forEach((el) => {
      const e = STATUSFX.find((x) => x.key === el.dataset.k); if (!e) return;
      const st = fxState(e);
      if (st.known) markField(el, e.sites[0][0], 2, "num");
      el.onchange = () => {
        const n = fxWrite(e, +el.value || 0);
        el.value = n; drawView();
        setStatus(`${e.label}: ${n}% (was ${e.stock}% on a stock disc).`, "ok");
      };
    });
    const rb = q("#fxReset", host);
    if (rb) rb.onclick = () => { STATUSFX.forEach((e) => fxWrite(e, e.stock)); drawView(); setStatus("Status effect strengths restored to stock.", "ok"); };
  }
  // ---- the damage+heal slot (see the SPLIT constant for how it was pinned) ----
  // Read the three instruction immediates back. `idx`/`amtIdx` are editor rows (game id - 1);
  // either is null when the word is no longer the instruction we know how to rewrite.
  function splitState() {
    const id = splitImm(readW(SPLIT.route, 4), SPLIT.routeOp);
    const amtId = splitImm(readW(SPLIT.amtSel, 4), SPLIT.amtSelOp);
    const heal = splitImm(readW(SPLIT.amt, 4), SPLIT.amtOp);
    const known = id !== null && amtId !== null && heal !== null;
    const inRange = (v) => v !== null && v >= 1 && v <= SPELL.count;
    return { idx: inRange(id) ? id - 1 : null, amtIdx: inRange(amtId) ? amtId - 1 : null, heal, known,
      dirty: [SPLIT.route, SPLIT.amtSel, SPLIT.amt].some((o) => isDirty(o, 4)) };
  }
  // Point both immediates at one spell (editor row) and set the heal number. `setTarget`
  // also gives that spell the both-sides target byte — without it the ally side never
  // enters the target list and the heal profile has nobody to land on.
  function applySplit(idx, heal, setTarget) {
    const id = clampInt(idx, 0, SPELL.count - 1) + 1;
    writeW(SPLIT.route, 4, splitWord(SPLIT.routeOp, id));
    reg(SPLIT.route, 4, "spellid", "Damage+heal", "spell that splits");
    writeW(SPLIT.amtSel, 4, splitWord(SPLIT.amtSelOp, id));
    reg(SPLIT.amtSel, 4, "spellid", "Damage+heal", "spell the heal number belongs to");
    writeW(SPLIT.amt, 4, splitWord(SPLIT.amtOp, clampInt(heal, 0, SPLIT.maxHeal)));
    reg(SPLIT.amt, 4, "imm16", "Damage+heal", "heal HP");
    if (setTarget) applySpell(idx, { target: 0x03 }, false);
  }
  function splitCard() {
    const st = splitState();
    const cur = st.idx == null ? SPLIT.stockSpell : st.idx;
    const opts = [];
    let curListed = false;
    for (let i = 0; i < SPELL.count; i++) {
      const nm = strAt(r32(SPELL.off + i * SPELL.stride + 0x08));
      if (!nm || nm === "no") continue;                       // blank/placeholder rows
      if (i === cur) curListed = true;
      opts.push(`<option value="${i}"${i === cur ? " selected" : ""}>${esc2(nm)} \u00b7 #${i}</option>`);
    }
    // the slot can point at an unnamed row (a modified disc, or a table with gaps) — keep it
    // selectable rather than silently snapping the dropdown to some other spell
    if (!curListed) opts.unshift(`<option value="${cur}" selected>#${cur} (unnamed row)</option>`);
    const warn = !st.known
      ? `<div class="warnbox" style="margin-bottom:10px">These three instructions aren't stock and weren't written by
           this editor (${[SPLIT.route, SPLIT.amtSel, SPLIT.amt].map((o) => hex(readW(o, 4), 8)).join(" ")}) — applying
           a spell here overwrites them.</div>`
      : st.amtIdx !== st.idx
      ? `<div class="warnbox" style="margin-bottom:10px">The two halves currently disagree: the split is on
           #${st.idx}, but the fixed heal number belongs to #${st.amtIdx}, so the split spell heals for its own
           Power instead. Applying puts both on the same spell.</div>` : "";
    return `<details class="card fold" id="spSplitBox" style="margin:0 0 12px"${spSplitOpen ? " open" : ""}>
      <summary class="bag-h"><span class="chev">▸</span>Damage + heal
        <span class="u">the one spell that hits foes and heals allies</span></summary>
      <div class="muted" style="margin:0 0 10px">Shining Wind is the only spell that does two different things to
        the two sides — and the game hardcodes it by spell number, not by any field on the record. Hand that number
        to a different spell and it inherits the whole behaviour: foes take its <b>Power</b> as damage, allies are
        healed the amount below and have their status cleared. There is exactly one such slot in the game, so this
        <b>moves</b> the trick rather than copying it — whichever spell you pick, Shining Wind goes back to being a
        plain damage spell. Its description text is just text; edit it below to match.</div>
      ${warn}
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">
        <label class="field"><span>Spell</span><select id="spSplitSpell">${opts.join("")}</select></label>
        <label class="field"><span>Heals allies (HP)</span>
          <input type="number" id="spSplitHeal" min="0" max="${SPLIT.maxHeal}" value="${st.heal == null ? SPLIT.stockHeal : st.heal}"></label>
      </div>
      <label class="row" style="gap:6px;cursor:pointer;margin:8px 0 0"><input type="checkbox" id="spSplitTgt" checked>
        also set that spell's Target to “All foes + allies” <span class="u">· both sides have to be in the target list for this to show</span></label>
      <div class="row" style="margin-top:8px"><button class="primary mini" id="spSplitApply">Apply</button>
        <button class="chip mini" id="spSplitReset">Restore original</button>
        <span class="muted" id="spSplitInfo"></span></div></details>`;
  }
  function splitInfo(host) {
    const st = splitState(), el = q("#spSplitInfo", host); if (!el) return;
    const nm = st.idx == null ? "" : strAt(r32(SPELL.off + st.idx * SPELL.stride + 0x08));
    el.textContent = (st.idx == null ? "not set to a spell in this table"
      : `now on ${nm || "#" + st.idx} (#${st.idx}), heals ${st.heal} HP`) + (st.dirty ? " · staged" : "");
  }
  function wireSplit(host) {
    const sel = q("#spSplitSpell", host); if (!sel) return;
    splitInfo(host);
    q("#spSplitApply", host).onclick = () => {
      const idx = +sel.value;
      applySplit(idx, +q("#spSplitHeal", host).value, q("#spSplitTgt", host).checked);
      drawView();
      setStatus(`“${strAt(r32(SPELL.off + idx * SPELL.stride + 0x08))}” now damages foes and heals allies. Review, then Save.`, "ok");
    };
    q("#spSplitReset", host).onclick = () => {
      [SPLIT.route, SPLIT.amtSel, SPLIT.amt].forEach((o) => revertRange(o, 4));
      drawView(); updateDirtyBadge();
      setStatus("Damage+heal restored to this disc's own wiring.", "ok");
    };
  }
  function drawSpells(host) {
    const upd = spDescOn;
    const runeOpts = Object.keys(RUNE_SPELLS).map((r) => `<option value="${r}">${r}</option>`).join("");
    const elemOptsBlank = `<option value="">— no change —</option>` + Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    const statOptsBlank = `<option value="">— no change —</option>` + ["none", ...Object.values(F18_BITS)].map((s) => `<option value="${s}">${s}</option>`).join("");
    const reskin = `<details class="card fold" id="spReskinBox" style="margin:0 0 12px"${spReskinOpen ? " open" : ""}>
      <summary class="bag-h"><span class="chev">▸</span>Rune reskin
        <span class="u">apply the fields you set to every spell a rune grants</span></summary>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
        <label class="field"><span>Rune</span><select id="rsRune">${runeOpts}</select></label>
        <label class="field"><span>Power</span><input type="number" id="rsPower" min="0" placeholder="no change"></label>
        <label class="field"><span>Cast (MOV)</span><input type="number" id="rsCast" min="0" placeholder="no change"></label>
        <label class="field"><span>Element</span><select id="rsElem">${elemOptsBlank}</select></label>
        <label class="field"><span>Target</span><select id="rsTarget"><option value="">— no change —</option>${TARGET_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <label class="field"><span>Area of effect</span><select id="rsAoe"><option value="">— no change —</option><option value="1">on</option><option value="0">off</option></select></label>
        <label class="field"><span>Status</span><select id="rsStatus">${statOptsBlank}</select></label>
        <label class="field"><span>Radius</span><input type="number" id="rsRadius" min="0" max="255" placeholder="no change"></label>
        <label class="field"><span>Status chance %</span><input type="number" id="rsChance" min="0" max="100" placeholder="no change"></label>
      </div>
      <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:4px">
        <span class="muted">Presets:</span>
        <button class="chip mini" data-rspreset="buff">Power 3000</button>
        <button class="chip mini" data-rspreset="max">Power 9999</button>
        <button class="chip mini" data-rspreset="aoe">Make AOE</button>
        <button class="chip mini" data-rspreset="instant">Instant cast</button>
        <button class="chip mini" data-rspreset="poison">Add poison</button>
        <button class="chip mini" data-rspreset="nostatus">Remove status</button>
        <button class="chip mini" data-rspreset="clear">Clear fields</button>
        <span class="u">fills the fields — then Apply</span></div>
      <div class="row" style="margin-top:8px"><button class="primary mini" id="rsApply">Apply to rune</button>
        <span class="muted" id="rsInfo"></span></div></details>`;
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="spUpd"${upd ? " checked" : ""}> also rewrite the damage number in each spell's description when Power changes <span class="u">\u00b7 applies to the rune reskin above too</span></label>`;

    const rows = [];
    for (let i = 0; i < SPELL.count; i++) {
      const off = SPELL.off + i * SPELL.stride, name = strAt(r32(off + 0x08));
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, off, name });
    }
    const body = rows.map(({ i, off, name }) => {
      const canTail = i + 1 < SPELL.count, elVal = canTail ? (r16(off + SPELL.elem) & 0xFF) : 0;
      const radVal = canTail ? r8(off + SPELL.radius) : 0, chVal = canTail ? r16(off + SPELL.chance) : 0;
      const f14 = r32(off + 0x14), tb = (f14 >> 8) & 0x7F, f18 = r32(off + 0x18);
      const elemSel = elemOptsHTML(elVal);
      // editable, length-capped description (cap = original slot length; can't grow past it)
      const dptr = r32(off + 0x0C), dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descField = dmax > 0
        ? `<label class="field" style="margin:0 0 10px"><span>Description <span class="muted">(max ${dmax} chars)</span></span>
             <input type="text" class="spdesc" data-i="${i}" maxlength="${dmax}" value="${esc2(dcur)}"></label>`
        : `<div class="muted" style="margin:0 0 8px">${esc2(dcur)}</div>`;
      return `<details class="char" data-i="${i}"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="lv sp-sum">${elemName(elVal)} · pw ${r32(off + 0x1C)} · ${decodeTarget(f14)}${radVal ? " r" + radVal : ""}${f18 ? " · " + decodeF18(f18) : ""}</span></summary>
        <div class="char-body">
          ${descField}
          <div class="grid">
            <label class="field"><span>Power</span><input type="number" class="sp" data-i="${i}" data-k="power" min="0" value="${r32(off + 0x1C)}"></label>
            <label class="field"><span>Cast (MOV)</span><input type="number" class="sp" data-i="${i}" data-k="cast" min="0" value="${r32(off + 0x10)}"></label>
            <label class="field"><span>Element</span><select class="sp" data-i="${i}" data-k="elementId" ${canTail ? "" : "disabled"}>${elemSel}</select></label>
            <label class="field"><span>Target</span><select class="sp" data-i="${i}" data-k="target">${targetOptsHTML(tb)}</select></label>
            <label class="field"><span>Area of effect</span><select class="sp" data-i="${i}" data-k="aoe"><option value="1"${(f14 & AREA_BIT) ? " selected" : ""}>on</option><option value="0"${!(f14 & AREA_BIT) ? " selected" : ""}>off</option></select></label>
            <label class="field"><span>Radius <span class="muted">(0 = no area)</span></span><input type="number" class="sp" data-i="${i}" data-k="radius" min="0" max="255" value="${radVal}" ${canTail ? "" : "disabled"}></label>
            <label class="field"><span>Status chance %</span><input type="number" class="sp" data-i="${i}" data-k="chance" min="0" max="100" value="${chVal}" ${canTail ? "" : "disabled"}></label>
            ${f18CtlHTML(i, f18)}
          </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`;
    // Two collapsed cards in a row read as one stack, so each section says what it is:
    // a one-off engine patch, a rune-wide bulk edit, then the table itself.
    const sec = (t) => `<div class="secdiv"><span>${t}</span></div>`;
    host.innerHTML = sec("Status effects \u00b7 what an effect is worth") + fxCard()
      + sec("Special effect \u00b7 one spell only") + splitCard()
      + sec("Bulk edit \u00b7 a whole rune") + reskin
      + sec("Every spell") + updBox + body;

    wireFx(host);
    wireSplit(host);
    const fold = (id, set) => { const d = q(id, host); if (d) d.ontoggle = () => set(d.open); };
    fold("#spSplitBox", (v) => { spSplitOpen = v; });
    fold("#spReskinBox", (v) => { spReskinOpen = v; });
    q("#spUpd", host).onchange = (e) => { spDescOn = e.target.checked; };
    q("#rsApply", host).onclick = () => runeReskin();
    qa("[data-rspreset]", host).forEach((b) => (b.onclick = () => {
      const set = (id, v) => { const el = q(id, host); if (el) el.value = v; };
      switch (b.dataset.rspreset) {
        case "buff": set("#rsPower", "3000"); break;
        case "max": set("#rsPower", "9999"); break;
        case "aoe": set("#rsAoe", "1"); break;
        case "instant": set("#rsCast", "0"); break;
        case "poison": set("#rsStatus", "poison"); break;
        case "nostatus": set("#rsStatus", "none"); break;   // clears the inflicted status (flags18)
        case "clear": ["#rsPower", "#rsCast", "#rsElem", "#rsTarget", "#rsAoe", "#rsStatus", "#rsRadius", "#rsChance"].forEach((s) => set(s, "")); break;
      }
      setStatus("Preset filled — pick a rune and click “Apply to rune”.", "ok");
    }));
    q("#rsRune", host).onchange = () => { const el = q("#rsInfo", host); el.textContent = "→ " + RUNE_SPELLS[q("#rsRune", host).value].join(", "); };
    q("#rsRune", host).dispatchEvent(new Event("change"));

    qa(".sp", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k;
      const f = {}; f[k] = k === "aoe" ? el.value === "1" : k === "status" ? el.value : +el.value;
      const dr = applySpell(i, f, spDescOn && k === "power");
      updateSpellSummary(host, i);
      if (dr && dr.truncated) setStatus("Power saved — but this description is at its length limit, so the DMGx value couldn't be rewritten. Edit the Description field to shorten it and fit the new number.", "warn");
    }));
    // flags18 checkboxes: rebuild the whole mask from the boxes in this spell's block, so any
    // combination (and any set-but-unlabelled bit, which gets its own box) round-trips intact.
    const f18FromBoxes = (d) => {
      let m = 0;
      qa("input.sp18", d).forEach((c) => { if (c.checked) m |= (1 << +c.dataset.b); });
      return m >>> 0;
    };
    qa("input.sp18", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, d = q(`details.char[data-i="${i}"]`, host);
      applySpell(i, { statusMask: f18FromBoxes(d) }, false);
      updateSpellSummary(host, i);
    }));
    qa("input.sp18hex", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, raw = el.value.trim().replace(/^0x/i, "");
      if (!/^[0-9a-f]{1,8}$/i.test(raw)) {
        setStatus(`“${el.value}” isn't a hex mask — use up to 8 hex digits, e.g. 1DE7.`, "err");
        el.value = hex(r32(SPELL.off + i * SPELL.stride + 0x18), 8); return;
      }
      applySpell(i, { statusMask: parseInt(raw, 16) }, false);
      // re-render the row so a bit typed in by hand gains its checkbox (and an unknown bit its warning)
      drawView(); setStatus("", "");
    }));
    // manual free-text description edit (capped to the slot length via maxlength + setDescText)
    qa(".spdesc", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, off = SPELL.off + i * SPELL.stride, name = strAt(r32(off + 0x08));
      const res = setDescText(r32(off + 0x0C), el.value, name, "Description");
      if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this spell.`, "warn");
      updateSpellSummary(host, i);
    }));
    qa("details.char", host).forEach((d) => updateSpellSummary(host, +d.dataset.i));   // init ↺/highlight
  }
  function updateSpellSummary(host, i) {
    const d = q(`details.char[data-i="${i}"]`, host); if (!d) return;
    const off = SPELL.off + i * SPELL.stride, elVal = i + 1 < SPELL.count ? (r16(off + SPELL.elem) & 0xFF) : 0;
    const f18 = r32(off + 0x18);
    const rad = i + 1 < SPELL.count ? r8(off + SPELL.radius) : 0;
    d.querySelector(".sp-sum").textContent = `${elemName(elVal)} · pw ${r32(off + 0x1C)} · ${decodeTarget(r32(off + 0x14))}${rad ? " r" + rad : ""}${f18 ? " · " + decodeF18(f18) : ""}`;
    const MAP = { power: [0x1C, 4, "num"], cast: [0x10, 4, "num"], elementId: [SPELL.elem, 2, "elem"], target: [0x14, 4, "flags14"], aoe: [0x14, 4, "flags14"], status: [0x18, 4, "status"],
      radius: [SPELL.radius, 1, "num"], chance: [SPELL.chance, 2, "num"] };
    qa(".sp", d).forEach((el) => {
      const [o, w, kind] = MAP[el.dataset.k];
      if (kind === "flags14") markFlagsField(el, off + o, el.dataset.k === "aoe" ? AREA_BIT : 0x7F00);
      else markField(el, off + o, w, kind);
    });
    // flags18 is one word behind ~16 checkboxes, so highlight the changed bits but hang the
    // single ↺ off the raw-mask box — one revert for the word, not one per bit.
    const f18Orig = origW(off + 0x18, 4) >>> 0;
    qa("input.sp18", d).forEach((el) => {
      const m = 1 << +el.dataset.b;
      el.classList.toggle("dirty", ((f18 ^ f18Orig) & m) !== 0);
    });
    const hexEl = d.querySelector("input.sp18hex");
    if (hexEl) { hexEl.value = hex(f18, 8); markField(hexEl, off + 0x18, 4, "num"); }
    // reflect any auto-rewrite of the description (e.g. Power change) inline + highlight if changed
    const dEl = d.querySelector(".spdesc");
    if (dEl) {
      const dptr = r32(off + 0x0C), doff = vaOff(dptr), dmax = origSlotLen(dptr);
      dEl.value = strFrom(BUF, doff, dmax);
      markField(dEl, doff, dmax, "text");
    }
  }
  function runeReskin() {
    const rune = q("#rsRune").value, idx = spellNameIndex();
    const targets = (RUNE_SPELLS[rune] || []).map((n) => idx[n]).filter((v) => v != null);
    if (!targets.length) return setStatus("Could not resolve that rune's spells in this ISO.", "err");
    const f = {}, num = (id) => q(id).value;
    if (num("#rsPower") !== "") f.power = +num("#rsPower");
    if (num("#rsCast") !== "") f.cast = +num("#rsCast");
    if (num("#rsElem") !== "") f.elementId = +num("#rsElem");
    if (num("#rsTarget") !== "") f.target = +num("#rsTarget");
    if (num("#rsAoe") !== "") f.aoe = num("#rsAoe") === "1";
    if (num("#rsStatus") !== "") f.status = num("#rsStatus");
    if (num("#rsRadius") !== "") f.radius = +num("#rsRadius");
    if (num("#rsChance") !== "") f.chance = +num("#rsChance");
    if (!Object.keys(f).length) return setStatus("Set at least one field to apply.", "warn");
    targets.forEach((i) => applySpell(i, f, spDescOn));
    drawView();
    setStatus(`Reskinned ${targets.length} spell(s) for rune "${rune}". Review, then Save.`, "ok");
  }

  // ---- unites ----------------------------------------------------------------
  function drawUnites(host) {
    const rows = [];
    for (let i = 0; i < UNITE.count; i++) {
      const off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08)), who = uniteRoster(i);
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && !who.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, off, name, who });
    }
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="unUpd"${unDescOn ? " checked" : ""}> also rewrite the damage number in each unite's description when Power changes</label>`
      + `<div class="muted" style="margin:0 0 10px">Who can perform each unite comes from the Suikosource unite guide, not from the disc — the roster isn't stored in an editable field, so it's shown for reference only. Filtering searches character names too.</div>`;
    host.innerHTML = updBox + (rows.map(({ i, off, name, who }) => {
      const f14 = r32(off + 0x14), tb = (f14 >> 8) & 0x7F;
      const radVal = r8(off + UNITE.radius), chVal = r16(off + UNITE.chance);
      const dptr = r32(off + 0x0C), dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descField = dmax > 0
        ? `<label class="field" style="margin:0 0 10px"><span>Description <span class="muted">(max ${dmax} chars)</span></span>
             <input type="text" class="undesc" data-i="${i}" maxlength="${dmax}" value="${esc2(dcur)}"></label>`
        : `<div class="muted" style="margin:0 0 8px">${esc2(dcur)}</div>`;
      const mem = uniteMembers(i);
      const chips = mem.map((m) => `<span class="tag">${esc2(REF.names.list1[m.id] || "#" + m.id)} <span class="dim">#${m.id}</span></span>`).join(" ");
      const whoField = who
        ? `<div class="field" style="margin:0 0 10px"><span>Characters <span class="muted">(guide reference — not editable)</span></span>
             <div class="row" style="flex-wrap:wrap;gap:5px;margin-top:4px">${chips}</div>
             ${mem.length === 0 || /any|mounted/i.test(who) ? `<div class="fnote" style="margin-top:4px">${esc2(who)}</div>` : ""}</div>`
        : `<div class="field" style="margin:0 0 10px"><span>Characters</span>
             <div class="fnote" style="margin-top:4px"><span class="dim">not listed in the unite guide — roster unknown (likely an enemy/unused record)</span></div></div>`;
      return `<details class="char" data-i="${i}"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="muted un-who" style="flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc2(who || "")}">${esc2(who || "—")}</span>
          <span class="lv un-sum">pw ${r32(off + 0x1C)} · ${decodeTarget(f14)}${radVal ? " r" + radVal : ""}</span></summary>
        <div class="char-body">${whoField}${descField}
          <div class="grid">
            <label class="field"><span>Power</span><input type="number" class="un" data-i="${i}" data-k="power" min="0" value="${r32(off + 0x1C)}"></label>
            <label class="field"><span>Cast (MOV)</span><input type="number" class="un" data-i="${i}" data-k="cast" min="0" value="${r32(off + 0x10)}"></label>
            <label class="field"><span>Target</span><select class="un" data-i="${i}" data-k="target">${targetOptsHTML(tb)}</select></label>
            <label class="field"><span>Area of effect</span><select class="un" data-i="${i}" data-k="aoe"><option value="1"${(f14 & AREA_BIT) ? " selected" : ""}>on</option><option value="0"${!(f14 & AREA_BIT) ? " selected" : ""}>off</option></select></label>
            <label class="field"><span>Radius <span class="muted">(0 = no area)</span></span><input type="number" class="un" data-i="${i}" data-k="radius" min="0" max="255" value="${radVal}"></label>
            <label class="field"><span>Status chance %</span><input type="number" class="un" data-i="${i}" data-k="chance" min="0" max="100" value="${chVal}"></label>
          </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`);
    const UMAP = { power: [0x1C, 4, "num"], cast: [0x10, 4, "num"], target: [0x14, 4, "flags14"], aoe: [0x14, 4, "flags14"],
      radius: [UNITE.radius, 1, "num"], chance: [UNITE.chance, 2, "num"] };
    const markUnite = (i) => {
      const off = UNITE.off + i * UNITE.stride, d = q(`details.char[data-i="${i}"]`, host); if (!d) return;
      const rad = r8(off + UNITE.radius);
      d.querySelector(".un-sum").textContent = `pw ${r32(off + 0x1C)} · ${decodeTarget(r32(off + 0x14))}${rad ? " r" + rad : ""}`;
      qa(".un", d).forEach((c) => {
        const [o, w, kind] = UMAP[c.dataset.k];
        if (kind === "flags14") markFlagsField(c, off + o, c.dataset.k === "aoe" ? AREA_BIT : 0x7F00);
        else markField(c, off + o, w, kind);
      });
      const dEl = d.querySelector(".undesc");
      if (dEl) { const dptr = r32(off + 0x0C), doff = vaOff(dptr), dmax = origSlotLen(dptr); dEl.value = strFrom(BUF, doff, dmax); markField(dEl, doff, dmax, "text"); }
    };
    const un = q("#unUpd", host); if (un) un.onchange = (e) => { unDescOn = e.target.checked; };
    qa(".un", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k, off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      if (k === "power") {
        writeW(off + 0x1C, 4, Math.max(0, +el.value || 0)); reg(off + 0x1C, 4, "num", name, "Power");
        if (unDescOn) { const dr = rewriteDesc(r32(off + 0x0C), (t) => descPower(t, Math.max(0, +el.value || 0)), name, "Description");
          if (dr && dr.truncated) setStatus("Power saved — but this description is at its length limit, so the DMGx value couldn't be rewritten. Edit the Description field to shorten it and fit the new number.", "warn"); }
      }
      else if (k === "cast") { writeW(off + 0x10, 4, Math.max(0, +el.value || 0)); reg(off + 0x10, 4, "num", name, "Cast"); }
      else if (k === "target") { let v = r32(off + 0x14); v = (v & 0xFFFF80FF) | ((+el.value & 0x7F) << 8); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Target"); }
      else if (k === "aoe") { let v = r32(off + 0x14); v = el.value === "1" ? (v | AREA_BIT) : (v & ~AREA_BIT); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Area of effect"); }
      else if (k === "radius") { writeW(off + UNITE.radius, 1, clampInt(el.value, 0, 255)); reg(off + UNITE.radius, 1, "num", name, "Radius"); }
      else if (k === "chance") { writeW(off + UNITE.chance, 2, clampInt(el.value, 0, 100)); reg(off + UNITE.chance, 2, "num", name, "Status chance %"); }
      markUnite(i);
    }));
    qa(".undesc", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      const res = setDescText(r32(off + 0x0C), el.value, name, "Description");
      if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this unite.`, "warn");
      markUnite(i);
    }));
    qa("details.char", host).forEach((d) => markUnite(+d.dataset.i));   // init ↺/highlight
  }

  // ---- food ------------------------------------------------------------------
  function drawFood(host) {
    const rows = [];
    for (let i = 0; i < FOOD.count; i++) {
      const off = FOOD.off + i * FOOD.stride, name = strAt(r32(off + FOOD.name));
      if (SEARCH && !name.toLowerCase().includes(SEARCH)) continue;
      const heal = off + FOOD.heal, proc = off + FOOD.proc, dptr = r32(off + FOOD.desc);
      const dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descCell = dmax > 0
        ? `<td><input type="text" class="fddesc" maxlength="${dmax}" style="min-width:150px" value="${esc2(dcur)}" data-dptr="${dptr}" data-g="${esc2(name)}" title="max ${dmax} chars"></td>`
        : `<td class="muted">${esc2(dcur)}</td>`;
      rows.push(`<tr><td class="sl">${i}</td><td class="acc2">${esc2(name || "#" + i)}</td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(heal)}" data-off="${heal}" data-dptr="${dptr}" data-kind="heal" data-g="${esc2(name)}" data-l="Heal HP"></td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(proc)}" data-off="${proc}" data-dptr="${dptr}" data-kind="proc" data-g="${esc2(name)}" data-l="Proc %"></td>
        ${descCell}</tr>`);
    }
    host.innerHTML = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="fUpd"${foodDescOn ? " checked" : ""}> also rewrite the "Heals N HP" / "N% chance" numbers in the description</label>
      <div style="overflow-x:auto"><table class="invtbl"><thead><tr><th>#</th><th>Item</th><th>Heal HP</th><th>Proc %</th><th>Description</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="5" class="muted">no matches</td></tr>`}</tbody></table></div>`;
    q("#fUpd", host).onchange = (e) => { foodDescOn = e.target.checked; };
    // reflect a food row's description string back into its editable cell (+ highlight)
    const refreshFoodDesc = (dptr, row) => {
      const de = row && row.querySelector("input.fddesc"); if (!de) return;
      const doff = vaOff(dptr), dmax = origSlotLen(dptr); de.value = strFrom(BUF, doff, dmax); markField(de, doff, dmax, "text");
    };
    qa("input.fd", host).forEach((inp) => {
      const off = +inp.dataset.off, nm = inp.dataset.g;
      inp.onchange = () => {
        const v = Math.max(0, Math.min(+inp.value || 0, 65535));
        writeW(off, 2, v); reg(off, 2, "num", nm, inp.dataset.l); markField(inp, off, 2, "num");
        if (foodDescOn && inp.dataset.dptr) { rewriteDesc(+inp.dataset.dptr, (t) => inp.dataset.kind === "heal" ? descHeal(t, v) : descProc(t, v), nm, "Description"); refreshFoodDesc(+inp.dataset.dptr, inp.closest("tr")); }
      };
      markField(inp, off, 2, "num");
    });
    // manual, length-capped description edit per food item
    qa("input.fddesc", host).forEach((el) => {
      const dptr = +el.dataset.dptr, doff = vaOff(dptr), dmax = origSlotLen(dptr);
      el.onchange = () => {
        const res = setDescText(dptr, el.value, el.dataset.g, "Description");
        if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this item.`, "warn");
        el.value = strFrom(BUF, doff, dmax); markField(el, doff, dmax, "text");
      };
      markField(el, doff, dmax, "text");
    });
  }

  // ---- gear (equipment: DEF + price editable; effects read-only) ------------
  function scanGear() {
    if (gearCache) return gearCache;
    const nameset = {}; for (const id in REF.items) nameset[REF.items[id]] = +id;
    for (const nm in gearAlias) nameset[nm] = gearAlias[nm];   // gear renamed this session still anchors
    const isptr = (w) => w >= ELF_VADDR && w <= ELF_VADDR + ELF_LEN;
    const out = {};
    const N = BUF.length - 2 * GEAR.stride;
    for (let p = 0; p < N; p += 4) {
      const dp = DV.getUint32(p, true), nv = DV.getUint32(p + 0x40, true);
      if (!isptr(dp) || !isptr(nv)) continue;
      const no = nv - ELF_VADDR; let ne = BUF.indexOf(0, no); if (ne < 0) continue;
      const nm = dec.decode(BUF.subarray(no, ne));
      if (!(nm in nameset)) continue;
      const doo = dp - ELF_VADDR; let de = BUF.indexOf(0, doo); if (de < 0) continue;
      const ds = dec.decode(BUF.subarray(doo, de));
      if (ds.indexOf("(") < 0) continue;
      const defv = DV.getUint16(p + GEAR.def, true), price = DV.getUint32(p + GEAR.price, true);
      if (defv > 500 || price > 2000000) continue;
      const iid = nameset[nm];
      if (!(iid in out)) out[iid] = ELF_BASE + p + GEAR.stride;   // stats live one record after the name
    }
    gearCache = out; return out;
  }
  // one effect slot: type select + value + a param control (stat / skill / hidden per type)
  function effectSlotHTML(nm, base, eo) {
    const t = r16(base + eo), val = r16(base + eo + 2), param = r16(base + eo + 4);
    const typeOpts = Object.entries(GEAR_EFFECT_TYPES).map(([v, l]) => `<option value="${v}"${+v === t ? " selected" : ""}>${v} · ${l}</option>`).join("");
    const statOpts = Object.entries(GEAR_STAT_SELECTOR).map(([v, l]) => `<option value="${v}"${+v === param ? " selected" : ""}>${l}</option>`).join("");
    const skillOpts = skillOpts2(param);
    const pk = GEAR_TYPE_PARAM[t];
    return `<div class="row" data-eff data-base="${base}" data-eo="${eo}" data-g="${esc2(nm)}" style="gap:6px;margin-bottom:6px">
        <span class="muted" style="width:52px">slot ${GEAR.effs.indexOf(eo)}</span>
        <select class="ge-type" style="flex:1 1 150px">${typeOpts}</select>
        <input type="number" class="ge-val" style="width:80px" min="0" max="65535" value="${val}" title="amount">
        <select class="ge-stat" style="flex:0 1 90px;${pk === "stat" ? "" : "display:none"}">${statOpts}</select>
        <select class="ge-skill" style="flex:1 1 150px;${pk === "skill" ? "" : "display:none"}">${skillOpts}</select>
      </div>`;
  }
  function skillOpts2(cur) {
    const list = Object.keys(REF.skills).map(Number).sort((a, b) => a - b);
    if (cur && !list.includes(cur)) list.unshift(cur);
    return list.map((id) => `<option value="${id}"${id === cur ? " selected" : ""}>${hex(id, 2)} · ${skillName(id)}</option>`).join("");
  }
  // ---- Mounts: the three hard-coded battle rider/mount pairs -------------------
  function drawMounts(host) {
    const riderRow = (id) => MOUNTS.riders.concat(MOUNTS.ridersNoBank).find((r) => r[0] === id) || null;
    const riderName = (id) => (riderRow(id) || [])[1] || null;
    const mountName = (id) => (MOUNTS.mounts.find((m) => m[0] === id) || [])[1] || null;
    // Per-combination confidence. The byte patch is the same edit for every pair; what differs
    // is whether the rider's mounted rig suits that class of mount, which static analysis can't
    // answer — so the grid is derived from what has actually been played rather than asserted.
    //
    // A pair is "expected" when some CONFIRMED pair shares its *direction* — the rider's rig
    // class paired against the mount's class. Stock covers flyer→flyer and horse→horse; adding
    // Chris+Bright covers horse→flyer, which is why the horse-rigged riders read expected on the
    // flyers now. That leaves flyer→horse (a flyer-rigged rider on Ruby) as the only direction
    // with no precedent, and it stays untested. Add a played pair to CONFIRMED and the whole grid
    // follows — no tier needs hand-editing.
    const DIRS = new Set(MOUNTS.CONFIRMED.map(([a, b]) => {
      const r = riderRow(a), m = MOUNTS.mounts.find((x) => x[0] === b);
      return r && m ? `${r[2]}>${m[2]}` : null;
    }).filter(Boolean));
    const tierOf = (rId, mId) => {
      if (!rId || !mId) return "off";
      const r = riderRow(rId), m = MOUNTS.mounts.find((x) => x[0] === mId);
      if (!r || !m) return "unknown";
      if (MOUNTS.CONFIRMED.some(([a, b]) => a === rId && b === mId)) return "confirmed";
      if (r[3] === "none") return "nobank";
      if (r[3] === "partial") return "rough";
      return DIRS.has(`${r[2]}>${m[2]}`) ? "expected" : "untested";
    };
    // Three shapes of the same fact, sized to where it goes. The grid's rider column is pinned
    // and never wraps, so it takes the shortest form — anything longer (Sharon's clip list) sets
    // the column width and pushes the mount columns off a phone screen. A <select> shows only its
    // selected option, so there the note is trimmed to actual caveats: a rig class in the closed
    // box just pushes the name out of view.
    const riderTag = (row) => row[3] === "none" ? "no battle bank"
      : row[3] === "partial" ? "partial bank" : `${row[2]} rig`;
    const riderCaveat = (row) => row[4] || (row[3] === "none" ? "no mounted-battle bank"
      : row[3] === "partial" ? "partial bank" : null);
    const badge = (t, pre) => { const d = MOUNTS.TIERS[t];
      return `<span class="mcf ${d.cls}" title="${esc2((pre ? pre + " — " : "") + d.label + ": " + d.why)}">${d.mark} ${esc2(d.label)}</span>`; };
    // Guard: every site must still be an `addiu $v0,$zero,imm`. If the disc doesn't match,
    // don't offer edits — better to say so than to write half a comparison chain.
    const sites = MOUNTS.pairs.flatMap((p) => p.riderSites.concat([p.mountSite]));
    const bad = sites.filter((o) => !inBlk(o, 4) || r8(o + 2) !== MOUNTS.sig[0] || r8(o + 3) !== MOUNTS.sig[1]);
    if (bad.length) {
      host.innerHTML = `<div class="card"><div class="warnbox" style="margin:0">
        The rider/mount comparison chain doesn't look like stock code on this disc
        (${bad.length} of ${sites.length} sites failed the <code>addiu $v0,$zero,imm</code> check),
        so this tab won't edit it. Revert to a pristine USA SLUS-20387 ISO and reopen.</div></div>`;
      return;
    }
    // The opt-in extras stay listed whenever a pair already holds one, so an existing edit
    // (or a disc patched elsewhere) never silently reads back as "model N (not in list)".
    const setRiders = MOUNTS.pairs.map((p) => r16(p.riderSites[0]));
    const extraRiders = MOUNTS.ridersNoBank.filter(([id]) => mntAllRiders || setRiders.includes(id));
    const riderOpts = MOUNTS.riders.concat(extraRiders);
    const cards = MOUNTS.pairs.map((p, i) => {
      const rIdSites = p.riderSites, rId = r16(rIdSites[0]), mId = r16(p.mountSite);
      const [sr, sm] = MOUNTS.STOCK[i];
      // A rider whose two sites disagree is a broken chain — surface it rather than hide it.
      const split = rIdSites.length > 1 && r16(rIdSites[0]) !== r16(rIdSites[1]);
      // Each option carries the confidence it would give THIS pair, so the marker is visible
      // before you commit to the change rather than only after.
      const opt = (list, cur, none, tierFor, noteFor) => [`<option value="0"${cur === 0 ? " selected" : ""}>${none}</option>`]
        .concat(list.map((row) => {
          const [id, nm] = row, note = noteFor(row), t = MOUNTS.TIERS[tierFor(id)];
          return `<option value="${id}"${id === cur ? " selected" : ""} title="${esc2(t.label + ": " + t.why)}">${
            esc2(nm)} ${t.mark}${note ? ` — ${esc2(note)}` : ""}</option>`;
        }))
        .concat(cur !== 0 && !list.some(([id]) => id === cur)
          ? [`<option value="${cur}" selected>model ${cur} (not in list)</option>`] : []).join("");
      const tier = tierOf(rId, mId), td = MOUNTS.TIERS[tier];
      const stockNote = `stock: ${riderName(sr) || sr} + ${mountName(sm) || sm}`;
      const who = rId && mId ? `${riderName(rId) || `model ${rId}`} + ${mountName(mId) || `model ${mId}`}` : null;
      return `<details class="char" data-rec="${rIdSites[0]}" open><summary>
          <span class="chev">▸</span><span class="nm">Pair ${i + 1}</span>
          ${badge(tier, who)}
          <span class="muted">${esc2(stockNote)}</span></summary>
        <div class="char-body">
          ${split ? `<div class="warnbox" style="margin:0 0 8px">This pair's two rider sites disagree
            (${r16(rIdSites[0])} vs ${r16(rIdSites[1])}) — pick a rider to rewrite both.</div>` : ""}
          <div class="grid">
            <label class="field"><span>Rider</span>
              <select class="mnt-rider" data-i="${i}">${
                opt(riderOpts, rId, "— none (pair disabled) —", (id) => tierOf(id, mId), riderCaveat)}</select></label>
            <label class="field"><span>Mount</span>
              <select class="mnt-mount" data-i="${i}">${
                opt(MOUNTS.mounts, mId, "— none (pair disabled) —", (id) => tierOf(rId, id), (row) => row[3])}</select></label>
          </div>
          <div class="fnote" style="margin-top:8px">${who ? `<b>${esc2(who)}</b> — ` : ""}${esc2(td.why)}</div>
        </div></details>`;
    }).join("");
    // The whole grid at a glance: 9 riders × 3 mounts, plus the opt-in no-bank rows when shown.
    const matrix = `<div class="mcfwrap"><table class="invtbl mcftbl">
        <thead><tr><th>Rider</th>${MOUNTS.mounts.map(([, nm, , what]) =>
          `<th>${esc2(nm)}<span class="muted"> · ${esc2(what)}</span></th>`).join("")}</tr></thead>
        <tbody>${riderOpts.map((row) => `<tr><td${row[4] ? ` title="${esc2(row[4])}"` : ""}>${
          esc2(row[1])}<span class="muted"> · ${esc2(riderTag(row))}</span></td>${MOUNTS.mounts.map(([mid, mnm]) =>
            `<td>${badge(tierOf(row[0], mid), `${row[1]} + ${mnm}`)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      <div class="mcfleg">${["confirmed", "expected", "untested", "rough", "nobank"].map((k) => {
        const d = MOUNTS.TIERS[k];
        return `<div class="mcfrow"><span class="mcf ${d.cls}">${d.mark} ${esc2(d.label)}</span>
          <span class="muted">${esc2(d.why)}</span></div>`; }).join("")}</div>
      <label class="row" style="gap:6px;cursor:pointer;margin:10px 0 0;align-items:flex-start">
        <input type="checkbox" id="mntAll"${mntAllRiders ? " checked" : ""} style="flex:0 0 auto;margin-top:3px">
        <span style="flex:1 1 200px;min-width:0">also list riders with no mounted-battle bank (Geddoe,
        Thomas, Salome, Juan) — they pair up and then keep their normal battle pose</span></label>`;
    const [l2base, l2stride] = TABLES.list2;
    const horseOff = (roster) => l2base + roster * l2stride + MOUNTS.horse.off;
    const horseRows = MOUNTS.horse.riders.map(([rid, nm, cap]) => {
      const off = horseOff(rid), cur = r16(off), stock = MOUNTS.horse.STOCK[rid] || 0;
      const known = MOUNTS.horse.VALID.some(([v]) => v === cur);
      const opts = MOUNTS.horse.VALID.map(([v, lbl]) =>
        `<option value="${v}"${v === cur ? " selected" : ""}>${esc2(lbl)}${v === stock && v ? " (stock)" : ""}</option>`)
        .concat(known ? [] : [`<option value="${cur}" selected>${cur} — not honoured by the game</option>`]).join("");
      return `<label class="field"><span>${esc2(nm)} <span class="muted">${esc2(cap)}</span></span>
        <select class="mnt-horse" data-off="${off}" data-nm="${esc2(nm)}">${opts}</select></label>`;
    }).join("");
    // ---- pair mechanics: whole-instruction rewrites, stock encodings pinned ----
    const M = MOUNTS.mech;
    const mechSites = [M.pool, M.adren].map((d) => d.off).concat([M.roundRider.off, M.roundMount.off]);
    const mechOk = mechSites.every((o) => inBlk(o, 4))
      && [M.pool, M.adren].every((d) => [d.stock, d.alt].includes(r32(d.off) >>> 0))
      && [M.roundRider, M.roundMount].every((d) => (r32(d.off) >>> 0 & 0xFFFF0000) === (d.word & 0xFFFF0000));
    const mechRows = !mechOk
      ? `<div class="warnbox" style="margin:0">These instructions don't match stock code on this disc, so
           they aren't editable here.</div>`
      : [M.pool, M.adren].map((d) => {
          const cur = (r32(d.off) >>> 0).toString();
          return `<label class="field"><span>${esc2(d.label)}</span>
            <select class="mnt-mech" data-off="${d.off}">${d.opts.map(([v, lbl]) =>
              `<option value="${Number(v)}"${Number(v) === Number(cur) ? " selected" : ""}>${esc2(lbl)}</option>`).join("")}
            </select></label>`;
        }).concat([M.roundRider, M.roundMount].map((d) =>
          `<label class="field"><span>${esc2(d.label)} <span class="muted">stock 1</span></span>
            <input type="number" class="mnt-round" data-off="${d.off}" min="0" max="999" value="${r16(d.off)}"></label>`)).join("");
    host.innerHTML = `<div class="card" style="margin:0 0 12px">
        <div class="bag-h">Battle mounts <span class="u">re-pairing confirmed in-game · patches game code</span></div>
        <div class="muted" style="margin:0 0 8px">The engine asks one question before seating a rider —
          <i>is this rider allowed on this mount?</i> — and answers it from three hard-coded comparisons.
          These dropdowns rewrite those three, so <b>any rider below can be put on Fubar, Bright or Ruby</b>.
          There is no fourth slot to add.</div>
        <div class="muted" style="margin:0 0 8px"><b>Re-pairing works, including across mount types.</b>
          Two re-pairings have been played through an emulator. <b>Hugo + Bright</b> mounts and fights
          correctly even though Hugo's mounted clips were authored for a griffon and Bright is a dragon.
          <b>Chris + Bright</b> then settled the harder case — a rider whose clips were authored around a
          <i>horse</i> driving a <i>flyer</i> — so the patch is settled and so is the direction that looked
          riskiest. What has no precedent yet is the reverse: a flyer-rigged rider (Hugo, Futch) on Ruby.
          Every combination below carries its own marker; keep a backup ISO for anything not marked
          <span class="mcf ok">✓ confirmed</span>.</div>
        <div class="muted" style="margin:0 0 8px"><b>The menu won't tell you it worked.</b> Observed with
          Chris + Bright: the formation menu shows no sign of the pairing, and the pair mounts in battle
          anyway. Judge a re-pairing by what happens when the battle starts, not by the menu.</div>
        <div class="warnbox" style="margin:0 0 8px"><b>Both halves must be in your party.</b> The candidate
          mount is drawn from party membership, so e.g. Chris on Bright still needs Futch recruited (that's
          how Bright joins) and both Chris and Bright deployed.</div>
        <div class="bag-h" style="margin-top:12px">Who can ride what <span class="u">confidence per combination</span></div>
        ${matrix}
        <details class="note"><summary>Where the markers come from, and how to give one rider two mounts</summary>
          <ul style="margin:4px 0 0 18px">
            <li><b>Riders</b> listed by default are the models that carry the <code>301/320/340</code>
              <i>mounted battle</i> clips — Hugo, Chris, Roland, Leo, Percival, Borus, Futch, Franz, and
              Sharon (partial). Those are the ones with an animation to play once they are seated.</li>
            <li><b>“Rigged for”</b> is the class of mount a rider's mounted clips were built around: Hugo's for
              a griffon and Futch's for a dragon (<i>flyer</i>), Chris's and the Zexen knights' for a horse,
              Franz's for Ruby (<i>horse</i>). Same class → <span class="mcf exp">• expected</span>;
              across classes → <span class="mcf unt">? untested</span>. Hugo+Bright is the one cross-mount
              case that has actually been played, and it works — which is encouraging for the rest, but
              flyer→flyer is a smaller jump than horse-rig→flyer.</li>
            <li><b>Mounts</b> are the party members whose model has a battle animation set: Fubar, Bright and
              Ruby. The field horses the Zexen knights and Hugo ride have no battle animations at all, so they
              aren't offered here — the <b>Assigned horse</b> card below is the route for those.</li>
            <li><b>Riders with no bank</b> (Geddoe, Thomas, Salome, Juan) are hidden behind the checkbox
              above. The comparison chain accepts them — it's a pure id compare — but they link to the mount
              and then keep their normal battle pose, because the motion call fails on the missing clips.
              Geddoe <i>does</i> have a full <i>field</i> ride set, so the game can show him on horseback out
              of battle; that is what the Assigned horse card gives him.</li>
            <li><b>One rider, two mounts</b> works: set two pairs to the same rider with different mounts
              (e.g. Hugo+Fubar and Hugo+Bright). The comparisons are checked in order and fall through cleanly.</li>
            <li>Rider seating in battle does <i>not</i> use the field saddle-offset table, so an unusual pair
              won't be mis-seated by it — but that also means nothing corrects the seat height either, which
              is exactly why a cross-class pairing is marked untested rather than expected.</li>
          </ul></details>
      </div>
      <div id="mountCards">${cards}</div>
      <div class="card" style="margin:0 0 12px">
        <div class="bag-h">Assigned horse <span class="u">BETA · one value per character · grants permission, doesn't stage the horse</span></div>
        <div class="muted" style="margin:0 0 8px">The game's <i>other</i> mount route: each character's own
          record can name a horse, and both the field and the battle gate honour it without the horse being in
          your party. Stock, this is what puts the six Zexen Knights on horseback — Chris on her own horse,
          the other five on the knight horse.</div>
        <div class="warnbox" style="margin:0 0 8px"><b>This grants permission — it does not by itself put
          anyone on a horse.</b> These horses are ordinary NPC models, not party members, so they hold no
          battle slot: the <i>scene</i> still has to stage one. That is why Chris rides in some battles and
          not others even though her record has always said 309. Setting this on a new character makes them
          eligible wherever the game already stages a horse; it cannot add a horse to a fight that has none.
          To <i>force</i> a horse in battle, use <b>Ruby</b> in the pair table above — she is a party member,
          so she brings her own battle slot.</div>
        <div class="grid eq">${horseRows}</div>
        <details class="note"><summary>Why only two horses, and what each character can actually do</summary>
          <ul style="margin:4px 0 0 18px">
            <li>The code that reads this does <code>(value − 308) &lt; 2</code> unsigned, so <b>only those two ids
              are honoured</b>. Any other mount id is read and silently discarded — which is why the Karaya horse
              and the flyers aren't offered here.</li>
            <li>The <b>pair table</b> above and this card fail in opposite ways. A pair mount is a recruited
              character, so it always has a battle slot and the pairing fires from party membership alone —
              that is why a re-paired Chris+Bright works in any fight with both deployed. An assigned horse
              needs no party slot but has no battle presence of its own, so it appears only where the scene
              already puts a horse. Reach beats reliability on one, reliability beats reach on the other.</li>
            <li><b>field+battle</b> characters carry both mounted animation banks. <b>field</b>-only ones
              (Geddoe, Thomas, Salome) will ride correctly on the map but keep their normal pose in battle —
              <i>Geddoe rides perfectly well outside combat</i>, which is the one thing the pair table above
              can't give him.</li>
            <li>Sharon has only a partial battle bank and Juan only a single field clip; both are offered but
              expect rough edges.</li>
          </ul></details>
      </div>
      <div class="card" style="margin:0 0 12px">
        <div class="bag-h">Mounted-pair mechanics <span class="u">BETA · rewrites game code</span></div>
        <div class="muted" style="margin:0 0 8px">When a pair mounts in battle the engine <b>pools their
          current HP and re-splits it in proportion to each half's max HP</b> — so mounting equalises the
          pair's HP <i>percentage</i> rather than merging the bars. Total is conserved. After that, damage
          lands on one half only and nothing rebalances again.</div>
        <div class="grid eq">${mechRows}</div>
        <div class="warnbox" style="margin:10px 2px 0">The proportional weighting itself isn't a constant, so
          it can't be exposed here — but it is driven by each half's <b>max HP</b>, which means the
          <b>Growth</b> tab already controls it. Give a mount a fatter HP curve and it carries a bigger share
          of the pair's pool.</div>
      </div>`;
    // Writes: rider rewrites every site for that pair (delay-slot duplicate included).
    const relabel = (i, what) => `Pair ${i + 1} ${what}`;
    function markSites(el, offs, origLabel) {
      const dirty = offs.some((o) => isDirty(o, 2));
      el.classList.toggle("dirty", dirty);
      let btn = el._revBtn;
      if (!btn) {
        if (!dirty) { scheduleBadge(); return; }
        btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
        btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); offs.forEach((o) => revertRange(o, 2)); drawView(); };
        el.insertAdjacentElement("afterend", btn); el._revBtn = btn;
      }
      btn.classList.toggle("show", dirty);
      if (dirty) btn.title = `Restore original (${origLabel})`;
      scheduleBadge();
    }
    { const cb = q("#mntAll", host);
      if (cb) cb.onchange = () => { mntAllRiders = cb.checked; drawView(); }; }
    qa("select.mnt-mech", host).forEach((sel) => {
      const off = +sel.dataset.off;
      sel.onchange = () => {
        writeW(off, 4, Number(sel.value) >>> 0);
        reg(off, 4, "num", "Mount mechanics", sel.closest("label").querySelector("span").textContent);
        markField(sel, off, 4, "num");
      };
      markField(sel, off, 4, "num");
    });
    qa("input.mnt-round", host).forEach((el) => {
      const off = +el.dataset.off;
      el.onchange = () => {
        const v = Math.max(0, Math.min(999, +el.value || 0)); el.value = v;
        writeW(off, 2, v);
        reg(off, 2, "num", "Mount mechanics", el.closest("label").querySelector("span").textContent);
        markField(el, off, 2, "num");
      };
      markField(el, off, 2, "num");
    });
    qa("select.mnt-horse", host).forEach((sel) => {
      const off = +sel.dataset.off;
      sel.onchange = () => {
        writeW(off, 2, +sel.value || 0);
        reg(off, 2, "num", "Assigned horse", sel.dataset.nm);
        markField(sel, off, 2, "num");
      };
      markField(sel, off, 2, "num");
    });
    // Both halves redraw the view rather than just marking themselves dirty: the confidence
    // marker on the summary, the note under the grid and the tier glyph on every *other*
    // option all depend on what this pair now holds, so leaving them as painted would show the
    // outgoing pair's verdict against the incoming pair's ids.
    qa("select.mnt-rider", host).forEach((sel) => {
      const i = +sel.dataset.i, offs = MOUNTS.pairs[i].riderSites;
      const orig = origW(offs[0], 2), origLbl = orig === 0 ? "none" : (riderName(orig) || `model ${orig}`);
      sel.onchange = () => {
        offs.forEach((o, n) => { writeW(o, 2, +sel.value || 0);
          reg(o, 2, "num", "Battle mounts", relabel(i, `rider${n ? " (delay-slot copy)" : ""}`)); });
        drawView();
      };
      markSites(sel, offs, origLbl);
    });
    qa("select.mnt-mount", host).forEach((sel) => {
      const i = +sel.dataset.i, off = MOUNTS.pairs[i].mountSite;
      const orig = origW(off, 2), origLbl = orig === 0 ? "none" : (mountName(orig) || `model ${orig}`);
      sel.onchange = () => {
        writeW(off, 2, +sel.value || 0);
        reg(off, 2, "num", "Battle mounts", relabel(i, "mount"));
        drawView();
      };
      markSites(sel, [off], origLbl);
    });
  }

  // ---- Test: experiments that are not known to work ---------------------------
  // Kept behind its own tab, and out of the Save Editor's picker, because the honest status
  // is "the patch does what it says and the game may still hang". Scripted scenes are
  // authored per protagonist; Koroku, Yuber and Lucia have all been seen to softlock one.
  let TESTVIEW = "avatar";
  const TESTS = [["avatar", "Field character"]];
  function drawTest(host) {
    host.innerHTML = `
      <div class="warnbox" style="margin:0 0 12px">
        <b>Experimental — expect these not to work.</b> The patches here rewrite game code
        correctly, but the game was not built for what they enable. Scripted scenes are written
        for a specific protagonist and the event data lives in packed files no editor can reach,
        so a scene can simply hang. Confirmed in play with <b>Koroku, Yuber and Lucia</b>.
        Treat all of it as a roaming toy, keep a backup save, and switch the leader back to
        Hugo, Chris, Geddoe or Thomas before triggering story. Note too that story scripts
        rewrite the leader byte themselves at <b>chapter transitions</b>, so a pick holds only
        until the next scene that sets it.
      </div>
      <div class="subtabs" id="testTabs" style="margin-bottom:12px">${TESTS.map(([k, l]) =>
        `<button class="chip${k === TESTVIEW ? " on" : ""}" data-t="${k}">${l}</button>`).join("")}</div>
      <div id="testView"></div>`;
    qa("#testTabs [data-t]", host).forEach((b) => (b.onclick = () => { TESTVIEW = b.dataset.t; drawView(); }));
    if (TESTVIEW === "avatar") drawAvatar(q("#testView", host));
  }

  // ---- Field character --------------------------------------------------------
  function avatarName(id) {
    const ri = AVATAR.PARTY_IDS.indexOf(id);
    if (ri >= 0) return (REF.names && REF.names.list1 && REF.names.list1[ri + 1]) || `model ${id}`;
    return AVATAR.EXTRA[id] || null;
  }

  // The chain at 0x17B7560, evaluated against whatever the buffer currently holds. Written
  // as the disassembly reads rather than simplified, so a changed immediate shows up here
  // the same way it will in the game.
  function avatarAllows(id) {
    const eq0 = r16(AVATAR.slots[0].off), gHi = r16(AVATAR.gates[0].off);
    const eq1 = r16(AVATAR.slots[1].off), gLo = r16(AVATAR.gates[1].off);
    const eq2 = r16(AVATAR.slots[2].off);
    if (id === eq0) return true;
    if (id < gHi) {
      if (id === 0) return false;
      if (id < gLo) return true;
      return id === eq2;
    }
    if (id === eq1) return true;
    if (id < r16(AVATAR.lo)) return false;
    if (id >= r16(AVATAR.hiTop)) return false;
    if (id < r16(AVATAR.hiBot)) return false;
    return true;
  }

  // Which area archives ship this model's cha_ records. Absence is a warning, not a verdict
  // — ETC.BIN carries every one of them too, and a resident model is not evicted on an area
  // change — so the readout says "ships in", never "will not work".
  function avatarAreas(id) {
    const m = REF && REF.avatarAreas && REF.avatarAreas.byModel && REF.avatarAreas.byModel[String(id)];
    return m && Array.isArray(m.areas) ? m.areas : null;
  }
  function avatarAreaCount() {
    const a = REF && REF.avatarAreas && REF.avatarAreas.archives;
    return Array.isArray(a) ? a.length : 0;
  }
  // The team index 0x177FEB4 resolves for this id, read back from the patched bytes.
  // Anything with no live case falls through the switch's default, which is index 0 (Hugo).
  function storyIndexOf(id) {
    const c = AVATAR.STORY.cases.find((x) => r16(x.off) === id);
    return c ? c.idx : 0;
  }

  function avatarAllowedIds() {
    const out = [];
    for (let id = 1; id <= 0xD7; id++) if (avatarAllows(id)) out.push(id);
    return out;
  }

  function drawAvatar(host) {
    const all = AVATAR.gates.concat(AVATAR.slots);
    const bad = all.concat([{ off: AVATAR.lo }, { off: AVATAR.hiTop }, { off: AVATAR.hiBot }])
      .filter((sIt) => !inBlk(sIt.off, 4));
    if (bad.length) {
      host.innerHTML = `<div class="warnbox">The field-character gate is not where this build expects it — no edits offered.</div>`;
      return;
    }
    const sigBad = AVATAR.gates.filter((g) => r8(g.off + 2) !== AVATAR.ltSig[0] || r8(g.off + 3) !== AVATAR.ltSig[1])
      .concat(AVATAR.slots.filter((s) => r8(s.off + 2) !== AVATAR.eqSig[0] || r8(s.off + 3) !== AVATAR.eqSig[1]));
    if (sigBad.length) {
      host.innerHTML = `<div class="warnbox">The instructions at the field-character gate don't look like this disc's — no edits offered.</div>`;
      return;
    }

    const allowed = avatarAllowedIds();
    const fbSites = AVATAR.ACTORFB.sites;
    const fbBad = fbSites.some((f) => !inBlk(f.off, 4) || (r32(f.off) !== f.stock && r32(f.off) !== f.alt));
    const actorFbOn = !fbBad && fbSites.every((f) => r32(f.off) === f.alt);
    const stock = new Set(AVATAR.STOCK_SET);
    const isWide = AVATAR.gates.every((g) => r16(g.off) === AVATAR.WIDE);
    const nArch = avatarAreaCount();
    const chip = (id) => {
      const ar = avatarAreas(id), si = storyIndexOf(id);
      const maps = ar ? ` · ${ar.length}/${nArch} maps` : "";
      const story = si === 0 ? "" : ` · story ${si}`;
      const title = ar
        ? `field model ships in ${ar.length} of ${nArch} area archives: ${ar.join(", ") || "none"}`
             + (si ? ` — uses its own story content (team index ${si})` : " — uses Hugo's story content")
        : "";
      return `<span class="tag${stock.has(id) ? "" : " acc2"}"${title ? ` title="${esc2(title)}"` : ""}>${
        esc2(avatarName(id) || `id ${id}`)} <span class="dim">#${id}${maps}${story}</span></span>`;
    };

    // Character options for the single-id slots: the 75 battle characters, then the two
    // named specials. Anything else would name a model the party space cannot address.
    const opts = (cur) => AVATAR.PARTY_IDS.map((id) =>
        `<option value="${id}"${id === cur ? " selected" : ""}>${esc2(avatarName(id) || "model " + id)} · #${id}</option>`).join("")
      + Object.entries(AVATAR.EXTRA).map(([id, nm]) =>
        `<option value="${id}"${+id === cur ? " selected" : ""}>${esc2(nm)} · #${id}</option>`).join("")
      + (AVATAR.PARTY_IDS.includes(cur) || AVATAR.EXTRA[cur] ? ""
         : `<option value="${cur}" selected>unknown id ${cur}</option>`);

    const slotRows = AVATAR.slots.map((sl, i) => {
      const cur = r16(sl.off), origLbl = avatarName(o16(sl.off)) || `id ${o16(sl.off)}`;
      return `<label class="field"><span>Slot ${i + 1} <span class="dim">${esc2(sl.label)}</span></span>
        <select class="av-slot" data-i="${i}" data-orig="${esc2(origLbl)}">${opts(cur)}</select></label>`;
    }).join("");

    const gateRows = AVATAR.gates.map((g, i) => `<label class="field">
        <span>Range bound ${i + 1} <span class="dim">${esc2(g.label)}</span></span>
        <input type="number" class="av-gate" data-i="${i}" min="0" max="511" value="${r16(g.off)}"></label>`).join("");

    host.innerHTML = `
      <div class="bag">
        <div class="bag-h">Field character <span class="u">patches game code · untested beyond the stock eight</span></div>
        <div class="muted" style="margin:0 0 10px">
          The character you run around the map as is the <b>party-leader byte at save 0x12</b>, and
          that byte names a <b>model</b>. One function decides whether that model is ever requested,
          and it is a hardcoded list of eight ids. Widen it here, then pick the character on the
          <b>Save Editor → Overview → Field character</b> field. Nothing about the party, the story
          or the scripts changes: this only stops the loader from refusing the id.
        </div>
        <div class="warnbox" style="margin:0 0 10px">
          Two things bite beyond the whitelist. The model has to be <b>resident in the area you
          are standing in</b> — coverage is on each chip below — and a <b>scripted scene can
          hang</b> whoever you pick, including the eight the game ships: Koroku is one of them and
          hangs. Being able to load a model is not the same as the game knowing what to do with it.
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:0 0 10px;align-items:center">
          <button id="avWide" class="chip${isWide ? " on" : ""}">Allow every battle character</button>
          <button id="avStock" class="chip">Restore stock eight</button>
          <span class="muted" style="font-size:12px">The first sets both range bounds to ${AVATAR.WIDE} (one past Emily, the last battle id).</span>
        </div>
        <div class="grid">${gateRows}${slotRows}</div>
        <div style="margin:12px 0 0">
          <b>Currently loadable as the field character</b>
          <span class="muted">· ${allowed.length} id${allowed.length === 1 ? "" : "s"}, read back from the patched bytes</span>
          <div style="margin:6px 0 0;line-height:2">${allowed.map(chip).join(" ")}</div>
        </div>
        <div class="bag-h" style="margin:16px 0 8px">Scene softlocks <span class="u">the actor lookup · untested</span></div>
        <div class="muted" style="margin:0 0 10px">
          Scripts name an actor two ways. <b>"The player"</b> resolves through the leader byte and
          works for anyone — which is why your avatar walks into the scene, and why talking to
          NPCs is fine. <b>"The character whose id is N"</b> scans the scene's actor records for
          that id and <b>returns nothing when they are absent</b>. A Hugo-chapter scene asking for
          Hugo gets nothing the moment you are somebody else, and the beat that would have made
          him speak has no actor — which is exactly where the game stops.
        </div>
        <label class="row" style="gap:8px;cursor:pointer;align-items:baseline;margin:0 0 6px">
          <input type="checkbox" id="avActorFb"${actorFbOn ? " checked" : ""}>
          <b>An actor nobody can find falls back to the player</b>
          <span class="muted" style="font-size:12px">so Koroku answers to Hugo's id</span></label>
        <div class="warnbox" style="margin:0 0 10px">
          <b>Tried in play, and it did not fix the hang.</b> Kept here because a patch that was
          built and did not help is worth recording. Most likely it never fires: if scenes reach
          protagonists by actor <i>slot</i> rather than by character id, the lookup never returns
          null and this exit is never taken. It can also hang the game harder than it already does —
          the fallback
          re-enters the same lookup with your leader's id, so in a scene whose actor table has no
          record for <i>your</i> character it recurses forever. The exit is two instructions —
          enough for a jump, not for a guard — so there is nowhere to put the check. Try it on a
          save you can throw away.
        </div>
        <div class="bag-h" style="margin:16px 0 8px">Story content <span class="u">which team's events and dialogue a leader gets</span></div>
        <div class="muted" style="margin:0 0 10px">
          The leader byte is also <b>whose story this is</b>. One switch turns it into a team
          index that picks which variant of a town's events and dialogue loads. Hugo is index
          <b>0</b>, and <b>0 is also what an unrecognised leader gets</b> — so switching a
          character to <i>Hugo's</i> here just retires its own case and lets it fall through.
          That is the fix for empty dialogue boxes: a town with no entry for Luc's index has
          one for Hugo's.
        </div>
        <table class="invtbl"><thead><tr><th>Character</th><th>Story content</th><th>Team index</th></tr></thead><tbody>
        ${AVATAR.STORY.cases.filter((c) => !c.fixed).map((c, i) => {
          const live = r16(c.off) === c.id;
          return `<tr><td>${esc2(avatarName(c.id) || "id " + c.id)} <span class="dim">#${c.id}</span></td>
            <td><select class="av-story" data-i="${i}">
              <option value="own"${live ? " selected" : ""}>its own (stock)</option>
              <option value="hugo"${live ? "" : " selected"}>Hugo's</option></select></td>
            <td class="dim">${live ? c.idx : "0 (Hugo)"}</td></tr>`;
        }).join("")}
        </tbody></table>
        <div class="muted" style="font-size:12px;margin:6px 0 0">
          Only this one switch knows these characters; the other six already send them to
          Hugo, which is why a single word is enough. It changes which content loads, not
          whether that content fits the scene you are standing in.
          <br><b>This is for empty dialogue boxes, not for softlocks.</b> Confirmed in play:
          switching Koroku to Hugo's content does <i>not</i> fix a scene that hangs — his model
          is missing the <code>evneutral</code> event-idle clip (the only model on the disc that
          is), so the script waits on an animation that cannot play. Loading more content that
          runs makes that likelier, not less.
        </div>
        <details class="note" style="margin:10px 0 0"><summary>The chain, and where each byte lives</summary>
          <pre style="white-space:pre-wrap;font-size:12px">FieldAvatarModelRequest(id)          ; vaddr 0x17B7560
    if (id == slot1)         LOAD      ; ISO 0x1FED64
    if (id &lt;  bound1) {                ; ISO 0x1FED70
        if (id == 0)         return
        if (id &lt;  bound2)    LOAD      ; ISO 0x1FED80
        if (id == slot3)     LOAD      ; ISO 0x1FED88
        return }
    if (id == slot2)         LOAD      ; ISO 0x1FED78
    ... 202 / 203 fall through         ; ISO 0x1FEDA0 / 0x1FEDAC / 0x1FEDB4
LOAD: request the model             ; 0x16E0FF8, the only issuer</pre>
          <div class="muted">Every id above is a 16-bit instruction immediate, so only the low
          half-word of each instruction changes and the opcode bytes stay put.</div>
        </details>
      </div>`;

    qa("select.av-slot", host).forEach((sel) => {
      const sl = AVATAR.slots[+sel.dataset.i];
      sel.onchange = () => {
        writeW(sl.off, 2, clampInt(sel.value, 0, 0xFFFF));
        reg(sl.off, 2, "num", "Field character", sl.label);
        drawView();
      };
      markField(sel, sl.off, 2, "num");
    });
    qa("input.av-gate", host).forEach((el) => {
      const g = AVATAR.gates[+el.dataset.i];
      el.onchange = () => {
        const v = clampInt(el.value, 0, 511); el.value = v;
        writeW(g.off, 2, v);
        reg(g.off, 2, "num", "Field character", g.label);
        drawView();
      };
      markField(el, g.off, 2, "num");
    });
    q("#avWide", host).onclick = () => {
      AVATAR.gates.forEach((g) => { writeW(g.off, 2, AVATAR.WIDE); reg(g.off, 2, "num", "Field character", g.label); });
      drawView();
    };
    { const cb = q("#avActorFb", host);
      if (cb) {
        if (fbBad) { cb.disabled = true; cb.title = "these instructions aren't stock — not offered"; }
        cb.onchange = () => {
          fbSites.forEach((f) => { writeW(f.off, 4, cb.checked ? f.alt : f.stock);
            reg(f.off, 4, "num", "Scene softlocks", "actor fallback"); });
          drawView();
        };
        cb.classList.toggle("dirty", fbSites.some((f) => isDirty(f.off, 4)));
      } }
    { const editable = AVATAR.STORY.cases.filter((c) => !c.fixed);
      qa("select.av-story", host).forEach((sel) => {
        const c = editable[+sel.dataset.i];
        sel.onchange = () => {
          writeW(c.off, 2, sel.value === "own" ? c.id : AVATAR.STORY.OFF);
          reg(c.off, 2, "num", "Story content", avatarName(c.id) || ("id " + c.id));
          drawView();
        };
        markField(sel, c.off, 2, "num");
      }); }
    q("#avStock", host).onclick = () => {
      AVATAR.gates.concat(AVATAR.slots).forEach((sIt) => {
        writeW(sIt.off, 2, sIt.stock); reg(sIt.off, 2, "num", "Field character", sIt.label);
      });
      // "stock" means the whole section, story cases included — otherwise the button half
      // reverts and the readout disagrees with the label.
      AVATAR.STORY.cases.forEach((c) => {
        writeW(c.off, 2, c.id); reg(c.off, 2, "num", "Story content", avatarName(c.id) || ("id " + c.id));
      });
      AVATAR.ACTORFB.sites.forEach((f) => {
        writeW(f.off, 4, f.stock); reg(f.off, 4, "num", "Scene softlocks", "actor fallback");
      });
      drawView();
    };
  }

  // ---- Movement speed --------------------------------------------------------
  const spdAddr = (cls, col) => MOVESPD.tbl + cls * MOVESPD.stride + col.off;
  const spdClassAddr = (rec) => TABLES.list2[0] + rec * TABLES.list2[1] + MOVESPD.classOff;
  const spdFmt = (v) => Number.isFinite(v) ? String(+v.toFixed(3)) : "?";

  // Structural check against the PRISTINE bytes: 14 records whose id field is zero and whose
  // three floats are finite and positive. A disc that fails this is not one we understand,
  // so nothing is offered rather than something being written blind.
  function moveSpdOk() {
    if (!inBlk(MOVESPD.tbl, MOVESPD.rows * MOVESPD.stride)) return false;
    for (let c = 0; c < MOVESPD.rows; c++) {
      if (o32(MOVESPD.tbl + c * MOVESPD.stride) !== 0) return false;
      for (const col of MOVESPD.cols) {
        const v = oF32(spdAddr(c, col));
        if (!Number.isFinite(v) || v <= 0 || v > MOVESPD.MAX) return false;
      }
    }
    return true;
  }

  // class -> [{rec, name}], read live off the disc so a reassignment shows up immediately.
  function spdMembers() {
    const out = {}, names = (REF && REF.names && REF.names.list2) || {};
    for (let rec = 0; rec < LIST_COUNT.list2; rec++) {
      const off = spdClassAddr(rec);
      if (!inBlk(off, 1)) continue;
      const cls = r8(off);
      (out[cls] = out[cls] || []).push({ rec, name: names[String(rec)] || `record ${rec}` });
    }
    return out;
  }

  // ---- giving one character its own speed ------------------------------------
  // The engine has no per-character speed: a character points at a shared class row. So
  // "give Chris her own speed" means finding a row that can hold it. Four cases, cheapest
  // first, and only the last one spends a row:
  //
  //   1. the character's row already holds exactly this  -> nothing to do
  //   2. the character is the ONLY thing pointing at its row -> edit that row in place
  //   3. some other row already holds exactly this -> point the character at it (free: rows
  //      are shared, so two characters wanting the same speed cost one row between them)
  //   4. otherwise -> take a row nobody points at, write it, point the character there
  //
  // The budget is therefore *distinct speeds*, not characters. Class 0 is never a candidate
  // for 2 or 4: every model with no list2 record falls back to it (GetModelClass returns 0),
  // so editing it would change every townsperson and enemy too.
  const SPD_EPS = 1e-4;
  const spdRowVals = (cls) => MOVESPD.cols.map((c) => rF32(spdAddr(cls, c)));
  const spdRowOrig = (cls) => MOVESPD.cols.map((c) => oF32(spdAddr(cls, c)));
  const spdSame = (a2, b2) => a2.every((v, i) => Math.abs(v - b2[i]) < SPD_EPS);

  // Membership over ALL 80 records, not just the named ones: record 0 is the unnamed default
  // several model ids resolve to, and a row it points at is not free.
  function spdRefCount() {
    const live = {}, orig = {};
    for (let rec = 0; rec < LIST_COUNT.list2; rec++) {
      const off = spdClassAddr(rec);
      if (!inBlk(off, 1)) continue;
      live[r8(off)] = (live[r8(off)] || 0) + 1;
      orig[o8(off)] = (orig[o8(off)] || 0) + 1;
    }
    return { live, orig };
  }
  const spdSpareRows = (ref) => {
    const out = [];
    for (let c = 1; c < MOVESPD.rows; c++) if (!ref.live[c]) out.push(c);
    return out;
  };
  function spdWriteRow(cls, vals) {
    MOVESPD.cols.forEach((col, i) => {
      const off = spdAddr(cls, col);
      writeF32(off, vals[i]);
      reg(off, 4, "f32", "Movement speed", `class ${cls} ${col.label.toLowerCase()}`);
    });
  }
  // A row nothing points at, that nothing pointed at on the pristine disc either, cannot
  // affect the game — so restore its bytes rather than leaving an orphaned edit staged.
  function spdCollectGarbage() {
    const ref = spdRefCount();
    let n = 0;
    for (let c = 1; c < MOVESPD.rows; c++) {
      if (ref.live[c] || ref.orig[c]) continue;
      if (spdSame(spdRowVals(c), spdRowOrig(c))) continue;
      MOVESPD.cols.forEach((col) => revertRange(spdAddr(c, col), 4));
      n++;
    }
    return n;
  }
  // -> { ok, msg } ; writes nothing when it cannot honour the request.
  function spdAssign(rec, vals) {
    const off = spdClassAddr(rec);
    if (!inBlk(off, 1)) return { ok: false, msg: "that character's record is outside the block." };
    const ref = spdRefCount(), cur = r8(off);
    const name = ((REF && REF.names && REF.names.list2) || {})[String(rec)] || `record ${rec}`;
    const setClass = (c) => { writeW(off, 1, c); reg(off, 1, "num", "Speed class", name); };

    if (cur < MOVESPD.rows && spdSame(spdRowVals(cur), vals))
      return { ok: true, msg: `${name} already has that speed (class ${cur}) — nothing staged.` };

    if (cur !== 0 && cur < MOVESPD.rows && ref.live[cur] === 1) {
      spdWriteRow(cur, vals);
      const gc = spdCollectGarbage();
      return { ok: true, msg: `${name} is the only character in class ${cur}, so that row was `
        + `retuned in place — no spare row spent.` + (gc ? ` ${gc} orphaned row(s) restored.` : "") };
    }

    for (let c = 0; c < MOVESPD.rows; c++) {
      if (c === cur || !spdSame(spdRowVals(c), vals)) continue;
      setClass(c);
      const gc = spdCollectGarbage();
      return { ok: true, msg: `${name} moved to class ${c}, which already holds that speed — `
        + `no spare row spent.` + (gc ? ` ${gc} orphaned row(s) restored.` : "") };
    }

    const spare = spdSpareRows(ref).filter((c) => c !== cur);
    if (!spare.length)
      return { ok: false, msg: "every row is in use. Give a character a speed another character "
        + "already has, or move a row's last character out to free it." };
    const c = spare[0];
    spdWriteRow(c, vals);
    setClass(c);
    const gc = spdCollectGarbage();
    const left = spdSpareRows(spdRefCount()).length;
    return { ok: true, msg: `${name} given its own row (class ${c}). ${left} spare row(s) left.`
      + (gc ? ` ${gc} orphaned row(s) restored.` : "") };
  }

  function drawMoveSpeed(host) {
    if (!host) return;
    if (!moveSpdOk()) {
      host.innerHTML = `<div class="warnbox">The movement-speed table isn't where this build expects
        it — no speed edits offered.</div>`;
      return;
    }
    const mem = spdMembers();
    const names = (REF && REF.names && REF.names.list2) || {};
    const memberOf = (cls) => (mem[cls] || []).filter((m) => names[String(m.rec)]);

    const classRow = (cls) => {
      const who = memberOf(cls);
      const cells = MOVESPD.cols.map((col) => {
        const off = spdAddr(cls, col);
        return `<td><input type="number" class="spd-f" data-cls="${cls}" data-col="${col.key}"
          min="0" max="${MOVESPD.MAX}" step="0.1" value="${spdFmt(rF32(off))}"></td>`;
      }).join("");
      return `<tr><td><b>${cls}</b></td>${cells}
        <td class="dim">${who.length ? esc2(who.map((m) => m.name).join(", ")) : "— no one —"}</td></tr>`;
    };
    const used = [], unused = [];
    for (let c = 0; c < MOVESPD.rows; c++) (memberOf(c).length ? used : unused).push(c);

    // ---- quick-set card state ----
    const named = [];
    for (let rec = 0; rec < LIST_COUNT.list2; rec++) {
      const nm = names[String(rec)];
      if (nm && inBlk(spdClassAddr(rec), 1)) named.push({ rec, name: nm });
    }
    if (spdQuickRec === null || !named.some((x) => x.rec === spdQuickRec))
      spdQuickRec = named.length ? named[0].rec : null;
    const spare = spdSpareRows(spdRefCount());
    const quickOpts = named.map((x) =>
      `<option value="${x.rec}"${x.rec === spdQuickRec ? " selected" : ""}>${esc2(x.name)}</option>`).join("");
    const qCls = spdQuickRec === null ? 0 : r8(spdClassAddr(spdQuickRec));
    const qVals = qCls < MOVESPD.rows ? spdRowVals(qCls) : MOVESPD.cols.map((c) => c.stock);
    // The count has to come from the reference count over ALL 80 records, not just the named
    // ones, or this line would promise a free in-place retune that the allocator then refuses
    // because an unnamed record (record 0, the default several model ids resolve to) shares
    // the row. Names are listed from the named members only — "record 0" means nothing to a user.
    const qRefs = spdRefCount().live[qCls] || 0;
    const qOthers = Math.max(0, qRefs - 1);
    const qNamed = memberOf(qCls).filter((m) => m.rec !== spdQuickRec);
    const qHidden = Math.max(0, qOthers - qNamed.length);
    const qWho = qNamed.slice(0, 4).map((m) => m.name)
      .concat(qNamed.length > 4 ? ["…"] : [])
      .concat(qHidden ? [`${qHidden} unnamed`] : []).join(", ");
    const qNowText = spdQuickRec === null ? ""
      : `Currently class ${qCls} — walk ${spdFmt(qVals[0])}, run ${spdFmt(qVals[1])}, time scale `
        + `${spdFmt(qVals[2])}. ` + (qOthers
          ? `Shared with ${qOthers} other${qOthers === 1 ? "" : "s"}`
            + (qWho ? ` (${qWho})` : "") + `, so editing the row directly would move them too.`
          : "Nobody else is in that class, so it can be retuned in place at no cost.");
    const qMsg = spdQuickMsg && spdQuickMsg.rec === spdQuickRec ? spdQuickMsg.msg : null;
    const qMsgKind = spdQuickMsg && spdQuickMsg.kind === "bad" ? "warnbox" : "note";

    const head = `<thead><tr><th>Class</th>${MOVESPD.cols.map((c) =>
      `<th>${c.label}${c.hint ? `<br><span class="dim" style="font-weight:400">${esc2(c.hint)}</span>` : ""}</th>`
      ).join("")}<th>Characters in this class</th></tr></thead>`;

    // Per-character class picker: one row per named list2 record.
    const charRows = [];
    for (let rec = 0; rec < LIST_COUNT.list2; rec++) {
      const nm = names[String(rec)]; if (!nm) continue;
      const off = spdClassAddr(rec); if (!inBlk(off, 1)) continue;
      const cur = r8(off);
      const opts = [];
      for (let c = 0; c <= MOVESPD.MAXCLASS; c++) {
        const run = spdFmt(rF32(spdAddr(c, MOVESPD.cols[1])));
        opts.push(`<option value="${c}"${c === cur ? " selected" : ""}>class ${c} · run ${run}</option>`);
      }
      if (cur > MOVESPD.MAXCLASS) opts.push(`<option value="${cur}" selected>class ${cur} — past the table</option>`);
      charRows.push(`<label class="field"><span>${esc2(nm)} <span class="dim">#${rec}</span></span>
        <select class="spd-cls" data-rec="${rec}" data-nm="${esc2(nm)}">${opts.join("")}</select></label>`);
    }

    host.innerHTML = `
      <div class="bag">
        <div class="bag-h">Field movement speed <span class="u">plain data · no code patched · untested in play</span></div>
        <div class="muted" style="margin:0 0 10px">
          How fast a character walks and runs <b>on the field</b> is a <b>table</b>, not code. Every field
          object gets a walk speed and a run speed from one of 14 rows, and which row it reads is a
          <b>movement class</b> stored on the character. Stock, <b>walking is 2.0 for the whole cast</b>
          and running is <b>6.0</b>, <b>5.0</b> or <b>4.5</b> depending on the class — so running as
          Hugo (6.0) covers a third more ground than as Chris (4.5). Mounts are
          ordinary field objects with their own class, so a mount's row is the mounted speed.
        </div>
        <div class="warnbox" style="margin:0 0 10px">
          <b>Field only — this does not change battle movement.</b> The table's values reach every
          object, but the battle unit spawner immediately overwrites both speeds from the character's
          <b>loaded battle asset</b>, which lives in the packed archives and not in the executable.
          Nothing overwrites a field object, so on the field these are the values that stay.
        </div>
        <div class="muted" style="margin:0 0 10px">
          Most of the cast here can never be the character you walk around <i>as</i> — that is a
          separate list of eight ids (see the <b>Test</b> tab). They are in the table because a field
          object is anyone the field walks around: the recruits standing about Budehuc Castle, and
          anyone an event script walks through a scene. The classes group by <b>body type</b> —
          teenagers, adult men, women, beast-people, big men — which is what a walking-around-town
          speed would be keyed on.
        </div>
        <div class="bag-h" style="margin:0 0 8px">Give one character its own speed
          <span class="u">picks a spare row for you</span></div>
        <div class="muted" style="margin:0 0 10px">
          Speed is stored per <i>class</i>, not per character, so a character can only have its
          own speed if a row is free to hold it. Set a number here and the editor sorts that out:
          it retunes the row in place when nobody else is in it, points you at an existing row
          that already holds the same speed, and only spends a spare row when it has to. The
          budget is therefore <b>distinct speeds</b>, not characters &mdash;
          <b id="spdSpare">${spare.length}</b> spare row${spare.length === 1 ? "" : "s"} right now.
          The boxes always start at the stock baseline
          (${MOVESPD.cols.map((c) => `${c.label.toLowerCase()} ${c.stock}`).join(", ")}); the line
          under them is what the character has <i>now</i>.
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin:0 0 6px">
          <label class="field" style="min-width:190px;flex:0 1 220px"><span>Character</span>
            <select id="spdQChar">${quickOpts}</select></label>
          ${MOVESPD.cols.map((c) => `<label class="field" style="max-width:120px"><span>${c.label}
            <span class="dim">${esc2(c.hint || "")}</span></span>
            <input type="number" class="spd-q" data-col="${c.key}" min="0" max="${MOVESPD.MAX}"
              step="0.1" value="${spdFmt(c.stock)}"></label>`).join("")}
          <button class="primary" id="spdQApply">Give this speed</button>
          <button class="chip" id="spdQReset">Reset this character</button>
        </div>
        <div class="muted" style="font-size:12px;margin:0 0 4px" id="spdQNow">${esc2(qNowText)}</div>
        ${qMsg ? `<div class="${qMsgKind}" style="margin:6px 0 0">${esc2(qMsg)}</div>` : ""}
        <details class="note" id="spdAdvanced" style="margin:16px 0 0">
        <summary>Class rows and manual assignment <span class="dim">&mdash; you should not need this</span></summary>
        <div class="muted" style="margin:8px 0 10px">
          The card above allocates and frees rows for you. Open this to do it by hand: retune a
          whole class at once (every character in it moves together), see exactly which row each
          character points at, or reach the rows nobody is in.
        </div>
        <div class="bag-h" style="margin:12px 0 8px">The class rows
          <span class="u">editing one retunes everyone in it</span></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:0 0 10px;align-items:center">
          <button id="spdLevel" class="chip">Everyone runs at ${MOVESPD.LEVEL}.0</button>
          <button id="spdStock" class="chip">Restore as loaded</button>
          <span class="muted" style="font-size:12px">The first sets every run speed to the fastest
            stock value and leaves walk and time scale alone. The second restores the whole
            section &mdash; speeds <i>and</i> class assignments, including anything the card
            above staged &mdash; to the bytes this ISO was opened with.</span>
        </div>
        <table class="invtbl">${head}<tbody>${used.map(classRow).join("")}</tbody></table>
        <details class="note" style="margin:10px 0 0"><summary>What &ldquo;time scale&rdquo; means, and when to touch it</summary>
          <p style="margin:8px 0">It is that object's <b>clock multiplier</b> &mdash; not an
          animation-only setting. Once per frame the engine takes how much real time has passed,
          multiplies it by this number, and hands the result both to the character's animation
          clock <i>and</i> to the step that moves them. So <b>2.0</b> means &ldquo;this character
          experiences two seconds for every one that passes&rdquo;: they animate twice as fast and
          cover ground twice as fast. <b>0.5</b> is slow motion for that one character while
          everything around them carries on normally.</p>
          <p style="margin:8px 0">That makes it a different lever from the <b>Run</b> column beside
          it, and the two fix different problems:</p>
          <ul style="margin:8px 0 8px 18px;padding:0">
            <li><b>Run</b> changes how far a stride carries you and nothing else. Raise it alone and
              the character <b>skates</b> &mdash; gliding along with their legs still cycling at the
              old rate.</li>
            <li><b>Time scale</b> speeds up the whole character, so the feet keep up &mdash; but it
              also speeds up everything you might not want faster: idle fidgets, turning on the
              spot, and the wind-up and stop at each end of a walk.</li>
          </ul>
          <p style="margin:8px 0">So a small rise in both usually looks better than a big rise in
          either. The engine agrees, which is the best evidence for what the field is for: a party
          member who has fallen behind is given a temporary <b>1.2</b> or <b>1.3</b> to hurry them
          along, and one movement state computes it as <i>current speed &divide; intended speed</i>
          &mdash; exactly the correction that keeps a stride matching the ground.</p>
          <p style="margin:8px 0"><b>One caveat.</b> What you set here is the character's
          <i>starting</i> clock. The situations above write over it while they last, so a party
          follower or anyone mid-way through a scripted walk may not keep your value. The engine
          clamps it at 10000, and every class ships at 1.0.</p>
        </details>
        <details class="note" style="margin:10px 0 0"><summary>Rows nobody uses (classes ${unused.join(", ")})</summary>
          <table class="invtbl">${head}<tbody>${unused.map(classRow).join("")}</tbody></table>
          <div class="muted" style="font-size:12px">No character ships in these. They only matter if you
          move someone into one below.</div>
        </details>
        <div class="bag-h" style="margin:16px 0 8px">Which class each character is in
          <span class="u">one byte per character · list2 record +0x78</span></div>
        <div class="muted" style="margin:0 0 10px">
          Change a character's class to give them someone else's speed without touching anyone
          else — Chris from class 2 to class 3 makes her run as fast as Hugo. Editing a row above
          instead retunes everyone in that class at once.
        </div>
        <details class="note" id="spdChars"><summary>Show all ${charRows.length} characters</summary>
          <div class="grid" style="margin-top:8px">${charRows.join("")}</div></details>
        </details>
      </div>`;

    // ---- quick-set handlers ----
    {
      const sel = q("#spdQChar", host);
      if (sel) sel.onchange = () => { spdQuickRec = +sel.value; spdQuickMsg = null; drawView(); };
      const readVals = () => MOVESPD.cols.map((c) => {
        const el = q(`input.spd-q[data-col="${c.key}"]`, host);
        return Math.max(0, Math.min(MOVESPD.MAX, +(el ? el.value : c.stock) || 0));
      });
      const apply = q("#spdQApply", host);
      if (apply) apply.onclick = () => {
        if (spdQuickRec === null) return;
        const res = spdAssign(spdQuickRec, readVals());
        spdQuickMsg = { rec: spdQuickRec, msg: res.msg, kind: res.ok ? "ok" : "bad" };
        setStatus(res.msg, res.ok ? "ok" : "warn");
        drawView();
      };
      const rst = q("#spdQReset", host);
      if (rst) rst.onclick = () => {
        if (spdQuickRec === null) return;
        revertRange(spdClassAddr(spdQuickRec), 1);
        const gc = spdCollectGarbage();
        const nm = names[String(spdQuickRec)] || `record ${spdQuickRec}`;
        spdQuickMsg = { rec: spdQuickRec, kind: "ok",
          msg: `${nm} put back in the class the disc gives them.`
               + (gc ? ` ${gc} row(s) it had left orphaned were restored.` : "") };
        drawView();
      };
    }

    qa("input.spd-f", host).forEach((el) => {
      const cls = +el.dataset.cls, col = MOVESPD.cols.find((c) => c.key === el.dataset.col);
      const off = spdAddr(cls, col);
      el.onchange = () => {
        const v = Math.max(0, Math.min(MOVESPD.MAX, +el.value || 0));
        writeF32(off, v);
        reg(off, 4, "f32", "Movement speed", `class ${cls} ${col.label.toLowerCase()}`);
        drawView();
      };
      markField(el, off, 4, "f32");
    });
    qa("select.spd-cls", host).forEach((sel) => {
      const rec = +sel.dataset.rec, off = spdClassAddr(rec);
      sel.onchange = () => {
        writeW(off, 1, clampInt(sel.value, 0, 0xFF));
        reg(off, 1, "num", "Speed class", sel.dataset.nm);
        drawView();
      };
      markField(sel, off, 1, "num");
    });
    q("#spdLevel", host).onclick = () => {
      const col = MOVESPD.cols[1];
      for (let c = 0; c < MOVESPD.rows; c++) {
        const off = spdAddr(c, col);
        writeF32(off, MOVESPD.LEVEL);
        reg(off, 4, "f32", "Movement speed", `class ${c} ${col.label.toLowerCase()}`);
      }
      drawView();
    };
    q("#spdStock", host).onclick = () => {
      // "as loaded" is the whole section, class assignments included — otherwise the
      // button half-reverts and the members column disagrees with the speeds beside it.
      // Like every ↺ in this editor it restores the bytes this ISO was opened with, which
      // after a save is what was saved — not the factory disc.
      for (let c = 0; c < MOVESPD.rows; c++) MOVESPD.cols.forEach((col) => revertRange(spdAddr(c, col), 4));
      for (let rec = 0; rec < LIST_COUNT.list2; rec++) {
        const off = spdClassAddr(rec);
        if (inBlk(off, 1)) revertRange(off, 1);
      }
      drawView();
    };
  }

  function drawGear(host) {
    const g = scanGear();
    const ids = Object.keys(g).map(Number).sort((a, b) => a - b);
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="gUpd"${gearDescOn ? " checked" : ""}> also rewrite the DEF(+N) number in the description when DEF changes</label>`;
    const rows = [];
    for (const iid of ids) {
      const nm = itemName(iid);
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && hex(iid, 3).toLowerCase() !== SEARCH) continue;
      const base = g[iid], def = base + GEAR.def, price = base + GEAR.price, dptr = r32(base + 0x00);
      const descStr = strAt(dptr), descMax = origSlotLen(dptr);
      const nptr = r32(base + GEAR.name), nameMax = origSlotLen(nptr);
      const effs = GEAR.effs.map((eo) => effectSlotHTML(nm, base, eo)).join("");
      rows.push(`<details class="char" data-base="${base}"><summary><span class="chev">▸</span>
          <span class="nm">${esc2(nm)}</span><span class="muted">${hex(iid, 3)}</span>
          <span class="lv">DEF ${r16(def)} · ${r32(price)}p</span></summary>
        <div class="char-body"><div class="grid">
          <label class="field"><span>DEF</span><input type="number" class="gr" min="0" max="65535" value="${r16(def)}" data-off="${def}" data-w="2" data-dptr="${dptr}" data-g="${esc2(nm)}" data-l="DEF"></label>
          <label class="field"><span>Price (potch)</span><input type="number" class="gr" min="0" max="4294967295" value="${r32(price)}" data-off="${price}" data-w="4" data-g="${esc2(nm)}" data-l="Price"></label>
        </div>
        <label class="field" style="margin-top:8px"><span>Name (${nameMax} char slot)</span>
          <input type="text" class="ge-name" maxlength="${nameMax}" value="${esc2(nm)}" data-nptr="${nptr}" data-iid="${iid}" data-g="${esc2(nm)}"></label>
        <label class="field" style="margin-top:8px"><span>Description (${descMax} char slot)</span>
          <input type="text" class="ge-desc" maxlength="${descMax}" value="${esc2(descStr)}" data-dptr="${dptr}" data-g="${esc2(nm)}"></label>
        <h4>Effect slots</h4>${effs}</div></details>`);
    }
    host.innerHTML = updBox + (rows.join("") || `<div class="muted">no matching equipment</div>`);
    q("#gUpd", host).onchange = (e) => { gearDescOn = e.target.checked; };

    qa("input.gr", host).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w, nm = inp.dataset.g;
      inp.onchange = () => {
        const v = Math.max(0, Math.min(+inp.value || 0, w === 2 ? 65535 : 4294967295));
        writeW(off, w, v); reg(off, w, "num", nm, inp.dataset.l); markField(inp, off, w, "num");
        if (inp.dataset.l === "DEF" && gearDescOn && inp.dataset.dptr) {
          const r = rewriteDesc(+inp.dataset.dptr, (t) => descDef(t, v), nm, "Description");
          const di = q(`.ge-desc[data-dptr="${inp.dataset.dptr}"]`, host);
          if (di && r.ok) { di.value = strAt(+inp.dataset.dptr); markField(di, vaOff(+inp.dataset.dptr), origSlotLen(+inp.dataset.dptr), "text"); }
        }
      };
      markField(inp, off, w, "num");
    });
    // Renaming is the same in-place, same-slot write the descriptions use: the string is
    // overwritten where it already sits and null-padded, so no pointer anywhere on the disc moves.
    // Every menu that shows the item reads through that one pointer, so the new name is global.
    qa("input.ge-name", host).forEach((inp) => {
      const nptr = +inp.dataset.nptr, iid = +inp.dataset.iid, was = inp.dataset.g;
      inp.onchange = () => {
        const want = inp.value.trim();
        if (!want) { inp.value = strAt(nptr); return setStatus("An item needs a name — left unchanged.", "warn"); }
        const r = setDescText(nptr, want, was, "Name");
        if (r.tooLong) { setStatus(`"${want}" is too long — the name slot holds ${r.max} characters.`, "warn"); inp.value = strAt(nptr); }
        else if (r.skip) setStatus("This item's name can't be edited on this disc.", "warn");
        else { gearAlias[want] = iid; gearCache = null; }   // rescan must still find the record
        const now = strAt(nptr);
        inp.value = now;
        const sum = inp.closest("details.char");
        if (sum) { const t = q(".nm", sum); if (t) t.textContent = now; }
        markField(inp, vaOff(nptr), origSlotLen(nptr), "text");
      };
      markField(inp, vaOff(nptr), origSlotLen(nptr), "text");
    });
    qa("input.ge-desc", host).forEach((inp) => {
      const dptr = +inp.dataset.dptr;
      inp.onchange = () => {
        const r = setDescText(dptr, inp.value, inp.dataset.g, "Description");
        if (r.tooLong) setStatus(`Description too long — the slot holds ${r.max} characters.`, "warn");
        markField(inp, vaOff(dptr), origSlotLen(dptr), "text");
      };
      markField(inp, vaOff(dptr), origSlotLen(dptr), "text");
    });
    qa("[data-eff]", host).forEach((rowEl) => wireEffectSlot(rowEl));
  }
  function wireEffectSlot(rowEl) {
    const base = +rowEl.dataset.base, eo = +rowEl.dataset.eo, nm = rowEl.dataset.g;
    const tSel = rowEl.querySelector(".ge-type"), vIn = rowEl.querySelector(".ge-val");
    const stat = rowEl.querySelector(".ge-stat"), skill = rowEl.querySelector(".ge-skill");
    const commit = () => {
      const t = +tSel.value, pk = GEAR_TYPE_PARAM[t];
      stat.style.display = pk === "stat" ? "" : "none";
      skill.style.display = pk === "skill" ? "" : "none";
      const param = pk === "stat" ? +stat.value : pk === "skill" ? +skill.value : 0;
      writeW(base + eo, 2, t); writeW(base + eo + 2, 2, Math.max(0, +vIn.value || 0)); writeW(base + eo + 4, 2, param);
      reg(base + eo, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} type`);
      reg(base + eo + 2, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} value`);
      reg(base + eo + 4, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} param`);
      const d = isDirty(base + eo, 8);
      [tSel, stat, skill].forEach((el) => el.classList.toggle("dirty", d));
      markField(vIn, base + eo, 8, "raw");   // one ↺ for the whole 8-byte slot, anchored on the amount
    };
    [tSel, vIn, stat, skill].forEach((el) => (el.onchange = commit));
    // initialise ↺ / highlight without writing (reflects any already-staged slot change)
    const d0 = isDirty(base + eo, 8);
    [tSel, stat, skill].forEach((el) => el.classList.toggle("dirty", d0));
    markField(vIn, base + eo, 8, "raw");
  }

  // ---- Armor sets --------------------------------------------------------------
  function drawSets(host) {
    const healLabel = { 0: "100%", 1: "50%", 2: "25%", 3: "12.5%", 4: "6.25%" };
    // decode current + original bonus constants
    const curCounter = readW(SETS.counterSites[0], 4) & 0xFFFF,
      origCounter = origW(SETS.counterSites[0], 4) & 0xFFFF;
    const curHeal = (readW(SETS.healShift, 4) >>> 6) & 0x1F,
      origHeal = (origW(SETS.healShift, 4) >>> 6) & 0x1F;
    const w0 = AUX_WINDOWS[0];
    const curPotch = auxHasPotch() ? decodePotch(auxR32(w0 + AUX_MULT), auxR32(w0 + AUX_MULT + 4)) : null;
    const origPotch = auxHasPotch() ? decodePotch(auxO32(w0 + AUX_MULT), auxO32(w0 + AUX_MULT + 4)) : null;
    const potchCtl = auxHasPotch()
      ? `<label class="field"><span>Potch multiplier per wearer <span class="muted">(stacks)</span></span>
           <select id="setPotch">${SETS.potchChoices.map((c) =>
             `<option value="${c}"${c === curPotch ? " selected" : ""}>×${c}${c === 1 ? " (off)" : ""}</option>`).join("")}
             ${curPotch === null ? `<option value="" selected>? (unrecognized patch)</option>` : ""}</select></label>`
      : `<label class="field"><span>Potch multiplier</span><span class="muted">unavailable — the overlay region couldn't be read from this disc</span></label>`;
    // ---- effect ownership: which set grants each effect -------------------------
    const stockMark = (v, orig) => (v === orig ? " (stock)" : "");
    const maskOpts = (cur, orig) => [0, 1, 2, 3, 4, 5, 6, 7].map((m) =>
      `<option value="${m}"${m === cur ? " selected" : ""}>${esc2(maskSetNames(m))}${stockMark(m, orig)}</option>`).join("");
    const eqOpts = (cur, orig) => [1, 2, 3, 4, 5, SETS.OWNER_OFF].map((n) =>
      `<option value="${n}"${n === cur ? " selected" : ""}>${n === SETS.OWNER_OFF ? "no set (off)" : esc2(SETS.meta[n - 1].name)}${stockMark(n, orig)}</option>`).join("");
    const curCounterOwner = readW(SETS.counterOwnerSites[0], 4) & 0xFFFF,
      origCounterOwner = origW(SETS.counterOwnerSites[0], 4) & 0xFFFF;
    const curHealOwner = readW(SETS.healOwnerSite, 4) & 0xFFFF,
      origHealOwner = origW(SETS.healOwnerSite, 4) & 0xFFFF;
    const curSqueakOwner = readW(SETS.squeakOwnerSite, 4) & 0xFFFF,
      origSqueakOwner = origW(SETS.squeakOwnerSite, 4) & 0xFFFF;
    const curHalveMask = readW(SETS.halveMaskSite, 4) & 0xFFFF,
      origHalveMask = origW(SETS.halveMaskSite, 4) & 0xFFFF;
    const potchMaskCtl = auxHasPotch()
      ? `<label class="field"><span>Potch bonus</span><select id="ownPotch">${maskOpts(auxR32(w0 + AUX_MASK) & 0xFFFF, auxO32(w0 + AUX_MASK) & 0xFFFF)}</select></label>`
      : "";
    const setCards = [];
    for (let i = 0; i < SETS.count; i++) {
      const meta = SETS.meta[i], base = SETS.table + i * SETS.stride;
      const selects = SETS.slots.map((slotName, s) => {
        const off = base + s * 2, cur = r16(off);
        const cats = SETS.slotCats[s];
        const ids = Object.keys(REF.items).map(Number)
          .filter((id) => cats.includes(REF.cats[id]) || id === cur).sort((a, b) => a - b);
        const opts = [`<option value="0">— none —</option>`]
          .concat(ids.map((id) => `<option value="${id}"${id === cur ? " selected" : ""} title="${esc2(itemDesc(id) || "")}">${esc2(itemName(id))}</option>`));
        return `<label class="field"><span>${slotName}</span>
          <select class="set-slot" data-off="${off}" data-g="${esc2(meta.name)}" data-l="${slotName}">${opts.join("")}</select></label>`;
      }).join("");
      if (SEARCH && !meta.name.toLowerCase().includes(SEARCH)) continue;
      setCards.push(`<details class="char" data-rec="${base}" open><summary>
          <span class="chev">▸</span><span class="nm">${esc2(meta.name)}</span><span class="muted">set #${i + 1}</span></summary>
        <div class="char-body">
          <div class="muted" style="margin:0 0 4px"><b>In-code bonus:</b> ${esc2(meta.bonus)}</div>
          <div class="muted" style="margin:0 0 8px"><b>Guide says:</b> ${esc2(meta.guide)}</div>
          <div class="grid">${selects}</div>
        </div></details>`);
    }
    host.innerHTML = `<div class="card" style="margin:0 0 12px">
        <div class="bag-h">Set bonus tuning <span class="u">patches game code — every stock value byte-verified</span></div>
        <div class="grid">
          ${potchCtl}
          <label class="field"><span>Destiny bonus counter chance %</span>
            <input type="number" id="setCounter" min="0" max="100" value="${curCounter}"></label>
          <label class="field"><span>Pale Moon heal (share of damage dealt)</span>
            <select id="setHeal">${[0, 1, 2, 3, 4].map((k) =>
              `<option value="${k}"${k === curHeal ? " selected" : ""}>${healLabel[k]}</option>`).join("")}</select></label>
        </div>
        <details class="note"><summary>Disassembly-verified behavior — what each set really does</summary>
          <div style="margin-top:4px">The potch multiplier applies once per party member wearing
          Prosperity <i>or</i> Destiny and stacks (two wearers at ×3 = ×9). The counter chance only fires for a Destiny wearer <b>without</b>
          the Counter Attack skill (damage = own PWR + support PWR, ÷3). Guardian's real effect is a halving check on counter damage
          (Pale Moon matches it too — likely a dev bug). Mole just squeaks. The Suikosource guide's “Prosperity ×7” and
          “Guardian counter +50%” don't match the code.</div></details>
      </div>
      <div class="card" style="margin:0 0 12px">
        <div class="bag-h">Effect ownership <span class="u">pick which set grants each effect — rewrites the game's own checks</span></div>
        <div class="grid eq">
          ${potchMaskCtl}
          <label class="field"><span>Bonus counter chance</span><select id="ownCounter">${eqOpts(curCounterOwner, origCounterOwner)}</select>
            <span id="counterDivHint"></span></label>
          <label class="field"><span>Heal-on-hit</span><select id="ownHeal">${eqOpts(curHealOwner, origHealOwner)}</select></label>
          <label class="field"><span>Counter-damage halving</span><select id="ownHalve">${maskOpts(curHalveMask, origHalveMask)}</select></label>
          <label class="field"><span>Squeaky footsteps</span><select id="ownSqueak">${eqOpts(curSqueakOwner, origSqueakOwner)}</select></label>
        </div>
        <div class="warnbox" style="margin:10px 2px 0">These dropdowns <b>move an existing effect onto a different set</b> (one set can hold
          several) — the game hard-codes each check, so genuinely new effects can't be added.</div>
        <details class="note"><summary>Why two dropdowns list set combos, and the counter-damage quirk</summary>
          <ul style="margin:4px 0 0 18px">
            <li><b>The potch and halving checks are bit tests</b>, not equality — the game does <code>setNumber &amp; mask</code>. Because the
              sets are numbered 1–5, only 8 groupings are reachable, which is exactly what those two dropdowns list.</li>
            <li><b>Bonus counter damage is divided by the set number itself</b> (the code reuses that register). Stock Destiny is #3, hence
              ÷3; moving it to Mole (#1) means no division at all, while Pale Moon (#5) divides by 5. The hint under the dropdown tracks this.</li>
          </ul></details>
      </div>
      <div id="setCards">${setCards.join("") || `<div class="muted">no matching sets</div>`}</div>`;
    // composition selects: normal block writes -> undo/review/recipe all standard
    qa("select.set-slot", host).forEach((sel) => {
      const off = +sel.dataset.off;
      sel.onchange = () => {
        writeW(off, 2, +sel.value || 0);
        reg(off, 2, "item", sel.dataset.g, sel.dataset.l);
        markField(sel, off, 2, "item");
      };
      markField(sel, off, 2, "item");
    });
    // bonus constants: whole-instruction rewrites; each control reverts BOTH code sites
    const counterEl = q("#setCounter", host), healEl = q("#setHeal", host);
    function markPair(el, dirty, revert, origLabel) {
      el.classList.toggle("dirty", dirty);
      let btn = el._revBtn;
      if (!btn) {
        if (!dirty) return;
        btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
        btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); revert(); drawView(); };
        el.insertAdjacentElement("afterend", btn); el._revBtn = btn;
      }
      btn.classList.toggle("show", dirty);
      if (dirty) btn.title = `Restore original (${origLabel})`;
      scheduleBadge();
    }
    counterEl.onchange = () => {
      const v = Math.max(0, Math.min(100, +counterEl.value || 0)); counterEl.value = v;
      SETS.counterSites.forEach((o, i) => { writeW(o, 4, counterWord(v));
        reg(o, 4, "num", "Armor sets", `Destiny counter chance${i ? " (2nd code site)" : ""}`); });
      markPair(counterEl, isDirty(SETS.counterSites[0], 4) || isDirty(SETS.counterSites[1], 4),
        () => SETS.counterSites.forEach((o) => revertRange(o, 4)), origCounter + "%");
    };
    markPair(counterEl, isDirty(SETS.counterSites[0], 4) || isDirty(SETS.counterSites[1], 4),
      () => SETS.counterSites.forEach((o) => revertRange(o, 4)), origCounter + "%");
    healEl.onchange = () => {
      const k = +healEl.value, w = healWords(k);
      writeW(SETS.healBias, 4, w[0]); writeW(SETS.healShift, 4, w[1]);
      reg(SETS.healBias, 4, "num", "Armor sets", "Pale Moon heal bias");
      reg(SETS.healShift, 4, "num", "Armor sets", "Pale Moon heal shift");
      markPair(healEl, isDirty(SETS.healBias, 4) || isDirty(SETS.healShift, 4),
        () => { revertRange(SETS.healBias, 4); revertRange(SETS.healShift, 4); }, healLabel[origHeal] || "?");
    };
    markPair(healEl, isDirty(SETS.healBias, 4) || isDirty(SETS.healShift, 4),
      () => { revertRange(SETS.healBias, 4); revertRange(SETS.healShift, 4); }, healLabel[origHeal] || "?");
    const potchEl = q("#setPotch", host);
    if (potchEl) {
      const multDirty = () => auxDirtyAt(AUX_MULT, 8), multRevert = () => auxRevertAt(AUX_MULT, 8);
      potchEl.onchange = () => {
        const w = potchWords(+potchEl.value);
        if (!w) return;
        for (const site of AUX_WINDOWS) { auxW32(site + AUX_MULT, w[0]); auxW32(site + AUX_MULT + 4, w[1]); }
        markPair(potchEl, multDirty(), multRevert, "×" + (origPotch ?? "?"));
      };
      markPair(potchEl, multDirty(), multRevert, "×" + (origPotch ?? "?"));
    }
    // ---- effect ownership --------------------------------------------------------
    // Each control rewrites only the immediate of the existing instruction(s), so the
    // opcode/registers stay exactly as the game shipped them.
    // narrow columns can clip long combo names — mirror the selection into a hover tooltip
    const syncTitle = (el) => { el.title = el.selectedOptions[0]?.textContent || ""; };
    function wireOwner(id, sites, label, fmt, extra) {
      const el = q("#" + id, host); if (!el) return;
      const origImm = origW(sites[0], 4) & 0xFFFF;
      const dirty = () => sites.some((o) => isDirty(o, 4)) || (extra ? isDirty(extra.off, 4) : false);
      const revert = () => { sites.forEach((o) => revertRange(o, 4)); if (extra) revertRange(extra.off, 4); };
      const apply = () => {
        syncTitle(el);
        const v = +el.value;
        sites.forEach((o, i) => {
          writeW(o, 4, withImm(origW(o, 4), v));
          reg(o, 4, "num", "Armor sets", `${label} owner${i ? ` (code site ${i + 1})` : ""}`);
        });
        if (extra) {
          // The heal check shares its register with a later divisor; restore that divisor
          // in a dead slot whenever the owner moves off the stock value, and undo the
          // repair when it moves back so a round-trip leaves zero bytes changed.
          if (v === extra.stock) revertRange(extra.off, 4);
          else { writeW(extra.off, 4, extra.word); reg(extra.off, 4, "num", "Armor sets", `${label} divisor repair`); }
        }
        markPair(el, dirty(), revert, fmt(origImm));
      };
      el.onchange = apply;
      syncTitle(el);
      markPair(el, dirty(), revert, fmt(origImm));
    }
    const eqName = (n) => (n >= 1 && n <= 5 ? SETS.meta[n - 1].name : "no set");
    wireOwner("ownCounter", SETS.counterOwnerSites, "Bonus counter", eqName);
    // surface the divisor quirk right where it bites: the counter owner's set number
    // divides the bonus damage, so show the resulting divisor live under the dropdown
    const counterOwnerEl = q("#ownCounter", host), counterHintEl = q("#counterDivHint", host);
    if (counterOwnerEl && counterHintEl) {
      const updHint = () => { const n = +counterOwnerEl.value;
        counterHintEl.textContent = n === SETS.OWNER_OFF ? "effect disabled"
          : n === 1 ? "bonus damage ÷1 — no reduction" : `bonus damage ÷${n} (divisor = set number)`; };
      const applyOwner = counterOwnerEl.onchange;
      counterOwnerEl.onchange = () => { applyOwner(); updHint(); };
      updHint();
    }
    wireOwner("ownHeal", [SETS.healOwnerSite], "Heal-on-hit", eqName,
      { off: SETS.healDivRepair, word: SETS.healDivWord, stock: 5 });
    wireOwner("ownSqueak", [SETS.squeakOwnerSite], "Squeaky footsteps", eqName);
    wireOwner("ownHalve", [SETS.halveMaskSite], "Counter-damage halving", maskSetNames);
    const ownPotchEl = q("#ownPotch", host);
    if (ownPotchEl) {
      const origMask = auxO32(w0 + AUX_MASK) & 0xFFFF;
      const maskDirty = () => auxDirtyAt(AUX_MASK, 4), maskRevert = () => auxRevertAt(AUX_MASK, 4);
      ownPotchEl.onchange = () => {
        const m = +ownPotchEl.value;
        for (const site of AUX_WINDOWS) auxW32(site + AUX_MASK, withImm(auxO32(site + AUX_MASK), m));
        syncTitle(ownPotchEl);
        markPair(ownPotchEl, maskDirty(), maskRevert, maskSetNames(origMask));
      };
      syncTitle(ownPotchEl);
      markPair(ownPotchEl, maskDirty(), maskRevert, maskSetNames(origMask));
    }
  }

  // ---- Text (in-ELF UI strings) ----------------------------------------------
  // The ELF has no index of its strings, so we find them the same way the desktop editor
  // does: scan the block for printable-ASCII runs and keep the ones that read as prose
  // (TextCore, a direct port of s3editor.py's _looks_like_text — the two must agree).
  //
  // Scanning ORIG rather than BUF is deliberate: `max` is the ON-DISK slot length and must
  // not move as you edit, or a string that you shortened would lose the tail of its slot on
  // the next render and could never be restored. Values displayed still come from BUF.
  let TEXTS = null;                                   // [{off, max}]; cleared on ISO load
  function scanTexts() {
    if (!TEXTS) TEXTS = TextCore.scanStrings(ORIG, ELF_BASE);
    return TEXTS;
  }
  const TEXT_ROW_CAP = 300;                           // keep the DOM small; filter to narrow
  function drawText(host) {
    const all = scanTexts();
    const hits = SEARCH
      ? all.filter((t) => strFrom(BUF, t.off, t.max).toLowerCase().includes(SEARCH) || hex(t.off, 6).includes(SEARCH))
      : all;
    const shown = hits.slice(0, TEXT_ROW_CAP);
    const rows = shown.map((t) => {
      const cur = strFrom(BUF, t.off, t.max);
      // A description the disc stores twice (attack runes, magic scrolls) shows both addresses,
      // so two identical rows can't be mistaken for each other — and says the edit hits both.
      const cop = descCopies(t.off);
      const twin = cop.length > 1
        ? ` <span class="u" title="This description is stored ${cop.length} times on the disc (${cop.map((o) => "0x" + hex(o, 6)).join(", ")}). Editing any one of them writes them all.">· ${cop.length} copies, mirrored</span>`
        : "";
      return `<label class="field tx"><span>0x${hex(t.off, 6)} <span class="muted">(max ${t.max})</span>${twin}</span>
        <input type="text" class="txt" data-off="${t.off}" data-max="${t.max}" maxlength="${t.max}" value="${esc2(cur)}"></label>`;
    }).join("");
    const capped = hits.length > shown.length
      ? `<div class="muted" style="margin:8px 0 0">Showing the first ${shown.length} of ${hits.length} matches — type in the filter to narrow.</div>` : "";
    host.innerHTML = `<div class="card" style="margin:0 0 12px">
        <div class="bag-h">In-ELF text <span class="u">${all.length} strings · in-place, length-capped</span></div>
        <div class="warnbox" style="margin:0 0 8px">Each string is written back over its <b>original bytes</b> and can't grow — longer text is
          rejected, shorter is null-padded. These are UI/battle/menu strings and character blurbs; <b>story dialogue is not here</b>
          (it lives in packed event files outside the executable and no editor in this repo can reach it).</div>
        ${rows ? `<div class="grid">${rows}</div>` : `<div class="muted">no matches</div>`}${capped}</div>`;
    qa("input.txt", host).forEach((el) => {
      const off = +el.dataset.off, max = +el.dataset.max;
      markField(el, off, max, "text");
      el.onchange = () => {
        const enc = latin1Enc(el.value);
        if (enc.length > max) {                       // maxlength can't stop a paste of wide chars
          setStatus(`Too long — "${el.value}" is ${enc.length} bytes, the slot holds ${max}.`, "err");
          el.value = strFrom(BUF, off, max); markField(el, off, max, "text"); return;
        }
        const padded = new Uint8Array(max); padded.set(enc);
        const n = writeDescAll(off, padded, "Text", `0x${hex(off, 6)}`);
        markField(el, off, max, "text");
        // Sibling rows for the other copy are showing stale text until they redraw.
        if (n > 1) { drawView(); setStatus(`Written to all ${n} copies of that description on the disc.`, "ok"); }
        else setStatus("", "");
      };
    });
  }

  // ---- Balance (Hard Mode / bulk) --------------------------------------------
  // All scaling is relative to the ORIGINAL on-disk value, so presets are idempotent
  // (re-applying "Hard" doesn't compound) and setting a multiplier to 1 restores the field.
  function applyHardMode(growthMults, spellMult, uniteMult) {
    let gN = 0, sN = 0, uN = 0;
    const [gb, gs] = TABLES.list2;
    for (let i = 0; i < LIST_COUNT.list2; i++) {
      for (const stat in GROWTH_OFFS) {
        const m = growthMults[stat]; if (m == null) continue;
        const off = gb + i * gs + GROWTH_OFFS[stat];
        const nv = Math.max(0, Math.min(15, Math.round(o8(off) * m)));   // growth bytes clamp 0..15
        if (nv !== r8(off)) gN++;
        writeW(off, 1, nv);
      }
    }
    if (spellMult != null) for (let i = 0; i < SPELL.count; i++) {
      const off = SPELL.off + i * SPELL.stride + 0x1C, nv = Math.max(0, Math.min(0xFFFFFFFF, Math.round(o32(off) * spellMult)));
      if (nv !== r32(off)) sN++; writeW(off, 4, nv);
    }
    if (uniteMult != null) for (let i = 0; i < UNITE.count; i++) {
      const off = UNITE.off + i * UNITE.stride + 0x1C, nv = Math.max(0, Math.min(0xFFFFFFFF, Math.round(o32(off) * uniteMult)));
      if (nv !== r32(off)) uN++; writeW(off, 4, nv);
    }
    return { gN, sN, uN };
  }
  function drawBalance(host) {
    const presetBtns = Object.entries(HM_PRESETS).map(([k, p]) =>
      `<button class="chip" data-preset="${k}" title="${esc2(p.desc)}">${p.label}</button>`).join("");
    const statRows = HM_STATS.map((s) =>
      `<label class="field"><span>${s} growth ×</span>
        <input type="number" class="hm-g" data-stat="${s}" min="0" max="4" step="0.05" value="1"></label>`).join("");
    host.innerHTML = `
      <div class="warnbox" style="margin-bottom:10px">This is a party <b>nerf</b> tool. It lowers how fast your characters grow (and optionally your spell/unite power) to make the game harder. Enemies can't be buffed directly in this ROM. Values scale from the ISO's originals, so presets don't stack.</div>
      <div class="bag-h">Presets</div>
      <div class="subtabs" style="margin-bottom:12px">${presetBtns}<button class="chip" data-preset="reset">Reset to 1.00×</button></div>
      <div class="bag-h">Growth-rate multipliers <span class="u">1.00 = unchanged</span></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${statRows}</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-top:10px">
        <label class="field"><span>Spell power ×</span><input type="number" id="hm-spell" min="0" max="4" step="0.05" value="1"></label>
        <label class="field"><span>Unite power ×</span><input type="number" id="hm-unite" min="0" max="4" step="0.05" value="1"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="hm-apply">Stage these multipliers</button>
        <span class="muted" id="hm-out"></span>
      </div>`;
    const gInputs = qa(".hm-g", host);
    const setMults = (g, sp, up) => {
      gInputs.forEach((i) => { i.value = g[i.dataset.stat] != null ? g[i.dataset.stat] : 1; });
      q("#hm-spell", host).value = sp; q("#hm-unite", host).value = up;
    };
    qa("[data-preset]", host).forEach((b) => (b.onclick = () => {
      if (b.dataset.preset === "reset") return setMults({}, 1, 1);
      const p = HM_PRESETS[b.dataset.preset]; setMults(p.growth, p.spell, p.unite);
    }));
    q("#hm-apply", host).onclick = () => {
      const g = {}; gInputs.forEach((i) => (g[i.dataset.stat] = +i.value || 0));
      const sp = +q("#hm-spell", host).value, up = +q("#hm-unite", host).value;
      const res = applyHardMode(g, sp, up);
      updateDirtyBadge();
      q("#hm-out", host).textContent =
        `Staged ${res.gN} growth byte(s)` + (res.sN ? `, ${res.sN} spell power(s)` : "") + (res.uN ? `, ${res.uN} unite power(s)` : "") + ". Review, then Save.";
      setStatus("Balance multipliers staged.", "ok");
    };
  }

  // ---- Encounter (global random-encounter rate) ------------------------------
  // One percentage, applied to the three movement-mode multipliers in the encounter
  // roll (see the ENC block up top). 100% rewrites the stock words byte-for-byte, so
  // returning to it leaves nothing staged rather than merely re-encoding the default.
  const ENC_PRESETS = [["None", 0], ["Quarter", 25], ["Half", 50], ["Stock", 100], ["Double", 200], ["Triple", 300]];
  // ---- Archive → in-game place names -------------------------------------------
  // The disc names its zone archives with romaji abbreviations (KRVI = KaRaya VIllage,
  // ZKTR = Zexen toride/fortress = Brass Castle, HNKT = honkyochi/HQ = Budehuc, MSVI =
  // Muse, Le Buque's Japanese name, YMMT = yamamichi = Mountain Path…). Every encounter
  // archive is anchored by matching its monster packs (enemy name + level + HP) against
  // the Suikosource bestiary's per-area tables: KSKR carries the Ancient Highway table
  // verbatim, HNKT the Budehuc-basement one, ICEW the Cyndar Ruins rows exactly (Malifaux
  // 50/600, Siren 50/350, TrollDragon 50/1900, CopperSun 55/5400), LAST the Ceremonial
  // Site trio, HAKA the hideaway's unique Mordolo/Nariqua, FAKE Mt. Senai's unique
  // Mirage, AKMT the full Kuput Forest list, RVER Mt. Hei-Tou's (the one field left).
  // HGB1/HGB2 are both Yaza Plain fields (HGB1 has Thomas ch.1's lv2-3 starter bugs =
  // the map at Budehuc's gate); SOGE (sougen = grassland) spans Amur + North Amur.
  // CVIS / SKBN / GDOP / LKOE hold no encounter or room data and stay unidentified.
  const ARCH_NAMES = {
    VDZK: "Vinay del Zexay", KRVI: "Karaya Village", LZVI: "Great Hollow",
    DKVI: "Duck Village", TSVI: "Chisha Village", IKVI: "Iksay Village",
    MSVI: "Le Buque", ZKTR: "Brass Castle", AKVI: "Alma Kinan Village",
    CRRA: "Caleria", HNKT: "Budehuc Castle", HGB1: "Yaza Plain (Budehuc gate)",
    HGB2: "Yaza Plain (second field)", SOGE: "Amur Plains / North Amur Plains",
    MORI: "Zexen Forest", KTDO: "North Cavern", YMMT: "Mountain Path",
    KSKR: "Ancient Highway", AKMT: "Kuput Forest", HAKA: "Flame Champion's Hideaway",
    FAKE: "Mt. Senai", ICEW: "Cyndar Ruins", RVER: "Mt. Hei-Tou",
    LAST: "Ceremonial Site", ETC: "shared (all areas)",
  };
  const archName = (a) => ARCH_NAMES[a] || "";

  // The three per-mode multipliers, as {key, label, hint} in the order they're shown.
  const ENC_MODES = [
    { key: "walk", label: "Walking", hint: "also mounted walking" },
    { key: "run", label: "Running", hint: "on foot" },
    { key: "ride", label: "Running mounted", hint: "galloping only" },
  ];

  function drawEncounter(host) {
    const cur = decodeEnc(ENC.sites.map((o) => readW(o, 4)));
    const orig = decodeEnc(ENC.sites.map((o) => origW(o, 4)));
    const mults = decodeEncMults(ENC.sites.map((o) => readW(o, 4) >>> 0));
    const unknown = mults === null;
    const multRows = ENC_MODES.map((m) => `<label class="field" style="max-width:190px">
        <span>${m.label} <span class="dim">${esc2(m.hint)}</span></span>
        <input type="number" class="enc-mult" data-k="${m.key}" min="0" max="${ENC.max}" step="5"
          value="${mults ? mults[m.key] : ENC.STOCK_MULT[m.key]}"></label>`).join("");
    host.innerHTML = `
      <div class="muted" style="margin:0 0 10px">Scales how often random battles trigger across the whole
        game. <b>100</b> = unchanged &middot; <b>50</b> = half as often &middot; <b>200</b> = twice as often
        &middot; <b>0</b> = no random encounters at all. Every area scales by the same factor, so a quiet
        field stays quieter than a dungeon.</div>
      ${unknown ? `<div class="warnbox" style="margin-bottom:10px">These instructions aren't stock and weren't
        written by this editor (${ENC.sites.map((o) => hex(readW(o, 4), 8)).join(" ")}) — applying a rate
        overwrites them.</div>` : ""}
      <div class="subtabs" style="margin-bottom:12px">${ENC_PRESETS.map(([lbl, v]) =>
        `<button class="chip" data-enc="${v}">${lbl}</button>`).join("")}</div>
      <div class="row" style="align-items:center;margin-bottom:10px">
        <input type="range" id="encRange" min="0" max="300" step="5" value="100" style="width:260px">
        <label class="field" style="max-width:120px"><span>Rate %</span>
          <input type="number" id="encPct" min="0" max="${ENC.max}" step="1" value="100"></label>
        <button class="chip" id="encReset">Restore 100%</button>
        <span class="muted" id="encOut"></span>
      </div>
      <div class="bag" style="margin:0 0 4px">
        <div class="bag-h">Per-movement multipliers <span class="u">what the slider above is made of</span></div>
        <div class="muted" style="margin:0 0 10px">The roll is <code>area rate &times; multiplier / 100</code>,
          and the game picks the multiplier from how you are moving. Stock is
          <b>100</b> walking, <b>120</b> running, <b>150</b> galloping — running is riskier than walking,
          and a mount is riskier still. Set them apart to change that shape rather than just its size:
          <b>0</b> in one mode means that mode never starts a battle. Mounted <i>walking</i> uses the
          walking number, so the third value is specifically a gallop.</div>
        <div class="row" style="align-items:flex-end;flex-wrap:wrap">${multRows}
          <button class="chip" id="encMultStock">Restore 100 / 120 / 150</button></div>
        <div class="muted" style="font-size:12px;margin:8px 0 0" id="encMultOut"></div>
      </div>
      <div id="encMove"></div>
      <div id="encRooms"></div>`;
    const pctEl = q("#encPct", host), rngEl = q("#encRange", host), outEl = q("#encOut", host);
    const dirty = () => ENC.sites.some((o) => isDirty(o, 4));
    const note = (v) => v === 100 ? "stock rate" : v === 0 ? "random encounters off"
      : v < 100 ? `${(100 / v).toFixed(v >= 10 ? 1 : 0)}\u00d7 fewer battles`
      : `${(v / 100).toFixed(2)}\u00d7 more battles`;
    const sync = (v) => {
      pctEl.value = v; rngEl.value = Math.min(+rngEl.max, v);
      outEl.textContent = note(v) + (dirty() ? ` \u00b7 staged (was ${orig === null ? "?" : orig + "%"})` : "");
      qa("[data-enc]", host).forEach((b) => b.classList.toggle("on", +b.dataset.enc === v));
    };
    const writeWords = (w) => ENC.sites.forEach((o, i) => {
      writeW(o, 4, w[i]);
      reg(o, 4, "imm16", "Encounters", ENC.labels[i]);
    });
    // ---- the three per-mode multipliers ----
    // The slider and these boxes write the same four words, so both paths re-sync both
    // readouts rather than only their own.
    const multEls = qa("input.enc-mult", host), outM = q("#encMultOut", host);
    const MULT_WORD = { walk: 0, ride: 2, run: 3 };       // which site each box owns
    const syncMults = () => {
      const m = decodeEncMults(ENC.sites.map((o) => readW(o, 4) >>> 0));
      multEls.forEach((el) => {
        const k = el.dataset.k;
        el.value = m ? m[k] : ENC.STOCK_MULT[k];
        // "walking" owns two words (its immediate and the branch that reaches the block).
        el.classList.toggle("dirty", isDirty(ENC.sites[MULT_WORD[k]], 4)
          || (k === "walk" && isDirty(ENC.sites[1], 4)));
      });
      const zero = m ? ENC_MODES.filter((x) => m[x.key] === 0).map((x) => x.label.toLowerCase()) : [];
      outM.textContent = !m
        ? "Unrecognised instructions — the boxes show the stock values, not what is on the disc."
        : zero.length ? `No random battles while ${zero.join(" or ")}.`
        : m.walk === 0 ? "Walking never starts a battle, so the other two are what remain."
        : `Relative risk: walking 1.00× · running ${(m.run / m.walk).toFixed(2)}× · galloping ${(m.ride / m.walk).toFixed(2)}×.`;
    };
    const apply = (v) => {
      v = Math.max(0, Math.min(ENC.max, Math.round(+v || 0)));
      const w = encWords(v); if (!w) return;
      writeWords(w);
      sync(v); syncMults(); updateDirtyBadge();
    };
    // A custom triple has no single percentage; say so rather than implying 100%.
    if (cur === null) {
      pctEl.value = 100; rngEl.value = 100;
      outEl.textContent = unknown ? "unrecognised instructions"
        : "custom per-movement multipliers · the rate above no longer describes them";
    } else sync(cur);
    rngEl.oninput = () => { pctEl.value = rngEl.value; outEl.textContent = note(+rngEl.value); };
    rngEl.onchange = () => apply(rngEl.value);
    pctEl.onchange = () => apply(pctEl.value);
    qa("[data-enc]", host).forEach((b) => (b.onclick = () => apply(+b.dataset.enc)));
    q("#encReset", host).onclick = () => {
      ENC.sites.forEach((o) => revertRange(o, 4));
      sync(orig === null ? 100 : orig); syncMults(); updateDirtyBadge();
    };
    const applyMults = () => {
      const m = {};
      multEls.forEach((el) => (m[el.dataset.k] = encClampMult(el.value)));
      writeWords(encMultWords(m));
      const p = decodeEnc(ENC.sites.map((o) => readW(o, 4)));
      if (p === null) outEl.textContent = "custom per-movement multipliers · the rate above no longer describes them";
      else sync(p);
      syncMults(); updateDirtyBadge();
    };
    multEls.forEach((el) => (el.onchange = applyMults));
    q("#encMultStock", host).onclick = () => {
      writeWords(encMultWords(ENC.STOCK_MULT));
      sync(100); syncMults(); updateDirtyBadge();
    };
    syncMults();
    drawEncMove(q("#encMove", host));
    const rhost = q("#encRooms", host);
    if (needTables(rhost)) drawRoomRates(rhost);
  }

  // ---- Movement rules: what counts as walking / running -----------------------
  const encMoveOk = () => ENCMOVE.walk.concat(ENCMOVE.run).every((s2) => inBlk(s2.off, 2) && r16(s2.off + 2) === s2.opc)
    && inBlk(ENCMOVE.runAlt.base.off, 2) && r16(ENCMOVE.runAlt.base.off + 2) === ENCMOVE.runAlt.base.opc
    && inBlk(ENCMOVE.runAlt.len.off, 2) && r16(ENCMOVE.runAlt.len.off + 2) === ENCMOVE.runAlt.len.opc;
  const runAltMode = () => {
    const b = (-(r16(ENCMOVE.runAlt.base.off) | 0) << 16 >> 16) & 0xFFFF, l = r16(ENCMOVE.runAlt.len.off);
    const m = ENCMOVE.runAlt.modes.find((x) => x.base === b && x.len === l);
    return m ? m.key : null;
  };
  // A group is "on" when any of its ranges still has a non-zero length.
  const walkOn = () => ENCMOVE.walk.some((s2) => r16(s2.off) !== 0);
  const runOn = () => ENCMOVE.run.some((s2) => r16(s2.off) !== 0) || r16(ENCMOVE.runAlt.len.off) !== 0;

  function drawEncMove(host) {
    if (!host) return;
    if (!encMoveOk()) {
      host.innerHTML = `<div class="warnbox" style="margin:12px 0 0">The movement tests aren't where this
        build expects them — no movement rules offered.</div>`;
      return;
    }
    const w = walkOn(), r = runOn(), mode = runAltMode();
    const bands = [];
    if (w) ENCMOVE.walk.forEach((s2) => { if (r16(s2.off)) bands.push("walk " + s2.what); });
    if (r) { ENCMOVE.run.forEach((s2) => { if (r16(s2.off)) bands.push("run " + s2.what); });
             if (r16(ENCMOVE.runAlt.len.off)) {
               const m = ENCMOVE.runAlt.modes.find((x) => x.key === mode);
               bands.push("run " + (m ? m.note.split(" — ")[0] : "custom range")); } }
    host.innerHTML = `
      <div class="bag" style="margin:16px 0 0">
        <div class="bag-h">Movement rules <span class="u">what counts as moving · patches game code</span></div>
        <div class="muted" style="margin:0 0 10px">
          Before the rate above is even used, the game checks which <b>animation</b> your character is
          playing. Walking and running are separate tests, and if neither matches, the roll is skipped
          entirely. That makes two things possible that a rate slider can't do.
        </div>
        <label class="row" style="gap:8px;cursor:pointer;align-items:baseline;margin:0 0 6px">
          <input type="checkbox" id="encWalk"${w ? " checked" : ""}>
          <b>Walking triggers encounters</b>
          <span class="muted" style="font-size:12px">off = walk anywhere in peace, run when you want to fight</span></label>
        <label class="row" style="gap:8px;cursor:pointer;align-items:baseline;margin:0 0 10px">
          <input type="checkbox" id="encRun"${r ? " checked" : ""}>
          <b>Running triggers encounters</b>
          <span class="muted" style="font-size:12px">stock rate is ${"×"}1.2 running, ${"×"}1.5 mounted</span></label>
        <label class="field" style="max-width:420px"><span>Second run range points at</span>
          <select id="encRunAlt"${r ? "" : " disabled"}>
            ${ENCMOVE.runAlt.modes.map((m) => `<option value="${m.key}"${m.key === mode ? " selected" : ""}>${esc2(m.label)}</option>`).join("")}
            ${mode === null ? `<option value="" selected>custom</option>` : ""}
          </select></label>
        <div class="muted" style="font-size:12px;margin:6px 0 0">
          ${esc2((ENCMOVE.runAlt.modes.find((m) => m.key === mode) || {}).note || "this range is not one of the two known settings")}
        </div>
        <div style="margin:10px 0 0"><b>Encounters currently roll while:</b>
          <span class="muted">${bands.length ? esc2(bands.join(" · ")) : "— never, on any animation —"}</span></div>
      </div>`;
    const setLen = (site, v, label) => { writeW(site.off, 2, v); reg(site.off, 2, "num", "Movement rules", label); };
    q("#encWalk", host).onchange = (e) => {
      ENCMOVE.walk.forEach((s2) => setLen(s2, e.target.checked ? s2.stock : 0, "walk " + s2.what));
      drawView();
    };
    q("#encRun", host).onchange = (e) => {
      const on = e.target.checked;
      ENCMOVE.run.forEach((s2) => setLen(s2, on ? s2.stock : 0, "run " + s2.what));
      const m = ENCMOVE.runAlt.modes.find((x) => x.key === (runAltMode() || "stock"));
      setLen(ENCMOVE.runAlt.len, on ? m.len : 0, "run second range length");
      drawView();
    };
    const sel = q("#encRunAlt", host);
    if (sel) sel.onchange = () => {
      const m = ENCMOVE.runAlt.modes.find((x) => x.key === sel.value); if (!m) return;
      writeW(ENCMOVE.runAlt.base.off, 2, (-m.base) & 0xFFFF);
      reg(ENCMOVE.runAlt.base.off, 2, "num", "Movement rules", "run second range base");
      setLen(ENCMOVE.runAlt.len, m.len, "run second range length");
      drawView();
    };
    // One control covers several instructions, so dirty state is the OR over its own sites
    // (markField is per-offset and would only ever look at the first).
    const anyDirty = (sites) => sites.some((s2) => isDirty(s2.off, 2));
    q("#encWalk", host).classList.toggle("dirty", anyDirty(ENCMOVE.walk));
    q("#encRun", host).classList.toggle("dirty", anyDirty(ENCMOVE.run.concat([ENCMOVE.runAlt.len])));
    if (sel) sel.classList.toggle("dirty", anyDirty([ENCMOVE.runAlt.base, ENCMOVE.runAlt.len]));
  }

  // ---- Per-area base rates ----------------------------------------------------
  // The percentage above is a global multiplier over THESE numbers — each map's own base
  // rate, read from the packed archives via Editor/s3_rooms.json (built by
  // build_room_index.py; the decode trail is in Suikoden3_ISO_offsets.md, "FSECT.BIN
  // CRACKED"). An area ships several chapter-variant tables. Where they agree on a room's
  // stock value the room gets ONE row that writes all of them; where they disagree it gets
  // one row per distinct value, because a single row would have to lie about the rest.
  function roomRows(a) {
    const byRoom = new Map();
    for (const t of a.tables) for (const r of t.rooms) {
      if (!byRoom.has(r.room)) byRoom.set(r.room, []);
      byRoom.get(r.room).push(r);
    }
    const out = [];
    for (const room of [...byRoom.keys()].sort((x, y) => x - y)) {
      const groups = new Map();
      for (const r of byRoom.get(room)) {
        const k = r.rate + ":" + r.grace;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const split = groups.size > 1;
      for (const rs of groups.values()) {
        out.push({ room, rate: rs[0].rate, grace: rs[0].grace, split, variants: rs.length,
                   rateOffs: rs.map((r) => r.rateOff), graceOffs: rs.map((r) => r.graceOff) });
      }
    }
    return out;
  }

  // Scale every room in one area from the DISC's own value, so re-applying never compounds
  // and 100% restores the original bytes exactly (same rule as the global control).
  function scaleArea(a, pct) {
    let n = 0;
    for (const t of a.tables) for (const r of t.rooms) {
      const o = auxO16(r.rateOff);
      if (o === null) continue;
      auxW16(r.rateOff, Math.max(0, Math.min(999, Math.round((o * pct) / 100))));
      n++;
    }
    return n;
  }
  const revertArea = (a) => {
    for (const t of a.tables) for (const r of t.rooms) { eRevert([r.rateOff], 2); eRevert([r.graceOff], 2); }
  };

  const ROOM_PRESETS = [["None", 0], ["Half", 50], ["Stock", 100], ["Double", 200]];

  function drawRoomRates(host) {
    if (!host) return;
    if (!ROOMS.length) {
      host.innerHTML = ROOMS_SKIPPED
        ? `<div class="warnbox">Per-area rates are indexed for the full USA disc — none of those offsets exist in
             this file, so only the global scale is editable here.</div>`
        : `<div class="muted">Per-area rates need <code>Editor/s3_rooms.json</code>; it didn't load, so only the
             global scale is available.</div>`;
      return;
    }
    const parts = [`<h3 class="sec">Per-area base rates</h3>`,
      `<div class="muted" style="margin:0 0 10px">Each map's own rate, read straight from the packed archives —
        the percentage above multiplies <b>these</b>. <b>0</b> means no random battles on that map, which is how
        the game marks towns and interiors; the disc's field and dungeon maps sit between <b>2 and 9</b>.
        <b>Grace</b> is how far you must travel after a battle before another can trigger. A rate at or above 100
        makes every roll a battle. Areas carry the disc's own archive tag with its in-game location and, where
        the enemy index knows them, the game's map ids.</div>`,
      `<div class="warnbox" style="margin:0 0 10px">Lowering a rate is always safe. <b>Raising one from 0 is not</b> —
        a map the game never fights on has no monster party loaded for it, so forcing an encounter there is not a
        state the game builds. Rows sitting at the disc's 0 are tagged <span class="opt-tag">no battles</span>, and
        an area with no battle zones indexed is flagged in full.</div>`];
    const q2 = SEARCH;
    ROOMS.forEach((a, ai) => {
      const zones = (a.zones || []).join(", ");
      const nm = archName(a.archive);
      if (q2 && !(a.archive + " " + nm + " " + zones).toLowerCase().includes(q2)) return;
      const rows = roomRows(a);
      const live = rows.filter((r) => r.rate > 0).length;
      parts.push(`<details class="char rarea" data-ra="${ai}" data-i="ra${ai}"><summary><span class="chev">▸</span>
          <span class="nm">${esc2(a.archive)}${nm ? ` — ${esc2(nm)}` : ""}</span>
          <span class="muted">${esc2(zones || "no battle zones indexed")}</span>
          <span class="lv">${rows.length} map row(s) · ${a.tables.length} chapter table(s) · ${live} with encounters</span></summary>
        <div class="char-body"><div class="muted">expanding…</div></div></details>`);
    });
    host.innerHTML = parts.join("");
    qa("details.rarea", host).forEach((det) => det.addEventListener("toggle", () => {
      if (!det.open || det._built) return;
      det._built = true;
      buildAreaBody(det, ROOMS[+det.dataset.ra], +det.dataset.ra);
    }));
  }

  function buildAreaBody(det, a, ai) {
    const rows = roomRows(a);
    const body = det.querySelector(".char-body");
    // An area the enemy index found no battle zones in has nothing to spawn: raising a rate
    // here asks the game for an encounter it has no monster party for.
    const noZones = !(a.zones || []).length;
    body.innerHTML = `
      ${noZones ? `<div class="warnbox" style="margin:0 0 8px">No battle zones are indexed for this archive — its
        maps are towns and interiors. Raising a rate here asks for an encounter the game has no monster party to
        fill, so treat anything above 0 as untested.</div>` : ""}
      <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <span class="muted">Whole area:</span>
        ${ROOM_PRESETS.map(([l, v]) => `<button class="chip" data-rp="${v}">${l}</button>`).join("")}
        <button class="chip" data-rrev="1">↺ Restore area</button>
        <span class="muted">scaled from the disc's own values — re-applying never compounds</span>
      </div>
      <table class="invtbl"><thead><tr><th style="width:34%">Map</th><th style="width:20%">Rate</th>
        <th style="width:20%">Grace</th><th>Applies to</th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr>
          <td class="sl">Room ${r.room}${r.split ? ` <span class="opt-tag" title="this room's chapter tables don't all carry the same value">variant</span>` : ""}${
            r.rate === 0 ? ` <span class="opt-tag" title="the disc has no random battles on this map — raising it asks for an encounter with nothing to spawn">no battles</span>` : ""}</td>
          <td><input type="number" class="rm-f" data-r="${i}" data-k="rate" min="0" max="999" style="width:84px"></td>
          <td><input type="number" class="rm-f" data-r="${i}" data-k="grace" min="0" max="4000" style="width:84px"></td>
          <td class="muted">${r.variants} table${r.variants === 1 ? "" : "s"}</td></tr>`).join("")}</tbody></table>`;
    wireRoomFields(body, a, ai, rows);
    qa("[data-rp]", body).forEach((b) => (b.onclick = () => {
      const n = scaleArea(a, +b.dataset.rp);
      setStatus(`${a.archive}: ${+b.dataset.rp}% of the disc's own rates across ${n} room record(s). Review, then Save to write.`, "ok");
      drawView();
    }));
    const rev = q("[data-rrev]", body);
    if (rev) rev.onclick = () => { revertArea(a); setStatus(`${a.archive} restored to the disc's values.`, "ok"); drawView(); };
  }

  function wireRoomFields(scope, a, ai, rows) {
    qa("input.rm-f", scope).forEach((inp) => {
      const r = rows[+inp.dataset.r], rate = inp.dataset.k === "rate";
      const offs = rate ? r.rateOffs : r.graceOffs;
      const mark = () => markMulti(inp, eDirty(offs, 2), () => { eRevert(offs, 2); drawView(); }, String(eOrig(offs, 2)));
      inp.value = eRead(offs, 2);
      inp.onchange = () => {
        const v = Math.max(0, Math.min(+inp.value || 0, rate ? 999 : 4000));
        inp.value = v;
        eWrite(offs, 2, v);
        EREG[`room:${a.archive}:${r.room}:${inp.dataset.r}:${inp.dataset.k}`] = {
          group: `Encounters — ${a.archive}`, label: `Room ${r.room} ${rate ? "rate" : "grace"}`,
          offs, w: 2, fmt: String, room: true };
        mark();
      };
      mark();
    });
  }

  // ---- Enemies (read-only names) ---------------------------------------------
  // Shared custom dirty-marker for multi-site fields (enemy fields; same shape as the
  // Sets view's markPair): highlight + ↺ that reverts every copy at once.
  function markMulti(el, dirty, revert, origLabel) {
    el.classList.toggle("dirty", dirty);
    let btn = el._revBtn;
    if (!btn) {
      if (!dirty) { scheduleBadge(); return; }
      btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); revert(); drawView(); };
      el.insertAdjacentElement("afterend", btn); el._revBtn = btn;
    }
    btn.classList.toggle("show", dirty);
    if (dirty) btn.title = `Restore original (${origLabel})`;
    scheduleBadge();
  }

  // ---- Enemies (per-area stat/reward editor + bestiary reference) -------------
  const STAT_NAMES8 = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"];
  // Bulk multipliers (kept across redraws). Every apply recomputes from the PRISTINE
  // disc values, so re-applying never compounds; a field left at ×1 is not touched.
  const ENBULK = { hp: 1, stats: 1, lv: 1, exp: 1, sp: 1, potch: 1, dropw: 1, scope: "all" };
  function enemyPacksInScope(scope) {
    const q2 = SEARCH;
    return EPACKS.filter((p) => {
      if (p.war) return false;   // war units have their own view; bulk multipliers never touch them
      if (scope !== "filtered" || !q2) return true;
      return (p.archive + " " + archName(p.archive) + " " + p.enemies.map((e) => e.name).join(" ")).toLowerCase().includes(q2);
    });
  }
  function applyEnemyBulk() {
    const rl = EPACKS_META.recLayout, al = EPACKS_META.auxLayout;
    const mul = (offs, w, m, min, max) => {
      if (m === 1) return;
      const nv = Math.max(min, Math.min(max, Math.round(eOrig(offs, w) * m)));
      eWrite(offs, w, nv);
    };
    let nv = 0;
    for (const p of enemyPacksInScope(ENBULK.scope)) {
      for (const e of p.enemies) for (const v of e.variants) {
        nv++;
        mul([...v.rec.map((o) => o + rl.hp), ...v.rec.map((o) => o + rl.maxhp)], 2, ENBULK.hp, 1, 65535);
        mul(v.rec.map((o) => o + rl.lv), 2, ENBULK.lv, 1, 99);
        for (let si = 0; si < 8; si++) mul(v.rec.map((o) => o + rl.stats + si * 2), 2, ENBULK.stats, 0, 65535);
        mul(v.aux.map((o) => o + al.exp), 4, ENBULK.exp, 0, 4294967295);
        mul(v.aux.map((o) => o + al.sp), 2, ENBULK.sp, 0, 65535);
        mul(v.aux.map((o) => o + al.potch), 4, ENBULK.potch, 0, 4294967295);
        for (let di = 0; di < al.nDrops; di++) {
          const woffs = v.aux.map((o) => o + al.drops + di * 4 + 2);
          if (eOrig(woffs, 2)) mul(woffs, 2, ENBULK.dropw, 0, 1000);   // leave empty slots empty
        }
      }
    }
    return nv;
  }
  function resetEnemyBulk() {
    const rl = EPACKS_META.recLayout, al = EPACKS_META.auxLayout;
    let nv = 0;
    for (const p of enemyPacksInScope(ENBULK.scope)) {
      for (const e of p.enemies) for (const v of e.variants) {
        nv++;
        eRevert(v.rec, rl.size);
        eRevert(v.aux, al.size);
      }
    }
    return nv;
  }
  function drawEnemies(host) {
    const rl = EPACKS_META && EPACKS_META.recLayout, al = EPACKS_META && EPACKS_META.auxLayout;
    const parts = [];
    const ZPACKS = EPACKS.filter((p) => !p.war);
    if (ZPACKS.length && rl && al) {
      parts.push(`<div class="muted" style="margin:0 0 8px">Per-area enemy packs decoded straight from the disc
        (${ZPACKS.length} pack${ZPACKS.length === 1 ? "" : "s"}${EPACKS_SKIPPED ? `, ${EPACKS_SKIPPED} unavailable on this disc` : ""}).
        Each pack exists as several streaming copies — edits write <b>every copy</b> at once. Stat order is the
        character convention (PWR/SKL/MAG/REP/PDF/MDF/SPD/LUK); drop weights are out of 1000 (128 ≈ 12.8%).
        Each pack is titled with its archive tag and the in-game area those battles belong to.
        Filter matches enemy names, archive tags or area names.</div>`);
      const mfld = (id, label) =>
        `<label class="field"><span>${label} ×</span><input type="number" id="${id}" class="eb-mul" min="0" max="100" step="0.05" value="${ENBULK[id.slice(2).toLowerCase()]}"></label>`;
      parts.push(`<div class="card" style="margin:0 0 12px">
        <div class="bag-h">Bulk tuning <span class="u">recomputed from the disc's original values — re-applying never compounds</span></div>
        <div class="grid">
          ${mfld("ebHp", "HP")}${mfld("ebStats", "All 8 stats")}${mfld("ebLv", "Level")}${mfld("ebExp", "EXP value")}
          ${mfld("ebSp", "SP")}${mfld("ebPotch", "Potch")}${mfld("ebDropw", "Drop weights")}
          <label class="field"><span>Scope</span><select id="ebScope">
            <option value="all"${ENBULK.scope === "all" ? " selected" : ""}>all packs</option>
            <option value="filtered"${ENBULK.scope === "filtered" ? " selected" : ""}>packs matching filter</option></select></label>
        </div>
        <div class="row" style="margin-top:8px;gap:8px;align-items:center">
          <button class="primary" id="ebApply">Apply multipliers</button>
          <button id="ebReset">Reset scope to disc originals</button>
        </div>
        <div class="muted" style="margin-top:6px">Every value is computed from the pristine disc number, so running Apply twice
          changes nothing and a new multiplier replaces the old one instead of stacking. Fields left at ×1 are not touched
          (your per-enemy edits to them survive); Reset reverts <b>every</b> enemy field in the scope, including manual edits.
          Empty drop slots stay empty. HP floors at 1, Level caps at 99, drop weights at 1000.</div>
      </div>`);
      const q2 = SEARCH;
      for (let pi = 0; pi < EPACKS.length; pi++) {
        const p = EPACKS[pi];
        if (p.war) continue;
        const nm = archName(p.archive);
        const hay = (p.archive + " " + nm + " " + p.enemies.map((e) => e.name).join(" ")).toLowerCase();
        if (q2 && !hay.includes(q2)) continue;
        const nvar = p.enemies.reduce((a, e) => a + e.variants.length, 0);
        parts.push(`<details class="char epack" data-ep="${pi}" data-i="ep${pi}"><summary><span class="chev">▸</span>
            <span class="nm">${esc2(p.archive)}${nm ? ` — ${esc2(nm)}` : ""} · ${esc2(p.label)}</span>
            <span class="lv">${p.enemies.length} enemies · ${nvar} variants · ×${p.copies} on disc</span></summary>
          <div class="char-body"><div class="muted">expanding…</div></div></details>`);
      }
      if (EPACKS_SKIPPED && !ZPACKS.length)
        parts.push(`<div class="warnbox">Enemy packs are indexed for the full USA disc — none of their offsets exist in this file, so nothing is editable here.</div>`);
    } else if (EPACKS_META && EPACKS_SKIPPED) {
      parts.push(`<div class="warnbox">Enemy packs are indexed for the full USA disc — none of their offsets exist in this file, so nothing is editable here.</div>`);
    }
    // Bestiary reference (Suikosource) — collapsed under the editor; honors the filter box
    // (and auto-opens while a filter is active so the matches are visible).
    const best = REF.bestiary || {};
    const brows = [];
    for (const nm of Object.keys(best).sort()) {
      for (const e of best[nm]) {
        const drops = (e.drops || []).join(", ");
        const hay = (nm + " " + drops + " " + (e.food || "")).toLowerCase();
        if (SEARCH && !hay.includes(SEARCH)) continue;
        brows.push(`<tr><td>${esc2(nm)}</td><td class="sl">${e.lv}</td><td class="sl">${e.hp.toLocaleString()}</td>
          <td>${esc2(drops || "—")}</td><td class="muted">${esc2(e.food || "—")}</td>
          <td class="sl">${esc2(String(e.potch || "—"))}</td><td class="sl">${esc2(String(e.sp || "—"))}</td></tr>`);
      }
    }
    if (brows.length || SEARCH)
      parts.push(`<details class="char" style="margin-top:10px"${SEARCH ? " open" : ""}><summary><span class="chev">▸</span>
          <span class="nm">Suikosource bestiary reference</span><span class="lv">read-only guide data</span></summary>
        <div class="char-body"><table class="invtbl"><thead><tr><th>Enemy</th><th>Lv</th><th>HP</th><th>Drops</th><th>Food</th><th>Potch</th><th>SP</th></tr></thead>
        <tbody>${brows.join("") || `<tr><td colspan="7" class="muted">no matches</td></tr>`}</tbody></table></div></details>`);
    host.innerHTML = parts.join("") || `<div class="muted">no enemy data available</div>`;
    // lazy-render pack bodies on first expand (1000+ variants would swamp the DOM otherwise)
    qa("details.epack", host).forEach((det) => {
      det.addEventListener("toggle", () => {
        if (!det.open || det._built) return;
        det._built = true;
        buildPackBody(det, EPACKS[+det.dataset.ep], rl, al);
      });
    });
    // bulk tuning controls
    qa("input.eb-mul", host).forEach((inp) => {
      inp.onchange = () => { ENBULK[inp.id.slice(2).toLowerCase()] = Math.max(0, +inp.value || 0); };
    });
    const scopeSel = q("#ebScope", host);
    if (scopeSel) scopeSel.onchange = () => { ENBULK.scope = scopeSel.value; };
    const applyBtn = q("#ebApply", host);
    if (applyBtn) applyBtn.onclick = () => {
      const n = applyEnemyBulk();
      const touched = ["hp", "stats", "lv", "exp", "sp", "potch", "dropw"].filter((k) => ENBULK[k] !== 1);
      setStatus(touched.length
        ? `Applied ${touched.map((k) => `${k} ×${ENBULK[k]}`).join(", ")} to ${n} variant(s). Review, then Save to write.`
        : "All multipliers are ×1 — nothing to apply.", touched.length ? "ok" : "warn");
      drawView();
    };
    const resetBtn = q("#ebReset", host);
    if (resetBtn) resetBtn.onclick = () => {
      const n = resetEnemyBulk();
      setStatus(`Reverted ${n} variant(s) in scope to the disc's original values.`, "ok");
      drawView();
    };
  }
  // ---- War / major battles (unit stat editor + army-skill reference) ----------
  // Region hints for the archives that hold war packs (best-effort labels).
  // Which in-game battles each war archive stages — anchored to the Suikosource bosses
  // guide via exact level/HP matches (Leo 23/600 + ZxnKn 20/230 at Vinay del Zexay in
  // Hugo ch.1; Franz/Ruby 38/400 at Chisha in ch.3; Leo 35/800 + HarmonSldr 55/600 at
  // Brass Castle; Sarah's tiers in SOGE). Battles staged from an archive's maps load
  // that archive's pack, so each hint names the chapter/story beat its units are fought in.
  const WAR_ARCH_HINTS = {
    ETC: "all war battles — shared soldier tiers + ch.5 war monsters",
    VDZK: "Vinay del Zexay — Hugo ch.1 escape (Leo & Percival give chase)",
    KRVI: "Karaya Village — ch.1 Zexen raid & burning of Karaya",
    LZVI: "Great Hollow — ch.1–2 Zexen attacks on the Lizard Clan",
    TSVI: "Chisha Village — ch.3 Harmonian invasion (Franz & Ruby's Mantors)",
    ZKTR: "Brass Castle — Hugo ch.3 assault · ch.5 Harmonian siege",
    SOGE: "grassland plains — ch.5 war vs Sarah's Harmonian army",
    HGB1: "Budehuc Castle — Thomas ch.2 defense against the Zexen troops",
  };
  function drawWar(host) {
    const rl = EPACKS_META && EPACKS_META.recLayout, al = EPACKS_META && EPACKS_META.auxLayout;
    const parts = [];
    const wpacks = EPACKS.map((p, pi) => [p, pi]).filter(([p]) => p.war);
    if (wpacks.length && rl && al) {
      parts.push(`<div class="muted" style="margin:0 0 8px">Every war-battle combatant found on the disc: faction soldiers
        (Zexen, Karaya, Lizard, Duck, Mantor, Harmonian), enemy <b>leader units</b> and the chapter-5 war monsters
        (${wpacks.length} pack${wpacks.length === 1 ? "" : "s"}${WPACKS_SKIPPED ? `, ${WPACKS_SKIPPED} unavailable on this disc` : ""}).
        Each archive feeds the battles staged from that region, so the same soldier can be tuned per battle; edits write every
        on-disc copy in that archive. <b>Your own units use the characters' save-file stats</b> — strengthen your army in the
        Save Editor (HP, stats, equipment). War battles pay no EXP/SP/potch, so there are no reward fields.
        Leader names marked (unit) are verified against the Suikosource guide; <i>Unit&nbsp;#N</i> records are unidentified
        leader units — edit them like any other. Each pack's title notes the chapter and story beat its battles belong to
        (matched against the guide's exact level/HP tables). Filter matches unit names, archive names or the battle context.</div>`);
      const q2 = SEARCH;
      for (const [p, pi] of wpacks) {
        const hint = WAR_ARCH_HINTS[p.archive];
        const hay = (p.archive + " " + (hint || "") + " " + p.enemies.map((e) => e.name).join(" ")).toLowerCase();
        if (q2 && !hay.includes(q2)) continue;
        const nvar = p.enemies.reduce((a, e) => a + e.variants.length, 0);
        parts.push(`<details class="char epack" data-ep="${pi}" data-i="wp${pi}"><summary><span class="chev">▸</span>
            <span class="nm">${esc2(p.archive)}${hint ? ` · ${esc2(hint)}` : ""}</span>
            <span class="lv">${p.enemies.length} units · ${nvar} variants</span></summary>
          <div class="char-body"><div class="muted">expanding…</div></div></details>`);
      }
    } else if (WPACKS_SKIPPED) {
      parts.push(`<div class="warnbox">War units are indexed for the full USA disc — none of their offsets exist in this file, so nothing is editable here.</div>`);
    }
    // Army-skill reference (RPGClassics army units guide) — war skills live in game
    // code, not in an editable table, so this is read-only context.
    const wr = REF.warRef || {};
    if (wr.army || wr.skills) {
      const row = (nm, sk) => `<tr><td>${esc2(nm)}</td><td>${esc2(sk)}</td></tr>`;
      const tbl = (obj) => `<table class="invtbl"><thead><tr><th>Character</th><th>War skills</th></tr></thead>
          <tbody>${Object.keys(obj).filter((n) => !SEARCH || n.toLowerCase().includes(SEARCH) || obj[n].toLowerCase().includes(SEARCH))
            .map((n) => row(n, obj[n])).join("") || `<tr><td colspan="2" class="muted">no matches</td></tr>`}</tbody></table>`;
      const skl = wr.skills ? `<table class="invtbl" style="margin-top:8px"><thead><tr><th>Skill</th><th>Effect</th></tr></thead>
          <tbody>${Object.keys(wr.skills).map((s) => row(s, wr.skills[s])).join("")}</tbody></table>` : "";
      const notes = (wr.notes || []).map((n) => `<li>${esc2(n)}</li>`).join("");
      parts.push(`<details class="char" style="margin-top:10px"${SEARCH ? " open" : ""}><summary><span class="chev">▸</span>
          <span class="nm">Army skills reference</span><span class="lv">read-only guide data</span></summary>
        <div class="char-body">
          ${notes ? `<ul class="muted" style="margin:0 0 8px 18px;padding:0">${notes}</ul>` : ""}
          <div class="bag-h">Army units</div>${wr.army ? tbl(wr.army) : ""}
          <div class="bag-h" style="margin-top:8px">Support units</div>${wr.support ? tbl(wr.support) : ""}
          <div class="bag-h" style="margin-top:8px">War skill effects</div>${skl}
        </div></details>`);
    }
    host.innerHTML = parts.join("") || `<div class="muted">no war-unit data available</div>`;
    qa("details.epack", host).forEach((det) => {
      det.addEventListener("toggle", () => {
        if (!det.open || det._built) return;
        det._built = true;
        buildPackBody(det, EPACKS[+det.dataset.ep], rl, al);
      });
    });
  }

  function buildPackBody(det, p, rl, al) {
    const body = det.querySelector(".char-body");
    const html = [];
    for (let ei = 0; ei < p.enemies.length; ei++) {
      const e = p.enemies[ei];
      for (let vi = 0; vi < e.variants.length; vi++) {
        const v = e.variants[vi];
        const tag = e.variants.length > 1 ? ` <span class="muted">variant ${vi + 1}/${e.variants.length}</span>` : "";
        const key = `${det.dataset.ep}:${ei}:${vi}`;
        const stats = STAT_NAMES8.map((sn, si) =>
          `<label class="field enfld"><span>${sn}</span>
             <input type="number" class="en-num" min="0" max="65535" data-k="${key}" data-f="stat${si}"></label>`).join("");
        const drops = [];
        if (!p.war) for (let di = 0; di < al.nDrops; di++) {
          drops.push(`<div class="en-drop" style="display:flex;gap:6px;align-items:center;max-width:520px;margin:4px 0">
            <button type="button" class="picker en-item" style="flex:1;min-width:0" data-k="${key}" data-f="drop${di}i">—</button>
            <input type="number" class="en-num" style="width:84px;flex:none" min="0" max="1000" title="weight / 1000" data-k="${key}" data-f="drop${di}w"></div>`);
        }
        // war variants carry no rewards or drops (major battles pay no EXP/SP/potch)
        const rewards = p.war ? "" : `
            <label class="field enfld"><span>EXP value</span><input type="number" class="en-num" min="0" max="4294967295" data-k="${key}" data-f="exp"></label>
            <label class="field enfld"><span>SP</span><input type="number" class="en-num" min="0" max="65535" data-k="${key}" data-f="sp"></label>
            <label class="field enfld"><span>Potch</span><input type="number" class="en-num" min="0" max="4294967295" data-k="${key}" data-f="potch"></label>`;
        html.push(`<div class="card" style="margin:0 0 10px">
          <div class="bag-h">${esc2(e.name)}${tag} <span class="u">id ${hex(e.id, 3)} · ×${v.rec.length} cop${v.rec.length === 1 ? "y" : "ies"}</span></div>
          <div class="grid">
            <label class="field enfld"><span>Level</span><input type="number" class="en-num" min="1" max="99" data-k="${key}" data-f="lv"></label>
            <label class="field enfld"><span>HP</span><input type="number" class="en-num" min="1" max="65535" data-k="${key}" data-f="hp"></label>${rewards}
          </div>
          <div class="grid" style="margin-top:6px">${stats}</div>
          ${drops.length ? `<div style="margin-top:6px"><span class="muted">Drops (item · weight/1000):</span>${drops.join("")}</div>` : ""}
        </div>`);
      }
    }
    // ---- zones & spawn formations -------------------------------------------
    const zl = (EPACKS_META && EPACKS_META.zoneLayout) || {};
    const roster = p.enemies.map((e) => ({ id: e.id, name: e.name }));
    if ((p.zones || []).length) {
      html.push(`<div class="bag-h" style="margin-top:14px">Zones &amp; spawn formations
        <span class="u">which monsters appear where, and in what groups</span></div>
      <div class="muted" style="margin:0 0 8px">Each zone is a map area (the game's own name, e.g. <code>mori_101</code>).
        Its <b>spawn slots</b> pick which monster (and which stat variant) each slot holds — swap a slot's monster and every
        formation using that slot spawns the new one. <b>Formations</b> are the encounter groups: relative weight, then one
        pick per member from the slots. Member count can shrink but not exceed the group's original size (fixed allocation
        on disc). The picker lists this pack's roster — monsters from other packs would load without models and crash.</div>`);
      for (let zi = 0; zi < p.zones.length; zi++) {
        const z = p.zones[zi];
        const zkey = `${det.dataset.ep}:z${zi}`;
        const slotCtls = z.slots.map((s, si) =>
          `<div class="en-drop" style="display:flex;gap:6px;align-items:center;max-width:520px;margin:4px 0">
             <span class="muted" style="width:52px">slot ${si}</span>
             <button type="button" class="picker zn-slot" style="flex:1;min-width:0" data-k="${zkey}" data-si="${si}">—</button>
             <label class="muted" style="flex:none">variant <input type="number" class="en-num zn-var" style="width:56px" min="0" max="7" data-k="${zkey}" data-si="${si}"></label>
           </div>`).join("");
        const partyRows = z.parties.map((pa, pi2) => {
          const mems = pa.members.map((m, mi) =>
            `<select class="zn-mem" data-k="${zkey}" data-pi="${pi2}" data-mi="${mi}"></select>`).join("");
          return `<div class="en-drop" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0">
            <span class="muted" style="width:24px">#${pi2 + 1}</span>
            <label class="muted">weight <input type="number" class="en-num zn-prob" style="width:64px" min="0" max="100" data-k="${zkey}" data-pi="${pi2}"></label>
            <label class="muted">size <input type="number" class="en-num zn-cnt" style="width:52px" min="1" max="${pa.members.length}" data-k="${zkey}" data-pi="${pi2}"></label>
            ${mems}
            ${pa.type ? `<span class="muted">type ${pa.type}</span>` : ""}
          </div>`;
        }).join("");
        html.push(`<div class="card" style="margin:0 0 10px">
          <div class="bag-h">${esc2(z.name)} <span class="u">${z.slots.length} slots · ${z.parties.length} formations · ×${z.slots[0].off.length} cop${z.slots[0].off.length === 1 ? "y" : "ies"}</span></div>
          <div style="margin:4px 0 8px">${slotCtls}</div>
          <div class="muted">Formations:</div>${partyRows}
        </div>`);
      }
    }
    body.innerHTML = html.join("") || `<div class="muted">empty pack</div>`;
    wireEnemyFields(body, p, det.dataset.ep, rl, al);
    wireZoneFields(body, p, det.dataset.ep, zl, roster);
  }
  function wireZoneFields(scope, p, ep, zl, roster) {
    const zone = (k) => p.zones[+k.split(":z")[1]];
    const slotName = (z, si) => {
      const id = eRead(z.slots[si].off, 4) & 0xFFFF;
      const r = roster.find((x) => x.id === id);
      return r ? r.name : (REF.items && id2nameFallback(id));
    };
    function id2nameFallback(id) { return `#${hex(id, 3)}`; }
    const refreshMembers = (z, k) => {
      qa(`select.zn-mem[data-k="${k}"]`, scope).forEach((sel) => {
        const cur = sel.value;
        sel.innerHTML = z.slots.map((s, si) => `<option value="${si}">${esc2(slotName(z, si) || "slot " + si)}</option>`).join("");
        if (cur !== "") sel.value = cur;
      });
    };
    // spawn slots: monster picker (pack roster) + variant
    qa("button.zn-slot", scope).forEach((btn) => {
      const z = zone(btn.dataset.k), si = +btn.dataset.si, s = z.slots[si];
      const idOffs = s.off;                        // u32 monster id (all copies)
      const label = () => {
        const id = eRead(idOffs, 4) & 0xFFFF;
        const r = roster.find((x) => x.id === id);
        return r ? `${hex(id, 3)} · ${r.name}` : `${hex(id, 3)} · (non-roster)`;
      };
      const mark = () => markMulti(btn, eDirty(idOffs, 4), () => { eRevert(idOffs, 4); drawView(); },
        hex(eOrig(idOffs, 4) & 0xFFFF, 3));
      btn.textContent = label();
      btn.onclick = () => {
        const cur = eRead(idOffs, 4) & 0xFFFF;
        const opts = roster.map((r) => ({ id: r.id, name: r.name }));
        if (!opts.some((o) => o.id === cur)) opts.unshift({ id: cur, name: "(current, non-roster)" });
        openPicker(`${z.name} slot ${si}`, opts, cur, (id) => {
          eWrite(idOffs, 4, id);
          EREG[`${p.archive}:${btn.dataset.k}:s${si}`] = { group: `${p.archive} ${z.name}`, label: `slot ${si} monster`,
            offs: idOffs, w: 4, fmt: (x) => { const r = roster.find((y) => y.id === (x & 0xFFFF)); return r ? r.name : hex(x & 0xFFFF, 3); } };
          btn.textContent = label(); mark(); refreshMembers(z, btn.dataset.k);
        });
      };
      mark();
    });
    qa("input.zn-var", scope).forEach((inp) => {
      const z = zone(inp.dataset.k), s = z.slots[+inp.dataset.si];
      const offs = s.off.map((o) => o + 4);        // u32 variant
      const mark = () => markMulti(inp, eDirty(offs, 4), () => { eRevert(offs, 4); drawView(); }, String(eOrig(offs, 4)));
      inp.value = eRead(offs, 4);
      inp.onchange = () => {
        const v = Math.max(0, Math.min(7, +inp.value || 0)); inp.value = v;
        eWrite(offs, 4, v);
        EREG[`${p.archive}:${inp.dataset.k}:sv${inp.dataset.si}`] = { group: `${p.archive} ${z.name}`,
          label: `slot ${inp.dataset.si} variant`, offs, w: 4, fmt: String };
        mark();
      };
      mark();
    });
    // formations: weight, size, members
    qa("input.zn-prob", scope).forEach((inp) => {
      const z = zone(inp.dataset.k), pa = z.parties[+inp.dataset.pi];
      const offs = pa.off.map((o) => o + (zl.partyProb ?? 2));
      const mark = () => markMulti(inp, eDirty(offs, 2), () => { eRevert(offs, 2); drawView(); }, String(eOrig(offs, 2)));
      inp.value = eRead(offs, 2);
      inp.onchange = () => {
        const v = Math.max(0, Math.min(100, +inp.value || 0)); inp.value = v;
        eWrite(offs, 2, v);
        EREG[`${p.archive}:${inp.dataset.k}:pw${inp.dataset.pi}`] = { group: `${p.archive} ${z.name}`,
          label: `formation ${+inp.dataset.pi + 1} weight`, offs, w: 2, fmt: String };
        mark();
      };
      mark();
    });
    qa("input.zn-cnt", scope).forEach((inp) => {
      const z = zone(inp.dataset.k), pa = z.parties[+inp.dataset.pi];
      const offs = pa.off.map((o) => o + (zl.partyCount ?? 0x12));
      const mark = () => markMulti(inp, eDirty(offs, 2), () => { eRevert(offs, 2); drawView(); }, String(eOrig(offs, 2)));
      inp.value = eRead(offs, 2);
      inp.onchange = () => {
        const v = Math.max(1, Math.min(pa.members.length, +inp.value || 1)); inp.value = v;
        eWrite(offs, 2, v);
        EREG[`${p.archive}:${inp.dataset.k}:pc${inp.dataset.pi}`] = { group: `${p.archive} ${z.name}`,
          label: `formation ${+inp.dataset.pi + 1} size`, offs, w: 2, fmt: String };
        mark();
      };
      mark();
    });
    qa("select.zn-mem", scope).forEach((sel) => {
      const z = zone(sel.dataset.k), pa = z.parties[+sel.dataset.pi], mi = +sel.dataset.mi;
      const offs = pa.memOff.map((o) => o + mi);   // u8 slot index
      sel.innerHTML = z.slots.map((s, si) => `<option value="${si}">${esc2(slotName(z, si) || "slot " + si)}</option>`).join("");
      const mark = () => markMulti(sel, eDirty(offs, 1), () => { eRevert(offs, 1); drawView(); }, String(eOrig(offs, 1)));
      sel.value = String(eRead(offs, 1));
      sel.onchange = () => {
        eWrite(offs, 1, +sel.value);
        EREG[`${p.archive}:${sel.dataset.k}:pm${sel.dataset.pi}.${mi}`] = { group: `${p.archive} ${z.name}`,
          label: `formation ${+sel.dataset.pi + 1} member ${mi + 1}`, offs, w: 1,
          fmt: (x) => slotName(z, x) || String(x) };
      mark();
      };
      mark();
    });
  }
  // field key -> {offs (all copies), width, group, label, kind}
  function enemyField(p, e, v, f, rl, al) {
    const grp = `${p.archive} ${e.name}`;
    const F = {
      lv:    { offs: v.rec.map((o) => o + rl.lv), w: 2, label: "Level" },
      hp:    { offs: [...v.rec.map((o) => o + rl.hp), ...v.rec.map((o) => o + rl.maxhp)], w: 2, label: "HP" },
      exp:   { offs: v.aux.map((o) => o + al.exp), w: 4, label: "EXP value" },
      sp:    { offs: v.aux.map((o) => o + al.sp), w: 2, label: "SP" },
      potch: { offs: v.aux.map((o) => o + al.potch), w: 4, label: "Potch" },
    };
    for (let si = 0; si < 8; si++) F["stat" + si] = { offs: v.rec.map((o) => o + rl.stats + si * 2), w: 2, label: STAT_NAMES8[si] };
    for (let di = 0; di < al.nDrops; di++) {
      F["drop" + di + "i"] = { offs: v.aux.map((o) => o + al.drops + di * 4), w: 2, label: `Drop ${di + 1} item`, kind: "item" };
      F["drop" + di + "w"] = { offs: v.aux.map((o) => o + al.drops + di * 4 + 2), w: 2, label: `Drop ${di + 1} weight` };
    }
    const d = F[f];
    d.group = grp;
    return d;
  }
  function wireEnemyFields(scope, p, ep, rl, al) {
    const lookup = (key) => {
      const [, ei, vi] = key.split(":").map(Number);
      return [p.enemies[ei], p.enemies[ei].variants[vi]];
    };
    qa("input.en-num[data-f]", scope).forEach((inp) => {
      const [e, v] = lookup(inp.dataset.k);
      const fd = enemyField(p, e, v, inp.dataset.f, rl, al);
      const mark = () => markMulti(inp, eDirty(fd.offs, fd.w), () => eRevert(fd.offs, fd.w), String(eOrig(fd.offs, fd.w)));
      inp.value = eRead(fd.offs, fd.w);
      inp.onchange = () => {
        const max = fd.w === 2 ? 65535 : 4294967295;
        const val = Math.max(0, Math.min(+inp.value || 0, max));
        inp.value = val;
        eWrite(fd.offs, fd.w, val);
        EREG[`${p.archive}:${inp.dataset.k}:${inp.dataset.f}`] = { group: fd.group, label: `${e.name} ${fd.label}`, offs: fd.offs, w: fd.w, fmt: String };
        mark();
      };
      mark();
    });
    qa("button.en-item", scope).forEach((btn) => {
      const [e, v] = lookup(btn.dataset.k);
      const fd = enemyField(p, e, v, btn.dataset.f, rl, al);
      const refresh = () => { btn.textContent = itemLabel(eRead(fd.offs, fd.w)); };
      const mark = () => markMulti(btn, eDirty(fd.offs, fd.w), () => eRevert(fd.offs, fd.w), itemLabel(eOrig(fd.offs, fd.w)));
      refresh();
      btn.onclick = () => {
        const cur = eRead(fd.offs, fd.w);
        const opts = itemOpts("");
        openPicker(`${e.name} — ${fd.label}`, opts, cur, (id) => {
          eWrite(fd.offs, fd.w, id);
          EREG[`${p.archive}:${btn.dataset.k}:${btn.dataset.f}`] = { group: fd.group, label: `${e.name} ${fd.label}`, offs: fd.offs, w: fd.w, fmt: (x) => itemLabel(x) };
          refresh(); mark();
        });
      };
      mark();
    });
  }

  // ---- Files (read-only sub-file browser) ------------------------------------
  // DATA/FSECT.BIN is the disc's archive directory, so every sub-file's offset and size is
  // known (Editor/s3_subfiles.json, built by build_subfile_index.py). This view is the plain
  // window onto that: which archive holds what, where each piece starts, how big it is, and
  // what it turned out to be. It is deliberately READ-ONLY — the editable pieces inside these
  // files have their own views (battle packs → Enemies/War, room tables → Encounter), and a
  // raw byte editor over 4,403 unknown blobs would be a footgun, not a feature.
  const KIND_NOTE = {
    battle: "monster packs, spawn slots and formations — edited in the Enemies / War views",
    town: "map data, including the room table the Encounter view edits",
    map: "geometry / model data",
    data: "not yet identified",
  };
  function subfileIndex() {
    const idx = (typeof window !== "undefined" && window.S3_TEST_SUBFILES) || (REF && REF.subfiles);
    return idx && Array.isArray(idx.archives) ? idx : null;
  }
  function drawFiles(host) {
    const idx = subfileIndex();
    if (!idx) {
      host.innerHTML = refTabs() + `<div class="muted">Needs <code>Editor/s3_subfiles.json</code>; it didn't load.</div>`;
      wireRefTabs(host);
      return;
    }
    const kinds = idx.kinds || [];
    const total = idx.archives.reduce((a, x) => a + x.files.length, 0);
    const tally = {};
    idx.archives.forEach((a) => a.files.forEach((fl) => { const k = kinds[fl[2]]; tally[k] = (tally[k] || 0) + 1; }));
    const parts = [refTabs(), `<div class="muted" style="margin:0 0 10px">Every packed sub-file on the disc —
      <b>${total.toLocaleString()}</b> across ${idx.archives.length} archives — from the directory in
      <code>DATA/FSECT.BIN</code>. ${kinds.map((k) => `<b>${tally[k] || 0}</b> ${k}`).join(" · ")}.
      Read-only: the editable pieces inside these files have their own views. <b>Peek</b> reads the first
      256 bytes off your disc so you can see what a blob actually is. Filter matches archive, area name, kind or map id.</div>`];
    if (!isoFile) parts.push(`<div class="warnbox">Peek needs the open ISO.</div>`);
    const q2 = SEARCH;
    idx.archives.forEach((a, ai) => {
      const nm = archName(a.archive);
      const rows = a.files.map((fl, i) => [i, fl]).filter(([, fl]) =>
        !q2 || (a.archive + " " + nm + " " + kinds[fl[2]] + " " + (fl[3] || "")).toLowerCase().includes(q2));
      if (!rows.length) return;
      const c = {};
      a.files.forEach((fl) => { const k = kinds[fl[2]]; c[k] = (c[k] || 0) + 1; });
      parts.push(`<details class="char sfarch" data-sa="${ai}" data-i="sf${ai}"><summary><span class="chev">▸</span>
          <span class="nm">${esc2(a.archive)}.BIN${nm ? ` — ${esc2(nm)}` : ""}</span>
          <span class="muted">${fmtSize(a.size)}</span>
          <span class="lv">${a.files.length} sub-files · ${kinds.filter((k) => c[k]).map((k) => `${c[k]} ${k}`).join(" · ")}</span></summary>
        <div class="char-body"><div class="muted">expanding…</div></div></details>`);
    });
    host.innerHTML = parts.join("");
    wireRefTabs(host);
    qa("details.sfarch", host).forEach((det) => det.addEventListener("toggle", () => {
      if (!det.open || det._built) return;
      det._built = true;
      buildArchiveBody(det, idx, +det.dataset.sa, kinds);
    }));
  }

  function buildArchiveBody(det, idx, ai, kinds) {
    const a = idx.archives[ai], q2 = SEARCH;
    const rows = a.files.map((fl, i) => [i, fl]).filter(([, fl]) =>
      !q2 || (a.archive + " " + archName(a.archive) + " " + kinds[fl[2]] + " " + (fl[3] || "")).toLowerCase().includes(q2));
    det.querySelector(".char-body").innerHTML = `
      <table class="invtbl"><thead><tr><th style="width:8%">#</th><th style="width:14%">Kind</th>
        <th style="width:26%">What it is</th><th style="width:20%">ISO offset</th>
        <th style="width:16%">Size</th><th></th></tr></thead>
      <tbody>${rows.map(([i, fl]) => {
        const off = a.base + fl[0] * 2048, kind = kinds[fl[2]];
        return `<tr><td class="sl">${i}</td>
          <td><span class="opt-tag" title="${esc2(KIND_NOTE[kind] || "")}">${esc2(kind)}</span></td>
          <td class="muted">${esc2(fl[3] || KIND_NOTE[kind] || "")}</td>
          <td class="sl">0x${off.toString(16).toUpperCase()}</td>
          <td class="sl">${fmtSize(fl[1] * 2048)}</td>
          <td>${isoFile ? `<button class="chip mini" data-peek="${off}">Peek</button>` : ""}</td></tr>
          <tr class="howrow"><td colspan="6"><pre class="sfpeek" data-at="${off}" hidden></pre></td></tr>`;
      }).join("")}</tbody></table>`;
    qa("[data-peek]", det).forEach((b) => (b.onclick = async () => {
      const off = +b.dataset.peek, pre = q(`.sfpeek[data-at="${off}"]`, det);
      if (!pre.hidden) { pre.hidden = true; b.textContent = "Peek"; return; }
      b.disabled = true;
      try {
        const bytes = new Uint8Array(await isoFile.slice(off, off + 256).arrayBuffer());
        pre.textContent = hexDump(bytes, off);
        pre.hidden = false; b.textContent = "Hide";
      } catch (e) { setStatus("Could not read that region: " + e.message, "err"); }
      b.disabled = false;
    }));
  }

  // 16-bytes-per-line hex + ASCII, the way every other tool prints it.
  function hexDump(bytes, base) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = bytes.subarray(i, i + 16);
      const hexs = [...row].map((x) => x.toString(16).padStart(2, "0")).join(" ");
      const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
      out.push(`${(base + i).toString(16).toUpperCase().padStart(9, "0")}  ${hexs.padEnd(47)}  ${asc}`);
    }
    return out.join("\n");
  }

  // ---- Reference (read-only item / rune / skill browser) ---------------------
  let REF_KIND = "items";
  // Reference is the disc's read-only half, so everything that only *describes* the game
  // lives under it — item, rune and skill lookups, where an item comes from, and the sub-file
  // directory. Each sub-tab replaces the view hint, because "read-only lookup" is the only
  // thing they share; what you're looking at differs a lot between them.
  const REF_HINT = {
    items: "Reference (read-only): every item id on the disc, with its category and description.",
    runes: "Reference (read-only): every rune — what it does, the spells it grants, who carries it and where it drops.",
    classes: "Reference (read-only): the war-battle class each unit shows — and why there is no class field to edit. It is derived from the character's skills.",
    skills: "Reference (read-only): every skill — what each rank is worth, who can learn it and how far, and who has it on this disc.",
    sources: "Reference (read-only): where each item comes from — drops decoded off this disc, plus guide notes.",
    mountref: "Reference (read-only): the mount system as decoded off this disc — what each model can do, which areas carry a mount, and the battle mechanics that aren't exposed as editable fields.",
    files: "Reference (read-only): every packed sub-file on the disc — which archive holds it, where it starts, how big it is, and what it turned out to be.",
  };
  let RUNE_GROUP = "";     // Runes browser: family filter chip ("" = all)
  let SKILL_TYPE = "";     // Skills browser: type filter chip ("" = all)
  // "Where does this item come from" — the read-only half of everything the enemy index and
  // the guides know. Two provenance kinds, deliberately kept apart in the UI as well as in
  // the JSON: `drops` were decoded off this disc and are stated as fact; `guide` rows are
  // text from the Suikosource Rare Armor guide and are labelled as such. They agree where
  // they overlap (8 of the guide's 12 drop lines match the decoded tables exactly), which is
  // why both are worth showing — but a reader should never have to guess which is which.
  //
  // Chest rows are guide-only and always will be: the disc rolls a chest's contents at
  // runtime, so there is no on-disc list to read (Suikoden3_ISO_offsets.md, "The pickup
  // ROLL, decoded"). Showing them here is how that stays useful without implying it's
  // editable.
  const SRC_LABEL = { chest: "Treasure chest", corpse: "Corpse", drop: "Dropped by",
    "shop-rare": "Shop (rarity)", shop: "Shop", equipped: "Equipped to",
    minigame: "Mini-game", battle: "Major battle" };

  function sourceRows(id) {
    const src = REF.itemSources && REF.itemSources.items && REF.itemSources.items[String(id)];
    if (!src) return [];
    const out = [];
    // One row per (enemy, level, weight) — the archives hosting that pack are a detail of
    // the same fact, not separate findings. Ungrouped this was 625 rows for 188 facts.
    (src.drops || []).forEach((d) => {
      const a = d.archives || (d.archive ? [d.archive] : []);
      const where = a.length <= 4 ? a.join(", ") : `${a.slice(0, 4).join(", ")} +${a.length - 4} more`;
      out.push({ disc: true, what: d.enemy,
        detail: `Lv ${d.lv} · drop weight ${d.weight}/1000 (${(d.weight / 10).toFixed(1)}%)`
          + (where ? ` · ${where}` : "") });
    });
    (src.guide || []).forEach((g) => out.push({ disc: false,
      what: SRC_LABEL[g.kind] || g.kind, detail: g.text }));
    return out;
  }

  function drawSources(host) {
    const idx = REF.itemSources && REF.itemSources.items;
    if (!idx) {
      host.innerHTML = refTabs() + `<div class="muted">Needs <code>Editor/s3_item_sources.json</code>; it didn't load.</div>`;
      wireRefTabs(host);
      return;
    }
    const q2 = SEARCH;
    const ids = Object.keys(idx).map(Number).sort((a, b) => a - b)
      .filter((id) => !q2 || itemName(id).toLowerCase().includes(q2) || hex(id, 3).toLowerCase().includes(q2)
        || sourceRows(id).some((r) => (r.what + " " + r.detail).toLowerCase().includes(q2)));
    const body = ids.map((id) => {
      const rows = sourceRows(id);
      return `<tr><td class="sl">${hex(id, 3)}</td><td>${esc2(itemName(id))}
          <div class="muted">${esc2(REF.cats[id] || "")}</div></td>
        <td>${rows.map((r) => `<div class="srcrow"><span class="srctag ${r.disc ? "disc" : "guide"}"
             title="${r.disc ? "decoded from this disc" : "from the Suikosource Rare Armor guide"}"
             >${r.disc ? "disc" : "guide"}</span> <b>${esc2(r.what)}</b>
             <span class="muted">${esc2(r.detail)}</span></div>`).join("")}</td></tr>`;
    });
    host.innerHTML = refTabs() +
      `<div class="muted" style="margin:0 0 10px">Where each item can be found. Rows tagged
        <span class="srctag disc">disc</span> are decoded from <b>this</b> disc's enemy tables — the enemy,
        which archive's pack, that variant's level and the drop weight out of 1000. Rows tagged
        <span class="srctag guide">guide</span> are text from the Suikosource <i>Rare Armor</i> guide.
        The two agree where they overlap. <b>Chest contents are guide-only</b>: the game rolls a chest's
        contents at runtime, so there is no list on the disc to read — and nothing here is editable.</div>
      <table class="invtbl"><thead><tr><th style="width:8%">ID</th><th style="width:26%">Item</th>
        <th>Where it comes from</th></tr></thead>
        <tbody>${body.join("") || `<tr><td colspan="3" class="muted">no matches</td></tr>`}</tbody></table>`;
    wireRefTabs(host);
  }

  // Pickup locations. Two tables that are deliberately NOT joined to each other:
  //
  //   the disc  — every archive's chests / lootable corpses / herb spots, counted off the map
  //               data by the game's own object names (takara 宝, emono 獲物, herb_*). An
  //               archive ships several chapter variants of the same maps, so the figure is
  //               the MAXIMUM over its variants; summing would count one chest per chapter.
  //   the guide — the six named treasure-boss chests and the rare gear the Suikosource guide
  //               says each holds, with the guardian sitting on it.
  //
  // The disc carries no place names anywhere, only tags like YMMT and map ids like ymmt_101,
  // so mapping "Mountain Path" onto an archive would be a guess in a data costume. The UI
  // says that outright rather than quietly printing one merged table.
  function drawPickups(host) {
    const src = REF.itemSources || {};
    const places = src.places || [], chests = src.chests || [];
    if (!places.length && !chests.length) {
      host.innerHTML = refTabs() + `<div class="muted">Needs <code>Editor/s3_item_sources.json</code>; it didn't load.</div>`;
      wireRefTabs(host); return;
    }
    const q2 = SEARCH;
    const pk = (n2, label) => (n2 ? `<span class="pkct">${n2} ${label}${n2 === 1 ? "" : "s"}</span>` : "");
    const prows = places.filter((p) => !q2 || (p.archive + " " + (p.zones || []).join(" ")).toLowerCase().includes(q2))
      .map((p) => `<tr><td class="sl">${p.area != null ? "0x" + p.area.toString(16).toUpperCase().padStart(2, "0") : "—"}</td>
        <td><b>${esc2(p.archive)}</b><div class="muted">${esc2((p.zones || []).join(", ") || "no battle zones indexed")}</div></td>
        <td>${pk(p.chest, "chest")}${pk(p.corpse, "corpse")}${pk(p.herbs, "herb spot")}</td>
        <td class="muted">${p.variants} chapter variant${p.variants === 1 ? "" : "s"}</td></tr>`);
    const crows = chests.filter((c) => !q2 || (c.place + " " + c.items.map((i) => itemName(+i.item)).join(" ")).toLowerCase().includes(q2))
      .map((c) => {
        const guards = [...new Set(c.items.map((i) => i.guardian).filter(Boolean))];
        return `<tr><td><b>${esc2(c.place)}</b>${guards.length
            ? `<div class="muted">guarded by ${esc2(guards.join(" · "))}</div>` : ""}</td>
          <td>${c.items.map((i) => `<span class="pkitem">${esc2(itemName(+i.item))}</span>`).join(" ")}</td></tr>`;
      });
    host.innerHTML = refTabs() +
      `<div class="muted" style="margin:0 0 10px">Where the game hides things. The first table is counted off
        <b>your disc</b> — the map objects the game itself names <code>takara</code> (宝, a chest),
        <code>emono</code> (獲物, a lootable corpse) and <code>herb_*</code>. An archive ships the same maps
        several times over, one set per chapter, so the count is the most any single variant carries rather
        than the total. The second table is the Suikosource guide's six treasure-boss chests.
        <b>The two aren't linked</b>: the disc holds no place names at all, only tags like <code>YMMT</code>
        and map ids like <code>ymmt_101</code>, so pairing "Mountain Path" with an archive would be a guess.
        Nothing here is editable — a chest's contents are rolled at run time, not stored.</div>
      <h3 class="sec">On the disc — pickups per area</h3>
      <table class="invtbl"><thead><tr><th style="width:8%">Area</th><th style="width:34%">Archive · map ids</th>
        <th>Pickups</th><th style="width:20%"></th></tr></thead>
        <tbody>${prows.join("") || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>
      <h3 class="sec">From the guide — treasure-boss chests</h3>
      <table class="invtbl"><thead><tr><th style="width:26%">Chest</th><th>Rare gear it holds</th></tr></thead>
        <tbody>${crows.join("") || `<tr><td colspan="2" class="muted">no matches</td></tr>`}</tbody></table>`;
    wireRefTabs(host);
  }

  // ---- Runes browser ---------------------------------------------------------
  // Runes fall into three families and the item-id list keeps each family contiguous, so these
  // ranges ARE the classification — there is no per-rune table here to drift out of sync.
  // Checked against Editor/Suikoden3_item_ids.txt: 22 + 27 + 23 = 72, which is exactly the
  // number of items in the "Runes" category, so every rune lands in one family and no other
  // item can wander in.
  const RUNE_GROUPS = [
    ["magic", "Magic", 0x13D, 0x152, "grants spells — which four you get depends on the rune's mastery level"],
    ["attack", "Special attack", 0x153, 0x16D, "a character's or a weapon class's signature attack; several are one-per-battle"],
    ["support", "Support", 0x1B8, 0x1CE, "passive — attach it and forget it. No spells, no menu entry in battle"],
  ];
  const runeGroupOf = (id) => (RUNE_GROUPS.find(([, , lo, hi]) => id >= lo && id <= hi) || ["", ""])[0];
  const runeGroupLabel = (k) => (RUNE_GROUPS.find(([g]) => g === k) || ["", ""])[1];
  const runeIds = () => Object.keys(REF.items).map(Number).filter((id) => REF.cats[id] === "Runes").sort((a, b) => a - b);

  // Both guide files that answer "whose rune is this?" spell rune names their own way — the
  // slot guide writes "Eight Devil", "Shining wing", "Sword of Rage" where the item list has
  // "Eight-Devil", "Shining Wing", "Sword Of Rage" — so both indexes are keyed by nameKey(),
  // the same normalizer runeTblDesc() already trusts before it believes a disc record.
  let RUNE_OWNERS = null, RUNE_HOLDERS = null;
  const SLOT_NAME = { head: "Head", right: "Right hand", left: "Left hand" };
  function runeOwners() {              // rune -> the character (or weapon class) it belongs to
    if (RUNE_OWNERS) return RUNE_OWNERS;
    const m = {}, src = REF.runeOwner || {};
    for (const k in src) m[nameKey(k)] = src[k];
    return (RUNE_OWNERS = m);
  }
  function runeHolders() {             // rune -> [{ch, slot}] who starts with it equipped
    if (RUNE_HOLDERS) return RUNE_HOLDERS;
    const m = {}, slots = REF.runeSlots || {};
    for (const ch in slots) for (const k in SLOT_NAME) {
      const s = slots[ch][k];
      if (!s || s.state !== "rune" || !s.rune) continue;
      const key = nameKey(s.rune);
      (m[key] = m[key] || []).push({ ch, slot: SLOT_NAME[k] });
    }
    return (RUNE_HOLDERS = m);
  }

  // What a rune is and does. The menu text is read off the LOADED disc (RUNE_TBL), so a rewrite
  // on the Text tab shows up here immediately; s3_rune_food_desc.json is the fallback, and it
  // also carries the "— Grants a, b, c" spell list that the disc's own one-liner leaves out.
  // Rune -> the spell records that carry its status/enhance bits, read live off the disc. This is
  // the mapping that used to be missing: "Sword of Cyclone" and "Wind Amulet" are spell records,
  // and without this you had to already know that to find them. Bits are decoded in plain
  // language so the row says what the rune does before you open the editor.
  function runeEffects(grants) {
    if (!BUF || !grants.length) return [];
    const idx = spellNameIndex();
    return grants.map((n) => {
      const i = idx[n];
      if (i == null) return null;
      const f18 = r32(SPELL.off + i * SPELL.stride + 0x18) >>> 0;
      return { spell: n, i, f18, text: decodeF18Plain(f18) };
    }).filter(Boolean).filter((e) => e.f18);          // only spells that actually carry an effect
  }
  // The effect editor, inline in the rune row. Same flags18 checkbox set the Spells tab uses
  // (so there is one implementation of "which bits are set"), plus the two other numbers that
  // actually change what an enhance/status rune does: how often it lands and how hard it hits.
  // Strength and duration of a status are engine-coded and deliberately absent — see F18_NOTE.
  const F18_SWORD = { 22: "fire", 23: "lightning", 24: "wind" };
  const F18_RESIST = { 25: "fire", 26: "lightning", 27: "wind" };
  function runeFxHTML(e) {
    const off = SPELL.off + e.i * SPELL.stride, canTail = e.i + 1 < SPELL.count;
    const swordChips = Object.entries(F18_SWORD).map(([b, el]) =>
      `<button class="chip mini" data-fxpreset="sword:${b}" data-i="${e.i}"
        title="Set the sword-enhance element to ${el}, clearing the other two">adds ${el}</button>`).join("");
    const resistChips = `<button class="chip mini" data-fxpreset="resist:all" data-i="${e.i}"
        title="Set all three elemental-resist bits">resists all three</button>`;
    const num = (k, label, val, cap) => `<label class="field"><span>${label}</span>
        <input type="number" class="rfx" data-i="${e.i}" data-k="${k}" min="0" max="${cap}" value="${val}" ${canTail || k === "power" ? "" : "disabled"}></label>`;
    return `<details class="runefx" data-i="${e.i}"${RUNE_FX_OPEN.has(e.i) ? " open" : ""}>
      <summary><span class="chev">▸</span> <b>${esc2(e.spell)}</b>
        <span class="muted">${esc2(e.text)}</span></summary>
      <div class="char-body">
        <div class="subtabs" style="margin:0 0 8px">${swordChips}${resistChips}
          <button class="chip mini" data-fxpreset="none" data-i="${e.i}">no status</button></div>
        <div class="grid">
          ${num("chance", "Chance it lands %", canTail ? r16(off + SPELL.chance) : 0, 100)}
          ${num("power", "Power", r32(off + 0x1C), 99999)}
          ${f18CtlHTML(e.i, r32(off + 0x18) >>> 0)}
        </div></div></details>`;
  }
  let RUNE_FX_OPEN = new Set();          // which effect editors stay open across a redraw
  function runeInfo(id) {
    const nm = REF.items[id] || "";
    const fb = (REF.runeFood && REF.runeFood[String(id)]) || "";
    const m = /^(.*?)\s*—\s*Grants\s+(.+)$/.exec(fb);
    const key = nm.toLowerCase().replace(/\s+/g, "").replace(/rune$/, "");
    // An attack rune's spell carries the rune's own name (Kite -> "Kite"), so it has no
    // RUNE_SPELLS entry and no "— Grants" clause; fall back to the rune name so those runes
    // reach the effect editor too. Resolved against the loaded disc, not a bundled list.
    let grants = RUNE_SPELLS[key] || (m ? m[2].split(/\s*,\s*/) : []);
    if (!grants.length && BUF && nm && nm in spellNameIndex()) grants = [nm];
    // The rune's own desc string, as a pointer + slot cap, so the browser can edit it in place.
    // This is the copy the game's rune menu actually reads (getDesc VA 0x16DBE48 -> itemRecord
    // VA 0x16DBCD8 -> RUNE_TBL +4), and until now nothing in the editor could write it: the
    // Text tab's prose filter rejects every one of these strings ("DMGx0.4" trips its
    // letter-then-digit reject), so the only editable copy was the spell record's — the wrong
    // one. That is issue #11. Edits here go through setDescText, which mirrors both copies.
    const dp = BUF && id >= RUNE_TBL.lo && id <= RUNE_TBL.hi && inBlk(RUNE_TBL.off + id * RUNE_TBL.stride, RUNE_TBL.stride)
      ? r32(RUNE_TBL.off + id * RUNE_TBL.stride + RUNE_TBL.desc) : 0;
    const own = dp ? runeTblDesc(id) : "";
    return {
      id, name: nm, group: runeGroupOf(id),
      text: (BUF && runeTblDesc(id)) || (m ? m[1] : fb),
      descPtr: own ? dp : 0,                       // 0 when this row has no trustworthy record
      descMax: own ? origSlotLen(dp) : 0,
      descCopies: own ? descCopyCount(vaOff(dp)) : 1,
      grants,
      effects: runeEffects(grants),
      owner: runeOwners()[nameKey(nm)] || "",
      holders: runeHolders()[nameKey(nm)] || [],
      sources: sourceRows(id),
    };
  }
  const runeHaystack = (r) => [r.name, hex(r.id, 3), r.text, runeGroupLabel(r.group), r.grants.join(" "), r.owner,
    r.holders.map((h) => h.ch + " " + h.slot).join(" "),
    r.sources.map((s) => s.what + " " + s.detail).join(" ")].join(" ").toLowerCase();

  // "Who has it / where to get it" — three kinds of row, each tagged with where it came from,
  // for the same reason the Item-sources browser tags its own: a decoded drop weight and a
  // guide's prose are not the same class of fact and a reader shouldn't have to guess which.
  function runeWhoHTML(r) {
    const rows = [];
    if (r.owner) rows.push({ disc: false, what: "Belongs to", detail: r.owner });
    if (r.holders.length) rows.push({ disc: false, what: "Starts equipped on",
      detail: r.holders.map((h) => `${h.ch} (${h.slot})`).join(", ") });
    rows.push(...r.sources);
    if (!rows.length) return `<span class="muted">—</span>`;
    return rows.map((x) => `<div class="srcrow"><span class="srctag ${x.disc ? "disc" : "guide"}"
        title="${x.disc ? "decoded from this disc" : "from the Suikosource guides"}"
        >${x.disc ? "disc" : "guide"}</span> <b>${esc2(x.what)}</b>
        <span class="muted">${esc2(x.detail)}</span></div>`).join("");
  }

  function drawRunes(host) {
    const all = runeIds().map(runeInfo);
    const q2 = SEARCH;
    const rows = all.filter((r) => (!RUNE_GROUP || r.group === RUNE_GROUP) && (!q2 || runeHaystack(r).includes(q2)));
    const tally = (k) => all.filter((r) => r.group === k).length;
    const chips = `<div class="subtabs" style="margin:0 0 10px">
      <button class="chip${RUNE_GROUP ? "" : " on"} mini" data-rgrp="">All (${all.length})</button>
      ${RUNE_GROUPS.map(([k, label, , , note]) => `<button class="chip${RUNE_GROUP === k ? " on" : ""} mini"
        data-rgrp="${k}" title="${esc2(note)}">${esc2(label)} (${tally(k)})</button>`).join("")}</div>`;
    host.innerHTML = refTabs() + chips +
      `<div class="muted" style="margin:0 0 10px">Every rune in the game: what it does, which spells it
        grants, and who carries it. Descriptions come off <b>this</b> disc's rune table, so an edit on the
        Text tab shows here. <b>Grants</b> lists the spells a magic rune unlocks as its mastery level rises;
        the Spells tab is where those are edited. Rows in the last column are tagged
        <span class="srctag guide">guide</span> when they come from the Suikosource rune-slot and character
        guides and <span class="srctag disc">disc</span> when decoded from this disc's enemy drop tables.
        The <b>menu text</b> box writes the rune's description straight into the table the game reads for it, capped
        to the on-disc slot. Twenty of these descriptions are stored twice on the disc — once here and once on the
        spell record of the attack the rune grants — and an edit writes <b>both</b>, which is what stopped rune text
        edits from showing up in game.
        Where a rune carries a status or enhance effect — Sword of Rage/Thunder/Cyclone, the Fire/Thunder/Wind
        Amulets, the poison and sleep runes — the effect is named in plain language and is <b>editable right
        here</b>: open it to tick any combination of effects, change how often it lands, and change its power.
        You don't need to know which spell record backs a rune. ${esc2(F18_NOTE)}
        Which rune a character has equipped is still set on the <b>Characters</b> tab.</div>
      <table class="invtbl"><thead><tr><th style="width:8%">ID</th><th style="width:20%">Rune</th>
        <th style="width:36%">What it does</th><th>Who has it / where to get it</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="sl">${hex(r.id, 3)}</td>
          <td>${esc2(r.name)}<div class="opt-tag">${esc2(runeGroupLabel(r.group))}</div></td>
          <td>${r.descMax > 0
            ? `<label class="field" style="margin:0 0 6px"><span class="muted">Menu text
                 <span class="u">max ${r.descMax}${r.descCopies > 1 ? ` · ${r.descCopies} copies, mirrored` : ""}</span></span>
               <input type="text" class="rdesc" data-id="${r.id}" maxlength="${r.descMax}" value="${esc2(r.text)}"></label>`
            : `<div class="muted">${esc2(r.text || "—")}</div>`}
            ${r.grants.length ? `<div class="grants">${r.grants.map((s) =>
              `<span class="spellchip">${esc2(s)}</span>`).join("")}</div>` : ""}
            ${r.effects.map(runeFxHTML).join("")}
            ${r.effects.length ? `<div class="srcrow"><button class="chip mini" data-spjump="${esc2(r.effects[0].spell)}"
                title="Open the full spell record on the Spells tab">Open on Spells tab</button></div>` : ""}</td>
          <td>${runeWhoHTML(r)}</td></tr>`).join("")
        || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>`;
    qa("[data-rgrp]", host).forEach((b) => (b.onclick = () => { RUNE_GROUP = b.dataset.rgrp; drawRunes(host); }));
    // "Open on Spells tab" hands off with the search box already narrowed to that spell, for the
    // fields the inline editor doesn't carry (element, target, radius, description).
    qa("[data-spjump]", host).forEach((b) => (b.onclick = () => {
      VIEW = "spells"; SEARCH = b.dataset.spjump.toLowerCase();
      const box = q("#isoSearch"); if (box) box.value = b.dataset.spjump;
      drawView();
    }));
    // In-place rune menu text. Writes RUNE_TBL's copy — the one the game reads — and
    // setDescText mirrors it onto the spell record's copy for the 20 attack runes.
    qa("input.rdesc", host).forEach((el) => {
      const id = +el.dataset.id, dptr = r32(RUNE_TBL.off + id * RUNE_TBL.stride + RUNE_TBL.desc);
      markField(el, vaOff(dptr), origSlotLen(dptr), "text");
      el.onchange = () => {
        const res = setDescText(dptr, el.value, REF.items[id] || `Rune ${hex(id, 3)}`, "Menu text");
        if (res.tooLong) { setStatus(`Description too long — max ${res.max} characters for this rune.`, "warn"); return drawRunes(host); }
        if (res.skip) return setStatus("That rune's description can't be written on this disc.", "err");
        setStatus(res.copies > 1 ? `Written to all ${res.copies} copies of that description on the disc.` : "", res.copies > 1 ? "ok" : "");
        drawRunes(host);
      };
    });
    // ---- inline effect editing -------------------------------------------------
    // Two runes can grant the same spell (Phoenix and Mallet both grant spell 51), so a mask is
    // always rebuilt from the boxes inside THIS <details> — never from every box with that
    // data-i, which would OR a stale sibling group back in.
    qa("details.runefx", host).forEach((d) => (d.ontoggle = () => {
      const i = +d.dataset.i; d.open ? RUNE_FX_OPEN.add(i) : RUNE_FX_OPEN.delete(i);
    }));
    const maskOf = (d) => {
      let m = 0;
      qa("input.sp18", d).forEach((c) => { if (c.checked) m |= (1 << +c.dataset.b); });
      return m >>> 0;
    };
    qa("input.sp18", host).forEach((el) => (el.onchange = () => {
      const d = el.closest("details.runefx");
      applySpell(+el.dataset.i, { statusMask: maskOf(d) }, false);
      drawRunes(host);
    }));
    qa("input.sp18hex", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, raw = el.value.trim().replace(/^0x/i, "");
      if (!/^[0-9a-f]{1,8}$/i.test(raw)) {
        setStatus(`“${el.value}” isn't a hex mask — use up to 8 hex digits, e.g. 1DE7.`, "err");
        return drawRunes(host);
      }
      applySpell(i, { statusMask: parseInt(raw, 16) }, false);
      setStatus("", ""); drawRunes(host);
    }));
    qa("input.rfx", host).forEach((el) => (el.onchange = () => {
      const k = el.dataset.k, f = {};
      f[k] = Math.max(0, +el.value || 0);
      applySpell(+el.dataset.i, f, false);
      drawRunes(host);
    }));
    qa("[data-fxpreset]", host).forEach((b) => (b.onclick = () => {
      const i = +b.dataset.i, p = b.dataset.fxpreset;
      let m = r32(SPELL.off + i * SPELL.stride + 0x18) >>> 0;
      if (p === "none") m = 0;
      else if (p === "resist:all") m |= (1 << 25) | (1 << 26) | (1 << 27);
      else if (p.startsWith("sword:")) {                       // one element, not three
        const keep = +p.slice(6);
        m &= ~((1 << 22) | (1 << 23) | (1 << 24));
        m |= (1 << keep);
      }
      applySpell(i, { statusMask: m }, false);
      RUNE_FX_OPEN.add(i); drawRunes(host);
    }));
    wireRefTabs(host);
  }

  // ---- Skills browser --------------------------------------------------------
  // The three types in s3_skill_ref.json line up exactly with how the game treats them, and
  // "Utility" is the set the editor already knows as the support skills: supportActive() gates
  // ids 0x1C..0x26 for the same eleven, verified 27/27 against the character guide. So the
  // Utility chip and the Support view's fade are two views of one fact, not two guesses.
  const SKILL_TYPES = [
    ["Mundane", "learnable by most fighters; the bread-and-butter combat skills"],
    ["Unique", "restricted — only some characters can take these, and rarely to S"],
    ["Utility", "the support skills: castle abilities that work outside battle (Cook, Appraisal, Discount, Bath…)"],
  ];
  const skillType = (id) => ((REF.skillRef && REF.skillRef[String(id)]) || {}).type || "";
  const GRADES = ["S", "A+", "A", "B+", "B", "C", "D", "E"];   // best first, for the cap summary

  // Who the guide says can learn a skill, and how far. Its cap tables only cover the combat
  // skills (ids 1..23, 26, 39..41) — the Utility ones aren't per-character caps at all, which
  // is why an empty list here is a fact worth printing rather than a hole to hide.
  let SKILL_LEARNERS = null;
  function skillLearners() {
    if (SKILL_LEARNERS) return SKILL_LEARNERS;
    const m = {}, caps = REF.skillCaps || {};
    for (const ch in caps) for (const sid in caps[ch]) (m[sid] = m[sid] || []).push({ ch, cap: caps[ch][sid] });
    return (SKILL_LEARNERS = m);
  }
  // Live from the disc, so it reflects staged edits: which support characters (list3) carry a
  // skill, and which fighters (list1) start with one. Both tables are tiny — 35 x 8 and 80 x 6.
  function skillHoldersLive() {
    const m = {};
    if (!BUF) return m;
    const add = (id, entry) => { if (id) (m[id] = m[id] || []).push(entry); };
    const [b3, s3] = TABLES.list3, n3 = REF.names.list3 || {};
    for (let i = 0; i < LIST_COUNT.list3; i++) {
      const nm = n3[String(i)]; if (!nm) continue;
      for (let k = 0; k < 8; k++) {
        const o = b3 + i * s3 + k; if (!inBlk(o, 1)) continue;
        const v = readW(o, 1);
        if (v && supportActive(v)) add(v, { ch: nm, note: "support" });   // combat slots on list3 never fire
      }
    }
    const [b1, s1] = TABLES.list1, n1 = REF.names.list1 || {};
    for (let i = 0; i < LIST_COUNT.list1; i++) {
      const nm = n1[String(i)]; if (!nm) continue;
      for (let k = 0; k < 6; k++) {
        const o = b1 + i * s1 + 12 + k * 2; if (!inBlk(o, 2)) continue;
        add(readW(o, 1), { ch: nm, note: rankLabel(readW(o + 1, 1)) });
      }
    }
    return m;
  }

  function skillCardHTML(id, learners, live) {
    const r = (REF.skillRef && REF.skillRef[String(id)]) || {};
    const ty = r.type || "";
    const byGrade = GRADES.map((g) => [g, learners.filter((l) => l.cap === g)]).filter(([, l]) => l.length);
    const best = byGrade.length ? byGrade[0][0] : "";
    const effects = (r.effects || []).map((e) => `<tr><td class="ty">${esc2(e.label)}</td>${
      RANK_OPTS.slice(1).map(([, g]) => `<td class="sl">${esc2((e.ranks && e.ranks[g]) || "–")}</td>`).join("")}</tr>`).join("");
    const capBlock = byGrade.length
      ? `<h4>Who can learn it — ${learners.length} characters, best <b>${esc2(best)}</b></h4>
         ${byGrade.map(([g, l]) => `<div class="srcrow"><span class="srctag guide">${esc2(g)}</span>
            <span class="muted">${esc2(l.map((x) => x.ch).join(", "))}</span></div>`).join("")}`
      : `<h4>Who can learn it</h4><div class="muted">Not in the guide's cap tables.${
          ty === "Utility" ? " Utility skills aren't capped per character — a support character either has one or doesn't." : ""}</div>`;
    const liveBlock = live.length
      ? `<h4>On this disc</h4><div class="srcrow"><span class="srctag disc">disc</span>
           <span class="muted">${esc2(live.map((x) => `${x.ch} (${x.note})`).join(", "))}</span></div>`
      : `<h4>On this disc</h4><div class="muted">No character starts with it.</div>`;
    return `<details class="char" data-i="sk${id}"${SEARCH ? " open" : ""}><summary><span class="chev">▸</span>
        <span class="nm">${esc2(skillName(id))}</span><span class="muted">${hex(id, 2)}</span>
        <span class="lv">${esc2(ty)}${byGrade.length ? ` · ${learners.length} can learn · best ${esc2(best)}` : ""}</span></summary>
      <div class="char-body">
        <div class="muted" style="margin-bottom:8px">${esc2(r.desc || "No guide description for this skill.")}</div>
        ${effects ? `<h4>Effect by rank</h4>
          <table class="invtbl ranktbl"><thead><tr><th>Effect</th>${
            RANK_OPTS.slice(1).map(([, g]) => `<th>${esc2(g)}</th>`).join("")}</tr></thead>
            <tbody>${effects}</tbody></table>` : ""}
        ${capBlock}
        ${liveBlock}
      </div></details>`;
  }

  function drawSkillsRef(host) {
    const learners = skillLearners(), live = skillHoldersLive(), q2 = SEARCH;
    const ids = Object.keys(REF.skills).map(Number).sort((a, b) => a - b);
    const tally = (t) => ids.filter((id) => skillType(id) === t).length;
    const hay = (id) => {
      const r = (REF.skillRef && REF.skillRef[String(id)]) || {};
      return [skillName(id), hex(id, 2), r.type || "", r.desc || "",
        (learners[String(id)] || []).map((l) => l.ch).join(" "),
        (live[id] || []).map((x) => x.ch).join(" ")].join(" ").toLowerCase();
    };
    const shown = ids.filter((id) => (!SKILL_TYPE || skillType(id) === SKILL_TYPE) && (!q2 || hay(id).includes(q2)));
    const chips = `<div class="subtabs" style="margin:0 0 10px">
      <button class="chip${SKILL_TYPE ? "" : " on"} mini" data-styp="">All (${ids.length})</button>
      ${SKILL_TYPES.map(([t, note]) => `<button class="chip${SKILL_TYPE === t ? " on" : ""} mini"
        data-styp="${t}" title="${esc2(note)}">${t === "Utility" ? "Utility (support)" : t} (${tally(t)})</button>`).join("")}</div>`;
    host.innerHTML = refTabs() + chips +
      `<div class="muted" style="margin:0 0 10px">Every skill, what each rank of it is actually worth, and who
        can get there. Effect numbers and the per-character caps are from the Suikosource skills guide
        (<span class="srctag guide">guide</span>); the <b>On this disc</b> line is read live out of the loaded
        ISO (<span class="srctag disc">disc</span>) and follows your staged edits. <b>Utility</b> are the
        support skills — castle abilities like Cook, Appraisal and Discount that only support characters use;
        they have no per-character cap, so the guide lists none. Editing lives on the
        <b>Characters</b>, <b>Growth</b> and <b>Support</b> tabs.</div>
      ${shown.map((id) => skillCardHTML(id, learners[String(id)] || [], live[id] || [])).join("")
        || `<div class="muted">no matches</div>`}`;
    qa("[data-styp]", host).forEach((b) => (b.onclick = () => { SKILL_TYPE = b.dataset.styp; drawSkillsRef(host); }));
    wireRefTabs(host);
  }

  // ---- Reference tab strip ---------------------------------------------------
  // [key, label, count(), draw(host)] — data-driven because several people add modes here and
  // a literal strip means every new mode edits the same three lines. `count` is a thunk since
  // REF is still null when this array is built. Function declarations hoist, so the draw
  // references resolve fine.
  const REF_MODES = [
    ["items", "Items", () => Object.keys(REF.items).length, drawItemsRef],
    ["runes", "Runes", () => runeIds().length, drawRunes],
    ["classes", "Classes", () => CLASS_TYPES, drawClassesRef],
    ["skills", "Skills", () => Object.keys(REF.skills).length, drawSkillsRef],
    ["sources", "Item sources", () => Object.keys((REF.itemSources && REF.itemSources.items) || {}).length, drawSources],
    ["files", "Files", () => { const sf = subfileIndex(); return (sf ? sf.archives.reduce((a, x) => a + x.files.length, 0) : 0).toLocaleString(); }, drawFiles],
    ["places", "Pickups", () => ((REF.itemSources && REF.itemSources.places) || []).length, drawPickups],
    ["mountref", "Mounts", () => MOUNTREF.riders.length + MOUNTREF.mounts.length, drawMountRef],
  ];
  function refTabs() {
    return `<div class="subtabs" style="margin-bottom:10px">${REF_MODES.map(([k, label, count]) =>
      `<button class="chip${REF_KIND === k ? " on" : ""}" data-ref="${k}">${label} (${count()})</button>`).join("")}</div>`;
  }
  function wireRefTabs(host) {
    // go through drawView so the per-sub-tab hint above the list follows the tab
    qa("[data-ref]", host).forEach((b) => (b.onclick = () => {
      REF_KIND = b.dataset.ref; RUNE_GROUP = ""; SKILL_TYPE = "";   // a mode's filter chips don't outlive it
      drawView();
    }));
  }
  // ---- Classes (war-battle unit type) ----------------------------------------
  // What the game shows as a unit's class — Hugo a Slasher, Lulu a Knight, Fubar a Slasher.
  // There is NO per-character class byte, which is the whole finding: the class is DERIVED at
  // runtime from the character's own skill list. Chain, all read off this disc:
  //
  //   display fn  VA 0x169B5F8  keeps the skill slots with rank > 0, selection-sorts them by
  //                             rank descending, then looks up the top two skill ids
  //   skill id    VA 0x16C7758 -> *(u8)(rec + 0x10 + slot*2)
  //   skill rank  VA 0x16C7878 -> *(u8)(rec + 0x11 + slot*2)
  //   record      VA 0x16C6D08 -> live 140-byte character record (list1's layout)
  //   class table VA 0x19605C0 (file 0x3A7DC0), 43 rows x 47 pairs of bytes, indexed
  //               [skillA-1][skillB-1] -> (type word, modifier word)
  //   word pool   VA 0x1960480 (file 0x3A7C80), 78 pointers, index 0 blank
  //
  // Column index == skill id, all 43 of them: 0x0C Shield Protect -> "Shield Knight",
  // 0x0D Armor Protect -> "Armored Knight", 0x0E Fire Magic -> "Fire Cmdr.", 0x1F Cook ->
  // "Cook Fighter", 0x28 Pale Gate Magic -> "Gate Cmdr.". Re-running the derivation over
  // list1 reproduces the three known-good anchors exactly, which is why this is stated as
  // fact rather than as a guess: change a character's skills and their class changes with it.
  const CLASS_POOL = { off: 0x3A7C80, count: 78 };
  const CLASS_TBL = { off: 0x3A7DC0, stride: 94, max: 43 };
  const CLASS_TYPES = 21;                  // pool indices 1..21 are the class words; 22+ modifiers
  let CLASS_NAMES = null;
  function classNames() {
    if (CLASS_NAMES) return CLASS_NAMES;
    const out = [];
    for (let i = 0; i < CLASS_POOL.count; i++) {
      const o = CLASS_POOL.off + i * 4;
      out.push(inBlk(o, 4) ? strAt(r32(o)) : "");
    }
    return (CLASS_NAMES = out);
  }
  // (skillA, skillB) -> the class label the game prints. Both are skill ids, 1..43.
  function classOf(a, b) {
    if (!(a >= 1 && a <= CLASS_TBL.max && b >= 1 && b <= CLASS_TBL.max)) return "";
    const o = CLASS_TBL.off + (a - 1) * CLASS_TBL.stride + (b - 1) * 2;
    if (!inBlk(o, 2)) return "";
    const N = classNames();
    return [N[r8(o)] || "", N[r8(o + 1)] || ""].filter(Boolean).join(" ");
  }
  // Derive one list1 character's class the way VA 0x169B5F8 does. Returns the label plus the
  // two skills that decided it, so the reference can show its own working.
  function classForChar(i) {
    const [b0, s0] = TABLES.list1, base = b0 + i * s0, slots = [];
    for (let k = 0; k < 8; k++) {
      const o = base + 12 + k * 2; if (!inBlk(o, 2)) break;
      const id = r8(o), rk = r8(o + 1);
      if (!id && !rk) break;
      if (rk > 0) slots.push({ id, rk, n: k });
    }
    if (!slots.length) return { label: "", slots, a: 0, b: 0 };
    const ord = slots.slice().sort((p, q) => q.rk - p.rk || p.n - q.n);   // stable, rank desc
    const a = ord[0].id, bb = (ord[1] || ord[0]).id;
    return { label: classOf(a, bb), slots, a, b: bb, same: ord.length < 2 };
  }
  function drawClassesRef(host) {
    const N = classNames();
    const words = (lo, hi) => N.map((s, i) => ({ s, i })).filter((x) => x.s && x.i >= lo && x.i <= hi)
      .map((x) => `<span class="spellchip" title="pool index ${x.i}">${esc2(x.s)}</span>`).join(" ");
    const names = REF.names.list1 || {};
    const rows = [];
    for (let i = 0; i < LIST_COUNT.list1; i++) {
      const nm = names[String(i)]; if (!nm) continue;
      const c = classForChar(i); if (!c.slots.length) continue;
      const q2 = SEARCH;
      const hay = `${nm} ${c.label} ${c.slots.map((x) => skillName(x.id)).join(" ")}`.toLowerCase();
      if (q2 && !hay.includes(q2)) continue;
      rows.push(`<tr><td>${esc2(nm)}</td>
        <td><b>${esc2(c.label || "—")}</b></td>
        <td class="sl">${esc2(skillName(c.a))} <span class="muted">+</span> ${esc2(skillName(c.b))}${
          c.same ? ` <span class="u">(only one skill — the game reads a second slot that was never filled)</span>` : ""}</td>
        <td><span class="muted">${c.slots.map((x) => `${esc2(skillName(x.id))} ${rankLabel(x.rk)}`).join(", ")}</span></td></tr>`);
    }
    host.innerHTML = refTabs() +
      `<div class="warnbox" style="margin:0 0 10px"><b>There is no class byte.</b> A character's class is
        worked out from their own skill list every time the game draws it: the skills they actually have are
        sorted by rank, and the top two are looked up in a 43&times;43 table of class words. So the way to
        change someone's class is to change their <b>skills</b> (Characters tab) — there is no field to set,
        and nothing here is editable.</div>
      <div class="muted" style="margin:0 0 10px">Read live off <b>this</b> disc: the word pool at
        <code>0x${hex(CLASS_POOL.off, 6)}</code> and the class table at <code>0x${hex(CLASS_TBL.off, 6)}</code>,
        with the derivation copied from the game's own display routine (VA <code>0x169B5F8</code>). The table's
        column index is the skill id, all 43 of them — Shield Protect gives &ldquo;Shield Knight&rdquo;, Fire
        Magic &ldquo;Fire Cmdr.&rdquo;, Cook &ldquo;Cook Fighter&rdquo;. Verified against three known units:
        Hugo and Fubar come out Slashers, Lulu a Knight.</div>
      <div class="card" style="margin:0 0 12px"><div class="bag-h">Class words <span class="u">${CLASS_TYPES} of them</span></div>
        <div class="grants">${words(1, CLASS_TYPES)}</div>
        <div class="bag-h" style="margin-top:10px">Modifier words <span class="u">appended to the class</span></div>
        <div class="grants">${words(CLASS_TYPES + 1, CLASS_POOL.count - 1)}</div></div>
      <table class="invtbl"><thead><tr><th style="width:16%">Character</th><th style="width:18%">Class</th>
        <th style="width:30%">Decided by</th><th>Their skills</th></tr></thead>
        <tbody>${rows.join("") || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>`;
    wireRefTabs(host);
  }
  function drawReference(host) { (REF_MODES.find(([k]) => k === REF_KIND) || REF_MODES[0])[3](host); }

  // ---- Mounts reference (read-only) ------------------------------------------
  // Everything the mount research established that ISN'T a field you can edit. Kept here
  // rather than in the Mounts tab so the editable and the merely-true don't get confused.
  // Capability comes from clip containment in ETC.BIN: a clip belongs to the cha_ record whose
  // payload header contains it, not to the nearest preceding name (that distinction is what
  // corrected an earlier reading of Geddoe as never rigged to ride).
  const MOUNTREF = {
    riders: [
      ["Hugo", "syu1", "yes — the only model with both (07x + 97x)", "yes · 311 family", "the only unit with the full ground set beside a Karaya horse; the field RideOn handler strips 7 Fubar-rigged clips before seating him on a horse"],
      ["Chris", "syu2", "yes (070–075)", "yes · 321/322 family", "carries her own horse in her record; confirmed in-game riding Bright, a pair-table flyer"],
      ["Geddoe", "syu3", "yes (970–975)", "no", "rides on the map, never in battle"],
      ["Thomas", "thms", "yes (970–975)", "no", "rides on the map, never in battle"],
      ["Roland", "loll", "yes (071–075)", "yes · 321/322 family", "carries 341 for the mounted attack where every other rider carries 340"],
      ["Leo", "leoo", "yes (071–075)", "yes · 321/322 family", ""],
      ["Percival", "psvl", "yes (071–075)", "yes · 321/322 family", ""],
      ["Borus", "bols", "yes (071–075)", "yes · 321/322 family", ""],
      ["Salome", "sarm", "yes (97x, bundled per area)", "no", "no 3xx bank at all"],
      ["Futch", "futi", "yes (071/073/074)", "yes · 311 family", "also has the 080 flying bank"],
      ["Franz", "mstk", "yes (071/073/074)", "yes · 311 family", "also has the 080 flying bank; 311 family even though Ruby is a horse, so the split is not flyer-vs-horse"],
      ["Sharon", "mria", "no", "partial · 300/301/310/311", ""],
      ["Juan", "jyan", "partial (074 only)", "no", ""],
      ["Zexen knight NPC", "zkk1", "yes (071–075)", "yes · 321/322 family", "ships ride-ready nearly everywhere a mount does"],
      ["Le Buque villagers", "msk1/msk2", "yes (070/071/073/074)", "no", ""],
    ],
    mounts: [
      ["Fubar", "guli", "8", "flyer", "full battle set — b_neutral, b_att, b_magic, b_hinsi; ridden by Hugo (stock)"],
      ["Bright", "brit", "32", "flyer", "full battle set; ridden by Futch (stock) and, re-paired, by Hugo and by Chris — both confirmed in-game"],
      ["Ruby", "mskr", "42", "horse", "full battle set; Franz's horse, a Star of Destiny"],
      ["Chris's horse", "s2um", "309", "ground", "battle clips: b_N_damage + b_down_start only (passive)"],
      ["Zexen-knight horse", "zkum", "308", "ground", "same two passive battle clips"],
      ["Karaya horse", "krum / kru2", "325 / 353", "ground", "field only — no battle clips at all"],
      ["Le Buque horses", "msx1 / msx2 / mskn", "359 / 360 / 209", "ground", "msx1 and mskn have battle clips"],
      ["Scenery horse", "uma1", "388", "—", "not rideable — no ride variants, no saddle offset"],
    ],
    areas: [
      ["HGB1 · Yaza Plain (Budehuc gate)", "Karaya horse", "Hugo, Zexen knight NPC"],
      ["HNKT · Budehuc Castle", "Karaya + Zexen horse, Ruby, Le Buque horse, Fubar, Bright", "Hugo, Chris, Borus, Leo, Roland, Percival, knight NPC (full); Futch, Franz, Juan (partial)"],
      ["KRVI · Karaya Village", "Karaya horse ×2, Zexen horse, Fubar", "Hugo, Roland, knight NPC"],
      ["ZKTR · Brass Castle", "Zexen horse, Fubar", "Chris, Borus, Leo, Roland, Percival, knight NPC"],
      ["MSVI · Le Buque", "Ruby, Le Buque horse", "Franz, two villagers"],
      ["TSVI · Chisha Village", "Ruby, Le Buque horse, Fubar", "Percival, knight NPC, Franz, Hugo (partial)"],
      ["CRRA · Caleria / YMMT · Mountain Path", "Bright", "Futch (+ Franz at YMMT)"],
      ["VDZK, LZVI, LAST", "Fubar", "Zexen knights / Chris"],
    ],
    notEditable: [
      ["Field ground ride is script-driven", "The EDS opcodes RideOn (22) / RideOff (24) live in each area archive, not the ELF. No patch can make mounting happen on a map whose script never asks for it.", "0x19828F8"],
      ["Saddle offsets are horses-only", "Three presets pick where a rider sits: Karaya 0.30 forward, Zexen/Chris 0.40, Le Buque 0.00 — all 0.70 up. Fubar and Bright have no entry because they are never ground mounts; the field flying path positions the rider from the scripted flight instead.", "0x16e85e8"],
      ["Damage is per-half", "Every HP change goes through one function taking a single character pointer, with no rider/mount indirection. A hit reduces exactly one half's bar.", "0x16c8670"],
      ["An unnamed pair-sum exists", "Three fields of the battle action block (+0xa2 halved, +0xa4, +0xa6) are added from mount to rider. Shape suggests a movement or reach budget — a guess, not established, so it is deliberately not offered as an editable field.", "0x1819a70"],
      ["A pair-OR predicate exists", "Property 0x9e is true for the pair if either half has it. The property itself was not identified.", "0x181b4f0"],
      ["The debug menu is orphaned", "Its Toggle Mount handler survives and mounts the selected character on whatever the scene already assigned, but the menu has no caller, its vtable is referenced by nothing, and the selection field it reads is written by no one. Re-enabling it means injecting code, not flipping a flag.", "0x178ccc8"],
      ["The scene's assigned mount is a pointer", "+0x1bc on the per-character scene record is the mount the field path rides, and it holds a live EOBJ address, not an id — it feeds straight into RideLink, and the party-warp reader's zero-fallback substitutes a global address. Across 186 call sites of the record accessor it is read once and written never. So no constant can be written into it or substituted at the read site: the value must be an object the scene actually allocated, and a fabricated pointer is dereferenced on the next instruction. This is why an assigned horse cannot be forced into a battle that doesn't stage one, and why Ruby in the pair table can be — battle Mount() links two battle slots the engine already owns.", "0x17b5a40 +0x1bc"],
      ["Field mounting is one opcode away from unreachable", "RideOn has exactly two callers in the ELF: the dead debug handler, and the EDS RideOn opcode. Scripts live in the area archives, not here, so no ELF patch can make a map mount anyone it doesn't already mount.", "0x179ec68"],
    ],
  };
  function drawMountRef(host) {
    const q2 = SEARCH, hit = (...xs) => !q2 || xs.join(" ").toLowerCase().includes(q2);
    const tbl = (head, rows) => `<table class="invtbl"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
      rows.join("") || `<tr><td colspan="${head.length}" class="muted">no matches</td></tr>`}</tbody></table>`;
    host.innerHTML = refTabs() +
      `<div class="muted" style="margin:0 0 10px">Decoded off this disc. Capability is read from <b>clip
        containment</b> — a clip belongs to the record whose payload holds it. Bundling is <b>asset
        residency</b>, not proof a scene mounts anyone. Only the battle pair table has been confirmed in an
        emulator (the three stock pairs plus Hugo+Bright and Chris+Bright); everything else on this page is
        static analysis.</div>
      <div class="muted" style="margin:0 0 10px">The <b>311 / 321-322 family</b> in the rider table is which
        mount system authored that rider's mounted-battle clips: <b>311</b> = the three-pair table (Hugo,
        Futch, Franz, Sharon), <b>321/322</b> = the assigned horse (Chris and the Zexen knights). No model
        carries both. It is a structural split, not flyer-vs-horse — Franz is 311 and Ruby is a horse — and
        it did not stop Chris (321/322) riding Bright. What the clips animate is unread.</div>
      <div class="bag-h">Riders — who is rigged to be mounted</div>
      ${tbl(["Character", "Model", "Field ride", "Mounted battle", "Notes"],
        MOUNTREF.riders.filter((r) => hit(...r)).map((r) =>
          `<tr><td>${esc2(r[0])}</td><td class="sl">${esc2(r[1])}</td><td>${esc2(r[2])}</td><td>${esc2(r[3])}</td><td class="muted">${esc2(r[4])}</td></tr>`))}
      <div class="bag-h" style="margin-top:14px">Mounts — what can be ridden</div>
      ${tbl(["Mount", "Model", "Id", "Kind", "Battle animation"],
        MOUNTREF.mounts.filter((r) => hit(...r)).map((r) =>
          `<tr><td>${esc2(r[0])}</td><td class="sl">${esc2(r[1])}</td><td class="sl">${esc2(r[2])}</td><td>${esc2(r[3])}</td><td class="muted">${esc2(r[4])}</td></tr>`))}
      <div class="bag-h" style="margin-top:14px">Areas that bundle a mount</div>
      ${tbl(["Area", "Mounts bundled", "Units with ride clips"],
        MOUNTREF.areas.filter((r) => hit(...r)).map((r) =>
          `<tr><td>${esc2(r[0])}</td><td>${esc2(r[1])}</td><td class="muted">${esc2(r[2])}</td></tr>`))}
      <div class="bag-h" style="margin-top:14px">Mechanics that can't be exposed as fields</div>
      ${tbl(["Finding", "Why it isn't editable", "Address"],
        MOUNTREF.notEditable.filter((r) => hit(...r)).map((r) =>
          `<tr><td>${esc2(r[0])}</td><td class="muted">${esc2(r[1])}</td><td class="sl">${esc2(r[2])}</td></tr>`))}`;
    wireRefTabs(host);
  }

  function drawItemsRef(host) {
    const q2 = SEARCH;
    const rows = Object.keys(REF.items).map(Number).sort((a, b) => a - b)
      .map((id) => ({ id, nm: itemName(id), sub: REF.cats[id] || "", desc: itemDesc(id) }))
      .filter((o) => !q2 || o.nm.toLowerCase().includes(q2) || hex(o.id, 3).toLowerCase().includes(q2))
      .map((o) => `<tr><td class="sl">${hex(o.id, 3)}</td><td>${esc2(o.nm)}${
        o.desc ? `<div class="muted">${esc2(o.desc)}</div>` : ""}</td><td class="ty">${esc2(o.sub)}</td></tr>`);
    host.innerHTML = refTabs() +
      `<table class="invtbl"><thead><tr><th>ID</th><th>Name</th><th>Category</th></tr></thead><tbody>${
        rows.join("") || `<tr><td colspan="3" class="muted">no matches</td></tr>`}</tbody></table>`;
    wireRefTabs(host);
  }

  // ---- misc ------------------------------------------------------------------
  function fmtSize(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB"; }
  function fmtDuration(ms) { const s = ms / 1000; if (s < 60) return s.toFixed(1) + "s"; const m = Math.floor(s / 60); return `${m}m ${Math.round(s % 60)}s`; }
  function setStatus(msg, kind) { const el = q("#isoStatus"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } else { const b = q("#isoBootStatus"); if (b) b.textContent = msg; } }

  // ---- loader shell (adapts to how this browser can save) --------------------
  function renderLoader() {
    // Copy + picker depend on the save capability. FS Access → in-place; else streamed copy;
    // else read-only (recipe export). Opening the ISO works everywhere via a ranged read.
    const howSaves = SUPPORTS_FS
      ? `Edits are written back <b>in place</b>. Nothing is uploaded. <b>Back up your ISO first</b> — or use <i>Export recipe</i> for a reversible record.`
      : CAN_STREAM_SAVE
        ? `This browser can't overwrite the file in place, so saving <b>streams a patched copy to your downloads</b> (a full ~4 GB file) — nothing is uploaded. You then swap it in for your ISO. <i>Export recipe</i> is a lighter alternative.`
        : `This browser can only <b>read</b> the disc. Browse and stage edits, then <b>Export a recipe</b> and apply it on a desktop Chromium browser (or the desktop app).`;
    const picker = SUPPORTS_FS
      ? `<label class="file"><button type="button" id="isoPick">Choose ISO…</button></label>`
      : `<label class="file"><button type="button" id="isoPickInputBtn">Choose ISO…</button>
          <input type="file" id="isoFileInput"></label>`;
    q("#isoRoot").innerHTML = `
      <div class="card">
        <h2>Load ISO</h2>
        <p class="sub" style="margin-top:0">Pick your <b>Suikoden III (USA)</b> disc image (SLUS-20387).
          Only a ~3.7 MB slice is read to edit. ${howSaves}</p>
        <div class="drop">
          <div><b>Open a Suikoden III ISO</b></div>
          ${picker}
          <div class="muted" style="margin-top:10px" id="isoBootStatus">.iso / .bin / .img · USA release only</div>
        </div>
        <div id="isoRecent"></div>
      </div>`;
    if (SUPPORTS_FS) {
      q("#isoPick").onclick = () => loadRef().then(openIso).catch((e) => setStatus("Failed to load reference tables: " + e.message, "err"));
      loadRef().then(showLastIso).catch(() => {});   // one-tap reopen (persisted handle; FS only)
    } else {
      const inp = q("#isoFileInput");
      q("#isoPickInputBtn").onclick = () => loadRef().then(() => inp.click()).catch((e) => setStatus("Failed to load reference tables: " + e.message, "err"));
      // loadRef() again, not just on the button: the Characters view reads REF.names as soon as
      // the editor renders, and on a phone the reference JSON can still be in flight when the
      // file arrives (or arrive without the button at all). loadRef() caches, so this is free.
      inp.onchange = () => { if (inp.files[0]) loadRef().then(() => loadFromInputFile(inp.files[0]))
        .catch((e) => setStatus("Failed to load reference tables: " + e.message, "err")); };
    }
  }

  // ---- mode tabs + init ------------------------------------------------------
  function switchMode(mode) {
    qa(".mtab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const save = q("#mode-save"), iso = q("#mode-iso");
    if (save) save.classList.toggle("hidden", mode !== "save");
    if (iso) iso.classList.toggle("hidden", mode !== "iso");
    if (mode === "iso" && !q("#isoRoot").dataset.init) {
      renderLoader();
      q("#isoRoot").dataset.init = "1";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    qa(".mtab").forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
    // warn before leaving with unsaved ISO edits (save editor has its own guard)
    window.addEventListener("beforeunload", (e) => { if (anyChanges()) { e.preventDefault(); e.returnValue = ""; } });
    // Undo/redo keyboard shortcuts (ISO editor only; ignore while typing in a field).
    document.addEventListener("keydown", (e) => {
      if (!BUF || q("#mode-iso") && q("#mode-iso").classList.contains("hidden")) return;
      const t = e.target, typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (typing || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
    });
  });
})();
