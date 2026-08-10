#!/usr/bin/env python3
"""
Suikoden III ISO editor — cross-platform local web app.

Stdlib only (http.server + json). Reuses all logic from s3patch.py.
Run:  python3 s3editor.py "ISO/Suikoden III (USA).iso"
Then open the printed http://127.0.0.1:PORT URL in any browser.

Writes go straight to the ISO you pass. Use a clone for testing
(Editor/make_test_iso.sh) — the app makes ONE backup on first write per session.
"""
import json, os, struct, sys, webbrowser, html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s3patch as S
import s3fields as F
import s3save as SV   # PS2 memory-card save reader (read-only; ISO not required)

ISO_PATH = None
_backed_up = False
_backup_enabled = True   # UI-controlled: make one .bak copy before the first edit
_scan_root = os.getcwd()

# --- persistent settings (last ISO path, backup pref) -----------------------
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".s3editor.json")

def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_config(**kw):
    cfg = load_config()
    cfg.update(kw)
    try:
        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass  # settings are best-effort; never block editing on a write failure

# --- edit staging -----------------------------------------------------------
# Writes do NOT touch the ISO. They accumulate here as {file_offset: byte}. Reads
# overlay this buffer so the UI reflects staged (unsaved) values. /api/save flushes
# to disk (honoring the backup toggle) and clears the buffer.
PENDING = {}          # offset -> int (0..255)
_READ_DISK = False    # when True, reads bypass PENDING (used to compute "defaults")

class StagingIso:
    """Wraps S.Iso for reads; captures writes into PENDING instead of the file."""
    def __init__(self):
        self._iso = S.Iso(ISO_PATH)   # read-only handle to the real file
    def rd(self, off, n):
        b = bytearray(self._iso.rd(off, n))
        if not _READ_DISK:
            for i in range(n):
                v = PENDING.get(off + i)
                if v is not None:
                    b[i] = v
        return bytes(b)
    def u8(self, off):  return self.rd(off, 1)[0]
    def u16(self, off): return struct.unpack("<H", self.rd(off, 2))[0]
    def u32(self, off): return struct.unpack("<I", self.rd(off, 4))[0]
    def wr(self, off, data):
        # Self-cleaning: only keep bytes that actually differ from disk, so PENDING
        # is exactly the set of "changed from default" bytes. A write that restores
        # a byte to its on-disk value drops it from the staging buffer.
        disk = self._iso.rd(off, len(data))
        for i, byte in enumerate(data):
            if byte == disk[i]:
                PENDING.pop(off + i, None)
            else:
                PENDING[off + i] = byte
    def disk_rd(self, off, n):
        """Raw on-disk bytes, ignoring staged edits (the 'default')."""
        return self._iso.rd(off, n)
    def close(self):
        self._iso.close()

def restore_range(off, width):
    """Drop staged edits in [off, off+width) -> those bytes revert to disk default."""
    n = 0
    for o in range(off, off + width):
        if PENDING.pop(o, None) is not None:
            n += 1
    return n

def stage_count():
    # number of distinct records touched is hard; report byte count as a proxy
    return len(PENDING)

def flush_pending():
    """Write all staged edits to the ISO at once. Returns bytes written."""
    if not PENDING:
        return 0
    ensure_backup()
    iso = S.Iso(ISO_PATH, write=True)
    try:
        # group contiguous offsets into runs for fewer writes
        for off in sorted(PENDING):
            iso.wr(off, bytes([PENDING[off]]))
    finally:
        iso.close()
    n = len(PENDING)
    PENDING.clear()
    return n

def _load_names():
    p = os.path.join(os.path.dirname(__file__), "s3_names.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}
CHAR_NAMES = _load_names()   # {"list1": {"1":"Hugo",...}, ...} from the original exe

def _load_skill_desc():
    p = os.path.join(os.path.dirname(__file__), "s3_skill_desc.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}
SKILL_DESC = _load_skill_desc()   # {skill name: description} from Suikosource skills guide

def _load_item_desc():
    p = os.path.join(os.path.dirname(__file__), "s3_item_desc.json")
    try:
        return {int(k): v for k, v in json.load(open(p, encoding="utf-8")).items()}
    except Exception:
        return {}
ITEM_DESC = _load_item_desc()   # {item id: description} from the ISO's equipment record table

def _load_weapon_chars():
    p = os.path.join(os.path.dirname(__file__), "s3_weapon_chars.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {"byIndex": {}, "families": {}}
# {weaponIndex: {family, fighters:[...]}} — mapped by matching each list4 ATK curve
# to Suikosource's weapon-growth guide (exact ATK-value match; 28/28 confirmed).
WEAPON_CHARS = _load_weapon_chars()

def _load_rune_owner():
    p = os.path.join(os.path.dirname(__file__), "s3_rune_owner.json")
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}
RUNE_OWNER = _load_rune_owner()   # {rune-attack spell name: owning character / weapon type}

def _load_unite_chars():
    p = os.path.join(os.path.dirname(__file__), "s3_unite_chars.json")
    try:
        return {int(k): v.get("chars", "") for k, v in json.load(open(p, encoding="utf-8")).items()}
    except Exception:
        return {}
UNITE_CHARS = _load_unite_chars()   # {unite index: "char, char, char"} from Suikosource unite guide


# ------------------------------------------------------------------ data model
def _iso(write=False):
    if not ISO_PATH:
        raise RuntimeError("no ISO loaded")
    # All reads and writes go through the staging layer: reads overlay PENDING,
    # writes accumulate in PENDING (nothing hits disk until /api/save).
    return StagingIso()

def scan_isos(root):
    """Find candidate .iso files the server can see, near the launch dir."""
    found = []
    roots = {os.path.abspath(root), os.path.abspath(os.path.join(root, "..")),
             os.path.abspath(os.path.join(root, "ISO")),
             os.path.abspath(os.path.dirname(__file__)),
             os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "ISO"))}
    seen = set()
    for r in roots:
        if not os.path.isdir(r):
            continue
        try:
            for dp, _, files in os.walk(r):
                # keep the scan shallow so it stays fast
                if dp.count(os.sep) - r.count(os.sep) > 2:
                    continue
                for fn in files:
                    if fn.lower().endswith(".iso"):
                        full = os.path.join(dp, fn)
                        if full in seen:
                            continue
                        seen.add(full)
                        try:
                            sz = os.path.getsize(full)
                        except OSError:
                            continue
                        found.append({"path": full, "name": fn,
                                      "size": sz, "gb": round(sz/1e9, 2)})
        except (OSError, PermissionError):
            continue
    found.sort(key=lambda x: x["name"].lower())
    return found

def open_iso(path):
    """Validate + load an ISO. Returns (ok, message)."""
    global ISO_PATH, _backed_up
    if not path or not os.path.isfile(path):
        return False, f"file not found: {path}"
    try:
        iso = S.Iso(path)
        ok, raw, be = S.check_version(iso); iso.close()
    except Exception as e:
        return False, f"could not read: {e}"
    if not ok:
        return False, (f"version check failed (BE=0x{be:08X}); this is not the "
                       f"USA SLUS-20387 release.")
    ISO_PATH = path
    _backed_up = False   # new ISO -> allow one fresh backup
    save_config(lastIso=os.path.abspath(path))
    return True, os.path.basename(path)

def ensure_backup():
    global _backed_up
    if not _backup_enabled:
        return
    if not _backed_up:
        S.backup(ISO_PATH)
        _backed_up = True

def read_spells():
    iso = _iso(); out = []
    for i in range(S.SPELL_COUNT):
        off = S.SPELL_TABLE_FILE + i * S.SPELL_STRIDE
        rec = iso.rd(off, S.SPELL_STRIDE)
        kind = struct.unpack_from("<H", rec, 0x04)[0]
        f14 = struct.unpack_from("<I", rec, 0x14)[0]
        f18 = struct.unpack_from("<I", rec, 0x18)[0]
        out.append({
            "index": i, "name": S._spell_name(iso, rec),
            "desc": _desc(iso, rec),
            "element": S.decode_element(kind),
            "elementId": kind & 0xFF,
            "cast": struct.unpack_from("<I", rec, 0x10)[0],
            "power": struct.unpack_from("<I", rec, 0x1C)[0],
            "aoe": bool(f14 & S.AREA_BIT),
            "target": S.decode_target(f14),
            "targetByte": (f14 >> 8) & 0xFF,
            "kind": S.KIND_LOW.get(f14 & 0xFF, "0x%02X" % (f14 & 0xFF)),
            "status": S.decode_f18(f18),
        })
    iso.close(); return out

def _u(value, width):
    """Clamp an incoming numeric field to an unsigned int of `width` bytes so a
    too-large or negative input can never crash struct.pack (returns 0..cap)."""
    cap = (1 << (8 * width)) - 1
    return max(0, min(cap, int(value)))

def _desc(iso, rec):
    try:
        v = struct.unpack_from("<I", rec, 0x0C)[0]
        return iso.rd(S.va2off(v), 64).split(b"\x00")[0].decode("latin1", "replace")
    except Exception:
        return ""

def read_unites():
    iso = _iso(); out = []
    for i in range(S.UNITE_COUNT):
        off = S.UNITE_TABLE_FILE + i * S.UNITE_STRIDE
        rec = iso.rd(off, S.UNITE_STRIDE)
        f14 = struct.unpack_from("<I", rec, 0x14)[0]
        out.append({
            "index": i, "name": S._spell_name(iso, rec), "desc": _desc(iso, rec),
            "chars": UNITE_CHARS.get(i, ""),
            "cast": struct.unpack_from("<I", rec, 0x10)[0],
            "power": struct.unpack_from("<I", rec, 0x1C)[0],
            "aoe": bool(f14 & S.AREA_BIT),
            "target": S.decode_target(f14),
            "targetByte": (f14 >> 8) & 0xFF,
        })
    iso.close(); return out

def write_unite(index, fields):
    iso = _iso(write=True)
    off = S.UNITE_TABLE_FILE + index * S.UNITE_STRIDE
    if "power" in fields: iso.wr(off + 0x1C, struct.pack("<I", _u(fields["power"], 4)))
    if "cast" in fields:  iso.wr(off + 0x10, struct.pack("<I", _u(fields["cast"], 4)))
    if "target" in fields:
        f14 = iso.u32(off + 0x14)
        f14 = (f14 & 0xFFFF00FF) | ((int(fields["target"]) & 0xFF) << 8)
        iso.wr(off + 0x14, struct.pack("<I", f14))
    if "aoe" in fields:
        f14 = iso.u32(off + 0x14)
        f14 = (f14 | S.AREA_BIT) if fields["aoe"] else (f14 & ~S.AREA_BIT)
        iso.wr(off + 0x14, struct.pack("<I", f14))
    iso.close(); return {"ok": True}

_gear_cache = None
def _gear_offsets(iso):
    global _gear_cache
    if _gear_cache is None:
        _gear_cache = S.find_gear_records(iso)
    return _gear_cache

def read_gear():
    iso = _iso(); items = S.load_item_ids(); skills = S.load_skill_ids()
    offs = _gear_offsets(iso); out = []
    for iid, off in sorted(offs.items()):
        rec = iso.rd(off, S.GEAR_STRIDE)
        effects = []
        for i, eo in enumerate(S.GEAR_EFFECT_OFFS):
            t = struct.unpack_from("<H", rec, eo)[0]
            v = struct.unpack_from("<H", rec, eo + 2)[0]
            param = struct.unpack_from("<H", rec, eo + 4)[0]   # 3rd u16: stat/skill/flag
            role = S.GEAR_TYPE_PARAM.get(t)                     # "stat" | "skill" | None
            effects.append({
                "slot": i, "off": eo, "type": t,
                "typeName": S.GEAR_EFFECT_TYPES.get(t, f"type {t}"),
                "value": v,
                "param": param,                                # raw 3rd field
                "paramRole": role or "",
                # skill kept for backwards compat with the write path (== param when type 5)
                "skill": param,
                "skillName": skills.get(param, "") if t == 5 else "",
                "statName": S.GEAR_STAT_SELECTOR.get(param, "") if t == 2 else "",
            })
        out.append({
            "id": iid, "name": items.get(iid, f"0x{iid:X}"),
            "desc": _desc_at(iso, struct.unpack_from("<I", rec, 0)[0]),
            "addr": off,
            "def": struct.unpack_from("<H", rec, S.GEAR_DEF_OFF)[0],
            "price": struct.unpack_from("<I", rec, S.GEAR_PRICE_OFF)[0],
            "effects": effects,
        })
    iso.close(); return out

def _desc_at(iso, va):
    try:
        return iso.rd(S.va2off(va), 64).split(b"\x00")[0].decode("latin1", "replace")
    except Exception:
        return ""

def write_gear(item_id, fields):
    iso = _iso(write=True)
    offs = _gear_offsets(iso)
    if item_id not in offs:
        iso.close(); return {"error": "no gear record for that item id"}
    off = offs[item_id]
    if "def" in fields:
        iso.wr(off + S.GEAR_DEF_OFF, struct.pack("<H", int(fields["def"]) & 0xFFFF))
    if "price" in fields:
        iso.wr(off + S.GEAR_PRICE_OFF, struct.pack("<I", int(fields["price"]) & 0xFFFFFFFF))
    # effects: list of {off, type, value, param}. `param` is the 3rd u16 (stat index
    # for a Stat bonus, skill id for Grant skill, else a flag). Accept legacy `skill`.
    for e in fields.get("effects", []):
        eo = int(e["off"])
        if eo not in S.GEAR_EFFECT_OFFS:
            iso.close(); return {"error": f"bad effect offset {eo}"}
        param = e.get("param", e.get("skill", 0))
        iso.wr(off + eo,     struct.pack("<H", int(e.get("type", 0)) & 0xFFFF))
        iso.wr(off + eo + 2, struct.pack("<H", int(e.get("value", 0)) & 0xFFFF))
        iso.wr(off + eo + 4, struct.pack("<H", int(param) & 0xFFFF))
    iso.close(); return {"ok": True}

# --- Weapons (list4 = weapon ATK sharpen table) --------------------------------
# Each record (stride 28): bytes 0..15 = ATK at sharpen levels 1..16 (u8 each);
# bytes 16..27 = a 12-byte tail (sharpen cost/material data, meaning unconfirmed).
# We edit only the 16 ATK levels; the tail is preserved untouched on save.
WEAPON_LEVELS = 16

