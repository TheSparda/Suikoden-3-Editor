// End-to-end tests for the web ISO editor, driven through the real code in a headless
// browser against a synthetic in-bounds ISO (see synth-iso.mjs). Self-skips (exit 0) when
// playwright-core or a Chromium binary isn't available, so it never breaks a minimal CI.
//
//   node web/tests/e2e.mjs            # uses playwright's own chromium
//   PW_CHROMIUM=/path/to/chrome node web/tests/e2e.mjs
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { buildSynthIso, ELF_BASE, ELF_END, SPELL, UNITE, FOOD, ENEMY, GEAR, TABLES, SHOP, VERSION_OFF, VERSION_VAL, SETS, ENC_SITES, ENC_STOCK,
  ENEMY_TEST_PACKS, ENEMY_REC_A, ENEMY_AUX_A, ENEMY_REC_B, ENEMY_AUX_B,
  ZONE_SLOTS_A, ZONE_PARTY_A, ZONE_MEM_A, ZONE_SLOTS_B, ZONE_PARTY_B, ZONE_MEM_B,
  WAR_TEST_UNITS, WAR_REC_A, WAR_REC_B } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Scratch dir for downloads/recipes. Per-process: a shared name in os.tmpdir() lets two
// concurrent runs of this suite half-overwrite each other's recipe files.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "s3e2e-run-"));
const REPO = path.resolve(HERE, "..", "..");

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP e2e: playwright-core not installed."); process.exit(0); }

let fails = 0, section = "";
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };
const head = (s) => { section = s; console.log(s + ":"); };

const { bytes, armor, mapping } = buildSynthIso();
let served = bytes;                       // tests can swap this before loading (bad/short ISOs)
const setServed = (b) => { served = b; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/synth.bin") { rs.writeHead(200); rs.end(Buffer.from(served)); return; }
  if (p === "/") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => { if (e) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); rs.end(d); });
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const base = `http://localhost:${port}/web/index.html`;

let browser;
try { browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined }); }
catch (e) { console.log("SKIP e2e: no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); process.exit(0); }

const fakeHandle = () => `(() => { window.__writes = [];
  const h = { name: 's.iso', kind: 'file',
    getFile: async () => new File([await (await fetch('/synth.bin')).arrayBuffer()], 's.iso'),
    createWritable: async () => ({ write: async (p) => window.__writes.push({ pos: p.position, data: [...new Uint8Array(p.data)] }), close: async () => {} }) };
  window.showOpenFilePicker = async () => [h]; })()`;

async function newPage(viewport) {
  const ctx = await browser.newContext(Object.assign({ acceptDownloads: true }, viewport ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log(`  ! [${section}] pageerror: ` + e.message); fails++; });
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_(FAILED|TUNNEL|CONNECTION)|jsdelivr|favicon/.test(m.text())) { console.log(`  ! [${section}] console: ` + m.text()); fails++; } });
  await page.route(/jsdelivr\.net/, (r) => r.abort());   // skip the heavy Pyodide CDN
  await page.addInitScript(fakeHandle());
  return page;
}
async function gotoIsoTab(page) { await page.goto(base, { waitUntil: "domcontentloaded" }); await page.click('.mtab[data-mode="iso"]'); }
async function loadIso(page) { await gotoIsoTab(page); await page.click("#isoPick"); await page.waitForSelector("#isoTabs", { timeout: 8000 }); }

// Reconstruct the final on-disk byte at an offset = the captured write if present, else the
// original synth byte. (Saves only write CHANGED runs, so a field where just one byte moved
// won't have its other bytes in the writes — fall back to the pristine image for those.)
function reader(writes) {
  const at = (pos) => { const w = writes.find((x) => pos >= x.pos && pos < x.pos + x.data.length); return w ? w.data[pos - w.pos] : bytes[pos]; };
  const wrote = (pos, n = 1) => { for (let i = 0; i < n; i++) if (writes.some((w) => pos + i >= w.pos && pos + i < w.pos + w.data.length)) return true; return false; };
  return {
    at, wrote,
    u8: at,
    u16: (p) => at(p) | (at(p + 1) << 8),
    u32: (p) => (at(p) | at(p + 1) << 8 | at(p + 2) << 16 | at(p + 3) << 24) >>> 0,
  };
}
const getWrites = (page) => page.evaluate(() => window.__writes);

