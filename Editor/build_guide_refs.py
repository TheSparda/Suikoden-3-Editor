#!/usr/bin/env python3
"""Regenerate the guide reference overlays used by the ISO editor's Growth/Characters views.

Derives four JSON files (ISO not required) from the bundled Suikosource guides:
  s3_rune_slots.json  <- suikosource/initial.txt   (per-char Head/Right/Left rune slot state:
                          equipped rune name, or "opens at Lv N", or empty; + Lv/WLv)
  s3_skill_ref.json   <- suikosource/skills.txt     (per-skill type/description + per-rank
                          effect tables, keyed by skill id)
  s3_skill_caps.json  <- suikosource/skills.txt     (per-character max skill grades)
  s3_growth_ref.json  <- suikosource/statgrowth.txt (per-character growth rate + start/end ranges)

The mappings these feed were verified against the real USA ISO (SLUS-20387); see
Suikoden3_ISO_offsets.md and github issue #2. Run:  python3 Editor/build_guide_refs.py
"""
import json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
SUI = os.path.join(HERE, "suikosource")
RANKS = ["E", "D", "C", "B", "B+", "A", "A+", "S"]


def load(name):
    return [l.rstrip("\n") for l in open(os.path.join(SUI, name), encoding="utf-8")]


def skill_ids():
    sid = {}
    for l in open(os.path.join(HERE, "Suikoden3_skill_ids.txt")):
        l = l.strip()
        if l:
            h, n = l.split(" ", 1); sid[int(h, 16)] = n
    return sid


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def build_rune_slots():
    names = json.load(open(os.path.join(HERE, "s3_names.json")))["list1"]
    roster = set(names.values())
    lines = load("initial.txt")
    cells = lambda l: l.split("\t")

    def slotval(s):
        s = (s or "").strip()
        if not s:
            return {"state": "none"}
        m = re.match(r"^<(\d+)>", s)
        if m:
            return {"state": "opens", "lv": int(m.group(1))}
        name = re.sub(r"\s*/?\s*\(\*\d+\).*$", "", s).strip()
        if not name or name.startswith("<"):
            return {"state": "none"}
        return {"state": "rune", "rune": name}

    out = {}
    i = 0
    while i < len(lines):
        c = cells(lines[i]); nm = c[1].strip() if len(c) > 1 else ""
        if nm in roster and nm not in out:
            if len(c) >= 7:                               # normal single row
                lv, wlv, head, rh, lh = c[2], c[3], c[4], c[5], c[6]
            else:                                         # wrapped across two lines
                nx = cells(lines[i + 1]) if i + 1 < len(lines) else [""] * 8
                nx += [""] * (8 - len(nx))
                if len(nx) > 1 and re.match(r"^[+-]?\d+$", nx[1].strip()):   # Lv on continuation
                    lv, wlv, head, rh, lh = nx[1], nx[2], nx[3], nx[4], nx[5]
                else:                                                        # equip on continuation
                    lv = c[2] if len(c) > 2 else ""; wlv = c[3] if len(c) > 3 else ""
                    head, rh, lh = nx[1], nx[2], nx[3]
            out[nm] = {"lv": lv.strip(), "wlv": wlv.strip(),
                       "head": slotval(head), "right": slotval(rh), "left": slotval(lh)}
        i += 1
    return out


