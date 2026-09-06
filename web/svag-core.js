// PS-ADPCM / `Svag` decoding for the ISO editor's Music tab — pure, DOM-free and
// Web-Audio-free, so it can be driven headlessly (web/tests/svag-core.mjs).
//
// /SD/STR.BIN holds 29 `Svag` streams: Sony's interleaved VAG, which is plain PS-ADPCM
// with the channels split into fixed-size blocks. Decoding it is small enough to own
// outright rather than ship a library for, and owning it is what lets the editor play the
// disc's music without uploading a byte of it anywhere.
//
// The frame, 16 bytes for 28 samples of one channel:
//
//     byte 0   low nibble = SHIFT, high nibble = FILTER
//     byte 1   flags (loop/end markers — playback here ignores them)
//     2..15    28 four-bit samples, low nibble of each byte first
//
// Each sample is `nibble << (12 - shift)` fed through a 2-tap IIR whose coefficients the
// filter index selects. The filter is what makes this lossy-but-musical rather than raw
// 4-bit noise, and getting f0/f1 wrong yields audio that is recognisable but harsh — so
// the unit test checks the recurrence against hand-computed values, not just "not silence".
//
// Two encodings are deliberately tolerated rather than rejected, because real discs
// contain both and a throw here would be a dead Play button:
//   • filter > 4 — undefined; the hardware clamps, so we clamp to 4.
//   • shift > 12 — no valid sample; the hardware yields 0, so we do.
(function (root) {
  "use strict";

  const F0 = [0, 60, 115, 98, 122];
  const F1 = [0, 0, -52, -55, -60];
  const FRAME = 16;                 // bytes
  const FRAME_SAMPLES = 28;

  // Decode one channel's frames into `out` (Float32, -1..1). Returns samples written.
  function decodeAdpcm(src, out) {
    let h1 = 0, h2 = 0, o = 0;
    for (let p = 0; p + FRAME <= src.length; p += FRAME) {
      const b0 = src[p];
      const shift = b0 & 0x0F;
      const filt = Math.min((b0 >> 4) & 0x0F, 4);
      const f0 = F0[filt] / 64, f1 = F1[filt] / 64;
      for (let i = 0; i < 14; i++) {
        const byte = src[p + 2 + i];
        for (let k = 0; k < 2; k++) {
          let nib = k ? (byte >> 4) : (byte & 0x0F);
          if (nib > 7) nib -= 16;                       // 4-bit two's complement
          let v = shift <= 12 ? (nib << (12 - shift)) : 0;
          v += h1 * f0 + h2 * f1;
          // Clamp BEFORE storing to history, as the hardware does. Feeding the unclamped
          // value back makes the filter run away on a loud passage instead of saturating,
          // which sounds like distortion rather than like a bug.
          if (v < -32768) v = -32768; else if (v > 32767) v = 32767;
          h2 = h1; h1 = v;
          if (o < out.length) out[o++] = v / 32768;
        }
      }
    }
    return o;
  }

  // How many samples per channel a `Svag` body of `bytes` yields at this interleave.
  function frameCount(bytes, ch, inter) {
    const blocks = Math.floor(bytes / inter);
    const per = Math.floor(blocks / ch) * inter;
    return Math.floor(per / FRAME) * FRAME_SAMPLES;
  }

  // De-interleave `inter`-byte blocks round-robin across channels, then decode each.
  // Returns one Float32Array per channel, all the same length.
  function decodeSvag(bytes, ch, inter) {
    if (!(ch >= 1 && ch <= 2) || !(inter > 0) || inter % FRAME) {
      throw new Error(`bad Svag geometry: ch=${ch} interleave=${inter}`);
    }
    const blocks = Math.floor(bytes.length / inter);
    const per = Math.floor(blocks / ch) * inter;        // whole blocks per channel
    const frames = Math.floor(per / FRAME) * FRAME_SAMPLES;
    const out = [];
    for (let c = 0; c < ch; c++) {
      const raw = new Uint8Array(per);
      let w = 0;
      for (let b = c; b < blocks && w < per; b += ch) {
        raw.set(bytes.subarray(b * inter, (b + 1) * inter), w);
        w += inter;
      }
      const pcm = new Float32Array(frames);
      decodeAdpcm(raw, pcm);
      out.push(pcm);
    }
    return out;
  }

  // Parse a stream header. `buf` starts at the stream's first byte; the header is stored
  // twice (0x000 and 0x400) with the PCM at 0x800 — we read the second copy, which is the
  // one immediately preceding the data.
  const HEADER2 = 0x400, DATA = 0x800;
  function readHeader(buf) {
    if (buf.length < DATA) return null;
    if (String.fromCharCode(buf[HEADER2], buf[HEADER2 + 1], buf[HEADER2 + 2], buf[HEADER2 + 3]) !== "Svag") return null;
    const dv = new DataView(buf.buffer, buf.byteOffset + HEADER2 + 4, 16);
    return { bytes: dv.getUint32(0, true), rate: dv.getUint32(4, true),
             ch: dv.getUint32(8, true), inter: dv.getUint32(12, true), data: DATA };
  }

  root.SvagCore = { decodeAdpcm, decodeSvag, frameCount, readHeader, FRAME, FRAME_SAMPLES, F0, F1 };
})(typeof window !== "undefined" ? window : globalThis);
