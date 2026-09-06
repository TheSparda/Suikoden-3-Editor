// Unit tests for the real recruit-core.js logic (loaded as-is) against the real canonical
// team map. The save-editor UI needs Pyodide (not available headless), but this exercises
// the actual staging math that UI drives, so bulk recruit/move/un-recruit and the presets
// are covered without a browser.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const RC = require("../recruit-core.js");   // the real module (CJS export path)
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const chars = [
  { rosterIndex: 0, name: "Hugo", recruited: true, recruiter: "Hugo" },
  { rosterIndex: 1, name: "Chris", recruited: false, recruiter: "" },
  { rosterIndex: 18, name: "Salome", recruited: false, recruiter: "" },
  { rosterIndex: 5, name: "Rico", recruited: true, recruiter: "" },     // shared already
];
const byName = (n) => chars.find((c) => c.name === n);

console.log("recruit-core logic (teams model):");
{ // recState reflects staged over loaded; teams is an array
  const R = { 1: { recruited: true, teams: ["Geddoe"] } };
  check("recState uses staged edit", eq(RC.recState(byName("Chris"), R), { recruited: true, teams: ["Geddoe"] }));
  check("recState falls back to loaded (recruiter → [team])", eq(RC.recState(byName("Hugo"), R), { recruited: true, teams: ["Hugo"] }));
}
{ // recruit an unrecruited char into a team
  const R = {}; RC.setRecruit(byName("Chris"), true, ["Geddoe"], R);
  check("recruit into a team stages {recruited,teams}", eq(R[1], { recruited: true, teams: ["Geddoe"] }));
}
{ // MULTI-TEAM: a character can be on several teams at once
  const R = {}; RC.setRecruit(byName("Chris"), true, ["Chris", "Hugo", "Geddoe"], R);
  check("multi-team stages sorted team list", eq(R[1], { recruited: true, teams: ["Hugo", "Chris", "Geddoe"] }));   // canonical order
}
{ // no-op recruit is pruned (Hugo already on Hugo's team)
  const R = {}; RC.setRecruit(byName("Hugo"), true, ["Hugo"], R);
  check("no-op recruit prunes", !(0 in R));
}
{ // move an already-recruited char to a different team
  const R = {}; RC.setRecruit(byName("Hugo"), true, ["Chris"], R);
  check("move team stages new teams", eq(R[0], { recruited: true, teams: ["Chris"] }));
}
{ // un-recruit
  const R = {}; RC.setRecruit(byName("Hugo"), false, undefined, R);
  check("un-recruit stages {recruited:false}", eq(R[0], { recruited: false }));
}
{ // recruit into shared clears the teams
  const R = {}; RC.setRecruit(byName("Chris"), true, [], R);
  check("recruit into shared -> teams []", eq(R[1], { recruited: true, teams: [] }));
}

console.log("canonical presets (real s3_recruit_teams.json):");
{ const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_teams.json"), "utf8"));
  const map = {}; for (const [t, names] of Object.entries(j.teams)) for (const n of names) map[n] = t;
  check("Salome maps to Chris", map["Salome"] === "Chris");
  { const R = {}; RC.applyCanonical(chars, "Chris", map, R);
    check("canonical→Chris recruits Chris + Salome only", eq(R[1], { recruited: true, teams: ["Chris"] }) && eq(R[18], { recruited: true, teams: ["Chris"] }) && !(5 in R)); }
  { const R = {}; RC.applyCanonical(chars, "ALL", map, R);
    check("canonical→everyone: Salome=Chris, Rico=shared", eq(R[18], { recruited: true, teams: ["Chris"] }) && eq(R[5] || { recruited: true, teams: [] }, { recruited: true, teams: [] }));
    check("canonical→everyone prunes Hugo (already Hugo)", !(0 in R)); }
}
{ // Hugo recruited (Hugo), Rico recruited (shared) -> 2 total: 1 Hugo, 1 shared
  const { total, counts } = RC.teamCounts(chars, {});
  check("teamCounts totals", total === 2 && counts.Hugo === 1 && counts[""] === 1);
  // a multi-team char counts toward each of its teams
  const R = {}; RC.setRecruit(byName("Rico"), true, ["Hugo", "Chris"], R);
  const tc = RC.teamCounts(chars, R);
  check("teamCounts counts a multi-team char on each team", tc.total === 2 && tc.counts.Hugo === 2 && tc.counts.Chris === 1 && tc.counts[""] === 0); }

