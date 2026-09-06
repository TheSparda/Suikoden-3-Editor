// Diff decoding for the ISO editor's Changes tab — pure, DOM-free, so it can be driven
// headlessly (web/tests/changes-core.mjs).
//
// The tab answers one question: what is different between the disc you have open and a
// pristine base disc. That is two problems and only the first is trivial:
//
//   1. WHICH bytes differ — a plain run diff of two copies of the same block.
//   2. WHAT each differing byte MEANS. The editor knows where every field lives, but its
//      review list can only label fields it watched you edit: FIELD_REG is written by the
//      write path, so it is a history, not a map. A disc that arrives already patched has
//      no such history — the labels have to come from a STATIC map of the block instead.
//
// This module owns (1) and the map→row join for (2). `iso.js` owns building the map, out
// of the same table constants its views read, so a table that moves moves in one place.
//
// The map's contract, enforced by checkRegions() and asserted in the tests: regions are
// sorted by offset and DO NOT OVERLAP. Overlap would put one changed byte in two fields at
// once with no principled way to choose, so the builder resolves it rather than this join.
// And any byte no region claims is reported as an `unmapped` row rather than dropped: a
// change the tab silently omits is far worse than a row of hex, because the whole point of
// the tab is that you can trust it to be the complete list.
(function (root) {
  "use strict";

  // ---- byte-run diff ---------------------------------------------------------
  // [start,end) runs where a and b differ, as ABSOLUTE offsets (origin + index). Runs are
  // returned in ascending order and never touch: two changed bytes with one identical byte
  // between them are two runs, which keeps a run from claiming bytes that did not change.
  function runs(a, b, origin) {
    origin = origin || 0;
    const out = [], n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n) {
      if (a[i] !== b[i]) { const s = i; while (i < n && a[i] !== b[i]) i++; out.push({ off: origin + s, len: i - s }); }
      else i++;
    }
    return out;
  }

  // Total bytes across a run list — the honest "how much of the disc moved" number.
  const runBytes = (rs) => rs.reduce((a, r) => a + r.len, 0);

  // ---- the region map --------------------------------------------------------
  // A region is {off, len, group, label, kind}. `kind` is opaque here — iso.js uses it to
  // pick a formatter ("text", "num", "item", "f32", "hex", …) — but it rides along so the
  // join can hand a caller everything it needs in one row.
  function sortRegions(regions) {
    return regions.slice().sort((x, y) => x.off - y.off || x.len - y.len);
  }
  // Returns the overlapping pairs, so a builder bug is a test failure with an address in it
  // rather than a silently mislabelled row. Assumes `regions` is already sorted.
  function checkRegions(regions) {
    const bad = [];
    for (let i = 1; i < regions.length; i++) {
      const p = regions[i - 1], c = regions[i];
      if (c.off < p.off + p.len) bad.push([p, c]);
    }
    return bad;
  }

  // ---- join ------------------------------------------------------------------
  // Map changed runs onto the region map. One row per region the runs TOUCH, carrying the
  // region's full extent rather than just the changed bytes — a field whose second byte
  // moved is still that whole field, and reading "62 → 300" needs both bytes of it. Bytes
  // inside a run that no region claims come back as `unmapped` rows covering exactly the
  // unclaimed span.
  //
  // `regions` must be sorted and non-overlapping (see checkRegions).
  function overlay(rs, regions) {
    const rows = [], seen = new Set();
    // The cursor into `regions` only ever advances, so the runs have to arrive in order.
    // runs() already returns them that way; sorting a copy here means a caller that
    // assembled its own list (say, two blocks' runs concatenated) still gets every region
    // instead of silently losing the ones behind the cursor.
    const ordered = rs.slice().sort((x, y) => x.off - y.off);
    let ri = 0;
    for (const run of ordered) {
      const end = run.off + run.len;
      while (ri < regions.length && regions[ri].off + regions[ri].len <= run.off) ri++;
      let cur = run.off, j = ri;
      while (j < regions.length && regions[j].off < end) {
        const g = regions[j];
        if (g.off > cur) rows.push({ off: cur, len: Math.min(g.off, end) - cur, group: "Unmapped", label: "", kind: "hex", unmapped: true });
        if (!seen.has(j)) { seen.add(j); rows.push({ off: g.off, len: g.len, group: g.group, label: g.label, kind: g.kind, region: g }); }
        cur = Math.max(cur, g.off + g.len);
        j++;
      }
      if (cur < end) rows.push({ off: cur, len: end - cur, group: "Unmapped", label: "", kind: "hex", unmapped: true });
    }
    return rows.sort((x, y) => x.off - y.off || x.len - y.len);
  }

  // Group rows for rendering, preserving the order the groups first appear in `order` and
  // appending anything the caller didn't name (so a new region group can never go missing
  // just because someone forgot to list it).
  function byGroup(rows, order) {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.group)) m.set(r.group, []); m.get(r.group).push(r); }
    const out = [];
    for (const g of order || []) if (m.has(g)) { out.push({ group: g, rows: m.get(g) }); m.delete(g); }
    for (const [g, v] of m) out.push({ group: g, rows: v });
    return out;
  }

  root.ChangesCore = { runs, runBytes, sortRegions, checkRegions, overlay, byGroup };
})(typeof window !== "undefined" ? window : globalThis);
