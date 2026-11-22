// Does the boot self-check catch a file the boot manifest promises but the page never
// really gets?
//
// Suikoden V's web editor was dead for a day because one Python module was missing from
// its Pyodide module manifest, and nothing said so: the page just never came up. S3's
// save editor now loads through a single BOOT_MANIFEST in app.js and verifies it after
// loading (verifyBootManifest): every required file fetched non-empty, present in the
// Pyodide FS afterwards, and the save module still carrying the functions app.js calls.
// A failure names the file(s) in the boot gate instead of leaving a blank page.
//
// Two layers, because each catches what the other cannot:
//   1. Static: the manifest in app.js still promises the known required set, each source
//      file exists on disk and is non-empty, and s3save.py really defines the symbols
//      the manifest claims. Removing a manifest entry fails HERE (the runtime check
//      iterates the manifest itself, so a removed entry is invisible to it by design).
//   2. Dynamic (playwright, self-skips without Chromium): the intact page boots clean
//      and records window.S3_BOOT_CHECK; a required file served 404 produces the named
//      error panel with the hard-refresh guidance; an OPTIONAL file served 404 does
//      not fail the boot (optional files fall back to "{}" and must not false-positive).
//
//   node web/tests/boot-manifest.mjs
//   PW_CHROMIUM=/path/to/chrome node web/tests/boot-manifest.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromiumPath, chromiumNote } from "./chromium-path.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

// ---- 1. static: the manifest promises what the editor needs -----------------
console.log("boot manifest (static):");
const EXPECTED = {
  "s3save.py":         { url: "../Editor/s3save.py", required: true },
  "items.txt":         { url: "../Editor/Suikoden3_item_ids.txt", required: true },
  "skills.txt":        { url: "../Editor/Suikoden3_skill_ids.txt", required: true },
  "names.json":        { url: "../Editor/s3_names.json", required: true },
  "itemdesc.json":     { url: "../Editor/s3_item_desc.json", required: true },
  "skilldesc.json":    { url: "../Editor/s3_skill_desc.json", required: true },
  "itemdescextra.json":{ url: "../Editor/s3_rune_food_desc.json", required: false },
  "skillref.json":     { url: "../Editor/s3_skill_ref.json", required: false },
};
const S3SAVE_SYMBOLS = ["read_all_s3_saves", "write_save_edits", "party_reference",
                        "carryover_reference", "trinity_reference"];

const appJs = fs.readFileSync(path.join(REPO, "web", "app.js"), "utf8");
const block = (appJs.match(/const BOOT_MANIFEST = \[([\s\S]*?)\];/) || [])[1] || "";
check("app.js declares a BOOT_MANIFEST", !!block);
const entries = [...block.matchAll(/url:\s*"([^"]+)",\s*dest:\s*"([^"]+)",\s*required:\s*(true|false)/g)]
  .map((m) => ({ url: m[1], dest: m[2], required: m[3] === "true" }));
check("the manifest parses into entries", entries.length >= Object.keys(EXPECTED).length,
  `${entries.length} entries`);
