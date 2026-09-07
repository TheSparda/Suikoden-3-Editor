// flags14 bit16 — the "no aiming step" bit — checked against a REAL pristine disc.
//
// Why this file exists: setting Phoenix's Target to "All foes" soft-locked a battle (played
// 2026-09-06). The cursor came up on the caster and its pair, no enemy could be picked, and
// confirming did nothing. The target byte itself was right — 0x02 IS all-foes — but the write
// was only half of one. flags14 carries a SECOND field the dropdown never touched: bit16, which
// tells the engine there is nothing to aim at. Set on exactly the records that hit a whole side
// (target byte 0x01/0x02/0x03) with AREA_BIT clear, clear on every other record. Leaving it
// behind produced 0x0080020A — "the whole foe side" and "make the player aim first" at once,
// a combination no stock record has.
//
// So the invariant is checked the only way that proves it: over every flags14 word on a
// pristine SLUS-20387 (94 spells + 38 unites), against the SHIPPED syncNoAim sliced straight
// out of web/iso.js rather than a copy of it.
//
//   node web/tests/spell-target-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/spell-target-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

const src = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};
const hx = (w) => "0x" + (w >>> 0).toString(16).toUpperCase().padStart(8, "0");

// ---- load the shipped helper, don't re-type it -------------------------------------------
const START = "  const AREA_BIT = 0x8000;";
const END = "  };";
const from = src.indexOf(START);
if (from < 0) { console.error("could not find AREA_BIT in web/iso.js"); process.exit(1); }
const to = src.indexOf("\n  const F18_BITS", from);
const slice = src.slice(from, to);
if (!/const syncNoAim = /.test(slice)) { console.error("syncNoAim is not in the AREA_BIT block"); process.exit(1); }
const { AREA_BIT, NO_AIM_BIT, syncNoAim } = new Function(
  `${slice}\n return { AREA_BIT, NO_AIM_BIT, syncNoAim };`)();

console.log("spell-target-real-iso: flags14 bit16 (no-aiming-step)");
check("AREA_BIT is bit15", AREA_BIT === 0x8000, hx(AREA_BIT));
check("NO_AIM_BIT is bit16", NO_AIM_BIT === 0x00010000, hx(NO_AIM_BIT));

// ---- every writer must route through it ---------------------------------------------------
// A target or AOE write that skips syncNoAim is exactly the bug this file is named after, and
// it is invisible on a disc-less machine, so assert the call sites in source too.
//
// Anchored on the WRITE rather than on the arithmetic: the unite handler folds Target and AOE
// into one branch, so `v` is built on one line and stored on another and a per-line grep for
// "0xFFFF80FF ... syncNoAim" would read as a pass only by accident. Each flags14 store has to
// have syncNoAim applied to v within the three lines leading up to it.
const lines = src.split("\n");
const stores = lines.map((l, n) => [l, n]).filter(([l]) => /writeW\(off \+ 0x14, 4, v\)/.test(l));
check("three flags14 writers (spell Target, spell AOE, unite Target/AOE)", stores.length === 3,
  `found ${stores.length}`);
const unsynced = stores.filter(([, n]) => !lines.slice(Math.max(0, n - 3), n + 1).join("\n").includes("syncNoAim("));
check("every flags14 write is wrapped in syncNoAim", unsynced.length === 0,
  unsynced.map(([, n]) => `line ${n + 1}`).join(" "));
// And both shapes of the write still exist, so a refactor cannot pass the check above by
// deleting a control instead of fixing it.
check("the Target byte write exists", /0xFFFF80FF/.test(src) && src.match(/0xFFFF80FF/g).length === 2,
  `${(src.match(/0xFFFF80FF/g) || []).length} sites`);
check("the AOE bit write exists", (src.match(/\|\s*AREA_BIT\)\s*:\s*\(v\s*&\s*~AREA_BIT\)/g) || []).length === 2);

if (!fs.existsSync(ISO)) {
  console.log(`SKIP the disc half: no disc at ${ISO} (set S3_ISO to point at one).`);
  process.exit(fails ? 1 : 0);
}

// ---- the disc half: 132 stock records, 0 exceptions ---------------------------------------
const SPELL = { off: 0x3EC2A0, count: 94, stride: 0x20 };
const UNITE = { off: 0x3ECF90, count: 38, stride: 0x28 };
const fd = fs.openSync(ISO, "r");
const rd = (off, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return b; };
const u32 = (off) => rd(off, 4).readUInt32LE(0);
const flags14 = (t) => Array.from({ length: t.count }, (_, i) => u32(t.off + i * t.stride + 0x14));

const stock = [...flags14(SPELL), ...flags14(UNITE)];
const drift = stock.filter((v) => syncNoAim(v) !== (v >>> 0));
check(`syncNoAim leaves every stock record alone (${stock.length} of them)`, drift.length === 0,
  drift.length ? drift.slice(0, 4).map(hx).join(" ") : "");

// The bit really is a function of the target byte and nothing else — assert the rule outright
// so a future "0x02 sometimes means something else" claim has to beat the data first.
const wrong = stock.filter((v) => {
  const tb = (v >> 8) & 0x7F;
  const whole = (tb === 0x01 || tb === 0x02 || tb === 0x03) && !(v & AREA_BIT);
  return whole !== !!(v & NO_AIM_BIT);
});
check("bit16 is set iff the target byte is a whole side with no area", wrong.length === 0,
  wrong.length ? wrong.slice(0, 4).map(hx).join(" ") : "");

// ---- the case that soft-locked --------------------------------------------------------------
// Phoenix is spell row 51 (rune 0x153's only slot); Kite is row 77, the stock all-foes attack.
const phoenix = u32(SPELL.off + 51 * SPELL.stride + 0x14);
const kite = u32(SPELL.off + 77 * SPELL.stride + 0x14);
check("Phoenix ships single-target", phoenix === 0x00800A0A, hx(phoenix));
check("Kite ships all-foes", kite === 0x0081020A, hx(kite));
const retargeted = syncNoAim((phoenix & 0xFFFF80FF) | ((0x02 & 0x7F) << 8));
check("Phoenix set to All foes now matches Kite byte-for-byte", retargeted === kite,
  `${hx(retargeted)} vs ${hx(kite)}`);
check("the old write produced the soft-lock word",
  (((phoenix & 0xFFFF80FF) | (0x02 << 8)) >>> 0) === 0x0080020A);
// ...and back again: a whole-side spell turned single-target has to LOSE the bit.
check("Kite set to Single target loses bit16",
  syncNoAim((kite & 0xFFFF80FF) | ((0x0A & 0x7F) << 8)) === 0x00800A0A);
// Turning AOE on takes a whole-side spell off the no-aim path (Double Tusk's shape).
check("Kite made AOE loses bit16", syncNoAim(kite | AREA_BIT) === 0x0080820A);

fs.closeSync(fd);
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
