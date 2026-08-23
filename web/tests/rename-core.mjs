// Unit tests for the real rename-core.js — the same-length global byte replacement used to
// rename a character everywhere on the disc during a streaming save. Runs in plain Node.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const RN = require("../rename-core.js");

let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };
const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const dec = (b) => String.fromCharCode(...b);

console.log("rename-core:");

// buildRenames: same-length rule, padding, too-long rejection
{
  const { list, warnings } = RN.buildRenames({ Hugo: "Rex", Chris: "Chriss", Geddoe: "Gideon" });
  const byOrig = Object.fromEntries(list.map((r) => [r.origName, r]));
  check("Hugo→Rex staged (shorter, padded to 4)", byOrig.Hugo && dec(byOrig.Hugo.new) === "Rex ");
  check("Geddoe→Gideon staged (same length 6)", byOrig.Geddoe && dec(byOrig.Geddoe.new) === "Gideon");
  check("Chris→Chriss rejected (too long)", !byOrig.Chris && warnings.some((w) => /Chris/.test(w) && /too long/.test(w)));
  check("shorter name warns about padding", warnings.some((w) => /Hugo/.test(w) && /padded/.test(w)));
  check("unchanged/empty dropped", RN.buildRenames({ Hugo: "Hugo", Chris: "" }).list.length === 0);
  check("only scoped names accepted", RN.buildRenames({ Lucia: "Xxxxx" }).list.length === 0);
}

// applyAll: whole-buffer same-length replace, size preserved, distinctive-name safety
{
  const { list } = RN.buildRenames({ Geddoe: "Gideon" });
  const buf = enc("...Geddoe went home. Ask Geddoe again. Geddoe.");
  const len = buf.length;
  RN.applyAll(buf, list);
  check("all occurrences replaced", dec(buf) === "...Gideon went home. Ask Gideon again. Gideon.");
  check("size preserved (same length)", buf.length === len);
}

// streamReplacer: matches straddling chunk boundaries are still caught; total bytes preserved
{
  const { list } = RN.buildRenames({ Geddoe: "Gideon", Hugo: "Hero" });
  const full = "Hugo and Geddoe met. Geddoe left, Hugo stayed. GeddoeHugo.";
  const src = enc(full);
  // feed in awkward 5-byte chunks so names split across boundaries
  const r = RN.streamReplacer(list);
  const out = [];
  for (let i = 0; i < src.length; i += 5) out.push(r.push(src.subarray(i, i + 5)));
  out.push(r.flush());
  const joined = new Uint8Array(out.reduce((a, c) => a + c.length, 0));
  { let o = 0; for (const c of out) { joined.set(c, o); o += c.length; } }
  check("streamed total bytes preserved", joined.length === src.length);
  check("boundary-split names still replaced",
    dec(joined) === "Hero and Gideon met. Gideon left, Hero stayed. GideonHero.");
}

// no false expansion: replacing does not re-trigger on the new bytes
{
  const { list } = RN.buildRenames({ Hugo: "Hugh" });   // new "Hugh" ≠ old "Hugo"
  const buf = enc("Hugo Hugo Hugo");
  RN.applyAll(buf, list);
  check("new bytes not re-replaced", dec(buf) === "Hugh Hugh Hugh");
}

console.log(fails ? `\n${fails} FAILED` : "\nAll rename-core checks passed.");
process.exit(fails ? 1 : 0);
