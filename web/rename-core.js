// Pure character-rename logic shared by the ISO editor (iso.js) and the Node tests.
// No DOM / no disc I/O — just the same-length byte-replacement used to rename a character
// EVERYWHERE on the disc during a streaming save. Same-length is the safety guarantee: it
// shifts zero bytes, so it can't corrupt any table, script offset, or pointer — anywhere.
//
// Scope is intentionally the distinctive main-cast names (no substring false-matches).
(function (root) {
  // Originals that are distinctive enough to global-replace. The test for adding one is that
  // it never occurs inside a longer word anywhere on the disc, or a same-length replace would
  // corrupt that word too. Checked on a pristine SLUS-20387: Koroku appears 139 times and
  // every one is the bare name (`grep -aoE '[A-Za-z]{0,6}Koroku[A-Za-z]{0,6}'` returns only
  // "Koroku"). Names like Luc fail that test — "Lucia", "Luck" — and are deliberately absent.
  const RENAMEABLE = ["Hugo", "Chris", "Geddoe", "Koroku"];

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
  //
  // This is the hot loop of a streaming save: a 4 GB disc is scanned end to end, on a phone.
  // A plain byte-at-a-time search costs ~6 s per GB there, so the scan runs SWAR-style — read
  // four bytes as one 32-bit word and test whether ANY of them equals a rename's first byte
  // (the classic (x-0x01010101) & ~x & 0x80808080 trick, which is byte-wise and so needs no
  // endianness assumption). Only a word that could contain a first byte drops to a byte-wise
  // compare. Same result as the naive loop — measured at ~6.5x its speed on 512 MB.
  function applyAll(buf, renames) {
    if (!renames || !renames.length) return buf;
    const n = buf.length;
    const byFirst = new Array(256), firsts = [];     // first byte -> the renames starting with it
    for (const r of renames) {
      const c = r.old[0];
      if (!byFirst[c]) { byFirst[c] = []; firsts.push(c); }
      byFirst[c].push(r);
    }
    // Try every rename at position i; on a hit, overwrite in place and return its length.
    const at = (i) => {
      const cands = byFirst[buf[i]];
      if (!cands) return 0;
      for (const { old, new: nw } of cands) {
        const L = old.length;
        if (i + L > n) continue;
        let hit = true;
        for (let j = 1; j < L; j++) if (buf[i + j] !== old[j]) { hit = false; break; }
        if (hit) { for (let j = 0; j < L; j++) buf[i + j] = nw[j]; return L; }
      }
      return 0;
    };
    // i is the next position allowed to START a match — a hit skips past its own bytes, so a
    // replacement can never be re-matched (the "Hugo"→"Hugh" case the unit tests pin down).
    let i = 0;
    const head = Math.min(n, (4 - (buf.byteOffset & 3)) & 3);   // bytes before the word view
    while (i < head) { const L = at(i); i += L || 1; }
    const words = (n - head) >> 2;
    if (words > 0) {
      const u32 = new Uint32Array(buf.buffer, buf.byteOffset + head, words);
      const masks = firsts.map((c) => (c * 0x01010101) >>> 0), m = masks.length;
      for (let w = 0; w < words; w++) {
        const v = u32[w];
        let maybe = false;
        for (let k = 0; k < m; k++) {
          const x = (v ^ masks[k]) >>> 0;
          if ((((x - 0x01010101) & ~x & 0x80808080) >>> 0) !== 0) { maybe = true; break; }
        }
        if (!maybe) continue;                       // no candidate first byte in these 4 bytes
        const base = head + (w << 2), end = base + 4;
        if (i < base) i = base;                     // never re-enter bytes an earlier hit ate
        while (i < end) { const L = at(i); i += L || 1; }
      }
    }
    const tail = head + (words << 2);
    if (i < tail) i = tail;
    while (i < n) { const L = at(i); i += L || 1; }
    return buf;
  }

  const NOTHING = new Uint8Array(0);

  // Streaming variant: feed arbitrary chunks; matches that straddle a chunk boundary are still
  // caught via a small carry window (maxLen-1 bytes). Emits same total bytes as it's fed.
  // With no renames staged (the common save) this is a pass-through: returning the caller's
  // chunk untouched skips a full copy of the disc — 4 GB of allocation and memcpy per save.
  function streamReplacer(renames) {
    if (!renames || !renames.length) return { push: (chunk) => chunk, flush: () => NOTHING };
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
      flush() { const out = carry; carry = NOTHING; return out; },
    };
  }

  const api = { RENAMEABLE, buildRenames, applyAll, streamReplacer };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RenameCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
