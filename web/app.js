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
// equipment slots (order + keys match s3save.EQUIP_SLOTS) and the item categories that fit.
// Both tables live in health-core.js so the pickers and the health audit can't disagree
// about what belongs in a slot.
const EQ = Object.entries(HealthCore.SLOT_LABEL);
const EQ_CATS = HealthCore.SLOT_CATS;
const RECRUITERS = ["Hugo", "Chris", "Geddoe", "Thomas"];

let pyReady = null, PY = null;   // PY = resolved pyodide (sync access keeps share() in-gesture)
let REF = { items: [], skills: [], charById: {}, charRoster: {}, charChoices: [], fieldAvatars: [] };
let ITEM_BY_ID = {}, saves = [], curSlot = 0, origName = "save.bin";
// File System Access API (desktop Chromium): lets us overwrite the original file in place
// instead of downloading a copy. Absent on Android/Firefox/Safari → we fall back to download.
let fileHandle = null;
const SUPPORTS_FS = typeof window !== "undefined" && "showOpenFilePicker" in window;
// "Save as…" (desktop Chromium): a native save dialog to choose the destination/name — lets
// you overwrite the original card or save a copy anywhere. Absent on Android/Firefox/Safari.
const SUPPORTS_SAVE_PICKER = typeof window !== "undefined" && "showSaveFilePicker" in window;
// Whether downloaded/shared copies get a ".edited" suffix. Default OFF — the download/share
// keeps the original filename so it can overwrite the source card; tick the box to add ".edited".
let ADD_SUFFIX = (() => { try { return localStorage.getItem("s3suffix") === "on"; } catch (e) { return false; } })();
// Web Share with files (Android Chrome): send the edited save straight to another app.
const CAN_SHARE_FILES = (() => {
  try { return !!(navigator.canShare && navigator.canShare({ files: [new File([new Blob([1])], "t.bin")] })); }
  catch (e) { return false; }
})();
const SHARE_CACHE = "s3editor-share";   // must match sw.js (share-target hand-off)

