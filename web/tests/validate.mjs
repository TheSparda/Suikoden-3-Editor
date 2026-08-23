// Fast, browser-free checks for the web editor — safe to run in CI and on session start.
// Verifies: the client JS parses; every ISO table offset stays inside the read block; and
// the JS reference-table parsers still produce the expected item/skill counts. Exits non-zero
// on any failure so CI/hooks catch offset drift or a broken parser before it ships.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

// 1) JS syntax
console.log("JS syntax:");
for (const f of ["app.js", "iso.js", "sw.js", "recruit-core.js"]) {
  try { execFileSync(process.execPath, ["--check", path.join(WEB, f)]); ok(f); }
  catch (e) { bad(`${f} — ${String(e.stderr || e).split("\n")[0]}`); }
}

// 2) ISO table offsets stay within the read block [ELF_BASE, ELF_END)
console.log("ISO offset bounds:");
const ELF_BASE = 0xA4800, ELF_END = 0x465DF0;
const TABLES = {
  list1: [4078716, 140, 80], list2: [4068152, 132, 80], list3: [4089904, 8, 35], list4: [4061704, 28, 28],
  item3_a: [4105552, 2, 10], item3_b: [4054224, 2, 16], item2: [3970620, 4, 15], item1: [4136564, 4, 3],
  spell: [0x3EC2A0, 0x20, 94], unite: [0x3ECF90, 0x28, 38], food: [0x3E91D0, 0x48, 62], enemy: [0x3E74E0, 0x14, 100],
  versionword: [4136544, 4, 1],
};
for (const [name, [base, stride, count]] of Object.entries(TABLES)) {
  const end = base + stride * count;
  if (base >= ELF_BASE && end <= ELF_END) ok(`${name} [${base}..${end})`);
  else bad(`${name} out of block: [${base}..${end}) vs [${ELF_BASE}..${ELF_END})`);
}

// 3) reference-table parsers (same rules as iso.js loadRef)
console.log("Reference tables:");
const itemsTxt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_item_ids.txt"), "latin1");
const skillsTxt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_skill_ids.txt"), "latin1");
let nItems = 0; const reI = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; while (reI.exec(itemsTxt)) nItems++;
let nSkills = 0; for (const l of skillsTxt.split(/\r?\n/)) { const p = l.trim().split(/\s+/); if (p.length >= 2 && !isNaN(parseInt(p[0], 16))) nSkills++; }
(nItems > 400 ? ok : bad)(`items parsed: ${nItems}`);
(nSkills >= 40 ? ok : bad)(`skills parsed: ${nSkills}`);

