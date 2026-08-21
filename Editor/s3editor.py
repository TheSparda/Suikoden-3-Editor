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


def pick_file_dialog(kind="card"):
    """Open a native OS file-open dialog on the server machine and return the chosen
    path. The server runs locally, so this dialog appears on the user's own desktop.
    macOS uses AppleScript (osascript); other platforms fall back to tkinter. Returns
    {"path": "..."} on choose, {"cancelled": True} if dismissed, or {"error": ...}."""
    # kind: "card" (card-only), "save" (card/.psu/raw gamedata), "iso" (game disc image)
    ISO_EXTS = (".iso", ".bin", ".img")
    CARD_EXTS = (".ps2", ".mcd", ".mc2", ".bin")   # memory-card formats scan_memcards accepts
    if kind == "iso":
        title = "Select a Suikoden III ISO"
        mac_types = '{"iso","bin","img"}'
        tk_types = [("Disc images", "*.iso *.bin *.img"), ("All files", "*.*")]
        guard_exts = ISO_EXTS
    elif kind == "recipe":
        title = "Select a .s3mod recipe"
        mac_types = ''                              # .s3mod has no OS-registered UTI
        tk_types = [("Mod recipes", "*.s3mod *.json"), ("All files", "*.*")]
        guard_exts = (".s3mod", ".json")
    elif kind == "patch":
        title = "Select an xdelta patch"
        mac_types = ''
        tk_types = [("xdelta patches", "*.xdelta *.vcdiff"), ("All files", "*.*")]
        guard_exts = (".xdelta", ".vcdiff")
    elif kind == "save":
        title = "Select a PS2 save (card, .psu, .cbs, .sps/.xps, .psv, or gamedata)"
        mac_types = ''                              # unrestricted: raw gamedata is extensionless
        tk_types = [("PS2 saves", "*.ps2 *.mcd *.mc2 *.bin *.psu *.cbs *.sps *.xps *.psv"),
                    ("All files", "*.*")]
        guard_exts = None                           # server sniffs; accept anything
    else:                                           # "card"
        title = "Select a PS2 memory card"
        mac_types = '{"ps2","mcd","mc2","bin"}'
        tk_types = [("PS2 memory cards", "*.ps2 *.mcd *.mc2 *.bin")]
        guard_exts = CARD_EXTS
    def _guard(path):
        # Defense in depth: reject a wrong extension even if the dialog filter is bypassed.
        if guard_exts and path and not path.lower().endswith(guard_exts):
            return {"error": f"expected one of {', '.join(guard_exts)}"}
        return {"path": path}
    try:
        if sys.platform == "darwin":
            import subprocess
            typeclause = f' of type {mac_types}' if mac_types else ''
            script = f'set f to choose file with prompt "{title}"{typeclause}\nPOSIX path of f'
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=300)
            out = r.stdout.strip()
            if r.returncode != 0 or not out:
                return {"cancelled": True}
            return _guard(out)
        # Windows / Linux: tkinter's native file chooser
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
        path = filedialog.askopenfilename(title=title, filetypes=tk_types)
        root.update(); root.destroy()
        return _guard(path) if path else {"cancelled": True}
    except Exception as e:
        return {"error": f"no native file dialog available: {e}"}

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

def _staged_bytes_map():
    """Merge the on-disk recipe journal (already-saved edits) with the live PENDING
    staging buffer into {offset: [oldByte, newByte]} — so a recipe can be exported from
    staged edits WITHOUT first writing them to the multi-GB ISO. For a staged offset, the
    'old' byte is read straight from disk (PENDING hasn't touched the file yet)."""
    import json
    bm = {}
    try:
        raw = json.load(open(ISO_PATH + ".s3mod.json")).get("bytes", {})
        bm = {int(k): [v[0], v[1]] for k, v in raw.items()}
    except Exception:
        bm = {}
    if PENDING:
        iso = S.Iso(ISO_PATH)
        try:
            for off, newb in PENDING.items():
                if off in bm:
                    bm[off][1] = newb                    # keep original 'old', update 'new'
                else:
                    bm[off] = [iso.rd(off, 1)[0], newb]  # 'old' = current on-disk byte
        finally:
            iso.close()
    return {o: v for o, v in bm.items() if v[0] != v[1]}   # drop no-ops

def _staged_recipe(note=""):
    """Coalesce the merged staged+journal byte map into a portable .s3mod recipe dict."""
    bm = _staged_bytes_map()
    if not bm:
        return None
    runs = []
    for off, (old, new) in sorted(bm.items()):
        if runs and off == runs[-1]["_end"]:
            r = runs[-1]; r["old"] += "%02x" % old; r["new"] += "%02x" % new; r["_end"] += 1
        else:
            runs.append({"off": off, "old": "%02x" % old, "new": "%02x" % new, "_end": off + 1})
    for r in runs:
        r.pop("_end")
    with S.Iso(ISO_PATH) as g:
        vword = struct.unpack(">I", g.rd(S.VERSION_CHECK_OFF, 4))[0]
    return {"format": "s3mod", "version": 1, "game": "SLUS-20387",
            "versionWord": vword, "note": note, "patchCount": len(runs), "patches": runs}

def _load_names():
    try:
        return F.res_json("s3_names.json")
    except Exception:
        return {}
CHAR_NAMES = _load_names()   # {"list1": {"1":"Hugo",...}, ...} from the original exe

def _load_skill_desc():
    try:
        return F.res_json("s3_skill_desc.json")
    except Exception:
        return {}
SKILL_DESC = _load_skill_desc()   # {skill name: description} from Suikosource skills guide

def _load_item_desc():
    try:
        return {int(k): v for k, v in F.res_json("s3_item_desc.json").items()}
    except Exception:
        return {}
ITEM_DESC = _load_item_desc()   # {item id: description} from the ISO's equipment record table

def _load_weapon_chars():
    try:
        return F.res_json("s3_weapon_chars.json")
    except Exception:
        return {"byIndex": {}, "families": {}}
# {weaponIndex: {family, fighters:[...]}} — mapped by matching each list4 ATK curve
# to Suikosource's weapon-growth guide (exact ATK-value match; 28/28 confirmed).
WEAPON_CHARS = _load_weapon_chars()

def _load_rune_owner():
    try:
        return F.res_json("s3_rune_owner.json")
    except Exception:
        return {}
RUNE_OWNER = _load_rune_owner()   # {rune-attack spell name: owning character / weapon type}

