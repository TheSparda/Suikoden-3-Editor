#!/usr/bin/env python3
"""Reverse-engineering helpers for the Suikoden III boot ELF, read straight out of the ISO.

Research tooling, not part of either editor — the editors work in file offsets and never
need this. It exists because every round of RE on this disc re-derives the same three
things, and one of them (the vaddr mapping) is easy to get subtly wrong: the ELF's PT_LOAD
puts vaddr 0x165D000 at ISO 0xA4800, so `file = vaddr - 0x15B8800`. Disassembling at a
delta that is 8 too large lands you inside the *previous* function's epilogue, which reads
as a bare `jr $ra` and looks convincingly like a dead end.

    python3 Editor/re_elf.py dis    0x17B7750 0x40   # disassemble
    python3 Editor/re_elf.py xref   0x19BD7A0        # who materialises this address
    python3 Editor/re_elf.py callers 0x17B7750       # who jal's here
    python3 Editor/re_elf.py fields 0x17B7750        # map the struct a function returns

`fields` is the one that pays for itself: it walks every call site, tracks which registers
alias the returned $v0, and reports every offset loaded or stored through them. That is how
the 0x3C-byte room record was mapped from 17 scattered call sites (see
Suikoden3_ISO_offsets.md, "Per-area encounter rates").

Needs capstone (`pip install capstone`). Capstone's MIPS32 mode does not know the R5900's
64-bit and quadword ops, so the handful this code actually uses is decoded here instead of
ending a listing early.
"""
import sys, os, struct, collections

ELF_HDR_ISO = 0xA3800          # \x7fELF in the ISO
PT_LOAD_ISO = 0xA4800          # PT_LOAD p_offset, as an ISO offset
PT_LOAD_VA = 0x165D000         # ...and its vaddr
PT_LOAD_SZ = 0x38D430          # p_filesz
DELTA = PT_LOAD_VA - PT_LOAD_ISO                       # 0x15B8800

REG = ["zero", "at", "v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3",
       "t4", "t5", "t6", "t7", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7",
       "t8", "t9", "k0", "k1", "gp", "sp", "fp", "ra"]
MEM_OPS = {"lb", "lbu", "lh", "lhu", "lw", "lwu", "ld", "lwc1", "ldc1",
           "sb", "sh", "sw", "sd", "swc1", "sdc1"}


def iso_path():
    """The pristine ISO — argv[-1] if it looks like a path, else the repo's ISO/ folder."""
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[-1]):
        return sys.argv[-1]
    here = os.path.dirname(os.path.abspath(__file__))
    d = os.path.join(os.path.dirname(here), "ISO")
    if os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            if n.lower().endswith(".iso"):
                return os.path.join(d, n)
    sys.exit("no ISO found — pass one as the last argument")


def load():
    """The whole PT_LOAD segment, plus a va->offset helper."""
    with open(iso_path(), "rb") as f:
        f.seek(PT_LOAD_ISO)
        return f.read(PT_LOAD_SZ)


def verify(buf):
    """Re-derive DELTA from the ELF header rather than trusting the constant."""
    with open(iso_path(), "rb") as f:
        f.seek(ELF_HDR_ISO)
        hdr = f.read(0x34)
        if hdr[:4] != b"\x7fELF":
            sys.exit("no ELF header at ISO 0x%X — not a USA SLUS-20387 image?" % ELF_HDR_ISO)
        phoff = struct.unpack_from("<I", hdr, 0x1C)[0]
        f.seek(ELF_HDR_ISO + phoff)
        _, p_off, p_va = struct.unpack("<3I", f.read(12))
    got = p_va - (ELF_HDR_ISO + p_off)
    if got != DELTA:
        sys.exit(f"ELF says delta {got:X}, this file assumes {DELTA:X}")


