// Guards how long the e2e suite takes. Runs the full suite, times every section, and
// compares against the committed baseline in timings.json.
//
//   node budget.mjs             # measure and judge against the baseline
//   node budget.mjs --update    # measure and REWRITE the baseline (do this deliberately)
//   node budget.mjs --from <f>  # judge a timings JSONL a previous run already produced
//
// Why this exists: the suite went from ~30s to 198s over months and nobody noticed, because
// no single commit made it obviously worse — a section here, a swallowed 10s timeout there.
// Three lines were eventually found costing 51s a run INSIDE CHECKS THAT PASSED, which is
// the failure mode that matters: a slow suite never turns red, it just quietly gets slower
// until running it stops being something you do while you work. This turns that drift into
// something a commit has to answer for.
//
// The thresholds below are per-section on purpose. A total-only budget hides the thing you
// actually want to catch — one careless section adding 8s while another happens to get 8s
// faster nets to zero and sails through.
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_PATH = path.join(HERE, "timings.json");

// A section may grow by the LARGER of these two before it is flagged: the ratio keeps cheap
// sections from tripping on noise, the floor keeps expensive ones from doubling quietly.
const GROW_RATIO = 1.5;        // 50% slower than baseline
const GROW_FLOOR_MS = 1200;    // ...or +1.2s, whichever is more generous
const NEW_SECTION_MS = 2500;   // a brand-new section this slow needs a deliberate look
// The TOTAL is a coarse backstop, not the guard. Whole-suite wall time swings with whatever
// else the machine is doing — a baseline taken on an idle box measured 150.9s and the very
// next run, with work in the background, came in at 158.8s. An 8s allowance failed that by
// 0.1s, which is exactly the kind of false alarm that gets a check switched off. So the
// total is deliberately loose, and THE PER-SECTION CHECKS ABOVE ARE WHAT ACTUALLY CATCHES
// REGRESSIONS: at a ~1s median section, +/-15% noise is ~150ms, nowhere near the +1.2s floor,
// so a section that genuinely got slower stands out while the suite total does not.
//
// The honest limitation: broad creep spread thinly (+80ms on every section, ~+9s) sits UNDER
// this floor and will not fail the run. It is still visible — the total delta is printed every
// time, and refreshing the baseline puts the new number in a reviewable diff.
const TOTAL_GROW_MS = 15000;
const TOTAL_GROW_RATIO = 0.12;   // ...or 12% of the baseline, whichever is larger
const RUN_TO_RUN_NOISE = "whole-suite time swings ~15% with machine load; per-section checks are the real guard";

const args = process.argv.slice(2);
const update = args.includes("--update");
const fromIdx = args.indexOf("--from");