def _load_unite_chars():
    try:
        return {int(k): v.get("chars", "") for k, v in F.res_json("s3_unite_chars.json").items()}
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
        # element lives one record ahead (see SPELL_ELEM_OFF); last record has no i+1
        kind = iso.u16(off + S.SPELL_ELEM_OFF) if i + 1 < S.SPELL_COUNT else 0
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
    # a couple of desc strings are SHARED between items (e.g. Wooden/Iron Shield):
    # map ptr -> [item ids] so the UI can warn that editing one edits both.
    _ptr_ids = {}
    for iid, off in offs.items():
        p = struct.unpack_from("<I", iso.rd(off, 4), 0)[0]
        _ptr_ids.setdefault(p, []).append(iid)
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
        dptr = struct.unpack_from("<I", rec, 0)[0]
        try:   # capacity = the ON-DISK string length (staged shorter text doesn't shrink it)
            dmax = len(iso.disk_rd(S.va2off(dptr), 160).split(b"\x00")[0])
        except Exception:
            dmax = 0
        out.append({
            "id": iid, "name": items.get(iid, f"0x{iid:X}"),
            "desc": _desc_at(iso, dptr),
            "descMax": dmax,
            "sharedWith": [items.get(x, f"0x{x:X}") for x in _ptr_ids.get(dptr, []) if x != iid],
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
    result = {"ok": True}
    if "desc" in fields:
        # Custom description: user-typed text written over the original string, padded with
        # NULs. Capped to the ON-DISK slot length (writing longer is rejected, not truncated).
        try:
            dptr = struct.unpack_from("<I", iso.rd(off + 0x00, 4), 0)[0]
            doff = S.va2off(dptr)
            maxlen = len(iso.disk_rd(doff, 160).split(b"\x00")[0])
            enc = str(fields["desc"]).encode("latin1", "replace")
            if len(enc) > maxlen:
                iso.close()
                return {"error": f"description too long: {len(enc)} chars, slot holds {maxlen}"}
            iso.wr(doff, enc + b"\x00" * (maxlen - len(enc)))
            result["newDesc"] = enc.decode("latin1")
            result["descMax"] = maxlen
        except Exception as e:
            iso.close(); return {"error": f"desc write failed: {e}"}
    if fields.get("updateDesc") and "def" in fields:
        # Best-effort: rewrite the "DEF(+N)" figure in the gear's description to match the
        # new DEF. Capped to the original string length (leaves text + flags if it would
        # overflow, same rule as Foods/Spells). Gear desc ptr is at record +0x00.
        import re
        newdef = int(fields["def"]) & 0xFFFF
        try:
            dptr = struct.unpack_from("<I", iso.rd(off + 0x00, 4), 0)[0]
            doff = S.va2off(dptr)
            orig = iso.rd(doff, 160).split(b"\x00")[0]
            maxlen = len(orig)
            text = orig.decode("latin1", "replace")
            if re.search(r"DEF\(\+?\d+\)", text):
                new = re.sub(r"DEF\(\+?\d+\)", f"DEF(+{newdef})", text, count=1)
            else:
                new = text
                result["descNoNumber"] = True   # no "DEF(+N)" token in this item's text
            if new != text:
                enc = new.encode("latin1", "replace")
                if len(enc) > maxlen:
                    result["descTruncated"] = True
                else:
                    iso.wr(doff, enc + b"\x00" * (maxlen - len(enc)))
                    result["descTruncated"] = False
                    result["newDesc"] = new
        except Exception as e:
            result["descError"] = str(e)
    iso.close(); return result

def read_foods():
    iso = _iso()
    foods = S.find_food_records(iso)
    iso.close(); return foods

def write_food(index, fields):
    iso = _iso(write=True)
    if not (0 <= int(index) < S.FOOD_COUNT):
        iso.close(); return {"error": "food index out of range"}
    off = S.FOOD_TABLE_FILE + int(index) * S.FOOD_STRIDE
    if "heal" in fields:
        iso.wr(off + S.FOOD_HEAL_OFF, struct.pack("<H", _u(fields["heal"], 2)))
    if "proc" in fields:
        iso.wr(off + S.FOOD_PROC_OFF, struct.pack("<H", _u(fields["proc"], 2)))
    result = {"ok": True}
    if fields.get("updateDesc"):
        # Best-effort: rewrite the "Heals NNN HP" / "NN% chance" numbers in the item's
        # description string to match the new field values. Edited in place, capped to the
        # string's original byte length (longer text is truncated) — same rule as the Text tab.
        import re
        dptr = struct.unpack_from("<I", iso.rd(off + S.FOOD_DESC_OFF, 4), 0)[0]
        try:
            doff = S.va2off(dptr)
            raw = iso.rd(doff, 128)
            orig = raw.split(b"\x00")[0]
            maxlen = len(orig)                       # cannot grow past the original string
            text = orig.decode("latin1", "replace")
            if "heal" in fields:
                text = re.sub(r"Heals \d+HP", f"Heals {_u(fields['heal'], 2)}HP", text, count=1)
            if "proc" in fields:
                text = re.sub(r"\d+% chance", f"{_u(fields['proc'], 2)}% chance", text, count=1)
            enc = text.encode("latin1", "replace")
            if len(enc) > maxlen:
                # would overflow the original string slot: leave the description untouched
                # rather than write a truncated (garbled) line.
                result["descTruncated"] = True
            else:
                iso.wr(doff, enc + b"\x00" * (maxlen - len(enc)))
                result["descTruncated"] = False
        except Exception as e:
            result["descError"] = str(e)
    iso.close(); return result

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

# --- Editable in-ELF text (UI / battle / menu / description strings) -----------
# The boot ELF holds English text as null-terminated ASCII. We surface the clean,
# meaningful strings (battle messages, menu labels, lottery/prize text, error prompts,
# character blurbs) for in-place editing. Edits are capped to the ORIGINAL byte length
# (can't grow a string without repointing, which is unsafe), null-padded on the tail.
# NOTE: this does NOT include story dialogue — that lives in packed event files
# elsewhere on the disc, outside the ELF, and isn't editable here.
import re as _re
_TEXT_ELF_LO = 0xA3800
_TEXT_ELF_HI = 0x465DF0
_text_cache = None

def _looks_like_text(s):
    if len(s) < 8 or " " not in s:
        return False
    if _re.search(r"[%$/\\]|0x|->|::|_|[A-Za-z]\d|\d[A-Za-z]", s):
        return False
    if not any(c.islower() for c in s):
        return False
    ok = sum(c.isalpha() or c in " ,.'!?-@()" for c in s)
    return ok / len(s) > 0.9

def read_texts():
    """Scan the ELF for editable UI/text strings (disk bytes, not staged), returning
    {offset, max, value} — value overlays any staged edit so the UI shows current text."""
    global _text_cache
    iso = _iso()
    if _text_cache is None:
        blob = iso.disk_rd(_TEXT_ELF_LO, _TEXT_ELF_HI - _TEXT_ELF_LO)
        out = []
        cur = bytearray(); st = 0
        for i, b in enumerate(blob):
            if 32 <= b < 127:
                if not cur:
                    st = i
                cur.append(b)
            else:
                if cur:
                    s = cur.decode("latin1")
                    if _looks_like_text(s):
                        out.append({"off": _TEXT_ELF_LO + st, "max": len(cur)})
                    cur = bytearray()
        _text_cache = out
    # attach current (staged-overlaid) value for each string
    res = []
    for t in _text_cache:
        cur = iso.rd(t["off"], t["max"]).split(b"\x00")[0].decode("latin1", "replace")
        res.append({"off": t["off"], "max": t["max"], "value": cur})
    iso.close()
    return res

def write_text(off, value):
    """Write an edited string in place, capped to its original length, null-padded."""
    iso = _iso(write=True)
    # find the record to get its max length (from cache)
    rec = next((t for t in (_text_cache or []) if t["off"] == off), None)
    if rec is None:
        iso.close(); return {"error": "unknown text offset"}
    enc = str(value).encode("latin1", "replace")[:rec["max"]]
    enc = enc + b"\x00" * (rec["max"] - len(enc))
    iso.wr(off, enc)
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
    icats = S.load_item_categories()
    groups = []

    # map an equip-field label to the item categories that belong in that slot, so the
    # dropdown can be filtered (rune hands/head -> Runes, etc). Starting "Other item"
    # slots hold consumables, so they're left unfiltered (cats = None).
    def field_cats(label):
        l = label.lower()
        if l.startswith("rune "):  return ["Runes"]
        if l.startswith("helmet"): return ["Headgear"]
        if l.startswith("armor"):  return ["Armor"]
        if l.startswith("shield"): return ["Shields"]
        return None

    def field(label, off, width, kind, opts=None):
        pos = rec_off + off
        v = _read_val(iso, pos, width)
        name = ""
        if kind == "item":  name = items.get(v, "")
        elif kind == "skill": name = skills.get(v, "")
        d = {"label": label, "off": off, "width": width, "kind": kind,
             "value": v, "name": name}
        if kind == "item":
            d["cats"] = field_cats(label)          # None = allow all (e.g. starting items)
        if kind == "enum":
            d["opts"] = [{"v": ov, "label": ol} for ov, ol in (opts or [])]
        return d

    if list_no == 1:
        # "Skill N rank" fields are learned ranks (E..S); item/skill/count fields stay as-is.
        l1 = []
        for label, off, width, kind in F.LIST1:
            if kind == "num" and label.endswith("rank"):
                l1.append(field(label, off, width, "enum", F.SKILL_RANK_OPTS))
            else:
                l1.append(field(label, off, width, kind))
        groups.append({"title": "Starting Stats / Equipment",
                       "help": F.SKILL_RANK_HELP, "fields": l1})
    elif list_no == 2:
        groups.append({"title": "Growth Rates / Rune Levels", "help": "higher = faster growth",
                       "fields": [field(*f) for f in F.LIST2_GROWTH]})
        smax = []
        for k in range(43):
            sid = k + 1
            smax.append(field(skills.get(sid, f"Skill 0x{sid:02X}") + " max",
                              F.LIST2_SKILLMAX_START + k, 1, "enum", F.SKILL_MAX_OPTS))
        groups.append({"title": "Skill Maximum Levels", "help": F.SKILL_MAX_HELP, "fields": smax})
        # NOTE: "Skill N level learned" is the CHARACTER LEVEL a fixed skill is granted at
        # (observed 0,1,15,20,25,30,33,35,37,40 — NOT the E..S rank scale), so it stays a
        # plain number. Skill-id fields are skill-pickers; Free Skills / Starting level are counts.
        groups.append({"title": "Fixed Skills / Free Skills / Starting Level",
                       "help": "Fixed Skill = auto-granted skill; its \"level learned\" is the "
                               "character level it's granted at (0 = none).",
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
    if "elementId" in fields and index + 1 < S.SPELL_COUNT:
        # element byte is stored one record ahead (SPELL_ELEM_OFF); preserve its high byte
        kind = iso.u16(off + S.SPELL_ELEM_OFF)
        iso.wr(off + S.SPELL_ELEM_OFF,
               struct.pack("<H", (kind & 0xFF00) | (int(fields["elementId"]) & 0xFF)))
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
    result = {"ok": True}
    if fields.get("updateDesc") and "power" in fields:
        # Best-effort: rewrite the damage figure in the spell's description to match the new
        # power. Two forms occur in S3: absolute "NNNDMG" (number == power) and multiplier
        # "DMGxN.N" (N.N == power/100). Edited in place, capped to the original string length
        # (same rule as Foods / the Text tab); left untouched if it would overflow or has no
        # number (heals/buffs/status spells carry no numeric damage in their text).
        import re
        pw = _u(fields["power"], 4)
        try:
            dptr = struct.unpack_from("<I", iso.rd(off + 0x0C, 4), 0)[0]
            doff = S.va2off(dptr)
            orig = iso.rd(doff, 160).split(b"\x00")[0]
            maxlen = len(orig)
            text = orig.decode("latin1", "replace")
            if re.search(r"DMGx\d+(?:\.\d+)?", text):
                new = re.sub(r"DMGx\d+(?:\.\d+)?", f"DMGx{pw/100:g}", text, count=1)
            elif re.search(r"\d+DMG", text):
                new = re.sub(r"\d+DMG", f"{pw}DMG", text, count=1)
            else:
                new = text
                result["descNoNumber"] = True   # nothing to update in this spell's text
            if new != text:
                enc = new.encode("latin1", "replace")
                if len(enc) > maxlen:
                    result["descTruncated"] = True     # would overflow -> leave original
                else:
                    iso.wr(doff, enc + b"\x00" * (maxlen - len(enc)))
                    result["descTruncated"] = False
                    result["newDesc"] = new
        except Exception as e:
            result["descError"] = str(e)
    iso.close()
    return result

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
            if p == "/api/foods":   return self._send(200, read_foods())
            if p == "/api/shop":    return self._send(200, read_shop())
            if p == "/api/items":
                _ic = S.load_item_categories()
                return self._send(200,
                    [{"id": k, "name": v, "desc": ITEM_DESC.get(k, ""), "cat": _ic.get(k, "")}
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
            if p == "/api/texts":
                return self._send(200, read_texts())
            # --- Save editor (PS2 memory card) — independent of any ISO ----------
            if p == "/api/pick-file":
                # Open a native OS file dialog on the machine running the server so the
                # user can browse to a memory card anywhere on disk (not just nearby).
                return self._send(200, pick_file_dialog(q.get("kind", "card")))
            if p == "/api/savecards":
                roots = {_scan_root, os.path.abspath(os.path.join(_scan_root, "..")),
                         os.path.abspath(os.path.join(_scan_root, "Saves")),
                         os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
                         os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Saves"))}
                last = load_config().get("lastCard")
                roots = sorted(roots)
                return self._send(200, {"root": _scan_root, "lastCard": last,
                                        "cards": SV.scan_memcards(roots),
                                        "files": SV.scan_individual_saves(roots)})
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
                # item id->name so the UI can label inventory + offer an item picker;
                # 'cat' = item category (Runes/Headgear/Shields/...) for filtering equip slots
                _icats = S.load_item_categories()
                items = [{"id": k, "name": v, "desc": ITEM_DESC.get(k, ""), "cat": _icats.get(k, "")}
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
            if self.path == "/api/food":
                return self._send(200, write_food(int(body["index"]), body["fields"]))
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
            if self.path == "/api/text":
                return self._send(200, write_text(int(body["off"]), body["value"]))
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
                                          party_edits=body.get("partyEdits", {}),
                                          recruit_edits=body.get("recruitEdits", {}),
                                          gold=body.get("gold"))
                return self._send(200, res)
            if self.path == "/api/mod-status":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                saved = S.mod_status(ISO_PATH)                 # already written to the ISO
                total = len(_staged_bytes_map())               # staged + saved (exportable now)
                return self._send(200, {"bytes": total, "runs": saved["runs"],
                                        "savedBytes": saved["bytes"], "pending": len(PENDING),
                                        "xdelta": S.xdelta_available()})
            if self.path == "/api/mod-export":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                # Build the recipe from staged + already-saved edits — no need to write the ISO.
                mod = _staged_recipe(note=body.get("note", ""))
                if mod is None:
                    return self._send(200, {"error": "no edits to export yet — make some changes first"})
                out = ISO_PATH + ".s3mod"
                with open(out, "w") as fp:
                    json.dump(mod, fp, indent=1)
                return self._send(200, {"ok": True, "path": out,
                                        "patchCount": mod["patchCount"]})
            if self.path == "/api/mod-apply":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                if PENDING:
                    return self._send(200, {"error": "you have unsaved edits — Save or Revert before applying a recipe"})
                recipe = body.get("recipe", "")
                if not os.path.isfile(recipe):
                    return self._send(200, {"error": f"recipe not found: {recipe}"})
                try:
                    mod = json.load(open(recipe))
                    res = S.apply_mod(ISO_PATH, mod, make_backup=_backup_enabled)
                except (ValueError, KeyError) as e:
                    return self._send(200, {"error": str(e)})
                res["ok"] = True
                return self._send(200, res)
            if self.path == "/api/mod-clear":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                return self._send(200, {"ok": True, "cleared": S.clear_mod(ISO_PATH)})
            if self.path == "/api/xdelta-make":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                if not S.xdelta_available():
                    return self._send(200, {"error": "xdelta3 not installed (macOS: brew install xdelta)"})
                pristine = body.get("pristine", "")
                if not os.path.isfile(pristine):
                    return self._send(200, {"error": f"pristine ISO not found: {pristine}"})
                out = ISO_PATH + ".xdelta"
                try:
                    n = S.make_xdelta(pristine, ISO_PATH, out)
                except RuntimeError as e:
                    return self._send(200, {"error": str(e)})
                return self._send(200, {"ok": True, "path": out, "size": n})
            if self.path == "/api/xdelta-apply":
                if not S.xdelta_available():
                    return self._send(200, {"error": "xdelta3 not installed (macOS: brew install xdelta)"})
                pristine = body.get("pristine", "")
                patch = body.get("patch", "")
                out = body.get("out", "")
                if not os.path.isfile(pristine):
                    return self._send(200, {"error": f"pristine ISO not found: {pristine}"})
                if not os.path.isfile(patch):
                    return self._send(200, {"error": f"patch not found: {patch}"})
                if not out:
                    out = pristine + ".patched.iso"
                try:
                    n = S.apply_xdelta(pristine, patch, out)
                except RuntimeError as e:
                    return self._send(200, {"error": str(e)})
                return self._send(200, {"ok": True, "path": out, "size": n})
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
/* "Other" hover dropdown: open on hover or keyboard focus-within */
.navgroup{position:relative;display:inline-flex}
.navmenu{position:absolute;top:100%;left:0;min-width:150px;display:none;flex-direction:column;gap:2px;
 padding:6px;background:var(--panel);border:1px solid var(--line);border-radius:8px;
 box-shadow:0 8px 24px rgba(0,0,0,.35);z-index:40}
.navgroup:hover .navmenu,.navgroup:focus-within .navmenu{display:flex}
.navgroup:has(.navtrig:disabled) .navmenu{display:none!important}
.navmenu button{width:100%;text-align:left}
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
button.act.mini{padding:3px 9px;font-size:12px}
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
/* opt-in checkbox pill (Foods "update description", etc.) */
.optchk{display:inline-flex;align-items:center;gap:9px;cursor:pointer;font-size:13px;
 padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);
 user-select:none;transition:border-color .12s,background .12s}
.optchk:hover{border-color:var(--acc);background:var(--panel2)}
.optchk input{width:16px;height:16px;margin:0;accent-color:var(--acc);cursor:pointer;flex:none}
.optchk .hint{margin:0}
tr.descrow td{border-bottom:1px solid var(--line);padding-top:0}
tr.descrow .desc{color:var(--mut);font-size:12px;font-style:italic;padding:0 9px 8px}
tr.mainrow td{border-bottom:0}
/* changed-from-default field highlighting + restore button */
input.changed,select.changed{color:var(--warn);border-color:var(--warnbd);background:var(--changed-bg)}
td.warn,.warn{color:var(--warn)}
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
#themebar .credit{margin-left:auto;color:var(--mut)}
#themebar .credit a{color:var(--acc2);text-decoration:none}
#themebar .credit a:hover{text-decoration:underline}
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
 <span class=credit>Made by <b>Sparda</b> ·
  <a href="https://github.com/TheSparda/Suikoden-3-Editor" target=_blank rel="noopener noreferrer">GitHub</a>
  · <span class=hint>v1.1.4</span></span>
</footer>
<div id=toast></div>
<script>
const $=s=>document.querySelector(s), api=(u,o)=>fetch(u,o).then(r=>r.json());
let META={}, TAB="characters", DIRTY=false;
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
 const TAB_LABEL={spells:"Spells",runes:"Runes",unites:"Unites",gear:"Gear",weapons:"Weapons",foods:"Foods",shop:"Shop",characters:"Characters",text:"Text",hardmode:"Hard Mode",enemies:"Enemies",reference:"Reference",patch:"Share / Patch",saves:"Save Editor"};
 // top-level bar; "Other" is a hover dropdown holding the less-used tabs
 const topTabs=["characters","spells","runes","unites","gear","weapons","hardmode"];
 const otherTabs=["foods","shop","enemies","text","reference","patch"];
 const btn=t=>`<button data-t="${t}">${TAB_LABEL[t]}</button>`;
 window.OTHER_TABS=otherTabs;
 $("#nav").innerHTML=
   topTabs.map(btn).join("")
   +`<div class=navgroup id=navother><button type=button class=navtrig data-group=other>Other ▾</button>`
   +`<div class=navmenu>${otherTabs.map(btn).join("")}</div></div>`
   +btn("saves");
 document.querySelectorAll("#nav button[data-t]").forEach(b=>b.onclick=()=>{
   if(b.disabled)return;TAB=b.dataset.t;render();});
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
function setTabsEnabled(on){document.querySelectorAll("#nav button[data-t]").forEach(b=>{
 b.disabled=(b.dataset.t==="saves")?false:!on;});
 const trig=document.querySelector("#nav .navtrig");if(trig)trig.disabled=!on;}
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
  <div class=row style=margin-top:14px;align-items:flex-end>
   <button class=act id=isobrowse>Browse…</button>
   <label style=flex:1>Or enter full path
   <input id=isopath style=width:100% placeholder="/full/path/to/Suikoden III (USA).iso" value="${META.lastIso?String(META.lastIso).replace(/"/g,"&quot;"):""}"></label>
   <button class=act id=openpath>Open</button></div>
  <div id=isoerr class=hint style=color:#e88></div></div>`;
 async function open(path){const r=await api("/api/open",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({path})});
  if(r.ok){META=await api("/api/meta");
   setTabsEnabled(true);renderIsoHeader();
   TAB="characters";render();toast("loaded "+r.iso);}
  else{$("#isoerr").textContent=r.error;}}
 m.querySelectorAll("[data-path]").forEach(b=>b.onclick=()=>open(decodeURIComponent(b.dataset.path)));
 $("#openpath").onclick=()=>open($("#isopath").value.trim());
 $("#isobrowse").onclick=async()=>{
   $("#isoerr").textContent="";
   const r=await api("/api/pick-file?kind=iso");
   if(r.path){$("#isopath").value=r.path;open(r.path);}
   else if(r.error)$("#isoerr").textContent=r.error;};
 if($("#openlast"))$("#openlast").onclick=()=>open(META.lastIso);}
function setActive(clear){document.querySelectorAll("#nav button[data-t]").forEach(b=>b.classList.toggle("on",!clear&&b.dataset.t===TAB));
 const trig=document.querySelector("#nav .navtrig");
 if(trig)trig.classList.toggle("on",!clear&&(window.OTHER_TABS||[]).includes(TAB));}
async function render(){
 // Save Editor is ISO-independent — allow it with no ISO loaded.
 if(TAB==="saves"){setActive();const m=$("#main");m.innerHTML=spinner();return renderSaves(m);}
 if(!META.loaded)return pickIso();setActive();const m=$("#main");m.innerHTML=spinner();
 if(TAB==="spells")return renderSpells(m);
 if(TAB==="runes")return renderRunes(m);
 if(TAB==="unites")return renderUnites(m);
 if(TAB==="gear")return renderGear(m);
 if(TAB==="foods")return renderFoods(m);
 if(TAB==="weapons")return renderWeapons(m);
 if(TAB==="shop")return renderShop(m);
 if(TAB==="characters")return renderChars(m);
 if(TAB==="hardmode")return renderHardMode(m);
 if(TAB==="enemies")return renderEnemies(m);
 if(TAB==="reference")return renderRef(m);
 if(TAB==="text")return renderText(m);
 if(TAB==="patch")return renderPatch(m);
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
 const elOpts=Object.entries(META.elements).map(([id,n])=>`<option value="${id}">${id} — ${n}</option>`).join("");
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

 m.innerHTML=`<div class=row style="margin-bottom:12px;align-items:center;gap:10px"><input class=search id=q placeholder="filter spells…">
  <label class=optchk><input type=checkbox id=syncdesc checked> also update the DMG figure in the description</label>
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
    if(f==="power"&&$("#syncdesc")&&$("#syncdesc").checked)fields.updateDesc=true;
    const r=await api("/api/spell",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({index:idx,fields})});
    if(r.ok)markDirty();toast(r.ok?(r.descTruncated?"staged (desc too long — left as-is)":"staged"):"error: "+(r.error||"?"));
    if(r.ok&&f==="power"&&r.newDesc){ // live-update the spell's description row
     const tr=inp.closest("tr"), drow=tr.nextElementSibling;
     if(drow&&drow.classList.contains("descrow")){const c=drow.querySelector(".desc");if(c)c.textContent=r.newDesc;}
     const s=sp.find(x=>x.index===idx);if(s)s.desc=r.newDesc;
    }
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
 const elOpts=Object.entries(META.elements).map(([id,n])=>`<option value="${id}">${id} — ${n}</option>`).join("");
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
 m.innerHTML=`<div class=row style="margin-bottom:12px;align-items:center;gap:10px"><input class=search id=q placeholder="filter gear…">
  <label class=optchk><input type=checkbox id=gupd checked> also update DEF in the description</label>
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
    <div class=row style="margin-bottom:6px;align-items:center">
     <label style="flex:1 1 auto">Description
      <input type=text style="width:100%;max-width:520px" maxlength=${g.descMax} data-id=${g.id} data-k=desc value="${(g.desc||'').replace(/"/g,'&quot;')}"></label>
     <span class=hint data-descleft=${g.id}>${g.descMax-(g.desc||'').length} left</span>
     ${(g.sharedWith&&g.sharedWith.length)?`<span class="hint warn">shared with ${g.sharedWith.join(", ")} — editing changes both</span>`:""}
    </div>
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
  // live remaining-space counter for the custom description inputs
  $("#gl").querySelectorAll('input[data-k=desc]').forEach(di=>di.addEventListener("input",()=>{
   const left=$(`#gl [data-descleft="${di.dataset.id}"]`);
   if(left)left.textContent=(+di.maxLength-di.value.length)+" left";}));
  decorate($("#gl"));}
 async function saveGear(inp){
  const id=+inp.dataset.id;const k=inp.dataset.k;const fields={};
  if(k==="def"){fields.def=+inp.value; if($("#gupd")&&$("#gupd").checked)fields.updateDesc=true;}
  else if(k==="desc")fields.desc=inp.value;
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
  if(r.ok)markDirty();toast(r.ok?(r.descTruncated?"staged (desc too long — left as-is)":"staged"):"error: "+(r.error||"?"));
  if(r.ok&&r.newDesc){const span=inp.closest(".card")?.querySelector("h3 .hint");if(span)span.textContent=r.newDesc;
   const di=inp.closest(".card")?.querySelector('input[data-k=desc]');if(di&&k!=="desc")di.value=r.newDesc;}}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

