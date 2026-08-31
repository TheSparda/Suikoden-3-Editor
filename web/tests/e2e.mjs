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
import { buildSynthIso, ELF_BASE, ELF_END, ELF_VADDR, SPELL, UNITE, FOOD, ENEMY, GEAR, TABLES, SHOPS, shopRec, PRICE_LADDER, VERSION_OFF, VERSION_VAL, SETS, ENC_SITES, ENC_STOCK,
  MOUNT_PAIRS, mountWord, HORSE_STOCK, horseAddr, MECH,
  ENEMY_TEST_PACKS, ENEMY_REC_A, ENEMY_AUX_A, ENEMY_REC_B, ENEMY_AUX_B,
  ZONE_SLOTS_A, ZONE_PARTY_A, ZONE_MEM_A, ZONE_SLOTS_B, ZONE_PARTY_B, ZONE_MEM_B,
  WAR_TEST_UNITS, WAR_REC_A, WAR_REC_B,
  ROOM_TEST_INDEX, ROOM_TABLE_A, ROOM_TABLE_B, SUBFILE_TEST_INDEX, SPLIT, SPLIT_STOCK,
  AVATAR_SITES, avatarWord, STORY_CASES, ENCMOVE_SITES, encMoveWord } from "./synth-iso.mjs";

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
// The full-screen boot gate covers the mode tabs until Pyodide is up, and these tests abort
// the Pyodide CDN on purpose — so take the gate down first. That button exists for real users
// too: the ISO editor needs no Python. web/tests/boot-gate.mjs is what tests the gate itself.
async function dismissBoot(page) {
  const b = await page.$("#bootHide");
  if (b) await b.click().catch(() => {});   // may have self-closed already (stubbed engine)
}
async function gotoIsoTab(page) { await page.goto(base, { waitUntil: "domcontentloaded" }); await dismissBoot(page); await page.click('.mtab[data-mode="iso"]'); }
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
// Same, for the Spells tab's collapsible tool cards (they ship collapsed).
async function openFold(page, sel) {
  await page.waitForSelector(sel);
  const loc = page.locator(sel);
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

// save(), but also hands back the text of the review dialog it confirmed — for the cases
// where what the review SAYS is part of the contract, not just the bytes it writes.
async function saveAndReview(page) {
  await page.evaluate(() => { window.__writes = []; });
  await page.click("#isoSaveBtn");
  try { await page.waitForSelector("#bnSkip", { timeout: 700 }); await page.click("#bnSkip"); } catch { /* already nudged */ }
  await page.waitForSelector("#cfOk", { timeout: 3000 });
  const review = await page.textContent(".cf-list");
  await page.click("#cfOk");
  await page.waitForSelector("#pgClose:visible", { timeout: 5000 });
  await page.click("#pgClose");
  return { r: reader(await getWrites(page)), review };
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
  // Shops: a stock slot (picker), a rarity chance (number) and a price-ladder step (number)
  await page.click('#isoTabs [data-v="shops"]');
  await page.click("button.shopitem >> nth=0"); await page.waitForSelector(".picker-search"); await page.fill(".picker-search", String(armor.id)); await page.click(".picker-row >> nth=0");
  await page.fill('input.shopchance >> nth=0', "77"); await page.dispatchEvent('input.shopchance >> nth=0', "change");
  await page.fill('input.shopqty >> nth=0', "5"); await page.dispatchEvent('input.shopqty >> nth=0', "change");
  await page.click(".shop-extra > summary");        // the shared tables fold away by default
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
  // flags18 is a bit SET, so the control is a checkbox group, not a one-of. Tick sleep (bit 10)
  // AND poison (bit 1) to prove a composite mask is authored rather than flattened to one bit.
  await page.check('details.char[data-i="0"] input.sp18[data-b="10"]');
  await page.check('details.char[data-i="0"] input.sp18[data-b="1"]');
  // radius + status chance (tail fields, stored one record ahead for spells)
  await page.fill('details.char[data-i="0"] input[data-k="radius"]', "3"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="radius"]', "change");
  await page.fill('details.char[data-i="0"] input[data-k="chance"]', "75"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="chance"]', "change");
  // ally-pair targeting (0x41, the Kindness Drops / Vengeful Child byte) on a second spell
  await openRec(page, 'details.char[data-i="1"]');
  await page.selectOption('details.char[data-i="1"] select[data-k="target"]', "65");
  // Unites: power/cast/target/aoe
  await page.click('#isoTabs [data-v="unites"]'); await openRec(page, 'details.char[data-i="0"]');
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "555"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change");
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1");
  await page.fill('details.char[data-i="0"] input[data-k="radius"]', "2"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="radius"]', "change");
  await page.fill('details.char[data-i="0"] input[data-k="chance"]', "40"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="chance"]', "change");
  const uniteSum = await page.textContent('details.char[data-i="0"] .un-sum');
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
  check("shop stock slot 1 = armor id", r.u16(shopRec(SHOPS.kinds.item, 0, 0)) === armor.id);
  check("shop rarity chance = 77", r.u8(shopRec(SHOPS.kinds.item, 0, 0) + SHOPS.rarOff + 0x0A) === 77);
  check("shop rarity quantity = 5", r.u8(shopRec(SHOPS.kinds.item, 0, 0) + SHOPS.rarOff + 0x0B) === 5);
  check("price ladder step 0 = 12345", r.u32(PRICE_LADDER[0]) === 12345);
  check("support skill1 = 0x0A", r.u8(l3rec) === 0x0A);
  check("growth PWR rate = 9", r.u8(l2rec + 4) === 9);
  check("skillmax#1 = 3 (D)", r.u8(l2rec + 16) === 3);
  check("spell0 power = 1234", r.u32(SPELL.off + 0x1C) === 1234);
  check("spell0 cast = 40", r.u32(SPELL.off + 0x10) === 40);
  check("spell0 element = Lightning(5)", (r.u16(SPELL.off + SPELL.elem) & 0xFF) === 5);
  // AOE is the top bit of the target byte, so target=all-foes(0x02) + AOE => high byte 0x82
  { const f14 = r.u32(SPELL.off + 0x14); check("spell0 target=all-foes + AOE bit", ((f14 >> 8) & 0x0F) === 0x02 && !!(f14 & 0x8000)); }
  { const f14 = r.u32(SPELL.off + SPELL.stride + 0x14); check("spell1 target=ally-pair (0x41)", ((f14 >> 8) & 0x7F) === 0x41 && !(f14 & 0x8000)); }
  check("spell0 status = sleep(bit10)|poison(bit1) — composite mask preserved",
    r.u32(SPELL.off + 0x18) === ((1 << 10) | (1 << 1)));
  // tail fields land one record ahead for spells — a wrong phase would write spell0's own record
  check("spell0 radius = 3 (one record ahead)", r.u8(SPELL.off + SPELL.radius) === 3);
  check("spell0 chance = 75%", r.u16(SPELL.off + SPELL.chance) === 75);
  check("spell0's own record 0x00..0x07 untouched", r.u32(SPELL.off) === 0 && r.u32(SPELL.off + 4) === 0);
  check("unite0 power = 555", r.u32(UNITE.off + 0x1C) === 555);
  check("unite0 AOE bit set", !!(r.u32(UNITE.off + 0x14) & 0x8000));
  check("unite0 radius = 2 (in-record tail)", r.u8(UNITE.off + UNITE.radius) === 2);
  check("unite0 chance = 40%", r.u16(UNITE.off + UNITE.chance) === 40);
  check("unite summary shows the radius", /r2/.test(uniteSum), uniteSum);
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

head("Rune + gear descriptions in the pickers (live, not from the bundled JSON)");
{ const page = await newPage(); await loadIso(page);
  // A rune's description is read straight out of the rune item table. Passive support runes
  // (Balance, Fury, ...) have no spell-table entry at all, so this table is their only source —
  // they used to render with no description line anywhere in the editor.
  await page.click('#isoTabs [data-v="chars"]');
  await page.fill("#isoSearch", "1"); await page.waitForTimeout(60);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  const rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  const rowDesc = async (id) => page.evaluate((wanted) => {
    const row = [...document.querySelectorAll(".picker-row")].find((b) => +b.dataset.id === wanted);
    return row ? (row.querySelector(".pr-desc") || {}).textContent || "" : null;
  }, id);
  await page.click(`details.char[open] button.picker[data-off="${rec + 64}"]`);   // Head Rune slot
  await page.waitForSelector(".picker-search");
  await page.fill(".picker-search", mapping.balance.name); await page.waitForTimeout(60);
  check("support rune shows its description (Balance)", (await rowDesc(mapping.balance.id)) === "Maintains balance.");
  await page.fill(".picker-search", mapping.runes[0].name); await page.waitForTimeout(60);
  check("magic rune shows its own text plus the spells it grants",
    /^Rune slot 0 text\. — Grants Flaming Arrows/.test((await rowDesc(mapping.runes[0].id)) || ""));
  await page.keyboard.press("Escape"); await page.waitForTimeout(60);

  // ...and an edited description shows up in the picker without reloading the ISO. Rewrite the
  // armor's description on the Gear tab, then read it back out of the all-items picker.
  await page.click('#isoTabs [data-v="gear"]'); await openRec(page, "details.char"); await page.waitForTimeout(60);
  await page.fill("input.ge-desc", "DEF(+99)"); await page.dispatchEvent("input.ge-desc", "change"); await page.waitForTimeout(60);
  await page.click('#isoTabs [data-v="chars"]');
  await page.fill("#isoSearch", "1"); await page.waitForTimeout(60);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  await page.click(`details.char[open] button.picker[data-off="${rec + 112}"]`);   // all-items slot
  await page.waitForSelector(".picker-search");
  await page.fill(".picker-search", String(armor.id)); await page.waitForTimeout(60);
  check("a description edited on the Gear tab is what the picker shows", (await rowDesc(armor.id)) === "DEF(+99)");
  await page.keyboard.press("Escape");
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

head("Mounts view — rewrite the battle rider/mount pairs");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="mounts"]');
  await page.waitForSelector("#mountCards details.char", { timeout: 3000 });
  check("all 3 pair cards render", (await page.$$("#mountCards details.char")).length === 3);
  // the tab must state what has actually been played, and mark every combination it can't vouch for
  { const txt = await page.textContent("#isoView");
    check("it names both confirmed re-pairings", /Hugo \+ Bright/.test(txt) && /Chris \+ Bright/.test(txt));
    check("it names the one direction left unplayed", /flyer-rigged rider \(Hugo, Futch\) on Ruby/.test(txt));
    check("it warns the menu won't show the pairing", /menu won't tell you it worked/i.test(txt));
    check("the legend lists every confidence tier",
      ["confirmed", "expected", "untested", "rough", "won't animate"].every((t) => txt.includes(t))); }
  // per-combination markers: stock + Hugo/Bright are confirmed, a horse-rigged rider on a flyer is not
  { const cell = async (rider, mount) => {
      const rows = await page.$$("table.mcftbl tbody tr");
      for (const tr of rows) {
        const tds = await tr.$$("td");
        if ((await tds[0].textContent()).trim().startsWith(rider)) return (await tds[mount].textContent()).trim();
      }
      return null; };
    check("Hugo + Fubar is confirmed", /confirmed/.test(await cell("Hugo", 1)));
    check("Hugo + Bright is confirmed", /confirmed/.test(await cell("Hugo", 2)));
    check("Chris + Bright is confirmed (horse rig on a flyer, played)", /confirmed/.test(await cell("Chris", 2)));
    check("Chris + Ruby is expected (horse rig, horse mount)", /expected/.test(await cell("Chris", 3)));
    check("Chris + Fubar is expected (horse→flyer now has a precedent)", /expected/.test(await cell("Chris", 1)));
    check("Borus + Bright inherits it (same zkum/s2um rig class)", /expected/.test(await cell("Borus", 2)));
    check("Futch + Fubar is expected (flyer rig, flyer mount)", /expected/.test(await cell("Futch", 1)));
    // flyer→horse is the one direction with no played precedent, and must stay marked as such
    check("Futch + Ruby is untested (flyer rig, horse mount)", /untested/.test(await cell("Futch", 3)));
    check("Hugo + Ruby is untested (flyer rig, horse mount)", /untested/.test(await cell("Hugo", 3)));
    check("Sharon reads rough on every mount",
      /rough/.test(await cell("Sharon", 1)) && /rough/.test(await cell("Sharon", 3))); }
  // stock decode: Hugo(1)+Fubar(8), Futch(31)+Bright(32), Franz(41)+Ruby(42)
  check("pair 1 rider decodes to Hugo", (await page.inputValue('select.mnt-rider[data-i="0"]')) === "1");
  check("pair 1 mount decodes to Fubar", (await page.inputValue('select.mnt-mount[data-i="0"]')) === "8");
  check("pair 2 rider decodes to Futch", (await page.inputValue('select.mnt-rider[data-i="1"]')) === "31");
  check("pair 3 mount decodes to Ruby", (await page.inputValue('select.mnt-mount[data-i="2"]')) === "42");
  // Geddoe is not offered by default — his model has no 3xx mounted animation bank
  check("Geddoe is not a rider option by default", (await page.textContent("#mountCards")).includes("Geddoe") === false);
  // ...but the opt-in reveals him, marked won't-animate: that is the issue #14 negative control
  await page.check("#mntAll");
  await page.waitForSelector("#mountCards details.char", { timeout: 3000 });
  { const opts = await page.$$eval('select.mnt-rider[data-i="0"] option', (o) => o.map((x) => x.textContent.trim()));
    const ged = opts.find((t) => t.startsWith("Geddoe"));
    check("the opt-in offers Geddoe", !!ged);
    check("...marked as having no mounted-battle bank", /no mounted-battle bank/.test(ged || ""));
    check("Geddoe's row reads won't animate", /won.t animate/.test(await page.textContent("table.mcftbl"))); }
  await page.uncheck("#mntAll");
  await page.waitForSelector("#mountCards details.char", { timeout: 3000 });
  // repair: Chris rides Bright, and give Hugo a second mount via pair 3
  await page.selectOption('select.mnt-rider[data-i="0"]', "2");     // Chris
  await page.selectOption('select.mnt-mount[data-i="0"]', "32");    // Bright
  await page.selectOption('select.mnt-rider[data-i="2"]', "1");     // Hugo
  await page.selectOption('select.mnt-mount[data-i="2"]', "42");    // Ruby (unchanged)
  const r = await save(page);
  check("pair 1 rider = addiu 2 (Chris)", r.u32(MOUNT_PAIRS[0].riderSites[0]) === mountWord(2));
  check("pair 1 mount = addiu 32 (Bright)", r.u32(MOUNT_PAIRS[0].mountSite) === mountWord(32));
  // the delay-slot duplicate is the whole point: BOTH rider sites must move together
  check("pair 3 rider site A = addiu 1 (Hugo)", r.u32(MOUNT_PAIRS[2].riderSites[0]) === mountWord(1));
  check("pair 3 rider delay-slot copy also = addiu 1", r.u32(MOUNT_PAIRS[2].riderSites[1]) === mountWord(1));
  check("untouched pair 2 keeps both rider sites at 31",
    r.u32(MOUNT_PAIRS[1].riderSites[0]) === mountWord(31) && r.u32(MOUNT_PAIRS[1].riderSites[1]) === mountWord(31));
  await page.context().close();
}

head("Mounted-pair mechanics — HP pooling and the Adrenaline pair-sum");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="mounts"]');
  await page.waitForSelector("select.mnt-mech", { timeout: 3000 });
  const mech = (off) => `select.mnt-mech[data-off="${off}"]`;
  const round = (off) => `input.mnt-round[data-off="${off}"]`;
  check("HP pooling decodes to stock", (await page.inputValue(mech(MECH.pool.off))) === String(MECH.pool.stock));
  check("Adrenaline pair-sum decodes to stock", (await page.inputValue(mech(MECH.adren.off))) === String(MECH.adren.stock));
  check("rider rounding decodes to 1", (await page.inputValue(round(MECH.roundRider.off))) === "1");
  // the tab must say the weighting itself lives in the Growth tab, since it isn't a constant
  check("it points at Growth for the weighting", /Growth/.test(await page.textContent("#isoView")));
  await page.selectOption(mech(MECH.pool.off), String(MECH.pool.alt));
  await page.selectOption(mech(MECH.adren.off), String(MECH.adren.alt));
  await page.fill(round(MECH.roundRider.off), "0"); await page.dispatchEvent(round(MECH.roundRider.off), "change");
  const r = await save(page);
  check("pooling gate became an unconditional branch", (r.u32(MECH.pool.off) >>> 0) === MECH.pool.alt);
  check("...and kept its branch offset", (r.u32(MECH.pool.off) & 0xFFFF) === (MECH.pool.stock & 0xFFFF));
  check("Adrenaline pair-sum became a nop", (r.u32(MECH.adren.off) >>> 0) === 0);
  check("rider rounding is now 0", (r.u32(MECH.roundRider.off) & 0xFFFF) === 0);
  check("...with the opcode half untouched",
    (r.u32(MECH.roundRider.off) >>> 0 & 0xFFFF0000) === (MECH.roundRider.stock & 0xFFFF0000));
  check("untouched mount rounding still 1", (r.u32(MECH.roundMount.off) & 0xFFFF) === 1);
  await page.context().close();
}

