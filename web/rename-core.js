// Pure character-rename logic shared by the ISO editor (iso.js) and the Node tests.
// No DOM / no disc I/O — just the same-length byte-replacement used to rename a character
// EVERYWHERE on the disc during a streaming save. Same-length is the safety guarantee: it
// shifts zero bytes, so it can't corrupt any table, script offset, or pointer — anywhere.
//
// Scope is intentionally the distinctive main-cast names (no substring false-matches).
(function (root) {
  const RENAMEABLE = ["Hugo", "Chris", "Geddoe"];   // originals; distinctive → safe to global-replace

  const enc = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xFF; return o; };

  // Turn { "Hugo": "Rex", ... } into [{old, new}] byte pairs. The replacement is padded with
  // trailing spaces to the ORIGINAL byte length (never longer — that would shift bytes), and
  // entries that are empty, unchanged, or too long are dropped. Returns {list, warnings}.
  function buildRenames(map) {
    const list = [], warnings = [];
    for (const orig of RENAMEABLE) {
      const nv = (map && map[orig] != null ? String(map[orig]) : "").trim();
      if (!nv || nv === orig) continue;
      if (nv.length > orig.length) { warnings.push(`${orig}: "${nv}" is too long (max ${orig.length} chars) — skipped`); continue; }
      const padded = nv + " ".repeat(orig.length - nv.length);   // same length as original
      if (nv.length < orig.length) warnings.push(`${orig}: "${nv}" is shorter — padded with spaces (may look odd in dialogue)`);
      list.push({ old: enc(orig), new: enc(padded), origName: orig, newName: nv });
    }
    return { list, warnings };
  }

  // Same-length replace of every old→new occurrence inside a buffer, in place.
  function applyAll(buf, renames) {
    for (const { old, new: nw } of renames) {
      const L = old.length;
      for (let i = 0; i + L <= buf.length; i++) {
        let hit = true;
        for (let j = 0; j < L; j++) if (buf[i + j] !== old[j]) { hit = false; break; }
        if (hit) { for (let j = 0; j < L; j++) buf[i + j] = nw[j]; i += L - 1; }
      }
    }
    return buf;
  }

  // Streaming variant: feed arbitrary chunks; matches that straddle a chunk boundary are still
  // caught via a small carry window (maxLen-1 bytes). Emits same total bytes as it's fed.
  function streamReplacer(renames) {
    const maxLen = renames.reduce((m, r) => Math.max(m, r.old.length), 1);
    let carry = new Uint8Array(0);
    return {
      push(chunk) {
        const work = new Uint8Array(carry.length + chunk.length);
        work.set(carry, 0); work.set(chunk, carry.length);
        applyAll(work, renames);
        const hold = Math.min(maxLen - 1, work.length);   // a match could start in the tail → keep it
        carry = work.slice(work.length - hold);
        return work.subarray(0, work.length - hold);
      },
      flush() { const out = carry; carry = new Uint8Array(0); return out; },
    };
  }

  const api = { RENAMEABLE, buildRenames, applyAll, streamReplacer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RenameCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