// ---- deterministic waits ------------------------------------------------------------------
// Two things in the editor land LATER than the action that caused them, and reading them on a
// fixed sleep is what made this suite flaky on a loaded machine:
//   * the "unsaved" badge is repainted on a requestAnimationFrame (iso.js scheduleBadge), so a
//     read taken straight after an edit can still show the PREVIOUS frame's state;
//   * the import/patch handlers are async (file read, then ranged reads off the disc), so
//     #isoStatus can still be carrying the message from the step before.
// These helpers wait for the state under test and then hand back what it ACTUALLY is, so a
// genuine regression still fails its check (with the real value) instead of timing out here.
async function until(page, fn, arg, timeout = 10000) {
  try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch { return false; }
}
// Run out the badge's PENDING repaint. scheduleBadge() queues its callback on the next
// animation frame; ours is queued after it, so by the time ours runs the badge is current.
// Without this a read can match the state the badge is about to LEAVE — which is how
// "returning to the stock owner clears every staged byte" passed and failed at random
// (badge still hidden from before the edit = accidental pass; repainted once = failure).
const flushBadge = (page) => page.evaluate(() => new Promise((res) => {
  let done = false;
  const fin = () => { if (!done) { done = true; res(); } };
  setTimeout(fin, 3000);                       // never hang if the page stops painting
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(fin, 0)));
}));
const readDirty = (page) => page.evaluate(() => { const d = document.querySelector("#isoDirty"); return !d || d.hidden; });
async function dirtyHiddenIs(page, want) {
  await flushBadge(page);
  await until(page, (w) => { const d = document.querySelector("#isoDirty"); return (!d || d.hidden) === w; }, want);
  return (await readDirty(page)) === want;
}
const nothingStaged = (page) => dirtyHiddenIs(page, true);    // badge hidden
const somethingStaged = (page) => dirtyHiddenIs(page, false); // badge showing
// Wait for the badge's label (it is rAF-repainted like its visibility) and return the text.
async function dirtyLabel(page, re) {
  await flushBadge(page);
  await until(page, (src) => new RegExp(src[0], src[1]).test(document.querySelector("#isoDirty")?.textContent || ""), [re.source, re.flags]);
  return page.textContent("#isoDirty");
}
// Wait for #isoStatus to carry the message under test, then return the real text for the check.
async function statusText(page, re) {
  await until(page, (src) => new RegExp(src[0], src[1]).test(document.querySelector("#isoStatus")?.textContent || ""), [re.source, re.flags]);
  return page.textContent("#isoStatus");
}
const statusHas = async (page, re) => re.test(await statusText(page, re));
// Feed a file to the import button and wait for the handler to actually finish. The status line
// is cleared first so the previous step's message can't be mistaken for this one's, and the
// import button re-enabling is the app's own "no longer busy" signal (iso.js setBusy) — the
// xdelta path posts progress messages before its verdict.
const IMPORT_DONE = () => {
  const s = document.querySelector("#isoStatus"), b = document.querySelector("#isoImportBtn");
  return !!s && s.textContent.trim().length > 0 && !!b && !b.disabled;
};
async function importFile(page, files) {
  await page.evaluate(() => { const s = document.querySelector("#isoStatus"); if (s) s.textContent = ""; });
  await page.setInputFiles("#isoRecipeFile", files);
  await until(page, IMPORT_DONE, null, 20000);
  await flushBadge(page);
  return page.textContent("#isoStatus");
}
// Open a <details> record idempotently — cross-view open-state preservation can already
// have opened it, and clicking the summary again would toggle it shut.
async function openRec(page, detailsSel) {
  const loc = page.locator(detailsSel).first();
  if ((await loc.getAttribute("open")) === null) await loc.locator("summary").click();
  await page.waitForTimeout(50);
}
// ---- .xdelta helpers (patch-apply tests) --------------------------------------------------
// Patches are built by REAL xdelta3 so the decoder is exercised against genuine output, not
// against our own encoder. `-S none` because xdelta3 defaults to LZMA secondary compression,
// which the editor refuses by design (one test asserts exactly that, using lzma=true).
let _xd = null;
function xdelta3Available() {
  if (_xd === null) { try { execFileSync("xdelta3", ["-V"], { stdio: "ignore" }); _xd = true; } catch { _xd = false; } }
  return _xd;
}
function makeXdelta(src, tgt, lzma = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3e2e-"));
  const s = path.join(dir, "s.bin"), t = path.join(dir, "t.bin"), p = path.join(dir, "p.xd");
  fs.writeFileSync(s, Buffer.from(src)); fs.writeFileSync(t, Buffer.from(tgt));
  execFileSync("xdelta3", ["-e", "-f", "-q", ...(lzma ? [] : ["-S", "none"]), "-s", s, t, p]);
  const out = new Uint8Array(fs.readFileSync(p));
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
// Feed bytes to the app's file input as if the user picked them.
async function uploadPatch(page, data, name) {
  return importFile(page, { name, mimeType: "application/octet-stream", buffer: Buffer.from(data) });
}

async function save(page) {
  await page.evaluate(() => { window.__writes = []; });   // capture only THIS save's writes
  await page.click("#isoSaveBtn");
  // the backup nudge only appears on the FIRST save of a session
  try { await page.waitForSelector("#bnSkip", { timeout: 700 }); await page.click("#bnSkip"); } catch { /* already nudged */ }
  await page.waitForSelector("#cfOk", { timeout: 3000 });
  await page.click("#cfOk");
  await page.waitForSelector("#pgClose:visible", { timeout: 5000 });
  await page.click("#pgClose");
  return reader(await getWrites(page));
}

// =====================================================================================
head("Fallback (no File System Access → input loader)");
{ const page = await newPage();
  await page.addInitScript("Object.defineProperty(window,'showOpenFilePicker',{value:undefined})");
  await gotoIsoTab(page); await page.waitForTimeout(150);
  // Without FS Access we no longer hard-block: the loader offers a plain <input type=file>
  // (open + stage + streaming/recipe save), and the FS-only picker button is absent.
  check("input-file loader shown, no FS picker",
    !!(await page.$("#isoFileInput")) && !(await page.$("#isoPick")));
  await page.context().close();
}

head("ISO validation");
{ // Wait for the EXPECTED rejection text, not a fixed 300ms: reading the multi-MB fixture over
  // HTTP can outlast any constant, which flaked ~1 run in 8. Waiting merely for "not still
  // loading" is not enough either — the loader's idle placeholder (".iso / .bin / .img · USA
  // release only") satisfies that instantly AND contains "USA", so a loose check would pass
  // before the version check had even run. Wait for the specific message.
  const rejection = async (page, re) => {
    await page.waitForFunction((src) => {
      const el = document.querySelector("#isoBootStatus");
      return !!(el && new RegExp(src, "i").test(el.textContent || ""));
    }, re.source, { timeout: 10000 });
    return page.textContent("#isoBootStatus");
  };
  // wrong version word
  const bad = bytes.slice(); new DataView(bad.buffer).setUint32(VERSION_OFF, 0x11223344, false);
  setServed(bad);
  const page = await newPage();
  await gotoIsoTab(page); await page.click("#isoPick");
  const want = /Not a USA \(SLUS-20387\)/;
  let msg = "";
  try { msg = await rejection(page, want); } catch { msg = await page.textContent("#isoBootStatus"); }
  check("rejects non-USA version word", !(await page.$("#isoTabs")) && want.test(msg), msg);
  await page.context().close();
  // undersized file
  setServed(new Uint8Array(2048));
  const page2 = await newPage();
  await gotoIsoTab(page2); await page2.click("#isoPick");
  const want2 = /not a full Suikoden III ISO/;
  let msg2 = "";
  try { msg2 = await rejection(page2, want2); } catch { msg2 = await page2.textContent("#isoBootStatus"); }
  check("rejects too-small file", !(await page2.$("#isoTabs")) && want2.test(msg2), msg2);
  await page2.context().close();
  setServed(bytes);
}

head("Overlap guard");
{ const page = await newPage(); await loadIso(page);
  await page.fill("#isoSearch", "79"); await page.waitForTimeout(80);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  check("last record hides spill-over fields", (await page.locator("details.char[open] .char-body").innerText()).includes("overlap the next table"));
  await page.context().close();
}

head("Byte-exact edits across every editable view");
{ const page = await newPage(); await loadIso(page);
  const [l2b, l2s] = TABLES.list2, [l3b, l3s] = TABLES.list3, [l4b] = TABLES.list4;
  // Weapons (list4): ATK Lv1 (byte @ rec0+0)
  await page.click('#isoTabs [data-v="weapons"]'); await openRec(page, "details.char");
  await page.fill('details.char[open] input[data-off="' + l4b + '"]', "77"); await page.dispatchEvent('details.char[open] input[data-off="' + l4b + '"]', "change");
  // Shops: item slot (picker) + a price (number)
  await page.click('#isoTabs [data-v="shops"]');
  await page.click("button.shopitem >> nth=0"); await page.waitForSelector(".picker-search"); await page.fill(".picker-search", String(armor.id)); await page.click(".picker-row >> nth=0");
  await page.fill('input.shopnum >> nth=0', "12345"); await page.dispatchEvent('input.shopnum >> nth=0', "change");
  // Support (list3): first support skill (skill picker). First *named* record is index 1.
  await page.click('#isoTabs [data-v="support"]'); await openRec(page, "details.char");
  const l3rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  await page.click('details.char[open] button.picker >> nth=0'); await page.waitForSelector(".picker-search"); await page.fill(".picker-search", "0a"); await page.click(".picker-row >> nth=0");
  // Growth (list2): a growth rate + a skillmax select + fixed skill num
  await page.click('#isoTabs [data-v="growth"]'); await openRec(page, "details.char"); await page.waitForTimeout(60);
  const l2rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  await page.fill('details.char[open] input[data-off="' + (l2rec + 4) + '"]', "9"); await page.dispatchEvent('details.char[open] input[data-off="' + (l2rec + 4) + '"]', "change");
  await page.selectOption('details.char[open] select[data-off="' + (l2rec + 16) + '"]', "3");   // skillmax skill#1 -> D (array starts +16)
  // Spells: power/cast/element/target/aoe/status
  await page.click('#isoTabs [data-v="spells"]'); await openRec(page, 'details.char[data-i="0"]');
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "1234"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change");
  await page.fill('details.char[data-i="0"] input[data-k="cast"]', "40"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="cast"]', "change");
  await page.selectOption('details.char[data-i="0"] select[data-k="elementId"]', "5");
  await page.selectOption('details.char[data-i="0"] select[data-k="target"]', "2");
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1");
  await page.selectOption('details.char[data-i="0"] select[data-k="status"]', "sleep");
  // ally-pair targeting (0x41, the Kindness Drops / Vengeful Child byte) on a second spell
  await openRec(page, 'details.char[data-i="1"]');
  await page.selectOption('details.char[data-i="1"] select[data-k="target"]', "65");
  // Unites: power/cast/target/aoe
  await page.click('#isoTabs [data-v="unites"]'); await openRec(page, 'details.char[data-i="0"]');
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "555"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change");
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1");
  // Gear: DEF/price/effect/desc
  await page.click('#isoTabs [data-v="gear"]'); await openRec(page, "details.char");
  await page.fill('input.gr[data-l="DEF"]', "42"); await page.dispatchEvent('input.gr[data-l="DEF"]', "change");
  await page.fill('input.gr[data-l="Price"]', "9999"); await page.dispatchEvent('input.gr[data-l="Price"]', "change");
  await page.selectOption(".ge-type >> nth=0", "1");   // effect0 type -> HP regen
  // Food: heal/proc
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "250"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  await page.fill('input.fd[data-kind="proc"] >> nth=0', "60"); await page.dispatchEvent('input.fd[data-kind="proc"] >> nth=0', "change");

  const r = await save(page);
  check("list4 ATK Lv1 = 77", r.u8(l4b) === 77);
  check("shop item slot = armor id", r.u16(SHOP.item3_a[0]) === armor.id);
  check("shop price = 12345", r.u32(SHOP.item2[0]) === 12345);
  check("support skill1 = 0x0A", r.u8(l3rec) === 0x0A);
  check("growth PWR rate = 9", r.u8(l2rec + 4) === 9);
  check("skillmax#1 = 3 (D)", r.u8(l2rec + 16) === 3);
  check("spell0 power = 1234", r.u32(SPELL.off + 0x1C) === 1234);
  check("spell0 cast = 40", r.u32(SPELL.off + 0x10) === 40);
  check("spell0 element = Lightning(5)", (r.u16(SPELL.off + SPELL.elem) & 0xFF) === 5);
  // AOE is the top bit of the target byte, so target=all-foes(0x02) + AOE => high byte 0x82
  { const f14 = r.u32(SPELL.off + 0x14); check("spell0 target=all-foes + AOE bit", ((f14 >> 8) & 0x0F) === 0x02 && !!(f14 & 0x8000)); }
  { const f14 = r.u32(SPELL.off + SPELL.stride + 0x14); check("spell1 target=ally-pair (0x41)", ((f14 >> 8) & 0x7F) === 0x41 && !(f14 & 0x8000)); }
  check("spell0 status = sleep(bit10)", r.u32(SPELL.off + 0x18) === (1 << 10));
  check("unite0 power = 555", r.u32(UNITE.off + 0x1C) === 555);
  check("unite0 AOE bit set", !!(r.u32(UNITE.off + 0x14) & 0x8000));
  check("gear DEF = 42", r.u16(GEAR.P + GEAR.stride + GEAR.def) === 42);
  check("gear price = 9999", r.u32(GEAR.P + GEAR.stride + GEAR.price) === 9999);
  check("gear effect0 type = 1", r.u16(GEAR.P + GEAR.stride + GEAR.effs[0]) === 1);
  check("food0 heal = 250", r.u16(FOOD.off + FOOD.heal) === 250);
  check("food0 proc = 60", r.u16(FOOD.off + FOOD.proc) === 60);
  await page.context().close();
}

head("Character pickers (item + skill) byte-exact");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]');
  await page.fill("#isoSearch", "1"); await page.waitForTimeout(60);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  const rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  // "Other item 1" (off 112, all-items picker) -> pick armor by exact id
  await page.click('details.char[open] button.picker[data-off="' + (rec + 112) + '"]');
  await page.waitForSelector(".picker-search"); await page.fill(".picker-search", String(armor.id)); await page.click(".picker-row >> nth=0");
  // "Skill 1 (id)" (off 12, skill picker) -> pick skill 0x0A
  await page.click('details.char[open] button.picker[data-off="' + (rec + 12) + '"]');
  await page.waitForSelector(".picker-search"); await page.fill(".picker-search", "0a"); await page.click(".picker-row >> nth=0");
  const r = await save(page);
  check("Other item 1 = armor id (u16)", r.u16(rec + 112) === armor.id);
  check("Skill 1 = 0x0A (u8)", r.u8(rec + 12) === 0x0A);
  await page.context().close();
}

