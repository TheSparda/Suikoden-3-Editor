#!/usr/bin/env python3
"""Read Suikoden III's event scripts (EDS) straight out of the disc.

The event data everyone assumes is out of reach isn't compressed — the `DATA/*.BIN` area
archives are plain bytes, which is how clip and asset names were grepped out of them. What
was missing was the *encoding*, so a raw opcode search returned pure noise
(MOUNT_SYSTEM_RESEARCH.md §9 tried exactly that and gave up). This recovers the encoding
from the interpreter itself and uses it to validate candidate bytes by chaining, which is
what turns noise into signal.

    python3 Editor/eds_dis.py lens                     # opcode -> instruction length
    python3 Editor/eds_dis.py dis   0x3A2C1000 40      # disassemble 40 instructions there
    python3 Editor/eds_dis.py scan  AKMT               # find script blobs in an archive
    python3 Editor/eds_dis.py find  346 1              # every `op 346, param 1` on the disc

How the encoding was recovered, so it can be re-checked rather than trusted:

  * The interpreter (`0x1778768` / `0x1778D78`) indexes a 359-entry handler table at
    `0x19828F8`, so `opcode = (handler - 0x19828F8) / 4`.
  * Every handler reads its operands through the script pointer at `ctx + 0x0C`
    (`lw rX, 0xc(rY)`) and writes it back advanced by a constant
    (`addiu rZ, rX, N` ... `sw rZ, 0xc(rY)`). **That constant is the instruction length.**
    240 of the 359 opcodes give one up this way, and every recovered length is even, which
    is the consistency check that says the reading is right rather than merely plausible.

An opcode whose length could not be recovered is a hard stop for the chainer — better a
short honest disassembly than a long invented one.
"""
import json
import os
import struct
import sys

import re_elf

HANDLERS = 0x19828F8
N_OPS = 359

# Opcodes identified while chasing the field-avatar work. Names are a convenience; an
# unnamed opcode is still fully identified by its number.
NAMES = {
    22: "RideOnSetS", 24: "RideOffSetS", 26: "ActorList", 27: "ActorList",
    40: "ResolveActor(0=player)", 55: "CameraTarget", 56: "CameraTarget",
    63: "TeamDispatch", 64: "TeamDispatch", 82: "TeamDispatch", 83: "TeamDispatch",
    88: "LeaderToActorRecord", 108: "HorseDashSetS", 109: "HorseInanakiE",
    310: "LeaderCharQuery", 324: "PlayerObjCompare", 345: "AvatarModelReq",
    346: "SetFieldAvatar",
}

# How a script names an actor: bits 10-13 pick a namespace, low 10 bits an index.
# Decoder at 0x17B5A40 (186 call sites).
def actor_str(v):
    if v & 0x8000:
        return f"none({v:#06x})"
    ns, idx = v & 0x3C00, v & 0x3FF
    kind = {0x0000: "slot", 0x0400: "charId", 0x0800: "objA", 0x0C00: "objB",
            0x1000: "indirect", 0x1400: "PLAYER", 0x1800: "partyPos"}.get(ns)
    if kind is None:
        return f"{v:#06x}"
    return "PLAYER" if kind == "PLAYER" else f"{kind}:{idx}"


def op_lengths(buf):
    """opcode -> instruction length in bytes, recovered from each handler's ip advance."""
    def w(va):
        o = va - re_elf.DELTA - re_elf.PT_LOAD_ISO
        return struct.unpack_from("<I", buf, o)[0] if 0 <= o < len(buf) - 4 else None

    ents = [w(HANDLERS + i * 4) for i in range(N_OPS)]
    lens = {}
    for op, h in enumerate(ents):
        if not h or not (0x165D000 <= h < 0x19EA430):
            continue
        ipreg = cand = None
        for k in range(0, 0x120, 4):
            x = w(h + k)
            if x is None:
                break
            o, rs, rt, imm = x >> 26, (x >> 21) & 31, (x >> 16) & 31, x & 0xFFFF
            simm = imm - 0x10000 if imm & 0x8000 else imm
            if o == 0x23 and imm == 0x0C:                       # lw rt, 0xc(rs)
                ipreg = rt
            elif o == 0x09 and ipreg is not None and rs == ipreg and 0 < simm <= 64:
                cand = (rt, simm)                                # addiu rt, ip, N
            elif o == 0x2B and imm == 0x0C and cand and rt == cand[0]:
                lens[op] = cand[1]                               # sw rt, 0xc(rs)
                break
            elif x == 0x03E00008:
                break
    return lens, ents


