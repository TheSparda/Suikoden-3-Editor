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
export const SPELL = { off: 0x3EC2A0, stride: 0x20, elem: 0x24 };
export const UNITE = { off: 0x3ECF90, stride: 0x28 };
export const FOOD = { off: 0x3E91D0, stride: 0x48, heal: 0x14, proc: 0x1E, name: 0x44, desc: 0x00 };
export const ENEMY = { off: 0x3E74E0, stride: 0x14, count: 100 };
export const GEAR = { P: 0x410000, stride: 0x44, def: 0x10, price: 0x08, effs: [0x14, 0x1C, 0x24, 0x2C, 0x34] };
export const TABLES = { list1: [4078716, 140], list2: [4068152, 132], list3: [4089904, 8], list4: [4061704, 28] };
export const SHOP = { item3_a: [4105552, 2], item3_b: [4054224, 2], item2: [3970620, 4], item1: [4136564, 4] };
export const VERSION_OFF = 4136544, VERSION_VAL = 0x40A69A01;
// Armor sets: composition table + the in-block bonus-constant instruction words
// (the potch pair lives ~1 GB into the disc — outside a synth file, so the Sets
// view must degrade to "unavailable" for it here).
export const SETS = { table: 0x3DDAB8, counterSites: [0x244F8C, 0x2452F8], healBias: 0x245DA8, healShift: 0x245DB4 };
export const SET_ROWS = [           // real composition (Head, Body, Shield, Accessory; 0 = unused)
  [0x0AD, 0x0C2, 0x109, 0x123],     // Mole
  [0x0BD, 0x103, 0x000, 0x11F],     // Prosperity
  [0x0BE, 0x0F2, 0x000, 0x126],     // Destiny
  [0x0A7, 0x0D7, 0x10C, 0x000],     // Guardian
  [0x0A9, 0x0E7, 0x000, 0x132],     // Pale Moon
];
export const STOCK_COUNTER = 0x2842001E;   // slti $v0,$v0,30
export const STOCK_HEAL_BIAS = 0x26220003; // addiu $v0,$s1,3
export const STOCK_HEAL_SRA = 0x00021083;  // sra $v0,$v0,2

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
  const bytes = new Uint8Array(ELF_END);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(VERSION_OFF, VERSION_VAL, false);            // big-endian USA version word
  const enc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  let sc = 0x400000;
  const put = (s) => { const o = sc; bytes.set(enc(s), o); bytes[o + s.length] = 0; sc += s.length + 1; return o - ELF_BASE + ELF_VADDR; };
  const w32 = (o, v) => dv.setUint32(o, v >>> 0, true), w16 = (o, v) => dv.setUint16(o, v & 0xffff, true);

  ["Flaming Arrows", "Dancing Flames", "Blazing Wall", "Explosion"].forEach((nm, i) => {
    const o = SPELL.off + i * SPELL.stride;
    w32(o + 8, put(nm)); w32(o + 0x0C, put("Deals 100DMG")); w32(o + 0x10, 50); w32(o + 0x14, 0x00000A00); w32(o + 0x1C, 100); w16(o + SPELL.elem, 1);
    if (i === 1) w32(o + 0x18, 0x10);   // spell #1 inflicts "unbalance" (flags18 bit4) → tests the Remove-status path
  });
  { const o = UNITE.off; w32(o + 8, put("Test Unite")); w32(o + 0x0C, put("coop")); w32(o + 0x10, 65); w32(o + 0x14, 0x00000200); w32(o + 0x1C, 200); }
  { const o = FOOD.off; w32(o + FOOD.name, put("Medicine")); w32(o + FOOD.desc, put("Heals 100HP")); w16(o + FOOD.heal, 100); }
  const armor = firstArmor();
  const P = GEAR.P, st = P + GEAR.stride;
  w32(P, put("(x)")); w32(P + 8, 1000); w16(P + 0x10, 10); w32(P + 0x40, put(armor.name));
  w32(st, put("DEF(+10)")); w32(st + 8, 1000); w16(st + 0x10, 10); w16(st + 0x14, 2); w16(st + 0x16, 5);
  // armor sets: real composition rows + stock bonus-constant words (Sets view decodes these)
  SET_ROWS.forEach((row, i) => row.forEach((id, s) => w16(SETS.table + i * 8 + s * 2, id)));
  SETS.counterSites.forEach((o) => w32(o, STOCK_COUNTER));
  w32(SETS.healBias, STOCK_HEAL_BIAS); w32(SETS.healShift, STOCK_HEAL_SRA);
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

  return { bytes, armor, mapping };
}
