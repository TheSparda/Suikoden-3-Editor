// The Party formation card: the six ISO settings that can change who joins your party, and
// the one-click restore that puts them back.
//
// The card's whole selling point is that it needs no base disc — every site names its own
// stock value inline. That makes the pinned constants load-bearing in a way the rest of the
// editor's are not: a wrong one here does not fail to apply, it QUIETLY WRITES THE WRONG
// BYTE over working code, in the one feature someone reaches for because their disc is
// already broken. So this test does three things:
//
//   1. Reads every pinned stock value back off the pristine disc in ISO/ when one is
//      present. That is what turns "these constants agree with each other" into "these
//      constants are this disc's".
//   2. Pins the claim the assigned-horse restore rests on: EXACTLY six of the 80 list2
//      records carry a nonzero +0x66 on a stock disc. Zeroing the other 74 is only safe
//      because of that, and it used to be a line of prose in MOUNT_SYSTEM_RESEARCH.
//   3. Checks the shape of the site set with no disc at all — in bounds, aligned, and
//      non-overlapping, which is the contract chgRegions' region map is asserted against.
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

// ---- pull the constants out of iso.js ---------------------------------------
// Same trick the field-avatar test uses: iso.js is a browser IIFE with no exports, so each
// block is sliced out by its own delimiters and evaluated. Fragile on purpose — a renamed
// or restructured constant fails loudly here rather than silently testing nothing.
const isoSrc = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
// Balanced-delimiter scan from the { or [ the declaration ends on, skipping over strings,
// template literals and comments so a brace inside prose can't close the literal early.
// (PARTYFIX's help text is full of them.)
function literal(decl) {
  const start = isoSrc.indexOf(decl);
  if (start < 0) { console.error(`FAIL: no \`${decl}\` in web/iso.js`); process.exit(1); }
  const i0 = start + decl.length - 1;
  let depth = 0, i = i0;
  for (; i < isoSrc.length; i++) {
    const c = isoSrc[i], d = isoSrc[i + 1];
    if (c === "/" && d === "/") { i = isoSrc.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && d === "*") { i = isoSrc.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < isoSrc.length && isoSrc[i] !== c; i++) if (isoSrc[i] === "\\") i++;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth === 0) break; }
  }
  if (depth !== 0) { console.error(`FAIL: \`${decl}\` is not balanced in web/iso.js`); process.exit(1); }
  return eval("(" + isoSrc.slice(i0, i + 1) + ")");
}
const MOUNTS = literal("const MOUNTS = {");
const AVATAR = literal("const AVATAR = {");
const PARTYFIX = literal("const PARTYFIX = [");
const TABLES = literal("const TABLES = {");
const LIST_COUNT = literal("const LIST_COUNT = {");

const ELF_BASE = 0xA4800, ELF_END = 0x465DF0;

// ---- the site set, resolved the same way iso.js resolves it -----------------
// Kept as its own copy rather than imported: partyFixSites() reads REF names and the live
// buffer, neither of which exists in Node. What matters is that the OFFSETS and STOCK
// VALUES match, and those come from the same constants above.
function sites(key) {
  const out = [];
  if (key === "horse") {
    const [b, st] = TABLES.list2;
    for (let i = 0; i < LIST_COUNT.list2; i++)
      out.push({ off: b + i * st + MOUNTS.horse.off, w: 2, stock: MOUNTS.horse.STOCK[i] || 0, rec: i });
  } else if (key === "clamp") {
    MOUNTS.horseClamp.sites.forEach((c) => out.push({ off: c.off, w: 4, stock: c.stock >>> 0, alt: c.alt >>> 0 }));
  } else if (key === "pairs") {
    MOUNTS.pairs.forEach((p, i) => {
      p.riderSites.forEach((o) => out.push({ off: o, w: 2, stock: MOUNTS.STOCK[i][0] }));
      out.push({ off: p.mountSite, w: 2, stock: MOUNTS.STOCK[i][1] });
    });
  } else if (key === "avatar") {
    AVATAR.gates.forEach((g) => out.push({ off: g.off, w: 2, stock: g.stock }));
    AVATAR.slots.forEach((s) => out.push({ off: s.off, w: 2, stock: s.stock }));
  } else if (key === "actorfb") {
    AVATAR.ACTORFB.sites.forEach((s) => out.push({ off: s.off, w: 4, stock: s.stock >>> 0, alt: s.alt >>> 0 }));
  } else if (key === "story") {
    AVATAR.STORY.cases.forEach((c) => out.push({ off: c.off, w: 2, stock: c.id }));
  }
  return out;
}

console.log("The card covers the settings it claims to:");
const KEYS = ["horse", "clamp", "pairs", "avatar", "actorfb", "story"];
check("PARTYFIX lists exactly the six party-formation settings",
  PARTYFIX.length === 6 && KEYS.every((k) => PARTYFIX.some((g) => g.key === k)),
  PARTYFIX.map((g) => g.key).join(", "));
check("every entry carries the prose the card renders",
  PARTYFIX.every((g) => g.title && g.group && g.what && g.breaks && g.restores));
