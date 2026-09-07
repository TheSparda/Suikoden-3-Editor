// The collapsed long descriptions ("Show more") — no browser.
//
// Two halves, and the second is the one that catches real drift.
//
// The pure half is `web/blurb-core.js`'s gate and summariser: which blocks earn a button and
// what a derived summary reads like.
//
// The wired half is the 66 `data-sum` attributes now living in `iso.js`, `app.js` and
// `index.html`, and the property they have to keep is easy to break by accident: expanded
// state is keyed by the **summary text**, because both editors rebuild whole tabs into
// `innerHTML` and there is no element to hang it off. Two blocks that happen to share a
// summary would therefore open and close together, on different tabs, for no visible reason.
// So uniqueness is asserted here rather than hoped for. Also checked: no summary carries a
// double quote (it lives in an HTML attribute inside a JS template literal, so one would
// truncate the attribute and spray the rest into the markup), every summary is meaningfully
// shorter than the block it stands in for, and the annotated-block count — the number that
// moves when someone adds a wall of text and forgets to summarise it.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const B = require(path.join(WEB, "blurb-core.js"));

let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };
const check = (m, cond) => (cond ? ok : bad)(m);

// ---------------------------------------------------------------- the gate and the summariser
console.log("blurb-core: plain text + gate");
check("tags are dropped and whitespace collapsed",
  B.plainText("<b>a</b>\n  <i>b</i>") === "a b");
check("entities count as one character, not as their source length",
  B.plainText("a&nbsp;b&mdash;c").length === 5);
check("a short caption is left alone",
  B.looksLong("Stock is 100 walking. Running is riskier.") === false);
check("a long block earns a button on length alone",
  B.looksLong("x ".repeat(200)) === true);
// The second gate exists because a four-sentence block is a wall of argument even when it is
// short, which is the shape the request named ("more than 2-3 sentences").
check("three sentences is not long", B.looksLong("One two. Three four. Five six.") === false);
check("four short sentences is long", B.looksLong("One two. Three four. Five six. Seven eight.") === true);

console.log("blurb-core: derived summaries");
check("takes whole sentences while they fit",
  B.deriveSummary("First one. Second one. " + "tail ".repeat(80)) === "First one. Second one.");
check("a single over-long sentence is cut at a word boundary and ellipsised", (() => {
  const s = B.deriveSummary("alpha bravo ".repeat(40), 60);
  return s.length <= 61 && s.endsWith("…") && !/ …$/.test(s) && s.startsWith("alpha bravo");
})());
check("never returns empty for non-empty prose", B.deriveSummary("Just this.") === "Just this.");
check("empty in, empty out", B.deriveSummary("") === "");
// The DOM half is a no-op under Node, and importing it must not throw on `document`.
check("importing under Node exposes only the pure half", typeof B.applyBlurbs === "undefined");

// ---------------------------------------------------------- the summaries actually shipped
console.log("blurb-core: the shipped data-sum attributes");
const FILES = ["iso.js", "app.js", "index.html"];
const found = [];      // { file, line, summary, bodyLen }

for (const f of FILES) {
  const src = fs.readFileSync(path.join(WEB, f), "utf8");
  // Same shape the annotation was written in: the attribute sits on a div/p/li opening tag.
  const re = /<(div|p|li)\b[^>]*?\bdata-sum="([^"]*)"[^>]*?>/g;
  let m;
  while ((m = re.exec(src))) {
    const [tag, name, summary] = [m[0], m[1], m[2]];
    // Walk to this element's own closing tag so the body length is the block's, not the card's.
    let depth = 1, i = m.index + tag.length;
    const close = "</" + name + ">";
    while (i < src.length && depth > 0) {
      const no = src.indexOf("<" + name, i), nc = src.indexOf(close, i);
      if (nc < 0) break;
      if (no >= 0 && no < nc) { depth++; i = no + 1; } else { depth--; i = nc + close.length; }
    }
    found.push({
      file: f,
      line: src.slice(0, m.index).split("\n").length,
      summary,
      bodyLen: B.plainText(src.slice(m.index + tag.length, i - close.length)
        .replace(/\$\{[^{}]*\}/g, "")).length,
    });
  }
}

