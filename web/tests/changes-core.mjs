// The Changes tab's diff join, no browser.
//
// The tab's whole claim is that its list is COMPLETE: every byte that differs between the
// open disc and a base disc is either named or shown as hex, and none is dropped. That
// property lives entirely in this module's run→region join, so it is asserted directly
// here rather than inferred from a rendered table.
//
// The two failure modes that matter, and why each is a silent one in the browser:
//   • a dropped byte — a real change the tab never mentions, which is worse than useless
//     because the tab is what you consult to find out whether a change landed at all;
//   • a byte claimed by two regions — the map builder's bug, but it surfaces here as a
//     mislabelled row, so checkRegions exists to make it an address in a test failure.
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = globalThis;
new Function(readFileSync(path.join(WEB, "changes-core.js"), "utf8")).call(g);
const C = g.ChangesCore;

let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };
const eq = (n, a, b) => check(`${n} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));
const U = (...b) => Uint8Array.from(b);

console.log("Byte-run diff:");
eq("identical blocks produce no runs", C.runs(U(1, 2, 3), U(1, 2, 3), 0), []);
eq("one changed byte is one 1-byte run", C.runs(U(1, 2, 3), U(1, 9, 3), 0), [{ off: 1, len: 1 }]);
eq("consecutive changed bytes coalesce", C.runs(U(1, 2, 3, 4), U(1, 9, 9, 4), 0), [{ off: 1, len: 2 }]);
// The single identical byte between them must SPLIT the run: a run that swallowed it would
// report an unchanged byte as changed, and the revert button writes exactly the run.
eq("one identical byte between changes splits the run",
  C.runs(U(1, 2, 3, 4, 5), U(9, 2, 9, 4, 5), 0), [{ off: 0, len: 1 }, { off: 2, len: 1 }]);
eq("a change at the very end is not lost", C.runs(U(1, 2), U(1, 9), 0), [{ off: 1, len: 1 }]);
eq("origin is added to every offset", C.runs(U(1, 2), U(1, 9), 0x1000), [{ off: 0x1001, len: 1 }]);
check("runBytes totals the run lengths", C.runBytes([{ off: 0, len: 3 }, { off: 9, len: 4 }]) === 7);

console.log("Region map hygiene:");
const R = (off, len, label) => ({ off, len, group: "G", label, kind: "num" });
{
  const sorted = C.sortRegions([R(20, 4, "c"), R(0, 4, "a"), R(10, 4, "b")]);
  eq("sortRegions orders by offset", sorted.map((r) => r.label), ["a", "b", "c"]);
  check("disjoint regions report no overlap", C.checkRegions(sorted).length === 0);
  const bad = C.checkRegions(C.sortRegions([R(0, 8, "a"), R(4, 4, "b")]));
  check("an overlapping pair is reported", bad.length === 1 && bad[0][0].label === "a" && bad[0][1].label === "b");
  check("touching regions are not an overlap", C.checkRegions(C.sortRegions([R(0, 4, "a"), R(4, 4, "b")])).length === 0);
}

console.log("Run → region join:");
{
  const regions = C.sortRegions([R(0, 4, "a"), R(8, 4, "b"), R(20, 8, "c")]);
  // A field whose second byte moved is still that whole field: reading "62 → 300" needs
  // both bytes, so the row carries the region's extent, not the run's.
  eq("a run inside a region yields the whole region",
    C.overlay([{ off: 1, len: 1 }], regions).map((r) => [r.off, r.len, r.label]), [[0, 4, "a"]]);
  eq("a region touched by two runs appears once",
    C.overlay([{ off: 0, len: 1 }, { off: 3, len: 1 }], regions).map((r) => r.label), ["a"]);
  // The gap between two mapped fields is where an undocumented table would live; it has to
  // come back as its own row, sized to exactly the unclaimed bytes.
  eq("a run spanning region / gap / region yields three rows in order",
    C.overlay([{ off: 2, len: 8 }], regions).map((r) => [r.off, r.len, r.label || "?"]),
    [[0, 4, "a"], [4, 4, "?"], [8, 4, "b"]]);
  eq("a run entirely in a gap is one unmapped row",
    C.overlay([{ off: 5, len: 2 }], regions).map((r) => [r.off, r.len, r.unmapped]), [[5, 2, true]]);
  eq("a run past the last region still reports its tail",
    C.overlay([{ off: 26, len: 6 }], regions).map((r) => [r.off, r.len, r.label || "?"]),
    [[20, 8, "c"], [28, 4, "?"]]);
  eq("a run before the first region reports its head",
    C.overlay([{ off: 0, len: 1 }], C.sortRegions([R(4, 4, "b")])).map((r) => [r.off, r.len, r.unmapped || false]),
    [[0, 1, true]]);
  check("rows come back sorted by offset",
    C.overlay([{ off: 22, len: 1 }, { off: 1, len: 1 }], regions).map((r) => r.off).join() === "0,20");
}
{
  // The completeness property, stated directly: across a randomized map and random runs,
  // every changed byte is covered by exactly one row. This is the assertion the tab's
  // credibility rests on, so it is checked as a property rather than by example.
  let worst = "";
  for (let seed = 1; seed <= 200 && !worst; seed++) {
    let s = seed;
    const rnd = (n) => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s % n);
    const regions = [];
    for (let off = 0; off < 200;) { const gapLen = rnd(4), len = 1 + rnd(6); off += gapLen; regions.push(R(off, len, "r" + off)); off += len; }
    const rs = [];
    for (let i = 0, off = 0; i < 6 && off < 190; i++) { off += 1 + rnd(20); const len = 1 + rnd(12); rs.push({ off, len }); off += len; }
    const rows = C.overlay(rs, C.sortRegions(regions));
    const cover = new Map();
    for (const r of rows) for (let i = r.off; i < r.off + r.len; i++) cover.set(i, (cover.get(i) || 0) + 1);
    for (const run of rs) for (let i = run.off; i < run.off + run.len; i++)
      if (cover.get(i) !== 1) { worst = `seed ${seed}: byte ${i} covered ${cover.get(i) || 0}x`; break; }
  }
  check(`every changed byte is covered exactly once, 200 randomized maps${worst ? " — " + worst : ""}`, !worst);
}

console.log("Grouping for display:");
{
  const rows = [{ group: "Text" }, { group: "Zzz" }, { group: "Spells" }, { group: "Text" }];
  const gs = C.byGroup(rows, ["Text", "Spells"]);
  eq("named groups come first, in the order given", gs.map((x) => x.group), ["Text", "Spells", "Zzz"]);
  check("rows stay with their group", gs[0].rows.length === 2);
  // A group the caller forgot to name must still render — dropping it would hide changes.
  check("an unnamed group is appended, never dropped", gs[2].rows.length === 1);
}

console.log(fails ? `\n${fails} check(s) failed.` : "\nAll checks passed.");
process.exit(fails ? 1 : 0);
