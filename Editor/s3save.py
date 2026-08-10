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
import struct, os, glob

MAGIC = b"Sony PS2 Memory Card Format"
S3_PREFIX = "BASLUS-20387"     # USA Suikoden III save-folder prefix on the memcard

# --- character record layout (offsets within the 140-byte block) ---------------
CHAR_BASE   = 0x33AC
CHAR_STRIDE = 0x8C
CHAR_COUNT  = 100              # map documents ~99 slots incl. the real Flame Champion
OFF_EXP     = 0x00            # u32 EXP toward next level (resets on level-up)
OFF_CURHP   = 0x08            # u16 current HP
OFF_ID      = 0x0C            # u8 character id
OFF_LEVEL   = 0x0D            # u8 level
OFF_STATS   = 0x20            # u16[8] stat block
# stat order mirrors the ISO growth-rate order used elsewhere in the editor
STAT_NAMES  = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK"]

# global (whole-save) fields, from the herrvillain save-offset map
GLOBAL = {
    "partyLeader": (0x12, 1),
    "storyPhase":  (0x14, 1),
}

# Roster order for the character blocks (index 0 = the fixed Flame Champion record).
# Matches the herrvillain map + our list ordering exactly.
ROSTER = [
    "Flame Champion", "Hugo", "Chris", "Geddoe", "Lucia", "Fred", "Rico", "Viki",
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
        self.data = data
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
    return {
        "rosterIndex": roster_index,
        "name": ROSTER[roster_index] if roster_index < len(ROSTER) else f"#{roster_index}",
        "addr": off,
        "id": rec[OFF_ID],
        "level": rec[OFF_LEVEL],
        "curHP": struct.unpack_from("<H", rec, OFF_CURHP)[0],
        "expToNext": struct.unpack_from("<I", rec, OFF_EXP)[0],
        "stats": dict(zip(STAT_NAMES, stats)),
        "raw": list(rec),
    }


def decode_save(gamedata):
    """Decode one save's gamedata payload into globals + character list."""
    g = {}
    for k, (off, w) in GLOBAL.items():
        g[k] = gamedata[off] if w == 1 else struct.unpack_from("<H", gamedata, off)[0]
    chars = []
    for i in range(min(CHAR_COUNT, len(ROSTER))):
        c = decode_character(gamedata, i)
        if c:
            chars.append(c)
    return {"size": len(gamedata), "checksumWord": struct.unpack_from("<I", gamedata, 0)[0],
            "global": g, "characters": chars}


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
