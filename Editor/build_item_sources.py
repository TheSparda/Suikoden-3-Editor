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
    """item id -> [{enemy, archives, lv, weight}] from the decoded enemy index.

    Grouped by (enemy, level, weight), with the archives that host that pack collected into
    a list. The same monster's pack is duplicated into every archive whose maps can spawn it,
    so ungrouped this is 625 rows of which 437 differ only by archive name — the Fire Rune
    alone produced fourteen. The fact is "this enemy at this level drops it at this weight";
    which archives carry the pack is a detail of that fact, not fifteen separate findings.
    Grouping here rather than in the renderers means the two Reference browsers that show
    these rows can't drift from each other."""
    path = os.path.join(HERE, "s3_enemy_packs.json")
    try:
        with open(path) as fh:
            j = json.load(fh)
    except (OSError, ValueError):
        return {}
    seen = collections.defaultdict(lambda: collections.defaultdict(set))
    for p in j.get("packs", []):
        if p.get("war"):
            continue                     # war units pay no drops
        for e in p["enemies"]:
            for v in e["variants"]:
                for iid, w in v.get("drops", []):
                    if iid and w:
                        seen[iid][(e["name"], v["lv"], w)].add(p["archive"])
    return {i: [{"enemy": n, "archives": sorted(arch), "lv": l, "weight": w}
                for (n, l, w), arch in sorted(g.items())]
            for i, g in seen.items()}


def pickup_places():
    """Per archive: the pickups its maps hold, counted off the disc.

    build_subfile_index.py already counts them into each town sub-file's label ("area 0x0D ·
    6 rooms · 1 corpse · 3 herbs") by looking for the game's own object names — `takara` (宝)
    a chest, `emono` (獲物) a lootable corpse, `herb_*` a herb spot. An archive ships several
    chapter variants of the same maps, so the honest per-archive figure is the MAXIMUM any one
    variant carries, not the sum, which would count the same chest once per chapter.
    """
    try:
        with open(os.path.join(HERE, "s3_subfiles.json")) as fh:
            sub = json.load(fh)
        with open(os.path.join(HERE, "s3_rooms.json")) as fh:
            rooms = json.load(fh)
    except (OSError, ValueError):
        return []
    kinds = sub.get("kinds", [])
    zones = {a["archive"]: a.get("zones", []) for a in rooms.get("areas", [])}
    area_of = {a["archive"]: a["area"] for a in rooms.get("areas", [])}
    out = []
    for arch in sub.get("archives", []):
        best = {}
        variants = 0
        for _sect, _size, k, label in arch["files"]:
            if kinds[k] != "town":
                continue
            variants += 1
            for n, what in re.findall(r"(\d+) (chest|corpse|herbs)", label):
                best[what] = max(best.get(what, 0), int(n))
        if not best:
            continue
        out.append({"archive": arch["archive"], "area": area_of.get(arch["archive"]),
                    "zones": zones.get(arch["archive"], []), "variants": variants,
                    "chest": best.get("chest", 0), "corpse": best.get("corpse", 0),
                    "herbs": best.get("herbs", 0)})
    out.sort(key=lambda x: (x["area"] if x["area"] is not None else 999, x["archive"]))
    return out


def guide_chests(guide):
    """The guide's named chests: place -> the rare items it lists for that place.

    Deliberately NOT joined to the archives above. The disc carries no place names at all —
    only tags like YMMT and map ids like ymmt_101 — so any mapping from "Mountain Path" to an
    archive would be my guess dressed up as data. The two tables sit side by side and the UI
    says why.
    """
    by_place = collections.defaultdict(list)
    for iid, rows in guide.items():
        for kind, text in rows:
            if kind != "chest":
                continue
            place, _, guard = text.partition(" - Guardian:")
            by_place[place.strip().rstrip(".")].append(
                {"item": iid, "guardian": guard.strip() or None})
    return [{"place": p, "items": sorted(v, key=lambda x: x["item"])}
            for p, v in sorted(by_place.items(), key=lambda x: -len(x[1]))]


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

    places = pickup_places()
    chests = guide_chests(guide)
    out = {"places": places, "chests": chests,
           "format": "s3itemsources", "schema": 1,
           "note": "Where an item comes from. `drops` is decoded from the disc (enemy, "
                   "archive, level, weight out of 1000); `guide` is text from the "
                   "Suikosource Rare Armor guide and is attributed as such.",
           "items": items}
    dst = os.path.join(HERE, "s3_item_sources.json")
    with open(dst, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    kinds = collections.Counter(k for v in guide.values() for k, _ in v)
    print(f"{len(items)} items with a known source -> {dst} ({os.path.getsize(dst):,} bytes)")
    rows = sum(len(v) for v in drops.values())
    spread = sum(len(r["archives"]) for v in drops.values() for r in v)
    print(f"  from the disc: {len(drops)} items have drop entries "
          f"({rows} distinct enemy/level/weight facts across {spread} archive placements)")
    print(f"  from the guide: {len(guide)} items, " +
          " ".join(f"{k}:{c}" for k, c in kinds.most_common()))
    print(f"  pickup census: {len(places)} archives with pickups "
          f"({sum(p['chest'] for p in places)} chests, {sum(p['corpse'] for p in places)} corpses, "
          f"{sum(p['herbs'] for p in places)} herb spots, counted per archive as the max over "
          f"its chapter variants)")
    print(f"  guide chests: {len(chests)} named places, "
          + ", ".join(f"{c['place']} ({len(c['items'])})" for c in chests))
    if unmatched:
        print(f"  guide names that don't resolve to an item id ({len(unmatched)}): "
              + ", ".join(sorted(set(unmatched))))


if __name__ == "__main__":
    main()
