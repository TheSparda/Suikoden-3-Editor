// Pure recruitment logic shared by the browser (app.js) and the Node tests.
// No DOM / no Pyodide — just the staging math for bulk team assignment, so it can be
// unit-tested directly (the save-editor UI itself needs Pyodide, which headless CI can't load).
//
// A "character" is { rosterIndex, recruited, recruiter }. RECRUIT is the pending-edits map
// { rosterIndex: {recruited, recruiter?} } that Apply forwards to s3save.write_save_edits.
// team: "" = shared/story, or a protagonist name ("Hugo"|"Chris"|"Geddoe"|"Thomas").
(function (root) {
  const RECRUITERS = ["Hugo", "Chris", "Geddoe", "Thomas"];

  // Effective (staged-over-loaded) recruit state for a character.
  function recState(c, RECRUIT) {
    const st = RECRUIT[c.rosterIndex] || {};
    return {
      recruited: "recruited" in st ? st.recruited : !!c.recruited,
      team: "recruiter" in st ? st.recruiter : (c.recruiter || ""),
    };
  }

  // Stage a recruit change, pruning entries that match the loaded save so the diff stays honest.
  // team === undefined keeps the current team; "" = shared; otherwise a protagonist name.
  function setRecruit(c, recruited, team, RECRUIT) {
    const ri = c.rosterIndex, cur = recState(c, RECRUIT);
    const finalTeam = recruited ? (team === undefined ? cur.team : team) : "";
    if (recruited === !!c.recruited && (!recruited || finalTeam === (c.recruiter || ""))) {
      delete RECRUIT[ri];
      return;
    }
    RECRUIT[ri] = recruited ? { recruited: true, recruiter: finalTeam } : { recruited: false };
  }

  // Apply a canonical preset: which === "ALL" assigns every character to its canonical team
  // (unlisted -> shared); otherwise recruits only that protagonist's canonical members.
  function applyCanonical(chars, which, teamsMap, RECRUIT) {
    chars.forEach((c) => {
      const t = teamsMap[c.name];
      if (which === "ALL") setRecruit(c, true, t || "", RECRUIT);
      else if (t === which) setRecruit(c, true, which, RECRUIT);
    });
  }

  // per-team recruited counts over a roster (staged state)
  function teamCounts(chars, RECRUIT) {
    const counts = { "": 0, Hugo: 0, Chris: 0, Geddoe: 0, Thomas: 0 };
    let total = 0;
    chars.forEach((c) => { const st = recState(c, RECRUIT); if (st.recruited) { total++; counts[st.team in counts ? st.team : ""]++; } });
    return { total, counts };
  }

  const api = { RECRUITERS, recState, setRecruit, applyCanonical, teamCounts };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RecruitCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