// Story routing is a FIX (it is what makes empty dialogue boxes render), so undoing it in a
// blanket "restore everything" would silently take a working setting away.
check("story routing is the only setting held back from the one-button restore",
  PARTYFIX.filter((g) => g.holdBack).map((g) => g.key).join() === "story");
check("every setting resolves at least one site",
  KEYS.every((k) => sites(k).length), KEYS.map((k) => `${k}:${sites(k).length}`).join(" "));

console.log("Site shape (no disc needed):");
const ALL = KEYS.flatMap((k) => sites(k).map((s) => ({ ...s, key: k })));
check("every site is inside the block the editor reads",
  ALL.every((s) => s.off >= ELF_BASE && s.off + s.w <= ELF_END),
  `${ALL.length} sites`);
check("every 4-byte site is word-aligned", ALL.filter((s) => s.w === 4).every((s) => s.off % 4 === 0));
check("every 2-byte site is half-word-aligned", ALL.filter((s) => s.w === 2).every((s) => s.off % 2 === 0));
// The restore writes each site independently, and chgRegions' map is asserted to be
// non-overlapping; two sites sharing a byte would break both.
{
  const sorted = ALL.slice().sort((a, b) => a.off - b.off);
  const clash = sorted.find((s, i) => i && sorted[i - 1].off + sorted[i - 1].w > s.off);
  check("no two sites share a byte", !clash, clash ? `0x${clash.off.toString(16)}` : `${ALL.length} disjoint`);
}
// A 16-bit immediate restore writes only the low half-word; if a "stock" value did not fit
// there the write would spill into the opcode and brick the instruction.
check("every 16-bit immediate's stock value fits in a half-word",
  ALL.filter((s) => s.w === 2).every((s) => s.stock >= 0 && s.stock <= 0xFFFF));
// The clamp and the actor fallback are whole-word rewrites, and both keep their opcode: the
// widened form must differ from stock in the low half only, or "restore" means something
// different from "put the immediate back".
check("the clamp's widened form differs from stock in the low half-word only",
  sites("clamp").every((s) => (s.stock & 0xFFFF0000) === (s.alt & 0xFFFF0000) && s.stock !== s.alt));

console.log("The assigned-horse claim the restore rests on:");
check("MOUNTS.horse.STOCK names six characters",
  Object.keys(MOUNTS.horse.STOCK).length === 6, Object.keys(MOUNTS.horse.STOCK).join(", "));
check("all six stock horses are inside the UNWIDENED clamp window (308-309)",
  Object.values(MOUNTS.horse.STOCK).every((v) => v === 308 || v === 309));
check("every character the Mounts tab offers a horse to is covered by the reset",
  MOUNTS.horse.riders.every(([rid]) => rid >= 0 && rid < LIST_COUNT.list2),
  `${MOUNTS.horse.riders.length} riders, list2 holds ${LIST_COUNT.list2}`);

// ---- against a real disc, when one is here ----------------------------------
// ISO/ sits inside the checkout and is gitignored. In a git worktree it is only in the MAIN
// checkout, so the .git pointer file is followed to find it — otherwise this would silently
// skip in exactly the setup the repo works in.
function isoCandidates() {
  const dirs = [path.join(REPO, "ISO")];
  try {
    const m = fs.readFileSync(path.join(REPO, ".git"), "utf8").trim().match(/^gitdir:\s*(.+)$/);
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

console.log("Stock values read back off a pristine disc:");
if (!iso) {
  console.log("  · SKIP — no ISO/ folder in the checkout, so the pinned values can't be byte-checked.");
} else {
  const fd = fs.openSync(iso, "r");
  const read = (off, w) => { const b = Buffer.alloc(w); fs.readSync(fd, b, 0, w, off); return w === 4 ? b.readUInt32LE(0) : b.readUInt16LE(0); };
  for (const key of KEYS) {
    const wrong = sites(key).filter((s) => read(s.off, s.w) !== s.stock);
    check(`${key}: all ${sites(key).length} site(s) hold their pinned stock value`, !wrong.length,
      wrong.length ? wrong.slice(0, 4).map((s) => `0x${s.off.toString(16)} want ${s.stock} got ${read(s.off, s.w)}`).join("; ") : undefined);
  }
  // The measurement itself, independent of MOUNTS.horse.STOCK: walk all 80 records and count.
  const [b, st] = TABLES.list2;
  const nonzero = [];
  for (let i = 0; i < LIST_COUNT.list2; i++) {
    const v = read(b + i * st + MOUNTS.horse.off, 2);
    if (v) nonzero.push([i, v]);
  }
  check("exactly six of the 80 list2 records carry a nonzero assigned horse on disc",
    nonzero.length === 6, nonzero.map(([i, v]) => `${i}=${v}`).join(" "));
  check("and they are the six MOUNTS.horse.STOCK names, with the same values",
    nonzero.every(([i, v]) => MOUNTS.horse.STOCK[i] === v));
  fs.closeSync(fd);
}

console.log(fails ? `\n${fails} check(s) failed` : "\nAll party-formation checks passed");
process.exit(fails ? 1 : 0);
