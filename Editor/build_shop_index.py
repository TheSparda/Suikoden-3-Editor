#!/usr/bin/env python3
"""Emit Editor/s3_shops.json — the shop-counter map the ISO editor's Shops tab labels itself with.

Research/build tooling, run by hand; the editors read the JSON, not this script.

The shop tables were previously known only as four unlabelled flat arrays ("item3_a",
"item3_b", ...). They are actually record 0 of three parallel arrays, proved from the
accessor at VA 0x170DDF8:

    rec(kind, loc, stage) = BASE[kind] + loc*0x1F0 + stage*0x7C      (0x1F0 == 4 * 0x7C)

with `loc < 0x10` there and `< 0xE` in the stage-picker at 0x170DCD8, so 14 locations x 4
stages of a 0x7C record. The record's two halves are proved separately:

  * stock   — u16 item ids at +0x00, zero-terminated. The enumerator at 0x176C948 caps the
              scan at `slti $s2, 0x1e` (30), which is exactly the 60 bytes before the rarity
              block, so the stock array is 30 slots.
  * rarity  — 4 x 16 bytes at +0x3C, proved by the accessor at 0x170DFB0:
              `if (n >= 4) return 0; return rec + (n << 4) + 0x3C`.
              Field offsets come from re_elf.py's `fields` walk of that function's call
              sites: u16 @+0,+2,+4,+6,+8 and u8 @+0xA,+0xB,+0xC. +0x00 is the item id and
              +0x0C gates a `rand(100)` roll at 0x170E664 — the appearance chance.

The location NAMES are not in the ELF. They are recovered by matching each counter's rarity
items against the Suikosource Rare Armor guide's "Rarity at <Item|Armor> Shop in <town>"
lines and the GameFAQs walkthrough, and every name below is cross-checked by at least one
item that only that town stocks. Locations whose rarities are all generic consumables stay
unnamed rather than guessed.
"""
import json, os, re, struct, sys, collections

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import re_elf

STRIDE, VAR_STRIDE, N_STOCK = 0x7C, 0x1F0, 30
RARITY_OFF, RARITY_STRIDE, N_RARITY = 0x3C, 0x10, 4
N_LOC, N_VAR = 14, 4

COUNTERS = [
    {"kind": 1, "name": "Item Shop",  "base": 0x3EA550},
    {"kind": 2, "name": "Armor Shop", "base": 0x3DDCD0},
    {"kind": 3, "name": "Rune Shop",  "base": 0x3EEB48},
]

# idx -> (town, evidence). Evidence is the item that pins it; see the module docstring.
LOCATIONS = {
    0:  ("Vinay del Zexay", "Yellow Scarf is a rarity here at stage 3 and regular stock at stage 4 — the guide says it becomes a regular item at VdZ in chapter 5; Custom Armor and Custom Leather are VdZ armour rarities."),
    1:  ("Karaya Village", "Its item counter stocks the Sacrificial Jizo the walkthrough sends you to the Karaya Village item hut for, and its armour counter sells Karaya clan bandanas and feather bands. One stage only, matching the village burning in chapter 2."),
    2:  ("Duck Village", "Hazy Rune rarity (guide lists it at Duck Village / Alma Kinan) and the only rune counter stocking the Skunk Rune, which the walkthrough places at the Duck Village rune shop."),
    3:  ("Great Hollow", "DragonTail Ornament rarity (guide: 'found at Great Hollow') and the Crown of Destiny armour rarity."),
    4:  ("Chisha Village", "LionGod Ring and Prosperity Ring item rarities plus the Prosperity Hat armour rarity — the guide names all three at Chisha."),
    5:  ("Alma Kinan", "The Killer Rune is a rarity at stage 1 and regular stock at stage 2, exactly as the guide describes Alma Kinan; Hazy Rune rarity as well."),
    6:  ("Iksay Village", "Rose Brooch rarity — the guide lists it only at the Iksay Village item shop."),
    7:  ("Le Buque", "Custom Tunic armour rarity (guide: Armor Shop in Le Buque, chapter 5)."),
    8:  ("Caleria", "WhiteRose Brooch item rarity and Guardian Chain Mail armour rarity, both guide-listed at Caleria."),
    9:  ("Brass Castle", "Custom Casque and Gold Emblem armour rarities, guide-listed at Brass Castle."),
}


def main():
    buf = re_elf.load(); re_elf.verify(buf); base_iso = re_elf.PT_LOAD_ISO
    u16 = lambda fo: struct.unpack_from("<H", buf, fo - base_iso)[0]

    counters = []
    for c in COUNTERS:
        used = []
        for loc in range(N_LOC):
            stages = 0
            for var in range(N_VAR):
                fo = c["base"] + loc * VAR_STRIDE + var * STRIDE
                if u16(fo) or u16(fo + RARITY_OFF):
                    stages = var + 1
            if stages:
                used.append({"loc": loc, "stages": stages})
        counters.append({**c, "va": c["base"] + re_elf.DELTA, "stocked": used})

    out = {
        "format": "Suikoden III shop counters (SLUS-20387)",
        "schema": 1,
        "note": ("Three parallel shop tables (item / armour / rune), each 14 locations x 4 story "
                 "stages of a 0x7C record: 30 zero-terminated u16 stock slots at +0x00 and four "
                 "16-byte rarity ('rare find') entries at +0x3C. Layout is decoded from the disc's "
                 "own accessors (0x170DDF8, 0x170DFB0, 0x176C948); the town names are attributed "
                 "to the Suikosource Rare Armor guide and the GameFAQs walkthrough, matched on "
                 "rarity items unique to each town."),
        "geometry": {
            "stride": STRIDE, "variantStride": VAR_STRIDE, "stockSlots": N_STOCK,
            "rarityOff": RARITY_OFF, "rarityStride": RARITY_STRIDE, "rarityCount": N_RARITY,
            "locations": N_LOC, "stages": N_VAR,
            # +0x02..+0x08 feed a separate price computation and stay unnamed
            "rarityFields": {"item": [0x00, 2], "u2": [0x02, 2], "u4": [0x04, 2],
                             "u6": [0x06, 2], "u8": [0x08, 2], "chance": [0x0A, 1],
                             "quantity": [0x0B, 1], "spread": [0x0C, 1]},
        },
        "counters": counters,
        "locationNames": {str(k): {"name": v[0], "evidence": v[1]} for k, v in LOCATIONS.items()},
    }
    p = os.path.join(HERE, "s3_shops.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    named = sum(1 for c in counters for s in c["stocked"] if s["loc"] in LOCATIONS)
    total = sum(len(c["stocked"]) for c in counters)
    print(f"wrote {p}: {total} stocked counters ({named} at named locations)")


if __name__ == "__main__":
    main()
