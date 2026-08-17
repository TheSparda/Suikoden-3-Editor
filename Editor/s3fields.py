"""
Named field schemas for the list1-4 character records, reconstructed from the
decompiled Suikoden3EditorV12b.exe (control labels + Patch/Load offsets).

Each field: (label, offset_within_record, width_bytes, kind)
  kind: "item" = resolve via item id list, "skill" = skill id, "num" = plain number.

Ordering of the 6 equip u16s (rune hands/head, helmet, armor, shield) follows the
exe's write order in Patch1_Click; treat those labels as the exe's own naming.
Skill rank values: 1=E 2=D 3=C 4=B 5=B+ 6=A 7=A+ 8=S (exe caps at 7).
Skill-max values : 0=Can't get 1=A+ 2=D 3=C 4=B 5=B+ 6=A 7=S.
"""

# list1 — Character Starting Stats (stride 140). Offsets verified vs Patch1_Click.
LIST1 = [
    ("Relative indicator (0/1)", 0,   2, "num"),
    ("Skill points",            9,   1, "num"),
    ("Skill 1 (hex)",           12,  1, "skill"), ("Skill 1 rank", 13, 1, "num"),
    ("Skill 2 (hex)",           14,  1, "skill"), ("Skill 2 rank", 15, 1, "num"),
    ("Skill 3 (hex)",           16,  1, "skill"), ("Skill 3 rank", 17, 1, "num"),
    ("Skill 4 (hex)",           18,  1, "skill"), ("Skill 4 rank", 19, 1, "num"),
    ("Skill 5 (hex)",           20,  1, "skill"), ("Skill 5 rank", 21, 1, "num"),
    ("Skill 6 (hex)",           22,  1, "skill"), ("Skill 6 rank", 23, 1, "num"),
    ("Rune Left hand (hex)",    64,  2, "item"),
    ("Rune Right hand (hex)",   72,  2, "item"),
    ("Rune Head (hex)",         80,  2, "item"),
    ("Helmet (hex)",            88,  2, "item"),
    ("Armor (hex)",             96,  2, "item"),
    ("Shield (hex)",           104,  2, "item"),
    ("Other item 1 (hex)",     112,  2, "item"), ("Other item 1 amount", 114, 1, "num"),
    ("Other item 2 (hex)",     120,  2, "item"), ("Other item 2 amount", 122, 1, "num"),
    ("Other item 3 (hex)",     128,  2, "item"), ("Other item 3 amount", 130, 1, "num"),
]

# list2 — Stat Growth + Skill Max Levels (stride 132). Growth block from Patch offsets.
# +0 and +4..+8 are growth/rune-level bytes; +9.. is the skill-max array (0..7 each).
LIST2_GROWTH = [
    ("PWR growth rate",   4, 1, "num"), ("SKL growth rate",   5, 1, "num"),
    ("MAG growth rate",   6, 1, "num"), ("REP growth rate",   7, 1, "num"),
    ("MDF growth rate",   8, 1, "num"), ("SPD growth rate",   9, 1, "num"),
    ("LUK growth rate",  10, 1, "num"), ("HP growth rate",   11, 1, "num"),
    ("Head Rune Level",   0, 1, "num"),
    ("RH Rune Level",     1, 1, "num"),
    ("LH Rune Level",     2, 1, "num"),
]
# Skill-max array: 43 skills (0x01..0x2B) as consecutive bytes starting at +13.
# We surface them named from the skill list so each maps to a skill.
LIST2_SKILLMAX_START = 13

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
SKILL_MAX_OPTS  = [(0, "Can't get"), (1, "A+"), (2, "D"), (3, "C"), (4, "B"),
                   (5, "B+"), (6, "A"), (7, "S")]
