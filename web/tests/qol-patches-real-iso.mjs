// Training and forge switches against a REAL pristine disc: the ten words the Test
// tab's Training and forge subtab patches, checked at the offsets iso.js ships.
//
// Why this file exists apart from e2e.mjs: the synthetic fixture plants the stock
// words, so the e2e can prove the controls write and restore bytes, but not that
// the offsets and stock words are the real ones on a real disc. Those come from
// the RE lab (SKILL_TRAINING.md): an exhaustive census of the SP accessor's
// subtract mode found exactly two call sites, both in the training menus; the
// sharpen executor holds the one potch-subtract call beside its price lookup; the
// confirm variants carry the affordability and at-cap branches. All of it is
// read-only byte-checking against the pristine USA ISO, using constants sliced
// out of web/iso.js (not re-typed), cross-checked against the published research
// values, so drift on either side goes red.
//
//   node web/tests/qol-patches-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/qol-patches-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

if (!fs.existsSync(ISO)) {
  console.log(`SKIP qol-patches-real-iso: no disc at ${ISO} (set S3_ISO to point at one).`);
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
const slice = (name) => {
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(iso);
  if (!block) { console.log(`  ✗ could not find ${name} in web/iso.js`); process.exit(1); }
  return [...block[1].matchAll(/\{ off: (0x[0-9A-Fa-f]+), stock: (0x[0-9A-Fa-f]+), patch: (0x[0-9A-Fa-f]+)/g)]
    .map((m) => ({ off: parseInt(m[1], 16), stock: parseInt(m[2], 16) >>> 0, patch: parseInt(m[3], 16) >>> 0 }));
};
const TRAIN = slice("QOL_TRAIN"), FORGE = slice("QOL_FORGE"), CAP = slice("QOL_SMITHCAP");

// ---- what the research pass published (SKILL_TRAINING.md) ----------------------------------
const RESEARCH_TRAIN = [
  { off: 0x19DB98, stock: 0x0C5B242C, patch: 0x00000000 },
  { off: 0x19ED70, stock: 0x0C5B242C, patch: 0x00000000 },
  { off: 0x19D2DC, stock: 0x54400013, patch: 0x00000000 },
  { off: 0x19EAFC, stock: 0x1440000D, patch: 0x00000000 },
];
const RESEARCH_FORGE = [
  { off: 0x1920A4, stock: 0x0C5BFFE8, patch: 0x00000000 },
  { off: 0x1918C0, stock: 0x14400011, patch: 0x00000000 },
  { off: 0x192C2C, stock: 0x5440000E, patch: 0x00000000 },
  { off: 0x191E34, stock: 0x14400010, patch: 0x00000000 },
];
const RESEARCH_CAP = [
  { off: 0x191898, stock: 0x10400028, patch: 0x00000000 },
  { off: 0x192C04, stock: 0x10400025, patch: 0x00000000 },
];
const same = (a, b) => a.length === b.length
  && a.every((c, i) => c.off === b[i].off && c.stock === b[i].stock && c.patch === b[i].patch);
check("iso.js QOL_TRAIN is the research set (2 SP-subtract calls + 2 affordability branches)",
  same(TRAIN, RESEARCH_TRAIN), TRAIN.map((c) => hx(c.off)).join(", "));
check("iso.js QOL_FORGE is the research set (1 potch-subtract call + 3 affordability branches)",
  same(FORGE, RESEARCH_FORGE), FORGE.map((c) => hx(c.off)).join(", "));
check("iso.js QOL_SMITHCAP is the research set (the 2 at-cap branches)",
  same(CAP, RESEARCH_CAP), CAP.map((c) => hx(c.off)).join(", "));

// ---- read the real disc ---------------------------------------------------------------------
const fd = fs.openSync(ISO, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
const u32 = (off) => readAt(off, 4).readUInt32LE(0) >>> 0;

console.log(`Training and forge patches vs ${path.basename(ISO)}:`);

// ---- the ten stock words ---------------------------------------------------------------------
for (const c of [...TRAIN, ...FORGE, ...CAP]) {
  check(`word @ ${hx(c.off)} holds its stock word ${hx(c.stock, 8)}`, u32(c.off) === c.stock, hx(u32(c.off), 8));
}

// The two training deduction sites are call sites, not just words: both encode a
// jal to the one SP accessor (VA 0x16C90B0), which is what makes them the same
// subtract the census counted. A jal word is 0x0C000000 | (target >> 2).
const jalTarget = (w) => (w & 0x03FFFFFF) << 2;
check("both training deduction sites jal the SP accessor (VA 0x16C90B0)",
  jalTarget(TRAIN[0].stock) === 0x16C90B0 && jalTarget(TRAIN[1].stock) === 0x16C90B0,
  hx(jalTarget(TRAIN[0].stock)) + ", " + hx(jalTarget(TRAIN[1].stock)));

fs.closeSync(fd);
console.log(fails ? `\nFAILED (${fails})` : "\nAll training/forge patch checks passed against the real disc.");
process.exit(fails ? 1 : 0);
