#!/usr/bin/env python3
"""Build Editor/s3_enemy_packs.json — the per-area enemy record index for the web editor.

Run against a PRISTINE USA (SLUS-20387) ISO:

    python3 Editor/build_enemy_index.py "/path/to/Suikoden III (USA).iso"

How it works (see Suikoden3_ISO_offsets.md "ENEMY STATS — FOUND"):
 1. Every battle pack stores each monster as: [count x 0x8C stat records]
    [count x 0x34 aux blocks] [node {u32 id, u32 count, u32 recsVa, u32 auxVa}].
    Pointers are pack-local vaddrs; each pack copy has its own file<->vaddr
    delta K.
 2. We fingerprint stat records disc-wide (u16 hp @+48 == maxhp @+50, u16 level
    @+64 matching a bestiary (lv,hp) pair), cluster the hits, and inside each
    cluster recover K by exact-cover voting of (recordBase - recsVa).
 3. A node is emitted only if every variant validates: record decodes with
    hp==maxhp and 1<=lv<=99, AND its aux block carries the 1000 marker
    (u16 @+0x0E — the drop-rate denominator constant). Correct-or-absent.
 4. Byte-identical packs inside an archive are streaming copies of the same
    logical pack; their record/aux offsets are merged so the editor writes
    every copy at once.

Aux block (0x34 bytes, ONE PER VARIANT at auxVa + k*0x34):
    +0x04 u32 EXP value   +0x0C u16 SP   +0x0E u16 1000 (marker)
    +0x10 u32 potch       +0x14 12 AI/resist bytes
    +0x20 5 x (u16 item id, u16 weight/1000) drop slots
Verified vs Suikosource: GhostHolly variants sp 55/460/490, potch 5,500/30,000/
33,000 — exact; drops decode to Byakko Chain Mail + Guardian Casque etc.
"""
import sys, os, json, struct, collections, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
REC = 0x8C
AUX = 0x34
# record-relative field offsets (verified: Rock Golem 950/Lv55, Vermitor 65/Lv15 ...)
R_HP, R_MAXHP, R_LV, R_STATS = 48, 50, 64, 32
# aux-block-relative offsets (verified vs Suikosource: GhostHolly 55/460/490 sp ...)
A_EXP, A_SP, A_MARK, A_POTCH, A_DROPS = 0x04, 0x0C, 0x0E, 0x10, 0x20
N_DROPS = 5

ELF_BASE = 0xA4800
PAIR_TABLE = 0x3B1168          # ELF file offset: (u16 monster id, u16 name idx)*
NAME_TABLE = 0x3E74E0          # 100 x 0x14 truncated enemy names

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

def load_names(f):
    f.seek(NAME_TABLE); nd = f.read(0x14 * 100)
    names = [nd[i*0x14:(i+1)*0x14].split(b"\x00")[0].decode("latin1") for i in range(100)]
    f.seek(PAIR_TABLE); pt = f.read(0x400)
    id2name = {}
    for i in range(0, len(pt), 4):
        a, b = struct.unpack_from("<HH", pt, i)
        if a == 0:
            break
        id2name[a] = names[b] if b < 100 else f"#{a:X}"
    return id2name

def bestiary_pairs():
    best = json.load(open(os.path.join(HERE, "s3_bestiary.json")))
    pairs = set()
    for rows in best.values():
        for r in rows:
            lv, hp = r.get("lv"), r.get("hp")
            if isinstance(lv, int) and isinstance(hp, int) and 1 <= lv <= 99 and 5 <= hp <= 65535:
                pairs.add((lv, hp))
    return pairs

def fingerprint_scan(f, pairs):
    """All file offsets where u16@x==u16@x+2 (hp) and u16@x+16 (lv) form a known pair."""
    import numpy as np
    hits = []
    sz = f.seek(0, 2)
    CH = 1 << 26
    off = 0
    while off < sz:
        f.seek(off); buf = f.read(CH + 32)
        if len(buf) < 32:
            break
        n = (len(buf) - 32) // 2 * 2
        a = np.frombuffer(buf[:n + 32], dtype="<u2")
        cond = (a[:-16] == a[1:-15]) & (a[:-16] >= 5)
        for i in np.nonzero(cond)[0]:
            l, h = int(a[i + 8]), int(a[i])
            if (l, h) in pairs:
                hits.append(off + int(i) * 2)
        off += CH
    return hits

def clusters_of(hits, gap=0x8000):
    hits = sorted(hits)
    out = []
    for p in hits:
        if out and p - out[-1][-1] < gap:
            out[-1].append(p)
        else:
            out.append([p])
    return out

def archive_of(pos):
    for n, (b, s) in ARCHIVES.items():
        if b <= pos < b + s:
            return n
    return None

