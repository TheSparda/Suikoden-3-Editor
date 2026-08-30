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

def parse_cluster(f, hitlist, monster_ids, exclude_ks=()):
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
        return [], None, lo, hi
    # K by exact-cover voting: recsPtr + K must equal a fingerprinted record base
    votes = collections.Counter()
    rset = set(recbases)
    for o, nid, cnt, rp, ap in cand:
        for R in recbases:
            votes[R - rp] += 1
    Ks = [k for k, c in votes.most_common(24) if k not in exclude_ks]
    bestK, bestcov = None, 0
    for K in Ks:
        cov = sum(1 for o, nid, cnt, rp, ap in cand if rp + K in rset)
        if cov > bestcov:
            bestK, bestcov = K, cov
    if bestK is None or bestcov < 1:
        return [], None, lo, hi
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
    return nodes, K, lo, hi


# ---- zones & formations ------------------------------------------------------
# Each map zone is a battle-area object embedded in the pack:
#   { u32 slotListVa, u32 partyListVa, u32 extraVa, u32 0, char name[] }   ("mori_101")
#   slotList  = {u32 count, u32 arrayVa} -> 0x14-stride spawn slots:
#               {u32 monsterId, u32 variant, f32 a, f32 b, u32 nodeVa}
#   partyList = {u32 count, u32 arrayVa} -> 0x1C-stride formations:
#               {u16 type, u16 probWeight, u32 ?, u64 -1, u16 formationId,
#                u16 memberCount, u32 membersVa -> u8 slotIndex[count]}
# Pointers are pack-local vaddrs; validated with the SAME K as the copy's monster
# nodes, so a zone only ever attaches to the pack copy it belongs to.
import re as _re
ZNAME = _re.compile(rb"[a-z][a-z0-9_]{3,11}\x00")

def parse_zones(f, lo, hi, K, monster_ids):
    f.seek(lo); img = f.read(hi - lo)
    L = len(img)
    u32 = lambda o: struct.unpack_from("<I", img, o)[0]
    u16 = lambda o: struct.unpack_from("<H", img, o)[0]
    zones = []
    for o in range(0, L - 0x20, 4):
        if u32(o + 0x0C) != 0:
            continue
        m = ZNAME.match(img, o + 0x10)
        if not m:
            continue
        slv, pav = u32(o), u32(o + 4)
        slf, paf = slv + K - lo, pav + K - lo
        if not (0 <= slf <= L - 8 and 0 <= paf <= L - 8):
            continue
        scnt, sarr = u32(slf), u32(slf + 4)
        pcnt, parr = u32(paf), u32(paf + 4)
        if not (1 <= scnt <= 32 and 1 <= pcnt <= 64):
            continue
        sao, pao = sarr + K - lo, parr + K - lo
        if not (0 <= sao and sao + scnt * 0x14 <= L and 0 <= pao and pao + pcnt * 0x1C <= L):
            continue
        slots = []
        ok = True
        known = 0
        for i in range(scnt):
            b = sao + i * 0x14
            mid, var = u32(b), u32(b + 4)
            # monsters, or character ids (bosses fight as characters); require at
            # least one known monster so text/junk can't masquerade as a zone
            if not ((mid in monster_ids) or (1 <= mid <= 0xD7)) or var > 7:
                ok = False; break
            if mid in monster_ids:
                known += 1
            slots.append({"id": mid, "variant": var, "off": lo + b})
        if not ok or known == 0:
            continue
        parties = []
        for i in range(pcnt):
            b = pao + i * 0x1C
            typ, prob = u16(b), u16(b + 2)
            fid, mcnt = u16(b + 0x10), u16(b + 0x12)
            mv = u32(b + 0x14)
            mo = mv + K - lo
            if not (mcnt <= 6 and 0 <= mo and mo + max(mcnt, 1) <= L):
                ok = False; break
            members = list(img[mo:mo + mcnt])
            if any(x >= scnt for x in members):
                ok = False; break
            parties.append({"type": typ, "prob": prob, "formId": fid,
                            "members": members, "off": lo + b, "memOff": lo + mo})
        if not ok or not parties:
            continue
        zones.append({"name": m.group()[:-1].decode(), "off": lo + o,
                      "slots": slots, "parties": parties})
    return zones


