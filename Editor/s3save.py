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
# stat order confirmed against herrvillain per-character RAM codes (relative spacing)
STAT_NAMES  = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"]

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
    return {
        "rosterIndex": roster_index,
        "name": ROSTER[roster_index] if roster_index < len(ROSTER) else f"#{roster_index}",
        "addr": off,
        "id": rec[OFF_ID],
        "level": rec[OFF_LEVEL],
        "curHP": struct.unpack_from("<H", rec, OFF_CURHP)[0],
        "maxHP": struct.unpack_from("<H", rec, OFF_MAXHP)[0],
        "expToNext": struct.unpack_from("<I", rec, OFF_EXP)[0],
        "stats": dict(zip(STAT_NAMES, stats)),
        "equip": equip,
        "raw": list(rec),
    }


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
    Returns [{region, base, items:[{slot, addr, id, qty, category}]}]. `slot` is the
    absolute entry index from the start of the first bag, so it round-trips on write.
    Only non-empty slots (real item id) are returned."""
    groups = []
    for name, base, count in INV_REGIONS:
        items = []
        for k in range(count):
            off = base + k * INV_ENTRY
            if off + 4 > len(gamedata):
                break
            iid = struct.unpack_from("<H", gamedata, off)[0]
            qty = struct.unpack_from("<H", gamedata, off + 2)[0]
            if iid == 0 or iid > ITEM_ID_MAX:      # empty or high-bit sentinel slot
                continue
            slot = (off - INV_REGIONS[0][1]) // INV_ENTRY
            items.append({"slot": slot, "addr": off, "id": iid, "qty": qty,
                          "category": item_category(iid)})
        groups.append({"region": name, "base": base, "items": items})
    return groups


def decode_save(gamedata):
    """Decode one save's gamedata payload into globals + character list + inventory."""
    g = {}
    for k, (off, w) in GLOBAL.items():
        g[k] = gamedata[off] if w == 1 else struct.unpack_from("<H", gamedata, off)[0]
    chars = []
    for i in range(min(CHAR_COUNT, len(ROSTER))):
        c = decode_character(gamedata, i)
        if c:
            chars.append(c)
    return {"size": len(gamedata), "checksumWord": struct.unpack_from("<I", gamedata, 0)[0],
            "global": g, "characters": chars, "inventory": decode_inventory(gamedata)}


# Editable per-character scalar fields -> (offset within the 140-byte block, byte width).
CHAR_FIELDS = {
    "level":     (OFF_LEVEL, 1),
    "curHP":     (OFF_CURHP, 2),
    "maxHP":     (OFF_MAXHP, 2),
    "expToNext": (OFF_EXP,   4),
}
# stat block: 8 u16 at OFF_STATS, addressed by stat name
STAT_INDEX = {n: i for i, n in enumerate(STAT_NAMES)}
# equip slots addressable by name -> offset
EQUIP_OFF = dict(EQUIP_SLOTS)

def _clamp(v, width):
    return max(0, min((1 << (8*width)) - 1, int(v)))

def apply_edits_to_gamedata(gamedata, edits, inv_edits=None):
    """edits: {rosterIndex: {field: value, "stats": {STAT: value}}}.
    inv_edits: {slot: {"id": id, "qty": qty}} for inventory slots.
    Returns (new_gamedata_with_fixed_checksum, changed_field_count)."""
    b = bytearray(gamedata)
    changed = 0
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
            struct.pack_into("<H", b, off, _clamp(ent["id"], 2)); changed += 1
        if "qty" in ent:
            struct.pack_into("<H", b, off + 2, _clamp(ent["qty"], 2)); changed += 1
    return fix_gamedata_checksum(bytes(b)), changed

def write_save_edits(path, folder, edits, make_backup=True, inv_edits=None):
    """Apply edits to one save folder's gamedata on a memcard file, in place.
    Fixes the save checksum and per-page ECC. Backs up the card first by default.
    Returns a summary dict."""
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
    new_gd, changed = apply_edits_to_gamedata(gd, edits, inv_edits)
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


def load_card(path):
    with open(path, "rb") as f:
        return MemCard(f.read())


def read_all_s3_saves(path):
    """Top-level: open a memcard file, decode every S3 save it contains."""
    card = load_card(path)
    saves = []
    for s in card.find_s3_saves():
        gd = card.read_file(s["cluster"], s["length"], "gamedata")
        if not gd:
            continue
        dec = decode_save(gd)
        dec["folder"] = s["folder"]
        dec["label"] = slot_label(s["folder"])
        saves.append(dec)
    return saves


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
                found.append({"path": full, "name": fn, "size": sz,
                              "mb": round(sz / 1048576, 1), "hasS3": has_s3})
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