// ---- tiny IndexedDB kv (remembers the last opened save across sessions) ----
const IDB_DB = "s3editor", IDB_STORE = "kv";
function _idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
async function idbGet(k) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readonly"); const q = t.objectStore(IDB_STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function idbDel(k) { const db = await _idb(); return new Promise((res, rej) => { const t = db.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
let OPT_RANK = "";   // rank stays a small native <select>; other lists use pickers

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const hx = (n, w) => n.toString(16).toUpperCase().padStart(w, "0");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- Pyodide bootstrap -----------------------------------------------------
async function bootPyodide() {
  bootProgress(10, "Downloading Python runtime…", "rt");
  const py = await loadPyodide();
  bootProgress(55, "Loading save module…", "mod");
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
  // Rune/food descriptions (runes+food have no equipment desc-record) + rich per-rank skill
  // effects — pre-extracted from the ISO / guides so the save editor (no ISO) can show them too.
  const grabOpt = async (u) => { try { const r = await fetch(u); return r.ok ? await r.text() : "{}"; } catch (e) { return "{}"; } };
  py.FS.writeFile("itemdescextra.json", await grabOpt("../Editor/s3_rune_food_desc.json"));
  py.FS.writeFile("skillref.json", await grabOpt("../Editor/s3_skill_ref.json"));
  bootProgress(80, "Parsing reference tables…", "ref");

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

def _skill_effect_text(ref, sid):
    r = ref.get(str(sid))
    if not r: return ""
    t = r.get("desc", "")
    effs = r.get("effects") or []
    if effs:
        e = effs[0]; ranks = e.get("ranks", {})
        span = " · ".join(f"{g} {ranks[g]}" for g in ("E","A","S") if ranks.get(g))
        if span: t += f"  [{e.get('label','')}: {span}]"
    return t

def load_reference():
    it = open("items.txt", encoding="latin1").read()
    ids, cats = _item_ids(it), _item_cats(it)
    idesc = {int(k): v for k, v in json.load(open("itemdesc.json")).items()}
    extra = {int(k): v for k, v in json.load(open("itemdescextra.json")).items()}   # rune/food
    sdesc = json.load(open("skilldesc.json"))     # keyed by skill NAME
    sref  = json.load(open("skillref.json"))      # keyed by skill id str: {desc, effects}
    items = [{"id": k, "name": v, "cat": cats.get(k, ""), "desc": extra.get(k) or idesc.get(k, "")}
             for k, v in sorted(ids.items())]
    skills = [{"id": k, "name": v, "desc": _skill_effect_text(sref, k) or sdesc.get(v, "")}
              for k, v in sorted(_skill_ids(open("skills.txt", encoding="latin1").read()).items())]
    # Party slots and the leader byte speak s3save.PARTY_IDS, NOT the exe list1 ids the
    # rest of the reference data uses (see the PARTY_IDS comment in s3save.py). charById is
    # read by the party picker, the leader line and the health audit, so it is that space.
    ref = s3save.party_reference()
    charById = {str(k): v for k, v in ref["names"].items()}
    charRoster = {str(k): v for k, v in ref["roster"].items()}
    return json.dumps({"items": items, "skills": skills, "charById": charById,
                       "charRoster": charRoster, "charChoices": ref["choices"],
                       "fieldAvatars": ref["fieldAvatars"],
                       "carryover": s3save.carryover_reference(),
                       "trinity": s3save.trinity_reference()})

def load_saves(path):
    charById = s3save.party_reference()["names"]
    out = []
    for dec in s3save.read_all_s3_saves(path):
        for c in dec["characters"]:
            c.pop("raw", None)                 # drop the 140-byte dump from the payload
        lid = dec["global"].get("partyLeader")
        dec["leaderName"] = charById.get(lid, "")
        out.append(dec)
    return json.dumps(out)

def apply_edits(path, folder, payload_json):
    p = json.loads(payload_json)
    edits = {int(k): v for k, v in (p.get("edits") or {}).items()}
    inv   = {int(k): v for k, v in (p.get("invEdits") or {}).items()}
    party = {int(k): v for k, v in (p.get("partyEdits") or {}).items()}
    pmount = {int(k): int(v) for k, v in (p.get("partyMountEdits") or {}).items()}
    rec   = {int(k): v for k, v in (p.get("recruitEdits") or {}).items()}
    res = s3save.write_save_edits(
        path, folder, edits, make_backup=False,
        inv_edits=inv or None, name_edits=(p.get("nameEdits") or None),
        party_edits=party or None, recruit_edits=rec or None, gold=p.get("gold"),
        party_mount_edits=pmount or None,
        leader=p.get("leader"), carryover=(p.get("carryover") or None),
        trinity=(p.get("trinity") or None))
    return json.dumps(res)

def carryover_bonus(payload_json):
    """"They were level N with these runes in my Suikoden II save" -> character edits,
    using the importer's own formulas (see s3save.carryover_*)."""
    req = {int(k): v for k, v in json.loads(payload_json).items()}
    return json.dumps(s3save.carryover_bonus_edits(req))
`);
  REF = JSON.parse(py.runPython("load_reference()"));
  REF.items.forEach((i) => (ITEM_BY_ID[i.id] = i));
  REF.skills.forEach((s) => (SKILL_BY_ID[s.id] = s));
  // Party picker list (id · name), in roster order. REF.charChoices is the pickable subset —
  // the battle characters that have a character block — so the named-but-unpickable ids
  // (Koroku's dogs, the Special Characters) label an existing slot without being offered.
  CHAR_LIST = REF.charChoices.map((id) => ({ id, name: REF.charById[id] }));
  OPT_RANK = RANK_TIERS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  PY = py;
  bootProgress(100, "Ready", "done");
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
// Party-slot options. A slot can legitimately already hold an id with no character block —
// a guest, one of Koroku's dogs, a Special Character — so the current value is appended when
// it isn't one of the pickable battle characters, and re-choosing it is a no-op rather than
// an id the list can't express.
function charList(curId) {
  const list = [{ id: 0, name: "empty" }, ...CHAR_LIST];
  if (curId && !CHAR_LIST.some((c) => c.id === curId))
    list.push({ id: curId, name: REF.charById[curId] || "id " + curId + " (guest/NPC)" });
  return list;
}

// What playing each one actually turned up, keyed by field-avatar id. Only ids with a verdict
// appear; everything else is simply untried, and saying nothing is more honest than a guess.
//
// Koroku is the one real casualty. His model is animal-rigged: the disc's motion table asks for
// named clips per slot, and his model carries none of the fourteen `check_*` / `pickup_*` ones
// that examining and picking things up use, where Luc's carries them. Three separate patches
// were built and played against it — see docs/FIELD_CHARACTER_RESEARCH.md — and none worked, so
// it is a documented limitation rather than a bug with a fix pending.
const AVATAR_NOTES = {
  54: { ok: false, short: "field pickups freeze",
        long: "No humanoid animation cycle — he's animal-rigged, and his model has none of the "
            + "examine/pick-up clips. Picking up a herb or looting a skeleton freezes the game. "
            + "Walking, running, battles, conversation and cutscenes are all fine." },
  63: { ok: true, short: "confirmed working",
        long: "Played through with no problems, including picking up the same objects Koroku "
            + "freezes on." },
};

// Field-avatar picker. Deliberately offers ONLY the ids the engine will load by itself —
// s3save.FIELD_AVATAR_IDS, the comparison chain at vaddr 0x17B7560. Widening that chain is
// possible (ISO Editor -> Test -> Field character) but it is experimental and hangs scenes,
// so the save editor stays on the set the game actually ships. Anything already in the save
// that isn't offerable is kept rather than dropped, or Apply would silently rewrite it.
function avatarList(curId) {
  const named = (id) => REF.charById[id] || "id " + id + " (guest/NPC)";
  // The rows used to carry a per-area coverage note ("ships in N/28 maps"), on the theory
  // that a model the area archive doesn't ship wouldn't load. Play testing says otherwise:
  // every one of these worked in every area it was tried in, so the note is gone rather
  // than left to scare people off picks that work.
  const list = (REF.fieldAvatars || []).map((id) => {
    const n = AVATAR_NOTES[id];
    return { id, name: named(id),
      cat: n && !n.ok ? "has a known problem" : STORY_SAFE.has(id) ? "protagonist" : "roaming only",
      // a known verdict outranks the generic blurb — it is the thing that decides the pick
      desc: (n ? n.long
               : STORY_SAFE.has(id) ? "a protagonist — scenes are written for them"
               : "the game ships this one; scenes work once it's in party slot 1 with the "
                 + "stand-in removed") };
  });
  if (curId && !list.some((c) => c.id === curId))
    list.unshift({ id: curId, name: named(curId), cat: "current", desc: "this save's current value" });
  return list;
}
// Put `id` in party slot 1, and by default remove whoever they are standing in for.
//
// Two conditions, both confirmed in play (2026-08-31), and the second one is the surprise:
//
//   1. the field character must be in **party slot 1** — actor slot 0 is party position 1,
//      and scripts drive the protagonist as that slot while the camera follows the leader
//      byte, so if they disagree a scene animates one actor and waits on another; and
//   2. the character being stood in for must **not also be in the party**. Keeping them
//      anywhere in the party freezes the scene; removing them makes it play. Tested both
//      ways round: [Koroku, ..., Hugo] freezes, [Koroku, ...] plays.
//
// So `remove` is the default, because it is the configuration that works. `keep` preserves
// the old swap for anyone who wants their party intact and will accept the freeze.
//
// Returns { party: sparse {slot: id} of changes, note, displaced }.
function promoteToLead(cur, id, nm, keep) {
  const at = cur.indexOf(id), was = cur[0];
  if (at === 0) return { party: [], note: "", displaced: 0 };
  const party = [];
  party[0] = id;
  if (at > 0) party[at] = keep ? was : 0;            // vacate where the pick came from
  let note;
  if (!was) {
    note = `Put ${nm(id)} in party slot 1.`;
  } else if (keep) {
    const free = cur.findIndex((v, i) => i > 0 && !v);
    if (at > 0) note = `Swapped ${nm(id)} into party slot 1 with ${nm(was)} (now slot ${at + 1}).`;
    else if (free > 0) { party[free] = was; note = `Put ${nm(id)} in party slot 1 and moved ${nm(was)} to slot ${free + 1}.`; }
    else note = `Put ${nm(id)} in party slot 1 — the party was full, so ${nm(was)} was dropped.`;
    note += ` ${nm(was)} is still in the party, which has been seen to FREEZE scripted scenes.`;
  } else {
    note = `Put ${nm(id)} in party slot 1 and removed ${nm(was)} from the party — `
         + `a scene that stages them as well would bind two actors to their one model, `
         + `which freezes it.`;
  }
  return { party, displaced: was || 0, note };
}

// The four the story is authored around. Everything else — even ids the engine ships, like
// Koroku — has been seen to hang a scripted scene.
const STORY_SAFE = new Set([1, 2, 3, 29]);

// Open the shared picker modal. list=[{id,name,cat?,desc?}]; onPick(id) fires on choose.
// idFmt formats the id prefix per domain (3-hex items, 2-hex skills, decimal chars).
// Shared modal accessibility: focus the initial element, trap Tab within the overlay,
// close on Escape, and restore focus to the opener. Returns a wrapped close() to use everywhere.
function modalA11y(ov, closeFn, initial) {
  const prev = document.activeElement;
  const SEL = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const focusables = () => $$(SEL, ov).filter((el) => !el.disabled && el.offsetParent !== null);
  const close = () => { document.removeEventListener("keydown", onKey, true); closeFn(); if (prev && prev.focus) try { prev.focus(); } catch (e) {} };
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      const f = focusables(); if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => { const t = initial || focusables()[0]; if (t && t.focus) t.focus(); }, 30);
  return close;
}

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
  let close = () => ov.remove();

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
  close = modalA11y(ov, () => ov.remove(), search);   // focus trap + Esc + focus restore
  $(".modal-x", ov).onclick = () => close();
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

// ---- File loading ----------------------------------------------------------
// Open via the File System Access picker so we retain a writable handle (desktop only).
async function openViaPicker() {
  try {
    const [h] = await window.showOpenFilePicker({ multiple: false });
    fileHandle = h;
    await handleFile(await h.getFile(), h);
  } catch (e) {
    if (e && e.name !== "AbortError") setDropMsg("Could not open file: " + e.message, true);
  }
}
async function ensureWritable(h) {
  const opts = { mode: "readwrite" };
  if ((await h.queryPermission(opts)) === "granted") return true;
  return (await h.requestPermission(opts)) === "granted";
}

async function handleFile(file, handle) {
  const py = await pyReady;
  fileHandle = handle || null;              // plain <input>/drag-drop have no handle
  origName = file.name || "save.bin";
  const bytes = new Uint8Array(await file.arrayBuffer());
  py.FS.writeFile(SAVE_PATH, bytes);
  let json;
  try {
    json = py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`);
  } catch (e) { return setDropMsg("Failed to read save: " + e.message, true); }
  saves = JSON.parse(json);
  if (!saves.length) { $("#editor").innerHTML = ""; return setDropMsg("No Suikoden III (USA) save found in that file.", true); }
  curSlot = 0;
  setDropMsg("Python engine ready — load a save file.", false);   // clear any prior "no save found" error
  rememberSave(origName, bytes, fileHandle);   // persist for one-tap reopen next visit
  renderEditor();
  $("#editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- remember last opened save --------------------------------------------
function rememberSave(name, bytes, handle) {
  // store a copy of the bytes + name (+ the writable handle on desktop, for in-place reopen)
  idbSet("lastSave", { name, bytes, handle: handle || null, at: Date.now() }).catch(() => {});
}
async function showRecent() {
  const el = $("#recent"); if (!el) return;
  let rec; try { rec = await idbGet("lastSave"); } catch (e) { return; }
  if (!rec) { el.innerHTML = ""; return; }
  const kb = Math.round((rec.bytes?.length || 0) / 1024);
  el.innerHTML = `<div class="recent">Last opened:
      <button class="chip" id="reopenBtn">↻ ${esc(rec.name)} <span class="muted">(${kb} KB)</span></button>
      <button class="chip mini" id="forgetBtn" title="forget">✕</button></div>`;
  $("#reopenBtn").onclick = () => reopenLast(rec);
  $("#forgetBtn").onclick = async () => { await idbDel("lastSave").catch(() => {}); el.innerHTML = ""; };
}
async function reopenLast(rec) {
  // Prefer the stored handle (re-grant permission → enables save-in-place) then fall back to bytes.
  if (SUPPORTS_FS && rec.handle) {
    try {
      if (await ensureWritable(rec.handle)) return handleFile(await rec.handle.getFile(), rec.handle);
    } catch (e) { /* handle stale/denied → fall back to stored bytes */ }
  }
  handleFile(new File([rec.bytes], rec.name));
}

// ---- Web Share Target: a save shared INTO the installed PWA ----------------
async function pickupSharedFile() {
  if (!new URLSearchParams(location.search).has("shared")) return false;
  history.replaceState({}, "", location.pathname);      // drop ?shared=1
  try {
    const c = await caches.open(SHARE_CACHE);
    const res = await c.match("shared-save");
    if (res) {
      const blob = await res.blob();
      const name = decodeURIComponent(res.headers.get("X-Filename") || "shared.bin");
      await c.delete("shared-save");
      await handleFile(new File([blob], name));
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

// ---- top-level editor render ----------------------------------------------
// Per-slot pending edits (reset when switching slots), mirroring the desktop editor.
let EDITS, INV, NAMES, PARTY, PMOUNT, RECRUIT, GOLD, LEADER, SUB, RECRUITED_ONLY, INVCAT, ADDED, SEARCH;
// Who slot 1 held before the last field-character pick, so the UI can offer to drop them.
let DISPLACED = 0;
// Pending carryover-flag edits: {s1?: bool, s2?: bool}. Separate from EDITS because the
// flags are whole-save state, not a character field.
let CARRY;
// Pending Trinity Sight edits: {lit: {povKey: bool}, stage: {povKey|"main": value}}. Same
// reason as CARRY — the flame mask and the progress counters are whole-save state.
let TRIN;
// Trinity Sight fold state, kept across slot switches like the carryover one.
let TRFOLD = false;
let refreshTrFold = () => {};
// Carryover + names fold: whole-save state you set once and never touch again, so it starts
// closed and stays as the user last left it across slot switches and Reset.
let COFOLD = false;
// Set by drawSlot; openCarryoverBonus ticks the s2 box from outside and has to keep the
// collapsed header's edit count honest.
let refreshCoFold = () => {};

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
  EDITS = {}; INV = {}; NAMES = {}; PARTY = {}; PMOUNT = {}; RECRUIT = {}; GOLD = null; LEADER = null; CARRY = {};
  TRIN = { lit: {}, stage: {} };
  SUB = "chars"; RECRUITED_ONLY = true; INVCAT = "regular"; ADDED = {}; SEARCH = "";

  const meta = s.meta || {};
  const leader = s.leaderName ? `Leader ${esc(s.leaderName)}`
    : `Leader id ${s.global.partyLeader} (guest/NPC)`;
  const metaBits = [
    meta.chapter != null ? `Chapter ${meta.chapter}` : null,
    s.global.playtime ? `Playtime ${s.global.playtime}` : null,
    // The phase byte names the point of view the save is being played from, so say which
    // one rather than leaving a bare number (s3save.PHASE_POV).
    leader, `Story phase ${s.global.storyPhase}` +
      (((REF.trinity || {}).phaseNames || {})[String(s.global.storyPhase)]
        ? ` · ${(REF.trinity.phaseNames || {})[String(s.global.storyPhase)]}` : ""),
  ].filter(Boolean).join(" · ");

  const co = s.carryover || {};
  const CR = REF.carryover || { chars: [], runes: [], flags: {} };
  // One row per game: the real flag bit, plus what its name slots currently hold. The
  // offset/mask is shown because it is the whole answer — anyone poking the save by hand
  // wants byte 0x31, not a heuristic.
  const coRow = (g, label) => {
    const f = co[g]; if (!f) return "";
    const on = CARRY[g] !== undefined ? CARRY[g] : f.loaded;
    const where = `0x${hx(f.flagOffset, 2)} bit ${f.flagBit} (mask 0x${hx(f.flagMask, 2)})`;
    return `<label class="row" style="gap:8px;cursor:pointer;align-items:baseline">
      <input type="checkbox" data-carry="${g}"${on ? " checked" : ""}${on !== f.loaded ? ' class="dirty"' : ""}>
      <b>${label} data loaded</b>
      <span class="muted" style="font-size:12px">${where} · ${esc(Object.values(f.names || {}).join(" / "))}${f.customNames ? "" : " (defaults)"}</span></label>`;
  };

  // The collapsed header has to answer "do I need to open this?" on its own: the flag state,
  // the two player-entered names, and — since a fold can hide staged edits — whether anything
  // in there is currently dirty.
  const coFoldSummary = () => {
    const bits = ["s2", "s1"].filter((g) => co[g]).map((g) => {
      const on = CARRY[g] !== undefined ? CARRY[g] : co[g].loaded;
      return `${g === "s2" ? "Suikoden II" : "Suikoden I"} ${on ? "loaded" : "not loaded"}`;
    });
    ["flameChampion", "castle"].forEach((k) => {
      const n = (s.names || []).find((x) => x.key === k);
      const v = n && (NAMES[k] !== undefined ? NAMES[k] : n.value);
      if (v) bits.push(v);
    });
    // Same no-op filter buildDiff() uses: a name typed back to what the save already holds
    // is not an edit, and the header must not claim it is.
    const edits = Object.keys(CARRY).length + Object.entries(NAMES)
      .filter(([k, v]) => { const n = (s.names || []).find((x) => x.key === k); return n && v !== n.value; }).length;
    return bits.map(esc).join(" · ") + (edits ? ` · <b class="fold-edited">${edits} edit(s)</b>` : "");
  };

  // ---- Trinity Sight (the chapter-select screen) ---------------------------
  // Three pieces of save state, and they are the three the game's own menu builder reads:
  // the six-bit flame mask at 0x34, and one progress counter per point of view in the bank
  // at 0x3B0 (s3save: TRINITY_POVS / STAGE_BASE — the disassembly is in the comment there).
  // Not yet play-tested, which the panel says out loud rather than implying confidence the
  // research does not have.
  const tr = s.trinity || { povs: [], main: {} };
  const TR = REF.trinity || { povs: [], main: { chapters: [], labels: {} } };
  const trRef = (k) => TR.povs.find((p) => p.key === k) || { chapters: [] };
  const trLit = (p) => (TRIN.lit[p.key] !== undefined ? TRIN.lit[p.key] : p.lit);
  const trStage = (key, cur) => (TRIN.stage[key] !== undefined ? TRIN.stage[key] : cur);
  // A stage the save holds that is not one of the chapter-opening values (a mid-chapter
  // save, which is most of them) still has to be selectable, or opening the panel and
  // touching nothing would silently propose moving the player back to a chapter start.
  const trOpts = (rows, cur, zero) => {
    const opts = [{ v: 0, l: zero }].concat(rows.map((r) => ({ v: r.value, l: r.label })));
    if (cur && !opts.some((o) => o.v === cur)) opts.push({ v: cur, l: `stage ${cur} (as saved)` });
    return opts.sort((x, y) => x.v - y.v);
  };
  const trRow = (p) => {
    const ref = trRef(p.key);
    const rows = ref.chapters.map((c) => ({ value: c.value, label: `Chapter ${c.chapter}` }));
    const cur = trStage(p.key, p.stage);
    const on = trLit(p);
    const opts = trOpts(rows, p.stage, "— not started —").map((o) =>
      `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${esc(o.l)}</option>`).join("");
    return `<div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
      <label class="row" style="gap:6px;cursor:pointer;min-width:150px;align-items:baseline">
        <input type="checkbox" data-tflame="${p.key}"${on ? " checked" : ""}${on !== p.lit ? ' class="dirty"' : ""}>
        <b>Flame ${p.flame} · ${esc(p.name)}</b></label>
      <select data-tstage="${p.key}" data-def="${p.stage}"${cur !== p.stage ? ' class="dirty"' : ""}
              style="min-width:170px">${opts}</select>
      <span class="muted" style="font-size:12px">0x${hx(ref.stageOffset || 0, 3)} · flag 0x${hx(TR.flagOffset || 0, 2)} bit ${p.bit} · stage ${p.stage}</span>
    </div>`;
  };
  const trMainRow = () => {
    const m = tr.main || {}, ref = TR.main || { chapters: [], labels: {} };
    const rows = (ref.chapters || []).map((c) => ({ value: c.value, label: (ref.labels || {})[String(c.chapter)] || `Chapter ${c.chapter}` }));
    const cur = trStage("main", m.stage || 0);
    const opts = trOpts(rows, m.stage || 0, "— before the merge —").map((o) =>
      `<option value="${o.v}"${o.v === cur ? " selected" : ""}>${esc(o.l)}</option>`).join("");
    return `<div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
      <b style="min-width:150px">${esc(ref.name || "Main story")}</b>
      <select data-tstage="main" data-def="${m.stage || 0}"${cur !== (m.stage || 0) ? ' class="dirty"' : ""}
              style="min-width:170px">${opts}</select>
      <span class="muted" style="font-size:12px">0x${hx(ref.stageOffset || 0, 3)} · no flame of its own · stage ${m.stage || 0}</span>
    </div>`;
  };
  const trFoldSummary = () => {
    const lit = (tr.povs || []).filter(trLit);
    const bits = [`${lit.length}/${(tr.povs || []).length} flames lit`];
    if (lit.length) bits.push(lit.map((p) => p.name).join(", "));
    const m = tr.main || {};
    const mCh = trStage("main", m.stage || 0);
    if (mCh) bits.push((TR.main?.labels || {})[String((TR.main?.chapters || []).filter((c) => mCh >= c.value).pop()?.chapter)] || `main stage ${mCh}`);
    const edits = Object.keys(TRIN.lit).length + Object.keys(TRIN.stage).length;
    return bits.map(esc).join(" · ") + (edits ? ` · <b class="fold-edited">${edits} edit(s)</b>` : "");
  };

  const names = (s.names || []).map((n) =>
    `<label class="field"><span>${esc(n.label)}</span>
       <input type="text" maxlength="${n.max}" value="${esc(n.value || "")}"
              data-name="${n.key}" data-def="${esc(n.value || "")}"></label>`).join("");

  const live = s.characters.filter((c) => c.recruited).length;
  const invCount = (s.inventory || []).reduce((a, b) => a + b.items.length, 0);

  if (saves.length > 1) $("#slotmeta").textContent =
    `${s.folder} · checksum 0x${(s.checksumWord >>> 0).toString(16).toUpperCase()}`;

  // The engine cross-checks the decoded save against invariants a correct layout cannot
  // violate — including the level it reads against the level the save's own PS2 browser
  // title reports. `problems` mean editing is unsafe and are shouted about; `notes` are
  // discrepancies with a benign explanation (e.g. the title going stale after you edit a
  // protagonist's level here) and get a quiet box, so the loud one keeps its meaning.
  const warns = ((s.problems || []).length
    ? `<div class="warnbox" style="margin:0 0 10px"><b>⚠ This save does not decode cleanly.</b>
         Editing it may write to the wrong place — please report it with the save attached.
         <ul style="margin:6px 0 0 18px">${s.problems.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
    : "") + ((s.notes || []).length
    ? `<div class="muted" style="margin:0 0 10px">${s.notes.map((w) => `ℹ ${esc(w)}`).join("<br>")}</div>`
    : "");

  $("#slotbody").innerHTML = `
    ${warns}
    <div class="card">
      <div class="muted" style="margin:-2px 0 8px">${metaBits}</div>
      <details class="fold" id="cofold"${COFOLD ? " open" : ""}>
        <summary class="bag-h"><span class="chev">▸</span>Suikoden I / II carryover &amp; names
          <span class="u" id="cofoldsum">${coFoldSummary()}</span></summary>
        <h3 class="sec" style="margin-top:6px">Carryover flags</h3>
        <div class="grid" id="carryover" style="gap:6px">
          ${coRow("s2", "Suikoden II")}${coRow("s1", "Suikoden I")}
        </div>
        <div class="muted" style="font-size:12px;margin:6px 0 0">
          Suikoden III only ever reads a <b>Suikoden II</b> memory-card save; the Suikoden I
          hero and country come out of that save too, which is why both flags live together.
          Ticking a box sets the bit the game's own scripts test — the carryover names below
          are what it makes them say.
          ${CR.chars.length ? `The import also upgrades ${CR.chars.map((c) => esc(c.name)).join(", ")}:` : ""}
          <button id="coBonus" style="margin-left:4px">Suikoden II bonus…</button>
        </div>
        <h3 class="sec">Names</h3>
        <div class="grid" id="names">${names}</div>
      </details>
      <details class="fold" id="trfold"${TRFOLD ? " open" : ""}>
        <summary class="bag-h"><span class="chev">▸</span>Trinity Sight — points of view &amp; chapters
          <span class="u" id="trfoldsum">${trFoldSummary()}</span></summary>
        <div class="grid" id="trinity" style="gap:6px;margin-top:6px">
          ${(tr.povs || []).map(trRow).join("")}
          <hr style="border:0;border-top:1px solid var(--bd);margin:2px 0">
          ${trMainRow()}
        </div>
        <div class="muted" style="font-size:12px;margin:6px 0 0">
          The chapter-select screen reads exactly three things, and these are they: the
          <b>flame mask</b> (flag byte <code>0x${hx(TR.flagOffset || 0, 2)}</code>, one bit per point of view) and one
          <b>progress counter</b> each (the eight-slot bank at <code>0x${hx(TR.stageOffset || 0, 3)}</code>). Each point of
          view has its own scale, so the dropdowns offer the stage values real saves hold at
          the start of each of that character's chapters — Chris has three, Thomas two,
          Koroku and Luc one each. Chapters 4-5 belong to the merged story on its own row;
          the game keeps Hugo/Chris/Geddoe in step with it from the merge onwards.
          <b>Not play-tested yet:</b> lighting a flame out of order (Luc's before the game is
          cleared) may not lead anywhere the game is ready for — keep a backup save.
        </div>
      </details>
      <h3 class="sec">Gold</h3>
      <label class="field" style="max-width:200px"><span>Gold / potch</span>
        <input type="number" min="0" max="999999999" id="goldfld"
               value="${s.global.gold || 0}" data-def="${s.global.gold || 0}"></label>
      <h3 class="sec">Backup / templates <span class="muted" style="font-size:11px;font-weight:400">JSON</span></h3>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <button id="exportJson">⬇ Export JSON</button>
        <button id="importJson">⬆ Import JSON…</button>
        <input type="file" id="importJsonFile" accept=".json,application/json" hidden>
        <span class="muted" style="font-size:12px;flex:1;min-width:180px">A human-readable snapshot of this save — edit or share it, then re-import to stage the changes for Apply.</span>
      </div>
    </div>
    <div class="card">
      <div class="subtabs">
        <button class="chip" data-sub="chars">Characters (${live})</button>
        <button class="chip" data-sub="recruit">Recruit</button>
        <button class="chip" data-sub="stars">108 Stars</button>
        <button class="chip" data-sub="party">Party</button>
        <button class="chip" data-sub="field">Field character</button>
        <button class="chip" data-sub="items">Inventory (${invCount})</button>
        <button class="chip" data-sub="health" id="healthTab">Health</button>
      </div>
      <input class="search" id="sq" placeholder="filter…">
      <div class="muted" id="subhint" style="margin:2px 0 10px"></div>
      <div id="subview"></div>
      <div class="toolbar">
        ${SUPPORTS_FS && fileHandle
          ? `<button class="primary" id="saveFileBtn">Apply &amp; save to file</button>
             ${SUPPORTS_SAVE_PICKER ? `<button id="saveAsBtn">Save as…</button>` : ""}
             <button id="saveBtn">Download copy</button>`
          : SUPPORTS_SAVE_PICKER
            ? `<button class="primary" id="saveAsBtn">Apply &amp; save…</button>
               <button id="saveBtn">Download copy</button>`
            : `<button class="primary" id="saveBtn">Apply &amp; download</button>`}
        ${CAN_SHARE_FILES ? `<button id="shareBtn">Apply &amp; share…</button>` : ""}
        <button id="resetBtn">Reset</button>
        <label class="row" style="gap:6px;cursor:pointer;font-size:12px;color:var(--mut)" title="Off = keep the original filename, so a download/share can overwrite the source card">
          <input type="checkbox" id="suffixChk"${ADD_SUFFIX ? " checked" : ""}> add “.edited” to copies</label>
        <span class="status" id="status"></span>
      </div>
    </div>`;

  refreshCoFold = () => { const el = $("#cofoldsum"); if (el) el.innerHTML = coFoldSummary(); };
  $("#cofold").ontoggle = (e) => { COFOLD = e.target.open; };
  $$("input[data-name]").forEach((inp) => (inp.oninput = () => {
    inp.classList.toggle("dirty", inp.value !== inp.dataset.def);
    NAMES[inp.dataset.name] = inp.value;
    refreshCoFold();
  }));
  $$("input[data-carry]").forEach((cb) => (cb.onchange = () => {
    const g = cb.dataset.carry, was = (s.carryover?.[g] || {}).loaded;
    if (cb.checked === was) delete CARRY[g]; else CARRY[g] = cb.checked;
    cb.classList.toggle("dirty", cb.checked !== was);
    refreshCoFold();
  }));
  const cob = $("#coBonus"); if (cob) cob.onclick = openCarryoverBonus;
  refreshTrFold = () => { const el = $("#trfoldsum"); if (el) el.innerHTML = trFoldSummary(); };
  $("#trfold").ontoggle = (e) => { TRFOLD = e.target.open; };
  $$("input[data-tflame]").forEach((cb) => (cb.onchange = () => {
    const k = cb.dataset.tflame, was = !!(tr.povs || []).find((p) => p.key === k)?.lit;
    if (cb.checked === was) delete TRIN.lit[k]; else TRIN.lit[k] = cb.checked;
    cb.classList.toggle("dirty", cb.checked !== was);
    refreshTrFold();
  }));
  $$("select[data-tstage]").forEach((sel) => (sel.onchange = () => {
    const k = sel.dataset.tstage, was = +sel.dataset.def, now = +sel.value;
    if (now === was) delete TRIN.stage[k]; else TRIN.stage[k] = now;
    sel.classList.toggle("dirty", now !== was);
    refreshTrFold();
  }));
  $("#goldfld").oninput = (e) => {
    e.target.classList.toggle("dirty", e.target.value !== e.target.dataset.def);
    GOLD = +e.target.value;
  };
  $("#exportJson").onclick = exportSaveJSON;
  $("#importJson").onclick = () => $("#importJsonFile").click();
  $("#importJsonFile").onchange = (e) => { const f = e.target.files[0]; if (f) importSaveJSON(f); e.target.value = ""; };
  $$("[data-sub]").forEach((b) => (b.onclick = () => { SUB = b.dataset.sub; SEARCH = ""; $("#sq").value = ""; showSub(); }));
  $("#sq").oninput = (e) => { SEARCH = e.target.value.toLowerCase(); showSub(); };
  $("#saveBtn").onclick = () => applyEdits("download");
  const sfb = $("#saveFileBtn"); if (sfb) sfb.onclick = () => applyEdits("file");
  const sab = $("#saveAsBtn"); if (sab) sab.onclick = () => applyEdits("saveas");
  const shb = $("#shareBtn"); if (shb) shb.onclick = () => applyEdits("share");
  $("#suffixChk").onchange = (e) => { ADD_SUFFIX = e.target.checked; try { localStorage.setItem("s3suffix", ADD_SUFFIX ? "on" : "off"); } catch (err) {} };
  $("#resetBtn").onclick = drawSlot;
  showSub();
  refreshHealthBadge();
}

function showSub() {
  $$("[data-sub]").forEach((b) => b.classList.toggle("on", b.dataset.sub === SUB));
  { const sq = $("#sq"); if (sq) sq.hidden = SUB === "field"; }   // nothing to filter there
  if (SUB === "chars") {
    $("#subhint").innerHTML = `Stats, equipped runes/armor, and skill slots per character, with the ` +
      `<b>guide's</b> skill caps, Lv-99 growth ranges and rune-slot unlock levels shown under each field. ` +
      `Tick <b>recruited</b> to add a not-yet-joined character (or untick to remove). ` +
      `<label style="cursor:pointer;margin-left:6px"><input type="checkbox" id="reconly" ${RECRUITED_ONLY ? "checked" : ""}> recruited only</label>`;
    drawChars();
    $("#reconly").onchange = (e) => { RECRUITED_ONLY = e.target.checked; drawChars(); };
  } else if (SUB === "recruit") {
    $("#subhint").innerHTML = `Bulk-recruit units into a protagonist's <b>pre-merge team</b> in one action. ` +
      `Pick a team, then use the bulk buttons or the canonical presets — no need to open each character. ` +
      `Team only matters before the parties merge (Flame Champion); after that it's cosmetic. Changes are staged until you Apply.`;
    drawRecruit();
  } else if (SUB === "stars") {
    $("#subhint").innerHTML = `Recruitment completion across the <b>108 Stars of Destiny</b>, in the ` +
      `<b>recruitment guide's order</b> — the order you can actually get them in — grouped into that ` +
      `order's stages, each with its own progress. Filter to <b>missing</b> to see who's left, with the ` +
      `guide's <i>how-to-recruit</i> for each optional star — and under it, <b>what that errand needs</b>: ` +
      `where the item it asks for actually comes from, the potch measured against your purse, and any ` +
      `star you must bring or recruit first. ` +
      `Team pills show which protagonist(s) a recruited star is on (a star can be on several at once).`;
    drawStars();
  } else if (SUB === "party") {
    $("#subhint").innerHTML = `Active battle party (up to 6). Leaving story-required leaders in place avoids soft-locks. ` +
      `Saving also re-derives the battle formation (the table the game reads to decide who to build), ` +
      `and closes any gap you leave in the list.`;
    drawParty();
  } else if (SUB === "field") {
    $("#subhint").innerHTML = `Who you <b>run around the map as</b> — the party-leader byte at ` +
      `<code>0x12</code>, which names the field model the engine loads. Picking someone also puts ` +
      `them in <b>party slot 1</b> and takes the character they stand in for <b>out of the party</b>; ` +
      `both are needed for cutscenes not to freeze, and both are confirmed in play.`;
    drawField();
  } else if (SUB === "health") {
    $("#subhint").innerHTML = `A read-through of this save — <b>including your pending edits</b> — for the states ` +
      `the game never writes itself: a party member who isn't recruited, a rune carrying a stack count, ` +
      `a value the engine will clamp on write. Findings with a <b>Fix</b> stage the change like any other ` +
      `edit, so it still goes through <b>Review changes</b> before anything is written.`;
    drawHealth();
  } else {
    $("#subhint").innerHTML = `Party + storage items. Use <b>+ Add item</b> to append to a bag, ✕ to remove. ` +
      `Only consumables, food and trade goods carry a quantity (max 9); runes, armour and key items are ` +
      `<b>one per slot</b> — click <b>+ Add item</b> once per copy.`;
    drawItems();
  }
  collapseSubhint();
  refreshHealthBadge();     // pending edits move the count; refresh whenever the view changes
}

// One-line versions of the sub-view hints above, for the "Show more" collapse
// (blurb-core.js). Only the long ones need an entry; a view with none renders its hint whole.
//
// `chars` is deliberately absent. Its hint carries the live "recruited only" checkbox, and
// collapsing the block would put that control behind the button — the prose would be tidier
// and the tab would lose a filter.
const SUBHINT_SUM = {
  recruit: "Bulk-recruit units into a protagonist's pre-merge team in one action, with the canonical presets.",
  stars: "Recruitment completion across the 108 Stars of Destiny, in the order you can actually get them in.",
  field: "Who you run around the map as — picking someone also stages the party changes that stop cutscenes freezing.",
  health: "A read-through of this save, pending edits included, for the states the game never writes itself.",
};

// #subhint is one element every sub-view writes over, so its collapse is rebuilt on each
// switch rather than left standing: the innerHTML above has already wiped the last view's
// structure, and clearing data-blurbed is what re-arms the pass. Run synchronously so the
// full hint never flashes before it collapses.
function collapseSubhint() {
  const hint = $("#subhint");
  if (!hint) return;
  hint.className = "muted";                 // drop .blurb / .open from the previous view
  hint.removeAttribute("data-blurbed");
  const sum = SUBHINT_SUM[SUB];
  if (sum) hint.setAttribute("data-sum", sum); else hint.removeAttribute("data-sum");
  if (sum && self.BlurbCore && self.BlurbCore.applyBlurbs) self.BlurbCore.applyBlurbs(hint);
}

// ---- guide reference overlays ----------------------------------------------
// The ISO editor annotates its character records with the Suikosource guide data (skill
// caps, Lv-99 growth ranges, rune-slot unlock levels — iso.js: skillCapNote/growthNote/
// runeSlotNote). The same committed JSON applies to a save, so show it here too: it turns
// "Skill slot 3" into "max B+" and a bare stat box into "Lv99 ≈ 90-188". The join and the
// coverage guarantees live in guide-core.js; this half is only rendering + escaping.
let GUIDE = null;                   // { caps, growth, slots }; {} tables when a file is absent
async function loadGuideRefs() {
  if (GUIDE) return GUIDE;
  const one = async (u) => { try { const r = await fetch(u); return r.ok ? await r.json() : {}; } catch (e) { return {}; } };
  const [caps, growth, slots] = await Promise.all([
    one("../Editor/s3_skill_caps.json"), one("../Editor/s3_growth_ref.json"), one("../Editor/s3_rune_slots.json")]);
  GUIDE = { caps, growth, slots };   // a missing file just hides its notes, never breaks the editor
  return GUIDE;
}
// .fnote is for GUIDE overlays, which are per-character by definition (e2e asserts a
// character the guide doesn't cover shows none). Static help that describes the field
// itself uses .fhint so it can't be mistaken for guide data.
const fnote = (html) => (html ? `<div class="fnote">${html}</div>` : "");
const fhint = (html) => (html ? `<div class="fhint">${html}</div>` : "");

// max grade for one skill on one character: "guide max: B+", or a dim "can't learn".
function capNote(charName, skillId) {
  const r = GUIDE && GuideCore.skillCap(GUIDE, charName, skillId);
  if (!r) return "";
  return r.grade ? `guide max: <b>${esc(r.grade)}</b>` : `<span class="dim">guide: can't learn</span>`;
}
// growth rate + the Lv-99 range the guide expects for a stat ("HP" covers Max HP).
function growthNoteSave(charName, stat) {
  const g = GUIDE && GuideCore.growth(GUIDE, charName, stat);
  if (!g) return "";
  const bits = [];
  if (g.rate) bits.push(`rate ${g.rate}`);
  if (g.end) bits.push(`Lv99 ≈ ${g.end}`);
  return bits.length ? `guide: ${esc(bits.join(" · "))}` : "";
}
// rune slot: locked until Lv N, an innate starting rune, or nothing.
function runeSlotNoteSave(charName, eqKey) {
  const s = GUIDE && GuideCore.runeSlot(GUIDE, charName, eqKey);
  if (!s) return "";
  if (s.state === "opens") return `guide: slot opens at <b>Lv ${esc(String(s.lv))}</b>`;
  if (s.state === "rune") return `guide: starts with <b>${esc(s.rune)}</b>`;
  return `<span class="dim">guide: empty/none</span>`;
}
// the level the character joins at — context for "is this level plausible?".
function joinLvNote(charName) {
  const i = GUIDE && GuideCore.initial(GUIDE, charName);
  if (!i) return "";
  return `guide: joins at <b>Lv ${esc(i.lv)}</b>${i.wlv ? ` · WLv ${esc(i.wlv)}` : ""}`;
}

// ---- Characters ------------------------------------------------------------
function drawChars() {
  const s = saves[curSlot];
  if (GUIDE === null) loadGuideRefs().then(() => { if (SUB === "chars") drawChars(); });   // notes appear once the guides load
  const pool = RECRUITED_ONLY ? s.characters.filter((c) => c.recruited) : s.characters.filter((c) => c.hasData || c.recruited);
  const shown = pool.filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);
  const box = $("#subview");
  box.innerHTML = shown.map(charCard).join("") || `<div class="muted">no characters</div>`;
  shown.forEach(wireChar);
}

// Caps match s3save.CHAR_FIELDS — the engine clamps to the same values, so the input can't
// offer a number the game would reject. Weapon (sharpen) level tops out at 16 and EXP is
// progress inside the current level (level-up fires at 1000). Shared with the health audit.
const CHAR_CAP = HealthCore.CAPS;
function charCard(c) {
  const num = (k, val, stat) => {
    const max = stat ? 999 : (CHAR_CAP[k] ?? 999999);
    return `<input type="number" min="0" max="${max}" value="${val}" data-ri="${c.rosterIndex}"` +
      (stat ? ` data-stat="${stat}"` : ` data-k="${k}"`) + ` data-def="${val}" title="0–${max}">`;
  };
  const statCells = STAT_NAMES().map((n) =>
    `<label class="field"><span>${n}</span>${num(null, c.stats[n], n)}${fnote(growthNoteSave(c.name, n))}</label>`).join("");
  // Level gets the guide's join level; Max HP is the "HP" row of the growth table.
  const CORE_NOTE = { level: () => joinLvNote(c.name), maxHP: () => growthNoteSave(c.name, "HP") };
  const CORE_HINT = {
    weaponLv: `sharpen level, 1–16`,
    expToNext: `<span class="dim">progress inside this level; 1000 = level up</span>`,
  };
  const core = [["Level", "level"], ["Weapon Lv", "weaponLv"], ["Cur HP", "curHP"],
                ["Max HP", "maxHP"], ["EXP in level", "expToNext"]]
    .map(([lbl, k]) => `<label class="field"><span>${lbl}</span>${num(k, c[k])}` +
      `${fnote(CORE_NOTE[k] ? CORE_NOTE[k]() : "")}${fhint(CORE_HINT[k] || "")}</label>`).join("");
  const equip = EQ.map(([key, lbl]) => {
    const cur = c.equip[key] || 0;
    return `<label class="field"><span>${lbl}</span>
       <button type="button" class="picker" data-eqri="${c.rosterIndex}" data-eq="${key}" data-val="${cur}" data-def="${cur}">${esc(itemLabel(cur))}</button>${fnote(runeSlotNoteSave(c.name, key))}</label>`;
  }).join("");
  const skills = (c.skills || []).map((sk) =>
    `<div class="field"><span>Skill slot ${sk.slot + 1}</span>
       <button type="button" class="picker" data-skri="${c.rosterIndex}" data-skslot="${sk.slot}" data-skf="id" data-val="${sk.id}" data-def="${sk.id}">${esc(skillLabel(sk.id))}</button>
       <div class="row" style="gap:6px;margin-top:4px"><span class="muted">rank</span>
         <select style="flex:1" data-skri="${c.rosterIndex}" data-skslot="${sk.slot}" data-skf="rank" data-def="${sk.rank}">${rankSel(sk.rank)}</select></div>
       <div class="fnote" data-capnote="${sk.slot}">${capNote(c.name, sk.id)}</div></div>`).join("");
  return `<details class="char"><summary>
      <span class="chev">▸</span><span class="nm">${esc(c.name)}</span>
      <span class="muted">#${c.rosterIndex}</span>
      <span class="pill${c.recruited ? " on" : ""}">${c.recruited ? "recruited" : "not recruited"}</span>
      <span class="lv">Lv ${c.level} · WLv ${c.weaponLv} · HP ${c.curHP}/${c.maxHP}</span></summary>
    <div class="char-body" data-roster="${c.rosterIndex}">
      <div class="row" style="gap:16px;margin-top:4px">
        <label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" data-recruit="${c.rosterIndex}" ${c.recruited ? "checked" : ""}> recruited</label>
        <span class="row" style="gap:4px;align-items:center">team(s)
          ${RECRUITERS.map((h) => `<label class="tmbox" title="${h}"><input type="checkbox" data-recteam="${c.rosterIndex}" value="${h}" ${(c.recruiters || []).includes(h) ? "checked" : ""}>${h[0]}</label>`).join("")}
          <span class="muted">none = shared</span></span></div>
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
      const note = $(`[data-capnote="${slot}"]`, body);      // the cap is per-skill, so re-render it
      if (note) note.innerHTML = capNote(c.name, id);
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
  $$("input[data-recteam]", body).forEach((box) => (box.onchange = () => {
    const ri = +box.dataset.recteam, e = recEntry(ri);
    e.teams = $$(`input[data-recteam="${ri}"]:checked`, body).map((b) => b.value);
    e.recruited = true;
    const cb = $(`input[data-recruit="${ri}"]`, body);
    if (cb && !cb.checked) { cb.checked = true; }
  }));
}

// ---- Recruit (bulk team assignment) ----------------------------------------
// Recruitment lives in the save: each character has a recruit word whose bits 2-5 encode
// which protagonist recruited them (their pre-merge team). This section stages bulk
// {recruited, recruiter} edits into RECRUIT (the same shape a single character card uses),
// so Apply routes them through the tried s3save.write_save_edits path unchanged.
const TEAM_OPTS = [["", "— shared / story —"], ...RECRUITERS.map((h) => [h, h])];
let RTEAM = "Hugo";                 // default team applied when a character is ticked recruited
let STARS_FILTER = "missing";       // 108-Stars dashboard: all | recruited | missing
let STARS_KIND = "all";             // all | optional | story
let RECRUIT_META = null;            // name -> {auto, how}: story auto-join vs optional recruit
// The Suikosource recruitment guide's own table: {phases, chars:{name -> {n, star, how, phase}},
// extras}. It is what puts the 108-Stars checklist in recruitment order instead of roster order.
let RECRUIT_ORDER = null;
// name -> {items, potch, first, gates}: what a star's how-to makes you bring, and where each
// item comes from (disc shop/drop tables + guide lines). See Editor/build_recruit_needs.py.
let RECRUIT_NEEDS = null;
let STARS_COLLAPSED = {};           // guide stage key -> folded away in the checklist?
async function loadRecruitMeta() {
  if (RECRUIT_META) return RECRUIT_META;
  try { RECRUIT_META = await (await fetch("../Editor/s3_recruit_meta.json")).json(); }
  catch (e) { RECRUIT_META = {}; }   // story/optional shading just stays off if the file is missing
  return RECRUIT_META;
}
async function loadRecruitOrder() {
  if (RECRUIT_ORDER) return RECRUIT_ORDER;
  try { RECRUIT_ORDER = await (await fetch("../Editor/s3_recruit_order.json")).json(); }
  catch (e) { RECRUIT_ORDER = { phases: [], chars: {}, extras: [] }; }   // falls back to one flat list
  return RECRUIT_ORDER;
}
async function loadRecruitNeeds() {
  if (RECRUIT_NEEDS) return RECRUIT_NEEDS;
  try { RECRUIT_NEEDS = (await (await fetch("../Editor/s3_recruit_needs.json")).json()).chars || {}; }
  catch (e) { RECRUIT_NEEDS = {}; }    // no file: the how-to line still shows, just without the extras
  return RECRUIT_NEEDS;
}
// Story characters auto-join — recruiting/un-recruiting them manually is pointless and can
// soft-lock. This tool is meant for OPTIONAL recruits.
//
// Two guides speak to this and they disagree about eleven characters, so a star only counts as
// story when BOTH agree: the character FAQ's "Automatic: Yes" field, and the stage the
// recruitment guide files them under. Where they differ the missable reading wins — Rhett and
// Wilder, whom you have to go and talk to, and Geddoe's Chapter 5 group, who leave for good if
// you run from that fight, stay on the worklist rather than being faded out as "arrives anyway".
const guideStar = (name) => (RECRUIT_ORDER && RECRUIT_ORDER.chars && RECRUIT_ORDER.chars[name]) || null;
function guideStageKind(name) {
  const g = guideStar(name);
  const p = g && (RECRUIT_ORDER.phases || []).find((ph) => ph.key === g.phase);
  return p ? p.kind : "";
}
function isStoryAuto(name) {
  const inMeta = !!(RECRUIT_META && name in RECRUIT_META);
  const metaAuto = inMeta ? !!RECRUIT_META[name].auto : true;    // unknown to the FAQ: no veto
  const kind = guideStageKind(name);
  return kind ? (kind === "story" && metaAuto) : (inMeta && metaAuto);
}
const recruitHow = (name) => (RECRUIT_META && RECRUIT_META[name] && RECRUIT_META[name].how) || "";

// recruit staging math lives in recruit-core.js (shared with the Node tests); thin wrappers
// bind the RECRUIT edit-map so call sites stay terse.
const recState = (c) => RecruitCore.recState(c, RECRUIT);
const setRecruit = (c, recruited, team) => RecruitCore.setRecruit(c, recruited, team, RECRUIT);

function drawRecruit() {
  if (RECRUIT_META === null) loadRecruitMeta().then(() => { if (SUB === "recruit") drawRecruit(); });   // story shading once meta loads
  const s = saves[curSlot];
  const roster = s.characters.filter((c) => c.hasData || c.recruited || (c.name && !/^#/.test(c.name)));
  const shown = roster.filter((c) => !SEARCH || c.name.toLowerCase().includes(SEARCH) || String(c.rosterIndex) === SEARCH);

  // per-team counts over the whole roster (staged)
  const { total, counts } = RecruitCore.teamCounts(roster, RECRUIT);
  const teamSel = TEAM_OPTS.map(([v, l]) => `<option value="${v}"${v === RTEAM ? " selected" : ""}>${esc(l)}</option>`).join("");

  const rows = shown.map((c) => {
    const st = recState(c), dirty = (c.rosterIndex in RECRUIT), story = isStoryAuto(c.name);
    const dis = st.recruited ? "" : "disabled";
    const boxes = RECRUITERS.map((h) => `<label class="tmbox" title="${h}"><input type="checkbox" data-tm="${c.rosterIndex}" value="${h}" ${st.teams.includes(h) ? "checked" : ""} ${dis}>${h[0]}</label>`).join("");
    const tag = story ? `<span class="story-tag" title="${esc(recruitHow(c.name) || "Joins automatically via the story")}">⚠ story</span>` : "";
    return `<tr class="${dirty ? "dirtyrow " : ""}${story ? "story-auto" : ""}">
        <td><label class="row" style="gap:6px;cursor:pointer"><input type="checkbox" data-rec="${c.rosterIndex}" ${st.recruited ? "checked" : ""}> <span>${esc(c.name)}</span></label> ${tag}</td>
        <td class="sl">#${c.rosterIndex}</td>
        <td class="teamcell">${boxes}<button class="chip mini" data-tmall="${c.rosterIndex}" ${dis}>All</button></td>
      </tr>`;
  }).join("") || `<tr><td colspan="3" class="muted">no matches</td></tr>`;

  $("#subview").innerHTML = `
    <div class="warnbox" style="margin:0 0 10px">Best used for <b>optional</b> recruits. <span class="story-tag">⚠ story</span> characters (faded) auto-join via the story — recruiting or un-recruiting them manually is unneeded and can soft-lock an early save. Keep a backup.</div>
    <div class="muted" style="margin:0 0 8px" data-sum="Tick a character's teams — a unit can be on several protagonists' teams at once, which is a real game mechanic once the parties merge.">Tick a character's <b>team(s)</b> — a unit can be on <b>several</b> protagonists' teams at once (H/C/G/T, or <b>All</b>), so e.g. a Hugo recruit can also show up while you play Chris. This is a real game mechanic: after the parties merge, the game itself puts shared characters on Hugo + Chris + Geddoe at once. Keep a backup.</div>
    <div class="row" style="gap:10px;margin-bottom:8px">
      <label class="field" style="max-width:240px"><span>Default team for new recruits</span><select id="rteam">${teamSel}</select></label>
      <span class="muted">Recruited ${total} · Hugo ${counts.Hugo} · Chris ${counts.Chris} · Geddoe ${counts.Geddoe} · Thomas ${counts.Thomas} · shared ${counts[""]}</span>
    </div>
    <table class="invtbl"><thead><tr><th>Character</th><th>#</th><th>Team(s)</th></tr></thead><tbody>${rows}</tbody></table>`;

  $("#rteam").onchange = (e) => { RTEAM = e.target.value; };
  const teamsChecked = (ri) => $$(`input[data-tm="${ri}"]:checked`).map((b) => b.value);
  // per-character edits apply immediately (granular + revertible via "Revert all")
  $$("input[data-rec]").forEach((cb) => (cb.onchange = () => {
    const c = charByRoster(+cb.dataset.rec);
    setRecruit(c, cb.checked, cb.checked ? (RTEAM ? [RTEAM] : []) : undefined); drawRecruit();
  }));
  // team checkboxes: a character can be on several teams at once (the save stores a bitmask)
  $$("input[data-tm]").forEach((box) => (box.onchange = () => {
    const ri = +box.dataset.tm, c = charByRoster(ri); setRecruit(c, true, teamsChecked(ri)); drawRecruit();
  }));
  $$("button[data-tmall]").forEach((btn) => (btn.onclick = () => {
    const c = charByRoster(+btn.dataset.tmall); setRecruit(c, true, [...RECRUITERS]); drawRecruit();
  }));
}
function charByRoster(ri) { return saves[curSlot].characters.find((c) => c.rosterIndex === ri) || { rosterIndex: ri, recruited: false, recruiter: "" }; }

// ---- 108 Stars dashboard ----------------------------------------------------
// A recruitment-completion tracker over the Stars of Destiny: who's in, who's left,
// which team(s) each recruited star sits on, and the guide's how-to for missing
// optional stars. Reflects staged (un)recruits live, so it doubles as a worklist.
//
// It is laid out in the Suikosource *recruitment guide's* order — the order you can actually
// get people in — cut into that order's stages (Chapter 1's parties, the Budehuc-era optional
// recruits, each story block, the Chapter 6 four). Roster order, which is what the save
// happens to store, tells a player nothing about what to do next; guide order reads top to
// bottom as a walkthrough. The ordering/grouping math is in recruit-core.js (unit-tested);
// this half is the panel. Without s3_recruit_order.json the table still renders, as one
// ungrouped list — the checklist never depends on the guide file being there.
function drawStars() {
  if (RECRUIT_META === null) loadRecruitMeta().then(() => { if (SUB === "stars") drawStars(); });
  if (RECRUIT_ORDER === null) loadRecruitOrder().then(() => { if (SUB === "stars") drawStars(); });
  if (RECRUIT_NEEDS === null) loadRecruitNeeds().then(() => { if (SUB === "stars") drawStars(); });
  const s = saves[curSlot];
  // The tracked set = characters either guide knows as recruitable stars, plus anyone actually
  // recruited in this save (covers roster/name drift either way).
  const known = (c) => (RECRUIT_ORDER && RECRUIT_ORDER.chars && c.name in RECRUIT_ORDER.chars)
    || (RECRUIT_META && c.name in RECRUIT_META);
  const stars = s.characters.filter((c) => known(c) || c.recruited);
  // guide order (n/star/phase land on each row) — everything below reads in this order
  const rows0 = RecruitCore.orderStars(
    stars.map((c) => ({ c, st: recState(c), story: isStoryAuto(c.name), how: recruitHow(c.name) })),
    RECRUIT_ORDER);

  // The headline is the 108 — count only rows the guide lists as Stars of Destiny, so a roster
  // entry that isn't one (Lulu) can't inflate it. Still listed below, just under its own stage.
  const scored = rows0.filter((x) => x.n !== null);
  const counted = scored.length ? scored : rows0;    // no guide file: fall back to everything tracked
  const total = counted.length;
  const got = counted.filter((x) => x.st.recruited).length;
  const pct = total ? Math.round((got / total) * 100) : 0;
  const missingOpt = counted.filter((x) => !x.st.recruited && !x.story).length;
  const multi = rows0.filter((x) => x.st.recruited && x.st.teams.length > 1).length;
  const { counts } = RecruitCore.teamCounts(stars, RECRUIT);
  const next = RecruitCore.nextStar(rows0);      // first optional star still missing, in guide order

  const shown = rows0.filter((x) => {
    if (STARS_FILTER === "recruited" && !x.st.recruited) return false;
    if (STARS_FILTER === "missing" && x.st.recruited) return false;
    if (STARS_KIND === "optional" && x.story) return false;
    if (STARS_KIND === "story" && !x.story) return false;
    if (SEARCH && !x.c.name.toLowerCase().includes(SEARCH) && String(x.c.rosterIndex) !== SEARCH) return false;
    return true;
  });
  const groups = RecruitCore.groupStars(rows0, shown, RECRUIT_ORDER);

  // bind this save into the pure formatter: staged gold, and whether a named prerequisite star
  // is (or is about to be) recruited.
  const byName = {};
  rows0.forEach((r) => (byName[r.c.name] = r));
  const needChips = (name) => RecruitCore.needChips((RECRUIT_NEEDS || {})[name], {
    gold: typeof GOLD === "number" ? GOLD : (s.global && s.global.gold),
    recruited: (n) => (byName[n] ? byName[n].st.recruited : null),
  });

  // Where a "＋ get it" lands: the bag belonging to the party this save is currently playing.
  // Derived from the field-leader byte (staged edit included) and that character's team bits,
  // so an item added from the checklist goes somewhere you can actually reach right now.
  const leadId = LEADER !== null ? LEADER : (s.global && s.global.partyLeader);
  const leadName = (REF.charById && REF.charById[leadId]) || s.leaderName || "";
  const bagTarget = RecruitCore.bagForNeeds(s, leadName, (n) => {
    const r = byName[n] || (s.characters || []).map((c) => ({ c })).find((x) => x.c.name === n);
    return r ? (r.st || recState(r.c)).teams : [];
  }, Object.values(ADDED).flat());

  const teamPills = (st) => st.teams.length
    ? st.teams.map((t) => `<span class="tpill t${t[0]}">${t[0]}</span>`).join("")
    : `<span class="tpill tS" title="shared / story">S</span>`;

  const starRow = (x) => {
    const rec = x.st.recruited;
    const kind = x.story ? `<span class="story-tag" title="Joins automatically via the story">⚠ story</span>` : `<span class="opt-tag">optional</span>`;
    const status = rec ? `<span class="ok">✓ recruited</span>` : `<span class="miss">✗ missing</span>`;
    const teamCell = rec ? teamPills(x.st) : "";
    const addBtn = (!rec && !x.story)
      ? `<button class="chip mini" data-starsadd="${x.c.rosterIndex}" title="Stage recruit (default team: ${RTEAM || "shared"})">＋ recruit</button>` : "";
    const dirty = (x.c.rosterIndex in RECRUIT) ? "dirtyrow " : "";
    const main = `<tr class="${dirty}${x.story ? "story-auto" : ""}">
        <td class="sl ordn" title="roster slot #${x.c.rosterIndex}">${x.n === null ? "–" : x.n}</td>
        <td><span>${esc(x.c.name)}</span> ${kind}</td>
        <td class="ty sod">${esc(x.star || "")}</td>
        <td>${status}</td>
        <td class="teamcell">${teamCell}</td>
        <td>${addBtn}</td>
      </tr>`;
    // The recruitment guide's how-to is the one written for this exact job; the character FAQ's
    // blurb is the fallback for anyone the guide doesn't cover. Full table width so it reads
    // cleanly at any pane size.
    const how = (!rec && !x.story) ? (x.guideHow || x.how) : "";
    // ...and under it, what that line makes you bring: the item's actual source and stock stage,
    // the potch measured against what this save is carrying, and any star you need along or
    // recruited first (with whether you already have them). A line that says "give him a Deer
    // Antler" is only half an errand until you know where antlers come from.
    const chips = (!rec && !x.story) ? needChips(x.c.name) : [];
    const chipHtml = chips.map((n) => {
      const mark = n.ok === null ? "" : n.ok ? `<span class="ok">✓</span> ` : `<span class="miss">✗</span> `;
      return `<span class="need n-${n.kind}${n.ok === false ? " short" : ""}">${mark}${esc(n.text)}${needBtn(n)}</span>`;
    }).join("");
    const howRow = (how || chipHtml)
      ? `<tr class="${dirty}howrow"><td colspan="6">
           ${how ? `<div class="howto">${esc(how)}</div>` : ""}
           ${chipHtml ? `<div class="needs"><span class="needlbl">needs</span>${chipHtml}</div>` : ""}
         </td></tr>` : "";
    return main + howRow;
  };

  // A stage header: its own progress, so "Chapter 4 story 10/10, optional 6/14" is readable at
  // a glance, and a fold so a finished stretch can be pushed out of the way.
  const groupHead = (g) => {
    const off = !!STARS_COLLAPSED[g.key];
    const gpct = g.total ? Math.round((g.got / g.total) * 100) : 0;
    const extra = g.extras.length
      ? ` <span class="phextra" title="${esc(g.extras.map((e) => e.how).join(" "))}">+ ${g.extras.length} non-star helper${g.extras.length === 1 ? "" : "s"}: ${esc(g.extras.map((e) => e.name).join(", "))}</span>` : "";
    return `<tr class="phaserow${off ? " off" : ""}"><td colspan="6">
        <button class="phasetog" data-starsp="${g.key}" aria-expanded="${off ? "false" : "true"}">${off ? "▸" : "▾"} <b>${esc(g.label)}</b></button>
        <span class="phprog">${g.got}/${g.total}</span>
        <span class="phbar"><span style="width:${gpct}%"></span></span>
        <div class="phnote">${esc(g.note || "")}${extra}</div>
      </td></tr>`;
  };

  // Hand it over rather than making you go and get it: an item lands in the current party's
  // bag, a potch price is topped up by exactly what you are short. Both only STAGE the change,
  // so they go through Review changes with everything else.
  const needBtn = (n) => {
    // An item you have to buy needs the money, not the item: give it the same top-up the potch
    // lines get, never "＋ add to bag" — a Mole Armor in your pack recruits nobody.
    if (n.kind === "item" && n.buy) return topUpBtn(n);
    if (n.kind === "item" && n.id) {
      if (!bagTarget || bagTarget.slot === null) return "";
      const warn = bagTarget.unstarted
        ? ` — WARNING: ${bagTarget.region}'s chapter hasn't started, and the game overwrites that bag when it does`
        : "";
      return ` <button class="chip mini needbtn" data-needitem="${n.id}"
        title="Put one ${esc(n.name)} in ${esc(bagTarget.region)} — ${esc(bagTarget.why)}${esc(warn)}">＋ add to ${esc(bagTarget.region)}</button>`;
    }
    if (n.kind === "potch") return topUpBtn(n);
    return "";
  };
  const topUpBtn = (n) => (n.short > 0
    ? ` <button class="chip mini needbtn" data-needgold="${n.amount}"
        title="Top your purse up to ${n.amount.toLocaleString()} potch — the ${n.short.toLocaleString()} you are short">＋ ${n.short.toLocaleString()}</button>`
    : "");

  const body = groups.map((g) =>
    groupHead(g) + (STARS_COLLAPSED[g.key] ? "" : g.rows.map(starRow).join(""))
  ).join("") || `<tr><td colspan="6" class="muted">no stars match this filter</td></tr>`;

  const fbtn = (v, l) => `<button class="chip${STARS_FILTER === v ? " on" : ""}" data-starsf="${v}">${l}</button>`;
  const kbtn = (v, l) => `<button class="chip${STARS_KIND === v ? " on" : ""}" data-starsk="${v}">${l}</button>`;
  const nextUp = next
    ? `<div class="nextup">Next in guide order: <b>${esc(next.c.name)}</b>
         <span class="ordn">#${next.n === null ? "?" : next.n}</span>
         <span class="muted">${esc(next.guideHow || next.how || "")}</span></div>` : "";

  $("#subview").innerHTML = `
    <div class="starshead">
      <div class="starsnum"><b>${got}</b> / ${total} <span class="muted">stars recruited</span></div>
      <div class="starsbar"><span style="width:${pct}%"></span></div>
      <div class="muted" style="font-size:12px">${pct}% · ${missingOpt} optional star${missingOpt === 1 ? "" : "s"} still gettable · ${multi} on multiple teams</div>
      ${nextUp}
    </div>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin:2px 0 4px">
      <span class="muted">Team spread:</span>
      <span class="tpill tH">H</span> ${counts.Hugo}
      <span class="tpill tC">C</span> ${counts.Chris}
      <span class="tpill tG">G</span> ${counts.Geddoe}
      <span class="tpill tT">T</span> ${counts.Thomas}
      <span class="tpill tS">S</span> ${counts[""]}
    </div>
    <div class="row" style="gap:10px;flex-wrap:wrap;margin:6px 0 10px">
      <span class="row" style="gap:4px">${fbtn("all", "All")}${fbtn("recruited", "Recruited")}${fbtn("missing", "Missing")}</span>
      <span class="row" style="gap:4px">${kbtn("all", "Any")}${kbtn("optional", "Optional")}${kbtn("story", "Story")}</span>
      <button class="chip" id="starsfold">${groups.every((g) => STARS_COLLAPSED[g.key]) ? "Expand all" : "Collapse all"}</button>
    </div>
    <table class="invtbl starstbl"><thead><tr><th class="ordn" title="position in the Suikosource recruitment guide">#</th><th>Character</th><th>Star</th><th>Status</th><th>Team(s)</th><th></th></tr></thead><tbody>${body}</tbody></table>`;

  $$("[data-starsf]").forEach((b) => (b.onclick = () => { STARS_FILTER = b.dataset.starsf; drawStars(); }));
  $$("[data-starsk]").forEach((b) => (b.onclick = () => { STARS_KIND = b.dataset.starsk; drawStars(); }));
  $$("[data-starsp]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.starsp; STARS_COLLAPSED[k] = !STARS_COLLAPSED[k]; drawStars();
  }));
  $("#starsfold").onclick = () => {
    const allOff = groups.every((g) => STARS_COLLAPSED[g.key]);
    groups.forEach((g) => { STARS_COLLAPSED[g.key] = !allOff; });
    drawStars();
  };
  $$("[data-starsadd]").forEach((b) => (b.onclick = () => {
    const c = charByRoster(+b.dataset.starsadd); setRecruit(c, true, RTEAM ? [RTEAM] : []); drawStars();
  }));
  $$("[data-needitem]").forEach((b) => (b.onclick = () => {
    const id = +b.dataset.needitem;
    // Re-derive the target at click time: an earlier click in this render already claimed a slot.
    const t = RecruitCore.bagForNeeds(s, leadName, (n) => (byName[n] ? byName[n].st.teams : []),
      Object.values(ADDED).flat());
    if (!t || t.slot === null) { setStatus("every bag is full — clear a slot in Inventory first"); return; }
    ADDED[t.bi] = (ADDED[t.bi] || []).concat(t.slot);
    // Runes, armour and key items are one per slot with the count left at 0; only real
    // stackables carry a quantity. Same rule the Inventory tab writes.
    INV[t.slot] = itemStackable(id) ? { id, qty: 1 } : { id };
    // Point the Inventory tab at the sub-tab this item actually lands in. Key items and party
    // items are separate lists there, so a Screw staged while that tab is on Party Items would
    // be nowhere to be seen — which reads as an add that didn't take.
    INVCAT = itemCategory(id) === "key" ? "key" : "regular";
    setStatus(`${itemLabel(id)} → ${t.region}, slot ${t.slot} — staged, not yet saved`);
    drawStars(); refreshHealthBadge();
  }));
  $$("[data-needgold]").forEach((b) => (b.onclick = () => {
    const want = +b.dataset.needgold;
    const have = typeof GOLD === "number" ? GOLD : (s.global && s.global.gold) || 0;
    if (have >= want) return;
    GOLD = want;                          // top up by the shortfall, not a round number
    setStatus(`Gold ${have.toLocaleString()} → ${want.toLocaleString()} — staged, not yet saved`);
    drawStars(); refreshHealthBadge();
  }));
}

