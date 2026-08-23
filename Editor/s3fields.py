"""
Named field schemas for the list1-4 character records, reconstructed from the
decompiled Suikoden3EditorV12b.exe (control labels + Patch/Load offsets).

Each field: (label, offset_within_record, width_bytes, kind)
  kind: "item" = resolve via item id list, "skill" = skill id, "num" = plain number.

The 6 equip u16s are rune Head/Right/Left, helmet, armor, shield. NOTE: the rune-slot
labels were corrected vs the exe's write-order naming — the game stores Head@+64,
Right@+72, Left@+80 (verified vs suikosource + the save editor; the exe had Head/Left
swapped). Helmet/armor/shield (+88/+96/+104) keep the exe's order.
Skill rank values: 1=E 2=D 3=C 4=B 5=B+ 6=A 7=A+ 8=S (exe caps at 7).
Skill-max values : 0=Can't get 1=A+ 2=D 3=C 4=B 5=B+ 6=A 7=S.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))

def res_bytes(name):
    """Read a bundled data file as bytes. Reads from disk beside the sources normally;
    inside the single-file .pyz build (where open() can't reach archive members) it
    falls back to pkgutil, which reads straight out of the zip."""
    p = os.path.join(HERE, name)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    import pkgutil
    data = pkgutil.get_data(__name__, name)
    if data is None:
        raise FileNotFoundError(name)
    return data

def res_text(name, encoding="utf-8"):
    """Read a bundled data file as text (works from sources and from the .pyz)."""
    return res_bytes(name).decode(encoding)

def res_json(name):
    """Load a bundled *.json reference table (works from sources and from the .pyz)."""
    return json.loads(res_text(name))

# list1 — Character Starting Stats (stride 140). Offsets verified vs Patch1_Click.
LIST1 = [
    # +0 (u16): meaning unverified — NOT a 0/1 flag and NOT an item id (observed 0..1100,
    #   exceeding the 612 max item id). Left as a raw number rather than a misleading label.
    ("Unknown (u16 @+0)",       0,   2, "num"),
    # +9 (u8): weapon-growth class (0..13) grouping the roster by weapon curve — verified
    #   (Hugo=3; Chris/Geddoe/Borus/Queen=5). See Weapons tab for the class->members table.
    ("Weapon growth class",     9,   1, "num"),
    ("Skill 1 (hex)",           12,  1, "skill"), ("Skill 1 rank", 13, 1, "num"),
    ("Skill 2 (hex)",           14,  1, "skill"), ("Skill 2 rank", 15, 1, "num"),
    ("Skill 3 (hex)",           16,  1, "skill"), ("Skill 3 rank", 17, 1, "num"),
    ("Skill 4 (hex)",           18,  1, "skill"), ("Skill 4 rank", 19, 1, "num"),
    ("Skill 5 (hex)",           20,  1, "skill"), ("Skill 5 rank", 21, 1, "num"),
    ("Skill 6 (hex)",           22,  1, "skill"), ("Skill 6 rank", 23, 1, "num"),
    # Rune slot order VERIFIED vs suikosource/initial.txt (and the save editor): the u16s are
    # Head/Right/Left, NOT Left/Right/Head. +64=Head (Fubar=Shining Wind, Bright=Spreading Flame),
    # +72=Right (Aila=Shield, Elaine=Water, Duke=Lightning), +80=Left (Chris=Phoenix, Geddoe=
    # Lightning, Elaine=Fire). The exe's write-order label had Head and Left swapped. See issue #2.
    ("Rune Head (hex)",         64,  2, "item"),
    ("Rune Right hand (hex)",   72,  2, "item"),
    ("Rune Left hand (hex)",    80,  2, "item"),
    ("Helmet (hex)",            88,  2, "item"),
    ("Armor (hex)",             96,  2, "item"),
    ("Shield (hex)",           104,  2, "item"),
    ("Other item 1 (hex)",     112,  2, "item"), ("Other item 1 amount", 114, 1, "num"),
    ("Other item 2 (hex)",     120,  2, "item"), ("Other item 2 amount", 122, 1, "num"),
    ("Other item 3 (hex)",     128,  2, "item"), ("Other item 3 amount", 130, 1, "num"),
]

# list2 — Stat Growth + Skill Max Levels (stride 132). Growth block from Patch offsets.
# Growth rates occupy the exe's own write-set {+0, +4,+5,+6,+7, +9,+10,+11} (8 bytes).
# Byte<->stat mapping VERIFIED by correlation vs suikosource/statgrowth.txt across the
# roster: +4=PWR +5=SKL +6=MAG +7=REP +9=MDF +10=SPD +11=LUK, and +0=HP. Bytes +1..+3
# are always 0 (unused padding) and +8 is a sparse non-growth field — NONE of these are
# rune levels. (The old "Head/RH/LH Rune Level" fields at +0/+1/+2 were a misread: +0 is
# actually HP growth, and +1/+2 are padding. See github issue #2.)
LIST2_GROWTH = [
    ("PWR growth rate",   4, 1, "num"), ("SKL growth rate",   5, 1, "num"),
    ("MAG growth rate",   6, 1, "num"), ("REP growth rate",   7, 1, "num"),
    ("MDF growth rate",   9, 1, "num"), ("SPD growth rate",  10, 1, "num"),
    ("LUK growth rate",  11, 1, "num"), ("HP growth rate",    0, 1, "num"),
]
# Skill-max array: 43 skills (ids 0x01..0x2B) as consecutive bytes starting at +16
# (skill id N -> byte +16+(N-1); array spans +16..+58). VERIFIED vs suikosource/skills.txt:
# 988/1100 known caps match at +16 (~90%; the rest are guide-vs-data variance / a few
# lead chars whose caps are all-S), vs ~12% at the old +13. Encoding is unchanged and
# correct (see SKILL_MAX_OPTS: 0=Can't get,1=A+,2=D,3=C,4=B,5=B+,6=A,7=S). See issue #2.
LIST2_SKILLMAX_START = 16

# list2 — Fixed Skills block (skills view). Offsets exact from Patch1_Click:
#   list2_60..76 -> +80..+96 (17 bytes), list2_80..81 -> +100..+101 (2 bytes).
# The exe's field names for this view (Fixed Skill N = a skill id, "level learned"
# = the character level it unlocks). Byte<->label order within the block is the
# exe's write order; treat pairing as best-effort (offsets are authoritative).
LIST2_FIXED = [
    ("Fixed Skill 1 (id)",        80, 1, "skill"), ("Skill 1 level learned", 81, 1, "num"),
    ("Fixed Skill 2 (id)",        82, 1, "skill"), ("Skill 2 level learned", 83, 1, "num"),
    ("Fixed Skill 3 (id)",        84, 1, "skill"), ("Skill 3 level learned", 85, 1, "num"),
    ("Fixed Skill 4 (id)",        86, 1, "skill"), ("Skill 4 level learned", 87, 1, "num"),
    ("Fixed Skill 5 (id)",        88, 1, "skill"), ("Skill 5 level learned", 89, 1, "num"),
    ("Fixed Skill 6 (id)",        90, 1, "skill"), ("Skill 6 level learned", 91, 1, "num"),
    ("Fixed Skill 7 (id)",        92, 1, "skill"), ("Skill 7 level learned", 93, 1, "num"),
    ("Fixed Skill 8 (id)",        94, 1, "skill"), ("Skill 8 level learned", 95, 1, "num"),
    ("Number of Free Skills",     96, 1, "num"),
    ("Starting level",           100, 1, "num"),
    ("Starting level relative (0/1)", 101, 1, "num"),
]

# list3 — Support Character Skills (stride 8): 8 skill-id/rank bytes.
LIST3 = [(f"Support skill {i+1} (id)", i, 1, "skill") for i in range(8)]

SKILL_RANK_HELP = "1=E 2=D 3=C 4=B 5=B+ 6=A 7=A+ 8=S"
SKILL_MAX_HELP  = "0=Can't get 1=A+ 2=D 3=C 4=B 5=B+ 6=A 7=S"

# Structured (value, label) option lists for skill-rank dropdowns. Kept in lockstep with
# the HELP strings above. RANK is a learned skill's proficiency (0 = not learned, then
# E..S); verified 0..8 in real saves. MAX is the ISO list2 "skill maximum level" scale.
SKILL_RANK_OPTS = [(0, "— (not learned)"), (1, "E"), (2, "D"), (3, "C"), (4, "B"),
                   (5, "B+"), (6, "A"), (7, "A+"), (8, "S")]
# Displayed in grade order (ascending), but each option's VALUE is still the game's raw
# non-linear byte — note A+ = 1 sits between A (6) and S (7) by grade, not by value.
SKILL_MAX_OPTS  = [(0, "Can't get"), (2, "D"), (3, "C"), (4, "B"), (5, "B+"),
                   (6, "A"), (1, "A+"), (7, "S")]