async function renderFoods(m){
 const foods=await api("/api/foods");
 const fdef=await api("/api/foods?disk=1");const FDEF={};fdef.forEach(f=>FDEF[f.index]={heal:f.heal,proc:f.proc});
 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter foods / medicines…">
  <span class=hint>Consumables (foods, medicines, stat stones). Edit <b>Heal HP</b> and the
   <b>status proc chance %</b>. Which status a food inflicts/cures isn't editable yet. Saves on change.</span></div>
  <label class=optchk for=fupd style="margin-bottom:12px">
   <input type=checkbox id=fupd>
   <span>Also update description text to match
    <span class=hint style=font-weight:400>— best-effort &amp; length-capped; an over-long number leaves the original text intact</span></span></label>
  <table><thead><tr><th>#</th><th>Name</th><th style=width:110px>Heal HP</th><th style=width:110px>Proc %</th><th>Description</th></tr></thead><tbody id=fb></tbody></table>`;
 const ORIG={};foods.forEach(x=>ORIG[x.index]=x.desc||"");   // on-disk description per food
 // Mirror the server's best-effort rewrite: swap the "Heals NNN HP" / "NN% chance" numbers.
 // Returns {text, fits} — fits=false when it would overflow the original byte length.
 function previewDesc(idx,heal,proc){
  let t=ORIG[idx];
  if(heal!=null&&!Number.isNaN(heal))t=t.replace(/Heals \d+HP/, "Heals "+heal+"HP");
  if(proc!=null&&!Number.isNaN(proc))t=t.replace(/\d+% chance/, proc+"% chance");
  return {text:t, fits:t.length<=ORIG[idx].length};
 }
 function curVals(idx){
  const h=$(`#fb input[data-i="${idx}"][data-k=heal]`), p=$(`#fb input[data-i="${idx}"][data-k=proc]`);
  return {heal:h?+h.value:null, proc:p?+p.value:null};
 }
 function refreshDesc(idx){
  const cell=$(`#fb [data-descfor="${idx}"]`); if(!cell)return;
  if(!$("#fupd").checked){cell.textContent=ORIG[idx];cell.classList.remove("warn");return;}
  const {heal,proc}=curVals(idx); const pv=previewDesc(idx,heal,proc);
  if(pv.fits){cell.textContent=pv.text;cell.classList.remove("warn");}
  else{cell.textContent=ORIG[idx]+"  (new text won't fit — will stay unchanged)";cell.classList.add("warn");}
 }
 function draw(f=""){
  const rows=foods.filter(x=>x.name.toLowerCase().includes(f)||(x.desc||"").toLowerCase().includes(f));
  $("#fb").innerHTML=rows.map(x=>{const d=FDEF[x.index]||x;return `<tr>
    <td class=hint>${x.index}</td><td>${x.name}</td>
    <td><input type=number min=0 max=65535 style=width:90px data-i=${x.index} data-k=heal data-def="${d.heal}" value="${x.heal}"></td>
    <td><input type=number min=0 max=100 style=width:90px data-i=${x.index} data-k=proc data-def="${d.proc}" value="${x.proc}"></td>
    <td class=hint data-descfor=${x.index}>${(x.desc||"").replace(/</g,"&lt;")}</td></tr>`;}).join("");
  decorate($("#fb"));
  $("#fb").querySelectorAll("input[data-i]").forEach(inp=>{
    const idx=+inp.dataset.i;
    inp.addEventListener("input",()=>refreshDesc(idx));   // live preview as you type
    inp.addEventListener("blur",async()=>{
     const fields={};fields[inp.dataset.k]=+inp.value;
     if($("#fupd").checked)fields.updateDesc=true;
     const r=await api("/api/food",{method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({index:idx,fields})});
     if(r.ok){markDirty();refreshDesc(idx);
      toast(fields.updateDesc&&r.descTruncated?"staged (description too long — text left unchanged)":"staged");}
     else toast("error: "+(r.error||"?"));});});}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());
 // toggling the checkbox re-previews every visible row
 $("#fupd").addEventListener("change",()=>$("#fb").querySelectorAll("[data-descfor]").forEach(c=>refreshDesc(+c.dataset.descfor)));}

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
 function nameOpts(listKey,filter){
  const map=NAMES[listKey]||{};
  let entries=Object.entries(map).sort((a,b)=>(+a[0])-(+b[0]));
  if(!entries.length)return `<option value="1">(index 1)</option>`;
  const f=(filter||"").trim().toLowerCase();
  if(f)entries=entries.filter(([i,n])=>n.toLowerCase().includes(f)
     ||String(i)===f||(+i).toString(16).toLowerCase()===f);
  if(!entries.length)return `<option value="">(no match)</option>`;
  return entries.map(([i,n])=>`<option value="${i}">${(+i).toString().padStart(3,'0')} — ${n}</option>`).join("");
 }
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Character editor</h3>
 <div class=hint>Names are from the original exe's list. list1 = Starting Stats, list2 = Growth (same roster),
 list3 = Support characters, list4 = weapon attack types. Equipment/rune/skill fields are dropdowns. Saves on change.</div>
 <div class=row>
  <label>Search<input class=search id=csearch placeholder="name or id (hex/dec)…" style=width:200px></label>
  <label>Character<select id=idx style=min-width:200px>${nameOpts("list1")}</select></label>
  <label>Data section<select id=list>${Object.entries(LIST_NAMES).map(([k,v])=>`<option value="${k}">${k} — ${v}</option>`).join("")}</select></label>
  <button class=act id=load>Reload</button>
  <span class=hint id=addr></span>
 </div><div id=rec></div></div>`;
 // filter the character dropdown by name / id; keep the current pick if it still matches
 function refilter(){
  const cur=$("#idx").value;
  $("#idx").innerHTML=nameOpts("list"+$("#list").value,$("#csearch").value);
  const opts=[...$("#idx").options].map(o=>o.value);
  if(opts.includes(cur))$("#idx").value=cur;
  if($("#idx").value&&$("#idx").value!==cur)load();}
 $("#csearch").oninput=refilter;
 // when the section changes: repopulate the name dropdown for that list AND reload
 $("#list").onchange=()=>{$("#idx").innerHTML=nameOpts("list"+$("#list").value,$("#csearch").value);load();};
 // item options filtered to a slot's categories (f.cats); null/absent = all items.
 // The currently-set item is always included so an off-category value is never lost.
 const optTag=i=>`<option value="${i.id}" title="${(i.desc||'').replace(/"/g,'&quot;')}">${i.id.toString(16).toUpperCase().padStart(3,'0')} · ${i.name}</option>`;
 function itemOptsFor(cats,curId){
  if(!cats||!cats.length)return itemOpts;
  let list=ITEMS_CACHE.filter(i=>cats.includes(i.cat));
  if(curId&&!list.some(i=>i.id===curId)){const cur=ITEMS_CACHE.find(i=>i.id===curId);if(cur)list=[cur,...list];}
  return `<option value="0">— none (0) —</option>`+list.map(optTag).join("");
 }
 function fieldEditor(f){
  const dv=(f.def!==undefined?f.def:f.value);
  if(f.kind==="item")  return `<select data-off=${f.off} data-w=${f.width} data-kind=item data-def="${dv}">${itemOptsFor(f.cats,f.value)}</select>`;
  if(f.kind==="skill") return `<select data-off=${f.off} data-w=${f.width} data-kind=skill data-def="${dv}">${skillOpts}</select>`;
  if(f.kind==="enum")  return `<select data-off=${f.off} data-w=${f.width} data-kind=enum data-def="${dv}">${(f.opts||[]).map(o=>`<option value="${o.v}">${o.label}</option>`).join("")}</select>`;
  return `<input type=number min=0 value="${f.value}" data-off=${f.off} data-w=${f.width} data-def="${dv}">`;
 }
 const enumLabel=(f,v)=>{const o=(f.opts||[]).find(o=>o.v===+v);return o?o.label:("= "+v);};
 async function load(){
  const L=+$("#list").value, IX=+$("#idx").value;
  const c=await api(`/api/charfields?list=${L}&index=${IX}`);
  const cd=await api(`/api/charfields?list=${L}&index=${IX}&disk=1`);
  const DEFOFF={};cd.groups.forEach(g=>g.fields.forEach(f=>DEFOFF[f.off]=f.value));
  c.groups.forEach(g=>g.fields.forEach(f=>{if(DEFOFF[f.off]!==undefined)f.def=DEFOFF[f.off];}));
  $("#addr").textContent=`addr 0x${c.addr.toString(16).toUpperCase()} · stride ${c.stride}`;
  let h="";
  c.groups.forEach((g,gi)=>{
   h+=`<div class=card style="margin:14px 0" data-grp=${gi}><h4 style="margin:0 0 4px">${g.title}</h4>`;
   if(g.help)h+=`<div class=hint>${g.help}</div>`;
   // bulk "set all" for groups with 2+ enum fields sharing one scale (e.g. Skill Maximum Levels)
   const enums=g.fields.filter(f=>f.kind==="enum");
   if(enums.length>=2){
    const bopts=(enums[0].opts||[]).map(o=>`<option value="${o.v}">${o.label}</option>`).join("");
    h+=`<div class=row style="margin:6px 0 4px;align-items:center;gap:6px">
      <span class=hint>Set all ${enums.length}:</span>
      <select class=bulkenum>${bopts}</select>
      <button class="act mini" data-bulkall=${gi}>Apply to all</button></div>`;}
   h+=`<table><tbody>`;
   g.fields.forEach(f=>{
    const note=f.kind==='num'?('= '+f.value):(f.kind==='enum'?enumLabel(f,f.value):(f.kind==='skill'?(SKILLDESC[f.value]||''):(f.kind==='item'?(ITEMDESC[f.value]||''):'')));
    h+=`<tr><td style="width:230px">${f.label}</td><td>${fieldEditor(f)}</td>
     <td class="hint" data-descfor="${f.off}">${note}</td></tr>`;});
   h+=`</tbody></table></div>`;});
  $("#rec").innerHTML=h;
  // wire bulk "Apply to all": set every enum select in the group and stage each edit
  $("#rec").querySelectorAll("[data-bulkall]").forEach(btn=>btn.onclick=()=>{
   const card=btn.closest("[data-grp]"); const val=card.querySelector(".bulkenum").value;
   card.querySelectorAll("select[data-kind=enum]").forEach(sel=>{
    if(sel.value!==val){setSel(sel,+val);sel.dispatchEvent(new Event("change"));}});
   toast("set "+card.querySelectorAll("select[data-kind=enum]").length+" fields");});
  // set dropdown current values
  c.groups.forEach(g=>g.fields.forEach(f=>{
   if(f.kind==="item"||f.kind==="skill"||f.kind==="enum"){
    const el=$(`#rec [data-off="${f.off}"][data-kind]`);if(el)setSel(el,f.value);}}));
  $("#rec").querySelectorAll("[data-off]").forEach(inp=>{
   const ev=inp.tagName==="SELECT"?"change":"blur";
   inp.addEventListener(ev,async()=>{
    const r=await api("/api/char",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({list:L,index:IX,off:+inp.dataset.off,value:+inp.value,width:+inp.dataset.w})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));
    if(inp.dataset.kind){const cell=$(`#rec [data-descfor="${inp.dataset.off}"]`);
     if(cell){
      if(inp.dataset.kind==="enum"){const o=inp.selectedOptions[0];cell.textContent=o?o.textContent.replace(/^\d+\s·\s/,''):"";}
      else{const map=inp.dataset.kind==="skill"?SKILLDESC:ITEMDESC;cell.textContent=map[+inp.value]||"";}
     }}});});
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

