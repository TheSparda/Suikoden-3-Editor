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
for (const f of ["app.js", "iso.js", "sw.js", "recruit-core.js", "rename-core.js", "guide-core.js", "health-core.js", "text-core.js", "vcdiff.js"]) {
  try { execFileSync(process.execPath, ["--check", path.join(WEB, f)]); ok(f); }
  catch (e) { bad(`${f} — ${String(e.stderr || e).split("\n")[0]}`); }
}

// 2) ISO table offsets stay within the read block [ELF_BASE, ELF_END)
console.log("ISO offset bounds:");
const ELF_BASE = 0xA4800, ELF_END = 0x465DF0;
const TABLES = {
  list1: [4078716, 140, 80], list2: [4068152, 132, 80], list3: [4089904, 8, 35], list4: [4061704, 28, 28],
  // shop counters: 14 locations x 4 stages x 0x7C, so bound the whole array, not just record 0
  shopItem: [4105552, 0x7C, 14 * 4], shopArmor: [4054224, 0x7C, 14 * 4], shopRune: [0x3EEB48, 0x7C, 14 * 4],
  priceLadder: [3970620, 4, 15], item1: [4136564, 4, 3],
  spell: [0x3EC2A0, 0x20, 94], unite: [0x3ECF90, 0x28, 38], food: [0x3E91D0, 0x48, 60], enemy: [0x3E74E0, 0x14, 100],
  // rune item table is indexed by ITEM id; only ids 317..462 are runes, so bound that window
  runes: [0x3EAF78 + 317 * 0x20, 0x20, 462 - 317 + 1],
  versionword: [4136544, 4, 1],
};
// IsValidRidePair's eight rider/mount immediates (Mounts tab) — individual code sites,
// not a strided table, so bound-check them one by one.
const MOUNT_SITES = [0x130384, 0x13038C, 0x130390, 0x130398, 0x1303A0, 0x1303A4, 0x1303AC, 0x1303B4];
for (const [name, [base, stride, count]] of Object.entries(TABLES)) {
  const end = base + stride * count;
  if (base >= ELF_BASE && end <= ELF_END) ok(`${name} [${base}..${end})`);
  else bad(`${name} out of block: [${base}..${end}) vs [${ELF_BASE}..${ELF_END})`);
}
{
  const oob = MOUNT_SITES.filter((o) => o < ELF_BASE || o + 4 > ELF_END);
  if (oob.length) bad(`mount pair sites out of block: ${oob.map((o) => "0x" + o.toString(16)).join(", ")}`);
  else ok(`mount pair sites (${MOUNT_SITES.length} code sites in block)`);
}

