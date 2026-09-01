// Unit tests for the real health-core.js (loaded as-is) — the save health check.
//
// The audit is the part that tells a user their save is fine, so a false negative is worse
// than a missing feature: it blesses a broken file. And a false positive trains people to
// ignore the panel. So every rule is driven both ways here — a clean save must produce
// nothing at all, and each defect must produce exactly its own finding.
//
// The other property under test is the fix loop: a finding's `fix.ops`, staged back through
// the same edit maps the UI uses and re-audited, must make that finding go away. That is
// what makes the Fix buttons trustworthy without a browser in the loop.
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const H = require("../health-core.js");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let fails = 0;
const check = (n, c, extra) => { console.log(`  ${c ? "✓" : "✗"} ${n}${!c && extra ? " — " + extra : ""}`); if (!c) fails++; };
const ids = (fs) => fs.map((f) => f.id);
const has = (fs, re) => fs.some((f) => re.test(f.id));
const one = (fs, re) => fs.filter((f) => re.test(f.id));

// ---- fixtures ---------------------------------------------------------------
// The shape s3save.decode_save returns, trimmed to the fields the audit reads.
const STATS = { PWR: 100, SKL: 100, MAG: 100, REP: 100, MDF: 100, SPD: 100, LUK: 100 };
const EMPTY_EQUIP = { headRune: 0, rightRune: 0, leftRune: 0, helm: 0, armor: 0,
                      shield: 0, boots: 0, gloves: 0, accessory: 0 };
const mkChar = (ri, name, over) => Object.assign({
  rosterIndex: ri, name, id: ri + 1, idExpected: ri + 1,
  level: 30, weaponLv: 5, curHP: 200, maxHP: 200, expToNext: 100,
  stats: Object.assign({}, STATS), equip: Object.assign({}, EMPTY_EQUIP),
  skills: [{ slot: 0, id: 0, rank: 0 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }],
  recruited: true, recruitWord: 0x1d, recruiter: "", recruiters: [], hasData: true,
}, over || {});

const mkItem = (slot, id, qty, stackable) => ({
  slot, addr: 0, id, qty, category: H.itemCategory(id), stackable, displayed: false,
  rawId: id, unknownId: false, state: [0, 0, 0, 0],
});

const mkBag = (region, firstSlot, items, capacity) => ({
  region, base: 0, firstSlot, capacity: capacity || 30, used: items.length,
  freeSlots: [], appendSlots: [], items,
});

const mkSave = (over) => Object.assign({
  global: { gold: 1000, storyPhase: 6, merged: true, partyLeader: 1, playtime: "1:00" },
  names: [], carryover: {}, party: [1, 2, 0, 0, 0, 0], partyFormation: [1, 2, 0, 0, 0, 0],
  characters: [mkChar(0, "Hugo"), mkChar(1, "Chris")],
  inventory: [mkBag("Party bag", 0, [mkItem(0, 0x01, 3, true), mkItem(1, 0x0a0, 0, false)])],
  statNames: Object.keys(STATS), problems: [], notes: [],
}, over || {});

// A small item table: 0x001 a consumable, 0x0A0 a rune, 0x0C0 a helm, 0x0D0 body armor.
const ITEMS = { 0x001: { name: "Medicine", cat: "Recovery" }, 0x0a0: { name: "Fury Rune", cat: "Runes" },
                0x0c0: { name: "Iron Helm", cat: "Headgear" }, 0x0d0: { name: "Chain Mail", cat: "Armor" } };
// Party ids are their own space (s3save.PARTY_IDS), so the audit can only reach a party
// member's character block through partyRoster. Read the real table out of s3save.py rather
// than restating it: a drift there should fail here, not silently mislabel party slots.
const PARTY_IDS = (() => {
  const py = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
  const m = py.match(/^PARTY_IDS = \[([\s\S]*?)\]/m);
  return m ? m[1].split(",").map((t) => t.trim()).filter(Boolean).map(Number) : [];
})();
const PARTY_ROSTER = Object.fromEntries(PARTY_IDS.map((pid, ri) => [pid, ri]));
const OPTS = {
  item: (id) => ITEMS[id] || null,
  skillName: (id) => "Skill" + id,
  charName: (id) => ({ 1: "Hugo", 2: "Chris", 3: "Geddoe" })[id] || "id " + id,
  partyRoster: (id) => (id in PARTY_ROSTER ? PARTY_ROSTER[id] : null),
};
// Guide stubs: Hugo caps Skill10 at B+ and cannot learn Skill40; his left rune opens at Lv 35.
const GUIDE_OPTS = Object.assign({}, OPTS, {
  skillCap: (nm, sid) => (nm === "Hugo" ? { grade: sid === 10 ? "B+" : null } : null),
  runeSlot: (nm, key) => (nm === "Hugo" && key === "leftRune" ? { state: "opens", lv: 35 } : null),
});

