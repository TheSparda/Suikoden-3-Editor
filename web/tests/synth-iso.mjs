// Build a synthetic, in-bounds Suikoden III (USA) "ISO" for headless tests.
// It contains only the ~3.75 MB editable region the web ISO editor reads, with the USA
// version word and a handful of planted spell/unite/food/gear records + real item names,
// so the editor's load → render → edit → save path can be exercised without a real 4 GB disc.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

export const ELF_BASE = 0xA4800, ELF_END = 0x465DF0, ELF_VADDR = 0x165D000;
// radius/chance are tail fields: a spell keeps them one record ahead (+stride+x), a unite
// (8 bytes longer) keeps them inside its own record at +0x20+x. See iso.js SPELL/UNITE.
export const SPELL = { off: 0x3EC2A0, stride: 0x20, elem: 0x24, radius: 0x21, chance: 0x26 };
export const UNITE = { off: 0x3ECF90, stride: 0x28, radius: 0x21, chance: 0x24 };
export const FOOD = { off: 0x3E91D0, stride: 0x48, heal: 0x14, proc: 0x1E, name: 0x44, desc: 0x00 };
export const ENEMY = { off: 0x3E74E0, stride: 0x14, count: 100 };
export const GEAR = { P: 0x410000, stride: 0x44, def: 0x10, price: 0x08, effs: [0x14, 0x1C, 0x24, 0x2C, 0x34] };
// Rune item table (iso.js RUNE_TBL): indexed by ITEM id, name ptr @+0 / desc ptr @+4. It is
// the only source of text for the passive support runes, so the fixture plants one of those
// (Balance) alongside the magic runes in the character's slots.
export const RUNE_TBL = { off: 0x3EAF78, stride: 0x20, name: 0x00, desc: 0x04 };
export const TABLES = { list1: [4078716, 140], list2: [4068152, 132], list3: [4089904, 8], list4: [4061704, 28] };
// War-battle class reference (iso.js CLASS_POOL / CLASS_TBL): a pool of 78 string pointers and
// a 43x47 table of (type, modifier) pool indices. Indexed [skillA-1][skillB-1]; column == skill id.
export const CLASS_POOL = { off: 0x3A7C80, count: 78 };
export const CLASS_TBL = { off: 0x3A7DC0, stride: 94, max: 43 };
// Shop counters: three parallel arrays of 14 locations x 4 story stages x 0x7C, with 30
// zero-terminated u16 stock slots at +0 and four 16-byte rarity entries at +0x3C. The fixture
// stocks location 0 (Vinay del Zexay on the real disc) so the Shops view has something to draw.
export const SHOPS = {
  stride: 0x7C, varStride: 0x1F0, stock: 30, rarOff: 0x3C, rarStride: 0x10, rarCount: 4,
  kinds: { item: 0x3EA550, armor: 0x3DDCD0, rune: 0x3EEB48 },
};
export const shopRec = (base, loc, stage) => base + loc * SHOPS.varStride + stage * SHOPS.stride;
export const PRICE_LADDER = [3970620, 4], ITEM1 = [4136564, 4];
export const VERSION_OFF = 4136544, VERSION_VAL = 0x40A69A01;
// Armor sets: composition table + the in-block bonus-constant instruction words
// (the potch pair lives ~1 GB into the disc — outside a synth file, so the Sets
// view must degrade to "unavailable" for it here).
export const SETS = { table: 0x3DDAB8, counterSites: [0x244F8C, 0x2452F8], healBias: 0x245DA8, healShift: 0x245DB4,
  counterOwnerSites: [0x244F78, 0x2452E4], healOwnerSite: 0x245D98, squeakOwnerSite: 0x131354,
  halveMaskSite: 0x246E28, healDivRepair: 0x245E1C };