def read_weapons():
    iso = _iso()
    base, stride, _ = S.TABLES["list4"]
    names = CHAR_NAMES.get("list4", {})
    n = max((int(k) for k in names), default=27) + 1
    by = WEAPON_CHARS.get("byIndex", {})
    out = []
    for i in range(n):
        rec = iso.rd(base + i*stride, stride)
        drec = iso.disk_rd(base + i*stride, stride)
        info = by.get(str(i), {})
        out.append({
            "index": i, "name": names.get(str(i), f"Weapon {i}"),
            "family": info.get("family", ""),
            "fighters": info.get("fighters", []),   # verified vs Suikosource weapon guide
            "atk": list(rec[:WEAPON_LEVELS]),
            "atkDefault": list(drec[:WEAPON_LEVELS]),
        })
    iso.close()
    return out

def write_weapon(index, levels):
    """levels: {levelIndex(0..15): atkValue}. Clamped to u8; tail untouched."""
    iso = _iso(write=True)
    base, stride, _ = S.TABLES["list4"]
    off = base + index*stride
    for k, v in levels.items():
        li = int(k)
        if not (0 <= li < WEAPON_LEVELS):
            iso.close(); return {"error": f"level index {li} out of range"}
        iso.wr(off + li, bytes([max(0, min(255, int(v)))]))
    iso.close(); return {"ok": True}

def read_shop():
    iso = _iso(); items = S.load_item_ids(); out = {}
    for name, (off, cnt, w, note) in S.SHOP.items():
        rows = []
        for i in range(cnt):
            v = iso.u32(off + i*w) if w == 4 else iso.u16(off + i*w)
            rows.append({"slot": i, "value": v,
                         "name": "" if w == 4 else items.get(v, "")})
        out[name] = {"note": note, "width": w, "rows": rows}
    iso.close(); return out

def read_char(list_no, index):
    iso = _iso()
    base, stride, desc = S.TABLES[f"list{list_no}"]
    rec = iso.rd(base + index*stride, stride)
    iso.close()
    return {"list": list_no, "index": index, "stride": stride, "desc": desc,
            "bytes": list(rec), "addr": base + index*stride}

def _read_val(iso, pos, width):
    return iso.u16(pos) if width == 2 else iso.u8(pos)

def read_charfields(list_no, index):
    """Return labeled fields with current values for a list1/2/3 record."""
    iso = _iso()
    base, stride, desc = S.TABLES[f"list{list_no}"]
    rec_off = base + index*stride
    items = S.load_item_ids()
    skills = S.load_skill_ids()
    groups = []

    def field(label, off, width, kind):
        pos = rec_off + off
        v = _read_val(iso, pos, width)
        name = ""
        if kind == "item":  name = items.get(v, "")
        elif kind == "skill": name = skills.get(v, "")
        return {"label": label, "off": off, "width": width, "kind": kind,
                "value": v, "name": name}

    if list_no == 1:
        groups.append({"title": "Starting Stats / Equipment",
                       "help": F.SKILL_RANK_HELP,
                       "fields": [field(*f) for f in F.LIST1]})
    elif list_no == 2:
        groups.append({"title": "Growth Rates / Rune Levels", "help": "higher = faster growth",
                       "fields": [field(*f) for f in F.LIST2_GROWTH]})
        smax = []
        for k in range(43):
            sid = k + 1
            smax.append(field(skills.get(sid, f"Skill 0x{sid:02X}") + " max",
                              F.LIST2_SKILLMAX_START + k, 1, "num"))
        groups.append({"title": "Skill Maximum Levels", "help": F.SKILL_MAX_HELP, "fields": smax})
        groups.append({"title": "Fixed Skills / Free Skills / Starting Level",
                       "help": F.SKILL_RANK_HELP,
                       "fields": [field(*f) for f in F.LIST2_FIXED]})
    elif list_no == 3:
        groups.append({"title": "Support Character Skills", "help": F.SKILL_RANK_HELP,
                       "fields": [field(*f) for f in F.LIST3]})
    else:
        rec = iso.rd(rec_off, stride)
        groups.append({"title": "Raw Bytes", "help": "",
                       "fields": [{"label": f"+{o}", "off": o, "width": 1, "kind": "num",
                                   "value": b, "name": ""} for o, b in enumerate(rec)]})
    iso.close()
    return {"list": list_no, "index": index, "addr": rec_off, "stride": stride,
            "desc": desc, "groups": groups}

def write_spell(index, fields):
    iso = _iso(write=True)
    off = S.SPELL_TABLE_FILE + index * S.SPELL_STRIDE
    if "power" in fields: iso.wr(off + 0x1C, struct.pack("<I", _u(fields["power"], 4)))
    if "cast" in fields:  iso.wr(off + 0x10, struct.pack("<I", _u(fields["cast"], 4)))
    if "elementId" in fields:
        kind = iso.u16(off + 0x04)
        iso.wr(off + 0x04, struct.pack("<H", (kind & 0xFF00) | (int(fields["elementId"]) & 0xFF)))
    if "aoe" in fields:
        f14 = iso.u32(off + 0x14)
        f14 = (f14 | S.AREA_BIT) if fields["aoe"] else (f14 & ~S.AREA_BIT)
        iso.wr(off + 0x14, struct.pack("<I", f14))
    if "target" in fields:
        # target byte = bits 8..15 of flags14 (shape/size selector); keep low byte.
        f14 = iso.u32(off + 0x14)
        tb = int(fields["target"]) & 0xFF
        f14 = (f14 & 0xFFFF00FF) | (tb << 8)
        iso.wr(off + 0x14, struct.pack("<I", f14))
    if "status" in fields:
        rev = {v: (1 << b) for b, v in S.F18_BITS.items()}
        val = 0 if fields["status"] in ("", "none", None) else rev.get(fields["status"])
        if val is None:
            iso.close(); return {"error": f"unknown status {fields['status']!r}"}
        iso.wr(off + 0x18, struct.pack("<I", val))
    iso.close()
    return {"ok": True}

def write_char_byte(list_no, index, boff, value, width):
    iso = _iso(write=True)
    base, stride, _ = S.TABLES[f"list{list_no}"]
    if boff + width > stride:
        iso.close(); return {"error": "offset past record"}
    # clamp to the field width so an over-large input can't crash struct.pack
    cap = 0xFFFF if width == 2 else 0xFF
    v = max(0, min(cap, int(value)))
    clamped = (v != int(value))
    pos = base + index*stride + boff
    iso.wr(pos, struct.pack("<H" if width == 2 else "<B", v))
    iso.close(); return {"ok": True, "value": v, "clamped": clamped}

def write_shop(table, slot, value):
    iso = _iso(write=True)
    off, cnt, w, _ = S.SHOP[table]
    if not (0 <= slot < cnt):
        iso.close(); return {"error": "slot out of range"}
    iso.wr(off + slot*w, struct.pack("<I" if w == 4 else "<H", _u(value, w)))
    iso.close(); return {"ok": True}


# ------------------------------------------------------------- Hard Mode / bulk
# The 8 player growth-rate bytes live in list2 at +4..+11 (PWR SKL MAG REP MDF SPD
# LUK HP). Growth rate drives how much each stat rises per level (typical 2..6), so
# scaling it down weakens the whole party across all 99 levels — a clean, reversible
# difficulty lever. All bulk edits scale the ISO's *disk* value (not the staged one)
# so re-applying a preset is idempotent instead of compounding.
GROWTH_OFFS = {"PWR": 4, "SKL": 5, "MAG": 6, "REP": 7, "MDF": 8, "SPD": 9, "LUK": 10, "HP": 11}
# list2 holds the growth records; roster is the named characters (79 from the exe).
CHAR_COUNT_L2 = max((int(k) for k in CHAR_NAMES.get("list2", {})), default=78) + 1

def _disk_u8(iso, off):
    return iso.disk_rd(off, 1)[0]

def scale_player_growth(mult_by_stat, clamp_min=0, clamp_max=15):
    """Scale each character's growth-rate bytes. mult_by_stat: {stat: float}.
    Returns count of bytes changed."""
    iso = _iso(write=True)
    base, stride, _ = S.TABLES["list2"]
    n = 0
    for i in range(CHAR_COUNT_L2):
        rec_off = base + i*stride
        for stat, off in GROWTH_OFFS.items():
            m = mult_by_stat.get(stat)
            if m is None:
                continue
            dv = _disk_u8(iso, rec_off + off)
            nv = max(clamp_min, min(clamp_max, round(dv * m)))
            if nv != dv:
                n += 1
            iso.wr(rec_off + off, bytes([nv]))   # StagingIso self-cleans no-ops
    iso.close()
    return n

def scale_table_power(table, mult, off_in_rec, width=4):
    """Scale the power field of every record in a spell/unite table by `mult`,
    relative to the disk default. table: 'spell'|'unite'."""
    iso = _iso(write=True)
    if table == "spell":
        base, cnt, stride = S.SPELL_TABLE_FILE, S.SPELL_COUNT, S.SPELL_STRIDE
    else:
        base, cnt, stride = S.UNITE_TABLE_FILE, S.UNITE_COUNT, S.UNITE_STRIDE
    fmt = "<I" if width == 4 else "<H"
    cap = 0xFFFFFFFF if width == 4 else 0xFFFF
    n = 0
    for i in range(cnt):
        pos = base + i*stride + off_in_rec
        dv = struct.unpack(fmt, iso.disk_rd(pos, width))[0]
        nv = max(0, min(cap, round(dv * mult)))
        if nv != dv:
            n += 1
        iso.wr(pos, struct.pack(fmt, nv))
    iso.close()
    return n

def read_growth():
    """Per-stat roster summary: average current (staged) vs disk growth rate, so the
    Hard Mode UI can show the effect. Also returns counts staged."""
    iso = _iso()
    base, stride, _ = S.TABLES["list2"]
    stats = {}
    for stat, off in GROWTH_OFFS.items():
        cur = dsk = chg = 0
        for i in range(CHAR_COUNT_L2):
            pos = base + i*stride + off
            c = iso.rd(pos, 1)[0]; d = iso.disk_rd(pos, 1)[0]
            cur += c; dsk += d; chg += (c != d)
        stats[stat] = {"avgCurrent": round(cur / CHAR_COUNT_L2, 2),
                       "avgDisk": round(dsk / CHAR_COUNT_L2, 2), "changed": chg}
    iso.close()
    return {"count": CHAR_COUNT_L2, "stats": stats}

def apply_hard_mode(cfg):
    """cfg: {growth:{stat:mult,...}, partyPower:mult|None, unitePower:mult|None}.
    Stages all edits; returns per-section change counts."""
    res = {"growthBytes": 0, "spellPower": 0, "unitePower": 0}
    g = cfg.get("growth") or {}
    if g:
        res["growthBytes"] = scale_player_growth({k: float(v) for k, v in g.items()})
    pp = cfg.get("partyPower")
    if pp is not None:
        # party's own attack spells share the spell table; scale power @+0x1C
        res["spellPower"] = scale_table_power("spell", float(pp), 0x1C, 4)
    up = cfg.get("unitePower")
    if up is not None:
        res["unitePower"] = scale_table_power("unite", float(up), 0x1C, 4)
    return {"ok": True, **res}


