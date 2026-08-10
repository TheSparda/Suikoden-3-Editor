#!/usr/bin/env python3
"""
Suikoden III (USA, SLUS-20387) ISO patcher / research tool.

Reverse-engineered from Suikoden3EditorV12b.exe (by Tony H) and verified byte-for-byte
against a real "Suikoden III (USA).iso". All offsets are RAW byte positions into the ISO
(the game data sits in a flat region; no LBA/sector math is needed for these tables).

Two halves:
  * VERIFIED  — character/growth/support/shop tables the original editor edits. Safe.
  * RESEARCH  — spell/rune-effect editing. Offsets are NOT known yet; this half only
                *searches* the ISO to help locate the table. Nothing is written blind.

Usage examples:
  python3 s3patch.py verify   "ISO/Suikoden III (USA).iso"
  python3 s3patch.py dump-char "ISO/..." --index 2
  python3 s3patch.py dump-shop "ISO/..."
  python3 s3patch.py set-shop  "ISO/..." --table item2 --slot 0 --value 1
  python3 s3patch.py set-field "ISO/..." --list 1 --index 2 --off 9 --u8 99
  python3 s3patch.py find-bytes "ISO/..." --hex "0B 02 01 02"
  python3 s3patch.py find-runetext "ISO/..."          # locate rune name strings
"""
import argparse, os, struct, sys, shutil, datetime

# ---------------------------------------------------------------------------
# VERIFIED constants (decimal is authoritative; hex is derived)
# ---------------------------------------------------------------------------
VERSION_CHECK_OFF = 4136544          # u32, read big-endian
VERSION_CHECK_VAL = 1084660225       # 0x40A69A01 for SLUS-20387

TABLES = {
    # name: (base_offset, stride, description)
    "list1": (4078716, 140, "character starting stats"),
    "list2": (4068152, 132, "stat growth / skill max levels"),
    "list3": (4089904,   8, "support character skills"),
    "list4": (4061704,  28, "list4 (16 bytes/record)"),
}

# Fixed (non-indexed) tables: name -> (offset, count, width, note)
SHOP = {
    "item1":    (4136564,  3, 4, "item1 group (u32)"),
    "item2":    (3970620, 15, 4, "PRICE LADDER (u32 potch) — not item IDs"),
    "item3_a":  (4105552, 10, 2, "item3 shop slots 1-10 (u16 item IDs)"),
    "item3_b":  (4054224, 16, 2, "item3 shop slots 21-36 (u16 item IDs)"),
}

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# SPELL / RUNE-EFFECT table  (located + partly validated 2026-08-09)
# 94 records x 0x20 bytes inside the boot ELF. Name pointers -> string pool.
# ELF @ file 0xA3800, PT_LOAD file 0xA4800 -> vaddr 0x165D000.
#   file_off = (vaddr - 0x165D000) + 0xA4800
# Record layout (offsets within the 0x20 struct), CONFIRMED where noted:
#   +0x00  u16   index/link a   (into a deeper anim/effect table)
#   +0x02  u16   index/link b
#   +0x04  u16   flags/kind     (element+kind nibble region; NOT fully mapped)
#   +0x06  u8    misc
#   +0x08  u32   -> name string (vaddr)         [CONFIRMED anchor]
#   +0x0C  u32   -> description string (vaddr)  [CONFIRMED]
#   +0x10  u32   base MOV / cast time           [CONFIRMED vs Suikosource]
#   +0x14  u32   bitfield/flags (targeting?)    [UNCONFIRMED - see note]
#   +0x18  u32   flags/target mask?             [UNCONFIRMED]
#   +0x1C  u32   spell power / damage           [STRONG: clean ascending curve]
SPELL_TABLE_FILE = 0x3EC2A0
SPELL_COUNT      = 94
SPELL_STRIDE     = 0x20

# Unite (co-op) attack table — same field layout as spells, different array.
# 38 records x 0x28 bytes at 0x3ECF90. Verified vs Suikosource unite guide
# (Twister 50/40, Bow-Wow 300/95, Triangle Strike 200/65, Pretty Girl 70/55).
UNITE_TABLE_FILE = 0x3ECF90
UNITE_COUNT      = 38
UNITE_STRIDE     = 0x28

# Enemy NAME table (research spike, 2026-08-09). 100 entries x 0x14, names inline
# (10-char truncated). Names are index-keyed; there is NO editable flat stat table
# (see offsets doc) — this is exposed read-only so users can reference enemies.
ENEMY_NAME_FILE  = 0x3E74E0
ENEMY_COUNT      = 100
ENEMY_NAME_STRIDE = 0x14

