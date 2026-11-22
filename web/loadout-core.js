// Loadout CSV export / import for the Save Editor, shared by the browser (app.js) and
// the Node tests. No DOM / no Pyodide: pure text in, staged edits out, so the format and
// its validation can be unit-tested without a browser.
//
// Format (one row per equipment slot, in roster order then slot order):
//
//   character_name,roster_index,character_id,slot,slot_label,item_id,item_id_hex,item_name
//   Hugo,0,1,headRune,Head Rune,0,000,
//   Hugo,0,1,rightRune,Right Rune,317,13D,Fire Rune
//   ...
//
//   character_name / character_id   the character the row belongs to. character_id is the
//                                   record id at block +0x0C (s3save.ROSTER_IDS), decimal.
//   roster_index                    the roster slot (the key every edit in this editor
//                                   uses), decimal.
//   slot / slot_label               the equipment slot key (s3save.EQUIP_SLOTS) and its
//                                   display label (HealthCore.SLOT_LABEL).
//   item_id / item_id_hex           the equipped item id, decimal and 3-digit hex. Both
//                                   are written so a spreadsheet edit in either column
//                                   is caught when they disagree. 0 means empty.
//   item_name                       the item table name for item_id (blank when empty).
//
// Import is strict and all-or-nothing. Every row is checked: the header must match
// exactly, every row must have exactly eight fields, the character must exist and its
// name and record id must match the loaded save, the slot must be a real slot key whose
// label matches, the two item id columns must agree, the item id must exist in the item
// table, and the item name must match that id. A duplicate row for the same character
// and slot is an error. Any error rejects the whole file: the result carries a per-row
// error list and no edits at all, so nothing is staged from a bad file.
//
// What is deliberately NOT checked: whether an item's picker category fits the slot.
// The picker categories (HealthCore.SLOT_CATS) are a browsing aid, not a save rule: the
// engine writes any u16 to any equipment slot, and real saves hold off-category values
// in the later slots (a corpus save reads a glove in the boots slot and food in the
// gloves slot). Enforcing picker categories would make this editor's own export of a
// real save un-importable, which breaks the round-trip this format exists for. A slot
// the save model does not have at all is still an error, as above.
//
// Staging: a clean parse returns edits in exactly the shape the character cards stage,
// { rosterIndex: { equip: { slot: itemId } } }, covering every row in the file. The
// caller merges that into its pending EDITS map and the user still reviews and Applies
// as usual. Nothing here writes a save.
(function (root) {
  const SLOT_KEYS = ["headRune", "rightRune", "leftRune", "helm", "armor", "shield",
                     "boots", "gloves", "accessory"];
  const SLOT_LABEL = { headRune: "Head Rune", rightRune: "Right Rune", leftRune: "Left Rune",
    helm: "Helm", armor: "Armor", shield: "Shield", boots: "Boots", gloves: "Gloves",
    accessory: "Accessory" };
  const HEADER = ["character_name", "roster_index", "character_id", "slot", "slot_label",
                  "item_id", "item_id_hex", "item_name"];
  const ITEM_ID_MAX = 0x2ff;   // s3save.ITEM_ID_MAX

  const itemName = (ctx, id) => {
    if (!id) return "";
    const byId = (ctx && ctx.itemById) || {};
    const it = byId[id] || byId[String(id)];
    if (!it) return null;
    return typeof it === "string" ? it : it.name;
  };
  const charIdOf = (c) => (c.idExpected != null ? c.idExpected : c.id);

  // ---- CSV writing ------------------------------------------------------------
  function csvField(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // characters: the decoded save's character list. Only characters with data or a
  // recruit flag are exported, matching exportSaveJSON's scope. Every one of the nine
  // slots gets a row, empty slots included, so clearing a slot in a spreadsheet and
  // re-importing really clears it.
  function toCsv(characters, ctx) {
    const lines = [HEADER.join(",")];
    for (const c of characters || []) {
      if (!c.hasData && !c.recruited) continue;
      for (const slot of SLOT_KEYS) {
        const id = (c.equip && c.equip[slot]) || 0;
        const name = itemName(ctx, id);
        lines.push([c.name, c.rosterIndex, charIdOf(c), slot, SLOT_LABEL[slot],
                    id, id ? id.toString(16).toUpperCase().padStart(3, "0") : "000",
                    name == null ? "#" + id : name].map(csvField).join(","));
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  // ---- CSV reading --------------------------------------------------------------
  // A small strict parser: quoted fields with "" escapes, CRLF or LF endings. Returns
  // { rows: [[field, ...], ...], errors: [{row, message}] } with 1-based row numbers
  // (the header is row 1). A malformed quote is an error, never a silent re-read.
  function parseCsv(text) {
    const errors = [], rows = [];
    let row = [], field = "", inQ = false, afterQ = false, line = 1, rowLine = 1;
    let i = text && text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const src = String(text == null ? "" : text);
    const endField = () => { row.push(field); field = ""; afterQ = false; };
    const endRow = () => { endField(); rows.push({ line: rowLine, fields: row }); row = []; };
    for (; i < src.length; i++) {
      const ch = src[i];
      if (inQ) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else { inQ = false; afterQ = true; }
        } else field += ch;
        if (ch === "\n") line++;
        continue;
      }
      if (afterQ && ch !== "," && ch !== "\r" && ch !== "\n") {
        errors.push({ row: line, message: `unexpected character after closing quote: ${JSON.stringify(ch)}` });
        afterQ = false;
      }
      if (ch === '"') {
        if (field === "" && !afterQ) inQ = true;
        else errors.push({ row: line, message: "unexpected quote in unquoted field" });
      } else if (ch === ",") endField();
      else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && src[i + 1] === "\n") i++;
        endRow(); line++; rowLine = line;
      } else field += ch;
    }
    if (inQ) errors.push({ row: rowLine, message: "unterminated quoted field" });
    if (field !== "" || row.length || afterQ) endRow();
    return { rows, errors };
  }

  const isInt = (s) => /^-?\d+$/.test(s);

  // Validate a loadout CSV against the loaded save and the item table.
  // ctx: { characters, itemById } with itemById mapping id -> {name} or name.
  // Returns { ok, errors: [{row, message}], edits, rows, changed } where edits is {}
  // whenever ok is false, and changed counts rows whose item differs from the save.
  function parseLoadout(text, ctx) {
    const fail = (errors) => ({ ok: false, errors, edits: {}, rows: 0, changed: 0 });
    if (typeof text !== "string" || !text.trim())
      return fail([{ row: 0, message: "file is empty" }]);
    const { rows: raw, errors: csvErrors } = parseCsv(text);
    if (csvErrors.length) return fail(csvErrors);
    if (!raw.length) return fail([{ row: 0, message: "file is empty" }]);
    const head = raw[0].fields;
    if (head.length !== HEADER.length || HEADER.some((h, k) => head[k] !== h))
      return fail([{ row: 1, message: `bad header: expected ${HEADER.join(",")}` }]);

    const byRi = {};
    for (const c of (ctx && ctx.characters) || []) byRi[c.rosterIndex] = c;
    const errors = [], edits = {}, seen = new Set();
    let changed = 0, dataRows = 0;

    raw.slice(1).forEach(({ line, fields }) => {
      // A single trailing blank line is the file's final newline, already handled by
      // the parser; a blank row in the middle is malformed, not skippable.
      if (fields.length !== HEADER.length) {
        errors.push({ row: line, message: `expected ${HEADER.length} fields, found ${fields.length}` });
        return;
      }
      dataRows++;
      const [name, riS, cidS, slot, slotLabel, idS, idHexS, itName] = fields;
      if (!isInt(riS)) { errors.push({ row: line, message: `roster_index is not an integer: ${JSON.stringify(riS)}` }); return; }
      const ri = parseInt(riS, 10), c = byRi[ri];
      if (!c) { errors.push({ row: line, message: `unknown character: roster_index ${ri}` }); return; }
      let bad = false;
      const err = (message) => { errors.push({ row: line, message }); bad = true; };
      if (name !== c.name) err(`character_name ${JSON.stringify(name)} does not match roster_index ${ri} (${JSON.stringify(c.name)})`);
      if (!isInt(cidS) || parseInt(cidS, 10) !== charIdOf(c))
        err(`character_id ${JSON.stringify(cidS)} does not match ${c.name} (expected ${charIdOf(c)})`);
      if (!SLOT_KEYS.includes(slot)) err(`unknown slot: ${JSON.stringify(slot)}`);
      else if (slotLabel !== SLOT_LABEL[slot]) err(`slot_label ${JSON.stringify(slotLabel)} does not match slot ${slot} (expected ${JSON.stringify(SLOT_LABEL[slot])})`);
      const dupKey = ri + ":" + slot;
      if (seen.has(dupKey)) err(`duplicate row for ${c.name} slot ${slot}`);
      seen.add(dupKey);

      if (!isInt(idS)) err(`item_id is not an integer: ${JSON.stringify(idS)}`);
      if (!/^[0-9A-Fa-f]{1,4}$/.test(idHexS)) err(`item_id_hex is not hex: ${JSON.stringify(idHexS)}`);
      if (bad) return;
      const id = parseInt(idS, 10);
      if (parseInt(idHexS, 16) !== id)
        return errors.push({ row: line, message: `item_id ${id} and item_id_hex ${JSON.stringify(idHexS)} disagree` }), undefined;
      if (id < 0 || id > ITEM_ID_MAX)
        return errors.push({ row: line, message: `unknown item id: ${id} (outside the item table range 0 to ${ITEM_ID_MAX})` }), undefined;
      const want = itemName(ctx, id);
      if (id && want == null)
        return errors.push({ row: line, message: `unknown item id: ${id}` }), undefined;
      if (itName !== (want || ""))
        return errors.push({ row: line, message: `item_name ${JSON.stringify(itName)} does not match item id ${id} (expected ${JSON.stringify(want || "")})` }), undefined;
      (edits[ri] = edits[ri] || { equip: {} }).equip[slot] = id;
      if (id !== ((c.equip && c.equip[slot]) || 0)) changed++;
    });

    if (!dataRows && !errors.length) errors.push({ row: 1, message: "no data rows" });
    if (errors.length) return fail(errors);
    return { ok: true, errors: [], edits, rows: dataRows, changed };
  }

  // Merge a clean parse into a pending EDITS map, in place. Callers must only pass a
  // result with ok true; a rejected parse stages nothing, by construction and by guard.
  function stageInto(result, EDITS) {
    if (!result || !result.ok) return 0;
    let n = 0;
    for (const [ri, e] of Object.entries(result.edits)) {
      const t = (EDITS[ri] = EDITS[ri] || {});
      t.equip = Object.assign(t.equip || {}, e.equip);
      n += Object.keys(e.equip).length;
    }
    return n;
  }

  const api = { SLOT_KEYS, SLOT_LABEL, HEADER, ITEM_ID_MAX, toCsv, parseCsv, parseLoadout, stageInto };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LoadoutCore = api;
})(typeof self !== "undefined" ? self : globalThis);
