// Pure in-ELF string scanner shared by the ISO editor (iso.js) and the Node tests.
// No DOM / no ISO — it takes a byte block and returns the editable string slots in it.
//
// The boot ELF stores its English UI text as printable-ASCII runs. There is no table of
// contents for them, so the desktop editor finds them by scanning for printable runs and
// filtering out the ones that look like code/format strings rather than prose. This is a
// originally a port of `_looks_like_text` / `read_texts` in the retired Editor/s3editor.py; the
// agree, or the same disc would offer different strings in each editor, so the heuristic
// lives here in one testable place and validate.mjs asserts the rules still match.
//
// Only bytes 32..126 are accumulated, so every character reaching the filter is ASCII —
// which is why Python's isalpha()/islower() reduce to /[A-Za-z]/ and /[a-z]/ here.
//
// NOTE ON SCOPE: these are UI / battle / menu / prize / error strings and character
// blurbs. Story **dialogue** is not here — it lives in packed event files elsewhere on
// the disc, outside the ELF, and no editor in this repo can reach it.
(function (root) {
  const MIN_LEN = 8;                       // shorter runs are almost always fragments
  const PRINTABLE_LO = 32, PRINTABLE_HI = 127;   // [lo, hi)
  // A run is rejected outright if it contains any of these: format/path punctuation, a hex
  // literal, an arrow or scope operator, an underscore, or a letter adjacent to a digit
  // (identifiers and format specifiers, e.g. "arg1" or "3rdPass").
  const REJECT = /[%$/\\]|0x|->|::|_|[A-Za-z]\d|\d[A-Za-z]/;
  // Characters that count as "prose" — letters plus the punctuation English text uses.
  const PROSE_PUNCT = " ,.'!?-@()";
  const PROSE_RATIO = 0.9;                 // >90% of the run must be prose characters

  function looksLikeText(s) {
    if (s.length < MIN_LEN || s.indexOf(" ") < 0) return false;
    if (REJECT.test(s)) return false;
    if (!/[a-z]/.test(s)) return false;    // ALL-CAPS runs are labels/enums, not prose
    let ok = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || PROSE_PUNCT.indexOf(c) >= 0) ok++;
    }
    return ok / s.length > PROSE_RATIO;
  }

  // Decode a printable-ASCII run. (Bytes are guaranteed in [32,127) by the scanner.)
  function decodeRun(bytes, from, to) {
    let s = "";
    for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // Scan a block for editable string slots. `base` is the absolute file offset of bytes[0],
  // so the returned `off` is absolute like every other offset in the editor.
  // Returns [{ off, max }] where `max` is the run's on-disk byte length — the hard cap for
  // an edit, since growing a string would mean repointing every reference to it.
  function scanStrings(bytes, base) {
    const out = [];
    let st = -1;
    for (let i = 0; i <= bytes.length; i++) {
      const b = i < bytes.length ? bytes[i] : 0;          // force a flush at the end
      const printable = i < bytes.length && b >= PRINTABLE_LO && b < PRINTABLE_HI;
      if (printable) { if (st < 0) st = i; continue; }
      if (st >= 0) {
        if (i - st >= MIN_LEN && looksLikeText(decodeRun(bytes, st, i))) out.push({ off: base + st, max: i - st });
        st = -1;
      }
    }
    return out;
  }

  const api = { MIN_LEN, PRINTABLE_LO, PRINTABLE_HI, REJECT, PROSE_PUNCT, PROSE_RATIO, looksLikeText, scanStrings };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.TextCore = api;                                                         // browser global
})(typeof self !== "undefined" ? self : globalThis);
