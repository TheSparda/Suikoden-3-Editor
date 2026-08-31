// Does the ISO tab block itself while a disc is loading?
//
// Auto-reopen means a load can start with no click at all, so the loader shell must not sit
// there looking idle and clickable while ~400 ranged reads run: the picker underneath is live,
// and a second pick would race the first. This checks the overlay goes up (for both a manual
// pick and the silent auto-reopen), actually covers the controls behind it, and always comes
// back down — including when the disc is rejected.
//
// Self-skips (exit 0) when playwright-core or a Chromium binary isn't available.
//
//   node web/tests/iso-load-overlay.mjs
//   PW_CHROMIUM=/path/to/chrome node web/tests/iso-load-overlay.mjs
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildSynthIso, ENEMY_TEST_PACKS, ROOM_TEST_INDEX } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP iso-load-overlay: playwright-core not installed."); process.exit(0); }

const { bytes } = buildSynthIso();
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/synth.bin") { rs.writeHead(200); rs.end(Buffer.from(bytes)); return; }
  if (p === "/") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); rs.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}/web/index.html`;

let browser;
try { browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined }); }
catch (e) { console.log("SKIP iso-load-overlay: no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); process.exit(0); }

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

// A REAL OPFS FileSystemFileHandle stands in for the picked file. e2e.mjs's hand-rolled stub
// can't be used here: a plain object with methods doesn't survive structuredClone, so iso.js
// could never persist it to IndexedDB and the auto-reopen path would be unreachable. OPFS
// handles carry no permission API of their own, so put one on the prototype.
const HANDLE = `(() => {
  const P = FileSystemFileHandle.prototype;
  P.queryPermission = async () => 'granted';
  P.requestPermission = async () => 'granted';
  const ready = (async () => {
    const dir = await navigator.storage.getDirectory();
    const h = await dir.getFileHandle('s.iso', { create: true });
    const w = await h.createWritable();
    await w.write(await (await fetch('/synth.bin')).arrayBuffer());
    await w.close();
    return h;
  })();
  window.showOpenFilePicker = async () => [await ready];
})()`;

// The synthetic disc loads in milliseconds — quicker than any poll can catch the overlay — so
// record every .modal-ov the page ever adds, together with what it was covering at that moment.
const SPY = `(() => { window.__ov = [];
  const go = () => new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) {
    if (!(n.classList && n.classList.contains('modal-ov'))) continue;
    const covered = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return !!(hit && hit.closest('.modal-ov')); };
    window.__ov.push({ title: (n.querySelector('#ldTitle') || {}).textContent,
      msg: (n.querySelector('#ldMsg') || {}).textContent,
      focus: document.activeElement === n.querySelector('.modal'),
      blocksPicker: covered('#isoPick'), blocksTabs: covered('.mtab[data-mode="save"]') });
  } }).observe(document.documentElement, { childList: true, subtree: true });
  // Init scripts run before the document exists, so the observer may have to wait for it.
  if (document.documentElement) go();
  else document.addEventListener('readystatechange', function f() {
    if (document.documentElement) { document.removeEventListener('readystatechange', f); go(); } });
})()`;

async function newPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("  ! pageerror: " + e.message); fails++; });
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_(FAILED|TUNNEL|CONNECTION)|jsdelivr|favicon/.test(m.text())) { console.log("  ! console: " + m.text()); fails++; } });
  await page.route(/jsdelivr\.net/, (r) => r.abort());   // skip the heavy Pyodide CDN
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await page.addInitScript(`window.S3_TEST_ROOMS = ${JSON.stringify(ROOM_TEST_INDEX)};`);
  await page.addInitScript(HANDLE);
  await page.addInitScript(SPY);
  return page;
}
const isoTab = async (page) => { await page.goto(base, { waitUntil: "domcontentloaded" }); await page.click('.mtab[data-mode="iso"]'); };

console.log("Manual pick:");
{ const page = await newPage();
  await isoTab(page);
  await page.click("#isoPick");
  await page.waitForSelector("#isoTabs", { timeout: 15000 });
  await page.waitForTimeout(150);
  const ov = await page.evaluate(() => window.__ov);
  check("one overlay went up for the load", ov.length === 1, JSON.stringify(ov));
  check("titled for the disc being opened", /Opening s\.iso/.test(ov[0]?.title || ""), ov[0]?.title);
  check("carries a progress line", /Reading/.test(ov[0]?.msg || ""), ov[0]?.msg);
  check("covers the picker button", ov[0]?.blocksPicker === true);
  check("covers the mode tabs", ov[0]?.blocksTabs === true);
  check("takes keyboard focus off the picker", ov[0]?.focus === true);
  check("gone once the editor is up", (await page.$$(".modal-ov")).length === 0);
  await page.context().close();
}

console.log("Auto-reopen (second visit, permission already granted):");
{ const page = await newPage();
  await isoTab(page);
  await page.click("#isoPick");                          // first visit remembers the handle
  await page.waitForSelector("#isoTabs", { timeout: 15000 });
  await isoTab(page);                                    // second visit reopens by itself
  await page.waitForSelector("#isoTabs", { timeout: 15000 });
  await page.waitForTimeout(150);
  const ov = await page.evaluate(() => window.__ov);
  check("one overlay for the unattended load", ov.length === 1, JSON.stringify(ov));
  check("says which disc it is reopening", /Reopening s\.iso/.test(ov[0]?.title || ""), ov[0]?.title);
  // The overlay must be up before the file is even fetched, not just once bytes arrive —
  // that early window is exactly when a user would tap the picker.
  check("up from the file-open step", /Opening the file/.test(ov[0]?.msg || ""), ov[0]?.msg);
  check("covers the picker button", ov[0]?.blocksPicker === true);
  check("covers the mode tabs", ov[0]?.blocksTabs === true);
  check("gone after the reopen", (await page.$$(".modal-ov")).length === 0);
  await page.context().close();
}

console.log("Rejected disc (the overlay must not strand):");
{ const page = await newPage();
  await isoTab(page);
  await page.evaluate(() => { window.showOpenFilePicker = async () => [{ name: "tiny.iso", kind: "file",
    getFile: async () => new File([new Uint8Array(2048)], "tiny.iso") }]; });
  await page.click("#isoPick");
  const seen = await page.waitForFunction(() => /not a full Suikoden III ISO/.test(document.querySelector("#isoBootStatus")?.textContent || ""), null, { timeout: 10000 }).then(() => true).catch(() => false);
  check("the disc is rejected", seen, await page.textContent("#isoBootStatus"));
  check("overlay closed on the rejection", (await page.$$(".modal-ov")).length === 0);
  await page.context().close();
}

await browser.close();
srv.close();
console.log(fails ? `\n${fails} iso-load-overlay check(s) FAILED.` : "\nAll iso-load-overlay checks passed.");
process.exit(fails ? 1 : 0);