def read_enemy_names(iso):
    """Return [{index, name}] for the 100 enemy name-table entries."""
    out = []
    for i in range(ENEMY_COUNT):
        rec = iso.rd(ENEMY_NAME_FILE + i*ENEMY_NAME_STRIDE, ENEMY_NAME_STRIDE)
        nm = rec.split(b"\x00")[0].decode("latin1", "replace").strip()
        out.append({"index": i, "name": nm})
    return out

ELF_PL_FILE      = 0xA4800
ELF_PL_VADDR     = 0x165D000
SPELL_FIELDS = {  # name -> (offset, width)
    "linkA": (0x00, 2), "linkB": (0x02, 2), "kind": (0x04, 2), "misc": (0x06, 1),
    "name_ptr": (0x08, 4), "desc_ptr": (0x0C, 4),
    "cast_mov": (0x10, 4), "flags14": (0x14, 4), "flags18": (0x18, 4), "power": (0x1C, 4),
}

def va2off(v): return (v - ELF_PL_VADDR) + ELF_PL_FILE
def off2va(o): return (o - ELF_PL_FILE) + ELF_PL_VADDR

# ---------------------------------------------------------------------------
# EQUIPMENT record table (weapons/armor/shields/accessories).
# stride 0x44; layout: desc ptr @+0x00, name ptr @+0x40, price u32 @+0x08,
# DEF u16 @+0x10, then up to 5 effect slots of 8 bytes each starting @+0x14:
#   slot = (type u16, value u16, skill_id u16, pad u16)
# effect types (verified vs descriptions across 221 records):
GEAR_STRIDE   = 0x44
GEAR_DEF_OFF  = 0x10
GEAR_PRICE_OFF= 0x08
GEAR_EFFECT_OFFS = (0x14, 0x1C, 0x24, 0x2C, 0x34)
GEAR_EFFECT_TYPES = {
    0: "(none)", 1: "HP regen/turn", 2: "SPD", 3: "PWR", 4: "MDF",
    5: "Grant skill", 6: "Status Protect", 7: "Elemental Resist", 8: "Evade ATK",
}

def find_gear_records(iso):
    """Return {item_id: file_offset} for every equipment record, keyed by item id.
    A record is validated by: desc ptr @+0 and name ptr @+0x40 both point into the
    string pool, the name is a known item, description contains '(' (a stat string),
    DEF < 500 and price < 2,000,000 (rejects false pointer matches)."""
    from struct import unpack_from
    items = load_item_ids(); nameset = {v: k for k, v in items.items()}
    lo = ELF_PL_FILE; hi = ELF_PL_FILE + 0x38D000
    data = iso.rd(lo, hi - lo)
    # string pool sits high in the loaded image; accept any vaddr inside PT_LOAD
    def isptr(w): return ELF_PL_VADDR <= w <= ELF_PL_VADDR + 0x38D000
    out = {}
    for p in range(0, len(data) - GEAR_STRIDE, 4):
        dp = unpack_from("<I", data, p)[0]
        nv = unpack_from("<I", data, p + 0x40)[0]
        if not (isptr(dp) and isptr(nv)):
            continue
        # resolve name string
        no = (nv - ELF_PL_VADDR); e = data.find(b"\x00", no); nm = data[no:e].decode("latin1", "replace")
        if nm not in nameset:
            continue
        do = (dp - ELF_PL_VADDR); de = data.find(b"\x00", do); ds = data[do:de].decode("latin1", "replace")
        if "(" not in ds:
            continue
        defv = unpack_from("<H", data, p + GEAR_DEF_OFF)[0]
        price = unpack_from("<I", data, p + GEAR_PRICE_OFF)[0]
        if defv > 500 or price > 2000000:
            continue
        iid = nameset[nm]
        out.setdefault(iid, lo + p)
    return out


# ---------------------------------------------------------------------------
# ID list parsing (from the .txt files extracted from the editor)
# ---------------------------------------------------------------------------
def load_skill_ids():
    """skill file: 'NN Name' one per line -> {hexid:int -> name}."""
    path = os.path.join(HERE, "Suikoden3_skill_ids.txt")
    out = {}
    if not os.path.exists(path):
        return out
    for line in open(path, encoding="latin1"):
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) == 2:
            try:
                out[int(parts[0], 16)] = parts[1]
            except ValueError:
                pass
    return out


