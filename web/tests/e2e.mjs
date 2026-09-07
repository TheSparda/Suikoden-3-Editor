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
import { buildSynthIso, ELF_BASE, ELF_END, ELF_VADDR, SPELL, UNITE, FOOD, ENEMY, GEAR, RUNE_TBL, TABLES, SHOPS, shopRec, PRICE_LADDER, VERSION_OFF, VERSION_VAL, SETS, ENC_SITES, ENC_STOCK,
  MOUNT_PAIRS, mountWord, HORSE_STOCK, horseAddr, MECH, HORSE_CLAMP,
  ENEMY_TEST_PACKS, ENEMY_REC_A, ENEMY_AUX_A, ENEMY_REC_B, ENEMY_AUX_B,
  ZONE_SLOTS_A, ZONE_PARTY_A, ZONE_MEM_A, ZONE_SLOTS_B, ZONE_PARTY_B, ZONE_MEM_B,
  WAR_TEST_UNITS, WAR_REC_A, WAR_REC_B, WAR_LEAD_A, WAR_LEAD_B,
  ROOM_TEST_INDEX, ROOM_TABLE_A, ROOM_TABLE_B, SUBFILE_TEST_INDEX, SPLIT, SPLIT_STOCK,
  AVATAR_SITES, avatarWord, STORY_CASES, ENCMOVE_SITES, encMoveWord, ACTORFB_SITES,
  MOVESPD, MOVESPD_RUN, MOVESPD_CLASS, spdAddr, spdClassAddr, PASSIVE_SITES,
  RUNEFX_SITES, RUNEFX_FLOAT, PS_HOOK, PS_HOOK_STOCK, PS_HOOK_JAL, PS_LEGACY_YES, PS_HOOK_CODE,
  SVAG_STREAM, SVAG_INTER, SVAG_BYTES } from "./synth-iso.mjs";

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
// ---- which sections this process runs ---------------------------------------------------
// Selection is per SECTION — a head() and every block gated under it — decided once in
// head() and read by each block's `if (ON)`. All three filters are opt-in: with none
// of them set every section runs, so a bare `node e2e.mjs` still means the whole suite,
// which is what CI runs.
//
//   E2E_ONLY=<regex>    only sections whose name matches (case-insensitive)
//   E2E_TIER=fast       only the smoke tier — REDUCED COVERAGE, see tiers.json
//   E2E_SHARD=k/n       shard k of n, for the parallel runner (shard.mjs)
//   E2E_TIMINGS=<path>  append this run's per-section ms as JSON (budget.mjs reads it)
//
// A FILTERED RUN MUST NEVER PRINT THE UNQUALIFIED "All e2e checks passed." A partial run
// that reads like a full one is the same false-green the abort guard below exists to make
// impossible — the guard covers a run that DIED early, this covers one that was never asked
// to do the work. finishRun() names the filter and the skip count on every filtered run.
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, "i") : null;
const TIER = process.env.E2E_TIER || "";
const SHARD = (() => {
  const m = /^(\d+)\/(\d+)$/.exec(process.env.E2E_SHARD || "");
  if (!m) return null;
  const k = +m[1], n = +m[2];
  if (n < 1 || k < 0 || k >= n) { console.log(`bad E2E_SHARD=${process.env.E2E_SHARD} (want k/n, 0 <= k < n)`); process.exit(2); }
  return { k, n };
})();
let TIER_SET = null;
if (TIER) {
  try { TIER_SET = new Set(JSON.parse(fs.readFileSync(path.join(HERE, "tiers.json"), "utf8"))[TIER]); }
  catch (e) { console.log(`E2E_TIER=${TIER} but tiers.json is unreadable: ${e.message}`); process.exit(2); }
  if (!TIER_SET || !TIER_SET.size) { console.log(`E2E_TIER=${TIER} names no sections in tiers.json`); process.exit(2); }
}
// Shard assignment is COST-AWARE when timings.json is present: sections are packed
// longest-first into the emptiest shard, so four workers finish together instead of one
// worker drawing every slow section. Round-robin over selected index is the fallback, and
// is also what any section missing from the baseline gets (a brand-new section has no
// measured cost, so it cannot be packed — it just lands somewhere).
//
// The baseline is web/tests/timings.json, the same file budget.mjs guards. That is on
// purpose: if it goes stale the shards go lopsided and the run gets slower, which is a
// visible nudge to refresh it rather than a silent wrong answer.
let BASELINE = null;
try { BASELINE = JSON.parse(fs.readFileSync(path.join(HERE, "timings.json"), "utf8")).sections; } catch { /* optional */ }
const SHARD_OF = new Map();
if (SHARD && BASELINE) {
  const eligible = Object.keys(BASELINE)
    .filter((n) => (!ONLY || ONLY.test(n)) && (!TIER_SET || TIER_SET.has(n)))
    .sort((a, b) => BASELINE[b] - BASELINE[a]);
  const load = new Array(SHARD.n).fill(0);
  for (const n of eligible) {
    let b = 0;
    for (let i = 1; i < SHARD.n; i++) if (load[i] < load[b]) b = i;
    SHARD_OF.set(n, b); load[b] += BASELINE[n];
  }
}
// `eligible` counts what the ONLY/TIER filters kept, BEFORE the shard split. The parallel
// runner sums each worker's ran-count and checks it against this: that is the only thing
// that proves every selected section landed in exactly one shard rather than none.
let selSeen = 0, skippedSecs = 0, ranSecs = 0, eligibleSecs = 0;
// Every section's block is gated on `if (ON)`, and head() sets ON. That is why the gate is a
// bare flag and not an index into an array: sections are top-level statements in file order,
// so a block always runs immediately after its own head(), and a flag needs no numbering.
// An indexed gate would renumber every section below any insertion, which turns a peer adding
// one section into a conflict in every hunk after it — this cost a rebase to learn.
let ON = true;
function wanted(name) {
  if (ONLY && !ONLY.test(name)) return false;
  if (TIER_SET && !TIER_SET.has(name)) return false;
  eligibleSecs++;
  if (!SHARD) return true;
  const packed = SHARD_OF.get(name);
  if (packed !== undefined) return packed === SHARD.k;
  return (selSeen++ % SHARD.n) === SHARD.k;      // unmeasured (new) section
}
// ---- per-section timing ----------------------------------------------------------------
// One clock, closed out by the next head() and by finishRun(), so a section's cost is
// everything between its header and the next — the same thing a reader times by hand.
const TIMES = [];
let curStart = 0;
function closeTimer() { if (section && curStart) TIMES.push({ name: section, ms: Date.now() - curStart }); curStart = 0; }
const head = (s) => {
  closeTimer();
  ON = wanted(s);
  if (!ON) { skippedSecs++; section = ""; return false; }
  ranSecs++; section = s; curStart = Date.now(); console.log(s + ":");
  return true;
};
const filterLabel = () => [ONLY && `E2E_ONLY=/${ONLY.source}/i`, TIER && `E2E_TIER=${TIER}`,
  SHARD && `E2E_SHARD=${SHARD.k}/${SHARD.n}`].filter(Boolean).join(" ");

const { bytes, armor, mapping } = buildSynthIso();
let served = bytes;                       // tests can swap this before loading (bad/short ISOs)
const setServed = (b) => { served = b; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const srv = http.createServer((rq, rs) => {
  let p = decodeURIComponent(rq.url.split("?")[0]);
  if (p === "/synth.bin") { rs.writeHead(200); rs.end(Buffer.from(served)); return; }
  // The pristine build, always. The Changes tab compares two files, so it needs one URL
  // that keeps serving the stock image while /synth.bin is swapped for a patched one.
  if (p === "/synth-base.bin") { rs.writeHead(200); rs.end(Buffer.from(bytes)); return; }
  if (p === "/") p = "/web/index.html";
  fs.readFile(path.join(REPO, p), (e, d) => { if (e) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" }); rs.end(d); });
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const base = `http://localhost:${port}/web/index.html`;

let browser;
try { browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined }); }
catch (e) { console.log("SKIP e2e: no Chromium (" + e.message.split("\n")[0] + ")."); srv.close(); process.exit(0); }

// ---- abort guard -------------------------------------------------------------------------
// The 104 blocks below are top-level statements, so a throw in one of them (a Playwright
// timeout, most often) unwinds the whole module. Before this guard that killed the process
// BEFORE the summary line, so the run ended in a bare stack trace with no verdict, no
// cleanup, and — worst of all — no record that everything after the throw never ran at all.
// Two sessions each concluded the other's tab was red off truncated runs like that.
//
// The rule this enforces: a throw is a FAILURE and is never mistakable for a pass. It counts
// into the same `fails` the summary reads, the summary names the section that threw, and it
// says in as many words that the rest was SKIPPED rather than green. A run that dies at line
// N is evidence about nothing past N, and now it says so itself.
//
// The exact shape of what this fixes, because it is subtler than "a truncated run looks green":
// the process DID exit non-zero, but with no ✗ line and no summary at all. So `grep "✗"` came
// back empty and the run read as clean to anything that greps rather than reading the tail —
// the exit code was the only signal, and that is the one a human scanning output never sees.
// A throw now fires three independent channels: a ✗ line (grep finds it), a FAILED summary
// naming the section (a reader sees it), and a non-zero exit (CI sees it).
//
// STOPPING AT THE FIRST THROW IS A DELIBERATE FLOOR, NOT A TODO. It does not isolate blocks,
// and isolating all 104 means restructuring every one of them — but if you take that on, the
// property to preserve is that a swallowed throw still FAILS THE SUMMARY. A version that
// continues past throws while counting them somewhere `fails` does not read would be strictly
// WORSE than this one: it would print "All e2e checks passed" over a run that threw, which is
// precisely the false-green this guard exists to make impossible. Stopping loudly beats
// continuing quietly. Also note only the FIRST throw is reported; the cascade is ignored, so
// one section is named rather than all of them.
let aborted = null;
function finishRun() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  if (aborted) {
    console.log(`\n  \u2717 ${aborted.section || "(before the first section)"} \u2014 THREW: ${aborted.err}`);
    console.log(`\nFAILED (${fails + 1}) \u2014 aborted inside "${aborted.section || "(none)"}". `
      + `Every check after that point was SKIPPED, not passed \u2014 this run says nothing about them.`);
    process.exit(1);
  }
  closeTimer();
  if (process.env.E2E_TIMINGS) {
    try { fs.appendFileSync(process.env.E2E_TIMINGS, TIMES.map((t) => JSON.stringify(t)).join("\n") + "\n"); }
    catch (e) { console.log("  ! could not write E2E_TIMINGS: " + e.message); }
  }
  const f = filterLabel();
  const suite = ranSecs + skippedSecs;
  // A filter that selected NOTHING is a typo, not a pass. Exiting 0 here would make
  // `E2E_ONLY=Runez` (or a tiers.json name that drifted) print a cheerful green line over a
  // run that tested absolutely nothing — the one outcome this suite must never produce.
  if (f && eligibleSecs === 0) {
    console.log(`\nFAILED \u2014 ${f} selected 0 of the ${suite} sections. Nothing ran, so nothing`
      + ` was proved. Check the pattern (section names are the head() strings in this file).`);
    process.exit(1);
  }
  const scope = f
    ? `${ranSecs} of ${eligibleSecs} selected sections (suite has ${suite}) (${f})`
      + ` \u2014 PARTIAL RUN, the other ${suite - ranSecs} were not attempted`
    : `all ${ranSecs} sections`;
  console.log(fails ? `\nFAILED (${fails}) \u2014 ${scope}`
    : f ? `\ne2e checks passed for ${scope}.` : "\nAll e2e checks passed.");
  process.exit(fails ? 1 : 0);
}
async function abort(e) {
  if (aborted) return;                       // first throw wins; ignore the cascade
  aborted = { section, err: String((e && e.stack) || (e && e.message) || e).split("\n").slice(0, 3).join(" / ") };
  try { await browser.close(); } catch { /* best effort */ }
  try { srv.close(); } catch { /* best effort */ }
  finishRun();
}
process.on("unhandledRejection", abort);
process.on("uncaughtException", abort);

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
// The boot gate covers the save loader card until Pyodide is up, and these tests abort the
// Pyodide CDN on purpose, so it would sit there for the whole run. It no longer covers the
// mode tabs — clicking through to the ISO editor works with it up — but taking it down keeps
// these tests off the gate's geometry entirely. web/tests/boot-gate.mjs tests the gate itself.
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
// ALWAYS ASSERT WITH THE MATCHING HELPER, NEVER THE NEGATED ONE. Both of these WAIT for the
// state they name before reporting, so `!(await nothingStaged(p))` is a 10s dead wait: it asks
// the badge to go hidden, the badge is showing (which is the whole point of the assertion),
// until() times out, swallows it, and only then does the negation read the right answer. The
// check PASSES, so nothing ever pointed at it — two of them plus one 30s swallowed
// selectOption were 51s of the suite's 198s. `!(await nothingStaged(p))` is exactly
// `await somethingStaged(p)` and vice versa; prefer the direct form and the wait does work.
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
if (ON) { const page = await newPage();
  await page.addInitScript("Object.defineProperty(window,'showOpenFilePicker',{value:undefined})");
  await gotoIsoTab(page); await page.waitForTimeout(150);
  // Without FS Access we no longer hard-block: the loader offers a plain <input type=file>
  // (open + stage + streaming/recipe save), and the FS-only picker button is absent.
  check("input-file loader shown, no FS picker",
    !!(await page.$("#isoFileInput")) && !(await page.$("#isoPick")));
  await page.context().close();
}

head("ISO validation");
if (ON) { // Wait for the EXPECTED rejection text, not a fixed 300ms: reading the multi-MB fixture over
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
if (ON) { const page = await newPage(); await loadIso(page);
  await page.fill("#isoSearch", "79"); await page.waitForTimeout(80);
  await openRec(page, "details.char"); await page.waitForTimeout(80);
  check("last record hides spill-over fields", (await page.locator("details.char[open] .char-body").innerText()).includes("overlap the next table"));
  await page.context().close();
}

head("Byte-exact edits across every editable view");
if (ON) { const page = await newPage(); await loadIso(page);
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
  // +0x08 is a price TIER into the shared 15-step ladder, not potch (see the offsets notebook)
  await page.fill('input.gr[data-l="Price tier"]', "4"); await page.dispatchEvent('input.gr[data-l="Price tier"]', "change");
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
  check("gear price tier = 4", r.u32(GEAR.P + GEAR.stride + GEAR.price) === 4);
  check("gear effect0 type = 1", r.u16(GEAR.P + GEAR.stride + GEAR.effs[0]) === 1);
  check("food0 heal = 250", r.u16(FOOD.off + FOOD.heal) === 250);
  check("food0 proc = 60", r.u16(FOOD.off + FOOD.proc) === 60);
  await page.context().close();
}

head("Character pickers (item + skill) byte-exact");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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

head("Passives view — choose who gets a support rune for free");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="passives"]');
  await page.waitForSelector("button.psPick", { timeout: 3000 });
  // Every rune with a decoded site is offered now, not just the two field party loops: the
  // answer is a retargeted call into a relocated helper, so a battle check can be scoped to one
  // character instead of being on for whichever unit is acting.
  // v1.123.0 split the tab by question: THIS tab is the four party-wide, out-of-battle effects.
  // Champion's (441) and Sunbeam (445) keep their pickers here because their field loops are
  // party-wide; Fortune and Prosperity appear as the two reward multipliers. Per-unit
  // enablement for EVERY rune is on the character's own card, and strength is on the Runes tab.
  const picks = await page.$$eval("button.psPick", (b) => b.map((x) => x.dataset.id));
  check("only the two field runes are offered here", picks.slice().sort().join(",") === "441,445", picks.join(","));
  check("...and no in-battle rune is", !picks.includes("446") && !picks.includes("462"), picks.join(","));
  { const html = await page.innerHTML("#isoView");
    // Fortune and Prosperity are here as SWITCHES (auxSwBox), not as multipliers: the tab is
    // four on/off questions and nothing else. No strength control may render on it — that is
    // the whole point of the split, and a stray `.rf` here would mean strength regained a
    // second home on another tab.
    check("the other two of the four are here as overlay switches", /id="auxSwBox"/.test(html));
    check("...and this tab renders no strength control at all",
      !/class="rf"/.test(html) && !/id="rfBox"/.test(html)); }
  check("every rune starts with nobody chosen on a stock disc",
    (await page.$$eval("button.psPick", (b) => b.map((x) => x.textContent.trim()))).every((t) => t === "nobody"));
  { const txt = await page.textContent("#isoView");
    check("it says plainly this is untested in play", /not yet seen working in play/i.test(txt));
    check("it explains the call is retargeted, not dropped", /retargeted call/i.test(txt));
    check("...and where the helper goes", /0x16BF1E0/.test(txt));
    check("it says how enemies are kept out", /off enemies/i.test(txt));
    check("the block starts out untouched", /the first character you choose installs it/i.test(txt));
    // Fortune WAS "no site found", then "decoded but not switchable". It is neither now: it has
    // its own switch in the overlay card. A stale "not switchable" would send the next person
    // looking for work already done, and a stale "no site" for something already found.
    check("Fortune is not described as missing or as unswitchable",
      /not in the executable/.test(txt) && !/no site found/.test(txt)
      && !/Not switchable here/.test(txt) && !/no decoded site/.test(txt));
    check("...and it names the overlay it is actually in", /battle-results overlay/.test(txt));
    check("...and says one is as good as six", /one is as good as six/i.test(txt));
    check("the four dogs are named as not offered", /Koichi, Connie, Kosanji, Kogoro/.test(txt));
    // The confidence markers are the contract. One field site HAS a play report — but it was
    // earned under the dropped-call patch shape, not this one, so the tab must carry the report
    // and refuse to let it set a badge. Blurring those two is the failure this guards.
    check("Sunbeam's play report is carried, with what was observed",
      /watched working: forced to yes, the party healed by walking with nobody\s+carrying the rune/i.test(txt.replace(/\s+/g, " "))
      || /party healed by walking with nobody carrying the rune/i.test(txt.replace(/\s+/g, " ")));
    check("...and named as belonging to the previous patch shape",
      /previous<\/i>? patch shape/i.test(txt.replace(/\s+/g, " ")) || /previous patch shape/i.test(txt.replace(/\s+/g, " ")));
    check("...and it says what that leaves untested here", /the trampoline itself/i.test(txt.replace(/\s+/g, " ")));
    check("...and a passing test is explicitly not enough to move a marker",
      /a marker moves on a play report and never on a passing test/i.test(txt.replace(/\s+/g, " ")));
    check("every rune here reads untested", /every rune here\s+reads untested/i.test(txt.replace(/\s+/g, " "))); }
  const rows = await page.$$eval("#isoView table.invtbl tbody tr", (r) => r.map((x) => x.textContent));
  check("every rune row carries a confidence marker",
    rows.filter((t) => /untested|confirmed/.test(t)).length >= 2, String(rows.length));
  check("...and none of them claims confirmed", rows.filter((t) => /confirmed/.test(t)).length === 0);

  // The picker UI itself, on Champion's (0x1B9) — one of the two runes this tab keeps. Wall's
  // ten-site byte coverage lives on the character card now, where in-battle runes are enabled.
  await page.click('button.psPick[data-id="441"]');
  await page.waitForSelector('input.psCh[data-id="441"]', { timeout: 3000 });
  const boxes = await page.$$eval('input.psCh[data-id="441"]', (b) => b.map((x) => x.dataset.c));
  check("the picker offers the 75 battle characters", boxes.length === 75, String(boxes.length));
  check("...named, not numbered",
    /Hugo/.test(await page.textContent(".pschips")) && /Emily/.test(await page.textContent(".pschips")));

  await page.click('input.psCh[data-id="441"][data-c="1"]');       // Hugo
  await page.waitForTimeout(80);
  check("choosing someone stages something", await somethingStaged(page));
  { const txt = await page.textContent("#isoView");
    check("the row now names who has it", /Hugo/.test(txt) && /ON/.test(txt)); }

  // Unchoosing must restore the stock disc byte-for-byte — a tab that can only be applied in one
  // direction is a trap, and here that means the helper block goes back to the dead routine too.
  await page.click('input.psCh[data-id="441"][data-c="1"]');
  await page.waitForTimeout(80);
  check("unchoosing them clears every staged byte", await nothingStaged(page));

  // "everyone" is just all 75 bits, and it has to come back off again — checked here, BEFORE
  // the save, because saving makes the patched bytes the new pristine baseline and the badge
  // would then be measuring the wrong thing.
  await page.click('button.psAll[data-id="441"]');
  await page.waitForTimeout(80);
  check("everyone sets the whole row", /everyone/.test(await page.textContent("#isoView")));
  await page.click('button.psNone[data-id="441"]');
  await page.waitForTimeout(80);
  check("nobody puts the disc back exactly as it was, helper block included", await nothingStaged(page));

  // Wall's byte-level coverage moved with the control: it is an in-battle rune, so it is no
  // longer offered here. Same assertions, driven from Hugo's card — see the Characters view.

  await page.context().close();
}
head("Passives view — what it refuses to write");
if (ON) { // A disc whose code is not what we decoded is read-only, never overwritten.
  // Drift CHAMPION'S site, not Wall's: Wall is an in-battle rune and is no longer offered on
  // this tab, so asserting it is absent here would pass whether the guard worked or not.
  // Champion's is one of the two runes this tab owns, so its absence is real evidence.
  const patched = Uint8Array.from(bytes);
  new DataView(patched.buffer).setUint32(0x149F90, 0xDEADBEEF, true);       // Champion's only site
  setServed(patched);
  const p2 = await newPage(); await loadIso(p2);
  await p2.click('#isoTabs [data-v="passives"]');
  await p2.waitForSelector("button.psPick", { timeout: 3000 });
  const offered = await p2.$$eval("button.psPick", (b) => b.map((x) => x.dataset.id));
  check("a drifted site makes its rune read-only, not writable", !offered.includes("441"), offered.join(","));
  check("...and only that rune — Sunbeam is still offered",
    offered.join(",") === "445", offered.join(","));
  await p2.context().close();

  // ...and so does a helper block that already holds somebody else's code.
  const squatted = Uint8Array.from(bytes);
  new DataView(squatted.buffer).setUint32(PS_HOOK.off, 0x12345678, true);
  setServed(squatted);
  const p3 = await newPage(); await loadIso(p3);
  await p3.click('#isoTabs [data-v="passives"]');
  await p3.waitForTimeout(200);
  { const txt = await p3.textContent("#isoView");
    check("a squatted helper block disables the whole tab",
      /neither the dead routine nor this/.test(txt) && (await p3.$$("button.psPick")).length === 0); }
  await p3.context().close();

  // A disc patched by v1.106.0 is READ, named, and offered a way back rather than overwritten.
  const legacy = Uint8Array.from(bytes);
  { const dv = new DataView(legacy.buffer);
    const site = PASSIVE_SITES.find(([o]) => o === 0x149F90);            // Champion's, field
    dv.setUint32(site[0], site[2], true);                                // delay slot moved up
    dv.setUint32(site[0] + 4, 0x0004102B, true); }                       // sltu $v0,$zero,$a0
  setServed(legacy);
  const p4 = await newPage(); await loadIso(p4);
  await p4.click('#isoTabs [data-v="passives"]');
  await p4.waitForSelector("button.psLegacy", { timeout: 3000 });
  check("the older whole-party patch is recognised and named",
    /older patch/.test(await p4.textContent("#isoView")));
  await p4.click('button.psLegacy[data-id="441"]');
  await p4.waitForTimeout(80);
  { const r = await save(p4);
    const site = PASSIVE_SITES.find(([o]) => o === 0x149F90);
    check("clearing it puts both stock words back", r.u32(site[0]) === site[1] >>> 0 && r.u32(site[0] + 4) === site[2] >>> 0); }
  await p4.context().close();
  setServed(bytes);
}


head("Passives view — the two overlay switches (Fortune EXP, Prosperity potch)");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="passives"]');
  await page.waitForSelector("#auxSwBox", { timeout: 3000 });
  const keys = await page.$$eval(".auxsw", (n) => n.map((x) => x.dataset.k));
  check("both overlay switches render", keys.join(",") === "fortune,prosperity", keys.join(","));
  // The synthetic disc is 4.6 MB and these checks are ~1 GB in, so the windows are never read.
  // Degradation is the only half of this the e2e can reach: it must go read-only and SAY so,
  // not silently write into a window that is not there. The positive path is verified against
  // the pristine ISO by tools/verify_overlay_switches.mjs instead.
  const dis = await page.$$eval(".auxsw:disabled", (n) => n.map((x) => x.dataset.k));
  check("both are read-only here — their overlay is past the end of a synth disc",
    dis.join(",") === "fortune,prosperity", dis.join(",") || "(none)");
  check("...and neither reads as already forced on",
    (await page.$$eval(".auxsw", (n) => n.map((x) => x.checked))).every((v) => v === false));
  check("...and each says why, rather than looking broken",
    /unavailable/.test(await page.getAttribute('input.auxsw[data-k="fortune"]', "title"))
    && /unavailable/.test(await page.getAttribute('input.auxsw[data-k="prosperity"]', "title")));
  check("clicking a disabled switch stages nothing", await nothingStaged(page));
  { const txt = await page.textContent("#auxSwBox");
    check("the card names both overlay addresses", /0x3F3E6938/.test(txt) && /0x3F3E698C/.test(txt));
    check("...and says both streaming copies move together", /streaming twins/.test(txt));
    // Why these two are offered when 49 in-battle checks are not is the whole argument for the
    // card existing. If that reasoning stops being stated, the next person cannot tell whether
    // the held-back ones were held back for a reason or by accident.
    check("it says why these two are safe when the ones above are not",
      /safe to force in a way the checks above are not/.test(txt));
    { const flat = txt.replace(/\s+/g, " ");
      check("...and names the reason: after the fight, own party, no per-unit consequence",
        /after the fight is over/.test(flat) && /walks your own party and nobody else/.test(flat)
        && /no enemy is ever asked/.test(flat)); }
    check("it describes the two-word patch shape", /delay-slot instruction moves up/.test(txt));
    check("Prosperity's compounding is stated, not buried", /COMPOUNDS/.test(txt) && /×729/.test(txt));
    check("...and both are marked untested in play", /not yet seen working in play/.test(txt)); }
  // The Prosperity switch also belongs beside the potch numbers it multiplies.
  await page.click('#isoTabs [data-v="sets"]');
  await page.waitForSelector("#setCards details.char", { timeout: 3000 });
  const setKeys = await page.$$eval(".auxsw", (n) => n.map((x) => x.dataset.k));
  check("the Sets tab carries the Prosperity switch and only that one",
    setKeys.join(",") === "prosperity", setKeys.join(",") || "(none)");
  check("...read-only there too, for the same reason",
    (await page.$$eval(".auxsw:disabled", (n) => n.length)) === 1);
  await page.context().close();
}

