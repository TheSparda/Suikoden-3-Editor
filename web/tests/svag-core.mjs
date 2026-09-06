// The PS-ADPCM decoder behind the Music tab's Play button, no browser.
//
// A decoder is a bad thing to test by "does it produce sound", because every wrong version
// also produces sound. Feed it a wrong filter coefficient, a flipped nibble order, or a
// sign-extension bug and you still get audio out — recognisable, even, just harsh or
// distorted. So the checks here are arithmetic: frames whose exact output can be computed
// by hand from the format, asserted sample by sample.
//
// The three bugs this is really guarding against, all of which sound "fine-ish":
//   • nibble ORDER — low nibble is the earlier sample; swapping them halves the pitch of
//     nothing and just adds hash, so it is inaudible as a bug but wrong everywhere;
//   • SIGN EXTENSION — nibbles are 4-bit two's complement, so 0x8..0xF are negative;
//     missing it turns every waveform into a DC-offset mess that still plays;
//   • the IIR RECURRENCE — h1/h2 must carry across frames, not reset per frame. Resetting
//     makes a click every 28 samples, which on a noisy track is easy to dismiss.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
new Function(readFileSync(path.join(HERE, "..", "svag-core.js"), "utf8"))();
const { decodeAdpcm, decodeSvag, frameCount, readHeader, F0, F1 } = globalThis.SvagCore;

let fails = 0, section = "";
const head = (s) => { section = s; console.log(s + ":"); };
const check = (name, ok, extra) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
  if (!ok) fails++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// One 16-byte frame: shift/filter byte, flags byte, then 14 data bytes.
function frame(shift, filt, nibbles) {
  const f = new Uint8Array(16);
  f[0] = (filt << 4) | shift;
  f[1] = 0;
  for (let i = 0; i < 28; i += 2) f[2 + i / 2] = (nibbles[i] & 0x0F) | ((nibbles[i + 1] & 0x0F) << 4);
  return f;
}
const rep = (v) => new Array(28).fill(v);

head("Sample decoding — filter 0, so output is the raw shifted nibble");
{
  // filter 0 zeroes both IIR taps, so sample = (nibble << (12 - shift)) / 32768 exactly.
  const out = new Float32Array(28);
  decodeAdpcm(frame(0, 0, rep(1)), out);
  check("nibble 1 at shift 0 is 4096/32768", near(out[0], 4096 / 32768), out[0]);
  check("every sample in the frame decodes", out.every((x) => near(x, 4096 / 32768)));

  const o2 = new Float32Array(28);
  decodeAdpcm(frame(4, 0, rep(1)), o2);
  check("shift 4 scales by 2^8", near(o2[0], 256 / 32768), o2[0]);

  // 0x8..0xF are NEGATIVE — the classic bug is reading them as 8..15.
  const o3 = new Float32Array(28);
  decodeAdpcm(frame(0, 0, rep(0xF)), o3);
  check("nibble 0xF is -1, not 15", near(o3[0], -4096 / 32768), o3[0]);
  const o4 = new Float32Array(28);
  decodeAdpcm(frame(0, 0, rep(0x8)), o4);
  check("nibble 0x8 is -8 (the sign boundary)", near(o4[0], (-8 * 4096) / 32768), o4[0]);
}

head("Nibble order — low nibble of each byte is the EARLIER sample");
{
  const nib = new Array(28).fill(0);
  nib[0] = 1; nib[1] = 2;              // first byte becomes 0x21
  const f = frame(0, 0, nib);
  check("the packed byte is high<<4 | low", f[2] === 0x21, f[2].toString(16));
  const out = new Float32Array(28);
  decodeAdpcm(f, out);
  check("sample 0 comes from the low nibble", near(out[0], 4096 / 32768), out[0]);
  check("sample 1 comes from the high nibble", near(out[1], 8192 / 32768), out[1]);
}

head("The IIR recurrence — hand-computed against the format's own coefficients");
{
  // filter 2: f0 = 115/64, f1 = -52/64. With shift 0 and every nibble 1, each step is
  //   v[n] = 4096 + v[n-1]*115/64 + v[n-2]*(-52/64)
  const out = new Float32Array(28);
  decodeAdpcm(frame(0, 2, rep(1)), out);
  // The reference recurrence, clamped to int16 before it enters the history — that
  // ordering is the hardware's, and it is what stops a resonant filter running away.
  const clamp = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
  let h1 = 0, h2 = 0;
  const want = [];
  for (let i = 0; i < 28; i++) {
    const v = clamp(4096 + h1 * (115 / 64) + h2 * (-52 / 64));
    h2 = h1; h1 = v; want.push(v / 32768);
  }
  check("coefficients are the PS-ADPCM set", F0[2] === 115 && F1[2] === -52, `${F0[2]},${F1[2]}`);
  check("sample 0 has no history yet", near(out[0], want[0]), `${out[0]} vs ${want[0]}`);
  check("sample 1 applies f0 to sample 0", near(out[1], want[1], 1e-5), `${out[1]} vs ${want[1]}`);
  check("the whole frame follows the recurrence",
    want.every((w, i) => near(out[i], w, 1e-5)));
}