// stock "which set owns this effect" words (see the offsets doc)
export const STOCK_OWNER_COUNTER = 0x24020003;   // addiu $v0,$zero,3   (Destiny)
export const STOCK_OWNER_HEAL = 0x24140005;      // addiu $s4,$zero,5   (Pale Moon)
export const STOCK_OWNER_SQUEAK = 0x24110001;    // addiu $s1,$zero,1   (Mole)
export const STOCK_HALVE_MASK = 0x30420004;      // andi  $v0,$v0,4     (Guardian + Pale Moon)
export const STOCK_HEAL_DIV_SLOT = 0x24040064;   // addiu $a0,$zero,0x64 (dead store / repair slot)
export const SET_ROWS = [           // real composition (Head, Body, Shield, Accessory; 0 = unused)
  [0x0AD, 0x0C2, 0x109, 0x123],     // Mole
  [0x0BD, 0x103, 0x000, 0x11F],     // Prosperity
  [0x0BE, 0x0F2, 0x000, 0x126],     // Destiny
  [0x0A7, 0x0D7, 0x10C, 0x000],     // Guardian
  [0x0A9, 0x0E7, 0x000, 0x132],     // Pale Moon
];
// Global encounter rate: the 4 instruction words the Balance tab rewrites (stock = 100%).
export const ENC_SITES = [0x149C3C, 0x149C40, 0x149C5C, 0x149C60];
export const ENC_STOCK = [0x0220A82D, 0x10000012, 0x24020096, 0x24020078];
// Damage+heal slot (iso.js SPLIT): the three instruction immediates that hand Shining
// Wind its "damage foes, heal allies" behaviour. Spell ids here are 1-based (row + 1).
export const SPLIT = { route: 0x25A8A4, amtSel: 0xE1C9C, amt: 0xE1C90 };
export const SPLIT_STOCK = [0x24020011, 0x3AC30011, 0x2412012C];   // spell 17, spell 17, 300 HP
// IsValidRidePair's three (rider, mount) comparisons — each an `addiu $v0,$zero,imm`.
// Riders #2 and #3 are duplicated into a branch delay slot, hence two sites each.
export const MOUNT_PAIRS = [
  { riderSites: [0x130384], mountSite: 0x130390, rider: 1, mount: 8 },    // Hugo  + Fubar
  { riderSites: [0x13038C, 0x130398], mountSite: 0x1303A4, rider: 31, mount: 32 },  // Futch + Bright
  { riderSites: [0x1303A0, 0x1303AC], mountSite: 0x1303B4, rider: 41, mount: 42 },  // Franz + Ruby
];
export const mountWord = (imm) => (0x24020000 | (imm & 0xFFFF)) >>> 0;   // addiu $v0,$zero,imm
// FieldAvatarModelRequest's whitelist chain (vaddr 0x17B7560) — the gate that decides whose
// field model the engine will load, i.e. who you can walk around the map as. Five editable
// immediates plus the three bounds the tab reads but does not offer. Stock values are the
// disc's, byte-verified; see docs/FIELD_CHARACTER_RESEARCH.md.
export const AVATAR_SITES = [
  [0x1FED64, 0x36, "eq"],   // Koroku
  [0x1FED70, 0x37, "lt"],   // upper bound of the low branch
  [0x1FED78, 0x3F, "eq"],   // Luc
  [0x1FED80, 0x04, "lt"],   // ids 1-3: Hugo / Chris / Geddoe
  [0x1FED88, 0x1D, "eq"],   // Thomas
  [0x1FEDA0, 0x3F, "lt"], [0x1FEDAC, 0xCC, "lt"], [0x1FEDB4, 0xCA, "lt"],
];
// The story-content switch at vaddr 0x177FEB4: leader id -> team index 0-7. Only the ids
// below get an index of their own; anything else falls to the default, which is index 0
// (Hugo). Retiring a case is what hands that character Hugo's events and dialogue.
// The movement tests that gate a random encounter: IsWalking @0x16F3860 and IsRunning
// @0x16F38A8. Each entry is [offset, immediate, word-shape] where the shape is the upper
// half of the instruction (addiu $v0,$a1,imm / sltiu $v0,$v0,imm / sltiu $v1,$v1,imm).
export const ENCMOVE_SITES = [
  [0x13B068, 0x02,   0x24A2, true],   // walk range 1 base (stored negated)
  [0x13B06C, 0x0C,   0x2C42, false],  // walk range 1 length
  [0x13B074, 0x42,   0x24A2, true],   // walk range 2 base
  [0x13B078, 0x03,   0x2C42, false],  // walk range 2 length
  [0x13B08C, 0x64,   0x24A3, true],   // walk kind-2 base
  [0x13B090, 0x0C,   0x2C63, false],  // walk kind-2 length
  [0x13B0B0, 0x0E,   0x24A2, true],   // run range 1 base
  [0x13B0B4, 0x06,   0x2C42, false],  // run range 1 length
  [0x13B0BC, 0x45,   0x24A2, true],   // run range 2 base  <- repointed at the animal cycle
  [0x13B0C0, 0x02,   0x2C42, false],  // run range 2 length
  [0x13B0D4, 0x70,   0x24A3, true],   // run kind-2 base
  [0x13B0D8, 0x03,   0x2C63, false],  // run kind-2 length
];
export const encMoveWord = (imm, opc, negated) =>
  (((opc << 16) >>> 0) | ((negated ? -imm : imm) & 0xFFFF)) >>> 0;

export const STORY_CASES = [
  [0x1C76DC, 1, 0], [0x1C76CC, 2, 1], [0x1C76F0, 3, 2], [0x1C7740, 0xCB, 3],
  [0x1C7724, 0x3F, 4], [0x1C7738, 0xCA, 4], [0x1C76F8, 0x11, 5],
  [0x1C770C, 0x42, 6], [0x1C771C, 0x36, 7],
];
export const avatarWord = (imm, kind) =>
  ((kind === "eq" ? 0x24020000 : 0x2C820000) | (imm & 0xFFFF)) >>> 0;   // addiu / sltiu
