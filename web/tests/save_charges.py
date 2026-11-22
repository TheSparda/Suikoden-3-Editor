#!/usr/bin/env python3
# Real-fixture test for the rune spell charge fields (record +0x38 CUR, +0x3C MAX).
#
# The synthetic round-trip (save_roundtrip.py) proves the write path; this proves the
# OFFSETS against real saves. It decodes every gamedata fixture the repo ships
# (Saves/_extracted_s3/) plus, when present, the lab memcards one level above the
# repo, and asserts the properties that only hold if +0x38/+0x3C really are the
# charge arrays: every byte in 0..9, CUR <= MAX in every slot, the stored MAX equal
# to the MAG threshold derivation (s3save.predicted_max_charges) for every record,
# and at least one spent slot (CUR < MAX) somewhere in the corpus, which is what
# proves CUR is serialised state rather than a copy of MAX.
#
# The write half runs on a COPY in a temp dir; fixture files are never modified
# (their hashes are asserted unchanged at the end).
import glob
import hashlib
import os
import sys
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


def main():
    print("Rune charges against real fixtures:")
    blobs = sorted(glob.glob(os.path.join(HERE, "..", "..", "Saves",
                                          "_extracted_s3", "gamedata*")))
    cards = sorted(glob.glob(os.path.join(HERE, "..", "..", "..", "saves",
                                          "memcards", "*.ps2")))
    fixtures = blobs + cards
    check("real fixtures found", len(fixtures) >= 5, "%d files" % len(fixtures))
    hashes = {p: hashlib.sha256(open(p, "rb").read()).hexdigest() for p in fixtures}

    records = 0
    spent = 0
    bad_range, bad_order, bad_pred = [], [], []
    for path in fixtures:
        for dec in s3save.read_all_s3_saves(path):
            check_save = dec["problems"] == []
            if not check_save:
                bad_range.append((path, dec["problems"][:1]))
            for c in dec["characters"]:
                if not c["hasData"]:
                    continue
                records += 1
                ch = c["charges"]
                if any(v > s3save.CHARGE_MAX for v in ch["cur"] + ch["max"]):
                    bad_range.append((path, c["name"]))
                if any(cv > mv for cv, mv in zip(ch["cur"], ch["max"])):
                    bad_order.append((path, c["name"]))
                if ch["max"] != ch["maxPredicted"]:
                    bad_pred.append((path, c["name"], ch["max"], ch["maxPredicted"]))
                spent += sum(1 for cv, mv in zip(ch["cur"], ch["max"]) if cv < mv)
    check("character records decoded", records >= 2000, "%d records" % records)
    check("every charge byte in 0..9 and no layout problems reported", not bad_range,
          str(bad_range[:3]))
    check("CUR <= MAX in every slot", not bad_order, str(bad_order[:3]))
    check("stored MAX equals the MAG threshold derivation for every record",
          not bad_pred, str(bad_pred[:3]))
    check("spent charges exist in the corpus (CUR is serialised, not derived)",
          spent > 0, "%d spent slots" % spent)

    # --- write on a COPY of a real fixture -------------------------------------
    src = next(p for p in blobs if os.path.getsize(p) == s3save.GAMEDATA_SIZE)
    tmp = tempfile.mkdtemp(prefix="s3charges-test-")
    copy_path = os.path.join(tmp, "gamedata")
    with open(src, "rb") as f, open(copy_path, "wb") as g:
        g.write(f.read())
    dec = s3save.read_all_s3_saves(copy_path)[0]
    target = next(c for c in dec["characters"]
                  if c["hasData"] and c["charges"]["max"][0] > 0)
    ri = target["rosterIndex"]
    res = s3save.write_save_edits(copy_path, dec["folder"],
                                  {ri: {"charges": {"cur": {0: 0, 1: 99}}}},
                                  make_backup=False)
    check("write on the copy reports ok", res.get("ok") is True, str(res))
    after = next(c for c in s3save.read_all_s3_saves(copy_path)[0]["characters"]
                 if c["rosterIndex"] == ri)
    check("edited CUR persisted on the copy", after["charges"]["cur"][0] == 0,
          str(after["charges"]))
    check("oversized CUR clamped to the stored MAX on the copy",
          after["charges"]["cur"][1] == after["charges"]["max"][1],
          str(after["charges"]))
    import struct
    raw = open(copy_path, "rb").read()
    words = struct.unpack("<%dI" % (len(raw) // 4), raw)
    check("checksum invariant holds on the copy (u32 words sum to 0)",
          sum(words) & 0xFFFFFFFF == 0)

    check("fixture files untouched",
          all(hashlib.sha256(open(p, "rb").read()).hexdigest() == h
              for p, h in hashes.items()))
    print("save_charges: %s" % ("FAIL (%d)" % fails if fails else "all checks passed"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