const audit = (save, staged, opts) => H.audit(save, staged || {}, opts || OPTS);

// Stage a finding's fix the way app.js applyFixOps does, then re-audit.
function stageFix(staged, ops) {
  const ent = (ri) => (staged.edits[ri] = staged.edits[ri] || {});
  ops.forEach((op) => {
    if (op.kind === "charField") ent(op.ri)[op.field] = op.value;
    else if (op.kind === "charStat") { const e = ent(op.ri); (e.stats = e.stats || {})[op.stat] = op.value; }
    else if (op.kind === "charEquip") { const e = ent(op.ri); (e.equip = e.equip || {})[op.slot] = op.value; }
    else if (op.kind === "charSkill") {
      const e = ent(op.ri); e.skills = e.skills || {};
      const sk = (e.skills[op.slot] = e.skills[op.slot] || {});
      if ("id" in op) sk.id = op.id;
      if ("rank" in op) sk.rank = op.rank;
    } else if (op.kind === "party") staged.party[op.slot] = op.value;
    else if (op.kind === "recruit") staged.recruit[op.ri] = { recruited: op.recruited, teams: [] };
    else if (op.kind === "inv") {
      const e = (staged.inv[op.slot] = staged.inv[op.slot] || {});
      if ("id" in op) e.id = op.id;
      if ("qty" in op) e.qty = op.qty;
    } else if (op.kind === "gold") staged.gold = op.value;
  });
  return staged;
}
const blank = () => ({ edits: {}, inv: {}, party: {}, recruit: {}, gold: null });
// The property that makes a Fix button trustworthy: stage it, re-audit, the finding is gone.
function fixClears(save, finding, opts) {
  const staged = stageFix(blank(), finding.fix.ops);
  return !audit(save, staged, opts).some((f) => f.id === finding.id);
}

// ---- a clean save produces nothing ------------------------------------------
console.log("clean save:");
{
  const f = audit(mkSave());
  check("no findings on a consistent save", f.length === 0, ids(f).join(", "));
}