console.log("previewChanges (dry-run diff for the confirm modal):");
{
  const changes = RC.previewChanges(chars, {}, (m) => { RC.setRecruit(byName("Chris"), true, ["Chris"], m); RC.setRecruit(byName("Salome"), true, ["Chris"], m); });
  check("previewChanges lists both new recruits", changes.length === 2 && changes.every((c) => c.kind === "recruit"));
  const chris = changes.find((c) => c.name === "Chris");
  check("previewChanges reports before/after teams", chris && eq(chris.after.teams, ["Chris"]) && chris.before.recruited === false);
}
{ const changes = RC.previewChanges(chars, {}, (m) => { RC.setRecruit(byName("Hugo"), true, ["Hugo"], m); });   // Hugo already Hugo
  check("previewChanges empty when nothing changes", changes.length === 0);
}
{ const changes = RC.previewChanges(chars, {}, (m) => { RC.setRecruit(byName("Rico"), true, ["Geddoe"], m); });
  check("previewChanges classifies a team move", changes.length === 1 && changes[0].kind === "move" && eq(changes[0].after.teams, ["Geddoe"])); }

console.log("108-Stars checklist order (real s3_recruit_order.json):");
{
  const ORDER = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_order.json"), "utf8"));
  check("guide covers the whole roster minus Lulu (not a Star)", Object.keys(ORDER.chars).length === 108);
  check("guide keeps the four non-star helpers aside", ORDER.extras.length === 4 && ORDER.extras.every((e) => e.star === "N/A"));
  check("every star sits in a stage", Object.values(ORDER.chars).every((g) => ORDER.phases.some((p) => p.key === g.phase)));
  check("guide positions are unique", new Set(Object.values(ORDER.chars).map((g) => g.n)).size === 108);
  check("Arthur is the first optional recruit (#26)", ORDER.chars["Arthur"].n === 26 && ORDER.chars["Arthur"].phase === "opt1");
  check("the Chapter 6 four come last", ["Albert", "Luc", "Sarah", "Yuber"].every((n) => ORDER.chars[n].phase === "ch6"));
  check("Star of Destiny names come through", ORDER.chars["Chris"].star === "Tenbi" && ORDER.chars["Geddoe"].star === "Tenjyu");

  // rows as the panel builds them: roster order in, guide order out
  const mk = (name, ri, rec, story) => ({ c: { name, rosterIndex: ri }, st: { recruited: rec, teams: [] }, story, how: "" });
  const rows = [mk("Jeane", 85, true, false), mk("Hugo", 0, true, true), mk("Lulu", 9, false, false),
                mk("Arthur", 101, false, false), mk("Futch", 29, false, false), mk("Yuber", 57, false, true)];
  const ordered = RC.orderStars(rows, ORDER);
  check("orderStars sorts by the guide, not the roster",
    eq(ordered.map((r) => r.c.name), ["Hugo", "Arthur", "Jeane", "Futch", "Yuber", "Lulu"]));
  check("orderStars attaches the guide's star name + how-to",
    ordered[1].star === "Chiyou" && /Mess Hall/.test(ordered[1].guideHow));
  check("a name the guide doesn't list sorts last with no position",
    ordered[5].c.name === "Lulu" && ordered[5].n === null);

  // grouping: stage progress counts the whole stage, the listing honours the filter
  const shown = ordered.filter((r) => !r.st.recruited);          // the "missing" filter
  const groups = RC.groupStars(ordered, shown, ORDER);
  check("groups come back in stage order, and an all-recruited stage drops out",
    eq(groups.map((g) => g.key), ["opt1", "opt2", "ch6", "other"]));
  check("the recruited view keeps only the stages with something in them",
    eq(RC.groupStars(ordered, ordered.filter((r) => r.st.recruited), ORDER).map((g) => g.key), ["ch1", "opt1"]));
  const opt1 = groups.find((g) => g.key === "opt1");
  check("stage progress counts every tracked row, not just the shown ones", opt1.total === 2 && opt1.got === 1);
  check("a filtered-out row is not listed under its stage", eq(opt1.rows.map((r) => r.c.name), ["Arthur"]));
  check("the non-star helpers ride along on their own stage as extras",
    eq(groups.find((g) => g.key === "opt2").extras.map((e) => e.name), ["Koichi", "Connie", "Kosanji", "Kogoro"]));
  check("Lulu lands in the leftovers group",
    groups[groups.length - 1].key === "other" && groups[groups.length - 1].rows[0].c.name === "Lulu");
  check("nextStar is the first missing OPTIONAL star in guide order", RC.nextStar(ordered).c.name === "Arthur");
  check("nextStar is null once every optional star is in",
    RC.nextStar(ordered.map((r) => (r.story ? r : Object.assign({}, r, { st: { recruited: true, teams: [] } })))) === null);
}

