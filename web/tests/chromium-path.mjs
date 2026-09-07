// Picks the Chromium binary the browser tests launch. Shared by e2e.mjs, boot-gate.mjs,
// iso-load-overlay.mjs and stream-save.mjs so they cannot disagree about it.
//
// WHY THIS FILE EXISTS: the browser choice decides whether the suite FINISHES, and the
// default is the wrong one. playwright-core resolves by default to
// `chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/...`, and with that binary
// the "Last opened ISO (persist handle + reopen)" section dies with "Target page, context or
// browser has been closed" and ABORTS THE RUN — every section after it is skipped, not
// passed. Sessions kept rediscovering this by hand (locate headless_shell, list cache dirs,
// misread the abort as a flaky section, retry against another build); that hunt repeatedly
// cost more wall-clock than the suite it was trying to run. Now it is decided here, once,
// and printed.
//
// ---------------------------------------------------------------------------------------
// WHAT IS ACTUALLY VERIFIED (measured 2026-09-06, playwright-core 1.62.1, darwin arm64).
// Do not re-derive this by hand; it took six probes.
//
//   chromium_headless_shell-1148/chrome-mac/headless_shell                   PASSES
//   chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/...         ABORTS
//   chromium-1234/.../Google Chrome for Testing.app/...  (pw default)        ABORTS
//
// So "newest headless_shell" IS NOT THE RULE — 1243 is a headless_shell and it still aborts,
// in the same section and with the same message as Chrome for Testing. The distinction is the
// build, not the flavour, which is why VERIFIED_BY_PLATFORM below is an explicit list of build
// revisions and not a pattern.
//
// And the crash is PLATFORM-SPECIFIC, which is why that list is keyed by platform: linux 1234
// runs the whole suite green in CI, so a bare revision list would either cry wolf on every
// green CI run or vouch for a macOS build nobody has ever run.
//
// Ruled out as the cause, so nobody re-probes them: OPFS availability, FileSystemFileHandle
// createWritable, and structured-cloning a real handle into IndexedDB all work identically
// on 1148 and 1243 over a localhost (secure) origin. `navigator.storage` being undefined on
// about:blank is a secure-context artifact of the probe, not a browser difference. The app
// side has no window.close(); the section dies on the waitForSelector right after
// `#isoClose`, whose handler drops the ~4.6MB BUF/DV/ORIG/ODV buffers and re-renders, and
// the browser PROCESS is gone by then (playwright reports "kill ESRCH") with no crash dump.
// That smells like a GC/OOM crash inside the newer build. Pinning it down is a real
// investigation and is NOT needed to run the suite.
//
// TWO NAMING ERAS, both live in a long-lived cache — match both or you will miss the good one:
//   older:  chromium_headless_shell-1148/chrome-mac/headless_shell
//   newer:  chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell
//
// AND A CACHE DIRECTORY EXISTING MEANS NOTHING. chromium_headless_shell-1217, -1223 and
// -1234 exist here holding only INSTALLATION_COMPLETE and DEPENDENCIES_VALIDATED marker
// files — no binary. Sorting by revision and taking the first DIRECTORY hands back a path
// that cannot launch; that is what one session spent several turns chasing. Every candidate
// below is stat-ed with X_OK first.
import fs from "fs";
import os from "os";
import path from "path";

// Builds confirmed to complete the full e2e suite, PER PLATFORM. Newest verified build wins.
//
// Platform-scoped because the evidence is: darwin 1243 aborts while linux 1234 is green, so a
// bare revision list would either cry wolf on CI or vouch for a macOS build nobody has run.
// A build is verified for the platform it was measured on and no other.
//
// ADDING TO THIS LIST IS AN EMPIRICAL CLAIM, not a guess: the WHOLE suite (not the fast tier)
// must reach "All e2e checks passed" on that platform first. The discriminating section is
// "Last opened ISO (persist handle + reopen)", so at minimum
// `PW_CHROMIUM=<path> E2E_ONLY="Last opened ISO" node e2e.mjs` must pass. Say where the
// evidence came from when you add one:
//
//   darwin 1148 — full suite locally, 2026-09-07.
//   linux  1234 — CI run 34088527704 (sharded suite + stream-save green) on ubuntu-latest,
//                 which is what `npx playwright-core install chromium` pulls for
//                 playwright-core 1.62.1.
const VERIFIED_BY_PLATFORM = { darwin: [1148], linux: [1234] };
const VERIFIED = VERIFIED_BY_PLATFORM[process.platform] || [];

function cacheRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "ms-playwright");
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

const runnable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// Every plausible binary inside one chromium_headless_shell-<rev> dir, across both naming
// eras and any platform suffix, without hardcoding the arch.
function binaryIn(dir) {
  let subs = [];
  try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  for (const s of subs) {
    for (const name of ["headless_shell", "chrome-headless-shell", "headless_shell.exe", "chrome-headless-shell.exe"]) {
      const p = path.join(dir, s, name);
      if (runnable(p)) return p;
    }
  }
  return null;
}

// Every usable headless_shell in the cache, newest revision first. Revision is parsed as an
// integer so -1243 beats -998 (a string sort would not).
function candidates() {
  const root = cacheRoot();
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return entries
    .map((n) => ({ rev: +((/^chromium_headless_shell-(\d+)$/.exec(n) || [])[1] ?? NaN), dir: path.join(root, n) }))
    .filter((c) => Number.isFinite(c.rev))
    .sort((a, b) => b.rev - a.rev)
    .map((c) => ({ ...c, bin: binaryIn(c.dir) }))
    .filter((c) => c.bin);
}

// Newest VERIFIED build, else newest usable build, else null. The second case is a
// best-effort guess and callers say so out loud — see chromiumNote().
export function resolve() {
  const all = candidates();
  const good = all.filter((c) => VERIFIED.includes(c.rev));
  if (good.length) return { bin: good[0].bin, rev: good[0].rev, verified: true };
  if (all.length) return { bin: all[0].bin, rev: all[0].rev, verified: false };
  return null;
}

// What to hand chromium.launch({ executablePath }).
//
// Returns undefined rather than throwing when nothing is found: every browser test
// self-skips with exit 0 when Chromium is unavailable, so a machine with no cache has to
// keep reaching that skip instead of dying here. undefined = playwright's own default, which
// is the pre-existing behaviour.
//
// PW_CHROMIUM still overrides everything, unchanged — pinning a build by hand is exactly how
// you would bisect a browser-version-dependent failure like the one documented above, and
// this must not take that away.
export function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  return resolve()?.bin || undefined;
}

// One line, printed by every browser test, so a reader never has to guess which binary
// produced the output — the question every session hunting this down had to answer by hand.
export function chromiumNote() {
  if (process.env.PW_CHROMIUM) return `chromium: PW_CHROMIUM=${process.env.PW_CHROMIUM} (explicit override)`;
  const r = resolve();
  if (!r) {
    return `chromium: no headless_shell in ${cacheRoot()} — falling back to playwright's default.`
      + ` On macOS that is "Google Chrome for Testing", which ABORTS this suite part-way`
      + ` ("Last opened ISO"). Fix: npx playwright install chromium-headless-shell`;
  }
  const rel = path.relative(cacheRoot(), r.bin);
  return r.verified
    ? `chromium: ${rel} (build ${r.rev}, verified for this suite)`
    : `chromium: ${rel} (build ${r.rev}) — not a verified build on ${process.platform}`
      + ` (verified here: ${VERIFIED.join(", ") || "none"}).`
      + ` If the run aborts in "Last opened ISO", that is why, and it is the browser, not your change.`;
}