// ---- Health check -----------------------------------------------------------
// A lint over the save. The rules live in health-core.js (pure, unit-tested); this half is
// the panel, the "Fix" wiring and the tab badge.
//
// Two properties matter. It audits the EFFECTIVE save — what's on disk with the pending
// edits applied on top — so it catches both damage already in the file and damage you are
// about to write; and a Fix only *stages* its change into the same EDITS/INV/PARTY/RECRUIT
// maps every other control uses, so it is reviewable, resettable, and goes through the
// normal confirm-then-write path rather than touching bytes on its own.
let HEALTH_FILTER = "all";           // all | error | warn | info
const SEV_LABEL = { error: "Problem", warn: "Warning", info: "Note" };

// Lookups the audit needs but can't derive. Each is optional in health-core — a missing one
// disables its checks rather than guessing, which is why the guide-backed rules simply don't
// fire until the guide JSON has loaded.
function healthOpts() {
  return {
    item: (id) => (ITEM_BY_ID[id] ? { name: ITEM_BY_ID[id].name, cat: ITEM_BY_ID[id].cat } : null),
    skillName: (id) => (SKILL_BY_ID[id] && SKILL_BY_ID[id].name) || "#" + id,
    charName: (id) => REF.charById[id] || "id " + id,
    // party id -> roster slot, so the audit can find the character block behind a slot.
    partyRoster: (id) => (id in REF.charRoster ? REF.charRoster[id] : null),
    skillCap: (nm, sid) => (GUIDE ? GuideCore.skillCap(GUIDE, nm, sid) : null),
    runeSlot: (nm, key) => (GUIDE ? GuideCore.runeSlot(GUIDE, nm, key) : null),
  };
}
function runHealth() {
  const s = saves[curSlot];
  if (!s) return [];
  return HealthCore.audit(s, { edits: EDITS, inv: INV, party: PARTY, recruit: RECRUIT, gold: GOLD,
                               leader: LEADER },
    healthOpts());
}
// Tab badge: errors + warnings only. Notes are worth reading but shouldn't make the tab shout.
function refreshHealthBadge() {
  const btn = $("#healthTab"); if (!btn) return;
  const c = HealthCore.counts(runHealth());
  const n = c.error + c.warn;
  btn.textContent = n ? `Health (${n})` : "Health ✓";
  btn.classList.toggle("hz-bad", c.error > 0);
  btn.classList.toggle("hz-warn", c.error === 0 && c.warn > 0);
}