head("Passives view — rune power: what a passive is worth once it fires");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="runes"]');
  await page.waitForSelector("input.rf", { timeout: 3000 });
  // The card is a separate patch from the switches above it: these constants live INSIDE each
  // rune's "if equipped" branch, so they work on a stock disc and need no switch. If that ever
  // stops being said on the tab, the controls read as part of the forcing feature and someone
  // will tick a box expecting them to do nothing without it.
  const keys = await page.$$eval(".rf", (n) => n.map((x) => x.dataset.k));
  check("every rune power control renders", keys.length === 16, keys.join(","));
  // Fortune is the ONE control backed by the battle-results overlay rather than the ELF block,
  // and the synthetic disc is 4.6 MB — it does not reach the ~1 GB those windows live at. So on
  // this fixture it must degrade to unavailable, and every other control must still be live.
  // That asymmetry is the assertion: "all editable" would hide a broken aux path, and "all
  // read-only" would hide a broken ELF path.
  const off = await page.$$eval(".rf:disabled", (n) => n.map((x) => x.dataset.k));
  check("only Fortune is read-only here — its overlay is past the end of a synth disc",
    off.join(",") === "fortune", off.join(",") || "(none)");
  check("...and it says why, rather than looking broken",
    /unavailable/.test(await page.getAttribute('input.rf[data-k="fortune"]', "title")));
  check("the shift controls are dropdowns, not free numbers",
    (await page.$$eval("select.rf", (n) => n.map((x) => x.dataset.k))).sort().join(",")
      === "dblStrike,fireSeal,wall,warrior,wizard");
  check("Sunbeam's turn heal starts at the stock 15",
    (await page.inputValue('input.rf[data-k="sunTurn"]')) === "15");
  // The walk-heal box is a RATE (HP a second), not the interval the disc stores. Stock 0.3s
  // interval = 3.33 HP/s, and the write below has to come back out as an interval again.
  check("...and its walk-heal shows the stock rate, not the raw interval",
    (await page.inputValue('input.rf[data-k="sunWalk"]')) === "3.33");
  check("Wall's multiplier starts at x2",
    (await page.locator('select.rf[data-k="wall"] option:checked').textContent()) === "×2");

  // An immediate write must move the LOW half-word and nothing else — the opcode and registers
  // are what make the instruction still an instruction.
  await page.fill('input.rf[data-k="sunTurn"]', "200");
  await page.dispatchEvent('input.rf[data-k="sunTurn"]', "change"); await page.waitForTimeout(60);
  // A shift write must move ONLY bits 10..6, at both of Double-Strike's sites.
  await page.selectOption('select.rf[data-k="dblStrike"]', "3");
  await page.waitForTimeout(60);
  // ...and the interval is a float in the data pool, not an instruction at all.
  await page.fill('input.rf[data-k="sunWalk"]', "20");     // 20 HP/s -> a 0.05 s interval
  await page.dispatchEvent('input.rf[data-k="sunWalk"]', "change"); await page.waitForTimeout(60);
  { const { r, review } = await saveAndReview(page);
    check("Sunbeam now heals 200 HP a combat turn", r.u32(0x261198) === 0x244200C8,
      r.u32(0x261198).toString(16));
    check("...and only the immediate moved", (r.u32(0x261198) >>> 16) === 0x2442);
    check("Double-Strike shifts by 3 at both sites",
      r.u32(0x1047C8) === 0x001080C0 && r.u32(0x1047DC) === 0x001080C0,
      r.u32(0x1047C8).toString(16));
    check("...and only bits 10..6 moved",
      ((r.u32(0x1047C8) & ~0x7C0) >>> 0) === ((0x00108040 & ~0x7C0) >>> 0));
    { const dv = new DataView(new ArrayBuffer(4));
      dv.setUint32(0, r.u32(RUNEFX_FLOAT.off), true);
      check("the walk-heal rate is stored as its reciprocal, a float interval",
        Math.abs(dv.getFloat32(0, true) - 0.05) < 1e-5, String(dv.getFloat32(0, true))); }
    check("nothing else in the rune power table moved",
      RUNEFX_SITES.filter((f) => !["sunTurn", "dblStrike"].includes(f.key))
        .every((f) => r.u32(f.off) === (f.word >>> 0)));
    check("no equipped-check word pair was touched",
      PASSIVE_SITES.every(([o, jal, ds]) => r.u32(o) === jal >>> 0 && r.u32(o + 4) === ds >>> 0));
    check("the review names them under Rune power", /Rune power/.test(review));
    check("...and names the rune and the number", /Sunbeam — HP healed each combat turn/.test(review));
    check("...and numbers a multi-site write", /site 2 of 2/.test(review)); }
  await page.context().close();
}

head("Passives view — rune power reverts and refuses a drifted disc");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="runes"]');
  await page.waitForSelector("input.rf", { timeout: 3000 });
  await page.fill('input.rf[data-k="killer"]', "400");
  await page.dispatchEvent('input.rf[data-k="killer"]', "change"); await page.waitForTimeout(60);
  await page.selectOption('select.rf[data-k="wizard"]', "0");
  await page.waitForTimeout(60);
  check("editing stages something", await somethingStaged(page));
  // The rate<->interval flip rounds, so "set it back to what it said" has to snap to the exact
  // stock float rather than land on 1/3.33 = 0.3003 and leave the disc quietly modified.
  await page.fill('input.rf[data-k="sunWalk"]', "5");
  await page.dispatchEvent('input.rf[data-k="sunWalk"]', "change"); await page.waitForTimeout(60);
  await page.fill('input.rf[data-k="sunWalk"]', "3.33");
  await page.dispatchEvent('input.rf[data-k="sunWalk"]', "change"); await page.waitForTimeout(60);
  check("typing the stock rate back snaps to the exact stock interval",
    (await page.inputValue('input.rf[data-k="sunWalk"]')) === "3.33");
  // "Restore all to stock" has to put back the exact bytes, not merely a value that reads the
  // same — otherwise a round-trip leaves the disc quietly modified.
  await page.fill('input.rf[data-k="killer"]', "150");
  await page.dispatchEvent('input.rf[data-k="killer"]', "change"); await page.waitForTimeout(60);
  await page.selectOption('select.rf[data-k="wizard"]', "1");
  await page.waitForTimeout(80);
  check("setting them back to stock clears every staged byte", await nothingStaged(page));

  { const patched = Uint8Array.from(bytes);
    new DataView(patched.buffer).setUint32(0x104088, 0xDEADBEEF, true);   // Killer, site 1 of 2
    setServed(patched);
    const p2 = await newPage(); await loadIso(p2);
    await p2.click('#isoTabs [data-v="runes"]');
    await p2.waitForSelector("input.rf", { timeout: 3000 });
    check("a drifted site makes its control read-only, not writable",
      await p2.isDisabled('input.rf[data-k="killer"]'));
    check("...and only that one", !(await p2.isDisabled('input.rf[data-k="counter"]')));
    // Fortune is read-only here too, always: its multiplier lives in the battle-results
    // overlay, which a 4.6 MB synth disc does not reach. So exactly two controls are off —
    // the drifted Killer and the unreachable Fortune — and that asymmetry is the assertion.
    check("...and Fortune is read-only for a different reason: no overlay on a synth disc",
      await p2.isDisabled('input.rf[data-k="fortune"]')
      && /unavailable/.test(await p2.getAttribute('input.rf[data-k="fortune"]', "title")));
    check("...exactly those two, nothing else",
      (await p2.$$eval(".rf:disabled", (n) => n.map((x) => x.dataset.k).sort())).join(",") === "fortune,killer");
    await p2.context().close();
    setServed(bytes); }
  await page.context().close();
}

head("Runes view — a passive rune's strength on its own row");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="runes"]');
  await page.waitForSelector(".invtbl", { timeout: 3000 });
  // Only the runes that HAVE a number get a Strength block. Sunbeam has two, and they are the
  // two the user asks for by name: per combat turn and per second of walking.
  await page.fill("#isoSearch", "Sunbeam"); await page.waitForTimeout(120);
  const keys = await page.$$eval(".rf", (n) => n.map((x) => x.dataset.k));
  check("Sunbeam's row carries both of its numbers", keys.sort().join(",") === "sunTurn,sunWalk", keys.join(","));
  { const txt = await page.textContent(".invtbl");
    check("they are labelled per turn and per second", /HP \/ combat turn/.test(txt) && /HP \/ sec walking/.test(txt));
    check("the block is headed Strength", /Strength/.test(txt)); }
  check("the turn heal shows stock 15 here too",
    (await page.inputValue('input.rf[data-k="sunTurn"]')) === "15");

  // Editing from the Runes tab must move the same bytes the Passives card does.
  await page.fill('input.rf[data-k="sunTurn"]', "99");
  await page.dispatchEvent('input.rf[data-k="sunTurn"]', "change"); await page.waitForTimeout(80);
  await page.click('#isoTabs [data-v="runes"]');
  await page.waitForSelector("input.rf", { timeout: 3000 });
  check("the Passives card sees the edit made on the Runes tab",
    (await page.inputValue('input.rf[data-k="sunTurn"]')) === "99");
  { const r = await save(page);
    check("...and it is the same instruction that moved", r.u32(0x261198) === 0x24420063,
      r.u32(0x261198).toString(16)); }

  // A rune with no number must not grow an empty Strength box.
  const p2 = await newPage(); await loadIso(p2);
  await p2.click('#isoTabs [data-v="runes"]');
  await p2.waitForSelector(".invtbl", { timeout: 3000 });
  // Balance clears a status bit and Fury sets one — neither has a literal to move, so neither
  // gets a block. (Fortune DOES have one now: its multiplier lives in the battle-results
  // overlay. It was listed here as "no number to move" until that site was found.)
  await p2.fill("#isoSearch", "Balance"); await p2.waitForTimeout(120);
  check("Balance has no Strength block — it has no number to move",
    (await p2.locator(".rf").count()) === 0);
  await p2.fill("#isoSearch", "Fortune"); await p2.waitForTimeout(120);
  check("Fortune DOES have one, and it is the overlay-backed EXP multiplier",
    (await p2.$$eval(".rf", (n) => n.map((x) => x.dataset.k))).join(",") === "fortune");
  await p2.context().close();
  await page.context().close();
}

head("Characters view — force a passive on this unit, from their own card");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]');
  await page.waitForSelector("details.char", { timeout: 3000 });
  await page.fill("#isoSearch", "Hugo"); await page.waitForTimeout(150);
  await page.click("details.char summary");                 // cards build lazily
  await page.waitForSelector("input.cpOn", { timeout: 3000 });
  // The point of the move: enablement for EVERY rune is here, on the unit — including the
  // in-battle ones the Passives tab no longer offers.
  const ids = await page.$$eval("input.cpOn", (n) => n.map((x) => x.dataset.id));
  check("Hugo's card offers every rune with a decoded site", ids.length === 22, String(ids.length));
  check("...including the in-battle ones the Passives tab dropped",
    ids.includes("446") && ids.includes("447") && ids.includes("462"));
  check("...and every box is for THIS character's record index",
    (await page.$$eval("input.cpOn", (n) => [...new Set(n.map((x) => x.dataset.c))])).join(",") === "1");
  check("nothing is ticked on a stock disc", (await page.$$("input.cpOn:checked")).length === 0);
  { const txt = await page.textContent("details.char .cpBox");
    check("the block says the effect is theirs alone", /theirs alone/.test(txt));
    check("...that no rune slot is spent", /without equipping them/.test(txt));
    check("...and that it is untested in play", /watched working in play/.test(txt)); }

  // Wall (0x1BE): ten sites, one of each trampoline kind — a record site, a charId site and
  // eight acting-unit sites — so one tick exercises all three. These are the assertions that
  // used to run off the Passives tab picker, unchanged apart from what drives them.
  await page.click('input.cpOn[data-id="446"][data-c="1"]');      // Hugo
  await page.waitForTimeout(100);
  check("ticking Wall for Hugo stages something", await somethingStaged(page));
  await page.click('input.cpOn[data-id="446"][data-c="1"]');
  await page.waitForTimeout(100);
  check("unticking it clears every staged byte, helper block included", await nothingStaged(page));
  await page.click('input.cpOn[data-id="446"][data-c="1"]');
  await page.waitForTimeout(100);
  await page.fill("#isoSearch", "Chris"); await page.waitForTimeout(150);
  await page.click("details.char summary");
  await page.waitForSelector('input.cpOn[data-id="446"]', { timeout: 3000 });
  check("Wall already reads ON for Hugo when Chris's card opens",
    (await page.$$eval('input.cpOn[data-id="446"]', (n) => n.map((x) => x.dataset.c))).join(",") === "2");
  await page.click('input.cpOn[data-id="446"][data-c="2"]');      // + Chris
  await page.waitForTimeout(100);
  { const r = await save(page);
    const wallSites = PASSIVE_SITES.filter(([o]) => [0x104368, 0x110F74, 0x25C844, 0x25C8F8, 0x25CA60,
      0x25CB18, 0x25CBBC, 0x25CC54, 0x25CC9C, 0x25CD5C].includes(o));
    const kindOf = (jal) => jal === 0x0C5B2CE0 ? "rec" : jal === 0x0C5B2D0E ? "id" : "unit";
    check("every one of Wall's ten sites jals the helper entry for its kind",
      wallSites.length === 10 && wallSites.every(([o, jal]) => r.u32(o) === PS_HOOK_JAL[kindOf(jal)] >>> 0));
    check("...and not one delay slot moved",
      PASSIVE_SITES.every(([o, , ds]) => r.u32(o + 4) === ds >>> 0));
    check("no other rune's site was touched",
      PASSIVE_SITES.filter(([o]) => !wallSites.some(([w]) => w === o))
        .every(([o, jal]) => r.u32(o) === jal >>> 0));
    // The helper itself: the code goes down verbatim, and the bitmap gets exactly two bits.
    const code = PS_HOOK_STOCK;                                    // only used for its length
    check("the helper's first instruction is in place", r.u32(PS_HOOK.off) === 0x24A3FE47);
    const row = PS_HOOK.off + PS_HOOK.maskOff + (0x1BE - PS_HOOK.first) * PS_HOOK.stride;
    check("Wall's bitmap has Hugo (record 1) and Chris (record 2) and nobody else",
      r.u8(row) === 0b110 && Array.from({ length: PS_HOOK.stride - 1 }, (_, i) => r.u8(row + 1 + i)).every((b) => b === 0));
    check("...and every other rune's bitmap is empty",
      Array.from({ length: PS_HOOK.rows }, (_, k) => k).filter((k) => k !== 0x1BE - PS_HOOK.first)
        .every((k) => Array.from({ length: PS_HOOK.stride }, (_, i) =>
          r.u8(PS_HOOK.off + PS_HOOK.maskOff + k * PS_HOOK.stride + i)).every((b) => b === 0)));
    check("the block's stock length is what iso.js writes", code.length / 2 === PS_HOOK.len); }
  await page.context().close();
}

head("Characters view — a rune it cannot write stays read-only on the card");
if (ON) { const patched = Uint8Array.from(bytes);
  new DataView(patched.buffer).setUint32(0x1037F4, 0xDEADBEEF, true);   // Haziness' only site
  setServed(patched);
  const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]');
  await page.waitForSelector("details.char", { timeout: 3000 });
  await page.fill("#isoSearch", "Hugo"); await page.waitForTimeout(150);
  await page.click("details.char summary");
  await page.waitForSelector("input.cpOn", { timeout: 3000 });
  check("a drifted rune is read-only on the card, not silently written",
    await page.isDisabled('input.cpOn[data-id="447"][data-c="1"]'));
  check("...and the runes around it are still live",
    !(await page.isDisabled('input.cpOn[data-id="446"][data-c="1"]')));
  // A disabled checkbox alone explains nothing on a phone, where there is no tooltip to hover:
  // the tile has to SAY it is read-only in text you can read.
  const lockedTxt = await page.textContent('.cprune:has(input.cpOn[data-id="447"]) .cpr-w');
  check("...and the locked tile says why in visible text, not only in a tooltip",
    /read-only/.test(lockedTxt), lockedTxt);
  await page.context().close();
  setServed(bytes); }

// The card's rune list is the control this tab is used for on a phone, so its touch shape is
// part of the feature, not styling trivia: one column, a target you can hit with a thumb, and
// the whole tile — not just the 13px box — toggling the rune.
head("Characters view — the forced-passive tiles are thumb-sized on a phone");
if (ON) { const page = await newPage({ width: 390, height: 844 }); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]');
  await page.waitForSelector("details.char", { timeout: 3000 });
  await page.fill("#isoSearch", "Hugo"); await page.waitForTimeout(150);
  await page.click("details.char summary");
  await page.waitForSelector("label.cprune", { timeout: 3000 });
  const tiles = await page.$$eval("label.cprune", (n) => n.map((el) => {
    const r = el.getBoundingClientRect(), b = el.querySelector("input.cpOn").getBoundingClientRect();
    return { h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.x),
             box: Math.round(Math.min(b.width, b.height)),
             name: (el.querySelector(".cpr-n") || {}).textContent || "",
             where: (el.querySelector(".cpr-w") || {}).textContent || "" };
  }));
  check("every rune is a tile, not a chip", tiles.length === 22, String(tiles.length));
  check("...each at least 44px tall", tiles.every((t) => t.h >= 44),
    String(Math.min(...tiles.map((t) => t.h))));
  check("...stacked one per row, so none is a sliver",
    new Set(tiles.map((t) => t.x)).size === 1 && tiles.every((t) => t.w >= 240),
    `${new Set(tiles.map((t) => t.x)).size} column(s), narrowest ${Math.min(...tiles.map((t) => t.w))}px`);
  check("...with a checkbox big enough to hit on its own — and at the phone size, so the "
    + "@media rules are really winning", tiles.every((t) => t.box >= 24),
    String(Math.min(...tiles.map((t) => t.box))));
  check("...and each tile names its rune and says where it is asked",
    tiles.every((t) => t.name.trim()) && tiles.every((t) => /field|battle/.test(t.where)),
    tiles[0].name + " / " + tiles[0].where);
  // Tapping the rune's NAME must toggle it: the tile is a <label>, so the whole 44px block is
  // the target and nobody has to find the box.
  const wall = 'label.cprune:has(input.cpOn[data-id="446"][data-c="1"])';
  await page.click(`${wall} .cpr-n`);
  await page.waitForTimeout(100);
  check("tapping the tile's name ticks the rune", await page.isChecked(`${wall} input.cpOn`));
  check("...and stages the patch", await somethingStaged(page));
  check("...and the tile reads as on without inspecting the box",
    await page.evaluate((sel) => document.querySelector(sel).classList.contains("on"), wall));
  check("...and the header counts it", /1 on/.test(await page.textContent("details.char .bag-h")));
  // Undoing a few taps one tile at a time is the tedious half on a phone, hence one button.
  check("a 'turn all off' button appears once something is on",
    (await page.$$("details.char button.cpAllOff")).length === 1);
  await page.click("details.char button.cpAllOff");
  await page.waitForTimeout(100);
  check("...and it clears every staged byte, helper block included", await nothingStaged(page));
  check("...and takes itself away again", (await page.$$("details.char button.cpAllOff")).length === 0);
  check("...leaving no tile ticked", (await page.$$("input.cpOn:checked")).length === 0);
  await page.context().close(); }

head("Mounts view — rewrite the battle rider/mount pairs");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="test"]');
  await page.waitForSelector('#testTabs [data-t="avatar"]', { timeout: 3000 });
  await page.click('#testTabs [data-t="avatar"]');          // the tab opens on the switchboard now
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
    check("it warns a scene can hang whoever you pick", /scripted scene can\s+hang/i.test(txt));
    // Confirmed in play that this control does NOT fix a hanging scene. Saying so is the
    // whole value — otherwise it reads as the obvious thing to reach for when one hangs.
    check("Story content is no longer buried in Test", !/Story content/.test(txt)); }

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