head("Field character — the whitelist that decides who you can walk around as");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="avatar"]');
  await page.waitForSelector("#avWide", { timeout: 3000 });
  // The readout is the only feedback there is that a patch took, so it is the thing under
  // test: it re-runs the game's chain over the bytes on screen. Stock must be the eight the
  // retail engine ships, by id — names come from list1, which the fixture does not populate.
  const chips = async () => (await page.$$eval("#isoView .tag", (els) =>
    els.map((e) => (e.textContent.match(/#(\d+)/) || [])[1]).filter(Boolean).map(Number)));
  check("stock reads back as the eight shipped avatars",
    JSON.stringify(await chips()) === JSON.stringify([1, 2, 3, 29, 54, 63, 202, 203]),
    JSON.stringify(await chips()));
  check("the low-branch bound decodes to 4", (await page.inputValue('input.av-gate[data-i="1"]')) === "4");
  check("slot 1 decodes to Koroku (54)", (await page.inputValue('select.av-slot[data-i="0"]')) === "54");
  check("slot 3 decodes to Thomas (29)", (await page.inputValue('select.av-slot[data-i="2"]')) === "29");
  // The tab has to say the two things that are true and unwelcome, or it oversells the patch.
  { const txt = await page.textContent("#isoView");
    check("it warns everyone beyond the stock eight is untested", /untested/i.test(txt));
    check("it warns story scripts rewrite the leader byte", /chapter transitions/i.test(txt));
    check("it points at the save editor for the actual pick", /Save Editor/.test(txt)); }

  // Swapping one id: Luc's slot re-pointed at Sarah (66), the one character asked for that
  // the retail chain has no room for.
  await page.selectOption('select.av-slot[data-i="1"]', "66");
  await page.waitForSelector("#avWide", { timeout: 3000 });
  check("Sarah joins the loadable set", (await chips()).includes(66));
  check("...and Luc leaves it", !(await chips()).includes(63));
  { const r = await save(page);
    check("only the Luc slot's immediate moved", r.u32(0x1FED78) === avatarWord(66, "eq"));
    check("...with the opcode half untouched", (r.u32(0x1FED78) >>> 16) === (avatarWord(0x3F, "eq") >>> 16));
    check("the other four sites are still stock",
      [0, 1, 3, 4].every((i) => r.u32(AVATAR_SITES[i][0]) === avatarWord(AVATAR_SITES[i][1], AVATAR_SITES[i][2]))); }

  // The one-button widening: both bounds to 0x53, which is what admits all 75 battle ids.
  await page.click("#avStock");
  await page.waitForSelector("#avWide", { timeout: 3000 });
  await page.click("#avWide");
  await page.waitForSelector("#avWide", { timeout: 3000 });
  { const c = await chips();
    check("widening admits every battle character", c.includes(66) && c.includes(82) && c.includes(1));
    check("...and keeps the two specials", c.includes(202) && c.includes(203));
    check("...and never admits id 0", !c.includes(0)); }
  { const r = await save(page);
    check("both range bounds became sltiu 0x53",
      r.u32(0x1FED70) === avatarWord(0x53, "lt") && r.u32(0x1FED80) === avatarWord(0x53, "lt"));
    check("the read-only second-half bounds were left alone",
      r.u32(0x1FEDA0) === avatarWord(0x3F, "lt") && r.u32(0x1FEDAC) === avatarWord(0xCC, "lt")
      && r.u32(0x1FEDB4) === avatarWord(0xCA, "lt")); }
  await page.context().close();
}

head("Field character — per-map coverage and the story-content switch");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="avatar"]');
  await page.waitForSelector("#avWide", { timeout: 3000 });
  // Coverage rides on the chip, because "is this character even in the map I am on" is the
  // second thing that decides whether a pick works and the user cannot check it themselves.
  { const txt = await page.textContent("#isoView");
    check("chips report how many maps ship each model", /\d+\/28 maps/.test(txt), (txt.match(/\d+\/28 maps/) || [])[0]);
    check("Thomas's chip shows his small coverage", /5\/28 maps/.test(txt)); }

  // The story-content control: retiring a case must move that character to Hugo's index.
  const storyRow = async (id) => {
    const rows = await page.$$("#isoView table.invtbl tbody tr");
    for (const tr of rows) {
      const tds = await tr.$$("td");
      if ((await tds[0].textContent()).includes("#" + id)) return { tr, tds };
    }
    return null; };
  { const r = await storyRow(63);
    check("Luc has a story-content row", !!r);
    check("...defaulting to his own content", (await r.tds[1].$eval("select", (e) => e.value)) === "own");
    check("...showing his own team index 4", (await r.tds[2].textContent()).trim() === "4"); }
  await page.selectOption('#isoView select.av-story >> nth=3', "hugo");   // Luc's row
  await page.waitForSelector("#avWide", { timeout: 3000 });
  { const r = await storyRow(63);
    check("switching Luc to Hugo's content reports index 0", /0 \(Hugo\)/.test(await r.tds[2].textContent()));
    const other = await storyRow(54);
    check("...and leaves Koroku on his own index 7", (await other.tds[2].textContent()).trim() === "7"); }
  { const r = await save(page);
    check("Luc's case immediate was retired", (r.u32(0x1C7724) & 0xFFFF) === 0x7FFF);
    check("...with the opcode half untouched", (r.u32(0x1C7724) >>> 16) === 0x2402);
    check("every other story case is untouched",
      STORY_CASES.filter(([o]) => o !== 0x1C7724).every(([o, imm]) => r.u32(o) === avatarWord(imm, "eq"))); }

  // Restore-stock has to cover the story cases too, or the button half-reverts.
  await page.click("#avStock");
  await page.waitForSelector("#avWide", { timeout: 3000 });
  { const r = await save(page);
    check("Restore stock returns every story case",
      STORY_CASES.every(([o, imm]) => r.u32(o) === avatarWord(imm, "eq"))); }
  await page.context().close();
}

head("Encounter movement rules — what counts as moving");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encWalk", { timeout: 3000 });
  const lenOf = (r, off) => r.u32(off) & 0xFFFF;
  const WALK_LEN = [0x13B06C, 0x13B078, 0x13B090], RUN_LEN = [0x13B0B4, 0x13B0D8];
  check("both movement toggles start on",
    (await page.isChecked("#encWalk")) && (await page.isChecked("#encRun")));
  check("the readout lists what currently rolls", /Encounters currently roll while/.test(await page.textContent("#encMove")));
  check("the second run range decodes as the stock mounted pair",
    (await page.inputValue("#encRunAlt")) === "stock");

  // The QoL setting: walk in peace, run to fight. Every walk range must go to zero, or the
  // test still fires on one of them and the setting silently does nothing.
  await page.uncheck("#encWalk");
  await page.waitForSelector("#encWalk", { timeout: 3000 });
  check("turning walking off empties the readout of walk bands",
    !/walk slots/.test(await page.textContent("#encMove")));
  { const r = await save(page);
    check("all three walk ranges are zeroed", WALK_LEN.every((o) => lenOf(r, o) === 0));
    check("...and the run ranges are untouched",
      lenOf(r, RUN_LEN[0]) === 6 && lenOf(r, RUN_LEN[1]) === 3);
    check("...with every opcode half intact",
      WALK_LEN.every((o) => (r.u32(o) >>> 16) === (o === 0x13B090 ? 0x2C63 : 0x2C42))); }

  // Koroku's fix: point the run test's second range at the animal run cycle.
  await page.check("#encWalk");
  await page.waitForSelector("#encRunAlt", { timeout: 3000 });
  await page.selectOption("#encRunAlt", "animal");
  await page.waitForSelector("#encRunAlt", { timeout: 3000 });
  check("the note names the trade it makes", /mounted fast-move/.test(await page.textContent("#encMove")));
  { const r = await save(page);
    check("the second run range base became -0x11A", (r.u32(0x13B0BC) & 0xFFFF) === ((-0x11A) & 0xFFFF));
    check("...its length became 6 (slots 0x11A-0x11F)", lenOf(r, 0x13B0C0) === 6);
    check("...the opcode halves survived",
      (r.u32(0x13B0BC) >>> 16) === 0x24A2 && (r.u32(0x13B0C0) >>> 16) === 0x2C42);
    check("walking was restored", WALK_LEN.every((o, i) => lenOf(r, o) === [0x0C, 0x03, 0x0C][i]));
    check("the first run range is untouched", lenOf(r, 0x13B0B4) === 6); }

  // Turning running off has to take the second range with it, or it keeps firing.
  await page.uncheck("#encRun");
  await page.waitForSelector("#encRun", { timeout: 3000 });
  { const r = await save(page);
    check("turning running off zeroes both run ranges and the second one",
      RUN_LEN.every((o) => lenOf(r, o) === 0) && lenOf(r, 0x13B0C0) === 0); }
  await page.context().close();
}

head("Reference — Mounts browser, read-only");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.click('[data-ref="mountref"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  const txt = await page.textContent("#isoView");
  check("Geddoe is listed as field-yes / battle-no", /Geddoe[\s\S]{0,160}970/.test(txt));
  // the 311 / 321-322 split: which mount system authored the rider's mounted-battle clips
  check("riders carry their bank family", /311 family/.test(txt) && /321\/322 family/.test(txt));
  check("it says the split isn't flyer-vs-horse", /not flyer-vs-horse/.test(txt));
  check("Roland's 341 anomaly is recorded", /341/.test(txt));
  check("the passive horses are described", /b_N_damage/.test(txt));
  check("it lists what can't be exposed", /can't be exposed as fields/.test(txt));
  // +0x1bc: the reason an assigned horse can't be forced into an arbitrary battle
  check("it types the scene's assigned mount as a pointer", /live EOBJ address, not an id/.test(txt));
  check("it says RideOn has two callers", /RideOn has exactly two callers/.test(txt));
  check("it states residency isn't proof", /asset\s*\n?\s*residency/.test(txt.replace(/\s+/g, " ")) || /residency/.test(txt));
  { const flat = txt.replace(/\s+/g, "");
    check("it scopes what is emulator-confirmed", /confirmedinanemulator/.test(flat)
      && /Hugo\+BrightandChris\+Bright/.test(flat)); }
  check("the browser stages nothing", (await page.$$("#isoView input, #isoView select")).length === 0);
  await page.context().close();
}

head("Assigned horse — the per-character list2 field, field + battle");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="mounts"]');
  await page.waitForSelector("select.mnt-horse", { timeout: 3000 });
  const sel = (roster) => `select.mnt-horse[data-off="${horseAddr(roster)}"]`;
  // stock decode: Chris on her own horse, Borus on the knight horse, Hugo on nothing
  check("Chris decodes to her own horse (309)", (await page.inputValue(sel(2))) === "309");
  check("Borus decodes to the Zexen-knight horse (308)", (await page.inputValue(sel(20))) === "308");
  check("Hugo decodes to none", (await page.inputValue(sel(1))) === "0");
  // Geddoe must be offered HERE even though the pair table above excludes him — he has the
  // field bank but no battle one, which is exactly the distinction this section exists to make
  check("Geddoe is offered an assigned horse", (await page.$(sel(3))) !== null);
  check("Geddoe is labelled field-only", /Geddoe[\s\S]{0,80}field/.test(await page.textContent("#isoView")));
  // the card must not imply that setting this alone puts someone on a horse in battle
  { const txt = await page.textContent("#isoView");
    check("it says the flag grants permission, not a horse", /does not by itself put\s+anyone on a horse/.test(txt.replace(/\s+/g, " ")));
    check("it points at Ruby to actually force one", /use <?b?>?Ruby<?\/?b?>?/.test(txt) || /Ruby/.test(txt));
    check("it explains why Chris rides in some battles only", /some battles\s+and\s+not others/.test(txt.replace(/\s+/g, " "))); }
  // only 308/309 are honoured by the game, so only those may be offered
  const optVals = await page.$$eval(sel(1), (els) => Array.from(els[0].options).map((o) => o.value));
  check("only none/308/309 are offered", JSON.stringify(optVals) === JSON.stringify(["0", "308", "309"]),
    optVals.join(","));
  await page.selectOption(sel(1), "308");     // give Hugo a knight horse
  await page.selectOption(sel(2), "0");       // take Chris's away
  const r = await save(page);
  check("Hugo's record now names the knight horse", r.u16(horseAddr(1)) === 308);
  check("Chris's record is cleared", r.u16(horseAddr(2)) === 0);
  check("untouched Borus still 308", r.u16(horseAddr(20)) === HORSE_STOCK[20]);
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

// The enemy / war / room tables are ~45 ranged reads scattered over 3.6 GB of disc. Reading
// them while opening the ISO is what made "Reading enemy data…" take tens of seconds on a
// phone, where each Blob.slice() through a content:// / Files provider is an IPC round trip.
// They now load on first use of the three views that need them. These sections pin down both
// halves of that: that opening reads nothing, and that everything which resolves an
// out-of-block offset still works — including the paths with no view to trigger the load.
const SLICE_SPY = `window.__slices = [];
  const _slice = Blob.prototype.slice;
  Blob.prototype.slice = function (a, b) { window.__slices.push((b || 0) - (a || 0)); return _slice.apply(this, arguments); };`;
// Every ranged read except the one ~3.75 MB read of the ELF block itself.
const sliceCount = (page) => page.evaluate("window.__slices.filter((n) => n > 0 && n < 0x100000).length");
const withTables = async (page) => {
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await page.addInitScript(`window.S3_TEST_WAR_UNITS = ${JSON.stringify(WAR_TEST_UNITS)};`);
  await page.addInitScript(`window.S3_TEST_ROOMS = ${JSON.stringify(ROOM_TEST_INDEX)};`);
};

head("Disc load defers the area tables to the views that need them");
{ const page = await newPage();
  await withTables(page);
  await page.addInitScript(SLICE_SPY);
  await loadIso(page);
  check("opening the disc reads no area tables at all", (await sliceCount(page)) === 0,
    `${await sliceCount(page)} ranged read(s)`);
  // Views that don't need them must not trigger the read either.
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForTimeout(80);
  await page.click('#isoTabs [data-v="sets"]'); await page.waitForTimeout(80);
  check("...nor does browsing the views that don't need them", (await sliceCount(page)) === 0);
  // First visit to Enemies pays for them — batched, and the fixture's enemy, war and room
  // windows sit within a few KB of each other, so one chunk covers all three.
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 5000 });
  const first = await sliceCount(page);
  check("the first Enemies visit batches them into one read", first === 1, `${first} ranged read(s)`);
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  check("...and the enemy record decodes", (await page.inputValue('input.en-num[data-f="lv"]')) === "7");
  check("...including its reward block", (await page.inputValue('input.en-num[data-f="potch"]')) === "60");
  // War and Encounter ride the same windows — no second read.
  await page.click('#isoTabs [data-v="war"]');
  await page.waitForSelector("details.epack", { timeout: 3000 });
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="hp"]', { timeout: 3000 });
  check("the war unit decodes from the same load", (await page.inputValue('input.en-num[data-f="hp"]')) === "230");
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("details.rarea", { timeout: 3000 });
  await page.click("details.rarea summary");
  await page.waitForSelector("input.rm-f", { timeout: 3000 });
  const rates = await page.$$eval('input.rm-f[data-k="rate"]', (es) => es.map((e) => e.value));
  check("the room table decodes from it too", rates.join(",") === "4,0,9,2", rates.join(","));
  await page.click('#isoTabs [data-v="enemies"]'); await page.waitForTimeout(120);
  check("War, Encounter and a second Enemies visit re-read nothing", (await sliceCount(page)) === first,
    `${await sliceCount(page)} vs ${first}`);
  await page.context().close();
}

