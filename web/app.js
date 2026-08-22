// Suikoden III Save Editor — web front-end (full parity with the desktop save editor).
//
// Option B: we do NOT reimplement save logic in JS. The real Editor/s3save.py runs in
// Pyodide (CPython/WASM). The uploaded save is written to Pyodide's in-memory FS and the
// existing path-based read_all_s3_saves()/write_save_edits() are called unchanged, so the
// gamedata checksum and memory-card ECC come from the tried module. The reference tables
// (item/skill/character names) are parsed with the same rules the desktop server uses.
// Nothing is uploaded — everything happens on-device.

const SAVE_PATH = "/save.bin";
const RANK_TIERS = [[0, "— (none)"], [1, "E"], [2, "D"], [3, "C"], [4, "B"],
                    [5, "B+"], [6, "A"], [7, "A+"], [8, "S"]];
// equipment slots (order + keys match s3save.EQUIP_SLOTS) and the item categories that fit
const EQ = [["headRune", "Head Rune"], ["rightRune", "Right Rune"], ["leftRune", "Left Rune"],
            ["helm", "Helm"], ["armor", "Armor"], ["shield", "Shield"],
            ["boots", "Boots"], ["gloves", "Gloves"], ["accessory", "Accessory"]];
const EQ_CATS = { headRune: ["Runes"], rightRune: ["Runes"], leftRune: ["Runes"],
  helm: ["Headgear"], armor: ["Armor"], shield: ["Shields"], boots: ["Footwear"],
  gloves: ["Gloves"], accessory: ["Rings", "Misc Gear"] };
const RECRUITERS = ["Hugo", "Chris", "Geddoe", "Thomas"];