// The per-character assigned horse: u16 at list2 record +0x66. Stock has Chris on her own
// horse (309) and the other five Zexen Knights on the knight horse (308).
// Movement speed (iso.js MOVESPD): 14 records of {u32 modelId, f32 walk, f32 run, f32 rate}
// keyed by the movement-class byte in each list2 record at +0x78. Real disc values.
export const MOVESPD = { tbl: 0x3B0BE0, rows: 14, stride: 16, walk: 0x04, run: 0x08, rate: 0x0C, classOff: 0x78 };
export const MOVESPD_RUN = [6, 5, 4.5, 6, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6];
export const MOVESPD_WALK = 2, MOVESPD_RATE = 1;
// The class byte per list2 record, as the disc ships it (record -> class).
export const MOVESPD_CLASS = {
  0: 3, 1: 3, 2: 2, 3: 1, 4: 2, 5: 1, 6: 4, 7: 2, 8: 0, 9: 8, 10: 3, 11: 4, 12: 1, 13: 2, 14: 1,
  15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 2, 22: 1, 23: 1, 24: 1, 25: 6, 26: 2, 27: 1, 28: 1,
  29: 4, 30: 1, 31: 0, 32: 7, 33: 7, 34: 7, 35: 1, 36: 1, 37: 0, 38: 2, 39: 1, 40: 1, 41: 3, 42: 4,
  43: 8, 44: 8, 45: 1, 46: 4, 47: 4, 48: 0, 49: 1, 50: 1, 51: 1, 52: 1, 53: 2, 54: 2, 55: 1, 56: 0,
  57: 1, 58: 1, 59: 2, 60: 2, 61: 1, 62: 4, 63: 1, 64: 1, 65: 1, 66: 5, 67: 1, 68: 2, 69: 4, 70: 4,
  71: 3, 72: 1, 73: 2, 74: 3, 75: 4, 76: 0, 77: 0, 78: 0, 79: 0,
};
export const spdAddr = (cls, col) => MOVESPD.tbl + cls * MOVESPD.stride + col;
export const spdClassAddr = (rec) => TABLES.list2[0] + rec * TABLES.list2[1] + MOVESPD.classOff;
export const HORSE_OFF = 0x66;
export const HORSE_STOCK = { 2: 309, 12: 308, 17: 308, 19: 308, 20: 308, 39: 308 };
export const horseAddr = (roster) => TABLES.list2[0] + roster * TABLES.list2[1] + HORSE_OFF;
// Mounted-pair mechanics: whole instructions the Mounts tab rewrites. HP pooling gate,
// the two rounding sweeteners, and the Adrenaline Power pair-sum.
export const MECH = {
  pool:       { off: 0x226F64, stock: 0x10400030, alt: 0x10000030 },
  roundRider: { off: 0x226FF4, stock: 0x24c60001 },
  roundMount: { off: 0x226FF8, stock: 0x26100001 },
  adren:      { off: 0x262CD0, stock: 0x02228821, alt: 0x00000000 },
};
// Status effect strength (iso.js STATUSFX): eleven `addiu $rt,$zero,imm` battle-code sites whose
// immediates are the percentages a status effect is worth. The fixture plants the stock words so
// the controls decode, and the e2e checks a write lands in the low half only.
export const STATUSFX_SITES = [
  { key: "swFire", off: 0x107470, word: 0x24100014, pct: 20 },
  { key: "swLightning", off: 0x107480, word: 0x24030014, pct: 20 },
  { key: "swWind", off: 0x107478, word: 0x2410000F, pct: 15 },
  { key: "swAny", off: 0x102488, word: 0x2402001E, pct: 30 },
  { key: "resWeak", off: 0xE3868, word: 0x24040078, pct: 120 },
  { key: "resWeak", off: 0x24765C, word: 0x24020078, pct: 120 },
  { key: "resNeutral", off: 0xE3870, word: 0x24040064, pct: 100 },
  { key: "res1", off: 0xE3878, word: 0x24040050, pct: 80 },
  { key: "res1", off: 0x247664, word: 0x24020050, pct: 80 },
  { key: "res2", off: 0xE3880, word: 0x2404003C, pct: 60 },
  { key: "res2", off: 0x247668, word: 0x2402003C, pct: 60 },
  { key: "res3", off: 0xE3884, word: 0x24040028, pct: 40 },
  { key: "res3", off: 0x24768C, word: 0x24040028, pct: 40 },
  { key: "buffDef", off: 0x104810, word: 0x24020055, pct: 85 },
  { key: "buffDef", off: 0x1053DC, word: 0x24020055, pct: 85 },
  { key: "mgcBoost", off: 0x10540C, word: 0x24020096, pct: 150 },
  { key: "mgcBoost", off: 0x105420, word: 0x24020096, pct: 150 },
  { key: "mgcBoost", off: 0x1054B8, word: 0x24020096, pct: 150 },
  { key: "mgcBoost", off: 0x1054CC, word: 0x24020096, pct: 150 },
]
export const STOCK_COUNTER = 0x2842001E;   // slti $v0,$v0,30
export const STOCK_HEAL_BIAS = 0x26220003; // addiu $v0,$s1,3
export const STOCK_HEAL_SRA = 0x00021083;  // sra $v0,$v0,2

