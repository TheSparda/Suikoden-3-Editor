#!/usr/bin/env python3
"""Does a live object's walk/run speed match the ISO's movement-speed table?

Written for one open question left by `docs/MOVEMENT_SPEED_RESEARCH.md`. The table at ISO
`0x3B0BE0` is copied into every object at creation, but the **battle** unit spawner
(`0x17ddf70`) overwrites both speeds from the character's *loaded battle asset* — packed,
compressed archive data that cannot be read off the disc without a codec nobody here has.
So two things are unverified on paper:

  1. that a **field** object really does carry the table's values (nothing overwrites it, but
     that is an argument, not a measurement), and
  2. whether the battle asset happens to hold the **same** numbers or different ones.

Both are one memory read away in a live game, which is what this does. It finds every object
in EE RAM that looks like an EOBJ, reads its walk/run/time-scale, and compares them to what
the ISO's table says that model should have.

    python3 -m tools.pcsx2.spdprobe                    # attach to PCSX2, snapshot, scan
    python3 -m tools.pcsx2.spdprobe --dump ram.bin     # scan an EE RAM image already on disk
    python3 -m tools.pcsx2.spdprobe --iso /path/to.iso # where to read the expected table from

**Stand in a field map and run it, then start a battle and run it again.** The field pass
should report every object MATCHES; if the battle pass reports DIFFERS, the asset carries its
own numbers and battle movement is genuinely not editable from the table. If the battle pass
also matches, the two systems agree and the table's numbers describe battle movement too.

Nothing is written; every access is a read.

The EOBJ fields used, all from MOVEMENT_SPEED_RESEARCH.md §3 and §5:

    +0x00  u16  model id            +0x2C   f32  time scale
    +0x02  u16  object kind         +0x248  f32  walk speed
    +0x0E  u16  motion slot         +0x24C  f32  run speed
    +0x4C  f32  position x/y/z      +0x250  u32  ride partner (0 = not mounted)

There is no signature word to key on, so the scan is a conjunction of range checks over all
of those. That admits false positives in principle; every hit is printed with its address and
raw values so a bogus one is visible rather than quietly averaged into the verdict.
"""
import argparse
import math
import os
import struct
import sys

# ---- where the expected values live on the disc ------------------------------
# ISO offsets; see docs/MOVEMENT_SPEED_RESEARCH.md and Editor/Suikoden3_ISO_offsets.md.
SPD_TABLE = 0x3B0BE0        # 14 x {u32 modelId, f32 walk, f32 run, f32 animRate}
SPD_ROWS = 14
SPD_STRIDE = 16
MODEL_INDEX = 0x3B0FA8      # byte table: model id -> list2 record index
LIST2 = 0x3E1338            # list2 record 0
LIST2_STRIDE = 132
CLASS_OFF = 0x78            # u8 movement class inside the list2 record

# ---- EOBJ layout ------------------------------------------------------------
O_MODEL, O_KIND, O_SLOT = 0x00, 0x02, 0x0E
O_RATE, O_POS, O_WALK, O_RUN, O_PARTNER = 0x2C, 0x4C, 0x248, 0x24C, 0x250
EOBJ_MIN = 0x254            # bytes we must be able to read past the base

EE_BASE = 0x00100000        # plausible EE pointer window, for the partner sanity check
EE_TOP = 0x02000000

# Lower bounds that matter more than they look. `> 0.0` is not a filter: a random word is
# very often a *denormal* float, which is positive, finite and prints as 0.000 — 11,016 of
# them passed on a 32 MB image before these bounds went in. Stock walk is 2.0 and the
# slowest stock run is 4.5, so nothing real is anywhere near these floors.
SPEED_MIN, SPEED_MAX = 0.05, 200.0
RATE_MIN, RATE_MAX = 0.01, 10000.0      # the engine clamps the rate at 10000 (0x16F5788)
POS_MAX = 1e6