let HEALTH_ROWS = [];
function drawHealth() {
  if (GUIDE === null) loadGuideRefs().then(() => { if (SUB === "health") drawHealth(); });   // guide rules join once loaded
  const all = runHealth();
  const c = HealthCore.counts(all);
  HEALTH_ROWS = all.filter((f) => {
    if (HEALTH_FILTER !== "all" && f.sev !== HEALTH_FILTER) return false;
    if (SEARCH && !(f.title + " " + f.detail + " " + f.group).toLowerCase().includes(SEARCH)) return false;
    return true;
  });
  const fixable = HEALTH_ROWS.filter((f) => f.fix);

  const verdict = !all.length
    ? `<div class="hz-ok">✓ Nothing to flag — this save and your pending edits look consistent.</div>`
    : `<div class="hz-nums">
         <span class="hz-c error">${c.error}</span> problem${c.error === 1 ? "" : "s"} ·
         <span class="hz-c warn">${c.warn}</span> warning${c.warn === 1 ? "" : "s"} ·
         <span class="hz-c info">${c.info}</span> note${c.info === 1 ? "" : "s"}</div>`;

  const fbtn = (v, l) => `<button class="chip${HEALTH_FILTER === v ? " on" : ""}" data-hf="${v}">${l}</button>`;

  const rows = HEALTH_ROWS.map((f, i) => `
    <div class="hz-item sev-${f.sev}">
      <div class="hz-sev">${SEV_LABEL[f.sev]}</div>
      <div class="hz-body">
        <div class="hz-t">${esc(f.title)}</div>
        <div class="hz-d">${esc(f.detail || "")}</div>
        <div class="hz-g">${esc(f.group)}</div>
      </div>
      <div class="hz-act">
        ${f.fix ? `<button class="chip mini" data-hfix="${i}">✓ ${esc(f.fix.label)}</button>` : ""}
        ${f.where ? `<button class="chip mini" data-hgo="${i}">Show</button>` : ""}
      </div>
    </div>`).join("") ||
    `<div class="muted" style="padding:8px 2px">${all.length ? "no findings match this filter" : "nothing to show"}</div>`;

  $("#subview").innerHTML = `
    <div class="hz-head">${verdict}</div>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin:8px 0 10px">
      ${fbtn("all", `All (${all.length})`)}${fbtn("error", `Problems (${c.error})`)}${fbtn("warn", `Warnings (${c.warn})`)}${fbtn("info", `Notes (${c.info})`)}
      ${fixable.length > 1 ? `<button class="chip" id="hzFixAll" style="margin-left:auto">✓ Fix all shown (${fixable.length})</button>` : ""}
    </div>
    <div class="hz-list">${rows}</div>`;

  $$("[data-hf]").forEach((b) => (b.onclick = () => { HEALTH_FILTER = b.dataset.hf; drawHealth(); }));
  $$("[data-hfix]").forEach((b) => (b.onclick = () => {
    applyFixOps(HEALTH_ROWS[+b.dataset.hfix].fix.ops);
    drawHealth(); refreshHealthBadge();
    setStatus("Fix staged — review it with Apply when you're done.", "");
  }));
  $$("[data-hgo]").forEach((b) => (b.onclick = () => {
    const w = HEALTH_ROWS[+b.dataset.hgo].where;
    SUB = w.sub; SEARCH = (w.search || "").toLowerCase();
    const sq = $("#sq"); if (sq) sq.value = w.search || "";
    showSub();
  }));
  const fa = $("#hzFixAll");
  if (fa) fa.onclick = () => {
    const n = fixable.length;
    fixable.forEach((f) => applyFixOps(f.fix.ops));
    drawHealth(); refreshHealthBadge();
    setStatus(`${n} fix${n === 1 ? "" : "es"} staged — review them with Apply.`, "");
  };
}

