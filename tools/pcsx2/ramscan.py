"""Differential RAM scanning — a scripted Cheat Engine for EE memory dumps.

The point of this module is one question: *which word in memory decides which model the
game draws for a party member?* Nothing in the ISO answers that, because the archive
addresses models by a precomputed index (see docs/ETC_BIN_MODEL_RESEARCH.md). But two
RAM dumps taken in the same place with a different character on screen must differ in
that word, and repeated snapshots under the right conditions squeeze the candidate set
from millions down to a handful you can poke one at a time.

Everything here works on plain `bytes` images (from savestate.extract_ee_ram), so scans
are offline and repeatable: capture five snapshots once, then re-run the narrowing logic
as often as you like without touching the emulator.

Scale note: a 32 MB image holds 8 M aligned 32-bit slots, so the first scan must be one
that narrows (an equality scan, or a changed-between-two-dumps scan). "Unchanged" and
other complement-shaped filters are only offered as *follow-up* steps, once a real
candidate set exists — materialising 8 M Python ints just to subtract from it is how you
run a machine out of memory for no benefit.
"""
import struct

WIDTH_FMT = {1: "<B", 2: "<H", 4: "<I", 8: "<Q"}


class ScanError(RuntimeError):
    pass


def differing_offsets(a, b, chunk=4096):
    """Yield every byte offset where two equal-length images differ.

    Compares chunk-first so untouched memory costs one C-level bytes comparison per
    4 KB instead of a Python loop per byte — the difference between a scan that takes
    a second and one that takes minutes.
    """
    if len(a) != len(b):
        raise ScanError("images differ in length (%d vs %d)" % (len(a), len(b)))
    for base in range(0, len(a), chunk):
        ca = a[base:base + chunk]
        cb = b[base:base + chunk]
        if ca == cb:
            continue
        for i, (x, y) in enumerate(zip(ca, cb)):
            if x != y:
                yield base + i


def differing_runs(a, b, chunk=4096, max_gap=8):
    """Differing offsets collapsed into (start, length) runs.

    `max_gap` merges runs separated by a few identical bytes, which is what a changed
    struct actually looks like: a handful of fields move while the padding between them
    stays put. Reading a report of ~200 runs is possible; reading 40,000 offsets is not.
    """
    runs = []
    start = prev = None
    for off in differing_offsets(a, b, chunk):
        if start is None:
            start = prev = off
        elif off - prev <= max_gap:
            prev = off
        else:
            runs.append((start, prev - start + 1))
            start = prev = off
    if start is not None:
        runs.append((start, prev - start + 1))
    return runs


def _aligned_slots(offsets, width, size):
    """Aligned addresses of every `width`-byte slot containing one of `offsets`."""
    out = set()
    for off in offsets:
        addr = off - (off % width)
        if addr + width <= size:
            out.add(addr)
    return sorted(out)


def find_value(dump, value, width=4, aligned=True, limit=None):
    """Every address holding `value`. Uses bytes.find on the packed needle, so the
    search itself runs in C."""
    if width not in WIDTH_FMT:
        raise ScanError("bad width %r" % (width,))
    needle = struct.pack(WIDTH_FMT[width], value)
    out, pos = [], 0
    while True:
        pos = dump.find(needle, pos)
        if pos == -1:
            break
        if not aligned or pos % width == 0:
            out.append(pos)
            if limit is not None and len(out) >= limit:
                break
        pos += 1
    return out


def find_bytes(dump, needle, limit=None):
    """Every offset of a literal byte pattern. This is how you go looking for the
    ETC.BIN asset codes (`cha_syu1`, `imf_luc`) in live memory: if the loader keeps a
    name or index table resident, it shows up here, and eemap can then tell you where
    that table sits on disc."""
    out, pos = [], 0
    while True:
        pos = dump.find(needle, pos)
        if pos == -1:
            break
        out.append(pos)
        if limit is not None and len(out) >= limit:
            break
        pos += 1
    return out


def find_ascii(dump, text, limit=None):
    return find_bytes(dump, text.encode("ascii"), limit=limit)


def values_at(dump, addrs, width=4):
    fmt = WIDTH_FMT[width]
    return [struct.unpack_from(fmt, dump, a)[0] for a in addrs]


