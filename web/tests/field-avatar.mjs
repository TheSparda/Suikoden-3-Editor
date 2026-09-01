// The field-character gate: the ISO patch that decides who you can walk around the map as.
//
// Two failure modes are worth a test, and neither shows up in a browser.
//
// 1. **Restated data drifting.** `web/iso.js` cannot ask the save engine anything, so it
//    restates `s3save.PARTY_IDS` (model id -> roster slot) and `FIELD_AVATAR_IDS` (the
//    loader's whitelist). A change to either in Python would leave the ISO tab labelling
//    every chip with the wrong name, and it would look completely plausible. Both are
//    parsed back out of `Editor/s3save.py` here and compared.
//
// 2. **The simulation lying.** The tab tells the user which ids are loadable by re-running
//    the game's own comparison chain over the bytes it just wrote. That readout is the only
//    feedback there is — nothing else says whether a patch worked — so it is exercised
//    against the stock immediates (must reproduce the whitelist exactly) and against the
//    widened ones (must admit every battle id, and still not admit 0).
//
// When a pristine ISO is reachable the stock words are also read off the disc, which is what
// turns "these constants are self-consistent" into "these constants are this disc's".
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { MOVESPD_RUN as SPD_RUN, MOVESPD_CLASS as SPD_CLASS } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let fails = 0;
const check = (n, c, extra) => {
  console.log(`  ${c ? "✓" : "✗"} ${n}${extra != null ? " — " + extra : ""}`);
  if (!c) fails++;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- pull AVATAR out of iso.js ----------------------------------------------
// iso.js is a browser IIFE with no exports; the block is a plain object literal, so it is
// sliced out by its own delimiters and evaluated. Fragile on purpose: if the constant is
// renamed or restructured this fails loudly rather than silently testing nothing.
const isoSrc = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
const start = isoSrc.indexOf("const AVATAR = {");
if (start < 0) { console.error("FAIL: no `const AVATAR = {` in web/iso.js"); process.exit(1); }
const end = isoSrc.indexOf("\n  };", start);
const AVATAR = eval("(" + isoSrc.slice(start + "const AVATAR = ".length, end + "\n  }".length) + ")");

// ---- pull the same facts out of s3save.py -----------------------------------
const pySrc = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
const pyList = (name) => {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*[\\[(]([^\\])]*)[\\])]`, "m"));
  if (!m) return null;
  return m[1].split(",").map((t) => t.trim()).filter(Boolean).map(Number);
};
const PY_PARTY_IDS = pyList("PARTY_IDS");
const PY_AVATARS = pyList("FIELD_AVATAR_IDS");

console.log("Restated tables match Editor/s3save.py:");
check("PARTY_IDS parsed out of s3save.py", Array.isArray(PY_PARTY_IDS) && PY_PARTY_IDS.length === 75,
  PY_PARTY_IDS && PY_PARTY_IDS.length);
check("FIELD_AVATAR_IDS parsed out of s3save.py", Array.isArray(PY_AVATARS) && PY_AVATARS.length === 8,
  PY_AVATARS && PY_AVATARS.length);
check("iso.js AVATAR.PARTY_IDS matches s3save.PARTY_IDS", eq(AVATAR.PARTY_IDS, PY_PARTY_IDS));
check("iso.js AVATAR.STOCK_SET matches s3save.FIELD_AVATAR_IDS", eq(AVATAR.STOCK_SET, PY_AVATARS));
check("WIDE is one past the last battle id",
  AVATAR.WIDE === PY_PARTY_IDS[PY_PARTY_IDS.length - 1] + 1, AVATAR.WIDE);

// ---- the chain, as drawAvatar simulates it ----------------------------------
// Mirrors avatarAllows() against a plain {offset: value} map instead of the ISO buffer.
function allows(mem, id) {
  const [gHi, gLo] = AVATAR.gates.map((g) => mem[g.off]);
  const [eq0, eq1, eq2] = AVATAR.slots.map((s) => mem[s.off]);
  if (id === eq0) return true;
  if (id < gHi) {
    if (id === 0) return false;
    if (id < gLo) return true;
    return id === eq2;
  }
  if (id === eq1) return true;
  if (id < mem[AVATAR.lo]) return false;
  if (id >= mem[AVATAR.hiTop]) return false;
  if (id < mem[AVATAR.hiBot]) return false;
  return true;
}
const allowedIds = (mem) => {
  const out = [];
  for (let id = 1; id <= 0xD7; id++) if (allows(mem, id)) out.push(id);
  return out;
};
const STOCK_MEM = Object.fromEntries(
  AVATAR.gates.concat(AVATAR.slots).map((s) => [s.off, s.stock])
    .concat([[AVATAR.lo, 0x3F], [AVATAR.hiTop, 0xCC], [AVATAR.hiBot, 0xCA]]));

console.log("The gate, evaluated:");
const stockAllowed = allowedIds(STOCK_MEM);
check("stock immediates admit exactly the eight whitelisted ids", eq(stockAllowed, PY_AVATARS),
  JSON.stringify(stockAllowed));
check("stock immediates reject Sarah (66)", !allows(STOCK_MEM, 66));
check("id 0 is never admitted", !allows(STOCK_MEM, 0));

const wideMem = Object.assign({}, STOCK_MEM);
AVATAR.gates.forEach((g) => (wideMem[g.off] = AVATAR.WIDE));
const wideAllowed = allowedIds(wideMem);
check("widening both bounds admits every battle character",
  PY_PARTY_IDS.every((id) => wideAllowed.includes(id)));
check("...including Sarah, the one the stock list omits", allows(wideMem, 66));
check("...and still not id 0", !allows(wideMem, 0));
check("...and the two specials survive the widening",
  allows(wideMem, 0xCA) && allows(wideMem, 0xCB));
// The gap ids (12, 33, 37-39, 43, 64) are not party ids, so admitting them is harmless —
// but the count is pinned so a bound typo that admits hundreds of ids can't pass quietly.
check("widening admits the 82-id run plus the two specials, nothing more",
  wideAllowed.length === 82 + 2, wideAllowed.length);

// ---- the save editor's picker labelling -------------------------------------
// The Overview picker offers all 75 battle characters and marks which ones the engine will
// actually load. Get that backwards and the tab quietly promises a swap that never happens,
// so the grouping is asserted rather than eyeballed. avatarList() is sliced out of app.js
// and run against stubbed globals; it touches REF, CHAR_LIST and avatarAreaInfo — the last
// one backed by the real coverage file, so the note it builds is exercised, not stubbed away.
const appSrc = fs.readFileSync(path.join(REPO, "web", "app.js"), "utf8");
const fnStart = appSrc.indexOf("function avatarList(");
if (fnStart < 0) { console.error("FAIL: no avatarList() in web/app.js"); process.exit(1); }
const fnEnd = appSrc.indexOf("\n}", fnStart);
const NAMES = Object.fromEntries(PY_PARTY_IDS.map((id, i) => [id, `Char${i + 1}`]));
Object.assign(NAMES, { 202: "Masked Luc", 203: "Grasslands Chris" });
const AREAS = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_avatar_areas.json"), "utf8"));
const areaInfo = (id) => { const m = (AREAS.byModel || {})[String(id)];
  return m && Array.isArray(m.areas) ? { areas: m.areas, total: (AREAS.archives || []).length } : null; };
// STORY_SAFE lives beside avatarList rather than inside it, so it is parsed out of app.js
// too — restating the four here would let the two drift without a test noticing.
const safeM = appSrc.match(/const STORY_SAFE = new Set\(\[([^\]]*)\]\)/);
if (!safeM) { console.error("FAIL: no STORY_SAFE in web/app.js"); process.exit(1); }
const STORY_SAFE = new Set(safeM[1].split(",").map((t) => Number(t.trim())).filter((n) => !isNaN(n)));
const avatarList = new Function("REF", "CHAR_LIST", "avatarAreaInfo", "STORY_SAFE",
  appSrc.slice(fnStart, fnEnd + 2) + "\nreturn avatarList;")(
  { fieldAvatars: PY_AVATARS, charById: NAMES },
  PY_PARTY_IDS.map((id) => ({ id, name: NAMES[id] })),
  areaInfo, STORY_SAFE);

console.log("Save-editor picker labelling:");
{ const list = avatarList(1);
  // The picker deliberately offers ONLY what the engine ships. Widening the whitelist is an
  // ISO experiment that hangs scenes, so a regression that re-exposed all 75 here would put
  // known-broken picks in front of someone editing a save.
  check("only the shipped avatars are offered", eq(list.map((r) => r.id), PY_AVATARS),
    JSON.stringify(list.map((r) => r.id)));
  check("Sarah is NOT offered (she needs the ISO experiment)", !list.some((r) => r.id === 66));
  check("no unpatched character is offered",
    !list.some((r) => !PY_AVATARS.includes(r.id)));
  // Being shipped is not the same as being story-safe — Koroku hangs scenes and is shipped.
  const prot = list.filter((r) => r.cat === "protagonist").map((r) => r.id);
  check("STORY_SAFE is exactly the four protagonists",
    eq([...STORY_SAFE].sort((a, b) => a - b), [1, 2, 3, 29]), JSON.stringify([...STORY_SAFE]));
  check("the four protagonists are marked as such", eq(prot, [1, 2, 3, 29]), JSON.stringify(prot));
  check("the rest are marked roaming only",
    list.filter((r) => r.cat === "roaming only").every((r) => !([1, 2, 3, 29].includes(r.id))));
  check("Koroku is shipped but not story-safe",
    (list.find((r) => r.id === 54) || {}).cat === "roaming only");
  check("nobody is listed twice", new Set(list.map((r) => r.id)).size === list.length);
  check("every row carries a note explaining its group", list.every((r) => r.desc && r.cat));
  // The coverage warning has to reach the row the user reads, not just exist in the file.
  const luc = list.find((r) => r.id === 63);
  check("a row states how many maps ship that field model", /ships in \d+\/28 maps/.test(luc.desc), luc.desc);
  check("...and names them", /ZKTR/.test(luc.desc));
  const thomas = list.find((r) => r.id === 29);
  check("the most map-limited avatar reports its small count", /ships in 5\/28 maps/.test(thomas.desc), thomas.desc);
  check("roaming picks say scenes can hang", /scenes can hang/.test(list.find((r) => r.id === 54).desc)); }
{ // A save whose leader the picker does not offer (a dog, a special) must still show what it
  // holds — dropping it would silently rewrite the save on the next Apply.
  const list = avatarList(0xD2);
  check("an unofferable current value is kept at the top", list[0].id === 0xD2 && list[0].cat === "current"); }

// ---- the story-content switch ------------------------------------------------
// Retiring a case only works because the switch's own default resolves to index 0 (Hugo).
// If a future edit ever gave a case index 0 of its own, or duplicated an id, the control
// would silently do nothing — so the shape it depends on is asserted, not assumed.
console.log("Story-content switch:");
{ const cs = AVATAR.STORY.cases;
  check("nine cases, one per known leader", cs.length === 9, cs.length);
  check("Hugo is the fallback and is not editable",
    cs.filter((c) => c.fixed).length === 1 && cs.find((c) => c.fixed).id === 1
      && cs.find((c) => c.fixed).idx === 0);
  check("every editable case has a non-zero index (so retiring it changes something)",
    cs.filter((c) => !c.fixed).every((c) => c.idx !== 0));
  check("no id appears twice", new Set(cs.map((c) => c.id)).size === cs.length);
  check("offsets are distinct", new Set(cs.map((c) => c.off)).size === cs.length);
  check("Luc, Koroku, Sarah and Masked Luc all have their own index",
    [0x3F, 0x36, 0x42, 0xCA].every((id) => (cs.find((c) => c.id === id) || {}).idx > 0));
  check("the retire value is unreachable for a leader byte", AVATAR.STORY.OFF > 0xFF);
  // The whole point: the ids this control covers must be leaders the engine will draw,
  // or the user is switching story content for a character they cannot play as.
  const drawable = new Set(PY_AVATARS);
  const covered = cs.filter((c) => !c.fixed && drawable.has(c.id)).map((c) => c.id);
  check("it covers the whitelisted avatars that have their own story index",
    covered.includes(0x3F) && covered.includes(0x36) && covered.includes(0xCA) && covered.includes(0xCB),
    JSON.stringify(covered)); }

// ---- per-map coverage data ---------------------------------------------------
// The picker's "ships in N of 28 maps" note is only as good as this file; a truncated or
// stale one would read as "this character is everywhere" rather than as missing data.
console.log("Per-map coverage data:");
{ const areas = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_avatar_areas.json"), "utf8"));
  check("28 area archives listed", (areas.archives || []).length === 28, (areas.archives || []).length);
  const bm = areas.byModel || {};
  check("every battle character has an entry", PY_PARTY_IDS.every((id) => bm[String(id)]));
  check("every whitelisted avatar has an entry", PY_AVATARS.every((id) => bm[String(id)]));
  check("each entry names a model code and an area list",
    Object.values(bm).every((m) => typeof m.code === "string" && m.code.length === 4 && Array.isArray(m.areas)));
  check("every listed area is a real archive",
    Object.values(bm).every((m) => m.areas.every((a) => areas.archives.includes(a))));
  // The observation that motivated the whole section: Plain Amur is an archive that carries
  // Luc but not Masked Luc, and at least one such archive must exist for that to be possible.
  const luc = bm["63"].areas, mask = bm["202"].areas;
  check("some archive carries Luc but not Masked Luc",
    luc.some((a) => !mask.includes(a)), luc.filter((a) => !mask.includes(a)).join(", "));
  check("coverage is partial, not universal (a full list would mean the scan matched junk)",
    Object.values(bm).every((m) => m.areas.length < 28)); }

// ---- the scene-softlock actor fallback ---------------------------------------
// Two words, and both have to move together: leaving `move $v0,$zero` in place after the
// jump would put a stray instruction in the delay slot, and leaving `jr $ra` would mean the
// toggle silently does nothing. The jump target is decoded back out of the J-type word so a
// mistyped constant cannot pass as "points at the player lookup".
console.log("Scene-softlock actor fallback:");
{ const fb = AVATAR.ACTORFB;
  check("both instructions of the exit are covered", fb.sites.length === 2);
  check("the stock exit is jr $ra + a move", fb.sites[0].stock === 0x03E00008
    && (fb.sites[1].stock & 0xFFFF) === 0x102D, fb.sites.map((f) => f.stock.toString(16)).join(" "));
  const j = fb.sites[0].alt;
  check("the replacement is a J-type jump", (j >>> 26) === 2, (j >>> 26));
  check("...whose target is the player lookup", ((j & 0x03FFFFFF) << 2) === fb.target,
    "0x" + (((j & 0x03FFFFFF) << 2) >>> 0).toString(16).toUpperCase());
  check("the delay slot becomes a nop", fb.sites[1].alt === 0);
  check("stock and patched differ at both sites", fb.sites.every((f) => f.stock !== f.alt)); }

// ---- movement rules: what counts as walking / running ------------------------
// These decide whether a random encounter is even rolled. Getting a length wrong turns a
// setting into "no encounters ever" without any error, so the immediates and the two
// run-range modes are pinned, and the disc check below confirms them byte for byte.
const encStart = isoSrc.indexOf("const ENCMOVE = {");
if (encStart < 0) { console.error("FAIL: no `const ENCMOVE = {` in web/iso.js"); process.exit(1); }
const encEnd = isoSrc.indexOf("\n  };", encStart);
const ENCMOVE = eval("(" + isoSrc.slice(encStart + "const ENCMOVE = ".length, encEnd + "\n  }".length) + ")");

console.log("Movement rules:");
{ const all = ENCMOVE.walk.concat(ENCMOVE.run);
  check("three walk ranges and two run ranges", ENCMOVE.walk.length === 3 && ENCMOVE.run.length === 2);
  check("every range has a non-zero stock length", all.every((r) => r.stock > 0));
  check("offsets are distinct",
    new Set(all.map((r) => r.off).concat([ENCMOVE.runAlt.base.off, ENCMOVE.runAlt.len.off])).size === all.length + 2);
  check("kind-2 ranges use the $v1 form, the rest $v0",
    ENCMOVE.walk[2].opc === 0x2C63 && ENCMOVE.run[1].opc === 0x2C63
      && ENCMOVE.walk[0].opc === 0x2C42 && ENCMOVE.run[0].opc === 0x2C42);
  const stock = ENCMOVE.runAlt.modes.find((m) => m.key === "stock");
  const animal = ENCMOVE.runAlt.modes.find((m) => m.key === "animal");
  check("the stock second run range is the mounted fast-move pair",
    stock.base === 0x45 && stock.len === 2);
  // 0x11A-0x11F is run_start / run_loop / run_stop in the animal block — the slots Koroku
  // and Fubar actually play, and the reason running never rolled for them.
  check("the animal mode covers exactly slots 0x11A-0x11F",
    animal.base === 0x11A && animal.len === 6);
  check("the two modes do not overlap",
    animal.base >= stock.base + stock.len || stock.base >= animal.base + animal.len);
  check("switching modes never revives a disabled test (both lengths non-zero)",
    stock.len > 0 && animal.len > 0);
  // Turning a group off means zeroing every one of its lengths; missing one leaves the
  // setting half-applied and silently still firing.
  check("walking covers all three of its ranges", ENCMOVE.walk.length === 3);
  check("running covers its own ranges plus the second-range length",
    ENCMOVE.run.length + 1 === 3); }

// ---- movement speed: the walk/run table and the per-character class ----------
// This one is pure data, so the risk is different from the patch sites above: nothing here
// would throw or look wrong in the browser if an offset drifted — it would quietly edit
// whatever else lives at 0x3B0BE0. The stride/offsets are pinned here, and the disc check
// below reads the actual floats back and compares them to what the fixture plants, so the
// editor, the test ISO and the real disc can never disagree without failing.
const spdStart = isoSrc.indexOf("const MOVESPD = {");
if (spdStart < 0) { console.error("FAIL: no `const MOVESPD = {` in web/iso.js"); process.exit(1); }
const spdEnd = isoSrc.indexOf("\n  };", spdStart);
const MOVESPD = eval("(" + isoSrc.slice(spdStart + "const MOVESPD = ".length, spdEnd + "\n  }".length) + ")");

console.log("Movement speed:");
{ check("14 records of 16 bytes", MOVESPD.rows === 14 && MOVESPD.stride === 16);
  check("three float columns at +4/+8/+0x0C, leaving the id field at +0 alone",
    eq(MOVESPD.cols.map((c) => c.off), [4, 8, 12]));
  // The id field is the per-model override list's key; writing one would switch that scan on.
  check("no column touches the record's id field", MOVESPD.cols.every((c) => c.off >= 4));
  check("the class byte sits inside a list2 record", MOVESPD.classOff > 0 && MOVESPD.classOff < 132);
  check("the assigned-horse field is not the class byte", MOVESPD.classOff !== 0x66);
  check("the last selectable class is the last row", MOVESPD.MAXCLASS === MOVESPD.rows - 1);
  check("stock walk/run/rate are recorded", eq(MOVESPD.cols.map((c) => c.stock), [2, 6, 1]));
  check("the level-everyone target is the fastest stock run speed", MOVESPD.LEVEL === 6);
  check("the sanity clamp leaves room above the fastest stock speed", MOVESPD.MAX > 6); }

// ---- encounter rate: the three per-movement multipliers ----------------------
// The walking multiplier does not exist on disc — walking skips the multiply entirely — so
// making it configurable means rewriting two words, and a wrong branch target would send the
// roll into the middle of the block. The stock triple must round-trip to the stock words
// byte for byte, or "restore" would leave a rewritten-but-equivalent encounter routine staged.
const encRateStart = isoSrc.indexOf("const ENC = {");
if (encRateStart < 0) { console.error("FAIL: no `const ENC = {` in web/iso.js"); process.exit(1); }
const encRateEnd = isoSrc.indexOf("\n  };", encRateStart);
const ENC = eval("(" + isoSrc.slice(encRateStart + "const ENC = ".length, encRateEnd + "\n  }".length) + ")");

console.log("Encounter multipliers:");
{ check("four words, four labels", ENC.sites.length === 4 && ENC.labels.length === 4);
  check("offsets are distinct and ascending", ENC.sites.every((o, i) => i === 0 || o > ENC.sites[i - 1]));
  check("stock is x1.00 walking, x1.20 running, x1.50 galloping",
    eq(ENC.STOCK_MULT, { walk: 100, run: 120, ride: 150 }));
  // Words 2 and 3 are `addiu $v0,$zero,imm` and their immediates ARE the stock multipliers.
  check("the mounted word carries 150", (ENC.stock[2] & 0xFFFF) === ENC.STOCK_MULT.ride
    && ((ENC.stock[2] & 0xFFFF0000) >>> 0) === ENC.addiuV0);
  check("the running word carries 120", (ENC.stock[3] & 0xFFFF) === ENC.STOCK_MULT.run
    && ((ENC.stock[3] & 0xFFFF0000) >>> 0) === ENC.addiuV0);
  // `move $s5,$s1` + `b`: walking has no multiplier of its own until the editor gives it one.
  check("walking ships as a move + branch, not an immediate",
    ENC.stock[0] === 0x0220A82D && ENC.stock[1] === 0x10000012);
  // b past the block vs b into it: the two targets must differ by exactly the skipped words.
  check("the editor's branch lands earlier than the stock one",
    (ENC.brJoin & 0xFFFF) < (ENC.stock[1] & 0xFFFF));
  const mult = (m) => {
    const c = (v) => Math.max(0, Math.min(ENC.max, Math.round(+v || 0)));
    const w = c(m.walk), r = c(m.run), d = c(m.ride), s = ENC.STOCK_MULT;
    const head = w === s.walk ? [ENC.stock[0], ENC.stock[1]] : [(ENC.addiuV0 | w) >>> 0, ENC.brJoin];
    return head.concat([(ENC.addiuV0 | d) >>> 0, (ENC.addiuV0 | r) >>> 0]);
  };
  check("the stock triple re-encodes to the stock words byte for byte",
    eq(mult(ENC.STOCK_MULT), ENC.stock));
  check("a custom triple lands its values in the right three words",
    eq(mult({ walk: 10, run: 20, ride: 30 }),
       [(ENC.addiuV0 | 10) >>> 0, ENC.brJoin, (ENC.addiuV0 | 30) >>> 0, (ENC.addiuV0 | 20) >>> 0]));
  // Only walking needs the two-word rewrite, so leaving it at x1.00 must not stage it.
  check("a stock walking multiplier keeps the original move + branch",
    eq(mult({ walk: 100, run: 20, ride: 30 }).slice(0, 2), ENC.stock.slice(0, 2)));
  check("multipliers clamp instead of wrapping into the opcode",
    (mult({ walk: 99999, run: 0, ride: 0 })[0] & 0xFFFF) === ENC.max); }

// ---- against a real disc, when one is here ----------------------------------
// ISO/ sits inside the checkout and is gitignored. In a git worktree it is only in the
// MAIN checkout, so the .git pointer file is followed to find it — otherwise this check
// would silently skip in exactly the setup the repo works in.
function isoCandidates() {
  const dirs = [path.join(REPO, "ISO")];
  try {
    const dot = fs.readFileSync(path.join(REPO, ".git"), "utf8").trim();
    const m = dot.match(/^gitdir:\s*(.+)$/);
    if (m) dirs.push(path.join(path.resolve(m[1], "..", "..", ".."), "ISO"));
  } catch { /* not a worktree, or no .git file */ }
  return dirs;
}
let iso = null;
for (const dir of isoCandidates()) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".iso"));
    if (f) { iso = path.join(dir, f); break; }
  } catch { /* no ISO folder here — try the next */ }
}

console.log("Patch sites on disc:");
if (!iso) {
  console.log("  · SKIP — no ISO/ folder in the checkout, so the sites can't be byte-checked.");
} else {
  const fd = fs.openSync(iso, "r");
  const word = (off) => { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, off); return b; };
  for (const s of AVATAR.gates) {
    const b = word(s.off);
    check(`0x${s.off.toString(16).toUpperCase()} is sltiu with immediate ${s.stock}`,
      b[2] === AVATAR.ltSig[0] && b[3] === AVATAR.ltSig[1] && b.readUInt16LE(0) === s.stock,
      b.toString("hex"));
  }
  for (const s of AVATAR.slots) {
    const b = word(s.off);
    check(`0x${s.off.toString(16).toUpperCase()} is addiu with immediate ${s.stock}`,
      b[2] === AVATAR.eqSig[0] && b[3] === AVATAR.eqSig[1] && b.readUInt16LE(0) === s.stock,
      b.toString("hex"));
  }
  for (const f of AVATAR.ACTORFB.sites) {
    const b = word(f.off);
    check(`actor-fallback site 0x${f.off.toString(16).toUpperCase()} is stock on disc`,
      b.readUInt32LE(0) === f.stock, b.toString("hex"));
  }
  for (const c of AVATAR.STORY.cases) {
    const b = word(c.off);
    check(`story case 0x${c.off.toString(16).toUpperCase()} is addiu with id ${c.id} (index ${c.idx})`,
      b[2] === AVATAR.eqSig[0] && b[3] === AVATAR.eqSig[1] && b.readUInt16LE(0) === c.id,
      b.toString("hex"));
  }
  for (const r of ENCMOVE.walk.concat(ENCMOVE.run)) {
    const b = word(r.off);
    check(`movement range 0x${r.off.toString(16).toUpperCase()} is length ${r.stock} (${r.what})`,
      b.readUInt16LE(2) === r.opc && b.readUInt16LE(0) === r.stock, b.toString("hex"));
  }
  { const sm = ENCMOVE.runAlt.modes.find((m) => m.key === "stock");
    const bb = word(ENCMOVE.runAlt.base.off), lb = word(ENCMOVE.runAlt.len.off);
    check("the second run range is stock on disc (base -0x45, length 2)",
      bb.readUInt16LE(2) === ENCMOVE.runAlt.base.opc && ((-bb.readInt16LE(0)) & 0xFFFF) === sm.base
        && lb.readUInt16LE(2) === ENCMOVE.runAlt.len.opc && lb.readUInt16LE(0) === sm.len,
      bb.toString("hex") + " " + lb.toString("hex")); }
  // The movement-speed table, read as floats straight off the disc. MOVESPD_RUN /
  // MOVESPD_CLASS in the test fixture are what the browser test asserts against, so if the
  // disc ever disagrees with them the fixture is lying and every UI check built on it is too.
  { const f32 = (off) => { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, off); return b.readFloatLE(0); };
    const u32 = (off) => { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, off); return b.readUInt32LE(0); };
    const runs = [], ids = [];
    let walkOk = true, rateOk = true;
    for (let c = 0; c < MOVESPD.rows; c++) {
      const rec = MOVESPD.tbl + c * MOVESPD.stride;
      ids.push(u32(rec));
      if (f32(rec + 4) !== 2) walkOk = false;
      if (f32(rec + 12) !== 1) rateOk = false;
      runs.push(f32(rec + 8));
    }
    check("every speed record's id field is zero (the override list stays terminated)",
      ids.every((v) => v === 0));
    check("walking is 2.0 for every class on disc", walkOk);
    check("the time scale is 1.0 for every class on disc", rateOk);
    check("run speeds match the fixture", eq(runs, SPD_RUN), runs.join(", "));
    // Hugo's class outruns Chris's by exactly the amount players notice.
    const cls = (rec) => { const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, 4068152 + rec * 132 + MOVESPD.classOff); return b[0]; };
    const got = {};
    for (let rec = 0; rec < 80; rec++) got[rec] = cls(rec);
    check("the movement class of all 80 list2 records matches the fixture", eq(got, SPD_CLASS));
    check("Hugo (rec 1) runs faster than Chris (rec 2)", runs[got[1]] > runs[got[2]],
      `${runs[got[1]]} vs ${runs[got[2]]}`);
    check("Geddoe (rec 3) sits between them",
      runs[got[3]] < runs[got[1]] && runs[got[3]] > runs[got[2]]);
    check("the mounts share one class", got[8] === got[31] && got[31] === got[37]); }
  // The encounter-rate words the multipliers ride on.
  ENC.sites.forEach((off, i) => {
    check(`encounter word 0x${off.toString(16).toUpperCase()} is stock (${ENC.labels[i]})`,
      word(off).readUInt32LE(0) === ENC.stock[i], word(off).toString("hex"));
  });
  for (const [off, want] of [[AVATAR.lo, 0x3F], [AVATAR.hiTop, 0xCC], [AVATAR.hiBot, 0xCA]]) {
    const b = word(off);
    check(`0x${off.toString(16).toUpperCase()} is sltiu with immediate ${want} (read-only half)`,
      b[2] === AVATAR.ltSig[0] && b[3] === AVATAR.ltSig[1] && b.readUInt16LE(0) === want,
      b.toString("hex"));
  }
  fs.closeSync(fd);
}

console.log(fails ? `\n${fails} field-avatar check(s) FAILED.` : "\nAll field-avatar checks passed.");
process.exit(fails ? 1 : 0);
