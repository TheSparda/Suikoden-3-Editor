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
import { buildSynthIso, ELF_BASE, ELF_END, SPELL, UNITE, FOOD, ENEMY, GEAR, TABLES, SHOP, VERSION_OFF } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP e2e: playwright-core not installed."); process.exit(0); }

let fails = 0, section = "";
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };
const head = (s) => { section = s; console.log(s + ":"); };

const { bytes, armor } = buildSynthIso();
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
// Open a <details> record idempotently — cross-view open-state preservation can already
// have opened it, and clicking the summary again would toggle it shut.
async function openRec(page, detailsSel) {
  const loc = page.locator(detailsSel).first();
  if ((await loc.getAttribute("open")) === null) await loc.locator("summary").click();
  await page.waitForTimeout(50);
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
head("Gating (unsupported browser)");
{ const page = await newPage();
  await page.addInitScript("Object.defineProperty(window,'showOpenFilePicker',{value:undefined})");
  await gotoIsoTab(page); await page.waitForTimeout(120);
  check("blocked notice shown, no loader", !!(await page.$("#isoRoot .warnbox")) && !(await page.$("#isoPick")));
  await page.context().close();
}

head("ISO validation");
{ // wrong version word
  const bad = bytes.slice(); new DataView(bad.buffer).setUint32(VERSION_OFF, 0x11223344, false);
  setServed(bad);
  const page = await newPage();
  await gotoIsoTab(page); await page.click("#isoPick"); await page.waitForTimeout(300);
  check("rejects non-USA version word", !(await page.$("#isoTabs")) && /USA|SLUS|version/i.test(await page.textContent("#isoBootStatus")));
  await page.context().close();
  // undersized file
  setServed(new Uint8Array(2048));
  const page2 = await newPage();
  await gotoIsoTab(page2); await page2.click("#isoPick"); await page2.waitForTimeout(300);
  check("rejects too-small file", !(await page2.$("#isoTabs")) && /not a full/i.test(await page2.textContent("#isoBootStatus")));
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
  await page.selectOption('details.char[open] select[data-off="' + (l2rec + 13) + '"]', "3");   // skillmax skill#1 -> D
  // Spells: power/cast/element/target/aoe/status
  await page.click('#isoTabs [data-v="spells"]'); await openRec(page, 'details.char[data-i="0"]');
  await page.fill('details.char[data-i="0"] input[data-k="power"]', "1234"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="power"]', "change");
  await page.fill('details.char[data-i="0"] input[data-k="cast"]', "40"); await page.dispatchEvent('details.char[data-i="0"] input[data-k="cast"]', "change");
  await page.selectOption('details.char[data-i="0"] select[data-k="elementId"]', "5");
  await page.selectOption('details.char[data-i="0"] select[data-k="target"]', "2");
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1");
  await page.selectOption('details.char[data-i="0"] select[data-k="status"]', "sleep");
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
  check("skillmax#1 = 3 (D)", r.u8(l2rec + 13) === 3);
  check("spell0 power = 1234", r.u32(SPELL.off + 0x1C) === 1234);
  check("spell0 cast = 40", r.u32(SPELL.off + 0x10) === 40);
  check("spell0 element = Lightning(5)", (r.u16(SPELL.off + SPELL.elem) & 0xFF) === 5);
  // AOE is the top bit of the target byte, so target=all-foes(0x02) + AOE => high byte 0x82
  { const f14 = r.u32(SPELL.off + 0x14); check("spell0 target=all-foes + AOE bit", ((f14 >> 8) & 0x0F) === 0x02 && !!(f14 & 0x8000)); }
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

head("Per-field revert + Revert all + badge");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "300"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change"); await page.waitForTimeout(60);
  const rev = page.locator('input.fd[data-kind="heal"]').first().locator('xpath=following-sibling::button[contains(@class,"revert")]');
  check("revert tooltip = original", (await rev.getAttribute("title")) === "Restore original (100)");
  check("badge visible after edit", !(await page.locator("#isoDirty").isHidden()));
  await rev.click(); await page.waitForTimeout(120);
  check("per-field revert restores value", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "100");
  // edit two, then Revert all
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "111"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  await page.fill('input.fd[data-kind="proc"] >> nth=0', "22"); await page.dispatchEvent('input.fd[data-kind="proc"] >> nth=0', "change");
  await page.click("#isoResetBtn"); await page.waitForTimeout(80);
  check("Revert all clears dirty badge", await page.locator("#isoDirty").isHidden());
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
  check("reset preset stages nothing", await page.locator("#isoDirty").isHidden());
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
  check("over-length description warns", /too long/i.test(await page.textContent("#isoStatus")));
  check("over-length description not written", !(await getWrites(page)).length && !(await page.evaluate(() => window.__writes.length)));
  await page.context().close();
}

head("Recipe export → reset → import round-trip");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "321"); await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#isoRecipeBtn")]);
  const recipePath = path.join(os.tmpdir(), "s3-test.s3mod"); await dl.saveAs(recipePath);
  const mod = JSON.parse(fs.readFileSync(recipePath, "utf8"));
  check("recipe has patches + version word", mod.patches.length > 0 && mod.versionWord === 0x40A69A01);
  await page.click("#isoResetBtn"); await page.waitForTimeout(60);
  check("reset cleared the edit", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "100");
  await page.setInputFiles("#isoRecipeFile", recipePath); await page.waitForTimeout(120);
  check("import re-applies the edit", (await page.inputValue('input.fd[data-kind="heal"] >> nth=0')) === "321");
  // wrong-version recipe is rejected
  const badRecipe = path.join(os.tmpdir(), "s3-bad.s3mod");
  fs.writeFileSync(badRecipe, JSON.stringify({ format: "s3mod", versionWord: 0xDEADBEEF, patches: [] }));
  await page.setInputFiles("#isoRecipeFile", badRecipe); await page.waitForTimeout(80);
  check("wrong-region recipe rejected", /different game\/region/i.test(await page.textContent("#isoStatus")));
  await page.context().close();
}

