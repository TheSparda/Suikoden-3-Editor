// Suikoden III ISO Editor — web front-end (client-side, in-place, no upload).
//
// Unlike the save editor (which loads a tiny file wholesale into Pyodide), the ISO is
// ~4.3 GB and can't live in memory. But every editable table sits in ONE contiguous
// ~3.7 MB region near the front of the disc (the boot ELF's PT_LOAD segment). So we:
//   • read that single block once via a ranged Blob.slice() (nothing else is loaded),
//   • edit entirely in memory against that block,
//   • on save, diff the block vs its pristine copy and write ONLY the changed byte runs
//     back to the original file via the File System Access API (in place).
//
// All offsets/strides/field layouts mirror Editor/s3patch.py + Editor/s3fields.py exactly.
// This tab is desktop-Chromium only (needs showOpenFilePicker for a writable handle);
// unsupported browsers get a clear "why" notice instead.
(function () {
  "use strict";

  // ---- constants (raw byte offsets into the ISO; decimal is authoritative) ----
  const VERSION_OFF = 4136544;              // u32 big-endian
  const VERSION_VAL = 0x40A69A01;           // SLUS-20387 (USA)
  const ELF_BASE = 0xA4800;                 // PT_LOAD file offset
  const ELF_LEN = 0x38D000;                 // PT_LOAD size (~3.71 MB) — covers every table
  const ELF_VADDR = 0x165D000;              // PT_LOAD virtual address (for name/desc pointers)
  const ELF_END = ELF_BASE + ELF_LEN;

  const TABLES = { list1: [4078716, 140], list2: [4068152, 132], list3: [4089904, 8], list4: [4061704, 28] };
  const LIST_COUNT = { list1: 80, list2: 80, list3: 35, list4: 28 };
  // Fixed shop/price tables: name -> [offset, count, width]
  const SHOP = { item3_a: [4105552, 10, 2], item3_b: [4054224, 16, 2], item2: [3970620, 15, 4], item1: [4136564, 3, 4] };
  const SPELL = { off: 0x3EC2A0, count: 94, stride: 0x20, elem: 0x24 };   // elem = stride+0x04
  const UNITE = { off: 0x3ECF90, count: 38, stride: 0x28 };
  const FOOD = { off: 0x3E91D0, stride: 0x48, count: 62, desc: 0x00, heal: 0x14, proc: 0x1E, name: 0x44 };
  const GEAR = { stride: 0x44, def: 0x10, price: 0x08, effs: [0x14, 0x1C, 0x24, 0x2C, 0x34] };

  const ELEMENTS = { 0: "None", 1: "Fire", 2: "Water", 3: "Wind", 4: "Earth", 5: "Lightning", 6: "Pale (Dark)" };
  const AREA_BIT = 0x8000;                  // flags14 bit15 = area-of-effect
  const F18_BITS = { 1: "poison", 3: "instant-death", 4: "unbalance", 9: "teleport/chant",
    10: "sleep", 13: "silence/berserk", 14: "mgc-boost", 15: "mgc-shield", 19: "mgc-immune-once",
    21: "buff-pdf/mdf", 22: "sword-fire", 23: "sword-lightning", 24: "sword-wind",
    25: "resist-fire", 26: "resist-lightning", 27: "resist-wind" };
  const RANK_OPTS = [[0, "— (not learned)"], [1, "E"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [7, "A+"], [8, "S"]];
  const MAX_OPTS = [[0, "Can't get"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [1, "A+"], [7, "S"]];

  // ---- field schemas for the character/growth/support/weapon record tables ----
  // [label, offsetInRecord, widthBytes, kind]  (kind: item | skill | rank | num)
  const LIST1_FIELDS = [
    ["Unknown (u16 @+0)", 0, 2, "num"], ["Weapon growth class", 9, 1, "num"],
    ["Skill 1 (id)", 12, 1, "skill"], ["Skill 1 rank", 13, 1, "rank"],
    ["Skill 2 (id)", 14, 1, "skill"], ["Skill 2 rank", 15, 1, "rank"],
    ["Skill 3 (id)", 16, 1, "skill"], ["Skill 3 rank", 17, 1, "rank"],
    ["Skill 4 (id)", 18, 1, "skill"], ["Skill 4 rank", 19, 1, "rank"],
    ["Skill 5 (id)", 20, 1, "skill"], ["Skill 5 rank", 21, 1, "rank"],
    ["Skill 6 (id)", 22, 1, "skill"], ["Skill 6 rank", 23, 1, "rank"],
    ["Rune Left hand", 64, 2, "item"], ["Rune Right hand", 72, 2, "item"], ["Rune Head", 80, 2, "item"],
    ["Helmet", 88, 2, "item"], ["Armor", 96, 2, "item"], ["Shield", 104, 2, "item"],
    ["Other item 1", 112, 2, "item"], ["Other item 1 amount", 114, 1, "num"],
    ["Other item 2", 120, 2, "item"], ["Other item 2 amount", 122, 1, "num"],
    ["Other item 3", 128, 2, "item"], ["Other item 3 amount", 130, 1, "num"],
  ];
  const LIST2_GROWTH = [
    ["PWR growth", 4, 1, "num"], ["SKL growth", 5, 1, "num"], ["MAG growth", 6, 1, "num"], ["REP growth", 7, 1, "num"],
    ["MDF growth", 8, 1, "num"], ["SPD growth", 9, 1, "num"], ["LUK growth", 10, 1, "num"], ["HP growth", 11, 1, "num"],
    ["Head Rune Level", 0, 1, "num"], ["RH Rune Level", 1, 1, "num"], ["LH Rune Level", 2, 1, "num"],
  ];
  const LIST2_FIXED = [
    ["Fixed Skill 1 (id)", 80, 1, "skill"], ["Skill 1 level learned", 81, 1, "num"],
    ["Fixed Skill 2 (id)", 82, 1, "skill"], ["Skill 2 level learned", 83, 1, "num"],
    ["Fixed Skill 3 (id)", 84, 1, "skill"], ["Skill 3 level learned", 85, 1, "num"],
    ["Fixed Skill 4 (id)", 86, 1, "skill"], ["Skill 4 level learned", 87, 1, "num"],
    ["Fixed Skill 5 (id)", 88, 1, "skill"], ["Skill 5 level learned", 89, 1, "num"],
    ["Fixed Skill 6 (id)", 90, 1, "skill"], ["Skill 6 level learned", 91, 1, "num"],
    ["Fixed Skill 7 (id)", 92, 1, "skill"], ["Skill 7 level learned", 93, 1, "num"],
    ["Fixed Skill 8 (id)", 94, 1, "skill"], ["Skill 8 level learned", 95, 1, "num"],
    ["Number of Free Skills", 96, 1, "num"], ["Starting level", 100, 1, "num"], ["Starting level relative (0/1)", 101, 1, "num"],
  ];
  const LIST2_SKILLMAX_START = 13;          // 43 skills (id 0x01..0x2B) as consecutive bytes
  const LIST3_FIELDS = Array.from({ length: 8 }, (_, i) => [`Support skill ${i + 1} (id)`, i, 1, "skill"]);
  const LIST4_FIELDS = Array.from({ length: 16 }, (_, i) => [`ATK Lv${i + 1}`, i, 1, "num"]);

  // ---- environment / capability ---------------------------------------------
  const SUPPORTS_FS = typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";

  // ---- state -----------------------------------------------------------------
  let isoHandle = null, isoName = "";
  let BUF = null, DV = null;                // live editable block (Uint8Array + DataView)
  let ORIG = null, ODV = null;              // pristine snapshot for diffing/undo
  let REF = null;                           // { items:{id:name}, cats:{id:cat}, idesc:{id:desc}, skills:{id:name}, names:{...} }
  let VIEW = "chars", SEARCH = "";
  let gearCache = null;                     // {itemId: absStatsOffset}
  const FIELD_REG = {};                     // absOff -> {group,label,off:absOff,width,kind}
  const dec = new TextDecoder("latin1");

  // ---- shared helpers from app.js (same global script scope) -----------------
  const q = (s, r = document) => (r || document).querySelector(s);
  const qa = (s, r = document) => Array.from((r || document).querySelectorAll(s));
  const esc2 = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hex = (n, w) => (n >>> 0).toString(16).toUpperCase().padStart(w, "0");

  // ---- block read/write (all offsets are ABSOLUTE ISO offsets) ---------------
  const inBlk = (off, n) => off >= ELF_BASE && off + n <= ELF_END;
  function r8(o) { return BUF[o - ELF_BASE]; }
  function r16(o) { return DV.getUint16(o - ELF_BASE, true); }
  function r32(o) { return DV.getUint32(o - ELF_BASE, true); }
  function o8(o) { return ORIG[o - ELF_BASE]; }
  function o16(o) { return ODV.getUint16(o - ELF_BASE, true); }
  function o32(o) { return ODV.getUint32(o - ELF_BASE, true); }
  function readW(o, w) { return w === 1 ? r8(o) : w === 2 ? r16(o) : r32(o); }
  function origW(o, w) { return w === 1 ? o8(o) : w === 2 ? o16(o) : o32(o); }
  function writeW(o, w, v) {
    if (!inBlk(o, w)) return;
    const rel = o - ELF_BASE;
    if (w === 1) BUF[rel] = v & 0xFF;
    else if (w === 2) DV.setUint16(rel, v & 0xFFFF, true);
    else DV.setUint32(rel, v >>> 0, true);
  }
  function strAt(vaddr) {
    const rel = vaddr - ELF_VADDR;
    if (rel < 0 || rel >= BUF.length) return "";
    let e = BUF.indexOf(0, rel); if (e < 0) e = Math.min(rel + 48, BUF.length);
    return dec.decode(BUF.subarray(rel, e));
  }

  // ---- reference tables (parsed in JS so the ISO tab needs no Pyodide) -------
  async function loadRef() {
    if (REF) return REF;
    const grab = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`fetch ${u} (${r.status})`); return r; };
    const itemsTxt = await (await grab("../Editor/Suikoden3_item_ids.txt")).text();
    const skillsTxt = await (await grab("../Editor/Suikoden3_skill_ids.txt")).text();
    const idesc = await (await grab("../Editor/s3_item_desc.json")).json();
    const names = await (await grab("../Editor/s3_names.json")).json();
    const items = {}, cats = {};
    let cur = "";
    for (const line of itemsTxt.split(/\r?\n/)) {
      const h = /\*\s*(.+?)\s*\*/.exec(line);
      if (h && line.indexOf("\t") < 0) { cur = h[1].trim(); continue; }
      const re = /([0-9A-Fa-f]{3})\t([^\t\n\r]+)/g; let m;
      while ((m = re.exec(line))) { const id = parseInt(m[1], 16); items[id] = m[2].trim(); cats[id] = cur; }
    }
    const skills = {};
    for (const line of skillsTxt.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/); if (p.length >= 2) { const id = parseInt(p[0], 16); if (!isNaN(id)) skills[id] = p.slice(1).join(" "); }
    }
    REF = { items, cats, idesc, skills, names };
    return REF;
  }

  // ---- label / option helpers ------------------------------------------------
  const itemName = (id) => REF.items[id] || "#" + id;
  const skillName = (id) => REF.skills[id] || "#" + id;
  const itemLabel = (id) => id ? `${hex(id, 3)} · ${itemName(id)}` : "— none —";
  const skillLabel = (id) => id ? `${hex(id, 2)} · ${skillName(id)}` : "— none —";
  const rankLabel = (v) => (RANK_OPTS.find((t) => t[0] === v) || [v, "?"])[1];
  const maxLabel = (v) => (MAX_OPTS.find((t) => t[0] === v) || [v, "?"])[1];
  function itemOpts(cat) {
    const list = Object.keys(REF.items).map(Number).filter((id) => !cat || REF.cats[id] === cat)
      .sort((a, b) => a - b).map((id) => ({ id, name: itemName(id), cat: REF.cats[id], desc: REF.idesc[id] || "" }));
    return [{ id: 0, name: "— none —" }, ...list];
  }
  function skillOpts() {
    const list = Object.keys(REF.skills).map(Number).sort((a, b) => a - b).map((id) => ({ id, name: skillName(id) }));
    return [{ id: 0, name: "— none —" }, ...list];
  }
  // map a list1 item-slot label to its item category, so pickers show the right gear only
  function slotCat(label) {
    if (/Rune/.test(label)) return "Runes";
    if (/Helmet/.test(label)) return "Headgear";
    if (/Armor/.test(label)) return "Armor";
    if (/Shield/.test(label)) return "Shields";
    return "";
  }

  function decodeF18(v) {
    if (!v) return "-";
    const names = [];
    for (let b = 0; b < 32; b++) if ((v >>> b) & 1) names.push(F18_BITS[b] || "bit" + b);
    return names.length > 6 ? "heal/restore-all" : names.join("|");
  }
  function decodeTarget(f14) {
    const tb = (f14 >>> 8) & 0xFF, area = !!(f14 & AREA_BIT), low = tb & 0x0F;
    const who = { 0xA: "single", 0x2: "all-foes", 0x3: "foes+allies", 0x1: "self/ally" }[low] || "who" + low;
    const shape = area ? "AREA" : (tb & 0x10) ? "LINE" : low === 0xA ? "single" : "spread";
    return `${shape}:${who}`;
  }

  // ---- edit application ------------------------------------------------------
  // Register a field's location so the review/save diff can label it, then apply.
  function reg(off, width, kind, group, label) { FIELD_REG[off] = { group, label, off, width, kind }; }
  function isDirty(off, width) {
    for (let i = 0; i < width; i++) if (BUF[off - ELF_BASE + i] !== ORIG[off - ELF_BASE + i]) return true;
    return false;
  }
  function fmtVal(kind, v) {
    if (kind === "item") return itemLabel(v);
    if (kind === "skill") return skillLabel(v);
    if (kind === "rank") return rankLabel(v);
    if (kind === "max") return maxLabel(v);
    if (kind === "elem") return ELEMENTS[v & 0xFF] || "0x" + (v & 0xFF).toString(16);
    if (kind === "aoe") return (v & AREA_BIT) ? "AOE on" : "AOE off";
    if (kind === "status") return decodeF18(v);
    return String(v);
  }
  function anyChanges() { return BUF && ORIG && diffRuns(1).length > 0; }
  // relative [start,end) runs where BUF != ORIG; pass limit to early-out on the first run
  function diffRuns(limit) {
    const runs = []; const N = BUF.length; let i = 0;
    while (i < N) {
      if (BUF[i] !== ORIG[i]) { const s = i; while (i < N && BUF[i] !== ORIG[i]) i++; runs.push([s, i]); if (limit && runs.length >= limit) return runs; }
      else i++;
    }
    return runs;
  }

  // ---- ISO load --------------------------------------------------------------
  async function openIso() {
    let handle, file;
    try {
      [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [{ description: "Disc images", accept: { "application/octet-stream": [".iso", ".bin", ".img"] } }],
      });
      file = await handle.getFile();
    } catch (e) { if (e && e.name !== "AbortError") setStatus("Could not open ISO: " + e.message, "err"); return; }

    setStatus("Reading disc region…", "");
    if (file.size < ELF_END) return setStatus(`That file is only ${fmtSize(file.size)} — not a full Suikoden III ISO.`, "err");
    let ab;
    try { ab = await file.slice(ELF_BASE, ELF_END).arrayBuffer(); }
    catch (e) { return setStatus("Read failed: " + e.message, "err"); }
    const buf = new Uint8Array(ab);
    if (buf.length < ELF_LEN) return setStatus("Could not read the full disc region (file too short or unreadable).", "err");
    const dv = new DataView(ab);
    const ver = dv.getUint32(VERSION_OFF - ELF_BASE, false);   // big-endian
    if (ver !== VERSION_VAL) {
      return setStatus(`Not a USA (SLUS-20387) Suikoden III ISO — version word 0x${hex(ver, 8)} ≠ 0x${hex(VERSION_VAL, 8)}. ` +
        `Only the USA release is supported.`, "err");
    }
    // commit
    BUF = buf; DV = dv; ORIG = buf.slice(); ODV = new DataView(ORIG.buffer);
    isoHandle = handle; isoName = file.name || "game.iso";
    gearCache = null; Object.keys(FIELD_REG).forEach((k) => delete FIELD_REG[k]);
    VIEW = "chars"; SEARCH = "";
    renderEditor(file.size);
    q("#isoRoot").scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Loaded ${isoName} — USA verified.`, "ok");
  }

  // ---- save (in place) -------------------------------------------------------
  function buildReview() {
    const rows = [];
    for (const off in FIELD_REG) {
      const m = FIELD_REG[off];
      if (!isDirty(m.off, m.width)) continue;
      const ov = fmtVal(m.kind, origW(m.off, m.width)), nv = fmtVal(m.kind, readW(m.off, m.width));
      if (ov !== nv) rows.push({ g: m.group, t: `${m.label}: ${ov} → ${nv}` });
    }
    return rows;
  }
  function saveIso() {
    if (!anyChanges()) return setStatus("No changes to save.", "warn");
    const rows = buildReview();
    const runs = diffRuns();
    const bytes = runs.reduce((a, r) => a + (r[1] - r[0]), 0);
    if (!rows.length) rows.push({ g: "Raw", t: `${bytes} byte(s) across ${runs.length} run(s)` });
    // reuse the save editor's confirm modal (same global function/markup)
    openConfirm(rows, doSave, `Write ${bytes} byte(s) to ${isoName}`);
  }
  async function doSave() {
    setStatus("Writing to ISO (the browser copies the file first — this can take a while for a 4 GB disc)…", "");
    try {
      const opts = { keepExistingData: true };
      const w = await isoHandle.createWritable(opts);
      for (const [s, e] of diffRuns()) {
        await w.write({ type: "write", position: ELF_BASE + s, data: BUF.slice(s, e) });
      }
      await w.close();
    } catch (e) { return setStatus("Write failed: " + e.message, "err"); }
    ORIG = BUF.slice(); ODV = new DataView(ORIG.buffer);   // now clean
    drawView();
    setStatus(`Saved — changes written in place to ${isoName}.`, "ok");
  }

  // ---- shareable .s3mod recipe (tiny, reversible, version-checked) -----------
  function exportRecipe() {
    if (!anyChanges()) return setStatus("No changes to export.", "warn");
    const patches = [];
    for (const [s, e] of diffRuns()) {
      let oldHex = "", newHex = "";
      for (let i = s; i < e; i++) { oldHex += hex(ORIG[i], 2).toLowerCase(); newHex += hex(BUF[i], 2).toLowerCase(); }
      patches.push({ off: ELF_BASE + s, old: oldHex, new: newHex });
    }
    const mod = { format: "s3mod", version: 1, game: "SLUS-20387", versionWord: VERSION_VAL,
      note: "made with the web ISO editor", patchCount: patches.length, patches };
    const blob = new Blob([JSON.stringify(mod, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (isoName.replace(/\.[^.]+$/, "") || "s3") + ".s3mod";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    setStatus(`Exported ${patches.length} patch run(s) as a .s3mod recipe.`, "ok");
  }
  async function importRecipe(file) {
    let mod;
    try { mod = JSON.parse(await file.text()); } catch (e) { return setStatus("Not a valid recipe file.", "err"); }
    if (mod.format !== "s3mod") return setStatus("Not an s3mod recipe.", "err");
    if (mod.versionWord && mod.versionWord !== VERSION_VAL) return setStatus("Recipe is for a different game/region.", "err");
    let applied = 0, mism = 0;
    for (const p of mod.patches || []) {
      const nb = hexBytes(p.new), ob = p.old ? hexBytes(p.old) : null;
      const off = +p.off;
      if (!inBlk(off, nb.length)) continue;
      if (ob) for (let i = 0; i < ob.length; i++) if (BUF[off - ELF_BASE + i] !== ob[i]) { mism++; break; }
      for (let i = 0; i < nb.length; i++) writeW(off + i, 1, nb[i]);
      applied += nb.length;
    }
    drawView();
    setStatus(`Applied recipe — ${applied} byte(s)${mism ? `, ${mism} run(s) didn't match expected originals` : ""}. Review, then Save to write.`, mism ? "warn" : "ok");
  }
  const hexBytes = (h) => { const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };

  // ---- top-level render ------------------------------------------------------
  const VIEWS = [["chars", "Characters"], ["growth", "Growth"], ["support", "Support"], ["weapons", "Weapons"],
    ["shops", "Shops"], ["spells", "Spells"], ["unites", "Unites"], ["gear", "Gear"], ["food", "Food"]];

  function renderEditor(size) {
    const root = q("#isoRoot");
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div><b class="acc2">${esc2(isoName)}</b>
            <span class="muted"> · ${fmtSize(size)} · USA SLUS-20387 ✓</span></div>
          <button id="isoClose" class="chip mini">Close</button>
        </div>
      </div>
      <div class="card">
        <div class="subtabs" id="isoTabs">${VIEWS.map(([k, l]) =>
          `<button class="chip${k === VIEW ? " on" : ""}" data-v="${k}">${l}</button>`).join("")}</div>
        <input class="search" id="isoSearch" placeholder="filter…">
        <div class="muted" id="isoHint" style="margin:2px 0 10px"></div>
        <div id="isoView"></div>
        <div class="toolbar">
          <button class="primary" id="isoSaveBtn">Apply &amp; save to ISO</button>
          <button id="isoRecipeBtn">Export recipe…</button>
          <label class="file" style="margin:0"><button type="button" id="isoImportBtn">Import recipe…</button>
            <input type="file" id="isoRecipeFile" accept=".s3mod,.json"></label>
          <button id="isoResetBtn">Revert all</button>
          <span class="status" id="isoStatus"></span>
        </div>
      </div>`;
    qa("[data-v]", root).forEach((b) => (b.onclick = () => { VIEW = b.dataset.v; SEARCH = ""; q("#isoSearch").value = ""; drawView(); }));
    q("#isoSearch").oninput = (e) => { SEARCH = e.target.value.toLowerCase(); drawView(); };
    q("#isoSaveBtn").onclick = saveIso;
    q("#isoRecipeBtn").onclick = exportRecipe;
    q("#isoImportBtn").onclick = () => q("#isoRecipeFile").click();
    q("#isoRecipeFile").onchange = (e) => { if (e.target.files[0]) importRecipe(e.target.files[0]); e.target.value = ""; };
    q("#isoResetBtn").onclick = () => { if (!anyChanges()) return setStatus("Nothing to revert.", "warn"); BUF.set(ORIG); drawView(); setStatus("Reverted all staged changes.", "ok"); };
    drawView();
  }

  function drawView() {
    qa("#isoTabs [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === VIEW));
    const hints = {
      chars: "Character starting stats (list 1): starting skills, ranks, equipped runes and gear.",
      growth: "Per-character stat-growth rates, rune levels, fixed skills, and starting level (list 2).",
      support: "Support-character skill sets (list 3), 8 skill ids each.",
      weapons: "Weapon ATK sharpen curves (list 4): base attack at sharpen levels 1–16.",
      shops: "Shop item slots (pick an item), the price ladder, and the item1 group. Prices are potch.",
      spells: "Spell / rune-effect table: power, cast (MOV), element, area-of-effect, and status.",
      unites: "Unite (co-op) attack table: power and cast (MOV).",
      gear: "Equipment records: DEF and price. Effect slots are shown read-only.",
      food: "Consumable / food table: heal amount and proc chance %.",
    };
    q("#isoHint").textContent = hints[VIEW] || "";
    const host = q("#isoView");
    if (VIEW === "chars") drawRecords(host, "list1", REF.names.list1, LIST1_FIELDS, true);
    else if (VIEW === "growth") drawGrowth(host);
    else if (VIEW === "support") drawRecords(host, "list3", REF.names.list3, LIST3_FIELDS, false);
    else if (VIEW === "weapons") drawRecords(host, "list4", REF.names.list4, LIST4_FIELDS, false);
    else if (VIEW === "shops") drawShops(host);
    else if (VIEW === "spells") drawSpells(host);
    else if (VIEW === "unites") drawUnites(host);
    else if (VIEW === "gear") drawGear(host);
    else if (VIEW === "food") drawFood(host);
  }

  // ---- generic record editor (list1 / list3 / list4) ------------------------
  function drawRecords(host, listKey, names, fields, lazy) {
    const [base, stride] = TABLES[listKey];
    const cnt = LIST_COUNT[listKey];
    const rows = [];
    for (let i = 0; i < cnt; i++) {
      const nm = names[String(i)];
      if (!nm && listKey !== "list4") continue;                 // only named roster entries
      const label = nm || `#${i}`;
      if (SEARCH && !label.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, label, base: base + i * stride });
    }
    if (!rows.length) { host.innerHTML = `<div class="muted">no matches</div>`; return; }
    host.innerHTML = rows.map((r) =>
      `<details class="char" data-rec="${r.base}"><summary>
         <span class="chev">▸</span><span class="nm">${esc2(r.label)}</span>
         <span class="muted">#${r.i}</span></summary>
         <div class="char-body"><div class="grid">${lazy ? "" : recFields(r.base, fields, r.label)}</div></div>
       </details>`).join("");
    qa("details.char", host).forEach((d) => {
      const rec = +d.dataset.rec, lbl = d.querySelector(".nm").textContent;
      if (lazy) d.addEventListener("toggle", () => {
        if (d.open && !d.dataset.built) { d.querySelector(".grid").innerHTML = recFields(rec, fields, lbl); wireFields(d, rec, lbl); d.dataset.built = "1"; }
      });
      else wireFields(d, rec, lbl);
    });
  }
  function recFields(recBase, fields, group) {
    return fields.map(([label, off, w, kind]) => fieldHTML(recBase + off, w, kind, label)).join("");
  }
  function fieldHTML(off, w, kind, label) {
    const v = readW(off, w), dirty = isDirty(off, w) ? " dirty" : "";
    if (kind === "item" || kind === "skill")
      return `<label class="field"><span>${esc2(label)}</span>
        <button type="button" class="picker${dirty}" data-off="${off}" data-w="${w}" data-kind="${kind}">${esc2(kind === "item" ? itemLabel(v) : skillLabel(v))}</button></label>`;
    if (kind === "rank" || kind === "max") {
      const opts = (kind === "rank" ? RANK_OPTS : MAX_OPTS).map(([val, l]) => `<option value="${val}"${val === v ? " selected" : ""}>${l}</option>`).join("");
      return `<label class="field"><span>${esc2(label)}</span>
        <select class="fsel${dirty}" data-off="${off}" data-w="${w}" data-kind="${kind}">${opts}</select></label>`;
    }
    const max = w === 1 ? 255 : w === 2 ? 65535 : 4294967295;
    return `<label class="field"><span>${esc2(label)}</span>
      <input type="number" class="fnum${dirty}" min="0" max="${max}" value="${v}" data-off="${off}" data-w="${w}" data-kind="num"></label>`;
  }
  function wireFields(scope, recBase, group) {
    qa("button.picker[data-off]", scope).forEach((btn) => (btn.onclick = () => {
      const off = +btn.dataset.off, w = +btn.dataset.w, kind = btn.dataset.kind, cur = readW(off, w);
      const label = btn.parentElement.querySelector("span").textContent;
      const opts = kind === "item" ? itemOpts(slotCat(label)) : skillOpts();
      // ensure current value is selectable even if filtered out
      if (cur && !opts.some((o) => o.id === cur)) opts.splice(1, 0, { id: cur, name: kind === "item" ? itemName(cur) : skillName(cur) });
      openPicker(label, opts, cur, (id) => {
        writeW(off, w, id); reg(off, w, kind, group, label);
        btn.textContent = kind === "item" ? itemLabel(id) : skillLabel(id);
        btn.classList.toggle("dirty", isDirty(off, w));
      }, (id) => hex(id, kind === "item" ? 3 : 2));
    }));
    qa("select.fsel[data-off]", scope).forEach((sel) => (sel.onchange = () => {
      const off = +sel.dataset.off, w = +sel.dataset.w, kind = sel.dataset.kind;
      const label = sel.parentElement.querySelector("span").textContent;
      writeW(off, w, +sel.value); reg(off, w, kind, group, label);
      sel.classList.toggle("dirty", isDirty(off, w));
    }));
    qa("input.fnum[data-off]", scope).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      const label = inp.parentElement.querySelector("span").textContent;
      writeW(off, w, Math.max(0, Math.min(+inp.value || 0, w === 1 ? 255 : w === 2 ? 65535 : 4294967295)));
      reg(off, w, "num", group, label);
      inp.classList.toggle("dirty", isDirty(off, w));
    }));
  }

  // ---- growth (list2: growth + fixed skills + skill-max array) ---------------
  function drawGrowth(host) {
    const [base, stride] = TABLES.list2, names = REF.names.list2, cnt = LIST_COUNT.list2;
    const rows = [];
    for (let i = 0; i < cnt; i++) {
      const nm = names[String(i)]; if (!nm) continue;
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, label: nm, base: base + i * stride });
    }
    if (!rows.length) { host.innerHTML = `<div class="muted">no matches</div>`; return; }
    host.innerHTML = rows.map((r) =>
      `<details class="char" data-rec="${r.base}"><summary>
         <span class="chev">▸</span><span class="nm">${esc2(r.label)}</span><span class="muted">#${r.i}</span></summary>
         <div class="char-body"></div></details>`).join("");
    qa("details.char", host).forEach((d) => {
      const rec = +d.dataset.rec, lbl = d.querySelector(".nm").textContent;
      d.addEventListener("toggle", () => {
        if (!d.open || d.dataset.built) return;
        const body = d.querySelector(".char-body");
        const skillmax = [];
        for (let k = 0; k < 43; k++) skillmax.push(fieldHTML(rec + LIST2_SKILLMAX_START + k, 1, "max", "Max: " + skillName(k + 1)));
        body.innerHTML =
          `<h4>Growth rates &amp; rune levels</h4><div class="grid">${recFields(rec, LIST2_GROWTH, lbl)}</div>
           <h4>Fixed skills &amp; start</h4><div class="grid">${recFields(rec, LIST2_FIXED, lbl)}</div>
           <h4>Skill maximum levels</h4><div class="grid">${skillmax.join("")}</div>`;
        wireFields(d, rec, lbl); d.dataset.built = "1";
      });
    });
  }

  // ---- shops -----------------------------------------------------------------
  function drawShops(host) {
    const itemBlk = (title, key) => {
      const [off, cnt, w] = SHOP[key];
      let rows = "";
      for (let i = 0; i < cnt; i++) {
        const o = off + i * w, v = readW(o, w), dirty = isDirty(o, w) ? " dirty" : "";
        rows += `<tr><td class="sl">${i}</td><td>
          <button type="button" class="picker shopitem${dirty}" data-off="${o}" data-w="${w}">${esc2(itemLabel(v))}</button></td></tr>`;
      }
      return `<div class="bag"><div class="bag-h">${title}</div>
        <table class="invtbl"><thead><tr><th>Slot</th><th>Item</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    const numBlk = (title, key, note) => {
      const [off, cnt, w] = SHOP[key];
      let rows = "";
      for (let i = 0; i < cnt; i++) {
        const o = off + i * w, v = readW(o, w), dirty = isDirty(o, w) ? " dirty" : "";
        rows += `<tr><td class="sl">${i}</td><td>
          <input type="number" class="shopnum${dirty}" min="0" max="4294967295" style="width:140px" data-off="${o}" data-w="${w}" value="${v}"></td></tr>`;
      }
      return `<div class="bag"><div class="bag-h">${title} <span class="u">${note}</span></div>
        <table class="invtbl"><thead><tr><th>#</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    };
    host.innerHTML = itemBlk("Shop items — slots 1–10 (item3_a)", "item3_a") +
      itemBlk("Shop items — slots 21–36 (item3_b)", "item3_b") +
      numBlk("Price ladder (item2)", "item2", "potch, u32") +
      numBlk("item1 group", "item1", "u32");
    qa("button.shopitem", host).forEach((btn) => (btn.onclick = () => {
      const off = +btn.dataset.off, w = +btn.dataset.w, cur = readW(off, w);
      openPicker("Choose item", itemOpts(""), cur, (id) => {
        writeW(off, w, id); reg(off, w, "item", "Shops", `slot @0x${hex(off, 6)}`);
        btn.textContent = itemLabel(id); btn.classList.toggle("dirty", isDirty(off, w));
      });
    }));
    qa("input.shopnum", host).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      writeW(off, w, Math.max(0, +inp.value || 0)); reg(off, w, "num", "Shops", `value @0x${hex(off, 6)}`);
      inp.classList.toggle("dirty", isDirty(off, w));
    }));
  }

  // ---- spells ----------------------------------------------------------------
  function drawSpells(host) {
    const rows = [];
    for (let i = 0; i < SPELL.count; i++) {
      const off = SPELL.off + i * SPELL.stride;
      const name = strAt(r32(off + 0x08));
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, off, name });
    }
    host.innerHTML = rows.map(({ i, off, name }) => {
      const elemOff = off + SPELL.elem, cast = off + 0x10, pw = off + 0x1C, f14 = off + 0x14, f18 = off + 0x18;
      const canElem = i + 1 < SPELL.count;
      const elVal = canElem ? (r16(elemOff) & 0xFF) : 0;
      const elemSel = Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}"${+v === elVal ? " selected" : ""}>${l}</option>`).join("");
      const statVal = r32(f18);
      const statCur = statVal === 0 ? "none" : (Object.entries(F18_BITS).find(([b]) => statVal === (1 << b)) || [])[1] || "custom";
      const statOpts = ["none", ...Object.values(F18_BITS)].map((s) => `<option value="${s}"${s === statCur ? " selected" : ""}>${s}</option>`).join("");
      return `<details class="char"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="lv">${ELEMENTS[elVal]} · pw ${r32(pw)} · ${decodeTarget(r32(f14))}</span></summary>
        <div class="char-body"><div class="grid">
          <label class="field"><span>Power</span><input type="number" class="sp" min="0" max="4294967295" value="${r32(pw)}" data-off="${pw}" data-kind="num" data-g="${esc2(name)}" data-l="Power"></label>
          <label class="field"><span>Cast (MOV)</span><input type="number" class="sp" min="0" max="4294967295" value="${r32(cast)}" data-off="${cast}" data-kind="num" data-g="${esc2(name)}" data-l="Cast"></label>
          <label class="field"><span>Element</span><select class="spelem" ${canElem ? "" : "disabled"} data-off="${elemOff}" data-g="${esc2(name)}">${elemSel}</select></label>
          <label class="field"><span>Area of effect</span><select class="spaoe" data-off="${f14}" data-g="${esc2(name)}"><option value="0"${!(r32(f14) & AREA_BIT) ? " selected" : ""}>off</option><option value="1"${(r32(f14) & AREA_BIT) ? " selected" : ""}>on</option></select></label>
          <label class="field"><span>Status</span><select class="spstat" data-off="${f18}" data-g="${esc2(name)}">${statOpts}</select></label>
        </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`;
    wireSpellControls(host);
  }
  function wireSpellControls(host) {
    qa("input.sp", host).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off; writeW(off, 4, Math.max(0, +inp.value || 0));
      reg(off, 4, "num", inp.dataset.g, inp.dataset.l); inp.classList.toggle("dirty", isDirty(off, 4));
    }));
    qa("select.spelem", host).forEach((sel) => (sel.onchange = () => {
      const off = +sel.dataset.off, kept = r16(off) & 0xFF00; writeW(off, 2, kept | (+sel.value & 0xFF));
      reg(off, 2, "elem", sel.dataset.g, "Element"); markSel(sel, off, 2);
    }));
    qa("select.spaoe", host).forEach((sel) => (sel.onchange = () => {
      const off = +sel.dataset.off; let f = r32(off); f = +sel.value ? (f | AREA_BIT) : (f & ~AREA_BIT); writeW(off, 4, f);
      reg(off, 4, "aoe", sel.dataset.g, "Area of effect"); markSel(sel, off, 4);
    }));
    qa("select.spstat", host).forEach((sel) => (sel.onchange = () => {
      const off = +sel.dataset.off; const rev = {}; for (const b in F18_BITS) rev[F18_BITS[b]] = 1 << b;
      writeW(off, 4, sel.value === "none" ? 0 : (rev[sel.value] || 0)); reg(off, 4, "status", sel.dataset.g, "Status"); markSel(sel, off, 4);
    }));
  }
  const markSel = (sel, off, w) => sel.classList.toggle("dirty", isDirty(off, w));

  // ---- unites ----------------------------------------------------------------
  function drawUnites(host) {
    const rows = [];
    for (let i = 0; i < UNITE.count; i++) {
      const off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      const pw = off + 0x1C, cast = off + 0x10;
      rows.push(`<tr><td class="sl">${i}</td><td class="acc2">${esc2(name || "#" + i)}</td>
        <td><input type="number" class="un" min="0" max="4294967295" style="width:110px" value="${r32(pw)}" data-off="${pw}" data-g="${esc2(name)}" data-l="Power"></td>
        <td><input type="number" class="un" min="0" max="4294967295" style="width:110px" value="${r32(cast)}" data-off="${cast}" data-g="${esc2(name)}" data-l="Cast"></td></tr>`);
    }
    host.innerHTML = `<table class="invtbl"><thead><tr><th>#</th><th>Unite</th><th>Power</th><th>Cast</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>`;
    qa("input.un", host).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off; writeW(off, 4, Math.max(0, +inp.value || 0));
      reg(off, 4, "num", inp.dataset.g, inp.dataset.l); inp.classList.toggle("dirty", isDirty(off, 4));
    }));
  }

  // ---- food ------------------------------------------------------------------
  function drawFood(host) {
    const rows = [];
    for (let i = 0; i < FOOD.count; i++) {
      const off = FOOD.off + i * FOOD.stride, name = strAt(r32(off + FOOD.name));
      if (SEARCH && !name.toLowerCase().includes(SEARCH)) continue;
      const heal = off + FOOD.heal, proc = off + FOOD.proc;
      rows.push(`<tr><td class="sl">${i}</td><td class="acc2">${esc2(name || "#" + i)}</td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(heal)}" data-off="${heal}" data-g="${esc2(name)}" data-l="Heal HP"></td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(proc)}" data-off="${proc}" data-g="${esc2(name)}" data-l="Proc %"></td></tr>`);
    }
    host.innerHTML = `<table class="invtbl"><thead><tr><th>#</th><th>Item</th><th>Heal HP</th><th>Proc %</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="4" class="muted">no matches</td></tr>`}</tbody></table>`;
    qa("input.fd", host).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off; writeW(off, 2, Math.max(0, Math.min(+inp.value || 0, 65535)));
      reg(off, 2, "num", inp.dataset.g, inp.dataset.l); inp.classList.toggle("dirty", isDirty(off, 2));
    }));
  }

  // ---- gear (equipment: DEF + price editable; effects read-only) ------------
  function scanGear() {
    if (gearCache) return gearCache;
    const nameset = {}; for (const id in REF.items) nameset[REF.items[id]] = +id;
    const isptr = (w) => w >= ELF_VADDR && w <= ELF_VADDR + ELF_LEN;
    const out = {};
    const N = BUF.length - 2 * GEAR.stride;
    for (let p = 0; p < N; p += 4) {
      const dp = DV.getUint32(p, true), nv = DV.getUint32(p + 0x40, true);
      if (!isptr(dp) || !isptr(nv)) continue;
      const no = nv - ELF_VADDR; let ne = BUF.indexOf(0, no); if (ne < 0) continue;
      const nm = dec.decode(BUF.subarray(no, ne));
      if (!(nm in nameset)) continue;
      const doo = dp - ELF_VADDR; let de = BUF.indexOf(0, doo); if (de < 0) continue;
      const ds = dec.decode(BUF.subarray(doo, de));
      if (ds.indexOf("(") < 0) continue;
      const defv = DV.getUint16(p + GEAR.def, true), price = DV.getUint32(p + GEAR.price, true);
      if (defv > 500 || price > 2000000) continue;
      const iid = nameset[nm];
      if (!(iid in out)) out[iid] = ELF_BASE + p + GEAR.stride;   // stats live one record after the name
    }
    gearCache = out; return out;
  }
  function drawGear(host) {
    const g = scanGear();
    const ids = Object.keys(g).map(Number).sort((a, b) => a - b);
    const rows = [];
    for (const iid of ids) {
      const nm = itemName(iid);
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && hex(iid, 3).toLowerCase() !== SEARCH) continue;
      const base = g[iid], def = base + GEAR.def, price = base + GEAR.price;
      const effs = GEAR.effs.map((eo) => { const t = r16(base + eo); return t ? `${t}/${r16(base + eo + 2)}/${r16(base + eo + 4)}` : ""; }).filter(Boolean).join(", ") || "—";
      rows.push(`<details class="char"><summary><span class="chev">▸</span>
          <span class="nm">${esc2(nm)}</span><span class="muted">${hex(iid, 3)}</span>
          <span class="lv">DEF ${r16(def)} · ${r32(price)}p</span></summary>
        <div class="char-body"><div class="grid">
          <label class="field"><span>DEF</span><input type="number" class="gr" min="0" max="65535" value="${r16(def)}" data-off="${def}" data-w="2" data-g="${esc2(nm)}" data-l="DEF"></label>
          <label class="field"><span>Price (potch)</span><input type="number" class="gr" min="0" max="4294967295" value="${r32(price)}" data-off="${price}" data-w="4" data-g="${esc2(nm)}" data-l="Price"></label>
        </div><div class="muted" style="margin-top:8px">Effect slots (type/value/param, read-only): ${esc2(effs)}</div></div></details>`);
    }
    host.innerHTML = rows.join("") || `<div class="muted">no matching equipment</div>`;
    qa("input.gr", host).forEach((inp) => (inp.onchange = () => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      writeW(off, w, Math.max(0, Math.min(+inp.value || 0, w === 2 ? 65535 : 4294967295)));
      reg(off, w, "num", inp.dataset.g, inp.dataset.l); inp.classList.toggle("dirty", isDirty(off, w));
    }));
  }

  // ---- misc ------------------------------------------------------------------
  function fmtSize(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB"; }
  function setStatus(msg, kind) { const el = q("#isoStatus"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } else { const b = q("#isoBootStatus"); if (b) b.textContent = msg; } }

  // ---- blocked / loader shells ----------------------------------------------
  function renderBlocked() {
    q("#isoRoot").innerHTML = `
      <div class="card">
        <h2>ISO editing isn't available in this browser</h2>
        <p class="sub" style="margin-top:0">The ISO editor writes changes <b>in place</b> into your ~4 GB disc image.
          That needs the <b>File System Access API</b> (a writable file handle), which this browser doesn't provide.</p>
        <div class="warnbox" style="margin:0 0 10px">Your browser: no <code>showOpenFilePicker</code> support.</div>
        <p class="muted">Supported: <b>desktop Chrome, Edge, Brave, Opera</b> and other Chromium browsers.
          Not supported: Firefox, Safari, and all mobile/iOS browsers — they can't open a multi-gigabyte file
          for in-place editing, and the disc is far too large to load into a tab's memory to download a copy.</p>
        <p class="muted">The <b>Save editor</b> tab works everywhere, including mobile.</p>
      </div>`;
  }
  function renderLoader() {
    q("#isoRoot").innerHTML = `
      <div class="card">
        <h2>Load ISO</h2>
        <p class="sub" style="margin-top:0">Pick your <b>Suikoden III (USA)</b> disc image (SLUS-20387).
          Only a ~3.7 MB slice is read; edits are written back in place. Nothing is uploaded.
          <b>Back up your ISO first</b> — or use <i>Export recipe</i> to keep a reversible record of your edits.</p>
        <div class="drop">
          <div><b>Open a Suikoden III ISO</b></div>
          <label class="file"><button type="button" id="isoPick">Choose ISO…</button></label>
          <div class="muted" style="margin-top:10px" id="isoBootStatus">.iso / .bin / .img · USA release only</div>
        </div>
      </div>`;
    q("#isoPick").onclick = () => loadRef().then(openIso).catch((e) => setStatus("Failed to load reference tables: " + e.message, "err"));
  }

  // ---- mode tabs + init ------------------------------------------------------
  function switchMode(mode) {
    qa(".mtab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const save = q("#mode-save"), iso = q("#mode-iso");
    if (save) save.classList.toggle("hidden", mode !== "save");
    if (iso) iso.classList.toggle("hidden", mode !== "iso");
    if (mode === "iso" && !q("#isoRoot").dataset.init) {
      if (SUPPORTS_FS) renderLoader(); else renderBlocked();
      q("#isoRoot").dataset.init = "1";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    qa(".mtab").forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
    // warn before leaving with unsaved ISO edits (save editor has its own guard)
    window.addEventListener("beforeunload", (e) => { if (anyChanges()) { e.preventDefault(); e.returnValue = ""; } });
  });
})();