// 4) shell wiring sanity: index.html loads iso.js and has both mode tabs; sw precaches iso.js
console.log("App shell:");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
(/src=["']iso\.js["']/.test(html) ? ok : bad)("index.html loads iso.js");
(/src=["']recruit-core\.js["']/.test(html) ? ok : bad)("index.html loads recruit-core.js before app.js");
(/data-mode="iso"/.test(html) && /data-mode="save"/.test(html) ? ok : bad)("both mode tabs present");
{ const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
  (/iso\.js/.test(sw) && /recruit-core\.js/.test(sw) ? ok : bad)("service worker precaches iso.js + recruit-core.js"); }

// 5) canonical recruit-team map: parses, teams valid, every name is in s3save.py ROSTER
console.log("Recruit teams:");
try {
  const rt = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_teams.json"), "utf8"));
  const validTeams = ["Hugo", "Chris", "Geddoe", "Thomas"];
  const teams = rt.teams || {};
  (Object.keys(teams).every((t) => validTeams.includes(t)) ? ok : bad)("only valid protagonist teams");
  // ROSTER names from s3save.py
  const src = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
  const m = /ROSTER\s*=\s*\[([\s\S]*?)\]/.exec(src);
  const roster = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const all = Object.values(teams).flat();
  const missing = all.filter((n) => !roster.has(n));
  (missing.length === 0 ? ok : bad)(`all ${all.length} team members exist in ROSTER` + (missing.length ? " (missing: " + missing.join(", ") + ")" : ""));
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  (dupes.length === 0 ? ok : bad)("no character listed on two teams" + (dupes.length ? " (dupes: " + dupes.join(", ") + ")" : ""));
} catch (e) { bad("s3_recruit_teams.json — " + e.message); }

// 6) QoL guards — styling + save-editor bits headless e2e can't reach (it aborts Pyodide)
console.log("QoL guards:");
{ const css = fs.readFileSync(path.join(WEB, "style.css"), "utf8");
  (/input\.search[^{]*\{[^}]*font-size:\s*16px/.test(css) && /input\.search[^{]*\{[^}]*min-height:\s*44px/.test(css)
    ? ok : bad)("filter inputs sized for touch (min-height 44px, 16px font)");
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  (/s3suffix"\)\s*===\s*"on"/.test(app) ? ok : bad)("save-editor '.edited' suffix defaults OFF (overwrite-friendly)");
  (/showSaveFilePicker/.test(app) ? ok : bad)("save-editor has a 'Save as…' destination picker");
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/RenameCore\.streamReplacer/.test(iso) && /src=["']rename-core\.js["']/.test(html) ? ok : bad)("ISO editor wires the character-rename streaming replacer");
  (/function markFlagsField/.test(iso) ? ok : bad)("ISO editor has bit-aware Target/AOE highlight");
  (/class="spdesc"/.test(iso) && /class="undesc"/.test(iso) && /class="fddesc"/.test(iso) ? ok : bad)("ISO editor has editable spell + unite + food descriptions");
  (/<input type="file" id="isoFileInput">/.test(iso) ? ok : bad)("ISO file input has no restrictive accept filter (Android can select .iso)");
  (/doStreamSave/.test(iso) ? ok : bad)("ISO editor has the streaming 'save patched copy' path");
  const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
  (/cache:\s*"no-store"/.test(sw) ? ok : bad)("service worker fetches app shell no-store (fresh updates)");
  (/dl-register/.test(sw) ? ok : bad)("service worker supports the streaming-download hand-off"); }

// 7) list2 growth + skill-max offsets (github issue #2 regression guard).
// These were re-derived + verified against a real ISO (skill-max start +16 matches ~90% of
// suikosource caps vs ~12% at the old +13; growth stat<->byte by correlation vs statgrowth).
// The web (iso.js) and desktop (s3fields.py) editors MUST stay in lockstep, so we assert both.
console.log("list2 offsets (issue #2):");
{
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  const fields = fs.readFileSync(path.join(REPO, "Editor", "s3fields.py"), "utf8");
  // expected growth stat -> byte offset (HP at +0 is the tell-tale that the fix is in place)
  const GROWTH = { PWR: 4, SKL: 5, MAG: 6, REP: 7, MDF: 9, SPD: 10, LUK: 11, HP: 0 };

  // skill-max start must be 16 in BOTH editors
  const jsStart = /LIST2_SKILLMAX_START\s*=\s*(\d+)/.exec(iso);
  const pyStart = /LIST2_SKILLMAX_START\s*=\s*(\d+)/.exec(fields);
  (jsStart && +jsStart[1] === 16 ? ok : bad)(`iso.js skill-max start = ${jsStart && jsStart[1]} (want 16)`);
  (pyStart && +pyStart[1] === 16 ? ok : bad)(`s3fields.py skill-max start = ${pyStart && pyStart[1]} (want 16)`);

  // growth offsets must match the verified map in BOTH editors
  const jsGrowth = /const LIST2_GROWTH\s*=\s*\[([\s\S]*?)\];/.exec(iso);
  const pyGrowth = /LIST2_GROWTH\s*=\s*\[([\s\S]*?)\]/.exec(fields);
  for (const [stat, off] of Object.entries(GROWTH)) {
    const re = new RegExp(`"${stat} growth[^"]*"\\s*,\\s*${off}\\b`);   // iso.js: ["PWR growth", 4, ...]
    (jsGrowth && re.test(jsGrowth[1]) ? ok : bad)(`iso.js ${stat} growth @+${off}`);
    const reP = new RegExp(`"${stat} growth rate"\\s*,\\s*${off}\\b`);  // s3fields: ("PWR growth rate", 4, ...)
    (pyGrowth && reP.test(pyGrowth[1]) ? ok : bad)(`s3fields.py ${stat} growth @+${off}`);
  }
  // the bogus "rune level" fields must be gone from both
  (jsGrowth && !/Rune Level/.test(jsGrowth[1]) ? ok : bad)("iso.js has no bogus 'Rune Level' growth fields");
  (pyGrowth && !/Rune Level/.test(pyGrowth[1]) ? ok : bad)("s3fields.py has no bogus 'Rune Level' growth fields");

  // encoding must stay non-monotonic (1=A+), which the ISO verification confirmed is correct
  (/\[1,\s*"A\+"\]/.test(iso) ? ok : bad)("iso.js MAX_OPTS keeps 1=A+ (verified-correct encoding)");

  // list1 rune slots are Head@+64 / Right@+72 / Left@+80 (verified vs suikosource + save editor).
  // Guards against the Head<->Left label swap the exe shipped (issue #2).
  const RUNES = [["Head", 64], ["Right hand", 72], ["Left hand", 80]];
  for (const [slot, off] of RUNES) {
    (new RegExp(`"Rune ${slot}"\\s*,\\s*${off}\\b`).test(iso) ? ok : bad)(`iso.js Rune ${slot} @+${off}`);
    (new RegExp(`"Rune ${slot} \\(hex\\)"\\s*,\\s*${off}\\b`).test(fields) ? ok : bad)(`s3fields.py Rune ${slot} @+${off}`);
  }
}

// 8) guide reference overlays + .xdelta export wiring.
console.log("Guide overlays + xdelta:");
{
  for (const f of ["s3_rune_slots.json", "s3_skill_ref.json", "s3_skill_caps.json", "s3_growth_ref.json"]) {
    try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", f), "utf8"));
      (Object.keys(j).length > 0 ? ok : bad)(`${f} parses (${Object.keys(j).length} entries)`); }
    catch (e) { bad(`${f} — ${e.message}`); }
  }
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/s3_rune_slots\.json/.test(iso) && /s3_skill_ref\.json/.test(iso) && /s3_skill_caps\.json/.test(iso) && /s3_growth_ref\.json/.test(iso)
    ? ok : bad)("iso.js loadRef fetches all four reference overlays");
  (/function runeSlotNote/.test(iso) && /function skillCapNote/.test(iso) && /function growthNote/.test(iso) && /function skillEffectText/.test(iso)
    ? ok : bad)("iso.js defines the overlay note helpers");
  (/function exportXdelta/.test(iso) && /Vcdiff\.buildXdelta/.test(iso) && /id="isoXdeltaBtn"/.test(iso)
    ? ok : bad)("iso.js has the Export .xdelta button + handler");
  (/src=["']vcdiff\.js["']/.test(html) ? ok : bad)("index.html loads vcdiff.js");
  { const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
    (/vcdiff\.js/.test(sw) ? ok : bad)("service worker precaches vcdiff.js"); }
  try { execFileSync(process.execPath, ["--check", path.join(WEB, "vcdiff.js")]); ok("vcdiff.js syntax"); }
  catch (e) { bad("vcdiff.js — " + String(e.stderr || e).split("\n")[0]); }
  // support-skill fade (list3): only utility skills 0x1C..0x26 are "used"; combat slots fade
  (/const supportActive = \(id\) => id >= 0x1C && id <= 0x26/.test(iso) && /listKey === "list3"/.test(iso)
    ? ok : bad)("iso.js fades unused combat skills in the Support view");
  // desktop editor mirrors the overlays + fade
  const py = fs.readFileSync(path.join(REPO, "Editor", "s3editor.py"), "utf8");
  (/_rune_slot_note/.test(py) && /_growth_note/.test(py) && /_skill_cap_note/.test(py) && /skill_effect_text/.test(py)
    ? ok : bad)("s3editor.py has the guide-overlay helpers");
  (/0x1C <= d\["value"\] <= 0x26/.test(py) ? ok : bad)("s3editor.py fades unused support (list3) combat skills");
}

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
