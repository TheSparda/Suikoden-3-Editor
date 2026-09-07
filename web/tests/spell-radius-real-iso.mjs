// The RADIUS byte — the size of a spell's area/line template — checked against a REAL pristine
// disc, and the coupling that keeps an "Area of effect" change from producing an area of size 0.
//
// Why this file exists: the AOE dropdown wrote flags14 bit15 and nothing else. But radius is a
// separate byte in the record tail, and on a pristine SLUS-20387 it is NOT independent of the
// flags: nonzero on every record that has a template and zero on every record that does not,
// 131/131 across the 93 spells whose tail is readable and the 38 unites, no exceptions in either
// direction. So switching AOE on for one of the 34 plain single-target spells asked the engine
// for an area of size ZERO — a combination no stock record has — and switching it back off left
// a stranded template size behind. Same trap through the Target dropdown, because the line bit
// (target byte 0x10) is radius-bearing too with the AREA bit clear: Thunder Runner r1.
//
// This is the same shape as the bit16 soft lock in spell-target-real-iso.mjs, and it is checked
// the same way: the SHIPPED needsRadius / defaultRadius / radiusFix, sliced straight out of
// web/iso.js rather than copied, run over every record on a pristine disc.
//
//   node web/tests/spell-radius-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/spell-radius-real-iso.mjs
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

// ---- load the shipped helpers, don't re-type them ----------------------------------------
// Same slice as spell-target-real-iso.mjs: the whole flags14 helper block, which is pure by
// construction (no DOM, no BUF) precisely so both of these files can run it.
const START = "  const AREA_BIT = 0x8000;";
const from = src.indexOf(START);
if (from < 0) { console.error("could not find AREA_BIT in web/iso.js"); process.exit(1); }
const slice = src.slice(from, src.indexOf("\n  const F18_BITS", from));
if (!/const radiusFix = /.test(slice)) { console.error("radiusFix is not in the AREA_BIT block"); process.exit(1); }
const { AREA_BIT, LINE_BIT, AREA_RADIUS, LINE_RADIUS, needsRadius, defaultRadius, radiusFix, radiusTyped } =
  new Function(`${slice}\n return { AREA_BIT, LINE_BIT, AREA_RADIUS, LINE_RADIUS, needsRadius, defaultRadius, radiusFix, radiusTyped };`)();

console.log("spell-radius-real-iso: the area/line template size");
check("LINE_BIT is target-byte bit 4", LINE_BIT === 0x10);
check("defaults are stock values", AREA_RADIUS === 3 && LINE_RADIUS === 1, `area ${AREA_RADIUS}, line ${LINE_RADIUS}`);
check("defaultRadius picks by shape", defaultRadius(AREA_BIT) === AREA_RADIUS && defaultRadius(0x12 << 8) === LINE_RADIUS);

// ---- every writer must route through it ---------------------------------------------------
// A flags14 write that skips syncRadius is the bug this file is named after, and it is invisible
// on a disc-less machine, so assert the call sites in source too. syncRadius is the IO wrapper
// (it reads the byte, writes it, and returns the sentence the user sees); radiusFix is the rule.
const lines = src.split("\n");
const stores = lines.map((l, n) => [l, n]).filter(([l]) => /writeW\(off \+ 0x14, 4, v\)/.test(l));
check("three flags14 writers (spell Target, spell AOE, unite Target/AOE)", stores.length === 3,
  `found ${stores.length}`);
