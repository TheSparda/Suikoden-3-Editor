#!/usr/bin/env node
// Suikoden III Editor MCP server (stdio, no dependencies).
//
// Design: this server contains no editing logic of its own.
//  - ISO side: table and patch constants are sliced out of web/iso.js at startup,
//    exactly the way the repo's Node tests slice them (web/tests/*.mjs), and the
//    Changes audit and .xdelta export run the repo's own web/changes-core.js and
//    web/vcdiff.js, loaded the same way the tests load them.
//  - Save side: every operation is delegated to Editor/s3save.py (the module the
//    web save editor runs under Pyodide) through mcp/save_bridge.py.
//
// Working-copy rule: opening a file copies it into this server's work directory.
// All edits land on the copy or on staged state; outputs are written only to
// caller-chosen paths. The path a file was opened from is never written.
//
// Disabled features stay disabled: the attack-rune spell lists global patch
// (ATKLIST, Option B) offsets are fenced off from every write route, and
// Trinity Sight is exposed read-only only.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const WEB = path.join(REPO, "web");
const WORK = path.join(HERE, ".work");
fs.mkdirSync(WORK, { recursive: true });

// ---------------------------------------------------------------------------
// Load the repo's own pure-logic cores the way its tests do.
// ---------------------------------------------------------------------------
const g = globalThis;
for (const f of ["changes-core.js", "vcdiff.js"]) {
  new Function(fs.readFileSync(path.join(WEB, f), "utf8")).call(g);
}
const ChangesCore = g.ChangesCore;
const Vcdiff = g.Vcdiff;
if (!ChangesCore || !Vcdiff) throw new Error("could not load web core modules (changes-core.js / vcdiff.js)");

const isoSrc = fs.readFileSync(path.join(WEB, "iso.js"), "utf8");