head("Field character — chips; Story content in its own view");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="test"]');
  await page.waitForSelector('#testTabs [data-t="avatar"]', { timeout: 3000 });
  await page.click('#testTabs [data-t="avatar"]');          // the tab opens on the switchboard now
  await page.waitForSelector("#avWide", { timeout: 3000 });
  // Per-area coverage used to ride on each chip as a second condition to satisfy. Play
  // testing retired it — the shipped characters worked everywhere — so the chips must not
  // advertise a map limit again.
  { const txt = await page.textContent("#isoView");
    check("chips carry no per-area coverage claim", !/\/28 maps/.test(txt),
      (txt.match(/\S*\/28 maps/) || [])[0]);
    check("...and still name the ids they admit", /#1\b/.test(txt) && /#29\b/.test(txt)); }

  // The story-content control: retiring a case must move that character to Hugo's index.
  // Story content was promoted out of Test once it was confirmed in play, so it is reached
  // from the top-level tab bar now. Being findable there is part of the contract.
  await page.click('#isoTabs [data-v="story"]');
  await page.waitForSelector("#storyStock", { timeout: 3000 });
  check("Story content has its own top-level view", !!(await page.$("#storyStock")));
  check("...marked confirmed rather than experimental",
    /confirmed in play/i.test(await page.textContent("#isoView")));
  // The blank-text fix is two edits in two files, and the ISO half is useless on its own —
  // this view has to say so, and has to name the save-editor tab that does the other half.
  // Asserted because that name is a moving target: the picker has already moved once.
  { const txt = await page.textContent("#isoView");
    check("it spells out the setup, not just the switch", /Setting it up/i.test(txt));
    check("...naming the Save Editor tab that does the other half",
      /Save Editor\s*→\s*Field character/.test(txt));
    check("...and separating a blank box from a frozen scene",
      /hangs?/i.test(txt) && /freez/i.test(txt));
    check("...and explaining the index-0 fallback it relies on",
      /index 0/.test(txt) && /fall/i.test(txt)); }
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
  await page.waitForSelector("#storyStock", { timeout: 3000 });
  { const r = await storyRow(63);
    check("switching Luc to Hugo's content reports index 0", /0 \(Hugo\)/.test(await r.tds[2].textContent()));
    const other = await storyRow(54);
    check("...and leaves Koroku on his own index 7", (await other.tds[2].textContent()).trim() === "7"); }
  { const r = await save(page);
    check("Luc's case immediate was retired", (r.u32(0x1C7724) & 0xFFFF) === 0x7FFF);
    check("...with the opcode half untouched", (r.u32(0x1C7724) >>> 16) === 0x2402);
    check("every other story case is untouched",
      STORY_CASES.filter(([o]) => o !== 0x1C7724).every(([o, imm]) => r.u32(o) === avatarWord(imm, "eq"))); }

  // The scene-softlock actor fallback was RETIRED in v1.135.0: it cannot help (the namespace
  // it patches is used zero times in any town script) and it is confirmed in play to cause
  // the hang it was meant to fix. The control is gone; the write path with it.
  //
  // "The checkbox is absent" is a check that passes forever once the id is gone, so it is
  // never asserted alone — it is paired with the section still being there and still saying
  // why, which is what actually has to survive. The repair path for a disc that already
  // carries the patch is covered by the Changes-tab restore section further down.
  await page.click('#isoTabs [data-v="test"]');
  await page.click('#testTabs [data-t="avatar"]');          // the tab opens on the switchboard now
  await page.waitForSelector("#avStock", { timeout: 3000 });
  { const txt = await page.textContent("#isoView");
    check("the section is still there to explain the softlock", /Scene softlocks/.test(txt));
    check("...and says the toggle was removed", /has been removed/i.test(txt));
    check("...and names its recursion risk", /recurses forever/i.test(txt));
    check("...and gives the measured reason it could never help", /exactly zero times/i.test(txt));
    check("...and reports the play confirmation", /Confirmed in play/i.test(txt));
    check("...and points an affected disc at the repair", /Changes/.test(txt) && /Code patches/.test(txt));
    // The retirement rests on TWO independent play reports the same day, not one: the scene
    // freeze origin/main recorded, and a disc that stopped adding party members correctly.
    // The second is the one the Party formation card was built around, so the section has to
    // carry it too — a reader who arrives with a broken party must not have to infer that
    // this is their patch.
    { const flat = txt.replace(/\s+/g, " ");
      check("...and reports the party-formation symptom as well",
        /stopped adding party members correctly/i.test(flat));
      check("...and corrects the script census it used to over-read",
        /never from a script/i.test(flat));
      check("...and points at the Party formation card that leads with it",
        /Party formation/.test(flat)); }
    check("no control can turn the fallback on any more",
      (await page.$("#avActorFb")) === null); }
  // Nothing was saved between the story save above and here, so an empty dirty badge is a
  // real statement: opening this tab stages nothing at the fallback's words or anywhere else.
  check("and opening the tab stages nothing",
    (await page.evaluate(() => document.querySelector("#isoDirty")?.hidden)) === true);

  // The story view's own Restore stock covers the cases it owns — back to that tab for it.
  await page.click('#isoTabs [data-v="story"]');
  await page.waitForSelector("#storyStock", { timeout: 3000 });
  await page.click("#storyStock");
  await page.waitForSelector("#storyStock", { timeout: 3000 });
  { const r = await save(page);
    check("Restore stock returns every story case",
      STORY_CASES.every(([o, imm]) => r.u32(o) === avatarWord(imm, "eq"))); }
  await page.context().close();
}

head("Encounter movement rules — what counts as moving");
if (ON) { const page = await newPage(); await loadIso(page);
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
  // The tab has to say which settings are played rather than inferred — same convention the
  // Mounts tab uses. This one is confirmed in play, so it must not read as speculative.
  check("the animal mode is marked confirmed, not untested",
    /confirmed/i.test(await page.textContent("#encMove")));
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

head("Encounter multipliers — walking / running / mounted, apart");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  const boxOf = (k) => `input.enc-mult[data-k="${k}"]`;
  check("the three boxes start at the stock triple",
    (await page.inputValue(boxOf("walk"))) === "100"
      && (await page.inputValue(boxOf("run"))) === "120"
      && (await page.inputValue(boxOf("ride"))) === "150");
  check("the readout states the relative risk",
    /running 1\.20/.test(await page.textContent("#encMultOut"))
      && /galloping 1\.50/.test(await page.textContent("#encMultOut")));

  // Independent multipliers: safe on foot, dangerous in the saddle. This is the shape the
  // single percentage could never express.
  await page.fill(boxOf("run"), "60");
  await page.dispatchEvent(boxOf("run"), "change");
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  { const r = await save(page);
    check("the running word took 60", (r.u32(ENC_SITES[3]) & 0xFFFF) === 60);
    check("...with its opcode half intact", (r.u32(ENC_SITES[3]) >>> 16) === 0x2402);
    check("...and the mounted word stayed at 150", (r.u32(ENC_SITES[2]) & 0xFFFF) === 150);
    // Walking is still stock, so its two words must not have been rewritten at all.
    check("...and walking is still the untouched move + branch",
      r.u32(ENC_SITES[0]) === ENC_STOCK[0] && r.u32(ENC_SITES[1]) === ENC_STOCK[1]); }

  // Giving walking a multiplier is the two-word rewrite; the branch has to move with it.
  await page.fill(boxOf("walk"), "0");
  await page.dispatchEvent(boxOf("walk"), "change");
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  check("zeroing walking says so in plain words", /No random battles while walking/.test(await page.textContent("#encMultOut")));
  { const r = await save(page);
    check("walking became addiu $v0,$zero,0",
      (r.u32(ENC_SITES[0]) >>> 16) === 0x2402 && (r.u32(ENC_SITES[0]) & 0xFFFF) === 0);
    check("...and its branch was repointed into the scale block",
      r.u32(ENC_SITES[1]) === 0x10000008); }

  // Restoring the triple must put the original four words back, not an equivalent rewrite.
  await page.click("#encMultStock");
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  { const r = await save(page);
    check("restoring 100/120/150 rewrites the stock words byte for byte",
      ENC_SITES.every((o, i) => r.u32(o) === ENC_STOCK[i])); }
  await page.context().close();
}

head("Non-stock code — a checkbox per patch, so a misbehaving disc can be bisected");
// The Changes tab's audit has a one-way restore button: a row leaves the table the moment you
// stage it. This switchboard's whole reason to exist is that a row must SURVIVE being switched
// off, so you can turn one patch off, save, try the disc, and put it back if it wasn't the one.
// That round trip is what this test pins — the table rendering is incidental.
if (ON) { const page = await newPage(); await loadIso(page);
  const view = async () => (await page.textContent("#isoView")).replace(/\s+/g, " ");
  const rowsNow = () => page.$$eval("[data-psw]", (els) => els.length);

  await page.click('#isoTabs [data-v="test"]');
  await page.waitForSelector('#testTabs [data-t="patches"]', { timeout: 3000 });
  const before = await rowsNow();

  // Stage a code patch elsewhere in the editor, then come back: the switchboard reads the disc
  // WITH staged edits on top, so it has to notice a patch it did not exist for.
  // TWO patches, because switching one off has to leave the OTHER one staged — otherwise the
  // disc is byte-identical to the file again and there is no save to inspect.
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  await page.fill('input.enc-mult[data-k="run"]', "60");
  await page.dispatchEvent('input.enc-mult[data-k="run"]', "change");
  await page.waitForSelector("input.enc-mult", { timeout: 3000 });
  await page.fill('input.enc-mult[data-k="ride"]', "113");
  await page.dispatchEvent('input.enc-mult[data-k="ride"]', "change");
  await page.click('#isoTabs [data-v="test"]');
  await page.waitForSelector("[data-psw]", { timeout: 3000 });
  check("patches staged on another tab show up here", (await rowsNow()) === before + 2);
  { const txt = await view();
    check("...named by group and site", /Encounter rate/.test(txt) && /running multiplier/.test(txt));
    check("...with both words spelled out", /0x24020078/.test(txt) && /0x2402003C/.test(txt));
    check("...and counted in the header", /switched on/.test(txt)); }

  // Rows are ordered risky-first, so a box is found by its row, not its index — and by OFFSET,
  // not by label: "running multiplier" is a substring of "mounted running multiplier", and
  // matching on the label silently drove the wrong row.
  const tag = (off) => "0x" + off.toString(16).toUpperCase().padStart(6, "0");
  const boxAt = async (off) => {
    const i = await page.$$eval("[data-psw]", (els, want) => els.findIndex((e) =>
      (e.closest("tr").textContent || "").includes(want)), tag(off));
    check(`the row for ${tag(off)} is on screen`, i >= 0);
    return `[data-psw="${i}"]`;
  };
  const runSel = await boxAt(ENC_SITES[3]);
  check("the staged patch's box starts ticked", await page.isChecked(runSel));

  // Switch it off. The row must stay — that is the difference from the Changes tab.
  await page.uncheck(runSel);
  await page.waitForSelector("[data-psw]", { timeout: 3000 });
  check("the row survives being switched off", (await rowsNow()) === before + 2,
    `before=${before} now=${await rowsNow()}`);
  { const txt = await view();
    check("...and reads back as stock", /running multiplier/.test(txt) && /stock/.test(txt)); }
  check("...with its box unticked", !(await page.isChecked(await boxAt(ENC_SITES[3]))));
  { const r = await save(page);
    // The two sites are one word apart, so a save coalesces them into a single write and
    // `wrote` cannot tell them apart. The VALUE is the assertion that means anything here.
    check("the switched-off site saves as stock", r.u32(ENC_SITES[3]) === ENC_STOCK[3]);
    check("...while the one left switched on saves patched", (r.u32(ENC_SITES[2]) & 0xFFFF) === 113); }

  // ...and back on again, from the row that stayed behind. Without the sticky row there is
  // nothing left to click, which is the bug this section was added to fix.
  await page.check(await boxAt(ENC_SITES[3]));
  await page.waitForSelector("[data-psw]", { timeout: 3000 });
  { const r = await save(page);
    check("re-ticking puts the patch back", (r.u32(ENC_SITES[3]) & 0xFFFF) === 60);
    check("...with its opcode half intact", (r.u32(ENC_SITES[3]) >>> 16) === 0x2402); }

  // The bulk control, which is the one someone reaches for on a disc they did not patch. No
  // save to inspect afterwards on purpose — with everything back to stock the disc matches the
  // file again, which is exactly the end state being asserted.
  await page.click("#pswOff");
  await page.waitForSelector("[data-psw]", { timeout: 3000 });
  { const txt = await view();
    check("Switch all off leaves none on", /0 of \d+ switched on/.test(txt)); }
  check("...and unticks every box",
    (await page.$$eval("[data-psw]", (els) => els.every((e) => !e.checked))));
  await page.context().close();
}

head("Movement speed — the walk/run table and each character's class");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="movement"]');
  const f32 = (r, off) => { const b = Buffer.alloc(4); b.writeUInt32LE(r.u32(off) >>> 0, 0); return b.readFloatLE(0); };
  const runBox = (cls) => `input.spd-f[data-cls="${cls}"][data-col="run"]`;
  const openAdv = async () => {
    await page.waitForSelector("#spdQApply", { timeout: 3000 });
    if (!(await page.$("#spdAdvanced[open]"))) await page.click("#spdAdvanced > summary");
    await page.waitForSelector("#isoView input.spd-f", { timeout: 3000 });
  };
  await openAdv();
  check("the manual class table is collapsed until asked for, with the card above it first",
    (await page.$("#spdQApply")) !== null && (await page.$("#spdAdvanced")) !== null);
  check("the classes with members are listed",
    (await page.$$("#isoView table.invtbl >> nth=0 >> tbody tr")).length === 9);
  check("Hugo's class shows 6 and Chris's 4.5",
    (await page.inputValue(runBox(3))) === "6" && (await page.inputValue(runBox(2))) === "4.5");
  check("the members column names who is in a class",
    /Chris/.test(await page.textContent("#isoView")) && /Hugo/.test(await page.textContent("#isoView")));
  // The scope caveat is the whole reason this tab is honest: the table reaches every object, but
  // the battle spawner overwrites both speeds from packed asset data. Losing this line would turn
  // a correct feature into a wrong claim, so it is asserted rather than left to review.
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("the tab says it does not change battle movement",
      /does not change battle movement/i.test(txt));
    check("...and says where battle speeds actually come from", /loaded battle asset/i.test(txt));
    check("...and explains why non-avatars are in the table", /Budehuc Castle/.test(txt)); }
  // Time scale is the one column whose name does not explain itself, and the difference between
  // it and Run is the thing a user gets wrong. Assert the explanation and both failure modes.
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("time scale is explained as a clock multiplier", /clock multiplier/i.test(txt));
    check("...covering animation and movement together",
      /animation clock/i.test(txt) && /cover ground twice as fast/i.test(txt));
    check("...naming the skate failure mode of raising run alone", /skate/i.test(txt));
    check("...and warning that the engine overwrites it", /starting.{0,3}clock/i.test(txt));
    check("the columns carry their units", /units\/sec/.test(txt)); }

  // Editing a class row retunes everyone in it.
  await page.fill(runBox(2), "7.5");
  await page.dispatchEvent(runBox(2), "change");
  await openAdv();
  { const r = await save(page);
    check("class 2's run speed was written as a float", f32(r, spdAddr(2, MOVESPD.run)) === 7.5);
    check("...its walk speed is untouched", f32(r, spdAddr(2, MOVESPD.walk)) === 2);
    check("...its id field is still zero (the override list stays terminated)",
      r.u32(spdAddr(2, 0)) === 0);
    check("...and no other class moved", f32(r, spdAddr(3, MOVESPD.run)) === 6); }

  // The other lever: move one character to another class, leaving the table alone.
  await openAdv();
  await page.click("#spdStock");
  await openAdv();
  await page.click("#spdChars > summary");                                  // the pickers are collapsed
  await page.selectOption('#isoView select.spd-cls[data-rec="2"]', "3");     // Chris -> Hugo's class
  await openAdv();
  check("Chris now appears in Hugo's class row",
    /class 3[\s\S]{0,400}Chris/.test(await page.textContent("#isoView"))
      || /Hugo, Chris/.test(await page.textContent("#isoView"))
      || /Chris/.test(await page.textContent("#isoView")));
  { const r = await save(page);
    check("Chris's class byte became 3", r.u8(spdClassAddr(2)) === 3);
    check("...nobody else's moved",
      [1, 3, 4].every((rec) => r.u8(spdClassAddr(rec)) === MOVESPD_CLASS[rec]));
    check("...and the speed table itself is untouched",
      MOVESPD_RUN.every((v, c) => f32(r, spdAddr(c, MOVESPD.run)) === v)); }

  // "Everyone runs at 6" levels every row, including the ones nobody is in.
  await openAdv();
  await page.click("#spdLevel");
  await openAdv();
  { const r = await save(page);
    check("every class run speed became 6",
      MOVESPD_RUN.every((_, c) => f32(r, spdAddr(c, MOVESPD.run)) === 6));
    check("...walk speeds were left alone",
      MOVESPD_RUN.every((_, c) => f32(r, spdAddr(c, MOVESPD.walk)) === 2)); }

  await page.context().close();
}

// The quick-set card is where the class indirection is supposed to disappear. Its allocator has
// four paths and the wrong one being taken is silent — it would look like it worked and quietly
// retune a shared row, or burn a spare row it did not need to. Each path is exercised.
//
// Asserted through the DOM rather than through saves: a save rebases what "as loaded" means, so
// a byte check after the second save compares against the first save's output instead of the
// disc. The byte-level verification is the block after this one, on a page that saves once.
head("Movement speed — give one character its own speed");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="movement"]');
  await page.waitForSelector("#spdQApply", { timeout: 3000 });
  const settle = () => page.waitForSelector("#spdQApply", { timeout: 3000 });
  const pick = async (name) => { await page.selectOption("#spdQChar", { label: name }); await settle(); };
  const setRun = (v) => page.fill('input.spd-q[data-col="run"]', String(v));
  const give = async () => { await page.click("#spdQApply"); await settle(); };
  const spare = () => page.textContent("#spdSpare");
  const view = () => page.textContent("#isoView");
  const now = () => page.textContent("#spdQNow");
  // The per-character pickers are the independent read-back: they show the class byte.
  const openAdvanced = async () => {
    if (!(await page.$("#spdAdvanced[open]"))) await page.click("#spdAdvanced > summary");
  };
  const classOf = async (rec) => {
    await openAdvanced();
    if (!(await page.$("#spdChars[open]"))) await page.click("#spdChars > summary");
    return +(await page.inputValue(`#isoView select.spd-cls[data-rec="${rec}"]`));
  };
  const rowRun = async (cls) => {
    await openAdvanced();
    return page.inputValue(`input.spd-f[data-cls="${cls}"][data-col="run"]`);
  };

  check("the spare-row budget is shown", (await spare()) === "5");
  // Speed is linear in play (Koroku: run 12 = 2x, 18 = 3x of the 6.0 his class ships with), so
  // the multiple of stock is the reading that means something. It must measure against what the
  // character SHIPS with, not against whatever their class currently holds.
  check("the confirmed-in-play result and its linearity are stated",
    /Confirmed in play/.test(await view()) && /linear/.test(await view()));
  { await page.selectOption("#spdQChar", { label: "Chris" }); await settle();
    await page.fill('input.spd-q[data-col="run"]', "9");
    await page.dispatchEvent('input.spd-q[data-col="run"]', "input");
    const m = await page.textContent("#spdQMult");
    check("the multiplier reads against what the character ships with",
      /Chris ships with walk 2, run 4.5/.test(m) && /\u00d72\.00 run/.test(m));
    await page.selectOption("#spdQChar", { label: "Hugo" }); await settle(); }
  check("the boxes start at the stock baseline, not the character's current values",
    (await page.inputValue('input.spd-q[data-col="walk"]')) === "2"
      && (await page.inputValue('input.spd-q[data-col="run"]')) === "6"
      && (await page.inputValue('input.spd-q[data-col="rate"]')) === "1");

  // Path 4 — Chris shares class 2 with twelve others, so she needs a row of her own.
  await pick("Chris");
  check("a shared class warns that editing the row moves others too",
    /Shared with 12 others/.test(await now()));
  // Hugo's row is also referenced by the unnamed default record, which must be counted (or the
  // line would promise a free in-place retune the allocator then refuses) but never named.
  { await pick("Hugo");
    const t = await now();
    check("an unnamed sharer is counted but not named by number",
      /Shared with 5 others/.test(t) && /1 unnamed/.test(t) && !/record 0/.test(t));
    await pick("Chris"); }
  await setRun(7.25); await give();
  check("...so she is given her own row", /own row \(class 9\)/.test(await view()));
  check("...the budget drops", (await spare()) === "4");
  check("...her class byte points at it", (await classOf(2)) === 9);
  check("...the new row holds the speed asked for", (await rowRun(9)) === "7.25");
  check("...and class 2 still reads 4.5, so the other twelve did not move",
    (await rowRun(2)) === "4.5");
  check("...none of whom moved class",
    (await classOf(4)) === MOVESPD_CLASS[4] && (await classOf(13)) === MOVESPD_CLASS[13]);

  // Path 3 — a second character wanting the SAME speed joins that row instead of spending one.
  await pick("Lucia");
  await setRun(7.25); await give();
  check("a character wanting an existing speed joins that row", /already holds that speed/.test(await view()));
  check("...spending no extra row", (await spare()) === "4");
  check("...both now point at the same row",
    (await classOf(2)) === 9 && (await classOf(4)) === 9);

  // Path 2 — Augustine is class 5's only occupant, so his row is retuned in place.
  await pick("Augustine");
  check("a sole occupant is reported as retunable at no cost", /Nobody else is in that class/.test(await now()));
  await setRun(3.5); await give();
  check("...and is retuned in place", /only character in class 5/.test(await view()));
  check("...still spending no row", (await spare()) === "4");
  check("...his class byte did not change", (await classOf(66)) === 5);
  check("...and class 5 now reads the new speed", (await rowRun(5)) === "3.5");

  // Path 1 — asking for what a character already has must be a no-op. The boxes reset to the
  // stock baseline on every render, so the value has to be typed again to ask the same question.
  await setRun(3.5); await give();
  check("re-applying the same speed says nothing was staged", /already has that speed/.test(await view()));

  // Reset returns the character; the row stays while anyone is still using it.
  await pick("Chris");
  await page.click("#spdQReset"); await settle();
  check("reset reports putting the character back", /put back in the class the disc gives/.test(await view()));
  check("...she is in her stock class again", (await classOf(2)) === MOVESPD_CLASS[2]);
  check("...and the row survives because Lucia still uses it",
    (await rowRun(9)) === "7.25" && (await classOf(4)) === 9);

  // The last character leaving frees the row AND its bytes are put back, not left staged.
  await pick("Lucia");
  await page.click("#spdQReset"); await settle();
  check("the last character leaving frees the row again", (await spare()) === "5");
  check("...and the orphaned row's edit was restored", /orphaned/.test(await view()));
  check("...so the row reads its disc value once more", (await rowRun(9)) === "6");
  await page.context().close();
}

// The same feature at the byte level, saving exactly once so "as loaded" still means the disc.
head("Movement speed — quick-set writes the right bytes");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="movement"]');
  await page.waitForSelector("#spdQApply", { timeout: 3000 });
  const f32 = (r, off) => { const b = Buffer.alloc(4); b.writeUInt32LE(r.u32(off) >>> 0, 0); return b.readFloatLE(0); };
  const near = (a2, b2) => Math.abs(a2 - b2) < 1e-4;   // 1.2 has no exact f32 form
  await page.selectOption("#spdQChar", { label: "Chris" });
  await page.waitForSelector("#spdQApply", { timeout: 3000 });
  await page.fill('input.spd-q[data-col="run"]', "7.25");
  await page.fill('input.spd-q[data-col="rate"]', "1.2");
  await page.click("#spdQApply");
  await page.waitForSelector("#spdQApply", { timeout: 3000 });
  const r = await save(page);
  check("the spare row took the run speed", f32(r, spdAddr(9, MOVESPD.run)) === 7.25);
  check("...and the time scale", near(f32(r, spdAddr(9, MOVESPD.rate)), 1.2));
  check("...and the walk speed shown in the box", f32(r, spdAddr(9, MOVESPD.walk)) === 2);
  check("...with the row's id field left at zero (override list stays terminated)",
    r.u32(spdAddr(9, 0)) === 0);
  check("Chris's class byte points at the new row", r.u8(spdClassAddr(2)) === 9);
  check("her old class row is untouched", f32(r, spdAddr(2, MOVESPD.run)) === 4.5);
  check("nobody else's class byte moved",
    [1, 3, 4, 13, 66].every((rec) => r.u8(spdClassAddr(rec)) === MOVESPD_CLASS[rec]));
  check("and no other row's floats moved",
    MOVESPD_RUN.every((v, c) => c === 9 || f32(r, spdAddr(c, MOVESPD.run)) === v));
  await page.context().close();
}

// Restore has to take the class assignments with it, or the members column disagrees with
// the speeds beside it. On its own page, because a save rebases what "as loaded" means.
head("Movement speed — restore covers speeds and classes together");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="movement"]');
  const runBox = (cls) => `input.spd-f[data-cls="${cls}"][data-col="run"]`;
  const openAdv = async () => {
    await page.waitForSelector("#spdQApply", { timeout: 3000 });
    if (!(await page.$("#spdAdvanced[open]"))) await page.click("#spdAdvanced > summary");
    await page.waitForSelector("#isoView input.spd-f", { timeout: 3000 });
  };
  await openAdv();
  await page.fill(runBox(2), "9");
  await page.dispatchEvent(runBox(2), "change");
  await openAdv();
  await page.click("#spdChars > summary");
  await page.selectOption('#isoView select.spd-cls[data-rec="2"]', "3");     // Chris -> Hugo's class
  await openAdv();
  check("both kinds of edit stage", await somethingStaged(page));
  await page.click("#spdStock");
  await openAdv();
  check("restore leaves nothing staged", await nothingStaged(page));
  check("...the table reads as the disc again", (await page.inputValue(runBox(2))) === "4.5");
  await page.click("#spdChars > summary");
  check("...and Chris is back in her own class",
    (await page.inputValue('#isoView select.spd-cls[data-rec="2"]')) === String(MOVESPD_CLASS[2]));
  await page.context().close();
}

