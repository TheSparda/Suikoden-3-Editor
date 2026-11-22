// Loadout CSV export / import (loadout-core.js), no browser.
//
// Two halves:
//   1. Pure format checks on synthetic characters: the header, quoting, and every
//      strict-validation rejection (unknown character, unknown item, malformed rows,
//      wrong slot, name / id mismatches, duplicates), each proving that a rejected
//      file stages zero changes.
//   2. The real-fixture round trip: a COPY of a real gamedata fixture is decoded by
//      the real s3save engine (loadout_roundtrip.py), exported to CSV, imported
//      unchanged, and the resulting edits are applied by the engine to the copy.
//      The character records (and the whole payload) must come back byte-identical,
//      and the original fixture must be untouched. Skips cleanly when python3 or
//      the fixture is unavailable, mirroring save-roundtrip.mjs.
import { createRequire } from "module";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const L = require("../loadout-core.js");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let fails = 0;
const check = (n, c, extra = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`); if (!c) fails++; };

// ---- synthetic context ---------------------------------------------------------
const ctx = {
  itemById: { 317: { name: "Fire Rune" }, 280: { name: "Chain Mail" }, 290: { name: "Iron Helm" } },
  characters: [
    { rosterIndex: 0, name: "Hugo", id: 1, idExpected: 1, hasData: true, recruited: true,
      equip: { headRune: 317, armor: 280 } },
    { rosterIndex: 1, name: "Chris", id: 2, idExpected: 2, hasData: true, recruited: true,
      equip: { helm: 290 } },
    { rosterIndex: 2, name: "Geddoe", id: 3, idExpected: 3, hasData: false, recruited: false,
      equip: {} },
  ],
};

console.log("Export:");
const csv = L.toCsv(ctx.characters, ctx);
const lines = csv.trimEnd().split("\r\n");
check("header is the documented format", lines[0] === L.HEADER.join(","), lines[0]);
check("one row per slot per exported character (2 characters x 9 slots)",
      lines.length - 1 === 18, String(lines.length - 1));
check("characters with no data and no recruit flag are not exported",
      !csv.includes("Geddoe"));
check("an equipped item row carries name, decimal id and hex id",
      lines.includes("Hugo,0,1,headRune,Head Rune,317,13D,Fire Rune"));
check("an empty slot exports as id 0 with a blank name",
      lines.includes("Hugo,0,1,shield,Shield,0,000,"));

console.log("Import of an unchanged export:");
{
  const r = L.parseLoadout(csv, ctx);
  check("unchanged export parses clean", r.ok, JSON.stringify(r.errors));
  check("row count matches the export", r.rows === 18);
  check("no row differs from the save", r.changed === 0);
  check("edits cover every exported slot",
        Object.keys(r.edits).length === 2 &&
        Object.keys(r.edits[0].equip).length === 9 && r.edits[0].equip.headRune === 317);
  const EDITS = {}; const n = L.stageInto(r, EDITS);
  check("stageInto stages through the pending EDITS shape",
        n === 18 && EDITS[0].equip.armor === 280 && EDITS[1].equip.helm === 290);
}
{
  // A real change in the spreadsheet stages exactly that change.
  const edited = csv.replace("Hugo,0,1,armor,Armor,280,118,Chain Mail",
                             "Hugo,0,1,armor,Armor,0,000,");
  const r = L.parseLoadout(edited, ctx);
  check("clearing a slot in the CSV parses and counts as one change", r.ok && r.changed === 1);
  check("the cleared slot stages item 0", r.ok && r.edits[0].equip.armor === 0);
}
{
  // CSV quoting: a name containing a comma and a quote round-trips.
  const qctx = { characters: [{ rosterIndex: 0, name: 'A, "B"', id: 1, idExpected: 1,
                                 hasData: true, recruited: true, equip: {} }],
                 itemById: {} };
  const r = L.parseLoadout(L.toCsv(qctx.characters, qctx), qctx);
  check("quoted names with commas and quotes round-trip", r.ok, JSON.stringify(r.errors));
}

console.log("Strict rejection (each must fail with per-row errors and stage nothing):");
const expectReject = (name, text, needle) => {
  const r = L.parseLoadout(text, ctx);
  const EDITS = {}; const staged = L.stageInto(r, EDITS);
  check(name, !r.ok && r.errors.length > 0 && Object.keys(r.edits).length === 0 &&
        staged === 0 && Object.keys(EDITS).length === 0 &&
        r.errors.some((e) => e.message.includes(needle)),
        JSON.stringify(r.errors));
};
const swap = (from, to) => csv.replace(from, to);
expectReject("unknown item id is rejected",
  swap("317,13D,Fire Rune", "700,2BC,Fire Rune"), "unknown item id");
expectReject("an item id with no table entry is rejected",
  swap("317,13D,Fire Rune", "100,064,Fire Rune"), "unknown item id");
expectReject("unknown character (roster_index) is rejected",
  swap("Chris,1,2,", "Chris,77,2,"), "unknown character");
expectReject("character name that does not match its roster_index is rejected",
  swap("Chris,1,2,", "Hugo,1,2,"), "does not match roster_index");
expectReject("character id that does not match the character is rejected",
  swap("Hugo,0,1,", "Hugo,0,9,"), "character_id");
expectReject("malformed row (missing fields) is rejected",
  swap("Hugo,0,1,headRune,Head Rune,317,13D,Fire Rune", "Hugo,0,1,headRune"), "expected 8 fields");
expectReject("malformed CSV (unterminated quote) is rejected",
  csv.replace("Fire Rune", '"Fire Rune'), "unterminated quoted field");
expectReject("wrong slot (unknown slot key) is rejected",
  swap(",headRune,Head Rune,", ",weapon,Weapon,"), "unknown slot");
expectReject("wrong slot label for a real slot is rejected",
  swap(",armor,Armor,", ",armor,Head Rune,"), "slot_label");
expectReject("item name that does not match its id is rejected",
  swap("317,13D,Fire Rune", "317,13D,Water Rune"), "item_name");
expectReject("decimal and hex item ids that disagree are rejected",
  swap("317,13D,Fire Rune", "317,13E,Fire Rune"), "disagree");
expectReject("a duplicate character and slot row is rejected",
  csv + "Hugo,0,1,armor,Armor,280,118,Chain Mail\r\n", "duplicate");
expectReject("a bad header is rejected",
  csv.replace("character_name", "char_name"), "bad header");
expectReject("an empty file is rejected", "", "empty");
expectReject("a non-integer item id is rejected",
  swap("317,13D,Fire Rune", "abc,13D,Fire Rune"), "not an integer");

// ---- real-fixture round trip -----------------------------------------------------
console.log("Real fixture round trip (copy only, via s3save):");
const fixture = path.join(REPO, "Saves", "_extracted_s3", "gamedata");
const helper = path.join(HERE, "loadout_roundtrip.py");
let py = null;
for (const cand of ["python3", "python"]) {
  const probe = spawnSync(cand, ["--version"], { encoding: "utf8" });
  if (!probe.error) { py = cand; break; }
}
if (!py || !fs.existsSync(fixture)) {
  console.log("  - SKIP: python3 or the gamedata fixture is unavailable.");
} else {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "s3-loadout-"));
  const dump = spawnSync(py, [helper, "dump", fixture, work], { encoding: "utf8" });
  check("fixture copy decodes with the real engine", dump.status === 0, (dump.stderr || "").trim());
  if (dump.status === 0) {
    const fctx = JSON.parse(fs.readFileSync(path.join(work, "context.json"), "utf8"));
    const rcsv = L.toCsv(fctx.characters, fctx);
    const r = L.parseLoadout(rcsv, fctx);
    check("real save exports and re-imports clean", r.ok, JSON.stringify(r.errors.slice(0, 3)));
    check("real round trip reports zero changes", r.ok && r.changed === 0, `changed=${r.changed}`);
    check("real export has one row per slot per exported character",
          r.ok && r.rows === fctx.characters.filter((c) => c.hasData || c.recruited).length * 9,
          `rows=${r.rows}`);
    // Negative on the real context too: one corrupted row rejects the whole file.
    const badLines = rcsv.split("\r\n");
    badLines[1] = badLines[1].replace(/,[^,]*$/, ",No Such Item");
    const bad = L.parseLoadout(badLines.join("\r\n"), fctx);
    check("one bad row in a real export rejects everything and stages nothing",
          !bad.ok && Object.keys(bad.edits).length === 0 && bad.errors.length > 0);
    if (r.ok) {
      const editsPath = path.join(work, "edits.json");
      fs.writeFileSync(editsPath, JSON.stringify(r.edits));
      const ap = spawnSync(py, [helper, "apply", work, editsPath], { encoding: "utf8" });
      check("engine applies the round-tripped edits", ap.status === 0, (ap.stderr || "").trim());
      if (ap.status === 0) {
        const v = JSON.parse(ap.stdout.trim().split("\n").pop());
        check("character records are byte-identical after export, import, apply",
              v.charRecordsIdentical === true, JSON.stringify(v));
        check("whole gamedata payload is byte-identical after the round trip",
              v.wholeIdentical === true, JSON.stringify(v));
        check("the original fixture was never modified", v.fixtureUntouched === true);
        check("the working copy was only read by the apply step", v.copyUntouched === true);
      }
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} check(s) failed.` : "\nAll loadout CSV checks passed.");
process.exit(fails ? 1 : 0);