// ---- Text: edit UI / battle / menu / description strings in the ISO's boot ELF ----
async function renderText(m){
 m.innerHTML=spinner("scanning ISO for editable text…");
 const texts=await api("/api/texts");
 m.innerHTML=`<div class=row style="margin-bottom:12px"><input class=search id=q placeholder="filter text…" style=width:340px>
   <span class=hint>Editable UI / battle / menu / prize / error text and character blurbs from the game
    executable. Each edit is capped to the original length (longer text is truncated). Story
    <b>dialogue is not here</b> — it lives in packed event files outside the executable. Saves on change.</span></div>
  <div class=hint style="margin:-6px 0 10px">${texts.length} strings</div>
  <table><thead><tr><th style=width:90px>Offset</th><th style=width:52px>Max</th><th>Text</th></tr></thead><tbody id=tb></tbody></table>`;
 function draw(f=""){
  const rows=texts.filter(t=>t.value.toLowerCase().includes(f)).slice(0,600);
  $("#tb").innerHTML=rows.map(t=>`<tr>
    <td class=hint>0x${t.off.toString(16).toUpperCase()}</td>
    <td class=hint>${t.max}</td>
    <td><input type=text value="${t.value.replace(/"/g,'&quot;')}" maxlength=${t.max}
        data-off=${t.off} data-def="${t.value.replace(/"/g,'&quot;')}" style=width:100%></td></tr>`).join("");
  decorate($("#tb"));
  $("#tb").querySelectorAll("input[data-off]").forEach(inp=>inp.addEventListener("change",async()=>{
    const r=await api("/api/text",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({off:+inp.dataset.off,value:inp.value})});
    if(r.ok)markDirty();toast(r.ok?"staged":"error: "+(r.error||"?"));}));
  if(texts.length>600&&!f)$("#tb").insertAdjacentHTML("beforeend",`<tr><td colspan=3 class=hint>… showing first 600; use the filter to narrow.</td></tr>`);}
 draw();$("#q").oninput=e=>draw(e.target.value.toLowerCase());}

