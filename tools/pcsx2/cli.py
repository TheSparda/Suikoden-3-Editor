#!/usr/bin/env python3
"""Command line for the PCSX2 harness.

    python3 -m tools.pcsx2.cli doctor
    python3 -m tools.pcsx2.cli boot-verify "ISO/Suikoden III (USA).iso"
    python3 -m tools.pcsx2.cli snapshot hugo.ee
    python3 -m tools.pcsx2.cli diff hugo.ee chris.ee
    python3 -m tools.pcsx2.cli scan --changed hugo.ee chris.ee --unchanged hugo.ee hugo2.ee
    python3 -m tools.pcsx2.cli codes hugo.ee
    python3 -m tools.pcsx2.cli read 0x199C47C --width 4
    python3 -m tools.pcsx2.cli poke 0x199C47C 42 --width 1

Run it from the repo root (the package import needs the repo on sys.path); the
`doctor` and offline commands work with no emulator installed.
"""
import argparse
import os
import sys

if __package__ in (None, ""):  # allow `python3 tools/pcsx2/cli.py ...`
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    __package__ = "tools.pcsx2"

from . import eemap, harness, pine, ramscan, savestate  # noqa: E402

# The asset-name prefixes ETC.BIN uses (docs/ETC_BIN_MODEL_RESEARCH.md). If the loader
# keeps a resident name or index table, these are what it looks like in RAM.
ASSET_PREFIXES = ("cha_", "imf_", "ctx_", "face_", "walk_", "run_")


def _load(path):
    with open(path, "rb") as f:
        return f.read()


# -- commands ---------------------------------------------------------------


def cmd_doctor(args):
    rows = harness.doctor()
    width = max(len(label) for label, _, _ in rows)
    for label, ok, detail in rows:
        print("%s %-*s  %s" % ("ok  " if ok else "MISS", width, label, detail))
    missing = [label for label, ok, _ in rows if not ok]
    if missing:
        print("\nMissing: %s" % ", ".join(missing))
        print("Everything except 'pcsx2 binary' and 'game ISO' has an offline fallback;")
        print("see tools/pcsx2/README.md for what each one unlocks.")
    return 0


def cmd_boot_verify(args):
    """Boot the disc and prove the editor's tables reached RAM unchanged.

    This is the end-to-end check web/tests/README.md calls out as still manual: patch an
    ISO, boot it, and read the patched table back out of the running game.
    """
    iso = args.iso or next((p for p in eemap.default_iso_candidates() if p and os.path.exists(p)), None)
    if not iso or not os.path.exists(iso):
        print("no ISO given and none found; pass a path or set S3_ISO", file=sys.stderr)
        return 2
    if not harness.find_pcsx2():
        print("no PCSX2 binary found — set PCSX2_BIN. Skipping.", file=sys.stderr)
        return 77  # conventional "skipped", so CI can treat it as not-a-failure

    with harness.Pcsx2(iso=iso, turbo=True, log=args.log) as emu:
        serial = emu.wait_ready(timeout=args.timeout)
        print("booted %s (%s)" % (serial, emu.pine.title()))
        dump = emu.snapshot_ee()
        emap = eemap.calibrate(iso, dump)
        print("calibrated %r (doc constant was 0x%X)" % (emap, eemap.DEFAULT_DELTA))

        checks = [("version word", eemap.VERSION_CHECK_OFF, 4)]
        for name, (base, stride, _) in sorted(eemap.TABLES.items()):
            checks.append(("%s[0]" % name, base, min(stride, 64)))
        checks.append(("rune[0..3]", eemap.RUNE_TABLE_OFF, 4 * eemap.RUNE_TABLE_STRIDE))

        bad = 0
        with open(iso, "rb") as f:
            for label, off, length in checks:
                f.seek(off)
                want = f.read(length)
                addr = emap.to_ee(off)
                got = dump[addr:addr + length]
                same = want == got
                bad += 0 if same else 1
                print("  %-12s file 0x%-8X -> ee 0x%08X  %s" % (
                    label, off, addr, "match" if same else "MISMATCH"))
                if not same and args.verbose:
                    print("     iso: %s" % want.hex())
                    print("     ram: %s" % got.hex())
        if bad:
            print("\n%d region(s) differ between disc and RAM." % bad)
            print("That is the interesting case: either the game rewrites the table at "
                  "runtime, or the ELF is not loaded where we think it is.")
            return 1
        print("\nAll checked regions are byte-identical on disc and in RAM.")
        return 0