# ---- FSECT copy recovery -----------------------------------------------------
# The fingerprint pass above can only find a pack copy that contains an enemy whose
# (level, HP) is in the Suikosource bestiary. That is most of them, but not all: the
# disc turns out to hold 285 battle sub-files and the fingerprint reaches 172 of them.
# The rest are extra streaming copies of areas we DO decode — and a copy we don't know
# about is a copy an edit doesn't reach, which is the same bug as the potch overlay pair.
#
# DATA/FSECT.BIN closes that gap (see Suikoden3_ISO_offsets.md, "FSECT.BIN CRACKED"):
# it gives every sub-file's bounds, a battle sub-file starts with its zone object, and
# with the object's three pointers plus the sub-file's own length the file<->vaddr delta
# K is over-determined — 49 of 61 sampled sub-files resolve to exactly ONE K and none to
# more than one. (The 12 that don't are zones with no spawn slots, e.g. Budehuc's castle
# maps, which have nothing to edit anyway.)
import re as _re2

_ZNAME_HEAD = _re2.compile(rb"^[a-z][a-z0-9_]{3,11}\x00")

def battle_subfiles(f):
    """[(archive, iso offset, byte length)] for every sub-file that starts with a zone object."""
    try:
        sys.path.insert(0, HERE)
        import build_room_index as R
    except Exception:
        return []
    out = []
    for name, files in R.directories(R.fsect_words(f)).items():
        base = R.FILES[name][0]
        for sect, size in files:
            off = base + sect * 2048
            f.seek(off)
            head = f.read(0x20)
            if len(head) < 0x20:
                continue
            w = struct.unpack_from("<4I", head)
            if w[3] == 0 and _ZNAME_HEAD.match(head[0x10:0x1C]) and \
               all(0x00100000 <= x <= 0x02000000 for x in w[:3]):
                out.append((name, off, size * 2048))
    return out


def solve_k(buf):
    """The one K that makes a battle sub-file's zone object resolve inside itself, or None.

    K is bounded on both sides — every pointer must land inside the sub-file — so the
    search is a few thousand candidates, and the slot/formation counts plus the slot
    monster ids reject all but the right one. Ambiguity has not been observed; if it ever
    happens we return None rather than pick, per correct-or-absent."""
    L = len(buf)
    if L < 0x20:
        return None
    u32 = lambda o: struct.unpack_from("<I", buf, o)[0]
    slv, pav, exv = u32(0), u32(4), u32(8)
    if u32(12) != 0:
        return None
    found = []
    for K in range(max(slv, pav, exv) - L + 8, min(slv, pav, exv) + 1, 4):
        sf, pf = slv - K, pav - K
        if not (0 <= sf <= L - 8 and 0 <= pf <= L - 8):
            continue
        scnt, sarr = u32(sf), u32(sf + 4)
        pcnt, parr = u32(pf), u32(pf + 4)
        if not (1 <= scnt <= 32 and 1 <= pcnt <= 64):
            continue
        sao, pao = sarr - K, parr - K
        if not (0 <= sao and sao + scnt * 0x14 <= L and 0 <= pao and pao + pcnt * 0x1C <= L):
            continue
        ok = True
        for i in range(scnt):
            mid, var = u32(sao + i * 0x14), u32(sao + i * 0x14 + 4)
            if not ((0x1F5 <= mid <= 0x257) or (1 <= mid <= 0xD7)) or var > 7:
                ok = False
                break
        if ok:
            found.append(K)
            if len(found) > 1:
                return None
    return found[0] if found else None


def fsect_zone_copies(f, monster_ids):
    """Every zone FSECT can see, decoded from its own sub-file. -> {archive: [zone, ...]}"""
    out = collections.defaultdict(list)
    for arch, off, size in battle_subfiles(f):
        f.seek(off)
        buf = f.read(size)
        K = solve_k(buf)
        if K is None:
            continue
        # solve_k returns vaddr - offsetWithinSubfile; parse_zones wants fileAbs - vaddr.
        for z in parse_zones(f, off, off + size, off - K, monster_ids):
            out[arch].append(z)
    return out