head("Enemies + Reference (read-only)");
{ const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  check("enemy names render", (await page.locator(".invtbl tbody tr").count()) >= 5);
  await page.fill("#isoSearch", "dragon"); await page.waitForTimeout(80);
  check("enemy search filters", (await page.locator(".invtbl tbody tr").count()) === 1);
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
  check("progress modal reaches Saved", /Saved/i.test(await page.textContent("#pgTitle")));
  check("elapsed timer shown", /elapsed \d/.test(await page.textContent("#pgMeta")));
  await page.click("#pgClose");
  check("status ok after save", /Saved/.test(await page.textContent("#isoStatus")));
  check("badge cleared after save", await page.locator("#isoDirty").isHidden());
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
  await page.click("#isoForget"); await page.waitForTimeout(100);
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
      ['Hugo','Hugo',true], ['Chris','',false], ['Salome','',false],
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
  check("recruit roster renders", (await page.locator("#subview .invtbl tbody tr").count()) === 6);
  // bulk recruit all shown -> Geddoe
  await page.selectOption("#rteam", "Geddoe");
  await page.click("#recAllShown"); await page.waitForTimeout(80);
  check("recruit-all checks every row", (await page.locator("#subview input[data-rec]:checked").count()) === 6);
  check("recruit-all sets team select to Geddoe", (await page.locator('#subview select[data-team] >> nth=0').inputValue()) === "Geddoe");
  // canonical preset -> Chris (Chris + Salome)
  await page.click('[data-canon="Chris"]'); await page.waitForTimeout(80);
  const salomeTeam = await page.locator('#subview tr:has-text("Salome") select[data-team]').inputValue();
  check("canonical→Chris assigns Salome to Chris", salomeTeam === "Chris");
  // review modal lists recruit/team changes
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  const review = await page.textContent(".cf-list");
  check("review lists recruit/team changes", /Recruited: yes/.test(review) && /Team:/.test(review));
  await page.click("#cfCancel");
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

for (const [w, h] of [[360, 640], [320, 480]]) {
  head(`Mobile ${w}px — no horizontal overflow`);
  const page = await newPage({ width: w, height: h });
  await loadIso(page);
  let over = null;
  for (const v of ["chars", "growth", "support", "weapons", "shops", "spells", "unites", "gear", "food", "balance", "enemies", "ref"]) {
    await page.click(`#isoTabs [data-v="${v}"]`); await page.waitForTimeout(50);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) over = v;
  }
  check(`no overflow at ${w}px`, over === null, over ? "overflow in " + over : "");
  await page.context().close();
}

await browser.close();
srv.close();
console.log(fails ? `\nFAILED (${fails})` : "\nAll e2e checks passed.");
process.exit(fails ? 1 : 0);
