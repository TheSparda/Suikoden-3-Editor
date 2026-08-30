#!/usr/bin/env python3
"""Build Editor/s3_rooms.json — the per-area random-encounter rate index.

Run against a PRISTINE USA (SLUS-20387) ISO:

    python3 Editor/build_room_index.py "/path/to/Suikoden III (USA).iso"

Background (full trail in Suikoden3_ISO_offsets.md, "Per-area encounter rates"):

The Encounter tab can only scale encounters globally because each map's own base rate is
not in the executable — the ELF fetch at VA 0x17B7750 returns `roomTable + idx * 0x3C`,
where the table lives in the map archives. This locates that table for every area.

Two pieces make it work:

 1. **DATA/FSECT.BIN is the archive directory.** Each entry is one u32 —
    `sector = w & 0xFFFFF`, `size = w >> 20`, both in 2048-byte sectors, per the ELF
    accessors at 0x171F500 / 0x171F520 — and the sectors are RELATIVE to the containing
    archive. A directory's entries tile its archive exactly, so a run of tiling entries
    whose end equals an archive's own sector count identifies which archive it belongs to.
    28 of the 29 archives resolve this way with no leftovers (ETC.BIN carries its own TOC).

 2. **The room table is the head of an archive's "town data" sub-file** — a short header
    then N x 0x3C records. Field offsets come from the 17 call sites of the fetch:

        +0x00 u16 mPartyRank   (named by the printf `townDatNo=%d mPartyRank=0x%x`)
        +0x02 u16 post-battle grace distance
        +0x04 u16 ENCOUNTER RATE          <- what the editor wants
        +0x08 u16 BgData id = (room number << 8) | area id

Correct-or-absent, like the rest of the reference data: a table is emitted only if its
records agree on one area id, their room numbers count up by one, and that area id is the
one the rest of the archive agrees on. Five small archives (CVIS, GDOP, HGB2, LKOE, SKBN)
legitimately have no table and are reported rather than guessed at.
"""
import sys, os, json, struct, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SEC = 2048
REC = 0x3C                      # room record stride
FSECT_ISO, FSECT_LEN = 0x4F6000, 89388
HEAD_SEARCH = 0x400             # how far into a sub-file to look for the table start

