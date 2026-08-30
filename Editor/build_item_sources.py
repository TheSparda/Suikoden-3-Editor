#!/usr/bin/env python3
"""Build Editor/s3_item_sources.json — "where does this item come from", for the Reference tab.

    python3 Editor/build_item_sources.py [path/to/RareArmor.txt]

Two sources, both already in the repo, neither of them guesswork:

  drops   Editor/s3_enemy_packs.json — the per-area enemy drop tables decoded from the
          disc. Every entry carries the enemy, the archive its pack lives in, that
          variant's level, and the drop weight out of 1000. This is the disc's own data.

  guide   The Suikosource *Rare Armor* guide, which tags each of the 60 rarest pieces with
          how to get it: `Treasure Chest: <place> - Guardian: <boss>`, `Dropped by ...`,
          `Rarity at <shop>`, `Sold at ...`, `Equipped to ...`, `Corpse Search ...`,
          `Mini-Game ...`, `Major Battle ...`. Text from a guide, attributed as such.

The two are kept apart in the output on purpose. The drop lines are things the editor read
off the disc and can prove; the guide lines are somebody's playthrough notes. They agree
where they overlap — the guide says Troll Dragon drops a Pale Moon Casque and the index has
exactly that at weight 64 — which is the cross-check that makes both worth showing, but a
reader should still be able to tell which is which.

Chest contents in particular are guide-only and stay that way: the disc generates a chest's
contents at runtime, so there is no on-disc list to read (see Suikoden3_ISO_offsets.md,
"The pickup ROLL, decoded").
"""
import sys, os, re, json, collections

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GUIDE = os.path.join(HERE, "suikosource", "rare_armor.txt")

# Leading phrase -> the kind we file the line under. Order matters: longest first.
KINDS = [
    ("Treasure Chest:", "chest"),
    ("Corpse Search", "corpse"),
    ("Dropped by", "drop"),
    ("Rarity at", "shop-rare"),
    ("Sold at", "shop"),
    ("Equipped to", "equipped"),
    ("Mini-Game", "minigame"),
    ("Major Battle", "battle"),
    ("Potch won", "minigame"),
]
# an item heading looks like "Custom Casque: Defense +32"
HEAD = re.compile(r"^([A-Z][A-Za-z'’ \-]{2,26}):\s+(Defense|Attack|Damage|Strength|Find|Adrenaline)")
norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())


def item_table():
    """id -> name, and a normalised name -> id index for matching guide text."""
    ids = {}
    path = os.path.join(HERE, "Suikoden3_item_ids.txt")
    with open(path, encoding="latin1") as fh:
        for line in fh:
            for m in re.finditer(r"([0-9A-Fa-f]{3})\t([^\t\n\r]+)", line):
                ids[int(m.group(1), 16)] = m.group(2).strip()
    return ids, {norm(v): k for k, v in ids.items()}


def resolve(name, by_norm):
    """Guide name -> item id. The disc's names are truncated ("OldByakkoChnMl"), so fall
    back to a prefix match and refuse anything ambiguous rather than pick."""
    n = norm(name)
    if n in by_norm:
        return by_norm[n]
    cands = {i for nm, i in by_norm.items()
             if nm.startswith(n[:10]) or n.startswith(nm[:10])}
    return cands.pop() if len(cands) == 1 else None


def parse_guide(path, by_norm):
    """item id -> [(kind, text)] from the Rare Armor guide."""
    out = collections.defaultdict(list)
    unmatched, cur, cur_id = [], None, None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            m = HEAD.match(line)
            if m:
                cur = m.group(1).strip()
                cur_id = resolve(cur, by_norm)
                if cur_id is None:
                    unmatched.append(cur)
                continue
            if cur_id is None or not line:
                continue
            for prefix, kind in KINDS:
                if line.startswith(prefix):
                    text = line[len(prefix):].strip(" :-")
                    out[cur_id].append((kind, text))
                    break
    return out, unmatched


def parse_drops():
    """item id -> [{enemy, archive, lv, weight}] from the decoded enemy index."""
    path = os.path.join(HERE, "s3_enemy_packs.json")
    try:
        with open(path) as fh:
            j = json.load(fh)
    except (OSError, ValueError):
        return {}
    seen = collections.defaultdict(set)
    for p in j.get("packs", []):
        if p.get("war"):
            continue                     # war units pay no drops
        for e in p["enemies"]:
            for v in e["variants"]:
                for iid, w in v.get("drops", []):
                    if iid and w:
                        seen[iid].add((e["name"], p["archive"], v["lv"], w))
    return {i: [{"enemy": n, "archive": a, "lv": l, "weight": w}
                for n, a, l, w in sorted(s)] for i, s in seen.items()}


def main():
    guide_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GUIDE
    ids, by_norm = item_table()
    drops = parse_drops()
    guide, unmatched = ({}, [])
    if os.path.isfile(guide_path):
        guide, unmatched = parse_guide(guide_path, by_norm)
    else:
        print(f"note: no guide text at {guide_path} — shipping drops only")

    items = {}
    for iid in sorted(set(drops) | set(guide)):
        rec = {}
        if iid in guide:
            rec["guide"] = [{"kind": k, "text": t} for k, t in guide[iid]]
        if iid in drops:
            rec["drops"] = drops[iid]
        items[str(iid)] = rec

    out = {"format": "s3itemsources", "schema": 1,
           "note": "Where an item comes from. `drops` is decoded from the disc (enemy, "
                   "archive, level, weight out of 1000); `guide` is text from the "
                   "Suikosource Rare Armor guide and is attributed as such.",
           "items": items}
    dst = os.path.join(HERE, "s3_item_sources.json")
    with open(dst, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    kinds = collections.Counter(k for v in guide.values() for k, _ in v)
    print(f"{len(items)} items with a known source -> {dst} ({os.path.getsize(dst):,} bytes)")
    print(f"  from the disc: {len(drops)} items have drop entries "
          f"({sum(len(v) for v in drops.values())} enemy/area rows)")
    print(f"  from the guide: {len(guide)} items, " +
          " ".join(f"{k}:{c}" for k, c in kinds.most_common()))
    if unmatched:
        print(f"  guide names that don't resolve to an item id ({len(unmatched)}): "
              + ", ".join(sorted(set(unmatched))))


if __name__ == "__main__":
    main()
