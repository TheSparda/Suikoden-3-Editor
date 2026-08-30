// Save-rule constants + the save health audit, shared by the browser (app.js) and the
// Node tests. No DOM / no Pyodide — pure data in, findings out, so every rule can be
// unit-tested without a browser (the save editor UI itself needs Pyodide, which headless
// CI can't load).
//
// Two halves:
//
//   1. The item-classification rules that mirror s3save.item_stackable / item_category.
//      They used to live inline in app.js as a second copy; owning them here means the
//      audit and the inventory UI can never disagree about what "stackable" means.
//
//   2. audit(save, staged, opts) — the health check. It runs over the EFFECTIVE save
//      (what's on disk, with the pending edits applied on top), so it catches both damage
//      already in the file and damage you are about to write. Every finding is
//      {id, sev, group, title, detail, where?, fix?}; a `fix` is a list of primitive
//      staging ops the caller applies to its own edit maps, so this module never touches
//      the UI and the fix goes through the normal review-changes → Apply path.
//
// House rule, same as the guide overlays: correct or absent, never wrong. A check that
// needs a lookup the caller didn't supply (item table, guide data) simply doesn't run,
// and no finding claims a consequence that isn't derivable from s3save.py's own write
// path. "will be written as N" appears only where the engine really clamps.
(function (root) {
  // ---- save rules (mirror s3save.py) ---------------------------------------
  const ITEM_QTY_MAX = 9;                 // s3save.ITEM_QTY_MAX — the count domain is 0-9
  const ITEM_ID_MAX = 0x2ff;              // s3save.ITEM_ID_MAX
  // s3save.ITEM_ONE_PER_SLOT_EXC / ITEM_STACKABLE_EXC — the nine ids that contradict the
  // band rule (stat stones, Sacrificial Jizo, Dragon Incense; Grape the other way).
  const ITEM_ONE_PER_SLOT_EXC = new Set([0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x9e, 0x9f]);
  const ITEM_STACKABLE_EXC = new Set([0x202]);

  // s3save.item_stackable: does this item carry a real count, or is it one-per-slot?
  function itemStackable(id) {
    if (!(id > 0)) return false;
    if (ITEM_ONE_PER_SLOT_EXC.has(id)) return false;
    if (ITEM_STACKABLE_EXC.has(id)) return true;
    return id < 0xa0 || (id >= 0x1f0 && id < 0x200);
  }
  // s3save.item_category.
  function itemCategory(id) { return id >= 0x200 ? "key" : id >= 0xa0 ? "equipment" : "consumable"; }

  // What the engine actually stores in the count field for a slot it writes
  // (apply_edits_to_gamedata: one-per-slot -> 0, stackable -> clamped to 1..9).
  function engineQty(id, stackable, requested) {
    if (!id) return 0;
    if (!stackable) return 0;
    return Math.max(1, Math.min(ITEM_QTY_MAX, requested | 0));
  }

  // Fields the engine clamps to a real cap on write (s3save.CHAR_FIELDS). Anything else is
  // clamped only to its byte width, which is what U16_MAX/U32_MAX below cover.
  const CAPS = { level: 99, weaponLv: 16, curHP: 9999, maxHP: 9999, expToNext: 999 };
  const ENGINE_CAPS = { level: 99, weaponLv: 16, expToNext: 999 };   // s3save clamps these
  // The editor's labels for those fields, so a finding reads "Level is 120", not "level is 120".
  const FIELD_LABEL = { level: "Level", weaponLv: "Weapon Lv", curHP: "Current HP",
                        maxHP: "Max HP", expToNext: "EXP in level" };
  const U16_MAX = 0xffff, U32_MAX = 0xffffffff;

  // Which item categories fit which equipment slot (the pickers use the same map).
  const SLOT_CATS = {
    headRune: ["Runes"], rightRune: ["Runes"], leftRune: ["Runes"],
    helm: ["Headgear"], armor: ["Armor"], shield: ["Shields"],
    boots: ["Footwear"], gloves: ["Gloves"], accessory: ["Rings", "Misc Gear"],
  };
  const SLOT_LABEL = { headRune: "Head Rune", rightRune: "Right Rune", leftRune: "Left Rune",
    helm: "Helm", armor: "Armor", shield: "Shield", boots: "Boots", gloves: "Gloves",
    accessory: "Accessory" };
  const RUNE_SLOTS = ["headRune", "rightRune", "leftRune"];

  // Skill rank tiers, by value (s3save writes the raw byte; these are the editor's labels).
  const RANK_LABELS = ["— (none)", "E", "D", "C", "B", "B+", "A", "A+", "S"];
  const rankLabel = (v) => RANK_LABELS[v] || String(v);
  const rankValue = (grade) => { const i = RANK_LABELS.indexOf(String(grade)); return i > 0 ? i : null; };

  const SEV_RANK = { error: 0, warn: 1, info: 2 };

  // ---- effective save (loaded + staged) ------------------------------------
  // `staged` mirrors the app's pending-edit maps: {edits, inv, party, recruit, gold}.
  // Returns a normalized view with the same field names the decoded save uses, so the
  // checks below never have to ask "is this staged or on disk".
  function effective(save, staged) {
    staged = staged || {};
    const E = staged.edits || {}, INV = staged.inv || {}, P = staged.party || {},
      R = staged.recruit || {};

    const characters = (save.characters || []).map((c) => {
      const e = E[c.rosterIndex] || {}, r = R[c.rosterIndex];
      const stats = Object.assign({}, c.stats, e.stats || {});
      const equip = Object.assign({}, c.equip, e.equip || {});
      const skills = (c.skills || []).map((sk) => {
        const s = (e.skills || {})[sk.slot] || {};
        return { slot: sk.slot, id: "id" in s ? s.id : sk.id, rank: "rank" in s ? s.rank : sk.rank,
                 staged: "id" in s || "rank" in s };
      });
      const out = { rosterIndex: c.rosterIndex, name: c.name, id: c.id, idExpected: c.idExpected,
        stats, equip, skills, hasData: c.hasData,
        recruited: r && "recruited" in r ? !!r.recruited : !!c.recruited,
        recruiters: r && "teams" in r ? r.teams.slice() : (c.recruiters || []).slice(),
        staged: { char: Object.keys(e).length > 0, recruit: !!r } };
      ["level", "weaponLv", "curHP", "maxHP", "expToNext"].forEach((k) => {
        out[k] = k in e ? e[k] : c[k];
      });
      // hasData is the engine's "this record has been initialized" signal; recompute it so a
      // staged level/stat counts, otherwise fixing an empty record wouldn't clear the finding.
      out.hasData = out.level > 0 || Object.values(stats).some((v) => v > 0);
      return out;
    });

    const party = (save.party || []).map((cid, slot) => (slot in P ? P[slot] : cid));

    const bags = (save.inventory || []).map((bag) => {
      const bySlot = {};
      (bag.items || []).forEach((it) => (bySlot[it.slot] = it));
      const items = [], free = [];
      for (let k = 0; k < bag.capacity; k++) {
        const slot = bag.firstSlot + k, base = bySlot[slot], st = INV[slot];
        let id = base ? base.id : 0, qty = base ? base.qty : 0;
        let stackable = base ? base.stackable : false;
        if (st) {
          if ("id" in st) {
            id = st.id;
            // The save's own evidence (base.stackable) only applies while the id is unchanged.
            stackable = base && base.id === id ? base.stackable : itemStackable(id);
            qty = "qty" in st ? st.qty : (stackable ? 1 : 0);
          } else if ("qty" in st) qty = st.qty;
          qty = engineQty(id, stackable, qty);      // what write_save_edits will really store
        }
        if (!id) { free.push(slot); continue; }
        items.push({ slot, id, qty, stackable,
          category: base && base.id === id ? base.category : itemCategory(id),
          displayed: !!(base && base.id === id && base.displayed),
          staged: !!st });
      }
      const lastUsed = items.length ? items[items.length - 1].slot : -1;
      return { region: bag.region, firstSlot: bag.firstSlot, capacity: bag.capacity,
        items, freeSlots: free, used: items.length,
        wasEmpty: !(bag.items || []).length,      // empty on disk, before staged edits
        gaps: free.filter((s) => s < lastUsed) };
    });

    const g = save.global || {};
    return { characters, party, bags,
      gold: staged.gold != null ? staged.gold : g.gold,
      storyPhase: g.storyPhase, merged: !!g.merged, partyLeader: g.partyLeader,
      problems: save.problems || [], notes: save.notes || [] };
  }

  // ---- the audit -----------------------------------------------------------
  // opts (every entry optional — a missing one just disables the checks that need it):
  //   item(id)      -> {name, cat} | null      the item table
  //   skillName(id) -> string
  //   charName(id)  -> string                  char-id (party space) -> display name
  //   skillCap(charName, skillId) -> {grade} | null       GuideCore.skillCap
  //   runeSlot(charName, slotKey) -> {state, lv, rune} | null   GuideCore.runeSlot
  function audit(save, staged, opts) {
    opts = opts || {};
    const eff = effective(save, staged);
    const out = [];
    const add = (f) => out.push(f);
    const item = (id) => (opts.item ? opts.item(id) : null);
    const itemName = (id) => { const i = item(id); return i ? i.name : "#" + id; };
    const skillName = (id) => (opts.skillName ? opts.skillName(id) : "#" + id);
    const charName = (id) => (opts.charName ? opts.charName(id) : "id " + id);
    const at = (name) => ({ sub: "chars", search: name });

    // --- what the engine already told us about this file ---------------------
    // Fold the decode-time layout checks in so the panel is the one place to look.
    eff.problems.forEach((t, i) => add({ id: "decode-problem-" + i, sev: "error", group: "Save file",
      title: "This save does not decode cleanly", detail: t }));
    eff.notes.forEach((t, i) => add({ id: "decode-note-" + i, sev: "info", group: "Save file",
      title: "Decode note", detail: t }));

    // --- party ---------------------------------------------------------------
    // Party slots hold char ids, not roster indices; map back through the record id the
    // roster slot is expected to carry (ROSTER_IDS, via decode_character).
    const byCharId = {};
    eff.characters.forEach((c) => { if (typeof c.idExpected === "number") byCharId[c.idExpected] = c; });
    const filled = eff.party.filter((id) => id > 0);
    if (!filled.length) {
      add({ id: "party-empty", sev: "info", group: "Party",
        title: "The active party is empty",
        detail: "Normal in early chapters, where story events set the field party themselves.",
        where: { sub: "party", search: "" } });
    }
    const seen = {};
    eff.party.forEach((cid, slot) => {
      if (!cid) return;
      const who = charName(cid);
      if (seen[cid] != null) {
        add({ id: "party-dup-" + slot, sev: "warn", group: "Party",
          title: `${who} is in party slots ${seen[cid] + 1} and ${slot + 1}`,
          detail: "The same character twice in the active party is not a state the game builds.",
          where: { sub: "party", search: "" },
          fix: { label: `Clear slot ${slot + 1}`, ops: [{ kind: "party", slot, value: 0 }] } });
      } else seen[cid] = slot;
      const c = byCharId[cid];
      if (c && !c.recruited) {
        add({ id: "party-unrecruited-" + slot, sev: "error", group: "Party",
          title: `Party slot ${slot + 1} holds ${c.name}, who is not recruited`,
          detail: "Their recruit flag is 0, so the game does not consider them part of your army. " +
            "Either recruit them or clear the slot.",
          where: { sub: "party", search: "" },
          fix: { label: `Recruit ${c.name}`, ops: [{ kind: "recruit", ri: c.rosterIndex, recruited: true }] } });
      }
    });
    if (eff.partyLeader && filled.length && !filled.includes(eff.partyLeader)) {
      add({ id: "party-leader-absent", sev: "info", group: "Party",
        title: `The party leader (${charName(eff.partyLeader)}) is not in the active party`,
        detail: "Worth a look if you did not mean it; the game sets the leader itself on story transitions.",
        where: { sub: "party", search: "" } });
    }

    // --- characters ----------------------------------------------------------
    eff.characters.forEach((c) => {
      const live = c.recruited || c.hasData;
      if (!live) return;
      const ri = c.rosterIndex;

      if (c.curHP > c.maxHP) {
        add({ id: `hp-over-${ri}`, sev: "error", group: c.name,
          title: `Current HP ${c.curHP} is above max HP ${c.maxHP}`,
          detail: "An invariant the game holds in every save; leaving it can produce odd healing behaviour.",
          where: at(c.name),
          fix: { label: `Set current HP to ${c.maxHP}`, ops: [{ kind: "charField", ri, field: "curHP", value: c.maxHP }] } });
      } else if (c.maxHP > 0 && c.curHP === 0) {
        add({ id: `hp-zero-${ri}`, sev: "info", group: c.name,
          title: "Current HP is 0",
          detail: "They are down — fine if that is how you saved, otherwise heal them here.",
          where: at(c.name),
          fix: { label: `Heal to ${c.maxHP}`, ops: [{ kind: "charField", ri, field: "curHP", value: c.maxHP }] } });
      }
      if (c.recruited && c.level > 0 && c.maxHP === 0) {
        add({ id: `maxhp-zero-${ri}`, sev: "warn", group: c.name,
          title: "Max HP is 0",
          detail: "A recruited character with no max HP cannot survive a hit.",
          where: at(c.name) });
      }
      if (c.recruited && !c.hasData) {
        add({ id: `empty-record-${ri}`, sev: "warn", group: c.name,
          title: "Flagged recruited, but the character record is empty",
          detail: "Level 0 and no stats. The game fills the record in when the character actually " +
            "joins, so a recruit flag set by hand can leave them unusable until then.",
          where: { sub: "recruit", search: c.name },
          fix: { label: `Un-recruit ${c.name}`, ops: [{ kind: "recruit", ri, recruited: false }] } });
      }

      // Values the engine clamps on write — say exactly what will land in the file.
      Object.entries(ENGINE_CAPS).forEach(([field, cap]) => {
        if (c[field] > cap) add({ id: `clamp-${field}-${ri}`, sev: "warn", group: c.name,
          title: `${FIELD_LABEL[field]} is ${c[field]} — above the maximum of ${cap}`,
          detail: `The save engine clamps this field, so it will be written as ${cap}.`,
          where: at(c.name),
          fix: { label: `Set to ${cap}`, ops: [{ kind: "charField", ri, field, value: cap }] } });
      });
      ["curHP", "maxHP"].forEach((field) => {
        if (c[field] > U16_MAX) add({ id: `clamp-${field}-${ri}`, sev: "warn", group: c.name,
          title: `${FIELD_LABEL[field]} is ${c[field]} — past the field's 16-bit range`,
          detail: `It will be written as ${U16_MAX}.`,
          where: at(c.name),
          fix: { label: `Set to ${CAPS[field]}`, ops: [{ kind: "charField", ri, field, value: CAPS[field] }] } });
      });
      Object.entries(c.stats).forEach(([st, v]) => {
        if (v > U16_MAX) add({ id: `clamp-stat-${st}-${ri}`, sev: "warn", group: c.name,
          title: `${st} is ${v} — past the field's 16-bit range`,
          detail: `It will be written as ${U16_MAX}.`,
          where: at(c.name),
          fix: { label: "Set to 999", ops: [{ kind: "charStat", ri, stat: st, value: 999 }] } });
      });

      // skills
      const firstSlotOf = {};
      c.skills.forEach((sk) => {
        if (sk.id && sk.rank === 0) {
          add({ id: `skill-norank-${ri}-${sk.slot}`, sev: "info", group: c.name,
            title: `Skill slot ${sk.slot + 1} holds ${skillName(sk.id)} at rank “${rankLabel(0)}”`,
            detail: "A skill with no rank grade. Give it a rank or clear the slot.",
            where: at(c.name),
            fix: { label: "Set rank E", ops: [{ kind: "charSkill", ri, slot: sk.slot, rank: 1 }] } });
        }
        if (!sk.id && sk.rank > 0) {
          add({ id: `skill-norankskill-${ri}-${sk.slot}`, sev: "warn", group: c.name,
            title: `Skill slot ${sk.slot + 1} has rank ${rankLabel(sk.rank)} but no skill`,
            detail: "The rank byte is set on an empty slot.",
            where: at(c.name),
            fix: { label: "Clear the rank", ops: [{ kind: "charSkill", ri, slot: sk.slot, rank: 0 }] } });
        }
        if (sk.id) {
          if (firstSlotOf[sk.id] != null) {
            add({ id: `skill-dup-${ri}-${sk.slot}`, sev: "warn", group: c.name,
              title: `${skillName(sk.id)} is in skill slots ${firstSlotOf[sk.id] + 1} and ${sk.slot + 1}`,
              detail: "The same skill twice on one character wastes a slot.",
              where: at(c.name),
              fix: { label: `Clear slot ${sk.slot + 1}`, ops: [{ kind: "charSkill", ri, slot: sk.slot, id: 0, rank: 0 }] } });
          } else firstSlotOf[sk.id] = sk.slot;

          const cap = opts.skillCap ? opts.skillCap(c.name, sk.id) : null;
          if (cap && !cap.grade) {
            add({ id: `skill-cantlearn-${ri}-${sk.slot}`, sev: "info", group: c.name,
              title: `The guide says ${c.name} cannot learn ${skillName(sk.id)}`,
              detail: `Slot ${sk.slot + 1}. Not something the game grants them.`,
              where: at(c.name),
              fix: { label: `Clear slot ${sk.slot + 1}`, ops: [{ kind: "charSkill", ri, slot: sk.slot, id: 0, rank: 0 }] } });
          } else if (cap && cap.grade) {
            const capVal = rankValue(cap.grade);
            if (capVal != null && sk.rank > capVal) {
              add({ id: `skill-overcap-${ri}-${sk.slot}`, sev: "info", group: c.name,
                title: `${skillName(sk.id)} is at ${rankLabel(sk.rank)}; the guide's maximum for ${c.name} is ${cap.grade}`,
                detail: `Slot ${sk.slot + 1}. Above what the character can reach in an unmodified game.`,
                where: at(c.name),
                fix: { label: `Set to ${cap.grade}`, ops: [{ kind: "charSkill", ri, slot: sk.slot, rank: capVal }] } });
            }
          }
        }
      });

      // equipment
      Object.entries(c.equip).forEach(([slot, id]) => {
        if (!id) return;
        const label = SLOT_LABEL[slot] || slot;
        const rec = item(id);
        if (opts.item && !rec) {
          add({ id: `equip-unknown-${ri}-${slot}`, sev: "warn", group: c.name,
            title: `${label} holds item id 0x${id.toString(16).toUpperCase()}, which is not in the item table`,
            detail: "Nothing in the game's item list has that id.",
            where: at(c.name),
            fix: { label: `Clear ${label}`, ops: [{ kind: "charEquip", ri, slot, value: 0 }] } });
          return;
        }
        const cats = SLOT_CATS[slot];
        if (rec && rec.cat && cats && !cats.includes(rec.cat)) {
          add({ id: `equip-cat-${ri}-${slot}`, sev: "warn", group: c.name,
            title: `${label} holds ${rec.name}, which is ${rec.cat}`,
            detail: `That slot takes ${cats.join(" / ")}.`,
            where: at(c.name),
            fix: { label: `Clear ${label}`, ops: [{ kind: "charEquip", ri, slot, value: 0 }] } });
        }
        if (RUNE_SLOTS.includes(slot) && opts.runeSlot) {
          const g = opts.runeSlot(c.name, slot);
          const lv = g && g.state === "opens" ? parseInt(g.lv, 10) : null;
          if (lv && c.level > 0 && c.level < lv) {
            add({ id: `rune-locked-${ri}-${slot}`, sev: "info", group: c.name,
              title: `${label} is filled, but the guide says it opens at Lv ${lv}`,
              detail: `${c.name} is Lv ${c.level}. The rune is stored; whether the game shows the slot yet is its call.`,
              where: at(c.name) });
          }
        }
      });
    });

    // --- inventory -----------------------------------------------------------
    eff.bags.forEach((bag, bi) => {
      bag.items.forEach((it) => {
        if (!it.stackable && it.qty > 0) {
          add({ id: `inv-count-${it.slot}`, sev: "warn", group: `Inventory — ${bag.region}`,
            title: `${itemName(it.id)} (slot ${it.slot}) is one-per-slot but carries a count of ${it.qty}`,
            detail: "The game holds several copies as several slots, each with a count of 0. An entry " +
              "with a count is a shape it never writes — the whole slot is freed as soon as one copy " +
              "leaves it, which is how editor-added runes used to vanish.",
            where: { sub: "items", search: String(it.slot) },
            fix: { label: "Clear the count", ops: [{ kind: "inv", slot: it.slot, qty: 0 }] } });
        }
        if (it.stackable && it.qty > ITEM_QTY_MAX) {
          add({ id: `inv-qty-${it.slot}`, sev: "warn", group: `Inventory — ${bag.region}`,
            title: `${itemName(it.id)} (slot ${it.slot}) has a count of ${it.qty}`,
            detail: `The count field only holds 0-${ITEM_QTY_MAX}; it will be written as ${ITEM_QTY_MAX}.`,
            where: { sub: "items", search: String(it.slot) },
            fix: { label: `Set to ${ITEM_QTY_MAX}`, ops: [{ kind: "inv", slot: it.slot, qty: ITEM_QTY_MAX }] } });
        }
        if (it.id > ITEM_ID_MAX || (opts.item && !item(it.id))) {
          add({ id: `inv-unknown-${it.slot}`, sev: "warn", group: `Inventory — ${bag.region}`,
            title: `Slot ${it.slot} holds item id 0x${it.id.toString(16).toUpperCase()}, which is not in the item table`,
            detail: "Past the end of the game's item list.",
            where: { sub: "items", search: String(it.slot) },
            fix: { label: "Empty the slot", ops: [{ kind: "inv", slot: it.slot, id: 0 }] } });
        }
      });
      if (bag.gaps.length) {
        // The game keeps each bag packed from its base and appends pickups at the tail, so an
        // empty slot with items after it is not a shape it produces — and the run can be
        // treated as ending at the gap the next time it repacks.
        add({ id: `bag-gap-${bi}`, sev: "warn", group: `Inventory — ${bag.region}`,
          title: `${bag.region} has ${bag.gaps.length} empty slot${bag.gaps.length === 1 ? "" : "s"} before its last item`,
          detail: "The game keeps each bag packed from the start and adds pickups at the end. Items " +
            "sitting after a gap can be dropped the next time it repacks the list.",
          where: { sub: "items", search: "" },
          fix: { label: "Compact the bag", ops: compactOps(bag) } });
      }
      if (bag.used >= bag.capacity) {
        add({ id: `bag-full-${bi}`, sev: "info", group: `Inventory — ${bag.region}`,
          title: `${bag.region} is full (${bag.used}/${bag.capacity})`,
          detail: "Nothing more can be added to this bag until something leaves it.",
          where: { sub: "items", search: "" } });
      }
      // Adding to a pre-merge carried bag whose chapter has not started: the game stocks that
      // bag when the chapter begins, overwriting whatever is in it.
      const carried = !eff.merged && ["Hugo", "Chris", "Geddoe", "Thomas"].includes(bag.region);
      const stagedAdds = bag.items.filter((it) => it.staged).length;
      if (carried && bag.wasEmpty && stagedAdds) {
        add({ id: `bag-unstarted-${bi}`, sev: "warn", group: `Inventory — ${bag.region}`,
          title: `${bag.region}'s bag was empty before your edit — their chapter has not started`,
          detail: `The game stocks that bag when the chapter begins and overwrites what is there, so the ` +
            `${stagedAdds} item${stagedAdds === 1 ? "" : "s"} you added would be thrown away. Add them after ` +
            `you have played as ${bag.region}.`,
          where: { sub: "items", search: "" } });
      }
    });

    // --- global --------------------------------------------------------------
    if (eff.gold > U32_MAX) {
      add({ id: "gold-clamp", sev: "warn", group: "Save file",
        title: `Gold is ${eff.gold} — past the field's 32-bit range`,
        detail: `It will be written as ${U32_MAX}.`,
        fix: { label: `Set to ${U32_MAX}`, ops: [{ kind: "gold", value: U32_MAX }] } });
    }

    out.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev]);
    return out;
  }

  // Rewrite a bag so its items sit contiguously from its first slot, clearing the tail.
  // Only the slots that actually change would be staged by the caller; emitting the whole
  // bag keeps this simple and the review list still shows only real differences.
  function compactOps(bag) {
    const ops = [];
    bag.items.forEach((it, k) => {
      const slot = bag.firstSlot + k;
      if (slot === it.slot) return;
      ops.push({ kind: "inv", slot, id: it.id, qty: it.stackable ? Math.max(1, it.qty) : 0 });
    });
    // clear whatever the moved items vacated
    const kept = new Set(bag.items.map((_, k) => bag.firstSlot + k));
    bag.items.forEach((it) => { if (!kept.has(it.slot)) ops.push({ kind: "inv", slot: it.slot, id: 0 }); });
    return ops;
  }

  function counts(findings) {
    const c = { error: 0, warn: 0, info: 0 };
    findings.forEach((f) => { c[f.sev] = (c[f.sev] || 0) + 1; });
    return c;
  }

  const api = { ITEM_QTY_MAX, ITEM_ID_MAX, CAPS, ENGINE_CAPS, FIELD_LABEL, SLOT_CATS, SLOT_LABEL, RANK_LABELS,
    itemStackable, itemCategory, engineQty, rankLabel, rankValue,
    effective, audit, compactOps, counts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.HealthCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