// ---- Share / Patch: export the edits you've made as a small shareable recipe, or
// apply someone else's — plus xdelta for whole-ISO diffs (incl. text edits). ----
const POST=(u,d)=>api(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d||{})});
async function renderPatch(m){
 const st=await POST("/api/mod-status",{});
 if(st.error){m.innerHTML=`<div class=card><div class=hint>${st.error}</div></div>`;return;}
 const xd=st.xdelta;
 m.innerHTML=`
 <div class=card>
  <h3 style=margin-top:0>Share your edits <span class=pill>recipe (.s3mod)</span></h3>
  <p class=hint>A recipe is a tiny JSON of the exact byte changes you made (with the original
   bytes, so it's reversible and version-checked). Share it so others can apply your mod to
   <b>their own</b> Suikoden III (USA) ISO — no need to pass around the multi-GB disc.</p>
  <div id=modstat class=hint style="margin:8px 0"><b>${st.bytes}</b> edit(s) ready to export${st.pending?` — includes <b>${st.pending}</b> staged (not yet written to the ISO; you don't have to save)`:""}${st.savedBytes?` · ${st.savedBytes} already written to the ISO`:""}. <button class="act mini sec" id=modrefresh>Refresh</button></div>
  <div class=row>
   <input class=search id=note placeholder="optional note (e.g. 'Hard mode + cheaper runes')" style=width:340px>
   <button class=act id=modexport ${st.bytes?"":"disabled"}>Export recipe (.s3mod)</button>
   <button class=ghost id=modclear ${st.savedBytes?"":"disabled"}>Clear ISO recording</button>
  </div>
  <div id=exres class=hint style="margin-top:8px"></div>
 </div>
 <div class=card>
  <h3 style=margin-top:0>Apply someone's recipe</h3>
  <p class=hint>Point this at a <code>.s3mod</code> file. It's checked against your open ISO's
   version word and written in place (a <code>.bak</code> is made if backups are on). Save or
   Revert any unsaved edits first.</p>
  <div class=row>
   <input class=search id=recpath placeholder="/path/to/mod.s3mod" style=width:340px>
   <button class=act id=recbrowse>Browse…</button>
   <button class=act id=recapply>Apply to current ISO</button>
  </div>
  <div id=applyres class=hint style="margin-top:8px"></div>
 </div>
 <div class=card>
  <h3 style=margin-top:0>xdelta patch <span class=pill>whole-ISO diff</span></h3>
  <p class=hint>Captures <b>every</b> byte difference between a pristine ISO and your edited one —
   including things recipes don't model. ${xd?"":"<b class=warn>xdelta3 not found</b> — install it first (macOS: <code>brew install xdelta</code>)."}</p>
  <div class=row style="opacity:${xd?1:.5}">
   <input class=search id=xdpristine placeholder="pristine (clean) ISO path" style=width:300px>
   <button class=act id=xdpbrowse ${xd?"":"disabled"}>Browse…</button>
   <button class=act id=xdmake ${xd?"":"disabled"}>Create .xdelta (pristine → current)</button>
  </div>
  <div class=row style="opacity:${xd?1:.5};margin-top:8px">
   <input class=search id=xda_pristine placeholder="pristine ISO path" style=width:200px>
   <button class=act id=xda_pbrowse ${xd?"":"disabled"}>Browse…</button>
   <input class=search id=xda_patch placeholder=".xdelta path" style=width:200px>
   <button class=act id=xda_patbrowse ${xd?"":"disabled"}>Browse…</button>
   <button class=act id=xdapply ${xd?"":"disabled"}>pristine + patch → new ISO</button>
  </div>
  <div id=xdres class=hint style="margin-top:8px"></div>
 </div>`;
 const setbrowse=(btn,inp,kind)=>$(btn).onclick=async()=>{const r=await api("/api/pick-file?kind="+kind);if(r.path)$(inp).value=r.path;};
 $("#modrefresh").onclick=()=>renderPatch(m);
 $("#modexport").onclick=async()=>{
  $("#exres").textContent="exporting…";
  const r=await POST("/api/mod-export",{note:$("#note").value.trim()});
  $("#exres").innerHTML=r.ok?`✓ wrote <code>${r.path}</code> (${r.patchCount} run(s)). Share that file.`:`<b class=warn>${r.error}</b>`;};
 $("#modclear").onclick=async()=>{if(!confirm("Clear the recorded edit journal? (Does not undo edits already written to the ISO.)"))return;
  const r=await POST("/api/mod-clear",{});$("#exres").textContent=r.ok?"cleared.":r.error;render();};
 setbrowse("#recbrowse","#recpath","recipe");
 $("#recapply").onclick=async()=>{
  $("#applyres").textContent="applying…";
  const r=await POST("/api/mod-apply",{recipe:$("#recpath").value.trim()});
  $("#applyres").innerHTML=r.ok?`✓ applied ${r.patchCount} run(s), ${r.appliedBytes} byte(s).${r.mismatchedRuns?` <b class=warn>${r.mismatchedRuns} run(s) didn't match the recipe's original bytes</b> (target ISO differs from the author's).`:""}`:`<b class=warn>${r.error}</b>`;};
 setbrowse("#xdpbrowse","#xdpristine","iso");
 setbrowse("#xda_pbrowse","#xda_pristine","iso");
 setbrowse("#xda_patbrowse","#xda_patch","patch");
 $("#xdmake").onclick=async()=>{$("#xdres").textContent="creating patch (may take a minute)…";
  const r=await POST("/api/xdelta-make",{pristine:$("#xdpristine").value.trim()});
  $("#xdres").innerHTML=r.ok?`✓ wrote <code>${r.path}</code> (${(r.size/1024).toFixed(1)} KB).`:`<b class=warn>${r.error}</b>`;};
 $("#xdapply").onclick=async()=>{$("#xdres").textContent="applying patch…";
  const r=await POST("/api/xdelta-apply",{pristine:$("#xda_pristine").value.trim(),patch:$("#xda_patch").value.trim()});
  $("#xdres").innerHTML=r.ok?`✓ wrote <code>${r.path}</code> (${(r.size/1e9).toFixed(2)} GB).`:`<b class=warn>${r.error}</b>`;};
}

// ---- Save Editor: reads a PS2 memory card (*.ps2) and decodes S3 save slots. ----
// Read-only for now: writing needs the save's checksum algorithm, which isn't
// solved yet. No ISO required — this is a separate subsystem (Editor/s3save.py).
let SAVE_CARD=null;   // last-opened card path
async function renderSaves(m){
 m.innerHTML=spinner("scanning for PS2 memory cards…");
 const d=await api("/api/savecards");
 const kindPill={card:"memory card",psu:".psu export",gamedata:"raw gamedata"};
 const mkrow=c=>`<tr>
   <td>${c.name} ${c.kind&&c.kind!=="card"?`<span class=pill style=font-size:10px>${kindPill[c.kind]||c.kind}</span>`:""}</td>
   <td class=hint>${c.mb} MB</td>
   <td>${c.hasS3?'<span class="pill aoe">Suikoden III</span>':'<span class=hint>no S3 save</span>'}</td>
   <td class=hint style=word-break:break-all>${c.path}</td>
   <td><button class=act data-card="${encodeURIComponent(c.path)}" ${c.hasS3?'':'disabled'}>Open</button></td></tr>`;
 const rows=(d.cards||[]).map(mkrow).join("");
 const frows=(d.files||[]).map(mkrow).join("");
 m.innerHTML=`<div class=card><h3 style=margin-top:0>Save Editor <span class=pill aoe>memory card &amp; single saves</span></h3>
   <div class=hint>Edits a Suikoden III save — no ISO needed. Opens an 8&nbsp;MB PS2 <b>memory card</b>
    (.ps2/.mcd/.mc2/.bin) <b>or an individual save</b>: a <b>.psu</b> export (uLaunchELF/mymc) or a raw
    <b>gamedata</b> payload. A <b>.bak</b> is made before the first write; the save checksum (and, for
    memory cards, page ECC) is recomputed automatically. Found near ${d.root}.</div>
   <div class=hint style="margin:2px 0 4px;font-weight:600;color:var(--acc2)">Memory cards</div>
   <table><thead><tr><th>File</th><th>Size</th><th>Contains</th><th>Path</th><th></th></tr></thead>
    <tbody>${rows||'<tr><td colspan=5 class=hint>no PS2 memory cards found nearby</td></tr>'}</tbody></table>
   <div class=hint style="margin:14px 0 4px;font-weight:600;color:var(--acc2)">Individual saves (.psu / gamedata)</div>
   <table><thead><tr><th>File</th><th>Size</th><th>Contains</th><th>Path</th><th></th></tr></thead>
    <tbody>${frows||'<tr><td colspan=5 class=hint>no individual saves found nearby — use Browse… or a full path below</td></tr>'}</tbody></table>
   ${d.lastCard?`<div class=row style="margin-top:12px;align-items:center">
     <button class=act id=savelast>Reopen last</button>
     <span class=hint style=word-break:break-all>${d.lastCard}</span></div>`:""}
   <div class=row style=margin-top:12px;align-items:flex-end>
     <button class=act id=cardbrowse>Browse…</button>
     <label style=flex:1>Or enter full path
     <input id=cardpath style=width:100% placeholder="/path/to/save.ps2 · .psu · gamedata" value="${d.lastCard?String(d.lastCard).replace(/"/g,"&quot;"):""}"></label>
     <button class=act id=cardopen>Open</button></div>
   <div id=carderr class=hint style=color:#e88></div></div>
   <div id=savebody></div>`;
 m.querySelectorAll("[data-card]").forEach(b=>b.onclick=()=>openCard(decodeURIComponent(b.dataset.card)));
 if($("#savelast"))$("#savelast").onclick=()=>openCard(d.lastCard);
 $("#cardopen").onclick=()=>openCard($("#cardpath").value.trim());
 $("#cardbrowse").onclick=async()=>{
   $("#carderr").textContent="";
   const r=await api("/api/pick-file?kind=save");
   if(r.path){$("#cardpath").value=r.path;openCard(r.path);}
   else if(r.error)$("#carderr").textContent=r.error;};
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
 let EDITS={}, INV={}, NAMES={}, PARTY={}, RECRUIT={}, GOLD=null, SUB="chars", HIDE_EMPTY=true;
 function setEdit(ridx,key,val,stat){
  EDITS[ridx]=EDITS[ridx]||{};
  if(stat){EDITS[ridx].stats=EDITS[ridx].stats||{};EDITS[ridx].stats[stat]=val;}
  else EDITS[ridx][key]=val;}
 function setSkill(ridx,slot,field,val){
  EDITS[ridx]=EDITS[ridx]||{};EDITS[ridx].skills=EDITS[ridx].skills||{};
  EDITS[ridx].skills[slot]=EDITS[ridx].skills[slot]||{};EDITS[ridx].skills[slot][field]=val;}
 function dirty(){return Object.keys(EDITS).length||Object.keys(INV).length||Object.keys(NAMES).length||Object.keys(PARTY).length||Object.keys(RECRUIT).length||GOLD!==null;}
 function markSaveDirty(){const w=$("#savewrite");if(w){w.disabled=!dirty();w.textContent=dirty()?"● Write to card":"Write to card";}}

 function drawSlot(i){
  const s=r.saves[i]; EDITS={}; INV={}; NAMES={}; PARTY={}; RECRUIT={}; GOLD=null;
  body.querySelectorAll("[data-slot]").forEach(b=>b.style.outline=(+b.dataset.slot===i)?"2px solid var(--acc)":"");
  const meta=s.meta||{};
  const leaderTxt=s.leaderName?`Leader ${s.leaderName}`:`Leader id ${s.global.partyLeader} (guest/NPC)`;
  const metaBits=[
    meta.chapter!=null?`Chapter ${meta.chapter}`:null,
    meta.level!=null?`Party Lv ${meta.level}`:null,
    s.global.playtime?`Playtime ${s.global.playtime}`:(meta.playtime?`Playtime ${meta.playtime}`:null),
    leaderTxt,
    `story phase ${s.global.storyPhase}`,
  ].filter(Boolean).join(" · ");
  $("#slotmeta").innerHTML=`${s.folder} · checksum 0x${s.checksumWord.toString(16).toUpperCase()}`;
  // "live" = actually recruited (real flag). Others are known but not yet joined.
  const live=s.characters.filter(c=>c.recruited);
  const recruitedCount=live.length;
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
     <div class=lvgrid style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:4px">${nameInputs}</div>
     <div class=row style="margin-top:10px;align-items:center;gap:8px">
       <label class=hint style="flex-direction:column;gap:3px;align-items:stretch">Gold / potch
         <input type=number min=0 max=999999 id=goldfld value="${s.global.gold||0}" data-def="${s.global.gold||0}" style=width:140px></label>
     </div></div>
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

  // learned-skill rank tiers (0 = not learned, then E..S). Verified 0..8 in real saves.
  const RANK_TIERS=[[0,"— (none)"],[1,"E"],[2,"D"],[3,"C"],[4,"B"],[5,"B+"],[6,"A"],[7,"A+"],[8,"S"]];
  const RANK_OPTS=RANK_TIERS.map(([v,l])=>`<option value="${v}">${l}</option>`).join("");
  // equip slot labels (order matches s3save EQUIP_SLOTS) + which item categories fit each
  const EQ=[["headRune","Head Rune"],["rightRune","Right Rune"],["leftRune","Left Rune"],
            ["helm","Helm"],["armor","Armor"],["shield","Shield"],
            ["boots","Boots"],["gloves","Gloves"],["accessory","Accessory"]];
  const EQ_CATS={headRune:["Runes"],rightRune:["Runes"],leftRune:["Runes"],
    helm:["Headgear"],armor:["Armor"],shield:["Shields"],boots:["Footwear"],
    gloves:["Gloves"],accessory:["Rings","Misc Gear"]};
  // Build a filtered option list for one slot. Always includes "none"; if the item
  // currently equipped isn't in the expected category (odd save data), it's still shown
  // so the value is never silently lost.
  function eqOpts(slotKey, curId){
    const cats=EQ_CATS[slotKey]||[];
    const opt=i=>`<option value="${i.id}">${i.id.toString(16).toUpperCase().padStart(3,'0')} · ${i.name}</option>`;
    let list=SAVE_ITEMS.filter(i=>cats.includes(i.cat));
    if(curId&&!list.some(i=>i.id===curId)){const cur=SAVE_ITEMS.find(i=>i.id===curId);
      if(cur)list=[cur,...list];}
    return `<option value="0">— none —</option>`+list.map(opt).join("");
  }
  function drawChars(f=""){
   const numIn=(c,k,val,stat)=>`<input type=number value="${val}" data-ri=${c.rosterIndex}`+
     (stat?` data-stat=${stat}`:` data-k=${k}`)+` data-def="${val}">`;
   const pool=HIDE_EMPTY?live:s.characters;
   const shown=pool.filter(c=>c.name.toLowerCase().includes(f)||String(c.rosterIndex)===f);
   // Per-character card: stats row (Lv/WpnLv/HP/MaxHP/EXP + 8 stats), then equipment,
   // then the 8 skill slots — all inline and always visible.
   const statHead=`<thead><tr><th>Lv</th><th>HP</th><th>MaxHP</th><th>EXP→next</th>${statCols.map(n=>`<th>${n}</th>`).join("")}</tr></thead>`;
   const card=c=>`<div class=card style="margin:0 0 12px;padding:12px 14px">
      <div style="font-weight:600;font-size:15px;color:var(--acc2);margin-bottom:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span>${c.name} <span class=hint style=font-weight:400>#${c.rosterIndex}</span></span>
        ${c.recruited?'<span class="pill aoe" style=font-size:11px>recruited</span>':'<span class=pill style=font-size:11px>not recruited</span>'}
        <label class=hint style="font-weight:400;display:flex;align-items:center;gap:5px;cursor:pointer">
          <input type=checkbox data-recruit=${c.rosterIndex} ${c.recruited?'checked':''}> recruited</label>
        <label class=hint style="font-weight:400;display:flex;align-items:center;gap:5px">recruited by
          <select data-recruiter=${c.rosterIndex}>
            <option value="">— shared / story —</option>
            ${["Hugo","Chris","Geddoe","Thomas"].map(h=>`<option value="${h}" ${c.recruiter===h?"selected":""}>${h}</option>`).join("")}
          </select></label></div>
      <div class=tablewrap><table class=savetbl>${statHead}<tbody><tr>
        <td>${numIn(c,"level",c.level)}</td>
        <td>${numIn(c,"curHP",c.curHP)}</td><td>${numIn(c,"maxHP",c.maxHP)}</td>
        <td>${numIn(c,"expToNext",c.expToNext)}</td>
        ${statCols.map(n=>`<td>${numIn(c,null,c.stats[n],n)}</td>`).join("")}
      </tr></tbody></table></div>
      <div class=hint style="margin:8px 2px 2px">Equipment</div>
      <div class=lvgrid style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:2px">
      ${EQ.map(([key,lbl])=>`<label class=hint style="flex-direction:column;gap:3px;align-items:stretch">${lbl}
        <select data-eqri=${c.rosterIndex} data-eq=${key} data-def="${c.equip[key]||0}">${eqOpts(key,c.equip[key]||0)}</select></label>`).join("")}
      </div>
      <div class=hint style="margin:10px 2px 2px">Skills</div>
      <div class=lvgrid style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:2px">
      ${(c.skills||[]).map(sk=>`<div style="display:flex;flex-direction:column;gap:3px">
        <select data-skri=${c.rosterIndex} data-skslot=${sk.slot} data-skf=id data-def="${sk.id}">${skillOpts}</select>
        <label class=hint style="flex-direction:row;gap:4px;align-items:center">rank
          <select style=width:118px data-skri=${c.rosterIndex} data-skslot=${sk.slot} data-skf=rank data-def="${sk.rank}">${RANK_OPTS}</select></label>
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
     el.addEventListener(ev,()=>{setSkill(+el.dataset.skri,+el.dataset.skslot,el.dataset.skf,+el.value);markSaveDirty();});});
   // recruit checkbox + "recruited by" dropdown -> RECRUIT[ridx]={recruited,recruiter}
   const recEntry=ri=>{RECRUIT[ri]=RECRUIT[ri]||{};return RECRUIT[ri];};
   $("#subview").querySelectorAll("input[data-recruit]").forEach(cb=>cb.addEventListener("change",()=>{
     recEntry(+cb.dataset.recruit).recruited=cb.checked;markSaveDirty();}));
   $("#subview").querySelectorAll("select[data-recruiter]").forEach(sel=>sel.addEventListener("change",()=>{
     const ri=+sel.dataset.recruiter;const e=recEntry(ri);e.recruiter=sel.value;
     // choosing a recruiter implies recruited; tick the box for clarity
     const cb=$(`input[data-recruit='${ri}']`);if(cb&&!cb.checked){cb.checked=true;e.recruited=true;}
     markSaveDirty();}));}

  let INVCAT="regular";  // "regular" (consumables+equipment) or "key"
  // inv is now an array of bags: [{region, base, items:[...]}]. Early game these are the
  // separate Hugo/Chris/Geddoe/Thomas parties; late game most items sit in one bag +
  // Storage. Only bags that actually contain items are shown.
  // ADDED[bagIndex] = [slotIndex, ...] extra empty slots the user opened for new items
  let ADDED={};
  function drawItems(f=""){
   const wantKey=INVCAT==="key";
   // build rows per bag: matching existing items + any user-added blank slots
   const bagViews=(inv||[]).map((bag,bi)=>{
     const items=bag.items.filter(it=>{
       if((it.category==="key")!==wantKey)return false;
       const nm=(ITEMNAME[it.id]||"").toLowerCase();
       return nm.includes(f)||String(it.slot)===f||it.id.toString(16).includes(f);});
     const added=(ADDED[bi]||[]).map(sl=>({slot:sl,id:0,qty:0,category:wantKey?'key':'consumable',_new:true}));
     return {bag,bi,items:items.concat(added)};});
   const nKey=(inv||[]).reduce((a,bg)=>a+bg.items.filter(it=>it.category==="key").length,0);
   const nReg=(inv||[]).reduce((a,bg)=>a+bg.items.length,0)-nKey;
   const rowHTML=it=>`<tr><td class=hint>${it.slot}</td>
       <td><select data-invslot=${it.slot} data-k=id data-def="${it.id}">${itemOpts}</select></td>
       <td><input type=number min=0 data-invslot=${it.slot} data-k=qty data-def="${it.qty}" value="${it.qty}" style=width:70px></td>
       <td class=hint>${it.category}</td>
       <td><button class="restore" data-clearslot=${it.slot} title="remove item" style="display:inline-block">✕</button></td></tr>`;
   const bagHTML=v=>{
     const free=(v.bag.freeSlots||[]).filter(sl=>!(ADDED[v.bi]||[]).includes(sl));
     const rows=v.items.map(rowHTML).join("");
     return `<div style="margin-bottom:14px">
       <div style="font-weight:600;color:var(--acc2);margin:0 2px 6px">${v.bag.region}
         <span class=hint style=font-weight:400>${v.bag.used}/${v.bag.capacity} slots used</span>
         ${free.length?`<button class="act sec" style="padding:2px 10px;margin-left:8px" data-addbag=${v.bi} data-freeslot=${free[0]}>+ Add item</button>`:'<span class=hint style=margin-left:8px>bag full</span>'}</div>
       <div class=tablewrap><table class=savetbl>
       <thead><tr><th>Slot</th><th>Item</th><th>Qty</th><th>Type</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan=5 class=hint>no items</td></tr>'}</tbody></table></div></div>`;};
   $("#subview").innerHTML=`<div class=subtabs style="margin-bottom:10px">
      <button data-invcat=regular class="${wantKey?'':'on'}">Party Items (${nReg})</button>
      <button data-invcat=key class="${wantKey?'on':''}">Key / Valuables (${nKey})</button></div>
     <div class=hint style="margin:-2px 2px 10px">Early game, Hugo / Chris / Geddoe carry separate bags (they merge after the Flame Champion is chosen). Use <b>+ Add item</b> to fill an empty slot, ✕ to remove. New items default to qty 1.</div>
     ${bagViews.map(bagHTML).join("")||'<div class=hint>none</div>'}`;
   $("#subview").querySelectorAll("[data-invcat]").forEach(b=>b.onclick=()=>{INVCAT=b.dataset.invcat;drawItems($("#sq").value.toLowerCase());});
   $("#subview").querySelectorAll("select[data-invslot]").forEach(sel=>setSel(sel,+sel.dataset.def));
   decorate($("#subview"));
   $("#subview").querySelectorAll("[data-invslot]").forEach(inp=>{
     const ev=inp.tagName==="SELECT"?"change":"blur";
     inp.addEventListener(ev,()=>{const sl=+inp.dataset.invslot;INV[sl]=INV[sl]||{};INV[sl][inp.dataset.k]=+inp.value;markSaveDirty();});});
   // "+ Add item": open the next free slot in that bag as an editable blank row
   $("#subview").querySelectorAll("[data-addbag]").forEach(btn=>btn.onclick=()=>{
     const bi=+btn.dataset.addbag, sl=+btn.dataset.freeslot;
     ADDED[bi]=(ADDED[bi]||[]).concat(sl);
     drawItems($("#sq").value.toLowerCase());});
   // ✕ remove: set the slot's item id to 0 (clears it) and re-render
   $("#subview").querySelectorAll("[data-clearslot]").forEach(btn=>btn.onclick=()=>{
     const sl=+btn.dataset.clearslot;INV[sl]={id:0,qty:0};markSaveDirty();
     // drop it from ADDED if it was a freshly-added row
     Object.keys(ADDED).forEach(bi=>ADDED[bi]=ADDED[bi].filter(x=>x!==sl));
     drawItems($("#sq").value.toLowerCase());});}

  function drawParty(){
   const mem=s.party||[];
   const anyFilled=mem.some(c=>c>0);
   const rows=mem.map((cid,slot)=>`<tr><td class=hint>Slot ${slot+1}</td>
     <td><select data-partyslot=${slot} data-def="${cid}">${charOpts}</select></td>
     <td class=hint>${CHARBY[cid]||(cid?('id '+cid+' (guest/NPC)'):'—')}</td></tr>`).join("");
   const emptyNote=anyFilled?"":`<div class=hint style="margin:0 2px 10px;color:var(--warn)">This save's active-party table is empty — common in early chapters, where the game sets the field party through story events rather than this list. You can assign members here, but on a very early save it may be overwritten when the next event loads.</div>`;
   $("#subview").innerHTML=emptyNote+`<div class=tablewrap><table class=savetbl>
     <thead><tr><th>Party</th><th>Character</th><th>Current</th></tr></thead><tbody>${rows}</tbody></table></div>`;
   $("#subview").querySelectorAll("select[data-partyslot]").forEach(sel=>{
     setSel(sel,+sel.dataset.def);
     sel.addEventListener("change",()=>{PARTY[+sel.dataset.partyslot]=+sel.value;markSaveDirty();});});
   decorate($("#subview"));}
  function showSub(){
   $("#slotbody").querySelectorAll("[data-sub]").forEach(b=>b.classList.toggle("on",b.dataset.sub===SUB));
   $("#sq").value="";
   if(SUB==="chars"){
    $("#subhint").innerHTML=`Each character shows stats, equipped runes/armor, and skill slots inline. Tick <b>recruited</b> on a card to add a not-yet-joined character to your roster (or untick to remove). Stat labels are a best-effort decode. A .bak is made first; after writing, load the save in-game and resave.
     &nbsp;<label style="cursor:pointer" title="show only recruited characters"><input type=checkbox id=reconly ${HIDE_EMPTY?'checked':''}> recruited only</label>`;
    drawChars();
    const rc=$("#reconly");if(rc)rc.onchange=()=>{HIDE_EMPTY=rc.checked;drawChars($("#sq").value.toLowerCase());};}
   else if(SUB==="party"){$("#subhint").innerHTML=`Active battle party (up to 6). Pick who fills each slot. Changing this swaps the in-field party; leave story-required leaders in place to avoid soft-locks. A .bak is made first.`;drawParty();}
   else{$("#subhint").innerHTML=`Party + storage items (id · quantity). Change an item or its count. Only non-empty slots are shown. A .bak is made first.`;drawItems();}}
  $("#slotbody").querySelectorAll("[data-sub]").forEach(b=>b.onclick=()=>{SUB=b.dataset.sub;showSub();});
  $("#sq").oninput=e=>{const f=e.target.value.toLowerCase();
    if(SUB==="chars")drawChars(f);else if(SUB==="items")drawItems(f);else drawParty();};
  // editable name fields (in the meta card, not #subview — decorate + wire directly)
  decorate($("#slotbody"));
  $("#slotbody").querySelectorAll("input[data-name]").forEach(inp=>inp.addEventListener("change",()=>{
    NAMES[inp.dataset.name]=inp.value;markSaveDirty();}));
  const gf=$("#goldfld");if(gf)gf.addEventListener("change",()=>{GOLD=+gf.value;markSaveDirty();});
  showSub();

  $("#savewrite").onclick=async()=>{
   if(!dirty()){toast("no edits");return;}
   $("#savemsg").textContent="writing…";
   const res=await api("/api/save-write",{method:"POST",headers:{"Content-Type":"application/json"},
     body:JSON.stringify({path:SAVE_CARD,folder:s.folder,edits:EDITS,invEdits:INV,nameEdits:NAMES,partyEdits:PARTY,recruitEdits:RECRUIT,gold:GOLD,backup:$("#savebak").checked})});
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
