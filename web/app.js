// Suikoden III Save Editor — web front-end.
//
// The whole point of Option B: we do NOT reimplement any save logic in JS.
// We load the real, unmodified Editor/s3save.py into Pyodide (CPython-in-WASM),
// drop the uploaded save bytes into Pyodide's in-memory filesystem, and call the
// existing path-based functions (read_all_s3_saves / write_save_edits) exactly as
// the desktop server does. The edited file is read straight back out of MEMFS and
// handed to the browser as a download. No server, no upload — all on-device.

const SAVE_PATH = "/save.bin";          // where the upload lives inside Pyodide MEMFS
const STAT_NAMES = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"];
const CHAR_NUM_FIELDS = [               // scalar per-character fields (label, key, max)
  ["Level", "level", 99],
  ["Cur HP", "curHP", 9999],
  ["Max HP", "maxHP", 9999],
  ["EXP to next", "expToNext", 4294967295],
];

let pyReady = null;      // resolves to the pyodide instance
let saves = [];          // decoded saves for the loaded file (from read_all_s3_saves)
let curIdx = 0;          // selected slot index into `saves`
let origName = "save.bin";

const $ = (id) => document.getElementById(id);

// ---- Pyodide bootstrap -----------------------------------------------------
async function bootPyodide() {
  const py = await loadPyodide();
  // Pull the real module (and its optional field schema) from the sibling Editor dir.
  const src = await fetch("../Editor/s3save.py").then((r) => {
    if (!r.ok) throw new Error("could not fetch s3save.py (" + r.status + ")");
    return r.text();
  });
  py.FS.writeFile("s3save.py", src);
  // Helper glue that stays in Python so all byte-twiddling runs in the real module.
  py.runPython(`
import json, s3save

def load_saves(path):
    out = []
    for dec in s3save.read_all_s3_saves(path):
        chars = [
            {"rosterIndex": c["rosterIndex"], "name": c["name"], "level": c["level"],
             "curHP": c["curHP"], "maxHP": c["maxHP"], "expToNext": c["expToNext"],
             "stats": c["stats"], "hasData": c["hasData"], "recruited": c["recruited"]}
            for c in dec["characters"]
        ]
        out.append({
            "folder": dec["folder"], "label": dec["label"], "size": dec["size"],
            "global": {"gold": dec["global"]["gold"],
                       "playtime": dec["global"]["playtime"],
                       "partyLeader": dec["global"].get("partyLeader"),
                       "storyPhase": dec["global"].get("storyPhase")},
            "names": dec["names"], "characters": chars,
        })
    return json.dumps(out)

def apply_edits(path, folder, payload_json):
    p = json.loads(payload_json)
    # JSON object keys are strings; write_save_edits/apply expect int roster indexes.
    edits = {int(k): v for k, v in (p.get("edits") or {}).items()}
    res = s3save.write_save_edits(
        path, folder, edits,
        make_backup=False,
        name_edits=p.get("name_edits") or None,
        gold=p.get("gold"),
    )
    return json.dumps(res)
`);
  return py;
}

// ---- File loading ----------------------------------------------------------
async function handleFile(file) {
  const py = await pyReady;
  origName = file.name || "save.bin";
  const buf = new Uint8Array(await file.arrayBuffer());
  py.FS.writeFile(SAVE_PATH, buf);
  let json;
  try {
    json = py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`);
  } catch (e) {
    return setStatus("Failed to read save: " + e.message, "err");
  }
  saves = JSON.parse(json);
  if (!saves.length) {
    $("saveCard").classList.add("hidden");
    return setDropMsg("No Suikoden III (USA) save found in that file.", true);
  }
  curIdx = 0;
  buildSlotPicker();
  render();
  $("saveCard").classList.remove("hidden");
  setStatus(`Loaded ${saves.length} save${saves.length > 1 ? "s" : ""} from ${origName}.`, "ok");
  $("saveCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Rendering -------------------------------------------------------------
function buildSlotPicker() {
  const sel = $("slotPick");
  sel.innerHTML = "";
  saves.forEach((s, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${s.label} — ${s.global.playtime}, ${s.global.gold.toLocaleString()}g`;
    sel.appendChild(o);
  });
  $("slotWrap").classList.toggle("hidden", saves.length < 2);
  sel.onchange = () => { curIdx = +sel.value; render(); };
}

function numField(label, value, key, max, dataAttrs, readonly) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  wrap.appendChild(span);
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = 0; inp.max = max; inp.step = 1;
  inp.value = value;
  if (readonly) { inp.disabled = true; inp.classList.add("ro"); }
  inp.dataset.orig = String(value);
  Object.entries(dataAttrs || {}).forEach(([k, v]) => (inp.dataset[k] = v));
  inp.oninput = () => inp.classList.toggle("dirty", inp.value !== inp.dataset.orig);
  wrap.appendChild(inp);
  return wrap;
}

