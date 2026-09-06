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

  // ---- 108-Stars checklist: the guide's recruitment order ---------------------
  // The checklist is laid out in the Suikosource recruitment guide's own order — the order you
  // can actually get people in — rather than by roster slot, which is meaningless to a player
  // working through the game. ORDER is Editor/s3_recruit_order.json: {phases, chars, extras}.
  //
  // A "row" here is whatever the UI tracks per character; these two only read .c.name /
  // .c.rosterIndex / .st.recruited and write the guide fields onto it, so the shape stays the
  // caller's business.

  // Annotate each row with its guide entry (n = position, star = Star of Destiny name, phase,
  // guideHow) and return them in guide order. Anyone the guide doesn't list — Lulu, who is not
  // a Star — sorts after the whole guide, keeping roster order among themselves.
  function orderStars(rows, ORDER) {
    const byName = (ORDER && ORDER.chars) || {};
    rows.forEach((r) => {
      const g = byName[r.c.name] || null;
      r.n = g ? g.n : null;
      r.star = g ? g.star : "";
      r.phase = g ? g.phase : "";
      r.guideHow = g ? g.how : "";
    });
    const key = (r) => (r.n === null ? 1e6 + r.c.rosterIndex : r.n);
    return rows.slice().sort((a, b) => key(a) - key(b));
  }

  // Cut the ordered rows into the guide's stages. `all` is every tracked row (drives each
  // stage's x/y progress, which must not move when the user filters); `shown` is the subset
  // that passed the filters and is what actually gets listed. Stages with nothing to show are
  // dropped. `extras` are the guide's non-star rows (the Koichi->Kogoro pet chain) — there is
  // nothing in the save to tick for them, so they ride along as a footnote on their stage.
  function groupStars(all, shown, ORDER) {
    const vis = new Set(shown.map((r) => r.c.rosterIndex));
    const extras = {};
    ((ORDER && ORDER.extras) || []).forEach((e) => (extras[e.phase] = extras[e.phase] || []).push(e));
    const out = [], placed = new Set();
    ((ORDER && ORDER.phases) || []).forEach((p) => {
      const mine = all.filter((r) => r.phase === p.key);
      mine.forEach((r) => placed.add(r.c.rosterIndex));
      const rows = mine.filter((r) => vis.has(r.c.rosterIndex));
      if (!rows.length) return;
      out.push(Object.assign({}, p, {
        rows, total: mine.length,
        got: mine.filter((r) => r.st.recruited).length,
        extras: extras[p.key] || [],
      }));
    });
    const rest = all.filter((r) => !placed.has(r.c.rosterIndex));
    const restShown = rest.filter((r) => vis.has(r.c.rosterIndex));
    if (restShown.length) {
      out.push({
        key: "other", label: "Not in the recruitment guide", kind: "other",
        note: "Roster entries the guide does not list as Stars of Destiny.",
        rows: restShown, total: rest.length, got: rest.filter((r) => r.st.recruited).length, extras: [],
      });
    }
    return out;
  }

  // The next star to chase: first not-yet-recruited optional row in guide order. Story joins
  // are skipped — you cannot go and get them, they arrive on their own.
  function nextStar(all) {
    return all.find((r) => !r.st.recruited && !r.story) || null;
  }

  const api = { RECRUITERS, recState, setRecruit, applyCanonical, teamCounts, previewChanges,
    orderStars, groupStars, nextStar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RecruitCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
