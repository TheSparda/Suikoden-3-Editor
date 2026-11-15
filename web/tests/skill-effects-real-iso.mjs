// Skill effects against a REAL pristine disc: the per-rank table the Skill effects
// view edits — its geometry, its 43 records' name pointers, and every series byte.
//
// Why this file exists apart from e2e.mjs: the synthetic fixture plants two records,
// so the e2e can prove the view decodes and writes — but not that the table the view
// points at is the game's own. That case rests on the 2026-11-15 verification census
// (lab SKILL_EFFECTS.md): the guide's 63 per-rank series were fingerprinted against
// the disc, 58 matched a series here exactly, 3 matched as 100 - value, 1 differed at
// a single grade, and 1 (Rune Sage A) matched nothing the guide prints. The expected
// bytes below are that census, transcribed from the pristine disc; the guide-side
// relationships (the complements, the Damage disagreement) are re-derived from
// Editor/s3_skill_ref.json at run time, so drift on either side goes red.
//
//   node web/tests/skill-effects-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/skill-effects-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

if (!fs.existsSync(ISO)) {
  console.log(`SKIP skill-effects-real-iso: no disc at ${ISO} (set S3_ISO to point at one).`);
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
const fxBlock = /const SKILLFX = \{([^}]*)\};/.exec(iso);
if (!fxBlock) { console.log("  ✗ could not find SKILLFX in web/iso.js"); process.exit(1); }
const fxNum = (k) => { const m = new RegExp(`${k}: (0x[0-9A-Fa-f]+|\\d+)`).exec(fxBlock[1]); return m ? parseInt(m[1]) : NaN; };
const FX = { off: fxNum("off"), count: fxNum("count"), stride: fxNum("stride"), a: fxNum("a"), b: fxNum("b") };
check("iso.js SKILLFX geometry is the research geometry (off 0x3F0858, 43 x 0x1C, A +0x0C, B +0x14)",
  FX.off === 0x3F0858 && FX.count === 43 && FX.stride === 0x1C && FX.a === 0x0C && FX.b === 0x14,
  `off ${hx(FX.off)} stride ${hx(FX.stride, 2)}`);

// ---- the census: every series byte on the pristine disc ------------------------------------
const EXPECTED = {
  1: { a: [5,10,17,25,36,50,70,100], b: [3,5,7,10,15,20,35,50] },
  2: { a: [5,8,12,16,20,25,30,40], b: [5,7,10,13,17,21,25,30] },
  3: { a: [3,4,7,10,15,20,35,50], b: [0,0,0,0,0,0,0,0] },
  4: { a: [5,10,15,25,35,50,70,100], b: [3,5,7,9,11,13,15,18] },
  5: { a: [5,10,15,20,25,30,40,50], b: [10,20,30,50,75,100,150,200] },
  6: { a: [5,7,9,12,14,17,20,25], b: [0,0,0,0,10,20,30,50] },
  7: { a: [5,10,20,30,50,70,80,90], b: [0,0,0,0,0,0,0,0] },
  8: { a: [2,4,6,8,13,18,25,35], b: [0,0,0,3,7,11,15,30] },
  9: { a: [2,4,6,10,15,20,30,45], b: [10,15,20,30,35,40,45,50] },
  10: { a: [2,4,7,13,22,35,50,70], b: [0,0,1,3,4,6,10,20] },
  11: { a: [2,4,8,13,20,30,50,75], b: [0,0,20,30,40,50,60,80] },
  12: { a: [10,15,20,30,45,65,100,150], b: [0,0,3,6,10,15,25,35] },
  13: { a: [5,7,10,15,20,25,35,50], b: [5,7,9,12,14,17,20,25] },
  14: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  15: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  16: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  17: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  18: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  19: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  20: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  21: { a: [5,7,10,15,20,30,50,80], b: [0,0,0,0,0,0,0,0] },
  22: { a: [95,93,90,85,80,75,65,50], b: [0,0,0,0,0,0,0,0] },
  23: { a: [90,75,60,50,40,30,20,10], b: [0,0,0,0,0,0,0,0] },
  24: { a: [90,75,60,50,40,30,20,10], b: [0,0,0,0,0,0,0,0] },
  25: { a: [3,7,12,19,26,35,50,70], b: [0,0,0,0,0,0,0,0] },
  26: { a: [5,10,15,20,30,45,70,100], b: [0,0,0,0,0,0,0,0] },
  27: { a: [20,30,40,50,65,75,85,95], b: [0,0,0,0,0,0,0,0] },
  28: { a: [20,35,50,65,80,100,120,150], b: [0,0,0,0,0,0,0,0] },
  29: { a: [5,10,15,20,25,30,40,50], b: [0,0,0,0,0,0,0,0] },
  30: { a: [5,8,12,17,23,30,40,50], b: [0,0,0,0,0,0,0,0] },
  31: { a: [2,3,4,6,8,10,15,20], b: [0,0,0,0,0,0,0,0] },
  32: { a: [20,30,40,50,65,75,90,100], b: [0,0,0,0,0,0,0,0] },
  33: { a: [3,5,7,9,13,15,20,30], b: [0,0,0,0,0,0,0,0] },
  34: { a: [2,3,4,6,8,10,12,15], b: [0,0,0,0,0,0,0,0] },
  35: { a: [2,3,4,6,8,10,12,15], b: [0,0,0,0,0,0,0,0] },
  36: { a: [3,6,10,13,16,24,30,40], b: [0,0,0,0,0,0,0,0] },
  37: { a: [20,30,40,45,50,55,60,75], b: [0,0,0,0,0,0,0,0] },
  38: { a: [20,40,60,90,120,150,170,200], b: [0,0,0,0,0,0,0,0] },
  39: { a: [3,5,7,10,15,25,35,50], b: [5,10,15,20,25,30,40,50] },
  40: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  41: { a: [10,25,40,55,65,70,75,85], b: [3,7,12,19,26,35,50,70] },
  42: { a: [10,20,30,45,60,80,90,100], b: [0,0,0,0,0,0,0,0] },
  43: { a: [5,10,15,20,25,30,40,50], b: [0,0,0,0,0,0,0,0] },
};