head("Encounter's global scale draws without waiting for the per-area tables");
{ const page = await newPage();
  await withTables(page);
  // Hold the area read open so the half-drawn state is observable rather than a race.
  await page.addInitScript(`(() => { const _s = Blob.prototype.slice;
    Blob.prototype.slice = function (a, b) {
      const blob = _s.apply(this, arguments);
      if (this.size > 0x400000 && (b || 0) - (a || 0) < 0x100000) {
        const _ab = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = () => new Promise((r) => setTimeout(() => r(_ab()), 1200));
      }
      return blob; }; })()`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  check("the global rate control is up immediately", (await page.inputValue("#encPct")) === "100");
  check("...while the per-area half says it's still reading",
    /Reading area data/.test(await page.textContent("#encRooms")));
  await page.waitForSelector("details.rarea", { timeout: 6000 });
  check("...and fills itself in when the read lands", (await page.locator("details.rarea").count()) > 0);
  await page.context().close();
}

head("A recipe reaches enemy data on a disc whose Enemies tab was never opened");
{ const page = await newPage();
  await withTables(page);
  await loadIso(page);
  // Straight from the loader to the patch button — no view has loaded the enemy windows, so
  // without a forced load inAux() would not recognise these offsets and importRecipe() would
  // skip the runs SILENTLY: not applied, not reported as mismatched, just gone.
  const recipe = JSON.stringify({ format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
    patches: [{ off: ENEMY_REC_A + 64, old: "07", new: "2a" },
              { off: ENEMY_REC_B + 64, old: "07", new: "2a" },
              { off: ROOM_TABLE_A + 4, old: "0400", new: "0900" }] });
  const s = await uploadPatch(page, new TextEncoder().encode(recipe), "enemy.s3mod");
  check("the recipe applies", /applied recipe/i.test(s), s);
  check("...and counts every byte, none silently skipped", /4 byte\(s\)/.test(s), s);
  check("...with no run reported as mismatched", !/didn't match/.test(s), s);
  const r = await save(page);
  check("enemy copy A written", r.u16(ENEMY_REC_A + 64) === 42);
  check("enemy copy B written", r.u16(ENEMY_REC_B + 64) === 42);
  check("room rate written", r.u16(ROOM_TABLE_A + 4) === 9);
  await page.context().close();
}

head("An .xdelta touching enemy data loads the tables before judging it out of range");
if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else { const page = await newPage();
  await withTables(page);
  await loadIso(page);
  // ENEMY_REC_A sits past ELF_END, so this patch is entirely out of block. Un-loaded windows
  // would make it look like a patch this editor can't stage, and it would be refused whole.
  const tgt = Uint8Array.from(bytes);
  tgt.set([0x2a, 0x00], ENEMY_REC_A + 64);
  tgt.set([0x2a, 0x00], ENEMY_REC_B + 64);
  const s = await uploadPatch(page, makeXdelta(bytes, tgt), "enemy.xdelta");
  check("the patch applies rather than being refused as out of range", /applied patch/i.test(s), s);
  const r = await save(page);
  check("enemy copy A written", r.u16(ENEMY_REC_A + 64) === 42);
  check("enemy copy B written", r.u16(ENEMY_REC_B + 64) === 42);
  await page.context().close();
}

head("A disc read that fails after open is retryable, not a dead tab");
{ const page = await newPage();
  await withTables(page);
  // Fail every ranged read EXCEPT the big ELF one, so the disc opens and only the deferred
  // tables break. This is the failure the old eager load could never hit: the file moving or
  // losing permission between opening the disc and clicking the tab.
  await page.addInitScript(`window.__failReads = true;
    const _s = Blob.prototype.slice;
    Blob.prototype.slice = function (a, b) {
      const blob = _s.apply(this, arguments);
      if (window.__failReads && this.size > 0x400000 && (b || 0) - (a || 0) < 0x100000)
        blob.arrayBuffer = () => Promise.reject(new Error("NotReadableError"));
      return blob; };`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("#tblRetry", { timeout: 5000 });
  const txt = await page.textContent("#isoView");
  check("the view says the read failed, not that the disc lacks the data", /Couldn't read this disc's area tables/.test(txt));
  check("...and does NOT claim the offsets don't exist", !/none of their offsets exist/.test(txt));
  // A patch must refuse outright rather than apply half of itself.
  const recipe = JSON.stringify({ format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
    patches: [{ off: ENEMY_REC_A + 64, new: "2a" }] });
  const ps = await uploadPatch(page, new TextEncoder().encode(recipe), "enemy.s3mod");
  check("a patch needing those tables is refused whole", /nothing was applied/i.test(ps), ps);
  check("...and stages nothing", await nothingStaged(page));
  // Let the disc come back, and Retry must recover in place.
  await page.evaluate("window.__failReads = false");
  await page.click("#tblRetry");
  await page.waitForSelector("details.epack", { timeout: 5000 });
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  check("Retry loads the tables and the view comes good", (await page.inputValue('input.en-num[data-f="lv"]')) === "7");
  await page.context().close();
}

head("Closing a disc drops the deferred tables with it");
{ const page = await newPage();
  await withTables(page);
  await page.addInitScript(SLICE_SPY);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 5000 });
  const afterFirst = await sliceCount(page);
  await page.click("#isoClose");
  await page.waitForSelector("#isoPick", { timeout: 3000 });
  await page.click("#isoPick");
  await page.waitForSelector("#isoTabs", { timeout: 8000 });
  check("reopening reads no area tables again on open", (await sliceCount(page)) === afterFirst);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("details.epack", { timeout: 5000 });
  check("...and the new disc re-reads them for itself", (await sliceCount(page)) > afterFirst,
    `${await sliceCount(page)} vs ${afterFirst}`);
  await page.click("details.epack summary");
  await page.waitForSelector('input.en-num[data-f="lv"]', { timeout: 3000 });
  check("...decoding correctly the second time too", (await page.inputValue('input.en-num[data-f="lv"]')) === "7");
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
  await openFold(page, "#spReskinBox");
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

head("Unite rosters — guide characters shown, searchable, read-only");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="unites"]'); await page.waitForTimeout(120);
  const row0 = 'details.char[data-i="0"]';
  check("roster summary on unite 0",
    /Geddoe, Queen, Ace, Joker, Jacques/.test(await page.textContent(`${row0} .un-who`)));
  await openRec(page, row0);
  const chips = await page.locator(`${row0} .char-body .tag`).allTextContents();
  check("unite 0 members resolved to character ids",
    chips.map((t) => t.replace(/\s+/g, " ").trim()).join(" | ") ===
    "Geddoe #3 | Queen #21 | Ace #16 | Joker #23 | Jacques #22", chips.join(" | "));
  check("roster is read-only (no input in the Characters field)",
    (await page.locator(`${row0} .char-body .tag input, ${row0} .char-body .tag select`).count()) === 0);
  check("unite view says the roster is guide reference",
    /Suikosource unite guide/i.test(await page.textContent("#isoView")));
  // unite 2 ("Griffon") has no entry in the guide — say so instead of guessing
  await openRec(page, 'details.char[data-i="2"]');
  check("unguided unite says roster unknown",
    /roster unknown/i.test(await page.textContent('details.char[data-i="2"] .char-body')));
  // filtering matches character names, not just unite names
  await page.fill("#isoSearch", "jacques"); await page.waitForTimeout(80);
  const ids = await page.locator("details.char").evaluateAll((ns) => ns.map((n) => n.dataset.i));
  check("filter by character name keeps both Mercenary B rows", ids.join(",") === "0,24", ids.join(","));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(60);
  await page.context().close();
}