// Stage a fix into the same pending-edit maps the rest of the editor writes to. Nothing here
// touches the save; Apply still shows the old → new list first.
function applyFixOps(ops) {
  (ops || []).forEach((op) => {
    const ent = (ri) => (EDITS[ri] = EDITS[ri] || {});
    if (op.kind === "charField") ent(op.ri)[op.field] = op.value;
    else if (op.kind === "charStat") { const e = ent(op.ri); (e.stats = e.stats || {})[op.stat] = op.value; }
    else if (op.kind === "charEquip") { const e = ent(op.ri); (e.equip = e.equip || {})[op.slot] = op.value; }
    else if (op.kind === "charSkill") {
      const e = ent(op.ri); e.skills = e.skills || {};
      const sk = (e.skills[op.slot] = e.skills[op.slot] || {});
      if ("id" in op) sk.id = op.id;
      if ("rank" in op) sk.rank = op.rank;
    } else if (op.kind === "party") PARTY[op.slot] = op.value;
    else if (op.kind === "recruit") setRecruit(charByRoster(op.ri), op.recruited, undefined);
    else if (op.kind === "inv") {
      const e = (INV[op.slot] = INV[op.slot] || {});
      if ("id" in op) e.id = op.id;
      if ("qty" in op) e.qty = op.qty;
    } else if (op.kind === "gold") GOLD = op.value;
  });
}

// ---- Party -----------------------------------------------------------------
// ---- Field character -------------------------------------------------------
// Who you run around the map as is the party-leader byte at 0x12, and the engine loads the
// field model it names. It used to sit on the Overview card, but it is not a one-field
// property: picking someone rewrites the party, and two conditions have to hold for scenes
// not to freeze. Its own tab is where that fits, next to the Party tab it acts on.
function drawField() {
  const s = saves[curSlot];
  const stock = s.global.partyLeader;
  const lead = LEADER !== null ? LEADER : stock;
  const mem = s.party || [];
  const eff0 = (PARTY[0] !== undefined ? PARTY[0] : mem[0]) || 0;
  const ship = (REF.fieldAvatars || []);
  $("#subview").innerHTML = `
    <label class="field" style="max-width:320px"><span>Who you walk around the map as</span>
      <button type="button" class="picker" id="leaderfld" data-val="${lead}"
              data-def="${stock}">${esc(charLabel(lead))}</button></label>
    <div class="muted" style="font-size:12px;margin:6px 0 0">
      This is the party-leader byte at <b>0x12</b>. The picker offers the ${ship.length} the
      game hands you itself — ${ship.map((id) => esc(REF.charById[id] || "id " + id)).join(", ")}
      — because those are the only ids whose field model the engine will load.
      <div id="leaderparty" style="margin:4px 0 0;color:var(--acc2)"></div></div>
    <h3 class="sec">How it works</h3>
    <div class="muted" style="font-size:12px" data-sum="You can play as a stand-in, but the character they are standing in for has to leave the party. Everything below is disassembly confirmed in play.">
      <p style="margin:0 0 8px">Everything below was worked out by disassembling the boot ELF and
      then confirming it in play, each way round. The short version: <b>you can play as a
      stand-in, but the character they are standing in for has to leave the party.</b></p>

      <p style="margin:0 0 4px"><b>1 · The byte names a model.</b> Save offset <code>0x12</code>
      is the party leader, and the engine feeds it to a hardcoded comparison chain that decides
      which field model to request. Eight ids get a hit; anything else is not an error — the
      request is simply never made, and you keep whatever model was already resident. That is
      why the picker offers eight and not the full roster.</p>

      <p style="margin:0 0 4px"><b>2 · Cutscenes drive party slot 1, not the leader byte.</b>
      Scene actors are built from the party list in order, so <i>actor slot 0 is party slot
      1</i>. Scripts move and speak as actor slot 0, while the camera follows the leader byte.
      If those are two different people, a scene animates one of them and then waits forever
      on the other — the freeze that looks like the game hanging on a line of dialogue. So the
      pick goes into slot 1.</p>

      <p style="margin:0 0 4px"><b>3 · The real character cannot also be in the party.</b>
      This is the one that is easy to miss. Each actor record is bound to a <i>character
      resource slot</i> by a lookup that walks the loaded slots and returns the <b>first</b>
      match for that character id. The party filler and the cast filler both run, and neither
      checks what the other did — so if a scene stages Hugo as cast <i>while Hugo is also in
      your party</i>, you get two actor records pointing at one model instance, and the scene
      never completes. Taking him out of the party is what makes it work: with only one record
      for him, your stand-in walks and talks through the scene in his place.
      <br>Removing him does <b>not</b> free a resource slot — the scene still loads him as cast.
      What it frees is the second claim on it.</p>

      <p style="margin:0 0 4px"><b>4 · What this tab does for you.</b> Picking someone stages
      both conditions in one go: it puts them in party slot 1 and takes the displaced character
      out of the party, and it tells you who it removed. If you would rather keep that character,
      the note offers a one-click swap instead — labelled with the fact that it is the
      configuration that freezes scenes. Nothing is written until <b>Apply</b>, and the battle
      formation is re-derived from the party list on save, so the two can never disagree.</p>

      <p style="margin:0 0 4px"><b>5 · The area does not limit the pick.</b> Field models ship
      per area archive, and most characters are in only a handful of them, which looked like a
      second condition to satisfy. In play it is not one: every character the picker offers
      worked everywhere it was tried. <code>ETC.BIN</code> carries all of them too, and a model
      already resident is not evicted on an area change — so the tab no longer warns about
      coverage.</p>

      <p style="margin:0"><b>6 · Blank dialogue is a different problem.</b> The leader byte also
      selects <i>whose</i> events and dialogue a town loads. Luc, Koroku, Sarah and Masked Luc
      each have their own index, and a town that ships nothing for that index gives you empty
      text boxes. That is fixed on the disc, not in the save — <b>ISO Editor → Story content</b>
      hands them Hugo's events instead. It fixes <i>empty</i> dialogue; a scene that
      <i>hangs</i> is the party conditions above.</p>
    </div>
    ${eff0 && lead && eff0 !== lead ? `<div class="warnbox" style="margin:8px 0 0">
      Party slot 1 holds ${esc(charLabel(eff0))} but the field character is
      ${esc(charLabel(lead))}. Scenes drive slot 1 and the camera follows the field character —
      while those disagree, a scene will freeze. Re-pick above to put them in step, or fix it
      on the <b>Party</b> tab.</div>` : ""}
    <div class="warnbox" style="margin:8px 0 0" data-sum="Hugo, Chris, Geddoe and Thomas are the story-safe picks; the rest work in scenes but are stand-ins. Keep a backup save.">
      <b>Hugo, Chris, Geddoe and Thomas are the story-safe picks.</b> The rest work <i>in
      scenes</i> — Koroku has been played through scene after scene, speaking the protagonist's
      lines — but they are stand-ins, so a scene written around something only the real
      protagonist has can still go wrong, and some of them have limits outside scenes too
      (see <b>Known limitations</b> below). Story scripts also set this byte at chapter transitions, so a change here
      holds until the next scene that sets it. Keep a backup save.</div>
    <h3 class="sec">Known limitations</h3>
    <div class="muted" style="font-size:12px;margin:0 0 8px">
      What playing them actually turned up. Anyone not listed simply hasn't been tested enough
      to say — which is not the same as working.
    </div>
    ${Object.keys(AVATAR_NOTES).map(Number).map((id) => {
      const n = AVATAR_NOTES[id];
      return `<div style="margin:0 0 8px;padding:8px 10px;border:1px solid var(--line);
                  border-left:3px solid ${n.ok ? "var(--ok)" : "var(--crimson)"};border-radius:8px">
        <div><b>${esc(charLabel(id))}</b> — <span style="color:${n.ok ? "var(--ok)" : "var(--crimson)"}">
          <b>${n.ok ? "✓" : "✕"} ${esc(n.short)}</b></span></div>
        <div class="muted" style="font-size:12px;margin:4px 0 0">${esc(n.long)}</div></div>`;
    }).join("")}
    <div class="muted" style="font-size:12px;margin:8px 0 0" data-sum="Koroku is the one real casualty and it is not fixable from here — his model carries none of the fourteen examine / pick-up clips.">
      <b>Koroku is the one real casualty, and it isn't fixable from here.</b> The disc's motion
      table names a clip per animation slot, and his model carries <b>none of the fourteen
      examine / pick-up clips</b> — Luc's carries them, which is exactly why Luc is fine.
      Three patches were built and played against it and none worked, so it's recorded as a
      limitation rather than a fix pending. Play as him and walk past the herbs; switch to a
      protagonist to collect. The write-up is in
      <code>docs/FIELD_CHARACTER_RESEARCH.md</code>.
    </div>`;
  $("#leaderfld").onclick = () => {
    const btn = $("#leaderfld"), cur = +btn.dataset.val;
    openPicker("Field character", avatarList(cur), cur, (id) => {
      btn.dataset.val = id; btn.textContent = charLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      LEADER = id;
      // A leader who isn't in the party has no actor record, so the engine's "find the
      // player" lookup returns nothing and any scripted scene freezes when it needs you to
      // act. Confirmed in play. The game never writes that state, so neither do we — the
      // leader goes into slot 1, and the character being stood in for comes out.
      const nm = (x) => REF.charById[x] || "id " + x;
      // Snapshot the party edits as they stood BEFORE this pick, so offering the other
      // variant re-stages from the same starting point instead of wiping edits the user
      // made by hand.
      const snap = Object.assign({}, PARTY);
      const before = (s.party || []).slice(0, 6).map((v, i) => (PARTY[i] !== undefined ? PARTY[i] : v) || 0);
      const stage = (keep) => {
        Object.keys(PARTY).forEach((k) => delete PARTY[k]);
        Object.assign(PARTY, snap);
        const r = promoteToLead(before, id, nm, keep);
        r.party.forEach((v, i) => { if (v !== undefined) PARTY[i] = v; });
        return r;
      };
      const r = stage(false);            // remove by default — the configuration that works
      DISPLACED = r.displaced || 0;
      const warn = $("#leaderparty");
      if (warn) {
        // Removal is the default because it is the confirmed-working configuration. Keeping
        // them is still offered, labelled with what it does, rather than silently withheld.
        // A known problem with the pick outranks the party bookkeeping — say it at the moment
        // of choosing, not only in the table further down the page. Both the first render and
        // the "keep instead" re-render go through this, so the warning can't be dropped by
        // taking the second path.
        const kn = AVATAR_NOTES[id];
        const head = kn && !kn.ok
          ? `<b style="color:var(--crimson)">${esc(nm(id))}: ${esc(kn.short)}.</b> ${esc(kn.long)}<br>`
          : "";
        const paint = (note, offerKeep) => {
          warn.innerHTML = head + esc(note) + (offerKeep
            ? ` <button type="button" id="keepDisplaced" class="linklike" style="text-decoration:underline">Keep ${esc(nm(DISPLACED))} in the party instead</button>`
            : "");
          const kb = $("#keepDisplaced");
          if (kb) kb.onclick = () => { const r2 = stage(true); DISPLACED = 0; paint(r2.note, false); };
        };
        paint(r.note, !!DISPLACED);
      }
    }, (id) => String(id).padStart(3, "0"));
  };
}

// Mount model ids, as they appear in party positions 7-12. Only 308/309 occur in a stock
// game — the consumer clamps with `(v - 308) < 2` — but a patched disc can show the other
// ids the ground-ride saddle table knows, so name those too rather than print a bare number.
// Mirrors s3save.MOUNT_MODEL_NAMES.
// Party ids that ship with an assigned horse in the ISO's list2 +0x66 field: the six Zexen
// Knights. Chris carries her own horse (309), the rest the knight horse (308). Hardcoded
// because +0x66 lives in the ISO, not the save — a save alone cannot know who is eligible,
// and an empty Mount cell is much more useful when it can say whether one was expected.
// The ISO editor's Mounts tab can give the field to anyone, so this is "stock", not "all".
const STOCK_HORSE_OWNERS = { 2: "Chris", 13: "Roland", 18: "Leo", 20: "Percival", 21: "Borus", 54: "Salome" };

// Offered in the party editor's Mount column. The model id is read straight out of the party
// list, without the `(v - 308) < 2` clamp the ISO's +0x66 field is subject to, so any of these
// works — but only when the rider has +0x66 set at all, which is what makes the game look.
const MOUNT_CHOICES = [
  [0, "— none —"], [308, "Zexen-knight horse"], [309, "Chris's horse"],
  [325, "Karaya horse"], [353, "Karaya horse #2"], [42, "Ruby"],
  [359, "Le Buque horse"], [360, "Le Buque horse #2"],
];

const MOUNT_MODELS = {
  308: "Zexen-knight horse", 309: "Chris's horse", 325: "Karaya horse", 353: "Karaya horse #2",
  42: "Ruby", 209: "Le Buque horse (mskn)", 359: "Le Buque horse", 360: "Le Buque horse #2",
};

