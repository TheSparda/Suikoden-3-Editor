// The two battle-results overlay switches, checked against a REAL pristine disc.
//
// Why this file exists apart from e2e.mjs: the synthetic fixture is ~4.6 MB and these two
// checks live ~1 GB in, so on that disc the controls can only ever be *unavailable*. The e2e
// asserts exactly that degradation and nothing else — it cannot prove a single byte of the
// positive path. This does, by running the SHIPPED switch code (sliced straight out of
// web/iso.js, not a copy of it) over windows read from the pristine USA ISO.
//
//   node web/tests/overlay-switches-real-iso.mjs
//   S3_ISO=/path/to/disc.iso node web/tests/overlay-switches-real-iso.mjs
//
// Self-skips (exit 0) when no disc is there, so it never breaks a machine without one.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ISO = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");

if (!fs.existsSync(ISO)) {
  console.log(`SKIP overlay-switches-real-iso: no disc at ${ISO} (set S3_ISO to point at one).`);
  process.exit(0);
}

let fails = 0;
const check = (name, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) fails++;
};
const hx = (w) => "0x" + (w >>> 0).toString(16).toUpperCase().padStart(8, "0");

// ---- load the shipped code, don't re-type it ---------------------------------------------
// Everything from the aux-window header down to auxSwRevert is self-contained apart from two
// names auxMarkSaved touches, which are shimmed. Slicing rather than importing is the point:
// a constant that drifts in iso.js drifts here too, and this file goes red instead of quietly
// testing its own private copy.
const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
const START = "  // ---- aux windows: tiny out-of-block ranges we also edit ---------------------";
const END = "  const auxSwRevert = (sw) => auxRevertAt(sw.rel, 8);";
const a = iso.indexOf(START), b = iso.indexOf(END);
if (a < 0 || b < 0) {
  console.log("  ✗ could not slice the aux-window section out of web/iso.js "
    + "(its header or auxSwRevert moved) — this file is testing NOTHING until that is fixed");
  process.exit(1);
}
const src = iso.slice(a, b + END.length);
const load = new Function(`
  let RSCALE = null;
  const resetBulkScales = () => {};
${src}
  return { AUX_WINDOWS, AUX_LEN, AUXSW, auxSwState, auxSwEditable, auxSwSet, auxSwDirty,
    auxSwRevert, auxRuns, setAux: (w) => { AUX = w; }, getAux: () => AUX };`)();

const { AUX_WINDOWS, AUX_LEN, AUXSW, auxSwState, auxSwEditable, auxSwSet, auxSwDirty,
  auxSwRevert, auxRuns, setAux, getAux } = load;

console.log(`Overlay switches vs ${path.basename(ISO)}:`);
check(`the editor reads two windows of 0x${AUX_LEN.toString(16).toUpperCase()} bytes`,
  AUX_WINDOWS.length === 2 && AUX_LEN >= 0x70, AUX_WINDOWS.map((o) => hx(o)).join(", "));

// ---- read the real windows ----------------------------------------------------------------
const fd = fs.openSync(ISO, "r");
const readAt = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return new Uint8Array(b); };
const size = fs.statSync(ISO).size;
check("the disc is long enough to hold both streaming copies",
  size > AUX_WINDOWS[1] + AUX_LEN, `${size} bytes`);

const pristine = AUX_WINDOWS.map((off) => readAt(off, AUX_LEN));
check("the two streaming copies are byte-identical across the whole window",
  Buffer.compare(Buffer.from(pristine[0]), Buffer.from(pristine[1])) === 0);

const mkAux = () => AUX_WINDOWS.map((off, i) => ({
  off, len: AUX_LEN, tag: "potch", buf: pristine[i].slice(), orig: pristine[i].slice() }));
setAux(mkAux());

const u32 = (win, rel) => new DataView(win.buffer, win.byteOffset, win.byteLength).getUint32(rel, true) >>> 0;

