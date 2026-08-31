#!/usr/bin/env python3
"""
Suikoden III PS2 memory-card save reader (read-only, stdlib only).

This is the save-editing counterpart to s3patch.py (which edits the ISO). It does
NOT touch the ISO and does NOT require one. It opens an 8 MB PS2 memory-card image
(*.ps2 / *.mcd), walks the PS2MFS filesystem, finds the Suikoden III USA save
folders (BASLUS-20387...), and decodes each save's `gamedata` payload.

Layout facts (validated 2026-08-10 against 4 real saves + the herrvillain save-offset
map; character-record and inventory offsets re-derived 2026-08-30 from a 28-save corpus
for github issue #5 — see Editor/Suikoden3_ISO_offsets.md):
  - Card pages are 512 data + 16 ECC spare = 528 bytes on disk.
  - `gamedata` is 53264 (0xD010) bytes; meaningful data ends ~0xCE48.
  - Character records: base 0x33AC, stride 0x8C (140 bytes), roster order
    Hugo, Chris, Geddoe, Lucia, Fred, Rico, Viki, Fubar, ... (the real story Flame
    Champion record sits one block earlier and is not a party member).
    Per record: +0x00 u16 EXP progress in level, +0x0C u8 char id, +0x0D u8 weapon
    (sharpen) level, +0x10 skills, +0x20.. u16 stat block, +0x30 u16 current HP,
    +0x32 u16 max HP, +0x40 u8 LEVEL, +0x44.. equipment.
  - Inventory: eight 30-entry bags at 0x7060 + n*0xF0; what they mean depends on the
    story phase (see inv_regions). Entry = u16 item id | 0x8000 "on display", u16 count
    (stackables only), 4 bytes of per-item state.
  - Global: +0x12 party-leader id, +0x14 story phase (>= 5 == the parties have merged).

WRITING is intentionally not implemented yet: gamedata word@0 is a checksum whose
algorithm is not yet cracked, so writing a modified save could make it fail to load.
This module is the read-only foundation; write support is gated on solving that.
"""
import struct, os, glob, shutil, unicodedata

MAGIC = b"Sony PS2 Memory Card Format"
S3_PREFIX = "BASLUS-20387"     # USA Suikoden III save-folder prefix on the memcard

# --- PS2 memory-card ECC (Hamming) — verbatim from mymc (Ross Ridge, public domain).
# Validated against every non-erased data page of a real card (0 mismatches). Each
# 128-byte chunk -> 3 bytes: [column_parity, line_parity_0, line_parity_1].
def _parityb(a):
    a ^= a >> 1; a ^= a >> 2; a ^= a >> 4
    return a & 1
_PARITY = [_parityb(b) for b in range(256)]
_CPM = [0] * 256
for _b in range(256):
    _m = 0
    for _i, _msk in enumerate([0x55, 0x33, 0x0F, 0x00, 0xAA, 0xCC, 0xF0]):
        _m |= _PARITY[_b & _msk] << _i
    _CPM[_b] = _m

def ecc_chunk(chunk):
    """Hamming code for a 128-byte chunk -> bytes([col, lp0, lp1])."""
    cp = 0x77; lp0 = 0x7F; lp1 = 0x7F
    for i in range(len(chunk)):
        b = chunk[i]
        cp ^= _CPM[b]
        if _PARITY[b]:
            lp0 ^= ~i
            lp1 ^= i
    return bytes([cp & 0xFF, lp0 & 0x7F, lp1 & 0xFF])

def ecc_page(page512):
    """16-byte spare (12 ECC + 4 zero) for a 512-byte page."""
    out = b"".join(ecc_chunk(page512[i*128:(i+1)*128]) for i in range(4))
    return out + b"\x00\x00\x00\x00"

