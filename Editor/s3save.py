#!/usr/bin/env python3
"""
Suikoden III PS2 memory-card save reader (read-only, stdlib only).

This is the save-editing counterpart to s3patch.py (which edits the ISO). It does
NOT touch the ISO and does NOT require one. It opens an 8 MB PS2 memory-card image
(*.ps2 / *.mcd), walks the PS2MFS filesystem, finds the Suikoden III USA save
folders (BASLUS-20387...), and decodes each save's `gamedata` payload.

Layout facts (validated 2026-08-10 against 4 real saves + the herrvillain save-offset
map; see Editor/Suikoden3_ISO_offsets.md):
  - Card pages are 512 data + 16 ECC spare = 528 bytes on disk.
  - `gamedata` is 53264 (0xD010) bytes; meaningful data ends ~0xCE48.
  - Character records: base 0x33AC, stride 0x8C (140 bytes), roster order
    Flame Champion(real), Hugo, Chris, Geddoe, Lucia, Fred, Rico, Viki, Fubar, ...
    Per record: +0x00 u32 EXP-to-next, +0x08 u16 current HP, +0x0C u8 char id,
    +0x0D u8 level, +0x20.. u16 stat block.
  - Global: +0x12 party-leader id, +0x14 story phase.

WRITING is intentionally not implemented yet: gamedata word@0 is a checksum whose
algorithm is not yet cracked, so writing a modified save could make it fail to load.
This module is the read-only foundation; write support is gated on solving that.
"""
import struct, os, glob, shutil

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
OFF_EXP     = 0x00            # u32 EXP toward next level (resets on level-up)
OFF_CURHP   = 0x08            # u16 current HP
OFF_ID      = 0x0C            # u8 character id
OFF_LEVEL   = 0x0D            # u8 level
OFF_MAXHP   = 0x30            # u16 max HP
OFF_STATS   = 0x20            # u16[8] stat block
# NOTE: per-character weapon (sharpen) level is intentionally NOT exposed. Its offset was
# never confirmed on real saves — 0x0D aliases the level byte and 0x0E/0x0F read as 0 — so
# writing it risked clobbering level. Left out per the "never write unverified fields" rule.
OFF_SKILLS  = 0x10            # 8 x (skill id u8, rank u8) — verified vs skill-id table
SKILL_SLOTS = 8
# stat order confirmed against herrvillain per-character RAM codes (relative spacing)
STAT_NAMES  = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"]

# Active-party composition: up to 6 member char-ids (u16) at file 0x3216 (herrvillain
# map), ids in the exe list1 space (1=Hugo, 63=Hallec, ...). 0 = empty slot.
PARTY_OFF   = 0x3216
PARTY_SLOTS = 6

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
    return data[off:off+n].split(b"\x00")[0].decode("latin1", "replace")

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
# Entries are 8 bytes: item id (u16) + quantity (u16) + 4 reserved. Empty slot = id 0.
# Early game, Hugo/Chris/Geddoe run THREE separate parties (Thomas has a 4th bag too);
# they merge into one shared inventory + storage after the Flame Champion is chosen.
# The herrvillain save-offset map documents each bag separately (validated vs real saves):
INV_ENTRY  = 8
INV_REGIONS = [
    ("Hugo",    0x7060, 30),
    ("Chris",   0x7150, 30),
    ("Geddoe",  0x7240, 30),
    ("Thomas",  0x7330, 30),
    ("Storage", 0x7420, 90),
]
# Sanity bound for a real item id (the game uses < 0x300; empty slots may hold a
# high-bit sentinel like 0x81xx, which we treat as empty rather than a bogus item).
ITEM_ID_MAX = 0x2FF

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
    stats = list(struct.unpack_from("<8H", rec, OFF_STATS))
    equip = {name: struct.unpack_from("<H", rec, eo)[0] for name, eo in EQUIP_SLOTS}
    skills = [{"slot": k, "id": rec[OFF_SKILLS + k*2], "rank": rec[OFF_SKILLS + k*2 + 1]}
              for k in range(SKILL_SLOTS)]
    lvl = rec[OFF_LEVEL]
    # Real recruit flag from the recruit table (nonzero = recruited); verified monotonic
    # across saves in playtime order. This is the authoritative "have I got them" signal,
    # unlike the character block which is pre-initialized for every roster slot.
    recruit_word = struct.unpack_from("<H", gamedata, RECRUIT_OFF + roster_index * 2)[0]
    return {
        "rosterIndex": roster_index,
        "name": ROSTER[roster_index] if roster_index < len(ROSTER) else f"#{roster_index}",
        "addr": off,
        "id": rec[OFF_ID],
        "level": lvl,
        "curHP": struct.unpack_from("<H", rec, OFF_CURHP)[0],
        "maxHP": struct.unpack_from("<H", rec, OFF_MAXHP)[0],
        "expToNext": struct.unpack_from("<I", rec, OFF_EXP)[0],
        "stats": dict(zip(STAT_NAMES, stats)),
        "equip": equip,
        "skills": skills,
        "recruited": recruit_word != 0,
        "recruitWord": recruit_word,
        "recruiter": recruiter_of(recruit_word),
        "recruiters": recruiters_of(recruit_word),
        "hasData": lvl > 0 or sum(stats) > 0,
        "raw": list(rec),
    }