function render() {
  const s = saves[curIdx];

  // Overview: gold editable, playtime/story read-only context.
  const g = $("globals");
  g.innerHTML = "";
  g.appendChild(numField("Gold", s.global.gold, null, 99999999, { role: "gold" }));
  g.appendChild(roText("Playtime", s.global.playtime));
  if (s.global.storyPhase != null) g.appendChild(roText("Story phase", s.global.storyPhase));

  // Names (fixed-width strings inside the save).
  const nm = $("names");
  nm.innerHTML = "";
  s.names.forEach((n) => {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const span = document.createElement("span");
    span.textContent = n.label;
    const inp = document.createElement("input");
    inp.type = "text"; inp.maxLength = n.max; inp.value = n.value;
    inp.dataset.orig = n.value; inp.dataset.nameKey = n.key;
    inp.oninput = () => inp.classList.toggle("dirty", inp.value !== inp.dataset.orig);
    wrap.append(span, inp);
    nm.appendChild(wrap);
  });

  // Characters — only meaningful ones, collapsed by default.
  const box = $("chars");
  box.innerHTML = "";
  s.characters.filter((c) => c.hasData).forEach((c) => {
    const d = document.createElement("details");
    d.className = "char";
    const sum = document.createElement("summary");
    sum.innerHTML = `<span class="chev">▸</span><span class="nm">${escapeHtml(c.name)}</span>` +
      (c.recruited ? `<span class="pill">recruited</span>` : "") +
      `<span class="lv">Lv ${c.level} · HP ${c.maxHP}</span>`;
    d.appendChild(sum);
    const body = document.createElement("div");
    body.className = "char-body";
    body.dataset.roster = c.rosterIndex;

    const h1 = document.createElement("h3"); h1.textContent = "Core"; body.appendChild(h1);
    const core = document.createElement("div"); core.className = "grid";
    CHAR_NUM_FIELDS.forEach(([label, key, max]) =>
      core.appendChild(numField(label, c[key], key, max, { field: key })));
    body.appendChild(core);

    const h2 = document.createElement("h3"); h2.textContent = "Stats"; body.appendChild(h2);
    const stats = document.createElement("div"); stats.className = "grid";
    STAT_NAMES.forEach((st) =>
      stats.appendChild(numField(st, c.stats[st], st, 999, { stat: st })));
    body.appendChild(stats);

    d.appendChild(body);
    box.appendChild(d);
  });
  setStatus("");
}

function roText(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `<span>${label}</span><input type="text" class="ro" disabled value="${escapeHtml(String(value))}">`;
  return wrap;
}

// ---- Collect edits & write -------------------------------------------------
function collectPayload() {
  const s = saves[curIdx];
  const payload = { edits: {}, name_edits: {} };

  const goldInp = $("globals").querySelector('[data-role="gold"]');
  if (goldInp && goldInp.value !== goldInp.dataset.orig) payload.gold = +goldInp.value;

  $("names").querySelectorAll("input[data-name-key]").forEach((inp) => {
    if (inp.value !== inp.dataset.orig) payload.name_edits[inp.dataset.nameKey] = inp.value;
  });

  $("chars").querySelectorAll(".char-body").forEach((body) => {
    const ridx = body.dataset.roster;
    const one = {};
    body.querySelectorAll("input[data-field]").forEach((inp) => {
      if (inp.value !== inp.dataset.orig) one[inp.dataset.field] = +inp.value;
    });
    const statChanges = {};
    body.querySelectorAll("input[data-stat]").forEach((inp) => {
      if (inp.value !== inp.dataset.orig) statChanges[inp.dataset.stat] = +inp.value;
    });
    if (Object.keys(statChanges).length) one.stats = statChanges;
    if (Object.keys(one).length) payload.edits[ridx] = one;
  });

  const hasChanges = payload.gold != null ||
    Object.keys(payload.name_edits).length || Object.keys(payload.edits).length;
  return hasChanges ? payload : null;
}

async function saveAndDownload() {
  const payload = collectPayload();
  if (!payload) return setStatus("No changes to apply.", "warn");
  const py = await pyReady;
  const s = saves[curIdx];
  setStatus("Applying…", "");
  let res;
  try {
    const out = py.runPython(
      `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(s.folder)}, ` +
      `${JSON.stringify(JSON.stringify(payload))})`);
    res = JSON.parse(out);
  } catch (e) {
    return setStatus("Write failed: " + e.message, "err");
  }
  if (res.error) return setStatus("Write failed: " + res.error, "err");

  const bytes = py.FS.readFile(SAVE_PATH);           // pull edited container back out
  downloadBytes(bytes, downloadName());
  let msg = `Saved — ${res.changed} field(s) changed. Downloaded ${downloadName()}.`;
  if (res.warn) msg += " ⚠ " + res.warn;
  setStatus(msg, res.warn ? "warn" : "ok");

  // Refresh the decoded view from the now-edited file so the UI matches what's on disk.
  saves = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));
  render();
}

function downloadName() {
  const dot = origName.lastIndexOf(".");
  const stem = dot > 0 ? origName.slice(0, dot) : origName;
  const ext = dot > 0 ? origName.slice(dot) : "";
  return `${stem}.edited${ext}`;
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---- misc ------------------------------------------------------------------
function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
function setDropMsg(msg, isErr) {
  $("engineStatus").innerHTML = (isErr ? "⚠ " : "") + msg;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- wire up ---------------------------------------------------------------
window.addEventListener("DOMContentLoaded", () => {
  const drop = $("drop"), fileInput = $("file"), pickBtn = $("pickBtn");
  pickBtn.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });
  $("saveBtn").onclick = saveAndDownload;
  $("resetBtn").onclick = () => render();

  pyReady = bootPyodide().then((py) => {
    setDropMsg("Python engine ready — load a save file.", false);
    pickBtn.disabled = false;
    return py;
  }).catch((e) => {
    setDropMsg("Engine failed to start: " + e.message, true);
    throw e;
  });
});