function drawParty() {
  const s = saves[curSlot];
  const mem = s.party || [];
  const anyFilled = mem.some((c) => c > 0);
  // Slot 1 is not just "first". Scene actors are built from this list in order, so actor slot
  // 0 IS party slot 1, and scripts drive the protagonist as actor slot 0 while the camera
  // follows the leader byte. Disagree and a scene animates one actor while waiting on
  // another — the Karaya Village freeze. Worth saying on the row itself.
  const lead = LEADER !== null ? LEADER : s.global.partyLeader;
  const eff0 = PARTY[0] !== undefined ? PARTY[0] : mem[0];
  // "Remove" was only reachable by opening the picker and choosing the `empty` row, which
  // nobody finds. An explicit ✕ per occupied slot is the obvious control.
  const eff = (slot) => (PARTY[slot] !== undefined ? PARTY[slot] : mem[slot]) || 0;
  // Positions 7-12 of the same table hold each member's MOUNT (see s3save.PARTY_MOUNT_SLOTS).
  // Read-only here: the game writes it when the party is formed, from the character's
  // assigned-horse field, and showing it is how you can tell a mount is actually staged.
  const mounts = s.partyMounts || [];
  const mountLabel = (m) => (MOUNT_MODELS[m] || `model ${m}`);
  // The formation table (0x3240) holds, per battle position, the 1-based index of the member
  // that stands there — an index into the DENSE list of filled party slots, not the slot
  // number. Invert it so a party row can state its own battle position instead of the row
  // number being assumed to be it.
  const form = s.formation || [];
  const dense = [];                       // party slot -> 1-based member index
  mem.forEach((cid, slot) => { if (cid) dense[slot] = dense.filter((x) => x).length + 1; });
  const battlePos = {};                   // member index -> 1-based battle position
  form.forEach((mi, pos) => { if (mi && battlePos[mi] === undefined) battlePos[mi] = pos + 1; });
  const posOf = (slot) => (dense[slot] ? battlePos[dense[slot]] : undefined);
  // A member with NO position is the real fault — the game builds the party from this table,
  // so they simply will not appear. A member at a position other than their slot number is
  // NOT a fault: the six positions are a battle layout, and the game itself writes reordered
  // ([1,3,4,2,6,5]) and spread ([1,0,3,0,2,0]) tables. An earlier build of this view warned
  // on those, which fires on perfectly healthy saves.
  const orphaned = mem.filter((cid, slot) => cid && posOf(slot) === undefined).length;
  const rows = mem.map((cid, slot) => {
    const now = eff(slot);
    const mv = (PMOUNT[slot] !== undefined ? PMOUNT[slot] : mounts[slot]) || 0;
    // The mount belongs to whoever is in the slot *in the file*. If this slot has a pending
    // edit the pairing is about to be re-derived on Apply, so say so instead of implying
    // the horse now belongs to the new pick.
    const pending = PARTY[slot] !== undefined && PARTY[slot] !== cid;
    const known = MOUNT_CHOICES.some(([v]) => v === mv);
    const dirtyM = PMOUNT[slot] !== undefined && PMOUNT[slot] !== (mounts[slot] || 0);
    const hint = !mv && now && STOCK_HORSE_OWNERS[now] ? ' <span class="dim">· expected</span>' : "";
    const mountCell = !now ? '<span class="dim">—</span>'
      : pending ? `<span class="dim" title="This slot has an unapplied character change; the mount is re-paired on Apply.">${
            mv ? esc(mountLabel(mv)) : "—"} <span class="dim">· re-paired on Apply</span></span>`
      : `<select class="pmount${dirtyM ? " dirty" : ""}" data-pmount="${slot}">${
            MOUNT_CHOICES.map(([v, lbl]) => `<option value="${v}"${v === mv ? " selected" : ""}>${esc(lbl)}</option>`).join("")
          }${known ? "" : `<option value="${mv}" selected>model ${mv}</option>`}</select>${hint}`;
    const bp = posOf(slot);
    const fCell = !cid ? '<span class="dim">—</span>'
      : bp === undefined ? '<span class="tag bad" title="No formation entry — this member will not appear in battle.">not placed</span>'
      : `<span class="dim">${bp}</span>`;
    return `<tr>
      <td class="sl">Slot ${slot + 1}${slot === 0 ? ' <span class="dim">· leader</span>' : ""}</td>
      <td><div class="party-row">
        <button type="button" class="picker" data-partyslot="${slot}" data-val="${now}" data-def="${cid}">${esc(charLabel(now))}</button>${
        now ? `<button type="button" class="chip mini party-x" data-partydrop="${slot}" title="Remove from the party" aria-label="Remove from the party">✕</button>` : ""}
      </div></td>
      <td>${fCell}</td>
      <td>${mountCell}</td></tr>`;
  }).join("");
  const mismatch = anyFilled && lead && eff0 !== lead;
  $("#subview").innerHTML =
    (anyFilled ? "" : `<div class="warnbox">This save's active-party table is empty — common in early chapters where story events set the field party. Assignments here may be overwritten by the next event on a very early save.</div>`) +
    (mismatch ? `<div class="warnbox" data-sum="Party slot 1 and the field character disagree, which freezes scripted scenes. Set them to the same character.">Slot 1 holds ${esc(REF.charById[eff0] || "id " + eff0)} but the
       <b>field character</b> is ${esc(REF.charById[lead] || "id " + lead)}. Scripted scenes drive the
       protagonist as party slot 1 while the camera follows the field character — when those disagree
       a scene animates one and waits on the other, and freezes. Set them to the same character.</div>` : "") +
    `<div class="muted" style="margin:0 0 8px;font-size:12px" data-sum="This is the party list, not the battle formation — that table is re-derived from this list every time you Apply.">This is the <b>party list</b>
       (save <code>0x3216</code>) — who is in your party, in order. It is not the <b>battle
       formation</b> (<code>0x3240</code>), which is where they stand in a fight; that table is
       re-derived from this list every time you Apply, so it can never disagree with it.</div>` +
    (orphaned ? `<div class="warnbox">${orphaned} party member${orphaned === 1 ? " has" : "s have"}
       no place in the battle formation, so ${orphaned === 1 ? "they" : "they"} will not appear in
       battle. Run the health check — it can rebuild the table.</div>` : "") +
    `<table class="invtbl"><thead><tr><th>Party</th><th>Character</th><th>Battle pos.</th><th>Mount</th></tr></thead><tbody>${rows}</tbody></table>` +
    (anyFilled ? `<div class="card" style="margin:12px 0 0">
      <div class="bag-h">Battle formation <span class="u">save 0x3240 · six positions</span></div>
      <div class="muted" style="margin:0 0 8px" data-sum="A separate table from the party list, and the one the game actually reads to build the party.">A <b>separate table</b> from the party list, and the
        one the game actually reads to build the party. Each position holds the <i>index</i> of a
        party member, so gaps and reordering are normal — the game writes both. It is also what a
        story join looks at for free space, not the party list.</div>
      <table class="invtbl"><thead><tr><th>Position</th><th>Who stands there</th><th>Mount</th></tr></thead><tbody>${
        form.slice(0, 6).map((mi, pos) => {
          const slot = mi ? mem.findIndex((c, k) => dense[k] === mi) : -1;
          const who = mi && slot >= 0 ? charLabel(eff(slot))
                    : mi ? `<span class="tag bad">member ${mi} — no such party member</span>`
                    : '<span class="dim">empty</span>';
          const mv2 = slot >= 0 ? (mounts[slot] || 0) : 0;
          const mc = mv2 ? `<span class="tag">${esc(mountLabel(mv2))}</span>` : '<span class="dim">—</span>';
          return `<tr><td class="sl">${pos + 1}</td><td>${who}</td><td>${mc}</td></tr>`;
        }).join("")}</tbody></table>
      <div class="muted" style="margin:8px 0 0;font-size:12px">${
        form.filter((v) => !v).length} of 6 free — a character who joins by story event needs one
        of these empty, or the join is silently dropped.</div></div>` : "") +
    (anyFilled ? `<div class="muted" style="margin:8px 0 0;font-size:12px" data-sum="A mount is staged six positions along in the same table, and the game rewrites that slot from the ISO's assigned-horse field on every party change.">A <b>mount</b> is staged
       in the same table, six positions along (save <code>0x3222</code>). Removing a member takes
       their mount with them.
       <br><b>Two halves decide whether a horse appears.</b> This dropdown picks <i>which</i> model
       — read straight out of the party list, with none of the 308/309 clamp the ISO field has, so
       any horse here is legal. Whether one is staged <i>at all</i> is the rider's assigned-horse
       field in the ISO (<b>Mounts</b> tab): the game only looks six positions along when that is
       set. Stock, only the six Zexen Knights have it.
       <br><b>Not durable on its own.</b> The game rewrites this slot from that ISO field every
       time the party is formed, so a model picked here survives until the next party change unless
       the ISO agrees with it.${
         mounts.some((m) => m) ? ""
           : " Nothing is staged in this save — none of these characters carries the field."}</div>` : "");
  $$("select[data-pmount]").forEach((sel) => (sel.onchange = () => {
    const slot = +sel.dataset.pmount;
    const was = (saves[curSlot].partyMounts || [])[slot] || 0;
    if (+sel.value === was) delete PMOUNT[slot]; else PMOUNT[slot] = +sel.value;
    drawParty();
  }));
  $$("[data-partydrop]").forEach((b) => (b.onclick = () => {
    PARTY[+b.dataset.partydrop] = 0;
    drawParty();
  }));
  $$("button.picker[data-partyslot]").forEach((btn) => (btn.onclick = () => {
    const slot = +btn.dataset.partyslot, cur = +btn.dataset.val;
    openPicker(`Party slot ${slot + 1}`, charList(cur), cur, (id) => {
      btn.dataset.val = id; btn.textContent = charLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      PARTY[slot] = id;
      drawParty();                       // the slot-1/leader warning depends on what was picked
    }, (id) => String(id).padStart(3, "0"));
  }));
}

// ---- Inventory -------------------------------------------------------------
// The four pre-merge carried bags, by the label s3save.inv_regions() gives them.
const TEAM_BAGS = ["Hugo", "Chris", "Geddoe", "Thomas"];
function drawItems() {
  const s = saves[curSlot];
  const inv = s.inventory || [];
  const wantKey = INVCAT === "key";
  // Slots staged this session — this tab's "+ Add item" and the 108-Stars checklist's
  // "＋ add to <bag>" both park a slot in ADDED and write the item into INV. They are part of
  // the inventory the moment they are staged, so they count toward the tab badges and the
  // bag's used tally; a Screw that lands in Hugo's bag while the badge still reads
  // "Key / Valuables (0)" reads as an add that silently failed.
  const stagedIn = (bi) => ADDED[bi] || [];
  const stagedId = (sl) => (INV[sl] || {}).id || 0;
  const stagedIds = Object.values(ADDED).flat().map(stagedId).filter(Boolean);
  const nKey = inv.reduce((a, b) => a + b.items.filter((it) => it.category === "key").length, 0)
    + stagedIds.filter((id) => itemCategory(id) === "key").length;
  const nReg = inv.reduce((a, b) => a + b.items.length, 0)
    + stagedIds.length - nKey;

  // Equipment, runes and key items are ONE PER SLOT in this game: the count field is 0 and
  // several copies live in several slots. A count > 0 on one of them is an entry the game
  // never writes — it displays, but the whole slot is freed the moment one item leaves it
  // (that is why attaching one Fury Rune took the spares with it). So the Qty cell is only
  // editable for the items that really stack, and adding N copies allocates N slots.
  const qtyCell = (it) => it.stackable
    ? `<input type="number" min="1" max="9" style="width:74px" data-invslot="${it.slot}" data-k="qty" data-def="${it.qty}" value="${Math.max(1, it.qty)}">`
    : `<span class="muted" title="this item is one-per-slot — the game stores several copies as several slots, with the count left at 0">1 <span class="dim">per slot</span></span>`;
  // A staged slot is flagged the way every other pending edit is — changed-row tint plus a
  // "staged" pill — so it can't be mistaken for something the save already held. Its picker's
  // baseline is 0 (the empty slot it came from), which keeps it marked whatever you pick.
  const rowHTML = (it) => `<tr class="${it.added ? "dirtyrow" : ""}">
      <td class="sl">${it.slot}</td>
      <td><button type="button" class="picker${it.added && it.id ? " dirty" : ""}" data-invslot="${it.slot}" data-k="id" data-val="${it.id}" data-def="${it.added ? 0 : it.id}">${esc(itemLabel(it.id))}</button>${
        it.added && it.id ? ` <span class="pill" title="added this session — staged, not yet written to the save">staged</span>` : ""}${
        it.displayed ? ` <span class="pill" title="this item is currently on display in the castle">on display</span>` : ""}</td>
      <td>${qtyCell(it)}</td>
      <td class="ty">${it.category}</td>
      <td><button class="rm mini" data-clearslot="${it.slot}" title="remove">✕</button></td></tr>`;

  const merged = !!(s.global && s.global.merged);
  const bags = inv.map((bag, bi) => {
    const items = bag.items.filter((it) => (it.category === "key") === wantKey &&
      (!SEARCH || (ITEM_BY_ID[it.id]?.name || "").toLowerCase().includes(SEARCH) ||
       String(it.slot) === SEARCH || it.id.toString(16).includes(SEARCH)));
    // A slot added this session shows whatever has been staged into it — the checklist's
    // "＋ get it" fills one in directly, and an empty row where the Rose Brooch is supposed to
    // be would read as if the add had failed. Still-empty ones stay in the tab you added from.
    const added = stagedIn(bi).map((sl) => {
      const st = INV[sl] || {}, id = st.id || 0;
      return { slot: sl, id, added: true, qty: st.qty || 0, stackable: id ? itemStackable(id) : true,
               category: id ? itemCategory(id) : (wantKey ? "key" : "consumable") };
    }).filter((r) => !r.id || (r.category === "key") === wantKey);
    const list = items.concat(added);
    // Only append AFTER the bag's last used entry: the game keeps each bag packed from its
    // base and adds new pickups at the tail, so a slot in an interior gap can be dropped
    // the next time it repacks the list.
    const free = (bag.appendSlots || bag.freeSlots || []).filter((sl) => !stagedIn(bi).includes(sl));
    // What the bag holds once the staged adds are written — an empty slot claimed by
    // "+ Add item" isn't an item yet, so it only comes off `free`, not onto `used`.
    const used = bag.used + stagedIn(bi).filter(stagedId).length;
    const rows = list.map(rowHTML).join("") || `<tr><td colspan="5" class="muted">no items</td></tr>`;
    // A team's CARRIED bag being empty before the merge means their chapter hasn't started:
    // the game stocks that bag itself at the start of the chapter, overwriting whatever is
    // in it, so anything added now is thrown away. (Their storage list filling up later is
    // normal and says nothing, so the note is only shown on the carried bags.)
    const unstarted = !merged && bag.used === 0 && TEAM_BAGS.includes(bag.region)
      ? `<div class="warnbox" style="margin:6px 0 0">This bag is empty, which means ${esc(bag.region)}'s chapter hasn't started yet.
           The game stocks the bag when that chapter begins and overwrites what's there — so add items after you've played as them, not before.</div>`
      : "";
    return `<div class="bag"><div class="bag-h">${esc(bag.region)}
        <span class="u">${used}/${bag.capacity} slots</span>
        ${free.length ? `<button class="chip mini" data-addbag="${bi}" data-freeslot="${free[0]}">+ Add item</button>
           <span class="u">${free.length} free</span>` : `<span class="u">bag full</span>`}</div>
      ${unstarted}
      <table class="invtbl"><thead><tr><th>Slot</th><th>Item</th><th>Qty</th><th>Type</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");

  $("#subview").innerHTML = `<div class="subtabs">
      <button class="chip${wantKey ? "" : " on"}" data-invcat="regular">Party Items (${nReg})</button>
      <button class="chip${wantKey ? " on" : ""}" data-invcat="key">Key / Valuables (${nKey})</button></div>
    <div class="muted" style="margin:-4px 2px 10px">${merged
      ? `The parties have merged: one shared party bag plus one shared storage.`
      : `Before the merge each of Hugo / Chris / Geddoe / Thomas has their own bag and their own storage. They all collapse into one shared bag + storage when the parties join, which rewrites every list — so treat additions made now as temporary until you are past that point.`}
      <br>Runes, armour and key items are one per slot: to carry three Fury Runes, add three slots, not one slot with a count of 3.</div>
    ${bags || `<div class="muted">none</div>`}`;

  $$("[data-invcat]").forEach((b) => (b.onclick = () => { INVCAT = b.dataset.invcat; drawItems(); }));
  $$("input[data-invslot]").forEach((inp) => (inp.onchange = () => {
    const sl = +inp.dataset.invslot;
    // The game's count field only holds 1-9, so pin the input to what will actually be
    // stored rather than letting a typed 50 look accepted and come back as 9.
    const v = Math.max(1, Math.min(ITEM_QTY_MAX, +inp.value || 1));
    inp.value = v;
    (INV[sl] = INV[sl] || {}).qty = v;
    inp.classList.toggle("dirty", String(v) !== inp.dataset.def);
  }));
  $$("button.picker[data-invslot]").forEach((btn) => (btn.onclick = () => {
    const sl = +btn.dataset.invslot, cur = +btn.dataset.val;
    openPicker("Choose item", itemList("empty"), cur, (id) => {
      btn.dataset.val = id; btn.textContent = itemLabel(id);
      btn.classList.toggle("dirty", String(id) !== btn.dataset.def);
      (INV[sl] = INV[sl] || {}).id = id;
      syncQtyCell(btn, sl, id);
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

// The count field is real only for consumables/food and the 0x1F0-0x1FF trade goods;
// everything else is one item per slot with the count left at 0. The rules (and the nine
// ids that contradict the bands) mirror s3save.item_stackable / item_category and live in
// health-core.js, so the inventory UI and the health audit share one copy. This is only for
// display — the engine decides what actually gets stored, and it also consults how the save
// already holds that item.
const itemStackable = HealthCore.itemStackable;
const itemCategory = HealthCore.itemCategory;
const ITEM_QTY_MAX = HealthCore.ITEM_QTY_MAX;   // s3save.ITEM_QTY_MAX — count domain is 0-9

// Picking a different item can flip a row between "has a count" and "one per slot", so the
// Qty cell is rebuilt in place (a full redraw would drop the other rows' staged edits).
function syncQtyCell(btn, slot, id) {
  const row = btn.closest("tr");
  const cell = row?.children[2];
  if (row?.children[3]) row.children[3].textContent = id ? itemCategory(id) : "";
  if (!cell) return;
  if (itemStackable(id)) {
    const q = Math.max(1, (INV[slot] && INV[slot].qty) || 1);
    cell.innerHTML = `<input type="number" min="1" max="9" style="width:74px" data-invslot="${slot}" data-k="qty" data-def="" value="${q}">`;
    const inp = cell.firstElementChild;
    inp.onchange = () => {
      const v = Math.max(1, Math.min(ITEM_QTY_MAX, +inp.value || 1));
      inp.value = v; (INV[slot] = INV[slot] || {}).qty = v; inp.classList.add("dirty");
    };
  } else {
    cell.innerHTML = `<span class="muted" title="this item is one-per-slot — the game stores several copies as several slots, with the count left at 0">1 <span class="dim">per slot</span></span>`;
    if (INV[slot]) delete INV[slot].qty;      // the engine forces 0 for these anyway
  }
}

// ---- Write & download ------------------------------------------------------
function hasChanges() {
  return Object.keys(EDITS).length || Object.keys(INV).length || Object.keys(NAMES).length ||
    Object.keys(PARTY).length || Object.keys(PMOUNT).length || Object.keys(RECRUIT).length || GOLD !== null ||
    LEADER !== null || Object.keys(CARRY).length ||
    Object.keys(TRIN.lit).length || Object.keys(TRIN.stage).length;
}

const RANK_LABEL = (v) => (RANK_TIERS.find((t) => t[0] === v) || [v, "?"])[1];

// Build a human-readable old→new list of everything the write will change.
function buildDiff() {
  const s = saves[curSlot];
  const rows = [];
  const byRi = {}; s.characters.forEach((c) => (byRi[c.rosterIndex] = c));
  const invBySlot = {}; (s.inventory || []).forEach((b) => b.items.forEach((it) => (invBySlot[it.slot] = it)));
  const FIELD_LABEL = { level: "Level", weaponLv: "Weapon Lv", curHP: "Cur HP", maxHP: "Max HP",
                        expToNext: "EXP in level" };

  if (GOLD !== null && GOLD !== s.global.gold) rows.push({ g: "Gold", t: `${s.global.gold} → ${GOLD}` });
  if (LEADER !== null && LEADER !== s.global.partyLeader)
    rows.push({ g: "Field character", t: `${charLabel(s.global.partyLeader)} → ${charLabel(LEADER)}` });
  Object.entries(CARRY).forEach(([g, on]) => {
    const f = s.carryover?.[g] || {};
    if (!!on !== !!f.loaded)
      rows.push({ g: "Carryover", t: `${g === "s1" ? "Suikoden I" : "Suikoden II"} data loaded: ${f.loaded ? "yes" : "no"} → ${on ? "yes" : "no"}` });
  });
  {
    const tr = s.trinity || { povs: [], main: {} };
    const TR = REF.trinity || { povs: [], main: { chapters: [], labels: {} } };
    const chapterOf = (rows_, v) => {
      const hit = (rows_ || []).filter((c) => v >= c.value).pop();
      return v && hit ? hit.chapter : 0;
    };
    Object.entries(TRIN.lit).forEach(([k, on]) => {
      const p = (tr.povs || []).find((x) => x.key === k); if (!p || !!on === !!p.lit) return;
      rows.push({ g: "Trinity Sight", t: `${p.name}'s flame: ${p.lit ? "lit" : "dark"} → ${on ? "lit" : "dark"}` });
    });
    Object.entries(TRIN.stage).forEach(([k, v]) => {
      const isMain = k === "main";
      const cur = isMain ? (tr.main?.stage || 0) : ((tr.povs || []).find((x) => x.key === k)?.stage || 0);
      if (v === cur) return;
      const ref = isMain ? (TR.main || {}) : (TR.povs || []).find((x) => x.key === k) || {};
      const label = (ch) => !ch ? "not started"
        : isMain ? ((ref.labels || {})[String(ch)] || `chapter ${ch}`) : `chapter ${ch}`;
      const name = isMain ? (ref.name || "Main story") : ((tr.povs || []).find((x) => x.key === k)?.name || k);
      rows.push({ g: "Trinity Sight",
        t: `${name}: ${label(chapterOf(ref.chapters, cur))} (stage ${cur}) → ${label(chapterOf(ref.chapters, v))} (stage ${v})` });
    });
  }
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
  // The write path re-derives the formation table from the party list on every party edit —
  // without it, a member dropped into an empty slot never appears in-game. Say so, otherwise
  // a "Recruit them / rebuild" fix that changes no visible slot looks like it does nothing.
  if (Object.keys(PARTY).length)
    rows.push({ g: "Party", t: "Battle formation: re-derived from the party list" });
  Object.entries(RECRUIT).forEach(([ri, v]) => {
    const c = byRi[ri] || byRi[+ri] || {}, who = c.name || `#${ri}`;
    if ("recruited" in v && v.recruited !== !!c.recruited) rows.push({ g: who, t: `Recruited: ${v.recruited ? "yes" : "no"}` });
    if (v.recruited && "teams" in v) {
      const before = (c.recruiters && c.recruiters.length ? c.recruiters.join(" + ") : "shared");
      const after = (v.teams && v.teams.length ? v.teams.join(" + ") : "shared");
      if (before !== after) rows.push({ g: who, t: `Teams: ${before} → ${after}` });
    }
  });
  Object.entries(PARTY).forEach(([slot, cid]) => {
    const old = (s.party || [])[+slot] || 0;
    if (cid !== old) rows.push({ g: "Party", t: `Slot ${+slot + 1}: ${charLabel(old)} → ${charLabel(cid)}` });
  });
  Object.entries(PMOUNT).forEach(([slot, mid]) => {
    const old = (s.partyMounts || [])[+slot] || 0;
    const nm = (m) => (m ? (MOUNT_MODELS[m] || `model ${m}`) : "none");
    if (mid !== old) rows.push({ g: "Party", t: `Slot ${+slot + 1} mount: ${nm(old)} → ${nm(mid)}` });
  });
  Object.entries(INV).forEach(([slot, ent]) => {
    const old = invBySlot[slot] || { id: 0, qty: 0 };
    const nid = "id" in ent ? ent.id : old.id;
    // Show the count the engine will actually store, not the raw request: one-per-slot items
    // are forced to 0 and stackables to at least 1.
    const nq = !nid ? 0 : !itemStackable(nid) ? 0
      : Math.max(1, Math.min(ITEM_QTY_MAX, "qty" in ent ? ent.qty : old.qty));
    // Show any non-zero count, not just a stackable's: clearing the bogus count an old build
    // left on a one-per-slot item is a real change, and "Fury Rune → Fury Rune" would hide it.
    const amt = (id, q) => (id && q ? ` ×${q}` : "");
    if (nid !== old.id || nq !== old.qty)
      rows.push({ g: "Inventory", t: `Slot ${slot}: ${itemLabel(old.id)}${amt(old.id, old.qty)} → ${itemLabel(nid)}${amt(nid, nq)}` });
  });
  return rows;
}

