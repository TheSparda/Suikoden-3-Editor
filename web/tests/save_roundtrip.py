#!/usr/bin/env python3
# Save-engine round-trip test for the web editor's Pyodide path.
#
# The web Save Editor runs Editor/s3save.py unchanged in the browser (read_all_s3_saves /
# write_save_edits). The repo ships NO game data, so — mirroring web/tests/synth-iso.mjs for
# the ISO editor — this builds a SYNTHETIC 53264-byte "gamedata" payload with planted values
# and drives the real engine: decode -> edit -> write -> re-decode, asserting the values
# persist and the gamedata checksum invariant (all u32 words sum to 0) holds. It also unit-
# checks the memory-card ECC helper and the "no S3 save found" path.
#
# Imports s3save directly (not a JS reimplementation) so the offsets and checksum can never
# drift from the engine under test. Run via `node save-roundtrip.mjs` (skips cleanly if
# python3 is absent) or directly: `python3 save_roundtrip.py`.
import os
import sys
import struct
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "Editor"))
import s3save  # noqa: E402

fails = 0


def check(name, cond, extra=""):
    global fails
    print("  %s %s%s" % ("✓" if cond else "✗", name, (" — " + extra) if extra else ""))
    if not cond:
        fails += 1


def build_synth():
    """A valid bare S3 save payload with a few planted, verifiable values."""
    b = bytearray(s3save.GAMEDATA_SIZE)
    # gold (u32)
    struct.pack_into("<I", b, s3save.GOLD_OFF, 12345)
    # roster 0 (Hugo): id / level / HP / EXP / one stat / one skill slot
    base = s3save.CHAR_BASE  # roster index 0
    b[base + s3save.OFF_ID] = 1
    b[base + s3save.OFF_LEVEL] = 10
    struct.pack_into("<H", b, base + s3save.OFF_CURHP, 100)
    struct.pack_into("<H", b, base + s3save.OFF_MAXHP, 181)
    struct.pack_into("<I", b, base + s3save.OFF_EXP, 500)
    struct.pack_into("<H", b, base + s3save.OFF_STATS, 58)          # PWR = stat[0]
    b[base + s3save.OFF_SKILLS + 0] = 6                              # skill slot 0 id
    b[base + s3save.OFF_SKILLS + 1] = 3                              # skill slot 0 rank
    # roster 0 recruited; roster 1 NOT recruited (so we can recruit it via an edit)
    struct.pack_into("<H", b, s3save.RECRUIT_OFF + 0 * 2, s3save.RECRUIT_DEFAULT)
    # active party slot 0 = Hugo
    struct.pack_into("<H", b, s3save.PARTY_OFF + 0 * 2, 1)
    # a name field
    nm = "TESTHERO".encode("latin1")
    off, n = s3save.NAME_OFF["flameChampion"]
    b[off:off + len(nm)] = nm
    return s3save.fix_gamedata_checksum(bytes(b))


def sum_words(data):
    words = struct.unpack_from("<%dI" % (len(data) // 4), data, 0)
    return sum(words) & 0xFFFFFFFF


def main():
    print("Save-engine round-trip (synthetic gamedata):")

    tmp = tempfile.mkdtemp(prefix="s3save-test-")
    path = os.path.join(tmp, "gamedata")
    with open(path, "wb") as f:
        f.write(build_synth())

    # --- decode ---
    saves = s3save.read_all_s3_saves(path)
    check("decodes exactly one save", len(saves) == 1)
    s = saves[0]
    hugo = next(c for c in s["characters"] if c["rosterIndex"] == 0)
    check("gold decoded", s["global"]["gold"] == 12345, str(s["global"]["gold"]))
    check("level decoded", hugo["level"] == 10)
    check("maxHP decoded", hugo["maxHP"] == 181)
    check("PWR stat decoded", hugo["stats"]["PWR"] == 58)
    check("skill slot 0 decoded", hugo["skills"][0]["id"] == 6 and hugo["skills"][0]["rank"] == 3)
    check("roster 0 recruited, roster 1 not",
          hugo["recruited"] and not next(c for c in s["characters"] if c["rosterIndex"] == 1)["recruited"])
    check("name decoded", any(n["value"] == "TESTHERO" for n in s.get("names", [])))
    check("synth checksum is valid (words sum to 0)", sum_words(open(path, "rb").read()) == 0)

    # --- edit (mirrors the web app's payload shape) ---
    res = s3save.write_save_edits(
        path, s["folder"],
        {0: {"level": 50, "maxHP": 9999, "stats": {"PWR": 250},
             "skills": {0: {"id": 7, "rank": 8}}}},
        make_backup=False,
        name_edits={"flameChampion": "Zephon"},
        party_edits={1: 63},
        recruit_edits={1: {"recruited": True, "recruiter": "Chris"}},
        gold=999999,
    )
    check("write reports ok", res.get("ok") is True, str(res))
    check("write changed multiple fields", res.get("changed", 0) >= 6, "changed=%s" % res.get("changed"))
    check("write preserved payload size", os.path.getsize(path) == s3save.GAMEDATA_SIZE)

    # --- re-decode the WRITTEN payload (proves it stays a valid, decodable save) ---
    saves2 = s3save.read_all_s3_saves(path)
    check("re-decodes after write", len(saves2) == 1)
    s2 = saves2[0]
    hugo2 = next(c for c in s2["characters"] if c["rosterIndex"] == 0)
    r1 = next(c for c in s2["characters"] if c["rosterIndex"] == 1)
    check("gold persisted", s2["global"]["gold"] == 999999, str(s2["global"]["gold"]))
    check("level persisted", hugo2["level"] == 50)
    check("maxHP persisted", hugo2["maxHP"] == 9999)
    check("PWR persisted", hugo2["stats"]["PWR"] == 250)
    check("skill edit persisted", hugo2["skills"][0]["id"] == 7 and hugo2["skills"][0]["rank"] == 8)
    check("name persisted", any(n["value"] == "Zephon" for n in s2.get("names", [])))
    check("party slot persisted", s2["party"][1] == 63)
    check("recruit persisted (recruited + recruiter)", r1["recruited"] and r1["recruiter"] == "Chris")
    check("checksum invariant holds after write", sum_words(open(path, "rb").read()) == 0)

    # --- rejection paths (what the web loader turns into a friendly message) ---
    # An unrecognized/garbage file raises; the web app catches it -> "Failed to read save".
    bad = os.path.join(tmp, "short.bin")
    with open(bad, "wb") as f:
        f.write(bytes(s3save.GAMEDATA_SIZE - 1))
    try:
        s3save.read_all_s3_saves(bad)
        check("unrecognized file is rejected", False, "no exception raised")
    except Exception:
        check("unrecognized file is rejected (raises; web layer reports it)", True)

    # --- memory-card ECC helper (used when writing .ps2 cards) ---
    print("Memory-card ECC helper:")
    zero = s3save.ecc_page(bytes(512))
    check("ecc_page returns 16 bytes", len(zero) == 16)
    check("ecc_page of a zero page is the known constant",
          zero == (bytes([0x77, 0x7F, 0x7F]) * 4) + b"\x00\x00\x00\x00", zero.hex())
    flipped = bytearray(512)
    flipped[0] = 0x01
    check("ecc changes when a byte flips (detects corruption)", s3save.ecc_page(bytes(flipped)) != zero)

    print("\n%s" % ("All save round-trip checks passed." if fails == 0 else "%d check(s) FAILED." % fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