# --- gamedata checksum: the sum of all little-endian u32 words == 0 (mod 2^32).
# Verified across 4 real saves. word@0 stores the value that makes the sum zero.
def gamedata_checksum(data):
    words = struct.unpack_from("<%dI" % ((len(data) // 4) - 1), data, 4)
    return (-sum(words)) & 0xFFFFFFFF

def fix_gamedata_checksum(data):
    """Return a copy of gamedata with word@0 recomputed so all u32 sum to 0."""
    b = bytearray(data)
    struct.pack_into("<I", b, 0, gamedata_checksum(bytes(b)))
    return bytes(b)

# --- character record layout (offsets within the 140-byte block) ---------------
CHAR_BASE   = 0x33AC
CHAR_STRIDE = 0x8C
CHAR_COUNT  = 100              # map documents ~99 slots incl. the real Flame Champion
OFF_EXP     = 0x00            # u16 EXP progress inside the current level, 0..999
OFF_ID      = 0x0C            # u8 character id
OFF_WEAPONLV = 0x0D           # u8 weapon (sharpen) level, 1..16
OFF_SKILLS  = 0x10            # 8 x (skill id u8, rank u8) — verified vs skill-id table
SKILL_SLOTS = 8
OFF_STATS   = 0x20            # u16 stat block, see STAT_OFFSETS (0x28 is NOT a stat)
OFF_CURHP   = 0x30            # u16 current HP
OFF_MAXHP   = 0x32            # u16 max HP
OFF_LEVEL   = 0x40            # u8 character level, 1..99
EXP_MAX     = 999             # level-up fires at 1000; 990 is the highest value observed
WEAPONLV_MAX = 16             # herrvillain doc: weapon level 1-16
LEVEL_MAX   = 99
# ---------------------------------------------------------------------------
# Offsets corrected 2026-08-30 (github issue #5) against 28 real saves — 2100 non-empty
# character records — extracted from every save in the corpus. What was wrong and why the
# new values are right:
#
#   LEVEL. Was 0x0D; the real level is 0x40. The PS2 browser title of every S3 save carries
#   the chapter protagonist's level ("Suikoden3〔07〕Cpt.4 L54/ 61:15"), and 0x40 matches it
#   in 20/20 saves that have a title, across all four protagonists (see PHASE_PROTAGONIST).
#   0x0D is the WEAPON (sharpen) level: its domain over the corpus is exactly 1..16 — the
#   documented weapon-level cap — and it reads 1 for all five non-human units (Fubar,
#   Bright, Ruby, Koroku, Gadget Z), which carry no weapon. A chapter-2 Chris with a
#   sharpen-8 weapon is what the old code reported as "Lv8".
#
#   CUR/MAX HP. Was (0x08, 0x30); the real pair is (0x30, 0x32). cur <= max holds in
#   2100/2100 records with the new pair, and the old pair violates it 47 times. 0x30 and
#   0x32 are equal for a character saved at full health and differ exactly for the wounded
#   ones. 0x08 is a separate u32 counter of unknown meaning — no longer read or written.
#
#   STATS. Suikoden III has SEVEN stats, not eight (confirmed against s3_growth_ref.json,
#   which lists PWR/SKL/MAG/REP/MDF/SPD/LUK + HP). The old 8-name list inserted a phantom
#   "PDF" at 0x28, a slot that is zero for every human record and nonzero only for the five
#   non-human units — so editing "PDF" poked a byte whose meaning is unknown. The seven
#   real stats keep their previously-verified offsets; only the phantom is gone.
#
#   EXP. 0x00 is a u16 (0x02/0x03 are zero in all 2100 records), rises as the character
#   fights, resets on level-up, and never reaches 1000 (max observed 990 at every level
#   band) — i.e. progress inside the current level out of 1000, not a total.
# ---------------------------------------------------------------------------
# stat order confirmed against herrvillain per-character RAM codes (relative spacing)
STAT_NAMES   = ["PWR", "SKL", "MAG", "REP", "MDF", "SPD", "LUK"]
STAT_OFFSETS = {"PWR": 0x20, "SKL": 0x22, "MAG": 0x24, "REP": 0x26,
                "MDF": 0x2A, "SPD": 0x2C, "LUK": 0x2E}

# Which protagonist's level the save title reports, keyed by story phase (0x14). Verified on
# every titled save in the corpus: phases 1-4 are the four pre-merge chapters, and from the
# merge (phase 5+) the title tracks Hugo. Used by validate_save() to cross-check the level
# offset against a value the save itself carries, so an offset drift fails loudly.
PHASE_PROTAGONIST = {1: "Hugo", 2: "Chris", 3: "Geddoe", 4: "Thomas"}
MERGE_PHASE = 5               # story phase at which the three parties (and bags) merge

# Character id stored at +0x0C of each record, per roster index. Unanimous across all 28
# saves in the corpus (zero disagreements), which is what disproves the "roster order is
# off" theory. Mostly rosterIndex+1, except the five non-human units, which live in their
# own 72.. id band: Fubar 72, Bright 73, Ruby 74, Koroku 75. Roster slots past 74 are the
# non-combat 108 Stars — they have no character record at all, so their expected id is
# None. decode_character() reports a mismatch instead of silently mislabeling a row.
ROSTER_IDS = [
    1, 2, 3, 4, 5, 6, 7, 72,
    8, 9, 10, 11, 12, 13, 14, 15,
    16, 17, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 28, 29, 73, 30,
    31, 32, 33, 34, 74, 35, 36, 37,
    38, 39, 40, 41, 42, 43, 44, 75,
    45, 46, 47, 48, 49, 50, 51, 52,
    53, 54, 55, 56, 57, 58, 59, 60,
    61, 62, 63, 64, 65, 66, 67, 68,
    69, 70, 71,
]

# Active-party composition: up to 6 member ids (u16) at file 0x3216 (herrvillain map).
# 0 = empty slot. The leader byte at 0x12 uses the same numbering.
PARTY_OFF   = 0x3216
PARTY_SLOTS = 6

# ---------------------------------------------------------------------------
# The party id space. This is a THIRD numbering, and getting it wrong is invisible:
# both the wrong read and the wrong write are self-consistent, so the editor shows you
# back exactly what you picked while the game loads somebody else (or nobody).
#
#   * list1 (Editor/s3_names.json)      — the exe's stat-record table, 1..79
#   * the record id at block +0x0C      — ROSTER_IDS above; Fubar 72, Bright 73, Ruby 74,
#                                         Koroku 75, everyone else rosterIndex+1
#   * PARTY_IDS (this table)            — what 0x3216 and 0x12 actually hold
#
# PARTY_IDS is the "Party Modifier digits" of the herrvillain cheat reference
# (Cheat files/Cheat info/Suikoden III Cheat Codes.pdf, "Party Modifier Digits" ->
# "Battle Characters"). It agrees with list1 for 0x01-0x0B (Hugo..Aila) and then diverges,
# because it reserves ids the roster does not: gaps at 0x0C, 0x21, 0x25-0x27, 0x2B, 0x40.
# So Roland is list1 12 but party id 0x0D, Bright list1 31 but 0x20, Koroku list1 48 but
# 0x36, Emily list1 75 but 0x52.
#
# Confirmed against the 20-save playthrough corpus + the 5 extracted gamedata blobs: under
# this table every stored party decodes to a party the game actually builds, and under the
# old list1 reading none of them did.
#
#   0x3216                 this table                  read as list1 (wrong)
#   [2,13,18,20,21,45]     Chris + Roland + Leo +      Chris, Lilly, Beecham, Borus,
#                          Percival + Borus + Salome   Queen, Nash
#                          (the Zexen knights)
#   [3,17,22,24,23,11]     Geddoe + Ace + Queen +      Geddoe, Leo, Jacques, Duke,
#                          Joker + Jacques + Aila      Joker, Aila
#                          (his mercenaries)
#   [1,54,210,211,212,213] Hugo + Koroku + Koichi +    Hugo, Yumi, and four ids that
#                          Connie + Kosanji + Kogoro   decode to nothing at all
#   [63,66,65]             Luc + Sarah + Yuber         Hallec, Augustine, Twaikin
#
# and the leader byte on both phase-4 (Thomas chapter) saves reads 29 = Thomas here, but
# "Cecile" through list1.
#
# Indexed by roster index, so it lines up with the recruit table and the character blocks.
# Roster slots past 74 are the non-combat 108 Stars: they have their own "Support
# Characters" digits (a different field — the support slot at 0x3252, which this editor
# does not expose), so they are not battle-party ids and are absent here.
PARTY_IDS = [
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24, 25,
    26, 27, 28, 29, 30, 31, 32, 34,
    35, 36, 40, 41, 42, 44, 45, 46,
    47, 48, 49, 50, 51, 52, 53, 54,
    55, 56, 57, 58, 59, 60, 61, 62,
    63, 65, 66, 67, 68, 69, 70, 71,
    72, 73, 74, 75, 76, 77, 78, 79,
    80, 81, 82,
]
PARTY_ROSTER = {pid: ri for ri, pid in enumerate(PARTY_IDS)}

# Party ids with no character block of their own, so they can be shown but not edited
# coherently: the four dogs of Koroku's bonus chapter (list1 76-79, no roster slot) and the
# "Special Characters" the same reference lists. Real saves carry these — gamedata_u03 holds
# the dogs, and two corpus saves are led by 0xCA "Masked Luc" — so naming them is the
# difference between a readable party and a row of bare numbers.
PARTY_EXTRA_NAMES = {
    0xD2: "Koichi", 0xD3: "Connie", 0xD4: "Kosanji", 0xD5: "Kogoro",
    0xCA: "Masked Luc", 0xCB: "Grasslands Chris", 0xCC: "Masked Kidd",
    0xCD: "Flame Champion", 0xCE: "Wyatt Lightfellow", 0xCF: "Sana",
    0xD0: "Fire Bringer", 0xD1: "Ruby (special)", 0xD6: "Ultra Gadget Z",
    0xD7: "Zexen Aila",
}


def party_id_of(roster_index):
    """Party id for a roster slot, or None for the support-only 108 Stars."""
    if 0 <= roster_index < len(PARTY_IDS):
        return PARTY_IDS[roster_index]
    return None


def party_roster_index(party_id):
    """Roster slot a party id addresses, or None (guest/NPC/special — no character block)."""
    return PARTY_ROSTER.get(party_id)


def party_name(party_id):
    """Display name for a party id, or '' when the reference does not name it."""
    ri = PARTY_ROSTER.get(party_id)
    if ri is not None:
        return ROSTER[ri]
    return PARTY_EXTRA_NAMES.get(party_id, "")


def party_reference():
    """Everything the UI needs to speak the party id space:
    {"names": {partyId: name}, "roster": {partyId: rosterIndex}, "choices": [partyId...]}.
    `choices` is the pickable set — the battle characters that have a character block, in
    roster order. The named-but-unpickable ids (dogs, Special Characters) appear in `names`
    only, so an existing slot reads correctly without offering an unverified edit."""
    names = {pid: ROSTER[ri] for ri, pid in enumerate(PARTY_IDS)}
    names.update(PARTY_EXTRA_NAMES)
    return {"names": names,
            "roster": dict(PARTY_ROSTER),
            "choices": list(PARTY_IDS)}

# Recruitment table (herrvillain "Recruit Modifiers" region): one u16 per roster slot at
# 0x232 + rosterIndex*2. Nonzero = recruited; 0 = not recruited. Verified by diffing 4
# saves in PLAYTIME order — the count of nonzero words is strictly monotonic (85 -> 105 ->
# 109), the hallmark of a real recruit flag. The specific nonzero value encodes join
# type/orderability per character (0x1C/0x1D/0x21/...), so to recruit we keep an existing
# nonzero value or default to 0x1D (the common fresh-story-recruit value); un-recruit = 0.
RECRUIT_OFF     = 0x232
RECRUIT_DEFAULT = 0x1D
# Within the recruit word, bits 2..5 record WHICH protagonist recruited the character
# (pre-merge, S3 runs three separate parties; a unit is only usable by the hero who
# recruited them until the parties join). Verified by grouping the early save's recruits:
# Hugo -> his Grasslands allies, Chris -> the Zexen knights, Geddoe -> his mercenaries,
# Thomas -> his Chisha castle crew. bit0 (0x01) = recruited; 0x40/0x80 = status/away.
RECRUITER_BITS  = {0x04: "Hugo", 0x08: "Chris", 0x10: "Geddoe", 0x20: "Thomas"}
RECRUITER_MASK  = 0x3C   # bits 2..5
# These are a MASK, not a single value: a character can carry several teams' bits at once.
# Confirmed on real saves — post-merge, the game itself sets shared characters to
# Hugo+Chris+Geddoe (0x1C) simultaneously. So writing multiple bits is a legitimate mechanic,
# not a hack (the editor exposes it as a per-team multi-select).

def recruiter_of(recruit_word):
    """Name of the FIRST protagonist whose team-bit is set, or '' (shared/story)."""
    for bit, nm in RECRUITER_BITS.items():
        if recruit_word & bit:
            return nm
    return ""

def recruiters_of(recruit_word):
    """ALL protagonist team-bits set on this character. Bits 2..5 are a mask, so a character
    can carry several at once — the data-side of "show this recruit on multiple teams"."""
    return [nm for bit, nm in sorted(RECRUITER_BITS.items()) if recruit_word & bit]

# Equipped-gear slots (u16 item ids), located empirically in the save block and matching
# the herrvillain RAM map's 8-byte spacing. Verified: each decodes to a real rune/armor/
# accessory name across all sample saves.
EQUIP_SLOTS = [
    ("headRune",  0x44), ("rightRune", 0x4C), ("leftRune", 0x54),
    ("helm",      0x5C), ("armor",     0x64), ("shield",   0x6C),
    ("boots",     0x74), ("gloves",    0x7C), ("accessory", 0x84),
]

# global (whole-save) fields, from the herrvillain save-offset map
GLOBAL = {
    "partyLeader": (0x12, 1),
    "storyPhase":  (0x14, 1),
}
# Playtime, in seconds, at file 0x28 (u32). CONFIRMED: 1719 == "28:39", exact match to the
# save title across all sample saves. Read-only (cosmetic).
PLAYTIME_OFF = 0x28
# Gold/potch candidate (u32 at 0x3210, just before the party list). LIKELY but UNVERIFIED:
# values are money-shaped and vary like spendable gold across saves, but there's no
# monotonic proof (gold is spent) and no save with a known on-screen potch to confirm.
# Exposed as editable-but-flagged; a wrong value is low-risk and easily fixed in-game.
GOLD_OFF = 0x3210

# Editable name fields (herrvillain map). Fixed 16-char ASCII, 0-terminated, 17-byte
# slots — safe in-place edits. Cross-verified against real saves (Flame Champion name,
# castle name, and the imported Suikoden I/II hero + country names).
NAME_FIELDS = [
    ("flameChampion", 0xC9E0, 16, "Flame Champion name"),
    ("castle",        0xC9F1, 16, "Castle name"),
    ("s1Hero",        0xCA13, 16, "Suikoden I hero name"),
    ("s1Country",     0xCA24, 16, "Suikoden I country/castle"),
    ("s2Hero",        0xCA35, 16, "Suikoden II hero name"),
]

def _read_str(data, off, n):
    raw = data[off:off+n].split(b"\x00")[0]
    # Player-entered names (Flame Champion, castle) are half-width ASCII; the carryover
    # S1/S2 hero/country names are stored full-width Shift-JIS (e.g. "ＭｃＤｏｈｌ"). Decode as
    # Shift-JIS (ASCII is a subset, so half-width names are unaffected) and NFKC-normalize
    # so full-width forms read as plain "McDohl"/"Toran"/"Riou" instead of latin1 garbage.
    try:
        s = raw.decode("shift_jis")
    except Exception:
        s = raw.decode("latin1", "replace")
    return unicodedata.normalize("NFKC", s)


def _to_fullwidth(s):
    """ASCII -> full-width (the form S3 uses for imported S1/S2 carryover names)."""
    return "".join("　" if c == " " else chr(ord(c) + 0xFEE0) if 0x21 <= ord(c) <= 0x7E else c
                   for c in s)

# Suikoden III seeds these carryover name fields with canonical DEFAULTS unless a real
# Suikoden I / II memory-card save is loaded (which overwrites them with that save's
# hero/country). So a value differing from the default is our signal that S1/S2 data was
# actually carried over. (There's no separate boolean load-flag byte in this region.)
S12_DEFAULTS = {"s1Hero": "McDohl", "s1Country": "Toran",
                "s2Hero": "Genkaku Jr.", "s2Country": "Dunan"}

def detect_carryover(gamedata):
    """Report whether Suikoden I / II save data appears to have been loaded, based on
    whether the carryover name fields differ from S3's built-in defaults."""
    s1h = _read_str(gamedata, 0xCA13, 16)
    s1c = _read_str(gamedata, 0xCA24, 16)
    s2h = _read_str(gamedata, 0xCA35, 16)
    s2c = _read_str(gamedata, 0xCA02, 16)   # "SII army/country" per the map
    s1_loaded = (s1h != S12_DEFAULTS["s1Hero"] or s1c != S12_DEFAULTS["s1Country"])
    s2_loaded = (s2h != S12_DEFAULTS["s2Hero"] or s2c != S12_DEFAULTS["s2Country"])
    return {
        "s1": {"loaded": s1_loaded, "hero": s1h, "country": s1c,
               "note": "custom S1 data" if s1_loaded else "default (no S1 save detected)"},
        "s2": {"loaded": s2_loaded, "hero": s2h, "country": s2c,
               "note": "custom S2 data" if s2_loaded else "default (no S2 save detected)"},
    }

# --- Inventory ------------------------------------------------------------------
# Entries are 8 bytes: item id (u16) + count (u16) + 4 bytes of per-item state.
# Empty slot = id 0. The whole region is a uniform array of EIGHT 30-entry bags at
# INV_BASE + n*INV_BLOCK (0x7060 .. 0x77DF); block 8 onward is always zero and the data
# past it (a castle-decoration placement table at 0x7A00) is a different structure.
#
# What the eight blocks MEAN depends on the story phase (corrected 2026-08-30, issue #5):
#
#   Pre-merge (phase < 5): blocks 0-3 are the four teams' carried bags and blocks 4-7 are
#   the same four teams' storage. Proved by which block moves when the story phase changes
#   across the corpus's chapter sequence: phase 1 -> {0,4}, 2 -> {1,5}, 3 -> {2,6},
#   4 -> {3,7}, with no cross-talk.
#
#   Post-merge (phase >= 5): block 0 is the single shared party bag and blocks 1-7 are ONE
#   contiguous 210-slot shared storage. Proved by a fully-stocked endgame save where blocks
#   1-7 form a single ascending run — each block's last id equals the next block's first —
#   and by the fill order: block n+1 only holds items once block n is full.
#
# The old model (four bags plus a single 90-slot "Storage" at 0x7420) mislabeled blocks 1-3
# after the merge, invented one list spanning three independent pre-merge lists, and never
# exposed block 7 at all.
INV_ENTRY  = 8
INV_BASE   = 0x7060
INV_BLOCK  = 30 * INV_ENTRY     # 0xF0 — one bag
INV_BLOCKS = 8
INV_TEAMS  = ["Hugo", "Chris", "Geddoe", "Thomas"]

def inv_regions(story_phase=0):
    """The bag layout for a save at this story phase -> [(label, base, capacity)].
    Slots stay numbered from INV_BASE regardless of layout, so a slot index means the
    same byte offset in both layouts and round-trips on write."""
    if story_phase >= MERGE_PHASE:
        return [("Party bag", INV_BASE, 30),
                ("Storage", INV_BASE + INV_BLOCK, (INV_BLOCKS - 1) * 30)]
    return ([(t, INV_BASE + i * INV_BLOCK, 30) for i, t in enumerate(INV_TEAMS)] +
            [(t + " storage", INV_BASE + (4 + i) * INV_BLOCK, 30)
             for i, t in enumerate(INV_TEAMS)])

# Kept as the pre-merge layout for callers that predate inv_regions(); the write path uses
# INV_BASE directly, so nothing depends on this being the current save's layout.
INV_REGIONS = [(l, b, c) for l, b, c in inv_regions(0)]

# Sanity bound for a real item id (the game's table ends at 0x264).
ITEM_ID_MAX = 0x2FF
# Bit 15 of an item id is a FLAG, not part of the id: every id seen with it set is a castle
# ornament (Graffiti, Peeing Boy, Hex Doll, the paintings, the urns, Plant Vase...), the same
# ids appear unflagged in other saves, and there is a decoration-placement table at 0x7A00
# listing exactly these items — so 0x8000 means "currently on display in the castle".
# It is a REAL, occupied slot. Treating it as empty (the old `iid > ITEM_ID_MAX` test) both
# hid the item from the editor and offered its slot as free, so "+ Add item" overwrote it.
ITEM_FLAG_DISPLAYED = 0x8000
ITEM_ID_MASK = 0x7FFF

# Stackable vs one-per-slot, from the count field's behaviour over 2327 real entries:
#   consumables/food   id < 0x0A0    count 0..6   (stackable; per-item stack size)
#   equipment & runes   0x0A0-0x1EF  count 0 in 986/986 entries — one item per slot
#   trade goods         0x1F0-0x1FF  count 1..9   (stackable)
#   key items/valuables 0x200+       count 0 in 443/444 entries — one item per slot
# The game holds N copies of a one-per-slot item as N separate slots, each with count 0 —
# never as one slot with count N (Escape Scroll x6, New Chain Mail x6, Graffiti x6, Power
# Gloves x5 all appear that way). A rune written with count 1 is therefore a shape the game
# never produces: it displays, but the whole slot is freed the moment one item leaves it,
# which is exactly the reported "attach 1 Fury Rune and the other 2 vanish".
ITEM_QTY_MAX = 9              # herrvillain doc: item qty 0-9
# The bands above are the default, but they are not the whole story: the corpus covers 213
# of the 508 item ids, and nine of those contradict a pure band test. Embedded as exceptions
# so the classification follows the data rather than a tidy boundary.
#   Stat stones read count 0 in every save despite sitting in the consumable band. Six of
#   the seven are observed (0x0B-0x0E, 0x10, 0x11) and all agree, so the contiguous category
#   block 0x0B-0x11 is treated as one-per-slot — 0x0F (Stone Of Mag-Def) by interpolation.
#   Sacrificial Jizo and Dragon Incense likewise read 0.
ITEM_ONE_PER_SLOT_EXC = set(range(0x0B, 0x12)) | {0x9E, 0x9F}
#   Grape is an ingredient in the key-item band and does carry a count.
ITEM_STACKABLE_EXC = {0x202}

def item_stackable(iid):
    """True if this item id carries a real count; False if it is one-item-per-slot.

    Beware: ~58% of the item table never appears in the sample saves, so for those ids this
    is the band rule's best guess, not a verified fact. apply_edits_to_gamedata prefers the
    evidence in the save being edited when the same item is already held somewhere in it."""
    iid &= ITEM_ID_MASK
    if iid in ITEM_ONE_PER_SLOT_EXC:
        return False
    if iid in ITEM_STACKABLE_EXC:
        return True
    return iid < 0xA0 or 0x1F0 <= iid < 0x200


def item_stackable_for(gamedata, iid):
    """item_stackable(), refined by how THIS save already stores that item.

    Since ~58% of the item table never appears in the sample saves, the band rule is a guess
    for those ids — but if the player already holds the item, the entries in their own save
    settle it. The override is deliberately ONE-DIRECTIONAL: the save may only demote an item
    to one-per-slot, never promote it to stackable. A save edited by an older build can
    contain runes carrying a bogus count of 1 (the bug being fixed here), and promoting on
    that evidence would keep writing the broken shape for exactly the players who hit it.
    Demoting is safe in both directions: the old build never wrote 0 for a new item, and
    one-per-slot is the shape that provably survives."""
    iid &= ITEM_ID_MASK
    guess = item_stackable(iid)
    if not iid or not guess:
        return guess
    counts = [qty for slot in range(INV_BLOCKS * 30)
              for raw, qty in [struct.unpack_from("<HH", gamedata,
                                                  INV_BASE + slot * INV_ENTRY)]
              if raw and (raw & ITEM_ID_MASK) == iid]
    if counts and max(counts) == 0:
        return False              # the game's own entries hold this one per slot
    return True

# Roster order for the character blocks. CHAR_BASE (0x33AC) is HUGO — the real
# story "Flame Champion" record lives one block earlier (0x3320) and is not a
# recruitable party member, so it is intentionally NOT in this list (its inclusion
# was an earlier off-by-one that mislabeled every character).
ROSTER = [
    "Hugo", "Chris", "Geddoe", "Lucia", "Fred", "Rico", "Viki",
    "Fubar", "Sgt. Joe", "Lulu", "Aila", "Roland", "Lilly", "Reed", "Samus", "Ace",
    "Leo", "Beecham", "Percival", "Borus", "Queen", "Jacques", "Joker", "Duke",
    "Gau", "Elaine", "Nicolas", "Thomas", "Cecile", "Futch", "Bright", "Dupa",
    "Shiba", "Bazba", "Sasarai", "Franz", "Ruby", "Ayame", "Salome", "Watari",
    "Melville", "Alanis", "Wilder", "Rhett", "Nash", "Belle", "Mel", "Koroku",
    "Juan", "Guillaume", "Piccolo", "Mua", "Yuiri", "Yumi", "Jimba", "Gadget Z",
    "Luc", "Yuber", "Sarah", "Nei", "Toppo", "Shabon", "Hallec", "Kenji",
    "Twaikin", "Augustine", "Landis", "Sanae Y", "Sharon", "Viki (Young)", "Edge",
    "Wan Fu", "Estella", "Rody", "Emily", "Apple", "Luce", "Caesar", "Louis",
    "Shizu", "Eike", "Mamie", "Sebastian", "Gordon", "Dominic", "Jeane", "Peggi",
    "Scott", "Hortez", "Ernie", "Martha", "Yun", "Billy", "Elliot", "Anne",
    "Kidd", "Mike", "Jefferson", "Kathy", "Goro", "Albert", "Arthur", "Nadir",
    "Muto", "Barts", "Tuta", "Mio", "Dios", "Iku",
]


class MemCard:
    """Read-only PS2MFS memory-card image walker (handles 528-byte spare pages)."""
    def __init__(self, data):
        if data[:len(MAGIC)] != MAGIC:
            raise ValueError("not a PS2 memory-card image")
        self.data = bytearray(data)   # mutable so write-back can patch pages in place
        self.page_len = struct.unpack_from("<H", data, 0x28)[0]           # 512
        self.pages_per_cluster = struct.unpack_from("<H", data, 0x2A)[0]  # 2
        self.pages_per_block = struct.unpack_from("<H", data, 0x2C)[0]    # 16
        self.clusters = struct.unpack_from("<I", data, 0x30)[0]
        self.alloc_offset = struct.unpack_from("<I", data, 0x34)[0]
        self.rootdir_cluster = struct.unpack_from("<I", data, 0x3C)[0]
        self.ifc_list = list(struct.unpack_from("<32I", data, 0x50))
        self.cluster_size = self.page_len * self.pages_per_cluster        # 1024
        total_pages = self.clusters * self.pages_per_cluster
        spare_page = self.page_len + (self.page_len // 512) * 16          # 528
        if total_pages * spare_page == len(data):
            self.raw_page = spare_page
        elif total_pages * self.page_len == len(data):
            self.raw_page = self.page_len
        else:                                    # infer from size as a fallback
            self.raw_page = len(data) // total_pages

    def _page(self, n):
        off = n * self.raw_page
        return self.data[off:off + self.page_len]

    def _cluster(self, c):
        base = c * self.pages_per_cluster
        return b"".join(self._page(base + i) for i in range(self.pages_per_cluster))

    def _fat(self, cluster):
        per = self.cluster_size // 4                    # 256
        ifc = self.ifc_list[cluster // (per * per)]
        fat_cluster = self._cluster(ifc)
        ptr = struct.unpack_from("<I", fat_cluster, ((cluster // per) % per) * 4)[0]
        real = self._cluster(ptr)
        return struct.unpack_from("<I", real, (cluster % per) * 4)[0]

    def _chain(self, first, size):
        out = b""
        c = first
        while size > 0 and (c & 0x7FFFFFFF) != 0x7FFFFFFF and c != 0xFFFFFFFF:
            out += self._cluster((c & 0x7FFFFFFF) + self.alloc_offset)
            nxt = self._fat(c & 0x7FFFFFFF)
            if nxt == 0xFFFFFFFF:
                break
            c = nxt
            size -= self.cluster_size
        return out

    @staticmethod
    def _dirent(buf, off):
        mode = struct.unpack_from("<H", buf, off)[0]
        length = struct.unpack_from("<I", buf, off + 4)[0]
        cluster = struct.unpack_from("<I", buf, off + 0x10)[0]
        name = buf[off + 0x40:off + 0x40 + 32].split(b"\x00")[0].decode("ascii", "replace")
        return {"mode": mode, "is_dir": bool(mode & 0x0020), "length": length,
                "cluster": cluster, "name": name}

    def _listdir(self, dir_cluster, count):
        data = self._chain(dir_cluster, count * 512)
        out = []
        for i in range(count):
            o = i * 512
            if o + 0x60 > len(data):
                break
            out.append(self._dirent(data, o))
        return out

    def root_entries(self):
        head = self._chain(self.rootdir_cluster, 512)
        root_len = self._dirent(head, 0)["length"]
        return self._listdir(self.rootdir_cluster, root_len)

    def find_s3_saves(self):
        """Return [{folder, cluster, length}] for each Suikoden III USA save folder."""
        out = []
        for e in self.root_entries():
            if e["is_dir"] and e["name"].startswith(S3_PREFIX):
                out.append({"folder": e["name"], "cluster": e["cluster"],
                            "length": e["length"]})
        return out

    def read_file(self, dir_cluster, dir_len, filename):
        for e in self._listdir(dir_cluster, dir_len):
            if e["name"] == filename and not e["is_dir"]:
                return self._chain(e["cluster"], e["length"])[:e["length"]]
        return None

    # ---- write support -----------------------------------------------------
    def _chain_clusters(self, first, size):
        """The ordered list of physical cluster numbers backing a file/dir."""
        clusters, c = [], first
        while size > 0 and (c & 0x7FFFFFFF) != 0x7FFFFFFF and c != 0xFFFFFFFF:
            clusters.append((c & 0x7FFFFFFF) + self.alloc_offset)
            nxt = self._fat(c & 0x7FFFFFFF)
            if nxt == 0xFFFFFFFF:
                break
            c = nxt
            size -= self.cluster_size
        return clusters

    def _write_page(self, page_num, data512):
        """Overwrite one 512-byte page in self.data and recompute its ECC spare."""
        off = page_num * self.raw_page
        self.data[off:off + self.page_len] = data512
        if self.raw_page >= self.page_len + 16:      # card has a spare area
            spare = ecc_page(data512)
            self.data[off + self.page_len:off + self.page_len + 16] = spare

    def _write_cluster(self, cluster_num, data):
        base = cluster_num * self.pages_per_cluster
        for i in range(self.pages_per_cluster):
            seg = data[i*self.page_len:(i+1)*self.page_len]
            if len(seg) < self.page_len:
                seg = seg + b"\x00" * (self.page_len - len(seg))
            self._write_page(base + i, seg)

    def write_file(self, dir_cluster, dir_len, filename, new_content):
        """Replace a file's bytes in place (same length) and refresh ECC.
        Returns number of clusters written. Raises if length differs."""
        ent = None
        for e in self._listdir(dir_cluster, dir_len):
            if e["name"] == filename and not e["is_dir"]:
                ent = e; break
        if ent is None:
            raise KeyError(f"{filename} not found")
        if len(new_content) != ent["length"]:
            raise ValueError(f"length changed ({len(new_content)} != {ent['length']}); "
                             "in-place write only")
        clusters = self._chain_clusters(ent["cluster"], ent["length"])
        for i, cnum in enumerate(clusters):
            seg = new_content[i*self.cluster_size:(i+1)*self.cluster_size]
            if not seg:
                break
            self._write_cluster(cnum, seg)
        return len(clusters)

    def to_bytes(self):
        return bytes(self.data)


def slot_label(folder):
    """'BASLUS-20387sui3_u01' -> 'Slot 1'. Falls back to the raw folder name."""
    tail = folder[len(S3_PREFIX):]
    if tail.startswith("sui3_u") and tail[6:].isdigit():
        return f"Slot {int(tail[6:])}"
    return tail or folder


def decode_character(gamedata, roster_index):
    off = CHAR_BASE + roster_index * CHAR_STRIDE
    rec = gamedata[off:off + CHAR_STRIDE]
    if len(rec) < CHAR_STRIDE:
        return None
    stats = {n: struct.unpack_from("<H", rec, STAT_OFFSETS[n])[0] for n in STAT_NAMES}
    equip = {name: struct.unpack_from("<H", rec, eo)[0] for name, eo in EQUIP_SLOTS}
    skills = [{"slot": k, "id": rec[OFF_SKILLS + k*2], "rank": rec[OFF_SKILLS + k*2 + 1]}
              for k in range(SKILL_SLOTS)]
    lvl = rec[OFF_LEVEL]
    # Real recruit flag from the recruit table (nonzero = recruited); verified monotonic
    # across saves in playtime order. This is the authoritative "have I got them" signal,
    # unlike the character block which is pre-initialized for every roster slot.
    recruit_word = struct.unpack_from("<H", gamedata, RECRUIT_OFF + roster_index * 2)[0]
    # The record carries its own character id. Compare it with the id this roster slot is
    # supposed to hold so a future layout shift shows up as a flagged row instead of a
    # whole roster silently attributed to the wrong people.
    want_id = ROSTER_IDS[roster_index] if roster_index < len(ROSTER_IDS) else None
    got_id = rec[OFF_ID]
    return {
        "rosterIndex": roster_index,
        "name": ROSTER[roster_index] if roster_index < len(ROSTER) else f"#{roster_index}",
        "addr": off,
        "id": got_id,
        "idExpected": want_id,
        "idMismatch": bool(got_id) and want_id is not None and got_id != want_id,
        "level": lvl,
        "weaponLv": rec[OFF_WEAPONLV],
        "curHP": struct.unpack_from("<H", rec, OFF_CURHP)[0],
        "maxHP": struct.unpack_from("<H", rec, OFF_MAXHP)[0],
        "expToNext": struct.unpack_from("<H", rec, OFF_EXP)[0],
        "stats": stats,
        "equip": equip,
        "skills": skills,
        "recruited": recruit_word != 0,
        "recruitWord": recruit_word,
        "recruiter": recruiter_of(recruit_word),
        "recruiters": recruiters_of(recruit_word),
        "hasData": lvl > 0 or sum(stats.values()) > 0,
        "raw": list(rec),
    }


def decode_party(gamedata):
    """Active-party member ids, in the PARTY_IDS space (0 = empty slot)."""
    return [struct.unpack_from("<H", gamedata, PARTY_OFF + k*2)[0] for k in range(PARTY_SLOTS)]


# Item-id category boundaries (from the herrvillain "Item Digits" grouping + the ISO's
# own item table): consumables/curatives < 0xA0, wearable equipment 0xA0-0x1FF, and
# 0x200+ are the "key/valuable" goods — seeds, medals, recipes, trade items, old books,
# stat/spell stones, etc. Used only to sort key items apart from regular party items.
def item_category(iid):
    if iid >= 0x200:
        return "key"
    if 0xA0 <= iid < 0x200:
        return "equipment"
    return "consumable"

def decode_inventory(gamedata, story_phase=0):
    """Decode the item inventory grouped by bag (layout depends on story_phase; see
    inv_regions). Returns [{region, base, firstSlot, capacity, used, freeSlots,
    appendSlots, items:[...]}]. `slot` is the absolute entry index from INV_BASE, so it
    round-trips on write regardless of layout.

    Only non-empty slots appear in `items`. `freeSlots` lists the truly-empty slots.
    `appendSlots` is the subset of those that sit AFTER the bag's last used entry — the
    only safe place to add an item, because the game keeps each bag packed from its base
    and appends new pickups at the tail. Writing into an interior gap risks the game
    treating the run as ending there when it next repacks."""
    groups = []
    for name, base, count in inv_regions(story_phase):
        items, free = [], []
        first_slot = (base - INV_BASE) // INV_ENTRY
        last_used = -1
        for k in range(count):
            off = base + k * INV_ENTRY
            if off + 4 > len(gamedata):
                break
            slot = (off - INV_BASE) // INV_ENTRY
            raw = struct.unpack_from("<H", gamedata, off)[0]
            qty = struct.unpack_from("<H", gamedata, off + 2)[0]
            if raw == 0:
                free.append(slot)
                continue
            iid = raw & ITEM_ID_MASK
            last_used = k
            items.append({"slot": slot, "addr": off, "id": iid, "qty": qty,
                          "category": item_category(iid),
                          "stackable": item_stackable_for(gamedata, iid),
                          "displayed": bool(raw & ITEM_FLAG_DISPLAYED),
                          "rawId": raw,
                          "unknownId": iid > ITEM_ID_MAX,
                          "state": list(gamedata[off + 4:off + 8])})
        append = [s for s in free if s - first_slot > last_used]
        groups.append({"region": name, "base": base, "firstSlot": first_slot,
                       "capacity": count, "used": len(items),
                       "freeSlots": free, "appendSlots": append, "items": items})
    return groups


def validate_save(gamedata, chars, inventory, meta=None):
    """Cross-check the decoded save against invariants that only hold if the record layout
    is right, and return a list of human-readable warnings (empty = all good).

    This exists because issue #5 was a silent mislabel: the editor read a plausible-looking
    number from the wrong byte and nobody could tell. Every check below is something a
    correct layout cannot violate, so an offset drift surfaces as a warning on a real save
    instead of quietly writing to the wrong place.

    The strongest check is the last one: the PS2 browser title of an S3 save states the
    chapter protagonist's level, so the save carries its own answer for the field this issue
    got wrong. If our decoded level disagrees with the title, the level offset is wrong.

    Each entry is (severity, text). "error" means the layout looks wrong and editing is
    unsafe; "info" means the discrepancy has a benign explanation the user should simply be
    told. Keeping them apart matters: the title-vs-level check legitimately trips on a save
    whose protagonist level was edited here and then reloaded, and crying corruption at that
    would train people to ignore the banner that catches the real bug."""
    warn = []
    err = lambda t: warn.append(("error", t))
    info = lambda t: warn.append(("info", t))
    bad_ids = [c for c in chars if c.get("idMismatch")]
    if bad_ids:
        err("character record id mismatch at roster %s (expected %s, found %s) — the "
                    "roster order may have shifted; treat character edits as unsafe" % (
                        ", ".join(str(c["rosterIndex"]) for c in bad_ids[:5]),
                        bad_ids[0]["idExpected"], bad_ids[0]["id"]))
    over = [c for c in chars if c["hasData"] and c["curHP"] > c["maxHP"]]
    if over:
        err("%d character(s) decode with current HP above max HP (first: %s %d/%d) — "
                    "the HP offsets look wrong" % (len(over), over[0]["name"],
                                                   over[0]["curHP"], over[0]["maxHP"]))
    bad_lv = [c for c in chars if c["level"] > LEVEL_MAX or c["weaponLv"] > WEAPONLV_MAX]
    if bad_lv:
        err("%d character(s) decode outside the level/weapon-level caps (first: %s "
                    "Lv%d WLv%d)" % (len(bad_lv), bad_lv[0]["name"], bad_lv[0]["level"],
                                     bad_lv[0]["weaponLv"]))
    bad_item = [it for bag in inventory for it in bag["items"] if it["unknownId"]]
    if bad_item:
        err("%d inventory slot(s) hold an id past the end of the item table (first: "
                    "0x%04X) — the bag layout may be wrong" % (len(bad_item),
                                                               bad_item[0]["rawId"]))
    phase = gamedata[GLOBAL["storyPhase"][0]]
    merged = phase >= MERGE_PHASE
    # Structural signature of the merged layout: storage blocks fill strictly in order, so a
    # later block only holds items once the one before it is full. Disagreeing with the phase
    # means MERGE_PHASE (or the phase offset) is off for this save.
    seq = [sum(1 for k in range(30)
               if struct.unpack_from("<H", gamedata,
                                     INV_BASE + n * INV_BLOCK + k * INV_ENTRY)[0])
           for n in range(1, INV_BLOCKS)]
    sequential = all(seq[i] == 30 for i in range(len(seq) - 1) if seq[i + 1] > 0)
    if merged != sequential and any(seq):
        err("story phase %d says the parties are %s but the storage blocks look %s — "
                    "the bag labels for this save may be wrong" % (
                        phase, "merged" if merged else "separate",
                        "merged" if sequential else "separate"))
    want = (meta or {}).get("level")
    who = PHASE_PROTAGONIST.get(phase, "Hugo")
    if want:
        got = next((c["level"] for c in chars if c["name"] == who), None)
        if got is not None and got != want:
            # The title is written by the GAME when it saves, so it legitimately goes stale
            # the moment this editor changes that character's level — say so, or a user who
            # edits the protagonist and reloads their own file gets told it is corrupt.
            info("the save title says %s is Lv%d but the character record decodes "
                        "Lv%d. Expected if you changed that level here and reloaded the "
                        "result (the game rewrites the title on its next save). If you have "
                        "not edited it, the level offset is wrong — please report it."
                        % (who, want, got))
    return warn


def decode_save(gamedata, meta=None):
    """Decode one save's gamedata payload into globals + names + character list + inventory."""
    g = {}
    for k, (off, w) in GLOBAL.items():
        g[k] = gamedata[off] if w == 1 else struct.unpack_from("<H", gamedata, off)[0]
    names = [{"key": key, "label": label, "value": _read_str(gamedata, off, n), "max": n}
             for key, off, n, label in NAME_FIELDS]
    pt = struct.unpack_from("<I", gamedata, PLAYTIME_OFF)[0]
    g["playtimeSeconds"] = pt
    g["playtime"] = f"{pt//3600}:{(pt%3600)//60:02d}:{pt%60:02d}"
    g["gold"] = struct.unpack_from("<I", gamedata, GOLD_OFF)[0]
    g["merged"] = g.get("storyPhase", 0) >= MERGE_PHASE
    chars = [c for c in (decode_character(gamedata, i)
                         for i in range(min(CHAR_COUNT, len(ROSTER)))) if c]
    inv = decode_inventory(gamedata, g.get("storyPhase", 0))
    checks = validate_save(gamedata, chars, inv, meta)
    return {"size": len(gamedata), "checksumWord": struct.unpack_from("<I", gamedata, 0)[0],
            "global": g, "names": names, "carryover": detect_carryover(gamedata),
            "party": decode_party(gamedata),
            "characters": chars,
            "inventory": inv,
            "statNames": list(STAT_NAMES),
            # "problems" are layout errors (editing is unsafe); "notes" are discrepancies
            # with a benign explanation. `warnings` stays as the flat list of texts so
            # existing callers keep working.
            "problems": [t for sev, t in checks if sev == "error"],
            "notes": [t for sev, t in checks if sev == "info"],
            "warnings": [t for _, t in checks]}


# Editable per-character scalar fields -> (offset within the 140-byte block, byte width, cap).
CHAR_FIELDS = {
    "level":       (OFF_LEVEL,    1, LEVEL_MAX),
    "weaponLv":    (OFF_WEAPONLV, 1, WEAPONLV_MAX),
    "curHP":       (OFF_CURHP,    2, None),
    "maxHP":       (OFF_MAXHP,    2, None),
    "expToNext":   (OFF_EXP,      2, EXP_MAX),
}
# equip slots addressable by name -> offset
EQUIP_OFF = dict(EQUIP_SLOTS)

def _clamp(v, width, cap=None):
    hi = (1 << (8*width)) - 1
    if cap is not None:
        hi = min(hi, cap)
    return max(0, min(hi, int(v)))

NAME_OFF = {key: (off, n) for key, off, n, _ in NAME_FIELDS}

def apply_edits_to_gamedata(gamedata, edits, inv_edits=None, name_edits=None,
                            party_edits=None, recruit_edits=None, gold=None):
    """edits: {rosterIndex: {field: value, "stats": {STAT: value},
                             "skills": {slot: {"id": id, "rank": rank}}}}.
    inv_edits: {slot: {"id": id, "qty": qty}} for inventory slots.
    name_edits: {nameKey: "new text"} for the editable name fields.
    party_edits: {partySlot(0..5): charId} for the active-party composition.
    recruit_edits: {rosterIndex: value}, where value is a bool (recruit/un-recruit) OR a
        dict {"recruited": bool, "recruiter": "Hugo"|"Chris"|"Geddoe"|"Thomas"|""} to also
        set which protagonist recruited them (pre-merge party ownership).
    Returns (new_gamedata_with_fixed_checksum, changed_field_count)."""
    b = bytearray(gamedata)
    changed = 0
    name_to_bit = {v: k for k, v in RECRUITER_BITS.items()}
    for ridx, val in (recruit_edits or {}).items():
        ridx = int(ridx)
        ro = RECRUIT_OFF + ridx * 2
        if ro + 2 > len(b):
            continue
        cur = struct.unpack_from("<H", b, ro)[0]
        want = val.get("recruited", True) if isinstance(val, dict) else bool(val)
        recruiter = val.get("recruiter") if isinstance(val, dict) else None
        teams = val.get("teams") if isinstance(val, dict) else None
        if want:
            word = cur if cur != 0 else RECRUIT_DEFAULT
            if teams is not None:                # multi-team: OR the bits (2..5) — a char can be on several
                word = (word & ~RECRUITER_MASK) | sum(name_to_bit.get(n, 0) for n in teams)
            elif recruiter is not None:          # single team (backward compat)
                word = (word & ~RECRUITER_MASK) | name_to_bit.get(recruiter, 0)
            word |= 0x01                          # keep the recruited bit set
            struct.pack_into("<H", b, ro, word)
        else:
            struct.pack_into("<H", b, ro, 0)
        changed += 1
    for key, val in (name_edits or {}).items():
        if key not in NAME_OFF:
            continue
        off, n = NAME_OFF[key]
        val = unicodedata.normalize("NFKC", str(val))     # accept full- or half-width input
        existing = bytes(b[off:off + n]).split(b"\x00")[0]
        if any(byte >= 0x80 for byte in existing):
            # field is stored full-width Shift-JIS (imported S1/S2 names) — write the edit in
            # the same form so the game renders it like its own carryover names
            enc = _to_fullwidth(val[:n // 2]).encode("shift_jis", "replace")[:n]
        else:
            enc = val.encode("latin1", "replace")[:n]
        b[off:off + n] = enc + b"\x00" * (n - len(enc))   # fixed-width, null-padded
        changed += 1
    for ridx, fields in (edits or {}).items():
        ridx = int(ridx)
        base = CHAR_BASE + ridx * CHAR_STRIDE
        if base + CHAR_STRIDE > len(b):
            continue
        for k, v in fields.items():
            if k == "stats":
                for sname, sval in (v or {}).items():
                    if sname in STAT_OFFSETS:
                        struct.pack_into("<H", b, base + STAT_OFFSETS[sname], _clamp(sval, 2))
                        changed += 1
            elif k == "equip":
                for ename, eval_ in (v or {}).items():
                    if ename in EQUIP_OFF:
                        struct.pack_into("<H", b, base + EQUIP_OFF[ename], _clamp(eval_, 2))
                        changed += 1
            elif k == "skills":
                for slot, sk in (v or {}).items():
                    slot = int(slot)
                    if not (0 <= slot < SKILL_SLOTS):
                        continue
                    so = base + OFF_SKILLS + slot * 2
                    if "id" in sk:
                        b[so] = _clamp(sk["id"], 1); changed += 1
                    if "rank" in sk:
                        b[so + 1] = _clamp(sk["rank"], 1); changed += 1
            elif k in CHAR_FIELDS:
                off, w, cap = CHAR_FIELDS[k]
                fmt = {1: "<B", 2: "<H", 4: "<I"}[w]
                struct.pack_into(fmt, b, base + off, _clamp(v, w, cap))
                changed += 1
    # Inventory. The count field is only meaningful for stackable items; equipment, runes
    # and key items are strictly ONE PER SLOT with count 0 (986/986 and 443/444 real
    # entries), and the game holds several copies as several slots. Writing count>0 on a
    # one-per-slot item produces an entry the game never makes: it shows in the bag, but the
    # whole slot is freed as soon as one item leaves it — issue #5's "attach 1 Fury Rune and
    # the other 2 disappear", and the reason editor-added runes did not survive a chapter
    # transition. So the count is derived from the item, not from the caller's default.
    # Read the save's own evidence from the ORIGINAL bytes, before this batch's writes
    # muddy the picture.
    def stackable(iid):
        return item_stackable_for(gamedata, iid)
    for slot, ent in (inv_edits or {}).items():
        slot = int(slot)
        off = INV_BASE + slot * INV_ENTRY        # slot is absolute, from the first bag
        if off + INV_ENTRY > len(b) or slot >= INV_BLOCKS * 30:
            continue
        cur_id = struct.unpack_from("<H", b, off)[0]
        if "id" in ent:
            new_id = _clamp(ent["id"], 2) & ITEM_ID_MASK
            # Preserve the "on display in the castle" flag when only the count changes on an
            # existing item; a genuinely different item is not the one on display.
            if new_id and new_id == (cur_id & ITEM_ID_MASK):
                new_id |= cur_id & ITEM_FLAG_DISPLAYED
            struct.pack_into("<H", b, off, new_id); changed += 1
            if new_id != cur_id:
                # The trailing 4 bytes are per-item state, not padding — real saves carry
                # values there on cooking ingredients and food. They belong to the item that
                # was in the slot, so they are cleared only when the item actually changes.
                struct.pack_into("<I", b, off + 4, 0)
            if (new_id & ITEM_ID_MASK) == 0:     # clearing a slot -> zero its count too
                struct.pack_into("<H", b, off + 2, 0)
            elif "qty" not in ent:
                struct.pack_into("<H", b, off + 2, 1 if stackable(new_id) else 0)
        if "qty" in ent:
            iid = struct.unpack_from("<H", b, off)[0] & ITEM_ID_MASK
            if not iid:
                qty = 0
            elif stackable(iid):
                qty = max(1, _clamp(ent["qty"], 2, ITEM_QTY_MAX))
            else:
                qty = 0                          # one item per slot; the count must be 0
            struct.pack_into("<H", b, off + 2, qty); changed += 1
    for slot, cid in (party_edits or {}).items():
        slot = int(slot)
        if 0 <= slot < PARTY_SLOTS:
            struct.pack_into("<H", b, PARTY_OFF + slot * 2, _clamp(cid, 2)); changed += 1
    if gold is not None:
        struct.pack_into("<I", b, GOLD_OFF, _clamp(gold, 4)); changed += 1
    return fix_gamedata_checksum(bytes(b)), changed

def _backup_once(path, make_backup):
    if make_backup:
        bak = path + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)


def write_save_edits(path, folder, edits, make_backup=True, inv_edits=None, name_edits=None,
                     party_edits=None, recruit_edits=None, gold=None):
    """Apply edits to one save's gamedata, in place, for any supported container
    (memory card, .psu export, or raw gamedata). Fixes the save checksum (and, for
    memory cards, per-page ECC). Backs up the file first by default."""
    fmt = _sniff_format(path)
    if fmt in ("psu", "gamedata"):
        return _write_save_edits_flat(fmt, path, edits, make_backup, inv_edits, name_edits,
                                      party_edits, recruit_edits, gold)
    if fmt in ("cbs", "sharkport", "psv"):
        return _write_individual_save(fmt, path, edits, make_backup, inv_edits, name_edits,
                                      party_edits, recruit_edits, gold)
    card = load_card(path)
    # locate the folder + its gamedata
    target = None
    for e in card.root_entries():
        if e["is_dir"] and e["name"] == folder:
            target = e; break
    if target is None:
        return {"error": f"save folder {folder} not found"}
    gd = card.read_file(target["cluster"], target["length"], "gamedata")
    if gd is None:
        return {"error": "gamedata not found in save folder"}
    new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits, party_edits,
                                              recruit_edits, gold)
    if changed == 0:
        return {"ok": True, "changed": 0, "note": "no editable fields in request"}
    if make_backup:
        bak = path + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(path, bak)
    clusters = card.write_file(target["cluster"], target["length"], "gamedata", new_gd)
    with open(path, "wb") as f:
        f.write(card.to_bytes())
    return {"ok": True, "changed": changed, "clustersWritten": clusters,
            "checksum": struct.unpack_from("<I", new_gd, 0)[0]}


def _write_individual_save(fmt, path, edits, make_backup, inv_edits, name_edits,
                           party_edits, recruit_edits, gold):
    """Edit the S3 gamedata inside a .cbs / .sps / .xps file. SharkPort stores files
    uncompressed, so its gamedata is patched in place at its absolute offset.
    CodeBreaker is decompressed (RC4+zlib), patched, and re-encoded. The S3 checksum is
    recomputed by apply_edits_to_gamedata either way."""
    with open(path, "rb") as f:
        b = f.read()
    if fmt == "psv":
        # PSV stores files uncompressed at directory-declared offsets: patch in place.
        tgt = next(((off, size) for name, off, size in _psv_entries(b)
                    if size == GAMEDATA_SIZE), None)
        if not tgt:
            return {"error": "gamedata payload not found in .psv"}
        off, _ = tgt
        gd = b[off:off + GAMEDATA_SIZE]
        new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits,
                                                  party_edits, recruit_edits, gold)
        if changed == 0:
            return {"ok": True, "changed": 0, "note": "no editable fields in request"}
        _backup_once(path, make_backup)
        ba = bytearray(b); ba[off:off + GAMEDATA_SIZE] = new_gd
        with open(path, "wb") as f:
            f.write(bytes(ba))
        return {"ok": True, "changed": changed,
                "checksum": struct.unpack_from("<I", new_gd, 0)[0],
                "warn": "PSV edited in place (.bak kept). The S3 save checksum was fixed, "
                        "but the PS3 signature was NOT recomputed — re-importing to a real "
                        "PS3 needs an external resigner. Fine for PC tools/conversion."}
    if fmt == "sharkport":
        folder, fs = _sps_read(b, want_offsets=True)
        tgt = next(((off, data) for name, (off, data) in fs.items()
                    if len(data) == GAMEDATA_SIZE), None)
        if not tgt:
            return {"error": "gamedata payload not found in SharkPort save"}
        off, gd = tgt
        new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits,
                                                  party_edits, recruit_edits, gold)
        if changed == 0:
            return {"ok": True, "changed": 0, "note": "no editable fields in request"}
        _backup_once(path, make_backup)
        ba = bytearray(b); ba[off:off + len(new_gd)] = new_gd
        with open(path, "wb") as f:
            f.write(bytes(ba))
        return {"ok": True, "changed": changed,
                "checksum": struct.unpack_from("<I", new_gd, 0)[0]}
    # CodeBreaker (.cbs): decompress -> patch -> recompress + re-encrypt
    import zlib
    hlen = struct.unpack_from("<L", b, 8)[0]
    dlen = struct.unpack_from("<L", b, 12)[0]
    body = bytearray(zlib.decompressobj().decompress(_cbs_rc4(b[hlen:]), dlen))
    off = None; pos = 0
    while pos < len(body):
        h = struct.unpack_from("<8s8sLHHLL32s", bytes(body), pos); sz = h[2]
        if sz == GAMEDATA_SIZE:
            off = pos + 64; gd = bytes(body[off:off + sz]); break
        pos += 64 + sz
    if off is None:
        return {"error": "gamedata payload not found in CodeBreaker save"}
    new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits,
                                              party_edits, recruit_edits, gold)
    if changed == 0:
        return {"ok": True, "changed": 0, "note": "no editable fields in request"}
    body[off:off + len(new_gd)] = new_gd
    newcomp = _cbs_rc4(zlib.compress(bytes(body), 9))
    newb = bytearray(b[:hlen]) + newcomp
    struct.pack_into("<L", newb, 16, len(newb))       # flen field = total file size
    _backup_once(path, make_backup)
    with open(path, "wb") as f:
        f.write(bytes(newb))
    return {"ok": True, "changed": changed,
            "checksum": struct.unpack_from("<I", new_gd, 0)[0],
            "warn": "CodeBreaker save re-encoded (RC4+zlib); a .bak was kept. "
                    "The S3 gamedata checksum was recomputed, but re-import via your "
                    "cheat device wasn't independently verified — keep the backup."}


def load_card(path):
    with open(path, "rb") as f:
        return MemCard(f.read())


_FW_MAP = {chr(0xFF01 + i): chr(0x21 + i) for i in range(94)}
_FW_MAP["　"] = " "
def _title_from_icon_sys(ic):
    """The PS2 browser title in icon.sys (Shift-JIS full-width) e.g.
    'Suikoden3 [01] Cpt.3 L41 / 28:39' -> chapter/level/playtime. Returns raw + parsed."""
    if not ic or len(ic) < 0xC0 + 4:
        return {}
    raw = ic[0xC0:0xC0 + 68].split(b"\x00")[0].decode("shift_jis", "replace")
    norm = "".join(_FW_MAP.get(c, c) for c in raw)
    out = {"title": norm}
    import re
    m = re.search(r"Cpt\.(\d+)", norm)
    if m: out["chapter"] = int(m.group(1))
    m = re.search(r"L(\d+)", norm)
    if m: out["level"] = int(m.group(1))
    m = re.search(r"(\d+:\d+)\s*$", norm)
    if m: out["playtime"] = m.group(1)
    return out

GAMEDATA_SIZE = 53264          # 0xD010 — the bare S3 save payload
_DIRENT = 512                  # PS2MFS / .psu directory-entry size
_PSU_CLUSTER = 1024            # .psu files are padded to 1 KB boundaries
_DF_DIR = 0x0020               # dirent mode bit: this entry is a directory


def _round_up(n, m):
    return (n + m - 1) // m * m


class PsuSave:
    """Reader/writer for a single-save EMS (.psu) export (uLaunchELF / mymc).
    Layout (verified vs mymc ps2save.load_ems): a 512-byte dirent for the save
    folder, then '.' and '..' dirents, then for each file a 512-byte dirent
    (mode@0, length@4, name@0x40) followed by its data padded to a 1 KB boundary.
    No ECC and no whole-file checksum, so editing a file's bytes in place (same
    length) is all that's needed."""
    def __init__(self, data):
        self.data = bytearray(data)
        d0 = self.data[:_DIRENT]
        mode, _, n = struct.unpack_from("<HHL", d0, 0)
        if not (mode & _DF_DIR) or n < 2:
            raise ValueError("not a .psu save file")
        self.folder = d0[0x40:0x40 + 448].split(b"\x00")[0].decode("latin1", "replace")
        self.files = {}                       # name -> {hdr, data_off, length}
        off = _DIRENT * 3                      # skip dir, '.', '..'
        for _ in range(n - 2):
            if off + _DIRENT > len(self.data):
                break
            hdr = self.data[off:off + _DIRENT]
            fmode, _, flen = struct.unpack_from("<HHL", hdr, 0)
            name = hdr[0x40:0x40 + 448].split(b"\x00")[0].decode("latin1", "replace")
            data_off = off + _DIRENT
            self.files[name] = {"hdr": off, "data_off": data_off, "length": flen}
            off = data_off + _round_up(flen, _PSU_CLUSTER)

    def read_file(self, name):
        e = self.files.get(name)
        if not e:
            return None
        return bytes(self.data[e["data_off"]:e["data_off"] + e["length"]])

    def write_file(self, name, new_bytes):
        e = self.files.get(name)
        if not e or len(new_bytes) != e["length"]:   # in-place only (same length)
            return False
        self.data[e["data_off"]:e["data_off"] + e["length"]] = new_bytes
        return True

    def to_bytes(self):
        return bytes(self.data)


# ---------------------------------------------------------------------------
# CodeBreaker (.cbs) and SharkPort/X-Port (.sps/.xps) standalone saves.
# These are single-file exports of one memory-card folder, used by cheat devices and
# save-sharing sites. Ported to py3 from mymc (Ross Ridge, public domain). Each decodes
# to {inner-filename: bytes}; the S3 payload is the 53264-byte "gamedata" file.
# CBS bodies are RC4+zlib compressed; SharkPort stores files uncompressed (so its
# gamedata can be patched in place). After editing, apply_edits_to_gamedata recomputes
# the S3 checksum, same as every other container.
_CBS_MAGIC = b"CFU\x00"
_SPS_MAGIC = b"\x0d\x00\x00\x00SharkPortSave"
_CBS_RC4 = bytes([
    0x5f,0x1f,0x85,0x6f,0x31,0xaa,0x3b,0x18,0x21,0xb9,0xce,0x1c,0x07,0x4c,0x9c,0xb4,
    0x81,0xb8,0xef,0x98,0x59,0xae,0xf9,0x26,0xe3,0x80,0xa3,0x29,0x2d,0x73,0x51,0x62,
    0x7c,0x64,0x46,0xf4,0x34,0x1a,0xf6,0xe1,0xba,0x3a,0x0d,0x82,0x79,0x0a,0x5c,0x16,
    0x71,0x49,0x8e,0xac,0x8c,0x9f,0x35,0x19,0x45,0x94,0x3f,0x56,0x0c,0x91,0x00,0x0b,
    0xd7,0xb0,0xdd,0x39,0x66,0xa1,0x76,0x52,0x13,0x57,0xf3,0xbb,0x4e,0xe5,0xdc,0xf0,
    0x65,0x84,0xb2,0xd6,0xdf,0x15,0x3c,0x63,0x1d,0x89,0x14,0xbd,0xd2,0x36,0xfe,0xb1,
    0xca,0x8b,0xa4,0xc6,0x9e,0x67,0x47,0x37,0x42,0x6d,0x6a,0x03,0x92,0x70,0x05,0x7d,
    0x96,0x2f,0x40,0x90,0xc4,0xf1,0x3e,0x3d,0x01,0xf7,0x68,0x1e,0xc3,0xfc,0x72,0xb5,
    0x54,0xcf,0xe7,0x41,0xe4,0x4d,0x83,0x55,0x12,0x22,0x09,0x78,0xfa,0xde,0xa7,0x06,
    0x08,0x23,0xbf,0x0f,0xcc,0xc1,0x97,0x61,0xc5,0x4a,0xe6,0xa0,0x11,0xc2,0xea,0x74,
    0x02,0x87,0xd5,0xd1,0x9d,0xb7,0x7e,0x38,0x60,0x53,0x95,0x8d,0x25,0x77,0x10,0x5e,
    0x9b,0x7f,0xd8,0x6e,0xda,0xa2,0x2e,0x20,0x4f,0xcd,0x8f,0xcb,0xbe,0x5a,0xe0,0xed,
    0x2c,0x9a,0xd4,0xe2,0xaf,0xd0,0xa9,0xe8,0xad,0x7a,0xbc,0xa8,0xf2,0xee,0xeb,0xf5,
    0xa6,0x99,0x28,0x24,0x6c,0x2b,0x75,0x5d,0xf8,0xd3,0x86,0x17,0xfb,0xc0,0x7b,0xb3,
    0x58,0xdb,0xc7,0x4b,0xff,0x04,0x50,0xe9,0x88,0x69,0xc9,0x2a,0xab,0xfd,0x5b,0x1b,
    0x8a,0xd9,0xec,0x27,0x44,0x0e,0x33,0xc8,0x6b,0x93,0x32,0x48,0xb6,0x30,0x43,0xa5])

def _cbs_rc4(data):
    s = bytearray(_CBS_RC4); t = bytearray(data); j = 0
    for ii in range(len(t)):
        i = (ii + 1) % 256; j = (j + s[i]) % 256; s[i], s[j] = s[j], s[i]
        t[ii] ^= s[(s[i] + s[j]) % 256]
    return bytes(t)

def load_cbs(b):
    """Return (dirname, {filename: bytes}) for a CodeBreaker save."""
    import zlib
    hlen = struct.unpack_from("<L", b, 8)[0]
    dlen, flen = struct.unpack_from("<LL", b, 12)
    # header: magic@0, d04@4, hlen@8, dlen@12, flen@16, dirname(32s)@20 (per mymc load_codebreaker)
    dirname = b[20:52].split(b"\x00")[0].decode("latin1", "replace") if hlen >= 52 else ""
    body = zlib.decompressobj().decompress(_cbs_rc4(b[hlen:hlen + flen]), dlen)
    fs = {}
    while body:
        h = struct.unpack_from("<8s8sLHHLL32s", body, 0); sz = h[2]
        fs[h[7].split(b"\x00")[0].decode("latin1")] = body[64:64 + sz]
        body = body[64 + sz:]
    return dirname, fs

def _sps_read(b, want_offsets=False):
    """Parse a SharkPort/X-Port save. Returns (dirname, {name: bytes}) or, when
    want_offsets, (dirname, {name: (abs_offset, bytes)}) — SharkPort stores files
    uncompressed, so the gamedata can be patched in place at its absolute offset."""
    import io
    f = io.BytesIO(b); f.read(17); f.read(4)          # magic + savetype
    for _ in range(3):                                # dirname / datestamp / comment blocks
        n = struct.unpack("<L", f.read(4))[0]; f.read(n)
    f.read(4)                                         # flen
    hlen, dn, dl, dm, cr, mo = struct.unpack("<H64sL8xH2x8s8s", f.read(98)); f.read(hlen - 98)
    dirname = dn.split(b"\x00")[0].decode("latin1", "replace")
    dl -= 2; fs = {}
    for _ in range(dl):
        hlen, name, flen, mode, cr, mo = struct.unpack("<H64sL8xH2x8s8s", f.read(98)); f.read(hlen - 98)
        key = name.split(b"\x00")[0].decode("latin1")
        off = f.tell(); data = f.read(flen)
        fs[key] = (off, data) if want_offsets else data
    return dirname, fs

def load_sharkport(b):
    return _sps_read(b, want_offsets=False)

# ---------------------------------------------------------------------------
# PS3 .PSV export (PS2 save exported from a PS3's XMB / virtual memory card).
# Layout (verified against a real BASLUS-20387 export):
#   +0x00  magic "\x00VSP"
#   +0x08  20-byte salt + 20-byte HMAC signature (PS3 crypto — we do NOT recompute it;
#          an edited .psv needs external resigning to import on a real PS3)
#   +0x68  save-folder block: created/modified ToDs, ..., mode u32 (dir), name[32] @+0x80
#   +0xA0  file entries, stride 0x3C each:
#          [created 8][modified 8][size u32][mode u32][name 32][data offset u32]
# The S3 gamedata is the entry named "gamedata" (size 0xD010); its data offset field
# points at the raw payload inside the .psv.
_PSV_MAGIC = b"\x00VSP"
_PSV_ENTRIES_OFF = 0xA0
_PSV_ENTRY_SZ = 0x3C

def _psv_entries(b):
    """Yield (name, data_offset, size) for each file entry in a .psv."""
    out = []
    i = _PSV_ENTRIES_OFF
    while i + _PSV_ENTRY_SZ <= len(b):
        size = struct.unpack_from("<I", b, i + 0x10)[0]
        mode = struct.unpack_from("<I", b, i + 0x14)[0]
        raw = b[i + 0x18:i + 0x18 + 32]
        name = raw.split(b"\x00")[0].decode("latin1", "replace")
        off = struct.unpack_from("<I", b, i + 0x38)[0]
        if not name or any(c < 0x20 or c > 0x7E for c in raw.split(b"\x00")[0]):
            break
        if not (mode & 0x8000) or (mode & _DF_DIR):      # must be an existing FILE entry
            break
        if off == 0 or off + size > len(b):
            break
        out.append((name, off, size))
        i += _PSV_ENTRY_SZ
    return out

def load_psv(b):
    """Return (folder_name, {filename: bytes}) for a PS3 .psv export."""
    folder = b[0x80:0xA0].split(b"\x00")[0].decode("latin1", "replace")
    fs = {name: b[off:off + size] for name, off, size in _psv_entries(b)}
    return folder, fs

def _find_gamedata(files):
    """Pick the S3 gamedata payload from a decoded file dict (by name, then by size)."""
    if "gamedata" in files and len(files["gamedata"]) == GAMEDATA_SIZE:
        return "gamedata", files["gamedata"]
    for name, data in files.items():
        if len(data) == GAMEDATA_SIZE:
            return name, data
    return None, None


def _sniff_format(path):
    """Return 'card' | 'psu' | 'gamedata' | 'cbs' | 'sharkport' | 'unknown'."""
    try:
        sz = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(_DIRENT)
    except OSError:
        return "unknown"
    if head[:len(MAGIC)] == MAGIC:
        return "card"
    if head[:len(_CBS_MAGIC)] == _CBS_MAGIC:
        return "cbs"
    if head[:len(_SPS_MAGIC)] == _SPS_MAGIC:
        return "sharkport"
    if head[:len(_PSV_MAGIC)] == _PSV_MAGIC:
        return "psv"
    if sz == GAMEDATA_SIZE:
        return "gamedata"
    if len(head) >= 0x40 and (struct.unpack_from("<H", head, 0)[0] & _DF_DIR):
        return "psu"
    return "unknown"


def read_all_s3_saves(path):
    """Top-level: open a save file (memory card, .psu export, or raw gamedata) and
    decode every Suikoden III save it contains."""
    fmt = _sniff_format(path)
    if fmt == "psu":
        return _read_psu_saves(path)
    if fmt == "gamedata":
        return _read_gamedata_save(path)
    if fmt in ("cbs", "sharkport", "psv"):
        return _read_individual_save(path, fmt)
    card = load_card(path)
    saves = []
    for s in card.find_s3_saves():
        gd = card.read_file(s["cluster"], s["length"], "gamedata")
        if not gd:
            continue
        ic = card.read_file(s["cluster"], s["length"], "icon.sys")
        meta = _title_from_icon_sys(ic)
        dec = decode_save(gd, meta)
        dec["folder"] = s["folder"]
        dec["label"] = slot_label(s["folder"])
        dec["meta"] = meta
        saves.append(dec)
    return saves


def _read_psu_saves(path):
    with open(path, "rb") as f:
        psu = PsuSave(f.read())
    if not psu.folder.startswith(S3_PREFIX):
        return []
    gd = psu.read_file("gamedata")
    if not gd or len(gd) < GAMEDATA_SIZE:
        return []
    meta = _title_from_icon_sys(psu.read_file("icon.sys"))
    dec = decode_save(gd, meta)
    dec["folder"] = psu.folder
    dec["label"] = slot_label(psu.folder)
    dec["meta"] = meta
    return [dec]


def _read_gamedata_save(path):
    with open(path, "rb") as f:
        gd = f.read()
    if len(gd) != GAMEDATA_SIZE:
        return []
    dec = decode_save(gd)
    dec["folder"] = os.path.basename(path)   # raw payload has no folder name
    dec["label"] = slot_label(dec["folder"])
    dec["meta"] = {}
    return [dec]


def _read_individual_save(path, fmt):
    """Decode a CodeBreaker (.cbs) or SharkPort/X-Port (.sps/.xps) file into one S3 save."""
    with open(path, "rb") as f:
        b = f.read()
    folder, files = (load_cbs(b) if fmt == "cbs"
                     else load_psv(b) if fmt == "psv"
                     else load_sharkport(b))
    _, gd = _find_gamedata(files)
    if not gd:
        return []
    if not folder or not folder.startswith(S3_PREFIX):
        return []                             # not a Suikoden III (USA) save
    meta = _title_from_icon_sys(files.get("icon.sys"))
    dec = decode_save(gd, meta)
    dec["folder"] = folder
    dec["label"] = slot_label(folder)
    dec["meta"] = meta
    return [dec]


def _write_save_edits_flat(fmt, path, edits, make_backup, inv_edits, name_edits,
                           party_edits, recruit_edits, gold):
    """Write edits into a .psu export or a raw gamedata file. No ECC (neither format
    has it); the gamedata's own checksum is recomputed by apply_edits_to_gamedata.
    Same-length in-place write, so the container layout is untouched."""
    if fmt == "gamedata":
        with open(path, "rb") as f:
            gd = f.read()
        new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits,
                                                  party_edits, recruit_edits, gold)
        if changed == 0:
            return {"ok": True, "changed": 0, "note": "no editable fields in request"}
        _backup_once(path, make_backup)
        with open(path, "wb") as f:
            f.write(new_gd)
        return {"ok": True, "changed": changed,
                "checksum": struct.unpack_from("<I", new_gd, 0)[0]}
    # .psu
    with open(path, "rb") as f:
        psu = PsuSave(f.read())
    gd = psu.read_file("gamedata")
    if gd is None:
        return {"error": "gamedata not found in .psu"}
    new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits, name_edits,
                                              party_edits, recruit_edits, gold)
    if changed == 0:
        return {"ok": True, "changed": 0, "note": "no editable fields in request"}
    if not psu.write_file("gamedata", new_gd):
        return {"error": "could not write gamedata back into .psu (length mismatch)"}
    _backup_once(path, make_backup)
    with open(path, "wb") as f:
        f.write(psu.to_bytes())
    return {"ok": True, "changed": changed,
            "checksum": struct.unpack_from("<I", new_gd, 0)[0]}


def scan_memcards(roots):
    """Find 8 MB PS2 memory-card images near the given root dirs."""
    seen, found = set(), []
    exts = (".ps2", ".mcd", ".mc2", ".bin")
    for r in roots:
        if not r or not os.path.isdir(r):
            continue
        for dp, _, files in os.walk(r):
            if dp.count(os.sep) - r.count(os.sep) > 4:
                continue
            for fn in files:
                if not fn.lower().endswith(exts):
                    continue
                full = os.path.join(dp, fn)
                if full in seen:
                    continue
                seen.add(full)
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                # PS2 cards are 8 MB nominal (8650752 with spare, 8388608 without)
                if sz not in (8650752, 8388608) and not (8_000_000 <= sz <= 9_500_000):
                    continue
                # confirm it's really a PS2 card + carries an S3 save (cheap header peek)
                try:
                    with open(full, "rb") as fh:
                        head = fh.read(64)
                    if head[:len(MAGIC)] != MAGIC:
                        continue
                    with open(full, "rb") as fh:
                        blob = fh.read()
                    has_s3 = S3_PREFIX.encode() in blob
                except OSError:
                    continue
                found.append({"path": full, "name": fn, "size": sz, "kind": "card",
                              "mb": round(sz / 1048576, 1), "hasS3": has_s3})
    found.sort(key=lambda x: (not x["hasS3"], x["name"].lower()))
    return found


def scan_individual_saves(roots):
    """Find individual (non-memory-card) S3 saves near the given roots: .psu exports
    whose folder is an S3 save, and raw 53264-byte `gamedata` payloads. Returns the
    same shape as scan_memcards with kind 'psu' | 'gamedata'."""
    seen, found = set(), []
    for r in roots:
        if not r or not os.path.isdir(r):
            continue
        for dp, _, files in os.walk(r):
            if dp.count(os.sep) - r.count(os.sep) > 4:
                continue
            for fn in files:
                full = os.path.join(dp, fn)
                if full in seen:
                    continue
                seen.add(full)
                low = fn.lower()
                try:
                    sz = os.path.getsize(full)
                except OSError:
                    continue
                kind = has_s3 = None
                if low.endswith(".psu"):
                    # cheap: the folder name is in the first dirent at +0x40
                    try:
                        with open(full, "rb") as fh:
                            head = fh.read(_DIRENT)
                        name = head[0x40:0x40 + 448].split(b"\x00")[0].decode("latin1", "replace")
                        kind = "psu"; has_s3 = name.startswith(S3_PREFIX)
                    except OSError:
                        continue
                elif low.endswith((".cbs", ".sps", ".xps", ".psv")):
                    # cheat-device / PS3 single-save export; check magic + S3 folder prefix
                    try:
                        with open(full, "rb") as fh:
                            b = fh.read()
                        if b[:len(_CBS_MAGIC)] == _CBS_MAGIC:
                            folder, files = load_cbs(b); kind = "cbs"
                        elif b[:len(_SPS_MAGIC)] == _SPS_MAGIC:
                            folder, files = load_sharkport(b); kind = "sharkport"
                        elif b[:len(_PSV_MAGIC)] == _PSV_MAGIC:
                            folder, files = load_psv(b); kind = "psv"
                        else:
                            continue
                        _, gd = _find_gamedata(files)
                        has_s3 = bool(gd) and folder.startswith(S3_PREFIX)
                    except Exception:
                        continue
                elif sz == GAMEDATA_SIZE:
                    # a bare gamedata payload; validate via its self-consistent checksum
                    try:
                        with open(full, "rb") as fh:
                            gd = fh.read()
                        words = struct.unpack_from("<%dI" % (len(gd) // 4), gd, 0)
                        kind = "gamedata"; has_s3 = (sum(words) & 0xFFFFFFFF) == 0
                    except OSError:
                        continue
                if kind is None:
                    continue
                found.append({"path": full, "name": fn, "size": sz, "kind": kind,
                              "mb": round(sz / 1048576, 2), "hasS3": bool(has_s3)})
    found.sort(key=lambda x: (not x["hasS3"], x["name"].lower()))
    return found


if __name__ == "__main__":
    import sys, json
    if len(sys.argv) < 2:
        print("usage: s3save.py <memcard.ps2> [--json]")
        sys.exit(1)
    saves = read_all_s3_saves(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(saves, indent=2)); sys.exit(0)
    for s in saves:
        print(f"\n=== {s['label']} ({s['folder']})  checksum=0x{s['checksumWord']:08X} ===")
        lid = s['global']['partyLeader']
        print(f"  party leader id={lid} ({party_name(lid) or '?'})  "
              f"story phase={s['global']['storyPhase']}")
        print("  party: " + ", ".join(f"{p} ({party_name(p) or '?'})"
                                      for p in s["party"] if p) or "  party: (empty)")
        for c in s["characters"]:
            if c["level"] == 0 and c["curHP"] == 0 and c["expToNext"] == 0:
                continue   # unrecruited/empty slot
            st = " ".join(f"{k}{v}" for k, v in c["stats"].items())
            print(f"  [{c['rosterIndex']:3d}] {c['name']:14s} Lv{c['level']:3d} HP{c['curHP']:4d}  {st}")
