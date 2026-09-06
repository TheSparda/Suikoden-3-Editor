#!/usr/bin/env python3
"""Build Editor/s3_bgm.json — every place the game decides which music plays.

Run against a PRISTINE USA (SLUS-20387) ISO:

    python3 Editor/build_bgm_index.py "/path/to/Suikoden III (USA).iso"

Background (full trail in Suikoden3_ISO_offsets.md, "BGM / sound control"):

Music is not a table in the executable. Two places pick a track, and this indexes both.

 1. **Event-script opcode 59/60** — the sound command. Handler at VA 0x17AF1A8, an
    18-byte instruction whose operands come straight off the script stream:

        w0 opcode (59 or 60)   w1 KIND   w2 TRACK   w3/w4 fade u32
        w5/w6 param u32        w7/w8 param u32

    KIND indexes the 8-entry table at VA 0x1983020 = [0, 0x1000, 0x2000, 0x3000,
    38, 39, 40, 41]. **Kind 1 is BGM**: its tag 0x1000 is exactly the bit the request
    function masks off before comparing against the current track
    (`andi $s2, $s0, 0x1000` at 0x17AEABC, beside the `prevBgm:0x%x stat:0x%x` printf).
    So `w2` of a kind-1 instruction is the track the game switches to, and it is a
    single u16 — editable in place, no length change.

 2. **The room record** (0x3C stride, already located by build_room_index.py). Its whole
    unrecognised tail is the room's audio block, fanned out at VA 0x17AEDA8:

        soundReq(kind=1, room->0x22, room->0x28 masks, room->0x2C, room->0x30)
        tailcall  0x17AE1E0(room->0x24, room->0x34)      ; the SD_SE_START path

    so **+0x22 is the room's BGM** and **+0x24 its ambient sound effect** — which is why
    +0x24 reads 0 indoors and non-zero on field maps.

Correct-or-absent, like the rest of the reference data. A raw two-byte search for the
opcode matches plenty of ordinary data, so a candidate is emitted only if its operands
have the shape every disassembler-confirmed instruction has (w3/w5/w6/w7 all zero). That
filter keeps 91% of raw kind-1 hits and collapses 33 candidate track ids to 13 coherent
ones — the values it drops are the obvious garbage (23908, 55482), which is the check
that says it is separating signal from noise rather than just shrinking the set.

ALSO indexed: the 29 streamed tracks themselves (see `streams`), so the editor can play
them straight off the disc. What is NOT indexed is any link between a track id and a
stream — see the note below.

NOT resolved here: what the track ids sound like. There are 13 of them and no name table
on the disc; mapping id -> song needs a patched disc and an emulator, not a scan.
"""
import sys, os, json, struct, collections

HERE = os.path.dirname(os.path.abspath(__file__))
SEC = 2048
SOUND_OPS = (59, 60)            # both dispatch to the handler at 0x17AF1A8
KIND_BGM = 1                    # table[1] = 0x1000, the prevBgm tag
N_KINDS = 8                     # the table at 0x1983020 has 8 entries
INSTR = 18                      # bytes

# ---- the streamed music itself -------------------------------------------------------
# /SD/STR.BIN is one concatenation of `Svag` streams — Sony interleaved VAG, i.e. plain
# PS-ADPCM, 44.1 kHz stereo. What locates them is a table in MODULES/SD_CALL.IRX: 29
# records of {u32 file, u32 startSector, u32 ?, u32 flags}, sectors relative to STR.BIN.
# All 29 starts land exactly on a `Svag` header, which is what says the table is the right
# one. The third word is NOT a length — see streams() — so sizes come from the headers.
# Each stream is a 0x400 header, a second copy of it, then the data.
STR_BASE, STR_SIZE = 0xE617C800, 47712256
SDCALL_TABLE = 0x4C8800 + 0x1A680
N_STREAMS = 29
SVAG_DATA = 0x800               # header + its duplicate, then PCM