def cmd_snapshot(args):
    """Attach to a running PCSX2 and write its EE RAM to a file."""
    emu = harness.Pcsx2().attach(retries=args.retries)
    try:
        data = emu.snapshot_ee(slot=args.slot)
    finally:
        emu.stop()
    with open(args.out, "wb") as f:
        f.write(data)
    print("wrote %s (%d bytes)" % (args.out, len(data)))
    return 0


def cmd_diff(args):
    a, b = _load(args.a), _load(args.b)
    runs = ramscan.differing_runs(a, b, max_gap=args.gap)
    total = sum(n for _, n in runs)
    print("%d differing run(s), %d bytes total (%.3f%% of RAM)"
          % (len(runs), total, 100.0 * total / max(1, len(a))))
    runs.sort(key=lambda r: -r[1])
    for start, length in runs[:args.limit]:
        print("  0x%08X +%-6d %s" % (start, length, a[start:start + min(length, 16)].hex()))
    if len(runs) > args.limit:
        print("  ... %d more" % (len(runs) - args.limit))
    return 0


def cmd_scan(args):
    """Narrow candidates across snapshot pairs. The first pair seeds the set."""
    cache = {}

    def load(p):
        if p not in cache:
            cache[p] = _load(p)
        return cache[p]

    scanner = ramscan.Scanner(width=args.width)
    steps = [("changed", p) for p in (args.changed or [])] + \
            [("unchanged", p) for p in (args.unchanged or [])]
    if not steps:
        print("give at least one --changed A B", file=sys.stderr)
        return 2
    if steps[0][0] != "changed":
        print("the first step must be --changed (see ramscan.Scanner docs)", file=sys.stderr)
        return 2

    first = True
    for kind, (pa, pb) in steps:
        a, b = load(pa), load(pb)
        if first:
            scanner.first_changed(a, b)
            first = False
        elif kind == "changed":
            scanner.keep_changed(a, b)
        else:
            scanner.keep_unchanged(a, b)

    if args.min is not None or args.max is not None:
        lo = args.min if args.min is not None else 0
        hi = args.max if args.max is not None else (1 << (8 * args.width)) - 1
        scanner.keep_value_between(load(steps[0][1][0]), lo, hi)

    print(scanner.report(load(steps[0][1][0]), limit=args.limit))
    if args.out:
        with open(args.out, "w") as f:
            for addr in scanner.addresses():
                f.write("0x%08X\n" % addr)
        print("wrote %s" % args.out)
    return 0


def cmd_codes(args):
    """Hunt the model tables: find ETC.BIN asset names / 4-char codes in live RAM.

    docs/ETC_BIN_MODEL_RESEARCH.md stopped at "the game loads models by precomputed
    index/offset, and the offset table's location is not yet found". If the resident
    loader keeps names or an index array in RAM, it lands here — and any hit inside the
    ELF maps straight back to an ISO offset the editor could patch.
    """
    dump = _load(args.dump)
    emap = eemap.EeMap()
    if args.iso and os.path.exists(args.iso):
        try:
            emap = eemap.calibrate(args.iso, dump)
            print("calibrated %r" % emap)
        except eemap.CalibrationError as e:
            print("calibration failed (%s); using the documented delta" % e)

    needles = [n.encode("ascii") for n in (args.needle or ASSET_PREFIXES)]
    total = 0
    for needle in needles:
        hits = ramscan.find_bytes(dump, needle, limit=args.limit)
        total += len(hits)
        print("%-8s %d hit(s)" % (needle.decode(), len(hits)))
        for off in hits[:args.show]:
            text = dump[off:off + 16].split(b"\0", 1)[0].decode("ascii", "replace")
            try:
                where = "iso 0x%X" % emap.to_file(off)
            except ValueError:
                where = "not in ELF"
            print("   ee 0x%08X  %-18s %s" % (off, text, where))
    if not total:
        print("\nNothing found. That is itself a result: the loader is not keeping asset")
        print("names resident, so the index it uses is numeric — scan for it with")
        print("`diff`/`scan` across two snapshots that show different characters.")
    return 0


