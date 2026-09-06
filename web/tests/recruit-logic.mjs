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

console.log(fails ? `\nFAILED (${fails})` : "\nAll recruit-logic checks passed.");
process.exit(fails ? 1 : 0);
