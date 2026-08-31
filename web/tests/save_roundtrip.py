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
    b[base + s3save.OFF_ID] = s3save.ROSTER_IDS[0]
    b[base + s3save.OFF_LEVEL] = 10
    b[base + s3save.OFF_WEAPONLV] = 4
    struct.pack_into("<H", b, base + s3save.OFF_CURHP, 100)
    struct.pack_into("<H", b, base + s3save.OFF_MAXHP, 181)
    struct.pack_into("<H", b, base + s3save.OFF_EXP, 500)
    struct.pack_into("<H", b, base + s3save.STAT_OFFSETS["PWR"], 58)
    b[base + s3save.OFF_SKILLS + 0] = 6                              # skill slot 0 id
    b[base + s3save.OFF_SKILLS + 1] = 3                              # skill slot 0 rank
    # roster 1 (Chris) with its own id, so an offset/roster shift shows up as a mismatch
    b[s3save.CHAR_BASE + s3save.CHAR_STRIDE + s3save.OFF_ID] = s3save.ROSTER_IDS[1]
    b[s3save.CHAR_BASE + s3save.CHAR_STRIDE + s3save.OFF_LEVEL] = 31
    # a pre-merge bag: a stackable consumable, then a rune held the way the game holds
    # several copies of a one-per-slot item — one per slot, count 0
    struct.pack_into("<HH", b, s3save.INV_BASE + 0 * s3save.INV_ENTRY, 0x001, 6)   # Medicine D
    struct.pack_into("<HH", b, s3save.INV_BASE + 1 * s3save.INV_ENTRY, 0x1CC, 0)   # Fury rune
    struct.pack_into("<HH", b, s3save.INV_BASE + 2 * s3save.INV_ENTRY, 0x1CC, 0)   # Fury rune
    # an ornament flagged "on display in the castle" (bit 15 is a flag, not part of the id)
    struct.pack_into("<HH", b, s3save.INV_BASE + 3 * s3save.INV_ENTRY,
                     0x1DB | s3save.ITEM_FLAG_DISPLAYED, 0)                        # Graffiti
    # roster 0 recruited; roster 1 NOT recruited (so we can recruit it via an edit)
    struct.pack_into("<H", b, s3save.RECRUIT_OFF + 0 * 2, s3save.RECRUIT_DEFAULT)
    # active party slot 0 = Hugo
    struct.pack_into("<H", b, s3save.PARTY_OFF + 0 * 2, 1)
    # a name field (player-entered = half-width ASCII)
    nm = "TESTHERO".encode("latin1")
    off, n = s3save.NAME_OFF["flameChampion"]
    b[off:off + len(nm)] = nm
    # a carryover name stored full-width Shift-JIS, like a real save's imported S1 hero
    fw = s3save._to_fullwidth("McDohl").encode("shift_jis")
    o2, _ = s3save.NAME_OFF["s1Hero"]
    b[o2:o2 + len(fw)] = fw
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
    check("weapon (sharpen) level decoded separately from level", hugo["weaponLv"] == 4)
    check("curHP decoded", hugo["curHP"] == 100)
    check("maxHP decoded", hugo["maxHP"] == 181)
    check("PWR stat decoded", hugo["stats"]["PWR"] == 58)
    check("skill slot 0 decoded", hugo["skills"][0]["id"] == 6 and hugo["skills"][0]["rank"] == 3)
    check("roster 0 recruited, roster 1 not",
          hugo["recruited"] and not next(c for c in s["characters"] if c["rosterIndex"] == 1)["recruited"])
    check("name decoded", any(n["value"] == "TESTHERO" for n in s.get("names", [])))
    check("full-width Shift-JIS carryover name decodes to half-width",
          any(n["key"] == "s1Hero" and n["value"] == "McDohl" for n in s.get("names", [])))
    check("synth checksum is valid (words sum to 0)", sum_words(open(path, "rb").read()) == 0)

    # --- layout guards (issue #5) -------------------------------------------------------
    # The original bug was a silent mislabel: level was read from the weapon-level byte and
    # nothing complained. These assert the properties that made the wrong offsets wrong, so
    # a future drift fails here instead of shipping.
    print("Character-record layout guards:")
    check("level and weapon level are different bytes",
          s3save.OFF_LEVEL != s3save.OFF_WEAPONLV)
    check("curHP and maxHP are different bytes", s3save.OFF_CURHP != s3save.OFF_MAXHP)
    check("seven stats, no phantom eighth", len(s3save.STAT_NAMES) == 7 and
          len(set(s3save.STAT_OFFSETS.values())) == 7, str(s3save.STAT_NAMES))
    scalar = {k: v[0] for k, v in s3save.CHAR_FIELDS.items()}
    spans = [(o, o + w) for o, w, _ in s3save.CHAR_FIELDS.values()] + \
            [(o, o + 2) for o in s3save.STAT_OFFSETS.values()] + \
            [(o, o + 2) for _, o in s3save.EQUIP_SLOTS] + \
            [(s3save.OFF_ID, s3save.OFF_ID + 1),
             (s3save.OFF_SKILLS, s3save.OFF_SKILLS + s3save.SKILL_SLOTS * 2)]
    spans.sort()
    check("no writable character field overlaps another",
          all(spans[i][1] <= spans[i + 1][0] for i in range(len(spans) - 1)), str(spans))
    check("every writable character field fits in the record",
          max(e for _, e in spans) <= s3save.CHAR_STRIDE)
    check("field caps match the game's documented domains",
          scalar["level"] is not None and s3save.LEVEL_MAX == 99 and
          s3save.WEAPONLV_MAX == 16 and s3save.ITEM_QTY_MAX == 9)
    check("roster id table covers every roster slot that has a record",
          len(s3save.ROSTER_IDS) <= len(s3save.ROSTER) and
          len(set(s3save.ROSTER_IDS)) == len(s3save.ROSTER_IDS))
    check("record id is validated against the roster (no silent mislabel)",
          hugo["idExpected"] == s3save.ROSTER_IDS[0] and not hugo["idMismatch"])
    shifted = bytearray(open(path, "rb").read())
    shifted[s3save.CHAR_BASE + s3save.OFF_ID] = 99          # wrong character in slot 0
    warn_shift = s3save.decode_save(bytes(shifted))["problems"]
    check("a roster/id shift is reported, not swallowed",
          any("id mismatch" in w for w in warn_shift), str(warn_shift))
    swapped = bytearray(open(path, "rb").read())
    struct.pack_into("<H", swapped, s3save.CHAR_BASE + s3save.OFF_CURHP, 9999)
    check("current HP above max HP is reported",
          any("current HP" in w for w in s3save.decode_save(bytes(swapped))["problems"]))
    # The save title states the chapter protagonist's level, so a save carries its own
    # answer for the field this issue got wrong.
    stale = s3save.decode_save(open(path, "rb").read(), {"level": 77})
    check("a level that contradicts the save title is reported",
          any("level offset is wrong" in w for w in stale["warnings"]))
    check("...and it is a NOTE, not a layout problem — the title goes stale whenever this "
          "editor changes that level, so it must not read as corruption",
          len(stale["notes"]) == 1 and not stale["problems"])
    check("...and the message names the benign cause (an edit made here) first, so editing "
          "a protagonist's level does not read as corruption",
          any("Expected if you changed that level here" in w
              for w in s3save.decode_save(open(path, "rb").read(), {"level": 77})["warnings"]))
    check("a level that matches the save title is accepted",
          not s3save.decode_save(open(path, "rb").read(), {"level": 10})["warnings"],
          str(s3save.decode_save(open(path, "rb").read(), {"level": 10})["warnings"]))

    print("Inventory layout guards:")
    for phase in (0, s3save.MERGE_PHASE):
        regs = s3save.inv_regions(phase)
        spans = sorted((base, base + cap * s3save.INV_ENTRY) for _, base, cap in regs)
        check("phase %d bag layout tiles the region with no gap or overlap" % phase,
              spans[0][0] == s3save.INV_BASE and
              all(spans[i][1] == spans[i + 1][0] for i in range(len(spans) - 1)) and
              spans[-1][1] == s3save.INV_BASE + s3save.INV_BLOCKS * s3save.INV_BLOCK,
              str([(hex(a2), hex(b2)) for a2, b2 in spans]))
        check("phase %d exposes all %d bag slots" % (phase, s3save.INV_BLOCKS * 30),
              sum(c for _, _, c in regs) == s3save.INV_BLOCKS * 30)
    check("stackable classification matches the id bands",
          s3save.item_stackable(0x001) and s3save.item_stackable(0x1F1) and
          not s3save.item_stackable(0x1CC) and not s3save.item_stackable(0x0D3) and
          not s3save.item_stackable(0x211))
    # Nine real ids contradict a pure band test; a regression here silently reintroduces the
    # "count on a one-per-slot item" bug for stat stones instead of runes.
    check("the stat stones are one-per-slot despite the consumable band",
          all(not s3save.item_stackable(i) for i in range(0x0B, 0x12)))
    check("Sacrificial Jizo / Dragon Incense are one-per-slot",
          not s3save.item_stackable(0x9E) and not s3save.item_stackable(0x9F))
    check("Grape carries a count despite being a key item", s3save.item_stackable(0x202))
    # The save's own entries refine the guess for the ~58% of ids the corpus never covered,
    # but only ever toward one-per-slot — a save damaged by an older build must not teach it
    # that a rune carries a count.
    probe = bytearray(open(path, "rb").read())
    struct.pack_into("<HH", probe, s3save.INV_BASE + 20 * s3save.INV_ENTRY, 0x1CC, 1)
    check("a bogus count on a rune (older build's damage) does NOT promote it to stackable",
          not s3save.item_stackable_for(bytes(probe), 0x1CC))
    # Demotion needs EVERY entry for that id to read 0 — one stray zero alongside a real
    # count must not demote an item the save also holds properly.
    struct.pack_into("<HH", probe, s3save.INV_BASE + 21 * s3save.INV_ENTRY, 0x006, 0)
    check("the save's own count-0 entries demote a band-stackable item",
          not s3save.item_stackable_for(bytes(probe), 0x006))
    struct.pack_into("<HH", probe, s3save.INV_BASE + 22 * s3save.INV_ENTRY, 0x006, 4)
    check("a stray count-0 entry alongside a real count does not demote",
          s3save.item_stackable_for(bytes(probe), 0x006))
    check("an item the save says nothing about falls back to the band rule",
          s3save.item_stackable_for(bytes(probe), 0x004) is s3save.item_stackable(0x004))
    bags = {b2["region"]: b2 for b2 in s["inventory"]}
    hugo_bag = bags["Hugo"]
    check("pre-merge layout names the four team bags and their storage",
          set(bags) == {t for t in s3save.INV_TEAMS} | {t + " storage" for t in s3save.INV_TEAMS},
          str(sorted(bags)))
    check("the two one-per-slot Fury Runes both decode (not merged, not hidden)",
          [it["id"] for it in hugo_bag["items"]].count(0x1CC) == 2)
    check("a 0x8000-flagged ornament decodes as a real item on display",
          any(it["id"] == 0x1DB and it["displayed"] for it in hugo_bag["items"]))
    check("a 0x8000-flagged slot is NOT offered as free (it holds a real item)",
          (s3save.INV_BASE + 3 * s3save.INV_ENTRY - s3save.INV_BASE) // s3save.INV_ENTRY
          not in hugo_bag["freeSlots"])
    check("appendSlots only sit after the last used entry",
          hugo_bag["appendSlots"] and min(hugo_bag["appendSlots"]) == 4,
          str(hugo_bag["appendSlots"][:4]))
    check("stackable/one-per-slot is reported per item",
          all(it["stackable"] == s3save.item_stackable(it["id"]) for it in hugo_bag["items"]))

    # --- edit (mirrors the web app's payload shape) ---
    res = s3save.write_save_edits(
        path, s["folder"],
        {0: {"level": 50, "maxHP": 9999, "stats": {"PWR": 250},
             "skills": {0: {"id": 7, "rank": 8}}}},
        make_backup=False,
        name_edits={"flameChampion": "Zephon", "s1Hero": "Tir"},
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
    check("edit to a full-width name re-reads as half-width",
          any(n["key"] == "s1Hero" and n["value"] == "Tir" for n in s2.get("names", [])))
    _o, _n = s3save.NAME_OFF["s1Hero"]
    _raw = open(path, "rb").read()[_o:_o + _n].split(b"\x00")[0]
    check("edit to a full-width name stays full-width Shift-JIS", any(byte >= 0x80 for byte in _raw))
    check("party slot persisted", s2["party"][1] == 63)
    check("party slot 1 names the character it was set to (Luc, party id 63)",
          s3save.party_name(s2["party"][1]) == "Luc", s3save.party_name(s2["party"][1]))
    check("recruit persisted (recruited + recruiter)", r1["recruited"] and r1["recruiter"] == "Chris")
    check("checksum invariant holds after write", sum_words(open(path, "rb").read()) == 0)

    # --- multi-team: a character can carry several protagonists' team bits (0x3C) at once ---
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False,
        recruit_edits={1: {"recruited": True, "teams": ["Hugo", "Chris", "Geddoe"]}})
    r1b = next(c for c in s3save.read_all_s3_saves(path)[0]["characters"] if c["rosterIndex"] == 1)
    check("multi-team persisted (all three team bits set)",
          set(r1b["recruiters"]) == {"Hugo", "Chris", "Geddoe"} and r1b["recruited"])
    check("checksum invariant holds after multi-team write", sum_words(open(path, "rb").read()) == 0)

    # --- inventory write semantics (issue #5) -------------------------------------------
    # The reported failure: three Fury Runes added as ONE slot with a count of 3 showed up
    # in game, but attaching one freed the whole slot and took the spares with it, and the
    # entry did not survive a chapter transition. Real saves never hold a rune that way —
    # equipment/runes/key items are one per slot with the count at 0 — so the engine must
    # force the count regardless of what the caller asks for.
    print("Inventory write semantics:")
    inv0 = s3save.decode_inventory(open(path, "rb").read())
    free = inv0[0]["appendSlots"]
    rune_slot, cons_slot, third = free[0], free[1], free[2]
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False, inv_edits={
        rune_slot: {"id": 0x1CC, "qty": 3},     # a rune, asked for with a count of 3
        cons_slot: {"id": 0x001, "qty": 4},     # a stackable consumable
        third:     {"id": 0x001, "qty": 99},    # over the game's 0-9 count cap
    })
    inv1 = s3save.decode_inventory(open(path, "rb").read())
    bag1 = {it["slot"]: it for it in inv1[0]["items"]}
    check("a rune written with a count is forced to one-per-slot (count 0)",
          bag1[rune_slot]["id"] == 0x1CC and bag1[rune_slot]["qty"] == 0,
          "qty=%s" % bag1[rune_slot]["qty"])
    check("a stackable consumable keeps its count", bag1[cons_slot]["qty"] == 4)
    check("a count over the game's cap is clamped to %d" % s3save.ITEM_QTY_MAX,
          bag1[third]["qty"] == s3save.ITEM_QTY_MAX, "qty=%s" % bag1[third]["qty"])
    check("three copies of a one-per-slot item = three slots",
          [it["id"] for it in inv1[0]["items"]].count(0x1CC) == 3)
    check("checksum invariant holds after inventory writes",
          sum_words(open(path, "rb").read()) == 0)

    # Adding an item with no count at all is the UI's normal path — the engine picks the
    # count from the item, not from a hardcoded 1.
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False,
                            inv_edits={free[3]: {"id": 0x1CC}, free[4]: {"id": 0x001}})
    bag2 = {it["slot"]: it for it in s3save.decode_inventory(open(path, "rb").read())[0]["items"]}
    check("a new one-per-slot item defaults to count 0", bag2[free[3]]["qty"] == 0)
    check("a new stackable item defaults to count 1", bag2[free[4]]["qty"] == 1)

    # The "on display in the castle" flag belongs to the item, so a count-only edit keeps it
    # and swapping the item out drops it.
    disp = next(it for it in inv1[0]["items"] if it["id"] == 0x1DB)
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False,
                            inv_edits={disp["slot"]: {"id": 0x1DB}})
    still = next(it for it in s3save.decode_inventory(open(path, "rb").read())[0]["items"]
                 if it["slot"] == disp["slot"])
    check("re-writing the same item keeps its on-display flag", still["displayed"])
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False,
                            inv_edits={disp["slot"]: {"id": 0x001}})
    swapped_it = next(it for it in s3save.decode_inventory(open(path, "rb").read())[0]["items"]
                      if it["slot"] == disp["slot"])
    check("replacing the item clears the on-display flag",
          not swapped_it["displayed"] and swapped_it["id"] == 0x001)
    check("clearing a slot zeroes id and count",
          not any(it["slot"] == disp["slot"] for it in s3save.decode_inventory(
              s3save.apply_edits_to_gamedata(open(path, "rb").read(), {},
                                             inv_edits={disp["slot"]: {"id": 0}})[0])[0]["items"]))

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

    # --- the party id space -------------------------------------------------
    # 0x3216 and the leader byte at 0x12 hold PARTY_IDS values, which are neither the exe
    # list1 ids nor the record id at block +0x0C. Both wrong readings are self-consistent —
    # the editor shows back what you picked while the game loads someone else — so the
    # divergences are pinned here rather than left to a plausible-looking refactor.
    print("Party id space:")
    check("PARTY_IDS covers the 75 roster slots that have a character block",
          len(s3save.PARTY_IDS) == 75)
    check("PARTY_IDS is 1:1", len(set(s3save.PARTY_IDS)) == len(s3save.PARTY_IDS))
    check("PARTY_IDS rises with roster order",
          all(b > a for a, b in zip(s3save.PARTY_IDS, s3save.PARTY_IDS[1:])))
    check("every party id round-trips back to its roster slot",
          all(s3save.party_roster_index(s3save.party_id_of(ri)) == ri
              for ri in range(len(s3save.PARTY_IDS))))
    # Hugo..Aila (roster 0-10) are the run where all three id spaces happen to agree.
    check("Hugo..Aila are rosterIndex+1 in the party space",
          s3save.PARTY_IDS[:11] == list(range(1, 12)))
    # The four documented divergences, by name, from the reference's Party Modifier digits.
    for ri, want in ((11, 13), (30, 32), (47, 54), (74, 82)):
        check("%s is party id %d" % (s3save.ROSTER[ri], want),
              s3save.party_id_of(ri) == want)
    # The bug this table fixes: neither of the other two ids a character carries addresses
    # him in a party slot — Bright's list1 id (31) loads Futch, his record id (73) Augustine.
    bright = s3save.ROSTER.index("Bright")
    check("Bright's party id differs from his list1 id",
          s3save.party_id_of(bright) != bright + 1)
    check("Bright's party id differs from his record id",
          s3save.party_id_of(bright) != s3save.ROSTER_IDS[bright])
    check("Bright's list1 id names Futch in the party space",
          s3save.party_name(bright + 1) == "Futch", s3save.party_name(bright + 1))
    check("Bright's record id names someone else in the party space",
          s3save.party_name(s3save.ROSTER_IDS[bright]) not in ("", "Bright"),
          s3save.party_name(s3save.ROSTER_IDS[bright]))
    # Ids a save can legitimately carry that have no character block of their own.
    check("Koroku's dogs are named but not pickable",
          s3save.party_name(0xD2) == "Koichi" and 0xD2 not in s3save.PARTY_IDS)
    check("the Special Characters are named", s3save.party_name(0xCA) == "Masked Luc")
    check("an id the reference does not name stays unnamed", s3save.party_name(0x1234) == "")

    # A party edit writes the party id verbatim, and re-decodes as that character.
    s3save.write_save_edits(path, s["folder"], {}, make_backup=False,
                            party_edits={2: s3save.party_id_of(bright)})
    s3 = s3save.read_all_s3_saves(path)[0]
    check("staging Bright writes his party id (32), not 31 or 73", s3["party"][2] == 32)
    check("...and re-decodes as Bright", s3save.party_name(s3["party"][2]) == "Bright")
    check("checksum invariant holds after the party write",
          sum_words(open(path, "rb").read()) == 0)

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