// ---- party ------------------------------------------------------------------
console.log("party:");
{
  const s = mkSave({ characters: [mkChar(0, "Hugo"), mkChar(1, "Chris", { recruited: false, recruitWord: 0 })] });
  const f = audit(s);
  const hit = one(f, /^party-unrecruited-1$/)[0];
  check("a party member who isn't recruited is an error", !!hit && hit.sev === "error");
  check("it names the character", !!hit && /Chris/.test(hit.title));
  check("its fix recruits them, and clears the finding", !!hit && fixClears(s, hit));
}
{
  const s = mkSave({ party: [1, 2, 1, 0, 0, 0] });
  const hit = one(audit(s), /^party-dup-2$/)[0];
  check("the same character in two party slots is flagged", !!hit && hit.sev === "warn");
  check("its fix clears the later slot", !!hit && fixClears(s, hit));
}
{
  const f = audit(mkSave({ party: [0, 0, 0, 0, 0, 0] }));
  check("an empty party is a note, not a problem", has(f, /^party-empty$/) &&
    one(f, /^party-empty$/)[0].sev === "info");
}
{ // A leader who is not in the party is a SOFTLOCK, not a curiosity: scene actors are built
  // from the party list and the engine finds "the player" by matching the leader's character
  // id against them, so a leader with no actor record freezes any scene that needs the player
  // to act. Confirmed in play — Koroku as leader with Hugo in the party hangs Karaya Village
  // at the protagonist's line. The severity and the fix are what make that recoverable.
  const s = mkSave({ party: [1, 0, 0, 0, 0, 0],
                     global: { gold: 10, storyPhase: 6, merged: true, partyLeader: 54 },
                     characters: [mkChar(0, "Hugo")] });
  const hit = one(audit(s), /^party-leader-absent$/)[0];
  check("a leader who isn't in the party is an ERROR, not a note", !!hit && hit.sev === "error");
  check("...and says it freezes scenes", !!hit && /freezes/.test(hit.detail));
  check("...and offers to put the leader in slot 1", !!hit && !!hit.fix &&
    hit.fix.ops[0].kind === "party" && hit.fix.ops[0].slot === 0 && hit.fix.ops[0].value === 54);
  // and applying that fix must clear the finding
  const after = audit(s, { party: { 0: 54 } });
  check("...and applying it clears the finding", !has(after, /^party-leader-absent$/));
}
{ // The formation table is the half of a party edit that fails silently: the game builds the
  // members it lists, so a party list longer than the formation shows empty slots in-game.
  const s = mkSave({ party: [1, 2, 3, 0, 0, 0], partyFormation: [1, 2, 0, 0, 0, 0],
                     characters: [mkChar(0, "Hugo"), mkChar(1, "Chris"), mkChar(2, "Geddoe")] });
  const hit = one(audit(s), /^party-formation$/)[0];
  check("a formation shorter than the party is an error", !!hit && hit.sev === "error");
  check("it counts both sides", !!hit && /lists 2 members.*holds 3/.test(hit.title), hit && hit.title);
  check("its fix clears the finding", !!hit && fixClears(s, hit));
}
{ // ...and the shapes the game itself writes are all fine: dense, reordered, and spread.
  const ok = (form, party) => !has(audit(mkSave({ party, partyFormation: form,
    characters: [mkChar(0, "Hugo"), mkChar(1, "Chris"), mkChar(2, "Geddoe")] })), /^party-formation$/);
  check("a dense formation is clean", ok([1, 2, 3, 0, 0, 0], [1, 2, 3, 0, 0, 0]));
  check("a reordered formation is clean", ok([1, 3, 2, 0, 0, 0], [1, 2, 3, 0, 0, 0]));
  check("a spread formation is clean", ok([1, 0, 2, 0, 3, 0], [1, 2, 3, 0, 0, 0]));
  check("an empty party with an empty formation is clean", ok([0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]));
}
{ // A staged party edit rebuilds the table at write time, so it must not be pre-flagged.
  const s = mkSave({ party: [1, 2, 0, 0, 0, 0], partyFormation: [1, 2, 0, 0, 0, 0] });
  const staged = Object.assign(blank(), { party: { 2: 3 } });
  check("staging a third member does not flag the formation it is about to rebuild",
    !has(audit(s, staged), /^party-formation$/));
}
{ // a party id with no roster record (guest/NPC) must not be reported as unrecruited
  const f = audit(mkSave({ party: [1, 2, 900, 0, 0, 0] }));
  check("a guest/NPC party id is not called unrecruited", !has(f, /^party-unrecruited/));
}

// ---- characters -------------------------------------------------------------
console.log("characters:");
{
  const s = mkSave({ characters: [mkChar(0, "Hugo", { curHP: 400, maxHP: 200 }), mkChar(1, "Chris")] });
  const hit = one(audit(s), /^hp-over-0$/)[0];
  check("current HP above max HP is an error", !!hit && hit.sev === "error");
  check("its fix caps current HP at max, clearing it", !!hit && fixClears(s, hit));
}
{
  const f = audit(mkSave({ characters: [mkChar(0, "Hugo", { curHP: 0 }), mkChar(1, "Chris")] }));
  check("0 current HP is a note with a heal fix", has(f, /^hp-zero-0$/) &&
    one(f, /^hp-zero-0$/)[0].fix.ops[0].value === 200);
}
{
  const f = audit(mkSave({ characters: [mkChar(0, "Hugo", { maxHP: 0 }), mkChar(1, "Chris")] }));
  check("0 max HP on a recruited character is a warning", has(f, /^maxhp-zero-0$/));
}
{
  const s = mkSave({ characters: [mkChar(0, "Hugo", { level: 0, hasData: false, stats: { PWR: 0, SKL: 0, MAG: 0, REP: 0, MDF: 0, SPD: 0, LUK: 0 }, curHP: 0, maxHP: 0 }), mkChar(1, "Chris")] });
  const hit = one(audit(s), /^empty-record-0$/)[0];
  check("recruited with an uninitialized record is flagged", !!hit && hit.sev === "warn");
  check("its fix un-recruits them", !!hit && fixClears(s, hit));
}
{ // values the ENGINE clamps: the finding must state the value that will actually land
  const s = mkSave({ characters: [mkChar(0, "Hugo", { level: 120, weaponLv: 40, expToNext: 5000 }), mkChar(1, "Chris")] });
  const f = audit(s);
  check("level over 99 is flagged with the written value", has(f, /^clamp-level-0$/) &&
    /written as 99/.test(one(f, /^clamp-level-0$/)[0].detail));
  check("…using the editor's field label", /^Level is 120/.test(one(f, /^clamp-level-0$/)[0].title),
    one(f, /^clamp-level-0$/)[0].title);
  check("weapon level over 16 is flagged", has(f, /^clamp-weaponLv-0$/));
  check("EXP over 999 is flagged", has(f, /^clamp-expToNext-0$/));
  check("each clamp fix clears its finding", one(f, /^clamp-/).every((x) => fixClears(s, x)));
}
{ // a stat inside the 16-bit field is NOT flagged — the engine does not clamp it to 999
  const f = audit(mkSave({ characters: [mkChar(0, "Hugo", { stats: Object.assign({}, STATS, { PWR: 5000 }) }), mkChar(1, "Chris")] }));
  check("a high-but-storable stat is left alone", !has(f, /^clamp-stat/));
}
{
  const f = audit(mkSave({ characters: [mkChar(0, "Hugo", { stats: Object.assign({}, STATS, { PWR: 70000 }) }), mkChar(1, "Chris")] }));
  check("a stat past the 16-bit field is flagged", has(f, /^clamp-stat-PWR-0$/));
}

