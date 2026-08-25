#!/usr/bin/env python3
"""Index Suikoden III (USA) WAR-battle unit stat records from a pristine ISO.

War / major-battle field fights use the same battle engine as regular
encounters, and their combatants use the same on-disc containers the enemies
editor decodes:  [count x 0x8C stat records][count x 0x34 aux blocks]
[node {u32 id, u32 count, u32 recsVa, u32 auxVa}].

Unlike zone monsters these were NOT found by the bestiary fingerprint
(war soldiers aren't in the bestiary), so this builder finds them by the
node invariant itself (auxVa == recsVa + count*0x8C) and keeps:
  - every node whose id is a war-soldier id (ZxnKn, ZxnInf, KarayaFtr, ...)
  - every other node inside the same cluster (small ids < 0x100 are the
    human "leader unit" records; monster ids there are war-battle monsters,
    e.g. Luc's chapter-5 army).

Verified vs Suikosource "bosses" guide: the ZxnKn node (lv20 hp230) matches
the Thomas ch.2 war battle exactly; node id 0x12 (lv23 hp600) matches Leo,
id 0x13 (lv22 hp500) matches Percival in the same battle. War variants carry
no SP/potch/drops (war battles give no rewards), so aux blocks are indexed
but left out of the editable UI.

Usage: python3 build_war_index.py "<path to Suikoden III (USA).iso>"
Writes: Editor/s3_war_units.json
"""
import sys, os, json, struct, collections

HERE = os.path.dirname(os.path.abspath(__file__))
REC, AUX = 0x8C, 0x34
R_HP, R_MAXHP, R_LV, R_STATS = 48, 50, 64, 32

NAME_TABLE = 0x3E74E0            # 100 x 0x14 truncated enemy names (ELF)
PAIR_TABLE = 0x3B1168            # (u16 monster id, u16 name idx)*

# war-battle soldier ids (all resolve through the pair table)
WAR_IDS = {0x132, 0x133, 0x136, 0x13F, 0x141, 0x147, 0x165, 0x166, 0x167, 0x168, 0x17C}

# Human "leader unit" ids verified against the Suikosource bosses guide by exact
# (lv, hp) matches (these small ids are the game's actor enum, NOT list1 ids):
#   0x12: lv23 hp600 + lv35 hp800  = Leo   (Thomas ch2 / Zexen battles, exact)
#   0x42: lv42/750 44/900 45/1100 52/1100 56/1100 60/3200 = Sarah (6 exact matches)
#   0x29: lv38 hp400 = Franz  (Geddoe/Chris ch: "Franz 38 400")
#   0x2A: lv38 hp400 = Ruby   (same battles; Mantor-style non-zero PDF column)
HUMAN_HINTS = {0x12: "Leo", 0x42: "Sarah", 0x29: "Franz", 0x2A: "Ruby"}

ARCHIVES = {  # name -> (ISO offset, size); from the ISO9660 walk
    "VDZK": (0x2B3E3800, 203202560), "ETC": (0x375AD800, 386756608),
    "KRVI": (0x4E684800, 73117696), "LZVI": (0x52C3F800, 122597376),
    "DKVI": (0x5A12A800, 73271296), "TSVI": (0x5E70B000, 170022912),
    "IKVI": (0x68930800, 123334656), "MSVI": (0x6FECF800, 90224640),
    "ZKTR": (0x754DB000, 309727232), "AKVI": (0x87C3C000, 67536896),
    "CRRA": (0x8BCA4800, 67901440), "CVIS": (0x8FD66000, 6580224),
    "HNKT": (0x903AC800, 648851456), "MORI": (0xB6E77800, 52774912),
    "SOGE": (0xBA0CC000, 40478720), "KTDO": (0xBC766800, 71790592),
    "YMMT": (0xC0BDD800, 60413952), "KSKR": (0xC457B000, 60504064),
    "AKMT": (0xC7F2E800, 56690688), "HGB1": (0xCB53F000, 45883392),
    "HGB2": (0xCE101000, 10735616), "HAKA": (0xCEB3E000, 62218240),
    "FAKE": (0xD2694000, 58972160), "ICEW": (0xD5ED1800, 63004672),
    "RVER": (0xD9AE7800, 54429696), "LAST": (0xDCED0000, 137080832),
    "SKBN": (0xE518B000, 1812480), "GDOP": (0xE5345800, 3414016),
    "LKOE": (0xE5687000, 2852864),
}