head("Armor sets view — decode, edit, byte-exact save");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="sets"]');
  await page.waitForSelector("#setCards details.char", { timeout: 3000 });
  check("all 5 set cards render", (await page.$$("#setCards details.char")).length === 5);
  // decode of planted stock values: Mole head slot shows Mole Helm (0x0AD = 173)
  const moleHead = SETS.table;   // set 0, slot 0
  check("Mole head slot decodes to Mole Helm", (await page.inputValue(`select.set-slot[data-off="${moleHead}"]`)) === "173");
  check("counter chance decodes to 30", (await page.inputValue("#setCounter")) === "30");
  check("heal share decodes to 25% (shift 2)", (await page.inputValue("#setHeal")) === "2");
  // the potch pair lives outside a synth file → the control must degrade, not lie
  check("potch multiplier degrades to 'unavailable'", (await page.textContent("#isoView")).includes("unavailable"));
  // edit: swap Mole head to Old Helm (0x0AE = 174), counter -> 50, heal -> 50% (shift 1)
  await page.selectOption(`select.set-slot[data-off="${moleHead}"]`, "174");
  await page.fill("#setCounter", "50"); await page.dispatchEvent("#setCounter", "change");
  await page.selectOption("#setHeal", "1");
  const r = await save(page);
  check("set table: Mole head = Old Helm", r.u16(moleHead) === 174);
  check("counter site A = slti 50", r.u32(SETS.counterSites[0]) === 0x28420032);
  check("counter site B = slti 50", r.u32(SETS.counterSites[1]) === 0x28420032);
  check("heal bias = addiu +1", r.u32(SETS.healBias) === 0x26220001);
  check("heal shift = sra 1", r.u32(SETS.healShift) === 0x00021043);
  await page.context().close();
}

head("Armor set effect ownership — reassign which set grants what");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="sets"]');
  await page.waitForSelector("#ownCounter", { timeout: 3000 });
  // stock owners decode: counter=Destiny(3), heal=Pale Moon(5), squeak=Mole(1), halving mask=4
  check("counter owner decodes to Destiny", (await page.inputValue("#ownCounter")) === "3");
  check("heal owner decodes to Pale Moon", (await page.inputValue("#ownHeal")) === "5");
  check("squeak owner decodes to Mole", (await page.inputValue("#ownSqueak")) === "1");
  check("halving mask decodes to 4", (await page.inputValue("#ownHalve")) === "4");
  // the mask dropdown must name the sets a bit test actually selects (4 -> Guardian + Pale Moon)
  check("mask option names its real set group (and flags the stock value)",
    (await page.textContent("#ownHalve option[value='4']")).trim() === "Guardian + Pale Moon (stock)");
  check("mask 1 names the odd-numbered sets",
    (await page.textContent("#ownHalve option[value='1']")).trim() === "Mole + Destiny + Pale Moon");
  // reassign: counter -> Mole(1), heal -> Guardian(4), squeak -> off(6), halving -> mask 2
  await page.selectOption("#ownCounter", "1");
  await page.selectOption("#ownHeal", "4");
  await page.selectOption("#ownSqueak", "6");
  await page.selectOption("#ownHalve", "2");
  const r = await save(page);
  check("counter owner site A = addiu 1", r.u32(SETS.counterOwnerSites[0]) === 0x24020001);
  check("counter owner site B = addiu 1", r.u32(SETS.counterOwnerSites[1]) === 0x24020001);
  check("heal owner = addiu $s4,4", r.u32(SETS.healOwnerSite) === 0x24140004);
  check("squeak owner = addiu $s1,6 (off)", r.u32(SETS.squeakOwnerSite) === 0x24110006);
  check("halving mask = andi 2", r.u32(SETS.halveMaskSite) === 0x30420002);
  // moving the heal owner off Pale Moon must restore the divisor it clobbers
  check("heal divisor repair written", r.u32(SETS.healDivRepair) === 0x24140005);
  await page.context().close();
}

head("Heal-owner round trip leaves no stray bytes");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="sets"]');
  await page.waitForSelector("#ownHeal", { timeout: 3000 });
  await page.selectOption("#ownHeal", "2");            // off stock -> repair patch written
  await page.selectOption("#ownHeal", "5");            // back to stock -> repair must be undone
  const clean = await nothingStaged(page);
  check("returning to the stock owner clears every staged byte", clean,
    clean ? "" : await page.evaluate(() => `badge="${document.querySelector("#isoDirty")?.textContent}" ownHeal=${document.querySelector("#ownHeal")?.value}`));
  await page.context().close();
}

head("Enemies view — real index unavailable on a small disc");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForTimeout(150);
  const txt = await page.textContent("#isoView");
  // the shipped s3_enemy_packs.json targets the 4.3 GB disc; every pack must be skipped
  check("packs degrade to 'unavailable' (no wrong data)", /none of their offsets exist/.test(txt));
  check("bestiary reference still present", /bestiary reference/i.test(txt));
  await page.context().close();
}

head("Enemies editor — decode, edit, write-through both copies");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 3000 });
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  // decode of the planted fixture
  check("Level decodes to 7", (await page.inputValue('input.en-num[data-f="lv"]')) === "7");
  check("HP decodes to 40", (await page.inputValue('input.en-num[data-f="hp"]')) === "40");
  check("SP decodes to 9", (await page.inputValue('input.en-num[data-f="sp"]')) === "9");
  check("Potch decodes to 60", (await page.inputValue('input.en-num[data-f="potch"]')) === "60");
  check("stat PWR decodes to 11", (await page.inputValue('input.en-num[data-f="stat0"]')) === "11");
  check("drop 1 shows Medicine D", /Medicine D/.test(await page.textContent('button.en-item[data-f="drop0i"]')));
  check("drop 1 weight decodes to 128", (await page.inputValue('input.en-num[data-f="drop0w"]')) === "128");
  // edit every field kind
  const set = async (f, v) => { await page.fill(`input.en-num[data-f="${f}"]`, String(v)); await page.dispatchEvent(`input.en-num[data-f="${f}"]`, "change"); };
  await set("lv", 50); await set("hp", 1234); await set("sp", 77); await set("potch", 9999); await set("stat3", 222); await set("drop0w", 500);
  await page.click('button.en-item[data-f="drop1i"]');
  await page.waitForSelector(".picker-search"); await page.fill(".picker-search", String(armor.id)); await page.click(".picker-row >> nth=0");
  const r = await save(page);
  for (const [nm, rec, aux] of [["copy A", ENEMY_REC_A, ENEMY_AUX_A], ["copy B", ENEMY_REC_B, ENEMY_AUX_B]]) {
    check(`${nm}: level = 50`, r.u16(rec + 64) === 50);
    check(`${nm}: HP = 1234 (both fields)`, r.u16(rec + 48) === 1234 && r.u16(rec + 50) === 1234);
    check(`${nm}: REP stat = 222`, r.u16(rec + 32 + 6) === 222);
    check(`${nm}: SP = 77`, r.u16(aux + 12) === 77);
    check(`${nm}: potch = 9999`, r.u32(aux + 16) === 9999);
    check(`${nm}: drop1 weight = 500`, r.u16(aux + 34) === 500);
    check(`${nm}: drop2 item = armor`, r.u16(aux + 36) === armor.id);
  }
  await page.context().close();
}

head("Enemies bulk tuning — idempotent multipliers + reset");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("#ebApply", { timeout: 3000 });
  const apply = async (id, v) => { await page.fill(`#${id}`, String(v)); await page.dispatchEvent(`#${id}`, "change"); await page.click("#ebApply"); await page.waitForTimeout(100); };
  // x2 -> 80, applying again must NOT compound, x3 replaces (from orig 40 -> 120)
  await apply("ebHp", 2);
  await page.click("details.epack summary"); await page.waitForSelector('input.en-num[data-f="hp"]');
  check("HP x2 = 80", (await page.inputValue('input.en-num[data-f="hp"]')) === "80");
  await page.click("#ebApply"); await page.waitForTimeout(100);
  check("re-apply does not compound", (await page.inputValue('input.en-num[data-f="hp"]')) === "80");
  await apply("ebHp", 3);
  check("x3 replaces, from originals (120)", (await page.inputValue('input.en-num[data-f="hp"]')) === "120");
  // fields at x1 stay untouched: level still 7
  check("level untouched at x1", (await page.inputValue('input.en-num[data-f="lv"]')) === "7");
  // sp x0.5 rounds from orig 9 -> 5 (Math.round(4.5))
  await apply("ebSp", 0.5);
  check("SP x0.5 rounds to 5 (hp x3 kept)", (await page.inputValue('input.en-num[data-f="sp"]')) === "5"
    && (await page.inputValue('input.en-num[data-f="hp"]')) === "120");
  // drop weight x2 scales the used slot, leaves empty slots empty
  await apply("ebDropw", 2);
  check("drop weight x2 = 256", (await page.inputValue('input.en-num[data-f="drop0w"]')) === "256");
  check("empty drop slot stays 0", (await page.inputValue('input.en-num[data-f="drop1w"]')) === "0");
  // reset (pre-save) returns everything to disc originals -> no unsaved changes
  await page.click("#ebReset"); await page.waitForTimeout(150);
  check("reset restores originals", (await page.inputValue('input.en-num[data-f="hp"]')) === "40");
  check("reset leaves no staged bytes", await nothingStaged(page));
  // re-apply the kept multipliers and make sure the SAVED bytes hit every copy
  await page.click("#ebApply"); await page.waitForTimeout(150);
  const r = await save(page);
  for (const [nm, rec, aux] of [["copy A", ENEMY_REC_A, ENEMY_AUX_A], ["copy B", ENEMY_REC_B, ENEMY_AUX_B]]) {
    check(`${nm}: HP saved = 120 (both fields)`, r.u16(rec + 48) === 120 && r.u16(rec + 50) === 120);
    check(`${nm}: SP saved = 5`, r.u16(aux + 12) === 5);
    check(`${nm}: drop weight saved = 256`, r.u16(aux + 34) === 256);
  }
  await page.context().close();
}

