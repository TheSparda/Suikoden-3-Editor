#!/usr/bin/env python3
"""Emit Editor/s3_recruit_needs.json — what each recruit asks you to bring, and where to get it.

    python3 Editor/build_recruit_needs.py [path/to/pristine.iso]

The recruitment guide tells you a star wants the Rose Brooch; it does not tell you the Rose
Brooch is a 20%-chance rare find at Iksay Village's item shop. This walks every how-to line in
s3_recruit_order.json and resolves three kinds of prerequisite:

  items   any item name from Suikoden3_item_ids.txt that appears in the line, answered with
          every source the repo can actually prove:
            * shops  — read off the DISC, from the same three counter tables the ISO editor's
                       Shops tab edits (item/armour/rune x 14 locations x 4 story stages).
                       Gives the town, whether it is regular stock or a rare find, the rare
                       find's per-visit chance, and WHICH story stages carry it — the "when".
            * drops  — s3_item_sources.json, decoded from the disc's per-area drop tables:
                       enemy, level, chance out of 1000, and the areas its pack appears in.
            * chests — s3_item_sources.json (guide-sourced; the disc rolls chest contents at
                       runtime, so there is no on-disc list to read).
            * guide  — the Rare Armor guide's own line, attributed as such.
          An item with no source at all is emitted with an empty source list, so the editor can
          say "not in the editor's tables" instead of implying it knows.

  potch   "Pay him 100,000 potch" and friends — you cannot walk in short. An item you have to
          BUY counts here too: Dominic joins when you buy the Mole Armor from him, so what that
          errand actually needs is the money, not a Mole Armor. Its price comes off the disc.
          Gear records hold a price TIER, not potch: the field at gear+0x08 is 2..5 across the
          whole band, and the price routine at VA 0x1773390 reads `ladder[tier - 1]` from the
          15-step shared ladder at 0x3C963C (base materialised as ladder-4, so 1-based). Rune
          records at +0x0C hold real potch. Anything else the disc does not price here.

  first   other Stars the line makes you bring or recruit first (Ayame needs Watari along,
          Melville needs Billy recruited). Each carries that star's own guide position, which is
          the honest answer to "when". Only phrases that actually state a dependency count —
          "after recruiting X", "with X in your party", "bring X". A name merely mentioned is
          not one: Nei's line has you FIGHT Guillaume, Futch's has you chase Sharon (who then
          joins with him), and Jefferson's wants neither Juan nor Cecile with you, so a plain
          name match would invent three prerequisites that do not exist and reverse two more.

  gates   the non-character conditions a line states outright: "After recruiting at least 50
          Stars", "Must have completed Hugo Chapter 1".

Area names come from web/iso.js's ARCH_NAMES, parsed rather than copied so the two cannot drift.
Run after build_recruit_order.py.
"""
import json, os, re, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import re_elf

# the three counter tables, as proved in build_shop_index.py (accessor at VA 0x170DDF8)
STRIDE, VAR_STRIDE, N_STOCK = 0x7C, 0x1F0, 30
RARITY_OFF, RARITY_STRIDE, N_RARITY = 0x3C, 0x10, 4
N_LOC, N_VAR = 14, 4
COUNTERS = [(1, "Item Shop", 0x3EA550), (2, "Armor Shop", 0x3DDCD0), (3, "Rune Shop", 0x3EEB48)]

# Item names that are also ordinary English words in these sentences. "Water" is an item, but
# Kenji's line asks for "a glass of water"; matching it would invent an errand.
DENY = {"Water", "Grape"}      # Grape: the line says "a Grapes item", handled as Grapes below

# Guide spellings that don't match the item table. Kept explicit rather than fuzzy-matched.
SPELLING = {"Knight Status S": "Knight Statue S", "Grapes": "Grape"}

MIN_ITEM_LEN = 4               # below this, item names are too generic to match on

# Where a buy price lives, per item band. See the module docstring: gear stores a tier into the
# shared ladder, runes store potch outright, and nothing else on the disc prices an item here.
PRICE_LADDER = (0x3C963C, 15)
GEAR_PRICE = (0x3D8684, 0x44, 0x08, 161, 316)      # base, stride, field, first id, last id
RUNE_PRICE = (0x3EAF78, 0x20, 0x0C, 317, 462)

