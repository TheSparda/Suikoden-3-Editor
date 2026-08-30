#!/usr/bin/env python3
"""Build Editor/s3_subfiles.json — the disc's whole sub-file layout, from FSECT.BIN.

    python3 Editor/build_subfile_index.py "/path/to/Suikoden III (USA).iso"

DATA/FSECT.BIN is the archive directory (see Suikoden3_ISO_offsets.md, "FSECT.BIN
CRACKED"): one u32 per sub-file, `sector = w & 0xFFFFF` relative to the containing
archive and `size = w >> 20`, both in 2048-byte sectors, and a directory's entries tile
its archive exactly. That gives every sub-file's offset and size on the disc — 4,403 of
them across 28 archives.

Each one is then classified by what its first bytes actually are, never by position:

  battle  a zone object at offset 0 — {u32 slotListVa, u32 partyListVa, u32 extraVa,
          u32 0, char name[]} — so it carries the game's own map id (mori_101). These
          are the packs the Enemies/War views edit.
  town    holds a room table (the per-area encounter rates); labelled with its area id
          and room count. Also carries the map's named scene objects.
  map     the geometry/model family, recognised by the constant 0x310 at +0x0C.
  data    everything else, left unlabelled rather than guessed at.

The counts are a regression guard in themselves: `town` must come out at exactly the
number of tables the room index finds, since both are derived the same way.
"""
import sys, os, json, struct, re, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_room_index as R          # FSECT parsing + the room-table reader

SEC = 2048
KINDS = ["data", "map", "town", "battle"]          # index -> name, as stored in the JSON
ZNAME = re.compile(rb"^[a-z][a-z0-9_]{3,11}\x00")
MAP_MARKER = 0x310                                 # word at +0x0C on the geometry family

# Town sub-files carry the map's named scene objects in 32-byte, 16-aligned name fields.
# Three of those names are pickups, and the game names them in romaji: `takara*` (宝,
# "treasure") is a chest, `emono` (獲物, "catch/prey") is a lootable corpse, and `herb_*`
# is a herb-picking spot. Counting them tells you which maps have something to find —
# verified against the walkthrough for Kuput Forest, which describes exactly the herbs and
# the single corpse MORI's town data contains.
OBJ_NAME = re.compile(rb"(?=([A-Za-z][A-Za-z0-9_]{2,15})\x00)")
PICKUPS = (("takara", "chest"), ("emono", "corpse"), ("herb", "herbs"))


def scene_objects(buf):
    """Names of the 32-byte scene-object fields in a town sub-file."""
    out = []
    for m in OBJ_NAME.finditer(buf):
        o = m.start()
        if o % 16:
            continue
        nm = m.group(1)
        fld = buf[o:o + 32]
        if len(fld) == 32 and fld[len(nm)] == 0 and all(c == 0 for c in fld[len(nm):]):
            out.append(nm.decode("latin1"))
    return out


def pickup_note(buf):
    """"3 herbs · 1 corpse" for a town sub-file, or "" when it has none."""
    names = scene_objects(buf)
    bits = []
    for prefix, label in PICKUPS:
        n = sum(1 for x in names if x.startswith(prefix))
        if n:
            bits.append(f"{n} {label}")
    return " · ".join(bits)


def classify(head, whole=None):
    """(kind, label) for a sub-file. `head` is its first 0x400 bytes; `whole` (optional)
    is the entire sub-file, used only to count a town's pickups."""
    if len(head) < 0x20:
        return "data", ""
    w = struct.unpack_from("<4I", head)
    if w[3] == 0 and ZNAME.match(head[0x10:0x1C]) and all(0x00100000 <= x <= 0x02000000 for x in w[:3]):
        return "battle", head[0x10:0x1C].split(b"\x00")[0].decode("latin1")
    for o in range(0, min(len(head) - R.REC, 0x300), 4):
        rs, area = R.read_run(head, o)
        if len(rs) >= 2:
            lbl = f"area 0x{area:02X} · {len(rs)} rooms"
            note = pickup_note(whole) if whole is not None else ""
            return "town", lbl + (f" · {note}" if note else "")
    if w[3] == MAP_MARKER:
        return "map", ""
    return "data", ""


def main():
    iso = sys.argv[1] if len(sys.argv) > 1 else None
    if not iso or not os.path.isfile(iso):
        sys.exit(__doc__)
    out = {"format": "s3subfiles", "schema": 1, "kinds": KINDS,
           "note": "Sub-file layout from DATA/FSECT.BIN. Each archive: base = its ISO "
                   "offset; files = [sector, sizeInSectors, kindIndex, label]. Absolute "
                   "offset = base + sector*2048.",
           "archives": []}
    tally = collections.Counter()
    with open(iso, "rb") as f:
        dirs = R.directories(R.fsect_words(f))
        for name in sorted(dirs):
            base = R.FILES[name][0]
            files = []
            for sect, size in dirs[name]:
                f.seek(base + sect * SEC)
                head = f.read(min(size * SEC, 0x400))
                whole = None
                if struct.unpack_from("<I", head, 0x0C)[0] != MAP_MARKER:
                    f.seek(base + sect * SEC)
                    whole = f.read(size * SEC)          # only the small non-geometry ones
                kind, label = classify(head, whole)
                tally[kind] += 1
                files.append([sect, size, KINDS.index(kind), label])
            out["archives"].append({"archive": name, "base": base,
                                    "size": R.FILES[name][1], "files": files})
    path = os.path.join(HERE, "s3_subfiles.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    total = sum(len(a["files"]) for a in out["archives"])
    print(f"{total} sub-files across {len(out['archives'])} archives -> {path} "
          f"({os.path.getsize(path):,} bytes)")
    print("  " + " · ".join(f"{k} {tally[k]}" for k in KINDS))
    for a in out["archives"]:
        c = collections.Counter(KINDS[x[2]] for x in a["files"])
        print(f"  {a['archive']:5s} {len(a['files']):5d}  " +
              " ".join(f"{k}:{c[k]}" for k in KINDS if c[k]))


if __name__ == "__main__":
    main()
