// Runs e2e.mjs across N worker processes and merges their verdicts into one.
//
//   node shard.mjs              # N = E2E_WORKERS or 4
//   E2E_WORKERS=8 node shard.mjs
//   E2E_TIER=fast node shard.mjs        # forwarded to every worker
//   E2E_ONLY=Runes node shard.mjs       # ditto
//
// Why processes and not parallel pages in one process: e2e.mjs serves the fixture from ONE
// module-level `served` buffer that ~13 sections swap out mid-test (setServed(patched) ...
// setServed(bytes)). Two sections running concurrently in one process would read each
// other's fixture — a data race that would surface as impossible byte assertions, at
// random, in whichever section lost. Each worker gets its own process, its own HTTP server
// on its own port, and therefore its own `served`. Sections stay strictly sequential
// WITHIN a worker, which is the property the fixture swapping relies on.
//
// The merge is deliberately paranoid about partial results, for the same reason e2e.mjs's
// abort guard is: N workers means N ways for a run to be silently incomplete. A worker that
// dies without printing a verdict is a FAILURE here, not an absence — see verdict() below.
import { spawn } from "child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const N = Math.max(1, +(process.env.E2E_WORKERS || 4));
const FORWARD = ["E2E_TIER", "E2E_ONLY", "PW_CHROMIUM"];
// E2E_TIMINGS is deliberately NOT forwarded. Per-section times measured while three other
// workers fight for the same cores are inflated, and would not be comparable to the serial
// baseline they are judged against — budget.mjs runs the suite unsharded for that reason.

// One worker = one shard. e2e.mjs packs the selected sections across n shards by their
// baseline cost, so the split composes with E2E_TIER / E2E_ONLY instead of fighting them.
function work(k) {
  const env = { ...process.env, E2E_SHARD: `${k}/${N}` };
  for (const v of FORWARD) if (process.env[v] === undefined) delete env[v];
  return new Promise((res) => {
    const t0 = Date.now();
    const ch = spawn(process.execPath, [path.join(HERE, "e2e.mjs")], { cwd: HERE, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => { out += d; });
    ch.stderr.on("data", (d) => { out += d; });
    ch.on("error", (e) => res({ k, out: out + `\n(spawn failed: ${e.message})`, code: -1, ms: Date.now() - t0 }));
    ch.on("close", (code) => res({ k, out, code, ms: Date.now() - t0 }));
  });
}

// A worker's own summary line is the only thing that proves it finished. e2e.mjs prints
// exactly one of: "All e2e checks passed." (unfiltered), "e2e checks passed for N of M
// sections (...)" (filtered), or "FAILED (n) ...". Anything else — a crash, an OOM, a
// truncated pipe — means we do NOT know what happened in that shard, and "don't know" has
// to count as failure or sharding becomes a way to lose red runs.
function verdict(r) {
  const m = /^(?:All e2e checks passed\.|e2e checks passed for .*)$/m.exec(r.out);
  if (m && r.code === 0) return { ok: true };
  const f = /^FAILED \((\d+)\)/m.exec(r.out);
  if (f) return { ok: false, fails: +f[1], why: `${f[1]} failed check(s)` };
  return { ok: false, fails: 1, why: `no verdict line, exit ${r.code} — treat this shard as UNKNOWN, not green` };
}

const t0 = Date.now();
console.log(`e2e across ${N} workers${["E2E_TIER", "E2E_ONLY"].filter((v) => process.env[v]).map((v) => ` ${v}=${process.env[v]}`).join("")} — ${os.cpus().length} cores available\n`);
const results = await Promise.all(Array.from({ length: N }, (_, k) => work(k)));
const wall = Date.now() - t0;

let fails = 0, ran = 0, total = 0, suite = 0, bad = 0;
for (const r of results.sort((a, b) => a.k - b.k)) {
  const v = verdict(r);
  process.stdout.write(r.out.replace(/^/gm, `[w${r.k}] `).replace(/\n*$/, "\n"));
  if (!v.ok) { fails += v.fails || 1; bad++; }
  // "R of E selected sections (suite has S)" — E is what the tier/only filters kept, which
  // is the number the shards must add up to. Comparing against S instead would false-alarm
  // on every filtered run, and comparing against nothing would let a dropped shard pass.
  const c = /(\d+) of (\d+) selected sections \(suite has (\d+)\)/.exec(r.out);
  if (c) { ran += +c[1]; total = Math.max(total, +c[2]); suite = Math.max(suite, +c[3]); }
}

console.log("\n" + "-".repeat(78));
for (const r of results) console.log(`  w${r.k}  ${(r.ms / 1000).toFixed(1)}s  ${verdict(r).ok ? "ok" : "FAILED — " + verdict(r).why}`);
const slow = Math.max(...results.map((r) => r.ms)), fast = Math.min(...results.map((r) => r.ms));
console.log(`\nwall ${(wall / 1000).toFixed(1)}s — slowest worker ${(slow / 1000).toFixed(1)}s, fastest ${(fast / 1000).toFixed(1)}s`
  + ` (a wide spread means timings.json is stale, not that a worker is broken)`);

// Every section must have run in exactly one shard. If the counts don't add up the split
// dropped or duplicated work, and the aggregate verdict is meaningless either way.
if (total && ran !== total) {
  console.log(`\nFAILED — the shards ran ${ran} sections between them, but ${total} were selected.`
    + ` Sections were dropped or double-counted; this run proves nothing.`);
  process.exit(1);
}
if (fails) { console.log(`\nFAILED (${fails}) across ${bad} of ${N} workers.`); process.exit(1); }
// A tier/filter run is PARTIAL and has to say so, exactly as a single filtered worker does.
const partial = suite && total && total < suite;
console.log(partial
  ? `\ne2e checks passed for ${ran} of ${suite} sections (${["E2E_TIER", "E2E_ONLY"].filter((v) => process.env[v]).map((v) => `${v}=${process.env[v]}`).join(" ")})`
    + ` \u2014 PARTIAL RUN, the other ${suite - ran} were not attempted.`
  : `\nAll e2e checks passed${total ? ` \u2014 ${ran} sections across ${N} workers` : ""}.`);