# "Buy the Mole Armor from him" — the errand is the money, not the item.
BUY_RE = re.compile(r"\bbuys?\b", re.I)
BUY_FROM_RE = re.compile(r"\bfrom (him|her|them)\b", re.I)


def item_names():
    txt = open(os.path.join(HERE, "Suikoden3_item_ids.txt"), encoding="utf-8").read()
    return {int(h, 16): n.strip() for h, n in re.findall(r"([0-9A-F]{1,3})\t([^\t\n]+)", txt)}


def arch_names():
    """archive code -> area name, parsed out of web/iso.js so there is one copy of the map."""
    js = open(os.path.join(os.path.dirname(HERE), "web", "iso.js"), encoding="utf-8").read()
    body = re.search(r"const ARCH_NAMES = \{(.*?)\};", js, re.S).group(1)
    out = dict(re.findall(r'(\w+):\s*"([^"]+)"', body))
    if len(out) < 20:
        sys.exit(f"ARCH_NAMES parse looks wrong ({len(out)} entries) — did web/iso.js move it?")
    return out


def shop_index(iso_arg):
    """(item id -> [{counter, town, kind, chance, stages, maxStage}], the ELF buffer)."""
    if iso_arg:
        sys.argv.append(iso_arg)
    buf = re_elf.load(); re_elf.verify(buf); base = re_elf.PT_LOAD_ISO
    u16 = lambda fo: struct.unpack_from("<H", buf, fo - base)[0]
    towns = {int(k): v["name"] for k, v in
             json.load(open(os.path.join(HERE, "s3_shops.json"), encoding="utf-8"))["locationNames"].items()}

    hits = {}
    for _kind, cname, cbase in COUNTERS:
        for loc in range(N_LOC):
            recs = [cbase + loc * VAR_STRIDE + var * STRIDE for var in range(N_VAR)]
            live = [i for i, r in enumerate(recs) if u16(r) or u16(r + RARITY_OFF)]
            if not live:
                continue
            max_stage = max(live) + 1
            for var in live:
                rec = recs[var]
                stock = []
                for i in range(N_STOCK):
                    v = u16(rec + i * 2)
                    if not v:
                        break                       # the list ends at the first empty slot
                    stock.append((v, "stock", None))
                for i in range(N_RARITY):
                    r = rec + RARITY_OFF + i * RARITY_STRIDE
                    it = u16(r)
                    if it:
                        stock.append((it, "rare", buf[r + 0x0A - base]))
                for it, kind, chance in stock:
                    key = (it, cname, loc, kind, chance)
                    e = hits.setdefault(key, {"counter": cname, "town": towns.get(loc, f"unnamed counter #{loc}"),
                                              "named": loc in towns, "kind": kind, "chance": chance,
                                              "stages": [], "maxStage": max_stage})
                    e["stages"].append(var + 1)
    out = {}
    for (it, *_rest), e in hits.items():
        out.setdefault(it, []).append(e)
    return out, buf


def price_index(buf):
    """item id -> buy price in potch, for the bands the disc actually prices."""
    base = re_elf.PT_LOAD_ISO
    u32 = lambda fo: struct.unpack_from("<I", buf, fo - base)[0]
    lad = [u32(PRICE_LADDER[0] + i * 4) for i in range(PRICE_LADDER[1])]
    out = {}
    gb, gs, gf, glo, ghi = GEAR_PRICE
    for i in range(glo, ghi + 1):
        tier = u32(gb + i * gs + gf)
        if 1 <= tier <= len(lad):
            out[i] = {"potch": lad[tier - 1], "tier": tier, "how": "gear price tier"}
    rb, rs, rf, rlo, rhi = RUNE_PRICE
    for i in range(rlo, rhi + 1):
        p = u32(rb + i * rs + rf)
        if 0 < p < 1000000:
            out[i] = {"potch": p, "tier": None, "how": "rune record"}
    return out


def drop_index(archives):
    """item id -> ([{enemy, lv, pct, areas}], guide lines, chest lines) from s3_item_sources.json."""
    src = json.load(open(os.path.join(HERE, "s3_item_sources.json"), encoding="utf-8"))
    chests = {}
    for c in src["chests"]:
        for e in c["items"]:
            chests.setdefault(e["item"], []).append({"place": c["place"], "guardian": e.get("guardian")})
    drops, guide = {}, {}
    for sid, e in src["items"].items():
        i = int(sid)
        for d in e.get("drops", []):
            areas = [archives.get(a, a) for a in d.get("archives", [])]
            drops.setdefault(i, []).append({"enemy": d["enemy"], "lv": d.get("lv"),
                                            "pct": round(d.get("weight", 0) / 10, 1),
                                            "areas": sorted(set(areas))})
        if e.get("guide"):
            guide[i] = [{"kind": g["kind"], "text": g["text"]} for g in e["guide"]]
    for i in drops:                                  # best chance first, then by level
        drops[i].sort(key=lambda d: (-d["pct"], d["lv"] or 0))
    return drops, guide, chests