def town_subfiles(sub):
    """Every `town` sub-file, as (archive, iso_offset, size, label)."""
    kinds = sub["kinds"]
    return [(a["archive"], a["base"] + s * SEC, n * SEC, label)
            for a in sub["archives"] for s, n, k, label in a["files"]
            if kinds[k] == "town"]


def cues(data):
    """Sound commands in one sub-file: (byte offset, op, kind, track, fade, tail).

    Structural filter — the three operand words that are zero in every confirmed
    instruction must be zero here too. Without it the scan is ~9% noise.
    """
    n = len(data) // 2
    w = struct.unpack(f"<{n}H", data[:n * 2])
    out = []
    for i in range(n - 8):
        if w[i] not in SOUND_OPS or w[i + 1] >= N_KINDS:
            continue
        if w[i + 3] or w[i + 5] or w[i + 6] or w[i + 7]:
            continue
        out.append((i * 2, w[i], w[i + 1], w[i + 2], w[i + 4], w[i + 8]))
    return out


def streams(f):
    """The 29 streamed music/ambience tracks, from the SD_CALL.IRX table.

    What the record's third word is NOT: the stream's length. It disagrees with the actual
    data size on 9 of the 29 (record 4 declares 282 sectors where the data needs 243;
    record 17 declares 452 where the data needs 526), so it is something else — a play or
    loop length, unread. The authoritative size is the one in each stream's own `Svag`
    header, and that is what this trusts. Recorded as `sectors` but never used to compute
    an offset; believing it would have handed the editor truncated audio on six tracks and
    run two others off their end.

    Correct-or-absent: every record must start on a readable `Svag`, starts must strictly
    increase from 0, each stream's data must end before the next one starts, and the last
    must end inside STR.BIN.
    """
    f.seek(SDCALL_TABLE)
    recs = [struct.unpack("<4I", f.read(16)) for _ in range(N_STREAMS)]
    out, prev = [], -1
    for i, (fid, start, ln, flags) in enumerate(recs):
        if fid != 0 or start <= prev:
            raise SystemExit(f"stream record {i} out of order (file={fid} start={start})")
        prev = start
        f.seek(STR_BASE + start * SEC)
        head = f.read(SVAG_DATA)
        if head[0x400:0x404] != b"Svag":
            raise SystemExit(f"record {i} has no Svag header at sector {start}")
        size, rate, ch, inter = struct.unpack_from("<4I", head, 0x404)
        if not (1 <= ch <= 2 and 8000 <= rate <= 48000):
            raise SystemExit(f"record {i} has an implausible Svag header: {size},{rate},{ch}")
        # PS-ADPCM: 16 bytes carry 28 samples, per channel
        secs = size / ch / (rate * 16 / 28)
        out.append({"i": i, "sect": start, "sectors": ln, "flags": flags,
                    "off": STR_BASE + start * SEC + SVAG_DATA, "bytes": size,
                    "rate": rate, "ch": ch, "inter": inter, "secs": round(secs, 2)})
    for i, st in enumerate(out):
        end = st["sect"] * SEC + SVAG_DATA + st["bytes"]
        limit = out[i + 1]["sect"] * SEC if i + 1 < len(out) else STR_SIZE
        if end > limit:
            raise SystemExit(f"stream {i} runs {end - limit:,} bytes past the next stream")
    return out


def room_audio(rooms):
    """The per-room BGM/ambient fields, off the existing room index.

    s3_rooms.json stores rateOff (record + 4), so the record start is rateOff - 4.
    """
    out = []
    for a in rooms["areas"]:
        for t in a["tables"]:
            for r in t["rooms"]:
                rec = r["rateOff"] - 4
                out.append({"archive": a["archive"], "area": a["area"], "sub": t["sub"],
                            "room": r["room"], "bgmOff": rec + 0x22, "seOff": rec + 0x24})
    return out