function openConfirm(rows, onConfirm, okLabel) {
  const groups = {}; rows.forEach((r) => (groups[r.g] = groups[r.g] || []).push(r.t));
  const body = Object.entries(groups).map(([g, ts]) =>
    `<div class="cf-group"><div class="cf-g">${esc(g)}</div>${ts.map((t) => `<div class="cf-row">${esc(t)}</div>`).join("")}</div>`).join("");
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Review changes">
      <div class="modal-h"><b>Review changes (${rows.length})</b><button class="modal-x" aria-label="close">✕</button></div>
      <div class="cf-list">${body}</div>
      <div class="modal-f"><button id="cfCancel">Cancel</button>
        <button class="primary" id="cfOk">${esc(okLabel || "Apply & download")}</button></div></div>`;
  document.body.appendChild(ov);
  const close = modalA11y(ov, () => ov.remove(), $("#cfOk", ov));   // focus trap + Esc + focus restore
  $(".modal-x", ov).onclick = () => close(); $("#cfCancel", ov).onclick = () => close();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  $("#cfOk", ov).onclick = () => { close(); onConfirm(); };
}

// ---- Suikoden II bonus ------------------------------------------------------
// The two carryover flags are only half of what loading a Suikoden II save does. The
// importer also upgrades three characters who were in Suikoden II — Viki, Futch and Belle —
// from THEIR Suikoden II record: level, weapon level and three runes. There is no way to
// derive those from a Suikoden III save, so this asks for the Suikoden II numbers and runs
// the game's own formulas over them (s3save.carryover_level / carryover_weapon_level), then
// stages the result as ordinary character edits for the normal review-and-apply path.
function openCarryoverBonus() {
  const py = PY; if (!py) return setStatus("Engine not ready.", "err");
  const s = saves[curSlot];
  const CR = REF.carryover || { chars: [], runes: [], runeSlots: [] };
  const byRi = {}; s.characters.forEach((c) => (byRi[c.rosterIndex] = c));
  const targets = CR.chars.filter((c) => byRi[c.rosterIndex]);
  if (!targets.length) return setStatus("None of the carryover characters exist in this save.", "warn");

  const runeOpts = (sel) => [`<option value="0">— none —</option>`].concat(
    (CR.runes || []).map((id) => `<option value="${id}"${id === sel ? " selected" : ""}>${esc(itemLabel(id))}</option>`)).join("");
  const rows = targets.map((t) => {
    const c = byRi[t.rosterIndex];
    return `<div class="cf-group" data-ri="${t.rosterIndex}">
      <div class="cf-g">${esc(c.name)} <span class="muted" style="font-weight:400">— now Lv ${c.level}, weapon Lv ${c.weaponLv}</span></div>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin:4px 0">
        <label class="field" style="max-width:150px"><span>Suikoden II level</span>
          <input type="number" min="0" max="99" value="0" data-s2lv></label>
        <label class="field" style="max-width:150px"><span>S2 weapon level</span>
          <input type="number" min="0" max="16" value="0" data-s2wl></label>
      </div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        ${(CR.runeSlots || []).map((slot) => `<label class="field" style="max-width:170px">
            <span>${esc(slot)}</span><select data-rune>${runeOpts(c.equip?.[slot] || 0)}</select></label>`).join("")}
      </div></div>`;
  }).join("");

  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Suikoden II bonus">
      <div class="modal-h"><b>Suikoden II bonus</b><button class="modal-x" aria-label="close">✕</button></div>
      <div class="cf-list">
        <div class="muted" style="padding:0 0 8px" data-sum="Enter what each character was in your Suikoden II save. The carryover can only ever level them up, and only seven runes can arrive this way.">Enter what each character was in your Suikoden II
          save. The level applied is the game's own: <code>cur + cur×max(0, S2level−50)/100</code>,
          capped at 99, +5 more if they were level 99 — so it can only ever level them up.
          Weapon level gains <code>max(0, S2weaponLv−10)/2</code>. Leave a value at 0 to skip it.
          Only these seven runes can arrive by carryover.</div>
        ${rows}</div>
      <div class="modal-f"><button id="cbCancel">Cancel</button>
        <button class="primary" id="cbOk">Stage bonus</button></div></div>`;
  document.body.appendChild(ov);
  const close = modalA11y(ov, () => ov.remove(), $("#cbOk", ov));
  $(".modal-x", ov).onclick = () => close(); $("#cbCancel", ov).onclick = () => close();
  ov.onclick = (e) => { if (e.target === ov) close(); };

  $("#cbOk", ov).onclick = () => {
    const req = {};
    $$("[data-ri]", ov).forEach((g) => {
      const ri = +g.dataset.ri, c = byRi[ri];
      req[ri] = { level: c.level, weaponLv: c.weaponLv,
                  s2Level: +$("[data-s2lv]", g).value || 0,
                  s2WeaponLv: +$("[data-s2wl]", g).value || 0,
                  runes: $$("[data-rune]", g).map((sel) => +sel.value || 0) };
    });
    let out;
    try { out = JSON.parse(py.runPython(`carryover_bonus(${JSON.stringify(JSON.stringify(req))})`)); }
    catch (e) { close(); return setStatus("Bonus failed: " + e.message, "err"); }
    let n = 0;
    Object.entries(out).forEach(([ri, fields]) => {
      const e = (EDITS[ri] = EDITS[ri] || {});
      Object.entries(fields).forEach(([k, v]) => {
        if (k === "equip") { e.equip = Object.assign(e.equip || {}, v); n += Object.keys(v).length; }
        else { e[k] = v; n++; }
      });
    });
    // The bonus only makes sense on a save the game would consider "Suikoden II loaded",
    // so tick the flag alongside it rather than leaving the two half-applied.
    if (n && !(s.carryover?.s2 || {}).loaded) CARRY.s2 = true;
    close();
    if (!n) return setStatus("Suikoden II bonus: those numbers change nothing (the import only levels up).", "warn");
    // NOT drawSlot() — that is the Reset button, and it would throw the staging away.
    const cb = $('input[data-carry="s2"]');
    if (cb && CARRY.s2 !== undefined) { cb.checked = CARRY.s2; cb.classList.add("dirty"); }
    refreshCoFold();
    showSub(); refreshHealthBadge();
    setStatus(`Staged ${n} change(s) from the Suikoden II bonus — review before applying.`, "ok");
  };
}

// ---- Save <-> JSON round-trip ----------------------------------------------
// Export a human-readable snapshot of the loaded save; re-import stages the diffs
// through the normal Apply pipeline (review modal + checksum + backup). Numeric ids
// drive import; every *name field (and keys starting with _) is a label, ignored.
const SAVE_JSON_FORMAT = "suikoden3-save";

function exportSaveJSON() {
  const s = saves[curSlot];
  const chars = s.characters.filter((c) => c.hasData || c.recruited).map((c) => {
    const equip = {}; EQ.forEach(([k]) => { const id = c.equip?.[k] || 0; if (id) equip[k] = { id, name: ITEM_BY_ID[id]?.name || ("#" + id) }; });
    const skills = (c.skills || []).filter((sk) => sk.id).map((sk) => ({ slot: sk.slot, id: sk.id, rank: sk.rank, name: SKILL_BY_ID[sk.id]?.name || ("#" + sk.id) }));
    return { rosterIndex: c.rosterIndex, name: c.name, recruited: !!c.recruited, teams: (c.recruiters || []),
      level: c.level, weaponLv: c.weaponLv, curHP: c.curHP, maxHP: c.maxHP, expToNext: c.expToNext,
      stats: Object.assign({}, c.stats), equip, skills };
  });
  const names = {}; (s.names || []).forEach((n) => (names[n.key] = n.value));
  const party = (s.party || []).map((id) => ({ id, name: id ? (REF.charById[id] || ("id " + id)) : null }));
  const inventory = (s.inventory || []).map((b) => ({ region: b.region,
    items: b.items.map((it) => Object.assign(
      { slot: it.slot, id: it.id, name: ITEM_BY_ID[it.id]?.name || ("#" + it.id) },
      // One-per-slot items (runes, armour, key items) carry no count; leaving it out keeps a
      // round-tripped JSON from reintroducing the malformed "one slot, count N" entry.
      it.stackable ? { qty: it.qty } : { _onePerSlot: true },
      it.displayed ? { _onDisplay: true } : {})) }));
  const out = { _format: SAVE_JSON_FORMAT, _schema: 1,
    _note: "Human-readable snapshot. Edit numeric ids/values, then re-import to stage them for Apply. Keys starting with _ and every *name field are read-only labels, ignored on import.",
    _folder: s.folder, _label: s.label, _playtime: s.global.playtime, _storyPhase: s.global.storyPhase,
    gold: s.global.gold, fieldCharacter: { id: s.global.partyLeader, name: REF.charById[s.global.partyLeader] || null },
    carryover: { s1: !!s.carryover?.s1?.loaded, s2: !!s.carryover?.s2?.loaded },
    // Trinity Sight: the flame per point of view plus its progress counter. Stages are the
    // game's own numbers (see s3save.TRINITY_POVS), so a hand-edited value round-trips.
    trinitySight: Object.assign({},
      ...(s.trinity?.povs || []).map((p) => ({ [p.key]: { lit: !!p.lit, stage: p.stage, _chapter: p.chapter, _name: p.name } })),
      { main: { stage: s.trinity?.main?.stage || 0, _chapter: s.trinity?.main?.chapter || 0 } }),
    names, party, characters: chars, inventory };
  const json = JSON.stringify(out, null, 2);
  const base = (origName || "save").replace(/\.[^.]+$/, "");
  downloadBytes(new TextEncoder().encode(json), `${base}.${s.folder || "slot"}.json`);
  setStatus(`Exported ${chars.length} characters + gold/names/party/inventory to JSON.`, "ok");
}

async function importSaveJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); }
  catch (e) { return setStatus("Import failed: file is not valid JSON.", "err"); }
  if (!data || data._format !== SAVE_JSON_FORMAT)
    return setStatus('Import failed: not a Suikoden III save JSON (missing "_format").', "err");

  const s = saves[curSlot];
  const byRi = {}; s.characters.forEach((c) => (byRi[c.rosterIndex] = c));
  const nameToCharId = {}; Object.entries(REF.charById).forEach(([id, nm]) => (nameToCharId[String(nm).toLowerCase()] = +id));
  // Ids drive edits: accept a raw number, an {id} object, or (for party) a character name.
  const idOf = (v) => v == null ? 0 : typeof v === "object" ? (v.id | 0)
    : typeof v === "string" ? (nameToCharId[v.toLowerCase()] || 0) : (v | 0);
  let staged = 0;

  if (typeof data.gold === "number") { GOLD = data.gold; staged++; }
  if (data.fieldCharacter != null) { const id = idOf(data.fieldCharacter); if (id) { LEADER = id; staged++; } }
  if (data.carryover && typeof data.carryover === "object")
    ["s1", "s2"].forEach((g) => { if (typeof data.carryover[g] === "boolean") { CARRY[g] = data.carryover[g]; staged++; } });
  if (data.trinitySight && typeof data.trinitySight === "object") {
    const tr = s.trinity || { povs: [], main: {} };
    Object.entries(data.trinitySight).forEach(([k, v]) => {
      if (!v || typeof v !== "object") return;
      const p = k === "main" ? tr.main : (tr.povs || []).find((x) => x.key === k);
      if (!p) return;                                  // unknown key: a label, not an edit
      if (typeof v.lit === "boolean" && v.lit !== !!p.lit) { TRIN.lit[k] = v.lit; staged++; }
      if (Number.isFinite(v.stage) && (v.stage | 0) !== (p.stage || 0)) { TRIN.stage[k] = v.stage | 0; staged++; }
    });
  }
  if (data.names && typeof data.names === "object") Object.entries(data.names).forEach(([k, v]) => {
    if (typeof v === "string" && (s.names || []).some((n) => n.key === k)) { NAMES[k] = v; staged++; }
  });
  if (Array.isArray(data.party)) data.party.forEach((p, slot) => { PARTY[slot] = idOf(p); staged++; });
  if (Array.isArray(data.characters)) data.characters.forEach((jc) => {
    const ri = jc && jc.rosterIndex;
    if (typeof ri !== "number" || !(ri in byRi)) return;   // skip unknown/guest roster slots
    const e = (EDITS[ri] = EDITS[ri] || {});
    ["level", "weaponLv", "curHP", "maxHP", "expToNext"].forEach((k) => { if (typeof jc[k] === "number") { e[k] = jc[k]; staged++; } });
    if (jc.stats && typeof jc.stats === "object") { e.stats = e.stats || {}; Object.entries(jc.stats).forEach(([st, val]) => { if (typeof val === "number") e.stats[st] = val; }); staged++; }
    if (jc.equip && typeof jc.equip === "object") { e.equip = e.equip || {}; EQ.forEach(([k]) => { if (k in jc.equip) e.equip[k] = idOf(jc.equip[k]); }); staged++; }
    if (Array.isArray(jc.skills)) { e.skills = e.skills || {}; jc.skills.forEach((sk) => { if (sk && typeof sk.slot === "number") e.skills[sk.slot] = { id: idOf(sk.id), rank: sk.rank | 0 }; }); staged++; }
    if (typeof jc.recruited === "boolean" || Array.isArray(jc.teams)) {
      RECRUIT[ri] = { recruited: jc.recruited !== false,
        teams: RecruitCore.RECRUITERS.filter((t) => (jc.teams || []).includes(t)) };
      staged++;
    }
  });
  if (Array.isArray(data.inventory)) data.inventory.forEach((b) => (b && Array.isArray(b.items) ? b.items : []).forEach((it) => {
    if (it && typeof it.slot === "number") {
      const id = idOf(it.id);
      INV[it.slot] = (typeof it.qty === "number" && itemStackable(id)) ? { id, qty: it.qty | 0 } : { id };
      staged++;
    }
  }));

  if (!staged) return setStatus("Import: nothing recognized to apply in that JSON.", "warn");
  const diff = buildDiff();
  if (!diff.length) return setStatus("Import: the JSON already matches this save — no changes.", "warn");
  const mode = (SUPPORTS_FS && fileHandle) ? "file" : SUPPORTS_SAVE_PICKER ? "saveas" : "download";
  const okLabel = mode === "file" ? `Apply import & save to ${origName}`
    : mode === "saveas" ? "Apply import & choose destination…" : "Apply import & download";
  setStatus(`Imported ${diff.length} change(s) — review to apply.`, "");
  openConfirm(diff, () => doApply(mode), okLabel);
}

