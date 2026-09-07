// Fast, browser-free checks for the web editor — safe to run in CI and on session start.
// Verifies: the client JS parses; every ISO table offset stays inside the read block; and
// the JS reference-table parsers still produce the expected item/skill counts. Exits non-zero
// on any failure so CI/hooks catch offset drift or a broken parser before it ships.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..");
let failures = 0;
const ok = (m) => console.log("  ✓ " + m);
const bad = (m) => { console.log("  ✗ " + m); failures++; };

// 1) JS syntax
console.log("JS syntax:");
for (const f of ["app.js", "iso.js", "sw.js", "recruit-core.js", "rename-core.js", "guide-core.js", "health-core.js", "text-core.js", "vcdiff.js"]) {
  try { execFileSync(process.execPath, ["--check", path.join(WEB, f)]); ok(f); }
  catch (e) { bad(`${f} — ${String(e.stderr || e).split("\n")[0]}`); }
}

// 2) ISO table offsets stay within the read block [ELF_BASE, ELF_END)
console.log("ISO offset bounds:");
const ELF_BASE = 0xA4800, ELF_END = 0x465DF0;
const TABLES = {
  list1: [4078716, 140, 80], list2: [4068152, 132, 80], list3: [4089904, 8, 35], list4: [4061704, 28, 28],
  // shop counters: 14 locations x 4 stages x 0x7C, so bound the whole array, not just record 0
  shopItem: [4105552, 0x7C, 14 * 4], shopArmor: [4054224, 0x7C, 14 * 4], shopRune: [0x3EEB48, 0x7C, 14 * 4],
  priceLadder: [3970620, 4, 15], item1: [4136564, 4, 3],
  spell: [0x3EC2A0, 0x20, 94], unite: [0x3ECF90, 0x28, 38], food: [0x3E91D0, 0x48, 60], enemy: [0x3E74E0, 0x14, 100],
  // rune item table is indexed by ITEM id; only ids 317..462 are runes, so bound that window
  runes: [0x3EAF78 + 317 * 0x20, 0x20, 462 - 317 + 1],
  versionword: [4136544, 4, 1],
  // Classes reference: the war-battle class word pool (78 string pointers) and the 43x47 table
  // that maps a character's top two skill ids to a class label. No per-character class byte
  // exists — the label is derived — so these two are the whole of it.
  classPool: [0x3A7C80, 4, 78], classTbl: [0x3A7DC0, 94, 43],
  // the item-record bands the disc's own dispatcher (VA 0x16DBCD8) defines, name @+0 desc @+4.
  // Two of them have no editor view yet; bounding them here keeps the desc-alias index honest.
  itemBand: [0x3E8CBC + 1 * 0x24, 0x24, 160], gearBand: [0x3D8684 + 161 * 0x44, 0x44, 316 - 161 + 1],
  band4: [0x3EEB4C + 463 * 0x14, 0x14, 514 - 463 + 1], band5: [0x3E6680 + 515 * 0x10, 0x10, 612 - 515 + 1],
};
// Status effect strength (Spells tab): eleven `addiu $rt,$zero,imm` code sites whose immediates
// are the percentages a status is worth. Bound-checked one by one like the mount pair sites, and
// their stock words are asserted below so a drifted address can't be silently written.
const STATUSFX_SITES = [
  [0x107470, 0x24100014],
  [0x107480, 0x24030014],
  [0x107478, 0x2410000F],
  [0x102488, 0x2402001E],
  [0xE3868, 0x24040078],
  [0x24765C, 0x24020078],
  [0xE3870, 0x24040064],
  [0xE3878, 0x24040050],
  [0x247664, 0x24020050],
  [0xE3880, 0x2404003C],
  [0x247668, 0x2402003C],
  [0xE3884, 0x24040028],
  [0x24768C, 0x24040028],
  [0x104810, 0x24020055],
  [0x1053DC, 0x24020055],
  [0x10540C, 0x24020096],
  [0x105420, 0x24020096],
  [0x1054B8, 0x24020096],
  [0x1054CC, 0x24020096],
]
// Rune power (Passives tab): the magnitudes the passive support runes are worth, as
// [offset, stock word]. These sit INSIDE each rune's "if equipped" branch — they are not the
// equipped-check itself (that is PASSIVE_SITES / the PASSIVES table) — and each control rewrites only the
// value inside the instruction, so the stock word pins both the address and the shape. The
// last entry is not code at all: it is the walk-heal interval float in the small-data pool.
const RUNEFX_SITES = [
  [0x261198, 0x2442000F],   // Sunbeam   addiu $v0,$v0,15   — HP a combat turn adds
  [0x104088, 0x24020096],   // Killer    addiu $v0,$zero,150
  [0x104148, 0x24020096],
  [0x1038EC, 0x24020096],   // Counter
  [0x103B60, 0x24020096],
  [0x103D34, 0x24020096],
  [0x10FD34, 0x24020096],   // Gale
  [0x10380C, 0x2842001E],   // Haziness  slti $v0,$v0,30
  [0x245D78, 0x24020003],   // Drain     addiu $v0,$zero,3  — self-heal divisor
  [0x105218, 0x2403000A],   // Barrier   addiu $v1,$zero,10 — reflect divisor
  [0x1035E8, 0x24030005],   // Hunter    addiu $v1,$zero,5  — damage clamp
  [0x244B54, 0x3C013F00],   // Violence  lui $at,0x3F00     — 0.5f HP threshold
  [0x104370, 0x00131840],   // Wall      sll $v1,$s3,1
  [0x1047C8, 0x00108040],   // Double-Strike
  [0x1047DC, 0x00108040],
  [0x104878, 0x00101040],   // Fire Sealing
  [0x104FE0, 0x00111040],
  [0x10546C, 0x00101040],
  [0x10FD84, 0x00021042],   // Wizard    srl $v0,$v0,1
  [0x10FDA8, 0x00101042],
  [0x10FDDC, 0x00021042],   // Warrior
  [0x10FE00, 0x00101042],
];
const RUNEFX_FLOAT = [0x42C3B0, 0x3E99999A];   // Sunbeam walk-heal interval, 0.3f
// Fortune is the one rune power site OUTSIDE the ELF block: its EXP multiplier lives in the
// battle-results overlay, in both streaming copies. Bounds are the inverse of every other entry
// — these must be out of the block and inside the aux window pair, not in it.
const RUNEFX_AUX = [[0x3F3E6960, 0x24020002], [0x3F3EF160, 0x24020002]];
const AUX_PAIR = [0x3F3E6938, 0x3F3EF138], AUX_WIN_LEN = 0x70;
// The two overlay SWITCHES, which share those windows: the equipped/worn check each bonus asks
// before it pays out. Each is a word pair — the `jal` and the delay slot the patch swaps — and
// like the multiplier above them the bounds are inverted: out of the ELF block, inside a window.
// [window-relative offset, stock jal, stock delay slot, the answer written when forced on]
const AUXSW_SITES = [
  ["fortune",    0x00, 0x0C606CEC, 0x240501B8, 0x24020001],
  ["prosperity", 0x54, 0x0C606CDC, 0x0220202D, 0x2402FFFF],
];
// IsValidRidePair's eight rider/mount immediates (Mounts tab) — individual code sites,
// not a strided table, so bound-check them one by one.
const MOUNT_SITES = [0x130384, 0x13038C, 0x130390, 0x130398, 0x1303A0, 0x1303A4, 0x1303AC, 0x1303B4];
for (const [name, [base, stride, count]] of Object.entries(TABLES)) {
  const end = base + stride * count;
  if (base >= ELF_BASE && end <= ELF_END) ok(`${name} [${base}..${end})`);
  else bad(`${name} out of block: [${base}..${end}) vs [${ELF_BASE}..${ELF_END})`);
}
// Spell targeting/element enums must name every value a pristine disc actually uses. Fifteen of
// the 94 spells used to read "custom 0xNN" in the Target dropdown (0x05 the chanter-only
// Sword/Amulet runes, 0x09 the one-ally heals, 0x12 the line attacks) and 17 rendered a bare
// "undefined" for their element, because the two lists stopped short of the data.
{
  const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
  const used = (iso.match(/TARGET_BYTES_IN_USE = \[([^\]]*)\]/) || [])[1];
  const opts = (iso.match(/const TARGET_OPTS = \[([\s\S]*?)\];/) || [])[1];
  if (!used || !opts) bad("could not read TARGET_BYTES_IN_USE / TARGET_OPTS out of iso.js");
  else {
    const need = used.split(",").map((s) => parseInt(s.trim(), 16));
    const have = new Set([...opts.matchAll(/\[\s*(0x[0-9A-Fa-f]+)\s*,/g)].map((m) => parseInt(m[1], 16)));
    const missing = need.filter((b) => !have.has(b));
    (missing.length ? bad : ok)(missing.length
      ? `TARGET_OPTS is missing ${missing.map((b) => "0x" + b.toString(16).toUpperCase().padStart(2, "0")).join(", ")} — those spells show as "custom"`
      : `every target byte the disc uses is a named option (${need.length})`);
  }
  const el = (iso.match(/const ELEMENTS = \{([\s\S]*?)\};/) || [])[1] || "";
  const keys = new Set([...el.matchAll(/(\d+):/g)].map((m) => +m[1]));
  const missEl = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((k) => !keys.has(k));
  (missEl.length ? bad : ok)(missEl.length
    ? `ELEMENTS is missing ${missEl.join(", ")} — those spells render "undefined"`
    : "every element/family byte the disc uses is named (0..10)");
  (/const elemName = /.test(iso) ? ok : bad)("iso.js has an element fallback (no bare undefined in the UI)");
  (/elemName\(elVal\)/.test(iso) ? ok : bad)("the spell summary line uses the fallback");
}
{
  const oob = STATUSFX_SITES.filter(([o]) => o < ELF_BASE || o + 4 > ELF_END);
  if (oob.length) bad(`status-fx sites out of block: ${oob.map(([o]) => "0x" + o.toString(16)).join(", ")}`);
  else ok(`status effect strength sites (${STATUSFX_SITES.length} code sites in block)`);
  // every site the table names must also appear in iso.js with the same stock word
  const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
  const bad2 = STATUSFX_SITES.filter(([o, w]) => {
    const re = new RegExp(`\\[0x${o.toString(16).toUpperCase()},\\s*0x${w.toString(16).toUpperCase()}\\]`, "i");
    return !re.test(iso);
  });
  (bad2.length ? bad : ok)(bad2.length
    ? `iso.js STATUSFX is missing//drifted for ${bad2.map(([o]) => "0x" + o.toString(16)).join(", ")}`
    : "iso.js STATUSFX lists every site with its stock instruction word");
}
{
  const all = RUNEFX_SITES.concat([RUNEFX_FLOAT]);
  // Fortune's pair: outside the ELF block by construction, inside the overlay windows, and the
  // two streaming copies exactly 0x8800 apart (the spacing the potch pair already relies on).
  {
    const inBlock = RUNEFX_AUX.filter(([o]) => o >= ELF_BASE && o < ELF_END);
    (inBlock.length ? bad : ok)(inBlock.length
      ? `Fortune's overlay sites must NOT be in the ELF block: ${inBlock.map(([o]) => "0x" + o.toString(16)).join(", ")}`
      : "Fortune's two overlay sites are outside the ELF block, as overlay code must be");
    const inWin = RUNEFX_AUX.every(([o]) => AUX_PAIR.some((w) => o >= w && o + 4 <= w + AUX_WIN_LEN));
    (inWin ? ok : bad)(inWin
      ? `both Fortune sites fall inside the battle-results windows (${AUX_WIN_LEN} bytes each)`
      : "a Fortune site falls outside the aux window that is supposed to reach it — it would read as unavailable forever");
    const gap = RUNEFX_AUX[1][0] - RUNEFX_AUX[0][0];
    (gap === 0x8800 ? ok : bad)(gap === 0x8800
      ? "the two streaming copies are 0x8800 apart, matching the potch pair"
      : `the copies are 0x${gap.toString(16)} apart, not 0x8800 — one of them is misidentified`);
    const isoTxt = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
    const listed = RUNEFX_AUX.every(([o, w]) =>
      new RegExp(`\\[0x${o.toString(16).toUpperCase()},\\s*0x${w.toString(16).toUpperCase().padStart(8, "0")}\\]`, "i").test(isoTxt));
    (listed ? ok : bad)(listed
      ? "iso.js lists both Fortune sites with their stock word"
      : "iso.js RUNEFX is missing/drifted for a Fortune site");
    (/const AUX_WINDOWS = \[0x3F3E6938, 0x3F3EF138\]/.test(isoTxt) ? ok : bad)(
      "AUX_WINDOWS starts early enough to reach both overlay equipped checks");
    (/const AUX_LEN = 0x70/.test(isoTxt) && /const AUX_FORTUNE = 0x28;/.test(isoTxt)
      && /const AUX_MASK = 0x5C, AUX_MULT = 0x64;/.test(isoTxt) ? ok : bad)(
      "the offsets inside the window were shifted to match the moved base "
      + "(fortune 0x28, mask 0x5C, mult 0x64)");
    // The switches: every derived offset must land inside the window, the two copies must stay
    // 0x8800 apart, and no switch's word pair may collide with a value control in the same
    // window — the multiplier and the mask are edited independently and a shared word would
    // mean one control silently eating the other's write.
    const relOf = (name) => (isoTxt.match(new RegExp(`\\b${name} = (0x[0-9A-Fa-f]+)`)) || [])[1];
    const relFort = relOf("AUX_FORTUNE"), relMask = relOf("AUX_MASK"), relMult = relOf("AUX_MULT");
    (relFort && relMask && relMult ? ok : bad)(relFort && relMask && relMult
      ? "the window's value offsets can still be read out of iso.js"
      : "AUX_FORTUNE / AUX_MASK / AUX_MULT could not be parsed out of iso.js — the collision check below is checking nothing");
    const valSpans = [[parseInt(relFort, 16), 4], [parseInt(relMask, 16), 4], [parseInt(relMult, 16), 8]];
    const REL_CONST = { fortune: "AUX_FORT_CHK", prosperity: "AUX_PROSP_CHK" };
    for (const [key, rel, jal, ds, yes] of AUXSW_SITES) {
      // The offset iso.js actually uses, not the one this file wishes it used.
      const relSrc = parseInt(relOf(REL_CONST[key]) || "NaN", 16);
      (relSrc === rel ? ok : bad)(relSrc === rel
        ? `${REL_CONST[key]} is still 0x${rel.toString(16).toUpperCase()} (${key}'s check inside the window)`
        : `${REL_CONST[key]} reads 0x${Number.isNaN(relSrc) ? "??" : relSrc.toString(16)} in iso.js, not the decoded 0x${rel.toString(16)}`);
      const fits = rel >= 0 && rel + 8 <= AUX_WIN_LEN;
      (fits ? ok : bad)(fits
        ? `the ${key} switch's word pair fits inside the ${AUX_WIN_LEN}-byte window`
        : `the ${key} switch's word pair runs past the end of the window — it would read as unavailable forever`);
      const oob = AUX_PAIR.map((w) => w + rel).filter((o) => o >= ELF_BASE && o < ELF_END);
      (oob.length ? bad : ok)(oob.length
        ? `the ${key} switch must be overlay code, not in the ELF block`
        : `the ${key} switch's two copies are outside the ELF block, as overlay code must be`);
      const clash = valSpans.some(([o, n]) => rel < o + n && o < rel + 8);
      (clash ? bad : ok)(clash
        ? `the ${key} switch's word pair overlaps a value control in the same window`
        : `the ${key} switch does not overlap the multiplier, the mask or Fortune's EXP value`);
      // The stock words and the forced answer are the whole patch; drift here writes a
      // different instruction than the one the disassembly was checked against.
      const hx = (w) => "0x" + w.toString(16).toUpperCase().padStart(8, "0");
      const listed = new RegExp(`key: "${key}", rel: AUX_\\w+, jal: ${hx(jal)}, ds: ${hx(ds)}, yes: ${hx(yes)},`)
        .test(isoTxt);
      (listed ? ok : bad)(listed
        ? `iso.js's ${key} switch still carries its stock jal, delay slot and forced answer`
        : `iso.js's ${key} switch has drifted from the decoded words (${hx(jal)} / ${hx(ds)} / ${hx(yes)})`);
    }
    // Both copies always move together, and the read side refuses a disc where they disagree.
    (/for \(const w of AUX\) \{\s*\n\s*if \(w\.tag !== "potch"\) continue;\s*\n\s*auxW32\(w\.off \+ sw\.rel,/.test(isoTxt) ? ok : bad)(
      "auxSwSet writes every loaded overlay copy, not just the first");
    (/return st\.every\(\(x\) => x === "on"\) \? "on" : st\.every\(\(x\) => x === "off"\) \? "off" : "mixed";/.test(isoTxt) ? ok : bad)(
      "a disc whose two copies disagree reads as mixed, and mixed is not editable");
    (/const auxSwEditable = \(sw\) => \{ const x = auxSwState\(sw\); return x === "on" \|\| x === "off"; \};/.test(isoTxt) ? ok : bad)(
      "only the stock and the forced states are writable — a stranger's patch is read-only");
    (/const auxSwRevert = \(sw\) => auxRevertAt\(sw\.rel, 8\);/.test(isoTxt) ? ok : bad)(
      "the switch's revert restores both words across both streaming copies");
    // Same two-call coupling the Rune power card has: rendered and wired from the tab, and the
    // Prosperity one also renders on the Sets tab next to the numbers it multiplies.
    (/\$\{auxSwCard\(\)\}/.test(isoTxt) ? ok : bad)(
      "drawPassives still renders the overlay switch card (${auxSwCard()})");
    (/\$\{auxSwField\(auxSwById\("prosperity"\)\)\}/.test(isoTxt) ? ok : bad)(
      "drawSets still renders the Prosperity switch beside the potch numbers");
    ((isoTxt.match(/\n\s*wireAuxSw\(host\);/g) || []).length === 2 ? ok : bad)(
      `wireAuxSw is called from both tabs (found ${(isoTxt.match(/\n\s*wireAuxSw\(host\);/g) || []).length}, expected 2 — Passives and Sets)`);
    // Nothing is decoded-but-unswitchable any more, so the old gap list must be gone rather
    // than left rendering an empty table under a heading that says Fortune has no site.
    (/PS_UNMAPPED/.test(isoTxt) ? bad : ok)(
      /PS_UNMAPPED/.test(isoTxt)
        ? "iso.js still carries PS_UNMAPPED — Fortune is switchable now, so the gap list is stale"
        : "the decoded-but-unswitchable gap list is gone (Fortune has a switch)");
  }
  const oob = all.filter(([o]) => o < ELF_BASE || o + 4 > ELF_END);
  if (oob.length) bad(`rune power sites out of block: ${oob.map(([o]) => "0x" + o.toString(16)).join(", ")}`);
  else ok(`rune power sites (${all.length} in block: ${RUNEFX_SITES.length} code + 1 float)`);
  const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
  const missing = all.filter(([o, w]) => {
    const re = new RegExp(`\\[0x${o.toString(16).toUpperCase()},\\s*0x${w.toString(16).toUpperCase().padStart(8, "0")}\\]`, "i");
    return !re.test(iso);
  });
  (missing.length ? bad : ok)(missing.length
    ? `iso.js RUNEFX is missing/drifted for ${missing.map(([o]) => "0x" + o.toString(16)).join(", ")}`
    : "iso.js RUNEFX lists every site with its stock word");
  // A rune-power site must never land on an equipped-check word pair, a status constant, or
  // inside the block the Passives tab relocates its helper into: all of these write, and the
  // second writer would silently eat the first.
  // This reads the equipped-check addresses back out of iso.js by SHAPE, so it has to prove it
  // actually parsed them before it can claim they don't clash. If the passive tables are ever
  // restructured — the site descriptor gaining a field, `jal` ceasing to be the second key —
  // this regex quietly matches nothing, `psOffs` is empty, and the overlap check below passes
  // while checking NOTHING. That is the dangerous way for a guard to fail, so count first.
  const psOffs = [...iso.matchAll(/\{ off: (0x[0-9A-Fa-f]+), jal:/g)].map((m) => parseInt(m[1], 16));
  (psOffs.length === 51 ? ok : bad)(psOffs.length === 51
    ? "the overlap check can still see all 51 equipped-check sites"
    : `the equipped-check parser found ${psOffs.length} sites, not 51 — the passive site descriptor `
      + `changed shape, so the overlap check below is not actually checking anything. Fix this regex.`);
  // Same trap, one level up: if PS_HOOK is renamed or reshaped these two go 0 and the block
  // stops being checked at all, so they are asserted rather than defaulted.
  const hookOff = parseInt(((iso.match(/const PS_HOOK = \{\s*\n?\s*off: (0x[0-9A-Fa-f]+)/) || [])[1] || "0"), 16);
  const hookSpan = parseInt(((iso.match(/const PS_HOOK = \{[\s\S]*?span: (0x[0-9A-Fa-f]+)/) || [])[1] || "0"), 16);
  (hookOff && hookSpan ? ok : bad)(hookOff && hookSpan
    ? `the overlap check can still see the passives helper block (0x${hookOff.toString(16)}, ${hookSpan} bytes)`
    : "PS_HOOK's off/span could not be parsed out of iso.js, so the block is not being checked for overlap");
  const clash = all.filter(([o]) => psOffs.some((p) => o >= p && o < p + 8)
    || STATUSFX_SITES.some(([s]) => s === o) || MOUNT_SITES.includes(o)
    || (hookSpan && o + 4 > hookOff && o < hookOff + hookSpan));
  (clash.length ? bad : ok)(clash.length
    ? `rune power overlaps another patch at ${clash.map(([o]) => "0x" + o.toString(16)).join(", ")}`
    : "no rune power site overlaps an equipped-check word pair, a status constant, a mount site or the passives helper block");
  const dupes = all.map(([o]) => o).filter((o, i, a) => a.indexOf(o) !== i);
  (dupes.length ? bad : ok)(dupes.length
    ? `the same address is listed twice: ${dupes.map((o) => "0x" + o.toString(16)).join(", ")}`
    : "every rune power site is listed once");
  // The four value shapes and their guards have to stay in iso.js: an `imm` control that
  // silently started rewriting a shift would corrupt the instruction rather than the value.
  (/const RF_KIND = \{/.test(iso) && /imm:\s/.test(iso) && /sa:\s/.test(iso)
    && /f32hi:\s/.test(iso) && /f32:\s/.test(iso) ? ok : bad)(
    "RF_KIND still defines all four value shapes (imm / sa / f32hi / f32)");
  (/if \(!rfSiteOk\(e, off, stock\)\) return;/.test(iso) ? ok : bad)(
    "rfWrite re-checks each site's stock shape before writing it");
  // Fortune is the one entry outside the ELF block. Its accessor must route through the
  // overlay, and it must go read-only when the overlay was never read rather than write into
  // a window that is not there.
  (/const rfPut = \(e, off, v\) => \(e\.aux \? auxW32/.test(iso) ? ok : bad)(
    "aux-backed rune power writes go through the overlay writer, not writeW");
  (/const w = auxR32\(off\);[\s\S]{0,120}?return w !== null/.test(iso) ? ok : bad)(
    "an aux site with no overlay window loaded reads as unavailable, not writable");
  // Fortune's revert cannot be exercised by the e2e — on a synth disc the control is never
  // editable, so it can never become dirty there. Assert the wiring statically instead, and
  // that it reverts across BOTH copies (auxRevertAt spans the pair) rather than just one.
  (/auxRevertAt\(AUX_FORTUNE, 4\); drawView\(\);/.test(iso) ? ok : bad)(
    "Fortune's revert restores the span across both streaming copies");
  // The card is rendered and wired from inside drawPassives, and those two call sites are the
  // ONLY coupling between Rune power and the rest of the tab. A rewrite of drawPassives that
  // does not carry them forward drops the whole feature silently: RUNEFX, RF_KIND and every
  // helper still exist and still parse, so nothing above this line notices. The e2e catches it
  // (#rfBox stops existing) but the e2e is slow and not always run — catch it in the fast suite.
  // v1.123.0 moved the layout: rune STRENGTH is edited on the Runes tab only, per-unit
  // ENABLEMENT is on the character's own card, and the Passives tab keeps the four party-wide
  // effects. So the old "drawPassives renders rfCard()" guard is gone on purpose — what has to
  // hold now is that each control still has exactly one home and none of them lost it.
  (/\$\{runePowerHTML\(r\.id\)\}/.test(iso) ? ok : bad)(
    "the Runes tab is still the home of every rune's Strength block");
  // The Passives tab carries the four party-wide effects' SWITCHES and no strength at all:
  // Champion's and Sunbeam as rune rows, Fortune and Prosperity via the overlay-switch card.
  (/\$\{auxSwCard\(\)\}/.test(iso) ? ok : bad)(
    "the Passives tab renders the two overlay switches (Fortune, Prosperity)");
  (!/\$\{rfCard\(\)\}|\$\{psRewardCard\(\)\}/.test(iso) ? ok : bad)(
    "...and no strength control — that lives on the Runes tab only");
  (/const PS_TAB = \(p\) => p\.where !== "battle";/.test(iso) ? ok : bad)(
    "the Passives tab is filtered to the non-battle runes (Champion's, Sunbeam)");
  (/\$\{lazy \|\| listKey !== "list1" \? "" : charPassivesHTML\(r\.base\)\}/.test(iso) ? ok : bad)(
    "the character card renders its forced-passives block");
  (/wireCharPassives\(box\)/.test(iso) && /wireCharPassives\(d\)/.test(iso) ? ok : bad)(
    "...and wires it on both the lazy and eager card paths");
  // The transposition only works because a card's record index IS the bitmap index. If list1's
  // base/stride ever moved relative to PS_HOOK's pick range this would silently tick the wrong
  // character, so the derivation must stay arithmetic off TABLES.list1 rather than guessed.
  (/const charPassiveIdx = \(recBase\) => \(recBase - TABLES\.list1\[0\]\) \/ TABLES\.list1\[1\];/.test(iso) ? ok : bad)(
    "a card's forced-passive index is derived from TABLES.list1, not assumed");
  // Match the CALL, not the declaration — `function wireRf(host) {` also contains "wireRf(host)",
  // so a looser regex stays green with the call site deleted, which is the exact failure this
  // check exists to catch.
  (/\n\s*wireRf\(host\);/.test(iso) ? ok : bad)(
    "drawPassives still wires the Rune power controls (a wireRf(host); call, not just the declaration)");
  // Strength has exactly ONE home now: the rune's own row on the Runes tab. The Passives tab
  // renders no `.rf` control at all, so wireRf must be called from exactly one place — two
  // would mean a strength control had crept back onto another tab.
  (/\$\{runePowerHTML\(r\.id\)\}/.test(iso) ? ok : bad)(
    "drawRunes still renders each passive rune's Strength block");
  ((iso.match(/\n\s*wireRf\(host\);/g) || []).length === 1 ? ok : bad)(
    `wireRf is called from the Runes tab only (found ${(iso.match(/\n\s*wireRf\(host\);/g) || []).length}, expected 1)`);
  // One renderer still feeds both places that show a rune-power control: the Runes tab's
  // per-rune Strength blocks (short labels) and the Passives tab's reward card (long labels).
  // If they ever fork into two copies, a knob added to RUNEFX appears in only one of them.
  (/function rfField\(e, short\)/.test(iso) && /rfField\(e, true\)/.test(iso) ? ok : bad)(
    "the Runes tab's Strength blocks render through rfField()");
  // The dead Rune power card must stay dead — leaving it would give strength two homes on two
  // different tabs again, which is the thing v1.123.0 removed.
  (!/function rfCard\(/.test(iso) ? ok : bad)(
    "the old Rune power card is gone, not merely unreferenced");
  // The walk-heal is stored as an interval and shown as a rate; the snap-back is what keeps a
  // nudge-and-undo from leaving 1/3.33 = 0.3003 on the disc instead of the stock 0.3.
  (/Math\.abs\(shown - e\.stockShown\) < 0\.005\) return e\.stock/.test(iso) ? ok : bad)(
    "the rate control snaps back to the exact stock interval");
}
{
  const oob = MOUNT_SITES.filter((o) => o < ELF_BASE || o + 4 > ELF_END);
  if (oob.length) bad(`mount pair sites out of block: ${oob.map((o) => "0x" + o.toString(16)).join(", ")}`);
  else ok(`mount pair sites (${MOUNT_SITES.length} code sites in block)`);
}

// Passives tab: the 51 decoded equipped-rune checks, and the relocated helper they are pointed
// at. The site table is checked structurally — each site is TWO words (the `jal` and its delay
// slot), so the bound is 8 bytes, and two sites within 8 bytes of each other would have one
// silently overwrite the other. The `jal` word is decoded here rather than trusted: it must
// still target the helper its `k` claims, which catches a site copied to the wrong address or a
// `k` typo. The helper block is checked the other way round: the machine code iso.js embeds is
// pulled apart and its baked-in constants re-derived from the JS ones beside it, so a moved
// block, a resized table or a changed record stride fails here rather than in the game.
console.log("Passive rune sites:");
{
  const iso = fs.readFileSync(path.join(REPO, "web", "iso.js"), "utf8");
  const DELTA = 0x15B8800;                                  // ISO offset -> ELF vaddr
  const HELPER = { rec: 0x16CB380, id: 0x16CB438, unit: 0x181B3B0 };
  const BAND = [0x1B8, 0x1CE];                              // the support-rune item ids
  const FIELD = [0x149F90, 0x14A1B4];                        // the two field party loops
  const grab = (name) => (iso.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n  \\];`)) || [])[1];
  const sw = grab("PASSIVES");
  // Fortune is not in PASSIVES: its check is overlay code, so it is switched by AUXSW instead.
  // Coverage of the support-rune band therefore has to count both tables, and this reads the
  // rune ids out of AUXSW rather than trusting a constant here.
  const auxsw = (iso.match(/const AUXSW = \[([\s\S]*?)\n  \];/) || [])[1];
  // PS_HOOK's keys (off, len, rows, stride) are common words, so read them out of the object
  // literal itself rather than out of the whole file — `off: 0x3EC2A0` belongs to a spell table.
  const hook = (iso.match(/const PS_HOOK = \{([\s\S]*?)\n  \};/) || [])[1] || "";
  const num = (k) => { const m = hook.match(new RegExp(`\\b${k}:\\s*(0x[0-9A-Fa-f]+|\\d+)`)); return m ? Number(m[1]) : undefined; };
  const hexStr = (k) => (hook.match(new RegExp(`\\n    ${k}:\\n([\\s\\S]*?),(?:\\n|$)`)) || [])[1];
  if (!sw || auxsw === undefined) bad("could not read PASSIVES / AUXSW out of iso.js");
  else {
    const ids = [...sw.matchAll(/\{ id: (0x[0-9A-Fa-f]+),/g)].map((m) => parseInt(m[1], 16));
    const sites = [...sw.matchAll(/\{ off: (0x[0-9A-Fa-f]+), jal: (0x[0-9A-Fa-f]+), ds: (0x[0-9A-Fa-f]+), k: "(\w+)" \}/g)]
      .map((m) => ({ off: parseInt(m[1], 16), jal: parseInt(m[2], 16) >>> 0, ds: parseInt(m[3], 16) >>> 0, k: m[4] }));
    const gaps = [...auxsw.matchAll(/\bid: (0x[0-9A-Fa-f]+)/g)].map((m) => parseInt(m[1], 16));
    (sites.length === 51 ? ok : bad)(`${sites.length} call sites parsed (expected 51)`);
    (ids.length === 22 ? ok : bad)(`${ids.length} runes carry sites (expected 22)`);

    // The two field sites are the party loops, and they are the ONLY ones that go through the
    // charId form of the lookup along with Wall's stat site — a `k` that drifted would send the
    // trampoline the wrong argument, so the shape of the split is pinned rather than assumed.
    const fieldSites = sites.filter((s) => FIELD.includes(s.off));
    (fieldSites.length === 2 && fieldSites.every((s) => s.k === "id") ? ok : bad)(
      "both field party loops (0x149F90, 0x14A1B4) still go through 0x16CB438 (charId form)");
    (sites.filter((s) => s.k === "id").length === 3 && sites.filter((s) => s.k === "rec").length === 25
      && sites.filter((s) => s.k === "unit").length === 23 ? ok : bad)(
      "the sites split 25 / 3 / 23 across the record, charId and unit lookups");
    (sites.some((s) => s.off === 0x261184) ? ok : bad)("Sunbeam's in-battle half is carried too");

    // Every support rune is accounted for exactly once, as a rune with sites or a named gap.
    const band = [];
    for (let i = BAND[0]; i <= BAND[1]; i++) band.push(i);
    const seen = [...ids, ...gaps], uniq = new Set(seen);
    const missing = band.filter((i) => !uniq.has(i));
    const stray = [...uniq].filter((i) => i < BAND[0] || i > BAND[1]);
    const dupes = seen.filter((v, i) => seen.indexOf(v) !== i);
    (missing.length || stray.length || dupes.length ? bad : ok)(
      missing.length || stray.length || dupes.length
        ? `the support-rune band 0x1B8..0x1CE is not covered exactly once: missing ${missing.map((i) => "0x" + i.toString(16)).join(", ") || "none"}, `
          + `stray ${stray.map((i) => "0x" + i.toString(16)).join(", ") || "none"}, repeated ${dupes.map((i) => "0x" + i.toString(16)).join(", ") || "none"}`
        : `every support rune 0x1B8..0x1CE appears exactly once (${uniq.size} ids, Fortune the one switched through the overlay)`);

    const oobP = sites.filter((s) => s.off < ELF_BASE || s.off + 8 > ELF_END);
    (oobP.length ? bad : ok)(oobP.length
      ? `passive sites out of block: ${oobP.map((s) => "0x" + s.off.toString(16)).join(", ")}`
      : `all ${sites.length} passive sites (2 words each) stay in the read block`);

    const sorted = sites.map((s) => s.off).sort((a, b) => a - b);
    const clash = sorted.filter((o, i) => i && o - sorted[i - 1] < 8);
    (clash.length ? bad : ok)(clash.length
      ? `passive sites overlap at ${clash.map((o) => "0x" + o.toString(16)).join(", ")} — one patch would eat the other`
      : "no two passive sites are within 8 bytes of each other");

    const wrong = sites.filter((s) => {
      const va = s.off + DELTA;
      return (s.jal >>> 26) !== 3
        || (((va & 0xF0000000) | ((s.jal & 0x03FFFFFF) << 2)) >>> 0) !== HELPER[s.k];
    });
    (wrong.length ? bad : ok)(wrong.length
      ? `${wrong.length} passive site(s) don't jal the helper their kind names: ${wrong.map((s) => "0x" + s.off.toString(16)).join(", ")}`
      : `every site's jal decodes to the helper its kind names (${Object.keys(HELPER).join(" / ")})`);

    // ---- the relocated helper -------------------------------------------------
    const H = {
      off: num("off"), va: num("va"), span: num("span"), len: num("len"), maskOff: num("maskOff"),
      rows: num("rows"), stride: num("stride"), first: num("first"),
      recBase: num("recBase"), recStride: num("recStride"), recCount: num("recCount"),
      pickMin: num("pickMin"), pickMax: num("pickMax"),
    };
    const jalM = hook.match(/jal: \{ rec: (0x[0-9A-Fa-f]+), id: (0x[0-9A-Fa-f]+), unit: (0x[0-9A-Fa-f]+) \}/);
    const entM = hook.match(/entry: \{ rec: (0x[0-9A-Fa-f]+), id: (0x[0-9A-Fa-f]+), unit: (0x[0-9A-Fa-f]+) \}/);
    const codeHex = (hexStr("code") || "").replace(/[^0-9A-Fa-f]/g, "");
    const stockHex = (hexStr("stock") || "").replace(/[^0-9A-Fa-f]/g, "");
    if (!jalM || !entM || !codeHex || !stockHex || H.off === undefined) bad("could not read PS_HOOK out of iso.js");
    else {
      const w = (i) => parseInt(codeHex.substr(i * 8 + 6, 2) + codeHex.substr(i * 8 + 4, 2)
        + codeHex.substr(i * 8 + 2, 2) + codeHex.substr(i * 8, 2), 16) >>> 0;
      const nwords = codeHex.length / 8;
      (H.off + DELTA === H.va ? ok : bad)(`the block's vaddr and ISO offset agree (0x${H.va.toString(16)} = 0x${H.off.toString(16)} + delta)`);
      (H.off >= ELF_BASE && H.off + H.span <= ELF_END ? ok : bad)("the whole helper block stays in the read block");
      (H.maskOff + H.rows * H.stride === H.len && H.len <= H.span ? ok : bad)(
        `code + table (${H.maskOff} + ${H.rows}x${H.stride}) is exactly PS_HOOK.len and fits the ${H.span}-byte routine`);
      (codeHex.length === H.maskOff * 2 ? ok : bad)(`PS_HOOK.code is ${codeHex.length / 2} bytes, filling the block up to the table`);
      (stockHex.length === H.len * 2 ? ok : bad)(`PS_HOOK.stock is ${stockHex.length / 2} bytes — every byte this editor writes`);
      // No call site may live inside the block, or the two patches would fight.
      const inside = sites.filter((s) => s.off + 8 > H.off && s.off < H.off + H.span);
      (inside.length ? bad : ok)(inside.length ? `a call site sits inside the helper block: 0x${inside[0].off.toString(16)}` : "no call site lives inside the helper block");
      // The three entry points: each must be a real address inside the code, and each `jal`
      // word must decode back to it.
      const ent = { rec: parseInt(entM[1], 16), id: parseInt(entM[2], 16), unit: parseInt(entM[3], 16) };
      const jw = { rec: parseInt(jalM[1], 16) >>> 0, id: parseInt(jalM[2], 16) >>> 0, unit: parseInt(jalM[3], 16) >>> 0 };
      const entBad = Object.keys(ent).filter((k) => ent[k] < H.va || ent[k] >= H.va + H.maskOff || ent[k] % 4
        || ((0x0C000000 | ((ent[k] >> 2) & 0x03FFFFFF)) >>> 0) !== jw[k]);
      (entBad.length ? bad : ok)(entBad.length
        ? `PS_HOOK entry/jal disagree or fall outside the code: ${entBad.join(", ")}`
        : "psRec / psId / psUnit are inside the code and their jal words decode back to them");
      // Every entry starts a stack frame — a `jal` into the middle of an instruction pair, or
      // into the table, would land here as something else entirely.
      const entOk = Object.keys(ent).every((k) => (w((ent[k] - H.va) / 4) & 0xFFFF0000) >>> 0 === 0x27BD0000);
      (entOk ? ok : bad)("each entry point begins with `addiu $sp,$sp,-N`");
      // The constants baked into the machine code, re-derived from the JS beside it.
      const enc = {
        row0: ((0x09 << 26) | (5 << 21) | (3 << 16) | ((-H.first) & 0xFFFF)) >>> 0,   // addiu $v1,$a1,-first
        rows: ((0x0B << 26) | (3 << 21) | (1 << 16) | H.rows) >>> 0,                   // sltiu $at,$v1,rows
        recHi: ((0x0F << 26) | (1 << 16) | (((H.recBase >>> 16) + (H.recBase & 0x8000 ? 1 : 0)) & 0xFFFF)) >>> 0,
        recLo: ((0x09 << 26) | (1 << 21) | (1 << 16) | (H.recBase & 0xFFFF)) >>> 0,
        span: ((0x0B << 26) | (2 << 21) | (1 << 16) | (H.recCount * H.recStride)) >>> 0, // sltiu $at,$v0,N
        stride: ((0x09 << 26) | (1 << 16) | H.recStride) >>> 0,                         // addiu $at,$zero,0x8C
      };
      const mask = H.va + H.maskOff;
      const maskHi = ((0x0F << 26) | (1 << 16) | (((mask >>> 16) + (mask & 0x8000 ? 1 : 0)) & 0xFFFF)) >>> 0;
      const maskLo = ((0x09 << 26) | (1 << 21) | (1 << 16) | (mask & 0xFFFF)) >>> 0;
      const shift = Math.log2(H.stride);
      const words = Array.from({ length: nwords }, (_, i) => w(i));
      const has = (x) => words.includes(x >>> 0);
      const checks = [
        ["the row index is `$a1 - PS_HOOK.first`", words[0] === enc.row0],
        ["...bounded by PS_HOOK.rows", words[1] === enc.rows],
        ["the record array base is PS_HOOK.recBase", words[3] === enc.recHi && words[4] === enc.recLo],
        ["...bounded by recCount x recStride", words[6] === enc.span],
        ["...and divided by PS_HOOK.recStride", words[8] === enc.stride],
        [`the row is shifted by log2(stride) = ${shift}`, words[13] === ((3 << 16) | (3 << 11) | (shift << 6)) >>> 0],
        ["the table address is PS_HOOK.va + PS_HOOK.maskOff", words[16] === maskHi && words[17] === maskLo],
        ["the no-match path tail-jumps to 0x16CB380", has(0x08000000 | ((0x16CB380 >> 2) & 0x03FFFFFF))],
        ["...and the battle one to 0x16CB270", has(0x08000000 | ((0x16CB270 >> 2) & 0x03FFFFFF))],
        ["psId resolves the character id through 0x16C6D08", has(0x0C000000 | ((0x16C6D08 >> 2) & 0x03FFFFFF))],
        ["psUnit resolves the acting unit through 0x181B738", has(0x0C000000 | ((0x181B738 >> 2) & 0x03FFFFFF))],
      ];
      checks.forEach(([m, c]) => (c ? ok : bad)(m));
      (H.pickMin === 1 && H.pickMax === 75 ? ok : bad)("the picker offers record indices 1..75 — the battle characters");
      (Math.pow(2, Math.round(shift)) === H.stride && H.stride * 8 >= H.recCount ? ok : bad)(
        "the table stride is a power of two and covers every record index");

      // The fixture plants the same stock bytes; a drift between the two would make the e2e
      // suite exercise a block iso.js does not recognise.
      const syn = fs.readFileSync(path.join(REPO, "web", "tests", "synth-iso.mjs"), "utf8");
      const synHex = ((syn.match(/export const PS_HOOK_STOCK =\n([\s\S]*?);\n/) || [])[1] || "").replace(/[^0-9A-Fa-f]/g, "");
      (synHex === stockHex ? ok : bad)("synth-iso.mjs plants exactly the stock bytes iso.js expects");
      const synJal = syn.match(/PS_HOOK_JAL = \{ rec: (0x[0-9A-Fa-f]+), id: (0x[0-9A-Fa-f]+), unit: (0x[0-9A-Fa-f]+) \}/);
      (synJal && [1, 2, 3].every((i) => parseInt(synJal[i], 16) >>> 0 === jw[["", "rec", "id", "unit"][i]]) ? ok : bad)(
        "synth-iso.mjs and iso.js agree on the three trampoline jal words");
    }

    // Every rune must carry a confidence marker, and only the two words the tab knows how to
    // render. A rune added later with no marker would silently show as "untested" — the safe
    // direction, but it hides the omission, so require it explicitly. (Ported from v1.113.0,
    // which introduced the markers; this version widened them from 2 runes to 22.)
    const proofs = [...sw.matchAll(/proof: "(\w+)"/g)].map((m) => m[1]);
    (proofs.length === ids.length ? ok : bad)(`every rune carries a proof marker (${proofs.length}/${ids.length})`);
    const badProof = proofs.filter((x) => x !== "confirmed" && x !== "untested");
    (badProof.length ? bad : ok)(badProof.length
      ? `unknown proof marker(s): ${[...new Set(badProof)].join(", ")} — the tab only renders confirmed/untested`
      : `proof markers are all confirmed/untested (${[...new Set(proofs)].join(", ")})`);
    // Sunbeam's walk-heal was played on 2026-09-06 — but under the DROPPED-CALL patch shape, not
    // this one. The report is kept in the rune's note as evidence about the site; it may not set
    // the marker, because the trampoline it now goes through has never been played. Nothing here
    // may read "confirmed" until somebody plays THIS build, and a passing test is not that.
    (/id: 0x1BD, where: "both", proof: "untested"/.test(sw) ? ok : bad)(
      "Sunbeam reads untested — its play report was earned under the previous patch shape");
    (/id: 0x1B9, where: "field", proof: "untested"/.test(sw) ? ok : bad)("Champion's reads untested");
    (proofs.includes("confirmed") ? bad : ok)(proofs.includes("confirmed")
      ? "a rune is marked confirmed, but nothing has been watched working through the relocated helper"
      : "nothing claims to be confirmed in play through the relocated helper");
    (/watched working in game, through this mechanism/.test(iso) ? ok : bad)(
      "the confirmed badge's tooltip says which mechanism it would be confirming");
    // The play report itself must survive as recorded history — losing it would cost the one
    // piece of real evidence this feature has.
    (/played on 2026-09-06/.test(sw) && /previous patch shape/.test(sw) ? ok : bad)(
      "Sunbeam's play report is kept, with the patch shape it was earned under");

    // The delay slot is the one word this editor must never touch: every entry in the table
    // carries it, the audit compares it, and the write path only ever rewrites `s.off`.
    (/writeW\(s\.off, 4, w\);/.test(iso) ? ok : bad)("psSyncSites rewrites the jal word and nothing else");
    (/const PS_LEGACY_YES = 0x0004102B;/.test(iso) ? ok : bad)("v1.106.0–v1.113.0's answer word is still recognised (0x0004102B)");
    // ...and recognised as the second of TWO words. The answer word on its own is an ordinary
    // `sltu $v0,$zero,$a0` that occurs elsewhere in the image, so matching it alone would call
    // a stock disc patched. The delay-slot word has to have moved up as well.
    (/if \(a === \(s\.ds >>> 0\) && b === \(PS_LEGACY_YES >>> 0\)\) return "legacy";/.test(iso) ? ok : bad)(
      "the legacy encoding is matched on BOTH words, not on the answer word alone");
  }
}


// 2b) shop counter index: the JSON the Shops tab labels itself from must agree with the
// offsets above, and must not name a location that has no stock on the disc.
console.log("Shop counter index:");
{
  const sp = path.join(REPO, "Editor", "s3_shops.json");
  if (!fs.existsSync(sp)) bad("Editor/s3_shops.json missing");
  else {
    const j = JSON.parse(fs.readFileSync(sp, "utf8"));
    const g = j.geometry || {};
    (g.stride === 0x7C && g.variantStride === 0x1F0 && g.stockSlots === 30
      && g.rarityOff === 0x3C && g.rarityStride === 0x10 && g.rarityCount === 4 ? ok : bad)("geometry matches iso.js");
    (g.rarityOff + g.rarityCount * g.rarityStride === g.stride ? ok : bad)("rarity block exactly fills the record tail");
    (g.stockSlots * 2 === g.rarityOff ? ok : bad)("stock slots exactly fill the record head");
    const bases = { "Item Shop": 4105552, "Armor Shop": 4054224, "Rune Shop": 0x3EEB48 };
    for (const c of j.counters || []) {
      (bases[c.name] === c.base ? ok : bad)(`${c.name} base 0x${c.base.toString(16)}`);
      const end = c.base + g.locations * g.variantStride;
      (c.base >= ELF_BASE && end <= ELF_END ? ok : bad)(`${c.name} array stays in the read block`);
    }
    const stocked = new Set((j.counters || []).flatMap((c) => (c.stocked || []).map((x) => x.loc)));
    const named = Object.keys(j.locationNames || {}).map(Number);
    (named.length > 0 ? ok : bad)(`${named.length} locations named`);
    (named.every((l) => stocked.has(l)) ? ok : bad)("every named location actually has stock");
    (named.every((l) => (j.locationNames[l].evidence || "").length > 20) ? ok : bad)("every name cites its evidence");
    // each counter's 14-location array must stop before the next known table starts
    const NEXT = { "Item Shop": 0x3EC2A0 /* spells */, "Armor Shop": 4061704 /* list4 */, "Rune Shop": 4136564 /* item1 */ };
    for (const c of j.counters || [])
      (c.base + g.locations * g.variantStride <= NEXT[c.name] ? ok : bad)(`${c.name} stops before the next table`);
  }
}

// 3) reference-table parsers (same rules as iso.js loadRef)
console.log("Reference tables:");
const itemsTxt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_item_ids.txt"), "latin1");
const skillsTxt = fs.readFileSync(path.join(REPO, "Editor", "Suikoden3_skill_ids.txt"), "latin1");
let nItems = 0; const reI = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; while (reI.exec(itemsTxt)) nItems++;
let nSkills = 0; for (const l of skillsTxt.split(/\r?\n/)) { const p = l.trim().split(/\s+/); if (p.length >= 2 && !isNaN(parseInt(p[0], 16))) nSkills++; }
(nItems > 400 ? ok : bad)(`items parsed: ${nItems}`);
(nSkills >= 40 ? ok : bad)(`skills parsed: ${nSkills}`);

// 4) shell wiring sanity: index.html loads iso.js and has both mode tabs; sw precaches iso.js
console.log("App shell:");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
(/src=["']iso\.js["']/.test(html) ? ok : bad)("index.html loads iso.js");
(/src=["']recruit-core\.js["']/.test(html) ? ok : bad)("index.html loads recruit-core.js before app.js");
(/src=["']guide-core\.js["']/.test(html) ? ok : bad)("index.html loads guide-core.js before app.js");
(/src=["']health-core\.js["']/.test(html) ? ok : bad)("index.html loads health-core.js before app.js");
(/src=["']text-core\.js["']/.test(html) ? ok : bad)("index.html loads text-core.js before iso.js");
(/data-mode="iso"/.test(html) && /data-mode="save"/.test(html) ? ok : bad)("both mode tabs present");
{ const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
  (/iso\.js/.test(sw) && /recruit-core\.js/.test(sw) ? ok : bad)("service worker precaches iso.js + recruit-core.js");
  (/guide-core\.js/.test(sw) ? ok : bad)("service worker precaches guide-core.js");
  (/health-core\.js/.test(sw) ? ok : bad)("service worker precaches health-core.js"); }
// Boot gate: loading a memory card is inert until Pyodide is up, so a block covers that card.
// Three things about it are load-bearing and easy to break later, so assert them statically:
// it must be in the MARKUP (built from script it would flash the dead UI first), it must sit
// INSIDE #loaderCard (it used to be a full-screen overlay, which made the ISO editor — which
// needs no Python at all — look dead for the length of a 10 MB download), and it must keep the
// ISO shortcut. Also that app.js can actually take it down on both outcomes. boot-gate.mjs
// proves the coverage in a real browser; these are the cheap regressions to catch first.
{ const js = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  const bootCss = fs.readFileSync(path.join(WEB, "style.css"), "utf8");
  (/id="bootOv"/.test(html) ? ok : bad)("boot gate is in index.html (up on first paint)");
  const iCard = html.indexOf('id="loaderCard"'), iOv = html.indexOf('id="bootOv"'), iDrop = html.indexOf('id="drop"');
  (iCard >= 0 && iOv > iCard && iOv < iDrop ? ok : bad)("boot gate is inside the save loader card, not the page");
  (!/\.boot-ov\s*\{[^}]*position:\s*fixed/.test(bootCss) ? ok : bad)("boot gate is not a fixed full-screen overlay");
  (/id="bootIso"/.test(html) ? ok : bad)("boot gate offers the ISO-editor shortcut");
  (/id="bootFill"/.test(html) && /id="bootMsg"/.test(html) ? ok : bad)("boot gate has a progress bar + message");
  (/bootGate\.close\(\)/.test(js) ? ok : bad)("app.js closes the boot gate");
  (/bootGate\.fail\(/.test(js) ? ok : bad)("app.js puts the boot gate in an error state when the engine fails"); }

// 5) canonical recruit-team map: parses, teams valid, every name is in s3save.py ROSTER
console.log("Recruit teams:");
try {
  const rt = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_teams.json"), "utf8"));
  const validTeams = ["Hugo", "Chris", "Geddoe", "Thomas"];
  const teams = rt.teams || {};
  (Object.keys(teams).every((t) => validTeams.includes(t)) ? ok : bad)("only valid protagonist teams");
  // ROSTER names from s3save.py
  const src = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
  const m = /ROSTER\s*=\s*\[([\s\S]*?)\]/.exec(src);
  const roster = new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  const all = Object.values(teams).flat();
  const missing = all.filter((n) => !roster.has(n));
  (missing.length === 0 ? ok : bad)(`all ${all.length} team members exist in ROSTER` + (missing.length ? " (missing: " + missing.join(", ") + ")" : ""));
  const dupes = all.filter((n, i) => all.indexOf(n) !== i);
  (dupes.length === 0 ? ok : bad)("no character listed on two teams" + (dupes.length ? " (dupes: " + dupes.join(", ") + ")" : ""));
} catch (e) { bad("s3_recruit_teams.json — " + e.message); }

// 6) QoL guards — styling + save-editor bits headless e2e can't reach (it aborts Pyodide)
console.log("QoL guards:");
{ const css = fs.readFileSync(path.join(WEB, "style.css"), "utf8");
  (/input\.search[^{]*\{[^}]*font-size:\s*16px/.test(css) && /input\.search[^{]*\{[^}]*min-height:\s*44px/.test(css)
    ? ok : bad)("filter inputs sized for touch (min-height 44px, 16px font)");
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  (/s3suffix"\)\s*===\s*"on"/.test(app) ? ok : bad)("save-editor '.edited' suffix defaults OFF (overwrite-friendly)");
  (/showSaveFilePicker/.test(app) ? ok : bad)("save-editor has a 'Save as…' destination picker");
  // Guide overlays: the join itself is covered behaviorally by guide-core.mjs; these assert the
  // save editor actually fetches the three files and renders a note for each kind of field.
  (/s3_skill_caps\.json/.test(app) && /s3_growth_ref\.json/.test(app) && /s3_rune_slots\.json/.test(app)
    ? ok : bad)("save-editor fetches the skill-cap / growth / rune-slot guides");
  (/GuideCore\./.test(app) ? ok : bad)("save-editor uses the pure GuideCore join (not an inline copy)");
  // Health check: the panel must drive the pure audit, over the STAGED edits, and must never
  // write on its own — a Fix only stages ops the normal Apply path then reviews.
  (/HealthCore\.audit\(/.test(app) && /data-sub="health"/.test(app) && /function drawHealth/.test(app)
    ? ok : bad)("save editor has the Health panel wired to HealthCore.audit");
  (/edits: EDITS, inv: INV, party: PARTY, recruit: RECRUIT, gold: GOLD/.test(app)
    ? ok : bad)("the audit runs over the pending edits, not just the file on disk");
  (/function applyFixOps/.test(app) && !/py\.runPython[^\n]*applyFixOps/.test(app)
    ? ok : bad)("a Health fix only stages edits (no direct write path)");
  // the item-classification rules exist once, in health-core, not copied back into app.js
  (/HealthCore\.itemStackable/.test(app) && !/ITEM_ONE_PER_SLOT_EXC = new Set/.test(app)
    ? ok : bad)("app.js uses the shared item rules instead of a second copy");
  (/growthNoteSave\(c\.name, n\)/.test(app) && /runeSlotNoteSave\(c\.name, key\)/.test(app) && /capNote\(c\.name, sk\.id\)/.test(app)
    ? ok : bad)("save-editor renders guide notes on stats, rune slots and skill slots");
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/RenameCore\.streamReplacer/.test(iso) && /src=["']rename-core\.js["']/.test(html) ? ok : bad)("ISO editor wires the character-rename streaming replacer");
  // The rename panel is a fold, and its open state is read back out of the DOM at redraw time —
  // a card that trusted only its `toggle` handler would snap shut on the next edit in the tab.
  (/<details class="card fold" id="rnBox"/.test(iso) && /q\("#rnBox", host\); if \(b\) rnOpen = b\.open/.test(iso)
    ? ok : bad)("the character-rename panel is collapsible and keeps its open state across a redraw");
  (/function markFlagsField/.test(iso) ? ok : bad)("ISO editor has bit-aware Target/AOE highlight");
  (/class="spdesc"/.test(iso) && /class="undesc"/.test(iso) && /class="fddesc"/.test(iso) ? ok : bad)("ISO editor has editable spell + unite + food descriptions");
  (/<input type="file" id="isoFileInput">/.test(iso) ? ok : bad)("ISO file input has no restrictive accept filter (Android can select .iso)");
  (/doStreamSave/.test(iso) ? ok : bad)("ISO editor has the streaming 'save patched copy' path");
  // Applying patches: sniff the format by magic, walk windows, stage rather than write.
  (/async function applyXdelta/.test(iso) && /Vcdiff\.eachWindow/.test(iso)
    ? ok : bad)("ISO editor can apply an .xdelta patch");
  (/0xd6 && head\[1\] === 0xc3/.test(iso) ? ok : bad)("import sniffs VCDIFF magic (not the file extension)");
  (/w\.plan\(\)\.length/.test(iso) ? ok : bad)("apply-patch skips untouched windows (no whole-disc read)");
  (/outside the region/.test(iso) ? ok : bad)("apply-patch refuses a patch that reaches outside the editable block");
  const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
  (/cache:\s*"no-store"/.test(sw) ? ok : bad)("service worker fetches app shell no-store (fresh updates)");
  (/dl-register/.test(sw) ? ok : bad)("service worker supports the streaming-download hand-off"); }

// 7) list2 growth + skill-max offsets (github issue #2 regression guard).
// These were re-derived + verified against a real ISO (skill-max start +16 matches ~90% of
// suikosource caps vs ~12% at the old +13; growth stat<->byte by correlation vs statgrowth).
// iso.js is now the only implementation of these tables, so it is the only thing to assert.
console.log("list2 offsets (issue #2):");
{
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  // expected growth stat -> byte offset (HP at +0 is the tell-tale that the fix is in place)
  const GROWTH = { PWR: 4, SKL: 5, MAG: 6, REP: 7, MDF: 9, SPD: 10, LUK: 11, HP: 0 };

  // skill-max start must be 16 in BOTH editors
  const jsStart = /LIST2_SKILLMAX_START\s*=\s*(\d+)/.exec(iso);
  (jsStart && +jsStart[1] === 16 ? ok : bad)(`iso.js skill-max start = ${jsStart && jsStart[1]} (want 16)`);

  // growth offsets must match the verified map in BOTH editors
  const jsGrowth = /const LIST2_GROWTH\s*=\s*\[([\s\S]*?)\];/.exec(iso);
  for (const [stat, off] of Object.entries(GROWTH)) {
    const re = new RegExp(`"${stat} growth[^"]*"\\s*,\\s*${off}\\b`);   // iso.js: ["PWR growth", 4, ...]
    (jsGrowth && re.test(jsGrowth[1]) ? ok : bad)(`iso.js ${stat} growth @+${off}`);
  }
  // the bogus "rune level" fields must be gone
  (jsGrowth && !/Rune Level/.test(jsGrowth[1]) ? ok : bad)("iso.js has no bogus 'Rune Level' growth fields");

  // encoding must stay non-monotonic (1=A+), which the ISO verification confirmed is correct
  (/\[1,\s*"A\+"\]/.test(iso) ? ok : bad)("iso.js MAX_OPTS keeps 1=A+ (verified-correct encoding)");

  // list1 rune slots are Head@+64 / Right@+72 / Left@+80 (verified vs suikosource + save editor).
  // Guards against the Head<->Left label swap the exe shipped (issue #2).
  const RUNES = [["Head", 64], ["Right hand", 72], ["Left hand", 80]];
  for (const [slot, off] of RUNES) {
    (new RegExp(`"Rune ${slot}"\\s*,\\s*${off}\\b`).test(iso) ? ok : bad)(`iso.js Rune ${slot} @+${off}`);
  }
}

// 7b) spell/unite tail fields (radius + status chance). These live in the record's LAST 8
// bytes, which the table stores one record out of phase — so a spell reads them at
// base+stride+x while a unite (8 bytes longer) reads them inside its own record at +0x20+x.
// Getting that phase wrong reads a neighbour's data, so pin both offset sets.
console.log("spell/unite tail fields (radius/chance):");
{
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  const cons = (name) => {
    const m = new RegExp(`const ${name} = (\\{[^}]*\\})`).exec(iso);
    return m ? JSON.parse(m[1].replace(/([a-z]+):/g, '"$1":').replace(/0x[0-9A-Fa-f]+/g, (h) => parseInt(h, 16))) : null;
  };
  const SPELL = cons("SPELL"), UNITE = cons("UNITE");
  const want = { SPELL: { radius: 0x21, chance: 0x26, elem: 0x24 }, UNITE: { radius: 0x21, chance: 0x24 } };
  for (const [tbl, got] of [["SPELL", SPELL], ["UNITE", UNITE]]) {
    if (!got) { bad(`iso.js ${tbl} table const not found`); continue; }
    for (const [f, exp] of Object.entries(want[tbl]))
      (got[f] === exp ? ok : bad)(`iso.js ${tbl}.${f} = 0x${(got[f] ?? 0).toString(16)} (want 0x${exp.toString(16)})`);
    // the tail of the last record the editor actually reads must land inside the read block
    // (a spell's tail is one record ahead, so the last readable spell is count-2)
    const last = tbl === "SPELL" ? got.count - 2 : got.count - 1;
    const tail = got.off + last * got.stride + got.chance + 2;
    (tail <= ELF_END ? ok : bad)(`${tbl} last tail read ends at ${tail} (block ends ${ELF_END})`);
  }
}

// 8) guide reference overlays + .xdelta export wiring.
console.log("Guide overlays + xdelta:");
{
  for (const f of ["s3_rune_slots.json", "s3_skill_ref.json", "s3_skill_caps.json", "s3_growth_ref.json"]) {
    try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", f), "utf8"));
      (Object.keys(j).length > 0 ? ok : bad)(`${f} parses (${Object.keys(j).length} entries)`); }
    catch (e) { bad(`${f} — ${e.message}`); }
  }
  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/s3_rune_slots\.json/.test(iso) && /s3_skill_ref\.json/.test(iso) && /s3_skill_caps\.json/.test(iso) && /s3_growth_ref\.json/.test(iso)
    ? ok : bad)("iso.js loadRef fetches all four reference overlays");
  (/function runeSlotNote/.test(iso) && /function skillCapNote/.test(iso) && /function growthNote/.test(iso) && /function skillEffectText/.test(iso)
    ? ok : bad)("iso.js defines the overlay note helpers");
  (/function exportXdelta/.test(iso) && /Vcdiff\.buildXdelta/.test(iso) && /id="isoXdeltaBtn"/.test(iso)
    ? ok : bad)("iso.js has the Export .xdelta button + handler");
  (/src=["']vcdiff\.js["']/.test(html) ? ok : bad)("index.html loads vcdiff.js");
  { const sw = fs.readFileSync(path.join(WEB, "sw.js"), "utf8");
    (/vcdiff\.js/.test(sw) ? ok : bad)("service worker precaches vcdiff.js"); }
  try { execFileSync(process.execPath, ["--check", path.join(WEB, "vcdiff.js")]); ok("vcdiff.js syntax"); }
  catch (e) { bad("vcdiff.js — " + String(e.stderr || e).split("\n")[0]); }
  // support-skill fade (list3): only utility skills 0x1C..0x26 are "used"; combat slots fade
  (/const supportActive = \(id\) => id >= 0x1C && id <= 0x26/.test(iso) && /listKey === "list3"/.test(iso)
    ? ok : bad)("iso.js fades unused combat skills in the Support view");
  // rune + food item-description enrichment (blank in the item-desc pool; sourced from the
  // spell + food tables read live from the ISO)
  (/function runeDesc/.test(iso) && /function foodDesc/.test(iso) && /const itemDesc =/.test(iso) && /desc: itemDesc\(id\)/.test(iso)
    ? ok : bad)("iso.js enriches rune + food item descriptions");
  // food/recipe table is 60 dishes (recs 60-61 resolve to consumable items, not dishes)
  (/count: 60,/.test(iso) ? ok : bad)("iso.js FOOD.count = 60 (drops non-dish tail records)");
  const sp = fs.readFileSync(path.join(REPO, "Editor", "s3patch.py"), "utf8");
  (/FOOD_COUNT\s*=\s*60\b/.test(sp) ? ok : bad)("s3patch.py FOOD_COUNT = 60");
  // rune item table: the only source for the 23 passive support runes. iso.js reads it live and
  // build_item_desc_extra.py bakes it into s3_rune_food_desc.json for the save editor, so the two
  // must agree on its base — otherwise the baked text and the live text describe different runes.
  const isoRune = /RUNE_TBL = \{ off: (0x[0-9A-Fa-f]+), stride: (0x[0-9A-Fa-f]+)/.exec(iso);
  const pyRune = /RUNE_TBL_FILE\s*=\s*(0x[0-9A-Fa-f]+)/.exec(sp);
  const pyRuneStride = /RUNE_TBL_STRIDE\s*=\s*(0x[0-9A-Fa-f]+)/.exec(sp);
  (isoRune && pyRune && pyRuneStride && +isoRune[1] === +pyRune[1] && +isoRune[2] === +pyRuneStride[1]
    ? ok : bad)("iso.js RUNE_TBL and s3patch.py RUNE_TBL_FILE agree (live read vs baked JSON)");
  // Every non-rune row in that table is zeroed, so a row is only believed when it still names
  // the rune the item list says it is. Both the description AND the four spell slots go
  // through runeRowTrusted() — four zeros in an unnamed row means "nothing to read here",
  // not "this rune grants no spells".
  (/function runeRowTrusted/.test(iso) && /function runeTblDesc/.test(iso)
    && /runeRowTrusted\(id\)/.test(iso) && /nameKey\(strAt\(np\)\) === want/.test(iso)
    ? ok : bad)("iso.js validates each rune record's name before trusting its contents");
  // ...and it matches the name the row SHIPPED with too, or renaming a rune would make that
  // rune's own fields vanish — the row stops matching the bundled item list at exactly the
  // moment it is most certainly the right row.
  (/nameKey\(strFrom\(ORIG, vaOff\(np\), origSlotLen\(np\)\)\) === want/.test(iso)
    ? ok : bad)("iso.js keeps trusting a rune row after the rune is renamed");
  // The rune->spell binding: RUNE_TBL +0x18 is four u16 1-based spell numbers (0 = a free
  // slot). This is the fact the offsets doc spent three sessions hunting for in code, so a
  // regression on the offset or the 1-based convention has to fail loudly rather than write
  // a plausible-looking wrong number into a rune record.
  (/spells: 0x18, slotCount: 4/.test(iso) ? ok : bad)("iso.js RUNE_TBL carries the four spell slots at +0x18");
  (/function runeSpellIds/.test(iso) && /RUNE_TBL\.spells \+ k \* 2/.test(iso)
    ? ok : bad)("iso.js reads a rune's granted spells off the disc, not a bundled list");
  (!/const RUNE_SPELLS/.test(iso) ? ok : bad)("iso.js keeps no second, hardcoded copy of the rune->spell map");
  (/spellSlotName = \(gid\) => \(gid \? spellRowName\(gid - 1\)/.test(iso)
    ? ok : bad)("iso.js treats a spell slot as 1-based (0 = empty, not spell 0)");
  (/select class="rspell"/.test(iso) && /reg\(off, 2, "spellid", itemName\(id\), `Spell slot/.test(iso)
    ? ok : bad)("the Runes tab renders four editable spell slots and registers the write");
  (/function dropDescCaches/.test(iso) && (iso.match(/dropDescCaches\(\)/g) || []).length >= 5
    ? ok : bad)("iso.js drops the name->desc caches on every staged edit / undo / revert");
  // save editor (no ISO) uses the pre-extracted rune/food descriptions + rich skill effects
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_food_desc.json"), "utf8"));
    (Object.keys(j).length > 50 ? ok : bad)(`s3_rune_food_desc.json parses (${Object.keys(j).length} entries)`); }
  catch (e) { bad("s3_rune_food_desc.json — " + e.message); }
  const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  (/itemdescextra\.json/.test(app) && /extra\.get\(k\) or idesc\.get/.test(app)
    ? ok : bad)("save editor merges rune/food descriptions");
  (/skillref\.json/.test(app) && /_skill_effect_text/.test(app)
    ? ok : bad)("save editor shows per-rank skill effects");
  // recruit: preview-before-apply + story/optional shading
  // recruit section is per-character only (bulk + canonical presets removed); story shading stays
  (!/data-canon/.test(app) && !/recAllShown/.test(app) ? ok : bad)("save editor recruit has no bulk/canonical buttons");
  (/s3_recruit_meta\.json/.test(app) && /isStoryAuto/.test(app) && /story-auto/.test(app)
    ? ok : bad)("save editor fades story auto-join recruits");
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_meta.json"), "utf8"));
    const story = Object.values(j).filter((v) => v.auto).length;
    (Object.keys(j).length > 90 && story > 20 ? ok : bad)(`s3_recruit_meta.json parses (${Object.keys(j).length} chars, ${story} story)`); }
  catch (e) { bad("s3_recruit_meta.json — " + e.message); }
  // 108 Stars: the checklist runs in the recruitment guide's order, cut into that order's stages
  (/s3_recruit_order\.json/.test(app) && /orderStars/.test(app) && /groupStars/.test(app) && /phaserow/.test(app)
    ? ok : bad)("108-Stars checklist runs in the guide's recruitment order");
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_order.json"), "utf8"));
    const ns = Object.values(j.chars).map((g) => g.n);
    const staged = Object.values(j.chars).every((g) => j.phases.some((p) => p.key === g.phase));
    (Object.keys(j.chars).length === 108 && new Set(ns).size === ns.length && staged && j.extras.length === 4
      ? ok : bad)(`s3_recruit_order.json parses (${Object.keys(j.chars).length} stars, ${j.phases.length} stages, ${j.extras.length} non-star)`); }
  catch (e) { bad("s3_recruit_order.json — " + e.message); }
  // ...and under each how-to, what that errand needs and where it comes from
  (/s3_recruit_needs\.json/.test(app) && /needChips/.test(app) && /class="needs"/.test(app)
    ? ok : bad)("108-Stars checklist says what each errand needs");
  // ...and hands it over: item into the current party's bag, potch topped up by the shortfall
  (/data-needitem/.test(app) && /bagForNeeds/.test(app) && /data-needgold/.test(app)
    ? ok : bad)("108-Stars checklist can stage the item and the potch it needs");
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_needs.json"), "utf8"));
    const items = Object.values(j.chars).flatMap((c) => c.items || []);
    const rose = (j.chars["Augustine"].items || [])[0];
    (items.length >= 8 && rose && rose.name === "Rose Brooch" && rose.shops.length
      && rose.shops[0].town === "Iksay Village" && rose.shops[0].kind === "rare"
      ? ok : bad)(`s3_recruit_needs.json parses (${Object.keys(j.chars).length} stars, ${items.length} items)`); }
  catch (e) { bad("s3_recruit_needs.json — " + e.message); }
  // gear +0x08 is a price tier into the shared ladder, not potch — resolved everywhere it shows
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_recruit_needs.json"), "utf8"));
    const mole = (j.chars["Dominic"].items || [])[0];
    (mole && mole.buy === true && mole.price === 600 ? ok : bad)("a bought recruit item is priced from the disc");
  } catch (e) { bad("recruit needs buy price — " + e.message); }
  (/tierPotch/.test(iso) && /Price tier/.test(iso) && !/Price \(potch\)/.test(iso)
    ? ok : bad)("iso.js resolves the gear price tier through the ladder");
  // manual "Force refresh" escape hatch: footer button that clears SW + caches and reloads
  (/id="forceRefreshBtn"/.test(html) && /#forceRefreshBtn/.test(app)
    ? ok : bad)("footer has an always-available Force-refresh button");
  (/async function forceUpdate/.test(app) && /caches\.keys\(\)/.test(app) && /unregister\(\)/.test(app)
    ? ok : bad)("forceUpdate clears caches + unregisters the service worker");
  // ISO editor: undo/redo engine + skill-cap presets + rune reskin presets
  (/function undo\(\)/.test(iso) && /function redo\(\)/.test(iso) && /id="isoUndoBtn"/.test(iso) && /function recByte/.test(iso)
    ? ok : bad)("iso.js has an undo/redo engine + buttons");
  (/function applyCapPreset/.test(iso) && /data-cap="max"/.test(iso) && /data-cap="guide"/.test(iso)
    ? ok : bad)("iso.js Growth view has skill-cap presets");
  (/data-rspreset=/.test(iso) ? ok : bad)("iso.js Spells tab has rune reskin presets");
  // Damage+heal slot: three instruction immediates in the boot ELF, all inside the block the
  // editor holds, and all three rewritten together (moving one without the others leaves the
  // split spell healing for its Power instead of the number the user typed).
  {
    const m = iso.match(/const SPLIT = \{([\s\S]*?)\n  \};/);
    const num = (k) => { const g = m && m[1].match(new RegExp(k + ":\\s*(0x[0-9A-Fa-f]+)")); return g ? parseInt(g[1], 16) : NaN; };
    const sites = m ? ["route", "amtSel", "amt"].map(num) : [];
    (m && sites.every((o) => o >= 0xA4800 && o < 0x465DF0) ? ok : bad)(
      `iso.js SPLIT sites sit inside the ELF block (${sites.map((o) => "0x" + (o >>> 0).toString(16)).join(" ")})`);
    (m && num("stockRoute") === 0x24020011 && num("stockAmtSel") === 0x3AC30011 && num("stockAmt") === 0x2412012C
      ? ok : bad)("iso.js SPLIT stock words = spell 17 / spell 17 / 300 HP");
    (/function applySplit/.test(iso) && /SPLIT\.route/.test(iso) && /SPLIT\.amtSel/.test(iso) && /SPLIT\.amt,/.test(iso)
      ? ok : bad)("iso.js applySplit rewrites all three damage+heal immediates");
  }
  // bestiary reference (Enemies tab)
  try { const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_bestiary.json"), "utf8"));
    (Object.keys(j).length >= 50 ? ok : bad)(`s3_bestiary.json parses (${Object.keys(j).length} enemies)`); }
  catch (e) { bad("s3_bestiary.json — " + e.message); }
  (/s3_bestiary\.json/.test(iso) && /REF\.bestiary/.test(iso) ? ok : bad)("iso.js Enemies tab renders the bestiary reference");
  // Enemy pack index: the Enemies editor's ground truth. Every offset must sit inside the
  // 4.3 GB disc and past the ELF block (in-block offsets would double-edit through BUF).
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_enemy_packs.json"), "utf8"));
    (j.format === "s3enemy" && Array.isArray(j.packs) && j.packs.length >= 30 ? ok : bad)(
      `s3_enemy_packs.json parses (${j.packs.length} packs)`);
    const ISO_MAX = 0x100008000, ELF_HI = 0x465DF0;
    let n = 0, badOff = 0, vtot = 0;
    for (const p of j.packs) for (const e of p.enemies) for (const v of e.variants) {
      vtot++;
      for (const o of [...v.rec, ...v.aux]) { n++; if (o < ELF_HI || o + 0x8C > ISO_MAX) badOff++; }
    }
    (badOff === 0 ? ok : bad)(`all ${n} enemy offsets are out-of-block and on-disc (${vtot} variants)`);
    const gh = j.packs.flatMap((p) => p.enemies).filter((e) => e.name === "GhostHolly")
      .flatMap((e) => e.variants).find((v) => v.lv === 46 && v.hp === 3800);
    (gh && gh.sp === 490 && gh.potch === 33000 ? ok : bad)(
      "index spot-check: GhostHolly Lv46 = SP 490 / potch 33,000 (Suikosource)");
    // zones: every slot/party/member offset on-disc + out-of-block; members index real slots
    let zn = 0, zbad = 0, ztot = 0, ftot = 0;
    for (const p of j.packs) for (const z of (p.zones || [])) {
      ztot++;
      for (const s of z.slots) for (const o of s.off) { zn++; if (o < ELF_HI || o + 0x14 > ISO_MAX) zbad++; }
      for (const pa of z.parties) {
        ftot++;
        if (pa.members.some((m) => m >= z.slots.length)) zbad++;
        for (const o of [...pa.off, ...pa.memOff]) { zn++; if (o < ELF_HI || o + 4 > ISO_MAX) zbad++; }
      }
    }
    (ztot >= 40 && zbad === 0 ? ok : bad)(`zones sane: ${ztot} zones, ${ftot} formations, ${zn} offsets checked`);
    // mori_101 exists as chapter variants; the HollyShrub-era one has 5 slots / 16 formations
    const moris = j.packs.flatMap((p) => p.zones || []).filter((z) => z.name === "mori_101");
    (moris.some((z) => z.slots.length === 5 && z.parties.length === 16 && z.slots[0].id === 0x1F5)
      ? ok : bad)(`zone spot-check: a mori_101 variant has 5 slots / 16 formations (${moris.length} variants)`);
    (/s3_enemy_packs\.json/.test(iso) && /S3_TEST_ENEMY_PACKS/.test(iso) ? ok : bad)(
      "iso.js loads the pack index (with the test override hook)");
    // War-unit index (War tab): same record layout, its own JSON. Offsets must be
    // on-disc, out-of-block AND disjoint from the enemy index (overlapping write
    // windows would desync), and war variants never carry aux/reward offsets.
    const w = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_war_units.json"), "utf8"));
    (w.format === "s3war" && Array.isArray(w.packs) && w.packs.length >= 6 &&
      w.packs.every((p) => p.war === true) ? ok : bad)(
      `s3_war_units.json parses (${w.packs.length} war packs, all flagged war)`);
    const eoffs = new Set();
    for (const p of j.packs) for (const e of p.enemies) for (const v of e.variants)
      for (const o of [...v.rec, ...v.aux]) eoffs.add(o);
    let wn = 0, wbad = 0, woverlap = 0, waux = 0, wvar = 0;
    for (const p of w.packs) for (const e of p.enemies) for (const v of e.variants) {
      wvar++;
      waux += v.aux.length;
      for (const o of v.rec) { wn++; if (o < ELF_HI || o + 0x8C > ISO_MAX) wbad++; if (eoffs.has(o)) woverlap++; }
    }
    (wbad === 0 && woverlap === 0 && waux === 0 ? ok : bad)(
      `all ${wn} war offsets on-disc, disjoint from enemy packs, aux-free (${wvar} variants)`);
    // spot-checks vs the Suikosource bosses guide (exact lv/hp matches)
    const zk = w.packs.flatMap((p) => p.enemies).filter((e) => e.name === "ZxnKn")
      .flatMap((e) => e.variants).filter((v) => v.lv === 20 && v.hp === 230);
    (zk.length >= 4 ? ok : bad)(`war spot-check: ZxnKn Lv20/HP230 (Thomas ch2 battle, Suikosource) in ${zk.length} packs`);
    const sarah = w.packs.find((p) => p.archive === "SOGE");
    (sarah && sarah.enemies.some((e) => e.name.startsWith("Sarah") &&
      e.variants.some((v) => v.lv === 60 && v.hp === 3200)) ? ok : bad)(
      "war spot-check: Sarah unit Lv60/HP3200 (Suikosource) in SOGE");
    const etcw = w.packs.find((p) => p.archive === "ETC");
    (etcw && etcw.enemies.some((e) => e.name === "ZxnInf" && e.variants.length === 12) ? ok : bad)(
      "war spot-check: shared ETC pack has the 12-tier ZxnInf table");
    (/s3_war_units\.json/.test(iso) && /S3_TEST_WAR_UNITS/.test(iso) && /function drawWar/.test(iso) &&
      /\["war", "War"\]/.test(iso) ? ok : bad)("iso.js loads war units and renders the War tab");
    // The War view's bulk tuner multiplies the STOCK numbers stored beside each offset and
    // offers "Restore stock values" off the same field. A variant missing lv/hp/stats would
    // silently fall back to this file's own values (compounding on re-apply), so the baseline
    // has to be complete before the feature can be trusted.
    { const wv = w.packs.flatMap((p) => p.enemies).flatMap((e) => e.variants);
      const full = wv.filter((v) => Number.isFinite(v.lv) && Number.isFinite(v.hp)
        && Array.isArray(v.stats) && v.stats.length === 8 && v.stats.every(Number.isFinite));
      (full.length === wv.length ? ok : bad)(
        `every war variant carries a stock lv/hp/8-stat baseline (${full.length}/${wv.length})`); }
    // The bulk scopes split leaders from soldier tiers on the id boundary build_war_index.py
    // documents (below 0x100 = the game's actor enum). Both sides must be populated, or one
    // of the two scopes silently selects nothing.
    { const ids = new Set(w.packs.flatMap((p) => p.enemies).map((e) => e.id));
      const lead = [...ids].filter((i) => i < 0x100), troop = [...ids].filter((i) => i >= 0x100);
      (lead.length && troop.length ? ok : bad)(
        `war units split into leader and soldier scopes (${lead.length} leader ids, ${troop.length} soldier/monster ids)`); }
    (/WAR_BULK/.test(iso) && /bulkCardHtml\(WAR_BULK/.test(iso) && /wireBulkCard\(WAR_BULK/.test(iso) ? ok : bad)(
      "iso.js renders and wires the War bulk-tuning card");
    // Room index (per-area encounter rates). Same rules as the enemy index: every offset
    // must be on-disc and OUT of the ELF block, or the editor's in-block buffer would
    // double-edit it. Offsets must also be unique — two rows writing one byte desync.
    const rm = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rooms.json"), "utf8"));
    const rooms = rm.areas.flatMap((a) => a.tables.flatMap((t) => t.rooms));
    (rm.format === "s3rooms" && rm.areas.length >= 20 && rooms.length >= 1500 ? ok : bad)(
      `s3_rooms.json parses (${rm.areas.length} areas, ${rooms.length} rooms)`);
    { const offs = rooms.flatMap((r) => [r.rateOff, r.graceOff]);
      const outOfBlock = offs.every((o) => o >= ELF_HI && o + 2 <= ISO_MAX);
      (outOfBlock && new Set(offs).size === offs.length ? ok : bad)(
        `all ${offs.length} room offsets out-of-block, on-disc and unique`);
      (/s3_rooms\.json/.test(iso) && /S3_TEST_ROOMS/.test(iso) ? ok : bad)(
      "iso.js loads the room index (with the test override hook)");
    (/function drawRoomRates/.test(iso) && /function roomRows/.test(iso) && /function scaleArea/.test(iso)
      ? ok : bad)("iso.js Encounter tab renders per-area rates");
    (/tag: "room"/.test(iso) ? ok : bad)("room windows are tagged apart from the enemy windows");
    (!/Only the <b>global<\/b> rate is editable/.test(iso) ? ok : bad)(
      "the 'global only' caveat is gone from the Encounter tab");
    // Sub-file index (Files view). Every sub-file must sit inside its own archive, and the
    // directory must tile it exactly — that tiling is what identified the archive at all.
    const sf = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_subfiles.json"), "utf8"));
    const nsub = sf.archives.reduce((a, x) => a + x.files.length, 0);
    (sf.format === "s3subfiles" && sf.archives.length >= 28 && nsub >= 4000 ? ok : bad)(
      `s3_subfiles.json parses (${sf.archives.length} archives, ${nsub} sub-files)`);
    { let bad2 = 0, tiles = 0;
      for (const a of sf.archives) {
        let next = 0;
        for (const [sect, size] of a.files) { if (sect !== next) bad2++; next = sect + size; }
        if (next * 2048 === a.size) tiles++;
      }
      (bad2 === 0 && tiles === sf.archives.length ? ok : bad)(
        `every archive's sub-files tile it exactly (${tiles}/${sf.archives.length})`);
      const towns = sf.archives.reduce((a, x) => a + x.files.filter((f2) => sf.kinds[f2[2]] === "town").length, 0);
      const tables = rm.areas.reduce((a, x) => a + x.tables.length, 0);
      (towns === tables ? ok : bad)(`town sub-files match the room index's tables (${towns} vs ${tables})`); }
    // the Reference tab strip is data-driven (REF_MODES), so "registered" means an entry there
    const refMode = (k) => new RegExp(`\\["${k}", "[^"]+", \\(\\) =>`).test(iso);
    (/s3_subfiles\.json/.test(iso) && /function drawFiles/.test(iso) && refMode("files")
      ? ok : bad)("iso.js registers the read-only Files browser under Reference");
    // Item sources (Reference view). Provenance must stay split: `drops` are decoded from
    // the disc, `guide` rows are somebody's notes. A row that can't say which is worthless.
    const isrc = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_item_sources.json"), "utf8"));
    { const its = Object.values(isrc.items);
      (isrc.format === "s3itemsources" && its.length >= 100 ? ok : bad)(
        `s3_item_sources.json parses (${its.length} items)`);
      const nd = its.filter((x) => x.drops).length, ng = its.filter((x) => x.guide).length;
      (nd >= 90 && ng >= 50 ? ok : bad)(`${nd} items with decoded drops, ${ng} with guide notes`);
      // every drop row must name a real enemy/archive and a weight in the engine's 0..1000
      const ep2 = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_enemy_packs.json"), "utf8"));
      const known = new Set(ep2.packs.flatMap((p2) => p2.enemies.map((e) => e.name)));
      const rows = its.flatMap((x) => x.drops || []);
      (rows.every((r) => known.has(r.enemy) && r.weight > 0 && r.weight <= 1000 && r.lv >= 1 && r.lv <= 99)
        ? ok : bad)(`all ${rows.length} drop rows name a real enemy with a sane weight`);
      // Rows are grouped by (enemy, level, weight) with the hosting archives listed, so the
      // same fact can't appear once per archive. Ungrouped this was 625 rows for 188 facts.
      (rows.every((r) => Array.isArray(r.archives) && r.archives.length >= 1) ? ok : bad)(
        "every drop row carries its archive list");
      { const key = (r) => `${r.enemy}|${r.lv}|${r.weight}`;
        const dupes = its.filter((x) => x.drops &&
          new Set(x.drops.map(key)).size !== x.drops.length).length;
        (dupes === 0 ? ok : bad)(`no item repeats an (enemy, level, weight) fact (${dupes} do)`);
        const spread = rows.reduce((a, r) => a + r.archives.length, 0);
        (spread > rows.length ? ok : bad)(
          `${rows.length} facts span ${spread} archive placements (grouping is doing work)`); }
      const kinds = new Set(its.flatMap((x) => (x.guide || []).map((g) => g.kind)));
      (kinds.has("chest") && kinds.has("drop") ? ok : bad)(`guide kinds present (${[...kinds].sort().join(", ")})`);
      // the cross-check that makes both halves credible: Troll Dragon -> Pale Moon Casque
      const pmc = Object.entries(isrc.items).find(([, v]) =>
        (v.guide || []).some((g) => /Troll Dragon/.test(g.text)));
      (pmc && (pmc[1].drops || []).some((d) => /TrollDragn/.test(d.enemy)) ? ok : bad)(
        "spot-check: the guide's Troll Dragon drop is also in the decoded tables"); }
    (/s3_item_sources\.json/.test(iso) && /function drawSources/.test(iso) && refMode("sources")
      ? ok : bad)("iso.js registers the Item-sources reference browser");
    // Pickup locations. The per-archive counts are the MAX over chapter variants, never the
    // sum — summing would report one chest per chapter as several chests.
    { const pl = isrc.places || [], ch = isrc.chests || [];
      (pl.length >= 8 && ch.length === 6 ? ok : bad)(
        `pickup places (${pl.length} archives) + guide chests (${ch.length})`);
      (pl.every((p) => p.chest + p.corpse + p.herbs > 0 && p.variants >= 1) ? ok : bad)(
        "every listed archive actually has a pickup");
      const mori = pl.find((p) => p.archive === "MORI");
      (mori && mori.corpse === 1 && mori.herbs === 3 && mori.area === 0x0d ? ok : bad)(
        "pickup spot-check: MORI = area 0x0D, 1 corpse, 3 herbs (matches the walkthrough)");
      (ch.every((c) => c.items.length >= 4 && c.items.every((i) => +i.item >= 1)) ? ok : bad)(
        "every guide chest names at least 4 real items");
      (/function drawPickups/.test(iso) && refMode("places") ? ok : bad)(
        "iso.js registers the Pickups reference browser");
      (/aren't linked/.test(iso) ? ok : bad)(
        "the Pickups view states the disc and guide tables aren't joined"); }
    (/srctag \$\{r\.disc \? "disc" : "guide"\}/.test(iso) ? ok : bad)(
      "every source row is tagged disc vs guide");
    // Rune + skill lookups (Reference view). Both are pure joins over committed guide data, so
    // what can break is the join, not the rendering: a rune family range that stops covering the
    // item list, or a guide name that stops matching the disc's spelling of the same rune.
    { const rf = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_food_desc.json"), "utf8"));
      const ro = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_owner.json"), "utf8"));
      const rs2 = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_rune_slots.json"), "utf8"));
      const sr = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_skill_ref.json"), "utf8"));
      // same id/category parse iso.js does, so a category rename in the id list shows up here
      const items = {}, itemCats = {};
      { let cur = "";
        for (const line of itemsTxt.split(/\r?\n/)) {
          const h = /\*\s*(.+?)\s*\*/.exec(line);
          if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
          const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
          while ((m = re.exec(line))) { const id = parseInt(m[1], 16); items[id] = m[2].trim(); itemCats[id] = cur; } } }
      // the rune families are ID RANGES in iso.js, so they have to keep partitioning the
      // "Runes" category exactly — no rune outside a family, no non-rune inside one
      const groups = [...iso.matchAll(/\["(magic|attack|support)", "[^"]+", (0x[0-9A-Fa-f]+), (0x[0-9A-Fa-f]+),/g)]
        .map((m) => [m[1], parseInt(m[2], 16), parseInt(m[3], 16)]);
      const inGroup = (id) => groups.filter(([, lo, hi]) => id >= lo && id <= hi);
      const runeIds = Object.keys(itemCats).map(Number).filter((id) => itemCats[id] === "Runes");
      (groups.length === 3 && runeIds.every((id) => inGroup(id).length === 1) ? ok : bad)(
        `all ${runeIds.length} runes land in exactly one family (${groups.map(([g, lo, hi]) => `${g} ${lo.toString(16)}..${hi.toString(16)}`).join(", ")})`);
      const strays = groups.flatMap(([, lo, hi]) => {
        const out = []; for (let id = lo; id <= hi; id++) if (itemCats[id] !== "Runes") out.push(id); return out; });
      (strays.length === 0 ? ok : bad)(`no non-rune item falls inside a rune family (${strays.map((x) => x.toString(16)).join(",")})`);
      // every rune has menu text to show, whether or not a disc is open
      const noText = runeIds.filter((id) => !rf[String(id)]);
      (noText.length === 0 ? ok : bad)(`every rune has bundled description text (${runeIds.length} runes)`);
      // "— Grants a, b, c" is how the magic runes name their spells; the browser splits on it
      const grants = runeIds.filter((id) => /—\s*Grants\s+/.test(rf[String(id)] || ""));
      (grants.length >= 20 ? ok : bad)(`${grants.length} runes list the spells they grant`);
      // the join that would silently empty the "who has it" column: the guides spell rune names
      // their own way ("Eight Devil", "Shining wing"), so both files must still match by nameKey
      const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
      const runeKeys = new Set(runeIds.map((id) => key(items[id])));
      const ownMiss = Object.keys(ro).filter((n) => !runeKeys.has(key(n)));
      (ownMiss.length === 0 ? ok : bad)(`all ${Object.keys(ro).length} s3_rune_owner names match a rune item (${ownMiss})`);
      const slotRunes = [...new Set(Object.values(rs2).flatMap((v) =>
        ["head", "right", "left"].map((k) => (v[k] || {}).state === "rune" ? v[k].rune : null).filter(Boolean)))];
      const slotMiss = slotRunes.filter((n) => !runeKeys.has(key(n)));
      (slotMiss.length === 0 ? ok : bad)(`all ${slotRunes.length} runes in s3_rune_slots match a rune item (${slotMiss})`);
      // Skills: the browser's Utility chip and the Support view's fade must name the same set
      const utility = Object.keys(sr).filter((k) => sr[k].type === "Utility").map(Number).sort((a, b) => a - b);
      const gate = /const supportActive = \(id\) => id >= (0x[0-9A-Fa-f]+) && id <= (0x[0-9A-Fa-f]+)/.exec(iso);
      (gate && utility[0] === parseInt(gate[1], 16) && utility[utility.length - 1] === parseInt(gate[2], 16) &&
        utility.length === parseInt(gate[2], 16) - parseInt(gate[1], 16) + 1 ? ok : bad)(
        `"Utility" skills == supportActive()'s range (${utility.length} skills, ${utility[0]}..${utility[utility.length - 1]})`);
      const types = new Set(Object.values(sr).map((s) => s.type));
      ([...types].every((t) => new RegExp(`\\["${t}", "`).test(iso)) ? ok : bad)(
        `every skill type has a filter chip (${[...types].sort().join(", ")})`);
      // every rank shown in the effect table must be a rank the editor can actually set
      const ranks = new Set(Object.values(sr).flatMap((s) => (s.effects || []).flatMap((e) => Object.keys(e.ranks || {}))));
      const rankOpts = new Set([...iso.matchAll(/\[\d, "(E|D|C|B\+?|A\+?|S)"\]/g)].map((m) => m[1]));
      ([...ranks].every((g) => rankOpts.has(g)) ? ok : bad)(`guide ranks are all in RANK_OPTS (${[...ranks].join(" ")})`); }
    (/function drawSkillsRef/.test(iso) && refMode("skills") &&
      refMode("items") && /function drawItemsRef/.test(iso) ? ok : bad)(
      "iso.js registers the Items and Skill reference browsers");
    // Runes left Reference in v1.97.0: renaming a rune and rewriting its menu text are edits,
    // not reference, and nobody could find them buried under a tab whose hint said read-only.
    (/function drawRunes/.test(iso) && /\["runes", "Runes"\]/.test(iso) && !refMode("runes") ? ok : bad)(
      "the Runes browser is a top-level tab, not a Reference sub-tab");
    (/s3_rune_food_desc\.json/.test(iso) && /s3_rune_owner\.json/.test(iso) ? ok : bad)(
      "iso.js loadRef fetches the rune description + owner tables");
    const areas = rm.areas.map((a) => a.area);
      (new Set(areas).size === areas.length ? ok : bad)("every archive has a distinct area id");
      const mori = rm.areas.find((a) => a.archive === "MORI");
      (mori && mori.area === 0x0d && mori.tables[0].rooms.length === 6 &&
        mori.tables[0].rooms.every((r) => r.rate === 4) ? ok : bad)(
        "room spot-check: MORI = area 0x0D, 6 rooms, all rate 4");
      const rates = [...new Set(rooms.map((r) => r.rate))].sort((a, b) => a - b);
      (rates.every((r) => r >= 0 && r <= 9) ? ok : bad)(`room rates stay in 0..9 (${rates})`); }
    const wr = JSON.parse(fs.readFileSync(path.join(REPO, "Editor", "s3_war_ref.json"), "utf8"));
    (wr.army && wr.support && wr.skills && Object.keys(wr.army).length >= 40 ? ok : bad)(
      `s3_war_ref.json parses (${Object.keys(wr.army).length} army units, ${Object.keys(wr.support).length} support)`);
    (/REF\.warRef/.test(iso) ? ok : bad)("iso.js War tab renders the army-skill reference");
  } catch (e) { bad("s3_enemy_packs.json / s3_war_units.json — " + e.message); }
}

// 8) In-ELF text heuristic. There is no index of strings in the ELF — the editor FINDS them
// with this filter, so a drift in the rules changes which strings it offers on a given disc
// (and can start offering a format string the user is able to corrupt). The rules used to be
// asserted against a second copy in the desktop editor; that copy is gone, so pin the literals
// here instead — text-core.js is the only implementation now.
console.log("In-ELF text heuristic:");
{
  const T = (await import("../text-core.js")).default ||
    (await import("module")).createRequire(import.meta.url)(path.join(WEB, "text-core.js"));

  (T.MIN_LEN === 8 ? ok : bad)(`min run length ${T.MIN_LEN} (want 8)`);
  (T.PROSE_RATIO === 0.9 ? ok : bad)(`prose ratio ${T.PROSE_RATIO} (want 0.9)`);
  (T.PROSE_PUNCT === " ,.'!?-@()" ? ok : bad)(`prose punctuation ${JSON.stringify(T.PROSE_PUNCT)}`);
  (T.REJECT.source === "[%$/\\\\]|0x|->|::|_|[A-Za-z]\\d|\\d[A-Za-z]" ? ok : bad)(
    `reject pattern ${T.REJECT.source}`);

  // behaviour, not just the constants: prose in, identifiers/format strings out
  for (const good of ["Hugo the hero", "Restores all HP.", "A sturdy shield."])
    (T.looksLikeText(good) ? ok : bad)(`accepts ${JSON.stringify(good)}`);
  for (const bad_ of ["%s has fallen", "short", "0x1234 addr", "get_item_name", "PLAYER1 wins"])
    (T.looksLikeText(bad_) ? bad : ok)(`rejects ${JSON.stringify(bad_)}`);

  const iso = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");
  (/TextCore\.scanStrings\(ORIG, ELF_BASE\)/.test(iso) ? ok : bad)("iso.js scans ORIG (stable slot lengths), not BUF");
  (/\["text", "Text"\]/.test(iso) ? ok : bad)("iso.js registers the Text view");
  // The Runes browser stopped being read-only in v1.58.0 — it owns the rune's menu text and
  // its status effect, and is the ONLY place either can be edited. Its hint went on claiming
  // "Reference (read-only)" for 36 releases, which is a real reason someone would never look
  // there for the one field that fixes a rune description. Pin the correction.
  const runesHint = /\n\s*runes: "([^"]*)"/.exec(iso);
  (runesHint && !/read-only\)/.test(runesHint[1]) ? ok : bad)("the Runes tab is not advertised as read-only");
  (runesHint && /rename it/.test(runesHint[1]) ? ok : bad)("the Runes tab hint says a rune can be renamed");
  // A rune name and its description are each written in place through setDescText, which
  // mirrors every copy. Both fields have to exist or half the surface is unreachable again.
  (/input type="text" class="rname"/.test(iso) ? ok : bad)("the Runes tab renders a rename field");
  (/input type="text" class="rdesc"/.test(iso) ? ok : bad)("the Runes tab renders a menu-text field");
  (/qa\("input\.rname"/.test(iso) ? ok : bad)("the rename field is wired to a write");
  // Same failure mode, five times over: a tab's hint outlived what the tab does. The Encounter
  // hint said per-area base rates "aren't editable" for the 20 releases after they became
  // editable; the Passives hint still described the whole-party, two-rune, drop-the-call version
  // after the tab had gone per-character across 22 runes with Fortune and Prosperity on their own
  // switch; and Enemies, Sets and Food each named a fraction of their tab — no spawn formations,
  // no effect ownership, no rename. None of the last three was WRONG, which is why they survived
  // so long: a hint that undersells its tab hides a feature just as well as one that denies it.
  // A hint is the only description most people read, so pin every correction — and pin the caveat
  // each one exists to carry, since that is the part a rewrite tends to drop.
  const encHint = /\n\s*encounter: "([^"]*)"/.exec(iso);
  (encHint && !/aren't editable/.test(encHint[1]) ? ok : bad)("the Encounter hint no longer says per-area rates aren't editable");
  (encHint && /[Pp]er-area base rates are editable/.test(encHint[1]) ? ok : bad)("the Encounter hint says per-area base rates are editable");
  (encHint && /RAISING ONE FROM 0 IS NOT/.test(encHint[1]) ? ok : bad)("the Encounter hint keeps the raising-from-0 caveat");
  const psHint = /\n\s*passives: "([^"]*)"/.exec(iso);
  (psHint && !/cannot be forced/.test(psHint[1]) ? ok : bad)("the Passives hint no longer says Fortune cannot be forced");
  (psHint && !/CONFIRMED IN PLAY/.test(psHint[1]) ? ok : bad)("the Passives hint claims no play confirmation under this patch shape");
  (psHint && /THE CHARACTERS YOU\s+CHOOSE/.test(psHint[1]) ? ok : bad)("the Passives hint says a passive goes to chosen characters");
  (psHint && /OFF ENEMIES/.test(psHint[1]) ? ok : bad)("the Passives hint keeps the off-enemies guarantee");
  const enHint = /\n\s*enemies: "([^"]*)"/.exec(iso);
  (enHint && /SPAWNS AND FORMATIONS/.test(enHint[1]) ? ok : bad)("the Enemies hint names the spawns + formations editor");
  (enHint && /CRASH THE GAME/.test(enHint[1]) ? ok : bad)("the Enemies hint keeps the off-roster-monster caveat");
  (enHint && /bulk multipliers/i.test(enHint[1]) ? ok : bad)("the Enemies hint names the bulk multipliers");
  const setsHint = /\n\s*sets: "([^"]*)"/.exec(iso);
  (setsHint && /EFFECT OWNERSHIP/.test(setsHint[1]) ? ok : bad)("the Sets hint names the effect-ownership controls");
  (setsHint && /cannot be added, only moved/.test(setsHint[1]) ? ok : bad)("the Sets hint keeps the no-new-effects caveat");
  (setsHint && /COMPOUNDS per member/.test(setsHint[1]) ? ok : bad)("the Sets hint says the forced potch bonus compounds");
  const foodHint = /\n\s*food: "([^"]*)"/.exec(iso);
  (foodHint && /renaming the dish/.test(foodHint[1]) ? ok : bad)("the Food hint says a dish can be renamed");
  (foodHint && /IN PLACE/.test(foodHint[1]) ? ok : bad)("the Food hint keeps the written-in-place length cap");
}

console.log(failures ? `\nFAILED (${failures})` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
