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

  // ---- What a recruit asks you to bring --------------------------------------
  // A how-to line says "speak to him with the Rose Brooch in your inventory" and stops there.
  // Editor/s3_recruit_needs.json answers the rest — where that item comes from and when — from
  // the disc's shop and drop tables plus the guide's own lines. This turns one star's entry into
  // display chips, and checks each against the save it can see: a prerequisite star you already
  // have, or potch you cannot currently afford, is worth knowing before you walk over there.
  //
  // opts: {recruited: name -> true|false|null, gold: number|null}. Both optional; without them
  // the chips still render, just without the ✓/✗.
  const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const stageText = (s) => {
    const st = (s.stages || []).slice().sort((a, b) => a - b);
    if (!st.length) return "";
    const span = st[st.length - 1] - st[0] + 1 === st.length;
    const which = span && st.length > 1 ? `${st[0]}-${st[st.length - 1]}` : st.join(", ");
    return `stage${st.length > 1 ? "s" : ""} ${which} of ${s.maxStage}`;
  };
  function itemWhere(it) {
    const out = [];
    (it.shops || []).forEach((s) => {
      const what = s.kind === "rare" ? `rare find at` : `sold at`;
      const odds = s.kind === "rare" && s.chance ? ` — ${s.chance}% a visit` : "";
      out.push(`${what} ${s.town}'s ${s.counter} (${stageText(s)})${odds}`);
    });
    (it.chests || []).forEach((c) => out.push(`treasure chest in ${c.place}${c.guardian ? ` (guarded by ${c.guardian})` : ""}`));
    // Drops read as one line per hunting ground: same odds, same first area, all the enemies
    // that carry it there. Three separate "dropped by X in Kuput Forest" clauses for the same
    // forest is noise, and the same enemy at two levels is one enemy.
    const grounds = [];
    (it.drops || []).forEach((d) => {
      const here = d.areas[0] || "";
      const key = `${d.pct}|${here}`;
      let g = grounds.find((x) => x.key === key);
      if (!g) grounds.push((g = { key, pct: d.pct, here, who: [], also: new Set() }));
      const seen = g.who.find((w) => w.name === d.enemy);
      if (seen) { if (d.lv) seen.lv.push(d.lv); } else g.who.push({ name: d.enemy, lv: d.lv ? [d.lv] : [] });
      d.areas.slice(1).forEach((a) => g.also.add(a));
    });
    grounds.forEach((g) => {
      const who = g.who.map((w) => `${w.name}${w.lv.length ? ` Lv${w.lv.join("/")}` : ""}`).join(", ");
      const also = g.also.size ? ` (also in ${g.also.size} other area${g.also.size === 1 ? "" : "s"})` : "";
      out.push(`dropped by ${who} (${g.pct}%) in ${g.here}${also}`);
    });
    if (it.moreDrops) out.push(`+${it.moreDrops} more dropper${it.moreDrops === 1 ? "" : "s"}`);
    (it.guide || []).forEach((g) => {
      // the Rare Armor guide's own words, minus any line that just restates a counter the disc
      // already told us about ("Item Shop in Iksay Village")
      const dupe = /^shop/.test(g.kind) && (it.shops || []).some((s2) => g.text.includes(s2.town));
      if (!dupe) out.push(`${g.text} (guide)`);
    });
    return out;
  }
  function needChips(needs, opts) {
    const o = opts || {}, out = [];
    (needs && needs.items || []).forEach((it) => {
      const where = itemWhere(it);
      // Nothing known splits two ways: the guide's line already told you where (Scott's antler
      // is "from the Vinay del Zexay trading post"), or nobody has said — which the checklist
      // owns up to rather than dressing up.
      const blank = it.lineSays ? "only the line above" : "no source in the editor's tables";
      out.push({ kind: "item", name: it.name, id: it.id, ok: null,
        text: `${it.name} — ${where.length ? where.join(" · ") : blank}` });
    });
    (needs && needs.potch || []).forEach((amount) => {
      const gold = typeof o.gold === "number" ? o.gold : null;
      out.push({ kind: "potch", name: amount, amount, short: gold === null ? null : Math.max(0, amount - gold),
        ok: gold === null ? null : gold >= amount,
        text: `${num(amount)} potch${gold === null ? "" : ` — you have ${num(gold)}`}` });
    });
    (needs && needs.first || []).forEach((f) => {
      const got = o.recruited ? o.recruited(f.name) : null;
      const verb = f.how === "recruit" ? "Recruit" : "Bring";
      out.push({ kind: "first", name: f.name, ok: got === null ? null : !!got,
        text: `${verb} ${f.name} (#${f.n})${got === null ? "" : got ? " — recruited" : " — not yet recruited"}` });
    });
    (needs && needs.gates || []).forEach((g) => out.push({ kind: "gate", name: g, ok: null, text: g }));
    return out;
  }

  // Where a "＋ add" from the checklist should put the item: the bag the party you are actually
  // playing is carrying. The save's bag layout depends on how far the story has gone — before
  // the parties merge each protagonist carries their own bag (plus their own storage); after,
  // there is one shared bag — so "your inventory" is not a single place, and dropping a Rose
  // Brooch into Chris's bag while you are playing Hugo would put it somewhere you cannot reach.
  //
  // leaderName is who the save says you walk around as; teamsOf(name) gives that character's
  // pre-merge team(s) from the recruit bitmask. `taken` is the slots already staged this
  // session, which are no longer free. Returns null only when the save has no bags at all.
  function bagForNeeds(save, leaderName, teamsOf, taken) {
    const inv = (save && save.inventory) || [];
    if (!inv.length) return null;
    const held = new Set(taken || []);
    const idx = (region) => inv.findIndex((b) => b.region === region);
    const freeIn = (b) => (b && (b.appendSlots || b.freeSlots) || []).filter((sl) => !held.has(sl));

    const merged = !!(save.global && save.global.merged);
    let bi = -1, why = "";
    if (merged) {
      bi = idx("Party bag");
      why = "the parties have merged, so there is one shared bag";
    } else {
      const teams = (leaderName && teamsOf ? teamsOf(leaderName) : []) || [];
      const team = RECRUITERS.includes(leaderName) ? leaderName : teams.length === 1 ? teams[0] : null;
      if (team && idx(team) >= 0) {
        bi = idx(team);
        why = RECRUITERS.includes(leaderName)
          ? `you are playing as ${leaderName}`
          : `${leaderName} is on ${team}'s team, and that is who you are playing as`;
      } else {
        // Nothing in the save says whose chapter is running — fall back to the carried bag with
        // the most in it, and say so rather than pretending it was derived.
        let best = -1;
        inv.forEach((b, i) => {
          if (!RECRUITERS.includes(b.region)) return;
          if (best < 0 || b.used > inv[best].used) best = i;
        });
        bi = best;
        why = "the save doesn't say whose chapter is running, so this is the fullest carried bag";
      }
    }
    if (bi < 0) bi = 0;
    // A full bag is not a dead end: that team's storage takes the overflow.
    let slot = freeIn(inv[bi])[0];
    if (slot === undefined) {
      const store = idx(merged ? "Storage" : `${inv[bi].region} storage`);
      if (store >= 0 && freeIn(inv[store]).length) {
        why += ` — that bag is full, so this goes to ${inv[store].region}`;
        bi = store;
        slot = freeIn(inv[store])[0];
      }
    }
    return {
      bi, region: inv[bi].region, why,
      slot: slot === undefined ? null : slot,
      // Before the merge, an empty carried bag means that chapter hasn't begun; the game stocks
      // the bag when it does and overwrites whatever is in it, so anything added now is lost.
      unstarted: !merged && inv[bi].used === 0 && RECRUITERS.includes(inv[bi].region),
    };
  }

  const api = { RECRUITERS, recState, setRecruit, applyCanonical, teamCounts, previewChanges,
    orderStars, groupStars, nextStar, needChips, bagForNeeds };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.RecruitCore = api;                                                       // browser global
})(typeof self !== "undefined" ? self : globalThis);
