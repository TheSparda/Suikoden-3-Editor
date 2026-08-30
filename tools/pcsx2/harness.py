"""Drive a PCSX2 process from Python: boot a disc, wait for it, read it, shut it down.

PCSX2 has no headless build and no scripting console, so "automated testing" is really
three separate facilities stitched together here:

  * the CLI (`-batch -nogui -fastboot -statefile ...`) starts a run and, crucially,
    makes the process *exit* when emulation stops, so a test can wait on it;
  * PINE (pine.py) reads and writes the emulated RAM while it runs;
  * savestates give reproducible starting points and whole-RAM snapshots.

On a headless box the display still has to exist — `-nogui` hides the main window, not
the game output — so this wraps the launch in `xvfb-run` when there is no DISPLAY.

Nothing here fabricates a result when a piece is missing: `doctor()` reports what is
absent and the callers skip, in the same spirit as the repo's other suites (web/tests
self-skip without Chromium or xdelta3 rather than passing vacuously).
"""
import os
import shutil
import subprocess
import sys
import time

from . import pine, savestate

SERIAL = "SLUS-20387"

# Candidate binary names, in the order a machine is likely to have them.
_BINARIES = ("pcsx2-qt", "PCSX2", "pcsx2", "PCSX2-Qt")


class HarnessError(RuntimeError):
    pass


def find_pcsx2():
    """Absolute path to a PCSX2 binary, or None."""
    env = os.environ.get("PCSX2_BIN")
    if env:
        return env if os.path.exists(env) else None
    for name in _BINARIES:
        found = shutil.which(name)
        if found:
            return found
    # AppImages are the usual Linux distribution and never land on PATH.
    for d in (os.path.expanduser("~/Applications"), os.path.expanduser("~/Downloads")):
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.lower().startswith("pcsx2") and name.lower().endswith(".appimage"):
                return os.path.join(d, name)
    if sys.platform == "darwin":
        mac = "/Applications/PCSX2.app/Contents/MacOS/PCSX2"
        if os.path.exists(mac):
            return mac
    return None


def default_snaps_dir():
    env = os.environ.get("PCSX2_SNAPS_DIR")
    if env:
        return env
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(home, "Documents", "PCSX2", "snaps")
    mac = os.path.join(home, "Library", "Application Support", "PCSX2", "snaps")
    if os.path.isdir(mac):
        return mac
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(xdg, "PCSX2", "snaps")


def doctor():
    """What is present and what is missing, as an ordered list of (label, ok, detail)."""
    binary = find_pcsx2()
    display = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    xvfb = shutil.which("xvfb-run")
    xdotool = shutil.which("xdotool")
    iso = next((p for p in _iso_candidates() if p and os.path.exists(p)), None)
    try:
        with pine.connect(timeout=1.0):
            live = True
    except pine.PineError:
        live = False
    return [
        ("pcsx2 binary", binary is not None, binary or "not found (set PCSX2_BIN)"),
        ("display", display or bool(xvfb), "DISPLAY" if display else (xvfb or "none: install xvfb")),
        ("PINE server", live, "reachable" if live else "no emulator running (or PINE off)"),
        ("savestates dir", os.path.isdir(savestate.default_states_dir()), savestate.default_states_dir()),
        ("snaps dir", os.path.isdir(default_snaps_dir()), default_snaps_dir()),
        ("xdotool (screenshots)", xdotool is not None, xdotool or "not found: screenshot capture disabled"),
        ("game ISO", iso is not None, iso or "not found (set S3_ISO)"),
    ]


def _iso_candidates():
    from . import eemap

    return eemap.default_iso_candidates()


