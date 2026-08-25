// Pure guide-reference lookups shared by the save editor (app.js) and the Node tests.
// No DOM / no Pyodide — just the name join and the record lookups, so the mapping that
// actually decides whether a note appears can be unit-tested against the committed JSON.
//
// The three files this reads (s3_skill_caps / s3_growth_ref / s3_rune_slots, built by
// Editor/build_guide_refs.py from the Suikosource guides) are keyed by the ISO's **list1**
// character names. A save's characters instead carry **s3save.ROSTER** names. Those agree
// for most of the roster; ALIAS covers the ones that differ by punctuation only. Everything
// that still misses simply renders no note — per "correct-or-blank, never wrong":
//
//   • support characters (Apple, Luce, Caesar, …) live in list3 and don't fight, so the
//     combat guides have no entry for them at all — a note there would be meaningless;
//   • a handful of fighters (Guillaume, Viki, Sanae Y) are absent from the guides themselves.
//
// Every accessor returns plain data (never HTML) — app.js does the escaping and rendering.
(function (root) {
  // roster name -> guide (list1) key, for the few that differ by punctuation/disambiguation.
  const ALIAS = {
    "Viki": "Viki (Old)",
    "Sanae Y": "Sanae Y.",
  };

  // Guide stat keys. The save's stat block also has PDF, which the growth guide doesn't
  // track — it just gets no note.
  const GROWTH_STATS = ["PWR", "SKL", "MAG", "REP", "MDF", "SPD", "LUK", "HP"];
  const SLOT_KEYS = { headRune: "head", rightRune: "right", leftRune: "left" };

  const key = (charName) => ALIAS[charName] || charName;

  // A `guide` is { caps, growth, slots } — the three parsed JSON files (any may be {}).
  const tbl = (guide, which, charName) => (guide && guide[which] && guide[which][key(charName)]) || null;

  // null            -> this character isn't in the skills guide (no note)
  // { grade: null } -> in the guide, but this skill isn't on their list ("can't learn")
  // { grade: "B+" } -> capped at that grade
  function skillCap(guide, charName, skillId) {
    const c = tbl(guide, "caps", charName);
    if (!c || !skillId) return null;
    return { grade: c[String(skillId)] || null };
  }

  // { rate, start, end } for one stat, or null when unknown.
  function growth(guide, charName, stat) {
    const g = tbl(guide, "growth", charName);
    return (g && g[stat]) || null;
  }

  // { state: "opens", lv } | { state: "rune", rune } | { state: "none" } | null.
  // slotKey is the save editor's equip key ("headRune" | "rightRune" | "leftRune").
  function runeSlot(guide, charName, slotKey) {
    const r = tbl(guide, "slots", charName), k = SLOT_KEYS[slotKey];
    return (k && r && r[k]) || null;
  }

  // The level/weapon level the character joins at, from the guide's initial-setup table.
  // { lv, wlv } (strings, as printed in the guide) or null.
  function initial(guide, charName) {
    const r = tbl(guide, "slots", charName);
    if (!r || !r.lv) return null;
    return { lv: r.lv, wlv: r.wlv || "" };
  }

  // How many roster names resolve in each table — the regression guard for the name join
  // (a rename on either side silently drops notes, so tests assert these counts).
  function coverage(guide, roster) {
    const n = (which) => roster.filter((nm) => !!tbl(guide, which, nm)).length;
    return { caps: n("caps"), growth: n("growth"), slots: n("slots"), roster: roster.length };
  }

  const api = { ALIAS, GROWTH_STATS, SLOT_KEYS, key, skillCap, growth, runeSlot, initial, coverage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.GuideCore = api;                                                        // browser global
})(typeof self !== "undefined" ? self : globalThis);
