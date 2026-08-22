// End-to-end tests for the web ISO editor, driven through the real code in a headless
// browser against a synthetic in-bounds ISO (see synth-iso.mjs). Self-skips (exit 0) when
// playwright-core or a Chromium binary isn't available, so it never breaks a minimal CI.
//
//   node web/tests/e2e.mjs            # uses playwright's own chromium
//   PW_CHROMIUM=/path/to/chrome node web/tests/e2e.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSynthIso, ELF_BASE, ELF_END, SPELL, FOOD } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP e2e: playwright-core not installed."); process.exit(0); }

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

const { bytes, armor } = buildSynthIso();
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/synth.bin") { rs.writeHead(200); rs.end(Buffer.from(bytes)); return; }
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
  const ctx = await browser.newContext(viewport ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {});
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("  ! pageerror: " + e.message); fails++; });
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_(FAILED|TUNNEL|CONNECTION)|jsdelivr/.test(m.text())) { console.log("  ! console: " + m.text()); fails++; } });
  await page.route(/jsdelivr\.net/, (r) => r.abort());   // skip the heavy Pyodide CDN
  return page;
}
async function loadIso(page) {
  await page.addInitScript(fakeHandle());
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.click('.mtab[data-mode="iso"]');
  await page.click("#isoPick");
  await page.waitForSelector("#isoTabs", { timeout: 8000 });
}

// ---- gating (unsupported browser) ----
{ console.log("Gating:");
  const page = await newPage();
  await page.addInitScript("Object.defineProperty(window,'showOpenFilePicker',{value:undefined})");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.click('.mtab[data-mode="iso"]');
  await page.waitForTimeout(150);
  check("blocked notice on unsupported browser", !!(await page.$("#isoRoot .warnbox")) && !(await page.$("#isoPick")));
  await page.context().close();
}

// ---- features + revert ----
{ console.log("Features:");
  const page = await newPage();
  await loadIso(page);
  // overlap guard: the last roster record (#79) abuts list3 — its spill-over fields are hidden
  await page.fill("#isoSearch", "79");
  await page.waitForTimeout(80);
  await page.click("details.char >> nth=0 >> summary");
  await page.waitForTimeout(80);
  check("overlap guard hides unsafe fields on last record", (await page.locator("details.char[open] .char-body").innerText()).includes("overlap the next table"));
  await page.fill("#isoSearch", "");
  await page.waitForTimeout(60);
  // rune reskin
  await page.click('#isoTabs [data-v="spells"]');
  await page.waitForSelector("#rsApply");
  await page.selectOption("#rsRune", "fire");
  await page.fill("#rsPower", "999");
  await page.click("#rsApply");
  await page.waitForTimeout(150);
  await page.click('details.char[data-i="0"] > summary');
  check("rune reskin sets spell power", (await page.inputValue('details.char[data-i="0"] input[data-k="power"]')) === "999");
  await page.selectOption('details.char[data-i="0"] select[data-k="target"]', "2");
  check("spell target edit", (await page.textContent('details.char[data-i="0"] .sp-sum')).includes("all-foes"));
  // per-field revert
  const rev = page.locator('details.char[data-i="0"] input[data-k="power"]').locator('xpath=following-sibling::button[contains(@class,"revert")]');
  check("revert tooltip shows original", (await rev.getAttribute("title")) === "Restore original (100)");
  await rev.click();
  await page.waitForTimeout(120);
  check("revert restores field", (await page.inputValue('details.char[data-i="0"] input[data-k="power"]')) === "100");
  // gear desc rewrite
  await page.click('#isoTabs [data-v="gear"]');
  await page.click("details.char >> nth=0 >> summary");
  await page.fill('input.gr[data-l="DEF"]', "20");
  await page.dispatchEvent('input.gr[data-l="DEF"]', "change");
  check("gear DEF→desc rewrite", (await page.inputValue("input.ge-desc")) === "DEF(+20)");
  // food
  await page.click('#isoTabs [data-v="food"]');
  await page.fill('input.fd[data-kind="heal"] >> nth=0', "300");
  await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
  // enemies + reference render (read-only)
  await page.click('#isoTabs [data-v="enemies"]');
  check("enemies list renders", (await page.locator(".invtbl tbody tr").count()) > 0);
  await page.click('#isoTabs [data-v="ref"]');
  check("reference list renders", (await page.locator(".invtbl tbody tr").count()) > 10);
  // unsaved badge
  check("unsaved badge visible", !(await page.locator("#isoDirty").isHidden()));
  // save — expect the backup nudge first, then the confirm, then byte-exact writes
  await page.click("#isoSaveBtn");
  await page.waitForSelector("#bnSkip");
  await page.click("#bnSkip");
  await page.waitForSelector("#cfOk");
  await page.click("#cfOk");
  await page.waitForSelector("#pgClose:visible", { timeout: 5000 });
  await page.click("#pgClose");
  const writes = await page.evaluate(() => window.__writes);
  const u16 = (pos) => { const w = writes.find((x) => pos >= x.pos && pos < x.pos + x.data.length); return w ? (w.data[pos - w.pos] | (w.data[pos - w.pos + 1] << 8)) : null; };
  const u32 = (pos) => { const w = writes.find((x) => pos >= x.pos && pos < x.pos + x.data.length); if (!w) return null; const i = pos - w.pos; return (w.data[i] | w.data[i + 1] << 8 | w.data[i + 2] << 16 | w.data[i + 3] << 24) >>> 0; };
  check("spell0 power reverted → not written", u32(SPELL.off + 0x1C) === null);
  check("spell1 power written = 999", u32(SPELL.off + 0x20 + 0x1C) === 999);
  check("food heal written = 300", u16(FOOD.off + FOOD.heal) === 300);
  check("gear DEF written = 20", u16(0x410000 + 0x44 + 0x10) === 20);
  // balance / hard mode (after save; scales from the now-saved originals)
  await page.click('#isoTabs [data-v="balance"]');
  await page.click('[data-preset="hard"]');
  await page.click("#hm-apply");
  await page.waitForTimeout(150);
  check("balance preset stages growth bytes", /Staged \d+ growth/.test(await page.textContent("#hm-out")));
  await page.context().close();
}

// ---- mobile: no horizontal overflow across all views ----
for (const [w, h] of [[360, 640], [320, 480]]) {
  console.log(`Mobile ${w}px:`);
  const page = await newPage({ width: w, height: h });
  await loadIso(page);
  let over = false;
  for (const v of ["chars", "growth", "support", "weapons", "shops", "spells", "unites", "gear", "food", "balance", "enemies", "ref"]) {
    await page.click(`#isoTabs [data-v="${v}"]`);
    await page.waitForTimeout(60);
    const d = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (d) { over = true; console.log(`    overflow in ${v}`); }
  }
  check(`no horizontal overflow at ${w}px`, !over);
  await page.context().close();
}

await browser.close();
srv.close();
console.log(fails ? `\nFAILED (${fails})` : "\nAll e2e checks passed.");
process.exit(fails ? 1 : 0);