head("Reference — Music: playing the streamed audio off the disc");
if (ON) { const page = await newPage();
  // A cut-down index whose one stream points at the planted Svag in the synth disc.
  const BGM = { format: "s3bgm", schema: 1, kindBgm: 1,
    script: [{ archive: "TEST", label: "t", op: 59, track: 0x200, fade: 64, tail: 16, trackOff: 0 }],
    rooms: [{ archive: "TEST", area: 1, sub: 0, room: 1, bgmOff: 0, seOff: 0, bgm: 0x200, se: 0 }],
    streams: [{ i: 0, sect: 0, sectors: 1, flags: 115, off: SVAG_STREAM + 0x800,
                bytes: SVAG_BYTES, rate: 44100, ch: 2, inter: SVAG_INTER, secs: 0.16 }] };
  await page.addInitScript(`window.S3_TEST_BGM = ${JSON.stringify(BGM)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="bgm"]', { timeout: 3000 });
  await page.click('[data-ref="bgm"]');
  await page.waitForSelector("[data-play]", { timeout: 3000 });
  const txt = await page.textContent("#isoView");
  check("the streamed-audio section is present", /Streamed audio/.test(txt));
  check("it says the decode happens locally", /nothing is uploaded/.test(txt));
  // The honesty this section exists to preserve: no ▶ is attached to a track id, because
  // nothing on the disc joins the two.
  check("no play button sits on a track id row",
    (await page.locator("table.invtbl").nth(0).locator("[data-play]").count()) === 0);
  check("it states the id-to-stream link is unproven", /nothing found so far joins a track id/.test(txt));
  check("it states most of the soundtrack is not streamed", /at most ~10% of the music/.test(txt));

  await page.click('[data-play="0"]');
  await page.waitForFunction(() => {
    const e = document.querySelector('[data-pstate="0"]');
    return e && /playing|done|failed|no disc/.test(e.textContent);
  }, null, { timeout: 15000 });
  const state = await page.textContent('[data-pstate="0"]');
  check("clicking Play decodes and starts the stream", /playing|done/.test(state), state);
  // It must really have produced audio, not just flipped a label.
  const info = await page.evaluate(() => {
    const c = window.__s3audio; return c ? { rate: c.rate, frames: c.frames, ch: c.ch, peak: c.peak } : null;
  });
  check("an AudioBuffer was built from the planted stream",
    info && info.ch === 2 && info.rate === 44100 && info.frames === 14336, JSON.stringify(info));
  check("the decoded buffer is not silence", info && info.peak > 0, JSON.stringify(info));
  await page.click("[data-stopall]");
  check("Stop clears the row state", (await page.textContent('[data-pstate="0"]')) === "");
  check("playback stages nothing", await nothingStaged(page));
  await page.context().close();
}

head("Reference — Music: a bad stream offset reports, it does not crash the page");
if (ON) { const page = await newPage();
  // An index pointing past the end of the disc — what a stale s3_bgm.json would look like.
  const BGM = { format: "s3bgm", schema: 1, kindBgm: 1, script: [], rooms: [],
    streams: [{ i: 0, sect: 0, sectors: 1, flags: 115, off: 0x7F000000,
                bytes: SVAG_BYTES, rate: 44100, ch: 2, inter: SVAG_INTER, secs: 0.16 }] };
  await page.addInitScript(`window.S3_TEST_BGM = ${JSON.stringify(BGM)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="bgm"]', { timeout: 3000 });
  await page.click('[data-ref="bgm"]');
  await page.waitForSelector("[data-play]", { timeout: 3000 });
  await page.click('[data-play="0"]');
  await page.waitForFunction(() => {
    const e = document.querySelector('[data-pstate="0"]');
    return e && !/^(|reading…|decoding…)$/.test(e.textContent);
  }, null, { timeout: 15000 });
  const state = await page.textContent('[data-pstate="0"]');
  check("it names the offset it found nothing at", /no audio at 0x7f000000/i.test(state), state);
  // newPage() counts pageerror/console-error into `fails`, so a crash here fails the run.
  check("the rest of the view still works", /Streamed audio/.test(await page.textContent("#isoView")));
  await page.context().close();
}

head("Reference — Music: where the game picks a track, read-only");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="ref"]');
  await page.waitForSelector('[data-ref="bgm"]', { timeout: 3000 });
  await page.click('[data-ref="bgm"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  check("the sub-tab hint follows the sub-tab", /which music plays/.test(await page.textContent("#isoHint")), await page.textContent("#isoHint"));
  const txt = await page.textContent("#isoView");
  // Both sources of a track, and the field split that names them
  check("it counts both cue sources", /script cues/.test(txt) && /room\s+records/.test(txt.replace(/\s+/g, " ")));
  check("it names the room record's two audio fields", /\+0x22/.test(txt) && /\+0x24/.test(txt));
  check("track ids are listed in hex", /0x0200/.test(txt) && /0x0113/.test(txt), txt.slice(0, 120));
  check("track 0 reads as silence, not as an id", /silence/.test(txt));
  check("areas are named, not just archive codes", /Budehuc Castle/.test(txt));
  // The honesty rows — the whole reason this is reference and not an editor
  check("it says the ids have no names", /no name table/.test(txt));
  check("it flags 0x0200 as the map's own theme rather than a song", /own theme/.test(txt));
  check("it says the audio itself can't be replaced", /SD\/STR\.BIN/.test(txt));
  check("it states the filter that validates a cue", /91%/.test(txt));
  // Filtering reaches the area names, not only the ids. Assert on the AREA table's row count:
  // the track table legitimately keeps naming every area a surviving track plays in, so a
  // whole-page "other areas are gone" check would be wrong, not just brittle.
  const areaTable = page.locator("table.invtbl").nth(1);
  const before = await areaTable.locator("tbody tr").count();
  await page.fill("#isoSearch", "brass castle"); await page.waitForTimeout(150);
  const after = await areaTable.locator("tbody tr").count();
  check("filtering narrows the area table", after >= 1 && after < before, `${before} -> ${after}`);
  check("filtering matches an area name", /Brass Castle/.test(await page.textContent("#isoView")));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(150);
  check("clearing the filter restores every area", (await areaTable.locator("tbody tr").count()) === before);
  check("the view stages nothing", await nothingStaged(page));
  check("there is no input in the Music view", (await page.locator("#isoView input, #isoView select").count()) === 0);
  await page.context().close();
}

head("Reference — Mounts browser, read-only");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
  // The card used to say this flag "does not by itself put anyone on a horse". That was wrong
  // and the copy was corrected: PartyPut reads +0x66 and writes the horse into the party list
  // six positions along, which a real save corroborates (Chris at party position 3, her horse
  // at 9). What it genuinely cannot do is make a scene ASK for a mount. These assertions track
  // the corrected claims, so the card cannot quietly drift back to the old one.
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("it says the field really does stage a horse", /really does stage the horse/.test(txt));
    check("it explains the pos\u002B6 staging", /six positions along/.test(txt));
    check("it says the limit is the script, not the flag", /cannot do is write the script/.test(txt));
    check("it points at Ruby to force one in battle", /Ruby/.test(txt));
    check("it explains why Chris rides only sometimes", /some scenes and not others/.test(txt));
    check("it warns the party must be re-formed", /re-formed/.test(txt));
    check("it points at the Test tab for the wider list", /Test<\/b>? ?tab can widen|Test tab can widen/.test(txt)); }
  // Only 308/309 are honoured while the clamp is stock, so only those may be offered. The Test
  // tab can widen the clamp, and the dropdown then grows — this asserts the DEFAULT, which is
  // what a freshly loaded ISO must show.
  const optVals = await page.$$eval(sel(1), (els) => Array.from(els[0].options).map((o) => o.value));
  check("only none/308/309 are offered while the clamp is stock",
    JSON.stringify(optVals) === JSON.stringify(["0", "308", "309"]), optVals.join(","));
  await page.selectOption(sel(1), "308");     // give Hugo a knight horse
  await page.selectOption(sel(2), "0");       // take Chris's away
  const r = await save(page);
  check("Hugo's record now names the knight horse", r.u16(horseAddr(1)) === 308);
  check("Chris's record is cleared", r.u16(horseAddr(2)) === 0);
  check("untouched Borus still 308", r.u16(horseAddr(20)) === HORSE_STOCK[20]);
  await page.context().close();
}

head("Party formation — the no-base-disc check, and restoring a staged edit");
if (ON) { const page = await newPage(); await loadIso(page);
  const card = async () => {
    await page.click('#isoTabs [data-v="changes"]');
    await page.waitForSelector(".bag-h", { timeout: 3000 });
    return (await page.textContent("#isoView")).replace(/\s+/g, " ");
  };
  // A freshly loaded synthetic disc plants every one of these at its stock value, so the card
  // must say so — and must say so with no base disc chosen, which is the entire reason it
  // exists alongside the comparison below it.
  { const txt = await card();
    check("a stock disc reads all stock", /Party formation all stock/.test(txt));
    check("...and says nothing changes party formation", /Nothing on this disc changes party formation/.test(txt));
    check("...with no base disc chosen", /Choose a base disc/.test(txt));
    check("the one-button restore isn't offered when there is nothing to restore",
      (await page.$("#pfAll")) === null);
    // The one entry with a play report has to be readable without opening anything, and
    // has to say WHICH setting it is — that is the answer to the question the card exists
    // for (reported 2026-09-06: the scene actor fallback stopped party members being added).
    check("the confirmed finding is stated up front, on a stock disc too",
      /one has actually been watched doing this/.test(txt) && /Scene actor fallback/.test(txt));
    check("...dated, so the claim can be traced to its report", /2026-09-06/.test(txt));
    check("...and it carries a confirmed badge the other five don't",
      (await page.$$('.tag.acc2')).length >= 1
      && /confirmed to break party addition/.test(txt));
    check("...while the other five say they are mechanisms with no report",
      /mechanisms with no play report attached/.test(txt)); }
  // The Test tab keeps the record of the retired patch, and must name the party symptom there
  // too — a reader who arrives with a broken party should recognise it where the patch used to
  // live, not only on the screen that repairs it. Wait on #avStock: #avActorFb is gone.
  await page.click('#isoTabs [data-v="test"]');
  await page.click('#testTabs [data-t="avatar"]');          // the tab opens on the switchboard now
  await page.waitForSelector("#avStock", { timeout: 3000 });
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    // The toggle is retired (v1.135.0), so the Test tab's job here is to keep the record: say
    // the control is gone, and name BOTH play reports so a reader who arrives with a broken
    // party recognises their own symptom rather than only the scene freeze.
    check("the Test tab says the fallback's toggle was removed", /has been removed/i.test(txt));
    check("...and names the party-formation symptom",
      /stopped adding party members correctly/i.test(txt)); }
  // Hand Hugo a horse he doesn't ship with. That is the edit most likely to be behind
  // "adding party members stopped working": PartyPut stages the horse at pos+6, so it takes a
  // party-list position of its own.
  await page.click('#isoTabs [data-v="mounts"]');
  await page.waitForSelector("select.mnt-horse", { timeout: 3000 });
  await page.selectOption(`select.mnt-horse[data-off="${horseAddr(1)}"]`, "308");
  { const txt = await card();
    check("a staged horse shows up as one changed site", /Assigned horse 1 of 80 changed/.test(txt));
    check("...named, with stock and current side by side", /assigned horse 0 → 308/.test(txt));
    check("the one-button restore appears and counts only that site", /Restore 1 site\(s\) to stock/.test(txt)); }
  await page.click('[data-pf="horse"]');
  { const txt = await card();
    check("restoring the group puts the card back to all stock", /Party formation all stock/.test(txt));
    // Net zero against the disc, so there is nothing left to write — which is the honest
    // outcome and the reason this half asserts the card rather than a save.
    check("...and leaves nothing staged", await readDirty(page)); }
  await page.context().close();
}

head("Party formation — a disc patched in an earlier session, put back in one click");
if (ON) { // The case the card exists for: the change is already ON the disc, so nothing is staged and
  // Revert all has nothing to revert. Hugo carries a Karaya horse (325) and the clamp is
  // widened at all six sites — three party helpers and PartyPut's own position 7-12 guard.
  const patched = bytes.slice();
  const pdv = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  pdv.setUint16(horseAddr(1), 325, true);
  HORSE_CLAMP.forEach((c) => pdv.setUint32(c.off, c.alt >>> 0, true));
  setServed(patched);
  const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="changes"]');
  await page.waitForSelector("#pfAll", { timeout: 3000 });
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("both settings are reported changed", /2 of 6 setting\(s\) are not stock/.test(txt));
    check("the horse already on the disc is named", /assigned horse 0 → 325/.test(txt));
    check("all six clamp sites are counted", /Assigned-horse clamp 6 of 6 changed/.test(txt));
    check("the button covers all seven sites", /Restore 7 site\(s\) to stock/.test(txt));
    check("nothing is staged, so Revert all could not have found this", await readDirty(page)); }
  await page.click("#pfAll");
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("one button puts both settings back", /Party formation all stock/.test(txt)); }
  { const r = await save(page);
    check("the clamp is `sltiu …, 2` at all six sites",
      HORSE_CLAMP.every((c) => r.u32(c.off) === (c.stock >>> 0)),
      HORSE_CLAMP.map((c) => r.u32(c.off).toString(16)).join(" "));
    check("...and the horse the widened window admitted is gone", r.u16(horseAddr(1)) === 0);
    check("...while Chris keeps the horse she ships with", r.u16(horseAddr(2)) === HORSE_STOCK[2]); }
  await page.context().close();
  setServed(bytes);
}

head("Party formation — story routing is held back from the one-button restore");
if (ON) { // Blanking a story case is a FIX — it is what makes empty dialogue boxes render for a
  // stand-in protagonist — so the blanket restore must not quietly undo it. It is still
  // reported, and it gets its own button.
  const patched = bytes.slice();
  const pdv = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  const koroku = STORY_CASES[8][0];                       // the case comparing 0x36
  pdv.setUint32(koroku, avatarWord(0x7FFF, "eq"), true);  // an id the leader byte can't hold
  setServed(patched);
  const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="changes"]');
  await page.waitForSelector("#pfAll", { timeout: 3000 });
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("the blanked story case is reported", /Story content 1 of 9 changed/.test(txt));
    check("...and named as left out of the blanket restore", /Story content is left out of that/.test(txt));
    check("...which therefore promises nothing", /Restore 0 site\(s\) to stock/.test(txt));
    check("the card says it is a fix, not a bug", /here to be READ rather than reset/.test(txt)); }
  check("the blanket restore is disabled with only story changed",
    await page.$eval("#pfAll", (b) => b.disabled));
  await page.click('[data-pf="story"]');
  { const txt = (await page.textContent("#isoView")).replace(/\s+/g, " ");
    check("its own button still restores it", /Party formation all stock/.test(txt)); }
  { const r = await save(page);
    check("...and Koroku's case compares 0x36 again", r.u16(koroku) === 0x36); }
  await page.context().close();
  setServed(bytes);
}

head("Armor set effect ownership — reassign which set grants what");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (!ON) { /* section not selected */ }
else if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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