def load_item_ids():
    """item file: tab-separated 'HHH<TAB>Name' pairs, two per line -> {id:int -> name}."""
    path = os.path.join(HERE, "Suikoden3_item_ids.txt")
    out = {}
    if not os.path.exists(path):
        return out
    import re
    text = open(path, encoding="latin1").read()
    for m in re.finditer(r"\b([0-9A-Fa-f]{3})\t([^\t\n\r]+)", text):
        out[int(m.group(1), 16)] = m.group(2).strip()
    return out


# ---------------------------------------------------------------------------
# ISO helpers
# ---------------------------------------------------------------------------
class Iso:
    def __init__(self, path, write=False):
        self.path = path
        self.f = open(path, "r+b" if write else "rb")

    def close(self):
        self.f.close()

    def rd(self, off, n):
        self.f.seek(off)
        return self.f.read(n)

    def wr(self, off, data):
        self.f.seek(off)
        self.f.write(data)

    def u8(self, off):  return self.rd(off, 1)[0]
    def u16(self, off): return struct.unpack("<H", self.rd(off, 2))[0]
    def u32(self, off): return struct.unpack("<I", self.rd(off, 4))[0]


def check_version(iso):
    raw = iso.rd(VERSION_CHECK_OFF, 4)
    be = struct.unpack(">I", raw)[0]
    return be == VERSION_CHECK_VAL, raw, be


def require_version(iso):
    ok, raw, be = check_version(iso)
    if not ok:
        sys.exit(f"ERROR: version check failed. @0x{VERSION_CHECK_OFF:X} bytes={raw.hex(' ')} "
                 f"BE=0x{be:08X}, expected 0x{VERSION_CHECK_VAL:08X} (SLUS-20387). Aborting.")


def backup(path):
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = f"{path}.bak_{ts}"
    print(f"Backing up -> {dst}  ({os.path.getsize(path)/1e9:.2f} GB, may take a moment)...")
    shutil.copy2(path, dst)
    return dst


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_verify(a):
    iso = Iso(a.iso)
    ok, raw, be = check_version(iso)
    print(f"Version check @0x{VERSION_CHECK_OFF:X}: bytes={raw.hex(' ')} BE=0x{be:08X} "
          f"-> {'MATCH (SLUS-20387)' if ok else 'NO MATCH'}")
    for name, (base, stride, desc) in TABLES.items():
        print(f"  {name}: base=0x{base:X} stride={stride}  ({desc})")
    for name, (off, cnt, w, note) in SHOP.items():
        vals = [(iso.u32(off + i*w) if w == 4 else iso.u16(off + i*w)) for i in range(cnt)]
        print(f"  {name} @0x{off:X}: {vals}   # {note}")
    iso.close()


def cmd_dump_char(a):
    iso = Iso(a.iso); require_version(iso)
    base, stride, _ = TABLES[f"list{a.list}"]
    N = a.index
    rec = iso.rd(base + N*stride, stride)
    print(f"list{a.list} record N={N} @0x{base+N*stride:X} (stride {stride}):")
    for row in range(0, stride, 16):
        chunk = rec[row:row+16]
        print(f"  +{row:3d}: " + " ".join(f"{b:02X}" for b in chunk))
    iso.close()


def cmd_dump_shop(a):
    iso = Iso(a.iso); require_version(iso)
    items = load_item_ids()
    for name, (off, cnt, w, note) in SHOP.items():
        print(f"\n{name} @0x{off:X}  ({note}):")
        for i in range(cnt):
            v = iso.u32(off + i*w) if w == 4 else iso.u16(off + i*w)
            label = "" if w == 4 else f"  {items.get(v,'?')}"
            print(f"  [{i:2d}] {v}{label}")
    iso.close()


def cmd_set_shop(a):
    iso = Iso(a.iso, write=True); require_version(iso)
    if not a.no_backup:
        backup(a.iso)
    off, cnt, w, note = SHOP[a.table]
    if not (0 <= a.slot < cnt):
        sys.exit(f"slot out of range 0..{cnt-1}")
    pos = off + a.slot*w
    data = struct.pack("<I" if w == 4 else "<H", a.value)
    old = iso.rd(pos, w)
    iso.wr(pos, data)
    print(f"{a.table}[{a.slot}] @0x{pos:X}: {old.hex(' ')} -> {data.hex(' ')}  (={a.value})")
    iso.close()