# The boot ELF's own image in EE RAM. Static tables in here match the range checks by
# coincidence — two of them do, on a real image — so hits landing inside are labelled and
# left out of the verdict rather than filtered away, which would risk hiding a real object.
# Deliberately the FILE image (p_filesz), not p_memsz: if the engine allocates objects from a
# static pool in .bss, that pool sits past this bound and stays visible.
ELF_IMAGE_LO = 0x0165D000
ELF_IMAGE_HI = ELF_IMAGE_LO + 0x38D430


def _f32(buf, off):
    return struct.unpack_from("<f", buf, off)[0]


def _finite(v, lo, hi):
    return math.isfinite(v) and lo < v <= hi


# ---- expected values, read off the ISO ---------------------------------------
class Expected:
    """The ISO's answer for a model id: which class it is in and that class's speeds."""

    def __init__(self, iso_path):
        with open(iso_path, "rb") as f:
            f.seek(SPD_TABLE)
            tbl = f.read(SPD_ROWS * SPD_STRIDE)
            f.seek(MODEL_INDEX)
            self.index = f.read(0x100)
            f.seek(LIST2)
            self.list2 = f.read(80 * LIST2_STRIDE)
        self.rows = []
        for c in range(SPD_ROWS):
            o = c * SPD_STRIDE
            self.rows.append((_f32(tbl, o + 4), _f32(tbl, o + 8), _f32(tbl, o + 12)))

    def klass(self, model_id):
        """Re-run GetModelClass (0x16C7310) over the disc's bytes. None = no record."""
        if not 1 <= model_id <= 0xD8:
            return 0                      # no record -> class 0
        if model_id < 0x53 or model_id in (0xCA, 0xCB, 0xD7):
            rec = self.index[model_id]
        elif 0xD2 <= model_id <= 0xD5:
            rec = model_id - 0x86
        else:
            return 0                      # GetModelRecord returns NULL -> class 0
        if rec >= 80:
            return None
        return self.list2[rec * LIST2_STRIDE + CLASS_OFF]

    def speeds(self, model_id):
        """(walk, run, rate) the table says this model should get, or None."""
        c = self.klass(model_id)
        if c is None or c >= SPD_ROWS:
            return None
        return self.rows[c]


# ---- the scan ----------------------------------------------------------------
def scan(ram, expected, limit=0):
    """Every EOBJ-shaped record in `ram`, as dicts. Cheapest test first."""
    out = []
    n = len(ram) - EOBJ_MIN
    unpack_u32 = struct.Struct("<I").unpack_from
    for base in range(0, n, 4):
        head = unpack_u32(ram, base)[0]
        model, kind = head & 0xFFFF, head >> 16
        if not (1 <= model <= 0x1F4 and kind <= 8):
            continue
        slot = struct.unpack_from("<H", ram, base + O_SLOT)[0]
        if slot > 0x13B:
            continue
        walk = _f32(ram, base + O_WALK)
        run = _f32(ram, base + O_RUN)
        if not (_finite(walk, SPEED_MIN, SPEED_MAX) and _finite(run, SPEED_MIN, SPEED_MAX)):
            continue
        rate = _f32(ram, base + O_RATE)
        if not _finite(rate, RATE_MIN, RATE_MAX):
            continue
        pos = [_f32(ram, base + O_POS + i * 4) for i in range(3)]
        if not all(math.isfinite(p) and abs(p) < POS_MAX for p in pos):
            continue
        partner = unpack_u32(ram, base + O_PARTNER)[0]
        if partner and not (EE_BASE <= partner < EE_TOP and partner % 4 == 0):
            continue
        exp = expected.speeds(model)
        out.append({
            "addr": base, "model": model, "kind": kind, "slot": slot,
            "walk": walk, "run": run, "rate": rate,
            "mounted": bool(partner), "expected": exp,
            "static": ELF_IMAGE_LO <= base < ELF_IMAGE_HI,
            "match": exp is not None
                     and abs(walk - exp[0]) < 1e-4 and abs(run - exp[1]) < 1e-4,
        })
        if limit and len(out) >= limit:
            break
    return out


def live(hits):
    """The hits that can be live objects — everything outside the executable's own image."""
    return [h for h in hits if not h["static"]]


