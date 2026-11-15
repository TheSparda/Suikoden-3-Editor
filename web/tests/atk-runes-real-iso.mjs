// Special-attack runes against a REAL pristine disc: the binding collapse, the census
// behind the Runes tab's spell-list control, and the Test tab's global NOP patch.
//
// Why this file exists apart from e2e.mjs: the synthetic fixture plants exactly one
// category-2 rune (the twin), so it can prove the control writes two bytes but not that
// the control's STATE MACHINE matches the real disc — that 25 of the 27 special-attack
// runes collapse, that Devil's Doll and Spreading Flame are the two that do not, and
// that the four compares the Test tab NOPs really hold the stock words iso.js claims.
// All of that is read-only byte-checking against the pristine USA ISO, using constants
// sliced out of web/iso.js (not re-typed), cross-checked against the values the
// disassembly pass published — so drift on either side goes red.
//
//   node web/tests/atk-runes-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/atk-runes-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

if (!fs.existsSync(ISO)) {
  console.log(`SKIP atk-runes-real-iso: no disc at ${ISO} (set S3_ISO to point at one).`);
  process.exit(0);
}

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};
const hx = (n, w = 6) => "0x" + n.toString(16).toUpperCase().padStart(w, "0");

const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");

// ---- the shipped constants, sliced out of iso.js -----------------------------------------
const atkBlock = /const ATKLIST = \[([\s\S]*?)\];/.exec(iso);
if (!atkBlock) { console.log("  ✗ could not find ATKLIST in web/iso.js"); process.exit(1); }
const ATKLIST = [...atkBlock[1].matchAll(/\{ off: (0x[0-9A-Fa-f]+), stock: (0x[0-9A-Fa-f]+)/g)]
  .map((m) => ({ off: parseInt(m[1], 16), stock: parseInt(m[2], 16) >>> 0 }));

const tblLine = /const RUNE_TBL = \{([^}]*)\};/.exec(iso);
if (!tblLine) { console.log("  ✗ could not find RUNE_TBL in web/iso.js"); process.exit(1); }
const tblNum = (k) => { const m = new RegExp(`${k}: (0x[0-9A-Fa-f]+|\\d+)`).exec(tblLine[1]); return m ? parseInt(m[1]) : NaN; };
const RT = { off: tblNum("off"), stride: tblNum("stride"), lo: tblNum("lo"), hi: tblNum("hi"),
             elem: tblNum("elem"), cat: tblNum("cat"), spells: tblNum("spells") };

// ---- what the disassembly pass published (SPECIAL_ATTACK_RUNES.md) --------------------------
const RESEARCH_ATK = [
  { off: 0x123EF4, stock: 0x10620011 }, { off: 0x123EFC, stock: 0x10620010 },
  { off: 0x124024, stock: 0x1062000A }, { off: 0x12402C, stock: 0x50620009 },
];
check("iso.js ATKLIST is the research table (4 sites, same offsets and stock words)",
  ATKLIST.length === 4 && ATKLIST.every((c, i) => c.off === RESEARCH_ATK[i].off && c.stock === RESEARCH_ATK[i].stock),
  ATKLIST.map((c) => hx(c.off)).join(", "));
check("iso.js RUNE_TBL geometry is the research geometry (off 0x3EAF78, stride 0x20, elem +0x14, cat +0x16, spells +0x18)",
  RT.off === 0x3EAF78 && RT.stride === 0x20 && RT.elem === 0x14 && RT.cat === 0x16 && RT.spells === 0x18,
  `off ${hx(RT.off)} stride ${hx(RT.stride, 2)}`);

// ---- read the real disc ---------------------------------------------------------------------
const fd = fs.openSync(ISO, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
const u32 = (buf, o) => buf.readUInt32LE(o) >>> 0;
const u16 = (buf, o) => buf.readUInt16LE(o);

console.log(`Attack-rune binding vs ${path.basename(ISO)}:`);

// ---- 1. the four compares hold their stock words --------------------------------------------
for (const c of ATKLIST) {
  const got = u32(readAt(c.off, 4), 0);
  check(`compare @ ${hx(c.off)} holds its stock word ${hx(c.stock, 8)}`, got === c.stock, hx(got, 8));
}

// ---- 2. the rune census ----------------------------------------------------------------------
const span = (RT.hi - RT.lo + 1) * RT.stride;
const tbl = readAt(RT.off + RT.lo * RT.stride, span);
const rec = (id) => (id - RT.lo) * RT.stride;
const rows = [];
for (let id = RT.lo; id <= RT.hi; id++) {
  const o = rec(id);
  if (!u32(tbl, o)) continue;                       // no name pointer: not a rune row
  rows.push({ id, elem: u16(tbl, o + RT.elem), cat: u16(tbl, o + RT.cat),
              slots: [0, 1, 2, 3].map((k) => u16(tbl, o + RT.spells + k * 2)) });
}
check("72 rune rows carry records", rows.length === 72, String(rows.length));

const collapses = (r) => (r.cat === 1 || r.cat === 2) && r.elem === 0;
const collapsed = rows.filter(collapses);
check("25 runes collapse to slot 1 (category 2, element 0)", collapsed.length === 25,
  collapsed.map((r) => r.id).join(", "));
check("no stock rune sits on the category-1 arm (word 0x00010000)",
  rows.every((r) => !(r.cat === 1 && r.elem === 0)));

for (const [id, name] of [[352, "Devil's Doll"], [354, "Spreading Flame"]]) {
  const r = rows.find((x) => x.id === id);
  check(`${name} (${id}) is category 2 with element 1 — it already lists, no toggle`,
    !!r && r.cat === 2 && r.elem === 1, r ? `cat ${r.cat} elem ${r.elem}` : "row missing");
}

// Kite, the worked example: record at ISO 0x3EDD18, category u16 at 0x3EDD2E, slots at 0x3EDD30.
const kite = rows.find((x) => x.id === 365);
check("Kite (365): the category byte offset is the published 0x3EDD2E",
  RT.off + 365 * RT.stride + RT.cat === 0x3EDD2E, hx(RT.off + 365 * RT.stride + RT.cat));
check("Kite (365) collapses stock: category 2, element 0, slots 78/0/0/0",
  !!kite && kite.cat === 2 && kite.elem === 0 && kite.slots.join() === "78,0,0,0",
  kite ? `cat ${kite.cat} elem ${kite.elem} slots ${kite.slots.join("/")}` : "row missing");

// Every collapsing rune ships exactly one spell — the collapse is invisible on a stock
// disc precisely because there is never a second slot for it to hide.
check("every collapsing rune ships exactly one filled slot (the collapse hides nothing stock)",
  collapsed.every((r) => r.slots.filter(Boolean).length === 1));

fs.closeSync(fd);
console.log(fails ? `\nFAILED (${fails})` : "\nAll attack-rune checks passed against the real disc.");
process.exit(fails ? 1 : 0);
