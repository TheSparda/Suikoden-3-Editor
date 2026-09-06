#!/usr/bin/env python3
"""Turn the Suikosource *Recruitment Guide* into s3_recruit_order.json — the order you can
actually get the Stars of Destiny in, which is how the 108-Stars checklist is laid out.

The guide is one long table, sorted by when a character becomes gettable: the four starting
parties first, then the Budehuc-era optional recruits, then each story block, and finally the
Chapter 6 four that need every other star. It carries three things s3_recruit_meta.json (built
from the character FAQ) does not:

  * the position in that order (1..112),
  * the Star of Destiny name (Tenbi, Chimou, ...),
  * a one-line, recruitment-specific how-to (the FAQ's blurb is written for a character page).

Four guide rows are NOT stars — Koichi, Connie, Kosanji and Kogoro, the pet chain you can only
start after Koroku. They have no roster slot and nothing in the save to tick, so they are kept
aside under "extras" and the UI shows them as a footnote on their stage rather than as rows.

Source: suikosource/recruitment.txt (pdftotext -layout of the guide page).
Run: python3 Editor/build_recruit_order.py
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))

# The guide prints every row in one table with no section headings, but the order falls into
# clear stages — a story block, then the optional recruits that open up alongside it, and so on.
# Ranges are guide positions (the leftmost column); the assertions in main() re-derive story vs
# optional from the row text and complain if a future guide revision moves a boundary.
PHASES = [
    ("ch1",   1,  25,  "Chapter 1 — the four parties",   "story",    "Everyone you are handed while playing Hugo, Chris, Geddoe and Thomas' first chapters."),
    ("opt1",  26, 64,  "Optional — Chapters 1-3",        "optional", "The Budehuc-era recruits. Most open up as soon as you can travel; a few want a specific party or item."),
    ("ch23",  65, 72,  "Chapters 2-3 — story",           "story",    "Joins automatically as Hugo's and Chris' later chapters play out."),
    ("ch45",  73, 83,  "Chapters 4-5 — story",           "story",    "The armies gather at Budehuc; Yun joins a chapter later."),
    ("opt2",  84, 97,  "Optional — Chapter 4 onward",    "optional", "The second wave of optional recruits, once the parties have merged."),
    ("ch5",   98, 108, "Chapter 5 — story",              "story",    "Geddoe's Chapter 5 group only joins if you stand and fight."),
    ("ch6",   109, 112, "Chapter 6 — the last four",     "story",    "Joins in the final chapter, and only with every other star already recruited."),
]

# guide "Name" column -> roster name in s3save.py, for the rows that don't match by prefix.
ALIAS = {
    "Sgt. Jordi (Joe)": "Sgt. Joe",
    "Viki (young)": "Viki (Young)",
    "Beechum": "Beecham",          # the guide's spelling; the save's roster says Beecham
    "Sanae": "Sanae Y",
}

# A data row: "  26  Arthur   Chiyou   Speak to him in the Mess Hall...". Name may contain
# spaces and brackets, the Star column never does. Wrapped how-to text continues on the
# following lines, indented past the number column.
ROW_RE = re.compile(r"^\s*(\d{1,3})\s+(.+?)\s{2,}(\S+)\s{2,}(.+?)\s*$")
# Page furniture from the PDF print view: the browser's date/title header, the page footer URL,
# the intro prose above the table, and the table's own column header.
SKIP_RE = re.compile(r"^\s*(?:\d+/\d+/\d+,|https?://|Name\s+Star\s+How to Recruit)")


def roster():
    src = open(os.path.join(HERE, "s3save.py"), encoding="utf-8").read()
    return re.findall(r'"([^"]+)"', re.search(r"ROSTER\s*=\s*\[(.*?)\]", src, re.S).group(1))


def parse_guide():
    """[{n, name, star, how}] in the guide's own order."""
    rows, cur = [], None
    for line in open(os.path.join(HERE, "suikosource", "recruitment.txt"), encoding="utf-8"):
        line = line.rstrip()
        if not line.strip() or SKIP_RE.match(line):
            continue
        m = ROW_RE.match(line)
        if m:
            cur = {"n": int(m.group(1)), "name": m.group(2).strip(),
                   "star": m.group(3).strip(), "how": m.group(4).strip()}
            rows.append(cur)
        elif cur is not None:
            # a wrapped how-to line (indented under the How column) — glue it back on
            cur["how"] = re.sub(r"\s+", " ", cur["how"] + " " + line.strip())
    return rows


def match(gname, names):
    """Guide name -> roster name, or None for the rows that aren't roster characters."""
    if gname in ALIAS:
        return ALIAS[gname] if ALIAS[gname] in names else None
    if gname in names:
        return gname
    base = re.sub(r"\s*\(S\d\)$", "", gname)        # "Hugo (S3)" -> "Hugo"
    if base in names:
        return base
    # "Chris Lightfellow" -> "Chris", "Augustine Nabor" -> "Augustine"
    cands = [n for n in names if base.startswith(n + " ")]
    return max(cands, key=len) if cands else None


def phase_of(n):
    for key, lo, hi, _label, _kind, _note in PHASES:
        if lo <= n <= hi:
            return key
    return ""


# The guide never labels a row story vs optional in words (the site highlights them instead),
# but its how-to text does: a story join says so outright. Used only to check the stage ranges
# above still describe the data.
def looks_story(how):
    h = how.lower()
    return ("automatic" in h or h.startswith("you control")
            or re.search(r"joins during .*chapter", h) is not None)


def main():
    names = roster()
    rows = parse_guide()
    chars, extras, unmatched = {}, [], []
    for r in rows:
        rec = {"n": r["n"], "star": r["star"], "how": r["how"], "phase": phase_of(r["n"])}
        nm = match(r["name"], names)
        if nm:
            chars[nm] = rec
        elif r["star"] == "N/A":
            extras.append(dict(rec, name=r["name"]))      # the four non-star pets
        else:
            unmatched.append(r["name"])

    out = {
        "phases": [{"key": k, "label": lb, "kind": kd, "note": nt} for k, _lo, _hi, lb, kd, nt in PHASES],
        "chars": chars,
        "extras": extras,
    }
    with open(os.path.join(HERE, "s3_recruit_order.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    # sanity: every guide row landed somewhere, the stages cover the order with no gaps, and
    # each stage really is the story/optional block its label claims.
    problems = []
    if unmatched:
        problems.append("unmatched guide rows: " + ", ".join(unmatched))
    missing = [n for n in names if n not in chars]
    if missing:
        print("  not in the guide (not Stars of Destiny):", ", ".join(missing))
    for key, lo, hi, label, kind, _note in PHASES:
        block = [r for r in rows if lo <= r["n"] <= hi]
        if len(block) != hi - lo + 1:
            problems.append(f"{key}: expected {hi - lo + 1} rows, found {len(block)}")
        odd = [r["name"] for r in block if looks_story(r["how"]) != (kind == "story")]
        if odd:
            problems.append(f"{key} ({label}) is not a clean {kind} block: " + ", ".join(odd))
    print(f"guide rows {len(rows)} · stars {len(chars)} · non-star extras {len(extras)} · roster {len(names)}")
    for p in problems:
        print("  ! " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