head("Shops — counters by town and story stage, with rare finds");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="shops"]'); await page.waitForTimeout(120);
  // the fixture stocks location 0, which the shop index names Vinay del Zexay
  const locOpts = await page.locator("#shopLoc option").allTextContents();
  check("location picker names the town and its counters",
    /Vinay del Zexay/.test(locOpts[0]) && /Item\/Armor\/Rune/.test(locOpts[0]), locOpts.join(" | "));
  check("only stocked locations are offered", locOpts.length === 1, String(locOpts.length));
  check("the town name cites its evidence", /Yellow Scarf/.test(await page.textContent("#isoView")));
  // all three counters render, each with its own record address
  const heads = await page.locator(".bag-h").allTextContents();
  for (const k of ["Item Shop", "Armor Shop", "Rune Shop"])
    check(`${k} counter shown`, heads.some((h) => h.includes(k)), heads.join(" | "));
  check("stage 1 of 2 labelled", /stage 1 of 2/.test(heads.join(" ")), heads.join(" | "));
  // stock resolves to item names, not raw ids
  const body = await page.textContent("#isoView");
  check("stock slot shows the item name", /Medicine D/.test(body));
  check("rarity section present", /rare finds/i.test(body));
  check("shared tables start folded", (await page.locator(".shop-extra[open]").count()) === 0);
  check("...so the price ladder is out of the way until asked for",
    !(await page.locator("input.shopnum >> nth=0").isVisible()));
  await page.click(".shop-extra > summary"); await page.waitForTimeout(80);
  check("...and unfolds on click", await page.locator("input.shopnum >> nth=0").isVisible());
  await page.click(".shop-extra > summary"); await page.waitForTimeout(80);
  check("rarity roll is explained, not just labelled", /1-in-100 draw/.test(body) && /qty . spread/.test(body), "");
  check("fixture rarity chance read from +0x0A", (await page.inputValue("input.shopchance >> nth=0")) === "40");
  check("chance clamps to 100", await (async () => {
    await page.fill("input.shopchance >> nth=0", "250");
    await page.dispatchEvent("input.shopchance >> nth=0", "change"); await page.waitForTimeout(60);
    const v = await page.inputValue("input.shopchance >> nth=0");
    await page.fill("input.shopchance >> nth=0", "40"); await page.dispatchEvent("input.shopchance >> nth=0", "change");
    return v === "100";
  })());
  // switching stage re-reads a different record: stage 2 has one more item than stage 1
  const n1 = await page.locator("button.shopitem").count();
  await page.selectOption("#shopStage", "1"); await page.waitForTimeout(120);
  const n2 = await page.locator("button.shopitem").count();
  check("later stage shows a longer stock list on each counter", n2 === n1 + 3, `${n1} -> ${n2}`);
  check("stage label follows the picker", /stage 2 of 2/.test((await page.locator(".bag-h").allTextContents()).join(" ")));
  // the empty tail is hidden until asked for, then all 30 slots appear per counter
  await page.check("#shopEmpty"); await page.waitForTimeout(120);
  check("show-empty reveals all 30 slots on each of the 3 counters",
    (await page.locator("button.shopitem").count()) === 90);
  await page.uncheck("#shopEmpty"); await page.waitForTimeout(120);
  await page.context().close();
}

head("Shops — a gap in a stock list is called out");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="shops"]'); await page.waitForTimeout(120);
  check("no warning on a contiguous list", !/hides the rest/.test(await page.textContent("#isoView")));
  // clear slot 2 of 3 — the game stops reading at the first empty slot, so slot 3 goes dark
  await page.click("button.shopitem >> nth=1"); await page.waitForSelector(".picker-search");
  await page.click('.picker-row >> nth=0');          // "— none —" is always the first row
  await page.waitForTimeout(120);
  const t = await page.textContent("#isoView");
  check("gap warning appears", /hides the rest/.test(t));
  check("gap warning explains the consequence", /never appear/.test(t));
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