def cmd_set_field(a):
    """Generic verified-region write into a listN record at a byte offset."""
    iso = Iso(a.iso, write=True); require_version(iso)
    base, stride, _ = TABLES[f"list{a.list}"]
    if a.off + (2 if a.u16 is not None else 1) > stride:
        sys.exit("field extends past record stride")
    if not a.no_backup:
        backup(a.iso)
    pos = base + a.index*stride + a.off
    if a.u16 is not None:
        data = struct.pack("<H", a.u16); val = a.u16
    else:
        data = bytes([a.u8]); val = a.u8
    old = iso.rd(pos, len(data))
    iso.wr(pos, data)
    print(f"list{a.list} N={a.index} +{a.off} @0x{pos:X}: {old.hex(' ')} -> {data.hex(' ')} (={val})")
    iso.close()


def cmd_find_bytes(a):
    """Locate a byte pattern anywhere in the ISO (streaming, low memory)."""
    pat = bytes(int(x, 16) for x in a.hex.split())
    iso = Iso(a.iso)
    CHUNK = 8 << 20
    overlap = len(pat) - 1
    pos = 0
    prev = b""
    hits = 0
    while True:
        buf = prev + iso.rd(pos, CHUNK)
        if len(buf) <= overlap:
            break
        start = 0
        while True:
            i = buf.find(pat, start)
            if i < 0:
                break
            abs_off = pos - len(prev) + i
            print(f"  hit @0x{abs_off:X} ({abs_off})")
            hits += 1
            if hits >= a.max:
                iso.close(); return
            start = i + 1
        prev = buf[-overlap:] if overlap else b""
        pos += CHUNK
        if len(buf) < CHUNK:
            break
    print(f"{hits} hit(s).")
    iso.close()


def cmd_find_runetext(a):
    """
    RESEARCH: locate rune/spell name strings in the ISO. Finding the string table
    is the first step to finding the adjacent spell-parameter (damage/AOE) table.
    """
    iso = Iso(a.iso)
    needles = [b"True Fire", b"Rage", b"Cyclone", b"Thunder", b"Flowing", b"Mother Earth",
               b"Phoenix", b"Pale Gate"]
    data = iso.rd(0, 200 << 20)  # first 200MB usually holds text/data
    print("Searching first 200MB for rune name strings...")
    for n in needles:
        i = data.find(n)
        print(f"  {n.decode():14} -> {'@0x%X (%d)' % (i, i) if i >= 0 else 'not found in window'}")
    iso.close()
    print("\nNext step: dump a hex window around a cluster of these hits to spot a")
    print("fixed-stride parameter table (see: python3 s3patch.py dump-region ...).")


