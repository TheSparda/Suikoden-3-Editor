#!/usr/bin/env python3
"""
Suikoden III (USA, SLUS-20387) ISO reader/patcher library.

Reverse-engineered from Suikoden3EditorV12b.exe (by Tony H) and verified byte-for-byte
against a real "Suikoden III (USA).iso". All offsets are RAW byte positions into the ISO
(the game data sits in a flat region; no LBA/sector math is needed for these tables).

This is a LIBRARY, not a program. The editor itself is `web/` — a browser app whose ISO
half (`web/iso.js`) is an independent port of these tables, and whose save half runs
`s3save.py` directly under Pyodide. Nothing here is executed at runtime by the web app.

What still uses it: `build_item_desc_extra.py`, which opens the disc and reads the spell,
rune and food tables to regenerate `s3_rune_food_desc.json`. It needs `Iso`, `va2off`,
`load_item_ids`, `load_item_categories`, `read_rune_descs`, `find_food_records`,
`RUNE_SPELLS` and the `SPELL_*` constants.

The old `python3 s3patch.py <command>` CLI was removed once the web editor covered it:
`.s3mod` recipes and `.xdelta` export/apply are native to `web/iso.js` now, and diffing
two arbitrary discs is one shell command:

  xdelta3 -e -S none -s clean.iso modded.iso out.xdelta

(`-S none` matters — the web editor reads any VCDIFF patch except a secondary-compressed
one. `s3save.py <memcard.ps2>` is still runnable directly and dumps a card's saves.)
"""
import os, re, struct, sys, shutil, datetime

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

def _res_text(name, encoding="latin1"):
    """Read a bundled data file as text. Reads from disk beside the sources normally;
    inside the single-file .pyz build (where open() can't reach archive members) it
    falls back to pkgutil, which reads straight out of the zip. Returns None if absent."""
    p = os.path.join(HERE, name)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read().decode(encoding)
    import pkgutil
    try:
        data = pkgutil.get_data(__name__, name)
    except Exception:
        return None
    return data.decode(encoding) if data is not None else None

# ---------------------------------------------------------------------------
# SPELL / RUNE-EFFECT table  (located + partly validated 2026-08-09)
# 94 records x 0x20 bytes inside the boot ELF. Name pointers -> string pool.
# ELF @ file 0xA3800, PT_LOAD file 0xA4800 -> vaddr 0x165D000.
#   file_off = (vaddr - 0x165D000) + 0xA4800
# Record layout (offsets within the 0x20 struct), CONFIRMED where noted:
# NOTE: the first 8 bytes of a record are the TAIL of the PREVIOUS spell — the table is
# written one record out of phase. Read/write them only through the *_OFF constants below,
# which are relative to the owning spell's own base (i.e. base + stride + x):
#   +0x00  u8    tail: flag byte of spell i-1
#   +0x01  u8    tail: RADIUS of spell i-1        [CONFIRMED, see SPELL_RADIUS_OFF]
#   +0x02  u16   tail: link/effect id of spell i-1
#   +0x04  u16   tail: ELEMENT of spell i-1 (low byte)   [CONFIRMED, see SPELL_ELEM_OFF]
#   +0x06  u16   tail: status CHANCE % of spell i-1      [CONFIRMED, see SPELL_CHANCE_OFF]
#   +0x08  u32   -> name string (vaddr)         [CONFIRMED anchor]
#   +0x0C  u32   -> description string (vaddr)  [CONFIRMED]
#   +0x10  u32   base MOV / cast time           [CONFIRMED vs Suikosource]
#   +0x14  u32   bitfield/flags (targeting?)    [UNCONFIRMED - see note]
#   +0x18  u32   flags/target mask?             [UNCONFIRMED]
#   +0x1C  u32   spell power / damage           [STRONG: clean ascending curve]
SPELL_TABLE_FILE = 0x3EC2A0
SPELL_COUNT      = 94
SPELL_STRIDE     = 0x20
# The per-spell element byte is stored one record AHEAD of the record whose name/desc/
# power it belongs to: element(spell i) = byte at record (i+1) + 0x04. Verified against
# the "<Element> MGC" prefix in each spell's own description — 32/34 match under this
# offset vs only 25/34 same-record; the 2 remainders are the Pale Gate spells whose
# element code is 6 (a special multi/dark element, not one of the 5 basics). Read/write
# element ONLY through SPELL_ELEM_OFF so the two stay in lockstep.
SPELL_ELEM_OFF   = SPELL_STRIDE + 0x04   # +0x24 from a record's own base
# Two more tail fields, pinned 2026-08-30 against the spell AND unite tables at once:
#   radius — size of the area/line template. Nonzero for every AREA or LINE record and zero
#     for every single/all-target one: 130/130 across 94 spells + 38 unites, no exception.
#     Spells run 1..4 (Dancing Flames 2 -> Blazing Wall 3 -> Explosion 4); area unites are 3.
#   chance — % chance the status lands. Nonzero for exactly the records with flags14 bit21
#     set (130/130) and it matches the text: unite "Knight B" = 30 vs "30% chance of
#     deathblow", Wind of Sleep 60, Funeral Wind 80, Open Gate 80, Ready!/Go! 100.
# The old "misc" field read this chance byte from the record's own base, i.e. one record
# early, so it reported every spell's value against the WRONG spell.
SPELL_RADIUS_OFF = SPELL_STRIDE + 0x01   # +0x21, u8
SPELL_CHANCE_OFF = SPELL_STRIDE + 0x06   # +0x26, u16 (percent)
# A unite record is 8 bytes longer than a spell record (0x28 vs 0x20), so the same 8-byte
# phase shift leaves a unite's tail INSIDE its own record at +0x20..+0x27 — not one ahead.
UNITE_RADIUS_OFF = 0x21                  # u8,  relative to the unite record's own base
UNITE_CHANCE_OFF = 0x24                  # u16 (percent), same