// ---- Enemies editor fixture -------------------------------------------------
// A miniature enemy pack planted PAST the ELF block (real packs live ~1 GB into the
// disc; the synth file is extended by one sector to host this). Two byte-identical
// "streaming copies" so the write-through-all-copies path is exercised. The e2e
// injects ENEMY_TEST_PACKS via window.S3_TEST_ENEMY_PACKS before the ISO loads.
export const ENEMY_REC_A = 0x465E00, ENEMY_AUX_A = 0x465F00;   // copy 1
export const ENEMY_REC_B = 0x466000, ENEMY_AUX_B = 0x466100;   // copy 2
export const ZONE_SLOTS_A = 0x466200, ZONE_PARTY_A = 0x466240, ZONE_MEM_A = 0x466290;
export const ZONE_SLOTS_B = 0x466300, ZONE_PARTY_B = 0x466340, ZONE_MEM_B = 0x466390;
export const WAR_REC_A = 0x466400, WAR_REC_B = 0x4664A0;       // war-unit fixture (two copies)
// Room (per-area encounter rate) fixture — two chapter-variant tables of three rooms.
// Placed clear of the enemy/war spans so it gets its OWN aux window, the way the real
// disc's town-data sub-files do, instead of being absorbed into an enemy range.
export const ROOM_TABLE_A = 0x467000, ROOM_TABLE_B = 0x467100;
export const SYNTH_EXTRA = 0x1800;                             // file = ELF_END + this
export const ENEMY_TEST_PACKS = {
  format: "s3enemy", version: 1,
  recLayout: { hp: 48, maxhp: 50, lv: 64, stats: 32, size: 0x8C },
  auxLayout: { exp: 4, sp: 12, mark: 14, potch: 16, drops: 32, nDrops: 5, size: 0x34 },
  zoneLayout: { slotSize: 0x14, slotId: 0, slotVariant: 4,
                partySize: 0x1C, partyType: 0, partyProb: 2, partyFormId: 0x10, partyCount: 0x12 },
  packs: [{
    archive: "TEST", copies: 2, label: "BladeBunny",
    enemies: [{ id: 0x1F7, name: "BladeBunny", variants: [{
      lv: 7, hp: 40, stats: [11, 12, 13, 14, 15, 16, 17, 18], exp: 5, sp: 9, potch: 60,
      drops: [[1, 128], [0, 0], [0, 0], [0, 0], [0, 0]],
      rec: [ENEMY_REC_A, ENEMY_REC_B], aux: [ENEMY_AUX_A, ENEMY_AUX_B],
    }] }],
    zones: [{
      name: "test_101",
      slots: [
        { id: 0x1F7, variant: 0, off: [ZONE_SLOTS_A, ZONE_SLOTS_B] },
        { id: 0x1F7, variant: 1, off: [ZONE_SLOTS_A + 0x14, ZONE_SLOTS_B + 0x14] },
      ],
      parties: [
        { type: 0, prob: 50, formId: 0x1211, members: [0, 1],
          off: [ZONE_PARTY_A, ZONE_PARTY_B], memOff: [ZONE_MEM_A, ZONE_MEM_B] },
        { type: 0, prob: 25, formId: 0x1213, members: [1],
          off: [ZONE_PARTY_A + 0x1C, ZONE_PARTY_B + 0x1C], memOff: [ZONE_MEM_A + 8, ZONE_MEM_B + 8] },
      ],
    }],
  }],
};

// War-units fixture (War tab): one ZxnKn record in two copies, stats-only —
// war variants carry no aux/reward offsets. Injected via window.S3_TEST_WAR_UNITS.
export const WAR_TEST_UNITS = {
  format: "s3war", version: 1,
  recLayout: { hp: 48, maxhp: 50, lv: 64, stats: 32, size: 0x8C },
  auxLayout: { exp: 4, sp: 12, mark: 14, potch: 16, drops: 32, nDrops: 5, size: 0x34 },
  packs: [{
    archive: "TEST", war: true, copies: 2, label: "ZxnKn",
    enemies: [{ id: 0x132, name: "ZxnKn", variants: [{
      lv: 20, hp: 230, stats: [49, 65, 60, 35, 40, 45, 45, 55], exp: 0, sp: 0, potch: 0,
      drops: [], rec: [WAR_REC_A, WAR_REC_B], aux: [],
    }] }],
  }],
};

