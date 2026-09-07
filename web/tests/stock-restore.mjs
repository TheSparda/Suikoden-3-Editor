// "Restore to stock" on the Changes tab, and the one property that makes it worth trusting.
//
// The code audit compares a disc against a list of stock values this repo decoded, and the
// restore button writes those same values back. That is only a *restore* if every constant
// in the list is genuinely what a pristine disc holds — otherwise the button quietly stamps
// this repo's beliefs over someone's game and calls it stock. So:
//
//   1. **Every audited constant is read off a pristine disc and compared.** This is the whole
//      test. With an ISO present it turns "these constants agree with each other" into "these
//      constants are this disc's", which is the difference between a restore and a guess.
//   2. **Every audited site is restorable.** Each one has to be a 2- or 4-byte write inside
//      the editable block, or the relocated-helper block — the three shapes chgStockRevertRow
//      knows how to put back. A site the audit can name but not restore would show a ↺ that
//      does nothing.
//   3. **The helper block round-trips.** The installed code and the dead routine it replaces
//      are stored as hex blobs; they have to be the sizes PS_HOOK claims, and the stock blob
//      has to differ from the code blob (a copy-paste slip that made them equal would make
//      "is it installed?" and "is it free?" both true and the ordering guard meaningless).
//
// The site list below mirrors chgCodeAudit's. It is a deliberate second copy: iso.js is a
// browser IIFE with no exports, and a mirror that drifts fails loudly here rather than
// letting an unverified constant reach the restore button.
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

// ---- slice the constants out of the IIFE ------------------------------------
// Brace-matched rather than terminator-matched, so a block that grows a nested object still
// comes out whole. Strings and line comments are skipped so a brace inside either can't
// close the block early.
const src = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
function grab(name) {
  const key = `const ${name} = `;
  const i = src.indexOf(key);
  if (i < 0) { console.error(`FAIL: no \`${key}\` in web/iso.js`); process.exit(1); }
  const j = i + key.length;
  const open = src[j], close = open === "{" ? "}" : "]";
  let d = 0, k = j, q = null;
  for (; k < src.length; k++) {
    const c = src[k], n = src[k + 1];
    if (q) { if (c === "\\") k++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "/" && n === "/") { k = src.indexOf("\n", k); continue; }
    if (c === open) d++;
    else if (c === close && !--d) break;
  }
  return eval("(" + src.slice(j, k + 1) + ")");
}
const SPLIT = grab("SPLIT"), MOUNTS = grab("MOUNTS"), AVATAR = grab("AVATAR");
const ENCMOVE = grab("ENCMOVE"), ENC = grab("ENC"), PS_HOOK = grab("PS_HOOK");
const PASSIVES = grab("PASSIVES"), RUNEFX = grab("RUNEFX"), STATUSFX = grab("STATUSFX");
const TABLES = grab("TABLES"), LIST_COUNT = grab("LIST_COUNT");

const ELF_BASE = 0xA4800, ELF_END = 0x465DF0, ELF_LEN = ELF_END - ELF_BASE;
const VERSION_OFF = 4136544, VERSION_VAL = 0x40A69A01;
const inBlk = (o, w) => o >= ELF_BASE && o + w <= ELF_END;
const hx = (v, n) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(n, "0");

// ---- the site list, mirroring chgCodeAudit ----------------------------------
const sites = [];
const word = (off, stock, label) => inBlk(off, 4) && sites.push({ off, w: 4, stock: stock >>> 0, label });
const imm = (off, stock, label) => inBlk(off, 2) && sites.push({ off, w: 2, stock, label });

word(SPLIT.route, SPLIT.stockRoute, "Damage+heal split · which spell");
word(SPLIT.amtSel, SPLIT.stockAmtSel, "Damage+heal split · heal selector");
word(SPLIT.amt, SPLIT.stockAmt, "Damage+heal split · heal amount");
ENC.sites.forEach((o, i) => word(o, ENC.stock[i], `Encounter rate · ${ENC.labels[i]}`));
STATUSFX.forEach((f) => f.sites.forEach(([o, w], k) => word(o, w, `Status · ${f.label} #${k + 1}`)));
RUNEFX.forEach((f) => f.sites.forEach(([o, w], k) => word(o, w, `Rune power · ${f.label} #${k + 1}`)));
AVATAR.ACTORFB.sites.forEach((s, k) => word(s.off, s.stock, `Scene actor fallback · word ${k + 1}`));
ENCMOVE.walk.concat(ENCMOVE.run).forEach((s) => imm(s.off, s.stock, `Movement rules · ${s.what}`));
imm(ENCMOVE.runAlt.base.off, (-ENCMOVE.runAlt.modes[0].base) & 0xFFFF, "Movement rules · run range base");
imm(ENCMOVE.runAlt.len.off, ENCMOVE.runAlt.modes[0].len, "Movement rules · run range length");
AVATAR.gates.forEach((g) => imm(g.off, g.stock, `Field character · ${g.label}`));
AVATAR.slots.forEach((s) => imm(s.off, s.stock, `Field character · ${s.label}`));
AVATAR.STORY.cases.forEach((c) => imm(c.off, c.id, `Story content · case ${c.id}`));
MOUNTS.pairs.forEach((p, i) => {
  imm(p.riderSites[0], MOUNTS.STOCK[i][0], `Mounts · battle pair ${i + 1} rider`);
  imm(p.mountSite, MOUNTS.STOCK[i][1], `Mounts · battle pair ${i + 1} mount`);
});
MOUNTS.horseClamp.sites.forEach((s, i) => word(s.off, s.stock, `Mounts · assigned-horse clamp ${i + 1}`));
{ const [b, st] = TABLES.list2;
  for (let id = 0; id < LIST_COUNT.list2; id++)
    imm(b + id * st + MOUNTS.horse.off, MOUNTS.horse.STOCK[id] || 0, `Mounts · assigned horse, roster ${id}`); }
