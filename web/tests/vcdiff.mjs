// VCDIFF tests — both directions.
//
// ENCODE: web/vcdiff.js synthesizes an .xdelta from known edits without diffing the 4 GB disc.
// DECODE: it also reads patches back, which is what lets the editor APPLY a mod and not just
// publish one. The decoder has to cope with whatever xdelta3 emitted (full default code table,
// all nine address modes, RUN, app headers, VCD_ADLER32), so the meaningful tests run real
// xdelta3 output through it. Everything that needs xdelta3 skips cleanly when it isn't
// installed; the encoder round-trips still run, now through the SHIPPED decoder rather than a
// test-local one, so the two halves check each other.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = require(path.join(WEB, "vcdiff.js"));
const { buildXdelta, decode, eachWindow, adler32, defaultCodeTable } = V;

let fail = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); fail++; };
const chk = (m, c) => (c ? ok : bad)(m);
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const TMP = process.env.TMPDIR || "/tmp";
let xdeltaOK = true; try { execFileSync("xdelta3", ["-V"], { stdio: "ignore" }); } catch { xdeltaOK = false; }

// Deterministic bytes with NO long-range repeats. (A weak LCG in JS loses precision on the
// multiply and produces 100 KB-long exact repeats at unrelated offsets — which made an earlier
// version of this file "fail" on data no real disc looks like.) SHA-based counter mode instead.
function bytes(seed, n) {
  const out = Buffer.alloc(n);
  let o = 0, ctr = 0;
  while (o < n) {
    const h = zlib.deflateRawSync(Buffer.from(`${seed}:${ctr++}:${"x".repeat(64)}`), { level: 9 });
    const blk = require("crypto").createHash("sha256").update(h).update(String(ctr)).digest();
    blk.copy(out, o); o += blk.length;
  }
  return new Uint8Array(out);
}
function mk(size) { const b = new Uint8Array(size); for (let i = 0; i < size; i++) b[i] = (i * 37 + 11) & 0xFF; return b; }
function apply(src, edits) { const e = Uint8Array.from(src); for (const ed of edits) e.set(ed.data, ed.off); return e; }

// ---- the default code table ------------------------------------------------
console.log("VCDIFF default code table (RFC 3284 §5.4):");
{
  const t = defaultCodeTable();
  chk("has exactly 256 entries", t.length === 256);
  // spot-check the rows the RFC names explicitly
  chk("entry 0 is RUN", JSON.stringify(t[0]) === JSON.stringify([2, 0, 0, 0, 0, 0]));
  chk("entry 1 is ADD size 0 (size follows)", JSON.stringify(t[1]) === JSON.stringify([1, 0, 0, 0, 0, 0]));
  chk("entry 19 is COPY size 0 mode 0", JSON.stringify(t[19]) === JSON.stringify([3, 0, 0, 0, 0, 0]));
  chk("entry 255 is COPY(4,mode8)+ADD(1)", JSON.stringify(t[255]) === JSON.stringify([3, 4, 8, 1, 1, 0]));
  chk("every entry is a 6-tuple", t.every((r) => r.length === 6));
}

// ---- adler32 ---------------------------------------------------------------
console.log("adler32 (verifies an applied patch):");
{
  // zlib puts the adler32 of the input in the last 4 bytes of a zlib stream — free oracle
  const oracle = (b) => { const z = zlib.deflateSync(Buffer.from(b)); return z.readUInt32BE(z.length - 4); };
  let allOK = true;
  for (const n of [0, 1, 55, 5551, 5552, 5553, 100000]) {
    const b = bytes(3, n);
    if (adler32(b) !== oracle(b)) { allOK = false; bad(`adler32 differs from zlib at n=${n}`); }
  }
  if (allOK) ok("matches zlib across sizes (incl. the 5552-byte chunking boundary)");
}

// ---- encoder → shipped decoder round-trips ---------------------------------
const CASES = [
  ["single edit", 10240, [{ off: 100, data: [1, 2, 3] }], undefined],
  ["edit at 0", 10240, [{ off: 0, data: [7, 7, 7, 7] }], undefined],
  ["edit at end", 10240, [{ off: 10236, data: [5, 6, 7, 8] }], undefined],
  ["multi-window", 20000, [{ off: 50, data: [1, 2] }, { off: 8200, data: [3, 4, 5] }, { off: 16000, data: [6] }], 4096],
  ["straddle boundary", 12000, [{ off: 4094, data: [1, 2, 3, 4, 5, 6] }], 4096],
  ["identity (no edits)", 5000, [], undefined],
  ["many edits", 100000, Array.from({ length: 40 }, (_, k) => ({ off: k * 2400 + 13, data: [k & 0xFF] })), undefined],
];