// ---- 1. the stock words are what iso.js says they are --------------------------------------
for (const sw of AUXSW) {
  for (let i = 0; i < AUX_WINDOWS.length; i++) {
    const at = AUX_WINDOWS[i] + sw.rel;
    check(`${sw.key} @ ${hx(at)}: the stock call is ${hx(sw.jal)}`,
      u32(pristine[i], sw.rel) === (sw.jal >>> 0), hx(u32(pristine[i], sw.rel)));
    check(`${sw.key} @ ${hx(at + 4)}: the stock delay slot is ${hx(sw.ds)}`,
      u32(pristine[i], sw.rel + 4) === (sw.ds >>> 0), hx(u32(pristine[i], sw.rel + 4)));
  }
}

// ---- 2. a pristine disc reads as off, and is editable --------------------------------------
for (const sw of AUXSW) {
  check(`${sw.key} reads OFF on a pristine disc`, auxSwState(sw) === "off", auxSwState(sw));
  check(`${sw.key} is editable`, auxSwEditable(sw) === true);
  check(`${sw.key} starts clean`, auxSwDirty(sw) === false);
}

// ---- 3. forcing on writes the two-word patch, in BOTH copies, and nothing else -------------
// The whole shape of the patch: the delay-slot instruction moves UP into the jal's word and
// the answer lands in the word it vacated. Instruction order is unchanged and nothing moves,
// which is why only two words per copy may differ.
const AUXW = load.AUX_WINDOWS;
for (const sw of AUXSW) {
  setAux(mkAux());
  check(`${sw.key}: auxSwSet reports it wrote`, auxSwSet(sw, true) === true);
  check(`${sw.key} now reads ON`, auxSwState(sw) === "on", auxSwState(sw));
  check(`${sw.key} reads dirty`, auxSwDirty(sw) === true);
  const runs = auxRuns();
  check(`${sw.key}: exactly two dirty runs, one per streaming copy`, runs.length === 2,
    runs.map((r) => hx(r.off)).join(", "));
  // A run is a contiguous stretch of CHANGED bytes, so it is at most the 8-byte pair and
  // often shorter — both words here happen to share their top byte. What matters is that
  // nothing outside the pair moved.
  check(`${sw.key}: nothing outside the word pair changed`,
    runs.every((r) => AUXW.some((w) => r.off >= w + sw.rel && r.off + r.bytes.length <= w + sw.rel + 8)),
    runs.map((r) => `${hx(r.off)}+${r.bytes.length}`).join(", "));
  const got = getAux().map((w) => [u32(w.buf, sw.rel), u32(w.buf, sw.rel + 4)]);
  check(`${sw.key}: the delay slot moved up into the call's word (${hx(sw.ds)})`,
    got.every(([w0]) => w0 === (sw.ds >>> 0)), got.map(([w0]) => hx(w0)).join(", "));
  check(`${sw.key}: the answer went into the word the call vacated (${hx(sw.yes)})`,
    got.every(([, w1]) => w1 === (sw.yes >>> 0)), got.map(([, w1]) => hx(w1)).join(", "));
  check(`${sw.key}: both streaming copies came out identical`,
    got.length === 2 && got[0][0] === got[1][0] && got[0][1] === got[1][1]);
  // Everything else in the window — the EXP multiplier, the potch mask, the potch multiplier —
  // has to be untouched, or a switch would be quietly eating another control's value.
  check(`${sw.key}: the rest of the window is byte-identical`,
    getAux().every((w, i) => w.buf.every((v, k) =>
      (k >= sw.rel && k < sw.rel + 8) || v === pristine[i][k])));

  // ---- 4. and unticking puts both copies back byte-for-byte --------------------------------
  check(`${sw.key}: unticking reports it wrote`, auxSwSet(sw, false) === true);
  check(`${sw.key} reads OFF again`, auxSwState(sw) === "off");
  check(`${sw.key}: the window is byte-identical to the disc again`, auxRuns().length === 0);
  check(`${sw.key}: ...and reads clean`, auxSwDirty(sw) === false);
}