def build_skill_ref():
    sid = skill_ids(); name2id = {norm(n): i for i, n in sid.items()}
    lines = load("skills.txt"); ref = {}; i = 0
    while i < len(lines):
        # Two header formats in the guide: "Name<TAB>Mundane/Unique Skill" (combat/magic), and a
        # bare "Name" line (the utility/teacher skills: Cook, Appraisal, …). Both are followed by
        # a description line and (optionally) an E..S per-rank effect table.
        m = re.match(r"^(.+?)\t(Mundane|Unique) Skill\s*$", lines[i])
        gname = typ = None
        if m:
            gname, typ = m.group(1).strip(), m.group(2)
        elif "\t" not in lines[i] and norm(lines[i]) in name2id and name2id[norm(lines[i])] not in {int(k) for k in ref} \
                and i + 1 < len(lines) and lines[i + 1].strip() and "\t" not in lines[i + 1] \
                and not re.match(r"^(Initial|Max|Rank)\b", lines[i + 1]):
            gname, typ = lines[i].strip(), "Utility"
        if gname:
            skid = name2id.get(norm(gname))
            desc = lines[i + 1].strip() if i + 1 < len(lines) else ""
            effects = []; j = i + 2
            if j < len(lines) and re.search(r"\bE\t.*\bS\b", lines[j]):
                j += 1
                while j < len(lines) and lines[j].strip() and "\t" in lines[j] \
                        and not re.match(r"^.+?\t(Mundane|Unique) Skill", lines[j]):
                    parts = lines[j].split("\t"); label = parts[0].strip()
                    vals = [p.strip() for p in parts[1:]]
                    if label and len(vals) >= 8:
                        effects.append({"label": label, "ranks": dict(zip(RANKS, vals[:8]))}); j += 1
                    else:
                        break
            if skid and str(skid) not in ref:
                ref[str(skid)] = {"name": sid[skid], "type": typ, "desc": desc, "effects": effects}
            i = j if j > i else i + 1; continue
        i += 1
    return ref


def build_skill_caps():
    roster = set(json.load(open(os.path.join(HERE, "s3_names.json")))["list2"].values())
    abbr = {"Swing": 1, "Accur.": 2, "Damage": 3, "S-Shoot": 4, "Sharpshoot": 4, "Counter": 5,
            "Heavy-D": 6, "Cont Atk": 7, "Freeze": 8, "Thief": 9, "Repel": 0x0A, "Parry": 0x0B,
            "Shield": 0x0C, "Armor": 0x0D, "Fire": 0x0E, "Water": 0x0F, "Wind": 0x10, "Earth": 0x11,
            "Ltning": 0x12, "S-Shield": 0x13, "Blink": 0x14, "M-Repel": 0x15, "Resist": 0x16,
            "Focus": 0x17, "C-Vol": 0x18, "C-Pur": 0x19, "H-Dash": 0x1A, "Adr-Pwr": 0x27,
            "P-Gate": 0x28, "M-Sword": 0x29, "Precision": 0x2A, "M-Ration": 0x2B}
    lines = load("skills.txt"); caps = {}; cur = None; i = 0
    while i < len(lines):
        l = lines[i]
        if l in roster:
            cur = l
        if l.startswith("Max") and cur and i >= 2:
            hdr = [c.strip() for c in lines[i - 2].split("\t")]; mx = [c.strip() for c in l.split("\t")]
            for col, h in enumerate(hdr):
                if h in abbr and col < len(mx) and mx[col] in RANKS:
                    caps.setdefault(cur, {})[str(abbr[h])] = mx[col]
        i += 1
    return caps


def build_growth_ref():
    roster = set(json.load(open(os.path.join(HERE, "s3_names.json")))["list2"].values())
    lines = load("statgrowth.txt")
    cols = ["PWR", "SKL", "MAG", "REP", "PDF", "MDF", "SPD", "LUK", "HP"]
    growth = {}
    for i, l in enumerate(lines):
        c = l.split("\t")[0].strip()
        if c in roster and i + 1 < len(lines) and lines[i + 1].startswith("Growth Rate"):
            def row(prefix):
                for k in range(i + 1, min(i + 8, len(lines))):
                    if lines[k].startswith(prefix):
                        return [v.strip() for v in lines[k].split("\t")[1:]]
                return []
            rate, start, end = row("Growth Rate"), row("Starting"), row("Ending")
            rec = {}
            for k, st in enumerate(cols):
                if st == "PDF":
                    continue
                rec[st] = {"rate": rate[k] if k < len(rate) else "",
                           "start": start[k] if k < len(start) else "",
                           "end": end[k] if k < len(end) else ""}
            growth[c] = rec
    return growth


def main():
    outputs = {
        "s3_rune_slots.json": build_rune_slots(),
        "s3_skill_ref.json": build_skill_ref(),
        "s3_skill_caps.json": build_skill_caps(),
        "s3_growth_ref.json": build_growth_ref(),
    }
    for fname, data in outputs.items():
        with open(os.path.join(HERE, fname), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        print(f"wrote {fname}  ({len(data)} entries)")


if __name__ == "__main__":
    main()