head("Per-area encounter rates — decode, split variants, byte-exact write");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ROOMS = ${JSON.stringify(ROOM_TEST_INDEX)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("details.rarea", { timeout: 3000 });
  check("the area is listed with its map ids", /test_101/.test(await page.textContent("details.rarea summary")));
  await page.click("details.rarea summary");
  await page.waitForSelector("input.rm-f", { timeout: 3000 });
  // rooms 1 and 2 agree across both chapter tables -> one row each; room 3 does not -> two.
  const rowText = await page.$$eval("details.rarea tbody tr", (rs) => rs.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check("agreeing rooms collapse to one row each", rowText.filter((t) => /^Room [12] /.test(t)).length === 2);
  check("a room whose tables disagree is split, and says so",
    rowText.filter((t) => /^Room 3 variant/.test(t)).length === 2, rowText.join(" | "));
  const rates = await page.$$eval('input.rm-f[data-k="rate"]', (es) => es.map((e) => e.value));
  check("rates decode from the disc", rates.join(",") === "4,0,9,2", rates.join(","));
  const graces = await page.$$eval('input.rm-f[data-k="grace"]', (es) => es.map((e) => e.value));
  check("grace decodes from the disc", graces.join(",") === "6,0,4,4", graces.join(","));
  // an agreeing row writes BOTH chapter tables; a split row writes only its own
  const setRow = async (i, k, v) => { const sel = `input.rm-f[data-r="${i}"][data-k="${k}"]`;
    await page.fill(sel, String(v)); await page.dispatchEvent(sel, "change"); };
  await setRow(0, "rate", 7);          // room 1 — both tables
  await setRow(0, "grace", 12);
  await setRow(2, "rate", 1);          // room 3, the rate-9 variant only
  const { r, review } = await saveAndReview(page);
  check("the review names the area", /Encounters — TEST/.test(review), review.slice(0, 160));
  check("...and states the old → new rate", /Room 1 rate: 4 → 7/.test(review), review.slice(0, 160));
  check("room 1 rate written to chapter table A", r.u16(ROOM_TABLE_A + 4) === 7);
  check("room 1 rate written to chapter table B", r.u16(ROOM_TABLE_B + 4) === 7);
  check("room 1 grace written to both", r.u16(ROOM_TABLE_A + 2) === 12 && r.u16(ROOM_TABLE_B + 2) === 12);
  check("the split row wrote only its own table", r.u16(ROOM_TABLE_A + 0x78 + 4) === 1);
  check("...leaving the other table's value alone", r.u16(ROOM_TABLE_B + 0x78 + 4) === 2);
  check("untouched room 2 is unchanged", r.u16(ROOM_TABLE_A + 0x3C + 4) === 0);
  await page.context().close();
}

head("Per-area encounter rates — presets scale from the disc and never compound");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ROOMS = ${JSON.stringify(ROOM_TEST_INDEX)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("details.rarea", { timeout: 3000 });
  await page.click("details.rarea summary");
  await page.waitForSelector('[data-rp="200"]', { timeout: 3000 });
  // drawView() keeps the open <details> open, so the rows stay on screen across presets.
  const rateVals = () => page.$$eval('input.rm-f[data-k="rate"]', (es) => es.map((e) => e.value).join(","));
  const preset = async (v) => { await page.click(`[data-rp="${v}"]`); await page.waitForTimeout(120); };
  await preset(200);
  check("Double doubles every room from the disc value", (await rateVals()) === "8,0,18,4", await rateVals());
  await preset(200);
  check("applying Double twice does not compound", (await rateVals()) === "8,0,18,4", await rateVals());
  await preset(0);
  check("None zeroes the whole area", (await rateVals()) === "0,0,0,0", await rateVals());
  check("a zeroed area is staged", await somethingStaged(page));
  await preset(100);
  check("Stock is a byte-exact restore — nothing left staged", await nothingStaged(page));
  await preset(0);
  await page.click("[data-rrev]"); await page.waitForTimeout(120);
  check("Restore area clears it too", await nothingStaged(page));
  await page.context().close();
}

head("Files browser — a Reference sub-tab, read-only, peeks real bytes");
{ const page = await newPage();
  await page.addInitScript(`window.S3_TEST_SUBFILES = ${JSON.stringify(SUBFILE_TEST_INDEX)};`);
  await loadIso(page);
  check("Files is no longer a top-level tab", (await page.locator('#isoTabs [data-v="files"]').count()) === 0);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="files"]', { timeout: 3000 });
  await page.click('[data-ref="files"]');
  await page.waitForSelector("details.sfarch", { timeout: 3000 });
  check("the sub-tab hint follows the sub-tab", /packed sub-file/.test(await page.textContent("#isoHint")), await page.textContent("#isoHint"));
  const sum = await page.textContent("details.sfarch summary");
  check("the archive summarises its sub-files by kind", /4 sub-files/.test(sum) && /1 town/.test(sum) && /1 battle/.test(sum), sum);
  await page.click("details.sfarch summary");
  await page.waitForSelector("[data-peek]", { timeout: 3000 });
  const rows = await page.$$eval("details.sfarch tbody tr:not(.howrow)", (rs) => rs.map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  check("kinds and labels are listed", rows.some((r) => /town area 0x20 · 3 rooms/.test(r)) && rows.some((r) => /battle test_101/.test(r)), rows.join(" | "));
  check("offsets are shown in hex", rows.some((r) => /0x[0-9A-F]+/.test(r)));
  // Peek reads the real bytes off the open file — the room table's first record
  await page.click(`[data-peek="${ROOM_TABLE_A}"]`);
  await page.waitForFunction((o) => { const p = document.querySelector(`.sfpeek[data-at="${o}"]`); return p && !p.hidden; }, ROOM_TABLE_A, { timeout: 3000 });
  const dump = await page.textContent(`.sfpeek[data-at="${ROOM_TABLE_A}"]`);
  check("peek dumps hex + ascii from the right offset", dump.split("\n")[0].startsWith(ROOM_TABLE_A.toString(16).toUpperCase().padStart(9, "0")), dump.split("\n")[0]);
  check("peek shows the planted room record (rank 3, grace 6, rate 4)", /03 00 06 00 04 00/.test(dump), dump.split("\n")[0]);
  check("the view stages nothing", await nothingStaged(page));
  check("there is no input in the Files view", (await page.locator("#isoView input").count()) === 0);
  await page.context().close();
}

head("Reference — item sources, disc vs guide provenance, read-only");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="sources"]', { timeout: 3000 });
  await page.click('[data-ref="sources"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  const txt = await page.textContent("#isoView");
  check("the browser explains chest contents aren't editable", /Chest contents are guide-only/.test(txt));
  const tags = await page.$$eval(".srctag", (es) => es.map((e) => e.textContent.trim()));
  check("rows carry a disc/guide provenance tag", tags.length > 0 && tags.every((t) => t === "disc" || t === "guide"), tags.slice(0, 4).join(","));
  check("both provenance kinds are present", tags.includes("disc") && tags.includes("guide"));
  // the filter reaches the source text, not just the item name
  await page.fill("#isoSearch", "troll dragon"); await page.waitForTimeout(150);
  const filtered = await page.textContent("#isoView");
  check("filtering matches source text", /Pale Moon Casque/.test(filtered), filtered.slice(0, 120));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(150);
  check("the view stages nothing", await nothingStaged(page));
  check("no inputs in the sources browser", (await page.locator("#isoView input").count()) === 0);
  await page.context().close();
}