def archive_of(off):
    for nm, (base, size) in ARCHIVES.items():
        if base <= off < base + size:
            return nm
    return "ELF" if off < 0x466370 else "?"

def load_names(f):
    f.seek(NAME_TABLE); nd = f.read(0x14 * 100)
    names = [nd[i*0x14:(i+1)*0x14].split(b"\x00")[0].decode("latin1") for i in range(100)]
    f.seek(PAIR_TABLE); pt = f.read(0x400)
    id2name = {}
    for i in range(0, len(pt), 4):
        a, b = struct.unpack_from("<HH", pt, i)
        if a == 0:
            break
        if b < 100:
            id2name[a] = names[b]
    return id2name

def node_scan(f):
    """All well-formed nodes across the disc: (off, id, count, recsVa)."""
    import numpy as np
    sz = f.seek(0, 2)
    CH = 1 << 28
    hits = []
    pos = 0
    while pos < sz:
        f.seek(pos)
        data = f.read(min(CH + 16, sz - pos))
        n = len(data) // 4 * 4
        a = np.frombuffer(data[:n], dtype="<u4")
        if len(a) < 4:
            break
        eid, cnt, rv, av = a[:-3], a[1:-2], a[2:-1], a[3:]
        cond = ((cnt >= 1) & (cnt <= 16) & (eid >= 1) & (eid <= 0xFFFF)
                & (rv >= 0x100000) & (rv < 0x2000000) & (av == rv + cnt * REC))
        for i in np.nonzero(cond)[0]:
            hits.append((pos + int(i) * 4, int(eid[i]), int(cnt[i])))
        pos += CH
        print(f"  node scan: 0x{pos:X} / 0x{sz:X}  ({len(hits)} candidates)", file=sys.stderr)
    return hits

def decode_node(f, off, cnt):
    """Records + aux for a node whose arrays directly precede it. None if insane."""
    recbase = off - cnt * (REC + AUX)
    if recbase < 0:
        return None
    f.seek(recbase)
    blob = f.read(cnt * (REC + AUX))
    if len(blob) != cnt * (REC + AUX):
        return None
    variants = []
    for i in range(cnt):
        rec = blob[i*REC:(i+1)*REC]
        hp, mhp = struct.unpack_from("<HH", rec, R_HP)
        lv = struct.unpack_from("<H", rec, R_LV)[0]
        stats = list(struct.unpack_from("<8H", rec, R_STATS))
        if hp == 0 or hp != mhp or not (1 <= lv <= 99):
            return None
        aux = blob[cnt*REC + i*AUX: cnt*REC + (i+1)*AUX]
        exp = struct.unpack_from("<I", aux, 0x04)[0]
        sp = struct.unpack_from("<H", aux, 0x0C)[0]
        potch = struct.unpack_from("<I", aux, 0x10)[0]
        variants.append(dict(lv=lv, hp=hp, stats=stats, exp=exp, sp=sp, potch=potch,
                             recOff=recbase + i*REC, auxOff=recbase + cnt*REC + i*AUX))
    return dict(recbase=recbase, blob=blob, variants=variants)

def enemy_pack_offsets():
    """Every offset s3_enemy_packs.json already edits — the War index must not
    double-index those bytes (two overlapping write windows would desync)."""
    try:
        ep = json.load(open(os.path.join(HERE, "s3_enemy_packs.json")))
    except OSError:
        return set()
    offs = set()
    for p in ep.get("packs", []):
        for e in p["enemies"]:
            for v in e["variants"]:
                offs.update(v["rec"]); offs.update(v["aux"])
    return offs

