#!/usr/bin/env python3
"""Extract correct rune + food item descriptions from a USA ISO into s3_rune_food_desc.json,
and blank the drifted rune/food entries in s3_item_desc.json.

Runes and food have no name<->desc record, so the equipment-desc pool (s3_item_desc.json) either
left them blank or paired them with garbage (e.g. Rage -> "Sword of Rage"). Their real text lives
elsewhere in the ISO — the spell table (runes) and the food table (dishes) — which the ISO editor
already reads live. The save editor can't open an ISO, so it needs this pre-extracted static file.

Usage:  python3 Editor/build_item_desc_extra.py ["path/to/Suikoden III (USA).iso"]
"""
import json, os, re, struct, sys
import s3patch as S

HERE = os.path.dirname(os.path.abspath(__file__))


def find_iso(argv):
    if len(argv) > 1 and os.path.exists(argv[1]):
        return argv[1]
    for d in (os.path.join(HERE, "..", "ISO"), os.path.join(HERE, "ISO"), os.path.join(HERE, "..")):
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower().endswith(".iso"):
                    return os.path.join(d, f)
    sys.exit("No ISO found — pass the path as an argument.")


def build(iso):
    items = S.load_item_ids()
    cats = S.load_item_categories()
    # spell name -> description (runes: command runes share a spell name; magic runes via RUNE_SPELLS)
    spell = {}
    for i in range(S.SPELL_COUNT):
        rec = iso.rd(S.SPELL_TABLE_FILE + i * S.SPELL_STRIDE, S.SPELL_STRIDE)
        nptr = struct.unpack_from("<I", rec, 0x08)[0]
        dptr = struct.unpack_from("<I", rec, 0x0C)[0]
        try:
            nm = iso.rd(S.va2off(nptr), 48).split(b"\x00")[0].decode("latin1", "replace")
            d = iso.rd(S.va2off(dptr), 96).split(b"\x00")[0].decode("latin1", "replace")
        except Exception:
            continue
        if nm and nm not in spell:
            spell[nm] = d
    extra = {}
    for iid, nm in items.items():
        if cats.get(iid) != "Runes":
            continue
        if spell.get(nm):
            extra[iid] = spell[nm]; continue
        key = re.sub(r"rune$", "", re.sub(r"\s+", "", nm.lower()))
        st = S.RUNE_SPELLS.get(key)
        if st:
            d0 = spell.get(st[0], "")
            extra[iid] = "Grants " + ", ".join(st) + (f" — {st[0]}: {d0}" if d0 else "")
    # food: match food items to the recipe table by name (records 0..FOOD_COUNT-1 are real dishes)
    food = {}
    for fr in S.find_food_records(iso):
        nm, d = fr.get("name", ""), fr.get("desc", "")
        if d and not all(32 <= ord(c) < 127 for c in d):
            d = f"Heals {fr['heal']}HP" if fr.get("heal") else ""
        if nm and d:
            food[nm.lower()] = d
    for iid, nm in items.items():
        if cats.get(iid) == "Food Items" and nm.lower() in food:
            extra[iid] = food[nm.lower()]
    return extra, cats


def main():
    iso = S.Iso(find_iso(sys.argv))
    try:
        extra, cats = build(iso)
    finally:
        iso.close()
    # write the static extra-desc file (keyed by decimal item id string, like s3_item_desc.json)
    out = {str(k): v for k, v in sorted(extra.items())}
    with open(os.path.join(HERE, "s3_rune_food_desc.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote s3_rune_food_desc.json ({len(out)} rune/food descriptions)")
    # blank drifted rune/food entries in s3_item_desc.json (they're not equipment — correct-or-blank)
    path = os.path.join(HERE, "s3_item_desc.json")
    idesc = json.load(open(path, encoding="utf-8"))
    removed = 0
    for k in list(idesc.keys()):
        try:
            cat = cats.get(int(k), "")
        except ValueError:
            continue
        if cat in ("Runes", "Food Items") and idesc[k]:
            idesc[k] = ""; removed += 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(idesc, f, ensure_ascii=False, indent=1)
    print(f"blanked {removed} drifted rune/food entries in s3_item_desc.json")


if __name__ == "__main__":
    main()