def chain(data, off, lens, limit=4096):
    """Walk instructions from `off`. Returns [(offset, op, params)] until it stops making
    sense — an unknown opcode, an unrecovered length, or the end of the buffer."""
    out = []
    while len(out) < limit and off + 2 <= len(data):
        op = struct.unpack_from("<H", data, off)[0]
        if op >= N_OPS or op not in lens:
            break
        n = lens[op]
        if off + n > len(data):
            break
        params = list(struct.unpack_from(f"<{(n - 2) // 2}H", data, off + 2)) if n > 2 else []
        out.append((off, op, params))
        off += n
    return out


def iso_path():
    return re_elf.iso_path()


def archives():
    here = os.path.dirname(os.path.abspath(__file__))
    return json.load(open(os.path.join(here, "s3_subfiles.json")))["archives"]


def cmd_lens(argv):
    buf = re_elf.load()
    lens, _ = op_lengths(buf)
    print(f"{len(lens)}/{N_OPS} opcodes have a recoverable instruction length")
    hist = {}
    for v in lens.values():
        hist[v] = hist.get(v, 0) + 1
    print("lengths:", dict(sorted(hist.items())))
    odd = [op for op, n in lens.items() if n % 2]
    print("odd-length opcodes (should be none):", odd or "none")
    for op in sorted(NAMES):
        print(f"  op {op:3} {NAMES[op]:24} {lens.get(op, '?')} bytes")


def cmd_dis(argv):
    off, n = int(argv[0], 0), int(argv[1]) if len(argv) > 1 else 40
    buf = re_elf.load()
    lens, _ = op_lengths(buf)
    with open(iso_path(), "rb") as f:
        f.seek(off)
        data = f.read(n * 24 + 64)
    ins = chain(data, 0, lens, n)
    print(f"{len(ins)} instruction(s) chained from {off:#x}")
    for o, op, ps in ins:
        nm = NAMES.get(op, "")
        ptxt = " ".join(f"{p:#06x}" for p in ps)
        act = " ".join(actor_str(p) for p in ps[:2]) if ps else ""
        print(f"  {off + o:08X}  op {op:3} {nm:24} [{ptxt}]  {act}")


def cmd_scan(argv):
    """Find runs of validly-chaining instructions inside an archive."""
    want = argv[0] if argv else None
    minrun = int(argv[1]) if len(argv) > 1 else 60
    buf = re_elf.load()
    lens, _ = op_lengths(buf)
    with open(iso_path(), "rb") as f:
        for a in archives():
            if want and a["archive"] != want:
                continue
            print(f"{a['archive']}: {a['size'] / 1e6:.1f} MB")
            base, size, best = a["base"], a["size"], []
            step = 1 << 22
            pos = 0
            while pos < size:
                f.seek(base + pos)
                data = f.read(min(step, size - pos))
                if not data:
                    break
                i = 0
                while i < len(data) - 2:
                    ins = chain(data, i, lens, 400)
                    if len(ins) >= minrun:
                        best.append((base + pos + i, len(ins), ins[-1][0] + 8))
                        i = ins[-1][0] + 8
                    else:
                        i += 2
                pos += len(data) - 64
            best.sort(key=lambda r: -r[1])
            for o, n, _e in best[:20]:
                print(f"    {o:010X}  {n} instructions")
            print(f"    ({len(best)} run(s) >= {minrun})")


def cmd_find(argv):
    """Every occurrence of `op [param]`, word-aligned, across the archives."""
    op = int(argv[0], 0)
    par = int(argv[1], 0) if len(argv) > 1 else None
    pat = struct.pack("<H", op) + (struct.pack("<H", par) if par is not None else b"")
    total = 0
    with open(iso_path(), "rb") as f:
        for a in archives():
            base, size, pos, hits = a["base"], a["size"], 0, []
            while pos < size:
                f.seek(base + pos)
                data = f.read(min(1 << 26, size - pos))
                if not data:
                    break
                i = data.find(pat)
                while i != -1:
                    if (base + pos + i) % 2 == 0:
                        hits.append(base + pos + i)
                    i = data.find(pat, i + 1)
                pos += len(data) - 8
            if hits:
                total += len(hits)
                print(f"  {a['archive']:6} {len(hits):5}  e.g. {hits[0]:010X}")
    print(f"total {total}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    cmd, argv = sys.argv[1], [a for a in sys.argv[2:] if not os.path.isfile(a)]
    fn = {"lens": cmd_lens, "dis": cmd_dis, "scan": cmd_scan, "find": cmd_find}.get(cmd)
    if not fn:
        print(__doc__)
        return 2
    fn(argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