// Room-table fixture (Encounter view). Two chapter variants of one area, where room 1 and
// room 2 AGREE across the variants but room 3 does NOT (9 vs 2) — so the editor must show
// rooms 1-2 as a single row writing both tables, and split room 3 into two rows rather than
// showing one value that would be wrong for the other table.
const ROOM_REC = 0x3C;
export const ROOM_AREA_ID = 0x20;
export const ROOM_FIXTURE = [
  { base: ROOM_TABLE_A, rank: 3, rooms: [{ room: 1, rate: 4, grace: 6 }, { room: 2, rate: 0, grace: 0 }, { room: 3, rate: 9, grace: 4 }] },
  { base: ROOM_TABLE_B, rank: 5, rooms: [{ room: 1, rate: 4, grace: 6 }, { room: 2, rate: 0, grace: 0 }, { room: 3, rate: 2, grace: 4 }] },
];
export const ROOM_TEST_INDEX = {
  format: "s3rooms", schema: 1,
  areas: [{
    archive: "TEST", area: ROOM_AREA_ID, zones: ["test_101"],
    tables: ROOM_FIXTURE.map((t, ti) => ({
      sub: ti, rank: t.rank,
      rooms: t.rooms.map((r, i) => ({ room: r.room, rate: r.rate, grace: r.grace,
        rateOff: t.base + i * ROOM_REC + 4, graceOff: t.base + i * ROOM_REC + 2 })),
    })),
  }],
};

// Sub-file browser fixture: the synth file described as one archive of four "sub-files",
// pointing at regions that really exist in it so Peek reads bytes rather than off the end.
export const SUBFILE_TEST_INDEX = {
  format: "s3subfiles", schema: 1, kinds: ["data", "map", "town", "battle"],
  archives: [{
    archive: "TEST", base: 0, size: ELF_END + SYNTH_EXTRA,
    files: [
      [0, 1, 1, ""],                                        // map, sector 0
      [Math.floor(ROOM_TABLE_A / 2048), 1, 2, "area 0x20 · 3 rooms"],
      [Math.floor(ENEMY_REC_A / 2048), 1, 3, "test_101"],
      [Math.floor(WAR_REC_A / 2048), 1, 0, ""],
    ],
  }],
};

// items of a category (id + exact name), in id order, from the shipped id list.
export function catItems(cat, n = 99) {
  const txt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_item_ids.txt"), "latin1");
  let cur = ""; const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const h = /\*\s*(.+?)\s*\*/.exec(line);
    if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
    const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
    while ((m = re.exec(line))) if (cur === cat && out.length < n) out.push({ id: parseInt(m[1], 16), name: m[2].trim() });
  }
  return out;
}
export const firstArmor = () => catItems("Armor", 1)[0];