def negated(how, at):
    """True if this mention is something the line tells you NOT to bring ("not Grape Seeds")."""
    return re.search(r"\b(not|neither|nor|without)\b[^.]{0,20}$", how[:at], re.I) is not None


def find_items(how, names):
    """Item ids named in a how-to line. Longest match wins; a match inside another is dropped."""
    spans, out = [], []
    for nm in sorted(set(names.values()), key=len, reverse=True):
        if len(nm) < MIN_ITEM_LEN or nm in DENY:
            continue
        for m in re.finditer(r"(?<![A-Za-z])" + re.escape(nm) + r"(?![A-Za-z])", how, re.I):
            if any(s <= m.start() and m.end() <= e for s, e in spans):
                continue                             # inside an already-matched, longer name
            spans.append((m.start(), m.end()))
            if negated(how, m.start()):
                continue                             # "give him a Grapes item (not Grape Seeds)"
            out.append(nm)
    # guide spellings the item table doesn't use ("a Grapes item", "Knight Status S")
    for guide_word, real in SPELLING.items():
        if re.search(r"(?<![A-Za-z])" + re.escape(guide_word) + r"(?![A-Za-z])", how) and real not in out:
            out.append(real)
    ids = {n: i for i, n in names.items()}
    return [(ids[n], n) for n in out if n in ids]


# Phrases that actually state a dependency on another Star, and what the dependency IS. Each
# regex leaves the names in a window we then scan, so "with Melville and Elliot in your party"
# yields both. Anything outside these windows is a mention, not a requirement.
FIRST_PATTERNS = [
    ("recruit", re.compile(r"[Aa]fter (?:you )?recruit(?:ing)? ([^.,;]{1,60})")),
    ("party",   re.compile(r"(?:with|bring) ([^.,;]{1,60}?) (?:in|to) (?:your|the) (?:active )?party")),
    ("party",   re.compile(r"\b[Bb]ring ([A-Z][^.,;]{1,40}?) to\b")),
]
# Non-character conditions a line states outright, kept as the guide's own words.
GATE_PATTERNS = [
    re.compile(r"After recruiting at least \d+ Stars?", re.I),
    re.compile(r"Must have completed [^.]+", re.I),
    re.compile(r"You must have all other stars recruited", re.I),
]


def find_first(how, who, star_names, stars):
    """Stars this line makes you bring along or recruit first, as [{name, n, how}]."""
    out, seen = [], set()
    for kind, pat in FIRST_PATTERNS:
        for m in pat.finditer(how):
            window = m.group(1)
            if re.search(r"\b(neither|nor|without|not)\b", window, re.I):
                continue                              # "with neither Juan nor Cecile"
            for other in star_names:
                if other == who or other in seen:
                    continue
                if re.search(r"(?<![A-Za-z])" + re.escape(other) + r"(?![A-Za-z])", window):
                    seen.add(other)
                    out.append({"name": other, "n": stars[other]["n"], "how": kind})
    return sorted(out, key=lambda x: x["n"])


def here_in(areas, how):
    """Does the how-to line name one of these areas? ARCH_NAMES packs two fields into one label
    ("Amur Plains / North Amur Plains", "Yaza Plain (Budehuc gate)"), so test each part."""
    for a in areas:
        for part in re.split(r"\s*/\s*", re.sub(r"\s*\([^)]*\)", "", a)):
            if part and part.lower() in how.lower():
                return True
    return False


def find_gates(how):
    return [m.group(0).rstrip(".") for pat in GATE_PATTERNS for m in [pat.search(how)] if m]