# Unite (co-op) attack table — same field layout as spells, different array.
# 38 records x 0x28 bytes at 0x3ECF90. Verified vs Suikosource unite guide
# (Twister 50/40, Bow-Wow 300/95, Triangle Strike 200/65, Pretty Girl 70/55).
UNITE_TABLE_FILE = 0x3ECF90
UNITE_COUNT      = 38
UNITE_STRIDE     = 0x28

# RUNE item table (located + verified 2026-08-30). This is where the game keeps the text it
# prints in the rune/equip menu, and it is the ONLY source for the 23 passive support runes
# (Balance, Fury, Fortune, Skunk, ...): those have no spell-table entry, so before this table
# was found they showed no description at all.
#   record  = RUNE_TBL_FILE + item_id * RUNE_TBL_STRIDE      (indexed by ITEM ID, not by rune #)
#   +0x00  u32  -> name string (vaddr)
#   +0x04  u32  -> description string (vaddr)
# Rows for non-rune item ids are zeroed. Rune items occupy ids 317-365 (magic/attack runes) and
# 440-462 (support runes); all 72 line up name-for-name against Suikoden3_item_ids.txt on a
# pristine SLUS-20387, which is the check read_rune_descs() re-runs per record before trusting it.
RUNE_TBL_FILE   = 0x3EAF78
RUNE_TBL_STRIDE = 0x20
RUNE_TBL_NAME   = 0x00
RUNE_TBL_DESC   = 0x04


