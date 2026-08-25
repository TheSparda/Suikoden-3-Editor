// Behavioral tests for the real guide-core.js — the join that decides whether the save
// editor shows a guide note under a character's stats, skills and rune slots.
//
// This is deliberately run against the COMMITTED reference JSON and the REAL s3save.ROSTER
// (parsed out of the engine, the same trick Editor/build_recruit_meta.py uses), not a
// fixture: the failure mode being guarded is a *name* drifting on either side — a roster
// rename, or a regenerated guide file keyed differently — which silently drops every note
// with no error anywhere. Coverage counts catch exactly that.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const G = require("../guide-core.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.resolve(HERE, "..", "..", "Editor");
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(EDITOR, f), "utf8"));

let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };

const GUIDE = {
  caps: readJSON("s3_skill_caps.json"),
  growth: readJSON("s3_growth_ref.json"),
  slots: readJSON("s3_rune_slots.json"),
};

// The save editor names characters from s3save.ROSTER, so the join must be tested against it.
function roster() {
  const src = fs.readFileSync(path.join(EDITOR, "s3save.py"), "utf8");
  const m = /^ROSTER = \[(.*?)^\]/ms.exec(src);
  if (!m) throw new Error("could not parse ROSTER out of s3save.py");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
const ROSTER = roster();

console.log("guide-core:");

// ---- the name join ---------------------------------------------------------
check(`ROSTER parsed out of the engine (${ROSTER.length} entries)`, ROSTER.length > 100 && ROSTER[0] === "Hugo");
check("alias maps a roster name onto its guide key", G.key("Viki") === "Viki (Old)" && G.key("Sanae Y") === "Sanae Y.");
check("un-aliased names pass through unchanged", G.key("Hugo") === "Hugo" && G.key("Ace") === "Ace");
check("every ALIAS target differs from its source", Object.entries(G.ALIAS).every(([a, b]) => a !== b));

// Coverage guard. These are the counts the join resolves today; the remainder are list3
// support characters (no combat guide entry exists for them) plus a few the guides omit.
// A DROP here means a name drifted — notes vanished silently. A RISE is fine: bump these.
{
  const cov = G.coverage(GUIDE, ROSTER);
  check(`skill-cap coverage ${cov.caps}/${cov.roster} (>= 71)`, cov.caps >= 71);
  check(`growth coverage ${cov.growth}/${cov.roster} (>= 70)`, cov.growth >= 70);
  check(`rune-slot coverage ${cov.slots}/${cov.roster} (>= 71)`, cov.slots >= 71);
}

// ---- skill caps ------------------------------------------------------------
check("known cap resolves to its grade", G.skillCap(GUIDE, "Hugo", 10).grade === "S");
check("a second character's cap differs (not a constant)", G.skillCap(GUIDE, "Ace", 3).grade === "B");
check("skill the character can't learn -> in guide, no grade",
  G.skillCap(GUIDE, "Hugo", 40) && G.skillCap(GUIDE, "Hugo", 40).grade === null);
check("character absent from the guide -> no note at all", G.skillCap(GUIDE, "Apple", 1) === null);
check("empty skill slot (id 0) -> no note", G.skillCap(GUIDE, "Hugo", 0) === null);

// ---- growth ----------------------------------------------------------------
{
  const pwr = G.growth(GUIDE, "Hugo", "PWR");
  check("growth returns rate + Lv-99 range", pwr && pwr.rate === "04" && pwr.end === "90-188");
  check("HP growth is present (drives the Max HP note)",
    (G.growth(GUIDE, "Hugo", "HP") || {}).end === "470-626");
  check("PDF has no guide row -> no note (save tracks it, guide doesn't)",
    G.growth(GUIDE, "Hugo", "PDF") === null);
  check("unknown character -> null", G.growth(GUIDE, "Nobody", "PWR") === null);
  // every stat the module advertises must actually exist for a well-covered character
  check("all GROWTH_STATS resolve for a main character",
    G.GROWTH_STATS.every((s) => G.growth(GUIDE, "Chris", s)));
}

// ---- rune slots ------------------------------------------------------------
check("locked slot reports its unlock level",
  JSON.stringify(G.runeSlot(GUIDE, "Ace", "leftRune")) === JSON.stringify({ state: "opens", lv: 32 }));
check("innate rune reports the rune name",
  (G.runeSlot(GUIDE, "Ace", "rightRune") || {}).rune === "Double Tusk");
check("slot keys map to the save editor's equip keys, not the ISO labels",
  (G.runeSlot(GUIDE, "Hugo", "leftRune") || {}).rune === "Wind" &&
  (G.runeSlot(GUIDE, "Hugo", "rightRune") || {}).state === "opens");
check("empty slot reports none", (G.runeSlot(GUIDE, "Hugo", "headRune") || {}).state === "none");
check("a non-rune equip slot gets no note", G.runeSlot(GUIDE, "Hugo", "armor") === null);

// ---- join level ------------------------------------------------------------
check("initial level/weapon level resolve",
  JSON.stringify(G.initial(GUIDE, "Chris")) === JSON.stringify({ lv: "20", wlv: "5" }));
check("unknown character has no join level", G.initial(GUIDE, "Apple") === null);

// ---- graceful degradation --------------------------------------------------
// A missing/unfetchable reference file must hide its notes, never throw (app.js substitutes {}).
{
  const empty = { caps: {}, growth: {}, slots: {} };
  check("empty tables return null everywhere, no throw",
    G.skillCap(empty, "Hugo", 1) === null && G.growth(empty, "Hugo", "PWR") === null &&
    G.runeSlot(empty, "Hugo", "headRune") === null && G.initial(empty, "Hugo") === null);
  check("a null guide is tolerated",
    G.skillCap(null, "Hugo", 1) === null && G.runeSlot(null, "Hugo", "headRune") === null);
  check("coverage of empty tables is 0", G.coverage(empty, ROSTER).caps === 0);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll guide-core checks passed.");
process.exit(fails ? 1 : 0);