head("Zones & formations — decode, edit, write-through both copies");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 3000 });
  await page.click("details.epack summary");
  await page.waitForSelector("button.zn-slot", { timeout: 3000 });
  // decode
  check("zone renders with its map name", (await page.textContent("#isoView")).includes("test_101"));
  check("slot 0 decodes to BladeBunny", /BladeBunny/.test(await page.textContent('button.zn-slot[data-si="0"]')));
  check("slot 1 variant decodes to 1", (await page.inputValue('input.zn-var[data-si="1"]')) === "1");
  check("formation 1 weight decodes to 50", (await page.inputValue('input.zn-prob[data-pi="0"]')) === "50");
  check("formation 1 member 2 = slot 1", (await page.inputValue('select.zn-mem[data-pi="0"][data-mi="1"]')) === "1");
  // edit: weight 90, member 2 -> slot 0, size 1, slot1 variant -> 0
  await page.fill('input.zn-prob[data-pi="0"]', "90"); await page.dispatchEvent('input.zn-prob[data-pi="0"]', "change");
  await page.selectOption('select.zn-mem[data-pi="0"][data-mi="1"]', "0");
  await page.fill('input.zn-cnt[data-pi="1"]', "1"); await page.dispatchEvent('input.zn-cnt[data-pi="1"]', "change");
  await page.fill('input.zn-var[data-si="1"]', "0"); await page.dispatchEvent('input.zn-var[data-si="1"]', "change");
  // size caps at the original allocation
  await page.fill('input.zn-cnt[data-pi="0"]', "6"); await page.dispatchEvent('input.zn-cnt[data-pi="0"]', "change");
  check("formation size caps at original allocation", (await page.inputValue('input.zn-cnt[data-pi="0"]')) === "2");
  const r = await save(page);
  for (const [nm, slO, paO, meO] of [["copy A", ZONE_SLOTS_A, ZONE_PARTY_A, ZONE_MEM_A], ["copy B", ZONE_SLOTS_B, ZONE_PARTY_B, ZONE_MEM_B]]) {
    check(`${nm}: weight saved = 90`, r.u16(paO + 2) === 90);
    check(`${nm}: member rewritten to slot 0`, r.u8(meO + 1) === 0);
    check(`${nm}: formation 2 size = 1`, r.u16(paO + 0x1C + 0x12) === 1);
    check(`${nm}: slot 1 variant = 0`, r.u32(slO + 0x14 + 4) === 0);
  }
  await page.context().close();
}

head("Enemies editor — recipe export covers enemy bytes");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 3000 });
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  await page.fill('input.en-num[data-f="lv"]', "42"); await page.dispatchEvent('input.en-num[data-f="lv"]', "change");
  const dl = page.waitForEvent("download");
  await page.click("#isoRecipeBtn");
  const mod = JSON.parse(fs.readFileSync(await (await dl).path(), "utf8"));
  const a = mod.patches.find((p) => p.off === ENEMY_REC_A + 64), b = mod.patches.find((p) => p.off === ENEMY_REC_B + 64);
  check("recipe has copy-A run (7 -> 42)", !!a && a.old === "07" && a.new === "2a");
  check("recipe has copy-B run", !!b && b.new === "2a");
  await page.context().close();
}

head("War view — real index unavailable on a small disc, reference still shows");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="war"]');
  await page.waitForTimeout(150);
  const txt = await page.textContent("#isoView");
  check("war packs degrade to 'unavailable' (no wrong data)", /none of their offsets exist/.test(txt));
  check("army skills reference still present", /Army skills reference/.test(txt));
  await page.click("#isoView details.char summary");
  const body = await page.textContent("#isoView");
  check("reference lists a character's war skills", /Caesar/.test(body) && /Control VII, Tactics III/.test(body));
  await page.context().close();
}