// ---- 5. both at once, then reverted one at a time ------------------------------------------
setAux(mkAux());
AUXSW.forEach((sw) => auxSwSet(sw, true));
check("both switches on at once: four dirty runs (two switches x two copies)",
  auxRuns().length === 4, String(auxRuns().length));
check("...and both read ON", AUXSW.every((sw) => auxSwState(sw) === "on"));
auxSwRevert(AUXSW[0]);
check("reverting one leaves the other alone",
  auxSwState(AUXSW[0]) === "off" && auxSwState(AUXSW[1]) === "on");
auxSwRevert(AUXSW[1]);
check("reverting the second restores the window byte-for-byte", auxRuns().length === 0);

// ---- 6. a stranger's patch is read-only, and half a patch is "mixed" -----------------------
{
  const aux = mkAux();
  new DataView(aux[0].buf.buffer).setUint32(AUXSW[0].rel, 0xDEADBEEF, true);
  setAux(aux);
  check("a word neither stock nor ours reads as 'other', not as off",
    auxSwState(AUXSW[0]) === "other", auxSwState(AUXSW[0]));
  check("...and refuses to be written", auxSwSet(AUXSW[0], true) === false);
}
{
  const aux = mkAux();
  setAux(aux);
  // patch only the first copy, by hand, exactly as auxSwSet would
  const dv = new DataView(aux[0].buf.buffer);
  dv.setUint32(AUXSW[1].rel, AUXSW[1].ds >>> 0, true);
  dv.setUint32(AUXSW[1].rel + 4, AUXSW[1].yes >>> 0, true);
  check("one copy patched and one not reads as 'mixed'",
    auxSwState(AUXSW[1]) === "mixed", auxSwState(AUXSW[1]));
  check("...and refuses to be written, so it can never be left half-patched",
    auxSwSet(AUXSW[1], true) === false);
}

// ---- 7. no other copy of either check exists on the disc -----------------------------------
// The 8-byte check pattern is the strongest evidence that patching two addresses is patching
// ALL of them. Fortune's is unique to the overlay; Prosperity's `jal which_set` also appears
// in the bonus-counter routine inside the ELF block, so that one is reported by location
// rather than by count.
{
  const ELF_BASE = 0xA4800, ELF_END = 0x465DF0;    // the PT_LOAD block the editor loads
  const pat = (sw) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(sw.jal >>> 0, 0); b.writeUInt32LE(sw.ds >>> 0, 4);
    return b;
  };
  const want = AUXSW.map((sw) => ({ sw, p: pat(sw), hits: [] }));
  const CH = 1 << 24;
  let off = 0, prev = Buffer.alloc(0);
  const buf = Buffer.alloc(CH);
  for (;;) {
    const n = fs.readSync(fd, buf, 0, CH, off);
    if (n <= 0) break;
    const hay = Buffer.concat([prev, buf.subarray(0, n)]);
    const base = off - prev.length;
    for (const w of want) {
      let i = hay.indexOf(w.p);
      while (i !== -1) { w.hits.push(base + i); i = hay.indexOf(w.p, i + 1); }
    }
    prev = hay.subarray(hay.length - 7);
    off += n;
  }
  for (const w of want) {
    const overlay = w.hits.filter((o) => o < ELF_BASE || o >= ELF_END);
    const inBlock = w.hits.filter((o) => o >= ELF_BASE && o < ELF_END);
    check(`${w.sw.key}: the two patched addresses are the ONLY copies outside the executable`,
      overlay.length === 2 && overlay.join() === AUXW.map((x) => x + w.sw.rel).join(),
      overlay.map((o) => hx(o)).join(", ") || "(none)");
    if (inBlock.length)
      console.log(`    note: ${w.sw.key}'s 8-byte pattern also occurs ${inBlock.length}x inside the `
        + `ELF block (${inBlock.map((o) => hx(o)).join(", ")}) — a different routine asking the `
        + `same helper the same way, not a copy of this one.`);
  }
}

fs.closeSync(fd);
console.log(fails ? `\nFAILED (${fails})` : "\nAll overlay-switch checks passed against the real disc.");
process.exit(fails ? 1 : 0);