word(MOUNTS.mech.pool.off, MOUNTS.mech.pool.stock, "Mounts · HP pooling");
word(MOUNTS.mech.adren.off, MOUNTS.mech.adren.stock, "Mounts · adrenaline");
word(MOUNTS.mech.roundRider.off, MOUNTS.mech.roundRider.word, "Mounts · rider rounding");
word(MOUNTS.mech.roundMount.off, MOUNTS.mech.roundMount.word, "Mounts · mount rounding");
PASSIVES.forEach((p) => p.sites.forEach((s, i) => {
  word(s.off, s.jal, `Passive ${hx(p.id, 3)} #${i + 1} · the check`);
  word(s.off + 4, s.ds, `Passive ${hx(p.id, 3)} #${i + 1} · the delay slot`);
}));

const psHex = (s) => { const a = Buffer.alloc(s.length >> 1); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.substr(i * 2, 2), 16); return a; };
const PS_STOCK = psHex(PS_HOOK.stock), PS_CODE = psHex(PS_HOOK.code);

// ---- 2. every audited site is a shape the restore can write ------------------
console.log("Every audited site is restorable:");
check(`${sites.length} sites, all 2- or 4-byte writes inside the editable block`,
  sites.length > 100 && sites.every((s) => (s.w === 2 || s.w === 4) && inBlk(s.off, s.w)),
  `${sites.length} sites`);
check("no two sites overlap (a restore can't fight itself)", (() => {
  const seen = new Map();
  for (const s of sites) for (let i = 0; i < s.w; i++) {
    if (seen.has(s.off + i)) return false;
    seen.set(s.off + i, s.label);
  }
  return true;
})());
check("every 2-byte stock value fits in a halfword",
  sites.filter((s) => s.w === 2).every((s) => s.stock >= 0 && s.stock <= 0xFFFF));

// ---- 3. the relocated-helper block ------------------------------------------
console.log("The relocated-helper block:");
check(`the dead routine is ${PS_HOOK.len} bytes, as PS_HOOK.len says`, PS_STOCK.length === PS_HOOK.len,
  `${PS_STOCK.length} bytes`);
check(`the installed code is ${PS_HOOK.maskOff} bytes, so it stops where the bitmap starts`,
  PS_CODE.length === PS_HOOK.maskOff, `${PS_CODE.length} bytes`);
check("the code and the dead routine are different bytes",
  !PS_CODE.equals(PS_STOCK.subarray(0, PS_CODE.length)));
check("the block sits inside the editable region", inBlk(PS_HOOK.off, PS_HOOK.span));
check("no audited call site lives inside the block itself",
  sites.every((s) => s.off + s.w <= PS_HOOK.off || s.off >= PS_HOOK.off + PS_HOOK.span));

// ---- 1. against a real disc, when one is here --------------------------------
// ISO/ is gitignored and, in a git worktree, only exists in the MAIN checkout — so the .git
// pointer file is followed to find it, or this would silently skip in the repo's own setup.
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
console.log("Every stock value is what a pristine disc holds:");
if (!iso) {
  console.log("  · SKIP — no ISO/ folder in the checkout, so the constants can't be byte-checked.");
} else {
  const fd = fs.openSync(iso, "r");
  const vb = Buffer.alloc(4); fs.readSync(fd, vb, 0, 4, VERSION_OFF);
  if (vb.readUInt32BE(0) !== VERSION_VAL) {
    fs.closeSync(fd);
    check(`${path.basename(iso)} is a USA SLUS-20387 disc`, false, `version word ${hx(vb.readUInt32BE(0), 8)}`);
  } else {
    const blk = Buffer.alloc(ELF_LEN); fs.readSync(fd, blk, 0, ELF_LEN, ELF_BASE); fs.closeSync(fd);
    const bad = sites.filter((s) => (s.w === 4 ? blk.readUInt32LE(s.off - ELF_BASE) >>> 0
                                               : blk.readUInt16LE(s.off - ELF_BASE)) !== s.stock);
    check(`all ${sites.length} audited constants match ${path.basename(iso)}`, bad.length === 0,
      bad.length ? bad.slice(0, 6).map((s) => `${hx(s.off, 6)} ${s.label}`).join("; ") + (bad.length > 6 ? ` (+${bad.length - 6} more)` : "") : null);
    let d = 0;
    for (let i = 0; i < PS_STOCK.length; i++) if (blk[PS_HOOK.off - ELF_BASE + i] !== PS_STOCK[i]) d++;
    check("the dead routine on disc is byte-for-byte the blob restore writes back", d === 0,
      d ? `${d} of ${PS_STOCK.length} bytes differ` : null);
    // The audit's own claim: a pristine disc produces no findings at all.
    check("a pristine disc audits clean — no findings, so nothing to restore",
      bad.length === 0 && d === 0);
  }
}

console.log(fails ? `\nFAIL — ${fails} check(s)` : "\nAll checks passed.");
process.exit(fails ? 1 : 0);