head("Reference — pickup locations, disc census vs guide chests");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="places"]', { timeout: 3000 });
  await page.click('[data-ref="places"]');
  await page.waitForSelector(".pkct", { timeout: 3000 });
  const txt = await page.textContent("#isoView");
  check("both tables are present", /pickups per area/i.test(txt) && /treasure-boss chests/i.test(txt));
  check("it says the two tables aren't linked", /aren't linked/.test(txt));
  check("it says nothing here is editable", /rolled at run time/.test(txt));
  check("MORI's census matches the walkthrough", /1 corpse/.test(txt) && /3 herb spots/.test(txt), "");
  check("a guide chest lists its guardian", /guarded by/.test(txt));
  // filtering reaches map ids and chest contents alike
  await page.fill("#isoSearch", "mori_101"); await page.waitForTimeout(150);
  check("filter matches a map id", /MORI/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", "horned helm"); await page.waitForTimeout(150);
  check("filter matches a chest's contents", /Mt\. Senai/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(150);
  check("the view stages nothing", await nothingStaged(page));
  check("no inputs in the pickups browser", (await page.locator("#isoView input").count()) === 0);
  await page.context().close();
}

head("Reference — rune lookup: families, granted spells, who has it");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="runes"]', { timeout: 3000 });
  await page.click('[data-ref="runes"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  const all = +(await page.textContent('[data-rgrp=""]')).replace(/\D+/g, "");
  check("every rune in the game is listed", all === 72, `All (${all})`);
  const groups = await page.$$eval("[data-rgrp]", (es) => es.map((e) => e.textContent.trim()));
  check("the three rune families each have a chip", /Magic \(22\)/.test(groups.join(" "))
    && /Special attack \(27\)/.test(groups.join(" ")) && /Support \(23\)/.test(groups.join(" ")), groups.join(" | "));
  // a magic rune names the spells it grants; the browser is where you look that up
  await page.fill("#isoSearch", "true fire"); await page.waitForTimeout(150);
  const tf = await page.textContent("#isoView");
  check("a magic rune lists the spells it grants", /Hellfire/.test(tf) && /Blazing Wall/.test(tf), tf.slice(0, 200));
  // the filter reaches past the name into owners, spells and drop sources
  await page.fill("#isoSearch", "sasarai"); await page.waitForTimeout(150);
  check("filtering finds a rune by who carries it", /True Earth/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", "hellfire"); await page.waitForTimeout(150);
  check("filtering finds a rune by a spell it grants", /True Fire/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(150);
  // the family chips actually narrow the table, and the support runes are reachable in one click
  await page.click('[data-rgrp="support"]'); await page.waitForTimeout(150);
  const sup = await page.textContent("#isoView");
  check("the Support family shows the passive runes", /Fortune/.test(sup) && /Fury/.test(sup));
  check("the Support family excludes the magic runes", !/>True Fire</.test(await page.innerHTML("#isoView")));
  await page.click('[data-rgrp=""]'); await page.waitForTimeout(150);
  const tags = await page.$$eval(".srctag", (es) => es.map((e) => e.textContent.trim()));
  check("rune provenance stays tagged disc vs guide", tags.length > 0 && tags.every((t) => t === "disc" || t === "guide"));
  check("the view stages nothing", await nothingStaged(page));
  // The browser is no longer read-only — it now owns the rune's menu text (issue #11: the only
  // copy of it the game actually reads) and its effect bits (issue #12). It must still stage
  // nothing until touched, and it must carry ONLY those fields: any other input here would be
  // an accident, since every other rune property belongs to another tab.
  const kinds = await page.$$eval("#isoView input", (es) => [...new Set(es.map((e) => e.className))].sort());
  check("the only editable fields are menu text and effect bits",
    kinds.every((k) => /^(rdesc|sp18|sp18hex|rfx)$/.test(k)), kinds.join(" | "));
  // A rune is only editable when its table row still names it — the same check runeTblDesc()
  // makes before trusting a record. The fixture fills a handful of the 72 rows; the rest are
  // zeroed and stay read-only, so the editor never writes into a row it can't vouch for.
  const editable = new Set([...mapping.runes.map((r) => r.id), mapping.twin.rune.id]).size;
  check("only runes whose table row names them are editable",
    (await page.locator("input.rdesc").count()) === editable,
    `${await page.locator("input.rdesc").count()} of 72, expected ${editable}`);
  await page.context().close();
}

head("Reference — skill lookup: types, per-rank effects, who can learn it");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="skills"]', { timeout: 3000 });
  await page.click('[data-ref="skills"]');
  await page.waitForSelector("details.char", { timeout: 3000 });
  const types = (await page.$$eval("[data-styp]", (es) => es.map((e) => e.textContent.trim()))).join(" | ");
  check("the support skills have their own chip", /Utility \(support\) \(11\)/.test(types), types);
  // the whole point of the card: what a rank is worth, and who can reach it
  await page.click('details[data-i="sk1"] summary'); await page.waitForTimeout(120);
  const swing = await page.textContent('details[data-i="sk1"]');
  check("a skill card shows its per-rank effect table", /Freeze Time/.test(swing) && /-100/.test(swing), swing.slice(0, 200));
  check("a skill card names who can learn it and how far", /Who can learn it/.test(swing) && /characters, best/.test(swing));
  // Utility skills have no per-character cap, and the card says so rather than showing a hole
  await page.click('[data-styp="Utility"]'); await page.waitForTimeout(150);
  const util = await page.textContent("#isoView");
  check("the Utility chip narrows to the support skills", /Cook/.test(util) && /Appraisal/.test(util) && !/Sharpshoot/.test(util));
  await page.click('details[data-i="sk31"] summary'); await page.waitForTimeout(120);
  check("a support skill explains why it has no cap",
    /aren't capped per character/.test(await page.textContent('details[data-i="sk31"]')));
  await page.click('[data-styp=""]'); await page.waitForTimeout(150);
  // filtering reaches the description, not just the name
  await page.fill("#isoSearch", "counter attack"); await page.waitForTimeout(200);
  check("filtering opens the matching card", /Parry\/Shield Counter/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(150);
  check("the view stages nothing", await nothingStaged(page));
  check("no inputs in the skill browser", (await page.locator("#isoView input").count()) === 0);
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

head("Gear rename — in-place, slot-capped, and global");
{ const page = await newPage(); await loadIso(page);
  // The name pointer sits at +0x40 of the record BEFORE the stats record (= base + GEAR.name).
  const nameVa = (bytes[GEAR.P + 0x40] | bytes[GEAR.P + 0x41] << 8 | bytes[GEAR.P + 0x42] << 16 | bytes[GEAR.P + 0x43] << 24) >>> 0;
  const nameOff = nameVa - ELF_VADDR + ELF_BASE, slot = armor.name.length;
  await page.click('#isoTabs [data-v="gear"]'); await openRec(page, "details.char");
  const nameIn = page.locator("input.ge-name").first();
  const max = +(await nameIn.getAttribute("maxlength"));
  check("the name field is capped to the on-disc slot", max === slot, `maxlength=${max} vs slot=${slot}`);
  check("the name field starts at the disc's name", (await nameIn.inputValue()) === armor.name);

  // Over-length is refused outright — same rule as descriptions, because growing the string
  // would mean repointing every reference to it.
  await nameIn.evaluate((el, n) => { el.value = "X".repeat(n + 3); el.dispatchEvent(new Event("change", { bubbles: true })); }, max);
  await page.waitForTimeout(60);
  check("an over-length name warns", await statusHas(page, /too long/i));
  check("an over-length name stages nothing", await nothingStaged(page));

  // ...and so is a blank one: an item with no name is worse than the original.
  await nameIn.evaluate((el) => { el.value = "   "; el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(60);
  check("a blank name is refused", await statusHas(page, /needs a name/i));
  check("a blank name stages nothing", await nothingStaged(page));

  const newName = "Zzz";   // shorter than the slot -> exercises the null padding
  await nameIn.fill(newName); await page.dispatchEvent("input.ge-name", "change"); await page.waitForTimeout(80);
  check("the row header follows the rename", (await page.textContent("details.char[open] .nm")) === newName);

  // Renaming is global because every menu reads the one string through the one pointer. The
  // item pickers prove it: they resolve names off the disc, not off the bundled id list.
  await page.click('#isoTabs [data-v="chars"]');
  await page.fill("#isoSearch", "1"); await page.waitForTimeout(60);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  const rec = +(await page.getAttribute("details.char[open]", "data-rec"));
  await page.click(`details.char[open] button.picker[data-off="${rec + 112}"]`);   // all-items slot
  await page.waitForSelector(".picker-search");
  await page.fill(".picker-search", String(armor.id)); await page.waitForTimeout(60);
  const rowText = await page.evaluate((wanted) => {
    const row = [...document.querySelectorAll(".picker-row")].find((b) => +b.dataset.id === wanted);
    return row ? row.textContent : null;
  }, armor.id);
  check("every picker shows the renamed item", (rowText || "").includes(newName) && !(rowText || "").includes(armor.name), rowText);
  await page.keyboard.press("Escape"); await page.waitForTimeout(60);

  const { r, review } = await saveAndReview(page);
  check("the rename is listed for review", /Name/.test(review) && review.includes(newName), review.split("\n").find((l) => /Name/.test(l)) || "");
  let wrote = ""; for (let i = 0; i < slot; i++) wrote += String.fromCharCode(r.u8(nameOff + i));
  check("the name is written in place, null-padded to the slot", wrote === newName + "\0".repeat(slot - newName.length), JSON.stringify(wrote));
  check("the byte past the slot is untouched", r.u8(nameOff + slot) === bytes[nameOff + slot]);
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

head("Status effect strength — what an effect is worth (engine constants)");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]');
  await page.waitForSelector("#spFxBox");
  check("the status-strength card starts collapsed", !(await page.locator('input.fx[data-k="swLightning"]').isVisible()));
  await openFold(page, "#spFxBox");
  // every control must decode the disc's own immediate, not a hardcoded default
  const fxKeys = [...new Set(mapping.statusfx.map((f) => f.key))];
  for (const k of fxKeys) {
    const f = mapping.statusfx.find((x) => x.key === k);
    const el = page.locator(`input.fx[data-k="${k}"]`);
    check(`${k} decodes ${f.pct} off the disc`, (await el.inputValue()) === String(f.pct), await el.inputValue());
  }
  // the headline case: change what sword-lightning is worth
  await page.fill('input.fx[data-k="swLightning"]', "75");
  await page.dispatchEvent('input.fx[data-k="swLightning"]', "change"); await page.waitForTimeout(60);
  const site = mapping.statusfx.find((f) => f.key === "swLightning");
  { const r = await save(page);
    const wd = r.u32(site.off) >>> 0;
    check("sword-lightning now worth 75%", (wd & 0xFFFF) === 75, "0x" + wd.toString(16));
    check("only the immediate changed — opcode and registers intact",
      (wd & 0xFFFF0000) === (site.word & 0xFFFF0000), "0x" + wd.toString(16));
    check("the write is 4 bytes at that site, nothing either side",
      r.wrote(site.off, 4) && !r.wrote(site.off + 4, 4) && !r.wrote(site.off - 4, 4)); }
  // a constant carried by two code sites must be written at BOTH, or half the game disagrees
  await openFold(page, "#spFxBox");
  await page.fill('input.fx[data-k="buffDef"]', "50");
  await page.dispatchEvent('input.fx[data-k="buffDef"]', "change"); await page.waitForTimeout(60);
  { const r = await save(page);
    const all = mapping.statusfx.filter((f) => f.key === "buffDef");
    const got = all.map((f) => r.u32(f.off) & 0xFFFF);
    check(`all ${all.length} PDF/MDF sites were written`, got.every((v) => v === 50), got.join(" / ")); }
  // The constant carried by the MOST sites is the one a partial write would break most quietly:
  // it doesn't error, the game just behaves differently depending on which code path runs. The
  // unsaved-field badge counts REGISTERED sites, so it catches that for free — a write that hit
  // 1 of 4 sites reads as a smaller count. This assertion is the check that caught the bug
  // originally: the first cut of the table listed one mgc-boost site instead of four.
  await openFold(page, "#spFxBox");
  const mgcSites = mapping.statusfx.filter((f) => f.key === "mgcBoost").length;
  await page.fill('input.fx[data-k="mgcBoost"]', "300");
  await page.dispatchEvent('input.fx[data-k="mgcBoost"]', "change"); await page.waitForTimeout(60);
  check(`the badge counts all ${mgcSites} mgc-boost sites, not one`,
    new RegExp(`\\b${mgcSites} unsaved\\b`).test(await dirtyLabel(page, new RegExp(`${mgcSites} unsaved`))),
    await page.textContent("#isoDirty"));
  { // and every site is named in the review list, so a partial write is visible before saving
    const { r, review } = await saveAndReview(page);
    // .cf-list has no newlines between rows, so count label occurrences rather than lines
    const named = (review.match(/MGC-boost status/gi) || []).length;
    check(`the review list names all ${mgcSites} sites`, named === mgcSites, `${named}: ${review.slice(0, 220)}`);
    check("each site is numbered so a partial write is visible",
      /site 1 of 4/.test(review) && /site 4 of 4/.test(review), review.slice(0, 220));
    check("the review shows the percentage, not the raw instruction word",
      /150\s*→\s*300/.test(review) || /150.*300/.test(review.replace(/\s+/g, " ")), review.slice(0, 220));
    const all = mapping.statusfx.filter((f) => f.key === "mgcBoost").map((f) => r.u32(f.off) & 0xFFFF);
    check(`all ${mgcSites} MGC-boost sites were written`, all.every((v) => v === 300), all.join(" / "));
    check("every MGC-boost site kept its opcode and registers",
      mapping.statusfx.filter((f) => f.key === "mgcBoost")
        .every((f) => (r.u32(f.off) & 0xFFFF0000) === (f.word & 0xFFFF0000))); }
  // the resistance ladder exists twice in the code; both copies must agree or the two damage
  // paths disagree about what a resistance is worth
  await openFold(page, "#spFxBox");
  await page.fill('input.fx[data-k="res3"]', "10");
  await page.dispatchEvent('input.fx[data-k="res3"]', "change"); await page.waitForTimeout(60);
  { const r = await save(page);
    const all = mapping.statusfx.filter((f) => f.key === "res3");
    const got = all.map((f) => r.u32(f.off) & 0xFFFF);
    check(`both resistance ladders were written (${all.length} sites)`, got.every((v) => v === 10), got.join(" / ")); }
  await page.context().close();
}
{ const page = await newPage(); await loadIso(page);
  // "Restore all to stock" must put every immediate back, and stage nothing net
  await page.click('#isoTabs [data-v="spells"]'); await openFold(page, "#spFxBox");
  await page.fill('input.fx[data-k="res3"]', "0");
  await page.dispatchEvent('input.fx[data-k="res3"]', "change"); await page.waitForTimeout(60);
  check("an edit is staged", !(await nothingStaged(page)));
  await openFold(page, "#spFxBox");
  await page.click("#fxReset"); await page.waitForTimeout(80);
  check("restore-to-stock clears the change", await nothingStaged(page));
  await page.context().close();
}
{ // A disc whose instruction no longer matches must go READ-ONLY rather than be written blind.
  const drift = bytes.slice();
  const site = mapping.statusfx.find((f) => f.key === "swFire");
  new DataView(drift.buffer).setUint32(site.off, 0x00000000, true);   // clobber the instruction
  setServed(drift);
  const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await openFold(page, "#spFxBox");
  check("a drifted instruction is refused, not patched",
    (await page.locator('input.fx[data-k="swFire"]').count()) === 0
    && (await page.locator("#spFxBox input[disabled]").count()) >= 1);
  check("the card says a control is read-only", /read-only/.test(await page.textContent("#spFxBox")));
  // the other ten controls must still work — one drifted site can't disable the whole card
  const keys = [...new Set(mapping.statusfx.map((f) => f.key))];
  check("the undrifted controls stay editable",
    (await page.locator("#spFxBox input.fx").count()) === keys.length - 1,
    `${await page.locator("#spFxBox input.fx").count()} of ${keys.length}`);
  setServed(bytes);
  await page.context().close();
}

head("Spell targeting + element: every byte the disc uses has a name");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]');
  // Fixture spell #2 carries target byte 0x05 and element 7 — the Sword/Amulet shape that used
  // to read "custom 0x05" in the dropdown and "undefined" in the summary line.
  await openRec(page, 'details.char[data-i="2"]');
  const tgt = 'details.char[data-i="2"] select[data-k="target"]';
  const opts = await page.$$eval(`${tgt} option`, (es) => es.map((e) => ({ v: e.value, t: e.textContent, sel: e.selected })));
  const cur = opts.find((o) => o.sel);
  check("target 0x05 is a named option, not 'custom'", cur && cur.t === "Caster only (chanter)", cur ? cur.t : "none selected");
  check("no 'custom' option is offered for a stock byte", !opts.some((o) => /custom/i.test(o.t)), opts.map((o) => o.t).join(" | "));
  // the three bytes that were missing must all be offerable, or you can't author them
  for (const [v, label] of [["5", "Caster only (chanter)"], ["9", "Single ally"], ["18", "Line of foes (target + behind)"]])
    check(`0x${(+v).toString(16).toUpperCase().padStart(2, "0")} is offered as "${label}"`,
      opts.some((o) => o.v === v && o.t === label), opts.map((o) => o.v + "=" + o.t).join(" | "));
  const elOpts = await page.$$eval('details.char[data-i="2"] select[data-k="elementId"] option', (es) => es.map((e) => ({ t: e.textContent, sel: e.selected })));
  const elCur = elOpts.find((o) => o.sel);
  check("element 7 is named, not undefined", elCur && elCur.t === "Enhance (Sword/Amulet)", elCur ? elCur.t : "none selected");
  const sum = await page.textContent('details.char[data-i="2"] .sp-sum');
  check("the summary names the family, not 'undefined'", /Enhance \(Sword\/Amulet\)/.test(sum) && !/undefined/.test(sum), sum);
  check("the summary names the shape and who, not 'spread:who5'", /self:chanter/.test(sum) && !/who\d/.test(sum), sum);
  // and nothing anywhere on the tab leaks undefined into the UI
  const all = await page.textContent("#isoView");
  check("no 'undefined' anywhere on the Spells tab", !/undefined/.test(all));
  // changing the target must still round-trip through the newly named byte
  await page.selectOption(tgt, "9"); await page.waitForTimeout(60);
  { const r = await save(page); const f14 = r.u32(SPELL.off + 2 * SPELL.stride + 0x14);
    check("selecting a newly named target writes that byte", ((f14 >> 8) & 0x7F) === 0x09, "0x" + (((f14 >> 8) & 0x7F)).toString(16)); }
  await page.context().close();
}

head("Reference — Classes: derived from skills, not stored (issue #13)");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="classes"]', { timeout: 3000 });
  await page.click('[data-ref="classes"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  const body = await page.textContent("#isoView");
  // the finding itself has to be stated, or the view reads as "class field not implemented yet"
  check("the view says there is no class byte", /no class byte/i.test(body));
  check("it points at skills as the way to change a class", /change their <b>skills<\/b>|change their.{0,3}skills/i.test(await page.innerHTML("#isoView")));
  check("the class words are read off the disc", /Slasher/.test(body) && /Knight/.test(body));
  // the fixture gives list1 #1 (Hugo) Heavy Damage r2 + Counter Attack r1, the real disc's own
  // loadout, and plants the table cell those two resolve through
  const row = await page.$$eval("table.invtbl tbody tr", (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  const hugo = row.find((r) => r[0] === "Hugo");
  check("the derived class is shown", hugo && hugo[1] === "Slasher", hugo ? hugo.join(" | ") : "no Hugo row");
  check("it shows which two skills decided it",
    hugo && /Heavy Damage/.test(hugo[2]) && /Counter Attack/.test(hugo[2]), hugo ? hugo[2] : "");
  check("it lists the character's skills with ranks", hugo && /Heavy Damage D|Heavy Damage/.test(hugo[3]), hugo ? hugo[3] : "");
  // a cell is (type word, modifier word) — a two-word label must join both, not show one half
  for (const c of mapping.classes.cases) {
    const r = row.find((x) => x[0] === c.who);
    check(`${c.who} resolves to "${c.label}"`, r && r[1] === c.label, r ? r.join(" | ") : `no ${c.who} row`);
  }
  check("the view stages nothing", await nothingStaged(page));
  check("no inputs in the Classes view", (await page.locator("#isoView input").count()) === 0);
  await page.context().close();
}

head("Duplicated descriptions — one edit writes both copies (issue #11)");
// The Text tab can't reach these strings at all: its prose filter rejects every real one
// ("DMGx0.4" trips the letter-then-digit reject), which is exactly why the only editable copy
// used to be the spell record's — the copy the game's rune menu does NOT read.
{ const page = await newPage(); await loadIso(page);
  const T = mapping.twin;
  const read = (r, off, n) => { let s = ""; for (let i = 0; i < n; i++) { const c = r.at(off + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="runes"]', { timeout: 3000 });
  await page.click('[data-ref="runes"]'); await page.waitForSelector("input.rdesc", { timeout: 5000 });
  await page.fill("#isoSearch", T.rune.name.toLowerCase()); await page.waitForTimeout(100);
  const box = page.locator(`input.rdesc[data-id="${T.rune.id}"]`);
  check("the rune browser offers an editable menu text", (await box.count()) === 1);
  check("it starts at the disc's own rune text", (await box.inputValue()) === T.text);
  check("it is capped to the on-disc slot", +(await box.getAttribute("maxlength")) === T.text.length);
  const label = await box.evaluate((el) => el.closest("label").querySelector("span").textContent);
  check("the field says the text is mirrored", /2 copies, mirrored/.test(label), label);

  const NEW = "DMGx9 to one foe.";
  await box.fill(NEW); await box.dispatchEvent("change"); await page.waitForTimeout(80);
  check("status says both copies were written", await statusHas(page, /all 2 copies/i));
  const r = await save(page);
  check("the rune copy holds the new text", read(r, T.runeOff, T.text.length) === NEW);
  check("the spell copy holds it too — this is the bug", read(r, T.spellOff, T.text.length) === NEW);
  check("both slots are NUL-padded past the new text",
    r.at(T.runeOff + NEW.length) === 0 && r.at(T.spellOff + NEW.length) === 0);
  check("neither write runs past its slot",
    !r.wrote(T.runeOff + T.text.length, 1) && !r.wrote(T.spellOff + T.text.length, 1));
  await page.context().close();
}
{ const page = await newPage(); await loadIso(page);
  // …and it mirrors the other way too, from the Spells tab's own description field.
  const T = mapping.twin;
  await page.click('#isoTabs [data-v="spells"]');
  await openRec(page, `details.char[data-i="${T.spellIdx}"]`);
  const d = `details.char[data-i="${T.spellIdx}"] input.spdesc`;
  check("the spell's description field shows the shared text", (await page.inputValue(d)) === T.text);
  await page.fill(d, "DMGx1 to foes."); await page.dispatchEvent(d, "change"); await page.waitForTimeout(80);
  const r = await save(page);
  let got = ""; for (let i = 0; i < T.text.length; i++) { const c = r.at(T.runeOff + i); if (!c) break; got += String.fromCharCode(c); }
  check("Spells-tab edit reached the rune copy as well", got === "DMGx1 to foes.");
  await page.context().close();
}
{ const page = await newPage(); await loadIso(page);
  // A description that is NOT duplicated must stay a single write. The alias rule is
  // cross-table only: repeated text inside one table (the synth fixture gives four spells
  // their own copy of "Deals 100DMG") must NOT be linked.
  await page.click('#isoTabs [data-v="spells"]');
  await openRec(page, 'details.char[data-i="0"]');
  await page.fill('details.char[data-i="0"] input.spdesc', "Deals 1DMG");
  await page.dispatchEvent('details.char[data-i="0"] input.spdesc', "change"); await page.waitForTimeout(80);
  const r = await save(page);
  const at = (i) => { const o = SPELL.off + i * SPELL.stride + 0x0C; return r.u32(o); };
  const txt = (va) => { const off = va - ELF_VADDR + ELF_BASE; let s = ""; for (let i = 0; i < 12; i++) { const c = r.at(off + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  check("the edited spell description changed", txt(at(0)) === "Deals 1DMG");
  check("a same-table twin was NOT rewritten", txt(at(1)) === "Deals 100DMG", txt(at(1)));
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
  // ...and on the NEXT visit it comes back by itself: same context (IndexedDB + the OPFS
  // handle survive a reload), so opening the ISO Editor tab reopens the disc with no click.
  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await page.click('.mtab[data-mode="iso"]');
  check("prior ISO reopens automatically on the next visit", await until(page, () => !!document.querySelector("#isoTabs"), undefined, 8000));
  // Closing it must STAY closed — no bounce straight back into the disc just closed.
  await page.click("#isoClose"); await page.waitForSelector("#isoRecent .recent");
  await page.waitForTimeout(300);
  check("close stays closed (no auto-reopen loop)", !(await page.$("#isoTabs")));
  // Opting out sticks across a reload: the chip is offered, nothing loads on its own.
  await page.uncheck("#isoAuto");
  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await page.click('.mtab[data-mode="iso"]');
  await page.waitForSelector("#isoRecent .recent", { timeout: 3000 });
  await page.waitForTimeout(300);
  check("auto-reopen can be switched off", !(await page.$("#isoTabs")) && !(await page.isChecked("#isoAuto")));
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
        if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [], charById: {},
          charRoster: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 }, charChoices: [1, 2, 3, 4, 5, 6] });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
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
        if (code.includes('load_reference()')) return JSON.stringify({ items: [], skills: [], charById: {},
          charRoster: { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 }, charChoices: [1, 2, 3, 4, 5, 6] });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
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
        if (code.includes('load_reference()')) return JSON.stringify({ items: [{id:5,name:'Fire Rune',cat:'Runes'},{id:9,name:'Rage Rune',cat:'Runes'}], skills: [{id:6,name:'Attack'}], charById: {1:'Hugo',2:'Chris',3:'Geddoe'},
          charRoster: { 1: 0, 2: 1, 3: 2 }, charChoices: [1, 2, 3] });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) return JSON.stringify({ changed: 1 });
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
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

head("Suikoden I / II carryover (save editor, Pyodide stubbed)");
{ const page = await newPage();
  // The carryover flags are whole-save state, so the stub carries a decoded `carryover`
  // block shaped exactly like s3save.detect_carryover() and a REF.carryover reference block.
  // The formulas themselves are covered by save_roundtrip.py; what this proves is the
  // wiring: the checkbox reaches the write payload, and the bonus modal stages edits.
  await page.addInitScript(`
    const CHARS = [
      ['Hugo',true], ['Viki',true], ['Futch',true]
    ].map((x, i) => ({ rosterIndex: i, name: x[0], recruiter: '', recruited: x[1],
      level: 30, weaponLv: 5, curHP: 100, maxHP: 100, expToNext: 0, hasData: true,
      stats: { PWR: 1, SKL: 1, MAG: 1, REP: 1, PDF: 1, MDF: 1, SPD: 1, LUK: 1 },
      equip: { headRune: 0 }, skills: [] }));
    const CO = {
      s1: { loaded: false, flagIndex: 1, flagBit: 4, flagOffset: 0x31, flagMask: 0x10,
            names: { s1Hero: 'McDohl', s1Country: 'Toran' }, customNames: false,
            hero: 'McDohl', country: 'Toran', note: 'not loaded' },
      s2: { loaded: false, flagIndex: 1, flagBit: 3, flagOffset: 0x31, flagMask: 0x08,
            names: { s2Hero: 'Genkaku Jr.' }, customNames: false,
            hero: 'Genkaku Jr.', country: 'Dunan', note: 'not loaded' },
    };
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: CO, names: [], characters: CHARS, party: [0,0,0,0,0,0], inventory: [] }];
    window.__payloads = [];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({
          items: [{ id: 317, name: 'Fire', cat: 'Runes' }, { id: 337, name: 'Pale Gate', cat: 'Runes' }],
          skills: [], charById: { 1: 'Hugo', 7: 'Viki', 31: 'Futch' },
          charRoster: { 1: 0, 7: 1, 31: 2 }, charChoices: [1, 7, 31],
          carryover: { flags: { s1: { index: 1, bit: 4 }, s2: { index: 1, bit: 3 } },
                       chars: [{ battleId: 7, rosterIndex: 1, name: 'Viki' },
                               { battleId: 31, rosterIndex: 2, name: 'Futch' }],
                       runes: [317, 337], runeSlots: ['headRune', 'rightRune', 'leftRune'],
                       levelMax: 99, weaponLvMax: 16 } });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('carryover_bonus(')) {
          window.__bonusReq = code.slice(code.indexOf('(') + 1, code.lastIndexOf(')'));
          return JSON.stringify({ 1: { level: 44, weaponLv: 8, equip: { headRune: 317 } } });
        }
        if (code.startsWith('apply_edits(')) {
          window.__payloads.push(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')')));
          return JSON.stringify({ changed: 1 });
        }
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; }, { timeout: 15000 });
  await page.setInputFiles("#file", { name: "save.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  await page.waitForSelector("#carryover", { timeout: 5000 });

  const coText = await page.textContent("#carryover");
  check("both carryover rows render", (await page.locator("#carryover input[data-carry]").count()) === 2);
  check("the row names the flag byte and bit, not a heuristic",
    /0x31 bit 3/.test(coText) && /0x31 bit 4/.test(coText), coText.replace(/\s+/g, " ").slice(0, 160));
  check("an unset flag reads as unticked", !(await page.isChecked('input[data-carry="s2"]')));
  check("the current name-slot values are shown", /Genkaku Jr\./.test(coText) && /McDohl/.test(coText));

  // Ticking the box is a staged change like any other: it lands in the review list...
  await page.check('input[data-carry="s2"]'); await page.waitForTimeout(50);
  check("ticking marks the checkbox dirty", await page.locator('input[data-carry="s2"]').evaluate((e) => e.classList.contains("dirty")));
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  check("the review list names the carryover change",
    /Suikoden II data loaded: no → yes/.test(await page.textContent(".cf-list")));
  await page.click("#cfOk");
  await until(page, () => (window.__payloads || []).length > 0);
  const sent = JSON.parse(JSON.parse(await page.evaluate(() => window.__payloads[0].split(", ").slice(2).join(", "))));
  check("the write payload carries the flag", sent.carryover && sent.carryover.s2 === true, JSON.stringify(sent.carryover));

  // ...and unticking it again is a no-op, not a second staged change.
  await page.uncheck('input[data-carry="s2"]'); await page.waitForTimeout(50);
  check("returning a flag to its saved value clears the staging",
    await page.evaluate(() => !("s2" in CARRY)) && !(await page.locator('input[data-carry="s2"]').evaluate((e) => e.classList.contains("dirty"))));

  // The Suikoden II bonus modal: enter the S2 numbers, stage the character upgrade.
  await page.click("#coBonus"); await page.waitForSelector("#cbOk", { timeout: 3000 });
  const bonusText = await page.textContent(".cf-list");
  check("the bonus modal lists the characters the import upgrades",
    /Viki/.test(bonusText) && /Futch/.test(bonusText));
  check("only carryover-reachable runes are offered",
    (await page.locator('.modal-ov select[data-rune] option').count()) === 2 * 3 * 3,
    String(await page.locator('.modal-ov select[data-rune] option').count()));
  await page.fill('[data-ri="1"] [data-s2lv]', "99");
  await page.fill('[data-ri="1"] [data-s2wl]', "16");
  await page.click("#cbOk"); await page.waitForTimeout(80);
  const req = JSON.parse(JSON.parse(await page.evaluate(() => window.__bonusReq)));
  check("the bonus request sends the save's current values plus the S2 ones",
    req["1"].level === 30 && req["1"].weaponLv === 5 && req["1"].s2Level === 99 && req["1"].s2WeaponLv === 16,
    JSON.stringify(req["1"]));
  check("the returned upgrade is staged as ordinary character edits",
    await page.evaluate(() => EDITS[1] && EDITS[1].level === 44 && EDITS[1].weaponLv === 8 && EDITS[1].equip.headRune === 317));
  check("staging the bonus also ticks the Suikoden II flag",
    await page.isChecked('input[data-carry="s2"]'));
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  const review2 = await page.textContent(".cf-list");
  check("the review list shows the levelled character and the flag together",
    /Viki/.test(review2) && /Level: 30 → 44/.test(review2) && /Suikoden II data loaded/.test(review2), review2.replace(/\s+/g, " ").slice(0, 200));
  await page.click("#cfCancel");
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
  await page.click('#isoTabs [data-v="spells"]');
  check("the rune reskin card starts collapsed", !(await page.locator("#rsPower").isVisible()));
  await openFold(page, "#spReskinBox");
  await page.click('[data-rspreset="max"]'); await page.waitForTimeout(20);
  check("rune preset 'Power 9999' fills the reskin field", (await page.locator("#rsPower").inputValue()) === "9999");
  await page.click('[data-rspreset="nostatus"]'); await page.waitForTimeout(20);
  check("rune preset 'Remove status' sets Status → none", (await page.locator("#rsStatus").inputValue()) === "none");
  // spell #1 inflicts unbalance → summary shows it, and clearing its Status zeroes flags18
  check("spell summary shows the inflicted status", (await page.textContent('details.char[data-i="1"] .sp-sum')).includes("unbalance"));
  await openRec(page, 'details.char[data-i="1"]');
  await page.fill('details.char[data-i="1"] input.sp18hex', "0");
  await page.dispatchEvent('details.char[data-i="1"] input.sp18hex', "change");
  const rs = await save(page);
  check("clearing status zeroes flags18 (removes unbalance)", rs.u32(SPELL.off + 1 * 0x20 + 0x18) === 0);
  // the raw-hex escape hatch authors a bit the label table doesn't name, and rejects junk
  await openRec(page, 'details.char[data-i="1"]');
  await page.fill('details.char[data-i="1"] input.sp18hex', "1DE7");
  await page.dispatchEvent('details.char[data-i="1"] input.sp18hex', "change");
  const rh = await save(page);
  check("raw mask writes a composite (0x1DE7 restore-all)", rh.u32(SPELL.off + 1 * 0x20 + 0x18) === 0x1DE7);
  await openRec(page, 'details.char[data-i="1"]');
  await page.fill('details.char[data-i="1"] input.sp18hex', "zz");
  await page.dispatchEvent('details.char[data-i="1"] input.sp18hex', "change");
  check("a junk mask is refused with a message", await statusHas(page, /hex mask/i));
  await page.context().close();
}
head("Damage+heal slot — move Shining Wind's split effect to another spell");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForSelector("#spSplitBox");
  check("the damage+heal card starts collapsed", !(await page.locator("#spSplitSpell").isVisible()));
  // two collapsed bars in a row are ambiguous — each section carries a captioned rule
  { const secs = await page.locator("#isoView > .secdiv > span").allTextContents();
    check("the tab reads as four labelled sections",
      secs.length === 4 && /Status effects/.test(secs[0]) && /Special effect/.test(secs[1])
      && /Bulk edit/.test(secs[2]) && /Every spell/.test(secs[3]),
      secs.join(" | ")); }
  await openFold(page, "#spSplitBox");
  // the fixture ships the stock wiring: spell id 17 (row 16) + a 300 HP heal
  check("the slot decodes the disc's own wiring", /heals 300 HP/.test(await page.textContent("#spSplitInfo")),
    await page.textContent("#spSplitInfo"));
  await page.selectOption("#spSplitSpell", "2");            // Blazing Wall
  await page.fill("#spSplitHeal", "450");
  await page.click("#spSplitApply"); await page.waitForTimeout(60);
  check("the note names the spell that now splits", /Blazing Wall/.test(await page.textContent("#spSplitInfo")),
    await page.textContent("#spSplitInfo"));
  // Apply re-renders the whole tab — the card has to survive that, or the user loses their place
  check("the card stays open across Apply's re-render", await page.locator("#spSplitSpell").isVisible());
  const { r, review } = await saveAndReview(page);
  check("the review labels the patched instructions and reads the ids as spells",
    /Damage\+heal/.test(review) && /heal HP: 300 . 450/.test(review) && /Blazing Wall \(#2\)/.test(review),
    review.slice(0, 240));
  // both immediates must move together, or the spell heals for its Power instead of the number
  check("route immediate = spell id 3 (row 2 + 1)", (r.u32(SPLIT.route) & 0xFFFF) === 3 && (r.u32(SPLIT.route) >>> 16) === 0x2402);
  check("heal-owner immediate = the same id", (r.u32(SPLIT.amtSel) & 0xFFFF) === 3 && (r.u32(SPLIT.amtSel) >>> 16) === 0x3AC3);
  check("heal amount immediate = 450", (r.u32(SPLIT.amt) & 0xFFFF) === 450 && (r.u32(SPLIT.amt) >>> 16) === 0x2412);
  // ...and the spell has to actually pull both sides into the target list
  check("the spell's target byte became foes+allies (0x03)", ((r.u32(SPELL.off + 2 * SPELL.stride + 0x14) >> 8) & 0x7F) === 0x03);
  await page.context().close();
}
head("Damage+heal slot — restore puts the original bytes back");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await openFold(page, "#spSplitBox");
  await page.selectOption("#spSplitSpell", "1");
  await page.click("#spSplitApply"); await page.waitForTimeout(60);
  await page.click("#spSplitReset"); await page.waitForTimeout(60);
  const r = await save(page);
  check("all three instructions are byte-exact again",
    [SPLIT.route, SPLIT.amtSel, SPLIT.amt].every((o, i) => r.u32(o) === SPLIT_STOCK[i]));
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
  await dismissBoot(page);
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
  await dismissBoot(page);
  const built = await page.evaluate(async () => {
    const mk = (rosterIndex, name) => ({
      rosterIndex, name, addr: 0, id: 0, level: 30, curHP: 200, maxHP: 200, expToNext: 500,
      stats: { PWR: 100, SKL: 100, MAG: 100, REP: 100, PDF: 100, MDF: 100, SPD: 100, LUK: 100 },
      equip: { headRune: 0, rightRune: 0, leftRune: 0, helm: 0, armor: 0, shield: 0, boots: 0, gloves: 0, accessory: 0 },
      skills: [{ slot: 0, id: 10, rank: 4 }, { slot: 1, id: 40, rank: 0 }],
      recruited: true, recruitWord: 1, recruiter: "", recruiters: [], hasData: true,
    });
    REF = { items: [], skills: [], charById: {}, charRoster: {}, charChoices: [] };
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

// The save health check. health-core.mjs proves the rules; this proves the panel renders
// them, that a Fix stages a real edit (and only stages — nothing is written), and that the
// finding then goes away. Pyodide is aborted here, so the same synthetic-save trick is used.
head("Save editor — health check panel");
{ const page = await newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  const r = await page.evaluate(async () => {
    const mk = (rosterIndex, name, over) => Object.assign({
      rosterIndex, name, id: rosterIndex + 1, idExpected: rosterIndex + 1,
      level: 30, weaponLv: 5, curHP: 200, maxHP: 200, expToNext: 100,
      stats: { PWR: 100, SKL: 100, MAG: 100, REP: 100, MDF: 100, SPD: 100, LUK: 100 },
      equip: { headRune: 0, rightRune: 0, leftRune: 0, helm: 0, armor: 0, shield: 0, boots: 0, gloves: 0, accessory: 0 },
      skills: [{ slot: 0, id: 0, rank: 0 }],
      recruited: true, recruitWord: 0x1d, recruiter: "", recruiters: [], hasData: true,
    }, over || {});
    const rune = { id: 0xa0, name: "Fury Rune", cat: "Runes", desc: "" };
    REF = { items: [rune], skills: [], charById: { 1: "Hugo", 2: "Chris" },
            charRoster: { 1: 0, 2: 1 }, charChoices: [1, 2] };
    ITEM_BY_ID = { 0xa0: rune };
    OPT_RANK = RANK_TIERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    GUIDE = { caps: {}, growth: {}, slots: {} };   // skip the guide fetch/redraw
    RECRUIT_META = {};
    saves = [{
      label: "slot", folder: "BASLUS-20387", checksumWord: 0, meta: {}, names: [],
      global: { gold: 100, storyPhase: 6, merged: true, partyLeader: 1, playtime: "1:00" },
      party: [1, 2, 0, 0, 0, 0],
      characters: [mk(0, "Hugo", { curHP: 400 }), mk(1, "Chris", { recruited: false, recruitWord: 0 })],
      // a rune carrying a stack count — the shape that used to eat spare copies
      inventory: [{ region: "Party bag", base: 0, firstSlot: 0, capacity: 30, used: 1,
        freeSlots: [], appendSlots: [], items: [{ slot: 0, addr: 0, id: 0xa0, qty: 1,
          category: "equipment", stackable: false, displayed: false, rawId: 0xa0,
          unknownId: false, state: [0, 0, 0, 0] }] }],
      statNames: ["PWR", "SKL", "MAG", "REP", "MDF", "SPD", "LUK"], problems: [], notes: [],
    }];
    curSlot = 0;
    renderEditor();
    const badge = document.querySelector("#healthTab");
    const badgeText = badge.textContent, badgeBad = badge.classList.contains("hz-bad");
    badge.click();
    const rows = () => [...document.querySelectorAll(".hz-item")];
    const titles = () => rows().map((r) => r.querySelector(".hz-t").textContent.trim());
    const before = titles();
    const errors = rows().filter((r) => r.classList.contains("sev-error")).length;
    // stage the inventory fix and confirm it becomes a pending edit rather than a write
    const runeRow = rows().find((r) => /one-per-slot/.test(r.querySelector(".hz-t").textContent));
    runeRow.querySelector("[data-hfix]").click();
    const after = titles();
    const staged = JSON.parse(JSON.stringify(INV));
    // "Show" jumps to the view that owns the finding
    const hpRow = rows().find((r) => /Current HP/.test(r.querySelector(".hz-t").textContent));
    hpRow.querySelector("[data-hgo]").click();
    return { badgeText, badgeBad, before, after, errors, staged, jumpedTo: SUB,
      dirty: !!hasChanges(), diff: buildDiff().map((d) => d.g + ": " + d.t) };
  });
  check("the tab badges the problem count", /Health \(\d+\)/.test(r.badgeText), r.badgeText);
  check("the badge marks an error-level save", r.badgeBad);
  check("an unrecruited party member is listed", r.before.some((t) => /Chris, who is not recruited/.test(t)));
  check("current HP above max is listed", r.before.some((t) => /Current HP 400 is above max HP 200/.test(t)));
  check("a rune carrying a stack count is listed", r.before.some((t) => /one-per-slot but carries a count/.test(t)));
  check("problems render at error severity", r.errors >= 2, String(r.errors));
  check("applying a fix removes that finding", !r.after.some((t) => /one-per-slot but carries a count/.test(t)));
  check("…leaving the others alone", r.after.length === r.before.length - 1);
  check("the fix stages an inventory edit", JSON.stringify(r.staged) === JSON.stringify({ 0: { qty: 0 } }),
    JSON.stringify(r.staged));
  check("the fix is pending, not written", r.dirty === true);
  check("…and shows up in the review list", r.diff.some((d) => /Inventory: Slot 0: .* ×1 →/.test(d)), r.diff.join(" | "));
  check("Show jumps to the view that owns the finding", r.jumpedTo === "chars", r.jumpedTo);
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
