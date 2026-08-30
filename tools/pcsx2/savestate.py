"""Read EE main RAM out of a PCSX2 savestate.

A `.p2s` savestate is a zip archive; one member is the raw 32 MB image of the PS2's main
RAM. Pulling it out is the difference between a scan that takes seconds and one that
takes hours: PINE reads memory a value per command, so a full 32 MB sweep over the
socket is hopeless, while `save_state()` + unzip hands over the whole image at once.

The working loop this enables:  PINE `save_state(slot)` -> read the .p2s from disk ->
`extract_ee_ram()` -> diff against an earlier snapshot (ramscan.py) -> poke the surviving
candidates back through PINE.
"""
import os
import zipfile

EE_RAM_SIZE = 32 * 1024 * 1024

# PCSX2 has spelled this member differently across versions, so match on a normalised
# name rather than pinning one string.
_EE_HINTS = ("eememory", "eemem", "ee_memory")


class SavestateError(RuntimeError):
    pass


def members(path):
    with zipfile.ZipFile(path) as z:
        return [i.filename for i in z.infolist()]


def _pick_ee_member(zf):
    infos = zf.infolist()
    for info in infos:
        name = os.path.basename(info.filename).lower().replace(" ", "")
        if any(h in name for h in _EE_HINTS):
            return info
    # Fall back on size: the EE image is the only 32 MB member in a savestate.
    sized = [i for i in infos if i.file_size == EE_RAM_SIZE]
    if len(sized) == 1:
        return sized[0]
    raise SavestateError(
        "no EE memory member found in the savestate (members: %s)"
        % ", ".join(i.filename for i in infos)
    )


def extract_ee_ram(path):
    """Return the raw EE main-RAM image from a `.p2s` savestate."""
    if not zipfile.is_zipfile(path):
        raise SavestateError(
            "%s is not a zip — PCSX2 savestates are zip archives; is this really a "
            ".p2s?" % path
        )
    with zipfile.ZipFile(path) as z:
        info = _pick_ee_member(z)
        data = z.read(info)
    if len(data) != EE_RAM_SIZE:
        raise SavestateError(
            "EE image in %s is %d bytes, expected %d" % (path, len(data), EE_RAM_SIZE)
        )
    return data


def dump_ee_ram(path, out_path):
    """Extract the EE image to a plain file (useful for external hex tools)."""
    data = extract_ee_ram(path)
    with open(out_path, "wb") as f:
        f.write(data)
    return out_path


def state_path(slot, serial, states_dir=None):
    """Where PCSX2 writes `save_state(slot)` for a given disc serial.

    PCSX2 names savestates `<serial> (<crc>).<slot>.p2s`, and the CRC is not something
    we can compute here, so this returns the directory plus a glob-ready prefix rather
    than a full path; `newest_state` does the actual picking.
    """
    if states_dir is None:
        states_dir = default_states_dir()
    return states_dir, "%s " % serial, ".%02d.p2s" % slot


def default_states_dir():
    """PCSX2's default savestate directory per platform."""
    env = os.environ.get("PCSX2_STATES_DIR")
    if env:
        return env
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(home, "Documents", "PCSX2", "sstates")
    mac = os.path.join(home, "Library", "Application Support", "PCSX2", "sstates")
    if os.path.isdir(mac):
        return mac
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(xdg, "PCSX2", "sstates")


def newest_state(slot=None, serial=None, states_dir=None, newer_than=None):
    """Most recently written savestate matching the filters, or None.

    `newer_than` is a mtime floor — pass the time just before `save_state()` was called
    so a stale file from an earlier run can never be mistaken for the fresh one.
    """
    if states_dir is None:
        states_dir = default_states_dir()
    if not os.path.isdir(states_dir):
        return None
    best, best_mtime = None, -1.0
    for name in os.listdir(states_dir):
        if not name.endswith(".p2s"):
            continue
        if slot is not None and not name.endswith(".%02d.p2s" % slot):
            continue
        if serial is not None and not name.startswith(serial):
            continue
        full = os.path.join(states_dir, name)
        mtime = os.path.getmtime(full)
        if newer_than is not None and mtime < newer_than:
            continue
        if mtime > best_mtime:
            best, best_mtime = full, mtime
    return best