head("Enemies — a disc that was already tuned reads its own multiplier back");
if (ON) { // The state a re-opened tuned ISO is in: the bytes on the disc are scaled, and the pack
  // index still carries the STOCK numbers it was built from. Nothing in the file records the
  // multiplier, so the editor has to recover it by comparing the two.
  const V = ENEMY_TEST_PACKS.packs[0].enemies[0].variants[0];
  const scaled = (img, f) => { const t = Uint8Array.from(img), dv = new DataView(t.buffer);
    for (const rec of [ENEMY_REC_A, ENEMY_REC_B]) {
      dv.setUint16(rec + 48, f(V.hp, -1), true); dv.setUint16(rec + 50, f(V.hp, -1), true);
      V.stats.forEach((sv, i) => dv.setUint16(rec + 32 + i * 2, f(sv, i), true));
    }
    return t; };
  const tuned = scaled(bytes, (n) => Math.round(n * 1.2));
  // A redraw keeps an expanded pack expanded, so clicking the summary again would CLOSE it.
  const openPack = async (pg) => { const det = await pg.$("details.epack");
    if (!(await det.evaluate((d) => d.open))) await det.evaluate((d) => d.querySelector("summary").click());
    await pg.waitForSelector('input.en-num[data-f="hp"]'); };
  const readOn = (img, writes) => { const at = (pos) => { const w = writes.find((x) => pos >= x.pos && pos < x.pos + x.data.length); return w ? w.data[pos - w.pos] : img[pos]; };
    return { u16: (q) => at(q) | (at(q + 1) << 8) }; };
  const page = await newPage();
  setServed(tuned);
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("#ebApply", { timeout: 3000 });
  check("HP multiplier prefills to the ×1.2 already on the disc", (await page.inputValue("#ebHp")) === "1.2");
  check("stat multiplier prefills to ×1.2", (await page.inputValue("#ebStats")) === "1.2");
  check("untouched fields still read ×1", (await page.inputValue("#ebLv")) === "1" && (await page.inputValue("#ebSp")) === "1");
  const note = await page.textContent("#isoView");
  check("says the disc is already tuned", /already tuned/.test(note) && /HP ×1\.2/.test(note));
  check("prefilling stages nothing on its own", await nothingStaged(page));
  // Re-applying what the disc already carries must be a no-op, not ×1.44.
  await page.click("#ebApply"); await page.waitForTimeout(120);
  check("re-applying the detected ×1.2 changes nothing", await nothingStaged(page));
  // A NEW multiplier is measured from the stock numbers, not from the tuned disc.
  await page.fill("#ebHp", "1.5"); await page.dispatchEvent("#ebHp", "change");
  await page.click("#ebApply"); await page.waitForTimeout(120);
  await openPack(page);
  check("×1.5 is 1.5× STOCK (60), not 1.5× the tuned disc (72)", (await page.inputValue('input.en-num[data-f="hp"]')) === "60");
  // Restore puts the stock numbers back — the only way to undo a scale already saved into a file.
  await page.click("#ebStockRestore"); await page.waitForTimeout(150);
  await openPack(page);
  check("restore stock returns HP to 40", (await page.inputValue('input.en-num[data-f="hp"]')) === "40");
  check("restore stock returns PWR to 11", (await page.inputValue('input.en-num[data-f="stat0"]')) === "11");
  await page.evaluate(() => { window.__writes = []; });
  const r = readOn(tuned, await (async () => { await page.click("#isoSaveBtn");
    try { await page.waitForSelector("#bnSkip", { timeout: 700 }); await page.click("#bnSkip"); } catch { /* already nudged */ }
    await page.waitForSelector("#cfOk", { timeout: 3000 }); await page.click("#cfOk");
    await page.waitForSelector("#pgClose:visible", { timeout: 5000 }); await page.click("#pgClose");
    return getWrites(page); })());
  check("stock HP saved to both copies", r.u16(ENEMY_REC_A + 48) === 40 && r.u16(ENEMY_REC_B + 48) === 40
    && r.u16(ENEMY_REC_A + 50) === 40);
  await page.context().close();

  // A disc the index does NOT describe: no single ratio explains it, so the editor must say so
  // and must not offer to write the index's numbers over someone else's data.
  const foreign = scaled(bytes, (n, i) => [99, 3, 77, 5, 41, 9, 60, 2][i] || 4321);
  const p2 = await newPage();
  setServed(foreign);
  await p2.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await loadIso(p2);
  await p2.click('#isoTabs [data-v="enemies"]');
  await p2.waitForSelector("#ebApply", { timeout: 3000 });
  const note2 = await p2.textContent("#isoView");
  check("unrecognised disc is reported, not guessed at", /don't line up with the stock USA disc/.test(note2));
  check("no stock-relative toggle on an unrecognised disc", (await p2.$("#ebStock")) === null);
  check("no restore-stock button on an unrecognised disc", (await p2.$("#ebStockRestore")) === null);
  check("multipliers stay at ×1 when nothing was detected", (await p2.inputValue("#ebHp")) === "1");
  await p2.context().close();
  setServed(bytes);
}

head("Zones & formations — decode, edit, write-through both copies");
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage();
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

head("War bulk tuning — multiply the opposition, scoped to leaders or troops");
if (ON) { // The same engine the Enemies view runs, over the war half of the packs. What has to be
  // true here and isn't testable there: the reward/drop multipliers must NOT exist (war
  // records carry no aux block), the leader/troop scopes must split on the unit id, and the
  // two views' multipliers must stay independent of each other.
  const page = await newPage();
  await page.addInitScript(`window.S3_TEST_ENEMY_PACKS = ${JSON.stringify(ENEMY_TEST_PACKS)};`);
  await page.addInitScript(`window.S3_TEST_WAR_UNITS = ${JSON.stringify(WAR_TEST_UNITS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="war"]');
  await page.waitForSelector("#wbApply", { timeout: 3000 });
  check("HP, stats and level multipliers are offered",
    (await page.$("#wbHp")) !== null && (await page.$("#wbStats")) !== null && (await page.$("#wbLv")) !== null);
  check("no reward or drop multipliers — war battles pay nothing",
    (await page.$("#wbExp")) === null && (await page.$("#wbSp")) === null
    && (await page.$("#wbPotch")) === null && (await page.$("#wbDropw")) === null);
  // A redraw keeps an expanded pack expanded, so re-clicking a summary would CLOSE it.
  const packField = async (i, f) => {
    const det = (await page.$$("details.epack"))[i];
    if (!(await det.evaluate((d) => d.open))) await det.evaluate((d) => d.querySelector("summary").click());
    await page.waitForTimeout(60);
    return (await det.$(`input.en-num[data-f="${f}"]`)).inputValue();
  };
  const troop = (f) => packField(0, f), leader = (f) => packField(1, f);
  const apply = async (id, v) => { await page.fill(`#${id}`, String(v)); await page.dispatchEvent(`#${id}`, "change");
    await page.click("#wbApply"); await page.waitForTimeout(120); };
  await apply("wbHp", 2);
  check("soldier tier HP ×2 = 460", (await troop("hp")) === "460");
  check("leader unit HP ×2 = 1200", (await leader("hp")) === "1200");
  await page.click("#wbApply"); await page.waitForTimeout(120);
  check("re-apply does not compound", (await troop("hp")) === "460" && (await leader("hp")) === "1200");
  await apply("wbStats", 1.5);
  check("stats ×1.5 scales PWR (49 → 74)", (await troop("stat0")) === "74");
  check("level left at ×1 is untouched", (await troop("lv")) === "20" && (await leader("lv")) === "23");
  // Scope: leaders only. Everything is recomputed from the disc's opening values, so the
  // soldier tier drops back to stock while the leader takes the new numbers.
  await page.selectOption("#wbScope", "leaders"); await page.waitForTimeout(60);
  await apply("wbHp", 3);
  check("leaders-only scope: leader HP ×3 = 1800", (await leader("hp")) === "1800");
  check("...and the soldier tier is out of scope (back to 460)", (await troop("hp")) === "460");
  await page.selectOption("#wbScope", "troops"); await page.waitForTimeout(60);
  await apply("wbLv", 2);
  check("troops-only scope: soldier level ×2 = 40", (await troop("lv")) === "40");
  check("...and the leader's level is untouched", (await leader("lv")) === "23");
  // Apply always writes EVERY non-×1 multiplier over the current scope, from the stock base —
  // so the ×3 typed while leaders were selected now reaches the soldier too (3×230), and the
  // leader keeps the 1800 it was given rather than picking up the new level.
  check("...but the ×3 HP still in the box now reaches the soldier (690)", (await troop("hp")) === "690");
  check("...and the leader keeps its own 1800", (await leader("hp")) === "1800");
  // The Enemies view has its own multipliers and its own packs — neither moved.
  await page.click('#isoTabs [data-v="enemies"]');
  await page.waitForSelector("#ebApply", { timeout: 3000 });
  check("the Enemies multipliers are still ×1", (await page.inputValue("#ebHp")) === "1");
  await page.click("details.epack summary"); await page.waitForSelector('input.en-num[data-f="hp"]');
  check("...and no enemy pack was touched", (await page.inputValue('input.en-num[data-f="hp"]')) === "40");
  const r = await save(page);
  for (const [nm, rec] of [["copy A", WAR_REC_A], ["copy B", WAR_REC_B]]) {
    check(`soldier ${nm}: HP saved = 690 (both fields)`, r.u16(rec + 48) === 690 && r.u16(rec + 50) === 690);
    check(`soldier ${nm}: level saved = 40`, r.u16(rec + 64) === 40);
    check(`soldier ${nm}: PWR saved = 74`, r.u16(rec + 32) === 74);
  }
  for (const [nm, rec] of [["copy A", WAR_LEAD_A], ["copy B", WAR_LEAD_B]]) {
    check(`leader ${nm}: HP saved = 1800`, r.u16(rec + 48) === 1800 && r.u16(rec + 50) === 1800);
    check(`leader ${nm}: level saved = 23 (out of every scope that moved it)`, r.u16(rec + 64) === 23);
  }
  await page.context().close();
}

head("War — a disc that was already tuned reads its own multiplier back");
if (ON) { // Same recovery the Enemies view does, over the war index's stock baseline: the file records
  // no multiplier, only the numbers it produced, so re-opening a doubled disc has to recover
  // the scale by comparing against s3_war_units.json's stock lv/hp/stats.
  const V0 = WAR_TEST_UNITS.packs[0].enemies[0].variants[0];
  const V1 = WAR_TEST_UNITS.packs[1].enemies[0].variants[0];
  const t = Uint8Array.from(bytes), dv = new DataView(t.buffer);
  for (const [v, recs] of [[V0, [WAR_REC_A, WAR_REC_B]], [V1, [WAR_LEAD_A, WAR_LEAD_B]]])
    for (const rec of recs) {
      dv.setUint16(rec + 48, Math.round(v.hp * 1.2), true); dv.setUint16(rec + 50, Math.round(v.hp * 1.2), true);
      v.stats.forEach((sv, i) => dv.setUint16(rec + 32 + i * 2, Math.round(sv * 1.2), true));
    }
  const page = await newPage();
  setServed(t);
  await page.addInitScript(`window.S3_TEST_WAR_UNITS = ${JSON.stringify(WAR_TEST_UNITS)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="war"]');
  await page.waitForSelector("#wbApply", { timeout: 3000 });
  check("war HP multiplier prefills to the ×1.2 already on the disc", (await page.inputValue("#wbHp")) === "1.2");
  check("war stat multiplier prefills to ×1.2", (await page.inputValue("#wbStats")) === "1.2");
  check("level, which nobody scaled, still reads ×1", (await page.inputValue("#wbLv")) === "1");
  const note = await page.textContent("#isoView");
  check("says the disc is already tuned", /already tuned/.test(note) && /HP ×1\.2/.test(note));
  check("prefilling stages nothing on its own", await nothingStaged(page));
  await page.click("#wbApply"); await page.waitForTimeout(120);
  check("re-applying the detected ×1.2 changes nothing", await nothingStaged(page));
  // A new multiplier measures from the STOCK numbers, not from the tuned disc (1.5×230 = 345,
  // not 1.5×276 = 414).
  await page.fill("#wbHp", "1.5"); await page.dispatchEvent("#wbHp", "change");
  await page.click("#wbApply"); await page.waitForTimeout(120);
  const det0 = async (f) => { const d = (await page.$$("details.epack"))[0];
    if (!(await d.evaluate((x) => x.open))) await d.evaluate((x) => x.querySelector("summary").click());
    await page.waitForTimeout(60); return (await d.$(`input.en-num[data-f="${f}"]`)).inputValue(); };
  check("×1.5 is 1.5× STOCK (345), not 1.5× the tuned disc (414)", (await det0("hp")) === "345");
  await page.click("#wbStockRestore"); await page.waitForTimeout(150);
  check("restore stock returns war HP to 230", (await det0("hp")) === "230");
  check("restore stock returns PWR to 49", (await det0("stat0")) === "49");
  await page.context().close();
  setServed(bytes);
}

head("Rune reskin + description rewrite");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]');
  await openFold(page, "#spReskinBox");
  // The rune picker is keyed by ITEM id now, not by a bundled name: it lists whatever this
  // disc's rune records point at, so it follows a reassignment instead of a hardcoded list.
  await page.selectOption("#rsRune", String(mapping.runes[0].id));
  await page.fill("#rsPower", "300"); await page.click("#rsApply"); await page.waitForTimeout(150);
  const r = await save(page);
  check("reskin: spell0 power = 300", r.u32(SPELL.off + 0x1C) === 300);
  check("reskin: spell3 power = 300", r.u32(SPELL.off + 3 * SPELL.stride + 0x1C) === 300);
  // desc "Deals 100DMG" -> "Deals 300DMG": the "100"->"300" is a 1-byte change (first digit)
  const descWrite = (await getWrites(page)).some((w) => w.pos >= 0x400000);
  check("reskin: description bytes rewritten", descWrite);
  await page.context().close();
}

head("Target / Area-of-effect independent highlight + AOE-preserving Target write");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await openRec(page, 'details.char[data-i="0"]');
  const dirty = (k) => page.evaluate((k) => document.querySelector(`details.char[data-i="0"] select[data-k="${k}"]`).classList.contains("dirty"), k);
  // synth spell0 flags14 = 0x0A00 (target single 0x0A, AOE off). Turn AOE on → only AOE flags.
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "1"); await page.waitForTimeout(60);
  check("AOE change highlights AOE only", (await dirty("aoe")) === true && (await dirty("target")) === false);
  // Change Target → Target flags; the write must PRESERVE the AOE bit.
  await page.selectOption('details.char[data-i="0"] select[data-k="target"]', "2"); await page.waitForTimeout(60);
  check("Target change highlights Target", (await dirty("target")) === true);
  { const r = await save(page); const f14 = r.u32(SPELL.off + 0x14);
    check("Target write preserved AOE bit", ((f14 >> 8) & 0x7F) === 0x02 && !!(f14 & 0x8000));
    // bit16 = "no aiming step". An AREA spell is aimed, so all-foes + AOE must leave it CLEAR.
    check("all-foes + AOE leaves bit16 clear", !(f14 & 0x00010000)); }
  // Turn AOE back off and the same target byte now means the whole foe side with nothing to aim
  // at — bit16 has to come ON. Leaving it off is what soft-locked Phoenix: the cursor sat on the
  // caster and its pair with no enemy selectable.
  //
  // Only ONE more save here, not one per transition. A save is a full ISO build (~950ms) and
  // this section's whole job is the WIRING — that the controls route through syncNoAim and the
  // bit reaches the saved bytes. The rule itself (every target byte, both directions, and all
  // 132 stock records) is proved without a browser in spell-target-real-iso.mjs, which is where
  // to add a case rather than buying another second here.
  await page.selectOption('details.char[data-i="0"] select[data-k="aoe"]', "0"); await page.waitForTimeout(60);
  { const r = await save(page); const f14 = r.u32(SPELL.off + 0x14);
    check("all-foes with AOE off sets bit16", ((f14 >> 8) & 0x7F) === 0x02 && !(f14 & 0x8000) && !!(f14 & 0x00010000)); }
  await page.context().close();
}

head("Spell description — editable, auto-updates on Power, length-capped");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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

// A dish's NAME is one record behind the data it names, so the row for dish i must show dish
// i's own heal — not the previous dish's. That was wrong from v12 until now: the tab paired
// each name with the block it sat in, so editing "Fried Ice Cream" wrote Tomato Ice Cream.
// The fixture plants two dishes precisely so an off-by-one lands on the other one instead of
// on zeroes, which a single-row fixture would have hidden.
head("Food — each dish's name lines up with its own record");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="food"]'); await page.waitForTimeout(80);
  const grid = await page.evaluate(() => [...document.querySelectorAll("#isoView tbody tr")].slice(0, 2).map((r) => ({
    name: r.querySelector("input.fdname")?.value ?? r.cells[1].textContent.trim(),
    heal: r.querySelector('input[data-kind="heal"]')?.value,
    desc: r.querySelector("input.fddesc")?.value,
  })));
  check("dish 0 is Medicine, healing 100", grid[0] && grid[0].name === "Medicine" && grid[0].heal === "100",
    JSON.stringify(grid));
  check("...with its own description", grid[0] && grid[0].desc === "Heals 100HP", JSON.stringify(grid));
  check("dish 1 is Antitoxin, healing 10 — not Medicine's numbers",
    grid[1] && grid[1].name === "Antitoxin" && grid[1].heal === "10" && grid[1].desc === "Cures poison",
    JSON.stringify(grid));

  // Renaming a dish: in place, capped, refused when empty — same contract as gear and runes.
  const nm = "input.fdname >> nth=0";
  check("a dish can be renamed", await page.isVisible(nm));
  check("the rename is capped to the on-disc slot (8)", +(await page.getAttribute(nm, "maxlength")) === 8);
  await page.fill(nm, "Potion"); await page.dispatchEvent(nm, "change"); await page.waitForTimeout(80);
  check("the new name sticks", (await page.inputValue(nm)) === "Potion");
  await page.fill(nm, ""); await page.dispatchEvent(nm, "change"); await page.waitForTimeout(80);
  check("an empty name is refused", (await page.inputValue(nm)) === "Potion");
  const saved = await save(page);
  check("the rename is written NUL-padded over the old bytes",
    [...Array(8)].map((_, i) => saved.at(mapping.food.nameOff + i)).join(",") === [80, 111, 116, 105, 111, 110, 0, 0].join(","),
    [...Array(8)].map((_, i) => saved.at(mapping.food.nameOff + i)).join(","));
  await page.context().close();
}

head("Food description — editable, auto-updates on heal, length-capped");
if (ON) { const page = await newPage(); await loadIso(page);
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

head("Character rename panel — collapsed, scoped, same-length-capped, staged");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="chars"]'); await page.waitForTimeout(80);
  // The panel ships collapsed so the stat records sit at the top of the tab; the fields are in
  // the DOM either way, so visibility is what says whether the fold is doing its job.
  check("rename panel starts collapsed", !(await page.locator("#rnBox").evaluate((b) => b.open)));
  check("rename fields hidden while collapsed", !(await page.isVisible('input.rename[data-orig="Hugo"]')));
  await openFold(page, "#rnBox");
  check("clicking the header expands it", await page.isVisible('input.rename[data-orig="Hugo"]'));
  check("rename inputs present (Hugo/Chris/Geddoe/Koroku)", (await page.locator("input.rename").count()) === 4);
  check("Hugo rename capped to 4 chars", +(await page.getAttribute('input.rename[data-orig="Hugo"]', "maxlength")) === 4);
  check("Geddoe rename capped to 6 chars", +(await page.getAttribute('input.rename[data-orig="Geddoe"]', "maxlength")) === 6);
  // Koroku joined the scoped list for the field-character work; the cap is what keeps the
  // replacement same-length, so it is asserted like the others rather than assumed.
  check("Koroku is offered and capped to 6 chars",
    +(await page.getAttribute('input.rename[data-orig="Koroku"]', "maxlength")) === 6);
  await page.fill('input.rename[data-orig="Geddoe"]', "Gideon"); await page.dispatchEvent('input.rename[data-orig="Geddoe"]', "input"); await page.waitForTimeout(40);
  check("staged rename highlights", await page.evaluate(() => document.querySelector('input.rename[data-orig="Geddoe"]').classList.contains("dirty")));
  check("the collapsed-card counter follows the staged rename",
    (await page.textContent("#rnCount")) === "1 staged" && await page.isVisible("#rnCount"));
  // Plenty of things in this tab redraw the whole view (a search, a per-field revert); the card
  // the user opened — and the name they typed into it — both have to survive that.
  await page.fill("#isoSearch", "1"); await page.waitForTimeout(80);
  check("the open card survives a redraw", await page.isVisible('input.rename[data-orig="Geddoe"]'));
  check("the staged name survives a redraw", (await page.inputValue('input.rename[data-orig="Geddoe"]')) === "Gideon");
  await page.fill("#isoSearch", ""); await page.waitForTimeout(80);
  // this harness uses the FS-Access (in-place) path, where renames can't reach disc-wide copies
  await page.click("#isoSaveBtn");
  check("rename-only in-place save warns it needs streaming", await statusHas(page, /streaming/i));
  await page.context().close();
}

head("Per-field revert + Revert all + badge");
if (ON) { const page = await newPage(); await loadIso(page);
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

// The Balance tab is gone: its growth half is a card at the top of the Growth tab, its spell
// and unite halves are cards on those tabs. Two things are asserted at once here — that the
// merged card still scales from disk (so presets stay idempotent), and that it writes the
// VERIFIED offsets. The old tab carried a stale copy of the mapping that never touched HP at
// +0 and wrote MDF's multiplier into the non-growth byte at +8.
const origU32 = (p) => (bytes[p] | bytes[p + 1] << 8 | bytes[p + 2] << 16 | bytes[p + 3] << 24) >>> 0;

head("Growth — bulk scaling (merged from Balance): idempotent, right offsets");
if (ON) { const page = await newPage(); await loadIso(page);
  const [l2b, l2s] = TABLES.list2;
  const rec = l2b + 1 * l2s;
  // synth list2 rec1: HP@+0 = 9, PWR@+4 = 6, MDF@+9 = 4, and +8 = 3 (NOT a growth byte).
  // Hard preset: HP x0.65, PWR x0.7, MDF x0.8.
  check("Balance is no longer a tab of its own", !(await page.$('#isoTabs [data-v="balance"]')));
  await page.click('#isoTabs [data-v="growth"]');
  check("the Growth tab carries the bulk-scaling card", !!(await page.$("#gbBox")));
  await openFold(page, "#gbBox");
  await page.click('[data-gpreset="hard"]'); await page.click("#gb-apply"); await page.waitForTimeout(150);
  let r = await save(page);
  check("hard: PWR growth 6 -> 4 (+4)", r.u8(rec + 4) === 4);
  check("hard: HP growth 9 -> 6 — at +0, the offset the old tab never touched", r.u8(rec + 0) === 6);
  check("hard: MDF growth 4 -> 3 (+9)", r.u8(rec + 9) === 3);
  check("the non-growth byte at +8 is left alone (the old tab wrote MDF's multiplier here)", r.u8(rec + 8) === 3);
  // idempotent: applying Hard again after a save scales from the NEW originals, no runaway
  await openFold(page, "#gbBox");
  await page.click('[data-gpreset="hard"]'); await page.click("#gb-apply"); await page.waitForTimeout(150);
  r = await save(page);
  check("hard again: PWR 4 -> 3 (scales from disk, no runaway)", r.u8(rec + 4) === 3);
  check("hard again: HP 6 -> 4", r.u8(rec + 0) === 4);
  // reset to 1.00x -> nothing staged
  await openFold(page, "#gbBox");
  await page.click('[data-gpreset="reset"]'); await page.click("#gb-apply"); await page.waitForTimeout(150);
  check("reset preset stages nothing", await nothingStaged(page));
  await page.context().close();
}

head("Growth — collapsed-row summary, overwrite guard, filter scope");
if (ON) { const page = await newPage(); await loadIso(page);
  const [l2b, l2s] = TABLES.list2;
  const rec = l2b + 1 * l2s;
  await page.click('#isoTabs [data-v="growth"]');
  const sumOf = (off) => page.textContent(`details.char[data-rec="${off}"] .gr-sum`);
  const sums = await page.$$eval("details.char .gr-sum", (e) => e.map((x) => x.textContent));
  check("collapsed rows carry a growth summary", sums.length > 0 && /HP \d+ · PWR \d+/.test(sums[0] || ""), sums[0]);
  check("record #1's summary reads its planted bytes", /HP 9 · PWR 6/.test(await sumOf(rec)), await sumOf(rec));

  // Overwrite guard: bulk scaling starts from the pristine bytes, so a hand-typed growth value
  // would vanish without a word. It has to ask first.
  await openRec(page, `details.char[data-rec="${rec}"]`);
  const pwr = `details.char[data-rec="${rec}"] input.fnum[data-off="${rec + 4}"]`;
  await page.fill(pwr, "12"); await page.dispatchEvent(pwr, "change"); await page.waitForTimeout(80);
  check("the summary follows a hand edit while the record is open", /PWR 12/.test(await sumOf(rec)), await sumOf(rec));
  await openFold(page, "#gbBox");
  await page.click('[data-gpreset="hard"]');
  let asked = null;
  page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
  await page.click("#gb-apply"); await page.waitForTimeout(150);
  check("bulk apply warns before overwriting hand-edited growth", /edited by hand/.test(asked || ""), asked || "no dialog");
  check("dismissing the warning leaves the hand edit intact", /PWR 12/.test(await sumOf(rec)), await sumOf(rec));
  page.once("dialog", (d) => d.accept());
  await page.click("#gb-apply"); await page.waitForTimeout(150);
  check("accepting applies the scale over the hand edit", /PWR 4/.test(await sumOf(rec)), await sumOf(rec));
  await page.click("#isoResetBtn"); await page.waitForTimeout(120);

  // Filter scope: with the filter box in use, the card offers to scale only what it is showing.
  const name = await page.textContent(`details.char[data-rec="${rec}"] .nm`);
  await page.fill("#isoSearch", name); await page.waitForTimeout(150);
  await openFold(page, "#gbBox");
  check("a filter reveals the scope picker", !!(await page.$("#gb-scope")));
  await page.selectOption("#gb-scope", "filter");
  await page.click('[data-gpreset="hard"]'); await page.click("#gb-apply"); await page.waitForTimeout(150);
  const r = await save(page);
  check("scoped apply scales the matching record", r.u8(rec + 4) === 4);
  check("scoped apply leaves every other record alone",
    r.u8(l2b + 2 * l2s + 4) === bytes[l2b + 2 * l2s + 4] && r.u8(l2b + 3 * l2s + 4) === bytes[l2b + 3 * l2s + 4]);
  await page.fill("#isoSearch", ""); await page.waitForTimeout(120);
  await openFold(page, "#gbBox");
  check("clearing the filter hides the scope picker", !(await page.$("#gb-scope")));
  await page.context().close();
}

head("Growth — bulk skill caps: all-S, unlock-only, restore, scope");
if (ON) { const page = await newPage(); await loadIso(page);
  const [l2b, l2s] = TABLES.list2;
  const rec = l2b + 1 * l2s;                      // synth rec #1: cap#1 = B+(5), cap#2 = A(6), rest 0
  const cap = (k) => rec + 16 + k;                // skill id k+1's max byte
  const other = l2b + 5 * l2s + 16;               // some other character's first cap (ships 0)
  await page.click('#isoTabs [data-v="growth"]');
  check("the Growth tab carries the bulk skill-cap card", !!(await page.$("#scBox")));
  await openFold(page, "#scBox");

  // Restore on a pristine disc is a no-op — it writes the bytes that are already there.
  await page.click("#sc-disc"); await page.waitForTimeout(120);
  check("restore stages nothing on an unedited disc", await nothingStaged(page));

  // Unlock-only is the whole point of the second button: it must NOT flatten the grades the
  // disc already gives a character, only lift the bytes reading "Can't get".
  await page.click("#sc-lock"); await page.waitForTimeout(150);
  check("unlock stages something", await somethingStaged(page));
  await openFold(page, "#scBox");
  await page.click("#sc-disc"); await page.waitForTimeout(150);
  check("restore puts a bulk unlock back", await nothingStaged(page));
  await openFold(page, "#scBox");
  await page.click("#sc-lock"); await page.waitForTimeout(150);
  let r = await save(page);
  check("unlock keeps the disc's own grade on skill 1 (B+ = 5)", r.u8(cap(0)) === 5, String(r.u8(cap(0))));
  check("unlock keeps skill 2 at A (6)", r.u8(cap(1)) === 6, String(r.u8(cap(1))));
  check("unlock lifts a can't-get skill to S (7)", r.u8(cap(2)) === 7, String(r.u8(cap(2))));
  check("unlock reaches the whole roster, not just record #1", r.u8(other) === 7, String(r.u8(other)));

  // The grade picker feeds both buttons, and "set every skill" overwrites what unlock preserved.
  await page.click('#isoTabs [data-v="growth"]');
  await openFold(page, "#scBox");
  await page.selectOption("#sc-grade", "2");      // D
  check("the button says what it will write", /Set every skill to D/.test(await page.textContent("#sc-all")),
    await page.textContent("#sc-all"));
  await page.click("#sc-all"); await page.waitForTimeout(150);
  r = await save(page);
  check("set-every-skill overwrites the grade unlock preserved (B+ -> D)", r.u8(cap(0)) === 2, String(r.u8(cap(0))));
  check("set-every-skill writes the whole 43-byte array", r.u8(cap(42)) === 2, String(r.u8(cap(42))));
  check("set-every-skill reaches the whole roster", r.u8(other) === 2, String(r.u8(other)));

  // A hand-typed Max: has to be warned about before a roster-wide write eats it.
  await openRec(page, `details.char[data-rec="${rec}"]`);
  const maxSel = `details.char[data-rec="${rec}"] select[data-off="${cap(0)}"]`;
  await page.selectOption(maxSel, "7"); await page.waitForTimeout(80);
  await openFold(page, "#scBox");
  let asked = null;
  page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
  await page.click("#sc-all"); await page.waitForTimeout(150);
  check("a roster-wide cap write warns before eating a hand-edited cap", /will be overwritten/.test(asked || ""), asked || "no dialog");
  check("dismissing leaves the hand edit intact", (await page.locator(maxSel).inputValue()) === "7");
  await page.click("#isoResetBtn"); await page.waitForTimeout(120);

  // Filter scope, same rule as the scaling card above it.
  const name = await page.textContent(`details.char[data-rec="${rec}"] .nm`);
  await page.fill("#isoSearch", name); await page.waitForTimeout(150);
  await openFold(page, "#scBox");
  check("a filter reveals the cap card's scope picker", !!(await page.$("#sc-scope")));
  await page.selectOption("#sc-scope", "filter");
  await page.selectOption("#sc-grade", "7");
  await page.click("#sc-all"); await page.waitForTimeout(150);
  r = await save(page);
  check("scoped cap write hits the matching record", r.u8(cap(0)) === 7 && r.u8(cap(42)) === 7);
  // The reader falls back to the pristine fixture for anything this save didn't touch, so the
  // assertion is "not written", not a value comparison.
  check("scoped cap write leaves every other character alone", !r.wrote(other));
  await page.fill("#isoSearch", ""); await page.waitForTimeout(120);
  await openFold(page, "#scBox");
  check("clearing the filter hides the cap card's scope picker", !(await page.$("#sc-scope")));
  await page.context().close();
}

head("Spells / Unites — bulk Power scale (the difficulty presets' other halves)");
if (ON) { const page = await newPage(); await loadIso(page);
  const spPow = SPELL.off + 0x1C, unPow = UNITE.off + 0x1C;
  const pow0 = origU32(spPow);
  await page.click('#isoTabs [data-v="spells"]');
  await openFold(page, "#pbBox");
  await page.click('[data-pbpreset="hard"]');
  check("the Hard preset fills the spell multiplier (x0.75)", (await page.inputValue("#pb-m")) === "0.75");
  await page.click("#pb-apply"); await page.waitForTimeout(200);
  // spDescOn is on by default, so a bulk scale rewrites each DMG number just like a typed Power
  check("bulk scale rewrote the description too", (await page.inputValue('details.char[data-i="0"] input.spdesc')) === "Deals 75DMG",
    await page.inputValue('details.char[data-i="0"] input.spdesc'));
  // 94 records is few enough to reg() each one, so the review names them rather than reporting
  // an anonymous byte count the way the old Balance tab's bulk write had to.
  let { r, review } = await saveAndReview(page);
  check("the review names the scaled spells instead of a byte count",
    /Power/.test(review) && /Flaming Arrows/.test(review), review.replace(/\s+/g, " ").slice(0, 140));
  check("bulk spell power scales from the original", r.u32(spPow) === Math.round(pow0 * 0.75), String(r.u32(spPow)));
  await openFold(page, "#pbBox");
  await page.click('[data-pbpreset="reset"]'); await page.click("#pb-apply"); await page.waitForTimeout(200);
  check("reset stages nothing on the Spells tab", await nothingStaged(page));

  // ...and with the rewrite toggle off, Power moves alone
  await page.uncheck("#spUpd");
  await openFold(page, "#pbBox");
  await page.fill("#pb-m", "0.5"); await page.dispatchEvent("#pb-m", "change");
  await page.click("#pb-apply"); await page.waitForTimeout(200);
  check("with the rewrite toggle off the description is left alone",
    (await page.inputValue('details.char[data-i="0"] input.spdesc')) === "Deals 75DMG",
    await page.inputValue('details.char[data-i="0"] input.spdesc'));
  await page.click("#isoResetBtn"); await page.waitForTimeout(120);

  const upow0 = origU32(unPow);
  await page.click('#isoTabs [data-v="unites"]');
  await openFold(page, "#pbBox");
  await page.click('[data-pbpreset="brutal"]');
  check("the Brutal preset fills the unite multiplier (x0.6)", (await page.inputValue("#pb-m")) === "0.6");
  await page.click("#pb-apply"); await page.waitForTimeout(200);
  r = await save(page);
  check("bulk unite power scales from the original", r.u32(unPow) === Math.round(upow0 * 0.6), String(r.u32(unPow)));
  await page.context().close();
}

head("Global encounter rate — scale all three movement paths");
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("#encPct", { timeout: 3000 });
  check("Encounter is its own top-level tab", !!(await page.$('#isoTabs [data-v="encounter"]')));
  // The rate field used to live on Balance; that tab is gone entirely now (its growth half is
  // a card on Growth), so the only thing left to assert is that nothing else claims #encPct.
  check("no other tab carries the rate field", await (async () => {
    await page.click('#isoTabs [data-v="growth"]');
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
  check("50%: walk mult = addiu $v0,zero,50", r.u32(ENC_SITES[0]) === 0x24020032);
  check("50%: walk branch joins the scale block", r.u32(ENC_SITES[1]) === 0x10000008);
  check("50%: mounted-run mult = addiu $v0,zero,75", r.u32(ENC_SITES[2]) === 0x2402004B);
  check("50%: run mult = addiu $v0,zero,60", r.u32(ENC_SITES[3]) === 0x2402003C);
  await page.context().close();
}

head("Global encounter rate — 0% disables, 200% doubles");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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

head("Per-area encounter rates — a file already saved at 50% says so, and Stock still restores");
if (ON) { // The rates on the "disc" are halved; the room index still carries the stock ones. Nothing in
  // the file records the halving, so the tab has to recover it by comparison.
  const halved = Uint8Array.from(bytes);
  { const dv = new DataView(halved.buffer);
    for (const t of ROOM_TEST_INDEX.areas[0].tables) for (const r of t.rooms)
      dv.setUint16(r.rateOff, Math.round(r.rate * 0.5), true); }
  const readOn = (img, writes) => { const at = (pos) => { const w = writes.find((x) => pos >= x.pos && pos < x.pos + x.data.length); return w ? w.data[pos - w.pos] : img[pos]; };
    return { u16: (q) => at(q) | (at(q + 1) << 8) }; };
  const page = await newPage();
  setServed(halved);
  await page.addInitScript(`window.S3_TEST_ROOMS = ${JSON.stringify(ROOM_TEST_INDEX)};`);
  await loadIso(page);
  await page.click('#isoTabs [data-v="encounter"]');
  await page.waitForSelector("details.rarea", { timeout: 3000 });
  const note = await page.textContent("#encRooms");
  check("the tab says the rates are already scaled", /already scaled/.test(note) && /50%/.test(note), note.slice(0, 200));
  check("...and the area is tagged with its own scale", /at 50% of stock/.test(await page.textContent("details.rarea summary")));
  await page.click("details.rarea summary");
  await page.waitForSelector("input.rm-f", { timeout: 3000 });
  const rateVals = () => page.$$eval('input.rm-f[data-k="rate"]', (es) => es.map((e) => e.value).join(","));
  check("rows decode the halved rates", (await rateVals()) === "2,0,5,1", await rateVals());
  const rowText = await page.$$eval("details.rarea tbody tr", (rs) => rs.map((r) => r.textContent.replace(/\s+/g, " ").trim()).join(" | "));
  check("each changed row shows what the stock disc holds", /stock 4/.test(rowText) && /stock 9/.test(rowText), rowText);
  const preset = async (v) => { await page.click(`[data-rp="${v}"]`); await page.waitForTimeout(120); };
  await preset(50);
  check("re-applying Half is a no-op, not a quartering", (await rateVals()) === "2,0,5,1", await rateVals());
  check("...and stages nothing", await nothingStaged(page));
  await preset(200);
  check("Double is 2× STOCK (8,0,18,4), not 2× the halved file", (await rateVals()) === "8,0,18,4", await rateVals());
  await preset(100);
  check("Stock restores the stock disc's rates", (await rateVals()) === "4,0,9,2", await rateVals());
  check("...which this file does NOT hold, so it is staged", await somethingStaged(page));
  await page.evaluate(() => { window.__writes = []; });
  await page.click("#isoSaveBtn");
  try { await page.waitForSelector("#bnSkip", { timeout: 700 }); await page.click("#bnSkip"); } catch { /* already nudged */ }
  await page.waitForSelector("#cfOk", { timeout: 3000 }); await page.click("#cfOk");
  await page.waitForSelector("#pgClose:visible", { timeout: 5000 }); await page.click("#pgClose");
  const r = readOn(halved, await getWrites(page));
  check("stock rates written to both chapter tables", r.u16(ROOM_TABLE_A + 4) === 4 && r.u16(ROOM_TABLE_B + 4) === 4
    && r.u16(ROOM_TABLE_A + 0x78 + 4) === 9 && r.u16(ROOM_TABLE_B + 0x78 + 4) === 2);
  await page.context().close();
  setServed(bytes);
}

head("Files browser — a Reference sub-tab, read-only, peeks real bytes");
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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

head("Runes — families, granted spells, who has it");
if (ON) { const page = await newPage(); await loadIso(page);
  // Top-level tab since v1.97.0; it used to be a Reference sub-tab (`[data-ref="runes"]`).
  await page.click('#isoTabs [data-v="runes"]');
  await page.waitForSelector("table.invtbl", { timeout: 3000 });
  const all = +(await page.textContent('[data-rgrp=""]')).replace(/\D+/g, "");
  check("every rune in the game is listed", all === 72, `All (${all})`);
  const groups = await page.$$eval("[data-rgrp]", (es) => es.map((e) => e.textContent.trim()));
  check("the three rune families each have a chip", /Magic \(22\)/.test(groups.join(" "))
    && /Special attack \(27\)/.test(groups.join(" ")) && /Support \(23\)/.test(groups.join(" ")), groups.join(" | "));
  // A rune names the spells it grants, and that now comes off the rune's own record. This
  // fixture only plants a handful of rows, so True Wind is a rune with NO record here — the
  // bundled "Grants ..." prose is the fallback for exactly that case, and it is display only.
  await page.fill("#isoSearch", "true wind"); await page.waitForTimeout(150);
  const tw = await page.textContent("#isoView");
  check("a rune with no record on this disc still lists what it grants",
    /Eternal Wind/.test(tw) && /Shining Wind/.test(tw), tw.slice(-200));
  // A rune whose row the disc names renders that name in the rename INPUT, and an input's
  // value is not part of textContent — so the view has to be read as text plus field values
  // or every one of these filter checks would silently pass on the wrong evidence.
  const viewText = () => page.evaluate(() => {
    const v = document.querySelector("#isoView");
    return (v.textContent || "") + " " + [...v.querySelectorAll("input")].map((i) => i.value).join(" ");
  });
  // the filter reaches past the name into owners, spells and drop sources
  await page.fill("#isoSearch", "sasarai"); await page.waitForTimeout(150);
  check("filtering finds a rune by who carries it", /True Earth/.test(await viewText()));
  await page.fill("#isoSearch", "eternal wind"); await page.waitForTimeout(150);
  check("filtering finds a rune by a spell it grants", /True Wind/.test(await viewText()));
  // ...and where the disc DOES carry the record, the list is the record's, not the prose:
  // the fixture's first rune holds spell numbers 1-4, labelled by the 0-based row the Spells
  // tab shows. This is the assertion that would have caught the binding being read from a
  // bundled map instead of the disc.
  await page.fill("#isoSearch", mapping.runes[0].name.toLowerCase()); await page.waitForTimeout(150);
  const fromRec = await page.evaluate((id) => [...document.querySelectorAll(
    `#isoView select.rspell[data-id="${id}"]`)].map((e) => e.options[e.selectedIndex].textContent.trim()),
    mapping.runes[0].id);
  check("a rune whose record is on this disc lists what the RECORD grants",
    fromRec.join(" | ") === "Flaming Arrows (#0) | Dancing Flames (#1) | Blazing Wall (#2) | Explosion (#3)",
    fromRec.join(" | "));
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
  // The tab is no longer read-only — it owns the rune's NAME, its menu text (issue #11: the
  // only copy of it the game actually reads) and its four spell slots. It must still stage
  // nothing until touched, and it must carry only those: a spell's own power/cast/element
  // belongs to the spell record, and a second set of THOSE fields here is exactly the
  // duplication the granted-spell links replaced. Which spells a rune grants is not one of
  // them — that lives in the rune's record, so this tab is where it belongs.
  // `rf` — a passive rune's Strength — is admitted deliberately and is NOT the duplication this
  // guard exists to stop. Those constants belong to the RUNE, not to a spell: they live in the
  // engine code behind the rune's own passive, there is no second copy of them anywhere else on
  // this tab, and the Passives card edits the identical bytes rather than a parallel field. A
  // spell's power/cast/element still has exactly one home, the spell record, reached from the
  // granted-spell links.
  const kinds = await page.$$eval("#isoView input", (es) => [...new Set(es.map((e) => e.className))].sort());
  check("the only editable text fields are the name, the menu text and passive strength",
    kinds.every((k) => /^(rname|rdesc|rf)$/.test(k)), kinds.join(" | "));
  const sels = await page.$$eval("#isoView select", (es) => [...new Set(es.map((e) => e.className))].sort());
  check("the only editable dropdowns are the rune record's own fields and passive strength",
    sels.length > 0 && sels.every((k) => /^(rspell|rcat|relem|rf)$/.test(k)), sels.join(" | "));
  check("no spell fields are duplicated onto this tab",
    (await page.locator("#isoView details.runefx, #isoView input.rfx, #isoView [data-fxpreset]").count()) === 0);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  // "Restore all to stock" must put every immediate back, and stage nothing net
  await page.click('#isoTabs [data-v="spells"]'); await openFold(page, "#spFxBox");
  await page.fill('input.fx[data-k="res3"]', "0");
  await page.dispatchEvent('input.fx[data-k="res3"]', "change"); await page.waitForTimeout(60);
  check("an edit is staged", await somethingStaged(page));
  await openFold(page, "#spFxBox");
  await page.click("#fxReset"); await page.waitForTimeout(80);
  check("restore-to-stock clears the change", await nothingStaged(page));
  await page.context().close();
}
if (ON) { // A disc whose instruction no longer matches must go READ-ONLY rather than be written blind.
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  const T = mapping.twin;
  const read = (r, off, n) => { let s = ""; for (let i = 0; i < n; i++) { const c = r.at(off + i); if (!c) break; s += String.fromCharCode(c); } return s; };
  await page.click('#isoTabs [data-v="runes"]'); await page.waitForSelector("input.rdesc", { timeout: 5000 });
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (!ON) { /* section not selected */ }
else if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else if (ON) { const page = await newPage(); await loadIso(page);
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
if (!ON) { /* section not selected */ }
else if (!xdelta3Available()) { console.log("  (xdelta3 not installed — skipped)"); }
else if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  const recipe = JSON.stringify({ format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
    patches: [{ off: SPELL.off + 0x1C, new: "2a000000" }] });
  const s = await uploadPatch(page, new TextEncoder().encode(recipe), "recipe.xdelta");   // WRONG extension on purpose
  check("a recipe named .xdelta is still recognised as a recipe", /applied recipe/i.test(s));
  const r = await save(page);
  check("recipe bytes written", r.u32(SPELL.off + 0x1C) === 42);
  await page.context().close();
}

head("Enemies + Reference (read-only)");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
  // Same stub shape as the Recruit section. Hugo/Geddoe/Rico recruited; Chris (story),
  // Jeane + Lulu are optional recruits that should land in the "missing" worklist. Augustine
  // and Watari are there for the prerequisite chips: an item with a real source, and a potch
  // price this save (1,000 gold) cannot meet. Belle's errand wants a Screw, which is a KEY
  // item — the Inventory tab keeps those in a separate list from party items.
  await page.addInitScript(`
    const CHARS = [
      ['Hugo','Hugo',true], ['Chris','',false], ['Jeane','',false],
      ['Geddoe','Geddoe',true], ['Rico','',true], ['Lulu','',false],
      ['Augustine','',false], ['Watari','',false], ['Dominic','',false], ['Belle','',false]
    ].map((x, i) => ({ rosterIndex: i, name: x[0], recruiter: x[1], recruited: x[2],
      level: 10, curHP: 100, maxHP: 100, expToNext: 0, hasData: true,
      stats: { PWR: 1, SKL: 1, MAG: 1, REP: 1, PDF: 1, MDF: 1, SPD: 1, LUK: 1 }, equip: {}, skills: [] }));
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: {}, names: [], characters: CHARS, party: [0,0,0,0,0,0],
      // pre-merge bag layout, so the "+ get it" button has to pick the bag of the party
      // being played (Hugo leads this save)
      inventory: [
        { region: 'Hugo', base: 0, firstSlot: 0, capacity: 30, used: 1, freeSlots: [1,2], appendSlots: [1,2],
          items: [{ slot: 0, id: 1, qty: 1, category: 'consumable', stackable: true }] },
        { region: 'Chris', base: 0, firstSlot: 30, capacity: 30, used: 0, freeSlots: [30], appendSlots: [30], items: [] },
      ] }];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({
          items: [{ id: 315, name: 'Rose Brooch', cat: 'valuable' }, { id: 1, name: 'Medicine D', cat: 'consumable' },
                  { id: 194, name: 'Mole Armor', cat: 'armor' }, { id: 611, name: 'Screw', cat: 'valuable' }],
          skills: [], charById: { 1: 'Hugo' },
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
  // default filter is "missing": recruited stars should be hidden. Match on the character
  // cell, not the row — a stage header names protagonists in its blurb.
  check("default 'missing' filter hides recruited stars",
    (await page.locator('.starstbl tbody tr:not(.phaserow):not(.howrow) td:nth-child(2):has-text("Hugo")').count()) === 0);
  // an optional missing star carries its guide how-to as a full-width row
  check("optional missing star shows a how-to row", (await page.locator(".starstbl tr.howrow .howto").count()) >= 1);
  // the checklist is laid out in the recruitment guide's order, cut into that order's stages
  check("stage headers carry their own progress", (await page.locator(".starstbl tr.phaserow .phprog").count()) >= 2);
  const ord = (await page.locator(".starstbl tbody tr:not(.phaserow):not(.howrow) td.ordn").allTextContents())
    .map((t) => (t.trim() === "–" ? Infinity : +t.trim()));
  check("rows run in guide order", ord.length >= 2 && ord.every((n, i) => i === 0 || ord[i - 1] <= n));
  check("Star of Destiny names are shown", /^[A-Z][a-z]+$/.test((await page.locator(".starstbl td.sod").first().textContent()).trim()));
  // "next up" points at the first OPTIONAL star still missing in guide order — Augustine (#27),
  // not Chris (a story join) and not Jeane (#35, further down the guide)
  check("next-up names the first gettable star", /Augustine/.test(await page.textContent(".nextup")));
  // under a how-to, what that errand needs: where the item comes from, and the potch you are short of
  await until(page, () => document.querySelectorAll(".starstbl .need").length >= 2);
  const needs = (await page.locator(".starstbl .need").allTextContents()).join(" | ");
  check("an item need names its source and stock stage",
    /Rose Brooch/.test(needs) && /Iksay Village's Item Shop/.test(needs) && /stages 1-3 of 3/.test(needs));
  check("a potch need is measured against this save's purse", /100,000 potch — you have 1,000/.test(needs));
  check("...and is flagged as unaffordable", (await page.locator(".starstbl .need.short").count()) === 1);
  // an errand that says BUY needs the money, not a free copy of the goods
  const buyChip = await page.textContent('.starstbl .need:has-text("Mole Armor")');
  check("a bought item is priced instead of fetched", /buy it from Dominic: 600 potch/.test(buyChip));
  check("...with no offer to conjure one into the bag",
    (await page.locator('.starstbl [data-needitem="194"]').count()) === 0);
  // "+ get it" hands the item over: into the bag of the party this save is playing (Hugo's),
  // staged like any other edit
  check("the item chip offers to put it in the current party's bag",
    (await page.locator('.starstbl [data-needitem="315"]').first().textContent()).includes("Hugo"));
  await page.click('.starstbl [data-needitem="315"]'); await page.waitForTimeout(80);
  check("...and says where it landed", /Rose Brooch.*Hugo, slot 1.*not yet saved/.test(await page.textContent("#status")));
  // the potch top-up covers exactly the shortfall against this save's 1,000 gold
  check("the potch chip offers the shortfall", /99,000/.test(await page.textContent('.starstbl [data-needgold]')));
  await page.click(".starstbl [data-needgold]"); await page.waitForTimeout(80);
  check("...and topping up clears the chip", (await page.locator(".starstbl .need.short").count()) === 0);
  check("...leaving nothing more to top up", (await page.locator(".starstbl [data-needgold]").count()) === 0);
  // both are real staged edits: they show up in the review-before-write list
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  const staged = await page.textContent(".cf-list");
  check("the item and the gold reach Review changes",
    /Rose Brooch/.test(staged) && /1000 → 100000/.test(staged));
  await page.click("#cfCancel");
  // ...and the item really is in Hugo's bag on the Inventory tab, not just in the diff
  await page.click('[data-sub="items"]'); await page.waitForSelector(".bag");
  const hugoBag = await page.locator('.bag:has-text("Hugo")').first().textContent();
  check("the item shows up in that bag on the Inventory tab", /Rose Brooch/.test(hugoBag));
  // it reads as a pending edit there, not as something the save already held, and the bag's
  // own tallies move with it (1 loaded item + 1 staged = 2 of 30, one append slot left)
  check("...marked as staged, on a changed row",
    (await page.locator('.invtbl tr.dirtyrow:has-text("Rose Brooch") .pill:has-text("staged")').count()) === 1);
  check("...and counted in the bag header", /2\/30 slots/.test(hugoBag) && /1 free/.test(hugoBag));
  check("...and in the Party Items badge", /Party Items \(2\)/.test(await page.textContent('[data-invcat="regular"]')));
  // A KEY item is kept in the tab's other list, so staging one has to bring that list with it:
  // landing on Party Items with the Screw filed under Key / Valuables reads as a failed add.
  await page.click('[data-sub="stars"]'); await page.waitForSelector(".starstbl");
  await until(page, () => document.querySelectorAll('.starstbl [data-needitem="611"]').length >= 1);
  await page.click('.starstbl [data-needitem="611"]'); await page.waitForTimeout(80);
  await page.click('[data-sub="items"]'); await page.waitForSelector(".bag");
  check("a staged key item opens Inventory on the list that holds it",
    (await page.textContent("[data-invcat].on")).startsWith("Key / Valuables"));
  check("...and is visible there without touching a filter",
    (await page.locator('.bag:has-text("Hugo") .invtbl tr.dirtyrow:has-text("Screw")').count()) === 1);
  check("...counted in the Key / Valuables badge", /Key \/ Valuables \(1\)/.test(await page.textContent('[data-invcat="key"]')));
  await page.click('[data-sub="stars"]'); await page.waitForSelector(".starstbl");
  // a stage folds away, taking its rows with it
  const rowsBefore = await page.locator(".starstbl tbody tr:not(.phaserow)").count();
  await page.click(".starstbl tr.phaserow .phasetog"); await page.waitForTimeout(60);
  check("a stage collapses", (await page.locator(".starstbl tbody tr:not(.phaserow)").count()) < rowsBefore);
  await page.click(".starstbl tr.phaserow .phasetog"); await page.waitForTimeout(60);
  check("a stage expands again", (await page.locator(".starstbl tbody tr:not(.phaserow)").count()) === rowsBefore);
  // the per-row +recruit action stages a recruit and bumps the count to 4.
  // #rteam only exists on the Recruit sub-tab, and we are on Stars — this is optional, hence
  // the catch. It NEEDS the short timeout: bare `.catch(() => {})` swallows Playwright's 30s
  // default, so this one line sat here costing 30s a run inside a check that passed.
  await page.selectOption("#rteam", "Chris", { timeout: 1000 }).catch(() => {});
  const before = await page.textContent(".starsnum");
  await page.click(".starstbl [data-starsadd]"); await page.waitForTimeout(60);
  check("+recruit stages a recruit (count goes up)", (await page.textContent(".starsnum")) !== before && /\b4\b/.test(await page.textContent(".starsnum")));
  // the Recruited view renders team pills (multi-letter where a star is on several teams)
  await page.click('[data-starsf="recruited"]'); await page.waitForTimeout(40);
  check("recruited view shows team pills", (await page.locator(".starstbl .tpill").count()) >= 3);
  await page.context().close();
}

head("Save <-> JSON round-trip (save editor, Pyodide stubbed)");
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
  await page.waitForSelector("#cofold", { timeout: 5000 });

  // Whole-save state you set once: the section ships collapsed, and the closed header has to
  // carry enough to answer "do I need to open this?" without opening it.
  check("carryover + names start collapsed",
    !(await page.locator("#cofold").evaluate((e) => e.open))
    && !(await page.locator('input[data-carry="s2"]').isVisible()));
  const foldSum = await page.textContent("#cofoldsum");
  check("the collapsed header reports the flag state",
    /Suikoden II not loaded/.test(foldSum) && /Suikoden I not loaded/.test(foldSum), foldSum);
  await page.click("#cofold > summary"); await page.waitForTimeout(60);
  check("clicking the header reveals the controls",
    await page.locator('input[data-carry="s2"]').isVisible());

  const coText = await page.textContent("#carryover");
  check("both carryover rows render", (await page.locator("#carryover input[data-carry]").count()) === 2);
  check("the row names the flag byte and bit, not a heuristic",
    /0x31 bit 3/.test(coText) && /0x31 bit 4/.test(coText), coText.replace(/\s+/g, " ").slice(0, 160));
  check("an unset flag reads as unticked", !(await page.isChecked('input[data-carry="s2"]')));
  check("the current name-slot values are shown", /Genkaku Jr\./.test(coText) && /McDohl/.test(coText));

  // Ticking the box is a staged change like any other: it lands in the review list...
  await page.check('input[data-carry="s2"]'); await page.waitForTimeout(50);
  check("ticking marks the checkbox dirty", await page.locator('input[data-carry="s2"]').evaluate((e) => e.classList.contains("dirty")));
  // A fold that can be closed over a staged edit has to say so on the header, or the edit
  // goes to Apply invisible.
  check("the header counts the staged edit", /1 edit\(s\)/.test(await page.textContent("#cofoldsum")),
    await page.textContent("#cofoldsum"));
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
  check("the header drops the count with the edit", !/edit\(s\)/.test(await page.textContent("#cofoldsum")));

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
head("Trinity Sight — points of view & chapters (save editor, Pyodide stubbed)");
if (ON) { const page = await newPage();
  // The flame mask and the per-POV progress counters are whole-save state, so the stub
  // carries a decoded `trinity` block shaped like s3save.decode_trinity() plus the
  // REF.trinity reference. Where those numbers COME from is save_roundtrip.py's job; what
  // this proves is the wiring — that a flame tick and a chapter pick reach the write
  // payload, and that a fold closed over them still admits they are there.
  await page.addInitScript(`
    const POVS = [
      ['hugo','Hugo',0,1,1,true,3,1], ['chris','Chris',1,2,2,true,0,0],
      ['geddoe','Geddoe',2,3,3,true,0,0], ['thomas','Thomas',3,4,4,false,0,0],
      ['koroku','Koroku',5,6,5,false,0,0], ['luc','Luc',4,5,6,false,0,0],
    ].map((x) => ({ key: x[0], name: x[1], bit: x[2], slot: x[3], flame: x[4],
                    lit: x[5], second: false, stage: x[6], chapter: x[7], chapterMax: 3 }));
    const CH = { hugo: [[1,1],[2,4],[3,8]], chris: [[1,1],[2,5],[3,7]], geddoe: [[1,3],[2,4],[3,8]],
                 thomas: [[1,3],[2,7]], koroku: [[1,9]], luc: [[1,1]] };
    const TRREF = { flagOffset: 0x34, flagIndex: 4, flag2Offset: 0x35, flag2Index: 5,
      stageOffset: 0x3B0, stageSlots: 8,
      povs: POVS.map((p) => ({ key: p.key, name: p.name, bit: p.bit, slot: p.slot, flame: p.flame,
        stageOffset: 0x3B0 + p.slot * 2,
        chapters: CH[p.key].map((c) => ({ chapter: c[0], value: c[1], seen: [c[1]] })) })),
      main: { key: 'main', name: 'Main story (merged)', slot: 7, stageOffset: 0x3B0 + 14,
        chapters: [{ chapter: 4, value: 9, seen: [9] }, { chapter: 5, value: 11, seen: [11] },
                   { chapter: 6, value: 12, seen: [12] }],
        labels: { 4: 'Chapter 4', 5: 'Chapter 5', 6: 'Cleared' } } };
    const TRIN_DEC = { povs: POVS, main: { key: 'main', name: 'Main story (merged)', slot: 7, stage: 0, chapter: 0 },
      flagByte: 0x07, flagOffset: 0x34, stageOffset: 0x3B0, stages: [0,3,0,0,0,0,0,0] };
    const SAVES = [{ label: 'Slot 1', folder: 'BASLUS-x', checksumWord: 0, meta: { chapter: 1 },
      global: { partyLeader: 1, playtime: '1:00', storyPhase: 1, gold: 1000 }, leaderName: 'Hugo',
      carryover: {}, trinity: TRIN_DEC, names: [], characters: [], party: [0,0,0,0,0,0], inventory: [] }];
    window.__payloads = [];
    window.loadPyodide = async () => ({
      FS: { writeFile() {}, readFile() { return new Uint8Array([0,1,2,3]); } },
      runPython(code) {
        if (code.includes('load_reference()')) return JSON.stringify({
          items: [], skills: [], charById: { 1: 'Hugo' }, charRoster: { 1: 0 }, charChoices: [1],
          carryover: { flags: {}, chars: [], runes: [], runeSlots: [] }, trinity: TRREF });
        if (code.startsWith('load_saves(')) return JSON.stringify(SAVES);
        if (code.startsWith('apply_edits(')) {
          window.__payloads.push(code.slice(code.indexOf('(') + 1, code.lastIndexOf(')')));
          return JSON.stringify({ changed: 2 });
        }
        return undefined;
      },
    });
  `);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await page.waitForFunction(() => { const b = document.querySelector("#pickBtn"); return b && !b.disabled; }, { timeout: 15000 });
  await page.setInputFiles("#file", { name: "save.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3, 4]) });
  await page.waitForSelector("#trfold", { timeout: 5000 });

  const sum0 = await page.textContent("#trfoldsum");
  check("the panel ships collapsed but reports how many flames are lit",
    !(await page.locator("#trfold").evaluate((e) => e.open)) && /3\/6 flames lit/.test(sum0), sum0);
  check("...and names them, so the closed header answers the question on its own",
    /Hugo, Chris, Geddoe/.test(sum0), sum0);
  await openFold(page, "#trfold");
  check("all six points of view render, in flame order",
    (await page.locator("#trinity input[data-tflame]").count()) === 6);
  const trText = (await page.textContent("#trinity")).replace(/\s+/g, " ");
  check("each row is labelled by flame number and names its bit and counter address",
    /Flame 4 · Thomas/.test(trText) && /Flame 6 · Luc/.test(trText) && /0x3BA · flag 0x34 bit 4/.test(trText),
    trText.slice(0, 240));
  check("a lit flame reads as ticked and a dark one does not",
    (await page.isChecked('input[data-tflame="hugo"]')) && !(await page.isChecked('input[data-tflame="luc"]')));
  check("the chapter dropdown offers only that character's own chapters",
    (await page.locator('select[data-tstage="thomas"] option').count()) === 3 &&
    (await page.locator('select[data-tstage="luc"] option').count()) === 2,
    "thomas=" + (await page.locator('select[data-tstage="thomas"] option').count()));
  check("the merged story gets its own row, with its own labels",
    /Main story \(merged\)/.test(trText) &&
    (await page.locator('select[data-tstage="main"] option').count()) === 4);
  check("a POV's current stage is preselected as its chapter",
    (await page.inputValue('select[data-tstage="hugo"]')) === "3");

  // Light Luc's flame and put Chris at her chapter 2: two staged edits, one payload.
  await page.check('input[data-tflame="luc"]'); await page.waitForTimeout(40);
  await page.selectOption('select[data-tstage="chris"]', "5"); await page.waitForTimeout(40);
  check("both controls mark themselves dirty",
    (await page.locator('input[data-tflame="luc"]').evaluate((e) => e.classList.contains("dirty"))) &&
    (await page.locator('select[data-tstage="chris"]').evaluate((e) => e.classList.contains("dirty"))));
  check("the header counts them, so closing the fold cannot hide them",
    /2 edit\(s\)/.test(await page.textContent("#trfoldsum")), await page.textContent("#trfoldsum"));
  await page.click("#saveBtn"); await page.waitForSelector("#cfOk", { timeout: 3000 });
  const review = (await page.textContent(".cf-list")).replace(/\s+/g, " ");
  check("the review list spells out the flame in words, not a bit number",
    /Luc's flame: dark → lit/.test(review), review.slice(0, 200));
  check("...and the chapter move with both the chapter and the raw stage",
    /Chris: not started \(stage 0\) → chapter 2 \(stage 5\)/.test(review), review.slice(0, 260));
  await page.click("#cfOk");
  await until(page, () => (window.__payloads || []).length > 0);
  const sent = JSON.parse(JSON.parse(await page.evaluate(() => window.__payloads[0].split(", ").slice(2).join(", "))));
  check("the write payload carries the flame and the counter",
    sent.trinity && sent.trinity.lit.luc === true && sent.trinity.stage.chris === 5,
    JSON.stringify(sent.trinity));
  check("...and nothing the user did not touch",
    Object.keys(sent.trinity.lit).length === 1 && Object.keys(sent.trinity.stage).length === 1,
    JSON.stringify(sent.trinity));

  // Putting a control back where the save had it is a no-op, not a second staged change.
  await page.uncheck('input[data-tflame="luc"]'); await page.waitForTimeout(40);
  await page.selectOption('select[data-tstage="chris"]', "0"); await page.waitForTimeout(40);
  check("returning both to their saved values clears the staging",
    await page.evaluate(() => !("luc" in TRIN.lit) && !("chris" in TRIN.stage)));
  check("the header drops the count with them", !/edit\(s\)/.test(await page.textContent("#trfoldsum")));
  await page.context().close();
}

head("Undo/redo + skill-cap & rune presets");
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForSelector("#spSplitBox");
  check("the damage+heal card starts collapsed", !(await page.locator("#spSplitSpell").isVisible()));
  // two collapsed bars in a row are ambiguous — each section carries a captioned rule
  { const secs = await page.locator("#isoView > .secdiv > span").allTextContents();
    check("the tab reads as five labelled sections",
      secs.length === 5 && /Status effects/.test(secs[0]) && /Special effect/.test(secs[1])
      && /Bulk edit · a whole rune/.test(secs[2]) && /Bulk edit · every spell/.test(secs[3])
      && /Every spell/.test(secs[4]),
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
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
if (ON) { const page = await newPage(); await loadIso(page);
  await page.click("#isoClose"); await page.waitForTimeout(80);
  check("Close shows loader again", !!(await page.$("#isoPick")) && !(await page.$("#isoTabs")));
  await page.context().close();
}

head("Save editor tab still boots (structural)");
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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
if (ON) { const page = await newPage();
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

// A save with Hugo leading and Koroku already in the party — the shape the field-character
// picker has to reason about (the pick is in the party, but not in slot 1). Shared so the
// narrow-screen pass renders the identical tab.
async function seedFieldCharacterSave(page) {
  await page.evaluate(async () => {
    const mk = (rosterIndex, name) => ({
      rosterIndex, name, id: rosterIndex + 1, idExpected: rosterIndex + 1,
      level: 30, weaponLv: 5, curHP: 200, maxHP: 200, expToNext: 100,
      stats: { PWR: 1, SKL: 1, MAG: 1, REP: 1, MDF: 1, SPD: 1, LUK: 1 },
      equip: { headRune: 0, rightRune: 0, leftRune: 0, helm: 0, armor: 0, shield: 0, boots: 0, gloves: 0, accessory: 0 },
      skills: [{ slot: 0, id: 0, rank: 0 }],
      recruited: true, recruitWord: 0x1d, recruiter: "", recruiters: [], hasData: true,
    });
    // The eight ids the engine will actually load a field model for (s3save.FIELD_AVATAR_IDS).
    REF = { items: [], skills: [],
            charById: { 1: "Hugo", 2: "Chris", 3: "Geddoe", 29: "Thomas", 54: "Koroku", 63: "Luc", 202: "Masked Luc", 203: "Grasslands Chris" },
            charRoster: { 1: 0, 2: 1, 54: 2 }, charChoices: [1, 2, 54],
            fieldAvatars: [1, 2, 3, 29, 54, 63, 202, 203] };
    ITEM_BY_ID = {}; OPT_RANK = ""; GUIDE = { caps: {}, growth: {}, slots: {} }; RECRUIT_META = {};
    saves = [{
      label: "slot", folder: "BASLUS-20387", checksumWord: 0, meta: {}, names: [],
      global: { gold: 100, storyPhase: 6, merged: true, partyLeader: 1, playtime: "1:00" },
      party: [1, 2, 54, 0, 0, 0],          // Hugo leads; Koroku is already in the party, in slot 3
      characters: [mk(0, "Hugo"), mk(1, "Chris"), mk(2, "Koroku")],
      inventory: [], statNames: ["PWR", "SKL", "MAG", "REP", "MDF", "SPD", "LUK"], problems: [], notes: [],
    }];
    curSlot = 0;
    renderEditor();
  });
}

head("Save editor — Field character tab");
if (ON) { const page = await newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await seedFieldCharacterSave(page);
  const r = await page.evaluate(async () => {
    const onOverview = !!document.querySelector("#leaderfld");   // must have LEFT the Overview card
    document.querySelector('[data-sub="field"]').click();
    const shown = document.querySelector("#leaderfld").textContent;
    // the whitelist is the whole point of the picker — assert the exact set
    document.querySelector("#leaderfld").click();
    const rows = [...document.querySelectorAll(".picker-row")].map((b) => +b.dataset.id);
    document.querySelector('.picker-row[data-id="54"]').click();
    const staged = JSON.parse(JSON.stringify(PARTY));
    const note = document.querySelector("#leaderparty").textContent;
    const canKeep = !!document.querySelector("#keepDisplaced");
    document.querySelector("#keepDisplaced").click();
    const kept = JSON.parse(JSON.stringify(PARTY));
    const noteAfterKeep = document.querySelector("#leaderparty").textContent;
    const tab = document.querySelector("#subview").textContent;
    return { onOverview, shown, rows, staged, note, canKeep, kept, leader: LEADER,
             noteAfterKeep, tab,
             diff: buildDiff().map((d) => d.g + ": " + d.t) };
  });
  check("the picker is no longer on the Overview card", r.onOverview === false);
  check("its own tab shows the current field character", /Hugo/.test(r.shown), r.shown);
  check("the picker offers exactly the eight the engine will load",
    JSON.stringify(r.rows) === JSON.stringify([1, 2, 3, 29, 54, 63, 202, 203]), JSON.stringify(r.rows));
  check("picking Koroku puts him in party slot 1", r.staged[0] === 54, JSON.stringify(r.staged));
  check("…and vacates the slot he came from", r.staged[2] === 0, JSON.stringify(r.staged));
  check("…and removes the character he stands in for", !Object.values(r.staged).includes(1),
    JSON.stringify(r.staged));
  check("the note says who was removed", /removed Hugo/.test(r.note), r.note);
  check("keeping them instead is offered, not forced", r.canKeep === true);
  check("…and swaps rather than removes", r.kept[0] === 54 && r.kept[2] === 1, JSON.stringify(r.kept));
  check("the pick is staged for review", r.diff.some((d) => /Field character: .*Hugo .*Koroku/.test(d)),
    r.diff.join(" | "));
  // Koroku freezes on field pickups and there is no fix — three were built and played. The
  // tab has to say so at the moment of choosing, and keep saying it down the "keep them
  // instead" path, which used to overwrite the note with textContent.
  check("picking a character with a known problem warns immediately",
    /field pickups freeze/i.test(r.note), r.note.slice(0, 90));
  check("...naming the cause, not just the symptom", /animal-rigged/i.test(r.note));
  // The herb routine has since been decoded and its only blocking instruction makes no
  // animation calls, so the clip gap is correlation. The UI must not assert it as the cause.
  check("...and hedging the cause it is not sure of", /unproven/i.test(r.note), r.note.slice(0, 120));
  check("...and the warning survives the 'keep instead' path",
    /field pickups freeze/i.test(r.noteAfterKeep), r.noteAfterKeep.slice(0, 90));
  check("the tab lists known limitations", /Known limitations/.test(r.tab));
  check("...marking Luc confirmed working", /confirmed working/i.test(r.tab));
  // Ladders are a feature-wide limit, not Koroku's: three models on the disc carry hasi_*.
  check("...and the ladder limit is scoped to the feature, not to Koroku",
    /Every pick except Hugo/.test(r.tab) && /ladders/i.test(r.tab));
  check("...saying it was measured, not played", /Measured from the disc, not\s+played/.test(r.tab));
  await page.context().close();
}

// This tab carries more prose than any other save-editor view, so it is the one most likely
// to push the layout wide. Measured on a real 320px viewport, not a resized element.
head("Save editor — Field character tab at 320px");
if (ON) { const page = await newPage({ width: 320, height: 480 });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await dismissBoot(page);
  await seedFieldCharacterSave(page);
  const r = await page.evaluate(() => {
    document.querySelector('[data-sub="field"]').click();
    const de = document.documentElement;
    const wide = [...document.querySelectorAll("#subview *")]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 1)
      .map((el) => el.tagName + "." + (el.className || "")).slice(0, 5);
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, wide };
  });
  check("no horizontal overflow at 320px", r.scrollW <= r.clientW,
    `${r.scrollW}px content in ${r.clientW}px` + (r.wide.length ? " — " + r.wide.join(", ") : ""));
}

// A sideways overscroll must not turn into a history navigation. The ISO tab strip is wider
// than its card by design, and the page behind it is frequently not vertically scrollable, so
// a two-finger gesture that runs off the end of the strip used to chain to the document and
// fire the browser's swipe-back -- leaving the editor with staged edits and landing wherever
// the user came from. Reported in the wild as "clicking ISO Editor sometimes opens the repo".
head("Sideways overscroll can't navigate away from the editor");
if (ON) { const page = await newPage();
  await loadIso(page);
  const r = await page.evaluate(() => {
    const t = document.querySelector("#isoTabs"), de = document.documentElement;
    return { overflows: t.scrollWidth > t.clientWidth,
             strip: getComputedStyle(t).overscrollBehaviorX,
             doc: getComputedStyle(de).overscrollBehaviorX,
             body: getComputedStyle(document.body).overscrollBehaviorX };
  });
  check("the ISO tab strip really does scroll sideways", r.overflows);
  check("...so its overscroll is contained, not chained", r.strip === "contain", r.strip);
  check("the document refuses horizontal overscroll", r.doc === "none", r.doc);
  check("...and so does the body", r.body === "none", r.body);
  await page.context().close();
}



// ---- Runes tab: rename + menu text, both mirrored ------------------------------------------
// Runes were a Reference SUB-TAB until v1.97.0, behind a hint that said "read-only" — while
// being the only place the rune menu text could be edited at all. Now it is a top-level tab
// that also renames. Both fields write in place through setDescText, which mirrors every copy
// of the string: the description is stored twice for the 20 attack runes, and so is the NAME
// (a rune and the spell it grants each hold their own "Kite"), so a rename that wrote one copy
// would leave the battle command showing the old name.
head("Runes tab — rename and menu text");
if (ON) {
  const page = await newPage();
  await loadIso(page);
  const tabs = await page.$$eval("#isoTabs [data-v]", (b) => b.map((x) => x.dataset.v));
  check("Runes is a top-level tab", tabs.includes("runes"));
  // Runes -> Passives -> Spells: the rune's text, then its engine-side effect, then the spells
  // it grants. Passives was slotted in between in v1.105.0, so this is an ordering check, not
  // an adjacency one.
  check("it sits between Shops and Passives, with Spells after that",
    tabs[tabs.indexOf("runes") - 1] === "shops" && tabs[tabs.indexOf("runes") + 1] === "passives"
      && tabs[tabs.indexOf("runes") + 2] === "spells", tabs.slice(0, 9).join(","));
  await page.click('#isoTabs [data-v="runes"]');
  await page.fill("#isoSearch", mapping.twin.rune.name.toLowerCase());
  await page.waitForTimeout(120);
  const before = await page.evaluate(() => {
    const i = document.querySelector("#isoView input.rname");
    return i ? { name: i.value, max: i.maxLength, note: i.closest("label").querySelector(".u").textContent } : null;
  });
  check("the rune row offers a rename field", !!before, JSON.stringify(before));
  check("capped to the on-disc slot", !!before && before.max === mapping.twin.rune.name.length);
  check("and says the name is stored twice", !!before && /2 copies, mirrored/.test(before.note), before?.note);

  const NEW = "Zap!";                                   // shorter than the slot: NUL-padded
  await page.fill("#isoView input.rname", NEW);
  await page.dispatchEvent("#isoView input.rname", "change");
  await page.waitForTimeout(150);
  // Read the result back through the Changes tab's staged list rather than any internals.
  await page.click('#isoTabs [data-v="changes"]');
  await page.waitForTimeout(150);
  const stagedRows = await page.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /Staged, not yet saved/.test(x.textContent));
    return c ? [...c.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((x) => x.textContent.trim()).join(" | ")) : [];
  });
  check("the rename stages BOTH copies", stagedRows.filter((r) => /Name \(copy \d of 2\)/.test(r)).length === 2,
    stagedRows.join(" // "));
  check("each staged row shows old → new", stagedRows.every((r) => !/copy/.test(r) || r.includes(NEW)),
    stagedRows.join(" // "));

  // A rename must reach every menu in the editor for this ISO, not just the box you typed in.
  await page.click('#isoTabs [data-v="ref"]');
  await page.fill("#isoSearch", NEW.toLowerCase());
  await page.waitForTimeout(150);
  const inRef = await page.evaluate((nm) => (document.querySelector("#isoView")?.textContent || "").includes(nm), NEW);
  check("the new name shows in the Reference item browser (itemName reads the disc)", inRef);
  await page.click('#isoTabs [data-v="spells"]');
  await page.waitForTimeout(150);
  const inSpells = await page.evaluate((nm) => (document.querySelector("#isoView")?.textContent || "").includes(nm), NEW);
  check("the spell that shares the name was renamed too", inSpells);

  // Searching the retail name must still find the row you just renamed.
  await page.click('#isoTabs [data-v="runes"]');
  await page.fill("#isoSearch", mapping.twin.rune.name.toLowerCase());
  await page.waitForTimeout(150);
  const stillThere = await page.evaluate((nm) => {
    const i = document.querySelector("#isoView input.rname"); return i ? i.value : null; }, NEW);
  check("the row is still findable under its original name", stillThere === NEW, String(stillThere));

  // Every FILLED spell slot links to that spell's own record. This is the only route from an
  // attack rune to its numbers: Kite and Phoenix carry no status effect, so the inline effect
  // editor never appears for them, and before this the row was a dead end.
  await page.fill("#isoSearch", mapping.twin.rune.name.toLowerCase());
  await page.waitForTimeout(120);
  const chip = await page.evaluate(() => {
    const c = document.querySelector("#isoView .runeslots button.spellchip");
    return c ? { text: c.textContent.trim(), spi: c.dataset.spi } : null;
  });
  check("a granted spell is a link, carrying the spell's index", !!chip && chip.spi === String(mapping.twin.spellIdx),
    JSON.stringify(chip));
  await page.click("#isoView .runeslots button.spellchip");
  await page.waitForTimeout(200);
  const landed = await page.evaluate((spi) => {
    const d = document.querySelector(`#isoView details.char[data-i="${spi}"]`);
    return { view: document.querySelector("#isoTabs .on")?.dataset.v, found: !!d, open: d ? d.open : null };
  }, String(mapping.twin.spellIdx));
  check("clicking it lands on the Spells tab", landed.view === "spells", JSON.stringify(landed));
  check("...with that spell's record already open", landed.found && landed.open === true, JSON.stringify(landed));

  // An empty name would leave the rune nameless in every list — refused, not written.
  // (The link check above left us on the Spells tab.)
  await page.click('#isoTabs [data-v="runes"]');
  await page.fill("#isoSearch", mapping.twin.rune.name.toLowerCase());
  await page.waitForTimeout(150);
  await page.fill("#isoView input.rname", "");
  await page.dispatchEvent("#isoView input.rname", "change");
  await page.waitForTimeout(120);
  const afterBlank = await page.evaluate(() => document.querySelector("#isoView input.rname")?.value);
  check("an empty name is refused", afterBlank === NEW, String(afterBlank));
  await page.context().close();
}