def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    f = open(sys.argv[1], "rb")
    id2name = load_names(f)
    taken = enemy_pack_offsets()
    nodes = node_scan(f)

    # clusters of nodes (any id); a cluster is war-relevant if it contains a war-soldier id
    nodes.sort()
    clusters = []
    for h in nodes:
        if clusters and h[0] - clusters[-1][-1][0] < 0x8000:
            clusters[-1].append(h)
        else:
            clusters.append([h])
    war_clusters = [c for c in clusters if any(eid in WAR_IDS for _, eid, _ in c)]
    print(f"{len(war_clusters)} war clusters of {len(clusters)} total", file=sys.stderr)

    # decode every node in war clusters; drop insane ones (mid-data false nodes)
    # and anything the enemies index already edits (zone monsters that merely
    # share a cluster with a war node stay in the Enemies view).
    decoded = []          # (archive, id, cnt, decoded-node)
    for c in war_clusters:
        for off, eid, cnt in c:
            d = decode_node(f, off, cnt)
            if d is None:
                continue
            if any(v["recOff"] in taken for v in d["variants"]):
                continue
            decoded.append((archive_of(off), eid, cnt, d))

    # merge copies of the same node id WITHIN an archive when the stat RECORDS
    # are byte-identical (war aux blocks are unused/empty and are not edited,
    # so aux-only differences between copies must not split a logical unit)
    groups = collections.OrderedDict()
    for arch, eid, cnt, d in decoded:
        if eid < 0x100 and d["variants"][0]["lv"] <= 1 and d["variants"][0]["hp"] <= 20:
            continue                            # dummy/test record (e.g. LZVI id 3, lv1 hp16)
        recbytes = d["blob"][:cnt * REC]
        key = (arch, eid, bytes(recbytes))
        groups.setdefault(key, []).append(d)

    # one pack per archive
    per_arch = collections.OrderedDict()
    for (arch, eid, blob), ds in groups.items():
        nm = id2name.get(eid) or (HUMAN_HINTS.get(eid) and HUMAN_HINTS[eid] + " (unit)") or f"Unit #{eid:X}"
        variants = []
        for vi, v in enumerate(ds[0]["variants"]):
            variants.append(dict(
                lv=v["lv"], hp=v["hp"], stats=v["stats"],
                exp=v["exp"], sp=v["sp"], potch=v["potch"],
                drops=[],
                rec=sorted(d2["variants"][vi]["recOff"] for d2 in ds),
                aux=[],                          # war aux blocks are unused — never edited
            ))
        per_arch.setdefault(arch, []).append(dict(id=eid, name=nm, variants=variants, copies=len(ds)))

    packs = []
    for arch, enemies in per_arch.items():
        soldier = [e["name"] for e in enemies if e["id"] in WAR_IDS]
        others = [e["name"] for e in enemies if e["id"] not in WAR_IDS]
        label = ", ".join(dict.fromkeys(soldier + others))
        if len(label) > 70:
            label = label[:67] + "…"
        copies = max(e["copies"] for e in enemies)
        for e in enemies:
            e.pop("copies")
        packs.append(dict(archive=arch, label=label, war=True, copies=copies, enemies=enemies))

    nvar = sum(len(e["variants"]) for p in packs for e in p["enemies"])
    noff = sum(len(v["rec"]) + len(v["aux"]) for p in packs for e in p["enemies"] for v in e["variants"])
    out = dict(
        format="s3war", version=1, game="SLUS-20387",
        recLayout=dict(hp=R_HP, maxhp=R_MAXHP, lv=R_LV, stats=R_STATS, size=REC),
        auxLayout=dict(exp=0x04, sp=0x0C, mark=0x0E, potch=0x10, drops=0x20, nDrops=5, size=AUX),
        packs=packs,
    )
    dst = os.path.join(HERE, "s3_war_units.json")
    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(f"wrote {dst}: {len(packs)} packs, {nvar} variants, {noff} record/aux offsets")
    for p in packs:
        print(f"  {p['archive']:5s} x{p['copies']}  {p['label']}")

if __name__ == "__main__":
    main()
