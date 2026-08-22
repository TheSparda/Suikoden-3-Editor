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
for (const f of ["app.js", "iso.js", "sw.js"]) {
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
(/data-mode="iso"/.test(html) && /data-mode="save"/.test(html) ? ok : bad)("both mode tabs present");
(/iso\.js/.test(fs.readFileSync(path.join(WEB, "sw.js"), "utf8")) ? ok : bad)("service worker precaches iso.js");

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