def parse_cluster(f, hitlist, monster_ids):
    """Recover K, then decode + triple-validate every node near this record cluster."""
    recbases = sorted({h - R_HP for h in hitlist})
    lo, hi = recbases[0] - 0x8000, recbases[-1] + 0x8000
    f.seek(lo); img = f.read(hi - lo)
    L = len(img)
    u32 = lambda o: struct.unpack_from("<I", img, o)[0]
    # candidate nodes: {known monster id, count 1..8, recsVa < auxVa, aux array
    # directly after the record array (allow up to 0x20 alignment padding)}
    cand = []
    for o in range(0, L - 15, 4):
        nid = u32(o)
        if nid not in monster_ids:
            continue
        cnt = u32(o + 4)
        if not 1 <= cnt <= 8:
            continue
        rp, ap = u32(o + 8), u32(o + 12)
        if not (0 < rp < ap and REC * cnt <= ap - rp <= REC * cnt + 0x20):
            continue
        cand.append((o, nid, cnt, rp, ap))
    if not cand:
        return []
    # K by exact-cover voting: recsPtr + K must equal a fingerprinted record base
    votes = collections.Counter()
    rset = set(recbases)
    for o, nid, cnt, rp, ap in cand:
        for R in recbases:
            votes[R - rp] += 1
    Ks = [k for k, c in votes.most_common(12)]
    bestK, bestcov = None, 0
    for K in Ks:
        cov = sum(1 for o, nid, cnt, rp, ap in cand if rp + K in rset)
        if cov > bestcov:
            bestK, bestcov = K, cov
    if bestK is None or bestcov < 1:
        return []
    K = bestK
    nodes = []
    for o, nid, cnt, rp, ap in cand:
        recf, auxf = rp + K, ap + K
        if not (lo <= recf and auxf + AUX * cnt <= hi):
            continue
        variants = []
        ok = True
        for k in range(cnt):
            ro = recf - lo + k * REC
            ao = auxf - lo + k * AUX
            if ro + REC > L or ao + AUX > L:
                ok = False; break
            # validation 1: record decodes sanely
            hp, mhp = struct.unpack_from("<2H", img, ro + R_HP)
            lv = struct.unpack_from("<H", img, ro + R_LV)[0]
            if hp != mhp or hp == 0 or not 1 <= lv <= 99:
                ok = False; break
            # validation 2: aux block carries the 1000 marker
            if struct.unpack_from("<H", img, ao + A_MARK)[0] != 1000:
                ok = False; break
            stats = list(struct.unpack_from("<8H", img, ro + R_STATS))
            variants.append({
                "lv": lv, "hp": hp, "stats": stats,
                "exp": u32(ao + A_EXP),
                "sp": struct.unpack_from("<H", img, ao + A_SP)[0],
                "potch": u32(ao + A_POTCH),
                "drops": [list(struct.unpack_from("<2H", img, ao + A_DROPS + 4 * i))
                          for i in range(N_DROPS)],
                "off": recf + k * REC, "auxoff": auxf + k * AUX,
            })
        if not ok:
            continue
        nodes.append({"id": nid, "cnt": cnt, "node": lo + o, "variants": variants})
    return nodes

def main():
    iso_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not iso_path or not os.path.isfile(iso_path):
        sys.exit("usage: build_enemy_index.py <Suikoden III (USA).iso>")
    f = open(iso_path, "rb")
    id2name = load_names(f)
    monster_ids = set(id2name)
    pairs = bestiary_pairs()
    print(f"bestiary (lv,hp) pairs: {len(pairs)}; known monster ids: {len(monster_ids)}")
    hits = fingerprint_scan(f, pairs)
    print(f"fingerprint hits: {len(hits)}")
    packs = []
    for cl in clusters_of(hits):
        arch = archive_of(cl[0])
        if arch is None:
            continue   # ELF-resident cluster (different record type) or unknown region
        nodes = parse_cluster(f, cl, monster_ids)
        if nodes:
            packs.append({"archive": arch, "nodes": nodes})
    print(f"decoded packs: {len(packs)}  nodes: {sum(len(p['nodes']) for p in packs)}")

    # merge byte-identical pack copies (streaming duplicates within an archive)
    def pack_sig(f, p):
        h = hashlib.sha1()
        for n in sorted(p["nodes"], key=lambda n: n["node"]):
            h.update(struct.pack("<II", n["id"], n["cnt"]))
            for v in n["variants"]:
                f.seek(v["off"]); h.update(f.read(REC))
                f.seek(v["auxoff"]); h.update(f.read(AUX))
        return p["archive"] + ":" + h.hexdigest()
    groups = collections.OrderedDict()
    for p in packs:
        groups.setdefault(pack_sig(f, p), []).append(p)

    out_packs = []
    for sig, copies in groups.items():
        base = copies[0]
        enemies = []
        for ni, n in enumerate(sorted(base["nodes"], key=lambda n: n["node"])):
            variants = []
            for k, v in enumerate(n["variants"]):
                rec_offs, aux_offs = [], []
                for cp in copies:
                    cn = sorted(cp["nodes"], key=lambda x: x["node"])[ni]
                    rec_offs.append(cn["variants"][k]["off"])
                    aux_offs.append(cn["variants"][k]["auxoff"])
                variants.append({"lv": v["lv"], "hp": v["hp"], "stats": v["stats"],
                                 "exp": v["exp"], "sp": v["sp"], "potch": v["potch"],
                                 "drops": v["drops"], "rec": rec_offs, "aux": aux_offs})
            enemies.append({"id": n["id"], "name": id2name.get(n["id"], f"#{n['id']:X}"),
                            "variants": variants})
        label = ", ".join(sorted({e["name"] for e in enemies})[:4])
        out_packs.append({"archive": base["archive"], "copies": len(copies),
                          "label": label, "enemies": enemies})
    out_packs.sort(key=lambda p: (p["archive"], p["label"]))
    total_v = sum(len(e["variants"]) for p in out_packs for e in p["enemies"])
    print(f"logical packs: {len(out_packs)}  variants: {total_v}")
    out = {"format": "s3enemy", "version": 1, "game": "SLUS-20387",
           "recLayout": {"hp": R_HP, "maxhp": R_MAXHP, "lv": R_LV, "stats": R_STATS, "size": REC},
           "auxLayout": {"exp": A_EXP, "sp": A_SP, "mark": A_MARK, "potch": A_POTCH,
                         "drops": A_DROPS, "nDrops": N_DROPS, "size": AUX},
           "packs": out_packs}
    dst = os.path.join(HERE, "s3_enemy_packs.json")
    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(f"wrote {dst} ({os.path.getsize(dst):,} bytes)")

if __name__ == "__main__":
    main()