head("War editor — decode, edit, write-through both copies, no reward fields");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_WAR_UNITS = ${JSON.stringify(WAR_TEST_UNITS)};`);
  await loadIso(page);
  // the war pack must NOT leak into the Enemies view or its bulk scope
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForTimeout(150);
  check("war pack hidden from Enemies view", !/ZxnKn/.test(await page.textContent("#isoView")));
  await page.click('#isoTabs [data-v="war"]');
  await page.waitForSelector("details.epack", { timeout: 3000 });
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  check("Level decodes to 20", (await page.inputValue('input.en-num[data-f="lv"]')) === "20");
  check("HP decodes to 230", (await page.inputValue('input.en-num[data-f="hp"]')) === "230");
  check("stat PWR decodes to 49", (await page.inputValue('input.en-num[data-f="stat0"]')) === "49");
  check("no reward fields on a war unit", !(await page.isVisible('input.en-num[data-f="sp"]')) && !(await page.isVisible('button.en-item[data-f="drop0i"]')));
  const set = async (f, v) => { await page.fill(`input.en-num[data-f="${f}"]`, String(v)); await page.dispatchEvent(`input.en-num[data-f="${f}"]`, "change"); };
  await set("lv", 55); await set("hp", 999); await set("stat2", 111);
  const r = await save(page);
  for (const [nm, rec] of [["copy A", WAR_REC_A], ["copy B", WAR_REC_B]]) {
    check(`${nm}: level = 55`, r.u16(rec + 64) === 55);
    check(`${nm}: HP = 999 (both fields)`, r.u16(rec + 48) === 999 && r.u16(rec + 50) === 999);
    check(`${nm}: MAG stat = 111`, r.u16(rec + 32 + 4) === 111);
  }
  await page.context().close();
}

head("Rune reskin + description rewrite");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]');
  await page.selectOption("#rsRune", "fire"); await page.fill("#rsPower", "300"); await page.click("#rsApply"); await page.waitForTimeout(150);
  const r = await save(page);
  check("reskin: spell0 power = 300", r.u32(SPELL.off + 0x1C) === 300);
  check("reskin: spell3 power = 300", r.u32(SPELL.off + 3 * SPELL.stride + 0x1C) === 300);
  // desc "Deals 100DMG" -> "Deals 300DMG": the "100"->"300" is a 1-byte change (first digit)
  const descWrite = (await getWrites(page)).some((w) => w.pos >= 0x400000);
  check("reskin: description bytes rewritten", descWrite);
  await page.context().close();
}

head("Target / Area-of-effect independent highlight + AOE-preserving Target write");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await openRec(page, 'details.char[data-i="0"]');
  const dirty = (k) => page.evaluate((k) => document.querySelector(`details.char[data-i="0"] select[data-k="${k}"]`).classList.contains("dirty"), k);
  // synth spell0 flags14 = 0x0A00 (target single 0x0A, AOE off). Turn AOE on → only AOE flags.
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1"); await page.waitForTimeout(60);
  check("AOE change highlights AOE only", (await dirty("aoe")) === true && (await dirty("target")) === false);
  // Change Target → Target flags; the write must PRESERVE the AOE bit.
  await page.selectOption('details.char[data-i="0"] select[data-k="target"]', "2"); await page.waitForTimeout(60);
  check("Target change highlights Target", (await dirty("target")) === true);
  { const r = await save(page); const f14 = r.u32(SPELL.off + 0x14);
    check("Target write preserved AOE bit", ((f14 >> 8) & 0x7F) === 0x02 && !!(f14 & 0x8000)); }
  await page.context().close();
}

head("Spell description — editable, auto-updates on Power, length-capped");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await openRec(page, 'details.char[data-i="0"]');
  const desc = 'details.char[data-i="0"] input.spdesc';
  check("spell description field present", await page.isVisible(desc));
  check("spell description capped to slot (12)", +(await page.getAttribute(desc, "maxlength")) === 12);   // "Deals 100DMG"
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "300"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change"); await page.waitForTimeout(60);
  check("Power change rewrote description inline", (await page.inputValue(desc)) === "Deals 300DMG");
  check("rewritten description is highlighted", await page.evaluate((s) => document.querySelector(s).classList.contains("dirty"), desc));
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "100000"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change"); await page.waitForTimeout(60);
  check("over-length auto-rewrite is skipped", (await page.inputValue(desc)) === "Deals 300DMG");
  check("over-length auto-rewrite warns", await statusHas(page, /length limit/i));
  await page.evaluate((s) => { const e = document.querySelector(s); e.value = "X".repeat(40); e.dispatchEvent(new Event("change", { bubbles: true })); }, desc);
  await page.waitForTimeout(60);
  check("manual over-length description rejected", await statusHas(page, /too long/i));
  check("manual over-length not applied", (await page.inputValue(desc)) === "Deals 300DMG");
  await page.context().close();
}

head("Unite description — editable + length-capped");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="unites"]'); await openRec(page, 'details.char[data-i="0"]');
  const desc = 'details.char[data-i="0"] input.undesc';
  check("unite description field present", await page.isVisible(desc));
  check("unite description capped to slot (4)", +(await page.getAttribute(desc, "maxlength")) === 4);   // "coop"
  await page.evaluate((s) => { const e = document.querySelector(s); e.value = "X".repeat(10); e.dispatchEvent(new Event("change", { bubbles: true })); }, desc);
  await page.waitForTimeout(60);
  check("unite over-length description rejected", await statusHas(page, /too long/i));
  await page.context().close();
}

head("Food description — editable, auto-updates on heal, length-capped");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]'); await page.waitForTimeout(80);
  const desc = "input.fddesc >> nth=0";
  check("food description field present", await page.isVisible(desc));
  check("food description capped to slot (11)", +(await page.getAttribute(desc, "maxlength")) === 11);   // "Heals 100HP"
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "250"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change"); await page.waitForTimeout(60);
  check("heal change rewrote food desc inline", (await page.inputValue(desc)) === "Heals 250HP");
  check("rewritten food desc highlighted", await page.evaluate(() => document.querySelector("input.fddesc").classList.contains("dirty")));
  await page.evaluate(() => { const e = document.querySelector("input.fddesc"); e.value = "X".repeat(40); e.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(60);
  check("manual over-length food desc rejected", await statusHas(page, /too long/i));
  await page.context().close();
}

head("Character rename panel — scoped, same-length-capped, staged");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]'); await page.waitForTimeout(80);
  check("rename inputs present (Hugo/Chris/Geddoe)", (await page.locator("input.rename").count()) === 3);
  check("Hugo rename capped to 4 chars", +(await page.getAttribute('input.rename[data-orig="Hugo"]', "maxlength")) === 4);
  check("Geddoe rename capped to 6 chars", +(await page.getAttribute('input.rename[data-orig="Geddoe"]', "maxlength")) === 6);
  await page.fill('input.rename[data-orig="Geddoe"]', "Gideon"); await page.dispatchEvent('input.rename[data-orig="Geddoe"]', "input"); await page.waitForTimeout(40);
  check("staged rename highlights", await page.evaluate(() => document.querySelector('input.rename[data-orig="Geddoe"]').classList.contains("dirty")));
  // this harness uses the FS-Access (in-place) path, where renames can't reach disc-wide copies
  await page.click("#isoSaveBtn");
  check("rename-only in-place save warns it needs streaming", await statusHas(page, /streaming/i));
  await page.context().close();
}

head("Per-field revert + Revert all + badge");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "300"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change"); await page.waitForTimeout(60);
  const rev = page.locator('input.fd[data-kind="heal"]').first().locator('xpath=following-sibling::button[contains(@class,"revert")]');
  check("revert tooltip = original", (await rev.getAttribute("title")) === "Restore original (100)");
  check("badge visible after edit", await somethingStaged(page));
  await rev.click(); await page.waitForTimeout(120);
  check("per-field revert restores value", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "100");
  // edit two, then Revert all
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "111"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  await page.fill('input.fd[data-kind="proc"] >> nth=0', "22"); await page.dispatchEvent('input.fd[data-kind="proc"] >> nth=0', "change");
  await page.click("#isoResetBtn"); await page.waitForTimeout(80);
  check("Revert all clears dirty badge", await nothingStaged(page));
  check("Revert all restores values", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "100");
  await page.context().close();
}

head("Balance (Hard Mode) — idempotent + reset");
{ const page = await newPage(); await loadIso(page);
  const [l2b, l2s] = TABLES.list2;
  // synth plants list2 rec1 growth +4..+11 = [6,5,4,3,3,4,2,8]; Hard PWR mult 0.7 -> round(6*0.7)=4
  await page.click('#isoTabs [data-v="balance"]');
  await page.click('[data-preset="hard"]'); await page.click("#hm-apply"); await page.waitForTimeout(120);
  let r = await save(page);
  const pwrOff = l2b + 1 * l2s + 4;
  check("hard: PWR growth 6 -> 4", r.u8(pwrOff) === 4);
  // idempotent: applying Hard again after save scales from the NEW originals -> 4*0.7=3 (not compounding to a spiral)
  await page.click('#isoTabs [data-v="balance"]'); await page.click('[data-preset="hard"]'); await page.click("#hm-apply"); await page.waitForTimeout(120);
  r = await save(page);
  check("hard again: 4 -> 3 (scales from disk, no runaway)", r.u8(pwrOff) === 3);
  // reset to 1.00x -> no changes staged
  await page.click('#isoTabs [data-v="balance"]'); await page.click('[data-preset="reset"]'); await page.click("#hm-apply"); await page.waitForTimeout(120);
  check("reset preset stages nothing", await nothingStaged(page));
  await page.context().close();
}

head("Global encounter rate — scale all three movement paths");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  check("Encounter is its own top-level tab", !!(await page.$('#isoTabs [data-v="encounter"]')));
  check("the Balance tab no longer carries the rate field", await (async () => {
    await page.click('#isoTabs [data-v="balance"]');
    const gone = !(await page.$("#encPct"));
    await page.click('#isoTabs [data-v="encounter"]');
    await page.waitForSelector("#encPct", { timeout: 3000 });
    return gone;
  })());
  check("stock words decode to 100%", (await page.inputValue("#encPct")) === "100");
  check("100% reads as the stock rate", /stock rate/.test(await page.textContent("#encOut")));
  check("the Stock preset is marked active at 100%",
    await page.locator('[data-enc="100"]').evaluate((e) => e.classList.contains("on")));
  // preset buttons stage the same words as typing the number
  await page.click('[data-enc="25"]');
  check("Quarter preset sets the field to 25", (await page.inputValue("#encPct")) === "25");
  await page.click('[data-enc="100"]');
  check("Stock preset returns to 100 with nothing staged", await nothingStaged(page));
  // 50%: the ride path gains its own multiplier and branches into the shared MULT/100 block
  await page.fill("#encPct", "50"); await page.dispatchEvent("#encPct", "change");
  check("50% is described as fewer battles", /fewer battles/.test(await page.textContent("#encOut")));
  const r = await save(page);
  check("50%: ride mult = addiu $v0,zero,50", r.u32(ENC_SITES[0]) === 0x24020032);
  check("50%: ride branch joins the scale block", r.u32(ENC_SITES[1]) === 0x10000008);
  check("50%: run mult = addiu $v0,zero,75", r.u32(ENC_SITES[2]) === 0x2402004B);
  check("50%: walk mult = addiu $v0,zero,60", r.u32(ENC_SITES[3]) === 0x2402003C);
  await page.context().close();
}

head("Global encounter rate — 0% disables, 200% doubles");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  await page.fill("#encPct", "0"); await page.dispatchEvent("#encPct", "change");
  check("0% is described as off", /off/.test(await page.textContent("#encOut")));
  let r = await save(page);
  // every multiplier zero -> `rate <= 0` bails out of the roll before it can trigger
  check("0%: all three multipliers are zero",
    r.u32(ENC_SITES[0]) === 0x24020000 && r.u32(ENC_SITES[2]) === 0x24020000 && r.u32(ENC_SITES[3]) === 0x24020000);
  await page.context().close();
}
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  await page.fill("#encPct", "200"); await page.dispatchEvent("#encPct", "change");
  check("200% is described as more battles", /more battles/.test(await page.textContent("#encOut")));
  const r = await save(page);
  check("200%: ride 200, run 300, walk 240",
    r.u32(ENC_SITES[0]) === 0x240200C8 && r.u32(ENC_SITES[2]) === 0x2402012C && r.u32(ENC_SITES[3]) === 0x240200F0);
  await page.context().close();
}

head("Global encounter rate — 100% is a byte-exact restore, input clamps");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  await page.fill("#encPct", "25"); await page.dispatchEvent("#encPct", "change");
  check("25% stages a change", await somethingStaged(page));
  // going back to 100% must rewrite the stock words exactly, leaving nothing staged
  await page.fill("#encPct", "100"); await page.dispatchEvent("#encPct", "change");
  check("back at 100% nothing is staged", await nothingStaged(page));
  // the Restore button does the same from an arbitrary value
  await page.fill("#encPct", "300"); await page.dispatchEvent("#encPct", "change");
  await page.click("#encReset");
  check("Restore 100% clears the staged words", await nothingStaged(page));
  check("Restore 100% resets the field", (await page.inputValue("#encPct")) === "100");
  // out-of-range input clamps instead of encoding a bogus instruction immediate
  await page.fill("#encPct", "99999"); await page.dispatchEvent("#encPct", "change");
  check("out-of-range rate clamps to the max", (await page.inputValue("#encPct")) === "1000");
  await page.context().close();
}

head("Gear description overflow is rejected");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="gear"]'); await openRec(page, "details.char");
  const desc = page.locator("input.ge-desc").first();
  const max = +(await desc.getAttribute("maxlength"));
  // maxlength blocks typing past the slot, so force an over-length value + fire change
  await desc.evaluate((el, n) => { el.value = "X".repeat(n + 5); el.dispatchEvent(new Event("change", { bubbles: true })); }, max);
  await page.waitForTimeout(60);
  check("over-length description warns", await statusHas(page, /too long/i));
  check("over-length description not written", !(await getWrites(page)).length && !(await page.evaluate(() => window.__writes.length)));
  await page.context().close();
}

head("Text tab — in-ELF strings: filtered, editable, length-capped, byte-exact");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="text"]');
  await page.waitForSelector("input.txt", { timeout: 5000 });
  const T = mapping.text;
  // the scanner must offer the planted prose string and NOT the planted format string
  await page.fill("#isoSearch", "everyone survived"); await page.waitForTimeout(80);
  const row = page.locator(`input.txt[data-off="${T.off}"]`);
  check("planted prose string is offered", (await row.count()) === 1);
  check("slot cap is the on-disk length", +(await row.getAttribute("maxlength")) === T.max);
  check("current value decodes from the disc", (await row.inputValue()) === T.value);
  await page.fill("#isoSearch", "arg1"); await page.waitForTimeout(80);
  check("format string is filtered out (not editable)", (await page.locator("input.txt").count()) === 0);

  // over-length is rejected outright — the slot can't grow
  await page.fill("#isoSearch", "everyone survived"); await page.waitForTimeout(80);
  await row.evaluate((el, n) => { el.value = "X".repeat(n + 4); el.dispatchEvent(new Event("change", { bubbles: true })); }, T.max);
  await page.waitForTimeout(60);
  check("over-length text warns", await statusHas(page, /too long/i));
  check("over-length text is not staged", (await row.inputValue()) === T.value);

  // a shorter edit is written over the whole slot and NUL-padded
  const NEW = "Everyone made it home";
  await row.fill(NEW); await row.dispatchEvent("change"); await page.waitForTimeout(60);
  check("edited field highlights dirty", await row.evaluate((el) => el.classList.contains("dirty")));
  check("the change is counted as one labelled field", /1 unsaved/.test(await dirtyLabel(page, /1 unsaved/)));
  const r = await save(page);
  let got = ""; for (let i = 0; i < T.max; i++) { const c = r.at(T.off + i); if (!c) break; got += String.fromCharCode(c); }
  check("new text written byte-exact", got === NEW);
  check("tail of the slot is NUL-padded, not left over",
    r.at(T.off + NEW.length) === 0 && r.at(T.off + T.max - 1) === 0);
  check("the write never runs past the slot", !r.wrote(T.off + T.max, 1));
  await page.context().close();
}

head("Text tab — undo and per-field revert");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="text"]');
  await page.waitForSelector("input.txt", { timeout: 5000 });
  const T = mapping.text;
  // Filter by OFFSET, not by content: undo/redo re-render and re-filter, and a
  // content filter would drop the row the moment the edit changes the text.
  await page.fill("#isoSearch", T.off.toString(16)); await page.waitForTimeout(80);
  const row = () => page.locator(`input.txt[data-off="${T.off}"]`);
  check("a string can be found by its offset", (await row().count()) === 1);
  await row().fill("Short text"); await row().dispatchEvent("change"); await page.waitForTimeout(60);
  check("undo is enabled after a text edit", !(await page.locator("#isoUndoBtn").isDisabled()));
  await page.click("#isoUndoBtn"); await page.waitForTimeout(80);
  check("undo restores the original string", (await row().inputValue()) === T.value);
  await page.click("#isoRedoBtn"); await page.waitForTimeout(80);
  check("redo re-applies the edit", (await row().inputValue()) === "Short text");
  await page.locator(`input.txt[data-off="${T.off}"] ~ button.revert`).click(); await page.waitForTimeout(80);
  check("per-field revert restores the original", (await row().inputValue()) === T.value);
  check("nothing staged after revert", await nothingStaged(page));
  await page.context().close();
}

head("Recipe export → reset → import round-trip");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "321"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#isoRecipeBtn")]);
  const recipePath = path.join(TMP, "s3-test.s3mod"); await dl.saveAs(recipePath);
  const mod = JSON.parse(fs.readFileSync(recipePath, "utf8"));
  check("recipe has patches + version word", mod.patches.length > 0 && mod.versionWord === 0x40A69A01);
  await page.click("#isoResetBtn"); await page.waitForTimeout(60);
  check("reset cleared the edit", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "100");
  await importFile(page, recipePath);
  const reapplied = (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "321";
  check("import re-applies the edit", reapplied, reapplied ? "" : await page.textContent("#isoStatus"));
  // wrong-version recipe is rejected
  const badRecipe = path.join(TMP, "s3-bad.s3mod");
  fs.writeFileSync(badRecipe, JSON.stringify({ format: "s3mod", versionWord: 0xDEADBEEF, patches: [] }));
  const badStatus = await importFile(page, badRecipe);
  const rejected = /different game\/region/i.test(badStatus);
  check("wrong-region recipe rejected", rejected, rejected ? "" : `status was "${badStatus}"`);
  await page.context().close();
}

// Applying a patch is the counterpart to exporting one: the editor can now consume a mod.
// These drive the real UI with patches built by REAL xdelta3 against the real synthetic ISO,
// so they cover the whole path — magic sniffing, window walk, checksum, staging.
head("Apply an .xdelta patch (built by real xdelta3)");
if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else { const page = await newPage(); await loadIso(page);
  // a patch that edits bytes inside the editable block
  const tgt = Uint8Array.from(bytes);
  const at = SPELL.off + 0x1C;                    // spell 0 power (u32) — inside the block
  tgt.set([0xE7, 0x03, 0x00, 0x00], at);          // 999
  const patch = makeXdelta(bytes, tgt);
  check("xdelta3 produced a patch", patch && patch.length > 0);
  const applied = await uploadPatch(page, patch, "mod.xdelta");
  check("status reports a checksum-verified apply", /applied patch/i.test(applied));
  check("status says how much changed", /byte\(s\)/i.test(applied));
  check("the edit is staged, not silently written", !(await page.evaluate(() => window.__writes.length)));
  check("dirty badge reflects the staged patch", await somethingStaged(page));

  // An imported patch is an edit like any other: one undo step for the whole patch, before
  // saving (a save re-baselines ORIG, so this has to be checked while it's still staged).
  await page.click("#isoUndoBtn");
  check("undo reverts the whole applied patch in one step", await nothingStaged(page));
  await page.click("#isoRedoBtn");
  check("redo re-applies it", await somethingStaged(page));

  const r = await save(page);
  check("saving writes the patched bytes", r.u32(at) === 999);
  await page.context().close();
}

head("Apply patch — refusals");
if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else { const page = await newPage(); await loadIso(page);
  // 1. a patch that changes bytes OUTSIDE the editable block must be refused whole
  { const tgt = Uint8Array.from(bytes);
    tgt.set([1, 2, 3, 4], 0x1000);                // before ELF_BASE — can't be staged
    const s = await uploadPatch(page, makeXdelta(bytes, tgt), "outside.xdelta");
    check("patch touching bytes outside the block is refused", /outside the region/i.test(s));
    check("...and says nothing was applied", /nothing was applied/i.test(s));
    check("...and stages nothing", await nothingStaged(page));
  }
  // 2. xdelta3's DEFAULT encoding (LZMA secondary) must be refused with the fix, not mangled
  { const tgt = Uint8Array.from(bytes); tgt.set([9, 9, 9, 9], SPELL.off + 0x1C);
    const s = await uploadPatch(page, makeXdelta(bytes, tgt, true), "lzma.xdelta");
    check("LZMA-compressed patch is refused", /secondary compression|delta sections/i.test(s));
    check("...and tells the user to re-encode with -S none", /-S none/.test(s));
  }
  // 3. a patch for a different-sized image is refused before any disc I/O
  { const small = bytes.slice(0, ELF_END - 4096);
    const tgt = Uint8Array.from(small); tgt.set([1, 2, 3], 0x200000);
    const s = await uploadPatch(page, makeXdelta(small, tgt), "wrongsize.xdelta");
    check("patch for a different image size is refused", /different image/i.test(s));
  }
  // 4. a patch built against a MODIFIED source must fail the checksum rather than corrupt
  { const other = Uint8Array.from(bytes); other[SPELL.off + 0x40] ^= 0xFF;   // not our disc
    const tgt = Uint8Array.from(other); tgt.set([5, 5, 5, 5], SPELL.off + 0x1C);
    const s = await uploadPatch(page, makeXdelta(other, tgt), "othersrc.xdelta");
    check("patch built against a different disc fails its checksum", /checksum mismatch/i.test(s));
    check("...and stages nothing", await nothingStaged(page));
  }
  await page.context().close();
}

head("Apply an .s3mod recipe through the same button (format sniffed, not by name)");
{ const page = await newPage(); await loadIso(page);
  const recipe = JSON.stringify({ format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
    patches: [{ off: SPELL.off + 0x1C, new: "2a000000" }] });
  const s = await uploadPatch(page, new TextEncoder().encode(recipe), "recipe.xdelta");   // WRONG extension on purpose
  check("a recipe named .xdelta is still recognised as a recipe", /applied recipe/i.test(s));
  const r = await save(page);
  check("recipe bytes written", r.u32(SPELL.off + 0x1C) === 42);
  await page.context().close();
}

head("Enemies + Reference (read-only)");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  const nEnemies = await page.locator(".invtbl tbody tr").count();
  check("bestiary renders (Lv/HP/drops)", nEnemies >= 5 && (await page.textContent(".invtbl thead")).includes("HP"));
  await page.fill("#isoSearch", "blade bunny"); await page.waitForTimeout(80);
  const nFiltered = await page.locator(".invtbl tbody tr").count();
  check("bestiary search filters", nFiltered >= 1 && nFiltered < nEnemies);
  await page.fill("#isoSearch", "");
  await page.click('#isoTabs [data-v="ref"]');
  const nItems = await page.locator(".invtbl tbody tr").count();
  await page.click('[data-ref="skills"]'); await page.waitForTimeout(60);
  const nSkills = await page.locator(".invtbl tbody tr").count();
  check("reference items/skills toggle", nItems > 100 && nSkills > 10 && nSkills < nItems);
  await page.context().close();
}

head("Save-progress UX + backup nudge (export path)");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "200"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  const [dl] = await Promise.all([page.waitForEvent("download"), (async () => {
    await page.click("#isoSaveBtn"); await page.waitForSelector("#bnExport"); await page.click("#bnExport");   // export-and-continue
  })()]);
  check("backup nudge export produced a recipe", (await dl.suggestedFilename()).endsWith(".s3mod"));
  await page.waitForSelector("#cfOk"); await page.click("#cfOk");
  await page.waitForSelector("#pgClose:visible", { timeout: 5000 });
  check("progress modal reaches completion", /Done/i.test(await page.textContent("#pgTitle")));
  check("completion readout shows time taken", /⏱\s*[\d.]+\s*s/.test(await page.textContent("#pgMeta")));
  await page.click("#pgClose");
  check("status ok after save", await statusHas(page, /Saved/));
  check("badge cleared after save", await nothingStaged(page));
  await page.context().close();
}

head("Last opened ISO (persist handle + reopen)");
{ const page = await newPage();
  // back the picked file with a REAL OPFS handle so it's IndexedDB-serializable (the plain
  // fake handle used elsewhere can't be structured-cloned into IndexedDB)
  await page.addInitScript(`window.showOpenFilePicker = async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('synth.iso', { create: true });
    const w = await fh.createWritable(); await w.write(await (await fetch('/synth.bin')).arrayBuffer()); await w.close();
    return [fh];
  };`);
  await gotoIsoTab(page); await page.click("#isoPick"); await page.waitForSelector("#isoTabs", { timeout: 8000 });
  await page.click("#isoClose"); await page.waitForSelector("#isoRecent .recent", { timeout: 3000 });
  check("last-opened chip shows the ISO name", (await page.textContent("#isoReopen")).includes("synth.iso"));
  await page.click("#isoReopen"); await page.waitForSelector("#isoTabs", { timeout: 8000 });
  check("reopen loads the ISO editor", !!(await page.$("#isoTabs")));
  await page.click("#isoClose"); await page.waitForSelector("#isoRecent .recent");
  await page.click("#isoForget");
  await until(page, () => !document.querySelector("#isoReopen"));
  check("forget clears the last-opened chip", !(await page.$("#isoReopen")));
  await page.context().close();
}

head("Recruit section (save editor, Pyodide stubbed)");
{ const page = await newPage();
  // Stub the Python engine so the save-editor UI renders headless (real Pyodide needs a CDN
  // this sandbox can't reach). Canned saves drive the Recruit view; the recruit STAGING math
  // is the real recruit-core.js, and the diff/review is the real buildDiff/openConfirm.
  await page.addInitScript(`
    // [name, recruiter, recruited]
    const CHARS = [
      ['Hugo','Hugo',true], ['Chris','',false], ['Jeane','',false],
      ['Geddoe','Geddoe',true], ['Rico','',true], ['Lulu','',false]
    ].map((x, i) => ({ rosterIndex: i, name: x[0], recruiter: x[1], recruited: x[2],
      level: 10, curHP: 100, maxHP: 100, expToNext: 0, hasData: true,
      stats: { PWR: 1, SKL: 1, MAG: 1, REP: 1, PDF: 1, MDF: 1, SPD: 1, LUK: 1 }, equip: {}, skills: [] }));
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: {}, names: [], characters: CHARS, party: [0,0,0,0,0,0], inventory: [] }];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [], charById: {} });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; }, { timeout: 15000 });
  await page.setInputFiles("#file", { name: "save.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  await page.waitForSelector('[data-sub="recruit"]', { timeout: 5000 });
  await page.click('[data-sub="recruit"]'); await page.waitForSelector("#rteam");
  // s3_recruit_meta.json is fetched after the first render; the story shading below only
  // exists once it lands, so wait for the shading itself rather than for a fixed delay.
  await until(page, () => document.querySelectorAll("#subview tr.story-auto").length >= 3);
  check("recruit roster renders", (await page.locator("#subview .invtbl tbody tr").count()) === 6);
  // story auto-join units are faded (Hugo/Chris/Geddoe are story); Salome is an optional recruit
  check("story units get the .story-auto fade", (await page.locator("#subview tr.story-auto").count()) >= 3);
  check("optional recruit (Jeane) is not faded", !((await page.locator('#subview tr:has-text("Jeane")').first().getAttribute("class")) || "").includes("story-auto"));
  check("no bulk/canonical buttons remain", (await page.locator("#recAllShown, [data-canon]").count()) === 0);
  // per-row: recruit Jeane (index 2) with default team Chris via her checkbox
  await page.selectOption("#rteam", "Chris");
  await page.check('#subview input[data-rec="2"]'); await page.waitForTimeout(60);
  check("ticking recruit sets the default team checkbox", await page.locator('#subview input[data-tm="2"][value="Chris"]').isChecked());
  // MULTI-TEAM: also put her on Hugo's team (a unit can be on several teams at once)
  await page.check('#subview input[data-tm="2"][value="Hugo"]'); await page.waitForTimeout(60);
  check("can add a second team (Hugo + Chris)", (await page.locator('#subview input[data-tm="2"]:checked').count()) === 2);
  // review modal lists the multi-team change
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  const review = await page.textContent(".cf-list");
  check("review lists the multi-team change", /Jeane/.test(review) && /Teams:.*(Hugo.*Chris|Chris.*Hugo)/.test(review));
  await page.click("#cfCancel");
  // "All" button puts a character on every team
  await page.click('#subview button[data-tmall="2"]'); await page.waitForTimeout(60);
  check("'All' checks every team", (await page.locator('#subview input[data-tm="2"]:checked').count()) === 4);
  await page.context().close();
}

head("108 Stars dashboard (save editor, Pyodide stubbed)");
{ const page = await newPage();
  // Same stub shape as the Recruit section. Hugo/Geddoe/Rico recruited; Chris (story),
  // Jeane + Lulu are optional recruits that should land in the "missing" worklist.
  await page.addInitScript(`
    const CHARS = [
      ['Hugo','Hugo',true], ['Chris','',false], ['Jeane','',false],
      ['Geddoe','Geddoe',true], ['Rico','',true], ['Lulu','',false]
    ].map((x, i) => ({ rosterIndex: i, name: x[0], recruiter: x[1], recruited: x[2],
      level: 10, curHP: 100, maxHP: 100, expToNext: 0, hasData: true,
      stats: { PWR: 1, SKL: 1, MAG: 1, REP: 1, PDF: 1, MDF: 1, SPD: 1, LUK: 1 }, equip: {}, skills: [] }));
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: {}, names: [], characters: CHARS, party: [0,0,0,0,0,0], inventory: [] }];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [], charById: {} });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; }, { timeout: 15000 });
  await page.setInputFiles("#file", { name: "save.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  await page.waitForSelector('[data-sub="stars"]', { timeout: 5000 });
  await page.click('[data-sub="stars"]'); await page.waitForSelector(".starstbl");
  // as above: the how-to rows come from the fetched guide metadata, so wait for one to appear.
  await until(page, () => document.querySelectorAll(".starstbl tr.howrow .howto").length >= 1);
  // progress header counts recruited over the tracked set (Hugo/Geddoe/Rico = 3 recruited)
  check("stars progress shows recruited count", /\b3\b/.test(await page.textContent(".starsnum")));
  check("progress bar renders", (await page.locator(".starsbar > span").count()) === 1);
  // default filter is "missing": recruited stars should be hidden
  check("default 'missing' filter hides recruited stars", (await page.locator('.starstbl tbody tr:has-text("Hugo")').count()) === 0);
  // an optional missing star carries its guide how-to as a full-width row
  check("optional missing star shows a how-to row", (await page.locator(".starstbl tr.howrow .howto").count()) >= 1);
  // the per-row +recruit action stages a recruit and bumps the count to 4
  await page.selectOption("#rteam", "Chris").catch(() => {});
  const before = await page.textContent(".starsnum");
  await page.click(".starstbl [data-starsadd]"); await page.waitForTimeout(60);
  check("+recruit stages a recruit (count goes up)", (await page.textContent(".starsnum")) !== before && /\b4\b/.test(await page.textContent(".starsnum")));
  // the Recruited view renders team pills (multi-letter where a star is on several teams)
  await page.click('[data-starsf="recruited"]'); await page.waitForTimeout(40);
  check("recruited view shows team pills", (await page.locator(".starstbl .tpill").count()) >= 3);
  await page.context().close();
}

head("Save <-> JSON round-trip (save editor, Pyodide stubbed)");
{ const page = await newPage();
  await page.addInitScript(`
    const CHARS = [
      ['Hugo','Hugo',true], ['Chris','',false], ['Geddoe','Geddoe',true]
    ].map((x, i) => ({ rosterIndex: i, name: x[0], recruiter: x[1], recruited: x[2],
      level: 20, curHP: 100, maxHP: 100, expToNext: 0, hasData: true,
      stats: { PWR: 50, SKL: 1, MAG: 1, REP: 1, PDF: 1, MDF: 1, SPD: 1, LUK: 1 },
      equip: { headRune: 5 }, skills: [{ slot: 0, id: 6, rank: 3 }] }));
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: {}, names: [{ key: 'flameChampion', label: 'Flame Champion', value: 'Brian', max: 8 }],
      characters: CHARS, party: [1,0,0,0,0,0], inventory: [{ region: 'Party', items: [{ slot: 0, id: 5, qty: 1, category: 'consumable' }] }] }];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({ items: [{id:5,name:'Fire Rune',cat:'Runes'},{id:9,name:'Rage Rune',cat:'Runes'}], skills: [{id:6,name:'Attack'}], charById: {1:'Hugo',2:'Chris',3:'Geddoe'} });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; }, { timeout: 15000 });
  await page.setInputFiles("#file", { name: "save.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  await page.waitForSelector("#exportJson");
  // EXPORT: capture the JSON the download would contain
  const exp = await page.evaluate(() => {
    let out = null; const orig = window.downloadBytes;
    window.downloadBytes = (bytes) => { out = new TextDecoder().decode(bytes); };
    exportSaveJSON(); window.downloadBytes = orig;
    const p = JSON.parse(out);
    return { format: p._format, gold: p.gold, chars: p.characters.length,
      hugoRune: p.characters[0].equip.headRune?.id, hugoName: p.characters[0].name, exported: out };
  });
  check("export produces a suikoden3-save JSON", exp.format === "suikoden3-save");
  check("export includes gold + characters (with equip ids)", exp.gold === 1000 && exp.chars === 3 && exp.hugoRune === 5);
  // IMPORT: edit gold + Hugo level/rune, re-import -> review modal lists exactly those diffs
  await page.evaluate((raw) => {
    const p = JSON.parse(raw);
    p.gold = 999999; p.characters[0].level = 50; p.characters[0].equip.headRune = { id: 9 };
    p.names.flameChampion = "Zephon";
    return importSaveJSON(new File([JSON.stringify(p)], "edited.json", { type: "application/json" }));
  }, exp.exported);
  await page.waitForSelector(".modal .cf-list", { timeout: 3000 });
  const rows = await page.textContent(".modal .cf-list");
  check("import opens review modal with the gold change", /1000\s*→\s*999999/.test(rows));
  check("import lists the level change", /Level:\s*20\s*→\s*50/.test(rows));
  check("import lists the rune change (id->label)", /Rage Rune/.test(rows));
  check("import lists the name change", /Brian.*→.*Zephon/.test(rows));
  check("import ignores unchanged fields (no Geddoe/Chris rows)", !/Geddoe|Chris/.test(rows));
  // a non-save JSON is rejected
  await page.click("#cfCancel").catch(() => {});
  const rej = await page.evaluate(() => importSaveJSON(new File(['{"hello":1}'], "x.json")).then(() => document.querySelector("#status")?.textContent));
  check("non-save JSON is rejected with a message", /not a Suikoden III save JSON/.test(rej || ""));
  await page.context().close();
}

head("Undo/redo + skill-cap & rune presets");
{ const page = await newPage(); await loadIso(page);
  const [l4b] = TABLES.list4;
  // undo/redo stack behaviour on a weapon ATK edit
  await page.click('#isoTabs [data-v="weapons"]'); await openRec(page, "details.char");
  const l4inp = 'details.char[open] input[data-off="' + l4b + '"]';
  const orig = +(await page.inputValue(l4inp)), nv = orig === 123 ? 45 : 123;
  await page.fill(l4inp, String(nv)); await page.dispatchEvent(l4inp, "change"); await page.waitForTimeout(50);
  check("undo enabled after an edit", !(await page.locator("#isoUndoBtn").isDisabled()));
  await page.click("#isoUndoBtn"); await page.waitForTimeout(50);
  check("after undo: undo disabled + redo enabled", (await page.locator("#isoUndoBtn").isDisabled()) && !(await page.locator("#isoRedoBtn").isDisabled()));
  await page.click("#isoRedoBtn"); await page.waitForTimeout(50);
  check("after redo: undo enabled again", !(await page.locator("#isoUndoBtn").isDisabled()));
  const r = await save(page); check("redo restored the edit to disk", r.u8(l4b) === nv);
  // rune reskin presets fill the reskin fields
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForSelector("#rsPower");
  await page.click('[data-rspreset="max"]'); await page.waitForTimeout(20);
  check("rune preset 'Power 9999' fills the reskin field", (await page.locator("#rsPower").inputValue()) === "9999");
  await page.click('[data-rspreset="nostatus"]'); await page.waitForTimeout(20);
  check("rune preset 'Remove status' sets Status → none", (await page.locator("#rsStatus").inputValue()) === "none");
  // spell #1 inflicts unbalance → summary shows it, and clearing its Status zeroes flags18
  check("spell summary shows the inflicted status", (await page.textContent('details.char[data-i="1"] .sp-sum')).includes("unbalance"));
  await openRec(page, 'details.char[data-i="1"]');
  await page.selectOption('details.char[data-i="1"] select[data-k="status"]', "none");
  const rs = await save(page);
  check("clearing status zeroes flags18 (removes unbalance)", rs.u32(SPELL.off + 1 * 0x20 + 0x18) === 0);
  await page.context().close();
}
head("Skill-cap preset (Growth view)");
{ const page = await newPage(); await loadIso(page);
  const [l2b] = TABLES.list2;
  await page.click('#isoTabs [data-v="growth"]'); await openRec(page, "details.char"); await page.waitForTimeout(60);
  const l2rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  // guide-overlay notes render (skill caps / growth ranges from the reference JSONs)
  check("growth view shows guide reference notes", (await page.locator('details.char[open] .fnote:has-text("guide")').count()) > 0);
  await page.click('details.char[open] [data-cap="max"]'); await page.waitForTimeout(50);
  check("Max-all preset sets skillmax#1 select to S(7)", (await page.locator('details.char[open] select[data-off="' + (l2rec + 16) + '"]').inputValue()) === "7");
  const r = await save(page);
  check("Max-all preset wrote S(7) across the skillmax array", r.u8(l2rec + 16) === 7 && r.u8(l2rec + 58) === 7);
  await page.context().close();
}

head("Verified offset mappings (decode of planted bytes)");
{ const page = await newPage(); await loadIso(page);
  // Growth: the skill-max array starts at +16 (not +13) and the encoding is 5=B+ / 6=A;
  // HP growth is at +0 and PWR at +4. We planted these; assert the editor DECODES them.
  await page.click('#isoTabs [data-v="growth"]'); await openRec(page, `details.char[data-rec="${mapping.l2rec}"]`); await page.waitForTimeout(60);
  const sel = (off) => page.locator(`details.char[data-rec="${mapping.l2rec}"] select[data-off="${off}"]`);
  const inp = (off) => page.locator(`details.char[data-rec="${mapping.l2rec}"] input[data-off="${off}"]`);
  check("skill #1 max decodes at +16 → B+", (await sel(mapping.l2rec + 16).locator("option:checked").textContent()).trim() === mapping.skill1Max);
  check("skill #2 max decodes at +17 → A", (await sel(mapping.l2rec + 17).locator("option:checked").textContent()).trim() === mapping.skill2Max);
  check("HP growth is at +0", (await inp(mapping.l2rec + 0).inputValue()) === String(mapping.hpGrowth));
  check("PWR growth is at +4", (await inp(mapping.l2rec + 4).inputValue()) === String(mapping.pwrGrowth));
  // Characters: rune slots are Head@+64 / Right@+72 / Left@+80.
  await page.click('#isoTabs [data-v="chars"]'); await openRec(page, `details.char[data-rec="${mapping.l1rec}"]`); await page.waitForTimeout(60);
  const btn = (off) => page.locator(`details.char[data-rec="${mapping.l1rec}"] button.picker[data-off="${off}"]`);
  check("rune Head decodes at +64", (await btn(mapping.l1rec + 64).textContent()).includes(mapping.head.name));
  check("rune Right decodes at +72", (await btn(mapping.l1rec + 72).textContent()).includes(mapping.right.name));
  check("rune Left decodes at +80", (await btn(mapping.l1rec + 80).textContent()).includes(mapping.left.name));
  await page.context().close();
}

head("Close returns to loader");
{ const page = await newPage(); await loadIso(page);
  await page.click("#isoClose"); await page.waitForTimeout(80);
  check("Close shows loader again", !!(await page.$("#isoPick")) && !(await page.$("#isoTabs")));
  await page.context().close();
}

head("Save editor tab still boots (structural)");
{ const page = await newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  check("save loader present", !!(await page.$("#drop")));
  check("both mode tabs", (await page.locator(".mtab").count()) === 2);
  await page.click('.mtab[data-mode="iso"]'); await page.waitForTimeout(80);
  check("iso section shows", await page.locator("#mode-iso").evaluate((e) => !e.classList.contains("hidden")));
  await page.click('.mtab[data-mode="save"]'); await page.waitForTimeout(60);
  check("save section shows again", await page.locator("#mode-save").evaluate((e) => !e.classList.contains("hidden")));
  await page.context().close();
}

// Guide overlays in the save editor. guide-core.mjs proves the *join*; this proves the notes
// actually reach the DOM. Pyodide is aborted here, so we hand drawSlot() a synthetic decoded
// save (the same shape s3save.decode_save returns) and drive the real render path.
head("Save editor — guide overlays on character cards");
{ const page = await newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const built = await page.evaluate(async () => {
    const mk = (rosterIndex, name) => ({
      rosterIndex, name, addr: 0, id: 0, level: 30, curHP: 200, maxHP: 200, expToNext: 500,
      stats: { PWR: 100, SKL: 100, MAG: 100, REP: 100, PDF: 100, MDF: 100, SPD: 100, LUK: 100 },
      equip: { headRune: 0, rightRune: 0, leftRune: 0, helm: 0, armor: 0, shield: 0, boots: 0, gloves: 0, accessory: 0 },
      skills: [{ slot: 0, id: 10, rank: 4 }, { slot: 1, id: 40, rank: 0 }],
      recruited: true, recruitWord: 1, recruiter: "", recruiters: [], hasData: true,
    });
    REF = { items: [], skills: [], charById: {} };
    OPT_RANK = RANK_TIERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    saves = [{
      label: "slot", folder: "BASLUS-20387", checksumWord: 0, meta: {}, names: [], inventory: [],
      global: { gold: 100, storyPhase: 1, partyLeader: 0, playtime: "1:00" },
      characters: [mk(0, "Hugo"), mk(15, "Ace"), mk(76, "Apple")],
    }];
    curSlot = 0;
    renderEditor();
    RECRUIT_META = {};                     // skip the recruit-meta fetch/redraw
    await loadGuideRefs();                 // resolve before we read the DOM
    drawChars();
    const card = (nm) => [...document.querySelectorAll("details.char")].find((d) => d.querySelector(".nm").textContent === nm);
    const notes = (nm) => card(nm) ? [...card(nm).querySelectorAll(".fnote")].map((n) => n.textContent.trim()).filter(Boolean) : null;
    return { hugo: notes("Hugo"), ace: notes("Ace"), apple: notes("Apple"),
             guideLoaded: !!(GUIDE && Object.keys(GUIDE.caps).length) };
  });
  check("guide files fetched", built.guideLoaded);
  const has = (arr, re) => !!arr && arr.some((t) => re.test(t));
  check("stat field shows the guide's Lv-99 growth range", has(built.hugo, /rate 04 · Lv99 ≈ 90-188/));
  check("Max HP shows the HP growth row", has(built.hugo, /Lv99 ≈ 470-626/));
  check("Level shows the guide's join level", has(built.hugo, /joins at Lv 12/));
  check("rune slot shows its unlock level", has(built.hugo, /slot opens at Lv 35/));
  check("rune slot shows an innate rune", has(built.hugo, /starts with Wind/));
  check("skill slot shows the per-character cap", has(built.hugo, /guide max: S/));
  check("a skill the character can't learn is called out", has(built.hugo, /can't learn/));
  check("a different character gets different notes (not a constant)",
    has(built.ace, /starts with Double Tusk/) && has(built.ace, /slot opens at Lv 32/) && !has(built.ace, /joins at Lv 12/));
  check("a support character the guide doesn't cover shows no notes",
    Array.isArray(built.apple) && built.apple.length === 0);
  await page.context().close();
}

for (const [w, h] of [[360, 640], [320, 480]]) {
  head(`Mobile ${w}px — no horizontal overflow`);
  const page = await newPage({ width: w, height: h });
  await loadIso(page);
  let over = null;
  for (const v of ["chars", "growth", "support", "weapons", "shops", "spells", "unites", "gear", "sets", "food", "balance", "enemies", "ref"]) {
    await page.click(`#isoTabs [data-v="${v}"]`); await page.waitForTimeout(50);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) over = v;
  }
  check(`no overflow at ${w}px`, over === null, over ? "overflow in " + over : "");
  await page.context().close();
}

await browser.close();
srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\nFAILED (${fails})` : "\nAll e2e checks passed.");
process.exit(fails ? 1 : 0);
