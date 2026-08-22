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
export const GEAR_STRIDE = 0x44;
export const VERSION_OFF = 4136544, VERSION_VAL = 0x40A69A01;

// first Armor-category item (id + exact name) from the shipped id list — used for a gear record
export function firstArmor() {
  const txt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_item_ids.txt"), "latin1");
  let cur = "", found = null;
  for (const line of txt.split(/\r?\n/)) {
    const h = /\*\s*(.+?)\s*\*/.exec(line);
    if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
    const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
    while ((m = re.exec(line))) if (cur === "Armor" && !found) found = { id: parseInt(m[1], 16), name: m[2].trim() };
  }
  return found;
}

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
  });
  { const o = UNITE.off; w32(o + 8, put("Test Unite")); w32(o + 0x0C, put("coop")); w32(o + 0x10, 65); w32(o + 0x14, 0x00000200); w32(o + 0x1C, 200); }
  { const o = FOOD.off; w32(o + FOOD.name, put("Medicine")); w32(o + FOOD.desc, put("Heals 100HP")); w16(o + FOOD.heal, 100); }
  const armor = firstArmor();
  const P = 0x410000, st = P + GEAR_STRIDE;
  w32(P, put("(x)")); w32(P + 8, 1000); w16(P + 0x10, 10); w32(P + 0x40, put(armor.name));
  w32(st, put("DEF(+10)")); w32(st + 8, 1000); w16(st + 0x10, 10); w16(st + 0x14, 2); w16(st + 0x16, 5);
  return { bytes, armor };
}