# --------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        global _READ_DISK
        p = self.path.split("?")[0]
        q = {}
        if "?" in self.path:
            for kv in self.path.split("?", 1)[1].split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1); q[k] = v
        # ?disk=1 -> read the ISO's on-disk bytes, ignoring staged edits. Lets the
        # client compute each field's "default" to detect changes + offer Restore.
        _READ_DISK = q.get("disk") == "1"
        try:
            if p == "/" or p == "/index.html":
                return self._send(200, INDEX_HTML.encode(), "text/html; charset=utf-8")
            if p == "/api/isos":
                return self._send(200, {"root": _scan_root, "isos": scan_isos(_scan_root)})
            if p == "/api/meta":
                return self._send(200, {
                    "iso": os.path.basename(ISO_PATH) if ISO_PATH else None,
                    "loaded": bool(ISO_PATH),
                    "lastIso": load_config().get("lastIso"),
                    "backupEnabled": _backup_enabled,
                    "backedUp": _backed_up,
                    "pending": stage_count(),
                    "elements": S.ELEMENTS,
                    "statuses": ["none"] + sorted(set(S.F18_BITS.values())),
                    "runes": sorted(S.RUNE_SPELLS),
                    "runeSpells": S.RUNE_SPELLS,
                    "targets": [
                        {"v": 0x0A, "label": "Single target"},
                        {"v": 0x02, "label": "All foes"},
                        {"v": 0x03, "label": "All foes + allies"},
                        {"v": 0x12, "label": "Line / in front"},
                        {"v": 0x82, "label": "Area — foes"},
                        {"v": 0x83, "label": "Area — foes + allies"},
                        {"v": 0x01, "label": "Self / ally (buff)"},
                        {"v": 0x09, "label": "Heal — single ally"},
                        {"v": 0x81, "label": "Heal — area allies"},
                    ],
                    "shopTables": {k: v[3] for k, v in S.SHOP.items()},
                    "charNames": CHAR_NAMES,
                    "runeOwner": RUNE_OWNER,
                    "gearEffectTypes": S.GEAR_EFFECT_TYPES,
                    "gearStatSelector": S.GEAR_STAT_SELECTOR,
                    "gearTypeParam": S.GEAR_TYPE_PARAM,
                    "skills": [{"id": k, "name": v} for k, v in sorted(S.load_skill_ids().items())],
                })
            if p == "/api/spells":  return self._send(200, read_spells())
            if p == "/api/unites":  return self._send(200, read_unites())
            if p == "/api/gear":    return self._send(200, read_gear())
            if p == "/api/shop":    return self._send(200, read_shop())
            if p == "/api/items":   return self._send(200,
                [{"id": k, "name": v, "desc": ITEM_DESC.get(k, "")}
                 for k, v in sorted(S.load_item_ids().items())])
            if p == "/api/skills":  return self._send(200,
                [{"id": k, "name": v, "desc": SKILL_DESC.get(v, "")}
                 for k, v in sorted(S.load_skill_ids().items())])
            if p == "/api/char":
                return self._send(200, read_char(int(q["list"]), int(q["index"])))
            if p == "/api/charfields":
                return self._send(200, read_charfields(int(q["list"]), int(q["index"])))
            if p == "/api/enemies":
                return self._send(200, S.read_enemy_names(_iso()))
            if p == "/api/weapons":
                return self._send(200, read_weapons())
            if p == "/api/growth":
                return self._send(200, read_growth())
            # --- Save editor (PS2 memory card) — independent of any ISO ----------
            if p == "/api/savecards":
                roots = {_scan_root, os.path.abspath(os.path.join(_scan_root, "..")),
                         os.path.abspath(os.path.join(_scan_root, "Saves")),
                         os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
                         os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Saves"))}
                last = load_config().get("lastCard")
                return self._send(200, {"root": _scan_root, "lastCard": last,
                                        "cards": SV.scan_memcards(sorted(roots))})
            if p == "/api/save-read":
                path = q.get("path", "")
                import urllib.parse as _up
                path = _up.unquote(path)
                if not os.path.isfile(path):
                    return self._send(200, {"error": f"file not found: {path}"})
                try:
                    saves = SV.read_all_s3_saves(path)
                except Exception as e:
                    return self._send(200, {"error": f"could not read card: {e}"})
                save_config(lastCard=os.path.abspath(path))
                # item id->name so the UI can label inventory + offer an item picker
                items = [{"id": k, "name": v, "desc": ITEM_DESC.get(k, "")}
                         for k, v in sorted(S.load_item_ids().items())]
                # character-id -> name (list1 from the exe) to resolve leader / party ids
                charById = CHAR_NAMES.get("list1", {})
                # resolve the leader name for each save (ids >= ~200 are guests/NPCs)
                for sv in saves:
                    lid = sv.get("global", {}).get("partyLeader")
                    sv["leaderName"] = charById.get(str(lid), "")
                skills = [{"id": k, "name": v} for k, v in sorted(S.load_skill_ids().items())]
                return self._send(200, {"path": path, "statNames": SV.STAT_NAMES,
                                        "saves": saves, "items": items,
                                        "charById": charById, "skills": skills})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})
        finally:
            _READ_DISK = False

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        try:
            if self.path == "/api/open":
                ok, msg = open_iso(body.get("path", ""))
                return self._send(200, {"ok": ok, "iso": msg} if ok else {"error": msg})
            if self.path == "/api/backup":
                global _backup_enabled
                _backup_enabled = bool(body.get("enabled", True))
                return self._send(200, {"ok": True, "backupEnabled": _backup_enabled})
            if self.path == "/api/save":
                n = flush_pending()
                return self._send(200, {"ok": True, "written": n, "pending": 0})
            if self.path == "/api/revert":
                PENDING.clear()
                return self._send(200, {"ok": True, "pending": 0})
            if self.path == "/api/spell":
                return self._send(200, write_spell(int(body["index"]), body["fields"]))
            if self.path == "/api/unite":
                return self._send(200, write_unite(int(body["index"]), body["fields"]))
            if self.path == "/api/gear":
                return self._send(200, write_gear(int(body["id"]), body["fields"]))
            if self.path == "/api/rune":
                return self._send(200, self._rune(body))
            if self.path == "/api/shop":
                return self._send(200, write_shop(body["table"], int(body["slot"]), int(body["value"])))
            if self.path == "/api/char":
                return self._send(200, write_char_byte(int(body["list"]), int(body["index"]),
                                                       int(body["off"]), int(body["value"]),
                                                       int(body.get("width", 1))))
            if self.path == "/api/hardmode":
                return self._send(200, apply_hard_mode(body))
            if self.path == "/api/weapon":
                return self._send(200, write_weapon(int(body["index"]), body["levels"]))
            if self.path == "/api/save-write":
                # Save-editor writes go straight to the memcard file (with a .bak),
                # independent of the ISO staging layer. body: {path, folder, edits, backup}
                path = body.get("path", "")
                if not os.path.isfile(path):
                    return self._send(200, {"error": f"file not found: {path}"})
                res = SV.write_save_edits(path, body.get("folder", ""),
                                          body.get("edits", {}),
                                          make_backup=body.get("backup", True),
                                          inv_edits=body.get("invEdits", {}),
                                          name_edits=body.get("nameEdits", {}),
                                          party_edits=body.get("partyEdits", {}))
                return self._send(200, res)
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def _rune(self, body):
        key = body["rune"].lower().replace(" ", "").replace("_", "")
        names = S.RUNE_SPELLS.get(key)
        if not names: return {"error": "unknown rune"}
        iso = _iso(); n2i = {}
        for i in range(S.SPELL_COUNT):
            rec = iso.rd(S.SPELL_TABLE_FILE + i*S.SPELL_STRIDE, S.SPELL_STRIDE)
            n2i.setdefault(S._spell_name(iso, rec), i)
        iso.close()
        idxs = [n2i[n] for n in names if n in n2i]
        for idx in idxs:
            write_spell(idx, body["fields"])
        return {"ok": True, "spells": idxs}


