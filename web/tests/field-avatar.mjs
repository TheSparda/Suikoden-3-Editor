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
// and run against stubbed globals; it touches only REF and CHAR_LIST.
const appSrc = fs.readFileSync(path.join(REPO, "web", "app.js"), "utf8");
const fnStart = appSrc.indexOf("function avatarList(");
if (fnStart < 0) { console.error("FAIL: no avatarList() in web/app.js"); process.exit(1); }
const fnEnd = appSrc.indexOf("\n}", fnStart);
const NAMES = Object.fromEntries(PY_PARTY_IDS.map((id, i) => [id, `Char${i + 1}`]));
Object.assign(NAMES, { 202: "Masked Luc", 203: "Grasslands Chris" });
const avatarList = new Function("REF", "CHAR_LIST",
  appSrc.slice(fnStart, fnEnd + 2) + "\nreturn avatarList;")(
  { fieldAvatars: PY_AVATARS, charById: NAMES },
  PY_PARTY_IDS.map((id) => ({ id, name: NAMES[id] })));

console.log("Save-editor picker labelling:");
{ const list = avatarList(1);
  const wl = list.filter((r) => r.cat === "engine default").map((r) => r.id);
  check("the whitelisted eight are grouped as engine defaults", eq(wl, PY_AVATARS), JSON.stringify(wl));
  check("they are offered first", eq(list.slice(0, 8).map((r) => r.id), PY_AVATARS));
  const patchNeeded = list.filter((r) => r.cat === "needs ISO patch").map((r) => r.id);
  check("every other battle character is offered as needs-ISO-patch",
    eq(patchNeeded, PY_PARTY_IDS.filter((id) => !PY_AVATARS.includes(id))));
  check("Sarah is offered, marked needs-ISO-patch", patchNeeded.includes(66));
  check("nobody is listed twice", new Set(list.map((r) => r.id)).size === list.length);
  check("every row carries a note explaining its group", list.every((r) => r.desc && r.cat)); }
{ // A save whose leader the picker does not offer (a dog, a special) must still show what it
  // holds — dropping it would silently rewrite the save on the next Apply.
  const list = avatarList(0xD2);
  check("an unofferable current value is kept at the top", list[0].id === 0xD2 && list[0].cat === "current"); }

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