let pyReady = null;
let REF = { items: [], skills: [], charById: {} };
let ITEM_BY_ID = {}, saves = [], curSlot = 0, origName = "save.bin";
let OPT_RANK = "";   // rank stays a small native <select>; other lists use pickers

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const hx = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- Pyodide bootstrap -----------------------------------------------------
async function bootPyodide() {
  bootProgress(10, "Downloading Python runtime…");
  const py = await loadPyodide();
  bootProgress(55, "Loading save module…");
  const grab = async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${url} (${r.status})`);
    return r;
  };
  py.FS.writeFile("s3save.py", await (await grab("../Editor/s3save.py")).text());
  py.FS.writeFile("items.txt", await (await grab("../Editor/Suikoden3_item_ids.txt")).text());
  py.FS.writeFile("skills.txt", await (await grab("../Editor/Suikoden3_skill_ids.txt")).text());
  py.FS.writeFile("names.json", await (await grab("../Editor/s3_names.json")).text());
  py.FS.writeFile("itemdesc.json", await (await grab("../Editor/s3_item_desc.json")).text());
  py.FS.writeFile("skilldesc.json", await (await grab("../Editor/s3_skill_desc.json")).text());
  bootProgress(80, "Parsing reference tables…");

  py.runPython(`
import json, re, s3save

# --- reference-table parsers (same rules as s3patch.load_* used by the desktop server) ---
def _item_ids(t):
    return {int(m.group(1),16): m.group(2).strip()
            for m in re.finditer(r"\\b([0-9A-Fa-f]{3})\\t([^\\t\\n\\r]+)", t)}
def _item_cats(t):
    out, cur = {}, ""
    for line in t.splitlines():
        h = re.search(r"\\*\\s*(.+?)\\s*\\*", line)
        if h and "\\t" not in line:
            cur = h.group(1).strip(); continue
        for m in re.finditer(r"\\b([0-9A-Fa-f]{3})\\t([^\\t\\n\\r]+)", line):
            out[int(m.group(1),16)] = cur
    return out
def _skill_ids(t):
    out = {}
    for line in t.splitlines():
        p = line.strip().split(None, 1)
        if len(p) == 2:
            try: out[int(p[0],16)] = p[1]
            except ValueError: pass
    return out

def load_reference():
    it = open("items.txt", encoding="latin1").read()
    ids, cats = _item_ids(it), _item_cats(it)
    idesc = {int(k): v for k, v in json.load(open("itemdesc.json")).items()}
    sdesc = json.load(open("skilldesc.json"))     # keyed by skill NAME
    items = [{"id": k, "name": v, "cat": cats.get(k, ""), "desc": idesc.get(k, "")}
             for k, v in sorted(ids.items())]
    skills = [{"id": k, "name": v, "desc": sdesc.get(v, "")}
              for k, v in sorted(_skill_ids(open("skills.txt", encoding="latin1").read()).items())]
    charById = json.load(open("names.json")).get("list1", {})
    return json.dumps({"items": items, "skills": skills, "charById": charById})

def load_saves(path):
    charById = json.load(open("names.json")).get("list1", {})
    out = []
    for dec in s3save.read_all_s3_saves(path):
        for c in dec["characters"]:
            c.pop("raw", None)                 # drop the 140-byte dump from the payload
        lid = dec["global"].get("partyLeader")
        dec["leaderName"] = charById.get(str(lid), "")
        out.append(dec)
    return json.dumps(out)

def apply_edits(path, folder, payload_json):
    p = json.loads(payload_json)
    edits = {int(k): v for k, v in (p.get("edits") or {}).items()}
    inv   = {int(k): v for k, v in (p.get("invEdits") or {}).items()}
    party = {int(k): v for k, v in (p.get("partyEdits") or {}).items()}
    rec   = {int(k): v for k, v in (p.get("recruitEdits") or {}).items()}
    res = s3save.write_save_edits(
        path, folder, edits, make_backup=False,
        inv_edits=inv or None, name_edits=(p.get("nameEdits") or None),
        party_edits=party or None, recruit_edits=rec or None, gold=p.get("gold"))
    return json.dumps(res)
`);
  REF = JSON.parse(py.runPython("load_reference()"));
  REF.items.forEach((i) => (ITEM_BY_ID[i.id] = i));
  REF.skills.forEach((s) => (SKILL_BY_ID[s.id] = s));
  // character picker list (id · name), sorted by id
  CHAR_LIST = Object.entries(REF.charById).map(([id, nm]) => ({ id: +id, name: nm }))
    .sort((a, b) => a.id - b.id);
  OPT_RANK = RANK_TIERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  bootProgress(100, "Ready");
  return py;
}

// ---- searchable pickers (replace long native <select>s) --------------------
// Item / skill / character lists are large; a native select is unusable on mobile.
// Each picker button opens a filterable modal. Labels resolve id → "HHH · Name".
let SKILL_BY_ID = {}, CHAR_LIST = [];

function itemLabel(id) { return id ? `${hx(id, 3)} · ${ITEM_BY_ID[id]?.name || "#" + id}` : "— empty —"; }
function skillLabel(id) { return id ? `${hx(id, 2)} · ${SKILL_BY_ID[id]?.name || "#" + id}` : "— none —"; }
function charLabel(id) { return id ? `${String(id).padStart(3, "0")} · ${REF.charById[id] || "id " + id + " (guest/NPC)"}` : "— empty —"; }

// Option lists (each ends up as [{id,name,cat,desc}], with a 0 = none/empty entry first).
function itemList(noneLabel) { return [{ id: 0, name: noneLabel }, ...REF.items]; }
function skillList() { return [{ id: 0, name: "none" }, ...REF.skills]; }
function eqList(slotKey, curId) {
  const cats = EQ_CATS[slotKey] || [];
  let list = REF.items.filter((i) => cats.includes(i.cat));
  if (curId && !list.some((i) => i.id === curId) && ITEM_BY_ID[curId]) list = [ITEM_BY_ID[curId], ...list];
  return [{ id: 0, name: "none" }, ...list];
}
function charList() { return [{ id: 0, name: "empty" }, ...CHAR_LIST]; }

// Open the shared picker modal. list=[{id,name,cat?,desc?}]; onPick(id) fires on choose.
// idFmt formats the id prefix per domain (3-hex items, 2-hex skills, decimal chars).
function openPicker(title, list, current, onPick, idFmt) {
  idFmt = idFmt || ((id) => hx(id, 3));
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal picker-modal" role="dialog" aria-label="${esc(title)}">
      <div class="modal-h"><b>${esc(title)}</b><button class="modal-x" aria-label="close">✕</button></div>
      <input class="picker-search" placeholder="type to filter…" autocomplete="off">
      <div class="picker-list"></div></div>`;
  document.body.appendChild(ov);
  const listEl = $(".picker-list", ov), search = $(".picker-search", ov);
  const close = () => ov.remove();

  function render(f) {
    const q = (f || "").toLowerCase();
    const rows = list.filter((o) => !q || o.name.toLowerCase().includes(q) ||
      (o.id && (hx(o.id, 2).toLowerCase().includes(q) || String(o.id) === q)));
    listEl.innerHTML = rows.slice(0, 300).map((o) =>
      `<button class="picker-row${o.id === current ? " cur" : ""}" data-id="${o.id}">
         <span class="pr-name">${o.id ? idFmt(o.id) + " · " : ""}${esc(o.name)}</span>
         ${o.desc ? `<span class="pr-desc">${esc(o.desc)}</span>` : ""}
         ${o.cat ? `<span class="pr-cat">${esc(o.cat)}</span>` : ""}</button>`).join("") ||
      `<div class="muted" style="padding:12px">no matches</div>`;
    if (rows.length > 300) listEl.insertAdjacentHTML("beforeend",
      `<div class="muted" style="padding:8px 12px">…${rows.length - 300} more — keep typing</div>`);
    $$(".picker-row", listEl).forEach((b) => (b.onclick = () => { onPick(+b.dataset.id); close(); }));
  }
  render("");
  search.oninput = () => render(search.value);
  $(".modal-x", ov).onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  ov.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  setTimeout(() => search.focus(), 30);
}