def cmd_dump_region(a):
    iso = Iso(a.iso)
    data = iso.rd(a.off, a.len)
    for row in range(0, len(data), 16):
        chunk = data[row:row+16]
        hexs = " ".join(f"{b:02X}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"0x{a.off+row:08X}  {hexs:<47}  {asc}")
    iso.close()


def _spell_name(iso, rec):
    nptr = struct.unpack_from("<I", rec, 0x08)[0]
    try:
        o = va2off(nptr); s = iso.rd(o, 32).split(b"\x00")[0]
        return s.decode("latin1", "replace")
    except Exception:
        return "?"


ELEMENTS = {1:"Fire",2:"Water",3:"Wind",4:"Earth",5:"Lightning"}
AREA_BIT = 0x8000  # flags14 bit15: set = area-of-effect, clear = not-area

def decode_target(f14):
    """Human-readable target shape from flags14 (validated vs description text)."""
    tb = (f14 >> 8) & 0xFF          # target byte
    area = bool(f14 & AREA_BIT)
    line = bool(tb & 0x10)
    low  = tb & 0x0F
    who = {0xA:"single", 0x2:"all-foes", 0x3:"foes+allies", 0x1:"self/ally"}.get(low, f"who0x{low:X}")
    if area: shape = "AREA"
    elif line: shape = "LINE"
    elif low == 0xA: shape = "single"
    else: shape = "spread"   # hits a group without an area template
    return f"{shape}:{who}"

def decode_element(kind):
    return ELEMENTS.get(kind & 0xFF, f"0x{kind & 0xFF:X}")

# flags14 low byte = damage/effect kind (validated vs descriptions)
KIND_LOW = {0x0A:"damage", 0x87:"heal", 0x42:"status", 0x4A:"damage+status",
            0x02:"utility", 0x46:"heal+status", 0x83:"cure-all", 0x06:"none"}

# flags18 = status-effect / enhance bitmask (isolated from single-effect spells)
F18_BITS = {
    1:"poison", 3:"instant-death", 4:"unbalance", 9:"teleport/chant",
    10:"sleep", 13:"silence/berserk", 14:"mgc-boost", 15:"mgc-shield",
    19:"mgc-immune-once", 21:"buff-pdf/mdf",
    22:"sword-fire", 23:"sword-lightning", 24:"sword-wind",
    25:"resist-fire", 26:"resist-lightning", 27:"resist-wind",
}
F18_HEAL_MASK = 0x1DE7  # composite set on full heal/restore spells

def decode_f18(v):
    if v == 0: return "-"
    if (v & F18_HEAL_MASK) == F18_HEAL_MASK and bin(v).count("1") >= 8:
        extra = v & ~F18_HEAL_MASK
        return "heal/restore-all" + (f"+0x{extra:X}" if extra else "")
    names = [F18_BITS.get(b, f"bit{b}") for b in range(32) if (v >> b) & 1]
    return "|".join(names)


def cmd_spells(a):
    """List the spell/rune-effect table with decoded key fields."""
    iso = Iso(a.iso); require_version(iso)
    print(f"{'idx':>3} {'file':>8} {'name':18} {'elem':9} {'cast':>5} {'power':>6}  {'target':18} flags14")
    for i in range(SPELL_COUNT):
        off = SPELL_TABLE_FILE + i*SPELL_STRIDE
        rec = iso.rd(off, SPELL_STRIDE)
        kind = struct.unpack_from("<H", rec, 0x04)[0]
        cast = struct.unpack_from("<I", rec, 0x10)[0]
        f14  = struct.unpack_from("<I", rec, 0x14)[0]
        power= struct.unpack_from("<I", rec, 0x1C)[0]
        print(f"{i:>3} 0x{off:06X} {_spell_name(iso,rec)[:18]:18} {decode_element(kind):9} "
              f"{cast:>5} {power:>6}  {decode_target(f14):18} 0x{f14:08X}")
    iso.close()


def cmd_set_aoe(a):
    """Flip a spell between area-of-effect and not, using flags14 bit15."""
    iso = Iso(a.iso, write=True); require_version(iso)
    if not a.no_backup:
        backup(a.iso)
    pos = SPELL_TABLE_FILE + a.index*SPELL_STRIDE + 0x14
    cur = iso.u32(pos)
    new = (cur | AREA_BIT) if a.on else (cur & ~AREA_BIT)
    iso.wr(pos, struct.pack("<I", new))
    rec = iso.rd(SPELL_TABLE_FILE + a.index*SPELL_STRIDE, SPELL_STRIDE)
    print(f"spell #{a.index} '{_spell_name(iso,rec)}' flags14 @0x{pos:X}: "
          f"0x{cur:08X} -> 0x{new:08X}  target now {decode_target(new)}")
    iso.close()


def cmd_dump_spell(a):
    iso = Iso(a.iso); require_version(iso)
    off = SPELL_TABLE_FILE + a.index*SPELL_STRIDE
    rec = iso.rd(off, SPELL_STRIDE)
    print(f"spell #{a.index} @0x{off:X}  '{_spell_name(iso,rec)}'")
    for fname,(fo,w) in SPELL_FIELDS.items():
        v = (iso.u32(off+fo) if w==4 else iso.u16(off+fo) if w==2 else iso.u8(off+fo))
        extra = ""
        if fname in ("name_ptr","desc_ptr"):
            try: extra = "  -> '" + iso.rd(va2off(v),32).split(b'\x00')[0].decode('latin1','replace') + "'"
            except Exception: extra = ""
        print(f"  +0x{fo:02X} {fname:9} = {v}{extra}")
    kind = struct.unpack_from("<H", rec, 0x04)[0]
    f14  = struct.unpack_from("<I", rec, 0x14)[0]
    f18  = struct.unpack_from("<I", rec, 0x18)[0]
    print("  decoded:")
    print(f"    element   = {decode_element(kind)}")
    print(f"    target    = {decode_target(f14)}   (AOE bit15 = {'ON' if f14 & AREA_BIT else 'off'})")
    print(f"    kind      = {KIND_LOW.get(f14 & 0xFF, '0x%02X' % (f14 & 0xFF))}")
    print(f"    status    = {decode_f18(f18)}")
    print("  raw: " + " ".join(f"{b:02X}" for b in rec))
    iso.close()


def cmd_set_spell(a):
    """Write one field of a spell record. Field must be in SPELL_FIELDS."""
    iso = Iso(a.iso, write=True); require_version(iso)
    if a.field not in SPELL_FIELDS:
        sys.exit(f"unknown field. choices: {', '.join(SPELL_FIELDS)}")
    fo, w = SPELL_FIELDS[a.field]
    if not a.no_backup:
        backup(a.iso)
    pos = SPELL_TABLE_FILE + a.index*SPELL_STRIDE + fo
    fmt = {1:"<B",2:"<H",4:"<I"}[w]
    data = struct.pack(fmt, a.value)
    old = iso.rd(pos, w)
    iso.wr(pos, data)
    print(f"spell #{a.index} {a.field} @0x{pos:X}: {old.hex(' ')} -> {data.hex(' ')} (={a.value})")
    iso.close()


# Rune -> ordered spell names (from Suikosource S3 casting-time guide).
# Resolved to spell-table indices at runtime by name, so it survives index drift.
RUNE_SPELLS = {
    "fire":        ["Flaming Arrows", "Dancing Flames", "Blazing Wall", "Explosion"],
    "rage":        ["Dancing Flames", "Blazing Wall", "Explosion", "Final Flame"],
    "truefire":    ["Blazing Wall", "Explosion", "Final Flame", "Hellfire"],
    "lightning":   ["Thunder Runner", "Berserk Blow", "Soaring Bolt", "Furious Blow"],
    "thunder":     ["Berserk Blow", "Soaring Bolt", "Furious Blow", "Thunder Storm"],
    "truelightning":["Soaring Bolt", "Furious Blow", "Thunder Storm", "Hammer of Raijin"],
    "wind":        ["Wind of Sleep", "Healing Wind", "The Shredding", "Funeral Wind"],
    "cyclone":     ["Healing Wind", "The Shredding", "Funeral Wind", "Shining Wind"],
    "truewind":    ["The Shredding", "Funeral Wind", "Shining Wind", "Eternal Wind"],
    "water":       ["Kindness Drops", "Breath of Ice", "Kindness Rain", "Silent Lake"],
    "flowing":     ["Breath of Ice", "Kindness Rain", "Silent Lake", "Mother Ocean"],
    "truewater":   ["Kindness Rain", "Silent Lake", "Mother Ocean", "Heavenly Drops"],
    "earth":       ["Clay Guardian", "Vengeful Child", "Guardian Earth", "Earthquake"],
    "motherearth": ["Vengeful Child", "Guardian Earth", "Earthquake", "Canopy Defense"],
    "trueearth":   ["Guardian Earth", "Earthquake", "Canopy Defense", "Land of Eternity"],
    "shield":      ["Battle Oath", "Great Blessing", "Battlefield"],
    "blinking":    ["Ready!", "Set!", "Go!"],
    "jongleur":    ["Song of Skylark", "Song of Serenity", "Song of Madness", "Song of a Hero"],
    "palegate":    ["Open Gate", "Royal Passage", "Pale Palace", "Empty World"],
    "swordofrage": ["Sword of Rage", "Fire Amulet"],
    "swordofthunder":["Sword of Thunder", "Thunder Amulet"],
    "swordofcyclone":["Sword of Cyclone", "Wind Amulet"],
}

def _name_to_index(iso):
    idx = {}
    for i in range(SPELL_COUNT):
        rec = iso.rd(SPELL_TABLE_FILE + i*SPELL_STRIDE, SPELL_STRIDE)
        idx.setdefault(_spell_name(iso, rec), i)
    return idx


def _apply_spell_changes(iso, index, a):
    """Shared edit engine: returns list of (offset,fmt,value) for one spell."""
    off = SPELL_TABLE_FILE + index*SPELL_STRIDE
    rec = iso.rd(off, SPELL_STRIDE)
    changes = []
    if a.power is not None: changes.append((0x1C, "<I", a.power))
    if a.cast  is not None: changes.append((0x10, "<I", a.cast))
    if a.element is not None:
        rev = {v.lower(): k for k, v in ELEMENTS.items()}
        el = rev.get(a.element.lower())
        if el is None: sys.exit(f"element must be one of {list(ELEMENTS.values())}")
        kind = struct.unpack_from("<H", rec, 0x04)[0]
        changes.append((0x04, "<H", (kind & 0xFF00) | el))
    if a.aoe is not None:
        f14 = struct.unpack_from("<I", rec, 0x14)[0]
        f14 = (f14 | AREA_BIT) if a.aoe == "on" else (f14 & ~AREA_BIT)
        changes.append((0x14, "<I", f14))
    if a.status is not None:
        rev = {v: (1 << b) for b, v in F18_BITS.items()}
        if a.status == "none": changes.append((0x18, "<I", 0))
        elif a.status in rev:  changes.append((0x18, "<I", rev[a.status]))
        else: sys.exit(f"status must be 'none' or one of {sorted(rev)}")
    return off, changes


def cmd_reskin_rune(a):
    """Apply the same stat edits to all spells a rune grants (Level-1 rune reskin)."""
    iso = Iso(a.iso, write=True); require_version(iso)
    key = a.rune.lower().replace(" ", "").replace("_", "")
    if key not in RUNE_SPELLS:
        sys.exit("unknown rune. choices: " + ", ".join(sorted(RUNE_SPELLS)))
    names = RUNE_SPELLS[key]
    n2i = _name_to_index(iso)
    missing = [n for n in names if n not in n2i]
    if missing:
        sys.exit(f"could not resolve spell(s) {missing} in table — aborting.")
    indices = [n2i[n] for n in names]
    print(f"rune '{a.rune}' -> spells {list(zip(names, indices))}")
    if not any(v is not None for v in (a.power, a.cast, a.element, a.aoe, a.status)):
        sys.exit("nothing to change; pass at least one of --power/--cast/--element/--aoe/--status")
    if not a.no_backup:
        backup(a.iso)
    for idx in indices:
        off, changes = _apply_spell_changes(iso, idx, a)
        for fo, fmt, val in changes:
            iso.wr(off + fo, struct.pack(fmt, val))
        rec = iso.rd(off, SPELL_STRIDE)
        kind = struct.unpack_from("<H", rec, 0x04)[0]
        f14  = struct.unpack_from("<I", rec, 0x14)[0]
        f18  = struct.unpack_from("<I", rec, 0x18)[0]
        cast = struct.unpack_from("<I", rec, 0x10)[0]
        pw   = struct.unpack_from("<I", rec, 0x1C)[0]
        print(f"  #{idx:2} {_spell_name(iso,rec)[:16]:16} -> {decode_element(kind)} | "
              f"{decode_target(f14)} | status={decode_f18(f18)} | cast={cast} power={pw}")
    iso.close()


def cmd_reskin(a):
    """
    Level-1 custom rune: rewrite one spell's behavior in a single call.
    Any of --power/--cast/--element/--aoe/--status can be combined.
    Shows before/after decode. Backs up unless --no-backup.
    """
    iso = Iso(a.iso, write=True); require_version(iso)
    off, changes = _apply_spell_changes(iso, a.index, a)
    name = _spell_name(iso, iso.rd(off, SPELL_STRIDE))

    def show(tag):
        r = iso.rd(off, SPELL_STRIDE)
        kind = struct.unpack_from("<H", r, 0x04)[0]
        f14  = struct.unpack_from("<I", r, 0x14)[0]
        f18  = struct.unpack_from("<I", r, 0x18)[0]
        cast = struct.unpack_from("<I", r, 0x10)[0]
        pw   = struct.unpack_from("<I", r, 0x1C)[0]
        print(f"  {tag}: {decode_element(kind)} | {decode_target(f14)} | "
              f"kind={KIND_LOW.get(f14&0xFF,'0x%02X'%(f14&0xFF))} | status={decode_f18(f18)} | "
              f"cast={cast} power={pw}")

    if not changes:
        sys.exit("nothing to change; pass at least one of --power/--cast/--element/--aoe/--status")

    print(f"spell #{a.index} '{name}' @0x{off:X}")
    show("before")
    if not a.no_backup:
        backup(a.iso)
    for fo, fmt, val in changes:
        iso.wr(off + fo, struct.pack(fmt, val))
    show("after ")
    iso.close()


def cmd_ids(a):
    if a.kind == "skill":
        for k, v in sorted(load_skill_ids().items()):
            print(f"{k:02X}  {v}")
    else:
        for k, v in sorted(load_item_ids().items()):
            print(f"{k:03X}  {v}")


# ---------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Suikoden III (USA) ISO patcher/research tool")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_iso(sp): sp.add_argument("iso")

    s = sub.add_parser("verify", help="check version + dump table snapshot"); add_iso(s); s.set_defaults(fn=cmd_verify)

    s = sub.add_parser("dump-char", help="hexdump a listN record"); add_iso(s)
    s.add_argument("--list", type=int, default=1, choices=[1,2,3,4])
    s.add_argument("--index", type=int, required=True); s.set_defaults(fn=cmd_dump_char)

    s = sub.add_parser("dump-shop", help="show shop/price tables with item names"); add_iso(s); s.set_defaults(fn=cmd_dump_shop)

    s = sub.add_parser("set-shop", help="write one shop/price slot"); add_iso(s)
    s.add_argument("--table", required=True, choices=list(SHOP))
    s.add_argument("--slot", type=int, required=True)
    s.add_argument("--value", type=lambda x:int(x,0), required=True)
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_set_shop)

    s = sub.add_parser("set-field", help="write a byte/u16 into a listN record"); add_iso(s)
    s.add_argument("--list", type=int, default=1, choices=[1,2,3,4])
    s.add_argument("--index", type=int, required=True)
    s.add_argument("--off", type=int, required=True)
    s.add_argument("--u8", type=lambda x:int(x,0))
    s.add_argument("--u16", type=lambda x:int(x,0))
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_set_field)

    s = sub.add_parser("find-bytes", help="search ISO for a hex pattern"); add_iso(s)
    s.add_argument("--hex", required=True, help='e.g. "0B 02 01 02"')
    s.add_argument("--max", type=int, default=20); s.set_defaults(fn=cmd_find_bytes)

    s = sub.add_parser("find-runetext", help="RESEARCH: locate rune name strings"); add_iso(s); s.set_defaults(fn=cmd_find_runetext)

    s = sub.add_parser("dump-region", help="hex+ascii dump at an offset"); add_iso(s)
    s.add_argument("--off", type=lambda x:int(x,0), required=True)
    s.add_argument("--len", type=lambda x:int(x,0), default=256); s.set_defaults(fn=cmd_dump_region)

    s = sub.add_parser("spells", help="list the spell/rune-effect table"); add_iso(s); s.set_defaults(fn=cmd_spells)

    s = sub.add_parser("dump-spell", help="decode one spell record"); add_iso(s)
    s.add_argument("--index", type=int, required=True); s.set_defaults(fn=cmd_dump_spell)

    s = sub.add_parser("set-aoe", help="toggle a spell's area-of-effect flag (flags14 bit15)"); add_iso(s)
    s.add_argument("--index", type=int, required=True)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--on", action="store_true"); g.add_argument("--off", dest="on", action="store_false")
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_set_aoe)

    s = sub.add_parser("set-spell", help="write one spell field (cast_mov/power/kind/flags...)"); add_iso(s)
    s.add_argument("--index", type=int, required=True)
    s.add_argument("--field", required=True)
    s.add_argument("--value", type=lambda x:int(x,0), required=True)
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_set_spell)

    s = sub.add_parser("reskin", help="rewrite a spell's power/cast/element/aoe/status in one call"); add_iso(s)
    s.add_argument("--index", type=int, required=True)
    s.add_argument("--power", type=lambda x:int(x,0))
    s.add_argument("--cast", type=lambda x:int(x,0))
    s.add_argument("--element", help="Fire/Water/Wind/Earth/Lightning")
    s.add_argument("--aoe", choices=["on","off"])
    s.add_argument("--status", help="none or: " + ",".join(sorted(set(F18_BITS.values()))))
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_reskin)

    s = sub.add_parser("reskin-rune", help="apply stat edits to ALL spells a rune grants"); add_iso(s)
    s.add_argument("--rune", required=True, help="e.g. fire, truefire, lightning, cyclone, earth, palegate...")
    s.add_argument("--power", type=lambda x:int(x,0))
    s.add_argument("--cast", type=lambda x:int(x,0))
    s.add_argument("--element", help="Fire/Water/Wind/Earth/Lightning")
    s.add_argument("--aoe", choices=["on","off"])
    s.add_argument("--status", help="none or a status name")
    s.add_argument("--no-backup", action="store_true"); s.set_defaults(fn=cmd_reskin_rune)

    s = sub.add_parser("ids", help="print skill or item ID list")
    s.add_argument("--kind", choices=["skill","item"], required=True); s.set_defaults(fn=cmd_ids)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