head("History carries ACROSS frames — a per-frame reset clicks every 28 samples");
{
  const two = new Uint8Array(32);
  two.set(frame(0, 2, rep(1)), 0);
  two.set(frame(0, 2, rep(1)), 16);
  const out = new Float32Array(56);
  decodeAdpcm(two, out);
  const one = new Float32Array(28);
  decodeAdpcm(frame(0, 2, rep(1)), one);
  check("frame 2 does NOT repeat frame 1", !near(out[28], one[0], 1e-4), `${out[28]} vs ${one[0]}`);
  // continuing the same recurrence across the boundary
  const clamp2 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
  let h1 = 0, h2 = 0, v = 0;
  for (let i = 0; i < 29; i++) { v = clamp2(4096 + h1 * (115 / 64) + h2 * (-52 / 64)); h2 = h1; h1 = v; }
  check("sample 28 continues the recurrence", near(out[28], v / 32768, 1e-4), `${out[28]} vs ${v / 32768}`);
}

head("Clamping — the format's undefined encodings must not throw or produce NaN");
{
  const out = new Float32Array(28);
  decodeAdpcm(frame(13, 0, rep(7)), out);           // shift > 12 has no valid sample
  check("shift > 12 yields silence, not NaN", out.every((x) => x === 0), out[0]);
  const o2 = new Float32Array(28);
  decodeAdpcm(frame(0, 9, rep(1)), o2);             // filter > 4 is undefined
  check("filter > 4 clamps instead of reading past the table", Number.isFinite(o2[0]) && o2[0] !== 0, o2[0]);
  const o3 = new Float32Array(28);
  decodeAdpcm(frame(0, 4, rep(7)), o3);             // drive it hard enough to saturate
  check("output never leaves -1..1", o3.every((x) => x >= -1 && x <= 1), Math.max(...o3));
  // Where clamped-vs-unclamped history actually shows up: a signal loud enough to
  // saturate, then compared against the reference recurrence sample for sample. Pinning
  // to the rail is CORRECT under a constant drive (filter 2 has a DC gain of ~64), so
  // "does it come off the rail" proves nothing — matching the reference does.
  const NF = 6;
  const drive = new Uint8Array(16 * NF);
  const pattern = [];
  for (let i = 0; i < 28; i++) pattern.push([1, 7, 3, 0xF, 6, 0xA, 2, 5][i % 8]);
  for (let i = 0; i < NF; i++) drive.set(frame(0, 2, pattern), i * 16);
  const got = new Float32Array(28 * NF);
  decodeAdpcm(drive, got);
  const cl = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
  let a1 = 0, a2 = 0, ok = true, sawRail = false;
  for (let i = 0; i < 28 * NF; i++) {
    let n = pattern[i % 28]; if (n > 7) n -= 16;
    const v = cl(n * 4096 + a1 * (115 / 64) + a2 * (-52 / 64));
    a2 = a1; a1 = v;
    if (Math.abs(v) >= 32767) sawRail = true;
    if (!near(got[i], v / 32768, 1e-5)) { ok = false; break; }
  }
  check("the drive is loud enough to saturate (so this test can see the bug)", sawRail);
  check("a saturating signal matches the reference recurrence exactly", ok);
}

head("De-interleaving — channels are alternating fixed-size blocks");
{
  const INTER = 16;                                  // one frame per block, easiest to verify
  const L = frame(0, 0, rep(1)), R = frame(0, 0, rep(2));
  const body = new Uint8Array(64);
  body.set(L, 0); body.set(R, 16); body.set(L, 32); body.set(R, 48);
  const [l, r] = decodeSvag(body, 2, INTER);
  check("both channels come back", l.length === 56 && r.length === 56, `${l.length},${r.length}`);
  check("left is the nibble-1 blocks", near(l[0], 4096 / 32768) && near(l[28], 4096 / 32768 * (1), 1e-2));
  check("right is the nibble-2 blocks, not a copy of left", near(r[0], 8192 / 32768), r[0]);
  check("frameCount agrees with what was produced", frameCount(body.length, 2, INTER) === l.length,
    `${frameCount(body.length, 2, INTER)} vs ${l.length}`);

  const [mono] = decodeSvag(body, 1, INTER);
  check("mono takes every block", mono.length === 112, mono.length);

  // A partial trailing block must be dropped, not decoded as a short frame.
  const ragged = new Uint8Array(64 + 5);
  ragged.set(body, 0);
  const [l2] = decodeSvag(ragged, 2, INTER);
  check("a partial trailing block is ignored", l2.length === 56, l2.length);

  let threw = false;
  try { decodeSvag(body, 3, INTER); } catch (e) { threw = true; }
  check("an impossible channel count is rejected", threw);
  try { threw = false; decodeSvag(body, 2, 20); } catch (e) { threw = true; }
  check("an interleave that is not a whole number of frames is rejected", threw);
}

head("Header parsing");
{
  const buf = new Uint8Array(0x800);
  buf.set([0x53, 0x76, 0x61, 0x67], 0x400);          // "Svag"
  new DataView(buf.buffer).setUint32(0x404, 1162112, true);
  new DataView(buf.buffer).setUint32(0x408, 44100, true);
  new DataView(buf.buffer).setUint32(0x40C, 2, true);
  new DataView(buf.buffer).setUint32(0x410, 0x2000, true);
  const h = readHeader(buf);
  check("reads the copy that precedes the data", h && h.bytes === 1162112 && h.rate === 44100
    && h.ch === 2 && h.inter === 0x2000, JSON.stringify(h));
  check("PCM starts at 0x800", h.data === 0x800);
  check("a buffer without the magic is refused", readHeader(new Uint8Array(0x800)) === null);
  check("a short buffer is refused, not read out of bounds", readHeader(new Uint8Array(4)) === null);
}

console.log(fails ? `\nFAILED (${fails})` : "\nAll svag-core checks passed.");
process.exit(fails ? 1 : 0);