// Slice a `const NAME = <literal>;` definition out of iso.js and evaluate the
// literal. This is the repo tests' own technique (see web/tests/mp-charges-real-iso.mjs):
// constants are never re-typed here, so they cannot drift from the shipped editor.
function sliceConst(name) {
  const m = new RegExp(`const ${name} = `).exec(isoSrc);
  if (!m) throw new Error(`could not find const ${name} in web/iso.js`);
  let i = m.index + m[0].length;
  const start = i;
  let depth = 0, inStr = null;
  for (; i < isoSrc.length; i++) {
    const c = isoSrc[i];
    if (inStr) { if (c === inStr && isoSrc[i - 1] !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    if (c === "]" || c === "}" || c === ")") depth--;
    if (depth === 0 && c === ";") break;
  }
  const literal = isoSrc.slice(start, i);
  return new Function(`return (${literal});`)();
}
function sliceNum(name) {
  const m = new RegExp(`const ${name} = (0x[0-9A-Fa-f]+|\\d+)`).exec(isoSrc);
  if (!m) throw new Error(`could not find const ${name} in web/iso.js`);
  return parseInt(m[1]);
}

const ELF_BASE = sliceNum("ELF_BASE");
const ELF_VADDR = sliceNum("ELF_VADDR");
const VERSION_OFF = sliceNum("VERSION_OFF");
const VERSION_VAL = sliceNum("VERSION_VAL");
const ELF_END = (() => { const m = /const ELF_LEN = (0x[0-9A-Fa-f]+) - (0x[0-9A-Fa-f]+)/.exec(isoSrc); return parseInt(m[1]); })();
const ELF_LEN = ELF_END - ELF_BASE;

const SPELL = sliceConst("SPELL"), UNITE = sliceConst("UNITE"), FOOD = sliceConst("FOOD");
const RUNE_TBL = sliceConst("RUNE_TBL"), ENEMY = sliceConst("ENEMY"), SKILLFX = sliceConst("SKILLFX");
const TABLES = sliceConst("TABLES"), LIST_COUNT = sliceConst("LIST_COUNT");
const VIEWS = sliceConst("VIEWS");

// Field maps for the two record views whose maps live in iso.js as MAP / UMAP.
function sliceFieldMap(varName, scope) {
  const m = new RegExp(`const ${varName} = \\{([\\s\\S]*?)\\};`).exec(isoSrc);
  if (!m) throw new Error(`could not find ${varName} in web/iso.js`);
  const out = {};
  for (const e of m[1].matchAll(/(\w+): \[([^\]]+)\]/g)) {
    const parts = e[2].split(",").map((s) => s.trim());
    const off = new Function(...Object.keys(scope), `return (${parts[0]});`)(...Object.values(scope));
    out[e[1]] = { rel: off, width: parseInt(parts[1]), kind: parts[2].replace(/"/g, "") };
  }
  return out;
}
const SPELL_FIELDS = sliceFieldMap("MAP", { SPELL });
const UNITE_FIELDS = sliceFieldMap("UMAP", { UNITE });

// Enabled code patches (Test tab). ATKLIST is sliced only so its offsets can be
// fenced off; it is never exposed as an applicable patch.
const PATCH_SETS = {
  unlimited_casts_tier1: { label: "Unlimited rune casts (Tier 1)", words: sliceConst("MPCAST_T1") },
  unlimited_casts_tier2: { label: "Unlimited rune casts (Tier 2)", words: sliceConst("MPCAST_T2") },
  free_training: { label: "Free skill training", words: sliceConst("QOL_TRAIN") },
  free_sharpening: { label: "Free sharpening", words: sliceConst("QOL_FORGE") },
  smith_cap_removed: { label: "Sharpening level cap removed", words: sliceConst("QOL_SMITHCAP") },
};
const ATKLIST = sliceConst("ATKLIST");
const atkBlockedAt = (off) => ATKLIST.some((c) => off >= c.off && off < c.off + 4);

// Table-backed views exposed for record discovery/editing.
const TABLE_VIEWS = {
  spells: { label: "Spells", table: SPELL, fields: SPELL_FIELDS, namePtr: 0x08 },
  unites: { label: "Unites", table: UNITE, fields: UNITE_FIELDS, namePtr: 0x08 },
  runes: {
    label: "Runes (by item id)", table: RUNE_TBL, namePtr: RUNE_TBL.name, idBase: RUNE_TBL.lo, count: RUNE_TBL.hi - RUNE_TBL.lo + 1,
    fields: {
      price: { rel: RUNE_TBL.price, width: 4, kind: "num" },
      slotMask: { rel: RUNE_TBL.slotMask, width: 2, kind: "num" },
      element: { rel: RUNE_TBL.elem, width: 2, kind: "num" },
      category: { rel: RUNE_TBL.cat, width: 2, kind: "num" },
      spell1: { rel: RUNE_TBL.spells, width: 2, kind: "num" },
      spell2: { rel: RUNE_TBL.spells + 2, width: 2, kind: "num" },
      spell3: { rel: RUNE_TBL.spells + 4, width: 2, kind: "num" },
      spell4: { rel: RUNE_TBL.spells + 6, width: 2, kind: "num" },
    },
  },
  enemies: { label: "Enemies (names only on disc)", table: ENEMY, fields: {}, namePtr: 0x00 },
  skillfx: {
    label: "Skill effects", table: SKILLFX, fields: {
      a: { rel: SKILLFX.a, width: 4, kind: "num" }, b: { rel: SKILLFX.b, width: 4, kind: "num" },
    }, namePtr: null,
  },
  characters: {
    label: "Characters (list1 growth records)", table: { off: TABLES.list1[0], stride: TABLES.list1[1], count: LIST_COUNT.list1 },
    fields: {}, namePtr: null, rawRecord: true,
  },
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
function shaFile(p) { // streaming: a real ISO is 4 GB, over the single-Buffer limit
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(p, "r");
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) h.update(chunk.subarray(0, n));
  fs.closeSync(fd);
  return h.digest("hex");
}
let iso = null;   // {name, sourcePath, sourceHash, size, orig:Buffer, buf:Buffer, staged:Map<rel, {before, after, via}>}
let save = null;  // {name, sourcePath, sourceHash, format, saves:[...], staged:{...}, folder}

function fail(msg) { const e = new Error(msg); e.isToolError = true; throw e; }
function inBlk(off, n) { return off >= ELF_BASE && off + n <= ELF_END; }

function isoRead(off, w) {
  const rel = off - ELF_BASE;
  return w === 1 ? iso.buf[rel] : w === 2 ? iso.buf.readUInt16LE(rel) : iso.buf.readUInt32LE(rel) >>> 0;
}
function isoStage(off, w, value, via) {
  if (!inBlk(off, w)) fail(`offset 0x${off.toString(16)} is outside the editable disc region`);
  for (let i = 0; i < w; i++) if (atkBlockedAt(off + i))
    fail("That address belongs to the attack-rune spell lists patch (Option B), which is disabled in the editor. It cannot be applied through MCP either. Use the per-rune spell-list control (iso_rune_set_spell_list) instead.");
  const rel = off - ELF_BASE;
  const tmp = Buffer.alloc(4);
  if (w === 1) tmp.writeUInt8(value & 0xFF);
  else if (w === 2) tmp.writeUInt16LE(value & 0xFFFF);
  else tmp.writeUInt32LE(value >>> 0);
  for (let i = 0; i < w; i++) {
    const r = rel + i;
    if (!iso.staged.has(r)) iso.staged.set(r, { before: iso.orig[r], via });
    iso.buf[r] = tmp[i];
    const s = iso.staged.get(r);
    s.after = tmp[i];
    if (s.before === s.after) iso.staged.delete(r);
  }
}
function isoRuns() {
  // Group staged bytes into runs against the original, via the repo's ChangesCore.
  const changed = new Uint8Array(ELF_LEN);
  // ChangesCore.runs diffs two whole blocks; build the diff cheaply from staged bytes.
  const cur = new Uint8Array(ELF_LEN), orig = new Uint8Array(ELF_LEN);
  // Only the ELF block is held in memory (it is the whole editable region).
  cur.set(iso.buf); orig.set(iso.orig);
  return ChangesCore.runs(orig, cur, ELF_BASE);
}
function strAt(vaddr) {
  const rel = vaddr - ELF_VADDR;
  if (rel < 0 || rel >= iso.buf.length) return "";
  let e = iso.buf.indexOf(0, rel); if (e < 0) e = Math.min(rel + 64, iso.buf.length);
  return iso.buf.subarray(rel, e).toString("latin1");
}
function recordName(view, index) {
  const t = TABLE_VIEWS[view];
  if (t.namePtr == null) return null;
  const off = t.table.off + index * t.table.stride + t.namePtr;
  if (!inBlk(off, 4)) return null;
  const ptr = isoRead(off, 4);
  return strAt(ptr) || null;
}

// ---------------------------------------------------------------------------
// Save bridge (s3save.py)
// ---------------------------------------------------------------------------
function bridge(req) {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [path.join(HERE, "save_bridge.py")], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => reject(new Error(`could not start python3 for the save bridge: ${e.message}`)));
    p.on("close", () => {
      try {
        const r = JSON.parse(out.trim().split("\n").pop());
        if (r.ok) resolve(r.result);
        else reject(new Error(r.error || "save bridge failed"));
      } catch { reject(new Error(`save bridge returned unreadable output${err ? `: ${err.slice(0, 300)}` : ""}`)); }
    });
    p.stdin.end(JSON.stringify(req));
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const tools = [];
function tool(name, description, properties, required, fn) {
  tools.push({ name, description, inputSchema: { type: "object", properties, required: required || [] }, fn });
}
const S = (type, desc, extra = {}) => ({ type, description: desc, ...extra });

tool("iso_open", "Open a Suikoden III (USA) ISO. The file is copied to a working location and only its editable region is loaded; the source file is never written. Returns disc identity and the source hash.",
  { path: S("string", "Path to the ISO on this machine") }, ["path"], async ({ path: p }) => {
    if (!fs.existsSync(p)) fail(`no file at ${p}`);
    const fd = fs.openSync(p, "r");
    const size = fs.fstatSync(fd).size;
    if (size < ELF_END) { fs.closeSync(fd); fail(`that file is only ${size} bytes, not a full Suikoden III ISO`); }
    const block = Buffer.alloc(ELF_LEN);
    fs.readSync(fd, block, 0, ELF_LEN, ELF_BASE);
    fs.closeSync(fd);
    const ver = block.readUInt32BE(VERSION_OFF - ELF_BASE);
    if (ver !== VERSION_VAL) fail(`not a USA (SLUS-20387) Suikoden III ISO: version word 0x${ver.toString(16)} does not match 0x${VERSION_VAL.toString(16)}`);
    const srcHash = shaFile(p);
    fs.writeFileSync(path.join(WORK, "iso.work"), block);
    iso = { name: path.basename(p), sourcePath: p, sourceHash: srcHash, size, orig: Buffer.from(block), buf: Buffer.from(block), staged: new Map() };
    return { opened: iso.name, size, region: "USA SLUS-20387 verified", sourceSha256: srcHash, note: "Edits stage in memory and on the working copy only. The source file will not be written." };
  });

tool("iso_list_views", "List the editor's 23 ISO views (from web/iso.js) and mark which ones this server exposes for record-level editing.", {}, [], async () => ({
  views: VIEWS.map(([id, label]) => ({ id, label, recordEditing: id in TABLE_VIEWS || id === "test" || id === "changes" })),
  recordViews: Object.keys(TABLE_VIEWS),
}));

tool("iso_describe_view", "Describe a record view: its table location and editable fields, as defined in web/iso.js.",
  { view: S("string", "View id from iso_list_views") }, ["view"], async ({ view }) => {
    const t = TABLE_VIEWS[view];
    if (!t) fail(`view '${view}' has no record table exposed through MCP. Record views: ${Object.keys(TABLE_VIEWS).join(", ")}. Any offset in the editable region can still be read and staged with iso_read_word and iso_stage_word.`);
    return { view, label: t.label, table: { offset: "0x" + t.table.off.toString(16), stride: t.table.stride, count: t.count ?? t.table.count }, fields: t.fields };
  });

tool("iso_list_records", "List records of a table view (index, name where the disc stores one, and field values).",
  { view: S("string", "Record view id"), offset: S("integer", "First index (default 0)"), limit: S("integer", "Max records (default 50)") }, ["view"], async ({ view, offset = 0, limit = 50 }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    const t = TABLE_VIEWS[view]; if (!t) fail(`unknown record view '${view}'`);
    const count = t.count ?? t.table.count;
    const rows = [];
    for (let i = offset; i < Math.min(count, offset + limit); i++) {
      const base = t.table.off + i * t.table.stride;
      const rec = { index: i, id: t.idBase ? t.idBase + i : i, name: recordName(view, i), fields: {} };
      for (const [k, f] of Object.entries(t.fields)) rec.fields[k] = isoRead(base + f.rel, f.width);
      if (t.rawRecord) rec.bytes = [...iso.buf.subarray(base - ELF_BASE, base - ELF_BASE + t.table.stride)];
      rows.push(rec);
    }
    return { view, total: count, records: rows };
  });

tool("iso_get_field", "Read one field of one record in a table view (staged value if edited, else the disc value).",
  { view: S("string", "Record view id"), index: S("integer", "Record index"), field: S("string", "Field name from iso_describe_view") }, ["view", "index", "field"], async ({ view, index, field }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    const t = TABLE_VIEWS[view]; if (!t) fail(`unknown record view '${view}'`);
    const f = t.fields[field]; if (!f) fail(`view '${view}' has no field '${field}'. Fields: ${Object.keys(t.fields).join(", ") || "(none, use iso_read_word)"}`);
    const off = t.table.off + index * t.table.stride + f.rel;
    return { view, index, field, value: isoRead(off, f.width), offset: "0x" + off.toString(16), staged: iso.staged.has(off - ELF_BASE) };
  });

tool("iso_set_field", "Stage one field edit on a record. Nothing is written to any file until iso_export_iso, iso_export_recipe or iso_export_xdelta is called.",
  { view: S("string", "Record view id"), index: S("integer", "Record index"), field: S("string", "Field name"), value: S("integer", "New value (clamped to the field width)") }, ["view", "index", "field", "value"], async ({ view, index, field, value }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    const t = TABLE_VIEWS[view]; if (!t) fail(`unknown record view '${view}'`);
    const f = t.fields[field]; if (!f) fail(`view '${view}' has no field '${field}'`);
    const count = t.count ?? t.table.count;
    if (index < 0 || index >= count) fail(`index ${index} is out of range for '${view}' (0..${count - 1})`);
    if (!Number.isFinite(value)) fail("value must be a number");
    const off = t.table.off + index * t.table.stride + f.rel;
    isoStage(off, f.width, Math.round(value), `${view}[${index}].${field}`);
    return { staged: true, view, index, field, value: isoRead(off, f.width), stagedBytes: iso.staged.size };
  });

tool("iso_read_word", "Read a raw 1, 2 or 4 byte value at an absolute ISO offset inside the editable region.",
  { offset: S("integer", "Absolute ISO offset"), width: S("integer", "1, 2 or 4 (default 4)") }, ["offset"], async ({ offset, width = 4 }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    if (!inBlk(offset, width)) fail(`offset 0x${offset.toString(16)} is outside the editable disc region`);
    return { offset: "0x" + offset.toString(16), width, value: isoRead(offset, width), original: (() => { const rel = offset - ELF_BASE; return width === 1 ? iso.orig[rel] : width === 2 ? iso.orig.readUInt16LE(rel) : iso.orig.readUInt32LE(rel) >>> 0; })() };
  });

tool("iso_stage_word", "Stage a raw word edit at an absolute ISO offset. Refused for the disabled attack-rune lists patch offsets and anything outside the editable region.",
  { offset: S("integer", "Absolute ISO offset"), width: S("integer", "1, 2 or 4"), value: S("integer", "New value") }, ["offset", "width", "value"], async ({ offset, width, value }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    if (![1, 2, 4].includes(width)) fail("width must be 1, 2 or 4");
    isoStage(offset, width, value >>> 0, "raw");
    return { staged: true, offset: "0x" + offset.toString(16), stagedBytes: iso.staged.size };
  });

tool("iso_list_patches", "List the enabled Test-tab code patches and their current state on the open disc (stock, on, or unknown). The disabled attack-rune lists patch is not listed and cannot be applied.",
  {}, [], async () => {
    if (!iso) fail("no ISO is open; call iso_open first");
    return { patches: Object.entries(PATCH_SETS).map(([id, p]) => {
      const cur = p.words.map((c) => isoRead(c.off, 4));
      const state = cur.every((v, i) => v === p.words[i].stock) ? "stock" : cur.every((v, i) => v === p.words[i].patch) ? "on" : "unknown";
      return { id, label: p.label, state, sites: p.words.map((c) => ({ offset: "0x" + c.off.toString(16), what: c.what })) };
    }) };
  });

tool("iso_set_patch", "Stage an enabled code patch on or off (on writes the patch words, off restores the stock words). Refuses the disabled attack-rune lists patch by name.",
  { patch: S("string", "Patch id from iso_list_patches"), on: S("boolean", "true to apply, false to restore stock") }, ["patch", "on"], async ({ patch, on }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    if (/atk|attack.?rune|option.?b/i.test(patch)) fail("The attack-rune spell lists global patch (Option B) is disabled in the editor after play testing showed it does not work. It is not available through MCP. Use iso_rune_set_spell_list for the per-rune form, which works.");
    const p = PATCH_SETS[patch]; if (!p) fail(`unknown patch '${patch}'. Enabled patches: ${Object.keys(PATCH_SETS).join(", ")}`);
    for (const c of p.words) isoStage(c.off, 4, on ? c.patch : c.stock, p.label);
    return { staged: true, patch, on, stagedBytes: iso.staged.size };
  });

tool("iso_rune_set_spell_list", "The per-rune spell-list control (Option A, the working form): set a rune's four spell slots, set its type to Magic / support (category 0), and set its element family. Element defaults to the element of the first filled spell, as the web control does.",
  { itemId: S("integer", "Rune item id (317..462)"), spells: S("array", "Up to four 1-based spell ids, 0 for an empty slot", { items: { type: "integer" } }), element: S("integer", "Element family override (optional)") }, ["itemId", "spells"], async ({ itemId, spells, element }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    if (itemId < RUNE_TBL.lo || itemId > RUNE_TBL.hi) fail(`item id ${itemId} is not a rune (runes are ${RUNE_TBL.lo}..${RUNE_TBL.hi})`);
    const idx = itemId - RUNE_TBL.lo, base = RUNE_TBL.off + idx * RUNE_TBL.stride;
    const slots = [0, 0, 0, 0];
    (spells || []).slice(0, 4).forEach((s, i) => (slots[i] = s | 0));
    let elem = element;
    if (elem == null) {
      const first = slots.find((s) => s > 0);
      if (first) elem = isoRead(SPELL.off + (first - 1) * SPELL.stride + SPELL.elem, 2) & 0xFF;
    }
    slots.forEach((s, i) => isoStage(base + RUNE_TBL.spells + i * 2, 2, s, `rune ${itemId} spell slot ${i + 1}`));
    isoStage(base + RUNE_TBL.cat, 2, 0, `rune ${itemId} type (Magic / support)`);
    if (elem != null) isoStage(base + RUNE_TBL.elem, 2, elem, `rune ${itemId} element family`);
    return { staged: true, itemId, spells: slots, category: 0, element: elem ?? null, note: "Per-rune form only. The global form of this patch is disabled and is not offered." };
  });

tool("iso_list_changes", "List every staged ISO change as byte runs joined to the editor's field registry regions (the Changes audit model, via web/changes-core.js).",
  {}, [], async () => {
    if (!iso) fail("no ISO is open; call iso_open first");
    const runs = isoRuns();
    return { stagedBytes: iso.staged.size, runs: runs.map((r) => ({ offset: "0x" + r.off.toString(16), length: r.len })), totalChangedBytes: ChangesCore.runBytes(runs) };
  });

tool("iso_discard_changes", "Discard all staged ISO edits and restore the working copy to the opened disc state.", {}, [], async () => {
    if (!iso) fail("no ISO is open; call iso_open first");
    iso.buf = Buffer.from(iso.orig); iso.staged.clear();
    return { discarded: true };
  });

function guardOutputPath(p) {
  if (iso && path.resolve(p) === path.resolve(iso.sourcePath)) fail("refusing to write over the file the ISO was opened from. Choose a different output path.");
  if (save && path.resolve(p) === path.resolve(save.sourcePath)) fail("refusing to write over the file the save was opened from. Choose a different output path.");
}

tool("iso_export_iso", "Write a full patched ISO copy (the whole source file with the editable region replaced by the staged state) to a caller-chosen path. The opened source is never the target.",
  { outPath: S("string", "Where to write the patched ISO") }, ["outPath"], async ({ outPath }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    guardOutputPath(outPath);
    fs.copyFileSync(iso.sourcePath, outPath);
    const fd = fs.openSync(outPath, "r+");
    fs.writeSync(fd, iso.buf, 0, ELF_LEN, ELF_BASE);
    fs.closeSync(fd);
    return { written: outPath, stagedBytes: iso.staged.size, sha256: shaFile(outPath) };
  });

tool("iso_export_recipe", "Export the staged changes as a recipe JSON file (offset plus new bytes per run), the same shape the web editor's recipe export carries.",
  { outPath: S("string", "Where to write the recipe JSON") }, ["outPath"], async ({ outPath }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    guardOutputPath(outPath);
    const runs = isoRuns();
    const recipe = { game: "Suikoden III (USA) SLUS-20387", sourceSha256: iso.sourceHash, edits: runs.map((r) => ({ off: r.off, data: [...iso.buf.subarray(r.off - ELF_BASE, r.off - ELF_BASE + r.len)] })) };
    fs.writeFileSync(outPath, JSON.stringify(recipe, null, 2));
    return { written: outPath, edits: recipe.edits.length, totalChangedBytes: ChangesCore.runBytes(runs) };
  });

tool("iso_export_xdelta", "Export the staged changes as a standard VCDIFF (.xdelta) patch against the opened disc, built by the repo's own web/vcdiff.js.",
  { outPath: S("string", "Where to write the .xdelta patch") }, ["outPath"], async ({ outPath }) => {
    if (!iso) fail("no ISO is open; call iso_open first");
    guardOutputPath(outPath);
    const runs = isoRuns();
    const edits = runs.map((r) => ({ off: r.off, data: new Uint8Array(iso.buf.subarray(r.off - ELF_BASE, r.off - ELF_BASE + r.len)) }));
    const patch = Vcdiff.buildXdelta(iso.size, edits);
    fs.writeFileSync(outPath, patch);
    return { written: outPath, patchBytes: patch.length, edits: edits.length };
  });

// ---------------------------------------------------------------------------
// Save tools (all logic in Editor/s3save.py via the bridge)
// ---------------------------------------------------------------------------
tool("save_open", "Open a memory-card image (.ps2), a .psu export, or a raw gamedata save. Decodes every Suikoden III save it contains through s3save. The source is copied to a working location and never written.",
  { path: S("string", "Path to the card or save file"), index: S("integer", "Which save in the file to edit (default 0)") }, ["path"], async ({ path: p, index = 0 }) => {
    if (!fs.existsSync(p)) fail(`no file at ${p}`);
    const work = path.join(WORK, "save.work");
    fs.copyFileSync(p, work);
    const dec = await bridge({ cmd: "decode", path: work });
    if (!dec.saves.length) fail("no Suikoden III save found in that file");
    if (index < 0 || index >= dec.saves.length) fail(`save index ${index} out of range; the file holds ${dec.saves.length} save(s)`);
    const chosen = dec.saves[index];
    save = { name: path.basename(p), sourcePath: p, sourceHash: shaFile(p), format: dec.format, saves: dec.saves, index, folder: chosen.folder || null, staged: {} };
    return { opened: save.name, format: dec.format, saveCount: dec.saves.length, chosen: { index, label: chosen.label || null, folder: save.folder, gold: chosen.global?.gold, characters: chosen.characters?.length, problems: chosen.problems } };
  });

tool("save_get", "Read the decoded state of the opened save: globals, party, inventory, characters, and the Trinity Sight recorded state (read-only).",
  { section: S("string", "One of: summary, characters, inventory, party, trinity, names (default summary)") }, [], async ({ section = "summary" }) => {
    if (!save) fail("no save is open; call save_open first");
    const dec = await bridge({ cmd: "decode", path: path.join(WORK, "save.work") });
    const s = dec.saves[save.index];
    save.saves = dec.saves;
    if (section === "characters") return { characters: s.characters };
    if (section === "inventory") return { inventory: s.inventory };
    if (section === "party") return { party: s.party, partyMounts: s.partyMounts, formation: s.formation };
    if (section === "trinity") return { trinity: s.trinity, note: "Read-only. The game rebuilds chapter availability from story progress when a save loads, so Trinity Sight unlock and stage writes are not offered." };
    if (section === "names") return { names: s.names };
    return { global: s.global, names: s.names, party: s.party, characterCount: s.characters.length, inventoryCount: s.inventory.length, problems: s.problems, notes: s.notes, stagedEdits: save.staged };
  });

tool("save_stage_character", "Stage character edits for one roster index: scalar fields (level, weaponLv, curHP, maxHP, expToNext), stats, skills, equip, and rune spell charges. Applied by s3save with its own clamping when save_export is called.",
  { rosterIndex: S("integer", "Roster index of the character"), edits: S("object", "Edit object in s3save's shape: {level, weaponLv, curHP, maxHP, expToNext, stats:{PWR:...}, skills:{slot:{id, rank}}, equip:{slotName: itemId}, charges:{cur:{slot: n}, max:{slot: n}}}") }, ["rosterIndex", "edits"], async ({ rosterIndex, edits }) => {
    if (!save) fail("no save is open; call save_open first");
    save.staged.characters = save.staged.characters || {};
    save.staged.characters[rosterIndex] = { ...(save.staged.characters[rosterIndex] || {}), ...edits };
    return { staged: true, rosterIndex, stagedSections: Object.keys(save.staged) };
  });

tool("save_stage_misc", "Stage non-character save edits: gold, leader, party composition, party mounts, recruits (the 108 Stars worklist state), inventory slots, name fields, and carryover flags. Trinity Sight is not accepted here or anywhere: it is read-only.",
  { edits: S("object", "{gold, leader, party:{slot: charId}, partyMounts:{slot: modelId}, recruits:{rosterIndex: bool or {recruited, recruiter}}, inventory:{slot:{id, qty}}, names:{key: text}, carryover:{s1, s2}}") }, ["edits"], async ({ edits }) => {
    if (!save) fail("no save is open; call save_open first");
    if (edits && ("trinity" in edits)) fail("Trinity Sight is read-only in the editor: the game rebuilds chapter availability from story progress on load, so unlock and stage writes do not take effect and are not offered through MCP.");
    for (const k of ["gold", "leader", "party", "partyMounts", "recruits", "inventory", "names", "carryover"]) {
      if (edits && k in edits) save.staged[k] = edits[k];
    }
    return { staged: true, stagedSections: Object.keys(save.staged) };
  });

tool("save_list_changes", "Show everything staged for the opened save, in s3save's edit shape. Nothing has been written to any file yet.", {}, [], async () => {
    if (!save) fail("no save is open; call save_open first");
    return { staged: save.staged };
  });

tool("save_discard_changes", "Discard all staged save edits.", {}, [], async () => {
    if (!save) fail("no save is open; call save_open first");
    save.staged = {};
    return { discarded: true };
  });

tool("save_export", "Apply the staged edits through s3save (checksum and card ECC handled by the core) and write the result to a caller-chosen output path. The opened source is never the target.",
  { outPath: S("string", "Where to write the modified card or save") }, ["outPath"], async ({ outPath }) => {
    if (!save) fail("no save is open; call save_open first");
    guardOutputPath(outPath);
    fs.copyFileSync(save.sourcePath, outPath);
    const res = await bridge({ cmd: "apply", path: outPath, folder: save.folder, edits: save.staged });
    if (res && res.result && res.result.error) fail(`s3save refused the write: ${res.result.error}`);
    return { written: outPath, result: res.result ?? res, sha256: shaFile(outPath) };
  });

// ---------------------------------------------------------------------------
// MCP stdio transport (JSON-RPC 2.0, newline-delimited)
// ---------------------------------------------------------------------------
const PROTOCOL = "2024-11-05";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === "initialize") {
      send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "suikoden-3-editor", version: "1.0.0" } } });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    } else if (method === "tools/call") {
      const t = tools.find((x) => x.name === params?.name);
      if (!t) { send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `unknown tool '${params?.name}'` }] } }); return; }
      try {
        const r = await t.fn(params.arguments || {});
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] } });
      } catch (e) {
        send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] } });
      }
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: `internal error: ${e.message}` } });
  }
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { /* ignore malformed lines */ } }
  }
});