// ---- File loading ----------------------------------------------------------
async function handleFile(file) {
  const py = await pyReady;
  origName = file.name || "save.bin";
  py.FS.writeFile(SAVE_PATH, new Uint8Array(await file.arrayBuffer()));
  let json;
  try {
    json = py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`);
  } catch (e) { return setDropMsg("Failed to read save: " + e.message, true); }
  saves = JSON.parse(json);
  if (!saves.length) { $("#editor").innerHTML = ""; return setDropMsg("No Suikoden III (USA) save found in that file.", true); }
  curSlot = 0;
  renderEditor();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- top-level editor render ----------------------------------------------
// Per-slot pending edits (reset when switching slots), mirroring the desktop editor.
let EDITS, INV, NAMES, PARTY, RECRUIT, GOLD, SUB, RECRUITED_ONLY, INVCAT, ADDED, SEARCH;

function renderEditor() {
  const ed = $("#editor");
  const slotBar = saves.length > 1
    ? `<div class="card"><div class="slotbar"><b>Save slot:</b>${saves.map((s, i) =>
        `<button class="chip${i === curSlot ? " on" : ""}" data-slot="${i}">${esc(s.label)}</button>`).join("")}
        <span class="muted" id="slotmeta" style="margin-left:auto"></span></div></div>`
    : "";
  ed.innerHTML = slotBar + `<div id="slotbody"></div>`;
  $$("[data-slot]", ed).forEach((b) => (b.onclick = () => { curSlot = +b.dataset.slot; renderEditor(); }));
  drawSlot();
}

function drawSlot() {
  const s = saves[curSlot];
  EDITS = {}; INV = {}; NAMES = {}; PARTY = {}; RECRUIT = {}; GOLD = null;
  SUB = "chars"; RECRUITED_ONLY = true; INVCAT = "regular"; ADDED = {}; SEARCH = "";

  const meta = s.meta || {};
  const leader = s.leaderName ? `Leader ${esc(s.leaderName)}`
    : `Leader id ${s.global.partyLeader} (guest/NPC)`;
  const metaBits = [
    meta.chapter != null ? `Chapter ${meta.chapter}` : null,
    s.global.playtime ? `Playtime ${s.global.playtime}` : null,
    leader, `Story phase ${s.global.storyPhase}`,
  ].filter(Boolean).join(" · ");

  const co = s.carryover || {};
  const coPill = (g, label) => g ? `<span class="pill${g.loaded ? " on" : ""}" title="${esc(g.hero || "")}">${label}: ${g.loaded ? "loaded (" + esc(g.hero) + ")" : "not detected"}</span>` : "";

  const names = (s.names || []).map((n) =>
    `<label class="field"><span>${esc(n.label)}</span>
       <input type="text" maxlength="${n.max}" value="${esc(n.value || "")}"
              data-name="${n.key}" data-def="${esc(n.value || "")}"></label>`).join("");

  const live = s.characters.filter((c) => c.recruited).length;
  const invCount = (s.inventory || []).reduce((a, b) => a + b.items.length, 0);

  if (saves.length > 1) $("#slotmeta").textContent =
    `${s.folder} · checksum 0x${(s.checksumWord >>> 0).toString(16).toUpperCase()}`;

  $("#slotbody").innerHTML = `
    <div class="card">
      <div class="muted" style="margin:-2px 0 8px">${metaBits}</div>
      <div class="row" style="margin-bottom:10px"><span class="muted">Carryover:</span>
        ${coPill(co.s1, "Suikoden I")}${coPill(co.s2, "Suikoden II")}</div>
      <h3 class="sec">Names</h3>
      <div class="grid" id="names">${names}</div>
      <h3 class="sec">Gold</h3>
      <label class="field" style="max-width:200px"><span>Gold / potch</span>
        <input type="number" min="0" max="999999999" id="goldfld"
               value="${s.global.gold || 0}" data-def="${s.global.gold || 0}"></label>
    </div>
    <div class="card">
      <div class="subtabs">
        <button class="chip" data-sub="chars">Characters (${live})</button>
        <button class="chip" data-sub="party">Party</button>
        <button class="chip" data-sub="items">Inventory (${invCount})</button>
      </div>
      <input class="search" id="sq" placeholder="filter…">
      <div class="muted" id="subhint" style="margin:2px 0 10px"></div>
      <div id="subview"></div>
      <div class="toolbar">
        <button class="primary" id="saveBtn">Apply &amp; download</button>
        <button id="resetBtn">Reset</button>
        <span class="status" id="status"></span>
      </div>
    </div>`;

  $$("input[data-name]").forEach((inp) => (inp.oninput = () => {
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    NAMES[inp.dataset.name] = inp.value;
  }));
  $("#goldfld").oninput = (e) => {
    e.target.classList.toggle("dirty", e.target.value !== e.target.dataset.def);
    GOLD = +e.target.value;
  };
  $$("[data-sub]").forEach((b) => (b.onclick = () => { SUB = b.dataset.sub; SEARCH = ""; $("#sq").value = ""; showSub(); }));
  $("#sq").oninput = (e) => { SEARCH = e.target.value.toLowerCase(); showSub(); };
  $("#saveBtn").onclick = saveAndDownload;
  $("#resetBtn").onclick = drawSlot;
  showSub();
}

function showSub() {
  $$("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === SUB));
  if (SUB === "chars") {
    $("#subhint").innerHTML = `Stats, equipped runes/armor, and skill slots per character. ` +
      `Tick <b>recruited</b> to add a not-yet-joined character (or untick to remove). ` +
      `<label style="cursor:pointer;margin-left:6px"><input type="checkbox" id="reconly" ${RECRUITED_ONLY ? "checked" : ""}> recruited only</label>`;
    drawChars();
    $("#reconly").onchange = (e) => { RECRUITED_ONLY = e.target.checked; drawChars(); };
  } else if (SUB === "party") {
    $("#subhint").innerHTML = `Active battle party (up to 6). Leaving story-required leaders in place avoids soft-locks.`;
    drawParty();
  } else {
    $("#subhint").innerHTML = `Party + storage items (id · quantity). Use <b>+ Add item</b> for an empty slot, ✕ to remove. New items default to qty 1.`;
    drawItems();
  }
}

// ---- Characters ------------------------------------------------------------
function drawChars() {
  const s = saves[curSlot];
  const pool = RECRUITED_ONLY ? s.characters.filter((c) => c.recruited) : s.characters.filter((c) => c.hasData || c.recruited);
  const shown = pool.filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);
  const box = $("#subview");
  box.innerHTML = shown.map(charCard).join("") || `<div class="muted">no characters</div>`;
  shown.forEach(wireChar);
}

const CHAR_CAP = { level: 99, curHP: 9999, maxHP: 9999, expToNext: 99999999 };
function charCard(c) {
  const num = (k, val, stat) => {
    const max = stat ? 999 : (CHAR_CAP[k] ?? 999999);
    return `<input type="number" min="0" max="${max}" value="${val}" data-ri="${c.rosterIndex}"` +
      (stat ? ` data-stat="${stat}"` : ` data-k="${k}"`) + ` data-def="${val}" title="0–${max}">`;
  };
  const statCells = STAT_NAMES().map((n) =>
    `<label class="field"><span>${n}</span>${num(null, c.stats[n], n)}</label>`).join("");
  const core = [["Level", "level"], ["Cur HP", "curHP"], ["Max HP", "maxHP"], ["EXP→next", "expToNext"]]
    .map(([lbl, k]) => `<label class="field"><span>${lbl}</span>${num(k, c[k])}</label>`).join("");
  const equip = EQ.map(([key, lbl]) => {
    const cur = c.equip[key] || 0;
    return `<label class="field"><span>${lbl}</span>
       <button type="button" class="picker" data-eqri="${c.rosterIndex}" data-eq="${key}" data-val="${cur}" data-def="${cur}">${esc(itemLabel(cur))}</button></label>`;
  }).join("");
  const skills = (c.skills || []).map((sk) =>
    `<div class="field"><span>Skill slot ${sk.slot + 1}</span>
       <button type="button" class="picker" data-skri="${c.rosterIndex}" data-skslot="${sk.slot}" data-skf="id" data-val="${sk.id}" data-def="${sk.id}">${esc(skillLabel(sk.id))}</button>
       <div class="row" style="gap:6px;margin-top:4px"><span class="muted">rank</span>
         <select style="flex:1" data-skri="${c.rosterIndex}" data-skslot="${sk.slot}" data-skf="rank" data-def="${sk.rank}">${rankSel(sk.rank)}</select></div></div>`).join("");
  return `<details class="char"><summary>
      <span class="chev">▸</span><span class="nm">${esc(c.name)}</span>
      <span class="muted">#${c.rosterIndex}</span>
      <span class="pill${c.recruited ? " on" : ""}">${c.recruited ? "recruited" : "not recruited"}</span>
      <span class="lv">Lv ${c.level} · HP ${c.maxHP}</span></summary>
    <div class="char-body" data-roster="${c.rosterIndex}">
      <div class="row" style="gap:16px;margin-top:4px">
        <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" data-recruit="${c.rosterIndex}" ${c.recruited ? "checked" : ""}> recruited</label>
        <label class="row" style="gap:6px">recruited by
          <select data-recruiter="${c.rosterIndex}">
            <option value="">— shared / story —</option>
            ${RECRUITERS.map((h) => `<option value="${h}"${c.recruiter === h ? " selected" : ""}>${h}</option>`).join("")}
          </select></label></div>
      <h4>Core</h4><div class="grid">${core}</div>
      <h4>Stats</h4><div class="grid">${statCells}</div>
      <h4>Equipment</h4><div class="grid eq">${equip}</div>
      <h4>Skills</h4><div class="grid sk">${skills}</div>
    </div></details>`;
}
function rankSel(cur) { return OPT_RANK.replace(`value="${cur}"`, `value="${cur}" selected`); }

function wireChar(c) {
  const body = $(`.char-body[data-roster="${c.rosterIndex}"]`);
  $$("input[data-ri]", body).forEach((inp) => (inp.onchange = () => {
    const ri = +inp.dataset.ri, v = +inp.value;
    EDITS[ri] = EDITS[ri] || {};
    if (inp.dataset.stat) { (EDITS[ri].stats = EDITS[ri].stats || {})[inp.dataset.stat] = v; }
    else EDITS[ri][inp.dataset.k] = v;
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
  }));
  $$("button.picker[data-eq]", body).forEach((btn) => (btn.onclick = () => {
    const ri = +btn.dataset.eqri, key = btn.dataset.eq, cur = +btn.dataset.val;
    openPicker(`Equip — ${key}`, eqList(key, cur), cur, (id) => {
      btn.dataset.val = id; btn.textContent = itemLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      EDITS[ri] = EDITS[ri] || {}; (EDITS[ri].equip = EDITS[ri].equip || {})[key] = id;
    });
  }));
  $$("button.picker[data-skf='id']", body).forEach((btn) => (btn.onclick = () => {
    const ri = +btn.dataset.skri, slot = +btn.dataset.skslot, cur = +btn.dataset.val;
    openPicker(`Skill slot ${slot + 1}`, skillList(), cur, (id) => {
      btn.dataset.val = id; btn.textContent = skillLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      EDITS[ri] = EDITS[ri] || {}; EDITS[ri].skills = EDITS[ri].skills || {};
      (EDITS[ri].skills[slot] = EDITS[ri].skills[slot] || {}).id = id;
    }, (id) => hx(id, 2));
  }));
  $$("select[data-skf='rank']", body).forEach((s2) => (s2.onchange = () => {
    const ri = +s2.dataset.skri, slot = +s2.dataset.skslot;
    EDITS[ri] = EDITS[ri] || {}; EDITS[ri].skills = EDITS[ri].skills || {};
    (EDITS[ri].skills[slot] = EDITS[ri].skills[slot] || {}).rank = +s2.value;
    s2.classList.toggle("dirty", s2.value !== s2.dataset.def);
  }));
  const recEntry = (ri) => (RECRUIT[ri] = RECRUIT[ri] || {});
  $$("input[data-recruit]", body).forEach((cb) => (cb.onchange = () => { recEntry(+cb.dataset.recruit).recruited = cb.checked; }));
  $$("select[data-recruiter]", body).forEach((se) => (se.onchange = () => {
    const ri = +se.dataset.recruiter, e = recEntry(ri); e.recruiter = se.value;
    const cb = $(`input[data-recruit="${ri}"]`, body);
    if (cb && !cb.checked) { cb.checked = true; e.recruited = true; }
  }));
}

// ---- Party -----------------------------------------------------------------
function drawParty() {
  const s = saves[curSlot];
  const mem = s.party || [];
  const anyFilled = mem.some((c) => c > 0);
  const rows = mem.map((cid, slot) => `<tr>
      <td class="sl">Slot ${slot + 1}</td>
      <td><button type="button" class="picker" data-partyslot="${slot}" data-val="${cid}" data-def="${cid}">${esc(charLabel(cid))}</button></td></tr>`).join("");
  $("#subview").innerHTML =
    (anyFilled ? "" : `<div class="warnbox">This save's active-party table is empty — common in early chapters where story events set the field party. Assignments here may be overwritten by the next event on a very early save.</div>`) +
    `<table class="invtbl"><thead><tr><th>Party</th><th>Character</th></tr></thead><tbody>${rows}</tbody></table>`;
  $$("button.picker[data-partyslot]").forEach((btn) => (btn.onclick = () => {
    const slot = +btn.dataset.partyslot, cur = +btn.dataset.val;
    openPicker(`Party slot ${slot + 1}`, charList(), cur, (id) => {
      btn.dataset.val = id; btn.textContent = charLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      PARTY[slot] = id;
    }, (id) => String(id).padStart(3, "0"));
  }));
}

// ---- Inventory -------------------------------------------------------------
function drawItems() {
  const s = saves[curSlot];
  const inv = s.inventory || [];
  const wantKey = INVCAT === "key";
  const nKey = inv.reduce((a, b) => a + b.items.filter((it) => it.category === "key").length, 0);
  const nReg = inv.reduce((a, b) => a + b.items.length, 0) - nKey;

  const rowHTML = (it) => `<tr>
      <td class="sl">${it.slot}</td>
      <td><button type="button" class="picker" data-invslot="${it.slot}" data-k="id" data-val="${it.id}" data-def="${it.id}">${esc(itemLabel(it.id))}</button></td>
      <td><input type="number" min="0" max="99" style="width:74px" data-invslot="${it.slot}" data-k="qty" data-def="${it.qty}" value="${it.qty}"></td>
      <td class="ty">${it.category}</td>
      <td><button class="rm mini" data-clearslot="${it.slot}" title="remove">✕</button></td></tr>`;

  const bags = inv.map((bag, bi) => {
    const items = bag.items.filter((it) => (it.category === "key") === wantKey &&
      (!SEARCH || (ITEM_BY_ID[it.id]?.name || "").toLowerCase().includes(SEARCH) ||
       String(it.slot) === SEARCH || it.id.toString(16).includes(SEARCH)));
    const added = (ADDED[bi] || []).map((sl) => ({ slot: sl, id: 0, qty: 0, category: wantKey ? "key" : "consumable" }));
    const list = items.concat(added);
    const free = (bag.freeSlots || []).filter((sl) => !(ADDED[bi] || []).includes(sl));
    const rows = list.map(rowHTML).join("") || `<tr><td colspan="5" class="muted">no items</td></tr>`;
    return `<div class="bag"><div class="bag-h">${esc(bag.region)}
        <span class="u">${bag.used}/${bag.capacity} slots</span>
        ${free.length ? `<button class="chip mini" data-addbag="${bi}" data-freeslot="${free[0]}">+ Add item</button>` : `<span class="u">bag full</span>`}</div>
      <table class="invtbl"><thead><tr><th>Slot</th><th>Item</th><th>Qty</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");

  $("#subview").innerHTML = `<div class="subtabs">
      <button class="chip${wantKey ? "" : " on"}" data-invcat="regular">Party Items (${nReg})</button>
      <button class="chip${wantKey ? " on" : ""}" data-invcat="key">Key / Valuables (${nKey})</button></div>
    <div class="muted" style="margin:-4px 2px 10px">Early game, Hugo / Chris / Geddoe carry separate bags (they merge after the Flame Champion is chosen).</div>
    ${bags || `<div class="muted">none</div>`}`;

  $$("[data-invcat]").forEach((b) => (b.onclick = () => { INVCAT = b.dataset.invcat; drawItems(); }));
  $$("input[data-invslot]").forEach((inp) => (inp.onchange = () => {
    const sl = +inp.dataset.invslot;
    (INV[sl] = INV[sl] || {}).qty = +inp.value;
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
  }));
  $$("button.picker[data-invslot]").forEach((btn) => (btn.onclick = () => {
    const sl = +btn.dataset.invslot, cur = +btn.dataset.val;
    openPicker("Choose item", itemList("empty"), cur, (id) => {
      btn.dataset.val = id; btn.textContent = itemLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      (INV[sl] = INV[sl] || {}).id = id;
    });
  }));
  $$("[data-addbag]").forEach((btn) => (btn.onclick = () => {
    const bi = +btn.dataset.addbag;
    ADDED[bi] = (ADDED[bi] || []).concat(+btn.dataset.freeslot); drawItems();
  }));
  $$("[data-clearslot]").forEach((btn) => (btn.onclick = () => {
    const sl = +btn.dataset.clearslot;
    INV[sl] = { id: 0, qty: 0 };
    Object.keys(ADDED).forEach((bi) => (ADDED[bi] = ADDED[bi].filter((x) => x !== sl)));
    drawItems();
  }));
}

// ---- Write & download ------------------------------------------------------
function hasChanges() {
  return Object.keys(EDITS).length || Object.keys(INV).length || Object.keys(NAMES).length ||
    Object.keys(PARTY).length || Object.keys(RECRUIT).length || GOLD !== null;
}

const RANK_LABEL = (v) => (RANK_TIERS.find((t) => t[0] === v) || [v, "?"])[1];

// Build a human-readable old→new list of everything the write will change.
function buildDiff() {
  const s = saves[curSlot];
  const rows = [];
  const byRi = {}; s.characters.forEach((c) => (byRi[c.rosterIndex] = c));
  const invBySlot = {}; (s.inventory || []).forEach((b) => b.items.forEach((it) => (invBySlot[it.slot] = it)));
  const FIELD_LABEL = { level: "Level", curHP: "Cur HP", maxHP: "Max HP", expToNext: "EXP→next" };

  if (GOLD !== null && GOLD !== s.global.gold) rows.push({ g: "Gold", t: `${s.global.gold} → ${GOLD}` });
  Object.entries(NAMES).forEach(([k, v]) => {
    const n = (s.names || []).find((x) => x.key === k);
    if (n && v !== n.value) rows.push({ g: "Names", t: `${n.label}: "${n.value}" → "${v}"` });
  });
  Object.entries(EDITS).forEach(([ri, f]) => {
    const c = byRi[ri] || byRi[+ri] || {}; const who = c.name || `#${ri}`;
    Object.entries(f).forEach(([k, v]) => {
      if (k === "stats") Object.entries(v).forEach(([st, nv]) => { if (nv !== c.stats?.[st]) rows.push({ g: who, t: `${st}: ${c.stats?.[st]} → ${nv}` }); });
      else if (k === "equip") Object.entries(v).forEach(([slot, nv]) => { if (nv !== (c.equip?.[slot] || 0)) rows.push({ g: who, t: `${slot}: ${itemLabel(c.equip?.[slot] || 0)} → ${itemLabel(nv)}` }); });
      else if (k === "skills") Object.entries(v).forEach(([slot, sk]) => {
        const cur = (c.skills || [])[+slot] || {};
        if ("id" in sk && sk.id !== cur.id) rows.push({ g: who, t: `Skill ${+slot + 1}: ${skillLabel(cur.id)} → ${skillLabel(sk.id)}` });
        if ("rank" in sk && sk.rank !== cur.rank) rows.push({ g: who, t: `Skill ${+slot + 1} rank: ${RANK_LABEL(cur.rank)} → ${RANK_LABEL(sk.rank)}` });
      });
      else if (FIELD_LABEL[k] && v !== c[k]) rows.push({ g: who, t: `${FIELD_LABEL[k]}: ${c[k]} → ${v}` });
    });
  });
  Object.entries(RECRUIT).forEach(([ri, v]) => {
    const who = (byRi[ri] || byRi[+ri] || {}).name || `#${ri}`;
    if ("recruited" in v) rows.push({ g: who, t: `Recruited: ${v.recruited ? "yes" : "no"}` });
    if (v.recruiter != null && v.recruiter !== "") rows.push({ g: who, t: `Recruited by: ${v.recruiter}` });
  });
  Object.entries(PARTY).forEach(([slot, cid]) => {
    const old = (s.party || [])[+slot] || 0;
    if (cid !== old) rows.push({ g: "Party", t: `Slot ${+slot + 1}: ${charLabel(old)} → ${charLabel(cid)}` });
  });
  Object.entries(INV).forEach(([slot, ent]) => {
    const old = invBySlot[slot] || { id: 0, qty: 0 };
    const nid = "id" in ent ? ent.id : old.id, nq = "qty" in ent ? ent.qty : old.qty;
    if (nid !== old.id || nq !== old.qty)
      rows.push({ g: "Inventory", t: `Slot ${slot}: ${itemLabel(old.id)} ×${old.qty} → ${itemLabel(nid)} ×${nq}` });
  });
  return rows;
}

function openConfirm(rows, onConfirm) {
  const groups = {}; rows.forEach((r) => (groups[r.g] = groups[r.g] || []).push(r.t));
  const body = Object.entries(groups).map(([g, ts]) =>
    `<div class="cf-group"><div class="cf-g">${esc(g)}</div>${ts.map((t) => `<div class="cf-row">${esc(t)}</div>`).join("")}</div>`).join("");
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal" role="dialog" aria-label="Review changes">
      <div class="modal-h"><b>Review changes (${rows.length})</b><button class="modal-x" aria-label="close">✕</button></div>
      <div class="cf-list">${body}</div>
      <div class="modal-f"><button id="cfCancel">Cancel</button>
        <button class="primary" id="cfOk">Apply &amp; download</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $(".modal-x", ov).onclick = close; $("#cfCancel", ov).onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#cfOk", ov).onclick = () => { close(); onConfirm(); };
}

async function saveAndDownload() {
  if (!hasChanges()) return setStatus("No changes to apply.", "warn");
  const diff = buildDiff();
  if (!diff.length) return setStatus("No effective changes (values match the save).", "warn");
  openConfirm(diff, doApply);
}

async function doApply() {
  const py = await pyReady;
  const s = saves[curSlot];
  const payload = { edits: EDITS, invEdits: INV, nameEdits: NAMES, partyEdits: PARTY, recruitEdits: RECRUIT, gold: GOLD };
  setStatus("Applying…", "");
  let res;
  try {
    const out = py.runPython(
      `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(s.folder)}, ${JSON.stringify(JSON.stringify(payload))})`);
    res = JSON.parse(out);
  } catch (e) { return setStatus("Write failed: " + e.message, "err"); }
  if (res.error) return setStatus("Write failed: " + res.error, "err");

  downloadBytes(py.FS.readFile(SAVE_PATH), downloadName());
  let msg = `Saved — ${res.changed} field(s) changed. Downloaded ${downloadName()}.`;
  if (res.warn) msg += " ⚠ " + res.warn;
  setStatus(msg, res.warn ? "warn" : "ok");

  saves = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));  // refresh from edited file
  drawSlot();
  setStatus(msg, res.warn ? "warn" : "ok");
}

