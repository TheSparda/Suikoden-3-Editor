#!/usr/bin/env python3
"""Thin bridge between the MCP server (Node) and the canonical save core.

Every operation here is a call into Editor/s3save.py, the same module the web
save editor runs under Pyodide. This file contains no save-format logic of its
own: it only translates one JSON request on stdin into s3save calls and one
JSON response on stdout.

Commands:
  decode  {path}                                  -> {format, saves:[decode_save(...) + folder/label/region]}
  apply   {path, folder, edits}                   -> writes edits into the file at path
                                                     (the server only ever passes a working copy
                                                     or a caller-chosen output path, never the
                                                     file a save was opened from)
  synth   {out}                                   -> writes a synthetic gamedata fixture for tests
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "Editor"))
import s3save  # noqa: E402


def decode(path):
    fmt = s3save._sniff_format(path)
    saves = s3save.read_all_s3_saves(path)
    for s in saves:
        s.pop("raw", None)
        for c in s.get("characters", []):
            c.pop("raw", None)
    return {"format": fmt, "saves": saves}


def apply(path, folder, edits):
    edits = edits or {}
    if "trinity" in edits:
        raise ValueError("Trinity Sight is read-only: unlock and stage writes are not available.")
    return s3save.write_save_edits(
        path, folder,
        edits.get("characters") or {},
        make_backup=False,
        inv_edits=edits.get("inventory"),
        name_edits=edits.get("names"),
        party_edits=edits.get("party"),
        recruit_edits=edits.get("recruits"),
        gold=edits.get("gold"),
        carryover=edits.get("carryover"),
        leader=edits.get("leader"),
        party_mount_edits=edits.get("partyMounts"),
        trinity=None,
    )


def synth(out):
    """A valid bare gamedata payload with planted values (mirrors web/tests/save_roundtrip.py)."""
    b = bytearray(s3save.GAMEDATA_SIZE)
    struct.pack_into("<I", b, s3save.GOLD_OFF, 12345)
    struct.pack_into("<H", b, s3save.LEADER_OFF, 1)
    base = s3save.CHAR_BASE
    b[base + s3save.OFF_ID] = s3save.ROSTER_IDS[0]
    b[base + s3save.OFF_LEVEL] = 10
    b[base + s3save.OFF_WEAPONLV] = 4
    struct.pack_into("<H", b, base + s3save.OFF_CURHP, 100)
    struct.pack_into("<H", b, base + s3save.OFF_MAXHP, 181)
    struct.pack_into("<H", b, base + s3save.OFF_EXP, 500)
    struct.pack_into("<H", b, base + s3save.STAT_OFFSETS["PWR"], 58)
    struct.pack_into("<H", b, base + s3save.STAT_OFFSETS["MAG"], 47)
    b[base + s3save.OFF_CUR_CHARGES:base + s3save.OFF_CUR_CHARGES + 4] = bytes([3, 1, 0, 0])
    b[base + s3save.OFF_MAX_CHARGES:base + s3save.OFF_MAX_CHARGES + 4] = bytes([4, 1, 0, 0])
    b[base + s3save.OFF_SKILLS + 0] = 6
    b[base + s3save.OFF_SKILLS + 1] = 3
    b[s3save.CHAR_BASE + s3save.CHAR_STRIDE + s3save.OFF_ID] = s3save.ROSTER_IDS[1]
    b[s3save.CHAR_BASE + s3save.CHAR_STRIDE + s3save.OFF_LEVEL] = 31
    struct.pack_into("<HH", b, s3save.INV_BASE + 0 * s3save.INV_ENTRY, 0x001, 6)
    struct.pack_into("<HH", b, s3save.INV_BASE + 1 * s3save.INV_ENTRY, 0x1CC, 0)
    struct.pack_into("<H", b, s3save.RECRUIT_OFF + 0 * 2, s3save.RECRUIT_DEFAULT)
    struct.pack_into("<H", b, s3save.PARTY_OFF + 0 * 2, 1)
    data = s3save.fix_gamedata_checksum(bytes(b))
    with open(out, "wb") as f:
        f.write(data)
    return {"written": out, "size": len(data)}


def main():
    req = json.load(sys.stdin)
    cmd = req.get("cmd")
    try:
        if cmd == "decode":
            res = decode(req["path"])
        elif cmd == "apply":
            res = {"result": apply(req["path"], req.get("folder"), req.get("edits"))}
        elif cmd == "synth":
            res = synth(req["out"])
        else:
            raise ValueError(f"unknown bridge command: {cmd!r}")
        print(json.dumps({"ok": True, "result": res}))
    except Exception as e:  # plain-language error for the MCP client, no traceback
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(0)


if __name__ == "__main__":
    main()
