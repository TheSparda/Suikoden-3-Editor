// Catches the version collision that produces NO merge conflict.
//
// Two branches that both bump web/index.html and web/sw.js to the *same* number rebase
// cleanly — git sees identical content on both sides, so there is nothing to conflict.
// The loser's branch ends up byte-identical to main on both lines, its feature ships, and
// the only symptom is that everyone still holding the old service-worker cache never sees
// it. "Rebased clean" is the exact signal you would normally trust, which is what makes
// this one nasty: the usual alarm is the one thing that cannot fire.
//
// So the assertion is inverted from the usual: an IDENTICAL version line is the failure,
// and only when web/ has otherwise changed.
//
//   node web/tests/version-drift.mjs
//
// Deliberately NOT part of `npm test`: it compares against whatever origin/main your repo
// last fetched, so it is a pre-push check, not a CI check. Run `git fetch` first or it
// will happily compare you against a stale remote. Self-skips (exit 0) when there is no
// git, no origin/main, or nothing to compare — it should never block someone offline.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
const skip = (m) => { console.log("SKIP version-drift: " + m); process.exit(0); };

try { git("rev-parse", "--git-dir"); } catch { skip("not a git repo."); }
let base;
for (const ref of ["origin/main", "origin/master", "main"]) {
  try { git("rev-parse", "--verify", ref); base = ref; break; } catch { /* try next */ }
}
if (!base) skip("no origin/main to compare against.");

const show = (f) => { try { return git("show", `${base}:${f}`); } catch { return null; } };
const read = (f) => { try { return fs.readFileSync(path.join(REPO, f), "utf8"); } catch { return null; } };
const pick = (txt, re) => { const m = txt && txt.match(re); return m && m[1]; };

const VER = /·\s*v(\d+\.\d+\.\d+)\s*·/;
const SW = /const CACHE = "s3editor-v(\d+)"/;

const remoteVer = pick(show("web/index.html"), VER), localVer = pick(read("web/index.html"), VER);
const remoteSw = pick(show("web/sw.js"), SW), localSw = pick(read("web/sw.js"), SW);
if (!remoteVer || !localVer || !remoteSw || !localSw) skip("couldn't read a version on one side.");

// Did web/ change at all (excluding the two version files themselves)?
let changed = [];
try {
  changed = git("diff", "--name-only", base, "--", "web/")
    .split("\n").filter((f) => f && f !== "web/index.html" && f !== "web/sw.js");
} catch { skip("couldn't diff against " + base + "."); }

let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); fails++; };

console.log(`version drift vs ${base} (${git("rev-parse", "--short", base)}):`);
console.log(`  web/ files changed besides the version lines: ${changed.length}`);
if (!changed.length) {
  ok("no web/ changes — version bump not required");
} else {
  if (localVer === remoteVer) bad(`app version DID NOT MOVE — both are v${localVer}. `
    + `${changed.length} web/ file(s) changed, so this ships without a version bump. `
    + `Someone else almost certainly published v${remoteVer} while you held it; take the next one.`);
  else ok(`app version moved v${remoteVer} → v${localVer}`);

  if (localSw === remoteSw) bad(`service-worker cache DID NOT MOVE — both are s3editor-v${localSw}. `
    + `Users on the old cache will not receive these changes.`);
  else ok(`sw cache moved v${remoteSw} → v${localSw}`);
}
// A half-bump is its own bug: one moved, the other didn't.
if (changed.length && (localVer !== remoteVer) !== (localSw !== remoteSw))
  bad("only one of the two moved — app version and sw cache must be bumped together");

console.log(fails ? `\n${fails} problem(s). Fetch, then take the next free pair.` : "\nVersion drift OK.");
process.exit(fails ? 1 : 0);