def main():
    iso_arg = sys.argv[1] if len(sys.argv) > 1 else None
    names = item_names()
    order = json.load(open(os.path.join(HERE, "s3_recruit_order.json"), encoding="utf-8"))
    shops, elf = shop_index(iso_arg)
    prices = price_index(elf)
    drops, guide, chests = drop_index(arch_names())

    stars = order["chars"]
    # a star is "named" in someone else's line by their roster name; longest first so
    # "Viki (Young)" wins over "Viki".
    star_names = sorted(stars, key=len, reverse=True)

    out, n_items, n_unknown = {}, 0, 0
    for who, g in stars.items():
        how = g["how"]
        needs = {"items": [], "potch": [], "first": [], "gates": []}

        for iid, nm in find_items(how, names):
            # If the line already names the place ("from a monster in Amur Plains"), lead with the
            # enemies that actually live there — the reader is standing in that area.
            mine = sorted(drops.get(iid, []), key=lambda d: (not here_in(d["areas"], how), -d["pct"], d["lv"] or 0))
            src = {"shops": shops.get(iid, []), "drops": mine[:3],
                   "moreDrops": max(0, len(mine) - 3),
                   "chests": chests.get(iid, []), "guide": guide.get(iid, [])}
            # Buy or bring? "Buy the Mole Armor from him" makes the errand the money — handing
            # yourself a Mole Armor recruits nobody. Judged on the sentence the item is named
            # in, so Barts (give him Grapes; you CAN buy them elsewhere) stays an item errand.
            at = how.lower().index(nm.lower()) if nm.lower() in how.lower() else 0
            sentence = next((t for t in re.split(r"(?<=[.])\s+", how)
                             if nm.lower() in t.lower()), how)
            buy = bool(BUY_RE.search(sentence) and not re.search(r"\bgive\b", sentence, re.I))
            price = prices.get(iid)
            known = any(src[k] for k in ("shops", "drops", "chests", "guide"))
            # If nothing is known, does the line itself already say where to get it? Scott's
            # antler comes "from the Vinay del Zexay trading post" — the editor has nothing to
            # add there, which reads differently from having no idea at all (Billy's statues).
            says = bool(re.search(r"\b(from|buy|bought|sold|sell|trading post|shop)\b", how, re.I))
            needs["items"].append(dict(src, id=iid, name=nm, known=known, lineSays=says,
                                       buy=buy,
                                       # who you buy it from: the recruit, when the line says so
                                       buyFrom=who if (buy and BUY_FROM_RE.search(sentence)) else "",
                                       price=price["potch"] if (buy and price) else None,
                                       priceHow=price["how"] if (buy and price) else ""))
            n_items += 1
            n_unknown += 0 if known else 1

        for amount in re.findall(r"([\d,]{3,})\s*potch", how):
            needs["potch"].append(int(amount.replace(",", "")))

        needs["first"] = find_first(how, who, star_names, stars)
        needs["gates"] = find_gates(how)

        if any(needs.values()):
            out[who] = {k: v for k, v in needs.items() if v}

    doc = {
        "format": "s3recruitneeds",
        "schema": 1,
        "note": ("What each Star's how-to asks you to bring. `shops` is read off the disc (town, "
                 "regular stock vs rare find, the rare find's per-visit chance, and which of the "
                 "counter's four story stages carry it); `drops` is the disc's per-area drop tables "
                 "(chance out of 1000, shown as a percentage); `chests` and `guide` are Suikosource "
                 "guide text and are attributed as such. An item with no source at all is emitted "
                 "with known:false rather than a guess."),
        "chars": out,
    }
    p = os.path.join(HERE, "s3_recruit_needs.json")
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {p}: {len(out)} stars with prerequisites · {n_items} item(s) named, "
          f"{n_unknown} with no source in the tables")
    for who, n in sorted(out.items(), key=lambda kv: stars[kv[0]]["n"]):
        bits = []
        for it in n.get("items", []):
            if it["buy"]:
                bits.append(f"{it['name']}(BUY {it['price']} potch)" if it["price"]
                            else f"{it['name']}(BUY, unpriced)")
                continue
            where = ("shop" if it["shops"] else "drop" if it["drops"] else
                     "chest" if it["chests"] else "guide" if it["guide"] else "UNKNOWN")
            bits.append(f"{it['name']}({where})")
        bits += [f"{a:,} potch" for a in n.get("potch", [])]
        bits += [("after " if f["how"] == "recruit" else "bring ") + f["name"] for f in n.get("first", [])]
        bits += [f'gate: "{g}"' for g in n.get("gates", [])]
        print(f"  {stars[who]['n']:>3} {who:<13} {', '.join(bits)}")


if __name__ == "__main__":
    main()
