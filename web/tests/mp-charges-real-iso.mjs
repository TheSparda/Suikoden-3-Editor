// Unlimited rune casts against a REAL pristine disc: the three words the Test tab's
// two tiers patch, checked at the offsets iso.js ships.
//
// Why this file exists apart from e2e.mjs: the synthetic fixture plants the three stock
// words, so the e2e can prove the controls write and restore bytes — but not that the
// offsets and stock words are the real ones on a real disc. Those come from the charge
// census in the RE lab (MP_CHARGES.md): exactly one consumption call in the spell
// resolver, and the set-maximum / top-up pair inside the charge recompute. All of it is
// read-only byte-checking against the pristine USA ISO, using constants sliced out of
// web/iso.js (not re-typed), cross-checked against the published research values — so
// drift on either side goes red.
//
//   node web/tests/mp-charges-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/mp-charges-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

if (!fs.existsSync(ISO)) {
  console.log(`SKIP mp-charges-real-iso: no disc at ${ISO} (set S3_ISO to point at one).`);
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
const T1 = slice("MPCAST_T1"), T2 = slice("MPCAST_T2");

// ---- what the research pass published (MP_CHARGES.md) --------------------------------------
const RESEARCH_T1 = [{ off: 0x0E1BB8, stock: 0x0C5B228A, patch: 0x00000000 }];
const RESEARCH_T2 = [
  { off: 0x1106BC, stock: 0x326700FF, patch: 0x24070009 },
  { off: 0x1106C8, stock: 0x02743823, patch: 0x24070009 },
];
const same = (a, b) => a.length === b.length
  && a.every((c, i) => c.off === b[i].off && c.stock === b[i].stock && c.patch === b[i].patch);
check("iso.js MPCAST_T1 is the research tier 1 (the resolver's consumption call, NOP-ed)",
  same(T1, RESEARCH_T1), T1.map((c) => hx(c.off)).join(", "));
check("iso.js MPCAST_T2 is the research tier 2 (the recompute pair, both forced to addiu 9)",
  same(T2, RESEARCH_T2), T2.map((c) => hx(c.off)).join(", "));

// ---- read the real disc ---------------------------------------------------------------------
const fd = fs.openSync(ISO, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
const u32 = (off) => readAt(off, 4).readUInt32LE(0) >>> 0;

console.log(`Unlimited rune casts vs ${path.basename(ISO)}:`);

// ---- the three stock words ------------------------------------------------------------------
for (const c of [...T1, ...T2]) {
  check(`word @ ${hx(c.off)} holds its stock word ${hx(c.stock, 8)}`, u32(c.off) === c.stock, hx(u32(c.off), 8));
}

// The tier-1 site is a call site, not just a word: the mode setup before it and the
// value in its delay slot are what make it the consumption call (mode 1, value 1).
check("tier 1 is the consumption call: mode setup 0x24060001 before it",
  u32(T1[0].off - 4) === 0x24060001, hx(u32(T1[0].off - 4), 8));
check("...and value 0x24070001 in its delay slot",
  u32(T1[0].off + 4) === 0x24070001, hx(u32(T1[0].off + 4), 8));

// The tier-2 pair brackets the set-maximum call: both sites sit in the recompute's
// per-level loop, twelve bytes apart, either side of the call they feed.
check("tier 2's pair sits 12 bytes apart inside the one loop",
  T2[1].off - T2[0].off === 12, String(T2[1].off - T2[0].off));

fs.closeSync(fd);
console.log(fails ? `\nFAILED (${fails})` : "\nAll charge-patch checks passed against the real disc.");
process.exit(fails ? 1 : 0);