def decode_party(gamedata):
    """Active-party member char-ids (0 = empty slot)."""
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

def decode_inventory(gamedata):
    """Decode the item inventory grouped by bag (Hugo/Chris/Geddoe/Thomas/Storage).
    Returns [{region, base, firstSlot, capacity, used, freeSlots, items:[...]}].
    `slot` is the absolute entry index from the start of the first bag, so it
    round-trips on write. Only non-empty slots appear in `items`; `freeSlots` lists the
    absolute indices of empty slots in this bag (for adding new items)."""
    base0 = INV_REGIONS[0][1]
    groups = []
    for name, base, count in INV_REGIONS:
        items, free = [], []
        first_slot = (base - base0) // INV_ENTRY
        for k in range(count):
            off = base + k * INV_ENTRY
            if off + 4 > len(gamedata):
                break
            slot = (off - base0) // INV_ENTRY
            iid = struct.unpack_from("<H", gamedata, off)[0]
            qty = struct.unpack_from("<H", gamedata, off + 2)[0]
            if iid == 0 or iid > ITEM_ID_MAX:      # empty or high-bit sentinel slot
                free.append(slot)
                continue
            items.append({"slot": slot, "addr": off, "id": iid, "qty": qty,
                          "category": item_category(iid)})
        groups.append({"region": name, "base": base, "firstSlot": first_slot,
                       "capacity": count, "used": len(items),
                       "freeSlots": free, "items": items})
    return groups


def decode_save(gamedata):
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
    return {"size": len(gamedata), "checksumWord": struct.unpack_from("<I", gamedata, 0)[0],
            "global": g, "names": names, "carryover": detect_carryover(gamedata),
            "party": decode_party(gamedata),
            "characters": [
                c for c in (decode_character(gamedata, i)
                            for i in range(min(CHAR_COUNT, len(ROSTER)))) if c],
            "inventory": decode_inventory(gamedata)}


# Editable per-character scalar fields -> (offset within the 140-byte block, byte width).
CHAR_FIELDS = {
    "level":       (OFF_LEVEL, 1),
    "curHP":       (OFF_CURHP, 2),
    "maxHP":       (OFF_MAXHP, 2),
    "expToNext":   (OFF_EXP,   4),
}
# stat block: 8 u16 at OFF_STATS, addressed by stat name
STAT_INDEX = {n: i for i, n in enumerate(STAT_NAMES)}
# equip slots addressable by name -> offset
EQUIP_OFF = dict(EQUIP_SLOTS)

def _clamp(v, width):
    return max(0, min((1 << (8*width)) - 1, int(v)))

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
        enc = str(val).encode("latin1", "replace")[:n]
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
                    if sname in STAT_INDEX:
                        struct.pack_into("<H", b, base + OFF_STATS + STAT_INDEX[sname]*2,
                                         _clamp(sval, 2))
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
                off, w = CHAR_FIELDS[k]
                fmt = {1: "<B", 2: "<H", 4: "<I"}[w]
                struct.pack_into(fmt, b, base + off, _clamp(v, w))
                changed += 1
    for slot, ent in (inv_edits or {}).items():
        slot = int(slot)
        off = INV_REGIONS[0][1] + slot * INV_ENTRY   # slot is relative to the first bag
        if off + 4 > len(b):
            continue
        if "id" in ent:
            new_id = _clamp(ent["id"], 2)
            struct.pack_into("<H", b, off, new_id); changed += 1
            # ensure the 4 reserved bytes are clean when (re)filling/clearing a slot
            struct.pack_into("<I", b, off + 4, 0)
            if new_id == 0:                     # clearing a slot -> zero its quantity too
                struct.pack_into("<H", b, off + 2, 0)
            elif "qty" not in ent and struct.unpack_from("<H", b, off + 2)[0] == 0:
                struct.pack_into("<H", b, off + 2, 1)   # new item with no qty -> default 1
        if "qty" in ent:
            struct.pack_into("<H", b, off + 2, _clamp(ent["qty"], 2)); changed += 1
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
        dec = decode_save(gd)
        dec["folder"] = s["folder"]
        dec["label"] = slot_label(s["folder"])
        ic = card.read_file(s["cluster"], s["length"], "icon.sys")
        dec["meta"] = _title_from_icon_sys(ic)
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
    dec = decode_save(gd)
    dec["folder"] = psu.folder
    dec["label"] = slot_label(psu.folder)
    dec["meta"] = _title_from_icon_sys(psu.read_file("icon.sys"))
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
    dec = decode_save(gd)
    dec["folder"] = folder
    dec["label"] = slot_label(folder)
    dec["meta"] = _title_from_icon_sys(files.get("icon.sys"))
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
        print(f"  party leader id={s['global']['partyLeader']}  story phase={s['global']['storyPhase']}")
        for c in s["characters"]:
            if c["level"] == 0 and c["curHP"] == 0 and c["expToNext"] == 0:
                continue   # unrecruited/empty slot
            st = " ".join(f"{k}{v}" for k, v in c["stats"].items())
            print(f"  [{c['rosterIndex']:3d}] {c['name']:14s} Lv{c['level']:3d} HP{c['curHP']:4d}  {st}")