class Pcsx2:
    """A PCSX2 run. Use as a context manager; the emulator is stopped on exit."""

    def __init__(self, iso=None, statefile=None, state=None, binary=None, slot=pine.DEFAULT_SLOT,
                 fastboot=True, nogui=True, turbo=False, extra_args=(), log=None):
        self.iso = iso
        self.statefile = statefile
        self.state = state
        self.binary = binary or find_pcsx2()
        self.slot = slot
        self.fastboot = fastboot
        self.nogui = nogui
        self.turbo = turbo
        self.extra_args = list(extra_args)
        self.log = log
        self.proc = None
        self._pine = None

    # -- lifecycle ----------------------------------------------------------

    def command(self):
        if not self.binary:
            raise HarnessError("no PCSX2 binary found — set PCSX2_BIN=/path/to/pcsx2-qt")
        cmd = [self.binary, "-batch", "-earlyconsolelog"]
        if self.nogui:
            cmd.append("-nogui")
        if self.fastboot:
            cmd.append("-fastboot")
        if self.turbo:
            # Fast-forward: a boot-and-read test does not need real-time playback, and
            # this is the single biggest saving in a CI run.
            cmd.append("-turbo")
        if self.state is not None:
            cmd += ["-state", str(self.state)]
        if self.statefile:
            cmd += ["-statefile", self.statefile]
        if self.log:
            cmd += ["-logfile", self.log]
        cmd += self.extra_args
        if self.iso:
            cmd += ["--", self.iso]
        # Without a display server PCSX2 cannot create its output window at all, so on a
        # headless machine the whole command goes through Xvfb.
        if os.name != "nt" and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
            xvfb = shutil.which("xvfb-run")
            if xvfb:
                cmd = [xvfb, "-a", "-s", "-screen 0 1280x960x24"] + cmd
            else:
                raise HarnessError(
                    "no DISPLAY and no xvfb-run — install xvfb, or run with a desktop session"
                )
        return cmd

    def start(self):
        cmd = self.command()
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return self

    def stop(self, timeout=15.0):
        if self._pine is not None:
            self._pine.close()
            self._pine = None
        if self.proc is None:
            return
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=timeout)
        self.proc = None

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    # -- connection ---------------------------------------------------------

    @property
    def pine(self):
        if self._pine is None:
            self._pine = pine.connect(slot=self.slot, retries=30, delay=1.0)
        return self._pine

    def attach(self, retries=3):
        """Bind to a PCSX2 someone else started, for snapshotting a session you are
        playing by hand. `stop()` then closes the socket without killing the emulator,
        because `proc` is None."""
        self._pine = pine.connect(slot=self.slot, retries=retries)
        return self

    def wait_ready(self, serial=SERIAL, timeout=180.0):
        """Wait for the disc to be booted and running. Returns the serial reported."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.alive():
                raise HarnessError(
                    "PCSX2 exited during boot (exit %s). Common causes: no PS2 BIOS "
                    "configured, or the ISO path is wrong." % self.proc.returncode
                )
            try:
                return pine.wait_for_game(self.pine, serial=serial, timeout=5.0, poll=0.5)
            except pine.PineError:
                continue
        raise HarnessError("timed out waiting for %s to boot" % (serial or "a game"))

    # -- snapshots ----------------------------------------------------------

    def snapshot_ee(self, slot=1, timeout=30.0):
        """Save a state and return the EE RAM image from it.

        The mtime floor is what makes this safe to call in a loop: PCSX2 writes the file
        asynchronously, and without it the second snapshot happily re-reads the first.
        """
        floor = time.time() - 1.0
        self.pine.save_state(slot)
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = savestate.newest_state(slot=slot, serial=SERIAL, newer_than=floor)
            if path:
                # Give the writer a moment to finish; a half-written zip raises here.
                try:
                    return savestate.extract_ee_ram(path)
                except Exception:
                    pass
            time.sleep(0.5)
        raise HarnessError("no savestate appeared in %s" % savestate.default_states_dir())

    def screenshot(self, snaps_dir=None, timeout=15.0, key="F8"):
        """Trigger PCSX2's screenshot hotkey and return the file it wrote.

        There is no CLI or PINE command for this, so it goes through the hotkey — which
        means an X session and xdotool. Returns None when either is unavailable, so a
        caller can degrade to memory-only checks instead of failing.
        """
        xdotool = shutil.which("xdotool")
        if not xdotool or not os.environ.get("DISPLAY"):
            return None
        snaps_dir = snaps_dir or default_snaps_dir()
        floor = time.time() - 1.0
        subprocess.run([xdotool, "key", "--clearmodifiers", key], check=False)
        deadline = time.time() + timeout
        while time.time() < deadline:
            newest = _newest_file(snaps_dir, floor, (".png", ".jpg", ".webp"))
            if newest:
                return newest
            time.sleep(0.3)
        return None


def _newest_file(directory, newer_than, suffixes):
    if not os.path.isdir(directory):
        return None
    best, best_mtime = None, -1.0
    for name in os.listdir(directory):
        if not name.lower().endswith(suffixes):
            continue
        full = os.path.join(directory, name)
        mtime = os.path.getmtime(full)
        if mtime >= newer_than and mtime > best_mtime:
            best, best_mtime = full, mtime
    return best
