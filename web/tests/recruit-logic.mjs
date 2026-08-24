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

console.log(fails ? `\nFAILED (${fails})` : "\nAll recruit-logic checks passed.");
process.exit(fails ? 1 : 0);