export function buildSynthIso() {
  const bytes = new Uint8Array(ELF_END + SYNTH_EXTRA);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(VERSION_OFF, VERSION_VAL, false);            // big-endian USA version word
  const enc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  let sc = 0x400000;
  const put = (s) => { const o = sc; bytes.set(enc(s), o); bytes[o + s.length] = 0; sc += s.length + 1; return o - ELF_BASE + ELF_VADDR; };
  const w32 = (o, v) => dv.setUint32(o, v >>> 0, true), w16 = (o, v) => dv.setUint16(o, v & 0xffff, true);
  const wf32 = (o, v) => dv.setFloat32(o, v, true);

  ["Flaming Arrows", "Dancing Flames", "Blazing Wall", "Explosion"].forEach((nm, i) => {
    const o = SPELL.off + i * SPELL.stride;
    w32(o + 8, put(nm)); w32(o + 0x0C, put("Deals 100DMG")); w32(o + 0x10, 50); w32(o + 0x14, 0x00000A00); w32(o + 0x1C, 100); w16(o + SPELL.elem, 1);
    if (i === 1) w32(o + 0x18, 0x10);   // spell #1 inflicts "unbalance" (flags18 bit4) → tests the Remove-status path
    // Spell #2 reproduces the Sword/Amulet shape that used to render "custom 0x05" in the Target
    // dropdown and "undefined" for its element: target byte 0x05 (chanter only) and element 7
    // (the Sword-of-* / Amulet family, which is not one of the six damage elements).
    if (i === 2) { w32(o + 0x14, 0x00000500); w32(o + 0x18, 1 << 23); w16(o + SPELL.elem, 7); }
  });
  { const o = UNITE.off; w32(o + 8, put("Test Unite")); w32(o + 0x0C, put("coop")); w32(o + 0x10, 65); w32(o + 0x14, 0x00000200); w32(o + 0x1C, 200); }
  { const o = FOOD.off; w32(o + FOOD.name, put("Medicine")); w32(o + FOOD.desc, put("Heals 100HP")); w16(o + FOOD.heal, 100); }
  // shop fixture: location 0, stages 0 and 1, on all three counters (+ one rarity each)
  const SHOP_FIXTURE = { loc: 0, stages: 2, chance: 40, stock: null };
  {
    const stock = { item: [0x001, 0x00A, 0x009], armor: [firstArmor().id], rune: [0x1BD] };
    SHOP_FIXTURE.stock = stock;
    for (const [name, base] of Object.entries(SHOPS.kinds)) {
      for (let stage = 0; stage < 2; stage++) {
        const rec = shopRec(base, 0, stage);
        // stage 1 carries one extra copy of the head item, so the two stages differ
        const list = stage ? [...stock[name], stock[name][0]] : stock[name];
        list.forEach((id, i) => w16(rec + i * 2, id));
        w16(rec + SHOPS.rarOff, stock[name][0]);          // rarity 0 item id
        bytes[rec + SHOPS.rarOff + 0x0A] = 40;            // ...its appearance chance out of 100
        bytes[rec + SHOPS.rarOff + 0x0B] = 1;             // ...and one in stock when it lands
      }
    }
  }
  const armor = firstArmor();
  const P = GEAR.P, st = P + GEAR.stride;
  w32(P, put("(x)")); w32(P + 8, 1000); w16(P + 0x10, 10); w32(P + 0x40, put(armor.name));
  w32(st, put("DEF(+10)")); w32(st + 8, 1000); w16(st + 0x10, 10); w16(st + 0x14, 2); w16(st + 0x16, 5);
  // armor sets: real composition rows + stock bonus-constant words (Sets view decodes these)
  SET_ROWS.forEach((row, i) => row.forEach((id, s) => w16(SETS.table + i * 8 + s * 2, id)));
  ENC_SITES.forEach((o, i) => w32(o, ENC_STOCK[i]));   // encounter-rate instruction words
  [SPLIT.route, SPLIT.amtSel, SPLIT.amt].forEach((o, i) => w32(o, SPLIT_STOCK[i]));   // damage+heal slot
  SETS.counterSites.forEach((o) => w32(o, STOCK_COUNTER));
  w32(SETS.healBias, STOCK_HEAL_BIAS); w32(SETS.healShift, STOCK_HEAL_SRA);
  SETS.counterOwnerSites.forEach((o) => w32(o, STOCK_OWNER_COUNTER));
  w32(SETS.healOwnerSite, STOCK_OWNER_HEAL); w32(SETS.squeakOwnerSite, STOCK_OWNER_SQUEAK);
  w32(SETS.halveMaskSite, STOCK_HALVE_MASK); w32(SETS.healDivRepair, STOCK_HEAL_DIV_SLOT);
  // movement-speed table + the per-character class byte
  MOVESPD_RUN.forEach((run, cls) => {
    w32(spdAddr(cls, 0x00), 0);
    wf32(spdAddr(cls, MOVESPD.walk), MOVESPD_WALK);
    wf32(spdAddr(cls, MOVESPD.run), run);
    wf32(spdAddr(cls, MOVESPD.rate), MOVESPD_RATE);
  });
  for (const [rec, cls] of Object.entries(MOVESPD_CLASS)) bytes[spdClassAddr(+rec)] = cls;
  for (const [roster, v] of Object.entries(HORSE_STOCK)) w16(horseAddr(+roster), v);
  for (const d of Object.values(MECH)) w32(d.off, d.stock);
  MOUNT_PAIRS.forEach((p) => {
    p.riderSites.forEach((o) => w32(o, mountWord(p.rider)));
    w32(p.mountSite, mountWord(p.mount));
  });
  AVATAR_SITES.forEach(([o, imm, kind]) => w32(o, avatarWord(imm, kind)));
  STORY_CASES.forEach(([o, imm]) => w32(o, avatarWord(imm, "eq")));
  ENCMOVE_SITES.forEach(([o, imm, opc, neg]) => w32(o, encMoveWord(imm, opc, neg)));
  // enemies-editor fixture: two byte-identical copies of one BladeBunny record + aux
  for (const [recO, auxO] of [[ENEMY_REC_A, ENEMY_AUX_A], [ENEMY_REC_B, ENEMY_AUX_B]]) {
    const v = ENEMY_TEST_PACKS.packs[0].enemies[0].variants[0];
    v.stats.forEach((sv, si) => w16(recO + 32 + si * 2, sv));
    w16(recO + 48, v.hp); w16(recO + 50, v.hp); w16(recO + 64, v.lv);
    w32(auxO + 4, v.exp); w16(auxO + 12, v.sp); w16(auxO + 14, 1000); w32(auxO + 16, v.potch);
    v.drops.forEach((dp, di) => { w16(auxO + 32 + di * 4, dp[0]); w16(auxO + 34 + di * 4, dp[1]); });
  }
  // zone fixture (spawn slots + formations), two copies like the records
  for (const [slO, paO, meO] of [[ZONE_SLOTS_A, ZONE_PARTY_A, ZONE_MEM_A], [ZONE_SLOTS_B, ZONE_PARTY_B, ZONE_MEM_B]]) {
    const z = ENEMY_TEST_PACKS.packs[0].zones[0];
    z.slots.forEach((s, si) => { w32(slO + si * 0x14, s.id); w32(slO + si * 0x14 + 4, s.variant); });
    z.parties.forEach((pa, pi) => {
      const b = paO + pi * 0x1C;
      w16(b, pa.type); w16(b + 2, pa.prob); w16(b + 0x10, pa.formId); w16(b + 0x12, pa.members.length);
      pa.members.forEach((m, mi) => { bytes[meO + pi * 8 + mi] = m; });
    });
  }
  // war-units fixture: one ZxnKn record in two copies (stats only, no aux)
  for (const recO of [WAR_REC_A, WAR_REC_B]) {
    const v = WAR_TEST_UNITS.packs[0].enemies[0].variants[0];
    v.stats.forEach((sv, si) => w16(recO + 32 + si * 2, sv));
    w16(recO + 48, v.hp); w16(recO + 50, v.hp); w16(recO + 64, v.lv);
  }
  // room tables: rank/grace/rate/bg per record, exactly as build_room_index.py reads them
  for (const t of ROOM_FIXTURE) {
    t.rooms.forEach((r, i) => {
      const o = t.base + i * ROOM_REC;
      w16(o, t.rank); w16(o + 2, r.grace); w16(o + 4, r.rate);
      w16(o + 8, (r.room << 8) | ROOM_AREA_ID);
    });
  }
  // enemy names (inline, 0x14 stride) so the Enemies view + search have content
  ["Zombie", "Bat Rider", "Harpy", "Golem", "Dragon"].forEach((nm, i) => bytes.set(enc(nm), ENEMY.off + i * ENEMY.stride));
  for (let i = 0; i < 16; i++) bytes[TABLES.list4[0] + i] = 20 + i;   // list4 rec0 ATK curve

  // ---- Verified-offset fixture (record #1) -------------------------------------------------
  // Plants distinctive, known values at the offsets whose mapping was corrected against a real
  // disc (github issue #2), so e2e can prove the editor DECODES them right (not just writes):
  //   * skill-max array starts at +16 (skill id N -> +16+(N-1)); encoding 5=B+, 6=A
  //   * growth: HP is at +0 (not +11), PWR at +4
  //   * rune slots are Head@+64 / Right@+72 / Left@+80
  const l2rec = TABLES.list2[0] + 1 * TABLES.list2[1];   // list2 record #1
  const l1rec = TABLES.list1[0] + 1 * TABLES.list1[1];   // list1 record #1
  [6, 5, 4, 3, 3, 4, 2].forEach((v, k) => (bytes[l2rec + 4 + k] = v));   // +4..+10 growth (PWR..SPD-ish)
  bytes[l2rec + 0] = 9;                                   // HP growth lives at +0
  bytes[l2rec + 16] = 5;                                  // skill #1 (Swing) max = B+ (value 5)
  bytes[l2rec + 17] = 6;                                  // skill #2 (Accuracy) max = A (value 6)
  const runes = catItems("Runes", 3);                     // 3 distinct runes for Head/Right/Left
  w16(l1rec + 64, runes[0].id);                           // Head
  w16(l1rec + 72, runes[1].id);                           // Right
  w16(l1rec + 80, runes[2].id);                           // Left
  const mapping = {
    l2rec, l1rec,
    skill1Max: "B+", skill2Max: "A",                     // decoded grades for +16 / +17
    hpGrowth: 9, pwrGrowth: 6,
    head: runes[0], right: runes[1], left: runes[2],
  };

  // ---- Text tab fixture -------------------------------------------------------------------
  // Planted UI strings for the in-ELF Text view, each isolated by NUL bytes so the scanner
  // sees exactly one run. One is prose (must be offered for editing); one is a format string
  // (must be filtered out — editing it would corrupt a printf-style slot).
  const TEXT_AT = 0x420000;
  const TEXT_PROSE = "The battle is over and everyone survived";
  const TEXT_REJECT = "arg1 %s -> %d";
  bytes.set(enc(TEXT_PROSE), TEXT_AT); bytes[TEXT_AT + TEXT_PROSE.length] = 0;
  const rejAt = TEXT_AT + TEXT_PROSE.length + 1;
  bytes.set(enc(TEXT_REJECT), rejAt); bytes[rejAt + TEXT_REJECT.length] = 0;
  mapping.text = { off: TEXT_AT, value: TEXT_PROSE, max: TEXT_PROSE.length, rejected: TEXT_REJECT };

  // ---- Rune description fixture -----------------------------------------------------------
  // One row per rune the tests touch: the three in the character's slots (magic runes, which
  // also carry a "Grants <spells>" tail) plus Balance, a passive support rune with no spell
  // entry anywhere — before the rune table was read it showed nothing at all in the picker.
  const balance = catItems("Runes").find((r) => r.name === "Balance");
  const runeRows = [...runes.map((r, i) => ({ ...r, desc: `Rune slot ${i} text.` })),
    { ...balance, desc: "Maintains balance." }];
  for (const r of runeRows) {
    const o = RUNE_TBL.off + r.id * RUNE_TBL.stride;
    w32(o + RUNE_TBL.name, put(r.name)); w32(o + RUNE_TBL.desc, put(r.desc));
  }
  // ---- duplicated description fixture (issue #11) -----------------------------------------
  // On a real disc 27 descriptions are stored TWICE, at two addresses reached from two
  // different tables: the 20 attack runes (RUNE_TBL desc + the spell record of the attack they
  // grant) and the 7 magic scrolls. Editing one copy used to leave the other stale, and the
  // Text tab listed the two identical rows with nothing to tell them apart. Reproduce that
  // shape exactly — same text, two separate allocations, one under RUNE_TBL and one under the
  // spell table — so the mirrored write has something to mirror.
  const TWIN_TEXT = "DMGx0.4 to foes in area.";
  const twinRune = catItems("Runes").find((r) => r.name === "Great Hawk") || balance;
  {
    const o = RUNE_TBL.off + twinRune.id * RUNE_TBL.stride;
    w32(o + RUNE_TBL.name, put(twinRune.name));
    const runeCopy = put(TWIN_TEXT);                    // copy A — what the game's rune menu reads
    w32(o + RUNE_TBL.desc, runeCopy);
    const so = SPELL.off + 3 * SPELL.stride;            // spell #3, its own separate allocation
    const spellCopy = put(TWIN_TEXT);                   // copy B — sorts first in the Text tab
    w32(so + 0x0C, spellCopy);
    mapping.twin = { text: TWIN_TEXT, rune: twinRune,
      runeOff: runeCopy - ELF_VADDR + ELF_BASE, spellOff: spellCopy - ELF_VADDR + ELF_BASE, spellIdx: 3 };
  }
  // ---- war-battle class fixture -----------------------------------------------------------
  // There is no class byte: the game derives a unit's class from the character's own skills
  // (display fn VA 0x169B5F8 — keep the slots with rank > 0, sort by rank descending, look the
  // top two skill ids up in a 43x47 table). Plant a word pool and two table cells so the
  // Classes reference can be tested end to end, using the real shape: cell = (type, modifier),
  // both indices into the pool, and column index == skill id.
  {
    const words = { 1: "Slasher", 2: "Knight", 11: "Shield", 12: "Armored", 37: "Knight" };
    for (const [i, w] of Object.entries(words)) w32(CLASS_POOL.off + +i * 4, put(w));
    const cell = (a, b, type, mod) => {
      const o = CLASS_TBL.off + (a - 1) * CLASS_TBL.stride + (b - 1) * 2;
      bytes[o] = type; bytes[o + 1] = mod;
    };
    // Give list1 record #1 (Hugo) the real disc's own skill loadout: Heavy Damage at rank 2 and
    // Counter Attack at rank 1. Rank-sorted that is skill 6 then skill 5, which is the pair the
    // real game resolves to "Slasher" — the anchor this whole derivation was checked against.
    [[6, 2], [5, 1]].forEach(([id, rk], k) => { bytes[l1rec + 12 + k * 2] = id; bytes[l1rec + 13 + k * 2] = rk; });
    // Give the pair he resolves to a real label, plus
    // one two-word label so the "type + modifier" join is covered rather than assumed.
    cell(6, 5, 1, 0);           // Heavy Damage + Counter Attack -> "Slasher"  (one word)
    cell(12, 3, 11, 37);        // Shield Protect + Damage      -> "Shield Knight" (two words)
    // Record #5 (Fred) gets the pair that lands on the two-word cell, so the type+modifier join
    // is covered by a real row rather than assumed. Both ranks equal, so the stable sort keeps
    // slot order and the top two are skills 12 then 3 — the same pair the real disc resolves.
    const l1fred = TABLES.list1[0] + 5 * TABLES.list1[1];
    [[12, 2], [3, 2]].forEach(([id, rk], k) => { bytes[l1fred + 12 + k * 2] = id; bytes[l1fred + 13 + k * 2] = rk; });
    mapping.classes = { pool: CLASS_POOL.off, tbl: CLASS_TBL.off,
      cases: [{ who: "Hugo", label: "Slasher" }, { who: "Fred", label: "Shield Knight" }] };
  }
  for (const f of STATUSFX_SITES) w32(f.off, f.word);   // status effect strength code sites
  mapping.statusfx = STATUSFX_SITES;
  mapping.shops = SHOP_FIXTURE;
  mapping.runes = runeRows;
  mapping.balance = { ...balance, desc: "Maintains balance." };

  return { bytes, armor, mapping };
}