def verdict(hits):
    """One line saying what the scan means, plus the counts behind it."""
    known = [h for h in live(hits) if h["expected"] is not None]
    if not known:
        return "no objects found — is a map or battle actually loaded?", 0, 0
    m = sum(1 for h in known if h["match"])
    d = len(known) - m
    if d == 0:
        msg = ("every object carries the ISO table's values — the table is live here")
    elif m == 0:
        msg = ("NO object carries the table's values — something overwrote all of them "
               "(in a battle, that is the spawner reading the character's battle asset)")
    else:
        msg = ("mixed: %d match the table, %d were overwritten — compare the model ids, the "
               "overwritten ones are the ones whose speeds do not come from the table" % (m, d))
    return msg, m, d


def report(hits, show_all=False):
    msg, m, d = verdict(hits)
    statics = len(hits) - len(live(hits))
    print("%d live EOBJ-shaped object(s); %d match the ISO table, %d differ%s\n"
          % (len(live(hits)), m, d,
             "" if not statics else "  (+%d static hit(s) inside the ELF image, ignored)" % statics))
    rows = hits if show_all else [h for h in hits if h["expected"] is not None]
    print("   address    model kind slot   walk    run   scale   table walk/run   ")
    print("  ---------- ------ ---- ---- ------ ------ ------- ----------------- ---")
    for h in sorted(rows, key=lambda x: (x["static"], x["model"])):
        exp = h["expected"]
        etxt = "  —  /  —  " if exp is None else "%5.2f / %5.2f" % (exp[0], exp[1])
        note = " (ELF image — static data)" if h["static"] else (" (mounted)" if h["mounted"] else "")
        print("  0x%08X %6d %4d %4X %6.2f %6.2f %7.3f  %s  %s%s"
              % (h["addr"], h["model"], h["kind"], h["slot"], h["walk"], h["run"], h["rate"],
                 etxt, "-      " if h["static"] else ("MATCH " if h["match"] else "DIFFERS"), note))
    print("\n%s" % msg)


# ---- ram acquisition ---------------------------------------------------------
def _ram_from_emulator(slot, retries):
    from . import harness
    emu = harness.Pcsx2().attach(retries=retries)
    try:
        return emu.snapshot_ee(slot=slot)
    finally:
        emu.stop()


def _default_iso():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    env = os.environ.get("S3_ISO")
    if env and os.path.isfile(env):
        return env
    d = os.path.join(repo, "ISO")
    # In a git worktree the ISO folder only exists in the main checkout; follow .git.
    if not os.path.isdir(d):
        try:
            with open(os.path.join(repo, ".git")) as f:
                gitdir = f.read().strip().split(":", 1)[1].strip()
            d = os.path.join(os.path.abspath(os.path.join(gitdir, "..", "..", "..")), "ISO")
        except Exception:
            pass
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if name.lower().endswith(".iso"):
                return os.path.join(d, name)
    return None


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dump", help="scan this EE RAM image instead of attaching to PCSX2")
    p.add_argument("--iso", help="ISO to read the expected table from")
    p.add_argument("--slot", type=int, default=99, help="savestate slot to snapshot through")
    p.add_argument("--retries", type=int, default=0)
    p.add_argument("--all", action="store_true", help="also list objects with no table entry")
    args = p.parse_args(argv)

    iso = args.iso or _default_iso()
    if not iso:
        print("no ISO found — pass --iso; the expected values are read off the disc.")
        return 2
    expected = Expected(iso)

    if args.dump:
        with open(args.dump, "rb") as f:
            ram = f.read()
    else:
        try:
            ram = _ram_from_emulator(args.slot, args.retries)
        except Exception as e:                       # no PCSX2 / no PINE / no BIOS
            print("could not read EE RAM: %s" % e)
            print("Run PCSX2 with PINE enabled and a map or battle loaded, or pass "
                  "--dump after `python3 -m tools.pcsx2.cli snapshot ram.bin`.")
            return 77                                # 77 = skip, as elsewhere in this harness
    print("scanning %.1f MB of EE RAM against %s\n" % (len(ram) / 1048576.0, os.path.basename(iso)))
    report(scan(ram, expected), show_all=args.all)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