def _name_key(s):
    """Compare item names loosely: the disc writes 'Sword of Rage', the id list 'Sword Of Rage'."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def read_rune_descs(iso):
    """Return {item_id: description} for every rune item whose RUNE_TBL row still names it."""
    items = load_item_ids()
    cats = load_item_categories()
    out = {}
    for iid, nm in items.items():
        if cats.get(iid) != "Runes":
            continue
        rec = iso.rd(RUNE_TBL_FILE + iid * RUNE_TBL_STRIDE, RUNE_TBL_STRIDE)
        nptr = struct.unpack_from("<I", rec, RUNE_TBL_NAME)[0]
        dptr = struct.unpack_from("<I", rec, RUNE_TBL_DESC)[0]
        try:
            tn = iso.rd(va2off(nptr), 48).split(b"\x00")[0].decode("latin1", "replace")
            td = iso.rd(va2off(dptr), 96).split(b"\x00")[0].decode("latin1", "replace")
        except Exception:
            continue
        if tn and td and _name_key(tn) == _name_key(nm):
            out[iid] = td
    return out


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
SPELL_FIELDS = {  # name -> (offset, width); offsets are relative to the spell's OWN base
    "name_ptr": (0x08, 4), "desc_ptr": (0x0C, 4),
    "cast_mov": (0x10, 4), "flags14": (0x14, 4), "flags18": (0x18, 4), "power": (0x1C, 4),
    # tail fields — stored one record ahead (see the layout note above)
    "radius": (SPELL_STRIDE + 0x01, 1), "element": (SPELL_STRIDE + 0x04, 1),
    "chance": (SPELL_STRIDE + 0x06, 2),
}
SPELL_TAIL_FIELDS = {"radius", "element", "chance"}   # need index+1 to exist

def va2off(v): return (v - ELF_PL_VADDR) + ELF_PL_FILE
def off2va(o): return (o - ELF_PL_FILE) + ELF_PL_VADDR

# ---------------------------------------------------------------------------
# EQUIPMENT record table (weapons/armor/shields/accessories).
# stride 0x44; layout: desc ptr @+0x00, name ptr @+0x40, price u32 @+0x08,
# DEF u16 @+0x10, then up to 5 effect slots of 8 bytes each starting @+0x14:
#   slot = (type u16, value u16, param u16, pad u16)
# The 3rd u16 ("param") means different things per type: for a Stat bonus it selects
# WHICH stat; for Grant skill it's the skill id; otherwise it's an element/flag.
GEAR_STRIDE   = 0x44
GEAR_DEF_OFF  = 0x10
GEAR_PRICE_OFF= 0x08
GEAR_EFFECT_OFFS = (0x14, 0x1C, 0x24, 0x2C, 0x34)
# Effect types — re-derived vs in-game descriptions (2026-08-10). Type 2 is a
# generic stat bonus whose stat is chosen by `param` (GEAR_STAT_SELECTOR); the old
# map wrongly hard-coded types 2/3/4 as SPD/PWR/MDF (that was the reported bug).
GEAR_EFFECT_TYPES = {
    0: "(none)",
    1: "HP regen/turn",
    2: "Stat bonus",              # +value to the stat named by `param`
    3: "Accuracy +%",             # percent accuracy (only sample: Accuracy +10%)
    4: "type 4 (unverified)",     # no occurrences in this ROM
    5: "Grant skill",             # `param` = skill id
    6: "Status Protect",
    7: "Elemental Resist",
    8: "Evade single-target ATK",
    9: "Weak vs thrust / mobility",
    10: "Lowers ATK effect %",
    11: "Chance to reflect MGC",
    12: "Counter-attack rate +%",
}
# For a Stat bonus (type 2), the `param` u16 is the S3 stat index
# (PWR SKL MAG REP PDF MDF SPD LUK). Only 0/1/3/6 occur in gear, matching the
# four boostable stats PWR/SKL/REP/SPD (verified vs single-stat item descriptions).
GEAR_STAT_SELECTOR = {0: "PWR", 1: "SKL", 2: "MAG", 3: "REP", 4: "PDF", 5: "MDF", 6: "SPD", 7: "LUK"}
# Which effect types use `param` as a stat selector vs a skill id vs nothing.
GEAR_TYPE_PARAM = {2: "stat", 5: "skill"}   # everything else: param unused/flag

def find_gear_records(iso):
    """Return {item_id: stats_file_offset} for every equipment record, keyed by item id.
    A record is validated by: desc ptr @+0 and name ptr @+0x40 both point into the
    string pool, the name is a known item, description contains '(' (a stat string),
    DEF < 500 and price < 2,000,000 (rejects false pointer matches).

    OFF-BY-ONE (confirmed vs the Suikoden III equipment list, 26/26): the NAME pointer
    for item X lives in the record whose stat block actually belongs to item X-1. X's own
    stats/DEF/price/effects/description sit in the NEXT record (name_offset + GEAR_STRIDE).
    So we detect a record by its name pointer at `p`, then return `p + GEAR_STRIDE` as the
    stats offset for that item. Reading DEF/desc from the name record instead mislabels
    every item with the next one's stats (e.g. Wooden Shield showing Taikyoku Tunic's
    DEF 78 / Status Protect)."""
    from struct import unpack_from
    items = load_item_ids(); nameset = {v: k for k, v in items.items()}
    lo = ELF_PL_FILE; hi = ELF_PL_FILE + 0x38D000
    data = iso.rd(lo, hi - lo)
    # string pool sits high in the loaded image; accept any vaddr inside PT_LOAD
    def isptr(w): return ELF_PL_VADDR <= w <= ELF_PL_VADDR + 0x38D000
    out = {}
    for p in range(0, len(data) - 2 * GEAR_STRIDE, 4):
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
        out.setdefault(iid, lo + p + GEAR_STRIDE)   # stats live one record after the name
    return out


# ---------------------------------------------------------------------------
# Armor sets (verified 2026-08-24 vs the Suikosource Rare Armor guide + disassembly).
# The set-composition table lives in the boot ELF: 5 records x 8 bytes, each record
# = 4 x u16 item ids in equip-slot order (Head, Body, Shield, Accessory); 0 = slot
# not part of the set. Single copy in the whole 4GB ISO. The set-detect routine
# (ELF va 0x16CAD90) walks this table and returns the 1-based row number, so the
# in-code set numbers are: 1=Mole 2=Prosperity 3=Destiny 4=Guardian 5=Pale Moon.
SET_TABLE_FILE = 0x3DDAB8
SET_COUNT      = 5
SET_STRIDE     = 8
SET_SLOTS      = ("Head", "Body", "Shield", "Accessory")

# What the CODE actually does with each set (disassembled, call-site verified):
# - Potch:   battle-result overlay multiplies potch x3 for EVERY party member whose
#            set number has bit 1 set (`andi 2`) -> Prosperity (2) and Destiny (3).
#            Two identical overlay copies of the sll/addu pair perform the x3.
# - Counter: counter routine (ELF 0x17FD580): a character withOUT the Counter Attack
#            skill who wears set 3 (Destiny) gets a 30% chance to counter anyway
#            (`slti v0,v0,30` at two sites; damage = (PWR+partner PWR)/3).
# - Heal:    on-hit routine: set 5 (Pale Moon) heals 25% of damage dealt
#            (`addiu v0,s1,3; sra v0,v0,2` = signed /4).
# - Halving: counter-damage path tests `set & 4` (matches Guardian 4 AND Pale Moon 5)
#            and halves the amount — informational only, not exposed for editing.
# - Squeak:  field code checks set 1 (Mole) for the squeaky-footsteps SFX.
# Note the Suikosource guide attributes the counter bonus to Guardian and claims
# Prosperity is x7 — the code says Destiny counters and both potch sets are x3/wearer.
ARMOR_SETS = [
    {"name": "Mole Set",
     "bonus": "Squeaky footsteps when walking (not in battle)",
     "guide": "Make squeaky noises when you walk (not in battle)."},
    {"name": "Prosperity Set",
     "bonus": "Potch won after battle ×3 per wearer (stacks)",
     "guide": "Potch won after battle multiplied by 7."},
    {"name": "Destiny Set",
     "bonus": "Potch ×3 per wearer (stacks) + 30% counter chance if the wearer "
              "lacks the Counter Attack skill",
     "guide": "Potch won after battle multiplied by 3."},
    {"name": "Guardian Set",
     "bonus": "Counter-related damage involving the wearer is halved (set & 4 check)",
     "guide": "Counter rate +50%."},
    {"name": "Pale Moon Set",
     "bonus": "Heal 25% of damage dealt after each standard attack "
              "(also matches the Guardian halving check)",
     "guide": "Heal 25% of damage dealt after each standard attack."},
]

# Instruction patch points for the editable set-bonus constants (raw ISO offsets;
# every word below verified byte-exact against a pristine SLUS-20387 dump).
# Potch multiplier: `sll $v0,$s6,1` + `addu $s6,$v0,$s6` (= x3) at two overlay copies.
SET_POTCH_SITES = (0x3F3E699C, 0x3F3EF19C)     # each site: sll word, then addu word at +4
# Destiny bonus-counter chance: `slti $v0,$v0,30` (rand(100) < imm) at two ELF sites.
SET_COUNTER_SITES = (0x244F8C, 0x2452F8)
# Pale Moon heal fraction: bias `addiu $v0,$s1,(2^k)-1` then `sra $v0,$v0,k` (k=2 = /4).
SET_HEAL_BIAS_OFF  = 0x245DA8
SET_HEAL_SHIFT_OFF = 0x245DB4

def set_potch_words(mult):
    """Encode the 2-instruction multiply for a supported potch multiplier.
    x2^k is a bare sll; x(2^k)+1 is sll+addu (the stock x3). Returns (sll, addu)."""
    NOP = 0
    def sll(rd, rt, sa): return (rt << 16) | (rd << 11) | (sa << 6)
    ADDU_S6 = (2 << 21) | (22 << 16) | (22 << 11) | 0x21     # addu $s6,$v0,$s6
    m = int(mult)
    if m == 1:
        return (NOP, NOP)
    for k in range(1, 5):
        if m == (1 << k):          # 2,4,8,16 -> sll $s6,$s6,k
            return (sll(22, 22, k), NOP)
        if m == (1 << k) + 1:      # 3,5,9,17 -> sll $v0,$s6,k ; addu $s6,$v0,$s6
            return (sll(2, 22, k), ADDU_S6)
    raise ValueError(f"unsupported potch multiplier {mult}")

SET_POTCH_CHOICES = (1, 2, 3, 4, 5, 8, 9, 16, 17)

def decode_potch_words(w1, w2):
    """Reverse of set_potch_words; returns the multiplier or None if unrecognized."""
    for m in SET_POTCH_CHOICES:
        if set_potch_words(m) == (w1, w2):
            return m
    return None

def set_heal_words(shift):
    """Encode the Pale Moon heal-fraction pair for divisor 2^shift (shift 0..4)."""
    k = int(shift)
    if not 0 <= k <= 4:
        raise ValueError(f"bad heal shift {shift}")
    bias = (1 << k) - 1
    addiu = (9 << 26) | (17 << 21) | (2 << 16) | bias        # addiu $v0,$s1,bias
    sra   = (2 << 16) | (2 << 11) | (k << 6) | 3             # sra  $v0,$v0,k
    return (addiu, sra)

def set_counter_word(pct):
    """Encode `slti $v0,$v0,pct` for the Destiny bonus-counter chance (0..100)."""
    p = int(pct)
    if not 0 <= p <= 100:
        raise ValueError(f"bad counter chance {pct}")
    return (0x0A << 26) | (2 << 21) | (2 << 16) | p


# ---------------------------------------------------------------------------
# Global random-encounter rate (boot ELF, verified 2026-08-24 against a pristine
# SLUS-20387 dump). The per-area base rate lives in map data, but every field
# encounter goes through one roll at ELF va 0x17023A8:
#
#     rate = area_rate * MULT / 100        (MULT picked by movement mode)
#     if (rate <= 0) return                 -- 0 disables encounters outright
#     ... sample every 0.5 units moved, +30% if you loiter in one spot ...
#     if (rand(100) < rate) -> battle
#
# Three movement modes reach that multiply. Walking and running each load their own
# MULT immediate; the third ("ride", when the leader's id classifies into the first
# group at va 0x16F3860) skips the block entirely with `move $s5,$s1` = an implicit
# x1.00. To scale ALL THREE from one percentage we give the ride path its own
# multiplier immediate and branch it into the shared `MULT/100` block, which is a
# behaviour-preserving rewrite: at 100% it computes s1*100/100 == s1, exactly stock.
# Names corrected 2026-08-31: it is WALKING that ships without a multiplier (it skips the
# multiply with `move $s5,$s1`), and the 150 is running while MOUNTED. The values were always
# right; only the labels were swapped. Mounted *walking* takes the walk path.
ENC_WALK_MULT_OFF = 0x149C3C   # `move $s5,$s1`   -> `addiu $v0,$zero,MULT_walk`
ENC_WALK_BR_OFF   = 0x149C40   # `b 0x170248C`    -> `b 0x1702464` (join scale block)
ENC_RIDE_MULT_OFF = 0x149C5C   # `addiu $v0,$zero,150`  running while mounted
ENC_RUN_MULT_OFF  = 0x149C60   # `addiu $v0,$zero,120`  running on foot
ENC_SITES = (ENC_WALK_MULT_OFF, ENC_WALK_BR_OFF, ENC_RIDE_MULT_OFF, ENC_RUN_MULT_OFF)

# Byte-exact stock words, so 100% restores the ISO instead of merely emulating it.
ENC_STOCK_WORDS = (0x0220A82D, 0x10000012, 0x24020096, 0x24020078)
ENC_BR_JOIN     = 0x10000008   # b 0x1702464
ENC_ADDIU_V0    = 0x24020000   # addiu $v0,$zero,imm
ENC_WALK_BASE, ENC_RUN_BASE, ENC_RIDE_BASE = 100, 120, 150
ENC_MAX_PCT = 1000             # 150*1000/100 = 1500, well inside addiu's signed imm

def encounter_words(pct):
    """Encode the 4 instruction words for a global encounter rate of `pct` percent
    (100 = stock, 50 = half, 200 = double, 0 = no random encounters).
    Returns a tuple aligned with ENC_SITES."""
    p = int(pct)
    if not 0 <= p <= ENC_MAX_PCT:
        raise ValueError(f"encounter rate must be 0..{ENC_MAX_PCT}, got {pct}")
    if p == 100:
        return ENC_STOCK_WORDS
    scale = lambda base: (base * p + 50) // 100        # round half up
    return (ENC_ADDIU_V0 | scale(ENC_WALK_BASE),
            ENC_BR_JOIN,
            ENC_ADDIU_V0 | scale(ENC_RIDE_BASE),
            ENC_ADDIU_V0 | scale(ENC_RUN_BASE))

def decode_encounter_words(words):
    """Reverse of encounter_words. Returns the percentage, or None if the words
    aren't stock and aren't a shape this editor produced (e.g. hand-patched)."""
    w = tuple(words)
    if w == ENC_STOCK_WORDS:
        return 100
    walk, br = w[0], w[1]
    if br != ENC_BR_JOIN or (walk & 0xFFFF0000) != ENC_ADDIU_V0:
        return None
    p = walk & 0xFFFF
    return p if 0 <= p <= ENC_MAX_PCT and encounter_words(p) == w else None


# ---------------------------------------------------------------------------
# Consumable / food table (verified v12). Distinct array from gear: name ptr is at
# +0x44 (gear uses +0x40), and — unlike gear — name/desc/stats are SAME-record aligned
# (60/60 desc "Heals NNN HP" == heal field; no off-by-one). Medicines, Antitoxin, stat
# "Stone of X" items, and foods all share this record.
FOOD_TABLE_FILE = 0x3E91D0     # first record
FOOD_STRIDE     = 0x48
FOOD_COUNT      = 60           # recipe/dish records 0..59; recs 60-61 resolve to consumable
                               # ITEMS (Sacrificial Jizo=Curative, Escape Scroll=Spell Scroll) —
                               # past the recipe table, so excluded (was 62; see issue notes)
FOOD_DESC_OFF   = 0x00         # u32 -> description string (vaddr)   [CONFIRMED]
FOOD_HEAL_OFF   = 0x14         # u16 heal amount (HP)                [CONFIRMED 60/60]
FOOD_PROC_OFF   = 0x1E         # u16 proc chance % (0/30/60)         [CONFIRMED 7/7]
FOOD_NAME_OFF   = 0x44         # u32 -> name string (vaddr)          [CONFIRMED anchor]

def find_food_records(iso):
    """Return [{index, addr, name, desc, heal, proc}] for the consumable/food table.
    Only heal and proc% are exposed for editing — both verified against the in-game
    descriptions. The status-id field (which status a food inflicts/cures) is not yet
    mapped and is left untouched."""
    out = []
    for i in range(FOOD_COUNT):
        off = FOOD_TABLE_FILE + i * FOOD_STRIDE
        rec = iso.rd(off, FOOD_STRIDE)
        nptr = struct.unpack_from("<I", rec, FOOD_NAME_OFF)[0]
        dptr = struct.unpack_from("<I", rec, FOOD_DESC_OFF)[0]
        try:
            name = iso.rd(va2off(nptr), 32).split(b"\x00")[0].decode("latin1", "replace")
        except Exception:
            name = "?"
        try:
            desc = iso.rd(va2off(dptr), 96).split(b"\x00")[0].decode("latin1", "replace")
        except Exception:
            desc = ""
        out.append({
            "index": i, "addr": off, "name": name, "desc": desc,
            "heal": struct.unpack_from("<H", rec, FOOD_HEAL_OFF)[0],
            "proc": struct.unpack_from("<H", rec, FOOD_PROC_OFF)[0],
        })
    return out


# ---------------------------------------------------------------------------
# ID list parsing (from the .txt files extracted from the editor)
# ---------------------------------------------------------------------------
def load_skill_ids():
    """skill file: 'NN Name' one per line -> {hexid:int -> name}."""
    text = _res_text("Suikoden3_skill_ids.txt")
    out = {}
    if text is None:
        return out
    for line in text.splitlines():
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
    text = _res_text("Suikoden3_item_ids.txt")
    out = {}
    if text is None:
        return out
    import re
    for m in re.finditer(r"\b([0-9A-Fa-f]{3})\t([^\t\n\r]+)", text):
        out[int(m.group(1), 16)] = m.group(2).strip()
    return out


def load_item_categories():
    """Parse the '----* Category *----' section headers in the item-id file and map
    each item id to its category (e.g. 'Runes', 'Headgear', 'Shields'). Used to filter
    equipment dropdowns to the right item type per slot. Returns {id:int -> category}."""
    text = _res_text("Suikoden3_item_ids.txt")
    out = {}
    if text is None:
        return out
    import re
    cur = ""
    for line in text.splitlines():
        hdr = re.search(r"\*\s*(.+?)\s*\*", line)
        if hdr and "\t" not in line:                 # a section header, not an item row
            cur = hdr.group(1).strip()
            continue
        for m in re.finditer(r"\b([0-9A-Fa-f]{3})\t([^\t\n\r]+)", line):
            out[int(m.group(1), 16)] = cur
    return out


# ---------------------------------------------------------------------------
# ISO helpers
# ---------------------------------------------------------------------------
# ---- Shareable "mod recipe": every ISO write is auto-journaled at the Iso layer into
# <iso>.s3mod.json (a byte-level diff with old+new, so it's reversible + version-
# checkable). RECORD_MODS toggles it globally; _SUPPRESS_MOD is set during recipe-apply
# so a replay doesn't re-pollute the recipe.
RECORD_MODS = True
_SUPPRESS_MOD = False

class Iso:
    def __init__(self, path, write=False):
        self.path = path
        self.write = write
        self.f = open(path, "r+b" if write else "rb")
        self._writes = []

    def close(self):
        if self.write and RECORD_MODS and not _SUPPRESS_MOD and self._writes:
            try:
                _flush_mods(self.path, self._writes)
            except Exception:
                pass
        self._writes = []
        self.f.close()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()

    def rd(self, off, n):
        self.f.seek(off)
        return self.f.read(n)

    def wr(self, off, data):
        if RECORD_MODS and not _SUPPRESS_MOD and self.write:
            old = self.rd(off, len(data))
            self._writes.append((off, old, bytes(data)))
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
# Shareable mod recipe (.s3mod) + xdelta patch export/apply
#
# A recipe is a small JSON of {offset: [oldByte, newByte]} runs — reversible (it stores
# the original bytes) and version-checked (it stores the SLUS-20387 version word, so a
# recipe won't apply to the wrong ISO). It lets people share editor-made mods without
# passing around the multi-GB disc. xdelta captures *any* byte diff (incl. overlay/raw
# edits recipes don't model) but needs a pristine ISO to create/apply.
# ---------------------------------------------------------------------------
def _mod_sidecar(path):
    return path + ".s3mod.json"

def _flush_mods(path, writes):
    """Merge a batch of (off, old, new) writes into the ISO's <iso>.s3mod.json journal."""
    import json
    side = _mod_sidecar(path)
    try:
        with open(side) as fp:
            data = json.load(fp)
    except Exception:
        data = {"format": "s3mod", "version": 1, "bytes": {}}
    bm = data.setdefault("bytes", {})
    for off, old, new in writes:
        for i in range(len(new)):
            k = str(off + i)
            if k not in bm:
                bm[k] = [old[i], new[i]]   # keep the earliest on-disk value as "old"
            else:
                bm[k][1] = new[i]          # collapse repeated edits to the latest "new"
    tmp = side + ".tmp"
    with open(tmp, "w") as fp:
        json.dump(data, fp)
    os.replace(tmp, side)