function applyEdits(mode) {   // mode: "download" | "file" | "share"
  if (!hasChanges()) return setStatus("No changes to apply.", "warn");
  const diff = buildDiff();
  if (!diff.length) return setStatus("No effective changes (values match the save).", "warn");
  const okLabel = mode === "file" ? `Apply & save to ${origName}`
    : mode === "saveas" ? "Apply & choose destination…"
    : mode === "share" ? "Apply & share…" : "Apply & download";
  openConfirm(diff, () => doApply(mode), okLabel);
}

// Runs the edit synchronously up to the first await, so navigator.share() (mode "share")
// still sees the confirm-button's user activation. Uses the resolved PY (no await pyReady).
async function doApply(mode) {
  const py = PY; if (!py) return setStatus("Engine not ready.", "err");
  const s = saves[curSlot];
  const payload = { edits: EDITS, invEdits: INV, nameEdits: NAMES, partyEdits: PARTY,
                    partyMountEdits: PMOUNT,
                    recruitEdits: RECRUIT, gold: GOLD, leader: LEADER, carryover: CARRY,
                    trinity: TRIN };
  setStatus("Applying…", "");
  let res;
  try {
    res = JSON.parse(py.runPython(
      `apply_edits(${JSON.stringify(SAVE_PATH)}, ${JSON.stringify(s.folder)}, ${JSON.stringify(JSON.stringify(payload))})`));
  } catch (e) { return setStatus("Write failed: " + e.message, "err"); }
  if (res.error) return setStatus("Write failed: " + res.error, "err");
  const bytes = py.FS.readFile(SAVE_PATH);

  let msg;
  if (mode === "share") {
    const file = new File([bytes], downloadName(), { type: "application/octet-stream" });
    try {
      await navigator.share({ files: [file], title: origName, text: `${origName} (edited)` });
      msg = `Applied ${res.changed} field(s) — shared ${downloadName()}.`;
    } catch (e) {
      if (e && e.name === "AbortError") { setStatus("Share cancelled — nothing left the device.", "warn"); return refreshAfterApply(py); }
      downloadBytes(bytes, downloadName());          // share unavailable → download instead
      msg = `Applied ${res.changed} field(s). Share failed, downloaded ${downloadName()}.`;
    }
  } else if (mode === "saveas") {
    // Native save dialog: choose where + the filename (defaults to the original, so you can
    // overwrite the source card) — must stay in the confirm-click's user activation, so this
    // runs before any awaited work above returns to the event loop.
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: origName, types: saveTypes() });
    } catch (e) {
      if (e && e.name === "AbortError") return setStatus("Save cancelled — nothing was written.", "warn");
      return setStatus("Could not open the save dialog: " + e.message, "err");
    }
    try {
      const w = await handle.createWritable();
      await w.write(bytes); await w.close();
    } catch (e) { return setStatus("Could not write file: " + e.message, "err"); }
    fileHandle = handle; origName = handle.name || origName;   // adopt as the in-place target
    msg = `Saved — ${res.changed} field(s) changed, written to ${handle.name}.`;
  } else if (mode === "file" && fileHandle) {
    try {
      if (!(await ensureWritable(fileHandle))) return setStatus("Save cancelled — write permission denied.", "warn");
      const w = await fileHandle.createWritable();
      await w.write(bytes); await w.close();
      msg = `Saved — ${res.changed} field(s) changed, written to ${fileHandle.name}.`;
    } catch (e) { return setStatus("Could not write file: " + e.message, "err"); }
  } else {
    downloadBytes(bytes, downloadName());
    msg = `Saved — ${res.changed} field(s) changed. Downloaded ${downloadName()}.`;
  }
  if (res.warn) msg += " ⚠ " + res.warn;
  refreshAfterApply(py);
  setStatus(msg, res.warn ? "warn" : "ok");
}

function refreshAfterApply(py) {
  saves = JSON.parse(py.runPython(`load_saves(${JSON.stringify(SAVE_PATH)})`));  // reflect edited file
  const bytes = py.FS.readFile(SAVE_PATH);
  rememberSave(origName, bytes, fileHandle);        // keep the remembered copy current
  drawSlot();
}

function downloadName() {
  if (!ADD_SUFFIX) return origName;             // keep the original name (overwrite-friendly)
  const dot = origName.lastIndexOf(".");
  const stem = dot > 0 ? origName.slice(0, dot) : origName;
  const ext = dot > 0 ? origName.slice(dot) : "";
  return `${stem}.edited${ext}`;
}
// Accept types for the "Save as…" dialog, derived from the original extension so the picker
// preserves it (and offers a sensible default name). Empty extension → any file.
function saveTypes() {
  const dot = origName.lastIndexOf(".");
  const ext = dot > 0 ? origName.slice(dot).toLowerCase() : "";
  if (!ext) return [];
  return [{ description: "Save file", accept: { "application/octet-stream": [ext] } }];
}
function downloadBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Per-platform "how to install" help, shown when the browser hasn't offered a native install
// prompt (iOS never does; Chrome only after its engagement heuristic; some browsers never).
function showInstallHelp() {
  const ua = navigator.userAgent || "";
  const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(ua);
  let steps;
  if (isIOS) {
    steps = `<p>In <b>Safari</b>: tap the <b>Share</b> button <span aria-hidden="true">⎋</span> (the square with an up-arrow), then <b>Add to Home Screen</b>.</p>
      <p class="muted">iOS only installs web apps from Safari — not Chrome or other browsers.</p>`;
  } else if (isAndroid) {
    steps = `<p>In <b>Chrome</b>: tap the <b>⋮</b> menu (top-right), then <b>Install app</b> (or <b>Add to Home screen</b>).</p>
      <p class="muted">If you don't see it yet, Chrome sometimes waits until you've used the page for a little while — interact for ~30&nbsp;seconds and check the menu again. Some third-party or built-in browsers on handhelds can't install PWAs; if the option never appears, try the latest <b>Google Chrome</b> from the Play Store.</p>`;
  } else {
    steps = `<p>In <b>Chrome / Edge / Brave / Opera</b> (desktop): click the <b>install icon</b> in the address bar, or the <b>⋮</b> menu → <b>Install…</b>.</p>
      <p class="muted">Firefox and Safari on desktop don't support installing this kind of app.</p>`;
  }
  const ov = document.createElement("div");
  ov.className = "modal-ov";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="How to install" style="max-width:460px">
      <div class="modal-h"><b>Add to Home Screen / Install</b><button class="modal-x" aria-label="close">✕</button></div>
      <div class="cf-list" style="font-size:13px">${steps}
        <p class="muted" style="margin-bottom:0">Installing makes it open full-screen and work offline. Nothing is uploaded either way.</p></div>
      <div class="modal-f"><button class="primary" id="ihOk">Got it</button></div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  $(".modal-x", ov).onclick = close; $("#ihOk", ov).onclick = close;
  ov.onclick = (e) => { if (e.target === ov) close(); };
}

// ---- misc ------------------------------------------------------------------
// Suikoden III has SEVEN stats. The engine reports its own list (save.statNames) so this
// can never drift from the offsets again; the literal is only the pre-load fallback.
let _STAT_NAMES = ["PWR", "SKL", "MAG", "REP", "MDF", "SPD", "LUK"];
function STAT_NAMES() {
  const s = saves && saves[curSlot];
  return (s && s.statNames && s.statNames.length) ? s.statNames : _STAT_NAMES;
}
function setStatus(msg, kind) { const el = $("#status"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } }
function setDropMsg(msg, isErr) { $("#engineStatus").innerHTML = (isErr ? "⚠ " : "") + msg; }
function bootProgress(pct, msg, step) {
  bootGate.step(pct, msg, step);
  const el = $("#engineStatus"); if (!el) return;
  el.innerHTML = `<div class="bootmsg">${pct < 100 ? '<span class="spinner"></span>' : ""}${esc(msg)}</div>` +
    `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;
}

// ---- boot gate (the panel over the save loader card in index.html) ---------
// Two surfaces, one progress source: this drives the gate and the inline #engineStatus line,
// because the gate is dismissible and whoever dismisses it still deserves to see the engine
// come up underneath. It covers only #loaderCard — Python gates loading a memory card and
// nothing else, so the rest of the app (ISO editor above all) stays live while it boots.
const bootGate = (() => {
  const STEPS = ["rt", "mod", "ref"];
  let closed = false;
  const ov = () => document.getElementById("bootOv");
  return {
    // pct/msg mirror bootProgress; step is the STEPS key now running ("done" = all finished).
    step(pct, msg, step) {
      const o = ov(); if (!o || closed) return;
      const fill = o.querySelector("#bootFill"), m = o.querySelector("#bootMsg");
      if (fill) fill.style.width = Math.max(2, Math.min(100, pct)) + "%";
      if (m) { m.className = "boot-msg"; m.innerHTML = `<span class="spinner"></span>${esc(msg)}`; }
      if (!step) return;
      const at = STEPS.indexOf(step);   // -1 for "done" → everything ticks
      STEPS.forEach((k, i) => {
        const li = o.querySelector(`.boot-steps li[data-step="${k}"]`); if (!li) return;
        li.classList.toggle("on", i === at);
        li.classList.toggle("done", at < 0 || i < at);
      });
    },
    // Engine failed: keep the gate up (the loader under it can't do anything) but swap the
    // spinner for the reason and the two things that actually help — a retry and a cache nuke,
    // since a half-written service-worker cache is the usual culprit.
    fail(msg) {
      const o = ov(); if (!o || closed) return;
      const m = o.querySelector("#bootMsg"), bar = o.querySelector(".bar"), acts = o.querySelector("#bootActs");
      const t = o.querySelector("#bootTitle");
      if (t) t.textContent = "The Python engine didn’t start";
      if (m) { m.className = "boot-msg err"; m.textContent = "⚠ " + msg; }
      if (bar) bar.querySelector(".bar-fill").classList.add("err");
      // The step that was mid-flight is the one that failed — a spinning glyph next to
      // "didn't start" reads as still-working, which is the opposite of the truth.
      const at = o.querySelector(".boot-steps li.on");
      if (at) { at.classList.remove("on"); at.classList.add("bad"); }
      o.querySelector("#bootMsg")?.setAttribute("aria-busy", "false");
      if (acts && !document.getElementById("bootRetry")) {
        acts.insertAdjacentHTML("afterbegin",
          '<button type="button" class="chip" id="bootRetry">↻ Retry</button>' +
          '<button type="button" class="chip" id="bootNuke">Clear cache &amp; reload</button>');
        document.getElementById("bootRetry").onclick = () => location.reload();
        document.getElementById("bootNuke").onclick = forceUpdate;
      }
      const hide = document.getElementById("bootHide");
      if (hide) hide.textContent = "Dismiss anyway";
    },
    close() {
      const o = ov(); if (!o || closed) return;
      closed = true;
      o.classList.add("gone");
      // Remove it rather than leaving an invisible layer over the loader (and to drop the
      // min-height that keeps the card gate-sized while it is in the DOM).
      setTimeout(() => o.remove(), 260);
    },
    get closed() { return closed; },
  };
})();
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

// If a newer build is deployed but this tab is running a cached one, reveal a footer button
// to nuke the caches + SW and reload. Compares the loaded footer version against a fresh,
// cache-busted index.html (bypasses both the HTTP cache and the service worker).
const appVersion = (txt) => ((txt || "").match(/v(\d+\.\d+\.\d+)/) || [])[1] || "";
async function checkForUpdate() {
  try {
    const cur = appVersion(document.querySelector(".credit") && document.querySelector(".credit").textContent);
    const html = await (await fetch(`./index.html?cb=${Date.now()}`, { cache: "no-store" })).text();
    const latest = appVersion(html);
    if (cur && latest && cur !== latest) showUpdateBar(cur, latest);
  } catch (e) { /* offline or blocked — just don't prompt */ }
}
function showUpdateBar(cur, latest) {
  // Create the bar if this (possibly stale) page's HTML predates the #updateBar element.
  let bar = document.getElementById("updateBar");
  if (!bar) {
    bar = document.createElement("span"); bar.id = "updateBar"; bar.className = "note";
    (document.querySelector("footer") || document.body).appendChild(bar);
  }
  bar.hidden = false;
  bar.innerHTML = `⟳ A newer version is available (v${esc(cur)} → <b>v${esc(latest)}</b>). ` +
    `<button class="chip" id="forceUpd">Force refresh</button>`;
  const b = document.getElementById("forceUpd");
  if (b) b.onclick = forceUpdate;
}
async function forceUpdate() {
  ["forceUpd", "forceRefreshBtn"].forEach((id) => { const b = document.getElementById(id); if (b) { b.disabled = true; b.textContent = "Refreshing…"; } });
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); }
  } catch (e) { /* best-effort — reload anyway */ }
  location.reload();
}

window.addEventListener("DOMContentLoaded", () => {
  let theme = "crimson";
  try { theme = localStorage.getItem("s3theme") || "crimson"; } catch (e) {}
  applyTheme(theme);
  $$("footer .tb").forEach((b) => (b.onclick = () => applyTheme(b.dataset.theme)));

  const drop = $("#drop"), fileInput = $("#file"), pickBtn = $("#pickBtn");
  // Prefer the FS Access picker (keeps a writable handle for save-in-place); else <input>.
  pickBtn.onclick = () => (SUPPORTS_FS ? openViaPicker() : fileInput.click());
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("hot"); }));
  drop.addEventListener("drop", async (e) => {
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (SUPPORTS_FS && item && item.getAsFileSystemHandle) {   // keeps a writable handle
      try {
        const h = await item.getAsFileSystemHandle();
        if (h && h.kind === "file") return handleFile(await h.getFile(), h);
      } catch (err) { /* fall through to plain File */ }
    }
    const f = e.dataTransfer.files[0]; if (f) handleFile(f);
  });

  // Guard against losing pending edits on accidental close/navigation.
  window.addEventListener("beforeunload", (e) => {
    if (dirtyNow()) { e.preventDefault(); e.returnValue = ""; }
  });

  // Boot gate: the ISO button is a shortcut to the tab that needs no engine (iso.js owns the
  // tab switch, so click its button rather than reach into its closure); Dismiss/Escape reveal
  // the loader underneath. Nothing here is load-bearing any more — the gate covers one card,
  // not the app — and the picker stays disabled until the engine is actually up regardless.
  // No autofocus: this is a progress notice, not a dialog, so it must not steal the caret.
  const bootIso = $("#bootIso"), bootHide = $("#bootHide");
  if (bootIso) bootIso.onclick = () => {
    bootGate.close();
    const tab = document.querySelector('.mtab[data-mode="iso"]'); if (tab) tab.click();
  };
  if (bootHide) bootHide.onclick = () => bootGate.close();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !bootGate.closed) bootGate.close(); });

  pyReady = bootPyodide();
  pyReady.then(() => {
    setDropMsg("Python engine ready — load a save file.", false);
    pickBtn.disabled = false;
    bootGate.close();
  }).catch((e) => {
    setDropMsg("Engine failed to start: " + e.message, true);
    bootGate.fail(e.message);
  });
  // After the engine is up: a save shared into the PWA wins; otherwise offer the last one.
  pyReady.then(async () => {
    const shared = await pickupSharedFile();
    if (!shared) showRecent();
  }).catch(() => {});

  // Register the service worker so the app is installable + works offline on Android.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));
  }
  checkForUpdate();   // reveal a version-behind note in the footer if a newer version is live
  { const fr = $("#forceRefreshBtn"); if (fr) fr.onclick = forceUpdate; }   // always-available manual cache reset

  // Install affordance. Chrome fires beforeinstallprompt only after the PWA is installable AND
  // a ~30s engagement heuristic — and never on iOS, or on some Android browsers — so a button
  // gated solely on that event often never shows. Instead: always show the button when not
  // already installed; use the native prompt if we captured one, otherwise open per-platform
  // "how to install" instructions (Chrome ⋮ menu / iOS Share sheet).
  const installBtn = $("#installBtn");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  let deferredPrompt = null;
  if (!standalone) {
    installBtn.classList.remove("hidden");          // show it regardless; click explains how
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();                           // capture it; drive it from our button
      deferredPrompt = e;
      installBtn.textContent = "⬇ Install app";
    });
    installBtn.onclick = async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (outcome === "accepted") installBtn.classList.add("hidden");
        return;
      }
      showInstallHelp();                            // no native prompt available → guide them
    };
    window.addEventListener("appinstalled", () => installBtn.classList.add("hidden"));
  }
});