class Scanner:
    """A narrowing candidate set across a series of RAM snapshots.

    Typical Hugo-hunt session::

        s = Scanner(width=4)
        s.first_changed(hugo_dump, chris_dump)   # same map, different lead character
        s.keep_changed(chris_dump, geddoe_dump)  # must move again for a third lead
        s.keep_unchanged(hugo_dump, hugo_dump2)  # must NOT move when nothing changed
        s.report(hugo_dump)
    """

    def __init__(self, width=4, aligned=True):
        if width not in WIDTH_FMT:
            raise ScanError("bad width %r" % (width,))
        self.width = width
        self.aligned = aligned
        self.candidates = None
        self.history = []

    # -- first scans (must narrow) ------------------------------------------

    def first_equal(self, dump, value):
        self.candidates = find_value(dump, value, self.width, self.aligned)
        self.history.append("first_equal(%d) -> %d" % (value, len(self.candidates)))
        return self

    def first_changed(self, a, b):
        offs = differing_offsets(a, b)
        self.candidates = _aligned_slots(offs, self.width, len(a))
        self.history.append("first_changed -> %d" % len(self.candidates))
        return self

    def first_in_range(self, addrs):
        """Seed from an explicit address list (e.g. a struct you already located)."""
        self.candidates = sorted(set(addrs))
        self.history.append("first_in_range -> %d" % len(self.candidates))
        return self

    # -- narrowing ----------------------------------------------------------

    def _require(self):
        if self.candidates is None:
            raise ScanError(
                "start with first_equal/first_changed/first_in_range — a complement "
                "filter over all of RAM would materialise millions of addresses"
            )

    def _filter(self, pred, label):
        self._require()
        before = len(self.candidates)
        self.candidates = [a for a in self.candidates if pred(a)]
        self.history.append("%s: %d -> %d" % (label, before, len(self.candidates)))
        return self

    def keep_changed(self, a, b):
        fmt = WIDTH_FMT[self.width]
        return self._filter(
            lambda x: struct.unpack_from(fmt, a, x) != struct.unpack_from(fmt, b, x),
            "keep_changed",
        )

    def keep_unchanged(self, a, b):
        fmt = WIDTH_FMT[self.width]
        return self._filter(
            lambda x: struct.unpack_from(fmt, a, x) == struct.unpack_from(fmt, b, x),
            "keep_unchanged",
        )

    def keep_equal(self, dump, value):
        fmt = WIDTH_FMT[self.width]
        return self._filter(
            lambda x: struct.unpack_from(fmt, dump, x)[0] == value, "keep_equal(%d)" % value
        )

    def keep_value_between(self, dump, lo, hi):
        """Keep slots whose value is plausibly a small index. A model/character id is a
        low number; a pointer or a float is not, and this drops most of both."""
        fmt = WIDTH_FMT[self.width]
        return self._filter(
            lambda x: lo <= struct.unpack_from(fmt, dump, x)[0] <= hi,
            "keep_value_between(%d,%d)" % (lo, hi),
        )

    def keep_where(self, dump, pred, label="keep_where"):
        fmt = WIDTH_FMT[self.width]
        return self._filter(lambda x: pred(struct.unpack_from(fmt, dump, x)[0]), label)

    def keep_addr_between(self, lo, hi):
        return self._filter(lambda x: lo <= x < hi, "keep_addr_between")

    def exclude_near(self, addrs, radius):
        """Drop candidates within `radius` of known-uninteresting addresses (the frame
        counter, RNG state, and the audio ring buffer change on every single snapshot
        and will otherwise survive every differential scan you run)."""
        blocked = sorted(addrs)
        if not blocked:
            return self

        def ok(x):
            import bisect

            i = bisect.bisect_left(blocked, x)
            for j in (i - 1, i):
                if 0 <= j < len(blocked) and abs(blocked[j] - x) <= radius:
                    return False
            return True

        return self._filter(ok, "exclude_near(%d)" % radius)

    # -- output -------------------------------------------------------------

    def addresses(self):
        self._require()
        return list(self.candidates)

    def report(self, dump=None, limit=40):
        """A printable summary: the narrowing history plus the surviving addresses."""
        self._require()
        lines = list(self.history)
        lines.append("%d candidate(s)" % len(self.candidates))
        for a in self.candidates[:limit]:
            if dump is None:
                lines.append("  0x%08X" % a)
            else:
                v = struct.unpack_from(WIDTH_FMT[self.width], dump, a)[0]
                lines.append("  0x%08X = %d (0x%X)" % (a, v, v))
        if len(self.candidates) > limit:
            lines.append("  ... %d more" % (len(self.candidates) - limit))
        return "\n".join(lines)


def volatile_addresses(dumps, width=4, aligned=True):
    """Addresses that differ across *every* pair of a set of otherwise-identical dumps.

    Take three or four snapshots without changing anything in game and feed them here:
    the result is the noise floor — timers, RNG, audio — which `Scanner.exclude_near`
    can then subtract from a real scan.
    """
    if len(dumps) < 2:
        raise ScanError("need at least two dumps")
    common = None
    for a, b in zip(dumps, dumps[1:]):
        offs = set(_aligned_slots(differing_offsets(a, b), width, len(a)))
        common = offs if common is None else (common & offs)
    return sorted(common)
