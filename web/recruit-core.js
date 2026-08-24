// Pure recruitment logic shared by the browser (app.js) and the Node tests.
// No DOM / no Pyodide — just the staging math for bulk team assignment, so it can be
// unit-tested directly (the save-editor UI itself needs Pyodide, which headless CI can't load).
//
// A "character" is { rosterIndex, recruited, recruiter }. RECRUIT is the pending-edits map
// { rosterIndex: {recruited, recruiter?} } that Apply forwards to s3save.write_save_edits.
// team: "" = shared/story, or a protagonist name ("Hugo"|"Chris"|"Geddoe"|"Thomas").
(function (root) {
  const RECRUITERS = ["Hugo", "Chris", "Geddoe", "Thomas"];

  // Team membership is a BITMASK in the save (bits 2..5), so a character can be on several
  // protagonists' pre-merge teams at once. We model it as an array of team names (canonical
  // order, [] = shared/story).
  const norm = (arr) => RECRUITERS.filter((t) => (arr || []).includes(t));
  const sameTeams = (a, b) => { a = norm(a); b = norm(b); return a.length === b.length && a.every((t, i) => t === b[i]); };
  const loadedTeams = (c) => norm(c.recruiters || (c.recruiter ? [c.recruiter] : []));

  // Effective (staged-over-loaded) recruit state for a character.
  function recState(c, RECRUIT) {
    const st = RECRUIT[c.rosterIndex] || {};
    return {
      recruited: "recruited" in st ? st.recruited : !!c.recruited,
      teams: "teams" in st ? norm(st.teams) : loadedTeams(c),
    };
  }

  // Stage a recruit change, pruning entries that match the loaded save so the diff stays honest.
  // teams === undefined keeps the current teams; [] = shared; otherwise an array of protagonists.
  function setRecruit(c, recruited, teams, RECRUIT) {
    const ri = c.rosterIndex, cur = recState(c, RECRUIT);
    const finalTeams = recruited ? (teams === undefined ? cur.teams : norm(teams)) : [];
    if (recruited === !!c.recruited && (!recruited || sameTeams(finalTeams, loadedTeams(c)))) {
      delete RECRUIT[ri];
      return;
    }
    RECRUIT[ri] = recruited ? { recruited: true, teams: finalTeams } : { recruited: false };
  }

  // Apply a canonical preset: which === "ALL" assigns every character to its canonical team
  // (unlisted -> shared); otherwise recruits only that protagonist's canonical members.
  function applyCanonical(chars, which, teamsMap, RECRUIT) {
    chars.forEach((c) => {
      const t = teamsMap[c.name];
      if (which === "ALL") setRecruit(c, true, t ? [t] : [], RECRUIT);
      else if (t === which) setRecruit(c, true, [which], RECRUIT);
    });
  }

  // per-team recruited counts over a roster (staged state). A character on multiple teams
  // counts toward each; `total` is the distinct recruited count.
  function teamCounts(chars, RECRUIT) {
    const counts = { "": 0, Hugo: 0, Chris: 0, Geddoe: 0, Thomas: 0 };
    let total = 0;
    chars.forEach((c) => {
      const st = recState(c, RECRUIT);
      if (!st.recruited) return;
      total++;
      if (!st.teams.length) counts[""]++;
      else st.teams.forEach((t) => { if (t in counts) counts[t]++; });
    });
    return { total, counts };
  }

  // Dry-run a staging action and return the list of characters it would actually change, as
  // {rosterIndex, name, kind: "recruit"|"unrecruit"|"move", before, after}. applyFn(map) stages
  // into the map it's given; we run it on a CLONE so nothing is committed until the caller acts.
  // Powers the "show me what this does before I apply it" confirm step for bulk/canonical actions.
  function previewChanges(chars, RECRUIT, applyFn) {
    const before = {};
    chars.forEach((c) => { before[c.rosterIndex] = recState(c, RECRUIT); });
    const clone = {};
    for (const k in RECRUIT) clone[k] = Object.assign({}, RECRUIT[k]);
    applyFn(clone);
    const out = [];
    chars.forEach((c) => {
      const b = before[c.rosterIndex], a = recState(c, clone);
      if (a.recruited === b.recruited && sameTeams(a.teams, b.teams)) return;
      const kind = a.recruited && !b.recruited ? "recruit" : !a.recruited && b.recruited ? "unrecruit" : "move";
      out.push({ rosterIndex: c.rosterIndex, name: c.name, kind, before: b, after: a });
    });
    return out;
  }

  const api = { RECRUITERS, recState, setRecruit, applyCanonical, teamCounts, previewChanges };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RecruitCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