function downloadName() {
  const dot = origName.lastIndexOf(".");
  const stem = dot > 0 ? origName.slice(0, dot) : origName;
  const ext = dot > 0 ? origName.slice(dot) : "";
  return `${stem}.edited${ext}`;
}
function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- misc ------------------------------------------------------------------
let _STAT_NAMES = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"];
function STAT_NAMES() { return _STAT_NAMES; }
function setStatus(msg, kind) { const el = $("#status"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } }
function setDropMsg(msg, isErr) { $("#engineStatus").innerHTML = (isErr ? "⚠ " : "") + msg; }
function bootProgress(pct, msg) {
  const el = $("#engineStatus"); if (!el) return;
  el.innerHTML = `<div class="bootmsg">${pct < 100 ? '<span class="spinner"></span>' : ""}${esc(msg)}</div>` +
    `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;
}
function dirtyNow() { try { return typeof EDITS !== "undefined" && hasChanges(); } catch (e) { return false; } }

// ---- wire up ---------------------------------------------------------------
// Theme switcher — same two themes as the desktop editor, persisted in localStorage.
function applyTheme(t) {
  document.documentElement.classList.toggle("theme-parchment", t === "parchment");
  $$("footer .tb").forEach((b) => b.classList.toggle("on", b.dataset.theme === t));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "parchment" ? "#cdbb95" : "#17110d";
  try { localStorage.setItem("s3theme", t); } catch (e) {}
}

window.addEventListener("DOMContentLoaded", () => {
  let theme = "crimson";
  try { theme = localStorage.getItem("s3theme") || "crimson"; } catch (e) {}
  applyTheme(theme);
  $$("footer .tb").forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)));

  const drop = $("#drop"), fileInput = $("#file"), pickBtn = $("#pickBtn");
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  // Guard against losing pending edits on accidental close/navigation.
  window.addEventListener("beforeunload", (e) => {
    if (dirtyNow()) { e.preventDefault(); e.returnValue = ""; }
  });

  pyReady = bootPyodide().then((py) => {
    setDropMsg("Python engine ready — load a save file.", false);
    pickBtn.disabled = false;
    return py;
  }).catch((e) => { setDropMsg("Engine failed to start: " + e.message, true); throw e; });

  // Register the service worker so the app is installable + works offline on Android.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));
  }

  // Custom "Install app" button. Chrome/Android fires beforeinstallprompt only when the app
  // is installable and not already installed — so the button appears exactly when it's useful.
  const installBtn = $("#installBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let deferredPrompt = null;
  if (!standalone) {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();                 // suppress the mini-infobar; use our button instead
      deferredPrompt = e;
      installBtn.classList.remove("hidden");
    });
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.classList.add("hidden");
    };
    window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
  }
});
