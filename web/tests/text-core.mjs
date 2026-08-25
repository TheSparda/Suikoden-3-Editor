// Unit tests for the real text-core.js — the printable-run scanner + prose filter that
// decides which in-ELF strings the ISO editor's Text tab offers for editing.
//
// This heuristic is the whole feature: there is no index of strings in the ELF, so a run
// that slips through the filter is a *format string or identifier the user can corrupt*,
// and a run wrongly rejected is text they can't reach. It is also a port of
// `_looks_like_text` in Editor/s3editor.py, so the two editors must agree on a given disc —
// the rules are asserted here and the port was differential-tested against the Python.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const T = require("../text-core.js");

let fails = 0;
const check = (n, c) => { console.log(`  ${c ? "✓" : "✗"} ${n}`); if (!c) fails++; };
const enc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

console.log("text-core:");

// ---- the prose filter ------------------------------------------------------
{
  const yes = [
    "The battle is over",
    "You cannot use that item here",
    "Press the Start button",
    "Welcome to the trading post",
    "He is a quiet man, and rarely speaks.",
    "Are you sure? (yes or no)",
  ];
  const no = [
    ["too short", "Hi you"],            // < 8 chars
    ["no space", "Cannotusethatitemhere"],
    ["format specifier", "Loaded %s from disk"],
    ["path", "data/menu/font.bin"],
    ["hex literal", "value is 0x40 here"],
    ["arrow", "menu -> submenu here"],
    ["scope operator", "Scene::Battle start"],
    ["underscore", "battle_start_event"],
    ["letter then digit", "Loading stage1 now"],
    ["digit then letter", "the 3rd option here"],
    ["all caps", "PRESS START BUTTON"],
    ["mostly symbols", "a <<<<<<<<<<<<<< b"],
  ];
  check("prose strings are offered", yes.every((s) => T.looksLikeText(s)));
  for (const [why, s] of no) check(`rejected — ${why}`, !T.looksLikeText(s));
  check("empty string rejected", !T.looksLikeText(""));
  // a digit alone is fine as long as it isn't adjacent to a letter
  check("standalone number kept", T.looksLikeText("you have 5 left"));
  // exactly at the length boundary: 8 chars is accepted, 7 is not (matches the Python)
  check("length boundary is >= 8", T.looksLikeText("Hi there") && !T.looksLikeText("Hi ther"));
}

// ---- the scanner -----------------------------------------------------------
{
  // three runs separated by NULs: prose, a format string, and a too-short fragment
  const parts = ["The battle is over", "menu_item_%d", "ok"];
  const buf = new Uint8Array(200);
  let p = 10; const offs = [];
  for (const s of parts) { offs.push(p); buf.set(enc(s), p); p += s.length + 1; }
  const found = T.scanStrings(buf, 0x1000);
  check("only the prose run is returned", found.length === 1);
  check("offset is absolute (base applied)", found[0] && found[0].off === 0x1000 + offs[0]);
  check("max is the on-disk run length", found[0] && found[0].max === parts[0].length);
}
{
  // a run that reaches the very end of the block must still be flushed
  const s = "The end of the block";
  const buf = new Uint8Array(s.length);
  buf.set(enc(s));
  const found = T.scanStrings(buf, 0);
  check("run ending at the block boundary is found", found.length === 1 && found[0].max === s.length);
}
{
  // non-printable bytes terminate a run — a string split by a control byte is two runs,
  // and neither half should be silently merged into one oversized slot
  const buf = new Uint8Array(80);
  buf.set(enc("The battle is over"), 0);
  buf[18] = 0x07;                                   // bell, mid-sentence
  buf.set(enc("and everyone lived"), 19);
  const found = T.scanStrings(buf, 0);
  check("a control byte splits the run", found.length === 2);
  check("neither half spans the control byte",
    found.every((f) => f.off + f.max <= 18 || f.off >= 19));
}
{
  check("empty block yields nothing", T.scanStrings(new Uint8Array(0), 0).length === 0);
  check("all-zero block yields nothing", T.scanStrings(new Uint8Array(500), 0).length === 0);
}

// ---- the safety property that matters --------------------------------------
// Every returned slot must be exactly `max` printable bytes, because the editor writes
// `max` bytes back over it. If a slot ever covered a non-printable byte, an edit would
// clobber adjacent data.
{
  const buf = new Uint8Array(4096);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 3) & 0xFF;   // noise
  // NUL-isolate on BOTH sides: the noise is often printable too, so without a leading
  // terminator the run would start in the noise and fail the prose filter.
  const plant = (s, at) => { buf[at - 1] = 0; buf.set(enc(s), at); buf[at + s.length] = 0; };
  plant("The quick brown fox jumps", 1000);
  plant("A second sentence lives here", 2000);
  const found = T.scanStrings(buf, 0);
  const allPrintable = found.every((f) => {
    for (let i = f.off; i < f.off + f.max; i++) if (buf[i] < 32 || buf[i] >= 127) return false;
    return true;
  });
  check("every returned slot is entirely printable", found.length >= 2 && allPrintable);
  check("slots never overlap",
    found.every((f, i) => i === 0 || f.off >= found[i - 1].off + found[i - 1].max));
}

console.log(fails ? `\n${fails} FAILED` : "\nAll text-core checks passed.");
process.exit(fails ? 1 : 0);