console.log("Encoder → our own decoder:");
for (const [name, size, edits, win] of CASES) {
  const src = mk(size);
  const eds = edits.map((e) => ({ off: e.off, data: Uint8Array.from(e.data) }));
  const want = apply(src, eds);
  let patch, got;
  try { patch = buildXdelta(size, eds, win ? { window: win } : undefined); }
  catch (e) { bad(`${name}: build threw ${e.message}`); continue; }
  try { got = decode(src, patch); } catch (e) { bad(`${name}: decode threw ${e.message}`); continue; }
  chk(`${name} (patch ${patch.length}B)`, eq(got, want));
}

if (xdeltaOK) {
  console.log("Encoder → real xdelta3:");
  for (const [name, size, edits, win] of CASES) {
    const src = mk(size), eds = edits.map((e) => ({ off: e.off, data: Uint8Array.from(e.data) }));
    const want = apply(src, eds);
    const patch = buildXdelta(size, eds, win ? { window: win } : undefined);
    const s = path.join(TMP, "vct_s.bin"), p = path.join(TMP, "vct_p.xd"), o = path.join(TMP, "vct_o.bin");
    fs.writeFileSync(s, Buffer.from(src)); fs.writeFileSync(p, Buffer.from(patch));
    try { execFileSync("xdelta3", ["-d", "-f", "-q", "-s", s, p, o]); } catch (e) { bad(`${name}: xdelta3 -d failed`); continue; }
    chk(`${name} via xdelta3`, eq(fs.readFileSync(o), Buffer.from(want)));
  }

  // ---- real xdelta3 patches → our decoder ----------------------------------
  // The direction that matters for applying community mods.
  console.log("Real xdelta3 patches → our decoder:");
  const s = path.join(TMP, "vcd_s.bin"), t = path.join(TMP, "vcd_t.bin"), p = path.join(TMP, "vcd_p.xd");
  const enc = (flags) => { execFileSync("xdelta3", ["-e", "-f", "-q", "-S", "none", ...flags, "-s", s, t, p]);
    return new Uint8Array(fs.readFileSync(p)); };

  const shapes = [
    ["small scattered edits", () => { const a = bytes(1, 200000), b = Uint8Array.from(a); b.set([1, 2, 3], 100); b.set([65, 66, 67, 68], 150000); return [a, b]; }],
    ["long identical run (RUN opcode)", () => { const a = bytes(2, 100000), b = Uint8Array.from(a); b.fill(0x5A, 40000, 41000); return [a, b]; }],
    ["target longer than source", () => { const a = bytes(3, 50000), b = new Uint8Array(60000); b.set(a); b.fill(0xAB, 50000); return [a, b]; }],
    ["target shorter than source", () => { const a = bytes(4, 80000); return [a, a.slice(0, 30000)]; }],
    ["completely unrelated files", () => [bytes(5, 60000), bytes(99, 60000)]],
    ["300 scattered flips", () => { const a = bytes(6, 120000), b = Uint8Array.from(a); for (let i = 0; i < 300; i++) b[i * 370 + 5] ^= 0xFF; return [a, b]; }],
    ["empty source", () => [new Uint8Array(0), bytes(7, 5000)]],
    ["identical files", () => { const a = bytes(8, 40000); return [a, Uint8Array.from(a)]; }],
    ["self-referential repeats", () => { const a = bytes(9, 20000), b = new Uint8Array(20000);
      for (let i = 0; i < 20000; i += 256) b.set(a.subarray(0, Math.min(256, 20000 - i)), i); return [a, b]; }],
  ];
  const FLAGS = [[], ["-A"], ["-9"], ["-W", "65536"]];   // -W forces many windows
  for (const [name, gen] of shapes) {
    const [a, b] = gen();
    fs.writeFileSync(s, Buffer.from(a)); fs.writeFileSync(t, Buffer.from(b));
    let allOK = true, detail = "";
    for (const f of FLAGS) {
      const patch = enc(f);
      let got; try { got = decode(a, patch); } catch (e) { allOK = false; detail = `[${f.join(" ")}] ${e.message}`; break; }
      if (!eq(got, b)) { allOK = false; detail = `[${f.join(" ")}] bytes differ`; break; }
    }
    chk(`${name} — decodes under ${FLAGS.length} encoder settings`, allOK, detail);
  }

  // Windows: -W 65536 must actually produce many, or the multi-window path is untested
  {
    const a = bytes(10, 500000), b = Uint8Array.from(a); b.set([1, 2, 3], 250000);
    fs.writeFileSync(s, Buffer.from(a)); fs.writeFileSync(t, Buffer.from(b));
    const patch = enc(["-W", "65536"]);
    let n = 0; eachWindow(patch, () => n++);
    chk(`multi-window patch really has multiple windows (${n})`, n > 4);
    chk("multi-window decode is exact", eq(decode(a, patch), b));
  }

  // ---- the property the ISO editor depends on ------------------------------
  // It skips windows whose plan() is empty and diffs only the rest. That is only safe if
  // plan() never MISSES a changed byte. Assert the derived diff equals the true diff.
  console.log("plan() drives an exact diff without reading the whole file:");
  {
    const a = bytes(12, 400000), b = Uint8Array.from(a);
    const realEdits = [[100, [1, 2, 3]], [150000, [9, 9, 9, 9, 9]], [399990, [7, 7]]];
    realEdits.forEach(([o, d]) => b.set(d, o));
    fs.writeFileSync(s, Buffer.from(a)); fs.writeFileSync(t, Buffer.from(b));
    for (const f of [[], ["-W", "65536"]]) {
      const patch = enc(f);
      // replicate the editor's algorithm: skip empty-plan windows, diff the rest
      const derived = [];
      let touched = 0, scannedBytes = 0;
      eachWindow(patch, (w) => {
        if (!w.plan().length) return;
        touched++; scannedBytes += w.targetLen;
        const out = w.decode(a.subarray(w.sourceStart, w.sourceStart + w.sourceLen));
        const cur = a.subarray(w.targetStart, w.targetStart + w.targetLen);
        for (let i = 0; i < out.length;) {
          if (out[i] === cur[i]) { i++; continue; }
          const from = i; while (i < out.length && out[i] !== cur[i]) i++;
          derived.push([w.targetStart + from, w.targetStart + i]);
        }
      });
      // ground truth
      const truth = [];
      for (let i = 0; i < a.length;) {
        if (a[i] === b[i]) { i++; continue; }
        const from = i; while (i < a.length && a[i] !== b[i]) i++;
        truth.push([from, i]);
      }
      const label = f.length ? "many windows" : "one window";
      chk(`${label}: derived diff matches the true diff exactly`, JSON.stringify(derived) === JSON.stringify(truth),
        JSON.stringify(derived) === JSON.stringify(truth) ? "" : `got ${JSON.stringify(derived)} want ${JSON.stringify(truth)}`);
      if (f.length) chk(`${label}: only ${touched} of the windows needed disc reads (${scannedBytes}B of ${a.length}B)`, scannedBytes < a.length / 2);
    }
  }

  // ---- refusals: never mis-apply -------------------------------------------
  console.log("Refusals (a wrong answer is worse than none):");
  {
    const a = bytes(13, 200000), b = Uint8Array.from(a); b.set([4, 5, 6], 1234);
    fs.writeFileSync(s, Buffer.from(a)); fs.writeFileSync(t, Buffer.from(b));

    // xdelta3's DEFAULT is LZMA secondary compression — must be refused with the fix
    execFileSync("xdelta3", ["-e", "-f", "-q", "-s", s, t, p]);
    const lzma = new Uint8Array(fs.readFileSync(p));
    let msg = ""; try { decode(a, lzma); } catch (e) { msg = e.message; }
    chk("xdelta3's default (LZMA) patch is refused, not mis-decoded", /secondary compression|delta sections/i.test(msg));
    chk("...and the message names the fix (-S none)", /-S none/.test(msg));

    // wrong source must be caught by the stored checksum
    const patch = enc([]);
    const wrong = Uint8Array.from(a); wrong[12345] ^= 0xFF;
    let m2 = ""; try { decode(wrong, patch); } catch (e) { m2 = e.message; }
    chk("a patch applied to the wrong source fails its checksum", /checksum/i.test(m2));

    // and the checksum is actually present to do that job
    let hasAdler = false; eachWindow(patch, (w) => { hasAdler = hasAdler || w.adler32 !== null; });
    chk("xdelta3 patches carry the adler32 we verify", hasAdler);
  }
} else {
  console.log("  (xdelta3 not installed — skipped every real-patch decode + refusal check)");
}

console.log("Malformed input:");
for (const [n, b] of [["empty", new Uint8Array(0)], ["bad magic", Uint8Array.from([1, 2, 3, 4, 5, 6])],
                      ["truncated header", Uint8Array.from([0xd6, 0xc3])],
                      ["truncated window", Uint8Array.from([0xd6, 0xc3, 0xc4, 0x00, 0x00, 0x01, 0x10])],
                      ["unknown version", Uint8Array.from([0xd6, 0xc3, 0xc4, 0x09, 0x00])]]) {
  let threw = false; try { decode(mk(1000), b); } catch (e) { threw = true; }
  chk(`rejects ${n}`, threw);
}

console.log(fail ? `\nFAILED (${fail})` : "\nAll VCDIFF tests passed.");
process.exit(fail ? 1 : 0);
