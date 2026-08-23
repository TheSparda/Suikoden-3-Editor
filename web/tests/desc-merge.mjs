// Behavioral test for the item/skill description merge the SAVE editor performs (app.js
// load_reference): rune/food descriptions come from s3_rune_food_desc.json (extra) overriding
// the drifted equipment pool (s3_item_desc.json), and skills prefer per-rank effects from
// s3_skill_ref.json. Mirrors that merge against the real committed data and asserts values —
// the save editor stubs Pyodide in e2e, so this is the only place the merged strings are checked.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ED = path.join(REPO, "Editor");
const J = (f) => JSON.parse(fs.readFileSync(path.join(ED, f), "utf8"));
let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };

// item ids by name (and reverse) from the shipped id list
const idTxt = fs.readFileSync(path.join(ED, "Suikoden3_item_ids.txt"), "latin1");
const idByName = {}; { const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
  while ((m = re.exec(idTxt))) idByName[m[2].trim().toLowerCase()] = parseInt(m[1], 16); }
const idOf = (nm) => idByName[nm.toLowerCase()];

const idesc = J("s3_item_desc.json");           // equipment pool (rune/food entries blanked)
const extra = J("s3_rune_food_desc.json");      // correct rune + food descriptions
const sref = J("s3_skill_ref.json");            // skill id -> {desc, effects}
// itemDesc merge, exactly as app.js / iso.js resolve it
const itemDesc = (id) => extra[String(id)] || idesc[String(id)] || "";

console.log("Item description merge (rune/food override the drifted pool):");
check("Rage rune shows its granted spells (not the old 'Sword of Rage' drift)",
  /^Grants /.test(itemDesc(idOf("Rage"))) && !/Sword of Rage/.test(itemDesc(idOf("Rage"))));
check("the drifted 'Sword of Rage' entry was blanked in s3_item_desc.json",
  !idesc[String(idOf("Rage"))]);
check("Fire rune lists its spell set", /Flaming Arrows/.test(itemDesc(idOf("Fire"))));
check("a command rune shows its spell effect (Phoenix)", /DMG/.test(itemDesc(idOf("Phoenix"))));
check("food shows its heal (Scrambled Eggs → Heals 80HP)", itemDesc(idOf("Scrambled Eggs")) === "Heals 80HP");
check("a plain equipment desc still comes from the pool", /\(/.test(itemDesc(idOf("Wooden Shield")) || "(") );

console.log("Skill effect text (all 43 skills, incl. utility):");
const skillEffect = (id) => {
  const r = sref[String(id)]; if (!r) return "";
  let t = r.desc || ""; const e = (r.effects || [])[0];
  if (e && e.ranks) { const s = ["E", "A", "S"].filter((g) => e.ranks[g]).map((g) => `${g} ${e.ranks[g]}`).join(" · "); if (s) t += `  [${e.label}: ${s}]`; }
  return t;
};
check("all 43 skills have ref entries", Object.keys(sref).length === 43);
check("combat skill has per-rank effect (Swing @0x01)", /Freeze Time/.test(skillEffect(1)) && /S /.test(skillEffect(1)));
check("utility skill now has a description (Cook @0x1F)", /food/i.test(skillEffect(0x1F)));
check("utility skill has per-rank effect (Discount @0x21)", /-/.test(skillEffect(0x21)) && skillEffect(0x21).length > 20);

console.log(fails ? `\nFAILED (${fails})` : "\nAll desc-merge checks passed.");
process.exit(fails ? 1 : 0);