console.log("skills:");
{
  const mk = (skills) => mkSave({ characters: [mkChar(0, "Hugo", { skills }), mkChar(1, "Chris")] });
  {
    const s = mk([{ slot: 0, id: 10, rank: 4 }, { slot: 1, id: 10, rank: 3 }, { slot: 2, id: 0, rank: 0 }]);
    const hit = one(audit(s), /^skill-dup-0-1$/)[0];
    check("the same skill in two slots is flagged", !!hit && hit.sev === "warn");
    check("its fix clears the later slot", !!hit && fixClears(s, hit));
  }
  {
    const s = mk([{ slot: 0, id: 10, rank: 0 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }]);
    const hit = one(audit(s), /^skill-norank-0-0$/)[0];
    check("a skill with no rank grade is a note", !!hit && hit.sev === "info");
    check("its fix gives it rank E", !!hit && fixClears(s, hit));
  }
  {
    const s = mk([{ slot: 0, id: 0, rank: 5 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }]);
    const hit = one(audit(s), /^skill-norankskill-0-0$/)[0];
    check("a rank on an empty slot is a warning", !!hit && hit.sev === "warn");
    check("its fix clears the rank", !!hit && fixClears(s, hit));
  }
}
console.log("skills vs the guide:");
{
  const mk = (skills) => mkSave({ characters: [mkChar(0, "Hugo", { skills }), mkChar(1, "Chris")] });
  {
    const s = mk([{ slot: 0, id: 10, rank: 8 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }]);
    const hit = one(audit(s, {}, GUIDE_OPTS), /^skill-overcap-0-0$/)[0];
    check("a rank above the guide's cap is a note", !!hit && hit.sev === "info" && /B\+/.test(hit.title));
    check("its fix drops it to the cap", !!hit &&
      !audit(s, stageFix(blank(), hit.fix.ops), GUIDE_OPTS).some((f) => f.id === hit.id));
  }
  {
    const s = mk([{ slot: 0, id: 40, rank: 3 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }]);
    check("a skill the guide says they can't learn is flagged",
      has(audit(s, {}, GUIDE_OPTS), /^skill-cantlearn-0-0$/));
  }
  {  // without the guide the same save must produce neither finding (correct or absent)
    const s = mk([{ slot: 0, id: 40, rank: 8 }, { slot: 1, id: 0, rank: 0 }, { slot: 2, id: 0, rank: 0 }]);
    check("no guide loaded → no guide-backed findings", !has(audit(s), /^skill-(overcap|cantlearn)/));
  }
}