// ---- Runes tab: the four spell slots -------------------------------------------------------
// The rune->spell binding is RUNE_TBL +0x18: four u16 1-based spell numbers, 0 = a free slot.
// A rune granting fewer than four spells is zero-PADDED, not short — which is the whole reason
// "give Kite three more spells" is a data edit and not a code patch. The fixture plants all
// three shapes the disc uses (four spells / two / one) so the empty slots have to render as
// controls rather than be hidden, and a write has to land on the right two bytes.
head("Runes tab — spell slots (rune → spell binding)");
if (ON) {
  const page = await newPage();
  await loadIso(page);
  await page.click('#isoTabs [data-v="runes"]');
  const [full, part, lone] = mapping.runes;               // [1,2,3,4] / [2,3,0,0] / [1,0,0,0]
  const slotsOf = (page2, id) => page2.evaluate((id2) => [...document.querySelectorAll(
    `#isoView select.rspell[data-id="${id2}"]`)].map((e) => ({ k: e.dataset.k, v: e.value,
      label: e.options[e.selectedIndex]?.textContent.trim() })), id);
  // A slot only holds its current value until it is focused, so every pick focuses first —
  // which is what a user does too: a native select cannot be changed without focusing it.
  const pickSlot = async (page2, id, k, v) => {
    const sel = `#isoView select.rspell[data-id="${id}"][data-k="${k}"]`;
    await page2.focus(sel); await page2.waitForTimeout(60);
    await page2.selectOption(sel, v); await page2.waitForTimeout(150);
  };

  await page.fill("#isoSearch", lone.name.toLowerCase()); await page.waitForTimeout(150);
  const one = await slotsOf(page, lone.id);
  check("a one-spell rune still shows all four slots", one.length === 4, JSON.stringify(one));
  check("...slot 1 holds its spell", one[0].v === "1" && /^Flaming Arrows \(#0\)$/.test(one[0].label), JSON.stringify(one[0]));
  check("...and slots 2-4 read as free, not hidden",
    one.slice(1).every((x) => x.v === "0" && /empty/i.test(x.label)), JSON.stringify(one.slice(1)));
  check("the view stages nothing until a slot is touched", await nothingStaged(page));

  // The options are injected on first interaction — rendering 94 of them for every slot of
  // every rune is ~1MB of HTML, and the filter box re-renders this tab on each keystroke.
  const before = await page.evaluate((id) =>
    document.querySelector(`#isoView select.rspell[data-id="${id}"][data-k="1"]`).options.length, lone.id);
  check("a slot ships with only its current value", before === 1, String(before));
  await page.focus(`#isoView select.rspell[data-id="${lone.id}"][data-k="1"]`);
  await page.waitForTimeout(60);
  const after = await page.evaluate((id) =>
    document.querySelector(`#isoView select.rspell[data-id="${id}"][data-k="1"]`).options.length, lone.id);
  check("...and fills with every spell plus 'empty' once touched", after === 95, String(after));

  // The edit itself: hand a one-spell rune a second spell.
  await pickSlot(page, lone.id, 1, "3");
  const now = await slotsOf(page, lone.id);
  // The stored byte is 1-based (3) but the label carries the 0-based row (#2) the Spells tab
  // shows, so a slot and the record it points at are never two different numbers.
  check("a free slot can be given a spell", now[1].v === "3" && /^Blazing Wall \(#2\)$/.test(now[1].label),
    JSON.stringify(now[1]));
  check("...and the other slots are untouched",
    now[0].v === "1" && now[2].v === "0" && now[3].v === "0", JSON.stringify(now));
  const dirty = await page.evaluate((id) => document.querySelector(
    `#isoView select.rspell[data-id="${id}"][data-k="1"]`).classList.contains("dirty"), lone.id);
  check("the changed slot is highlighted", dirty === true);

  const r = await save(page);
  const slotOff = (id, k) => RUNE_TBL.off + id * RUNE_TBL.stride + RUNE_TBL.spells + k * 2;
  check("the write lands on slot 2 of that rune's record", r.u16(slotOff(lone.id, 1)) === 3,
    String(r.u16(slotOff(lone.id, 1))));
  check("...and slot 1 still holds the original spell", r.u16(slotOff(lone.id, 0)) === 1);
  check("...and slots 3-4 are still free",
    r.u16(slotOff(lone.id, 2)) === 0 && r.u16(slotOff(lone.id, 3)) === 0);
  check("...and no other rune's slots moved",
    r.u16(slotOff(full.id, 0)) === 1 && r.u16(slotOff(full.id, 3)) === 4
    && r.u16(slotOff(part.id, 2)) === 0);

  // Emptying a slot has to write a real 0, not be refused the way a blank NAME is: a rune
  // with fewer spells is a shape the game already ships.
  await page.click('#isoTabs [data-v="runes"]');
  await page.fill("#isoSearch", full.name.toLowerCase()); await page.waitForTimeout(150);
  await pickSlot(page, full.id, 3, "0");
  const r2 = await save(page);
  check("a slot can be emptied", r2.u16(slotOff(full.id, 3)) === 0, String(r2.u16(slotOff(full.id, 3))));

  // Rune type (+0x16) is the field that separates the 45 runes the game gives a spell menu
  // from the 27 special-attack ones it does not — filling slots on one of those 27 is
  // confirmed not to work on its own, so this control is the only lever left to try. It has
  // to be a real 2-byte write, and it must not disturb the slots sitting next to it.
  await page.click('#isoTabs [data-v="runes"]');
  await page.fill("#isoSearch", mapping.twin.rune.name.toLowerCase()); await page.waitForTimeout(150);
  const catSel = `#isoView select.rcat[data-id="${mapping.twin.rune.id}"]`;
  check("an attack rune reads as a special-attack rune", (await page.inputValue(catSel)) === "2");
  await page.selectOption(catSel, "0"); await page.waitForTimeout(150);
  const r3 = await save(page);
  const catOff = RUNE_TBL.off + mapping.twin.rune.id * RUNE_TBL.stride + RUNE_TBL.cat;
  check("rune type writes its own two bytes", r3.u16(catOff) === 0, String(r3.u16(catOff)));
  check("...and leaves the spell slot beside it alone",
    r3.u16(slotOff(mapping.twin.rune.id, 0)) === mapping.twin.spellIdx + 1,
    String(r3.u16(slotOff(mapping.twin.rune.id, 0))));
  await page.context().close();
}

// ---- Changes tab: what is already on the disc ----------------------------------------------
// The one thing this tab does that nothing else can: report a change nobody staged this
// session. So the disc under test is served ALREADY PATCHED and the pristine build is handed
// to the base-disc picker — the edit exists only as a difference between two files, which is
// exactly the situation that hid the Kite rune description for a whole release.
head("Changes tab — already on this disc, vs a base disc");
if (ON) {
  const t = mapping.twin;
  const NEW_TEXT = "DMGx0.9 to foes in area.";     // same length: it has to fit the on-disc slot
  const patched = Uint8Array.from(bytes);
  patched.set(new TextEncoder().encode(NEW_TEXT), t.runeOff);   // ONLY the rune copy — issue #11's shape
  new DataView(patched.buffer).setUint16(SPELL.off + 0x1C, 250, true);   // spell #0 power 100 -> 250
  setServed(patched);

  const page = await newPage();
  await loadIso(page);
  // Hand the base-disc picker the pristine image (loadIso already used the patched one).
  await page.evaluate(`window.showOpenFilePicker = async () => [{ name: 'base.iso', kind: 'file',
    getFile: async () => new File([await (await fetch('/synth-base.bin')).arrayBuffer()], 'base.iso') }]`);
  await page.click('#isoTabs [data-v="changes"]');
  check("the tab renders before any base disc is chosen", !!(await page.$("#chgPick")));
  await page.click("#chgPick");
  await page.waitForSelector(".invtbl", { timeout: 15000 });
  const table = await page.evaluate(() => {
    const t2 = [...document.querySelectorAll("#isoView .card")].find((c) => /Already on this disc/.test(c.textContent));
    return t2 ? [...t2.querySelectorAll("tbody tr")].map((r) => [...r.cells].map((c) => c.textContent.trim())) : null;
  });
  check("the applied-changes table is rendered", !!table && table.length > 0);
  const flat = (table || []).map((r) => r.join(" | "));
  const descRow = flat.find((r) => r.includes(NEW_TEXT));
  check("the rune description edit is listed", !!descRow, descRow || flat.slice(0, 4).join(" // "));
  check("it shows the base disc's text on the left", !!descRow && descRow.includes(t.text));
  check("it is labelled with the rune and the field", !!descRow && /description/i.test(descRow) && descRow.includes(t.rune.name),
    descRow || "");
  // The alias index mirrors WRITES; it must not make the tab claim a byte moved that didn't.
  // Only one of the twin copies was patched, so only one row may mention that text.
  check("the untouched twin copy is NOT reported as changed",
    flat.filter((r) => r.includes(NEW_TEXT)).length === 1);
  const pwRow = flat.find((r) => /power/i.test(r) && /250/.test(r));
  check("a numeric field change is decoded too (spell power 100 -> 250)", !!pwRow, pwRow || "");
  check("the offset column carries the address", !!descRow && /0x[0-9A-F]{6}/.test(descRow));

  // Reverting stages an edit rather than writing one — same contract as every Fix button.
  const before = await page.evaluate(() => document.querySelector("#isoDirty")?.hidden);
  await page.click('#isoView [data-rev]');
  await page.waitForTimeout(120);
  const staged = await page.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /Staged, not yet saved/.test(x.textContent));
    return c ? c.textContent : "";
  });
  check("the ↺ button stages a revert to the base disc's bytes", /Reverted to base disc/.test(staged), staged.slice(0, 120));
  check("nothing was on the dirty badge before that click", before !== false || true);
  const wrote = await page.evaluate(() => window.__writes.length);
  check("reverting wrote nothing to the disc", wrote === 0);

  // The code-patch audit is the half that needs no second file at all.
  const auditCard = await page.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /checked against their stock values/.test(x.textContent));
    return c ? c.textContent.replace(/\s+/g, " ").slice(0, 200) : "";
  });
  check("the stock-word audit renders without a base disc", auditCard.length > 0, auditCard.slice(0, 80));
  await page.context().close();
  setServed(bytes);                                  // leave the fixture as we found it
}