{ // no guide file (offline / not built): one flat list, nothing lost
  const rows = [{ c: { name: "Hugo", rosterIndex: 0 }, st: { recruited: true, teams: [] }, story: true, how: "" },
                { c: { name: "Jeane", rosterIndex: 85 }, st: { recruited: false, teams: [] }, story: false, how: "" }];
  const ordered = RC.orderStars(rows, null);
  const groups = RC.groupStars(ordered, ordered, null);
  check("without the guide everything falls into one group in roster order",
    groups.length === 1 && eq(groups[0].rows.map((r) => r.c.name), ["Hugo", "Jeane"]));
}

console.log("recruit prerequisites (real s3_recruit_needs.json):");
{
  const NEEDS = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_needs.json"), "utf8")).chars;

  // The flagship case: the guide says "with the Rose Brooch in your inventory" and stops.
  const rose = RC.needChips(NEEDS["Augustine"], {})[0];
  check("an item's where AND when come through", /Rose Brooch/.test(rose.text)
    && /Iksay Village's Item Shop/.test(rose.text) && /stages 1-3 of 3/.test(rose.text) && /20% a visit/.test(rose.text));
  check("a rare find is called one, not passed off as stock", /rare find/.test(rose.text));

  // a drop-sourced item names the enemy, its level, the odds and the area
  const screw = RC.needChips(NEEDS["Belle"], {})[0];
  check("a dropped item names enemy, level, odds and area",
    /Screw/.test(screw.text) && /Lv\d+/.test(screw.text) && /%/.test(screw.text) && /Amur Plains/.test(screw.text));
  check("the area the how-to already names is listed first", screw.text.indexOf("Amur Plains") < screw.text.indexOf("more"));

  check("a guide line that only restates a disc-read counter is dropped", !/\(guide\)/.test(rose.text));

  // one line per hunting ground, and one enemy per enemy
  const bowl = RC.needChips(NEEDS["Mamie"], {})[0].text;
  check("drops in the same place collapse to one clause", bowl.split("dropped by").length === 2);
  check("the same enemy at two levels is one enemy", /Red Mantik Lv39\/45/.test(bowl));
  check("droppers beyond the top few are counted, not hidden", /\+\d+ more dropper/.test(bowl));

  // an errand that says BUY needs the money, not the item
  const mole = RC.needChips(NEEDS["Dominic"], { gold: 100 })[0];
  check("a bought item is priced, not fetched",
    mole.buy === true && mole.amount === 600 && /buy it from Dominic: 600 potch/.test(mole.text));
  check("...and measured against the purse", mole.ok === false && mole.short === 500);
  check("...and it is still an item chip carrying its id", mole.kind === "item" && mole.id === 194);
  check("affording it clears the chip", RC.needChips(NEEDS["Dominic"], { gold: 600 })[0].ok === true);
  check("an item you have to GIVE is not turned into a purchase",
    !(NEEDS["Barts"].items || [])[0].buy && !(NEEDS["Augustine"].items || [])[0].buy);

  // an item nothing in the repo covers says so rather than implying knowledge
  const statue = RC.needChips(NEEDS["Billy"], {});
  check("an unsourced item admits it", statue.every((c) => /no source in the editor's tables/.test(c.text)));

  check("an item the guide's own line already places says so instead",
    /only the line above/.test(RC.needChips(NEEDS["Scott"], {})[0].text));

  // potch is measured against the purse this save is carrying
  const rich = RC.needChips(NEEDS["Watari"], { gold: 250000 })[0];
  const poor = RC.needChips(NEEDS["Watari"], { gold: 5000 })[0];
  check("potch you have is marked ok", rich.kind === "potch" && rich.ok === true && /100,000 potch/.test(rich.text));
  check("potch you are short of is marked short", poor.ok === false && /you have 5,000/.test(poor.text));
  check("without a purse the potch chip makes no claim", RC.needChips(NEEDS["Watari"], {})[0].ok === null);

  // prerequisite stars carry their guide position and whether you already have them
  const ayame = RC.needChips(NEEDS["Ayame"], { recruited: (n) => n === "Watari" })[0];
  check("a star you must bring is named with its guide position", /Bring Watari \(#50\)/.test(ayame.text) && ayame.ok === true);
  const melville = RC.needChips(NEEDS["Melville"], { recruited: () => false });
  check("a star you must recruit first is phrased as such", /Recruit Billy \(#29\)/.test(melville[0].text) && melville[0].ok === false);
  check("a stated gate comes through in the guide's own words",
    melville.some((c) => c.kind === "gate" && /Must have completed Hugo Chapter 1/.test(c.text)));

  // the builder must not turn a mention into a requirement
  check("a star you FIGHT is not a prerequisite", !(NEEDS["Nei"] && NEEDS["Nei"].first));
  check("a co-join is not a prerequisite", !(NEEDS["Bright"] && NEEDS["Bright"].first));
  check("a NEGATIVE party condition is not a prerequisite", !(NEEDS["Jefferson"] && NEEDS["Jefferson"].first));
  check("an item the line says NOT to bring is not a need",
    !(NEEDS["Barts"].items || []).some((i) => /Seeds/.test(i.name)));
  check("nothing is invented for a star with no errand", !NEEDS["Kenji"]);

  check("no needs at all renders nothing", RC.needChips(undefined, {}).length === 0);
}

console.log("where a checklist '+ get it' puts the item:");
{
  // bag layout as s3save reports it: four carried bags + four storages before the merge,
  // one shared bag + storage after.
  const bag = (region, used, append) => ({ region, used, capacity: 30, items: [], appendSlots: append });
  const pre = () => ({
    global: { merged: false, partyLeader: 1 },
    inventory: [bag("Hugo", 4, [4, 5]), bag("Chris", 2, [32, 33]), bag("Geddoe", 0, [60]),
                bag("Thomas", 1, [90]), bag("Hugo storage", 0, [120, 121]), bag("Chris storage", 0, [150])],
  });
  const post = { global: { merged: true }, inventory: [bag("Party bag", 6, [6, 7]), bag("Storage", 0, [30])] };
  const teams = { Aila: ["Geddoe"], Jeane: ["Hugo", "Chris"], Lulu: [] };
  const teamsOf = (n) => teams[n] || [];

  check("after the merge everything goes in the one shared bag",
    RC.bagForNeeds(post, "Hugo", teamsOf, []).region === "Party bag");
  check("playing a protagonist uses that protagonist's own bag",
    RC.bagForNeeds(pre(), "Chris", teamsOf, []).region === "Chris");
  check("...and takes the first slot after the bag's last used entry",
    RC.bagForNeeds(pre(), "Chris", teamsOf, []).slot === 32);
  check("playing someone else's unit follows their team",
    RC.bagForNeeds(pre(), "Aila", teamsOf, []).region === "Geddoe");
  check("a unit on several teams is not guessed at, and the fallback says so", (() => {
    const t = RC.bagForNeeds(pre(), "Jeane", teamsOf, []);
    return t.region === "Hugo" && /doesn't say whose chapter/.test(t.why);   // Hugo's bag is the fullest
  })());
  check("a bag that hasn't been stocked yet is flagged, not silently used",
    RC.bagForNeeds(pre(), "Aila", teamsOf, []).unstarted === true);
  check("slots already staged this session are not handed out twice",
    RC.bagForNeeds(pre(), "Chris", teamsOf, [32]).slot === 33);
  check("a full bag overflows into that team's storage", (() => {
    const t = RC.bagForNeeds(pre(), "Hugo", teamsOf, [4, 5]);
    return t.region === "Hugo storage" && t.slot === 120 && /full/.test(t.why);
  })());
  check("with everything full it reports no slot rather than picking one",
    RC.bagForNeeds(post, "Hugo", teamsOf, [6, 7, 30]).slot === null);
  check("a save with no bags at all returns nothing",
    RC.bagForNeeds({ global: {}, inventory: [] }, "Hugo", teamsOf, []) === null);

  // the potch chip carries the shortfall the button tops up
  const NEEDS = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_needs.json"), "utf8")).chars;
  const chip = RC.needChips(NEEDS["Watari"], { gold: 42000 })[0];
  check("a potch chip carries exactly what you are short", chip.amount === 100000 && chip.short === 58000);
  check("...and nothing to top up once you can afford it", RC.needChips(NEEDS["Watari"], { gold: 100000 })[0].short === 0);
  check("an item chip carries the item id the button adds",
    RC.needChips(NEEDS["Augustine"], {})[0].id === 315);
}

console.log(fails ? `\nFAILED (${fails})` : "\nAll recruit-logic checks passed.");
process.exit(fails ? 1 : 0);