def mod_status(path):
    """Byte + coalesced-run count of the recipe journal accumulated for this ISO."""
    import json
    try:
        with open(_mod_sidecar(path)) as fp:
            bm = json.load(fp).get("bytes", {})
    except Exception:
        return {"bytes": 0, "runs": 0}
    offs = sorted(int(k) for k in bm)
    runs = 0
    prev = None
    for o in offs:
        if prev is None or o != prev + 1:
            runs += 1
        prev = o
    return {"bytes": len(offs), "runs": runs}

def export_mod(path, note=""):
    """Coalesce the byte journal into a portable .s3mod recipe dict (contiguous runs)."""
    import json
    with open(_mod_sidecar(path)) as fp:
        bm = json.load(fp).get("bytes", {})
    if not bm:
        raise ValueError("no edits recorded for this ISO yet")
    items = sorted((int(k), v) for k, v in bm.items())
    runs = []
    for off, (old, new) in items:
        if runs and off == runs[-1]["_end"]:
            r = runs[-1]
            r["old"] += "%02x" % old
            r["new"] += "%02x" % new
            r["_end"] += 1
        else:
            runs.append({"off": off, "old": "%02x" % old, "new": "%02x" % new, "_end": off + 1})
    for r in runs:
        r.pop("_end")
    with Iso(path) as g:
        vraw = g.rd(VERSION_CHECK_OFF, 4)
    return {"format": "s3mod", "version": 1, "game": "SLUS-20387",
            "versionWord": struct.unpack(">I", vraw)[0], "note": note,
            "patchCount": len(runs), "patches": runs}