// ---- skill names + guide data ----------------------------------------------------------------
const names = {};
for (const line of fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_skill_ids.txt"), "latin1").split(/\r?\n/)) {
  const p = line.trim().split(/\s+/);
  if (p.length >= 2) { const id = parseInt(p[0], 16); if (!isNaN(id)) names[id] = p.slice(1).join(" "); }
}
const guide = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_skill_ref.json"), "utf8"));
const GRADES = ["E", "D", "C", "B", "B+", "A", "A+", "S"];
const guideSeries = (id, which) => {
  const fx = (guide[String(id)] || {}).effects || [];
  const e = fx[which];
  if (!e) return null;
  // Guide values carry signs the disc folds away ("+3" for Damage, "-10" for the
  // cancellation skills): parse the signed number; comparisons use it as printed,
  // and the complement checks below use its magnitude.
  return GRADES.map((g) => { const m = /^([+-]?\d+)/.exec((e.ranks || {})[g] || ""); return m ? parseInt(m[1], 10) : null; });
};

// ---- read the real disc -----------------------------------------------------------------------
const fd = fs.openSync(ISO, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
const va2off = (va) => va - 0x165D000 + 0xA4800;
const strAt = (va) => { const b = readAt(va2off(va), 40); return b.subarray(0, b.indexOf(0)).toString("latin1"); };
const rec = (id) => FX.off + (id - 1) * FX.stride;
const series = (id, base) => [...readAt(rec(id) + base, 8)];

console.log(`Skill effects vs ${path.basename(ISO)}:`);

let nameOk = 0, byteOk = 0;
// One skill is spelled differently on the disc than in the id list (the census
// recorded it — the disc drops the -ing): the comparison accepts either spelling.
const DISC_NAME = { 25: "Chant Purity" };
for (let id = 1; id <= FX.count; id++) {
  const np = readAt(rec(id), 4).readUInt32LE(0);
  // Compare case-insensitively with hyphens and spaces folded.
  const fold = (s) => s.toLowerCase().replace(/[-\s]+/g, " ").trim();
  if (fold(strAt(np)) === fold(names[id] || "") || fold(strAt(np)) === fold(DISC_NAME[id] || "\0")) nameOk++;
  const exp = EXPECTED[id];
  if (exp && series(id, FX.a).join() === exp.a.join() && series(id, FX.b).join() === exp.b.join()) byteOk++;
}
check("all 43 records' name pointers resolve to the skill names, in id order", nameOk === 43, `${nameOk}/43`);
check("all 86 series bytes match the verification census", byteOk === 43, `${byteOk}/43 skills`);

// The guide relationships the census published, re-derived live. "Verbatim" here
// reads the guide the way the census did: its sign is folded (Swing's reductions
// print as negatives, Damage's bonuses as positives) and a grade the guide leaves
// unprinted (a "—" where an effect has not started) reads as 0, which is what the
// disc stores there. On that reading 58 of the 63 series appear verbatim; the three
// complements appear as 100 - value; Damage's D grade is the one disagreement;
// Rune Sage's A matches nothing the guide prints.
let direct = 0, total = 0;
for (let id = 1; id <= FX.count; id++) {
  for (const [which, base] of [[0, FX.a], [1, FX.b]]) {
    const g = guideSeries(id, which);
    if (!g) continue;
    total++;
    if (series(id, base).every((v, i) => v === (g[i] == null ? 0 : Math.abs(g[i])))) direct++;
  }
}
check("58 of the guide's 63 series appear verbatim on the disc", direct === 58 && total === 63, `${direct}/${total}`);
for (const id of [22, 23, 24]) {
  const g = guideSeries(id, 0);
  check(`skill ${id} (${names[id]}) series A is stored as 100 - the guide value's size`,
    !!g && series(id, FX.a).every((v, i) => v === 100 - Math.abs(g[i])),
    series(id, FX.a).join("/"));
}
{
  const g = guideSeries(3, 0);
  const d = series(3, FX.a);
  check("Damage (3): the disc's D byte is 4 where the guide prints 5 — the one disagreement",
    !!g && g[1] === 5 && d[1] === 4 && d.every((v, i) => i === 1 || v === g[i]),
    `disc ${d.join("/")} vs guide ${g ? g.join("/") : "?"}`);
}
{
  const g = guideSeries(36, 0);
  check("Rune Sage (36): series A matches nothing the guide prints (kept unlabeled in the view)",
    !!g && series(36, FX.a).join() !== g.join(), series(36, FX.a).join("/"));
}
check("Repel (10): series B is a real on-disc series with no guide counterpart",
  series(10, FX.b).join() === EXPECTED[10].b.join() && guideSeries(10, 1) === null,
  series(10, FX.b).join("/"));

fs.closeSync(fd);
console.log(fails ? `\nFAILED (${fails})` : "\nAll skill-effect checks passed against the real disc.");
process.exit(fails ? 1 : 0);
