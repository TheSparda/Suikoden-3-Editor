// Byte-level test for the STREAMING save — the "save patched copy" path every phone uses
// (Android/Firefox/Safari have no showSaveFilePicker, so the whole disc is re-streamed with
// the edited region spliced in). The in-place desktop save is covered in e2e.mjs against a
// stubbed FileSystemWritable; this one runs the real thing: real service worker, real
// ReadableStream hand-off, real download, then compares the downloaded image byte for byte.
//
// It exists because that loop is the mobile hot path and is easy to break silently — a chunk
// boundary landing mid-region, a splice off by one, a rename that only lands in one chunk —
// none of which the in-place path would notice.
//
//   node web/tests/stream-save.mjs        # self-skips (exit 0) without playwright/chromium
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildSynthIso, ELF_BASE, ELF_END, FOOD } from "./synth-iso.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "s3stream-"));

let chromium;
try { ({ chromium } = await import("playwright-core")); }
catch { console.log("SKIP stream-save: playwright-core not installed."); process.exit(0); }

let fails = 0;
const check = (n, c, extra = "") => { console.log(`  ${c ? "✓" : "✗"} ${n}${extra ? " — " + extra : ""}`); if (!c) fails++; };

// The synth disc with a rename target planted OUTSIDE the editable ELF block: only a streaming
// save can reach it, so it proves the replacer really runs over the whole image.
const { bytes } = buildSynthIso();
const NAME_AT = 0x1000;                                    // inert header padding
const src = Uint8Array.from(bytes);
src.set(Uint8Array.from("Hugo", (c) => c.charCodeAt(0)), NAME_AT);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  // The service worker precaches "./" (= /web/), and a failed addAll means it never installs —
  // which is exactly the state where a streaming save can't run. Serve directories as index.html.
  if (p.endsWith("/")) p += "index.html";
  if (p === "/index.html") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
    rs.end(d);
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://localhost:${srv.address().port}/web/index.html`;

let browser;
try { browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined }); }
catch (e) { console.log("SKIP stream-save: no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); process.exit(0); }

console.log("streaming save (real service worker, real download):");

const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => { console.log("  ! pageerror: " + e.message); fails++; });
await page.route(/jsdelivr\.net/, (r) => r.abort());        // skip the heavy Pyodide CDN
// No File System Access → the editor picks the streaming save, exactly like a phone.
await page.addInitScript("Object.defineProperty(window,'showOpenFilePicker',{value:undefined});" +
  "Object.defineProperty(window,'showSaveFilePicker',{value:undefined})");
await page.goto(base, { waitUntil: "domcontentloaded" });

// The stream is handed to the service worker, so it has to be controlling this page first.
const controlled = await page.evaluate(async () => {
  if (!navigator.serviceWorker) return false;
  await navigator.serviceWorker.ready.catch(() => {});
  if (navigator.serviceWorker.controller) return true;
  return new Promise((res) => {
    const t = setTimeout(() => res(!!navigator.serviceWorker.controller), 8000);
    navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(t); res(true); }, { once: true });
  });
});
if (!controlled) { console.log("  (service worker never took control — skipped)"); await browser.close(); srv.close(); process.exit(0); }
check("service worker controls the page", controlled);

{ const b = await page.$("#bootHide"); if (b) await b.click(); }   // take the boot gate down (Pyodide is aborted here)
await page.click('.mtab[data-mode="iso"]');
await page.waitForSelector("#isoFileInput", { state: "attached", timeout: 8000 });   // styled label — the input itself is hidden
await page.setInputFiles("#isoFileInput", { name: "s3.iso", mimeType: "application/octet-stream", buffer: Buffer.from(src) });
await page.waitForSelector("#isoTabs", { timeout: 10000 });

// Stage one in-block edit (a food heal value) and one disc-wide rename.
await page.click('#isoTabs [data-v="food"]');
await page.fill('input.fd[data-kind="heal"] >> nth=0', "321");
await page.dispatchEvent('input.fd[data-kind="heal"] >> nth=0', "change");
await page.click('#isoTabs [data-v="chars"]');            // the rename panel lives above the char records
await page.waitForSelector('input.rename[data-orig="Hugo"]', { timeout: 10000 });
await page.fill('input.rename[data-orig="Hugo"]', "Rex");   // shorter → space-padded to "Rex "

await page.click("#isoSaveBtn");
try { await page.waitForSelector("#bnSkip", { timeout: 1500 }); await page.click("#bnSkip"); } catch { /* nudge already shown */ }
await page.waitForSelector("#cfOk", { timeout: 5000 });
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click("#cfOk")]);
const outPath = path.join(TMP, "patched.iso");
await dl.saveAs(outPath);
const out = new Uint8Array(fs.readFileSync(outPath));

check("patched copy is the same size as the source", out.length === src.length, `${out.length} vs ${src.length}`);
check("download is named .patched.iso", /\.patched\.iso$/.test(dl.suggestedFilename()), dl.suggestedFilename());

// 1. the staged edit landed
const healAt = FOOD.off + FOOD.heal;
const heal = out[healAt] | (out[healAt + 1] << 8);
check("the staged in-block edit is in the copy", heal === 321, "heal=" + heal);

// 2. the disc-wide rename reached a byte the in-place save can't touch
check("rename applied outside the editable block",
  String.fromCharCode(...out.subarray(NAME_AT, NAME_AT + 4)) === "Rex ",
  JSON.stringify(String.fromCharCode(...out.subarray(NAME_AT, NAME_AT + 4)))); 

// 3. NOTHING else moved. Every differing byte must be either inside the editable block or a
//    renamed occurrence — a chunk-boundary or splice bug shows up here and nowhere else.
const diffs = [];
for (let i = 0; i < src.length && diffs.length < 40; i++) if (src[i] !== out[i]) diffs.push(i);
const stray = diffs.filter((i) => !(i >= ELF_BASE && i < ELF_END) && !(i >= NAME_AT && i < NAME_AT + 4));
check("no byte outside the edited region or a rename changed", stray.length === 0,
  stray.length ? "first stray at 0x" + stray[0].toString(16) : "");
check("something actually changed", diffs.length > 0);

// 4. and the untouched majority of the disc is byte-identical (checked in bulk, not sampled)
const same = Buffer.compare(Buffer.from(src.subarray(ELF_END)), Buffer.from(out.subarray(ELF_END))) === 0;
check("everything after the editable block is byte-identical", same);
const headSame = Buffer.compare(
  Buffer.from(src.subarray(NAME_AT + 4, ELF_BASE)), Buffer.from(out.subarray(NAME_AT + 4, ELF_BASE))) === 0;
check("everything before the editable block is byte-identical", headSame);

await browser.close();
srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} stream-save check(s) FAILED.` : "\nAll stream-save checks passed.");
process.exit(fails ? 1 : 0);
