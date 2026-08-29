"""Map ISO file offsets to live EE RAM addresses (and back).

Every table the editor writes — list1..list4, the shop tables, the 94-record rune table
— lives inside the boot ELF, which the PS2 loads into main RAM as one contiguous chunk.
So an offset the editor patches on disc has a fixed counterpart in the running game's
memory, and that is what turns "did my edit land?" from a human playing for ten minutes
into a memory read.

`Editor/Suikoden3_ISO_offsets.md` records the mapping as
`file_off = (vaddr - 0x165D000) + 0xA4800`, derived from the ELF program header. That
constant is trusted here only as a *starting guess*: `calibrate` re-derives the real
delta by finding an anchor of ISO bytes inside an actual RAM dump. A game that relocates
its executable, or a doc constant that drifts, then shows up as a calibration failure
instead of a table of plausible-looking garbage.
"""
import os

# From the ELF program header, per Editor/Suikoden3_ISO_offsets.md.
ELF_FILE_BASE = 0xA4800
ELF_VADDR_BASE = 0x165D000
DEFAULT_DELTA = ELF_VADDR_BASE - ELF_FILE_BASE

EE_RAM_SIZE = 32 * 1024 * 1024

# The SLUS-20387 version check: u32 at this file offset reads 0x40A69A01 big-endian,
# i.e. the bytes 40 A6 9A 01. It is the editor's own disc fingerprint, which makes it
# the natural anchor to search RAM for.
VERSION_CHECK_OFF = 4136544
VERSION_CHECK_BYTES = bytes((0x40, 0xA6, 0x9A, 0x01))

# Table bases mirrored from Editor/s3patch.py so a harness run can name what it read.
# (base_offset, stride, description)
TABLES = {
    "list1": (4078716, 140, "character starting stats"),
    "list2": (4068152, 132, "stat growth / skill max levels"),
    "list3": (4089904, 8, "support character skills"),
    "list4": (4061704, 28, "list4"),
}
RUNE_TABLE_OFF = 0x3EC2A0
RUNE_TABLE_STRIDE = 0x20
RUNE_TABLE_COUNT = 94


class CalibrationError(RuntimeError):
    pass


class EeMap:
    """A file-offset <-> EE-address mapping with a known (or calibrated) delta."""

    def __init__(self, delta=DEFAULT_DELTA, calibrated=False):
        self.delta = delta
        self.calibrated = calibrated

    def to_ee(self, file_off):
        # Two separate guards. The lower one is exact: nothing before the ELF's first
        # mapped byte is in RAM at all, and offsets like 0 would otherwise map to a
        # perfectly plausible-looking address. The upper one is only the RAM bound,
        # because the ELF's length on disc is not recorded anywhere we trust — an
        # offset past the executable but still inside 32 MB will map without complaint.
        if file_off < ELF_FILE_BASE:
            raise ValueError(
                "file offset %d is before the ELF's first mapped byte (0x%X) — it is "
                "not loaded into RAM" % (file_off, ELF_FILE_BASE)
            )
        addr = file_off + self.delta
        if not 0 <= addr < EE_RAM_SIZE:
            raise ValueError(
                "file offset %d maps to 0x%08X, outside EE RAM — it is probably not "
                "inside the boot ELF" % (file_off, addr)
            )
        return addr

    def to_file(self, ee_addr):
        off = ee_addr - self.delta
        if off < ELF_FILE_BASE:
            raise ValueError(
                "EE address 0x%08X is below the ELF's load address — it is RAM the "
                "game allocated, not something with a place on the disc" % ee_addr
            )
        return off

    def table_ee(self, name, index=0):
        """EE address of record `index` of a named editor table."""
        base, stride, _ = TABLES[name]
        return self.to_ee(base + index * stride)

    def rune_ee(self, index=0):
        return self.to_ee(RUNE_TABLE_OFF + index * RUNE_TABLE_STRIDE)

    def __repr__(self):
        return "EeMap(delta=0x%X%s)" % (
            self.delta,
            "" if self.calibrated else ", uncalibrated",
        )


def read_anchor(iso_path, file_off=VERSION_CHECK_OFF, length=64):
    """Pull `length` bytes of the ISO around a known offset, to search RAM for.

    Reads from `file_off` backwards by a third so the anchor straddles the offset; a
    window that starts exactly at a table boundary is more likely to be all-zero
    padding, which matches everywhere and calibrates to nonsense.
    """
    start = max(0, file_off - length // 3)
    with open(iso_path, "rb") as f:
        f.seek(start)
        data = f.read(length)
    if len(data) < length:
        raise CalibrationError("could not read %d bytes at %d from %s" % (length, start, iso_path))
    return start, data


def calibrate_from_dump(ee_dump, anchor_off, anchor_bytes):
    """Find `anchor_bytes` in an EE RAM image and derive the file->EE delta.

    `ee_dump` is the raw 32 MB eeMemory image (see savestate.extract_ee_ram).
    Raises if the anchor is missing or ambiguous — an anchor that appears twice means
    the game keeps a second copy and we cannot tell which one the code reads.
    """
    if len(anchor_bytes) < 8:
        raise CalibrationError("anchor too short to be unique")
    hits = []
    pos = ee_dump.find(anchor_bytes)
    while pos != -1:
        hits.append(pos)
        if len(hits) > 8:
            break
        pos = ee_dump.find(anchor_bytes, pos + 1)
    if not hits:
        raise CalibrationError(
            "anchor bytes not found in the RAM dump — either the disc is not this "
            "build, or the dump was taken before the ELF finished loading"
        )
    if len(hits) > 1:
        raise CalibrationError(
            "anchor found at %d places (%s) — pick a longer/more distinctive anchor"
            % (len(hits), ", ".join("0x%08X" % h for h in hits))
        )
    return EeMap(delta=hits[0] - anchor_off, calibrated=True)


def calibrate(iso_path, ee_dump, file_off=VERSION_CHECK_OFF, length=64):
    """Convenience: take the anchor from the ISO and calibrate against a RAM dump."""
    start, data = read_anchor(iso_path, file_off, length)
    return calibrate_from_dump(ee_dump, start, data)


def verify_with_pine(client, eemap, iso_path):
    """Cheap online check that `eemap` is right: the four version-check bytes must read
    back identically from the mapped EE address. Returns (ok, expected, got)."""
    with open(iso_path, "rb") as f:
        f.seek(VERSION_CHECK_OFF)
        expected = f.read(4)
    got = client.read_bytes(eemap.to_ee(VERSION_CHECK_OFF), 4)
    return got == expected, expected, got


def describe(path_or_off):
    """Human-readable name for a file offset, if it falls in a table we know."""
    off = path_or_off
    for name, (base, stride, note) in TABLES.items():
        if base <= off < base + stride * 200:
            idx, rem = divmod(off - base, stride)
            return "%s[%d]+%d (%s)" % (name, idx, rem, note)
    end = RUNE_TABLE_OFF + RUNE_TABLE_STRIDE * RUNE_TABLE_COUNT
    if RUNE_TABLE_OFF <= off < end:
        idx, rem = divmod(off - RUNE_TABLE_OFF, RUNE_TABLE_STRIDE)
        return "rune[%d]+0x%X" % (idx, rem)
    return "0x%X" % off


def default_iso_candidates():
    """Where the repo's own scripts expect a disc to live, for CLI convenience."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return [
        os.environ.get("S3_ISO", ""),
        os.path.join(root, "ISO", "Suikoden III (USA).iso"),
    ]