console.log("equipment:");
{
  const eq = (over) => mkSave({ characters: [mkChar(0, "Hugo", { equip: Object.assign({}, EMPTY_EQUIP, over) }), mkChar(1, "Chris")] });
  check("a rune in a rune slot is fine", !has(audit(eq({ headRune: 0x0a0 })), /^equip-/));
  check("a helm in the helm slot is fine", !has(audit(eq({ helm: 0x0c0 })), /^equip-/));
  {
    const s = eq({ helm: 0x0d0 });         // body armor in the helm slot
    const hit = one(audit(s), /^equip-cat-0-helm$/)[0];
    check("gear in the wrong slot is flagged", !!hit && hit.sev === "warn" && /Chain Mail/.test(hit.title));
    check("its fix empties the slot", !!hit && fixClears(s, hit));
  }
  {
    const s = eq({ armor: 0x2ee });        // not in the item table
    const hit = one(audit(s), /^equip-unknown-0-armor$/)[0];
    check("an equipped id that isn't in the item table is flagged", !!hit);
    check("its fix empties the slot", !!hit && fixClears(s, hit));
  }
  {
    const s = mkSave({ characters: [mkChar(0, "Hugo", { level: 20, equip: Object.assign({}, EMPTY_EQUIP, { leftRune: 0x0a0 }) }), mkChar(1, "Chris")] });
    check("a rune in a slot the guide says is still locked is a note",
      has(audit(s, {}, GUIDE_OPTS), /^rune-locked-0-leftRune$/));
    const s2 = mkSave({ characters: [mkChar(0, "Hugo", { level: 40, equip: Object.assign({}, EMPTY_EQUIP, { leftRune: 0x0a0 }) }), mkChar(1, "Chris")] });
    check("…and not once the character is past that level", !has(audit(s2, {}, GUIDE_OPTS), /^rune-locked/));
  }
}

// ---- inventory --------------------------------------------------------------
console.log("inventory:");
{
  // The issue-#5 shape: a one-per-slot rune carrying a count. The game holds copies as
  // separate slots; an entry with a count frees the whole slot when one copy leaves.
  const s = mkSave({ inventory: [mkBag("Party bag", 0, [mkItem(0, 0x0a0, 1, false)])] });
  const hit = one(audit(s), /^inv-count-0$/)[0];
  check("a one-per-slot item carrying a count is flagged", !!hit && hit.sev === "warn");
  check("its fix clears the count", !!hit && fixClears(s, hit));
}
{
  const s = mkSave({ inventory: [mkBag("Party bag", 0, [mkItem(0, 0x001, 40, true)])] });
  const hit = one(audit(s), /^inv-qty-0$/)[0];
  check("a count past the 0-9 field is flagged with the written value",
    !!hit && /written as 9/.test(hit.detail));
  check("its fix sets it to 9", !!hit && fixClears(s, hit));
}
{
  const s = mkSave({ inventory: [mkBag("Party bag", 0, [mkItem(0, 0x3ff, 0, false)])] });
  const hit = one(audit(s), /^inv-unknown-0$/)[0];
  check("an item id past the table is flagged", !!hit);
  check("its fix empties the slot", !!hit && fixClears(s, hit));
}
{
  // Bags are packed from the base and appended at the tail; a gap with items after it is
  // not a shape the game writes, and the tail can be lost when it repacks.
  const s = mkSave({ inventory: [mkBag("Party bag", 0,
    [mkItem(0, 0x001, 3, true), mkItem(3, 0x0a0, 0, false), mkItem(5, 0x0c0, 0, false)])] });
  const hit = one(audit(s), /^bag-gap-0$/)[0];
  check("items sitting after a gap are flagged", !!hit && hit.sev === "warn" && /3 empty slots/.test(hit.title));
  const staged = stageFix(blank(), hit.fix.ops);
  const after = H.effective(s, staged).bags[0];
  check("Compact moves them to slots 0,1,2", after.items.map((i) => i.slot).join(",") === "0,1,2",
    after.items.map((i) => i.slot).join(","));
  check("…keeping the same items in order", after.items.map((i) => i.id).join(",") === [0x001, 0x0a0, 0x0c0].join(","));
  check("…giving the rune no count", after.items[1].qty === 0);
  check("…and the finding is gone", !audit(s, staged).some((f) => f.id === hit.id));
}
{
  const many = Array.from({ length: 30 }, (_, k) => mkItem(k, 0x001, 1, true));
  check("a full bag is a note", has(audit(mkSave({ inventory: [mkBag("Party bag", 0, many)] })), /^bag-full-0$/));
}
{
  // Adding to a pre-merge carried bag whose chapter hasn't started: the game restocks that
  // bag at the chapter start and overwrites whatever was put there.
  const s = mkSave({ global: { gold: 10, storyPhase: 2, merged: false, partyLeader: 1 },
    inventory: [mkBag("Hugo", 0, []), mkBag("Chris", 30, [mkItem(30, 0x001, 1, true)])] });
  check("no warning before you add anything", !has(audit(s), /^bag-unstarted/));
  const staged = Object.assign(blank(), { inv: { 0: { id: 0x001, qty: 1 } } });
  check("adding to the empty pre-merge bag warns it will be overwritten",
    has(audit(s, staged), /^bag-unstarted-0$/));
  check("…and adding to a bag that already has items does not",
    !has(audit(s, Object.assign(blank(), { inv: { 31: { id: 0x001, qty: 1 } } })), /^bag-unstarted-1$/));
}