def apply_mod(path, mod, make_backup=True):
    """Replay a .s3mod recipe onto a target ISO (version-checked, old-byte-warned)."""
    global _SUPPRESS_MOD
    if mod.get("format") != "s3mod":
        raise ValueError("not an s3mod recipe")
    with Iso(path) as g:
        cur = struct.unpack(">I", g.rd(VERSION_CHECK_OFF, 4))[0]
    want = mod.get("versionWord")
    if want is not None and want != cur:
        raise ValueError(f"ISO version word 0x{cur:08X} != recipe 0x{want:08X} "
                         f"(wrong game/region — expected SLUS-20387)")
    if make_backup:
        backup(path)
    applied = mism = 0
    _SUPPRESS_MOD = True
    try:
        with Iso(path, write=True) as g:
            for p in mod.get("patches", []):
                new = bytes.fromhex(p["new"])
                off = int(p["off"])
                if p.get("old") and g.rd(off, len(new)) != bytes.fromhex(p["old"]):
                    mism += 1
                g.wr(off, new)
                applied += len(new)
    finally:
        _SUPPRESS_MOD = False
    return {"appliedBytes": applied, "mismatchedRuns": mism,
            "patchCount": len(mod.get("patches", []))}

def clear_mod(path):
    try:
        os.remove(_mod_sidecar(path))
        return True
    except FileNotFoundError:
        return False

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