# ---- R5900 ops capstone's MIPS32 rejects -------------------------------------
def r5900(w):
    op, rs, rt, rd, funct = w >> 26, (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31, w & 63
    imm = w & 0xFFFF
    simm = imm - 0x10000 if imm & 0x8000 else imm
    if op == 0 and funct == 0x2D:                       # daddu — the 64-bit `move`
        return (f"move       ${REG[rd]}, ${REG[rs]}" if rt == 0
                else f"daddu      ${REG[rd]}, ${REG[rs]}, ${REG[rt]}")
    if op == 0 and funct == 0x2F:
        return f"dsubu      ${REG[rd]}, ${REG[rs]}, ${REG[rt]}"
    for code, name in ((0x19, "daddiu"), (0x1F, "sq"), (0x1E, "lq"), (0x3F, "sd"), (0x37, "ld")):
        if op == code:
            if name in ("daddiu",):
                return f"{name:<10s} ${REG[rt]}, ${REG[rs]}, {simm:#x}"
            return f"{name:<10s} ${REG[rt]}, {simm:#x}(${REG[rs]})"
    return f".word      0x{w:08X}"


def disasm(buf, va, n):
    from capstone import Cs, CS_ARCH_MIPS, CS_MODE_MIPS32, CS_MODE_LITTLE_ENDIAN
    md = Cs(CS_ARCH_MIPS, CS_MODE_MIPS32 | CS_MODE_LITTLE_ENDIAN)
    off = va - DELTA - PT_LOAD_ISO
    for o in range(0, n, 4):
        w = struct.unpack_from("<I", buf, off + o)[0]
        got = list(md.disasm(buf[off + o:off + o + 4], va + o))
        if got:
            print(f"{got[0].address:08X}  {got[0].mnemonic:<10s} {got[0].op_str}")
        else:
            print(f"{va + o:08X}  {r5900(w)}")


def callers(buf, target):
    """Every jal/j to target, as VAs."""
    want_jal = 0x0C000000 | ((target >> 2) & 0x03FFFFFF)
    want_j = 0x08000000 | ((target >> 2) & 0x03FFFFFF)
    out = []
    for o in range(0, len(buf) - 4, 4):
        w = struct.unpack_from("<I", buf, o)[0]
        if w in (want_jal, want_j):
            out.append(PT_LOAD_ISO + o + DELTA)
    return out


def xref(buf, target, window=16):
    """Code that materialises an address via the lui+addiu/ori/load idiom."""
    n = len(buf) // 4
    words = struct.unpack(f"<{n}I", buf[:n * 4])
    lui, hits = {}, []
    for i, w in enumerate(words):
        op, rs, rt = w >> 26, (w >> 21) & 31, (w >> 16) & 31
        imm = w & 0xFFFF
        simm = imm - 0x10000 if imm & 0x8000 else imm
        if op == 0x0F:
            lui[rt] = (imm << 16, i)
            continue
        base = lui.get(rs)
        if not base or i - base[1] > window:
            continue
        val = (base[0] | imm) if op == 0x0D else base[0] + simm
        if val == target:
            hits.append(PT_LOAD_ISO + i * 4 + DELTA)
    return hits


def fields(buf, target, span=0x100):
    """Map the struct a function returns, from every call site at once.

    Tracks registers aliasing the returned $v0 (through `move`) and reports every
    load/store offset seen through them. Deliberately crude — a register is dropped the
    moment anything else writes it — so the output is a candidate field list to read with
    judgement, not a decompilation. Offsets far outside the struct are the tracker losing
    an alias; the useful signal is the dense low-offset cluster.
    """
    from capstone import Cs, CS_ARCH_MIPS, CS_MODE_MIPS32, CS_MODE_LITTLE_ENDIAN
    md = Cs(CS_ARCH_MIPS, CS_MODE_MIPS32 | CS_MODE_LITTLE_ENDIAN)
    sites = callers(buf, target)
    seen = collections.defaultdict(list)
    for site in sites:
        alias = set()
        for o in range(4, span, 4):
            va = site + o
            off = va - DELTA - PT_LOAD_ISO
            if not (0 <= off < len(buf) - 4):
                break
            w = struct.unpack_from("<I", buf, off)[0]
            op, rs, rt, rd, funct = w >> 26, (w >> 21) & 31, (w >> 16) & 31, (w >> 11) & 31, w & 63
            imm = w & 0xFFFF
            simm = imm - 0x10000 if imm & 0x8000 else imm
            if op == 0 and funct == 0x2D:                    # move rd, rs
                if rs in alias or rs == 2:
                    alias.add(rd)
                else:
                    alias.discard(rd)
                continue
            ins = list(md.disasm(buf[off:off + 4], va))
            m = ins[0].mnemonic if ins else ""
            if m in MEM_OPS and (rs in alias or rs == 2):
                seen[simm].append((va, m))
                if m.startswith("l") and rt == 2:
                    alias.discard(2)
                continue
            if m in ("jal", "jalr", "j"):
                alias.discard(2)
            if op == 0 and rd in alias and rd != 0:
                alias.discard(rd)
            elif op in (8, 9, 0x19, 0x0C, 0x0D, 0x24, 0x25, 0x0F) and rt in alias:
                alias.discard(rt)
    print(f"struct returned by {target:08X} — {len(sites)} call site(s)\n")
    for off in sorted(seen):
        kinds = collections.Counter(m for _, m in seen[off])
        where = ", ".join(f"{va:08X}" for va, _ in seen[off][:6])
        print(f"  +0x{off:02X}  {dict(kinds)}  @ {where}")


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, arg = sys.argv[1], int(sys.argv[2], 16)
    buf = load()
    verify(buf)
    if cmd == "dis":
        n = int(sys.argv[3], 16) if len(sys.argv) > 3 and sys.argv[3].startswith("0x") else 0x80
        disasm(buf, arg, n)
    elif cmd == "callers":
        for va in callers(buf, arg):
            print(f"  jal/j from VA {va:08X}  (file {va - DELTA:08X})")
    elif cmd == "xref":
        for va in xref(buf, arg):
            print(f"  referenced at VA {va:08X}  (file {va - DELTA:08X})")
    elif cmd == "fields":
        fields(buf, arg)
    else:
        sys.exit(f"unknown command {cmd!r}")


if __name__ == "__main__":
    main()
