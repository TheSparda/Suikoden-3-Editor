// Long-description collapse ("Show more") shared by both editors and the Node tests.
//
// This repo's tabs explain themselves at length: what was disassembled, what has been played,
// what is still untested. That prose is the reason a lot of these switches are usable at all,
// so none of it is deleted — but a 2,900-character wall above the Runes table pushes the table
// itself off a phone screen, and someone who already knows what the tab does has to scroll
// past the same essay every visit.
//
// So each long block gets a one-line summary and a button. Authors opt a block in by putting
// the summary in `data-sum` on the block itself:
//
//     <div class="muted" data-sum="Brief version, one line.">…the full description…</div>
//
// An empty `data-sum=""` means "derive it from the first sentence(s)", which is right where a
// block already opens with its own summary.
//
// Three properties this has to keep:
//
//   * The full text stays IN THE DOM, hidden. It is never rebuilt from a string, and the
//     collapsed half is `hidden` rather than removed, so `textContent` still sees all of it
//     (several e2e checks read `textContent` of a whole tab) and Ctrl-F still finds it.
//   * Expanded state is keyed by the summary, not by the element. Both editors re-render whole
//     tabs into `innerHTML` on every filter keystroke and every staged edit, which would
//     otherwise snap an opened description shut mid-read — the same failure the `<details>`
//     cards hit when they tracked open state only in the DOM.
//   * Children are MOVED, not re-serialised. A block can hold live nodes (a picker button, a
//     staged-edit marker), and `innerHTML` round-tripping them would drop their handlers.
//
// The length gate is applied at runtime, not by the author: a lot of these descriptions are
// built with `${cond ? "…" : ""}` and shrink on a disc where the feature is unavailable. A
// block that renders short is left alone rather than collapsed behind a button that reveals
// one extra clause.
(function (root) {
  // Two ways a block earns a button, because the two failure modes are different: a
  // many-sentenced block is a wall of argument even when it is short, and a long one is a wall
  // of pixels even when it is a single sentence. Either is enough.
  //
  // The sentence rule is the shape the request named. The character count catches what it
  // misses: two sentences of 150 characters each are a wall too, and on a phone that is six
  // lines above the table you came for.
  const MAX_SENTS = 3;       // "more than 2-3 sentences"
  const LONG_MIN = 240;      // plain-text characters
  const SUM_MAX = 200;       // derived summaries are trimmed to about this many characters

  // Rendered length of an HTML fragment, near enough for the gate: tags dropped, entities
  // counted as one character, whitespace collapsed the way a browser lays it out.
  function plainText(html) {
    return String(html)
      .replace(/<[^>]*>/g, "")
      .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+|[a-z]+);/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Split on sentence-final punctuation followed by a space. Deliberately naive: the input is
  // this repo's own prose, and the only cost of a bad split is a summary one clause too long.
  function sentences(text) {
    return plainText(text).split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  }

  function looksLong(text) {
    const t = plainText(text);
    return t.length > LONG_MIN || sentences(t).length > MAX_SENTS;
  }

  // First sentence(s) of `text`, up to about `max` characters. Always returns something: a
  // single sentence longer than the budget is cut at a word boundary and ellipsised.
  function deriveSummary(text, max) {
    const cap = max || SUM_MAX;
    const parts = sentences(text);
    if (!parts.length) return "";
    let out = parts[0];
    for (let i = 1; i < parts.length && out.length + 1 + parts[i].length <= cap; i++) out += " " + parts[i];
    if (out.length <= cap) return out;
    const cut = out.slice(0, cap);
    const sp = cut.lastIndexOf(" ");
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, "") + "…";
  }

  const api = { LONG_MIN, MAX_SENTS, SUM_MAX, plainText, looksLong, sentences, deriveSummary };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node (CJS)
  root.BlurbCore = api;                                                        // browser global

  // ---------------------------------------------------------------- DOM half (browser only)
  const doc = typeof document !== "undefined" ? document : null;
  if (!doc) return;

  const OPEN = new Set();    // summaries the reader has expanded, so a re-render can restore them
  let seq = 0;

  function collapse(el) {
    el.setAttribute("data-blurbed", "1");    // marked first, so a failed pass can't loop
    const authored = el.getAttribute("data-sum").trim();
    const summary = authored || deriveSummary(el.textContent || "");
    // Nothing to gain: the block is already short, or the summary is the whole of it.
    if (!summary || !looksLong(el.textContent || "")) return;

    const full = doc.createElement("div");
    full.className = "blurb-full";
    full.id = "blurb-" + (++seq);
    while (el.firstChild) full.appendChild(el.firstChild);   // move, never re-serialise

    const sum = doc.createElement("div");
    sum.className = "blurb-sum";
    sum.textContent = summary;

    const tog = doc.createElement("button");
    tog.type = "button";
    tog.className = "blurb-tog";
    tog.setAttribute("aria-controls", full.id);

    el.classList.add("blurb");
    el.append(sum, full, tog);
    paint(el, OPEN.has(summary));
  }

  function paint(el, open) {
    const sum = el.querySelector(":scope > .blurb-sum");
    const full = el.querySelector(":scope > .blurb-full");
    const tog = el.querySelector(":scope > .blurb-tog");
    if (!sum || !full || !tog) return;
    sum.hidden = open;
    full.hidden = !open;
    tog.textContent = open ? "Show less ▴" : "Show more ▾";
    tog.setAttribute("aria-expanded", open ? "true" : "false");
    el.classList.toggle("open", open);
  }

  // `where` may itself be a block (the ISO editor's shared #isoHint element re-collapses
  // itself on every tab switch), so it is tested as well as its descendants.
  function applyBlurbs(where) {
    const scope = where || doc;
    if (scope.matches && scope.matches("[data-sum]:not([data-blurbed])")) collapse(scope);
    for (const el of scope.querySelectorAll("[data-sum]:not([data-blurbed])")) collapse(el);
  }

  doc.addEventListener("click", (e) => {
    const tog = e.target.closest && e.target.closest(".blurb-tog");
    if (!tog) return;
    const el = tog.closest(".blurb");
    if (!el) return;
    const key = (el.querySelector(":scope > .blurb-sum") || {}).textContent || "";
    const open = !el.classList.contains("open");
    if (open) OPEN.add(key); else OPEN.delete(key);
    paint(el, open);
  });

  // Both editors rebuild whole tabs with `innerHTML`, and there is no single render hook to
  // hang this off — so watch the document instead. `data-blurbed` makes the pass idempotent,
  // which is what stops our own DOM writes from re-triggering it forever.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; applyBlurbs(); });
  });
  const start = () => {
    applyBlurbs();
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start);
  else start();

  api.applyBlurbs = applyBlurbs;    // for tests / manual re-runs
})(typeof self !== "undefined" ? self : globalThis);