for (const [dest, want] of Object.entries(EXPECTED)) {
  const got = entries.find((e) => e.dest === dest);
  check(`manifest promises ${dest}`, !!got);
  if (!got) continue;
  check(`${dest} is loaded from ${want.url}`, got.url === want.url, got.url);
  check(`${dest} required flag is ${want.required}`, got.required === want.required);
  const disk = path.join(REPO, want.url.replace(/^\.\.\//, ""));
  check(`${dest} source exists on disk and is non-empty`,
    fs.existsSync(disk) && fs.statSync(disk).size > 0, disk);
}
{
  const saveEntry = block.match(/dest:\s*"s3save\.py"[\s\S]*?symbols:\s*\[([^\]]*)\]/);
  const claimed = saveEntry ? [...saveEntry[1].matchAll(/"(\w+)"/g)].map((m) => m[1]) : [];
  const src = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
  for (const sym of S3SAVE_SYMBOLS) {
    check(`manifest claims s3save.${sym}`, claimed.includes(sym), claimed.join(","));
    check(`s3save.py really defines ${sym}`, new RegExp("def " + sym + "\\b").test(src));
  }
}
check("the loader verifies against the manifest (verifyBootManifest is called)",
  /verifyBootManifest\(py, loaded\)/.test(appJs));

// ---- 2. dynamic: boot it, then break it -------------------------------------
let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP boot-manifest (dynamic): playwright-core not installed."); finish(); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); rs.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}/web/index.html`;

let browser;
console.log(chromiumNote());
try { browser = await chromium.launch({ executablePath: chromiumPath() }); }
catch (e) { console.log("SKIP boot-manifest (dynamic): no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); finish(); }

// A Pyodide stub with a REAL in-memory FS, so the check's read-back sees what was
// actually written. The boot-check snippet gets a real answer ("[]" = nothing missing);
// load_reference() gets the empty reference the other suites use.
const STUB_ENGINE = `
  window.loadPyodide = async () => {
    const files = new Map();
    return { FS: { writeFile(name, data) { files.set(name, data); },
                   readFile(name) { const d = files.get(name);
                     return typeof d === "string" ? new TextEncoder().encode(d) : (d || new Uint8Array(0)); } },
             runPython(code) {
               if (code.includes('S3_BOOT_CHECK')) return "[]";
               if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [],
                 charById: {}, charRoster: {}, charChoices: [] });
               return undefined;
             } };
  };`;

async function open(breakPattern) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("  ! pageerror: " + e.message); fails++; });
  await page.route(/jsdelivr\.net/, (r) => r.abort());
  if (breakPattern) await page.route(breakPattern, (r) => r.fulfill({ status: 404, body: "gone" }));
  await page.addInitScript(STUB_ENGINE);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  return page;
}
const gone = (page) => page.waitForSelector("#bootOv", { state: "detached", timeout: 5000 })
  .then(() => true).catch(() => false);

console.log("boot manifest (dynamic, intact tree):");
{
  const page = await open(null);
  check("the gate comes down on a clean boot", await gone(page));
  const bc = await page.evaluate(() => window.S3_BOOT_CHECK);
  check("the boot check ran and passed", !!bc && bc.ok === true, JSON.stringify(bc));
  check("it checked every required file",
    !!bc && Object.keys(EXPECTED).filter((d) => EXPECTED[d].required)
      .every((d) => bc.checked.includes(d)), bc && bc.checked.join(","));
  check("no optional file is missing on the intact tree",
    !!bc && bc.optionalMissing.length === 0, bc && bc.optionalMissing.join(","));
  check("the picker is enabled", !(await page.isDisabled("#pickBtn")));
  await page.context().close();
}

console.log("boot manifest (dynamic, required file broken):");
{
  const page = await open(/\/Editor\/s3save\.py$/);
  await page.waitForSelector("#bootRetry", { timeout: 5000 }).catch(() => {});
  check("the gate stays up with the error panel", !!(await page.$("#bootOv")));
  const msg = await page.textContent("#bootMsg");
  check("the panel names the broken file", /s3save\.py/.test(msg || ""), (msg || "").slice(0, 160));
  check("the panel tells the user to hard refresh", /hard refresh/i.test(msg || ""));
  check("the panel says to report it if it persists", /report it/i.test(msg || ""));
  check("Retry is offered", !!(await page.$("#bootRetry")));
  check("the picker stays disabled", await page.isDisabled("#pickBtn"));
  await page.context().close();
}

console.log("boot manifest (dynamic, optional file broken):");
{
  const page = await open(/\/Editor\/s3_skill_ref\.json$/);
  check("the boot still succeeds (no false positive on optional files)", await gone(page));
  const bc = await page.evaluate(() => window.S3_BOOT_CHECK);
  check("the check passed", !!bc && bc.ok === true, JSON.stringify(bc));
  check("the missing optional file is recorded, not failed",
    !!bc && bc.optionalMissing.includes("skillref.json"), bc && bc.optionalMissing.join(","));
  await page.context().close();
}

await browser.close();
srv.close();
finish();

function finish() {
  console.log(fails ? `\n${fails} boot-manifest problem(s).` : "\nBoot manifest OK.");
  process.exit(fails ? 1 : 0);
}