// ---- staged edits are audited too -------------------------------------------
console.log("pending edits:");
{
  const s = mkSave();
  check("a clean save with no edits is clean", audit(s).length === 0);
  const staged = Object.assign(blank(), { edits: { 0: { maxHP: 50 } } });
  check("staging max HP below current HP raises the error before it is written",
    has(audit(s, staged), /^hp-over-0$/));
  const staged2 = Object.assign(blank(), { party: { 2: 3 } });
  check("staging an unknown character into the party is audited",
    audit(s, staged2).length === 0);          // id 3 has no roster record → guest, not an error
  const staged3 = Object.assign(blank(), { recruit: { 1: { recruited: false, teams: [] } } });
  check("un-recruiting someone who is in the party raises the error",
    has(audit(s, staged3), /^party-unrecruited-1$/));
}

// ---- the engine's own decode checks are folded in ---------------------------
console.log("decode checks:");
{
  const f = audit(mkSave({ problems: ["record id mismatch at roster 7"], notes: ["title says Lv54"] }));
  check("decode problems become errors", has(f, /^decode-problem-0$/) &&
    one(f, /^decode-problem-0$/)[0].sev === "error");
  check("decode notes become notes", has(f, /^decode-note-0$/) &&
    one(f, /^decode-note-0$/)[0].sev === "info");
  check("errors sort before notes", f[0].sev === "error");
}

// ---- the shared item rules stay in lockstep with s3save.py ------------------
// health-core owns the copy the inventory UI and the audit both use, so a change to the
// engine's bands must not leave the browser classifying items differently.
console.log("item rules vs s3save.py:");
{
  const py = fs.readFileSync(path.join(REPO, "Editor", "s3save.py"), "utf8");
  const qty = /ITEM_QTY_MAX\s*=\s*(\d+)/.exec(py);
  check(`ITEM_QTY_MAX ${H.ITEM_QTY_MAX} matches s3save.py`, qty && +qty[1] === H.ITEM_QTY_MAX);
  const idmax = /ITEM_ID_MAX\s*=\s*(0x[0-9A-Fa-f]+)/.exec(py);
  check(`ITEM_ID_MAX matches s3save.py`, idmax && Number(idmax[1]) === H.ITEM_ID_MAX);
  // bands: consumable < 0xA0, equipment 0xA0-0x1FF, key 0x200+, trade goods 0x1F0-0x1FF stack
  // 0x09E/0x09F are the Jizo/Incense exceptions, so the band sample stops at 0x09D.
  const band = [[0x001, true, "consumable"], [0x09d, true, "consumable"], [0x0a0, false, "equipment"],
                [0x1ef, false, "equipment"], [0x1f0, true, "equipment"], [0x1ff, true, "equipment"],
                [0x200, false, "key"], [0x264, false, "key"]];
  check("stackable bands match the documented ones",
    band.every(([id, st]) => H.itemStackable(id) === st));
  check("categories match the documented ones",
    band.every(([id, , cat]) => H.itemCategory(id) === cat));
  // the nine exceptions the corpus proved
  const oneper = [...Array(7)].map((_, i) => 0x0b + i).concat([0x9e, 0x9f]);
  check("the stat stones / Jizo / Incense exceptions are one-per-slot",
    oneper.every((id) => H.itemStackable(id) === false));
  check("Grape (0x202) stacks despite being a key item", H.itemStackable(0x202) === true);
  for (const set of [["ITEM_ONE_PER_SLOT_EXC", oneper], ["ITEM_STACKABLE_EXC", [0x202]]]) {
    const m = new RegExp(set[0] + "\\s*=\\s*([^\\n]+)").exec(py);
    check(`${set[0]} still present in s3save.py`, !!m);
  }
}

console.log(fails ? `\nFAILED (${fails})` : "\nAll health-core checks passed.");
process.exit(fails ? 1 : 0);