// The ISO editor's per-tab hints are a second population: they live in a `hintSums` object
// rather than in markup, because `#isoHint` is one element every tab reuses. They land in the
// same `found` list so the uniqueness and length checks below cover both populations at once —
// a tab hint colliding with a block summary would tie a tab caption to a card on another tab.
{
  const src = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  const at = src.indexOf("const hintSums = {");
  if (at < 0) bad("could not find hintSums in iso.js — the tab hints are no longer summarised");
  else {
    let i = src.indexOf("{", at) + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
    const body = src.slice(src.indexOf("{", at) + 1, i - 1);
    // Every long hint needs a summary, so the two objects are compared key by key.
    const hintsAt = src.indexOf("const hints = {");
    let j = src.indexOf("{", hintsAt) + 1, d2 = 1;
    while (j < src.length && d2 > 0) { if (src[j] === "{") d2++; else if (src[j] === "}") d2--; j++; }
    const hintsBody = src.slice(src.indexOf("{", hintsAt) + 1, j - 1);

    const parse = (txt) => {
      const out = new Map();
      for (const m of txt.matchAll(/^\s*(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)) {
        out.set(m[1], JSON.parse('"' + m[2] + '"'));
      }
      return out;
    };
    const sums = parse(body), hints = parse(hintsBody);
    check(`the ISO tab hints are summarised (${sums.size} of ${hints.size} tabs)`, sums.size >= 19);

    const longUnsummarised = [...hints].filter(([k, v]) => B.looksLong(v) && !sums.get(k));
    check(longUnsummarised.length === 0
      ? "every ISO tab hint past the gate has a written summary"
      : `tab hint(s) long enough to collapse but with no summary — they would fall back to a ` +
        `derived first sentence: ${longUnsummarised.map(([k]) => k).join(", ")}`,
      longUnsummarised.length === 0);

    const strayShort = [...sums].filter(([k]) => hints.has(k) && !B.looksLong(hints.get(k)));
    check(strayShort.length === 0
      ? "no summary is written for a hint the gate leaves whole"
      : `summary written for a short hint (it will never be shown): ${strayShort.map(([k]) => k).join(", ")}`,
      strayShort.length === 0);

    for (const [k, v] of sums) found.push({ file: "iso.js hintSums", line: k, summary: v,
      bodyLen: B.plainText(hints.get(k) || "").length });
  }
}

// The Save Editor's sub-view hints, same story: one shared `#subhint` element, so the
// summaries live in `SUBHINT_SUM` instead of in markup. `chars` is intentionally absent
// because its hint carries the live "recruited only" checkbox — collapsing it would hide a
// control — so this asserts the exclusion rather than demanding full coverage.
{
  const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const at = src.indexOf("const SUBHINT_SUM = {");
  if (at < 0) bad("could not find SUBHINT_SUM in app.js — the sub-view hints are no longer summarised");
  else {
    let i = src.indexOf("{", at) + 1, depth = 1;
    while (i < src.length && depth > 0) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
    const body = src.slice(src.indexOf("{", at) + 1, i - 1);
    const keys = [...body.matchAll(/^\s*(\w+):\s*"((?:[^"\\]|\\.)*)"/gm)];
    check(`the Save Editor sub-view hints are summarised (${keys.length})`, keys.length >= 4);
    check("the chars hint is left whole, so its recruited-only checkbox stays visible",
      !keys.some((m) => m[1] === "chars") && /id="reconly"/.test(src));
    // Measure the hint each summary stands for: the branch bodies are `+`-joined template
    // literals, so the literals are stitched back together rather than evaluated.
    const hintText = (sub) => {
      const br = src.indexOf(`SUB === "${sub}"`);
      if (br < 0) return "";
      const start = src.indexOf('$("#subhint").innerHTML =', br);
      if (start < 0) return "";
      const end = src.indexOf(";\n", start);
      return B.plainText([...src.slice(start, end).matchAll(/`([^`]*)`/g)].map((x) => x[1]).join(""));
    };
    for (const m of keys) {
      found.push({ file: "app.js SUBHINT_SUM", line: m[1], summary: JSON.parse('"' + m[2] + '"'),
        bodyLen: hintText(m[1]).length });
    }
    const unmeasured = keys.filter((m) => hintText(m[1]).length === 0);
    check(unmeasured.length === 0
      ? "each sub-view summary was matched to the hint it replaces"
      : `could not find the hint for ${unmeasured.map((m) => m[1]).join(", ")}`,
      unmeasured.length === 0);
  }
}

// Coverage. Not a style preference: an unsummarised 2,900-character block is the thing this
// whole mechanism exists for, so the count is pinned and a drop has to be deliberate.
check(`every editor file carries summaries (${found.filter((x) => x.file === "iso.js").length} in iso.js, ` +
  `${found.filter((x) => x.file === "app.js").length} in app.js, ` +
  `${found.filter((x) => x.file === "index.html").length} in index.html)`,
  found.filter((x) => x.file === "iso.js").length >= 70 &&
  found.filter((x) => x.file === "app.js").length >= 9 &&
  found.filter((x) => x.file === "index.html").length >= 2);

const dupes = new Map();
for (const x of found) {
  const k = x.summary.trim();
  if (!dupes.has(k)) dupes.set(k, []);
  dupes.get(k).push(`${x.file}:${x.line}`);
}
const collided = [...dupes].filter(([, at]) => at.length > 1);
check(collided.length === 0
  ? "every summary is unique, so no two blocks share an expanded state"
  : `summaries collide (they would toggle together): ${collided.map(([s, at]) =>
      `${at.join(" + ")} — “${s.slice(0, 40)}…”`).join("; ")}`,
  collided.length === 0);

const quoted = found.filter((x) => /["`]/.test(x.summary) || x.summary.includes("${"));
check(quoted.length === 0
  ? "no summary carries a quote or an interpolation that would break its attribute"
  : `unsafe summary at ${quoted.map((x) => x.file + ":" + x.line).join(", ")}`,
  quoted.length === 0);

const notShorter = found.filter((x) => x.summary.length >= x.bodyLen);
check(notShorter.length === 0
  ? "every summary is shorter than the block it replaces"
  : `summary is not shorter than its block at ${notShorter.map((x) =>
      `${x.file}:${x.line} (${x.summary.length} vs ${x.bodyLen})`).join(", ")}`,
  notShorter.length === 0);

// A summary that needs its own "show more" defeats the point.
const tooLong = found.filter((x) => x.summary.length > 200);
check(tooLong.length === 0
  ? "no summary is itself long enough to need collapsing"
  : `over-long summary at ${tooLong.map((x) => `${x.file}:${x.line} (${x.summary.length})`).join(", ")}`,
  tooLong.length === 0);

// The runtime gate is what decides whether a button appears at all, so a block annotated but
// short would ship a summary nobody ever sees. Measured on the source's own prose.
const wouldNotCollapse = found.filter((x) => x.bodyLen > 0 && x.bodyLen <= B.LONG_MIN);
check(`annotated blocks under the length gate: ${wouldNotCollapse.length} ` +
  `(${wouldNotCollapse.map((x) => x.file + ":" + x.line).join(", ") || "none"}) — ` +
  `each still collapses if it runs past ${B.MAX_SENTS} sentences`,
  wouldNotCollapse.length <= 4);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