def augment_copies(f, out_packs, extra):
    """Add the copies the fingerprint pass never saw to each zone's write-through list.

    A copy is only accepted if its slot AND formation spans are byte-identical to the
    reference copy's — chapter variants of the same map legitimately differ, and writing
    one area's edit into another's bytes would be worse than missing the copy."""
    def span(o, n):
        f.seek(o)
        return f.read(n)
    added = zones_touched = 0
    for p in out_packs:
        pool = extra.get(p["archive"], [])
        if not pool:
            continue
        for z in p["zones"]:
            ref_s = span(z["slots"][0]["off"][0], 0x14 * len(z["slots"]))
            ref_p = span(z["parties"][0]["off"][0], 0x1C * len(z["parties"]))
            known = set(z["slots"][0]["off"])
            gained = 0
            for cand in pool:
                if cand["name"] != z["name"] or len(cand["slots"]) != len(z["slots"]) \
                   or len(cand["parties"]) != len(z["parties"]):
                    continue
                s0 = cand["slots"][0]["off"]
                if s0 in known:
                    continue
                if span(s0, len(ref_s)) != ref_s:
                    continue
                if span(cand["parties"][0]["off"], len(ref_p)) != ref_p:
                    continue
                d = s0 - z["slots"][0]["off"][0]
                for i, sl in enumerate(z["slots"]):
                    sl["off"].append(sl["off"][0] + d)
                for i, pa in enumerate(z["parties"]):
                    pa["off"].append(pa["off"][0] + d)
                    pa["memOff"].append(pa["memOff"][0] + d)
                known.add(s0)
                gained += 1
            if gained:
                zones_touched += 1
                added += gained
    return added, zones_touched


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
    zone_pool = {}
    for cl in clusters_of(hits):
        arch = archive_of(cl[0])
        if arch is None:
            continue   # ELF-resident cluster (different record type) or unknown region
        # A region can hold SEVERAL streaming copies whose fingerprints merged into
        # one cluster (copies < 0x8000 apart, e.g. MORI). Each copy has its own K, so
        # peel them off one at a time: decode with the best K, drop the record hits
        # that copy explains, and re-vote until nothing decodes.
        remaining = list(cl)
        seen_ks = set()
        for _pass in range(8):
            nodes, K, lo, hi = parse_cluster(f, remaining, monster_ids, exclude_ks=seen_ks)
            if not nodes:
                break
            seen_ks.add(K)
            packs.append({"archive": arch, "nodes": nodes, "K": K, "lo": lo, "hi": hi, "zones": []})
            for z in parse_zones(f, max(0, lo - 0x80000), hi + 0x80000, K, monster_ids):
                z["K"] = K
                zone_pool.setdefault(z["off"], z)
            explained = set()
            for n in nodes:
                for v in n["variants"]:
                    explained.add(v["off"] + R_HP)
            remaining = [h for h in remaining if h not in explained]
            if not remaining:
                break   # dedupe by absolute position
    # each zone attaches to exactly ONE cluster-pack: the nearest one decoded with
    # the same K (same physical copy), so overlapping scan windows can't duplicate
    # zones or fragment the byte-identical-copy merge below.
    for z in zone_pool.values():
        cands = [p for p in packs if p["K"] == z["K"] and p["lo"] - 0x80000 <= z["off"] <= p["hi"] + 0x80000]
        if not cands:
            continue
        best = min(cands, key=lambda p: min(abs(z["off"] - p["lo"]), abs(z["off"] - p["hi"])))
        best["zones"].append(z)
    print(f"decoded packs: {len(packs)}  nodes: {sum(len(p['nodes']) for p in packs)}  zones: {sum(len(p['zones']) for p in packs)}")

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
        # Zones: copies are byte-identical, so a zone found in ANY copy exists in every
        # copy at (off + copy delta). Normalize to copy 0, dedupe, then derive per-copy
        # offsets and BYTE-VERIFY each derived span; a pack whose verification fails
        # ships without zones rather than with wrong offsets.
        # copy deltas come straight from each copy's file<->vaddr K: node OBJECTS can
        # alias across copies (byte-identical regions validate under every copy's K),
        # so node positions are NOT a reliable delta source — K differences are exact.
        deltas = [cp["K"] - base["K"] for cp in copies]
        norm = {}
        for ci, cp in enumerate(copies):
            for z in cp["zones"]:
                norm.setdefault(z["off"] - deltas[ci], z)
        def span(off0, length):
            f.seek(off0); return f.read(length)
        zones = []
        zseen = set()
        for zoff0 in sorted(norm):
            z = norm[zoff0]
            # rebase the zone's inner offsets to copy-0 coordinates
            zdelta0 = zoff0 - z["off"]
            # A zone is written through only to the copies whose bytes actually match:
            # packs merged on identical MONSTER data can still differ in zone data
            # (chapter variants of the same area), so per-zone copy matching is the
            # correct-or-absent rule here.
            ref_slots = span(z["slots"][0]["off"], 0x14 * len(z["slots"]))
            ref_parties = span(z["parties"][0]["off"], 0x1C * len(z["parties"]))
            okd = [d for d in deltas
                   if span(z["slots"][0]["off"] + zdelta0 + d, len(ref_slots)) == ref_slots
                   and span(z["parties"][0]["off"] + zdelta0 + d, len(ref_parties)) == ref_parties]
            if not okd:
                continue
            slots = [{"id": s["id"], "variant": s["variant"],
                      "off": [s["off"] + zdelta0 + d for d in okd]} for s in z["slots"]]
            parties = [{"type": pa["type"], "prob": pa["prob"], "formId": pa["formId"],
                        "members": pa["members"],
                        "off": [pa["off"] + zdelta0 + d for d in okd],
                        "memOff": [pa["memOff"] + zdelta0 + d for d in okd]} for pa in z["parties"]]
            # several zone HEADERS can point at the same slot/party arrays (in-file
            # duplicates); the data offsets are the identity, so dedupe on those.
            zkey = (z["name"], slots[0]["off"][0], parties[0]["off"][0])
            if zkey in zseen:
                continue
            zseen.add(zkey)
            zones.append({"name": z["name"], "slots": slots, "parties": parties})
        label = ", ".join(sorted({e["name"] for e in enemies})[:4])
        out_packs.append({"archive": base["archive"], "copies": len(copies),
                          "label": label, "enemies": enemies, "zones": zones})
    # FSECT pass: hand every zone the streaming copies the fingerprint could not reach.
    extra = fsect_zone_copies(f, monster_ids)
    n_extra = sum(len(v) for v in extra.values())
    added, touched = augment_copies(f, out_packs, extra)
    print(f"FSECT battle sub-files decoded: {n_extra} zones; "
          f"added {added} previously-missed copy(ies) across {touched} zone(s)")

    out_packs.sort(key=lambda p: (p["archive"], p["label"]))
    total_v = sum(len(e["variants"]) for p in out_packs for e in p["enemies"])
    total_z = sum(len(p["zones"]) for p in out_packs)
    total_pa = sum(len(z["parties"]) for p in out_packs for z in p["zones"])
    print(f"logical packs: {len(out_packs)}  variants: {total_v}  zones: {total_z}  formations: {total_pa}")
    out = {"format": "s3enemy", "version": 1, "game": "SLUS-20387",
           "recLayout": {"hp": R_HP, "maxhp": R_MAXHP, "lv": R_LV, "stats": R_STATS, "size": REC},
           "auxLayout": {"exp": A_EXP, "sp": A_SP, "mark": A_MARK, "potch": A_POTCH,
                         "drops": A_DROPS, "nDrops": N_DROPS, "size": AUX},
           "zoneLayout": {"slotSize": 0x14, "slotId": 0, "slotVariant": 4,
                          "partySize": 0x1C, "partyType": 0, "partyProb": 2,
                          "partyFormId": 0x10, "partyCount": 0x12},
           "packs": out_packs}
    dst = os.path.join(HERE, "s3_enemy_packs.json")
    json.dump(out, open(dst, "w"), separators=(",", ":"))
    print(f"wrote {dst} ({os.path.getsize(dst):,} bytes)")

if __name__ == "__main__":
    main()
