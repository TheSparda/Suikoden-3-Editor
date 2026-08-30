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
//   node web/tests/version-drift.mjs                 # checks HEAD (what you would push)
//   node web/tests/version-drift.mjs --branch foo     # checks another ref
//   node web/tests/version-drift.mjs --worktree       # checks the checkout instead
//
// It checks a COMMIT, not the working tree, and that distinction is load-bearing here: this
// repo is worked by several sessions sharing one checkout, and commits are made from an
// explicit file list, so the working tree is not what gets pushed. Reading the checkout would
// both count a peer's in-flight edits as yours and miss a stale version line that is actually
// committed. `--worktree` is available for a normal single-user repo.
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

const argv = process.argv.slice(2);
const useWorktree = argv.includes("--worktree");
const bi = argv.indexOf("--branch");
const ref = bi >= 0 ? argv[bi + 1] : "HEAD";
if (!useWorktree) { try { git("rev-parse", "--verify", ref); } catch { skip(`no such ref: ${ref}`); } }
const target = useWorktree ? "working tree" : `${ref} (${git("rev-parse", "--short", ref)})`;

const show = (f) => { try { return git("show", `${base}:${f}`); } catch { return null; } };
const read = (f) => {
  if (useWorktree) { try { return fs.readFileSync(path.join(REPO, f), "utf8"); } catch { return null; } }
  try { return git("show", `${ref}:${f}`); } catch { return null; }
};
const pick = (txt, re) => { const m = txt && txt.match(re); return m && m[1]; };

const VER = /·\s*v(\d+\.\d+\.\d+)\s*·/;
const SW = /const CACHE = "s3editor-v(\d+)"/;

const remoteVer = pick(show("web/index.html"), VER), localVer = pick(read("web/index.html"), VER);
const remoteSw = pick(show("web/sw.js"), SW), localSw = pick(read("web/sw.js"), SW);
if (!remoteVer || !localVer || !remoteSw || !localSw) skip("couldn't read a version on one side.");

// Did web/ change at all (excluding the two version files themselves)?
let changed = [];
try {
  const args = useWorktree ? ["diff", "--name-only", base, "--", "web/"]
                           : ["diff", "--name-only", base, ref, "--", "web/"];
  changed = git(...args)
    .split("\n").filter((f) => f && f !== "web/index.html" && f !== "web/sw.js");
} catch { skip("couldn't diff against " + base + "."); }

let fails = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); fails++; };

console.log(`version drift: ${target} vs ${base} (${git("rev-parse", "--short", base)}):`);
console.log(`  web/ files changed besides the version lines: ${changed.length}`);
// Say plainly what was NOT looked at, so a shared checkout can't mislead.
if (!useWorktree) {
  // Must diff against HEAD, not the bare form: `git diff --name-only -- <path>` reports only
  // UNSTAGED changes, and `git checkout <ref> -- <path>` stages. That silently dropped
  // staged-but-uncommitted version bumps from the count — i.e. it under-reported exactly the
  // two files this tool exists for.
  let dirty = [];
  try { dirty = git("diff", "--name-only", "HEAD", "--", "web/").split("\n").filter(Boolean); } catch { /* ignore */ }
  if (dirty.length) {
    console.log(`  note: ${dirty.length} uncommitted web/ file(s) in the checkout were NOT `
      + `checked (this repo shares one tree; use --worktree to include them)`);
    const vf = dirty.filter((f) => f === "web/index.html" || f === "web/sw.js");
    if (vf.length) console.log(`  WARNING: ${vf.join(" and ")} ${vf.length > 1 ? "are" : "is"} `
      + `among them — the version you are about to commit differs from the one just checked`);
  }
}
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