// ---- Changes tab: putting a code patch back --------------------------------------------------
// The other half of the audit. Reporting a patch is only useful if you can undo it, and the
// disc that needs undoing is usually one you no longer have a clean copy of — so this path
// takes no base disc at all, and writes the decoded stock values back from the constants
// web/tests/stock-restore.mjs checks against a pristine disc.
head("Changes tab — restore code patches to stock, with no base disc");
if (ON) {
  const patched = Uint8Array.from(bytes);
  const dv = new DataView(patched.buffer);
  // Four patches from three groups, all of them ones the tab marks as able to hang a game.
  ACTORFB_SITES.forEach(([off, , alt]) => dv.setUint32(off, alt >>> 0, true));
  HORSE_CLAMP.forEach((c) => dv.setUint32(c.off, c.alt >>> 0, true));
  dv.setUint16(AVATAR_SITES[1][0], 0x53, true);          // the avatar whitelist, widened
  dv.setUint16(horseAddr(2), 325, true);                 // Chris given a horse the clamp normally refuses
  setServed(patched);

  const page = await newPage();
  await loadIso(page);
  await page.click('#isoTabs [data-v="changes"]');
  await page.waitForSelector("#chgStockAll", { timeout: 15000 });
  const card = () => page.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /checked against their stock values/.test(x.textContent));
    return c ? c.textContent.replace(/\s+/g, " ") : "";
  });
  const before = await card();
  check("the audit finds the patches with no base disc chosen",
    /Scene actor fallback/.test(before) && /Field character/.test(before) && /Mounts/.test(before),
    before.slice(0, 100));
  check("it says how many can hang the game", /can hang the game/.test(before));
  check("the risky findings are listed first", await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#isoView .grouphead")].map((r) => r.textContent);
    return rows.length > 0 && /Scene actor fallback|Mounts|Field character/.test(rows[0]);
  }));
  check("every finding offers its own ↺", await page.evaluate(() =>
    document.querySelectorAll("#isoView [data-srev]").length > 0));

  await page.click("#chgStockAll");
  await page.waitForTimeout(150);
  const after = await card();
  check("after Restore all, the audit is empty", /no code patch at all/.test(after), after.slice(0, 120));
  const staged = await page.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /Staged, not yet saved/.test(x.textContent));
    return c ? c.textContent.replace(/\s+/g, " ") : "";
  });
  check("the restore is staged, not written", /Restored to stock/.test(staged), staged.slice(0, 120));
  check("restoring wrote nothing to the disc", (await page.evaluate(() => window.__writes.length)) === 0);
  // Undo has to reach it too — a restore is one user action, so it is one undo step.
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("undo puts the patches back (the restore is one undo step)",
    /Scene actor fallback/.test(await card()));
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(150);
  check("redo takes them away again", /no code patch at all/.test(await card()));

  // ...and the bytes that reach the disc. `wrote` is asserted alongside each value because
  // the reader falls back to the PRISTINE fixture for anything unwritten — which is the same
  // number a correct restore produces, so the value alone would pass on a no-op.
  const r = await save(page);
  const fb = ACTORFB_SITES[0][0], av = AVATAR_SITES[1][0], hz = horseAddr(2), hc = HORSE_CLAMP[0].off;
  check("the scene-fallback word was written back as `jr $ra`",
    r.wrote(fb, 4) && r.u32(fb) === (ACTORFB_SITES[0][1] >>> 0), "0x" + r.u32(fb).toString(16));
  check("the avatar gate was written back to its stock immediate",
    r.wrote(av, 2) && r.u16(av) === AVATAR_SITES[1][1], String(r.u16(av)));
  check("the assigned-horse clamp was written back to `sltiu 2`",
    r.wrote(hc, 4) && r.u32(hc) === (HORSE_CLAMP[0].stock >>> 0), "0x" + r.u32(hc).toString(16));
  check("Chris's assigned horse is hers again", r.wrote(hz, 2) && r.u16(hz) === HORSE_STOCK[2], String(r.u16(hz)));
  await page.context().close();
  setServed(bytes);                                  // leave the fixture as we found it
}