# name -> (ISO offset, byte size), from the ISO9660 walk. ETC.BIN is deliberately absent:
# it is not in FSECT and carries its own count+12-byte-entry TOC (see the ETC.BIN notes).
FILES = {
    "HNKT": (0x903AC800, 648851456), "ZKTR": (0x754DB000, 309727232),
    "VDZK": (0x2B3E3800, 203202560), "TSVI": (0x5E70B000, 170022912),
    "LAST": (0xDCED0000, 137080832), "IKVI": (0x68930800, 123334656),
    "LZVI": (0x52C3F800, 122597376), "MSVI": (0x6FECF800, 90224640),
    "DKVI": (0x5A12A800, 73271296), "KRVI": (0x4E684800, 73117696),
    "KTDO": (0xBC766800, 71790592), "CRRA": (0x8BCA4800, 67901440),
    "AKVI": (0x87C3C000, 67536896), "ICEW": (0xD5ED1800, 63004672),
    "HAKA": (0xCEB3E000, 62218240), "KSKR": (0xC457B000, 60504064),
    "YMMT": (0xC0BDD800, 60413952), "FAKE": (0xD2694000, 58972160),
    "AKMT": (0xC7F2E800, 56690688), "RVER": (0xD9AE7800, 54429696),
    "MORI": (0xB6E77800, 52774912), "HGB1": (0xCB53F000, 45883392),
    "SOGE": (0xBA0CC000, 40478720), "HGB2": (0xCE101000, 10735616),
    "CVIS": (0x8FD66000, 6580224), "GDOP": (0xE5345800, 3414016),
    "LKOE": (0xE5687000, 2852864), "SKBN": (0xE518B000, 1812480),
}
SECTORS = {n: sz // SEC for n, (_, sz) in FILES.items()}

# The disc has no player-facing area names anywhere in it, so none are invented here.
# Each area is labelled the way the Enemies tab already labels zones — with the game's own
# map ids (mori_101, icew_105 ...), read from the shipped enemy index when it is present.
def zone_names(archive):
    try:
        with open(os.path.join(HERE, "s3_enemy_packs.json")) as fh:
            j = json.load(fh)
    except (OSError, ValueError):
        return []
    out = set()
    for p in j.get("packs", []):
        if p.get("archive") == archive:
            out.update(z["name"] for z in p.get("zones", []))
    return sorted(out)


# ---- FSECT: the archive directory -------------------------------------------
def fsect_words(f):
    f.seek(FSECT_ISO)
    b = f.read(FSECT_LEN)
    n = len(b) // 4
    return struct.unpack(f"<{n}I", b[:n * 4])


def tiling_runs(W, minlen=4):
    """Maximal runs of entries where sector + size == the next sector."""
    out, i, n = [], 0, len(W)
    while i < n:
        if W[i] == 0:
            i += 1
            continue
        j, sect, size = i, W[i] & 0xFFFFF, W[i] >> 20
        while j + 1 < n and W[j + 1] != 0 and (W[j + 1] & 0xFFFFF) == sect + size:
            j += 1
            sect, size = W[j] & 0xFFFFF, W[j] >> 20
        if j - i + 1 >= minlen:
            out.append((i, j - i + 1, sect + size))
        i = j + 1
    return out


def directories(W):
    """archive name -> [(sector, size_in_sectors), ...] for its sub-files."""
    by_end = {}
    for name, secs in SECTORS.items():
        by_end.setdefault(secs, []).append(name)
    out = {}
    for start, cnt, end in tiling_runs(W):
        who = by_end.get(end)
        if not who or len(who) != 1:
            continue                      # ambiguous size -> refuse rather than guess
        out[who[0]] = [(W[start + k] & 0xFFFFF, W[start + k] >> 20) for k in range(cnt)]
    return out


# ---- the room table ----------------------------------------------------------
def read_run(buf, off):
    """Room records starting at `off`: constant area id, room numbers counting up by one."""
    out, area, prev = [], None, None
    while off + REC <= len(buf):
        rank, grace, rate, _f6, bg = struct.unpack_from("<5H", buf, off)
        area_id, room = bg & 0xFF, bg >> 8
        if rank > 64 or grace > 4000 or rate > 200 or area_id == 0 or room == 0:
            break
        if area is None:
            area, prev = area_id, room - 1
        if area_id != area or room != prev + 1:
            break
        out.append({"room": room, "rank": rank, "grace": grace, "rate": rate, "off": off})
        prev = room
        off += REC
    return out, area


def tables_in(f, base, subfiles):
    """Every room table in one archive, as (subfile index, byte offset, area, records)."""
    found = []
    for k, (sect, size) in enumerate(subfiles):
        off = base + sect * SEC
        f.seek(off)
        buf = f.read(min(size * SEC, 0x8000))
        best = None
        for o in range(0, min(len(buf) - REC, HEAD_SEARCH), 4):
            rs, area = read_run(buf, o)
            if len(rs) >= 2 and (best is None or len(rs) > len(best[3])):
                best = (k, o, area, rs)
        if best:
            found.append(best)
    if not found:
        return []
    # The whole archive must agree on one area id — a lone disagreeing table is noise.
    votes = collections.Counter(t[2] for t in found)
    area = votes.most_common(1)[0][0]
    return [t for t in found if t[2] == area]


def main():
    iso = sys.argv[1] if len(sys.argv) > 1 else None
    if not iso or not os.path.isfile(iso):
        sys.exit(__doc__)
    out = {"format": "s3rooms", "schema": 1,
           "note": "Per-map random-encounter rates. rateOff/graceOff are absolute ISO "
                   "offsets of u16 fields inside a 0x3C room record; see "
                   "Suikoden3_ISO_offsets.md 'Per-area encounter rates'.",
           "areas": []}
    empty, total_rooms, total_tables = [], 0, 0
    with open(iso, "rb") as f:
        dirs = directories(fsect_words(f))
        missing = sorted(set(FILES) - set(dirs))
        if missing:
            print(f"warning: no FSECT directory for {', '.join(missing)}")
        for name in sorted(dirs):
            base = FILES[name][0]
            found = tables_in(f, base, dirs[name])
            if not found:
                empty.append(name)
                continue
            area = found[0][2]
            tables = []
            for k, o, _a, rs in found:
                tables.append({
                    "sub": k, "rank": rs[0]["rank"],
                    "rooms": [{"room": r["room"], "rate": r["rate"], "grace": r["grace"],
                               "rateOff": base + dirs[name][k][0] * SEC + r["off"] + 4,
                               "graceOff": base + dirs[name][k][0] * SEC + r["off"] + 2}
                              for r in rs]})
                total_rooms += len(rs)
            total_tables += len(tables)
            out["areas"].append({"archive": name, "area": area,
                                 "zones": zone_names(name), "tables": tables})
    out["areas"].sort(key=lambda a: a["area"])
    out["noTable"] = empty
    path = os.path.join(HERE, "s3_rooms.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"{len(out['areas'])} areas, {total_tables} tables, {total_rooms} room records "
          f"-> {path} ({os.path.getsize(path):,} bytes)")
    print(f"no room table (expected — small special archives): {', '.join(empty) or 'none'}")
    for a in out["areas"]:
        rates = sorted({r["rate"] for t in a["tables"] for r in t["rooms"]})
        print(f"  0x{a['area']:02X} {a['archive']:5s} {len(a['tables'])} table(s), "
              f"{len(a['tables'][0]['rooms'])} rooms, rates {rates}  "
              f"zones: {', '.join(a['zones']) or '-'}")


if __name__ == "__main__":
    main()