function measure() {
  const out = path.join(os.tmpdir(), `s3-budget-${process.pid}.jsonl`);
  try { fs.unlinkSync(out); } catch { /* fresh */ }
  console.log("running the full suite to time it (this is the slow part)...\n");
  const r = spawnSync(process.execPath, [path.join(HERE, "e2e.mjs")],
    { cwd: HERE, env: { ...process.env, E2E_TIMINGS: out }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tail = (r.stdout || "").trim().split("\n").slice(-1)[0] || "";
  if (/^SKIP e2e/.test(r.stdout || "")) { console.log("SKIP budget: e2e self-skipped (no Chromium)."); process.exit(0); }
  // Timing a run that did not finish is worse than not timing one: the sections after the
  // abort have no entry at all, so the totals look BETTER while the suite is broken.
  if (r.status !== 0) {
    console.log((r.stdout || "") + (r.stderr || ""));
    console.log("\nFAILED — the suite did not pass, so its timings mean nothing. Fix the failure first.");
    process.exit(1);
  }
  console.log("  " + tail);
  return out;
}

const src = fromIdx >= 0 ? args[fromIdx + 1] : measure();
const now = {};
for (const line of fs.readFileSync(src, "utf8").trim().split("\n")) {
  if (!line) continue;
  const t = JSON.parse(line);
  now[t.name] = (now[t.name] || 0) + t.ms;
}
const nowTotal = Object.values(now).reduce((a, b) => a + b, 0);
const count = Object.keys(now).length;

if (update) {
  fs.writeFileSync(BASE_PATH, JSON.stringify({
    note: "Per-section e2e cost in ms. Guarded by budget.mjs and used by e2e.mjs to balance shards. Refresh with: node budget.mjs --update",
    measuredOn: `${process.platform} ${process.arch}, ${os.cpus().length} cores`,
    measuredAt: new Date().toISOString().slice(0, 10),
    totalMs: nowTotal, sectionCount: count, sections: now,
  }, null, 2) + "\n");
  console.log(`\nbaseline updated: ${count} sections, ${(nowTotal / 1000).toFixed(1)}s total`);
  process.exit(0);
}

let base;
try { base = JSON.parse(fs.readFileSync(BASE_PATH, "utf8")); }
catch (e) { console.log(`no readable baseline at ${BASE_PATH} (${e.message}). Create one: node budget.mjs --update`); process.exit(2); }

const grew = [], added = [], gone = [];
for (const [name, ms] of Object.entries(now)) {
  const was = base.sections[name];
  if (was === undefined) { if (ms > NEW_SECTION_MS) added.push({ name, ms }); continue; }
  const allowed = Math.max(was * GROW_RATIO, was + GROW_FLOOR_MS);
  if (ms > allowed) grew.push({ name, was, ms, allowed: Math.round(allowed) });
}
for (const name of Object.keys(base.sections)) if (now[name] === undefined) gone.push(name);

const delta = nowTotal - base.totalMs;
const sign = (n) => (n >= 0 ? "+" : "") + (n / 1000).toFixed(1) + "s";
console.log(`\ne2e timing vs baseline (${base.measuredAt}, ${base.measuredOn})`);
console.log(`  total   ${(nowTotal / 1000).toFixed(1)}s vs ${(base.totalMs / 1000).toFixed(1)}s  (${sign(delta)})`);
console.log(`  sections ${count} vs ${base.sectionCount}`);
console.log(`  ${RUN_TO_RUN_NOISE}\n`);

if (gone.length) {
  console.log(`  ${gone.length} baseline section(s) no longer present — renamed or removed, so their`
    + ` cost is not being compared:`);
  gone.slice(0, 8).forEach((n) => console.log(`      ${n.slice(0, 84)}`));
  if (gone.length > 8) console.log(`      ...and ${gone.length - 8} more`);
  console.log("  Rename means the guard silently stops watching that section — refresh the baseline.\n");
}

let bad = 0;
if (grew.length) {
  bad += grew.length;
  console.log(`  ✗ ${grew.length} section(s) materially slower:`);
  for (const g of grew.sort((a, b) => (b.ms - b.was) - (a.ms - a.was))) {
    console.log(`      ${sign(g.ms - g.was).padStart(7)}  ${g.was}ms → ${g.ms}ms (allowed up to ${g.allowed}ms)  ${g.name.slice(0, 62)}`);
  }
  console.log("");
}
if (added.length) {
  bad += added.length;
  console.log(`  ✗ ${added.length} new section(s) over the ${NEW_SECTION_MS}ms single-section budget:`);
  for (const a of added.sort((x, y) => y.ms - x.ms)) console.log(`      ${a.ms}ms  ${a.name.slice(0, 70)}`);
  console.log(`      Consider whether it needs its own page+ISO load, or can join an existing section.\n`);
}
const totalAllowance = Math.max(TOTAL_GROW_MS, base.totalMs * TOTAL_GROW_RATIO);
if (delta > totalAllowance) {
  bad++;
  console.log(`  ✗ the suite as a whole is ${sign(delta)} slower, over the ${(totalAllowance / 1000).toFixed(0)}s allowance`
    + ` — and no single section explains it, so look for cost added across many of them.\n`);
}

if (!bad) {
  console.log("e2e timing is within budget.");
  process.exit(0);
}
console.log(`FAILED (${bad}) — e2e got materially slower.`);
console.log(`If the new cost is genuinely warranted, take it deliberately: node budget.mjs --update`);
console.log(`and say in the commit message what bought the extra time. If it is not, the usual causes are`);
console.log(`a swallowed timeout (a bare .catch(() => {}) on a Playwright call eats the 30s default),`);
console.log(`a waiter asked for the state the assertion is arguing against, or a new newPage()+loadIso`);
console.log(`(~230ms each) where an existing section's page would have done.`);
process.exit(1);