INDEX_HTML = r"""<!doctype html><html><head><meta charset=utf-8>
<title>Suikoden III ISO & Save Editor</title>
<style>
/* ===== Suikoden III inspired themes =====
   All colors go through CSS variables. The default (:root) is the "Dark crimson &
   gold" theme (S3 at night); body.theme-parchment overrides to the light, menu-
   authentic parchment look. Inspired-by only — no game assets/fonts are used. */
:root{
 --bg:#17110d;--panel:#211812;--panel2:#2d2018;--headbg:linear-gradient(180deg,#2a1e14,#211812);
 --ink:#efe4d0;--mut:#a6947a;--line:#3c2c1e;
 --acc:#c39a3f;--acc2:#e0bd63;--accink:#1c1206;      /* antique gold buttons/tabs */
 --crimson:#a5282a;                                   /* section titles / dividers */
 --input-bg:#140e09;--thead-bg:#281c13;
 --ok:#5a7d3c;--toastink:#f3ecda;
 --warn:#e0a92c;--warnbd:#8a6a1c;--changed-bg:#2a2010;
 --dotborder:rgba(255,255,255,.15);
 --titlefont:"Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
 --focusring:rgba(195,154,63,.28);
 --hdr:64px;--navh:49px;--shadow:0 2px 10px rgba(0,0,0,.38)}
body.theme-parchment{
 --bg:#cdbb95;--panel:#f3ead3;--panel2:#e8dabb;--headbg:linear-gradient(180deg,#f6eed8,#efe4c8);
 --ink:#3a2a17;--mut:#7c6845;--line:#c3ac80;
 --acc:#9c2b26;--acc2:#b83f39;--accink:#f6ecd6;       /* crimson buttons/tabs, cream text */
 --crimson:#8f2420;
 --input-bg:#fcf6e7;--thead-bg:#e3d3ac;
 --ok:#5a7d3c;--toastink:#f3ecda;
 --warn:#8a5a10;--warnbd:#b98a2e;--changed-bg:#f3e5bf;
 --dotborder:rgba(0,0,0,.22);
 --focusring:rgba(156,43,38,.25);
 --shadow:0 2px 8px rgba(90,60,20,.22)}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
 background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
/* sticky header + nav so Save/Revert and tabs stay in reach on long tables */
header{position:sticky;top:0;z-index:30;padding:12px 18px;background:var(--headbg);
 border-bottom:2px solid var(--acc);display:flex;gap:14px;align-items:center;box-shadow:var(--shadow)}
header b{font-size:17px;letter-spacing:.02em;font-family:var(--titlefont);color:var(--acc2)}
header .iso{color:var(--mut);font-size:12px}
nav{position:sticky;top:var(--hdr);z-index:29;display:flex;gap:4px;padding:8px 18px;background:var(--panel);
 border-bottom:1px solid var(--line)}
nav button{background:transparent;color:var(--mut);border:0;padding:8px 14px;border-radius:8px;cursor:pointer;
 font:inherit;transition:background .12s,color .12s}
nav button:hover:not(:disabled):not(.on){background:var(--panel2);color:var(--ink)}
nav button.on{background:var(--acc);color:var(--accink);font-weight:600}
nav button:disabled{opacity:.35;cursor:not-allowed}
main{padding:18px;max-width:1120px;margin:0 auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:middle}
/* sticky column headers within each scrolling card */
thead th{position:sticky;top:calc(var(--hdr) + var(--navh));z-index:5;background:var(--thead-bg);
 color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tbody tr{transition:background .08s}
tr:hover td{background:var(--panel2)}
input,select{background:var(--input-bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;
 padding:5px 8px;font:inherit;transition:border-color .12s,box-shadow .12s}
input:focus,select:focus{outline:0;border-color:var(--acc);box-shadow:0 0 0 3px var(--focusring)}
input:hover:not(:focus),select:hover:not(:focus){border-color:var(--acc)}
input[type=number]{width:82px}
button.act{background:var(--acc);color:var(--accink);border:0;border-radius:6px;padding:6px 12px;cursor:pointer;
 font-weight:600;transition:filter .12s,transform .04s}
button.act:hover{filter:brightness(1.08)}button.act:active{transform:translateY(1px)}
button.act:disabled{opacity:.45;cursor:default;filter:none}
button.act.sec{background:var(--panel2);color:var(--ink);border:1px solid var(--line)}
button.act.sec:hover{border-color:var(--acc);filter:none}
.pill{padding:2px 9px;border-radius:999px;font-size:12px;background:var(--input-bg);border:1px solid var(--line);white-space:nowrap}
.aoe{color:var(--acc2);border-color:var(--acc)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px;
 box-shadow:var(--shadow)}
.card h3,.card h4,.card h2{font-family:var(--titlefont);letter-spacing:.01em}
h2{color:var(--crimson)!important}
.card h3{color:var(--acc2)}
.row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}
.row label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mut)}
#toast{position:fixed;bottom:18px;right:18px;background:var(--ok);color:var(--toastink);padding:10px 16px;
 border-radius:8px;opacity:0;transform:translateY(6px);transition:.2s;font-weight:600;box-shadow:var(--shadow);z-index:50}
#toast.show{opacity:1;transform:translateY(0)}
.hint{color:var(--mut);font-size:12px;margin:4px 0 14px}
.search{width:260px}
tr.descrow td{border-bottom:1px solid var(--line);padding-top:0}
tr.descrow .desc{color:var(--mut);font-size:12px;font-style:italic;padding:0 9px 8px}
tr.mainrow td{border-bottom:0}
/* changed-from-default field highlighting + restore button */
input.changed,select.changed{color:var(--warn);border-color:var(--warnbd);background:var(--changed-bg)}
.restore{display:none;margin-left:4px;background:transparent;border:1px solid var(--line);color:var(--mut);
 border-radius:6px;padding:3px 7px;cursor:pointer;font:inherit;line-height:1;vertical-align:middle;transition:.12s}
.restore:hover{color:var(--ink);border-color:var(--acc);background:var(--panel2)}
.restore.show{display:inline-block}
/* unsaved-changes dot on the Save button */
#pendingBadge{color:var(--warn)}
/* loading spinner */
.spin{display:inline-block;width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--acc);
 border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle}
.loading{display:flex;gap:10px;align-items:center;color:var(--mut);padding:24px 4px}
@keyframes spin{to{transform:rotate(360deg)}}
/* element color dots for scannable spell/unite tables */
.eldot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:baseline;
 border:1px solid var(--dotborder)}
.el1{background:#ff6b57}.el2{background:#4aa3ff}.el3{background:#57d6a0}
.el4{background:#c9a06a}.el5{background:#e6d24a}.el0{background:#8a7f6a}
kbd{background:var(--input-bg);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;
 padding:1px 5px;font:11px ui-monospace,monospace;color:var(--mut)}
/* weapon ATK level grid — wraps instead of overflowing the card */
.lvgrid{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:10px 12px}
@media(max-width:900px){.lvgrid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.lvcell{display:flex;flex-direction:column;align-items:center;gap:3px}
.lvnum{font-size:11px;color:var(--mut)}
.lvcell input{width:60px;text-align:center}
/* keep the ↺ restore button tight under the input in weapon cells */
.lvcell .restore{margin:2px 0 0 0}
/* theme switcher footer */
#themebar{max-width:1120px;margin:8px auto 28px;padding:10px 18px;display:flex;gap:10px;align-items:center;
 color:var(--mut);font-size:12px}
#themebar .tb{background:transparent;border:1px solid var(--line);color:var(--mut);border-radius:999px;
 padding:5px 14px;cursor:pointer;font:inherit;transition:.12s}
#themebar .tb:hover{color:var(--ink);border-color:var(--acc)}
#themebar .tb.on{background:var(--acc);color:var(--accink);border-color:var(--acc);font-weight:600}
/* Save Editor: keep wide stat tables from overflowing the card */
.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.savetbl{width:auto;min-width:100%}
.savetbl th,.savetbl td{padding:6px 8px;white-space:nowrap}
.savetbl input[type=number]{width:58px;text-align:center}
/* override the global sticky thead (offset for the page header/nav) — inside a card
   that offset lands the header mid-table, so pin it to the top of its own scroller */
.savetbl thead th{position:sticky;top:0;z-index:4}
.savetbl .nm{position:sticky;left:0;background:var(--panel);z-index:2;font-weight:600}
.savetbl thead th.nm{background:var(--thead-bg);z-index:6}
.subtabs{display:flex;gap:6px;margin-bottom:10px}
.subtabs button{background:transparent;color:var(--mut);border:1px solid var(--line);border-radius:8px;
 padding:6px 12px;cursor:pointer;font:inherit}
.subtabs button.on{background:var(--acc);color:var(--accink);border-color:var(--acc);font-weight:600}
</style></head><body>
<header><b>Suikoden III ISO &amp; Save Editor</b><span class=iso id=iso></span>
<label class=hint style="margin-left:auto;display:flex;gap:6px;align-items:center;cursor:pointer">
 <input type=checkbox id=backupChk checked> Back up ISO before first save</label>
<span class=hint id=backupState style="margin:0 14px"></span>
<span id=pendingBadge class=hint style="margin-right:8px"></span>
<button class="act sec" id=revertBtn style="margin-right:6px;display:none">Revert</button>
<button class=act id=saveBtn disabled>Save to ISO</button></header>
<nav id=nav></nav>
<main id=main></main>
<footer id=themebar>
 <span>Theme:</span>
 <button class=tb data-theme=crimson>Crimson &amp; Gold</button>
 <button class=tb data-theme=parchment>Parchment</button>
 <span class=hint style="margin:0 0 0 6px">Suikoden III-inspired styling (not official art).</span>
</footer>
<div id=toast></div>
<script>
const $=s=>document.querySelector(s), api=(u,o)=>fetch(u,o).then(r=>r.json());
let META={}, TAB="spells", DIRTY=false;
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1600);}
// theme: 'crimson' (default dark) or 'parchment' (light menu look). Persisted in
// BOTH localStorage and a cookie (1yr) so it survives even when one is unavailable
// (e.g. localStorage blocked in some private/embedded modes).
function saveTheme(t){
 try{localStorage.setItem("s3theme",t);}catch(e){}
 try{document.cookie="s3theme="+t+";path=/;max-age=31536000;samesite=lax";}catch(e){}}
function loadTheme(){
 try{const v=localStorage.getItem("s3theme");if(v)return v;}catch(e){}
 const m=document.cookie.match(/(?:^|;\s*)s3theme=([^;]+)/);
 return m?decodeURIComponent(m[1]):"crimson";}
function applyTheme(t){document.body.classList.toggle("theme-parchment",t==="parchment");
 document.querySelectorAll("#themebar .tb").forEach(b=>b.classList.toggle("on",b.dataset.theme===t));
 saveTheme(t);}
(function initTheme(){const t=loadTheme();
 // script runs at end of <body>, so body + footer already exist — apply now (no flash)
 applyTheme(t);
 document.querySelectorAll("#themebar .tb").forEach(b=>b.onclick=()=>applyTheme(b.dataset.theme));})();
function spinner(label){return `<div class=loading><span class=spin></span>${label||"loading…"}</div>`;}
// Set a <select> to a value, injecting a synthetic option if that value has no
// matching <option> (raw ROM values outside our curated lists). Prevents a blank
// render that would falsely trip the changed-from-default highlight.
function setSel(el,val){
 if(!el)return; val=String(val);
 if(!Array.prototype.some.call(el.options,o=>o.value===val)){
  const o=document.createElement("option");o.value=val;o.textContent=val+" (raw)";
  o.dataset.synthetic="1";el.appendChild(o);}
 el.value=val;}
const ELNAME={0:"none",1:"Fire",2:"Water",3:"Wind",4:"Earth",5:"Lightning"};
// small colored dot for an element id, for scannable tables
function eldot(id){return `<span class="eldot el${id in ELNAME?id:0}" title="${ELNAME[id]||('el '+id)}"></span>`;}
// Highlight fields whose value differs from their ISO default (data-def) and add a
// ↺ "Restore to default" button. Restore sets the value back and re-fires the tab's
// own change/blur save handler, so every editor gets this for free.
function decorate(scope){
 (scope||document).querySelectorAll("[data-def]").forEach(inp=>{
  if(inp._decor)return; inp._decor=1;
  const def=inp.getAttribute("data-def");
  // for selects, make sure the default value is a real option so comparison and
  // restore work even when the default is a raw ROM value outside the curated list
  if(inp.tagName==="SELECT"&&!Array.prototype.some.call(inp.options,o=>o.value===String(def))){
   const o=document.createElement("option");o.value=String(def);o.textContent=def+" (raw)";
   o.dataset.synthetic="1";inp.appendChild(o);}
  let btn=inp.nextElementSibling;
  if(!btn||!btn.classList||!btn.classList.contains("restore")){
   btn=document.createElement("button");btn.type="button";btn.className="restore";
   btn.textContent="↺";btn.title="Restore to default ("+def+")";inp.after(btn);}
  const refresh=()=>{const ch=String(inp.value)!==String(def);
   inp.classList.toggle("changed",ch);btn.classList.toggle("show",ch);};
  inp.addEventListener("input",refresh);inp.addEventListener("change",refresh);
  btn.onclick=()=>{inp.value=String(def);
   inp.dispatchEvent(new Event(inp.tagName==="SELECT"?"change":"blur"));refresh();};
  refresh();
 });
}
// Call after any successful edit: marks unsaved changes and updates the Save UI.
function markDirty(){DIRTY=true;updateSaveUI();}
function updateSaveUI(){
 const sb=$("#saveBtn"),rb=$("#revertBtn"),pb=$("#pendingBadge");
 if(!sb)return;
 sb.disabled=!DIRTY;
 sb.textContent=DIRTY?"● Save to ISO":"Save to ISO";
 rb.style.display=DIRTY?"":"none";
 pb.textContent=DIRTY?"unsaved changes":"";
}
async function doSave(){
 const r=await api("/api/save",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 if(r.ok){DIRTY=false;updateSaveUI();toast(`saved ${r.written} byte(s) to ISO`);}
 else toast("save failed: "+(r.error||"?"));
}
async function doRevert(){
 await api("/api/revert",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 DIRTY=false;updateSaveUI();toast("reverted unsaved changes");render();
}
async function boot(){META=await api("/api/meta");
 const tabs=["spells","runes","unites","gear","weapons","shop","characters","hardmode","enemies","reference","saves"];
 const TAB_LABEL={spells:"Spells",runes:"Runes",unites:"Unites",gear:"Gear",weapons:"Weapons",shop:"Shop",characters:"Characters",hardmode:"Hard Mode",enemies:"Enemies",reference:"Reference",saves:"Save Editor"};
 $("#nav").innerHTML=tabs.map(t=>`<button data-t="${t}">${TAB_LABEL[t]}</button>`).join("");
 document.querySelectorAll("#nav button").forEach(b=>b.onclick=()=>{if(b.disabled)return;TAB=b.dataset.t;render();});
 setTabsEnabled(META.loaded);
 renderIsoHeader();
 const chk=$("#backupChk");chk.checked=(META.backupEnabled!==false);
 function syncBackupLabel(){$("#backupState").textContent=chk.checked
   ?"a .bak copy is made before your first edit":"editing in place — NO backup";}
 syncBackupLabel();
 chk.onchange=async()=>{await api("/api/backup",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({enabled:chk.checked})});syncBackupLabel();
   toast(chk.checked?"backup on":"backup off — editing in place");};
 $("#saveBtn").onclick=doSave; $("#revertBtn").onclick=doRevert;
 DIRTY=(META.pending||0)>0; updateSaveUI();
 window.addEventListener("beforeunload",e=>{if(DIRTY){e.preventDefault();e.returnValue="";}});
 // keyboard shortcuts: Cmd/Ctrl+S = save, "/" = focus the filter box
 document.addEventListener("keydown",e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="s"){e.preventDefault();if(DIRTY)doSave();return;}
  if(e.key==="/"&&!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)){
   const q=$("#q");if(q){e.preventDefault();q.focus();q.select();}}
 });
 if(META.loaded)render(); else pickIso();}

// The Save Editor works on a memory card and needs no ISO, so it stays enabled
// even before an ISO is picked. Every other tab requires a loaded ISO.
function setTabsEnabled(on){document.querySelectorAll("#nav button").forEach(b=>{
 b.disabled=(b.dataset.t==="saves")?false:!on;});}
function renderIsoHeader(){
 $("#iso").innerHTML=`<button class=act id=pick>${META.loaded?"Change ISO":"Select ISO…"}</button>`+
   (META.loaded?` · <b>${META.iso}</b>`:` <span class=hint>load an ISO to begin</span>`);
 $("#pick").onclick=pickIso;}

async function pickIso(){setActive(true);const m=$("#main");m.innerHTML=spinner("scanning for ISO files…");
 const d=await api("/api/isos");
 const rows=d.isos.map(i=>`<tr><td>${i.name}</td><td class=hint>${i.gb} GB</td>
   <td class=hint>${i.path}</td><td><button class=act data-path="${encodeURIComponent(i.path)}">Open</button></td></tr>`).join("");
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Select a Suikoden III ISO</h3>
  <div class=hint>Files the editor found near ${d.root}. Only the USA SLUS-20387 release works.
  A 4 GB file can't be uploaded through the browser, so the server opens it by path.</div>
  <table><thead><tr><th>File</th><th>Size</th><th>Path</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan=4 class=hint>none found nearby — enter a full path below</td></tr>'}</tbody></table>
  ${META.lastIso?`<div class=row style="margin-top:14px;align-items:center">
   <button class=act id=openlast>Reopen last ISO</button>
   <span class=hint style=word-break:break-all>${META.lastIso}</span></div>`:""}
  <div class=row style=margin-top:14px><label style=flex:1>Or enter full path
   <input id=isopath style=width:100% placeholder="/full/path/to/Suikoden III (USA).iso" value="${META.lastIso?String(META.lastIso).replace(/"/g,"&quot;"):""}"></label>
   <button class=act id=openpath>Open</button></div>
  <div id=isoerr class=hint style=color:#e88></div></div>`;
 async function open(path){const r=await api("/api/open",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({path})});
  if(r.ok){META=await api("/api/meta");
   setTabsEnabled(true);renderIsoHeader();
   TAB="spells";render();toast("loaded "+r.iso);}
  else{$("#isoerr").textContent=r.error;}}
 m.querySelectorAll("[data-path]").forEach(b=>b.onclick=()=>open(decodeURIComponent(b.dataset.path)));
 $("#openpath").onclick=()=>open($("#isopath").value.trim());
 if($("#openlast"))$("#openlast").onclick=()=>open(META.lastIso);}
function setActive(clear){document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("on",!clear&&b.dataset.t===TAB));}
async function render(){
 // Save Editor is ISO-independent — allow it with no ISO loaded.
 if(TAB==="saves"){setActive();const m=$("#main");m.innerHTML=spinner();return renderSaves(m);}
 if(!META.loaded)return pickIso();setActive();const m=$("#main");m.innerHTML=spinner();
 if(TAB==="spells")return renderSpells(m);
 if(TAB==="runes")return renderRunes(m);
 if(TAB==="unites")return renderUnites(m);
 if(TAB==="gear")return renderGear(m);
 if(TAB==="weapons")return renderWeapons(m);
 if(TAB==="shop")return renderShop(m);
 if(TAB==="characters")return renderChars(m);
 if(TAB==="hardmode")return renderHardMode(m);
 if(TAB==="enemies")return renderEnemies(m);
 if(TAB==="reference")return renderRef(m);
 if(TAB==="saves")return renderSaves(m);}

const RUNE_TITLE={fire:"Fire Rune",rage:"Rage Rune",truefire:"True Fire Rune",
 lightning:"Lightning Rune",thunder:"Thunder Rune",truelightning:"True Lightning Rune",
 wind:"Wind Rune",cyclone:"Cyclone Rune",truewind:"True Wind Rune",
 water:"Water Rune",flowing:"Flowing Rune",truewater:"True Water Rune",earth:"Earth Rune",
 motherearth:"Mother Earth Rune",trueearth:"True Earth Rune",shield:"Shield Rune",
 blinking:"Blinking Rune",jongleur:"Jongleur Rune",palegate:"Pale Gate Rune",
 swordofrage:"Sword of Rage Rune",swordofthunder:"Sword of Thunder Rune",
 swordofcyclone:"Sword of Cyclone Rune"};

async function renderSpells(m){const sp=await api("/api/spells");
 const spDef=await api("/api/spells?disk=1");const DEF={};spDef.forEach(s=>DEF[s.index]=s);
 const dstat=s=>META.statuses.includes(s.status)?s.status:"none";
 const elOpts=`<option value="0">0 — none / neutral</option>`+Object.entries(META.elements).map(([id,n])=>`<option value="${id}">${n}</option>`).join("");
 const stOpts=META.statuses.map(s=>`<option>${s}</option>`).join("");
 const tgOpts=(META.targets||[]).map(t=>`<option value="${t.v}">${t.label}</option>`).join("")+`<option value="" disabled>(other/custom)</option>`;
 const byName={};sp.forEach(s=>{if(!(s.name in byName))byName[s.name]=s;});
 // order magic runes by element family (base -> upgrade -> true), not alphabetically
 const FAM=["fire","rage","truefire","lightning","thunder","truelightning",
   "wind","cyclone","truewind","water","flowing","truewater",
   "earth","motherearth","trueearth","shield","blinking","jongleur","palegate",
   "swordofrage","swordofthunder","swordofcyclone"];
 const runeOrder=[...FAM.filter(r=>META.runes.includes(r)),
                  ...META.runes.filter(r=>!FAM.includes(r))];
 // 1) magic runes: show each rune's FULL spell set (runes share spells in S3, so a
 //    spell can appear under several runes — that's correct; editing it updates the
 //    single underlying record everywhere). 'covered' just tracks which spells belong
 //    to a magic rune, so the attack/misc partition below excludes them.
 const covered=new Set(); const mageSecs=[], attackSecs=[];
 runeOrder.forEach(rk=>{
  const names=META.runeSpells[rk]||[]; const rows=[];
  names.forEach(nm=>{const s=byName[nm]; if(s){covered.add(s.index);rows.push(s);}});
  if(rows.length)mageSecs.push({title:RUNE_TITLE[rk]||rk,rows});});
 const assigned=covered;
 // 2) remaining NAMED spells are attack-rune abilities: each is its own "<Name> Rune"
 //    (Phoenix spell <-> Phoenix rune, etc). Blank/placeholder names -> Misc.
 const misc=[];
 sp.filter(s=>!assigned.has(s.index)).forEach(s=>{
  const nm=(s.name||"").trim();
  if(!nm||nm==="no"||/^no+n*$/.test(nm)){misc.push(s);return;}
  const owner=(META.runeOwner||{})[nm];
  const title=nm+" Rune"+(owner?` <span class=hint style=font-weight:400>— ${owner}</span>`:"");
  attackSecs.push({title,rows:[s],attack:true});
 });
 const sections=[...mageSecs,...attackSecs];
 if(misc.length)sections.push({title:"Unused / placeholder slots",rows:misc});

 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter spells…">
  <span class=hint>Grouped by rune. Edit power / cast / element / AOE / status — saves on change/blur.</span></div>
  <div id=secs></div>`;
 const head=`<thead><tr><th>#</th><th>Name</th><th>Element</th><th>Power</th><th>Cast</th><th>Target / Size</th><th>Status</th><th>Shape</th></tr></thead>`;

 function rowHTML(s){const d=DEF[s.index]||s;return `<tr data-name="${s.name.toLowerCase()}" class=mainrow>
   <td>${s.index}</td><td>${s.name}</td>
   <td><select data-i=${s.index} data-f=elementId data-def="${d.elementId}">${elOpts}</select></td>
   <td><input type=number data-i=${s.index} data-f=power data-def="${d.power}" value="${s.power}"></td>
   <td><input type=number data-i=${s.index} data-f=cast data-def="${d.cast}" value="${s.cast}"></td>
   <td><select data-i=${s.index} data-f=target data-def="${d.targetByte}">${tgOpts}</select></td>
   <td><select data-i=${s.index} data-f=status data-def="${dstat(d)}">${stOpts}</select></td>
   <td><span class="pill ${s.aoe?'aoe':''}">${eldot(s.elementId)}${s.target}</span></td></tr>
   ${s.desc?`<tr class=descrow><td></td><td colspan=7 class=desc>${s.desc}</td></tr>`:""}`;}

 function draw(f=""){
  let firstAttackShown=false, anyMageShown=false;
  $("#secs").innerHTML=sections.map(sec=>{
   const rows=sec.rows.filter(s=>s.name.toLowerCase().includes(f));
   if(!rows.length)return "";
   let divider="";
   if(!sec.attack)anyMageShown=true;
   if(sec.attack && !firstAttackShown && anyMageShown){firstAttackShown=true;
    divider=`<h2 style="margin:22px 4px 8px;color:var(--acc);font-size:15px">⚔ Attack Runes &amp; Other Abilities <span class=hint style=color:var(--mut)>(rune-attacks like Phoenix/Double Tusk, plus extra rune spells — one each)</span></h2>`;}
   const tag=sec.attack?` <span class=pill style=font-size:11px>rune ability</span>`:"";
   return `${divider}<div class=card><h3 style="margin:0 0 8px">${sec.title}${tag} <span class=hint>${rows.length} spell${rows.length>1?"s":""}</span></h3>
    <table>${head}<tbody>${rows.map(rowHTML).join("")}</tbody></table></div>`;}).join("");
  // set select values + wire saves
  $("#secs").querySelectorAll("select[data-f=elementId]").forEach(el=>setSel(el,byName_i(el).elementId));
  $("#secs").querySelectorAll("select[data-f=status]").forEach(el=>{const s=byName_i(el);el.value=(META.statuses.includes(s.status)?s.status:"none");});
  $("#secs").querySelectorAll("select[data-f=target]").forEach(el=>setSel(el,byName_i(el).targetByte));
  $("#secs").querySelectorAll("[data-f]").forEach(inp=>{
   const ev=inp.tagName==="SELECT"?"change":"blur";
   inp.addEventListener(ev,async()=>{
    const idx=+inp.dataset.i, f=inp.dataset.f;
    let v=inp.tagName==="SELECT"?inp.value:+inp.value;
    const fields={};fields[f]=(f==="elementId"||f==="target")?+v:v;
    const r=await api("/api/spell",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({index:idx,fields})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));
    if(r.ok&&(f==="target"||f==="elementId")){ // refresh the Shape pill + local cache
     const fresh=(await api("/api/spells")).find(x=>x.index===idx);
     const s=sp.find(x=>x.index===idx);Object.assign(s,fresh);
     const pill=inp.closest("tr").querySelector(".pill");
     if(pill){pill.innerHTML=eldot(fresh.elementId)+fresh.target;pill.classList.toggle("aoe",fresh.aoe);}
    }});});
  decorate($("#secs"));}
 function byName_i(el){const idx=+el.dataset.i;return sp.find(s=>s.index===idx);}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderUnites(m){const un=await api("/api/unites");
 const unDef=await api("/api/unites?disk=1");const UDEF={};unDef.forEach(u=>UDEF[u.index]=u);
 const tgOpts=(META.targets||[]).map(t=>`<option value="${t.v}">${t.label}</option>`).join("");
 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter unites…">
  <span class=hint>Co-op unite attacks. Edit power (damage/multiplier) · cast time · target. Saves on change/blur.</span></div>
  <table><thead><tr><th>#</th><th>Unite</th><th>Characters</th><th>Power</th><th>Cast</th><th>Target / Size</th><th>Shape</th><th>Effect</th></tr></thead>
  <tbody id=tb></tbody></table>`;
 function draw(f=""){
  $("#tb").innerHTML=un.filter(u=>u.name.toLowerCase().includes(f)||u.desc.toLowerCase().includes(f)||(u.chars||"").toLowerCase().includes(f)).map(u=>{const d=UDEF[u.index]||u;return `<tr><td>${u.index}</td><td>${u.name}</td>
     <td class=hint style=min-width:150px>${u.chars||'—'}</td>
     <td><input type=number data-i=${u.index} data-f=power data-def="${d.power}" value="${u.power}"></td>
     <td><input type=number data-i=${u.index} data-f=cast data-def="${d.cast}" value="${u.cast}"></td>
     <td><select data-i=${u.index} data-f=target data-def="${d.targetByte}">${tgOpts}</select></td>
     <td><span class="pill ${u.aoe?'aoe':''}">${u.target}</span></td>
     <td class=hint>${u.desc}</td></tr>`;}).join("");
  $("#tb").querySelectorAll("select[data-f=target]").forEach(el=>{const u=un.find(x=>x.index===+el.dataset.i);setSel(el,u.targetByte);});
  $("#tb").querySelectorAll("[data-f]").forEach(inp=>{
   inp.addEventListener(inp.tagName==="SELECT"?"change":"blur",async()=>{
    const idx=+inp.dataset.i, fld=inp.dataset.f;
    let v=inp.tagName==="SELECT"?+inp.value:+inp.value;
    const fields={};fields[fld]=v;
    const r=await api("/api/unite",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({index:idx,fields})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));
    if(r.ok&&fld==="target"){const fresh=(await api("/api/unites")).find(x=>x.index===idx);
     const u=un.find(x=>x.index===idx);Object.assign(u,fresh);
     const pill=inp.closest("tr").querySelector(".pill");pill.textContent=fresh.target;pill.classList.toggle("aoe",fresh.aoe);}
   });});
  decorate($("#tb"));}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderRunes(m){
 const FAM=["fire","rage","truefire","lightning","thunder","truelightning",
   "wind","cyclone","truewind","water","flowing","truewater",
   "earth","motherearth","trueearth","shield","blinking",
   "jongleur","palegate","swordofrage","swordofthunder","swordofcyclone"];
 const runeOrder=[...FAM.filter(r=>META.runes.includes(r)),...META.runes.filter(r=>!FAM.includes(r))];
 const rOpts=runeOrder.map(r=>`<option>${r}</option>`).join("");
 const elOpts=`<option value="0">0 — none / neutral</option>`+Object.entries(META.elements).map(([id,n])=>`<option value="${id}">${n}</option>`).join("");
 const stOpts=META.statuses.map(s=>`<option>${s}</option>`).join("");
 const elOptsKeep=`<option value="">(keep)</option>`+elOpts;
 const stOptsKeep=`<option value="">(keep)</option>`+stOpts;
 m.innerHTML=`<div class=card>
  <div class=row><label>Rune<select id=rune>${rOpts}</select></label>
   <span class=hint>Edit each spell individually below, or use bulk-apply.</span></div></div>
 <div class=card><h3 style=margin-top:0>This rune's spells</h3>
  <table><thead><tr><th>Lv</th><th>#</th><th>Name</th><th>Element</th><th>Power</th><th>Cast</th><th>Target / Size</th><th>Status</th><th>Shape</th></tr></thead>
  <tbody id=spellrows></tbody></table></div>
 <div class=card><h3 style=margin-top:0>Bulk-edit all of this rune's spells</h3>
  <div class=hint>Applies to every spell the rune grants at once. Blank fields left unchanged.</div>
  <div class=row>
   <label>Power<input type=number id=power placeholder=keep></label>
   <label>Cast<input type=number id=cast placeholder=keep></label>
   <label>Element<select id=element>${elOptsKeep}</select></label>
   <label>AOE<select id=aoe><option value="">(keep)</option><option value=on>on</option><option value=off>off</option></select></label>
   <label>Status<select id=status>${stOptsKeep}</select></label>
   <button class=act id=go>Apply to all</button>
  </div><div id=out class=hint></div></div>`;

 async function saveSpell(index, field, value){
  const fields={};fields[field]=value;
  const r=await api("/api/spell",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({index,fields})});
  if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));return r.ok;}

 async function loadSpells(){
  const rune=$("#rune").value;
  const wanted=(META.runeSpells[rune]||[]);
  const all=await api("/api/spells");
  const dsk=await api("/api/spells?disk=1");
  const byName={};all.forEach(s=>{if(!(s.name in byName))byName[s.name]=s;});
  const defByIdx={};dsk.forEach(s=>defByIdx[s.index]=s);
  const dstat=s=>META.statuses.includes(s.status)?s.status:"none";
  const tb=$("#spellrows");tb.innerHTML="";
  wanted.forEach((nm,lv)=>{
   const s=byName[nm];if(!s)return;const d=defByIdx[s.index]||s;
   const tr=document.createElement("tr");
   const tgOpts=(META.targets||[]).map(t=>`<option value="${t.v}">${t.label}</option>`).join("");
   tr.innerHTML=`<td>${lv+1}</td><td>${s.index}</td><td>${s.name}</td>
    <td><select data-f=elementId data-def="${d.elementId}">${elOpts}</select></td>
    <td><input type=number data-f=power data-def="${d.power}" value="${s.power}"></td>
    <td><input type=number data-f=cast data-def="${d.cast}" value="${s.cast}"></td>
    <td><select data-f=target data-def="${d.targetByte}">${tgOpts}</select></td>
    <td><select data-f=status data-def="${dstat(d)}">${stOpts}</select></td>
    <td><span class="pill ${s.aoe?'aoe':''}" data-tgt>${s.target}</span></td>`;
   setSel(tr.querySelector("[data-f=elementId]"),s.elementId);
   tr.querySelector("[data-f=status]").value=(META.statuses.includes(s.status)?s.status:"none");
   setSel(tr.querySelector("[data-f=target]"),s.targetByte);
   tr.querySelectorAll("[data-f]").forEach(inp=>{
    inp.addEventListener(inp.tagName==="SELECT"?"change":"blur",async()=>{
     const f=inp.dataset.f;
     let v=inp.tagName==="SELECT"?inp.value:+inp.value;
     if(f==="elementId"||f==="target")v=+v;
     const ok=await saveSpell(s.index,f,v);
     if(ok&&f==="target")loadSpells(); // refresh shape text
    });});
   tb.appendChild(tr);
   if(s.desc){const dr=document.createElement("tr");dr.className="descrow";
    dr.innerHTML=`<td></td><td></td><td colspan=7 class=desc>${s.desc}</td>`;tb.appendChild(dr);}
  });
  decorate(tb);}

 $("#rune").onchange=loadSpells;
 $("#go").onclick=async()=>{const f={};
  if($("#power").value!=="")f.power=+$("#power").value;
  if($("#cast").value!=="")f.cast=+$("#cast").value;
  if($("#element").value!=="")f.elementId=+$("#element").value;
  if($("#aoe").value!=="")f.aoe=$("#aoe").value==="on";
  if($("#status").value!=="")f.status=$("#status").value;
  if(!Object.keys(f).length){toast("set at least one field");return;}
  const r=await api("/api/rune",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({rune:$("#rune").value,fields:f})});
  $("#out").textContent=r.ok?`applied to spell indices ${r.spells.join(", ")}`:"error: "+r.error;
  if(r.ok)markDirty();toast(r.ok?"staged rune edits":"error");
  if(r.ok)loadSpells();};
 loadSpells();}

async function renderGear(m){const gear=await api("/api/gear");
 const gearDef=await api("/api/gear?disk=1");const GDEF={};gearDef.forEach(g=>{GDEF[g.id]={def:g.def,price:g.price,eff:{}};g.effects.forEach(e=>GDEF[g.id].eff[e.off]=e);});
 const TYPES=META.gearEffectTypes||{};
 const STATSEL=META.gearStatSelector||{};      // {statIndex: "PWR"...}
 const TYPEPARAM=META.gearTypeParam||{};        // {type: "stat"|"skill"}
 const typeOpts=Object.entries(TYPES).map(([v,n])=>`<option value="${v}">${v} · ${n}</option>`).join("");
 const skillOpts=(META.skills||[]).map(s=>`<option value="${s.id}">${s.id.toString(16).toUpperCase().padStart(2,'0')} · ${s.name}</option>`).join("");
 const statOpts=Object.entries(STATSEL).map(([v,n])=>`<option value="${v}">${n}</option>`).join("");
 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter gear…">
  <span class=hint>Edit DEF, price, and up to 5 effect slots. Type 2 = Stat bonus (pick which stat), 5 = Grant skill (pick skill). Saves on change.</span></div>
  <div id=gl></div>`;
 // param control depends on type: stat dropdown (type 2), skill dropdown (type 5), else hidden
 function slotEditor(g,e){
  const de=(GDEF[g.id]&&GDEF[g.id].eff[e.off])||e;
  return `<span style="white-space:nowrap">
    <select data-id=${g.id} data-off=${e.off} data-k=type data-def="${de.type}">${typeOpts}</select>
    <input type=number style=width:64px data-id=${g.id} data-off=${e.off} data-k=value data-def="${de.value}" value="${e.value}" title="amount">
    <select data-id=${g.id} data-off=${e.off} data-k=stat data-def="${de.param}" title="which stat">${statOpts}</select>
    <select data-id=${g.id} data-off=${e.off} data-k=skill data-def="${de.param}" title="which skill">${skillOpts}</select></span>`;
 }
 function paramCtl(id,off){return {
   stat:$(`#gl select[data-id="${id}"][data-off="${off}"][data-k=stat]`),
   skill:$(`#gl select[data-id="${id}"][data-off="${off}"][data-k=skill]`)};}
 function toggleParam(id,off,t){const {stat,skill}=paramCtl(id,off);
   if(stat)stat.style.display=(TYPEPARAM[t]==="stat")?"":"none";
   if(skill)skill.style.display=(TYPEPARAM[t]==="skill")?"":"none";}
 function draw(f=""){
  $("#gl").innerHTML=gear.filter(g=>g.name.toLowerCase().includes(f)||g.desc.toLowerCase().includes(f)).map(g=>{
   const gd=GDEF[g.id]||{def:g.def,price:g.price};
   const effs=g.effects.map(e=>`<tr><td class=hint style=width:60px>slot ${e.slot}</td><td>${slotEditor(g,e)}</td></tr>`).join("");
   return `<div class=card><h3 style="margin:0 0 4px">${g.name} <span class=hint>${g.desc}</span></h3>
    <div class=row style="margin-bottom:6px">
     <label>DEF<input type=number style=width:80px data-id=${g.id} data-k=def data-def="${gd.def}" value="${g.def}"></label>
     <label>Price<input type=number style=width:110px data-id=${g.id} data-k=price data-def="${gd.price}" value="${g.price}"></label></div>
    <table><tbody>${effs}</tbody></table></div>`;}).join("");
  // set dropdown values + show the right param control (stat vs skill) per type
  gear.forEach(g=>g.effects.forEach(e=>{
   const ts=$(`#gl select[data-id="${g.id}"][data-off="${e.off}"][data-k=type]`);if(ts)setSel(ts,e.type);
   const {stat,skill}=paramCtl(g.id,e.off);
   if(stat)setSel(stat,e.param);
   if(skill)setSel(skill,e.param);
   toggleParam(g.id,e.off,e.type);
  }));
  $("#gl").querySelectorAll("[data-k]").forEach(inp=>{
   inp.addEventListener(inp.tagName==="SELECT"?"change":"blur",()=>saveGear(inp));});
  decorate($("#gl"));}
 async function saveGear(inp){
  const id=+inp.dataset.id;const k=inp.dataset.k;const fields={};
  if(k==="def")fields.def=+inp.value;
  else if(k==="price")fields.price=+inp.value;
  else{ // effect slot: gather type + value + the active param control for this off
   const off=+inp.dataset.off;
   const t=+$(`#gl select[data-id="${id}"][data-off="${off}"][data-k=type]`).value;
   const v=+$(`#gl input[data-id="${id}"][data-off="${off}"][data-k=value]`).value;
   const {stat,skill}=paramCtl(id,off);
   let param=0;
   if(TYPEPARAM[t]==="stat"&&stat)param=+stat.value;
   else if(TYPEPARAM[t]==="skill"&&skill)param=+skill.value;
   fields.effects=[{off,type:t,value:v,param}];
   toggleParam(id,off,t);  // update which control shows after a type change
  }
  const r=await api("/api/gear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,fields})});
  if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderWeapons(m){const wpn=await api("/api/weapons");
 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter weapons / characters…">
  <span class=hint>Each weapon type's ATK at sharpen levels 1–16 — Suikoden III's "weapon power."
   Characters who use each weapon (and their weapon names) are listed on the card. Edit a level
   directly or scale a whole curve. Saves on change. (Sharpen cost data untouched.)</span></div>
  <div id=wl></div>`;
 const fighterText=w=>(w.fighters||[]).map(fr=>{
   const wns=(fr.weapons||[]).filter(Boolean);
   return wns.length?`${fr.name} (${wns.join(" / ")})`:fr.name;}).join(", ");
 function draw(f=""){
  $("#wl").innerHTML=wpn.filter(w=>w.name.toLowerCase().includes(f)||fighterText(w).toLowerCase().includes(f)).map(w=>{
   const cells=w.atk.map((a,li)=>
     `<div class=lvcell><div class=lvnum>${li+1}</div>
       <input type=number data-i=${w.index} data-lv=${li} data-def="${w.atkDefault[li]}" value="${a}"></div>`).join("");
   const fam=w.family?` <span class=pill style=font-size:11px>${w.family}</span>`:"";
   const who=fighterText(w)?`<div class=hint style="margin:2px 0 10px"><b>Used by:</b> ${fighterText(w)}</div>`:"";
   return `<div class=card><div class=row style="justify-content:space-between;align-items:center;margin-bottom:4px">
     <h3 style="margin:0">${w.name}${fam} <span class=hint>ATK ${w.atk[0]} → ${w.atk[15]}</span></h3>
     <label class=hint style="flex-direction:row;align-items:center;gap:6px">scale ATK ×
      <input type=number step=0.05 min=0 value=1 style=width:70px data-scale=${w.index}>
      <button class="act sec" data-scalego=${w.index}>Apply</button></label></div>
    ${who}<div class=lvgrid>${cells}</div></div>`;}).join("");
  $("#wl").querySelectorAll("input[data-lv]").forEach(inp=>{
   inp.addEventListener("blur",async()=>{
    const r=await api("/api/weapon",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({index:+inp.dataset.i,levels:{[inp.dataset.lv]:+inp.value}})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));});});
  $("#wl").querySelectorAll("[data-scalego]").forEach(btn=>btn.onclick=async()=>{
   const idx=+btn.dataset.scalego;
   const mult=+$(`input[data-scale="${idx}"]`).value;
   const w=wpn.find(x=>x.index===idx);
   const levels={};
   document.querySelectorAll(`#wl input[data-i="${idx}"][data-lv]`).forEach(inp=>{
    const nv=Math.max(0,Math.min(255,Math.round(+inp.value*mult)));
    inp.value=nv; levels[inp.dataset.lv]=nv;
    inp.dispatchEvent(new Event("change"));});
   const r=await api("/api/weapon",{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({index:idx,levels})});
   if(r.ok){markDirty();toast(`scaled ${w.name} ATK ×${mult}`);}else toast("error");});
  decorate($("#wl"));}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderShop(m){const shop=await api("/api/shop");const items=await api("/api/items");
 const shopDef=await api("/api/shop?disk=1");
 const SDEF={};for(const[tbl,info]of Object.entries(shopDef)){SDEF[tbl]={};info.rows.forEach(r=>SDEF[tbl][r.slot]=r.value);}
 const IDESC={};items.forEach(i=>{IDESC[i.id]=i.desc||"";});
 const itemOpts=items.map(i=>`<option value="${i.id}" title="${(i.desc||'').replace(/"/g,'&quot;')}">${i.id.toString(16).toUpperCase().padStart(3,'0')} ${i.name}</option>`).join("");
 const SHOP_LABEL={item1:"Item Group 1",item2:"Price Ladder",item3_a:"Shop Slots 1–10",item3_b:"Shop Slots 21–36"};
 let h="";
 for(const [tbl,info] of Object.entries(shop)){
  h+=`<div class=card><h3 style=margin-top:0>${SHOP_LABEL[tbl]||tbl} <span class=hint>${info.note}</span></h3><table><tbody>`;
  info.rows.forEach(r=>{
   const dv=(SDEF[tbl]&&SDEF[tbl][r.slot]!==undefined)?SDEF[tbl][r.slot]:r.value;
   const editor=info.width===2
    ? `<select data-tbl=${tbl} data-slot=${r.slot} class=itemsel data-def="${dv}">${itemOpts}</select>`
    : `<input type=number data-tbl=${tbl} data-slot=${r.slot} data-def="${dv}" value="${r.value}">`;
   const note=r.name?(r.name+(IDESC[r.value]?` — <i>${IDESC[r.value]}</i>`:"")):"";
   h+=`<tr><td style=width:60px>[${r.slot}]</td><td>${editor}</td><td class=hint data-note=${tbl}_${r.slot}>${note}</td></tr>`;});
  h+=`</tbody></table></div>`;}
 m.innerHTML=h;
 document.querySelectorAll(".itemsel").forEach(sel=>{
  const row=shop[sel.dataset.tbl].rows[+sel.dataset.slot];setSel(sel,row.value);});
 decorate(m);
 m.querySelectorAll("[data-tbl]").forEach(inp=>{
  const ev=inp.tagName==="SELECT"?"change":"blur";
  inp.addEventListener(ev,async()=>{
   const r=await api("/api/shop",{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({table:inp.dataset.tbl,slot:+inp.dataset.slot,value:+inp.value})});
   if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));
   if(r.ok&&inp.tagName==="SELECT"){const it=items.find(x=>x.id===+inp.value);
    const cell=$(`[data-note="${inp.dataset.tbl}_${inp.dataset.slot}"]`);
    if(cell&&it)cell.innerHTML=it.name+(it.desc?` — <i>${it.desc}</i>`:"");}
  });});}

const LIST_NAMES={1:"Starting Stats / Equipment",2:"Growth · Skill Max · Fixed Skills",3:"Support Skills",4:"list4 (raw bytes)"};
let ITEMS_CACHE=null, SKILLS_CACHE=null;
async function renderChars(m){
 if(!ITEMS_CACHE)ITEMS_CACHE=await api("/api/items");
 if(!SKILLS_CACHE)SKILLS_CACHE=await api("/api/skills");
 const itemOpts=`<option value="0">— none (0) —</option>`+ITEMS_CACHE.map(i=>`<option value="${i.id}" title="${(i.desc||'').replace(/"/g,'&quot;')}">${i.id.toString(16).toUpperCase().padStart(3,'0')} · ${i.name}</option>`).join("");
 const ITEMDESC={};ITEMS_CACHE.forEach(i=>{ITEMDESC[i.id]=i.desc||"";});
 const skillOpts=`<option value="0">— none (0) —</option>`+SKILLS_CACHE.map(i=>`<option value="${i.id}" title="${(i.desc||'').replace(/"/g,'&quot;')}">${i.id.toString(16).toUpperCase().padStart(2,'0')} · ${i.name}</option>`).join("");
 const SKILLDESC={};SKILLS_CACHE.forEach(i=>{SKILLDESC[i.id]=i.desc||"";});
 const NAMES=META.charNames||{};
 function nameOpts(listKey){
  const map=NAMES[listKey]||{};
  const entries=Object.entries(map).sort((a,b)=>(+a[0])-(+b[0]));
  if(!entries.length)return `<option value="1">(index 1)</option>`;
  return entries.map(([i,n])=>`<option value="${i}">${(+i).toString().padStart(3,'0')} — ${n}</option>`).join("");
 }
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Character editor</h3>
 <div class=hint>Names are from the original exe's list. list1 = Starting Stats, list2 = Growth (same roster),
 list3 = Support characters, list4 = weapon attack types. Equipment/rune/skill fields are dropdowns. Saves on change.</div>
 <div class=row>
  <label>Character<select id=idx style=min-width:200px>${nameOpts("list1")}</select></label>
  <label>Data section<select id=list>${Object.entries(LIST_NAMES).map(([k,v])=>`<option value="${k}">${k} — ${v}</option>`).join("")}</select></label>
  <button class=act id=load>Reload</button>
  <span class=hint id=addr></span>
 </div><div id=rec></div></div>`;
 // when the section changes: repopulate the name dropdown for that list AND reload
 $("#list").onchange=()=>{$("#idx").innerHTML=nameOpts("list"+$("#list").value);load();};
 function fieldEditor(f){
  const dv=(f.def!==undefined?f.def:f.value);
  if(f.kind==="item")  return `<select data-off=${f.off} data-w=${f.width} data-kind=item data-def="${dv}">${itemOpts}</select>`;
  if(f.kind==="skill") return `<select data-off=${f.off} data-w=${f.width} data-kind=skill data-def="${dv}">${skillOpts}</select>`;
  return `<input type=number min=0 value="${f.value}" data-off=${f.off} data-w=${f.width} data-def="${dv}">`;
 }
 async function load(){
  const L=+$("#list").value, IX=+$("#idx").value;
  const c=await api(`/api/charfields?list=${L}&index=${IX}`);
  const cd=await api(`/api/charfields?list=${L}&index=${IX}&disk=1`);
  const DEFOFF={};cd.groups.forEach(g=>g.fields.forEach(f=>DEFOFF[f.off]=f.value));
  c.groups.forEach(g=>g.fields.forEach(f=>{if(DEFOFF[f.off]!==undefined)f.def=DEFOFF[f.off];}));
  $("#addr").textContent=`addr 0x${c.addr.toString(16).toUpperCase()} · stride ${c.stride}`;
  let h="";
  c.groups.forEach(g=>{
   h+=`<div class=card style="margin:14px 0"><h4 style="margin:0 0 4px">${g.title}</h4>`;
   if(g.help)h+=`<div class=hint>${g.help}</div>`;
   h+=`<table><tbody>`;
   g.fields.forEach(f=>{
    const note=f.kind==='num'?('= '+f.value):(f.kind==='skill'?(SKILLDESC[f.value]||''):(f.kind==='item'?(ITEMDESC[f.value]||''):''));
    h+=`<tr><td style="width:230px">${f.label}</td><td>${fieldEditor(f)}</td>
     <td class="hint" data-descfor="${f.off}">${note}</td></tr>`;});
   h+=`</tbody></table></div>`;});
  $("#rec").innerHTML=h;
  // set dropdown current values
  c.groups.forEach(g=>g.fields.forEach(f=>{
   if(f.kind==="item"||f.kind==="skill"){
    const el=$(`#rec [data-off="${f.off}"][data-kind]`);if(el)setSel(el,f.value);}}));
  $("#rec").querySelectorAll("[data-off]").forEach(inp=>{
   const ev=inp.tagName==="SELECT"?"change":"blur";
   inp.addEventListener(ev,async()=>{
    const r=await api("/api/char",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({list:L,index:IX,off:+inp.dataset.off,value:+inp.value,width:+inp.dataset.w})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));
    if(inp.dataset.kind){const cell=$(`#rec [data-descfor="${inp.dataset.off}"]`);
     const map=inp.dataset.kind==="skill"?SKILLDESC:ITEMDESC;
     if(cell)cell.textContent=map[+inp.value]||"";}});});
  decorate($("#rec"));}
 $("#load").onclick=load; $("#idx").onchange=load; load();}

// Difficulty presets. Each multiplier scales the ISO's DEFAULT growth rate / power,
// so presets are idempotent (re-applying doesn't compound). Stats: PWR SKL MAG REP
// MDF SPD LUK HP. Grounded in S3's per-stat growth-rate mechanic (values ~2-6).
const HM_STATS=["HP","PWR","MAG","SKL","MDF","SPD","REP","LUK"];
const HM_STATLABEL={HP:"HP",PWR:"Attack (PWR)",MAG:"Magic (MAG)",SKL:"Skill (SKL)",
 MDF:"Magic Def (MDF)",SPD:"Speed (SPD)",REP:"Repel (REP)",LUK:"Luck (LUK)"};
const HM_PRESETS={
 tougher:{label:"Tougher",desc:"A gentle nerf — the party grows a bit slower.",
   growth:{HP:0.8,PWR:0.85,MAG:0.85,SKL:0.9,MDF:0.9,SPD:0.95,REP:1,LUK:1},partyPower:0.9,unitePower:0.9},
 hard:{label:"Hard",desc:"Noticeably weaker party. Fights take real thought.",
   growth:{HP:0.65,PWR:0.7,MAG:0.7,SKL:0.8,MDF:0.8,SPD:0.9,REP:0.9,LUK:1},partyPower:0.75,unitePower:0.75},
 brutal:{label:"Brutal",desc:"Punishing. Low HP, weak hits — every battle is a threat.",
   growth:{HP:0.5,PWR:0.55,MAG:0.55,SKL:0.7,MDF:0.7,SPD:0.85,REP:0.85,LUK:1},partyPower:0.6,unitePower:0.6}};

async function renderHardMode(m){
 const g=await api("/api/growth");
 const cur={}; HM_STATS.forEach(s=>cur[s]=1); // slider state (multipliers)
 m.innerHTML=`<div class=card>
   <div class=row style="justify-content:space-between;align-items:center">
    <div><h3 style="margin:0 0 4px">Hard Mode <span class=pill>player nerf</span></h3>
     <div class=hint style=margin:0>Makes YOUR party weaker across the whole game by scaling each
      character's stat <b>growth rate</b> (and, optionally, spell/unite power). Enemies can't be
      buffed directly (their stats aren't in an editable table — see the Enemies tab), so difficulty
      comes from a weaker party. Edits are staged — hit <b>Save to ISO</b> to write.</div></div>
    <label class=hint style="flex-direction:row;align-items:center;gap:8px;cursor:pointer;font-size:13px">
     <input type=checkbox id=hmMaster> <b>Enable Hard Mode</b></label>
   </div></div>
  <div id=hmBody style="opacity:.45;pointer-events:none">
   <div class=card><h3 style="margin:0 0 8px">Difficulty preset</h3>
    <div class=row id=hmPresets></div>
    <div class=hint id=hmPresetDesc style=margin-top:8px></div></div>
   <div class=card><h3 style="margin:0 0 4px">Fine-tune multipliers</h3>
    <div class=hint>1.00 = unchanged (default). Lower = weaker. Applies to all ${g.count} party growth records.</div>
    <table><thead><tr><th>Stat</th><th>Multiplier</th><th>Avg growth (def → new)</th></tr></thead>
     <tbody id=hmStats></tbody></table>
    <div class=row style="margin-top:12px">
     <label>Spell power ×<input type=number id=hmSpell step=0.05 min=0 value=1 style=width:80px></label>
     <label>Unite power ×<input type=number id=hmUnite step=0.05 min=0 value=1 style=width:80px></label>
    </div>
    <div class=hint style=margin-top:6px>Note: spell records are shared between party and
     enemy casts, so scaling spell power affects both — leave at 1.00 to only nerf via growth rates.</div></div>
   <div class=card><div class=row style="align-items:center">
     <button class=act id=hmApply>Apply to staged edits</button>
     <button class="act sec" id=hmReset>Restore all to default</button>
     <span class=hint id=hmOut style=margin:0></span></div>
    <div class=hint style=margin-top:8px>Tip: after applying, review the Characters tab (Growth section) to
     see per-character values, then Save.</div></div>
  </div>`;
 const gd={}; HM_STATS.forEach(s=>gd[s]=g.stats[s]);
 function drawStats(){
  $("#hmStats").innerHTML=HM_STATS.map(s=>{
   const st=g.stats[s]; const proj=(st.avgDisk*cur[s]);
   return `<tr><td>${HM_STATLABEL[s]}</td>
    <td><input type=range min=0.3 max=1.2 step=0.05 data-s="${s}" value="${cur[s]}" style=width:180px>
        <span data-mv="${s}" style="display:inline-block;width:42px;text-align:right">${cur[s].toFixed(2)}</span></td>
    <td class=hint>${st.avgDisk.toFixed(2)} → <b style="color:${proj<st.avgDisk?'var(--warn)':'var(--ink)'}">${proj.toFixed(2)}</b>${st.changed?` · ${st.changed} staged`:""}</td></tr>`;}).join("");
  $("#hmStats").querySelectorAll("input[type=range]").forEach(r=>r.oninput=()=>{
   cur[r.dataset.s]=+r.value; $(`[data-mv="${r.dataset.s}"]`).textContent=(+r.value).toFixed(2);
   const st=g.stats[r.dataset.s]; const cell=r.closest("tr").querySelector("td.hint");
   const proj=st.avgDisk*(+r.value);
   cell.innerHTML=`${st.avgDisk.toFixed(2)} → <b style="color:${proj<st.avgDisk?'var(--warn)':'var(--ink)'}">${proj.toFixed(2)}</b>${st.changed?` · ${st.changed} staged`:""}`;});}
 drawStats();
 // preset buttons
 $("#hmPresets").innerHTML=Object.entries(HM_PRESETS).map(([k,p])=>`<button class="act sec" data-p="${k}">${p.label}</button>`).join("")+
   `<button class="act sec" data-p="custom">Custom</button>`;
 function applyPreset(k){
  if(k==="custom"){$("#hmPresetDesc").textContent="Set your own multipliers below.";return;}
  const p=HM_PRESETS[k];HM_STATS.forEach(s=>cur[s]=p.growth[s]!==undefined?p.growth[s]:1);
  $("#hmSpell").value=p.partyPower;$("#hmUnite").value=p.unitePower;
  $("#hmPresetDesc").textContent=p.desc;drawStats();}
 $("#hmPresets").querySelectorAll("[data-p]").forEach(b=>b.onclick=()=>{
  $("#hmPresets").querySelectorAll("[data-p]").forEach(x=>x.style.outline="");
  b.style.outline="2px solid var(--acc)";applyPreset(b.dataset.p);});
 // master toggle enables/disables the body
 $("#hmMaster").onchange=()=>{const on=$("#hmMaster").checked;
  $("#hmBody").style.opacity=on?"1":".45";$("#hmBody").style.pointerEvents=on?"":"none";
  if(on&&!$("#hmPresetDesc").textContent){$("#hmPresets [data-p=hard]").click();}};
 $("#hmApply").onclick=async()=>{
  const growth={};HM_STATS.forEach(s=>growth[s]=cur[s]);
  const body={growth};const sp=+$("#hmSpell").value,up=+$("#hmUnite").value;
  if(sp!==1)body.partyPower=sp; if(up!==1)body.unitePower=up;
  const r=await api("/api/hardmode",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(r.ok){markDirty();$("#hmOut").innerHTML=`staged: ${r.growthBytes} growth bytes${r.spellPower?`, ${r.spellPower} spell powers`:""}${r.unitePower?`, ${r.unitePower} unite powers`:""}`;
   toast("hard mode staged — hit Save to ISO");render();}
  else{$("#hmOut").textContent="error: "+(r.error||"?");}};
 $("#hmReset").onclick=async()=>{
  // multipliers of 1.0 rewrite disk defaults -> StagingIso self-cleans those bytes
  const growth={};HM_STATS.forEach(s=>growth[s]=1);
  await api("/api/hardmode",{method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({growth,partyPower:1,unitePower:1})});
  toast("player stats restored to default (staged)");markDirty();render();};}

async function renderEnemies(m){const en=await api("/api/enemies");
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Enemies <span class=pill>reference</span></h3>
  <div class=hint>All ${en.length} entries from the game's enemy name table (index-keyed).
   <b>Read-only:</b> enemy HP/attack are not stored in an editable table — they're set by the
   battle engine — so they can't be scaled here. Use <b>Hard Mode</b> to raise difficulty by
   weakening your party instead. Names are truncated to 10 characters in the ROM.</div>
  <input class=search id=q placeholder="filter enemies…" style=margin-bottom:10px>
  <table><thead><tr><th style=width:70px>Index</th><th>Name</th></tr></thead><tbody id=eb></tbody></table></div>`;
 function draw(f=""){$("#eb").innerHTML=en.filter(e=>e.name.toLowerCase().includes(f)||String(e.index)===f)
   .map(e=>`<tr><td class=hint>${e.index}</td><td>${e.name||'<span class=hint>(blank)</span>'}</td></tr>`).join("");}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderRef(m){const items=await api("/api/items");
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Hex reference (Items & Skills)</h3>
 <div class=hint>The exe's "Item hex list" / "Skill hex list". Search to find an ID to type into equipment/skill fields.</div>
 <input class=search id=q placeholder="search items/skills…" style=width:320px>
 <div class=row style="margin-top:10px;align-items:flex-start">
  <div style=flex:1><b>Items</b><table><tbody id=ib></tbody></table></div>
 </div></div>`;
 function draw(f=""){const ib=$("#ib");ib.innerHTML="";
  items.filter(i=>i.name.toLowerCase().includes(f)||i.id.toString(16).includes(f)).slice(0,400)
   .forEach(i=>{ib.innerHTML+=`<tr><td class=pill>${i.id.toString(16).toUpperCase().padStart(3,'0')}</td><td>${i.name}</td></tr>`;});}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

// ---- Save Editor: reads a PS2 memory card (*.ps2) and decodes S3 save slots. ----
// Read-only for now: writing needs the save's checksum algorithm, which isn't
// solved yet. No ISO required — this is a separate subsystem (Editor/s3save.py).
let SAVE_CARD=null;   // last-opened card path
async function renderSaves(m){
 m.innerHTML=spinner("scanning for PS2 memory cards…");
 const d=await api("/api/savecards");
 const rows=(d.cards||[]).map(c=>`<tr>
   <td>${c.name}</td><td class=hint>${c.mb} MB</td>
   <td>${c.hasS3?'<span class="pill aoe">Suikoden III</span>':'<span class=hint>no S3 save</span>'}</td>
   <td class=hint style=word-break:break-all>${c.path}</td>
   <td><button class=act data-card="${encodeURIComponent(c.path)}" ${c.hasS3?'':'disabled'}>Open</button></td></tr>`).join("");
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Save Editor <span class=pill aoe>memory card</span></h3>
   <div class=hint>Opens an 8&nbsp;MB PS2 memory-card image (<b>.ps2</b>/.mcd) and edits its Suikoden III
    save slots — no ISO needed. Edits write straight to the card file (a <b>.bak</b> is made first);
    the save checksum and page ECC are recomputed automatically. Cards found near ${d.root}.</div>
   <table><thead><tr><th>File</th><th>Size</th><th>Contains</th><th>Path</th><th></th></tr></thead>
    <tbody>${rows||'<tr><td colspan=5 class=hint>no PS2 memory cards found nearby — enter a full path below</td></tr>'}</tbody></table>
   ${d.lastCard?`<div class=row style="margin-top:12px;align-items:center">
     <button class=act id=savelast>Reopen last card</button>
     <span class=hint style=word-break:break-all>${d.lastCard}</span></div>`:""}
   <div class=row style=margin-top:12px><label style=flex:1>Or enter full path
     <input id=cardpath style=width:100% placeholder="/path/to/Mcd001.ps2" value="${d.lastCard?String(d.lastCard).replace(/"/g,"&quot;"):""}"></label>
     <button class=act id=cardopen>Open</button></label></div>
   <div id=carderr class=hint style=color:#e88></div></div>
   <div id=savebody></div>`;
 m.querySelectorAll("[data-card]").forEach(b=>b.onclick=()=>openCard(decodeURIComponent(b.dataset.card)));
 if($("#savelast"))$("#savelast").onclick=()=>openCard(d.lastCard);
 $("#cardopen").onclick=()=>openCard($("#cardpath").value.trim());
 if(SAVE_CARD)openCard(SAVE_CARD);
}
async function openCard(path){
 if(!path)return; SAVE_CARD=path;
 const body=$("#savebody"); if(body)body.innerHTML=spinner("reading save…");
 const r=await api("/api/save-read?path="+encodeURIComponent(path));
 if(r.error){$("#carderr").textContent=r.error; if(body)body.innerHTML=""; return;}
 $("#carderr").textContent="";
 renderSaveSlots(r);
}
let SAVE_ITEMS=[];       // [{id,name,desc}] for inventory labels + picker
function renderSaveSlots(r){
 const body=$("#savebody"); if(!body)return;
 if(!r.saves.length){body.innerHTML=`<div class=card><div class=hint>No Suikoden III save found on this card.</div></div>`;return;}
 SAVE_ITEMS=r.items||[];
 const statCols=r.statNames||[];
 const ITEMNAME={}; SAVE_ITEMS.forEach(i=>ITEMNAME[i.id]=i.name);
 const itemOpts=`<option value="0">— empty —</option>`+SAVE_ITEMS.map(i=>
   `<option value="${i.id}">${i.id.toString(16).toUpperCase().padStart(3,'0')} · ${i.name}</option>`).join("");
 const SKILLS=r.skills||[];
 const SKILLNAME={}; SKILLS.forEach(s=>SKILLNAME[s.id]=s.name);
 const skillOpts=`<option value="0">— none —</option>`+SKILLS.map(s=>
   `<option value="${s.id}">${s.id.toString(16).toUpperCase().padStart(2,'0')} · ${s.name}</option>`).join("");
 const CHARBY=r.charById||{};  // {id: name} for party picker
 const charOpts=`<option value="0">— empty —</option>`+Object.entries(CHARBY)
   .sort((a,b)=>(+a[0])-(+b[0])).map(([id,nm])=>`<option value="${id}">${(+id).toString().padStart(3,'0')} · ${nm}</option>`).join("");
 const slotTabs=r.saves.map((s,i)=>`<button class="act sec" data-slot=${i}>${s.label}</button>`).join("");
 body.innerHTML=`<div class=card><div class=row style="align-items:center;gap:8px">
    <b>Save slot:</b> ${slotTabs}
    <span class=hint id=slotmeta style=margin-left:auto></span></div></div>
   <div id=slotbody></div>`;
 // pending edits for the CURRENT slot
 let EDITS={}, INV={}, NAMES={}, PARTY={}, SUB="chars", RECRUITED_ONLY=true;
 function setEdit(ridx,key,val,stat){
  EDITS[ridx]=EDITS[ridx]||{};
  if(stat){EDITS[ridx].stats=EDITS[ridx].stats||{};EDITS[ridx].stats[stat]=val;}
  else EDITS[ridx][key]=val;}
 function setSkill(ridx,slot,field,val){
  EDITS[ridx]=EDITS[ridx]||{};EDITS[ridx].skills=EDITS[ridx].skills||{};
  EDITS[ridx].skills[slot]=EDITS[ridx].skills[slot]||{};EDITS[ridx].skills[slot][field]=val;}
 function dirty(){return Object.keys(EDITS).length||Object.keys(INV).length||Object.keys(NAMES).length||Object.keys(PARTY).length;}
 function markSaveDirty(){const w=$("#savewrite");if(w){w.disabled=!dirty();w.textContent=dirty()?"● Write to card":"Write to card";}}

 function drawSlot(i){
  const s=r.saves[i]; EDITS={}; INV={}; NAMES={}; PARTY={};
  body.querySelectorAll("[data-slot]").forEach(b=>b.style.outline=(+b.dataset.slot===i)?"2px solid var(--acc)":"");
  const meta=s.meta||{};
  const leaderTxt=s.leaderName?`Leader ${s.leaderName}`:`Leader id ${s.global.partyLeader} (guest/NPC)`;
  const metaBits=[
    meta.chapter!=null?`Chapter ${meta.chapter}`:null,
    meta.level!=null?`Party Lv ${meta.level}`:null,
    meta.playtime?`Playtime ${meta.playtime}`:null,
    leaderTxt,
    `story phase ${s.global.storyPhase}`,
  ].filter(Boolean).join(" · ");
  $("#slotmeta").innerHTML=`${s.folder} · checksum 0x${s.checksumWord.toString(16).toUpperCase()}`;
  const live=s.characters.filter(c=>c.level>0||c.curHP>0||c.expToNext>0);
  const inv=s.inventory||[];
  const invCount=inv.reduce((a,bg)=>a+bg.items.length,0);  // total items across all bags
  const nameInputs=(s.names||[]).map(nm=>`<label class=hint style="flex-direction:column;gap:3px;align-items:stretch">${nm.label}
     <input type=text maxlength=${nm.max} value="${(nm.value||'').replace(/"/g,'&quot;')}" data-name=${nm.key} data-def="${(nm.value||'').replace(/"/g,'&quot;')}"></label>`).join("");
  // Suikoden I/II carryover indicator
  const co=s.carryover||{};
  const coPill=(g,label)=>g?`<span class="pill ${g.loaded?'aoe':''}" title="${g.hero}${g.country?' · '+g.country:''}">${label}: ${g.loaded?'loaded ('+g.hero+')':'not detected'}</span>`:'';
  const carryLine=`<div style="margin:2px 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
     <span class=hint>Carryover:</span>${coPill(co.s1,'Suikoden I')}${coPill(co.s2,'Suikoden II')}
     <span class=hint>(detected from the transferred hero/country names; defaults mean no linked save)</span></div>`;
  $("#slotbody").innerHTML=`<div class=card>
     <div class=hint style="margin:-2px 0 8px">${metaBits}</div>
     ${carryLine}
     <div style="font-weight:600;color:var(--acc2);margin:0 0 6px">Names</div>
     <div class=lvgrid style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:4px">${nameInputs}</div></div>
    <div class=card>
     <div class=subtabs>
      <button data-sub=chars class=on>Characters (${live.length})</button>
      <button data-sub=party>Party</button>
      <button data-sub=items>Inventory (${invCount})</button></div>
     <div class=row style="margin-bottom:8px;align-items:center">
      <input class=search id=sq placeholder="filter…">
      <label class=hint style="flex-direction:row;align-items:center;gap:6px;cursor:pointer">
       <input type=checkbox id=savebak checked> Back up card (.bak) first</label>
      <button class=act id=savewrite style=margin-left:auto disabled>Write to card</button>
      <span class=hint id=savemsg></span></div>
     <div class=hint id=subhint style="margin:-2px 0 8px"></div>
     <div id=subview></div></div>`;

  // equip slot labels (order matches s3save EQUIP_SLOTS)
  const EQ=[["headRune","Head Rune"],["rightRune","Right Rune"],["leftRune","Left Rune"],
            ["helm","Helm"],["armor","Armor"],["shield","Shield"],
            ["boots","Boots"],["gloves","Gloves"],["accessory","Accessory"]];
  const eqItemOpts=`<option value="0">— none —</option>`+SAVE_ITEMS.map(i=>
    `<option value="${i.id}">${i.id.toString(16).toUpperCase().padStart(3,'0')} · ${i.name}</option>`).join("");
  function drawChars(f=""){
   const numIn=(c,k,val,stat)=>`<input type=number value="${val}" data-ri=${c.rosterIndex}`+
     (stat?` data-stat=${stat}`:` data-k=${k}`)+` data-def="${val}">`;
   const pool=RECRUITED_ONLY?live:s.characters;
   const shown=pool.filter(c=>c.name.toLowerCase().includes(f)||String(c.rosterIndex)===f);
   // Per-character card: stats row (Lv/WpnLv/HP/MaxHP/EXP + 8 stats), then equipment,
   // then the 8 skill slots — all inline and always visible.
   const statHead=`<thead><tr><th>Lv</th><th>Wpn</th><th>HP</th><th>MaxHP</th><th>EXP→next</th>${statCols.map(n=>`<th>${n}</th>`).join("")}</tr></thead>`;
   const card=c=>`<div class=card style="margin:0 0 12px;padding:12px 14px">
      <div style="font-weight:600;font-size:15px;color:var(--acc2);margin-bottom:6px">${c.name}
        <span class=hint style=font-weight:400>#${c.rosterIndex}</span>
        ${c.recruited?'<span class="pill aoe" style=font-size:11px>recruited</span>':'<span class=pill style=font-size:11px>not recruited</span>'}</div>
      <div class=tablewrap><table class=savetbl>${statHead}<tbody><tr>
        <td>${numIn(c,"level",c.level)}</td><td>${numIn(c,"weaponLevel",c.weaponLevel)}</td>
        <td>${numIn(c,"curHP",c.curHP)}</td><td>${numIn(c,"maxHP",c.maxHP)}</td>
        <td>${numIn(c,"expToNext",c.expToNext)}</td>
        ${statCols.map(n=>`<td>${numIn(c,null,c.stats[n],n)}</td>`).join("")}
      </tr></tbody></table></div>
      <div class=hint style="margin:8px 2px 2px">Equipment</div>
      <div class=lvgrid style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:2px">
      ${EQ.map(([key,lbl])=>`<label class=hint style="flex-direction:column;gap:3px;align-items:stretch">${lbl}
        <select data-eqri=${c.rosterIndex} data-eq=${key} data-def="${c.equip[key]||0}">${eqItemOpts}</select></label>`).join("")}
      </div>
      <div class=hint style="margin:10px 2px 2px">Skills</div>
      <div class=lvgrid style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:2px">
      ${(c.skills||[]).map(sk=>`<div style="display:flex;flex-direction:column;gap:3px">
        <select data-skri=${c.rosterIndex} data-skslot=${sk.slot} data-skf=id data-def="${sk.id}">${skillOpts}</select>
        <label class=hint style="flex-direction:row;gap:4px;align-items:center">rank
          <input type=number min=0 max=15 style=width:52px value="${sk.rank}" data-skri=${c.rosterIndex} data-skslot=${sk.slot} data-skf=rank data-def="${sk.rank}"></label>
      </div>`).join("")}
      </div></div>`;
   $("#subview").innerHTML=shown.map(card).join("")||`<div class=hint>no characters</div>`;
   decorate($("#subview"));
   $("#subview").querySelectorAll("input[data-ri]").forEach(inp=>inp.addEventListener("change",()=>{
     const ri=+inp.dataset.ri,v=+inp.value;
     if(inp.dataset.stat)setEdit(ri,null,v,inp.dataset.stat);else setEdit(ri,inp.dataset.k,v);
     markSaveDirty();}));
   $("#subview").querySelectorAll("select[data-eq]").forEach(sel=>{
     setSel(sel,+sel.dataset.def);
     sel.addEventListener("change",()=>{
       const ri=+sel.dataset.eqri;EDITS[ri]=EDITS[ri]||{};EDITS[ri].equip=EDITS[ri].equip||{};
       EDITS[ri].equip[sel.dataset.eq]=+sel.value;markSaveDirty();});});
   $("#subview").querySelectorAll("[data-skf]").forEach(el=>{
     if(el.tagName==="SELECT")setSel(el,+el.dataset.def);
     const ev=el.tagName==="SELECT"?"change":"change";
     el.addEventListener(ev,()=>{setSkill(+el.dataset.skri,+el.dataset.skslot,el.dataset.skf,+el.value);markSaveDirty();});});}

  let INVCAT="regular";  // "regular" (consumables+equipment) or "key"
  // inv is now an array of bags: [{region, base, items:[...]}]. Early game these are the
  // separate Hugo/Chris/Geddoe/Thomas parties; late game most items sit in one bag +
  // Storage. Only bags that actually contain items are shown.
  function drawItems(f=""){
   const wantKey=INVCAT==="key";
   const bags=(inv||[]).map(bag=>{
     const items=bag.items.filter(it=>{
       if((it.category==="key")!==wantKey)return false;
       const nm=(ITEMNAME[it.id]||"").toLowerCase();
       return nm.includes(f)||String(it.slot)===f||it.id.toString(16).includes(f);});
     return {region:bag.region,items};}).filter(bag=>bag.items.length);
   const nKey=(inv||[]).reduce((a,bg)=>a+bg.items.filter(it=>it.category==="key").length,0);
   const nReg=(inv||[]).reduce((a,bg)=>a+bg.items.length,0)-nKey;
   const bagHTML=bag=>{
     const rows=bag.items.map(it=>
       `<tr><td class=hint>${it.slot}</td>
         <td><select data-invslot=${it.slot} data-k=id data-def="${it.id}">${itemOpts}</select></td>
         <td><input type=number data-invslot=${it.slot} data-k=qty data-def="${it.qty}" value="${it.qty}" style=width:70px></td>
         <td class=hint>${it.category}</td></tr>`).join("");
     return `<div style="margin-bottom:14px">
       <div style="font-weight:600;color:var(--acc2);margin:0 2px 6px">${bag.region} <span class=hint style=font-weight:400>${bag.items.length} item${bag.items.length>1?'s':''}</span></div>
       <div class=tablewrap><table class=savetbl>
       <thead><tr><th>Slot</th><th>Item</th><th>Qty</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;};
   $("#subview").innerHTML=`<div class=subtabs style="margin-bottom:10px">
      <button data-invcat=regular class="${wantKey?'':'on'}">Party Items (${nReg})</button>
      <button data-invcat=key class="${wantKey?'on':''}">Key / Valuables (${nKey})</button></div>
     <div class=hint style="margin:-2px 2px 10px">Early game, Hugo / Chris / Geddoe carry separate bags (they merge after the Flame Champion is chosen). Each bag is editable on its own.</div>
     ${bags.map(bagHTML).join("")||'<div class=hint>none</div>'}`;
   $("#subview").querySelectorAll("[data-invcat]").forEach(b=>b.onclick=()=>{INVCAT=b.dataset.invcat;drawItems($("#sq").value.toLowerCase());});
   $("#subview").querySelectorAll("select[data-invslot]").forEach(sel=>setSel(sel,+sel.dataset.def));
   decorate($("#subview"));
   $("#subview").querySelectorAll("[data-invslot]").forEach(inp=>{
     const ev=inp.tagName==="SELECT"?"change":"blur";
     inp.addEventListener(ev,()=>{const sl=+inp.dataset.invslot;INV[sl]=INV[sl]||{};INV[sl][inp.dataset.k]=+inp.value;markSaveDirty();});});}

  function drawParty(){
   const mem=s.party||[];
   const rows=mem.map((cid,slot)=>`<tr><td class=hint>Slot ${slot+1}</td>
     <td><select data-partyslot=${slot} data-def="${cid}">${charOpts}</select></td>
     <td class=hint>${CHARBY[cid]||(cid?('id '+cid+' (guest/NPC)'):'—')}</td></tr>`).join("");
   $("#subview").innerHTML=`<div class=tablewrap><table class=savetbl>
     <thead><tr><th>Party</th><th>Character</th><th>Current</th></tr></thead><tbody>${rows}</tbody></table></div>`;
   $("#subview").querySelectorAll("select[data-partyslot]").forEach(sel=>{
     setSel(sel,+sel.dataset.def);
     sel.addEventListener("change",()=>{PARTY[+sel.dataset.partyslot]=+sel.value;markSaveDirty();});});
   decorate($("#subview"));}
  function showSub(){
   $("#slotbody").querySelectorAll("[data-sub]").forEach(b=>b.classList.toggle("on",b.dataset.sub===SUB));
   $("#sq").value="";
   if(SUB==="chars"){
    $("#subhint").innerHTML=`Each character shows stats, equipped runes/armor, and skill slots inline. Stat labels are a best-effort decode (one slot is unused in-game). A .bak is made first; after writing, load the save in-game and resave.
     &nbsp;<label style="cursor:pointer"><input type=checkbox id=reconly ${RECRUITED_ONLY?'checked':''}> recruited only</label>`;
    drawChars();
    const rc=$("#reconly");if(rc)rc.onchange=()=>{RECRUITED_ONLY=rc.checked;drawChars($("#sq").value.toLowerCase());};}
   else if(SUB==="party"){$("#subhint").innerHTML=`Active battle party (up to 6). Pick who fills each slot. Changing this swaps the in-field party; leave story-required leaders in place to avoid soft-locks. A .bak is made first.`;drawParty();}
   else{$("#subhint").innerHTML=`Party + storage items (id · quantity). Change an item or its count. Only non-empty slots are shown. A .bak is made first.`;drawItems();}}
  $("#slotbody").querySelectorAll("[data-sub]").forEach(b=>b.onclick=()=>{SUB=b.dataset.sub;showSub();});
  $("#sq").oninput=e=>{const f=e.target.value.toLowerCase();
    if(SUB==="chars")drawChars(f);else if(SUB==="items")drawItems(f);else drawParty();};
  // editable name fields (in the meta card, not #subview — decorate + wire directly)
  decorate($("#slotbody"));
  $("#slotbody").querySelectorAll("input[data-name]").forEach(inp=>inp.addEventListener("change",()=>{
    NAMES[inp.dataset.name]=inp.value;markSaveDirty();}));
  showSub();

  $("#savewrite").onclick=async()=>{
   if(!dirty()){toast("no edits");return;}
   $("#savemsg").textContent="writing…";
   const res=await api("/api/save-write",{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({path:SAVE_CARD,folder:s.folder,edits:EDITS,invEdits:INV,nameEdits:NAMES,partyEdits:PARTY,backup:$("#savebak").checked})});
   if(res.ok){$("#savemsg").innerHTML=`wrote ${res.changed} field(s), ${res.clustersWritten} clusters · checksum 0x${res.checksum.toString(16).toUpperCase()}`;
    toast("saved to card");openCard(SAVE_CARD);}
   else{$("#savemsg").textContent="error: "+(res.error||"?");toast("write failed");}
  };
 }
 body.querySelectorAll("[data-slot]").forEach(b=>b.onclick=()=>drawSlot(+b.dataset.slot));
 drawSlot(0);
}
boot();
</script></body></html>"""


def main():
    # Optional args: [iso_path] [port], both positional and order-flexible.
    args = sys.argv[1:]
    port = 8747
    path = None
    for a in args:
        if a.isdigit():
            port = int(a)
        else:
            path = a
    if path:
        ok, msg = open_iso(path)
        if not ok:
            print(f"warning: {msg}\nStart anyway — pick an ISO in the browser.", flush=True)
    url = f"http://127.0.0.1:{port}/"
    if ISO_PATH:
        print(f"Suikoden III editor serving {os.path.basename(ISO_PATH)}", flush=True)
    else:
        print("Suikoden III editor started — select an ISO in the browser.", flush=True)
    print(f"Open: {url}   (Ctrl+C to stop)", flush=True)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    # open the browser from a background thread so a slow/hung opener can't
    # block the server from accepting connections
    if os.environ.get("S3_NO_BROWSER") != "1":
        import threading
        threading.Thread(target=lambda: webbrowser.open(url), daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