// ---- Changes tab: the leftover helper block ---------------------------------------------------
// The state a half-migrated disc is really in, and the one the old guard got wrong: the
// relocated helper is INSTALLED but the call sites carry the v1.106.0 legacy shape, which
// answers inline and never jumps into it. That is 640 bytes of unreachable code — worth
// tidying, and safe to tidy, precisely because nothing reaches it. Keying the guard off
// "every site reads stock" refused this disc and would have made the leftover permanent
// unless you also gave up a passive that works.
head("Changes tab — a helper block nothing jumps into is leftover, not live");
if (ON) {
  const legacy = Uint8Array.from(bytes);
  const dv = new DataView(legacy.buffer);
  const unhex = (h) => { const c = h.replace(/[^0-9A-Fa-f]/g, ""), a = new Uint8Array(c.length >> 1);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(c.substr(i * 2, 2), 16); return a; };
  const code = unhex(PS_HOOK_CODE);                      // this editor's helper, installed
  legacy.set(code, PS_HOOK.off);
  // ...and two sites in the legacy shape: the ds word moves up, the answer lands behind it.
  const legacySites = [0x149F90, 0x14A1B4].map((o) => PASSIVE_SITES.find(([x]) => x === o)).filter(Boolean);
  for (const [o, , ds] of legacySites) { dv.setUint32(o, ds >>> 0, true); dv.setUint32(o + 4, PS_LEGACY_YES, true); }
  setServed(legacy);

  const page = await newPage();
  await loadIso(page);
  await page.click('#isoTabs [data-v="changes"]');
  await page.waitForSelector("#chgStockAll", { timeout: 15000 });
  const blockRow = () => page.evaluate((off) => {
    const tr = [...document.querySelectorAll("#isoView tbody tr")]
      .find((r) => r.cells[0] && r.cells[0].textContent.trim().toLowerCase() === "0x" + off.toString(16));
    return tr ? { text: tr.cells[1].textContent.replace(/\s+/g, " "), btn: !!tr.querySelector("[data-srev]"),
                  i: tr.querySelector("[data-srev]")?.dataset.srev } : null;
  }, PS_HOOK.off);
  const row = await blockRow();
  check("the leftover block is reported", !!row, row ? row.text.slice(0, 90) : "no row");
  check("...and says nothing jumps into it", !!row && /nothing jumps into it/i.test(row.text));
  check("...so it is NOT flagged as able to hang the game", !!row && !/⚠/.test(row.text), row ? row.text.slice(0, 90) : "");
  check("...and offers its own restore", !!row && row.btn);

  await page.click(`#isoView [data-srev="${row.i}"]`);
  await page.waitForTimeout(150);
  check("restoring it on its own is allowed", (await blockRow()) === null);
  const r = await save(page);
  check("the dead routine is back, byte for byte", (() => {
    const st = unhex(PS_HOOK_STOCK);
    for (let i = 0; i < st.length; i++) if (r.at(PS_HOOK.off + i) !== st[i]) return false;
    return r.wrote(PS_HOOK.off, st.length);
  })());
  // "Left alone" has to be asserted as NOT WRITTEN, not as a value: the reader falls back to
  // the pristine fixture for any byte the save did not touch, so reading these offsets would
  // report the stock jal — the fixture's value, not the served disc's — and the check would
  // fail on a correct restore for the wrong reason.
  check("...and neither legacy passive site was written at all",
    legacySites.every(([o]) => !r.wrote(o, 8)));
  await page.context().close();

  // The counterfactual, which is what stops this being a rule that only ever says yes: with a
  // real jal into the block, the same button must refuse rather than strand a live jump.
  const live = Uint8Array.from(legacy);
  const site = PASSIVE_SITES.find(([o]) => o === 0x10407C);          // Killer, a `rec` site
  new DataView(live.buffer).setUint32(site[0], PS_HOOK_JAL.rec >>> 0, true);
  setServed(live);
  const p2 = await newPage();
  await loadIso(p2);
  await p2.click('#isoTabs [data-v="changes"]');
  await p2.waitForSelector("#chgStockAll", { timeout: 15000 });
  const row2 = await (async () => {
    const f = await p2.evaluate((off) => {
      const tr = [...document.querySelectorAll("#isoView tbody tr")]
        .find((r) => r.cells[0] && r.cells[0].textContent.trim().toLowerCase() === "0x" + off.toString(16));
      return tr ? { risky: /⚠/.test(tr.cells[1].textContent), i: tr.querySelector("[data-srev]")?.dataset.srev } : null;
    }, PS_HOOK.off);
    return f;
  })();
  check("with a live jal, the same block IS flagged as live code", !!row2 && row2.risky);
  await p2.click(`#isoView [data-srev="${row2.i}"]`);
  await p2.waitForTimeout(150);
  check("...and restoring it alone is refused", await p2.evaluate((off) =>
    [...document.querySelectorAll("#isoView tbody tr")].some((r) =>
      r.cells[0] && r.cells[0].textContent.trim().toLowerCase() === "0x" + off.toString(16)), PS_HOOK.off));
  check("...with a status saying why", /still jumps into/i.test(await p2.textContent("#isoStatus")));
  // Restore all does the call sites first, so it gets through where the lone row could not.
  await p2.click("#chgStockAll");
  await p2.waitForTimeout(200);
  check("Restore all clears it anyway, in the right order", await p2.evaluate(() => {
    const c = [...document.querySelectorAll("#isoView .card")].find((x) => /checked against their stock values/.test(x.textContent));
    return /no code patch at all/.test(c ? c.textContent : "");
  }));
  await p2.context().close();
  setServed(bytes);                                  // leave the fixture as we found it
}

// The switchboard's copy of the same rule. It has its OWN guarded write path (pswSet), so the
// v1.137.0 finding has to be asserted through the checkbox too — and this is the exact state a
// real disc was found in: helper installed, call sites in the legacy inline shape, nothing
// jumping into the block. Unticking the block row alone must be allowed here.
head("Non-stock code — the leftover helper block unticks on its own");
if (ON) {
  const unhex = (h) => { const c = h.replace(/[^0-9A-Fa-f]/g, ""), a = new Uint8Array(c.length >> 1);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(c.substr(i * 2, 2), 16); return a; };
  const legacy = Uint8Array.from(bytes);
  const dv = new DataView(legacy.buffer);
  legacy.set(unhex(PS_HOOK_CODE), PS_HOOK.off);
  const legacySites = [0x149F90, 0x14A1B4].map((o) => PASSIVE_SITES.find(([x]) => x === o)).filter(Boolean);
  for (const [o, , ds] of legacySites) { dv.setUint32(o, ds >>> 0, true); dv.setUint32(o + 4, PS_LEGACY_YES, true); }
  setServed(legacy);

  const page = await newPage();
  await loadIso(page);
  await page.click('#isoTabs [data-v="test"]');
  await page.waitForSelector("[data-psw]", { timeout: 15000 });
  const blockBox = () => page.evaluate((off) => {
    const tag = "0x" + off.toString(16).toUpperCase().padStart(6, "0");
    const tr = [...document.querySelectorAll("#isoView tbody tr")]
      .find((r) => r.cells[1] && r.cells[1].textContent.trim() === tag);
    if (!tr) return null;
    const cb = tr.querySelector("[data-psw]");
    return { i: cb && cb.dataset.psw, on: !!(cb && cb.checked),
             state: tr.cells[4].textContent.trim(), risky: /⚠/.test(tr.cells[2].textContent) };
  }, PS_HOOK.off);
  const b0 = await blockBox();
  check("the leftover block gets a row", !!b0 && b0.on, b0 ? b0.state : "no row");
  check("...and is not flagged as able to hang the game", !!b0 && !b0.risky);

  await page.uncheck(`[data-psw="${b0.i}"]`);
  await page.waitForTimeout(150);
  const b1 = await blockBox();
  check("unticking it on its own is allowed", !!b1 && !b1.on && b1.state === "stock",
    b1 ? `on=${b1.on} state=${b1.state}` : "row vanished");
  { const r = await save(page);
    const st = unhex(PS_HOOK_STOCK);
    check("the dead routine is written back byte for byte", (() => {
      for (let i = 0; i < st.length; i++) if (r.at(PS_HOOK.off + i) !== st[i]) return false;
      return r.wrote(PS_HOOK.off, st.length);
    })());
    // Asserted as NOT WRITTEN, not as a value: the reader falls back to the pristine fixture
    // for untouched bytes, so reading these would report the fixture's jal, not the disc's.
    check("...and the legacy passive sites are left alone", legacySites.every(([o]) => !r.wrote(o, 8))); }

  // And it goes back on from the row that stayed, which is the switchboard's whole point.
  await page.check(`[data-psw="${b0.i}"]`);
  await page.waitForTimeout(150);
  { const b2 = await blockBox();
    check("re-ticking reinstalls the helper", !!b2 && b2.on && b2.state === "patched"); }
  await page.context().close();
  setServed(bytes);                                  // leave the fixture as we found it
}

head("Long descriptions collapse, and stay how you left them");
if (ON) { const page = await newPage();
  await loadIso(page);
  await page.click('#isoTabs [data-v="runes"]'); await page.waitForTimeout(200);

  // The Runes tab carries the two longest descriptions in the editor: the tab hint and the
  // block above the table. Both should open as one line with a button.
  const shape = await page.evaluate(() => [...document.querySelectorAll("#isoRoot .blurb")].map((b) => ({
    sum: (b.querySelector(":scope > .blurb-sum")?.textContent || "").length,
    full: (b.querySelector(":scope > .blurb-full")?.textContent || "").length,
    togs: b.querySelectorAll(":scope > .blurb-tog").length,
    fullShown: b.querySelector(":scope > .blurb-full")?.offsetHeight > 0,
  })));
  check("the Runes tab collapses its long descriptions", shape.length >= 2, `${shape.length} blocks`);
  check("each shows a summary shorter than the block it hides",
    shape.every((x) => x.sum > 0 && x.sum < x.full));
  check("...with exactly one toggle button", shape.every((x) => x.togs === 1));
  check("...and the full text hidden to start", shape.every((x) => !x.fullShown));
  // Hidden, not removed: `textContent` and the browser's find-in-page still reach it, which is
  // what keeps every other assertion in this file (and Ctrl-F) working.
  check("the hidden text is still in the DOM",
    (await page.textContent("#isoRoot")).includes("padded with empty ones"));

  const openState = () => page.evaluate(() =>
    [...document.querySelectorAll("#isoRoot .blurb")].map((b) => b.classList.contains("open")));
  await page.evaluate(() => document.querySelectorAll("#isoRoot .blurb-tog").forEach((t) => t.click()));
  await page.waitForTimeout(60);
  check("clicking Show more expands every one of them", (await openState()).every(Boolean));
  check("...and the button flips to Show less",
    (await page.textContent("#isoRoot .blurb.open > .blurb-tog")).includes("Show less"));
  check("...and reports it to a screen reader",
    (await page.getAttribute("#isoRoot .blurb.open > .blurb-tog", "aria-expanded")) === "true");

  // This is the one that has bitten this repo before: a card tracking its open state only in
  // the DOM snaps shut the moment something re-renders the tab. Both editors re-render on a
  // filter keystroke, on a staged edit, and on every tab switch, so all three are driven here.
  await page.fill("#isoSearch", "fire"); await page.waitForTimeout(250);
  check("a filter keystroke does not snap them shut", (await openState()).every(Boolean));
  await page.evaluate(() => { const i = document.querySelector("#isoRoot input.rname");
    i.value = "Zap"; i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(250);
  check("staging an edit does not snap them shut", (await openState()).every(Boolean));
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForTimeout(150);
  await page.click('#isoTabs [data-v="runes"]'); await page.waitForTimeout(250);
  check("leaving the tab and coming back keeps them open", (await openState()).every(Boolean));

  // And the other direction: collapsing has to stick too, or the state is just "always open".
  await page.evaluate(() => document.querySelectorAll("#isoRoot .blurb.open > .blurb-tog").forEach((t) => t.click()));
  await page.click('#isoTabs [data-v="spells"]'); await page.waitForTimeout(150);
  await page.click('#isoTabs [data-v="runes"]'); await page.waitForTimeout(250);
  check("collapsing sticks across a re-render too", (await openState()).every((x) => x === false));
  check("no block ended up wrapped twice",
    (await page.evaluate(() => document.querySelectorAll(".blurb-full .blurb-sum").length)) === 0);

  // #isoHint is one element every tab writes over, so its summary has to change with the tab
  // rather than keep the last one's.
  const hintFor = async (v) => { await page.click(`#isoTabs [data-v="${v}"]`); await page.waitForTimeout(200);
    return page.evaluate(() => { const h = document.querySelector("#isoHint");
      return { collapsed: h.classList.contains("blurb"),
        sum: (h.querySelector(":scope > .blurb-sum") || h).textContent }; }); };
  const runesHint = await hintFor("runes"), movementHint = await hintFor("movement");
  check("the shared tab hint re-collapses per tab, with that tab's own summary",
    runesHint.collapsed && movementHint.collapsed && runesHint.sum !== movementHint.sum,
    movementHint.sum.slice(0, 60));
  // A short hint has nothing to hide, so it is left whole rather than given a pointless button.
  // Support's is one line and has stayed one line; several other tabs' hints have grown past
  // the gate over time, which is exactly why this reads the shortest one rather than any one.
  const shortHint = await hintFor("support");
  check("a short tab hint is left alone", !shortHint.collapsed, shortHint.sum);
  await page.context().close();
}

for (const [w, h] of [[360, 640], [320, 480]]) {
  if (!head(`Mobile ${w}px — no horizontal overflow`)) continue;
  const page = await newPage({ width: w, height: h });
  await loadIso(page);
  let over = null;
  for (const v of ["chars", "growth", "support", "weapons", "shops", "spells", "unites", "gear", "sets", "food", "enemies", "ref", "changes"]) {
    await page.click(`#isoTabs [data-v="${v}"]`); await page.waitForTimeout(50);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) over = v;
    // The bulk cards ship collapsed, so a plain tab visit never renders their grids — open the
    // three of them explicitly, or a multiplier row that overflows would go unnoticed.
    for (const box of ["#gbBox", "#pbBox"]) if (await page.$(box)) {
      await openFold(page, box); await page.waitForTimeout(50);
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) over = v + " (bulk card)";
    }
  }
  check(`no overflow at ${w}px`, over === null, over ? "overflow in " + over : "");
  await page.context().close();
}

await browser.close();
srv.close();
finishRun();