def cmd_read(args):
    with pine.connect(retries=args.retries) as c:
        if args.length:
            data = c.read_bytes(args.addr, args.length)
            print(data.hex(" "))
        else:
            v = c.read(args.addr, args.width)
            print("0x%08X = %d (0x%X)" % (args.addr, v, v))
    return 0


def cmd_poke(args):
    with pine.connect(retries=args.retries) as c:
        before = c.read(args.addr, args.width)
        c.write(args.addr, args.value, args.width)
        after = c.read(args.addr, args.width)
    print("0x%08X: %d -> %d (read back %d)" % (args.addr, before, args.value, after))
    return 0 if after == args.value else 1


def cmd_states(args):
    d = savestate.default_states_dir()
    print("savestates: %s" % d)
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if name.endswith(".p2s"):
                print("  %s" % name)
    print("snaps: %s" % harness.default_snaps_dir())
    return 0


# -- argument parsing -------------------------------------------------------


def _int(s):
    return int(s, 0)


def build_parser():
    p = argparse.ArgumentParser(prog="tools.pcsx2.cli", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("doctor", help="report which pieces of the harness are available")
    sp.set_defaults(func=cmd_doctor)

    sp = sub.add_parser("boot-verify", help="boot an ISO and read its tables back out of RAM")
    sp.add_argument("iso", nargs="?")
    sp.add_argument("--timeout", type=float, default=180.0)
    sp.add_argument("--log", help="write PCSX2's log here")
    sp.add_argument("-v", "--verbose", action="store_true")
    sp.set_defaults(func=cmd_boot_verify)

    sp = sub.add_parser("snapshot", help="save a state from a running PCSX2 and dump its EE RAM")
    sp.add_argument("out")
    sp.add_argument("--slot", type=int, default=1)
    sp.add_argument("--retries", type=int, default=3)
    sp.set_defaults(func=cmd_snapshot)

    sp = sub.add_parser("diff", help="summarise where two RAM dumps differ")
    sp.add_argument("a")
    sp.add_argument("b")
    sp.add_argument("--gap", type=int, default=8)
    sp.add_argument("--limit", type=int, default=40)
    sp.set_defaults(func=cmd_diff)

    sp = sub.add_parser("scan", help="narrow candidate addresses across snapshot pairs")
    sp.add_argument("--changed", nargs=2, action="append", metavar=("A", "B"))
    sp.add_argument("--unchanged", nargs=2, action="append", metavar=("A", "B"))
    sp.add_argument("--width", type=int, default=4, choices=(1, 2, 4, 8))
    sp.add_argument("--min", type=_int)
    sp.add_argument("--max", type=_int)
    sp.add_argument("--limit", type=int, default=40)
    sp.add_argument("--out", help="write surviving addresses here")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("codes", help="search a RAM dump for ETC.BIN asset names")
    sp.add_argument("dump")
    sp.add_argument("--iso", help="calibrate the ELF mapping against this disc")
    sp.add_argument("--needle", action="append", help="search for this string instead")
    sp.add_argument("--limit", type=int, default=2000)
    sp.add_argument("--show", type=int, default=10)
    sp.set_defaults(func=cmd_codes)

    sp = sub.add_parser("read", help="read EE memory from a running PCSX2")
    sp.add_argument("addr", type=_int)
    sp.add_argument("--width", type=int, default=4, choices=(1, 2, 4, 8))
    sp.add_argument("--length", type=int, help="read this many bytes instead of one value")
    sp.add_argument("--retries", type=int, default=3)
    sp.set_defaults(func=cmd_read)

    sp = sub.add_parser("poke", help="write EE memory in a running PCSX2")
    sp.add_argument("addr", type=_int)
    sp.add_argument("value", type=_int)
    sp.add_argument("--width", type=int, default=4, choices=(1, 2, 4, 8))
    sp.add_argument("--retries", type=int, default=3)
    sp.set_defaults(func=cmd_poke)

    sp = sub.add_parser("states", help="list PCSX2's savestates and screenshot directory")
    sp.set_defaults(func=cmd_states)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (pine.PineError, harness.HarnessError, eemap.CalibrationError,
            savestate.SavestateError, ramscan.ScanError) as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    except BrokenPipeError:
        # `... | head` is the normal way to read a scan; don't make it look like a crash.
        try:
            sys.stdout.close()
        finally:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
