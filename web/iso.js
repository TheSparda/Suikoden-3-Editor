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
  // Read to the end of the ELF text/string region (0x465DF0) so every editable table AND
  // every description string it points into is inside the block we hold.
  const ELF_LEN = 0x465DF0 - 0xA4800;       // ~3.75 MB
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
  const ENEMY = { off: 0x3E74E0, count: 100, stride: 0x14 };   // names only (no editable stat table)

  // Known table starts, sorted — used to stop a record write from spilling into the next
  // table (list1's last record physically abuts list3; see nextBoundary/drawRecords).
  const BOUNDARIES = [3970620, 4054224, 4061704, 4068152, 4078716, 4089904, 4093152, 4100560, 4105552, 4113056, 4115344, 4136544, 4136564]
    .sort((a, b) => a - b);
  const nextBoundary = (off) => { for (const b of BOUNDARIES) if (b > off) return b; return ELF_END; };

  // ---- Hard Mode / bulk balance (mirror s3editor apply_hard_mode) ------------
  const GROWTH_OFFS = { PWR: 4, SKL: 5, MAG: 6, REP: 7, MDF: 8, SPD: 9, LUK: 10, HP: 11 };
  const HM_STATS = ["HP", "PWR", "MAG", "SKL", "MDF", "SPD", "REP", "LUK"];
  const HM_PRESETS = {
    tougher: { label: "Tougher", desc: "A gentle nerf — the party grows a bit slower.",
      growth: { HP: 0.8, PWR: 0.85, MAG: 0.85, SKL: 0.9, MDF: 0.9, SPD: 0.95, REP: 1, LUK: 1 }, spell: 0.9, unite: 0.9 },
    hard: { label: "Hard", desc: "Noticeably weaker party. Fights take real thought.",
      growth: { HP: 0.65, PWR: 0.7, MAG: 0.7, SKL: 0.8, MDF: 0.8, SPD: 0.9, REP: 0.9, LUK: 1 }, spell: 0.75, unite: 0.75 },
    brutal: { label: "Brutal", desc: "Punishing. Low HP, weak hits — every battle is a threat.",
      growth: { HP: 0.5, PWR: 0.55, MAG: 0.55, SKL: 0.7, MDF: 0.7, SPD: 0.85, REP: 0.85, LUK: 1 }, spell: 0.6, unite: 0.6 },
  };

  const ELEMENTS = { 0: "None", 1: "Fire", 2: "Water", 3: "Wind", 4: "Earth", 5: "Lightning", 6: "Pale (Dark)" };
  const AREA_BIT = 0x8000;                  // flags14 bit15 = area-of-effect
  const F18_BITS = { 1: "poison", 3: "instant-death", 4: "unbalance", 9: "teleport/chant",
    10: "sleep", 13: "silence/berserk", 14: "mgc-boost", 15: "mgc-shield", 19: "mgc-immune-once",
    21: "buff-pdf/mdf", 22: "sword-fire", 23: "sword-lightning", 24: "sword-wind",
    25: "resist-fire", 26: "resist-lightning", 27: "resist-wind" };
  const RANK_OPTS = [[0, "— (not learned)"], [1, "E"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [7, "A+"], [8, "S"]];
  const MAX_OPTS = [[0, "Can't get"], [2, "D"], [3, "C"], [4, "B"], [5, "B+"], [6, "A"], [1, "A+"], [7, "S"]];
  // spell/unite target byte (flags14 bits 8..15). AOE is a separate bit (0x8000).
  const TARGET_OPTS = [[0x0A, "Single target"], [0x02, "All foes"], [0x03, "All foes + allies"]];

  // gear effect-slot semantics (mirror s3patch.py)
  const GEAR_EFFECT_TYPES = { 0: "(none)", 1: "HP regen/turn", 2: "Stat bonus", 3: "Accuracy +%",
    4: "type 4 (unverified)", 5: "Grant skill", 6: "Status Protect", 7: "Elemental Resist",
    8: "Evade single-target ATK", 9: "Weak vs thrust / mobility", 10: "Lowers ATK effect %",
    11: "Chance to reflect MGC", 12: "Counter-attack rate +%" };
  const GEAR_STAT_SELECTOR = { 0: "PWR", 1: "SKL", 2: "MAG", 3: "REP", 4: "PDF", 5: "MDF", 6: "SPD", 7: "LUK" };
  const GEAR_TYPE_PARAM = { 2: "stat", 5: "skill" };   // type -> what `param` means

  // Rune -> ordered spell names it grants (resolved to table indices by name at runtime).
  const RUNE_SPELLS = {
    fire: ["Flaming Arrows", "Dancing Flames", "Blazing Wall", "Explosion"],
    rage: ["Dancing Flames", "Blazing Wall", "Explosion", "Final Flame"],
    truefire: ["Blazing Wall", "Explosion", "Final Flame", "Hellfire"],
    lightning: ["Thunder Runner", "Berserk Blow", "Soaring Bolt", "Furious Blow"],
    thunder: ["Berserk Blow", "Soaring Bolt", "Furious Blow", "Thunder Storm"],
    truelightning: ["Soaring Bolt", "Furious Blow", "Thunder Storm", "Hammer of Raijin"],
    wind: ["Wind of Sleep", "Healing Wind", "The Shredding", "Funeral Wind"],
    cyclone: ["Healing Wind", "The Shredding", "Funeral Wind", "Shining Wind"],
    truewind: ["The Shredding", "Funeral Wind", "Shining Wind", "Eternal Wind"],
    water: ["Kindness Drops", "Breath of Ice", "Kindness Rain", "Silent Lake"],
    flowing: ["Breath of Ice", "Kindness Rain", "Silent Lake", "Mother Ocean"],
    truewater: ["Kindness Rain", "Silent Lake", "Mother Ocean", "Heavenly Drops"],
    earth: ["Clay Guardian", "Vengeful Child", "Guardian Earth", "Earthquake"],
    motherearth: ["Vengeful Child", "Guardian Earth", "Earthquake", "Canopy Defense"],
    trueearth: ["Guardian Earth", "Earthquake", "Canopy Defense", "Land of Eternity"],
    shield: ["Battle Oath", "Great Blessing", "Battlefield"],
    blinking: ["Ready!", "Set!", "Go!"],
    jongleur: ["Song of Skylark", "Song of Serenity", "Song of Madness", "Song of a Hero"],
    palegate: ["Open Gate", "Royal Passage", "Pale Palace", "Empty World"],
    swordofrage: ["Sword of Rage", "Fire Amulet"],
    swordofthunder: ["Sword of Thunder", "Thunder Amulet"],
    swordofcyclone: ["Sword of Cyclone", "Wind Amulet"],
  };

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
  // Streaming "save patched ISO" fallback (Android/Firefox/Safari — no File System Access).
  // We can't overwrite a 4 GB file in place there, but we CAN read it in chunks and stream a
  // patched copy to the device via our own service worker. Needs transferable ReadableStreams
  // (to hand the stream to the SW). Everything stays local — nothing is uploaded.
  const CAN_TRANSFER_STREAM = (() => {
    try { const rs = new ReadableStream(); new MessageChannel().port1.postMessage(rs, [rs]); return true; }
    catch (e) { return false; }
  })();
  const CAN_STREAM_SAVE = typeof navigator !== "undefined" && "serviceWorker" in navigator && CAN_TRANSFER_STREAM;

  // ---- state -----------------------------------------------------------------
  let isoHandle = null, isoName = "", isoFile = null;   // isoFile: the source File (for streaming)
  let BUF = null, DV = null;                // live editable block (Uint8Array + DataView)
  let ORIG = null, ODV = null;              // pristine snapshot for diffing/undo
  let REF = null;                           // { items:{id:name}, cats:{id:cat}, idesc:{id:desc}, skills:{id:name}, names:{...} }
  let VIEW = "chars", SEARCH = "";
  let spDescOn = true, unDescOn = true, gearDescOn = true, foodDescOn = true;   // "also rewrite description" toggles
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
  const vaOff = (v) => v - ELF_VADDR + ELF_BASE;                 // vaddr -> absolute file offset
  const latin1Enc = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o[i] = c < 256 ? c : 63; } return o; };
  function writeBytes(off, bytes) { for (let i = 0; i < bytes.length; i++) if (inBlk(off + i, 1)) BUF[off - ELF_BASE + i] = bytes[i]; }
  // decode a null-terminated string from a given block copy (BUF or ORIG), bounded by maxlen
  function strFrom(arr, off, maxlen) {
    const rel = off - ELF_BASE; if (rel < 0 || rel >= arr.length) return "";
    let e = arr.indexOf(0, rel); if (e < 0 || e > rel + maxlen) e = rel + maxlen;
    return dec.decode(arr.subarray(rel, e));
  }
  // original on-disk slot length for a description pointer (the hard cap for edits)
  function origSlotLen(dptr) {
    const rel = vaOff(dptr) - ELF_BASE; if (rel < 0 || rel >= ORIG.length) return 0;
    let e = ORIG.indexOf(0, rel); if (e < 0) e = rel; return e - rel;
  }
  // Rewrite an in-place description string. transform(currentText)->newText. Capped to the
  // ORIGINAL slot length, null-padded. Returns a status object. Registers a review entry.
  function rewriteDesc(dptr, transform, group, label) {
    const off = vaOff(dptr), maxlen = origSlotLen(dptr);
    if (maxlen <= 0 || !inBlk(off, maxlen)) return { skip: true };
    const cur = strFrom(BUF, off, maxlen), next = transform(cur);
    if (next === cur) return { noNumber: true };
    const enc = latin1Enc(next);
    if (enc.length > maxlen) return { truncated: true };
    const padded = new Uint8Array(maxlen); padded.set(enc);
    writeBytes(off, padded); FIELD_REG[off] = { group, label, off, width: maxlen, kind: "text" };
    return { ok: true };
  }
  // Set a description to explicit text (gear custom desc). Rejects text longer than the slot.
  function setDescText(dptr, text, group, label) {
    const off = vaOff(dptr), maxlen = origSlotLen(dptr);
    if (maxlen <= 0 || !inBlk(off, maxlen)) return { skip: true, max: 0 };
    const enc = latin1Enc(text);
    if (enc.length > maxlen) return { tooLong: true, max: maxlen };
    const padded = new Uint8Array(maxlen); padded.set(enc);
    writeBytes(off, padded); FIELD_REG[off] = { group, label, off, width: maxlen, kind: "text" };
    return { ok: true, max: maxlen };
  }
  // description-number transforms (mirror the desktop's regex rewrites)
  const descPower = (t, pw) => /DMGx\d+(?:\.\d+)?/.test(t) ? t.replace(/DMGx\d+(?:\.\d+)?/, "DMGx" + String(pw / 100))
    : /\d+DMG/.test(t) ? t.replace(/\d+DMG/, pw + "DMG") : t;
  const descDef = (t, def) => /DEF\(\+?\d+\)/.test(t) ? t.replace(/DEF\(\+?\d+\)/, "DEF(+" + def + ")") : t;
  const descHeal = (t, h) => t.replace(/Heals \d+HP/, "Heals " + h + "HP");
  const descProc = (t, p) => t.replace(/\d+% chance/, p + "% chance");

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
  // restore a field's original bytes from the pristine snapshot
  function revertRange(off, width) { for (let i = 0; i < width; i++) if (inBlk(off + i, 1)) BUF[off - ELF_BASE + i] = ORIG[off - ELF_BASE + i]; }
  // Toggle a control's changed-highlight AND attach/refresh a ↺ "restore original" button
  // next to it. The button appears only while the field differs from the on-disk value; its
  // tooltip shows that original value; clicking it reverts just this field and re-renders.
  function markField(el, off, width, kind) {
    const dirty = isDirty(off, width);
    el.classList.toggle("dirty", dirty);
    let btn = el._revBtn;
    if (!btn) {
      if (!dirty) return;                    // clean fields don't need a button yet
      btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); revertRange(off, width); drawView(); };
      (kind === "raw" && el.parentElement && el.parentElement.hasAttribute("data-eff")
        ? el.parentElement.appendChild(btn) : el.insertAdjacentElement("afterend", btn));
      el._revBtn = btn;
    }
    btn.classList.toggle("show", dirty);
    if (dirty) {
      const ov = kind === "text" ? `"${strFrom(ORIG, off, width)}"`
        : kind === "raw" ? "original" : fmtVal(kind, origW(off, width));
      btn.title = `Restore original (${ov})`;
      btn.setAttribute("aria-label", `Restore original value (${ov})`);
    }
    scheduleBadge();
  }
  // Like markField, but only the bits in `mask` of a u32 field count as "this control's".
  // Lets Target and Area-of-effect (which share one flags word) highlight/revert independently.
  function markFlagsField(el, off, mask) {
    const cur = readW(off, 4) >>> 0, orig = origW(off, 4) >>> 0, dirty = ((cur ^ orig) & mask) !== 0;
    el.classList.toggle("dirty", dirty);
    let btn = el._revBtn;
    if (!btn) {
      if (!dirty) { scheduleBadge(); return; }
      btn = document.createElement("button"); btn.type = "button"; btn.className = "revert"; btn.textContent = "↺";
      btn.onclick = (e) => { e.preventDefault(); e.stopPropagation();
        const c = readW(off, 4) >>> 0, o = origW(off, 4) >>> 0; writeW(off, 4, ((c & ~mask) | (o & mask)) >>> 0); drawView(); };
      el.insertAdjacentElement("afterend", btn); el._revBtn = btn;
    }
    btn.classList.toggle("show", dirty);
    scheduleBadge();
  }
  // Coalesce dirty-badge refreshes to once per frame — markField fires many times per render.
  let badgePending = false;
  function scheduleBadge() {
    if (badgePending) return; badgePending = true;
    (window.requestAnimationFrame || setTimeout)(() => { badgePending = false; updateDirtyBadge(); }, 0);
  }
  function fmtVal(kind, v) {
    if (kind === "item") return itemLabel(v);
    if (kind === "skill") return skillLabel(v);
    if (kind === "rank") return rankLabel(v);
    if (kind === "max") return maxLabel(v);
    if (kind === "elem") return ELEMENTS[v & 0xFF] || "0x" + (v & 0xFF).toString(16);
    if (kind === "aoe") return (v & AREA_BIT) ? "AOE on" : "AOE off";
    if (kind === "flags14") return decodeTarget(v);
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
    let handle;
    try {
      // No type filter: some platforms (notably Android's picker) map .iso to a MIME the
      // filter doesn't list and grey it out. Allow any file; the version-word check validates.
      [handle] = await window.showOpenFilePicker({ multiple: false });
    } catch (e) { if (e && e.name !== "AbortError") setStatus("Could not open ISO: " + e.message, "err"); return; }
    loadFromHandle(handle);
  }
  // Open via a writable handle (desktop FS Access → in-place save + one-tap reopen).
  async function loadFromHandle(handle) {
    let file;
    try { file = await handle.getFile(); }
    catch (e) { return setStatus("Could not read that file: " + e.message, "err"); }
    return commitIso(file, handle);
  }
  // Open via a plain <input type=file> (Android/Firefox/Safari — no handle; save streams a copy).
  async function loadFromInputFile(file) { return commitIso(file, null); }

  // Read + validate + commit an ISO from a File. Nothing large is held — only the ~3.75 MB
  // editable region is read (via a ranged Blob.slice); the source File is kept for streaming.
  async function commitIso(file, handle) {
    setStatus("Reading disc region… (a moment on a large disc)", "");
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
    isoHandle = handle; isoFile = file; isoName = file.name || "game.iso";
    gearCache = null; Object.keys(FIELD_REG).forEach((k) => delete FIELD_REG[k]);
    recipeExported = false; saveNudged = false;
    VIEW = "chars"; SEARCH = "";
    if (handle) rememberIso(isoName, handle);   // persist the handle for one-tap reopen (FS only)
    renderEditor(file.size);
    q("#isoRoot").scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Loaded ${isoName} — USA verified.`, "ok");
  }
  // How this browser can write edits back: overwrite in place, stream a patched copy, or neither.
  function saveMode() {
    if (SUPPORTS_FS && isoHandle) return "inplace";
    if (CAN_STREAM_SAVE && isoFile) return "stream";
    return "none";
  }

  // ---- remember last opened ISO (persist the file HANDLE; the 4 GB bytes are never stored) --
  function rememberIso(name, handle) { idbSet("lastIso", { name, handle, at: Date.now() }).catch(() => {}); }
  async function showLastIso() {
    const el = q("#isoRecent"); if (!el) return;
    let rec; try { rec = await idbGet("lastIso"); } catch (e) { return; }
    if (!rec || !rec.handle) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="recent">Last opened:
        <button class="chip" id="isoReopen">↻ ${esc2(rec.name)}</button>
        <button class="chip mini" id="isoForget" title="forget" aria-label="forget last ISO">✕</button></div>`;
    q("#isoReopen", el).onclick = () => reopenLastIso(rec);
    q("#isoForget", el).onclick = async () => { await idbDel("lastIso").catch(() => {}); el.innerHTML = ""; };
  }
  async function reopenLastIso(rec) {
    try {
      if (!(await ensureWritable(rec.handle))) return setStatus("Reopen cancelled — write permission denied.", "warn");
      await loadFromHandle(rec.handle);
    } catch (e) { setStatus("Could not reopen — the file may have moved. Pick it again.", "err"); }
  }

  // ---- save (in place) -------------------------------------------------------
  function buildReview() {
    const rows = [];
    let covered = 0;
    for (const off in FIELD_REG) {
      const m = FIELD_REG[off];
      if (!isDirty(m.off, m.width)) continue;
      covered += m.width;
      let ov, nv;
      if (m.kind === "text") { ov = `"${strFrom(ORIG, m.off, m.width)}"`; nv = `"${strFrom(BUF, m.off, m.width)}"`; }
      else { ov = fmtVal(m.kind, origW(m.off, m.width)); nv = fmtVal(m.kind, readW(m.off, m.width)); }
      if (ov !== nv) rows.push({ g: m.group, t: `${m.label}: ${ov} → ${nv}` });
    }
    // Bulk edits (Balance presets) change many bytes not tied to one labeled field.
    const totalDirty = diffRuns().reduce((a, r) => a + (r[1] - r[0]), 0);
    if (totalDirty > covered) rows.push({ g: "Bulk / other", t: `${totalDirty - covered} more byte(s) changed (e.g. Balance multipliers)` });
    return rows;
  }
  let recipeExported = false, saveNudged = false;
  function saveIso() {
    if (!anyChanges()) return setStatus("No changes to save.", "warn");
    if (saveMode() === "none")
      return setStatus("This browser can't write the ISO. Use “Export recipe…” and apply it on a desktop Chromium browser (or the desktop app).", "warn");
    // One-time nudge to export a reversible recipe before the first write of a session.
    if (!recipeExported && !saveNudged) { saveNudged = true; return backupNudge(confirmAndSave); }
    confirmAndSave();
  }
  function confirmAndSave() {
    const rows = buildReview();
    const bytes = diffRuns().reduce((a, r) => a + (r[1] - r[0]), 0);
    if (!rows.length) rows.push({ g: "Raw", t: `${bytes} byte(s)` });
    if (saveMode() === "stream") {
      openConfirm(rows, doStreamSave,
        `Save patched ISO (~${fmtSize(isoFile.size)} download)`);
    } else {
      openConfirm(rows, doSave, `Write ${bytes} byte(s) to ${isoName}`);   // in-place
    }
  }
  // "Back up first?" prompt shown once before the first save; offers a one-click recipe export.
  function backupNudge(onContinue) {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Back up before saving" style="max-width:460px">
        <div class="modal-h"><b>Back up before saving?</b></div>
        <div class="pg-body">
          <p class="sub" style="margin:0 0 6px">Editing an ISO writes changes into your disc image. Export a tiny <b>.s3mod recipe</b> first — it records every change so you can undo, and it takes a second (no 4&nbsp;GB copy).</p>
          <p class="muted" style="margin:0">You can also keep your own backup copy of the ISO.</p>
        </div>
        <div class="modal-f">
          <button id="bnCancel">Cancel</button>
          <button id="bnSkip">Save without backup</button>
          <button class="primary" id="bnExport">Export recipe &amp; continue</button>
        </div></div>`;
    document.body.appendChild(ov);
    const close = modalA11y(ov, () => ov.remove(), q("#bnExport", ov));
    q("#bnCancel", ov).onclick = () => close();
    ov.onclick = (e) => { if (e.target === ov) close(); };
    q("#bnSkip", ov).onclick = () => { close(); onContinue(); };
    q("#bnExport", ov).onclick = () => { close(); exportRecipe(); onContinue(); };
  }
  async function doSave() {
    const runs = diffRuns();
    const total = runs.length, totalBytes = runs.reduce((a, r) => a + (r[1] - r[0]), 0);
    const pg = progressModal();
    setBusy(true);
    try {
      // Phase 1: the browser makes a safe (atomic) copy of the disc before applying writes.
      // There are no progress events for this, so show an animated bar + elapsed timer.
      pg.phase("Preparing", `Making a safe copy of ${isoName} before writing… ` +
        `Large discs can take a while — nothing is uploaded, and the original stays intact until this finishes.`, { indet: true });
      const w = await isoHandle.createWritable({ keepExistingData: true });

      // Phase 2: apply just the changed byte-runs. These are tiny and fast; show real progress.
      let done = 0, wrote = 0;
      pg.phase("Writing", `Applying ${total} change${total === 1 ? "" : "s"} (${totalBytes} bytes) in place…`, { pct: 0 });
      for (const [s, e] of runs) {
        await w.write({ type: "write", position: ELF_BASE + s, data: BUF.slice(s, e) });
        done++; wrote += e - s;
        pg.phase("Writing", `Applying change ${done} of ${total}…`, { pct: (done / total) * 100 });
      }

      // Phase 3: commit/rename the copy over the original.
      pg.phase("Finalizing", "Committing changes to the disc…", { indet: true });
      await w.close();

      ORIG = BUF.slice(); ODV = new DataView(ORIG.buffer);   // now clean
      drawView();
      pg.done(`Wrote ${wrote} byte(s) across ${total} run(s) to ${isoName}.`, false);
      setStatus(`Saved — ${wrote} byte(s) written in place to ${isoName}.`, "ok");
    } catch (e) {
      pg.done("Write failed: " + e.message + ". Your staged edits are still here — you can retry or export a recipe.", true);
      setStatus("Write failed: " + e.message, "err");
    } finally { setBusy(false); }
  }

  // Streaming save (Android/Firefox/Safari): there's no in-place API for a 4 GB file, so read
  // the source disc in chunks, splice the edited ~3.75 MB region over it, and stream the whole
  // patched copy straight to the device's downloads through our own service worker. Bounded
  // memory (backpressure via the stream's pull()); nothing is uploaded; no third-party helper.
  async function doStreamSave() {
    if (!isoFile) return setStatus("The original ISO isn't available to copy — reopen it and try again.", "err");
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller)
      return setStatus("Saving needs the offline helper active — reload the page once, then reopen the ISO and save.", "warn");

    const m = isoName.match(/\.[^.]+$/);
    const outName = (m ? isoName.slice(0, isoName.length - m[0].length) : isoName || "s3") + ".patched" + (m ? m[0] : ".iso");
    const total = isoFile.size;
    const region = BUF.slice();          // snapshot so mid-save edits can't corrupt the copy
    const pg = progressModal(); setBusy(true);
    try {
      pg.phase("Preparing", `Building a patched copy of ${isoName} (~${fmtSize(total)}). ` +
        `This can take a few minutes for a full disc — keep this tab open and your screen awake. ` +
        `It streams straight to your downloads; nothing is uploaded.`, { indet: true });

      let pos = 0, finished, failed;
      const done = new Promise((res, rej) => { finished = res; failed = rej; });
      const reader = isoFile.stream().getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          let r;
          try { r = await reader.read(); }
          catch (e) { controller.error(e); failed(e); return; }
          if (r.done) { controller.close(); finished(); return; }
          let chunk = r.value;                                  // bytes at [pos, pos+len)
          const start = pos, end = pos + chunk.length;
          if (end > ELF_BASE && start < ELF_END) {              // overlaps the editable region
            chunk = chunk.slice();                              // writable copy
            const a = Math.max(start, ELF_BASE), b = Math.min(end, ELF_END);
            for (let i = a; i < b; i++) chunk[i - start] = region[i - ELF_BASE];
          }
          controller.enqueue(chunk);
          pos = end;
          pg.phase("Writing", `Streaming patched ISO to your downloads… ${fmtSize(pos)} / ${fmtSize(total)}`,
            { pct: total ? (pos / total) * 100 : 0 });
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} failed(new Error("download cancelled")); },
      });

      // Hand the stream to the service worker, wait for its ack, then trigger the download.
      const id = "iso-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const sw = navigator.serviceWorker.controller;
      await new Promise((res, rej) => {
        const ch = new MessageChannel();
        const to = setTimeout(() => rej(new Error("the offline helper didn't respond")), 5000);
        ch.port1.onmessage = () => { clearTimeout(to); res(); };
        try { sw.postMessage({ type: "dl-register", id, filename: outName, size: total, stream }, [stream, ch.port2]); }
        catch (e) { clearTimeout(to); rej(e); }
      });
      const ifr = document.createElement("iframe");
      ifr.style.display = "none"; ifr.src = "_dl/" + id;
      document.body.appendChild(ifr);

      await done;                                                // resolves when fully streamed
      ORIG = BUF.slice(); ODV = new DataView(ORIG.buffer);       // treat as saved
      drawView();
      setTimeout(() => ifr.remove(), 1000);
      pg.done(`Streamed a patched copy — check your downloads for “${outName}”. Replace your ISO with it to play the edits.`, false, { bytes: total });
      setStatus(`Saved a patched copy (${fmtSize(total)}) to your downloads: ${outName}.`, "ok");
    } catch (e) {
      pg.done("Save failed: " + e.message + ". Your edits are still staged — retry, or export a recipe instead.", true);
      setStatus("Save failed: " + e.message, "err");
    } finally { setBusy(false); }
  }

  // Disable the toolbar while a write is in flight (prevents double-saves / racing edits).
  function setBusy(b) {
    ["#isoSaveBtn", "#isoRecipeBtn", "#isoImportBtn", "#isoResetBtn"].forEach((s) => { const el = q(s); if (el) el.disabled = b; });
  }

  // Non-dismissable progress modal with phase text, a bar (animated or %), and an elapsed timer.
  function progressModal() {
    const ov = document.createElement("div");
    ov.className = "modal-ov";
    ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Saving to ISO" style="max-width:460px">
        <div class="modal-h"><b id="pgTitle">Saving to ISO</b></div>
        <div class="pg-body" aria-live="polite">
          <div class="muted" id="pgMsg" style="margin-bottom:12px"></div>
          <div class="bar indet"><div class="bar-fill" id="pgFill" style="width:35%"></div></div>
          <div class="muted pg-meta" id="pgMeta" style="margin-top:8px"></div>
        </div>
        <div class="modal-f" id="pgFoot" style="display:none"><button class="primary" id="pgClose">Done</button></div>
      </div>`;
    document.body.appendChild(ov);
    const el = (id) => ov.querySelector("#" + id), bar = ov.querySelector(".bar"), fill = el("pgFill");
    const t0 = (performance && performance.now) ? performance.now() : Date.now();
    const now = () => ((performance && performance.now) ? performance.now() : Date.now());
    const tick = () => (el("pgMeta").textContent = `elapsed ${((now() - t0) / 1000).toFixed(1)}s`);
    const timer = setInterval(tick, 100); tick();
    return {
      phase(title, msg, { indet = false, pct = null } = {}) {
        el("pgTitle").textContent = title; el("pgMsg").textContent = msg;
        bar.classList.toggle("indet", indet);
        if (!indet) fill.style.width = Math.max(2, Math.min(100, pct == null ? 100 : pct)) + "%";
      },
      done(msg, isErr, extra) {
        clearInterval(timer);
        const ms = now() - t0;
        el("pgTitle").textContent = isErr ? "Save failed" : "Done";
        el("pgMsg").textContent = msg;
        bar.classList.remove("indet"); fill.style.width = "100%"; fill.classList.toggle("err", !!isErr);
        // Completion readout: time taken, plus size + average throughput when a byte total is given.
        const parts = [`⏱ ${fmtDuration(ms)}`];
        if (!isErr && extra && extra.bytes) {
          parts.push(fmtSize(extra.bytes));
          const s = ms / 1000; if (s > 0.2) parts.push(`${fmtSize(extra.bytes / s)}/s`);
        }
        el("pgMeta").textContent = parts.join("  ·  ");
        el("pgFoot").style.display = "flex"; el("pgClose").onclick = () => ov.remove();
        setTimeout(() => el("pgClose").focus(), 20);
      },
    };
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
    recipeExported = true;
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
    ["shops", "Shops"], ["spells", "Spells"], ["unites", "Unites"], ["gear", "Gear"], ["food", "Food"],
    ["balance", "Balance"], ["enemies", "Enemies"], ["ref", "Reference"]];

  function renderEditor(size) {
    const root = q("#isoRoot");
    const sm = saveMode();
    const saveLabel = sm === "stream" ? "Apply &amp; save patched ISO" : "Apply &amp; save to ISO";
    const saveNote = sm === "stream" ? ` · <span class="muted">saves a patched copy to downloads</span>`
      : sm === "none" ? ` · <span style="color:var(--warn)">read-only here — export a recipe</span>` : "";
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div><b class="acc2">${esc2(isoName)}</b>
            <span class="muted"> · ${fmtSize(size)} · USA SLUS-20387 ✓</span>${saveNote}</div>
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
          <button class="primary" id="isoSaveBtn"${sm === "none" ? " disabled" : ""}>${saveLabel}</button>
          <span class="pill" id="isoDirty" hidden></span>
          <button id="isoRecipeBtn">Export recipe…</button>
          <label class="file" style="margin:0"><button type="button" id="isoImportBtn">Import recipe…</button>
            <input type="file" id="isoRecipeFile" accept=".s3mod,.json"></label>
          <button id="isoResetBtn">Revert all</button>
          <span class="status" id="isoStatus"></span>
        </div>
      </div>`;
    qa("[data-v]", root).forEach((b) => (b.onclick = () => { VIEW = b.dataset.v; SEARCH = ""; q("#isoSearch").value = ""; drawView(); }));
    q("#isoSearch").oninput = (e) => { SEARCH = e.target.value.toLowerCase(); drawView(); };
    q("#isoClose").onclick = () => { if (anyChanges() && !confirm("Discard staged edits and close this ISO?")) return; BUF = DV = ORIG = ODV = isoHandle = isoFile = null; renderLoader(); };
    q("#isoSaveBtn").onclick = saveIso;
    q("#isoRecipeBtn").onclick = exportRecipe;
    q("#isoImportBtn").onclick = () => q("#isoRecipeFile").click();
    q("#isoRecipeFile").onchange = (e) => { if (e.target.files[0]) importRecipe(e.target.files[0]); e.target.value = ""; };
    q("#isoResetBtn").onclick = () => { if (!anyChanges()) return setStatus("Nothing to revert.", "warn"); BUF.set(ORIG); drawView(); setStatus("Reverted all staged changes.", "ok"); };
    drawView();
  }

  // Live "unsaved changes" indicator: count of labeled field changes, or a dot for
  // bulk (Balance) edits that aren't tied to a single field. Also annotates the Save button.
  function updateDirtyBadge() {
    const badge = q("#isoDirty"), btn = q("#isoSaveBtn"); if (!badge || !btn) return;
    const n = buildReview().length;
    if (n > 0) { badge.hidden = false; badge.textContent = `${n} unsaved`; }
    else if (anyChanges()) { badge.hidden = false; badge.textContent = "unsaved changes"; }
    else { badge.hidden = true; }
    btn.textContent = anyChanges() ? "Apply & save to ISO ●" : "Apply & save to ISO";
  }

  function drawView() {
    qa("#isoTabs [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === VIEW));
    const hints = {
      chars: "Character starting stats (list 1): starting skills, ranks, equipped runes and gear.",
      growth: "Per-character stat-growth rates, rune levels, fixed skills, and starting level (list 2).",
      support: "Support-character skill sets (list 3), 8 skill ids each.",
      weapons: "Weapon ATK sharpen curves (list 4): base attack at sharpen levels 1–16.",
      shops: "Shop item slots (pick an item), the price ladder, and the item1 group. Prices are potch.",
      spells: "Spell / rune-effect table: power, cast (MOV), element, target, area-of-effect, status — plus a rune reskin that edits every spell a rune grants at once, and optional description rewrites.",
      unites: "Unite (co-op) attack table: power, cast (MOV), target, and area-of-effect.",
      gear: "Equipment records: DEF, price, custom description, and all 5 effect slots (type / amount / stat or skill).",
      food: "Consumable / food table: heal amount and proc chance %.",
      balance: "Bulk difficulty levers: scale every character's stat-growth rate (and optionally spell/unite power) by a multiplier. Scaled from the ISO's original values, so presets don't compound.",
      enemies: "Enemy name reference (read-only) — Suikoden III has no editable flat enemy-stat table in this ROM.",
      ref: "Reference (read-only): searchable item and skill id lists with descriptions.",
    };
    q("#isoHint").textContent = hints[VIEW] || "";
    const host = q("#isoView");
    // remember which records are expanded so a re-render (e.g. a per-field revert) keeps your place
    const detKey = (d) => d.dataset.i ?? d.dataset.rec ?? d.dataset.base;
    const open = new Set(qa("details.char[open]", host).map(detKey));
    const y = window.scrollY;
    if (VIEW === "chars") drawRecords(host, "list1", REF.names.list1, LIST1_FIELDS, true);
    else if (VIEW === "growth") drawGrowth(host);
    else if (VIEW === "support") drawRecords(host, "list3", REF.names.list3, LIST3_FIELDS, false);
    else if (VIEW === "weapons") drawRecords(host, "list4", REF.names.list4, LIST4_FIELDS, false);
    else if (VIEW === "shops") drawShops(host);
    else if (VIEW === "spells") drawSpells(host);
    else if (VIEW === "unites") drawUnites(host);
    else if (VIEW === "gear") drawGear(host);
    else if (VIEW === "food") drawFood(host);
    else if (VIEW === "balance") drawBalance(host);
    else if (VIEW === "enemies") drawEnemies(host);
    else if (VIEW === "ref") drawReference(host);
    if (open.size) qa("details.char", host).forEach((d) => {
      if (open.has(detKey(d))) { d.open = true; d.dispatchEvent(new Event("toggle")); }
    });
    window.scrollTo(0, y);
    scheduleBadge();
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
    // Records physically abut the next table (e.g. list1's last record overlaps list3).
    // Drop any field whose bytes would spill past that boundary so an edit can't corrupt it.
    const safeEnd = Math.min(recBase + 200, nextBoundary(recBase));
    let dropped = 0;
    const html = fields.map(([label, off, w, kind]) => {
      if (recBase + off + w > safeEnd) { dropped++; return ""; }
      return fieldHTML(recBase + off, w, kind, label);
    }).join("");
    return html + (dropped ? `<div class="muted" style="grid-column:1/-1">${dropped} field(s) hidden — they overlap the next table and aren't safe to edit on this record.</div>` : "");
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
    qa("button.picker[data-off]", scope).forEach((btn) => {
      const off = +btn.dataset.off, w = +btn.dataset.w, kind = btn.dataset.kind;
      const label = btn.parentElement.querySelector("span").textContent;
      btn.onclick = () => {
        const cur = readW(off, w);
        const opts = kind === "item" ? itemOpts(slotCat(label)) : skillOpts();
        if (cur && !opts.some((o) => o.id === cur)) opts.splice(1, 0, { id: cur, name: kind === "item" ? itemName(cur) : skillName(cur) });
        openPicker(label, opts, cur, (id) => {
          writeW(off, w, id); reg(off, w, kind, group, label);
          btn.textContent = kind === "item" ? itemLabel(id) : skillLabel(id);
          markField(btn, off, w, kind);
        }, (id) => hex(id, kind === "item" ? 3 : 2));
      };
      markField(btn, off, w, kind);          // initialise ↺ / highlight for already-changed fields
    });
    qa("select.fsel[data-off]", scope).forEach((sel) => {
      const off = +sel.dataset.off, w = +sel.dataset.w, kind = sel.dataset.kind;
      const label = sel.parentElement.querySelector("span").textContent;
      sel.onchange = () => { writeW(off, w, +sel.value); reg(off, w, kind, group, label); markField(sel, off, w, kind); };
      markField(sel, off, w, kind);
    });
    qa("input.fnum[data-off]", scope).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      const label = inp.parentElement.querySelector("span").textContent;
      inp.onchange = () => {
        writeW(off, w, Math.max(0, Math.min(+inp.value || 0, w === 1 ? 255 : w === 2 ? 65535 : 4294967295)));
        reg(off, w, "num", group, label); markField(inp, off, w, "num");
      };
      markField(inp, off, w, "num");
    });
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
    qa("button.shopitem", host).forEach((btn) => {
      const off = +btn.dataset.off, w = +btn.dataset.w;
      btn.onclick = () => {
        openPicker("Choose item", itemOpts(""), readW(off, w), (id) => {
          writeW(off, w, id); reg(off, w, "item", "Shops", `slot @0x${hex(off, 6)}`);
          btn.textContent = itemLabel(id); markField(btn, off, w, "item");
        });
      };
      markField(btn, off, w, "item");
    });
    qa("input.shopnum", host).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w;
      inp.onchange = () => { writeW(off, w, Math.max(0, +inp.value || 0)); reg(off, w, "num", "Shops", `value @0x${hex(off, 6)}`); markField(inp, off, w, "num"); };
      markField(inp, off, w, "num");
    });
  }

  // ---- spells ----------------------------------------------------------------
  function spellNameIndex() {
    const m = {};
    for (let i = 0; i < SPELL.count; i++) { const n = strAt(r32(SPELL.off + i * SPELL.stride + 0x08)); if (!(n in m)) m[n] = i; }
    return m;
  }
  // Shared edit engine for a spell record (used by per-spell controls AND rune reskin).
  function applySpell(idx, f, updateDesc) {
    const off = SPELL.off + idx * SPELL.stride, name = strAt(r32(off + 0x08));
    let descRes = null;
    if (f.power != null) {
      writeW(off + 0x1C, 4, Math.max(0, f.power)); reg(off + 0x1C, 4, "num", name, "Power");
      if (updateDesc) descRes = rewriteDesc(r32(off + 0x0C), (t) => descPower(t, Math.max(0, f.power)), name, "Description");
    }
    if (f.cast != null) { writeW(off + 0x10, 4, Math.max(0, f.cast)); reg(off + 0x10, 4, "num", name, "Cast"); }
    if (f.elementId != null && idx + 1 < SPELL.count) {
      const eo = off + SPELL.elem; writeW(eo, 2, (r16(eo) & 0xFF00) | (f.elementId & 0xFF)); reg(eo, 2, "elem", name, "Element");
    }
    if (f.target != null) { let v = r32(off + 0x14); v = (v & 0xFFFF80FF) | ((f.target & 0x7F) << 8); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Target"); }
    if (f.aoe != null) { let v = r32(off + 0x14); v = f.aoe ? (v | AREA_BIT) : (v & ~AREA_BIT); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Area of effect"); }
    if (f.status != null) { const rev = {}; for (const b in F18_BITS) rev[F18_BITS[b]] = 1 << b; writeW(off + 0x18, 4, f.status === "none" ? 0 : (rev[f.status] || 0)); reg(off + 0x18, 4, "status", name, "Status"); }
    return descRes;
  }
  const targetOptsHTML = (cur) => {
    let html = TARGET_OPTS.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`).join("");
    if (!TARGET_OPTS.some(([v]) => v === cur)) html += `<option value="${cur}" selected>custom 0x${hex(cur, 2)}</option>`;
    return html;
  };
  function drawSpells(host) {
    const upd = spDescOn;
    const runeOpts = Object.keys(RUNE_SPELLS).map((r) => `<option value="${r}">${r}</option>`).join("");
    const elemOptsBlank = `<option value="">— no change —</option>` + Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    const statOptsBlank = `<option value="">— no change —</option>` + ["none", ...Object.values(F18_BITS)].map((s) => `<option value="${s}">${s}</option>`).join("");
    const reskin = `<div class="card" style="margin:0 0 12px">
      <div class="bag-h">Rune reskin <span class="u">apply the fields you set to every spell a rune grants</span></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(130px,1fr))">
        <label class="field"><span>Rune</span><select id="rsRune">${runeOpts}</select></label>
        <label class="field"><span>Power</span><input type="number" id="rsPower" min="0" placeholder="no change"></label>
        <label class="field"><span>Cast (MOV)</span><input type="number" id="rsCast" min="0" placeholder="no change"></label>
        <label class="field"><span>Element</span><select id="rsElem">${elemOptsBlank}</select></label>
        <label class="field"><span>Target</span><select id="rsTarget"><option value="">— no change —</option>${TARGET_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
        <label class="field"><span>Area of effect</span><select id="rsAoe"><option value="">— no change —</option><option value="1">on</option><option value="0">off</option></select></label>
        <label class="field"><span>Status</span><select id="rsStatus">${statOptsBlank}</select></label>
      </div>
      <div class="row" style="margin-top:8px"><button class="primary mini" id="rsApply">Apply to rune</button>
        <span class="muted" id="rsInfo"></span></div></div>`;
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="spUpd"${upd ? " checked" : ""}> also rewrite the damage number in each spell's description when Power changes</label>`;

    const rows = [];
    for (let i = 0; i < SPELL.count; i++) {
      const off = SPELL.off + i * SPELL.stride, name = strAt(r32(off + 0x08));
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, off, name });
    }
    const body = rows.map(({ i, off, name }) => {
      const canElem = i + 1 < SPELL.count, elVal = canElem ? (r16(off + SPELL.elem) & 0xFF) : 0;
      const f14 = r32(off + 0x14), tb = (f14 >> 8) & 0x7F, f18 = r32(off + 0x18);
      const statCur = f18 === 0 ? "none" : (Object.entries(F18_BITS).find(([b]) => f18 === (1 << b)) || [])[1] || "custom";
      const elemSel = Object.entries(ELEMENTS).map(([v, l]) => `<option value="${v}"${+v === elVal ? " selected" : ""}>${l}</option>`).join("");
      const statOpts = ["none", ...Object.values(F18_BITS)].map((s) => `<option value="${s}"${s === statCur ? " selected" : ""}>${s}</option>`).join("");
      // editable, length-capped description (cap = original slot length; can't grow past it)
      const dptr = r32(off + 0x0C), dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descField = dmax > 0
        ? `<label class="field" style="margin:0 0 10px"><span>Description <span class="muted">(max ${dmax} chars)</span></span>
             <input type="text" class="spdesc" data-i="${i}" maxlength="${dmax}" value="${esc2(dcur)}"></label>`
        : `<div class="muted" style="margin:0 0 8px">${esc2(dcur)}</div>`;
      return `<details class="char" data-i="${i}"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="lv sp-sum">${ELEMENTS[elVal]} · pw ${r32(off + 0x1C)} · ${decodeTarget(f14)}</span></summary>
        <div class="char-body">
          ${descField}
          <div class="grid">
            <label class="field"><span>Power</span><input type="number" class="sp" data-i="${i}" data-k="power" min="0" value="${r32(off + 0x1C)}"></label>
            <label class="field"><span>Cast (MOV)</span><input type="number" class="sp" data-i="${i}" data-k="cast" min="0" value="${r32(off + 0x10)}"></label>
            <label class="field"><span>Element</span><select class="sp" data-i="${i}" data-k="elementId" ${canElem ? "" : "disabled"}>${elemSel}</select></label>
            <label class="field"><span>Target</span><select class="sp" data-i="${i}" data-k="target">${targetOptsHTML(tb)}</select></label>
            <label class="field"><span>Area of effect</span><select class="sp" data-i="${i}" data-k="aoe"><option value="1"${(f14 & AREA_BIT) ? " selected" : ""}>on</option><option value="0"${!(f14 & AREA_BIT) ? " selected" : ""}>off</option></select></label>
            <label class="field"><span>Status</span><select class="sp" data-i="${i}" data-k="status">${statOpts}</select></label>
          </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`;
    host.innerHTML = reskin + updBox + body;

    q("#spUpd", host).onchange = (e) => { spDescOn = e.target.checked; };
    q("#rsApply", host).onclick = () => runeReskin();
    q("#rsRune", host).onchange = () => { const el = q("#rsInfo", host); el.textContent = "→ " + RUNE_SPELLS[q("#rsRune", host).value].join(", "); };
    q("#rsRune", host).dispatchEvent(new Event("change"));

    qa(".sp", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k;
      const f = {}; f[k] = k === "aoe" ? el.value === "1" : k === "status" ? el.value : +el.value;
      const dr = applySpell(i, f, spDescOn && k === "power");
      updateSpellSummary(host, i);
      if (dr && dr.truncated) setStatus("Power saved — but this description is at its length limit, so the DMGx value couldn't be rewritten. Edit the Description field to shorten it and fit the new number.", "warn");
    }));
    // manual free-text description edit (capped to the slot length via maxlength + setDescText)
    qa(".spdesc", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, off = SPELL.off + i * SPELL.stride, name = strAt(r32(off + 0x08));
      const res = setDescText(r32(off + 0x0C), el.value, name, "Description");
      if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this spell.`, "warn");
      updateSpellSummary(host, i);
    }));
    qa("details.char", host).forEach((d) => updateSpellSummary(host, +d.dataset.i));   // init ↺/highlight
  }
  function updateSpellSummary(host, i) {
    const d = q(`details.char[data-i="${i}"]`, host); if (!d) return;
    const off = SPELL.off + i * SPELL.stride, elVal = i + 1 < SPELL.count ? (r16(off + SPELL.elem) & 0xFF) : 0;
    d.querySelector(".sp-sum").textContent = `${ELEMENTS[elVal]} · pw ${r32(off + 0x1C)} · ${decodeTarget(r32(off + 0x14))}`;
    const MAP = { power: [0x1C, 4, "num"], cast: [0x10, 4, "num"], elementId: [SPELL.elem, 2, "elem"], target: [0x14, 4, "flags14"], aoe: [0x14, 4, "flags14"], status: [0x18, 4, "status"] };
    qa(".sp", d).forEach((el) => {
      const [o, w, kind] = MAP[el.dataset.k];
      if (kind === "flags14") markFlagsField(el, off + o, el.dataset.k === "aoe" ? AREA_BIT : 0x7F00);
      else markField(el, off + o, w, kind);
    });
    // reflect any auto-rewrite of the description (e.g. Power change) inline + highlight if changed
    const dEl = d.querySelector(".spdesc");
    if (dEl) {
      const dptr = r32(off + 0x0C), doff = vaOff(dptr), dmax = origSlotLen(dptr);
      dEl.value = strFrom(BUF, doff, dmax);
      markField(dEl, doff, dmax, "text");
    }
  }
  function runeReskin() {
    const rune = q("#rsRune").value, idx = spellNameIndex();
    const targets = (RUNE_SPELLS[rune] || []).map((n) => idx[n]).filter((v) => v != null);
    if (!targets.length) return setStatus("Could not resolve that rune's spells in this ISO.", "err");
    const f = {}, num = (id) => q(id).value;
    if (num("#rsPower") !== "") f.power = +num("#rsPower");
    if (num("#rsCast") !== "") f.cast = +num("#rsCast");
    if (num("#rsElem") !== "") f.elementId = +num("#rsElem");
    if (num("#rsTarget") !== "") f.target = +num("#rsTarget");
    if (num("#rsAoe") !== "") f.aoe = num("#rsAoe") === "1";
    if (num("#rsStatus") !== "") f.status = num("#rsStatus");
    if (!Object.keys(f).length) return setStatus("Set at least one field to apply.", "warn");
    targets.forEach((i) => applySpell(i, f, spDescOn));
    drawView();
    setStatus(`Reskinned ${targets.length} spell(s) for rune "${rune}". Review, then Save.`, "ok");
  }

  // ---- unites ----------------------------------------------------------------
  function drawUnites(host) {
    const rows = [];
    for (let i = 0; i < UNITE.count; i++) {
      const off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      if (SEARCH && !name.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push({ i, off, name });
    }
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="unUpd"${unDescOn ? " checked" : ""}> also rewrite the damage number in each unite's description when Power changes</label>`;
    host.innerHTML = updBox + (rows.map(({ i, off, name }) => {
      const f14 = r32(off + 0x14), tb = (f14 >> 8) & 0x7F;
      const dptr = r32(off + 0x0C), dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descField = dmax > 0
        ? `<label class="field" style="margin:0 0 10px"><span>Description <span class="muted">(max ${dmax} chars)</span></span>
             <input type="text" class="undesc" data-i="${i}" maxlength="${dmax}" value="${esc2(dcur)}"></label>`
        : `<div class="muted" style="margin:0 0 8px">${esc2(dcur)}</div>`;
      return `<details class="char" data-i="${i}"><summary>
          <span class="chev">▸</span><span class="nm">${esc2(name || "#" + i)}</span><span class="muted">#${i}</span>
          <span class="lv un-sum">pw ${r32(off + 0x1C)} · ${decodeTarget(f14)}</span></summary>
        <div class="char-body">${descField}
          <div class="grid">
            <label class="field"><span>Power</span><input type="number" class="un" data-i="${i}" data-k="power" min="0" value="${r32(off + 0x1C)}"></label>
            <label class="field"><span>Cast (MOV)</span><input type="number" class="un" data-i="${i}" data-k="cast" min="0" value="${r32(off + 0x10)}"></label>
            <label class="field"><span>Target</span><select class="un" data-i="${i}" data-k="target">${targetOptsHTML(tb)}</select></label>
            <label class="field"><span>Area of effect</span><select class="un" data-i="${i}" data-k="aoe"><option value="1"${(f14 & AREA_BIT) ? " selected" : ""}>on</option><option value="0"${!(f14 & AREA_BIT) ? " selected" : ""}>off</option></select></label>
          </div></div></details>`;
    }).join("") || `<div class="muted">no matches</div>`);
    const UMAP = { power: [0x1C, 4, "num"], cast: [0x10, 4, "num"], target: [0x14, 4, "flags14"], aoe: [0x14, 4, "flags14"] };
    const markUnite = (i) => {
      const off = UNITE.off + i * UNITE.stride, d = q(`details.char[data-i="${i}"]`, host); if (!d) return;
      d.querySelector(".un-sum").textContent = `pw ${r32(off + 0x1C)} · ${decodeTarget(r32(off + 0x14))}`;
      qa(".un", d).forEach((c) => {
        const [o, w, kind] = UMAP[c.dataset.k];
        if (kind === "flags14") markFlagsField(c, off + o, c.dataset.k === "aoe" ? AREA_BIT : 0x7F00);
        else markField(c, off + o, w, kind);
      });
      const dEl = d.querySelector(".undesc");
      if (dEl) { const dptr = r32(off + 0x0C), doff = vaOff(dptr), dmax = origSlotLen(dptr); dEl.value = strFrom(BUF, doff, dmax); markField(dEl, doff, dmax, "text"); }
    };
    const un = q("#unUpd", host); if (un) un.onchange = (e) => { unDescOn = e.target.checked; };
    qa(".un", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, k = el.dataset.k, off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      if (k === "power") {
        writeW(off + 0x1C, 4, Math.max(0, +el.value || 0)); reg(off + 0x1C, 4, "num", name, "Power");
        if (unDescOn) { const dr = rewriteDesc(r32(off + 0x0C), (t) => descPower(t, Math.max(0, +el.value || 0)), name, "Description");
          if (dr && dr.truncated) setStatus("Power saved — but this description is at its length limit, so the DMGx value couldn't be rewritten. Edit the Description field to shorten it and fit the new number.", "warn"); }
      }
      else if (k === "cast") { writeW(off + 0x10, 4, Math.max(0, +el.value || 0)); reg(off + 0x10, 4, "num", name, "Cast"); }
      else if (k === "target") { let v = r32(off + 0x14); v = (v & 0xFFFF80FF) | ((+el.value & 0x7F) << 8); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Target"); }
      else if (k === "aoe") { let v = r32(off + 0x14); v = el.value === "1" ? (v | AREA_BIT) : (v & ~AREA_BIT); writeW(off + 0x14, 4, v); reg(off + 0x14, 4, "flags14", name, "Area of effect"); }
      markUnite(i);
    }));
    qa(".undesc", host).forEach((el) => (el.onchange = () => {
      const i = +el.dataset.i, off = UNITE.off + i * UNITE.stride, name = strAt(r32(off + 0x08));
      const res = setDescText(r32(off + 0x0C), el.value, name, "Description");
      if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this unite.`, "warn");
      markUnite(i);
    }));
    qa("details.char", host).forEach((d) => markUnite(+d.dataset.i));   // init ↺/highlight
  }

  // ---- food ------------------------------------------------------------------
  function drawFood(host) {
    const rows = [];
    for (let i = 0; i < FOOD.count; i++) {
      const off = FOOD.off + i * FOOD.stride, name = strAt(r32(off + FOOD.name));
      if (SEARCH && !name.toLowerCase().includes(SEARCH)) continue;
      const heal = off + FOOD.heal, proc = off + FOOD.proc, dptr = r32(off + FOOD.desc);
      const dmax = origSlotLen(dptr), dcur = strAt(dptr);
      const descCell = dmax > 0
        ? `<td><input type="text" class="fddesc" maxlength="${dmax}" style="min-width:150px" value="${esc2(dcur)}" data-dptr="${dptr}" data-g="${esc2(name)}" title="max ${dmax} chars"></td>`
        : `<td class="muted">${esc2(dcur)}</td>`;
      rows.push(`<tr><td class="sl">${i}</td><td class="acc2">${esc2(name || "#" + i)}</td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(heal)}" data-off="${heal}" data-dptr="${dptr}" data-kind="heal" data-g="${esc2(name)}" data-l="Heal HP"></td>
        <td><input type="number" class="fd" min="0" max="65535" style="width:90px" value="${r16(proc)}" data-off="${proc}" data-dptr="${dptr}" data-kind="proc" data-g="${esc2(name)}" data-l="Proc %"></td>
        ${descCell}</tr>`);
    }
    host.innerHTML = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="fUpd"${foodDescOn ? " checked" : ""}> also rewrite the "Heals N HP" / "N% chance" numbers in the description</label>
      <div style="overflow-x:auto"><table class="invtbl"><thead><tr><th>#</th><th>Item</th><th>Heal HP</th><th>Proc %</th><th>Description</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="5" class="muted">no matches</td></tr>`}</tbody></table></div>`;
    q("#fUpd", host).onchange = (e) => { foodDescOn = e.target.checked; };
    // reflect a food row's description string back into its editable cell (+ highlight)
    const refreshFoodDesc = (dptr, row) => {
      const de = row && row.querySelector("input.fddesc"); if (!de) return;
      const doff = vaOff(dptr), dmax = origSlotLen(dptr); de.value = strFrom(BUF, doff, dmax); markField(de, doff, dmax, "text");
    };
    qa("input.fd", host).forEach((inp) => {
      const off = +inp.dataset.off, nm = inp.dataset.g;
      inp.onchange = () => {
        const v = Math.max(0, Math.min(+inp.value || 0, 65535));
        writeW(off, 2, v); reg(off, 2, "num", nm, inp.dataset.l); markField(inp, off, 2, "num");
        if (foodDescOn && inp.dataset.dptr) { rewriteDesc(+inp.dataset.dptr, (t) => inp.dataset.kind === "heal" ? descHeal(t, v) : descProc(t, v), nm, "Description"); refreshFoodDesc(+inp.dataset.dptr, inp.closest("tr")); }
      };
      markField(inp, off, 2, "num");
    });
    // manual, length-capped description edit per food item
    qa("input.fddesc", host).forEach((el) => {
      const dptr = +el.dataset.dptr, doff = vaOff(dptr), dmax = origSlotLen(dptr);
      el.onchange = () => {
        const res = setDescText(dptr, el.value, el.dataset.g, "Description");
        if (res.tooLong) setStatus(`Description too long — max ${res.max} characters for this item.`, "warn");
        el.value = strFrom(BUF, doff, dmax); markField(el, doff, dmax, "text");
      };
      markField(el, doff, dmax, "text");
    });
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
  // one effect slot: type select + value + a param control (stat / skill / hidden per type)
  function effectSlotHTML(nm, base, eo) {
    const t = r16(base + eo), val = r16(base + eo + 2), param = r16(base + eo + 4);
    const typeOpts = Object.entries(GEAR_EFFECT_TYPES).map(([v, l]) => `<option value="${v}"${+v === t ? " selected" : ""}>${v} · ${l}</option>`).join("");
    const statOpts = Object.entries(GEAR_STAT_SELECTOR).map(([v, l]) => `<option value="${v}"${+v === param ? " selected" : ""}>${l}</option>`).join("");
    const skillOpts = skillOpts2(param);
    const pk = GEAR_TYPE_PARAM[t];
    return `<div class="row" data-eff data-base="${base}" data-eo="${eo}" data-g="${esc2(nm)}" style="gap:6px;margin-bottom:6px">
        <span class="muted" style="width:52px">slot ${GEAR.effs.indexOf(eo)}</span>
        <select class="ge-type" style="flex:1 1 150px">${typeOpts}</select>
        <input type="number" class="ge-val" style="width:80px" min="0" max="65535" value="${val}" title="amount">
        <select class="ge-stat" style="flex:0 1 90px;${pk === "stat" ? "" : "display:none"}">${statOpts}</select>
        <select class="ge-skill" style="flex:1 1 150px;${pk === "skill" ? "" : "display:none"}">${skillOpts}</select>
      </div>`;
  }
  function skillOpts2(cur) {
    const list = Object.keys(REF.skills).map(Number).sort((a, b) => a - b);
    if (cur && !list.includes(cur)) list.unshift(cur);
    return list.map((id) => `<option value="${id}"${id === cur ? " selected" : ""}>${hex(id, 2)} · ${skillName(id)}</option>`).join("");
  }
  function drawGear(host) {
    const g = scanGear();
    const ids = Object.keys(g).map(Number).sort((a, b) => a - b);
    const updBox = `<label class="row" style="gap:6px;cursor:pointer;margin:0 0 10px"><input type="checkbox" id="gUpd"${gearDescOn ? " checked" : ""}> also rewrite the DEF(+N) number in the description when DEF changes</label>`;
    const rows = [];
    for (const iid of ids) {
      const nm = itemName(iid);
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && hex(iid, 3).toLowerCase() !== SEARCH) continue;
      const base = g[iid], def = base + GEAR.def, price = base + GEAR.price, dptr = r32(base + 0x00);
      const descStr = strAt(dptr), descMax = origSlotLen(dptr);
      const effs = GEAR.effs.map((eo) => effectSlotHTML(nm, base, eo)).join("");
      rows.push(`<details class="char" data-base="${base}"><summary><span class="chev">▸</span>
          <span class="nm">${esc2(nm)}</span><span class="muted">${hex(iid, 3)}</span>
          <span class="lv">DEF ${r16(def)} · ${r32(price)}p</span></summary>
        <div class="char-body"><div class="grid">
          <label class="field"><span>DEF</span><input type="number" class="gr" min="0" max="65535" value="${r16(def)}" data-off="${def}" data-w="2" data-dptr="${dptr}" data-g="${esc2(nm)}" data-l="DEF"></label>
          <label class="field"><span>Price (potch)</span><input type="number" class="gr" min="0" max="4294967295" value="${r32(price)}" data-off="${price}" data-w="4" data-g="${esc2(nm)}" data-l="Price"></label>
        </div>
        <label class="field" style="margin-top:8px"><span>Description (${descMax} char slot)</span>
          <input type="text" class="ge-desc" maxlength="${descMax}" value="${esc2(descStr)}" data-dptr="${dptr}" data-g="${esc2(nm)}"></label>
        <h4>Effect slots</h4>${effs}</div></details>`);
    }
    host.innerHTML = updBox + (rows.join("") || `<div class="muted">no matching equipment</div>`);
    q("#gUpd", host).onchange = (e) => { gearDescOn = e.target.checked; };

    qa("input.gr", host).forEach((inp) => {
      const off = +inp.dataset.off, w = +inp.dataset.w, nm = inp.dataset.g;
      inp.onchange = () => {
        const v = Math.max(0, Math.min(+inp.value || 0, w === 2 ? 65535 : 4294967295));
        writeW(off, w, v); reg(off, w, "num", nm, inp.dataset.l); markField(inp, off, w, "num");
        if (inp.dataset.l === "DEF" && gearDescOn && inp.dataset.dptr) {
          const r = rewriteDesc(+inp.dataset.dptr, (t) => descDef(t, v), nm, "Description");
          const di = q(`.ge-desc[data-dptr="${inp.dataset.dptr}"]`, host);
          if (di && r.ok) { di.value = strAt(+inp.dataset.dptr); markField(di, vaOff(+inp.dataset.dptr), origSlotLen(+inp.dataset.dptr), "text"); }
        }
      };
      markField(inp, off, w, "num");
    });
    qa("input.ge-desc", host).forEach((inp) => {
      const dptr = +inp.dataset.dptr;
      inp.onchange = () => {
        const r = setDescText(dptr, inp.value, inp.dataset.g, "Description");
        if (r.tooLong) setStatus(`Description too long — the slot holds ${r.max} characters.`, "warn");
        markField(inp, vaOff(dptr), origSlotLen(dptr), "text");
      };
      markField(inp, vaOff(dptr), origSlotLen(dptr), "text");
    });
    qa("[data-eff]", host).forEach((rowEl) => wireEffectSlot(rowEl));
  }
  function wireEffectSlot(rowEl) {
    const base = +rowEl.dataset.base, eo = +rowEl.dataset.eo, nm = rowEl.dataset.g;
    const tSel = rowEl.querySelector(".ge-type"), vIn = rowEl.querySelector(".ge-val");
    const stat = rowEl.querySelector(".ge-stat"), skill = rowEl.querySelector(".ge-skill");
    const commit = () => {
      const t = +tSel.value, pk = GEAR_TYPE_PARAM[t];
      stat.style.display = pk === "stat" ? "" : "none";
      skill.style.display = pk === "skill" ? "" : "none";
      const param = pk === "stat" ? +stat.value : pk === "skill" ? +skill.value : 0;
      writeW(base + eo, 2, t); writeW(base + eo + 2, 2, Math.max(0, +vIn.value || 0)); writeW(base + eo + 4, 2, param);
      reg(base + eo, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} type`);
      reg(base + eo + 2, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} value`);
      reg(base + eo + 4, 2, "num", nm, `Effect ${GEAR.effs.indexOf(eo)} param`);
      const d = isDirty(base + eo, 8);
      [tSel, stat, skill].forEach((el) => el.classList.toggle("dirty", d));
      markField(vIn, base + eo, 8, "raw");   // one ↺ for the whole 8-byte slot, anchored on the amount
    };
    [tSel, vIn, stat, skill].forEach((el) => (el.onchange = commit));
    // initialise ↺ / highlight without writing (reflects any already-staged slot change)
    const d0 = isDirty(base + eo, 8);
    [tSel, stat, skill].forEach((el) => el.classList.toggle("dirty", d0));
    markField(vIn, base + eo, 8, "raw");
  }

  // ---- Balance (Hard Mode / bulk) --------------------------------------------
  // All scaling is relative to the ORIGINAL on-disk value, so presets are idempotent
  // (re-applying "Hard" doesn't compound) and setting a multiplier to 1 restores the field.
  function applyHardMode(growthMults, spellMult, uniteMult) {
    let gN = 0, sN = 0, uN = 0;
    const [gb, gs] = TABLES.list2;
    for (let i = 0; i < LIST_COUNT.list2; i++) {
      for (const stat in GROWTH_OFFS) {
        const m = growthMults[stat]; if (m == null) continue;
        const off = gb + i * gs + GROWTH_OFFS[stat];
        const nv = Math.max(0, Math.min(15, Math.round(o8(off) * m)));   // growth bytes clamp 0..15
        if (nv !== r8(off)) gN++;
        writeW(off, 1, nv);
      }
    }
    if (spellMult != null) for (let i = 0; i < SPELL.count; i++) {
      const off = SPELL.off + i * SPELL.stride + 0x1C, nv = Math.max(0, Math.min(0xFFFFFFFF, Math.round(o32(off) * spellMult)));
      if (nv !== r32(off)) sN++; writeW(off, 4, nv);
    }
    if (uniteMult != null) for (let i = 0; i < UNITE.count; i++) {
      const off = UNITE.off + i * UNITE.stride + 0x1C, nv = Math.max(0, Math.min(0xFFFFFFFF, Math.round(o32(off) * uniteMult)));
      if (nv !== r32(off)) uN++; writeW(off, 4, nv);
    }
    return { gN, sN, uN };
  }
  function drawBalance(host) {
    const presetBtns = Object.entries(HM_PRESETS).map(([k, p]) =>
      `<button class="chip" data-preset="${k}" title="${esc2(p.desc)}">${p.label}</button>`).join("");
    const statRows = HM_STATS.map((s) =>
      `<label class="field"><span>${s} growth ×</span>
        <input type="number" class="hm-g" data-stat="${s}" min="0" max="4" step="0.05" value="1"></label>`).join("");
    host.innerHTML = `
      <div class="warnbox" style="margin-bottom:10px">This is a party <b>nerf</b> tool. It lowers how fast your characters grow (and optionally your spell/unite power) to make the game harder. Enemies can't be buffed directly in this ROM. Values scale from the ISO's originals, so presets don't stack.</div>
      <div class="bag-h">Presets</div>
      <div class="subtabs" style="margin-bottom:12px">${presetBtns}<button class="chip" data-preset="reset">Reset to 1.00×</button></div>
      <div class="bag-h">Growth-rate multipliers <span class="u">1.00 = unchanged</span></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${statRows}</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(150px,1fr));margin-top:10px">
        <label class="field"><span>Spell power ×</span><input type="number" id="hm-spell" min="0" max="4" step="0.05" value="1"></label>
        <label class="field"><span>Unite power ×</span><input type="number" id="hm-unite" min="0" max="4" step="0.05" value="1"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="hm-apply">Stage these multipliers</button>
        <span class="muted" id="hm-out"></span>
      </div>`;
    const gInputs = qa(".hm-g", host);
    const setMults = (g, sp, up) => {
      gInputs.forEach((i) => { i.value = g[i.dataset.stat] != null ? g[i.dataset.stat] : 1; });
      q("#hm-spell", host).value = sp; q("#hm-unite", host).value = up;
    };
    qa("[data-preset]", host).forEach((b) => (b.onclick = () => {
      if (b.dataset.preset === "reset") return setMults({}, 1, 1);
      const p = HM_PRESETS[b.dataset.preset]; setMults(p.growth, p.spell, p.unite);
    }));
    q("#hm-apply", host).onclick = () => {
      const g = {}; gInputs.forEach((i) => (g[i.dataset.stat] = +i.value || 0));
      const sp = +q("#hm-spell", host).value, up = +q("#hm-unite", host).value;
      const res = applyHardMode(g, sp, up);
      updateDirtyBadge();
      q("#hm-out", host).textContent =
        `Staged ${res.gN} growth byte(s)` + (res.sN ? `, ${res.sN} spell power(s)` : "") + (res.uN ? `, ${res.uN} unite power(s)` : "") + ". Review, then Save.";
      setStatus("Balance multipliers staged.", "ok");
    };
  }

  // ---- Enemies (read-only names) ---------------------------------------------
  function drawEnemies(host) {
    const rows = [];
    for (let i = 0; i < ENEMY.count; i++) {
      const off = ENEMY.off + i * ENEMY.stride;
      const nm = strFrom(BUF, off, ENEMY.stride).replace(/[^\x20-\x7e].*$/, "").trim();
      if (SEARCH && !nm.toLowerCase().includes(SEARCH) && String(i) !== SEARCH) continue;
      rows.push(`<tr><td class="sl">${i}</td><td>${esc2(nm || "—")}</td></tr>`);
    }
    host.innerHTML = `<table class="invtbl"><thead><tr><th>#</th><th>Enemy</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="2" class="muted">no matches</td></tr>`}</tbody></table>`;
  }

  // ---- Reference (read-only item / skill browser) ----------------------------
  let REF_KIND = "items";
  function drawReference(host) {
    const isItems = REF_KIND === "items";
    const list = isItems
      ? Object.keys(REF.items).map(Number).sort((a, b) => a - b).map((id) => ({ id, w: 3, nm: itemName(id), sub: REF.cats[id] || "", desc: REF.idesc[id] || "" }))
      : Object.keys(REF.skills).map(Number).sort((a, b) => a - b).map((id) => ({ id, w: 2, nm: skillName(id), sub: "", desc: "" }));
    const q2 = SEARCH;
    const rows = list.filter((o) => !q2 || o.nm.toLowerCase().includes(q2) || hex(o.id, o.w).toLowerCase().includes(q2))
      .map((o) => `<tr><td class="sl">${hex(o.id, o.w)}</td><td>${esc2(o.nm)}${o.desc ? `<div class="muted">${esc2(o.desc)}</div>` : ""}</td><td class="ty">${esc2(o.sub)}</td></tr>`);
    host.innerHTML = `<div class="subtabs" style="margin-bottom:10px">
        <button class="chip${isItems ? " on" : ""}" data-ref="items">Items (${Object.keys(REF.items).length})</button>
        <button class="chip${isItems ? "" : " on"}" data-ref="skills">Skills (${Object.keys(REF.skills).length})</button></div>
      <table class="invtbl"><thead><tr><th>ID</th><th>Name</th><th>Category</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="3" class="muted">no matches</td></tr>`}</tbody></table>`;
    qa("[data-ref]", host).forEach((b) => (b.onclick = () => { REF_KIND = b.dataset.ref; drawReference(host); }));
  }

  // ---- misc ------------------------------------------------------------------
  function fmtSize(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB"; }
  function fmtDuration(ms) { const s = ms / 1000; if (s < 60) return s.toFixed(1) + "s"; const m = Math.floor(s / 60); return `${m}m ${Math.round(s % 60)}s`; }
  function setStatus(msg, kind) { const el = q("#isoStatus"); if (el) { el.textContent = msg; el.className = "status" + (kind ? " " + kind : ""); } else { const b = q("#isoBootStatus"); if (b) b.textContent = msg; } }

  // ---- loader shell (adapts to how this browser can save) --------------------
  function renderLoader() {
    // Copy + picker depend on the save capability. FS Access → in-place; else streamed copy;
    // else read-only (recipe export). Opening the ISO works everywhere via a ranged read.
    const howSaves = SUPPORTS_FS
      ? `Edits are written back <b>in place</b>. Nothing is uploaded. <b>Back up your ISO first</b> — or use <i>Export recipe</i> for a reversible record.`
      : CAN_STREAM_SAVE
        ? `This browser can't overwrite the file in place, so saving <b>streams a patched copy to your downloads</b> (a full ~4 GB file) — nothing is uploaded. You then swap it in for your ISO. <i>Export recipe</i> is a lighter alternative.`
        : `This browser can only <b>read</b> the disc. Browse and stage edits, then <b>Export a recipe</b> and apply it on a desktop Chromium browser (or the desktop app).`;
    const picker = SUPPORTS_FS
      ? `<label class="file"><button type="button" id="isoPick">Choose ISO…</button></label>`
      : `<label class="file"><button type="button" id="isoPickInputBtn">Choose ISO…</button>
          <input type="file" id="isoFileInput"></label>`;
    q("#isoRoot").innerHTML = `
      <div class="card">
        <h2>Load ISO</h2>
        <p class="sub" style="margin-top:0">Pick your <b>Suikoden III (USA)</b> disc image (SLUS-20387).
          Only a ~3.7 MB slice is read to edit. ${howSaves}</p>
        <div class="drop">
          <div><b>Open a Suikoden III ISO</b></div>
          ${picker}
          <div class="muted" style="margin-top:10px" id="isoBootStatus">.iso / .bin / .img · USA release only</div>
        </div>
        <div id="isoRecent"></div>
      </div>`;
    if (SUPPORTS_FS) {
      q("#isoPick").onclick = () => loadRef().then(openIso).catch((e) => setStatus("Failed to load reference tables: " + e.message, "err"));
      loadRef().then(showLastIso).catch(() => {});   // one-tap reopen (persisted handle; FS only)
    } else {
      const inp = q("#isoFileInput");
      q("#isoPickInputBtn").onclick = () => loadRef().then(() => inp.click()).catch((e) => setStatus("Failed to load reference tables: " + e.message, "err"));
      inp.onchange = () => { if (inp.files[0]) loadFromInputFile(inp.files[0]); };
    }
  }

  // ---- mode tabs + init ------------------------------------------------------
  function switchMode(mode) {
    qa(".mtab").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const save = q("#mode-save"), iso = q("#mode-iso");
    if (save) save.classList.toggle("hidden", mode !== "save");
    if (iso) iso.classList.toggle("hidden", mode !== "iso");
    if (mode === "iso" && !q("#isoRoot").dataset.init) {
      renderLoader();
      q("#isoRoot").dataset.init = "1";
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    qa(".mtab").forEach((b) => (b.onclick = () => switchMode(b.dataset.mode)));
    // warn before leaving with unsaved ISO edits (save editor has its own guard)
    window.addEventListener("beforeunload", (e) => { if (anyChanges()) { e.preventDefault(); e.returnValue = ""; } });
  });
})();