def main():
    iso = sys.argv[1] if len(sys.argv) > 1 else None
    if not iso or not os.path.isfile(iso):
        sys.exit(__doc__)
    sub = json.load(open(os.path.join(HERE, "s3_subfiles.json")))
    rooms = json.load(open(os.path.join(HERE, "s3_rooms.json")))

    out = {"format": "s3bgm", "schema": 1,
           "note": "Where the game picks music. script[] are opcode 59/60 sound commands "
                   "(trackOff is the absolute ISO offset of the u16 track operand); "
                   "rooms[] are the 0x3C room record's audio fields (+0x22 BGM, +0x24 "
                   "ambient SE). Track ids are unnamed. See Suikoden3_ISO_offsets.md "
                   "'BGM / sound control'.",
           "kindBgm": KIND_BGM, "script": [], "rooms": [], "streams": []}

    bykind = collections.Counter()
    tracks = collections.Counter()
    byarc = collections.defaultdict(collections.Counter)
    raw = 0

    with open(iso, "rb") as f:
        for arc, off, size, label in town_subfiles(sub):
            f.seek(off)
            data = f.read(size)
            n = len(data) // 2
            w = struct.unpack(f"<{n}H", data[:n * 2])
            raw += sum(1 for i in range(n - 8)
                       if w[i] in SOUND_OPS and w[i + 1] == KIND_BGM)
            for o, op, kind, track, fade, tail in cues(data):
                bykind[kind] += 1
                if kind != KIND_BGM:
                    continue
                tracks[track] += 1
                byarc[arc][track] += 1
                out["script"].append({"archive": arc, "label": label, "op": op,
                                      "track": track, "fade": fade, "tail": tail,
                                      "trackOff": off + o + 4})

        out["rooms"] = room_audio(rooms)
        out["streams"] = streams(f)

        # Every emitted offset must re-read the value the index claims for it.
        bad = 0
        for c in out["script"]:
            f.seek(c["trackOff"])
            if struct.unpack("<H", f.read(2))[0] != c["track"]:
                bad += 1
        seen = set()
        for r in out["rooms"]:
            f.seek(r["bgmOff"])
            r["bgm"], r["se"] = struct.unpack("<HH", f.read(4))
            if r["bgmOff"] in seen:
                bad += 1
            seen.add(r["bgmOff"])

    path = os.path.join(HERE, "s3_bgm.json")
    with open(path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    kept = len(out["script"])
    print(f"{kept} BGM script cues + {len(out['rooms'])} room records "
          f"-> {path} ({os.path.getsize(path):,} bytes)")
    print(f"readback mismatches: {bad}   (must be 0)")
    print(f"structural filter kept {kept}/{raw} raw kind-{KIND_BGM} hits "
          f"({100 * kept / raw:.0f}%)")
    print(f"\nsound commands by kind: "
          f"{', '.join(f'{k}:{v}' for k, v in sorted(bykind.items()))}")
    print(f"\n{len(tracks)} distinct BGM track ids:")
    for t, c in sorted(tracks.items(), key=lambda x: -x[1]):
        print(f"   0x{t:04X} ({t:5d}) : {c:5d} cue(s)")
    print(f"\n{len(out['streams'])} streamed tracks in /SD/STR.BIN "
          f"(~{sum(s['secs'] for s in out['streams']) / 60:.1f} min; sizes come from each "
          f"Svag header, not the table's third word):")
    for st in out["streams"]:
        print(f"   [{st['i']:2}] sect {st['sect']:>6} +{st['sectors']:<6} "
              f"{st['bytes']:>10,}B  {st['rate']}Hz ch{st['ch']}  "
              f"{int(st['secs']) // 60}m{st['secs'] % 60:04.1f}s")
    print("\nper archive:")
    for arc in sorted(byarc):
        ids = ", ".join(f"0x{t:04X}x{c}" for t, c in
                        sorted(byarc[arc].items(), key=lambda x: -x[1]))
        print(f"   {arc:5s} {ids}")


if __name__ == "__main__":
    main()
