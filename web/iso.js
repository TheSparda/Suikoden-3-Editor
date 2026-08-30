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
  // Three movement modes reach that multiply. Walk and run each load their own MULT
  // immediate; the third ("ride") skips the block with `move $s5,$s1` = an implicit
  // x1.00. To scale all three from one percentage we give ride its own multiplier and
  // branch it into the shared MULT/100 block — behaviour-preserving, since at 100% it
  // computes s1*100/100 == s1. 100% restores the stock words byte-for-byte.
  const ENC = {
    sites: [0x149C3C, 0x149C40, 0x149C5C, 0x149C60],  // ride mult, ride branch, run mult, walk mult
    stock: [0x0220A82D, 0x10000012, 0x24020096, 0x24020078],
    brJoin: 0x10000008,          // b 0x1702464 — ride path joins the scale block
    addiuV0: 0x24020000,         // addiu $v0,$zero,imm
    max: 1000,
  };
  const encWords = (pct) => {
    const p = Math.round(pct);
    if (!(p >= 0 && p <= ENC.max)) return null;
    if (p === 100) return ENC.stock.slice();
    const sc = (b) => Math.floor((b * p + 50) / 100);
    return [(ENC.addiuV0 | sc(100)) >>> 0, ENC.brJoin,
            (ENC.addiuV0 | sc(150)) >>> 0, (ENC.addiuV0 | sc(120)) >>> 0];
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
  // AUX now holds two kinds of windows, told apart by `tag`:
  //   "potch" — the two fixed 16-byte overlay windows (Sets view)
  //   "enemy" — coalesced spans covering enemy stat records + reward blocks,
  //             built from Editor/s3_enemy_packs.json at load (Enemies view)
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

  const ELEMENTS = { 0: "None", 1: "Fire", 2: "Water", 3: "Wind", 4: "Earth", 5: "Lightning", 6: "Pale (Dark)" };
  const AREA_BIT = 0x8000;                  // flags14 bit15 = area-of-effect
  const F18_BITS = { 1: "poison", 3: "instant-death", 4: "unbalance", 9: "teleport/chant",
    10: "sleep", 13: "silence/berserk", 14: "mgc-boost", 15: "mgc-shield", 19: "mgc-immune-once",
    21: "buff-pdf/mdf", 22: "sword-fire", 23: "sword-lightning", 24: "sword-wind",
    25: "resist-fire", 26: "resist-lightning", 27: "resist-wind" };
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
  const TARGET_OPTS = [[0x0A, "Single target"], [0x02, "All foes"], [0x03, "All foes + allies"],
    [0x01, "All allies"], [0x41, "Single ally (pair)"], [0x06, "Foes around caster"]];

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
    writeBytes(off, padded); FIELD_REG[off] = { group, label, off, width: maxlen, kind: "text" };
    return { ok: true };
  }
  // Set a description to explicit text (gear custom desc). Rejects text longer than the slot.
  function setDescText(dptr, text, group, label) {
    const off = vaOff(dptr), maxlen = origSlotLen(dptr);
    if (maxlen <= 0 || !inBlk(off, maxlen)) return { skip: true, max: 0 };
    const enc = latin1Enc(text);
    if (enc.length > maxlen) return { tooLong: true, max: maxlen };
    const padded = new Uint8Array(maxlen); padded.set(enc);
    writeBytes(off, padded); FIELD_REG[off] = { group, label, off, width: maxlen, kind: "text" };
    return { ok: true, max: maxlen };
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
            runeFood, runeOwner, shops };
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
    let who = { 0xA: "single", 0x2: "all-foes", 0x3: "foes+allies", 0x1: "self/ally",
      0x6: "foes-around-caster" }[low] || "who" + low;
    if (tb & 0x40) who += "(1 pair)";       // pair-select bit: target one ally pair, not the side
    const shape = area ? "AREA" : (tb & 0x10) ? "LINE" : low === 0xA ? "single" : "spread";
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

  // Read + validate + commit an ISO from a File. Nothing large is held — only the ~3.75 MB
  // editable region is read (via a ranged Blob.slice); the source File is kept for streaming.
  async function commitIso(file, handle) {
    setStatus("Reading disc region… (a moment on a large disc)", "");
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
    // aux windows (potch-multiplier overlay pair) — optional: an unreadable window just
    // makes that one control read-only in the Sets view, never blocks the load.
    let aux = [];
    try {
      for (const off of AUX_WINDOWS) {
        const a = new Uint8Array(await file.slice(off, off + AUX_LEN).arrayBuffer());
        if (a.length === AUX_LEN) aux.push({ off, len: AUX_LEN, tag: "potch", buf: a, orig: a.slice() });
      }
      if (aux.length !== AUX_WINDOWS.length) aux = [];
    } catch (e) { aux = []; }
    // enemy windows: coalesced spans over every stat record + reward block listed in
    // s3_enemy_packs.json (all pack copies). Optional the same way — a pack whose
    // offsets can't be read (short disc / test fixture) is skipped, and the Enemies
    // view reports it as unavailable instead of showing wrong data.
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
      setStatus("Reading enemy data…", "");
      const rl = epsrc.recLayout, al = epsrc.auxLayout;
      const zl = epsrc.zoneLayout || { slotSize: 0x14, partySize: 0x1C };
      const spans = [];
      for (const p of epsrc.packs) {
        const offs = [];
        for (const e of p.enemies) for (const v of e.variants) {
          for (const o of v.rec) offs.push([o, rl.size]);
          for (const o of v.aux) offs.push([o, al.size]);
        }
        for (const z of (p.zones || [])) {
          for (const s of z.slots) for (const o of s.off) offs.push([o, zl.slotSize]);
          for (const pa of z.parties) {
            for (const o of pa.off) offs.push([o, zl.partySize]);
            for (const o of pa.memOff) offs.push([o, Math.max(pa.members.length, 1)]);
          }
        }
        if (offs.some(([o, n]) => o + n > file.size)) { if (p.war) wskipped++; else eskipped++; continue; }
        epacks.push(p); spans.push(...offs);
      }
      spans.sort((a, b) => a[0] - b[0]);
      const ranges = [];
      for (const [o, n] of spans) {
        if (ranges.length && o - ranges[ranges.length - 1][1] <= 0x2000) {
          ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], o + n);
        } else ranges.push([o, o + n]);
      }
      try {
        for (const [s, e] of ranges) {
          const a = new Uint8Array(await file.slice(s, e).arrayBuffer());
          if (a.length !== e - s) throw new Error("short read");
          aux.push({ off: s, len: e - s, tag: "enemy", buf: a, orig: a.slice() });
        }
      } catch (err) {
        // drop every enemy window on any failure — a half-loaded set would lie
        aux = aux.filter((w) => w.tag !== "enemy");
        epacks = [];
        eskipped = epsrc.packs.filter((p) => !p.war).length;
        wskipped = epsrc.packs.filter((p) => p.war).length;
      }
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
        for (const t of a.tables) for (const r of t.rooms) offs.push(r.graceOff);
        if (offs.some((o) => o + 4 > file.size)) { rskipped++; continue; }
        rareas.push(a); rspans.push(...offs);
      }
      rspans.sort((x, y) => x - y);
      const rranges = [];
      for (const o of rspans) {
        if (rranges.length && o - rranges[rranges.length - 1][1] <= 0x2000) {
          rranges[rranges.length - 1][1] = Math.max(rranges[rranges.length - 1][1], o + 4);
        } else rranges.push([o, o + 4]);
      }
      try {
        for (const [s0, e0] of rranges) {
          // An enemy window already covering this range can serve the reads/writes
          // (auxWin searches every window); adding a second overlapping one would split
          // the dirty tracking, so skip it.
          if (aux.some((w) => s0 >= w.off && e0 <= w.off + w.len)) continue;
          const a2 = new Uint8Array(await file.slice(s0, e0).arrayBuffer());
          if (a2.length !== e0 - s0) throw new Error("short read");
          aux.push({ off: s0, len: e0 - s0, tag: "room", buf: a2, orig: a2.slice() });
        }
      } catch (err) {
        aux = aux.filter((w) => w.tag !== "room");     // half-loaded would lie
        rareas = []; rskipped = rsrc.areas.length;
      }
    }
    // commit
    BUF = buf; DV = dv; ORIG = buf.slice(); ODV = new DataView(ORIG.buffer);
    AUX = aux;
    EPACKS = epacks; EPACKS_META = epsrc || null; EPACKS_SKIPPED = eskipped; WPACKS_SKIPPED = wskipped;
    ROOMS = rareas; ROOMS_SKIPPED = rskipped;
    Object.keys(EREG).forEach((k) => delete EREG[k]);
    isoHandle = handle; isoFile = file; isoName = file.name || "game.iso";
    gearCache = null; gearAlias = {}; dropDescCaches(); TEXTS = null; resetUndo(); Object.keys(FIELD_REG).forEach((k) => delete FIELD_REG[k]);
    recipeExported = false; saveNudged = false; RENAMES = {};
    VIEW = "chars"; SEARCH = "";
    if (handle) rememberIso(isoName, handle);   // persist the handle for one-tap reopen (FS only)
    renderEditor(file.size);
    q("#isoRoot").scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Loaded ${isoName} — USA verified.`, "ok");
  }
  // How this browser can write edits back: overwrite in place, stream a patched copy, or neither.
  function saveMode() {
    if (SUPPORTS_FS && isoHandle) return "inplace";
    if (CAN_STREAM_SAVE && isoFile) return "stream";
    return "none";
  }

  // ---- remember last opened ISO (persist the file HANDLE; the 4 GB bytes are never stored) --
  function rememberIso(name, handle) { idbSet("lastIso", { name, handle, at: Date.now() }).catch(() => {}); }
  async function showLastIso() {
    const el = q("#isoRecent"); if (!el) return;
    let rec; try { rec = await idbGet("lastIso"); } catch (e) { return; }
    if (!rec || !rec.handle) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="recent">Last opened:
        <button class="chip" id="isoReopen">↻ ${esc2(rec.name)}</button>
        <button class="chip mini" id="isoForget" title="forget" aria-label="forget last ISO">✕</button></div>`;
    q("#isoReopen", el).onclick = () => reopenLastIso(rec);
    q("#isoForget", el).onclick = async () => { await idbDel("lastIso").catch(() => {}); el.innerHTML = ""; };
  }
  async function reopenLastIso(rec) {
    try {
      if (!(await ensureWritable(rec.handle))) return setStatus("Reopen cancelled — write permission denied.", "warn");
      await loadFromHandle(rec.handle);
    } catch (e) { setStatus("Could not reopen — the file may have moved. Pick it again.", "err"); }
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
      const reader = isoFile.stream().getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          let r;
          try { r = await reader.read(); }
          catch (e) { controller.error(e); failed(e); return; }
          if (r.done) { const tail = replacer.flush(); if (tail.length) controller.enqueue(tail); controller.close(); finished(); return; }
          let chunk = r.value;                                  // bytes at [pos, pos+len)
          const start = pos, end = pos + chunk.length;
          if (end > ELF_BASE && start < ELF_END) {              // overlaps the editable region
            chunk = chunk.slice();                              // writable copy
            const a = Math.max(start, ELF_BASE), b = Math.min(end, ELF_END);
            for (let i = a; i < b; i++) chunk[i - start] = region[i - ELF_BASE];
          }
          for (const r of auxSnap) {                            // aux windows (potch overlay)
            const re = r.off + r.bytes.length;
            if (re > start && r.off < end) {
              chunk = chunk.slice();
              const a = Math.max(start, r.off), b = Math.min(end, re);
              for (let i = a; i < b; i++) chunk[i - start] = r.bytes[i - r.off];
            }
          }
          controller.enqueue(replacer.push(chunk));             // disc-wide same-length rename
          pos = end;
          pg.phase("Writing", `Streaming patched ISO to your downloads… ${fmtSize(pos)} / ${fmtSize(total)}`,
            { pct: total ? (pos / total) * 100 : 0 });
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} failed(new Error("download cancelled")); },
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
    ["shops", "Shops"], ["spells", "Spells"], ["unites", "Unites"], ["gear", "Gear"], ["sets", "Sets"], ["food", "Food"],
    ["balance", "Balance"], ["encounter", "Encounter"], ["enemies", "Enemies"], ["war", "War"],
    ["text", "Text"], ["ref", "Reference"]];

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
    q("#isoClose").onclick = () => { if (anyChanges() && !confirm("Discard staged edits and close this ISO?")) return; BUF = DV = ORIG = ODV = isoHandle = isoFile = null; AUX = []; EPACKS = []; EPACKS_META = null; EPACKS_SKIPPED = 0; ROOMS = []; ROOMS_SKIPPED = 0; renderLoader(); };
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
      gear: "Equipment records: name, DEF, price, custom description, and all 5 effect slots (type / amount / stat or skill). Names and descriptions are rewritten in place, so each is capped to the character slot the disc already reserves for it — the new name then shows everywhere the game names that item.",
      sets: "Armor sets: which items complete each of the 5 sets, plus the set-bonus constants patched out of the game code (potch multiplier, Destiny counter chance, Pale Moon heal share).",
      food: "Consumable / food table: heal amount and proc chance %.",
      text: "In-ELF UI text: battle messages, menu labels, prize/error prompts and character blurbs. Each string is capped to its original byte length (growing one would need repointing). Story dialogue lives in packed event files off the ELF and is not editable.",
      balance: "Bulk difficulty levers: scale every character's stat-growth rate (and optionally spell/unite power) by a multiplier. Scaled from the ISO's original values, so presets don't compound.",
      encounter: "How often random battles trigger, as one global percentage of the game's stock rate. 100 = unchanged, 50 = half as often, 200 = twice, 0 = none. Per-area base rates live in the packed map archives and aren't editable.",
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
    else if (VIEW === "gear") drawGear(host);
    else if (VIEW === "sets") drawSets(host);
    else if (VIEW === "food") drawFood(host);
    else if (VIEW === "text") drawText(host);
    else if (VIEW === "balance") drawBalance(host);
    else if (VIEW === "encounter") drawEncounter(host);
    else if (VIEW === "enemies") drawEnemies(host);
    else if (VIEW === "war") drawWar(host);
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
  function dropDescCaches() { SPELL_DESC_BY_NAME = null; FOOD_DESC_BY_NAME = null; }
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
    if (f.status != null) { const rev = {}; for (const b in F18_BITS) rev[F18_BITS[b]] = 1 << b; writeW(off + 0x18, 4, f.status === "none" ? 0 : (rev[f.status] || 0)); reg(off + 0x18, 4, "status", name, "Status"); }
    if (f.radius != null && idx + 1 < SPELL.count) {
      const ro = off + SPELL.radius; writeW(ro, 1, clampInt(f.radius, 0, 255)); reg(ro, 1, "num", name, "Radius");
    }
    if (f.chance != null && idx + 1 < SPELL.count) {
      const co = off + SPELL.chance; writeW(co, 2, clampInt(f.chance, 0, 100)); reg(co, 2, "num", name, "Status chance %");
    }
    return descRes;
  }
  const targetOptsHTML = (cur) => {
    let html = TARGET_OPTS.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
    if (!TARGET_OPTS.some(([v]) => v === cur)) html += `<option value="${cur}" selected>custom 0x${hex(cur, 2)}</option>`;
    return html;
  };
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
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="spUpd"${upd ? " checked" : ""}> also rewrite the damage number in each spell's description when Power changes</label>`;

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
      const statCur = f18 === 0 ? "none" : (Object.entries(F18_BITS).find(([b]) => f18 === (1 << b)) || [])[1] || "custom";
      const elemSel = Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}"${+v === elVal ? " selected" : ""}>${l}</option>`).join("");
      const statOpts = ["none", ...Object.values(F18_BITS)].map((s) => `<option value="${s}"${s === statCur ? " selected" : ""}>${s}</option>`).join("");
      // editable, length-capped description (cap = original slot length; can't grow past it)
      const dptr = r32(off + 0x0C), dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descField = dmax > 0
        ? `<label class="field" style="margin:0 0 10px"><span>Description <span class="muted">(max ${dmax} chars)</span></span>
             <input type="text" class="spdesc" data-i="${i}" maxlength="${dmax}" value="${esc2(dcur)}"></label>`
        : `<div class="muted" style="margin:0 0 8px">${esc2(dcur)}</div>`;
      return `<details class="char" data-i="${i}"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="lv sp-sum">${ELEMENTS[elVal]} · pw ${r32(off + 0x1C)} · ${decodeTarget(f14)}${radVal ? " r" + radVal : ""}${f18 ? " · " + decodeF18(f18) : ""}</span></summary>
        <div class="char-body">
          ${descField}
          <div class="grid">
            <label class="field"><span>Power</span><input type="number" class="sp" data-i="${i}" data-k="power" min="0" value="${r32(off + 0x1C)}"></label>
            <label class="field"><span>Cast (MOV)</span><input type="number" class="sp" data-i="${i}" data-k="cast" min="0" value="${r32(off + 0x10)}"></label>
            <label class="field"><span>Element</span><select class="sp" data-i="${i}" data-k="elementId" ${canTail ? "" : "disabled"}>${elemSel}</select></label>
            <label class="field"><span>Target</span><select class="sp" data-i="${i}" data-k="target">${targetOptsHTML(tb)}</select></label>
            <label class="field"><span>Area of effect</span><select class="sp" data-i="${i}" data-k="aoe"><option value="1"${(f14 & AREA_BIT) ? " selected" : ""}>on</option><option value="0"${!(f14 & AREA_BIT) ? " selected" : ""}>off</option></select></label>
            <label class="field"><span>Status</span><select class="sp" data-i="${i}" data-k="status">${statOpts}</select></label>
            <label class="field"><span>Radius <span class="muted">(0 = no area)</span></span><input type="number" class="sp" data-i="${i}" data-k="radius" min="0" max="255" value="${radVal}" ${canTail ? "" : "disabled"}></label>
            <label class="field"><span>Status chance %</span><input type="number" class="sp" data-i="${i}" data-k="chance" min="0" max="100" value="${chVal}" ${canTail ? "" : "disabled"}></label>
          </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`;
    host.innerHTML = splitCard() + reskin + updBox + body;

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
    d.querySelector(".sp-sum").textContent = `${ELEMENTS[elVal]} · pw ${r32(off + 0x1C)} · ${decodeTarget(r32(off + 0x14))}${rad ? " r" + rad : ""}${f18 ? " · " + decodeF18(f18) : ""}`;
    const MAP = { power: [0x1C, 4, "num"], cast: [0x10, 4, "num"], elementId: [SPELL.elem, 2, "elem"], target: [0x14, 4, "flags14"], aoe: [0x14, 4, "flags14"], status: [0x18, 4, "status"],
      radius: [SPELL.radius, 1, "num"], chance: [SPELL.chance, 2, "num"] };
    qa(".sp", d).forEach((el) => {
      const [o, w, kind] = MAP[el.dataset.k];
      if (kind === "flags14") markFlagsField(el, off + o, el.dataset.k === "aoe" ? AREA_BIT : 0x7F00);
      else markField(el, off + o, w, kind);
    });
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
      return `<label class="field tx"><span>0x${hex(t.off, 6)} <span class="muted">(max ${t.max})</span></span>
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
        writeBytes(off, padded);
        reg(off, max, "text", "Text", `0x${hex(off, 6)}`);
        markField(el, off, max, "text");
        setStatus("", "");
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

  function drawEncounter(host) {
    const cur = decodeEnc(ENC.sites.map((o) => readW(o, 4)));
    const orig = decodeEnc(ENC.sites.map((o) => origW(o, 4)));
    const unknown = cur === null;
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
    const apply = (v) => {
      v = Math.max(0, Math.min(ENC.max, Math.round(+v || 0)));
      const w = encWords(v); if (!w) return;
      ENC.sites.forEach((o, i) => {
        writeW(o, 4, w[i]);
        reg(o, 4, "num", "Encounters", ["ride multiplier", "ride branch", "running multiplier", "walking multiplier"][i]);
      });
      sync(v); updateDirtyBadge();
    };
    sync(unknown ? 100 : cur);
    rngEl.oninput = () => { pctEl.value = rngEl.value; outEl.textContent = note(+rngEl.value); };
    rngEl.onchange = () => apply(rngEl.value);
    pctEl.onchange = () => apply(pctEl.value);
    qa("[data-enc]", host).forEach((b) => (b.onclick = () => apply(+b.dataset.enc)));
    q("#encReset", host).onclick = () => { ENC.sites.forEach((o) => revertRange(o, 4)); sync(orig === null ? 100 : orig); updateDirtyBadge(); };
    drawRoomRates(q("#encRooms", host));
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
    skills: "Reference (read-only): every skill — what each rank is worth, who can learn it and how far, and who has it on this disc.",
    sources: "Reference (read-only): where each item comes from — drops decoded off this disc, plus guide notes.",
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
  function runeInfo(id) {
    const nm = REF.items[id] || "";
    const fb = (REF.runeFood && REF.runeFood[String(id)]) || "";
    const m = /^(.*?)\s*—\s*Grants\s+(.+)$/.exec(fb);
    const key = nm.toLowerCase().replace(/\s+/g, "").replace(/rune$/, "");
    return {
      id, name: nm, group: runeGroupOf(id),
      text: (BUF && runeTblDesc(id)) || (m ? m[1] : fb),
      grants: RUNE_SPELLS[key] || (m ? m[2].split(/\s*,\s*/) : []),
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
        Nothing here is editable — runes are equipped per character on the <b>Characters</b> tab.</div>
      <table class="invtbl"><thead><tr><th style="width:8%">ID</th><th style="width:20%">Rune</th>
        <th style="width:36%">What it does</th><th>Who has it / where to get it</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="sl">${hex(r.id, 3)}</td>
          <td>${esc2(r.name)}<div class="opt-tag">${esc2(runeGroupLabel(r.group))}</div></td>
          <td><div class="muted">${esc2(r.text || "—")}</div>
            ${r.grants.length ? `<div class="grants">${r.grants.map((s) =>
              `<span class="spellchip">${esc2(s)}</span>`).join("")}</div>` : ""}</td>
          <td>${runeWhoHTML(r)}</td></tr>`).join("")
        || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>`;
    qa("[data-rgrp]", host).forEach((b) => (b.onclick = () => { RUNE_GROUP = b.dataset.rgrp; drawRunes(host); }));
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
    ["skills", "Skills", () => Object.keys(REF.skills).length, drawSkillsRef],
    ["sources", "Item sources", () => Object.keys((REF.itemSources && REF.itemSources.items) || {}).length, drawSources],
    ["files", "Files", () => { const sf = subfileIndex(); return (sf ? sf.archives.reduce((a, x) => a + x.files.length, 0) : 0).toLocaleString(); }, drawFiles],
    ["places", "Pickups", () => ((REF.itemSources && REF.itemSources.places) || []).length, drawPickups],
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
  function drawReference(host) { (REF_MODES.find(([k]) => k === REF_KIND) || REF_MODES[0])[3](host); }

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
      inp.onchange = () => { if (inp.files[0]) loadFromInputFile(inp.files[0]); };
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
