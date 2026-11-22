#!/usr/bin/env python3
# Helper for loadout-core.mjs: the real-fixture half of the loadout CSV round trip.
#
#   dump  <fixture-gamedata> <workdir>
#       Copy the fixture into <workdir>/save-copy (the original is only ever read),
#       decode the copy with the real s3save engine, and write <workdir>/context.json
#       with the decoded characters, the item table (id -> name, parsed from
#       Editor/Suikoden3_item_ids.txt with the same rules app.js uses), and the
#       SHA-256 of both the original and the copy.
#
#   apply <workdir> <edits.json>
#       Apply the edits JSON ({rosterIndex: {"equip": {slot: itemId}}}) to the copy's
#       bytes with s3save.apply_edits_to_gamedata and print a JSON verdict: whether
#       the character-record region and the whole payload are byte-identical to the
#       copy, and whether the original fixture still hashes to what dump recorded.
import hashlib
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "..", "..")
sys.path.insert(0, os.path.join(REPO, "Editor"))
import s3save  # noqa: E402


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def item_table():
    t = open(os.path.join(REPO, "Editor", "Suikoden3_item_ids.txt"),
             encoding="latin1").read()
    return {int(m.group(1), 16): m.group(2).strip()
            for m in re.finditer(r"\b([0-9A-Fa-f]{3})\t([^\t\n\r]+)", t)}


def main():
    if sys.argv[1] == "dump":
        fixture, workdir = sys.argv[2], sys.argv[3]
        os.makedirs(workdir, exist_ok=True)
        copy = os.path.join(workdir, "save-copy")
        shutil.copyfile(fixture, copy)
        saves = s3save.read_all_s3_saves(copy)
        assert len(saves) == 1, "fixture did not decode to exactly one save"
        chars = [{k: c[k] for k in ("rosterIndex", "name", "id", "idExpected",
                                    "equip", "hasData", "recruited")}
                 for c in saves[0]["characters"]]
        ctx = {"characters": chars,
               "itemById": {str(k): {"name": v} for k, v in item_table().items()},
               "fixtureSha": sha(fixture), "copySha": sha(copy),
               "fixture": fixture}
        with open(os.path.join(workdir, "context.json"), "w") as f:
            json.dump(ctx, f)
        print(json.dumps({"chars": len(chars), "copySha": ctx["copySha"]}))
        return 0
    if sys.argv[1] == "apply":
        workdir, edits_path = sys.argv[2], sys.argv[3]
        copy = os.path.join(workdir, "save-copy")
        ctx = json.load(open(os.path.join(workdir, "context.json")))
        original = open(copy, "rb").read()
        edits = {int(k): v for k, v in json.load(open(edits_path)).items()}
        new, changed = s3save.apply_edits_to_gamedata(original, edits)
        lo = s3save.CHAR_BASE
        hi = lo + s3save.CHAR_COUNT * s3save.CHAR_STRIDE
        print(json.dumps({
            "changedFields": changed,
            "charRecordsIdentical": new[lo:hi] == original[lo:hi],
            "wholeIdentical": new == original,
            "fixtureUntouched": sha(ctx["fixture"]) == ctx["fixtureSha"],
            "copyUntouched": sha(copy) == ctx["copySha"],
        }))
        return 0
    print("usage: loadout_roundtrip.py dump <fixture> <workdir> | apply <workdir> <edits.json>",
          file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