// 2b) shop counter index: the JSON the Shops tab labels itself from must agree with the
// offsets above, and must not name a location that has no stock on the disc.
console.log("Shop counter index:");
{
  const sp = path.join(REPO, "Editor", "s3_shops.json");
  if (!fs.existsSync(sp)) bad("Editor/s3_shops.json missing");
  else {
    const j = JSON.parse(fs.readFileSync(sp, "utf8"));
    const g = j.geometry || {};
    (g.stride === 0x7C && g.variantStride === 0x1F0 && g.stockSlots === 30
      && g.rarityOff === 0x3C && g.rarityStride === 0x10 && g.rarityCount === 4 ? ok : bad)("geometry matches iso.js");
    (g.rarityOff + g.rarityCount * g.rarityStride === g.stride ? ok : bad)("rarity block exactly fills the record tail");
    (g.stockSlots * 2 === g.rarityOff ? ok : bad)("stock slots exactly fill the record head");
    const bases = { "Item Shop": 4105552, "Armor Shop": 4054224, "Rune Shop": 0x3EEB48 };
    for (const c of j.counters || []) {
      (bases[c.name] === c.base ? ok : bad)(`${c.name} base 0x${c.base.toString(16)}`);
      const end = c.base + g.locations * g.variantStride;
      (c.base >= ELF_BASE && end <= ELF_END ? ok : bad)(`${c.name} array stays in the read block`);
    }
    const stocked = new Set((j.counters || []).flatMap((c) => (c.stocked || []).map((x) => x.loc)));
    const named = Object.keys(j.locationNames || {}).map(Number);
    (named.length > 0 ? ok : bad)(`${named.length} locations named`);
    (named.every((l) => stocked.has(l)) ? ok : bad)("every named location actually has stock");
    (named.every((l) => (j.locationNames[l].evidence || "").length > 20) ? ok : bad)("every name cites its evidence");
    // each counter's 14-location array must stop before the next known table starts
    const NEXT = { "Item Shop": 0x3EC2A0 /* spells */, "Armor Shop": 4061704 /* list4 */, "Rune Shop": 4136564 /* item1 */ };
    for (const c of j.counters || [])
      (c.base + g.locations * g.variantStride <= NEXT[c.name] ? ok : bad)(`${c.name} stops before the next table`);
  }
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
(/src=["']guide-core\.js["']/.test(html) ? ok : bad)("index.html loads guide-core.js before app.js");
(/src=["']health-core\.js["']/.test(html) ? ok : bad)("index.html loads health-core.js before app.js");
(/src=["']text-core\.js["']/.test(html) ? ok : bad)("index.html loads text-core.js before iso.js");
(/data-mode="iso"/.test(html) && /data-mode="save"/.test(html) ? ok : bad)("both mode tabs present");
{ const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
  (/iso\.js/.test(sw) && /recruit-core\.js/.test(sw) ? ok : bad)("service worker precaches iso.js + recruit-core.js");
  (/guide-core\.js/.test(sw) ? ok : bad)("service worker precaches guide-core.js");
  (/health-core\.js/.test(sw) ? ok : bad)("service worker precaches health-core.js"); }

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
  // Guide overlays: the join itself is covered behaviorally by guide-core.mjs; these assert the
  // save editor actually fetches the three files and renders a note for each kind of field.
  (/s3_skill_caps\.json/.test(app) && /s3_growth_ref\.json/.test(app) && /s3_rune_slots\.json/.test(app)
    ? ok : bad)("save-editor fetches the skill-cap / growth / rune-slot guides");
  (/GuideCore\./.test(app) ? ok : bad)("save-editor uses the pure GuideCore join (not an inline copy)");
  // Health check: the panel must drive the pure audit, over the STAGED edits, and must never
  // write on its own — a Fix only stages ops the normal Apply path then reviews.
  (/HealthCore\.audit\(/.test(app) && /data-sub="health"/.test(app) && /function drawHealth/.test(app)
    ? ok : bad)("save editor has the Health panel wired to HealthCore.audit");
  (/edits: EDITS, inv: INV, party: PARTY, recruit: RECRUIT, gold: GOLD/.test(app)
    ? ok : bad)("the audit runs over the pending edits, not just the file on disk");
  (/function applyFixOps/.test(app) && !/py\.runPython[^\n]*applyFixOps/.test(app)
    ? ok : bad)("a Health fix only stages edits (no direct write path)");
  // the item-classification rules exist once, in health-core, not copied back into app.js
  (/HealthCore\.itemStackable/.test(app) && !/ITEM_ONE_PER_SLOT_EXC = new Set/.test(app)
    ? ok : bad)("app.js uses the shared item rules instead of a second copy");
  (/growthNoteSave\(c\.name, n\)/.test(app) && /runeSlotNoteSave\(c\.name, key\)/.test(app) && /capNote\(c\.name, sk\.id\)/.test(app)
    ? ok : bad)("save-editor renders guide notes on stats, rune slots and skill slots");
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/RenameCore\.streamReplacer/.test(iso) && /src=["']rename-core\.js["']/.test(html) ? ok : bad)("ISO editor wires the character-rename streaming replacer");
  (/function markFlagsField/.test(iso) ? ok : bad)("ISO editor has bit-aware Target/AOE highlight");
  (/class="spdesc"/.test(iso) && /class="undesc"/.test(iso) && /class="fddesc"/.test(iso) ? ok : bad)("ISO editor has editable spell + unite + food descriptions");
  (/<input type="file" id="isoFileInput">/.test(iso) ? ok : bad)("ISO file input has no restrictive accept filter (Android can select .iso)");
  (/doStreamSave/.test(iso) ? ok : bad)("ISO editor has the streaming 'save patched copy' path");
  // Applying patches: sniff the format by magic, walk windows, stage rather than write.
  (/async function applyXdelta/.test(iso) && /Vcdiff\.eachWindow/.test(iso)
    ? ok : bad)("ISO editor can apply an .xdelta patch");
  (/0xd6 && head\[1\] === 0xc3/.test(iso) ? ok : bad)("import sniffs VCDIFF magic (not the file extension)");
  (/w\.plan\(\)\.length/.test(iso) ? ok : bad)("apply-patch skips untouched windows (no whole-disc read)");
  (/outside the region/.test(iso) ? ok : bad)("apply-patch refuses a patch that reaches outside the editable block");
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

// 7b) spell/unite tail fields (radius + status chance). These live in the record's LAST 8
// bytes, which the table stores one record out of phase — so a spell reads them at
// base+stride+x while a unite (8 bytes longer) reads them inside its own record at +0x20+x.
// Getting that phase wrong reads a neighbour's data, so pin both offset sets and the
// s3patch.py constants that must agree with them.
console.log("spell/unite tail fields (radius/chance):");
{
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  const patch = fs.readFileSync(path.join(REPO, "Editor", "s3patch.py"), "utf8");
  const cons = (name) => {
    const m = new RegExp(`const ${name} = (\\{[^}]*\\})`).exec(iso);
    return m ? JSON.parse(m[1].replace(/([a-z]+):/g, '"$1":').replace(/0x[0-9A-Fa-f]+/g, (h) => parseInt(h, 16))) : null;
  };
  const SPELL = cons("SPELL"), UNITE = cons("UNITE");
  const want = { SPELL: { radius: 0x21, chance: 0x26, elem: 0x24 }, UNITE: { radius: 0x21, chance: 0x24 } };
  for (const [tbl, got] of [["SPELL", SPELL], ["UNITE", UNITE]]) {
    if (!got) { bad(`iso.js ${tbl} table const not found`); continue; }
    for (const [f, exp] of Object.entries(want[tbl]))
      (got[f] === exp ? ok : bad)(`iso.js ${tbl}.${f} = 0x${(got[f] ?? 0).toString(16)} (want 0x${exp.toString(16)})`);
    // the tail of the last record the editor actually reads must land inside the read block
    // (a spell's tail is one record ahead, so the last readable spell is count-2)
    const last = tbl === "SPELL" ? got.count - 2 : got.count - 1;
    const tail = got.off + last * got.stride + got.chance + 2;
    (tail <= ELF_END ? ok : bad)(`${tbl} last tail read ends at ${tail} (block ends ${ELF_END})`);
  }
  // s3patch.py must use the same phase, or the CLI reports a neighbour's values (the old "misc")
  const py = (re, exp, label) => { const m = re.exec(patch); (m && eval(m[1]) === exp ? ok : bad)(`s3patch.py ${label} = ${m && m[1]} (want 0x${exp.toString(16)})`); };
  py(/SPELL_RADIUS_OFF\s*=\s*SPELL_STRIDE \+ (0x[0-9A-Fa-f]+)/, 0x01, "SPELL_RADIUS_OFF - stride");
  py(/SPELL_CHANCE_OFF\s*=\s*SPELL_STRIDE \+ (0x[0-9A-Fa-f]+)/, 0x06, "SPELL_CHANCE_OFF - stride");
  py(/UNITE_RADIUS_OFF\s*=\s*(0x[0-9A-Fa-f]+)/, 0x21, "UNITE_RADIUS_OFF");
  py(/UNITE_CHANCE_OFF\s*=\s*(0x[0-9A-Fa-f]+)/, 0x24, "UNITE_CHANCE_OFF");
  // the phase-shifted "misc" field must be gone (it read the chance byte one record early)
  (/"misc":/.test(patch) ? bad : ok)("s3patch.py no longer exposes the off-by-one-record 'misc' field");
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
  // rune + food item-description enrichment (blank in the item-desc pool; sourced from the
  // spell + food tables read live from the ISO)
  (/function runeDesc/.test(iso) && /function foodDesc/.test(iso) && /const itemDesc =/.test(iso) && /desc: itemDesc\(id\)/.test(iso)
    ? ok : bad)("iso.js enriches rune + food item descriptions");
  (/def _enriched_item_descs/.test(py) && /_enriched_item_descs\(\)/.test(py)
    ? ok : bad)("s3editor.py enriches rune + food item descriptions");
  // food/recipe table is 60 dishes (recs 60-61 resolve to consumable items, not dishes)
  (/count: 60,/.test(iso) ? ok : bad)("iso.js FOOD.count = 60 (drops non-dish tail records)");
  const sp = fs.readFileSync(path.join(REPO, "Editor", "s3patch.py"), "utf8");
  (/FOOD_COUNT\s*=\s*60\b/.test(sp) ? ok : bad)("s3patch.py FOOD_COUNT = 60");
  // rune item table: the only source for the 23 passive support runes. Both editors must agree
  // on its base, or one of them silently reads a neighbouring table and shows the wrong text.
  const isoRune = /RUNE_TBL = \{ off: (0x[0-9A-Fa-f]+), stride: (0x[0-9A-Fa-f]+)/.exec(iso);
  const pyRune = /RUNE_TBL_FILE\s*=\s*(0x[0-9A-Fa-f]+)/.exec(sp);
  const pyRuneStride = /RUNE_TBL_STRIDE\s*=\s*(0x[0-9A-Fa-f]+)/.exec(sp);
  (isoRune && pyRune && pyRuneStride && +isoRune[1] === +pyRune[1] && +isoRune[2] === +pyRuneStride[1]
    ? ok : bad)("iso.js RUNE_TBL and s3patch.py RUNE_TBL_FILE agree");
  (/function runeTblDesc/.test(iso) && /nameKey\(nm\) !== nameKey/.test(iso)
    ? ok : bad)("iso.js validates each rune record's name before trusting its description");
  (/function dropDescCaches/.test(iso) && (iso.match(/dropDescCaches\(\)/g) || []).length >= 5
    ? ok : bad)("iso.js drops the name->desc caches on every staged edit / undo / revert");
  // save editor (no ISO) uses the pre-extracted rune/food descriptions + rich skill effects
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_food_desc.json"), "utf8"));
    (Object.keys(j).length > 50 ? ok : bad)(`s3_rune_food_desc.json parses (${Object.keys(j).length} entries)`); }
  catch (e) { bad("s3_rune_food_desc.json — " + e.message); }
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  (/itemdescextra\.json/.test(app) && /extra\.get\(k\) or idesc\.get/.test(app)
    ? ok : bad)("save editor merges rune/food descriptions");
  (/skillref\.json/.test(app) && /_skill_effect_text/.test(app)
    ? ok : bad)("save editor shows per-rank skill effects");
  // recruit: preview-before-apply + story/optional shading
  // recruit section is per-character only (bulk + canonical presets removed); story shading stays
  (!/data-canon/.test(app) && !/recAllShown/.test(app) ? ok : bad)("save editor recruit has no bulk/canonical buttons");
  (/s3_recruit_meta\.json/.test(app) && /isStoryAuto/.test(app) && /story-auto/.test(app)
    ? ok : bad)("save editor fades story auto-join recruits");
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_meta.json"), "utf8"));
    const story = Object.values(j).filter((v) => v.auto).length;
    (Object.keys(j).length > 90 && story > 20 ? ok : bad)(`s3_recruit_meta.json parses (${Object.keys(j).length} chars, ${story} story)`); }
  catch (e) { bad("s3_recruit_meta.json — " + e.message); }
  // manual "Force refresh" escape hatch: footer button that clears SW + caches and reloads
  (/id="forceRefreshBtn"/.test(html) && /#forceRefreshBtn/.test(app)
    ? ok : bad)("footer has an always-available Force-refresh button");
  (/async function forceUpdate/.test(app) && /caches\.keys\(\)/.test(app) && /unregister\(\)/.test(app)
    ? ok : bad)("forceUpdate clears caches + unregisters the service worker");
  // ISO editor: undo/redo engine + skill-cap presets + rune reskin presets
  (/function undo\(\)/.test(iso) && /function redo\(\)/.test(iso) && /id="isoUndoBtn"/.test(iso) && /function recByte/.test(iso)
    ? ok : bad)("iso.js has an undo/redo engine + buttons");
  (/function applyCapPreset/.test(iso) && /data-cap="max"/.test(iso) && /data-cap="guide"/.test(iso)
    ? ok : bad)("iso.js Growth view has skill-cap presets");
  (/data-rspreset=/.test(iso) ? ok : bad)("iso.js Spells tab has rune reskin presets");
  // Damage+heal slot: three instruction immediates in the boot ELF, all inside the block the
  // editor holds, and all three rewritten together (moving one without the others leaves the
  // split spell healing for its Power instead of the number the user typed).
  {
    const m = iso.match(/const SPLIT = \{([\s\S]*?)\n  \};/);
    const num = (k) => { const g = m && m[1].match(new RegExp(k + ":\\s*(0x[0-9A-Fa-f]+)")); return g ? parseInt(g[1], 16) : NaN; };
    const sites = m ? ["route", "amtSel", "amt"].map(num) : [];
    (m && sites.every((o) => o >= 0xA4800 && o < 0x465DF0) ? ok : bad)(
      `iso.js SPLIT sites sit inside the ELF block (${sites.map((o) => "0x" + (o >>> 0).toString(16)).join(" ")})`);
    (m && num("stockRoute") === 0x24020011 && num("stockAmtSel") === 0x3AC30011 && num("stockAmt") === 0x2412012C
      ? ok : bad)("iso.js SPLIT stock words = spell 17 / spell 17 / 300 HP");
    (/function applySplit/.test(iso) && /SPLIT\.route/.test(iso) && /SPLIT\.amtSel/.test(iso) && /SPLIT\.amt,/.test(iso)
      ? ok : bad)("iso.js applySplit rewrites all three damage+heal immediates");
  }
  // bestiary reference (Enemies tab)
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_bestiary.json"), "utf8"));
    (Object.keys(j).length >= 50 ? ok : bad)(`s3_bestiary.json parses (${Object.keys(j).length} enemies)`); }
  catch (e) { bad("s3_bestiary.json — " + e.message); }
  (/s3_bestiary\.json/.test(iso) && /REF\.bestiary/.test(iso) ? ok : bad)("iso.js Enemies tab renders the bestiary reference");
  // Enemy pack index: the Enemies editor's ground truth. Every offset must sit inside the
  // 4.3 GB disc and past the ELF block (in-block offsets would double-edit through BUF).
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_enemy_packs.json"), "utf8"));
    (j.format === "s3enemy" && Array.isArray(j.packs) && j.packs.length >= 30 ? ok : bad)(
      `s3_enemy_packs.json parses (${j.packs.length} packs)`);
    const ISO_MAX = 0x100008000, ELF_HI = 0x465DF0;
    let n = 0, badOff = 0, vtot = 0;
    for (const p of j.packs) for (const e of p.enemies) for (const v of e.variants) {
      vtot++;
      for (const o of [...v.rec, ...v.aux]) { n++; if (o < ELF_HI || o + 0x8C > ISO_MAX) badOff++; }
    }
    (badOff === 0 ? ok : bad)(`all ${n} enemy offsets are out-of-block and on-disc (${vtot} variants)`);
    const gh = j.packs.flatMap((p) => p.enemies).filter((e) => e.name === "GhostHolly")
      .flatMap((e) => e.variants).find((v) => v.lv === 46 && v.hp === 3800);
    (gh && gh.sp === 490 && gh.potch === 33000 ? ok : bad)(
      "index spot-check: GhostHolly Lv46 = SP 490 / potch 33,000 (Suikosource)");
    // zones: every slot/party/member offset on-disc + out-of-block; members index real slots
    let zn = 0, zbad = 0, ztot = 0, ftot = 0;
    for (const p of j.packs) for (const z of (p.zones || [])) {
      ztot++;
      for (const s of z.slots) for (const o of s.off) { zn++; if (o < ELF_HI || o + 0x14 > ISO_MAX) zbad++; }
      for (const pa of z.parties) {
        ftot++;
        if (pa.members.some((m) => m >= z.slots.length)) zbad++;
        for (const o of [...pa.off, ...pa.memOff]) { zn++; if (o < ELF_HI || o + 4 > ISO_MAX) zbad++; }
      }
    }
    (ztot >= 40 && zbad === 0 ? ok : bad)(`zones sane: ${ztot} zones, ${ftot} formations, ${zn} offsets checked`);
    // mori_101 exists as chapter variants; the HollyShrub-era one has 5 slots / 16 formations
    const moris = j.packs.flatMap((p) => p.zones || []).filter((z) => z.name === "mori_101");
    (moris.some((z) => z.slots.length === 5 && z.parties.length === 16 && z.slots[0].id === 0x1F5)
      ? ok : bad)(`zone spot-check: a mori_101 variant has 5 slots / 16 formations (${moris.length} variants)`);
    (/s3_enemy_packs\.json/.test(iso) && /S3_TEST_ENEMY_PACKS/.test(iso) ? ok : bad)(
      "iso.js loads the pack index (with the test override hook)");
    // War-unit index (War tab): same record layout, its own JSON. Offsets must be
    // on-disc, out-of-block AND disjoint from the enemy index (overlapping write
    // windows would desync), and war variants never carry aux/reward offsets.
    const w = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_war_units.json"), "utf8"));
    (w.format === "s3war" && Array.isArray(w.packs) && w.packs.length >= 6 &&
      w.packs.every((p) => p.war === true) ? ok : bad)(
      `s3_war_units.json parses (${w.packs.length} war packs, all flagged war)`);
    const eoffs = new Set();
    for (const p of j.packs) for (const e of p.enemies) for (const v of e.variants)
      for (const o of [...v.rec, ...v.aux]) eoffs.add(o);
    let wn = 0, wbad = 0, woverlap = 0, waux = 0, wvar = 0;
    for (const p of w.packs) for (const e of p.enemies) for (const v of e.variants) {
      wvar++;
      waux += v.aux.length;
      for (const o of v.rec) { wn++; if (o < ELF_HI || o + 0x8C > ISO_MAX) wbad++; if (eoffs.has(o)) woverlap++; }
    }
    (wbad === 0 && woverlap === 0 && waux === 0 ? ok : bad)(
      `all ${wn} war offsets on-disc, disjoint from enemy packs, aux-free (${wvar} variants)`);
    // spot-checks vs the Suikosource bosses guide (exact lv/hp matches)
    const zk = w.packs.flatMap((p) => p.enemies).filter((e) => e.name === "ZxnKn")
      .flatMap((e) => e.variants).filter((v) => v.lv === 20 && v.hp === 230);
    (zk.length >= 4 ? ok : bad)(`war spot-check: ZxnKn Lv20/HP230 (Thomas ch2 battle, Suikosource) in ${zk.length} packs`);
    const sarah = w.packs.find((p) => p.archive === "SOGE");
    (sarah && sarah.enemies.some((e) => e.name.startsWith("Sarah") &&
      e.variants.some((v) => v.lv === 60 && v.hp === 3200)) ? ok : bad)(
      "war spot-check: Sarah unit Lv60/HP3200 (Suikosource) in SOGE");
    const etcw = w.packs.find((p) => p.archive === "ETC");
    (etcw && etcw.enemies.some((e) => e.name === "ZxnInf" && e.variants.length === 12) ? ok : bad)(
      "war spot-check: shared ETC pack has the 12-tier ZxnInf table");
    (/s3_war_units\.json/.test(iso) && /S3_TEST_WAR_UNITS/.test(iso) && /function drawWar/.test(iso) &&
      /\["war", "War"\]/.test(iso) ? ok : bad)("iso.js loads war units and renders the War tab");
    // Room index (per-area encounter rates). Same rules as the enemy index: every offset
    // must be on-disc and OUT of the ELF block, or the editor's in-block buffer would
    // double-edit it. Offsets must also be unique — two rows writing one byte desync.
    const rm = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rooms.json"), "utf8"));
    const rooms = rm.areas.flatMap((a) => a.tables.flatMap((t) => t.rooms));
    (rm.format === "s3rooms" && rm.areas.length >= 20 && rooms.length >= 1500 ? ok : bad)(
      `s3_rooms.json parses (${rm.areas.length} areas, ${rooms.length} rooms)`);
    { const offs = rooms.flatMap((r) => [r.rateOff, r.graceOff]);
      const outOfBlock = offs.every((o) => o >= ELF_HI && o + 2 <= ISO_MAX);
      (outOfBlock && new Set(offs).size === offs.length ? ok : bad)(
        `all ${offs.length} room offsets out-of-block, on-disc and unique`);
      (/s3_rooms\.json/.test(iso) && /S3_TEST_ROOMS/.test(iso) ? ok : bad)(
      "iso.js loads the room index (with the test override hook)");
    (/function drawRoomRates/.test(iso) && /function roomRows/.test(iso) && /function scaleArea/.test(iso)
      ? ok : bad)("iso.js Encounter tab renders per-area rates");
    (/tag: "room"/.test(iso) ? ok : bad)("room windows are tagged apart from the enemy windows");
    (!/Only the <b>global<\/b> rate is editable/.test(iso) ? ok : bad)(
      "the 'global only' caveat is gone from the Encounter tab");
    // Sub-file index (Files view). Every sub-file must sit inside its own archive, and the
    // directory must tile it exactly — that tiling is what identified the archive at all.
    const sf = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_subfiles.json"), "utf8"));
    const nsub = sf.archives.reduce((a, x) => a + x.files.length, 0);
    (sf.format === "s3subfiles" && sf.archives.length >= 28 && nsub >= 4000 ? ok : bad)(
      `s3_subfiles.json parses (${sf.archives.length} archives, ${nsub} sub-files)`);
    { let bad2 = 0, tiles = 0;
      for (const a of sf.archives) {
        let next = 0;
        for (const [sect, size] of a.files) { if (sect !== next) bad2++; next = sect + size; }
        if (next * 2048 === a.size) tiles++;
      }
      (bad2 === 0 && tiles === sf.archives.length ? ok : bad)(
        `every archive's sub-files tile it exactly (${tiles}/${sf.archives.length})`);
      const towns = sf.archives.reduce((a, x) => a + x.files.filter((f2) => sf.kinds[f2[2]] === "town").length, 0);
      const tables = rm.areas.reduce((a, x) => a + x.tables.length, 0);
      (towns === tables ? ok : bad)(`town sub-files match the room index's tables (${towns} vs ${tables})`); }
    // the Reference tab strip is data-driven (REF_MODES), so "registered" means an entry there
    const refMode = (k) => new RegExp(`\\["${k}", "[^"]+", \\(\\) =>`).test(iso);
    (/s3_subfiles\.json/.test(iso) && /function drawFiles/.test(iso) && refMode("files")
      ? ok : bad)("iso.js registers the read-only Files browser under Reference");
    // Item sources (Reference view). Provenance must stay split: `drops` are decoded from
    // the disc, `guide` rows are somebody's notes. A row that can't say which is worthless.
    const isrc = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_item_sources.json"), "utf8"));
    { const its = Object.values(isrc.items);
      (isrc.format === "s3itemsources" && its.length >= 100 ? ok : bad)(
        `s3_item_sources.json parses (${its.length} items)`);
      const nd = its.filter((x) => x.drops).length, ng = its.filter((x) => x.guide).length;
      (nd >= 90 && ng >= 50 ? ok : bad)(`${nd} items with decoded drops, ${ng} with guide notes`);
      // every drop row must name a real enemy/archive and a weight in the engine's 0..1000
      const ep2 = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_enemy_packs.json"), "utf8"));
      const known = new Set(ep2.packs.flatMap((p2) => p2.enemies.map((e) => e.name)));
      const rows = its.flatMap((x) => x.drops || []);
      (rows.every((r) => known.has(r.enemy) && r.weight > 0 && r.weight <= 1000 && r.lv >= 1 && r.lv <= 99)
        ? ok : bad)(`all ${rows.length} drop rows name a real enemy with a sane weight`);
      // Rows are grouped by (enemy, level, weight) with the hosting archives listed, so the
      // same fact can't appear once per archive. Ungrouped this was 625 rows for 188 facts.
      (rows.every((r) => Array.isArray(r.archives) && r.archives.length >= 1) ? ok : bad)(
        "every drop row carries its archive list");
      { const key = (r) => `${r.enemy}|${r.lv}|${r.weight}`;
        const dupes = its.filter((x) => x.drops &&
          new Set(x.drops.map(key)).size !== x.drops.length).length;
        (dupes === 0 ? ok : bad)(`no item repeats an (enemy, level, weight) fact (${dupes} do)`);
        const spread = rows.reduce((a, r) => a + r.archives.length, 0);
        (spread > rows.length ? ok : bad)(
          `${rows.length} facts span ${spread} archive placements (grouping is doing work)`); }
      const kinds = new Set(its.flatMap((x) => (x.guide || []).map((g) => g.kind)));
      (kinds.has("chest") && kinds.has("drop") ? ok : bad)(`guide kinds present (${[...kinds].sort().join(", ")})`);
      // the cross-check that makes both halves credible: Troll Dragon -> Pale Moon Casque
      const pmc = Object.entries(isrc.items).find(([, v]) =>
        (v.guide || []).some((g) => /Troll Dragon/.test(g.text)));
      (pmc && (pmc[1].drops || []).some((d) => /TrollDragn/.test(d.enemy)) ? ok : bad)(
        "spot-check: the guide's Troll Dragon drop is also in the decoded tables"); }
    (/s3_item_sources\.json/.test(iso) && /function drawSources/.test(iso) && refMode("sources")
      ? ok : bad)("iso.js registers the Item-sources reference browser");
    // Pickup locations. The per-archive counts are the MAX over chapter variants, never the
    // sum — summing would report one chest per chapter as several chests.
    { const pl = isrc.places || [], ch = isrc.chests || [];
      (pl.length >= 8 && ch.length === 6 ? ok : bad)(
        `pickup places (${pl.length} archives) + guide chests (${ch.length})`);
      (pl.every((p) => p.chest + p.corpse + p.herbs > 0 && p.variants >= 1) ? ok : bad)(
        "every listed archive actually has a pickup");
      const mori = pl.find((p) => p.archive === "MORI");
      (mori && mori.corpse === 1 && mori.herbs === 3 && mori.area === 0x0d ? ok : bad)(
        "pickup spot-check: MORI = area 0x0D, 1 corpse, 3 herbs (matches the walkthrough)");
      (ch.every((c) => c.items.length >= 4 && c.items.every((i) => +i.item >= 1)) ? ok : bad)(
        "every guide chest names at least 4 real items");
      (/function drawPickups/.test(iso) && refMode("places") ? ok : bad)(
        "iso.js registers the Pickups reference browser");
      (/aren't linked/.test(iso) ? ok : bad)(
        "the Pickups view states the disc and guide tables aren't joined"); }
    (/srctag \$\{r\.disc \? "disc" : "guide"\}/.test(iso) ? ok : bad)(
      "every source row is tagged disc vs guide");
    // Rune + skill lookups (Reference view). Both are pure joins over committed guide data, so
    // what can break is the join, not the rendering: a rune family range that stops covering the
    // item list, or a guide name that stops matching the disc's spelling of the same rune.
    { const rf = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_food_desc.json"), "utf8"));
      const ro = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_owner.json"), "utf8"));
      const rs2 = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_slots.json"), "utf8"));
      const sr = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_skill_ref.json"), "utf8"));
      // same id/category parse iso.js does, so a category rename in the id list shows up here
      const items = {}, itemCats = {};
      { let cur = "";
        for (const line of itemsTxt.split(/\r?\n/)) {
          const h = /\*\s*(.+?)\s*\*/.exec(line);
          if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
          const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
          while ((m = re.exec(line))) { const id = parseInt(m[1], 16); items[id] = m[2].trim(); itemCats[id] = cur; } } }
      // the rune families are ID RANGES in iso.js, so they have to keep partitioning the
      // "Runes" category exactly — no rune outside a family, no non-rune inside one
      const groups = [...iso.matchAll(/\["(magic|attack|support)", "[^"]+", (0x[0-9A-Fa-f]+), (0x[0-9A-Fa-f]+),/g)]
        .map((m) => [m[1], parseInt(m[2], 16), parseInt(m[3], 16)]);
      const inGroup = (id) => groups.filter(([, lo, hi]) => id >= lo && id <= hi);
      const runeIds = Object.keys(itemCats).map(Number).filter((id) => itemCats[id] === "Runes");
      (groups.length === 3 && runeIds.every((id) => inGroup(id).length === 1) ? ok : bad)(
        `all ${runeIds.length} runes land in exactly one family (${groups.map(([g, lo, hi]) => `${g} ${lo.toString(16)}..${hi.toString(16)}`).join(", ")})`);
      const strays = groups.flatMap(([, lo, hi]) => {
        const out = []; for (let id = lo; id <= hi; id++) if (itemCats[id] !== "Runes") out.push(id); return out; });
      (strays.length === 0 ? ok : bad)(`no non-rune item falls inside a rune family (${strays.map((x) => x.toString(16)).join(",")})`);
      // every rune has menu text to show, whether or not a disc is open
      const noText = runeIds.filter((id) => !rf[String(id)]);
      (noText.length === 0 ? ok : bad)(`every rune has bundled description text (${runeIds.length} runes)`);
      // "— Grants a, b, c" is how the magic runes name their spells; the browser splits on it
      const grants = runeIds.filter((id) => /—\s*Grants\s+/.test(rf[String(id)] || ""));
      (grants.length >= 20 ? ok : bad)(`${grants.length} runes list the spells they grant`);
      // the join that would silently empty the "who has it" column: the guides spell rune names
      // their own way ("Eight Devil", "Shining wing"), so both files must still match by nameKey
      const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
      const runeKeys = new Set(runeIds.map((id) => key(items[id])));
      const ownMiss = Object.keys(ro).filter((n) => !runeKeys.has(key(n)));
      (ownMiss.length === 0 ? ok : bad)(`all ${Object.keys(ro).length} s3_rune_owner names match a rune item (${ownMiss})`);
      const slotRunes = [...new Set(Object.values(rs2).flatMap((v) =>
        ["head", "right", "left"].map((k) => (v[k] || {}).state === "rune" ? v[k].rune : null).filter(Boolean)))];
      const slotMiss = slotRunes.filter((n) => !runeKeys.has(key(n)));
      (slotMiss.length === 0 ? ok : bad)(`all ${slotRunes.length} runes in s3_rune_slots match a rune item (${slotMiss})`);
      // Skills: the browser's Utility chip and the Support view's fade must name the same set
      const utility = Object.keys(sr).filter((k) => sr[k].type === "Utility").map(Number).sort((a, b) => a - b);
      const gate = /const supportActive = \(id\) => id >= (0x[0-9A-Fa-f]+) && id <= (0x[0-9A-Fa-f]+)/.exec(iso);
      (gate && utility[0] === parseInt(gate[1], 16) && utility[utility.length - 1] === parseInt(gate[2], 16) &&
        utility.length === parseInt(gate[2], 16) - parseInt(gate[1], 16) + 1 ? ok : bad)(
        `"Utility" skills == supportActive()'s range (${utility.length} skills, ${utility[0]}..${utility[utility.length - 1]})`);
      const types = new Set(Object.values(sr).map((s) => s.type));
      ([...types].every((t) => new RegExp(`\\["${t}", "`).test(iso)) ? ok : bad)(
        `every skill type has a filter chip (${[...types].sort().join(", ")})`);
      // every rank shown in the effect table must be a rank the editor can actually set
      const ranks = new Set(Object.values(sr).flatMap((s) => (s.effects || []).flatMap((e) => Object.keys(e.ranks || {}))));
      const rankOpts = new Set([...iso.matchAll(/\[\d, "(E|D|C|B\+?|A\+?|S)"\]/g)].map((m) => m[1]));
      ([...ranks].every((g) => rankOpts.has(g)) ? ok : bad)(`guide ranks are all in RANK_OPTS (${[...ranks].join(" ")})`); }
    (/function drawRunes/.test(iso) && refMode("runes") &&
      /function drawSkillsRef/.test(iso) && refMode("skills") &&
      refMode("items") && /function drawItemsRef/.test(iso) ? ok : bad)(
      "iso.js registers the Items, Rune and Skill reference browsers");
    (/s3_rune_food_desc\.json/.test(iso) && /s3_rune_owner\.json/.test(iso) ? ok : bad)(
      "iso.js loadRef fetches the rune description + owner tables");
    const areas = rm.areas.map((a) => a.area);
      (new Set(areas).size === areas.length ? ok : bad)("every archive has a distinct area id");
      const mori = rm.areas.find((a) => a.archive === "MORI");
      (mori && mori.area === 0x0d && mori.tables[0].rooms.length === 6 &&
        mori.tables[0].rooms.every((r) => r.rate === 4) ? ok : bad)(
        "room spot-check: MORI = area 0x0D, 6 rooms, all rate 4");
      const rates = [...new Set(rooms.map((r) => r.rate))].sort((a, b) => a - b);
      (rates.every((r) => r >= 0 && r <= 9) ? ok : bad)(`room rates stay in 0..9 (${rates})`); }
    const wr = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_war_ref.json"), "utf8"));
    (wr.army && wr.support && wr.skills && Object.keys(wr.army).length >= 40 ? ok : bad)(
      `s3_war_ref.json parses (${Object.keys(wr.army).length} army units, ${Object.keys(wr.support).length} support)`);
    (/REF\.warRef/.test(iso) ? ok : bad)("iso.js War tab renders the army-skill reference");
  } catch (e) { bad("s3_enemy_packs.json / s3_war_units.json — " + e.message); }
}

// 8) In-ELF text heuristic must stay in lockstep with the desktop editor.
// There's no index of strings in the ELF — both editors FIND them with the same filter, so if
// the rules drift the two tools offer different strings on the same disc (and one of them may
// offer a format string the user can corrupt). Assert the literals agree, rule by rule.
console.log("In-ELF text heuristic (web ⇄ desktop):");
{
  const T = (await import("../text-core.js")).default ||
    (await import("module")).createRequire(import.meta.url)(path.join(WEB, "text-core.js"));
  const py = fs.readFileSync(path.join(REPO, "Editor", "s3editor.py"), "utf8");
  const pick = (re, what) => { const m = re.exec(py); if (!m) bad(`could not find ${what} in s3editor.py`); return m && m[1]; };

  const minLen = pick(/if len\(s\) < (\d+) or " " not in s:/, "min length");
  (Number(minLen) === T.MIN_LEN ? ok : bad)(`min run length ${T.MIN_LEN} (py ${minLen})`);

  const rej = pick(/_re\.search\(r"([^"]+)"/, "reject regex");
  (rej === T.REJECT.source ? ok : bad)(`reject pattern matches` + (rej === T.REJECT.source ? "" : ` — js ${T.REJECT.source} vs py ${rej}`));

  const punct = pick(/c\.isalpha\(\) or c in "([^"]+)"/, "prose punctuation");
  (punct === T.PROSE_PUNCT ? ok : bad)(`prose punctuation matches` + (punct === T.PROSE_PUNCT ? "" : ` — js ${JSON.stringify(T.PROSE_PUNCT)} vs py ${JSON.stringify(punct)}`));

  const ratio = pick(/return ok \/ len\(s\) > (0\.\d+)/, "prose ratio");
  (Number(ratio) === T.PROSE_RATIO ? ok : bad)(`prose ratio ${T.PROSE_RATIO} (py ${ratio})`);

  // Scan range. The desktop starts 0x1000 earlier, at the ELF *header* rather than PT_LOAD;
  // those bytes are headers and program-header tables, which cannot pass the prose filter, so
  // the two produce the same string set. The END must match exactly — that one is real data.
  const pyHi = pick(/_TEXT_ELF_HI = (0x[0-9A-Fa-f]+)/, "_TEXT_ELF_HI");
  const pyLo = pick(/_TEXT_ELF_LO = (0x[0-9A-Fa-f]+)/, "_TEXT_ELF_LO");
  (Number(pyHi) === ELF_END ? ok : bad)(`scan end 0x${ELF_END.toString(16)} matches desktop (${pyHi})`);
  (Number(pyLo) <= ELF_BASE ? ok : bad)(`desktop scan start ${pyLo} is at or before the web block (0x${ELF_BASE.toString(16)})`);

  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/TextCore\.scanStrings\(ORIG, ELF_BASE\)/.test(iso) ? ok : bad)("iso.js scans ORIG (stable slot lengths), not BUF");
  (/\["text", "Text"\]/.test(iso) ? ok : bad)("iso.js registers the Text view");
}

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
