#!/usr/bin/env node
// Test harness for the Suikoden III Editor MCP server.
// Speaks to the server as a real MCP client (JSON-RPC 2.0 over stdio) and drives
// it against synthetic fixtures: the ISO fixture from web/tests/synth-iso.mjs and
// a synthetic gamedata save built by mcp/save_bridge.py (which uses s3save).
// Run: node mcp/test.mjs   (exit 0 = all checks passed)
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "s3mcp-"));
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

let fails = 0, total = 0;
const check = (name, cond, extra = "") => { total++; console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`); if (!cond) fails++; };

// ---- fixtures ---------------------------------------------------------------
const { buildSynthIso } = await import(path.join(REPO, "web", "tests", "synth-iso.mjs"));
const synthIsoPath = path.join(TMP, "synth.iso");
fs.writeFileSync(synthIsoPath, buildSynthIso().bytes);
const synthSavePath = path.join(TMP, "synth.gamedata");
execFileSync("python3", [path.join(HERE, "save_bridge.py")], {
  input: JSON.stringify({ cmd: "synth", out: synthSavePath }),
});
const isoHashBefore = sha(synthIsoPath), saveHashBefore = sha(synthSavePath);

// ---- minimal MCP client ------------------------------------------------------
const srv = spawn("node", [path.join(HERE, "server.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 0;
const waiters = new Map();
srv.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  }
});
srv.stderr.on("data", (d) => process.stderr.write("[server] " + d));
const rpc = (method, params) => new Promise((res) => {
  const id = ++nextId; waiters.set(id, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  const c = r.result?.content?.[0]?.text ?? "";
  let parsed = null; try { parsed = JSON.parse(c); } catch { /* error text */ }
  return { isError: !!r.result?.isError, text: c, data: parsed };
};

// ---- handshake and discovery --------------------------------------------------
console.log("Handshake and tool listing:");
const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "s3-mcp-test", version: "0" } });
check("initialize returns the server identity", init.result?.serverInfo?.name === "suikoden-3-editor");
notify("notifications/initialized", {});
const list = await rpc("tools/list", {});
const toolNames = list.result.tools.map((t) => t.name);
check("tools/list returns the full surface (23 tools)", toolNames.length === 23, toolNames.join(","));
check("no tool exposes the disabled attack-rune lists patch", !toolNames.some((n) => /atklist|option_?b/i.test(n)));

// ---- ISO round trip -----------------------------------------------------------
console.log("ISO discovery and field edit round trip (synthetic fixture):");
const open = await call("iso_open", { path: synthIsoPath });
check("iso_open verifies the synth disc", !open.isError && open.data?.region?.includes("SLUS-20387"), open.text.slice(0, 120));
const views = await call("iso_list_views");
check("iso_list_views returns all 23 views", views.data?.views?.length === 23);
const desc = await call("iso_describe_view", { view: "spells" });
check("iso_describe_view spells exposes the power field from iso.js", !!desc.data?.fields?.power);
const recs = await call("iso_list_records", { view: "spells", limit: 5 });
check("iso_list_records returns spell records", recs.data?.records?.length === 5 && recs.data.total === 94);
const before = await call("iso_get_field", { view: "spells", index: 0, field: "power" });
check("iso_get_field reads the planted spell power", !before.isError && typeof before.data?.value === "number", `power=${before.data?.value}`);
const set = await call("iso_set_field", { view: "spells", index: 0, field: "power", value: 999 });
check("iso_set_field stages the edit", !set.isError && set.data?.staged === true);
const after = await call("iso_get_field", { view: "spells", index: 0, field: "power" });
check("the staged value reads back", after.data?.value === 999 && after.data?.staged === true);
const changes = await call("iso_list_changes");
check("iso_list_changes reports the staged run", !changes.isError && changes.data?.totalChangedBytes >= 2, JSON.stringify(changes.data));

// ---- patches and disabled-feature fences --------------------------------------
console.log("Code patches and disabled-feature fences:");
const patches = await call("iso_list_patches");
check("iso_list_patches lists the enabled sets, tier 1 at stock", patches.data?.patches?.some((p) => p.id === "unlimited_casts_tier1" && p.state === "stock"));
const t1 = await call("iso_set_patch", { patch: "unlimited_casts_tier1", on: true });
check("iso_set_patch stages Tier 1", !t1.isError && t1.data?.on === true);
const patches2 = await call("iso_list_patches");
check("tier 1 now reads as on", patches2.data?.patches?.find((p) => p.id === "unlimited_casts_tier1")?.state === "on");
const ob = await call("iso_set_patch", { patch: "option_b", on: true });
check("Option B is refused by name", ob.isError && /disabled/i.test(ob.text), ob.text.slice(0, 100));
const raw = await call("iso_stage_word", { offset: 0x123EF4, width: 4, value: 0 });
check("a raw write at an ATKLIST offset is refused", raw.isError && /disabled/i.test(raw.text));
const rune = await call("iso_rune_set_spell_list", { itemId: 341, spells: [52, 1, 2, 3] });
check("the per-rune spell-list control (Option A) stages", !rune.isError && rune.data?.category === 0, rune.text.slice(0, 120));

// ---- exports ------------------------------------------------------------------
console.log("ISO exports:");
const outIso = path.join(TMP, "out.iso");
const exp = await call("iso_export_iso", { outPath: outIso });
check("iso_export_iso writes a patched copy", !exp.isError && fs.existsSync(outIso));
const recipePath = path.join(TMP, "recipe.json");
const rec = await call("iso_export_recipe", { outPath: recipePath });
check("iso_export_recipe writes edits", !rec.isError && JSON.parse(fs.readFileSync(recipePath, "utf8")).edits.length > 0);
const xdPath = path.join(TMP, "out.xdelta");
const xd = await call("iso_export_xdelta", { outPath: xdPath });
check("iso_export_xdelta writes a VCDIFF patch", !xd.isError && fs.readFileSync(xdPath).subarray(0, 4).equals(Buffer.from([0xd6, 0xc3, 0xc4, 0x00])));
const guard = await call("iso_export_iso", { outPath: synthIsoPath });
check("exporting over the opened source is refused", guard.isError && /never|refusing/i.test(guard.text));
check("the source ISO hash is unchanged after edits and exports", sha(synthIsoPath) === isoHashBefore);
const reopen = await call("iso_open", { path: outIso });
const verify = await call("iso_get_field", { view: "spells", index: 0, field: "power" });
check("reopening the exported ISO reads the edited value back", !reopen.isError && verify.data?.value === 999);

// ---- save round trip ------------------------------------------------------------
console.log("Save edit round trip (synthetic gamedata through s3save):");
const sopen = await call("save_open", { path: synthSavePath });
check("save_open decodes the synth save", !sopen.isError && sopen.data?.format === "gamedata", sopen.text.slice(0, 120));
const summary = await call("save_get", { section: "summary" });
check("save_get summary shows the planted gold", summary.data?.global?.gold === 12345, `gold=${summary.data?.global?.gold}`);
const trin = await call("save_get", { section: "trinity" });
check("Trinity Sight state is readable", !trin.isError && !!trin.data?.trinity);
const trinWrite = await call("save_stage_misc", { edits: { trinity: { lit: { thomas: true } } } });
check("a Trinity Sight write is refused", trinWrite.isError && /read-only/i.test(trinWrite.text));
const schar = await call("save_stage_character", { rosterIndex: 0, edits: { level: 42, charges: { cur: { 0: 4 } } } });
check("save_stage_character stages", !schar.isError && schar.data?.staged === true);
const smisc = await call("save_stage_misc", { edits: { gold: 777, recruits: { 1: true } } });
check("save_stage_misc stages gold and a recruit", !smisc.isError);
const schanges = await call("save_list_changes");
check("save_list_changes shows the staged edits", schanges.data?.staged?.characters?.[0]?.level === 42 && schanges.data?.staged?.gold === 777);
const outSave = path.join(TMP, "out.gamedata");
const sexp = await call("save_export", { outPath: outSave });
check("save_export writes through s3save", !sexp.isError && fs.existsSync(outSave), sexp.text.slice(0, 160));
check("the source save hash is unchanged", sha(synthSavePath) === saveHashBefore);
const sreopen = await call("save_open", { path: outSave });
const sverify = await call("save_get", { section: "characters" });
const hugo = sverify.data?.characters?.find((c) => c.rosterIndex === 0);
check("reopening the exported save reads the edits back", !sreopen.isError && hugo?.level === 42, `level=${hugo?.level}`);
const ssum2 = await call("save_get", { section: "summary" });
check("the exported gold reads back", ssum2.data?.global?.gold === 777);

// ---- real ISO smoke (read path only, on a copy) --------------------------------
console.log("Real ISO smoke test:");
const realIso = process.env.S3_ISO || path.join(REPO, "ISO", "Suikoden III (USA).iso");
if (fs.existsSync(realIso)) {
  const ro = await call("iso_open", { path: realIso });
  const rr = await call("iso_list_records", { view: "spells", limit: 3 });
  check("the real disc opens and its spells read", !ro.isError && rr.data?.records?.length === 3, rr.data?.records?.[0]?.name || "");
} else {
  console.log("  - skipped: no real ISO in the repo checkout");
}

// ---- real memory card smoke (optional, S3_CARD=/path/to/card.ps2) -------------
console.log("Real memory card smoke test:");
if (process.env.S3_CARD && fs.existsSync(process.env.S3_CARD)) {
  const cardHash = sha(process.env.S3_CARD);
  const co = await call("save_open", { path: process.env.S3_CARD });
  check("the real card opens and decodes its saves", !co.isError && co.data?.saveCount >= 1, `${co.data?.saveCount} save(s)`);
  await call("save_stage_misc", { edits: { gold: 31337 } });
  const cout = path.join(TMP, "card-out.ps2");
  const ce = await call("save_export", { outPath: cout });
  await call("save_open", { path: cout });
  const cg = await call("save_get", { section: "summary" });
  check("a gold edit round-trips through a real card export", !ce.isError && cg.data?.global?.gold === 31337);
  check("the source card hash is unchanged", sha(process.env.S3_CARD) === cardHash);
} else {
  console.log("  - skipped: set S3_CARD to a memory card image to run it");
}

srv.kill();
console.log(`\n${total - fails}/${total} checks passed${fails ? `, ${fails} FAILED` : ""}.`);
process.exit(fails ? 1 : 0);