check("syncRadius is called for the spell table and the unite table",
  (src.match(/syncRadius\("spell"/g) || []).length === 1 && (src.match(/syncRadius\("unite"/g) || []).length === 1);
// The coupling must be skippable by an explicit radius in the SAME call, or the rune-reskin card
// would fight the Radius box it offers one field above.
check("an explicit radius in the same edit wins", /f\.radius == null/.test(src));
// Both Radius controls must declare the value authored, or radiusFix's "the user owns this"
// branch is unreachable and a typed 4 gets reset the next time the shape changes.
check("both Radius controls mark the row as typed",
  (src.match(/radiusTyped\.spell\.add\(/g) || []).length === 1 &&
  (src.match(/radiusTyped\.unite\.add\(/g) || []).length === 1);

// ---- the rule, in both directions, without a disc -----------------------------------------
const F14 = (tb, area) => (((tb & 0x7F) << 8) | (area ? AREA_BIT : 0) | 0x0A) >>> 0;
check("area on + radius 0 gets a size", radiusFix("spell", 0, 0, F14(0x0A, true))?.radius === AREA_RADIUS);
check("area off + radius 3 gets cleared", radiusFix("spell", 0, 3, F14(0x0A, false))?.radius === 0);
check("line target + radius 0 gets a size", radiusFix("spell", 0, 0, F14(0x12, false))?.radius === LINE_RADIUS);
check("line target dropped + radius 1 gets cleared", radiusFix("spell", 0, 1, F14(0x0A, false))?.radius === 0);
// The narrow part: a size that already agrees with the shape is never touched, so Explosion's 4
// survives an unrelated Target change and a bulk reskin does not flatten a graded rune family.
check("an area record that already has a size is left alone", radiusFix("spell", 3, 4, F14(0x03, true)) === null);
check("a plain record that already has 0 is left alone", radiusFix("spell", 0, 0, F14(0x0A, false)) === null);
// ...and a value the user typed is theirs. Same inputs as the two writing cases above, only now
// the row is marked: the answer changes from "write this" to "say something".
radiusTyped.spell.add(7);
check("a typed radius is not overwritten", radiusFix("spell", 7, 0, F14(0x0A, true))?.skip === true);
check("a typed radius is not cleared either", radiusFix("spell", 7, 3, F14(0x0A, false))?.skip === true);
check("and the note still says which way it wanted to go",
  radiusFix("spell", 7, 0, F14(0x0A, true))?.want === true && radiusFix("spell", 7, 3, F14(0x0A, false))?.want === false);
check("the two tables track typed rows separately", radiusFix("unite", 7, 0, F14(0x0A, true))?.radius === AREA_RADIUS);
radiusTyped.spell.delete(7);

if (!fs.existsSync(ISO)) {
  console.log(`SKIP the disc half: no disc at ${ISO} (set S3_ISO to point at one).`);
  process.exit(fails ? 1 : 0);
}

// ---- the disc half: 131 stock records, 0 exceptions ---------------------------------------
// The last spell's tail lands outside the table (a record's tail is stored one record AHEAD),
// so 93 of the 94 spells have a radius byte to read; every unite does, because a unite record is
// 8 bytes longer and the same shift leaves its tail inside itself.
const SPELL = { off: 0x3EC2A0, count: 94, stride: 0x20, radius: 0x21 };
const UNITE = { off: 0x3ECF90, count: 38, stride: 0x28, radius: 0x21 };
const fd = fs.openSync(ISO, "r");
const rd = (off, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, off); return b; };
const u8 = (off) => rd(off, 1)[0];
const u32 = (off) => rd(off, 4).readUInt32LE(0);
const recs = [];
for (const [tbl, T] of [["spell", SPELL], ["unite", UNITE]])
  for (let i = 0; i < T.count; i++) {
    if (tbl === "spell" && i + 1 >= T.count) continue;                 // no readable tail
    const off = T.off + i * T.stride;
    recs.push({ tbl, i, f14: u32(off + 0x14), rad: u8(off + T.radius) });
  }
check(`131 records with a readable radius byte (93 spells + 38 unites)`, recs.length === 131, `${recs.length}`);

const wrong = recs.filter((r) => needsRadius(r.f14) !== (r.rad !== 0));
check("radius is nonzero iff the record has an area or a line", wrong.length === 0,
  wrong.slice(0, 4).map((r) => `${r.tbl}${r.i} ${hx(r.f14)} r${r.rad}`).join(" "));

// radiusFix must be a no-op on the whole pristine disc, which is the same guarantee syncNoAim
// gives: a stock record edited in some other way never has its radius moved out from under it.
const drift = recs.filter((r) => radiusFix(r.tbl, r.i, r.rad, r.f14) !== null);
check("radiusFix leaves every stock record alone", drift.length === 0,
  drift.slice(0, 4).map((r) => `${r.tbl}${r.i} ${hx(r.f14)} r${r.rad}`).join(" "));

// The defaults are stock values, not inventions — assert they are in the sets the disc uses.
const sizes = (pred) => [...new Set(recs.filter(pred).map((r) => r.rad))].sort((a, b) => a - b);
const areaSizes = sizes((r) => (r.f14 & AREA_BIT) !== 0);
const lineSizes = sizes((r) => !(r.f14 & AREA_BIT) && (((r.f14 >> 8) & 0x7F) & LINE_BIT) !== 0);
check("stock area sizes are 2,3,4", areaSizes.join(",") === "2,3,4", areaSizes.join(","));
check("stock line sizes are 1,3", lineSizes.join(",") === "1,3", lineSizes.join(","));
check("AREA_RADIUS is one the disc uses", areaSizes.includes(AREA_RADIUS));
check("LINE_RADIUS is one the disc uses", lineSizes.includes(LINE_RADIUS));
// Every one of the 12 area unites is 3, which is why one default serves both tables.
const uniteAreaSizes = sizes((r) => r.tbl === "unite" && (r.f14 & AREA_BIT) !== 0);
check("every area unite is radius 3", uniteAreaSizes.join(",") === "3", uniteAreaSizes.join(","));

// ---- the case that produced the size-zero area ---------------------------------------------
// Flaming Arrows is spell row 0: the plain single-target 0x0A shape, radius 0, and the row the
// e2e drives. Explosion is row 3, the top of the graded fire family (2 -> 3 -> 4).
const fa = u32(SPELL.off + 0x14), faRad = u8(SPELL.off + SPELL.radius);
check("Flaming Arrows ships single-target, radius 0", fa === 0x00000A0A && faRad === 0, `${hx(fa)} r${faRad}`);
check("turning its AOE on now fills a size", radiusFix("spell", 0, faRad, (fa | AREA_BIT) >>> 0)?.radius === AREA_RADIUS);

const ex = u32(SPELL.off + 3 * SPELL.stride + 0x14), exRad = u8(SPELL.off + 3 * SPELL.stride + SPELL.radius);
check("Explosion ships area, radius 4", (ex & AREA_BIT) !== 0 && exRad === 4, `${hx(ex)} r${exRad}`);
check("Explosion's authored 4 survives an unrelated Target change",
  radiusFix("spell", 3, exRad, ((ex & 0xFFFF80FF) | (0x02 << 8)) >>> 0) === null);
check("Explosion turned single-target loses its size",
  radiusFix("spell", 3, exRad, ((ex & 0xFFFF80FF & ~AREA_BIT) | (0x0A << 8)) >>> 0)?.radius === 0);

// A LINE spell is the case the Target dropdown alone can strand, with the AREA bit never moving.
const tr = u32(SPELL.off + 6 * SPELL.stride + 0x14), trRad = u8(SPELL.off + 6 * SPELL.stride + SPELL.radius);
check("Thunder Runner ships line-of-foes, radius 1", ((tr >> 8) & 0x7F) === 0x12 && trRad === 1, `${hx(tr)} r${trRad}`);
check("Thunder Runner turned single-target loses its size",
  radiusFix("spell", 6, trRad, ((tr & 0xFFFF80FF) | (0x0A << 8)) >>> 0)?.radius === 0);
check("and a single-target spell made a line gains one",
  radiusFix("spell", 0, faRad, ((fa & 0xFFFF80FF) | (0x12 << 8)) >>> 0)?.radius === LINE_RADIUS);

// Mercenary B is unite row 0: area, radius 3 — the shape every area unite has.
const mb = u32(UNITE.off + 0x14), mbRad = u8(UNITE.off + UNITE.radius);
check("Mercenary B ships area, radius 3", (mb & AREA_BIT) !== 0 && mbRad === 3, `${hx(mb)} r${mbRad}`);
check("turning a unite's AOE off clears its size",
  radiusFix("unite", 0, mbRad, (mb & ~AREA_BIT) >>> 0)?.radius === 0);

fs.closeSync(fd);
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
