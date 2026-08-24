#!/usr/bin/env python3
"""Classify each roster character as story (auto-joins) vs optional recruit, from the character
guide's "Automatic: Yes/No" field, into s3_recruit_meta.json. The recruit editor uses this to
recommend recruiting only OPTIONAL units and to fade story/automatic ones (which join anyway and
whose manual toggling can soft-lock). Source: suikosource/characters.txt (Suikosource char guide).
Run: python3 Editor/build_recruit_meta.py
"""
import json, os, re
HERE = os.path.dirname(os.path.abspath(__file__))

def roster():
    m = re.search(r"ROSTER\s*=\s*\[(.*?)\]", open(os.path.join(HERE, "s3save.py")).read(), re.S)
    return re.findall(r'"([^"]+)"', m.group(1))

# roster name -> guide "Name:" line, for the few that don't match by prefix.
ALIAS = {
    "Sgt. Joe": "Sgt. Jordi (Joe)", "Elliot": "Elliott",
    "Viki": "Viki (Big)", "Viki (Young)": "Viki (Little)",
}

# A guide field header at column 0 ("Name:", "Automatic:", "Battle Fighting Style:", ...) —
# the recruitment blurb ends at the next such header or a blank line.
FIELD_RE = re.compile(r"^[A-Z][A-Za-z]*(?: [A-Za-z]+)*:")

def parse_guide():
    lines = [l.rstrip() for l in open(os.path.join(HERE, "suikosource", "characters.txt"), encoding="utf-8")]
    out = {}; cur = None; i = 0
    while i < len(lines):
        l = lines[i]
        m = re.match(r"^Name:\s*(.+?)\s*$", l)
        if m: cur = m.group(1).strip()
        am = re.match(r"^Automatic:\s*(.*)$", l)
        if am and cur and cur not in out:
            # The recruitment blurb starts after "Automatic:" and continues across wrapped
            # lines until the next field header or a blank line — grab the whole thing, not
            # just the first line (which cut instructions off mid-sentence).
            parts = [am.group(1).strip()]
            j = i + 1
            while j < len(lines) and lines[j].strip() and not FIELD_RE.match(lines[j]):
                parts.append(lines[j].strip()); j += 1
            rest = re.sub(r"\s+", " ", " ".join(p for p in parts if p)).strip()
            # Only an explicit "No" is a normal optional recruit. "Yes" = story auto-join, and a
            # conditional (e.g. Luc: "recruit all 104 Stars... becomes the main character") is a
            # special/story-gated unlock, NOT something to bulk-recruit — treat both as story.
            auto = not rest.lower().startswith("no")
            how = re.sub(r"^(Yes|No)[\.,\s]*", "", rest).strip()
            out[cur] = {"auto": auto, "how": how}
            i = j; continue
        i += 1
    return out

def match(rname, guide):
    if rname in ALIAS and ALIAS[rname] in guide:
        return guide[ALIAS[rname]]
    # exact, then guide-name starts with roster name (Chris -> "Chris Lightfellow"),
    # then roster name starts with guide name (rare). Longest sensible match wins.
    if rname in guide: return guide[rname]
    cands = [g for g in guide if g.lower() == rname.lower()
             or g.lower().startswith(rname.lower() + " ")
             or rname.lower().startswith(g.lower() + " ")
             or g.lower().replace(".", "") == rname.lower().replace(".", "")]
    if cands:
        return guide[max(cands, key=len)]
    return None

def main():
    guide = parse_guide(); r = roster(); meta = {}; miss = []
    for nm in r:
        g = match(nm, guide)
        if g: meta[nm] = g
        else: miss.append(nm)
    json.dump(meta, open(os.path.join(HERE, "s3_recruit_meta.json"), "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    story = sum(1 for v in meta.values() if v["auto"])
    print(f"roster {len(r)} · classified {len(meta)} (story {story} / optional {len(meta)-story}) · unmatched {len(miss)}")
    if miss: print("  unmatched:", ", ".join(miss))

if __name__ == "__main__":
    main()
