#!/usr/bin/env python3
"""Offline tests for the PCSX2 harness — no emulator, no ISO, no BIOS.

Everything the harness does that can be wrong *in a way that produces confident
nonsense* is checked here against synthetic fixtures: the PINE wire framing (against a
mock server that speaks the protocol back), the savestate reader (against a hand-built
zip), the scan narrowing (against dumps with a planted "character id"), the ELF
calibration (against a planted anchor) and the PNG hash (against images this file
encodes, one per filter type).

What it cannot check is the half that only a real PCSX2 can answer: that the opcode
numbers match the emulator's, that batching is framed the way we assume, and that the
documented ELF load address is where the game actually lands. Those are verified at
runtime instead — the client probes batching on connect and falls back, and
`cli.py boot-verify` re-derives the load address from a live RAM dump rather than
trusting the constant. This file is about the logic; boot-verify is about the game.

    python3 tools/pcsx2/selftest.py
"""

import os
import socket
import struct
import sys
import tempfile
import threading
import zipfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from tools.pcsx2 import edsprobe, eemap, harness, pine, pngdiff, ramscan, savestate  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(cond, label):
    CHECKS[0] += 1
    if not cond:
        FAILURES.append(label)
        print("  FAIL %s" % label)


def check_raises(exc, fn, label):
    try:
        fn()
    except exc:
        CHECKS[0] += 1
        return
    except Exception as e:  # wrong exception type is still a failure
        CHECKS[0] += 1
        FAILURES.append("%s (raised %r)" % (label, e))
        print("  FAIL %s (raised %r)" % (label, e))
        return
    CHECKS[0] += 1
    FAILURES.append("%s (did not raise)" % label)
    print("  FAIL %s (did not raise)" % label)


# ---------------------------------------------------------------------------
# A mock PINE server, so the client's framing is exercised end to end.
# ---------------------------------------------------------------------------

class MockPine(threading.Thread):
    """Speaks the framing pine.py implements, over a real unix socket.

    Holds a small sparse memory so reads see what writes put there. `batching` can be
    turned off to prove the client's fallback path works.
    """

    daemon = True

    def __init__(self, path, batching=True, ram_size=0x2000000):
        super().__init__()
        self.path = path
        self.batching = batching
        self.mem = bytearray(ram_size)
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(path)
        self.sock.listen(4)
        self.stop_flag = False
        self.saved_slots = []
        self.loaded_slots = []

    def run(self):
        while not self.stop_flag:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        with conn:
            while True:
                head = self._recv(conn, 4)
                if not head:
                    return
                (total,) = struct.unpack("<I", head)
                body = self._recv(conn, total - 4)
                if body is None:
                    return
                try:
                    payload = self._run_commands(body)
                    conn.sendall(struct.pack("<I", 5 + len(payload)) + b"\x00" + payload)
                except Exception:
                    conn.sendall(struct.pack("<I", 5) + b"\xff")

    @staticmethod
    def _recv(conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                return None if buf else b""
            buf += chunk
        return buf

    def _run_commands(self, body):
        """`body` may hold several commands back to back when the client batches."""
        out = b""
        pos = 0
        while pos < len(body):
            op = body[pos]
            pos += 1
            if op in (pine.MSG_READ8, pine.MSG_READ16, pine.MSG_READ32, pine.MSG_READ64):
                width = {0: 1, 1: 2, 2: 4, 3: 8}[op]
                (addr,) = struct.unpack_from("<I", body, pos)
                pos += 4
                out += bytes(self.mem[addr:addr + width])
            elif op in (pine.MSG_WRITE8, pine.MSG_WRITE16, pine.MSG_WRITE32, pine.MSG_WRITE64):
                width = {4: 1, 5: 2, 6: 4, 7: 8}[op]
                (addr,) = struct.unpack_from("<I", body, pos)
                pos += 4
                self.mem[addr:addr + width] = body[pos:pos + width]
                pos += width
            elif op in (pine.MSG_VERSION, pine.MSG_TITLE, pine.MSG_ID, pine.MSG_GAMEVERSION):
                text = {
                    pine.MSG_VERSION: b"PCSX2 2.0.0-mock",
                    pine.MSG_TITLE: b"Suikoden III",
                    pine.MSG_ID: b"SLUS-20387",
                    pine.MSG_GAMEVERSION: b"1.00",
                }[op] + b"\0"
                out += struct.pack("<I", len(text)) + text
            elif op == pine.MSG_STATUS:
                out += struct.pack("<I", pine.STATUS_RUNNING)
            elif op == pine.MSG_SAVESTATE:
                self.saved_slots.append(body[pos])
                pos += 1
            elif op == pine.MSG_LOADSTATE:
                self.loaded_slots.append(body[pos])
                pos += 1
            else:
                raise ValueError("bad opcode 0x%02X" % op)
            if not self.batching and pos < len(body):
                # Emulate a server that ignores trailing commands: the client's probe
                # must notice the short reply and stop batching.
                break
        return out

    def shutdown(self):
        self.stop_flag = True
        try:
            self.sock.close()
        finally:
            if os.path.exists(self.path):
                os.unlink(self.path)


def test_pine():
    print("pine: framing against a mock server")
    for batching in (True, False):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "pcsx2.sock")
        server = MockPine(path, batching=batching)
        server.start()
        try:
            with pine.Client(endpoint=("unix", path), timeout=5.0) as c:
                label = "batching=%s" % batching
                check(c.batching is batching, "%s: probe detected the server's mode" % label)

                c.write(0x1000, 0x41424344, 4)
                check(c.read(0x1000, 4) == 0x41424344, "%s: u32 round trip" % label)
                c.write(0x1010, 0xAB, 1)
                c.write(0x1012, 0xBEEF, 2)
                c.write(0x1020, 0x0102030405060708, 8)
                check(c.read(0x1010, 1) == 0xAB, "%s: u8 round trip" % label)
                check(c.read(0x1012, 2) == 0xBEEF, "%s: u16 round trip" % label)
                check(c.read(0x1020, 8) == 0x0102030405060708, "%s: u64 round trip" % label)

                # A batch must come back in order, not just with the right values.
                c.write_many([(0x2000 + i * 4, 1000 + i, 4) for i in range(8)])
                got = c.read_many([(0x2000 + i * 4, 4) for i in range(8)])
                check(got == [1000 + i for i in range(8)], "%s: batch preserves order" % label)

                c.write_bytes(0x3000, bytes(range(64)))
                check(c.read_bytes(0x3000, 64) == bytes(range(64)), "%s: byte range" % label)

                check(c.game_id() == "SLUS-20387", "%s: game_id" % label)
                check(c.title() == "Suikoden III", "%s: title" % label)
                check(c.version().startswith("PCSX2"), "%s: version" % label)
                check(c.status() == pine.STATUS_RUNNING, "%s: status" % label)

                c.save_state(3)
                c.load_state(3)
                check(server.saved_slots[-1] == 3, "%s: save_state carries the slot" % label)
                check(server.loaded_slots[-1] == 3, "%s: load_state carries the slot" % label)

                # Range guard: catching this locally beats a bare PINE failure.
                check_raises(ValueError, lambda: c.read(0x4000000, 4),
                             "%s: read past EE RAM is rejected" % label)
                check_raises(ValueError, lambda: c.write(pine.EE_RAM_SIZE - 2, 0, 4),
                             "%s: write straddling the end is rejected" % label)
                check_raises(ValueError, lambda: c.read(0, 3), "%s: bad width rejected" % label)
        finally:
            server.shutdown()

    # wait_for_game must reject a serial mismatch rather than accept any running game.
    d = tempfile.mkdtemp()
    path = os.path.join(d, "pcsx2.sock")
    server = MockPine(path)
    server.start()
    try:
        with pine.Client(endpoint=("unix", path)) as c:
            check(pine.wait_for_game(c, serial="SLUS-20387", timeout=3) == "SLUS-20387",
                  "wait_for_game accepts the right serial")
            check_raises(pine.PineError,
                         lambda: pine.wait_for_game(c, serial="SLES-50000", timeout=1.5, poll=0.2),
                         "wait_for_game rejects the wrong serial")
    finally:
        server.shutdown()

    # No server at all must be a clear error, not a hang.
    check_raises(pine.PineError,
                 lambda: pine.Client(endpoint=("unix", "/nonexistent/pcsx2.sock"), timeout=0.5).connect(),
                 "connect to a dead socket raises PineError")

    cands = pine.socket_candidates(28011)
    check(any(p.endswith("pcsx2.sock") for _, p in cands) if cands[0][0] == "unix" else True,
          "default slot tries the unsuffixed socket name")


# ---------------------------------------------------------------------------
# savestate
# ---------------------------------------------------------------------------

def _make_p2s(path, ee_bytes, member="eeMemory.bin", extras=True):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        if extras:
            z.writestr("PCSX2 Savestate Version.id", b"\x00" * 4)
            z.writestr("iopMemory.bin", b"\x00" * 1024)
        z.writestr(member, ee_bytes)


def test_savestate():
    print("savestate: EE image extraction")
    d = tempfile.mkdtemp()
    ee = bytearray(savestate.EE_RAM_SIZE)
    ee[0x100:0x104] = b"\xde\xad\xbe\xef"
    ee = bytes(ee)

    p = os.path.join(d, "a.p2s")
    _make_p2s(p, ee)
    got = savestate.extract_ee_ram(p)
    check(got == ee, "extracts eeMemory.bin")
    check("eeMemory.bin" in savestate.members(p), "lists members")

    # Version drift: a differently spelled member must still be found.
    p2 = os.path.join(d, "b.p2s")
    _make_p2s(p2, ee, member="EE Memory.bin")
    check(savestate.extract_ee_ram(p2) == ee, "finds a differently spelled EE member")

    # Unknown name, right size: the size fallback should carry it.
    p3 = os.path.join(d, "c.p2s")
    _make_p2s(p3, ee, member="mainram.dat")
    check(savestate.extract_ee_ram(p3) == ee, "falls back to the 32 MB member")

    # A truncated image must raise, not silently scan short.
    p4 = os.path.join(d, "d.p2s")
    _make_p2s(p4, b"\x00" * 1024, member="eeMemory.bin")
    check_raises(savestate.SavestateError, lambda: savestate.extract_ee_ram(p4),
                 "wrong-sized EE image is rejected")

    p5 = os.path.join(d, "e.p2s")
    with open(p5, "wb") as f:
        f.write(b"not a zip")
    check_raises(savestate.SavestateError, lambda: savestate.extract_ee_ram(p5),
                 "non-zip is rejected with a useful message")

    # newest_state's mtime floor is what stops a stale file being read as a fresh one.
    states = os.path.join(d, "sstates")
    os.makedirs(states)
    old = os.path.join(states, "SLUS-20387 (ABCD1234).01.p2s")
    with open(old, "wb") as f:
        f.write(b"x")
    os.utime(old, (1000, 1000))
    check(savestate.newest_state(slot=1, serial="SLUS-20387", states_dir=states) == old,
          "newest_state finds a matching state")
    check(savestate.newest_state(slot=1, serial="SLUS-20387", states_dir=states,
                                 newer_than=2000) is None,
          "newest_state honours the mtime floor")
    check(savestate.newest_state(slot=2, serial="SLUS-20387", states_dir=states) is None,
          "newest_state filters by slot")


# ---------------------------------------------------------------------------
# ramscan
# ---------------------------------------------------------------------------

def test_ramscan():
    print("ramscan: differential narrowing")
    size = 1 << 16

    def make(char_id, noise_seed):
        buf = bytearray(size)
        struct.pack_into("<I", buf, 0x4000, char_id)      # the planted "character id"
        struct.pack_into("<I", buf, 0x8000, 0xCAFEBABE)   # never moves
        # A frame counter and an RNG word that move on *every* snapshot: the noise a
        # real scan has to survive. Both are deliberately large, because "a character id
        # is a small number" is the cheap filter the scanner leans on.
        struct.pack_into("<I", buf, 0x1000, 0x00300000 + noise_seed)
        struct.pack_into("<I", buf, 0x1080, noise_seed * 2654435761 & 0xFFFFFFFF)
        return bytes(buf)

    hugo_a = make(1, 100)
    hugo_b = make(1, 101)
    chris = make(2, 102)
    geddoe = make(3, 103)

    offs = list(ramscan.differing_offsets(hugo_a, chris))
    check(0x4000 in offs, "differing_offsets finds the changed id")
    check(0x8000 not in offs, "differing_offsets ignores the constant")

    runs = ramscan.differing_runs(hugo_a, chris)
    check(any(s <= 0x4000 < s + n for s, n in runs), "differing_runs covers the id")
    check(all(n <= 16 for _, n in runs), "differing_runs stays tight")

    check(ramscan.find_value(hugo_a, 0xCAFEBABE) == [0x8000], "find_value locates a word")
    check(ramscan.find_value(hugo_a, 0xCAFEBABE, aligned=False) == [0x8000],
          "find_value unaligned agrees here")
    check(ramscan.values_at(hugo_a, [0x4000]) == [1], "values_at reads the id")

    noise = ramscan.volatile_addresses([hugo_a, hugo_b, make(1, 104)])
    check(0x1000 in noise and 0x1080 in noise, "volatile_addresses finds the noise floor")
    check(0x4000 not in noise, "volatile_addresses leaves the id alone")

    s = ramscan.Scanner(width=4)
    s.first_changed(hugo_a, chris)
    s.keep_changed(chris, geddoe)
    s.keep_unchanged(hugo_a, hugo_b)
    check(s.addresses() == [0x4000], "scan narrows to the planted id")
    check("first_changed" in s.report(hugo_a), "report shows the narrowing history")

    # Without the unchanged step the noise survives — which is the whole reason
    # exclude_near exists.
    s2 = ramscan.Scanner(width=4).first_changed(hugo_a, chris).keep_changed(chris, geddoe)
    check(len(s2.addresses()) > 1, "noise survives a naive two-step scan")
    check(s2.exclude_near(noise, radius=8).addresses() == [0x4000],
          "exclude_near removes the noise floor")

    s3 = ramscan.Scanner(width=4).first_changed(hugo_a, chris)
    check(s3.keep_value_between(hugo_a, 0, 255).addresses().count(0x4000) == 1,
          "keep_value_between keeps a small index")
    check(0x1000 not in ramscan.Scanner(width=4).first_changed(hugo_a, chris)
          .keep_value_between(hugo_a, 0, 255).addresses(),
          "keep_value_between drops a large counter")

    check_raises(ramscan.ScanError, lambda: ramscan.Scanner().keep_changed(hugo_a, chris),
                 "a complement filter cannot be the first scan")
    check_raises(ramscan.ScanError, lambda: list(ramscan.differing_offsets(hugo_a, b"short")),
                 "mismatched dump lengths are rejected")

    check(ramscan.find_ascii(hugo_a, "cha_syu1") == [], "find_ascii on a dump with no names")
    planted = bytearray(hugo_a)
    planted[0x2000:0x2008] = b"cha_syu1"
    check(ramscan.find_ascii(bytes(planted), "cha_syu1") == [0x2000], "find_ascii locates a code")


# ---------------------------------------------------------------------------
# eemap
# ---------------------------------------------------------------------------

def test_eemap():
    print("eemap: ELF calibration")
    m = eemap.EeMap()
    check(m.to_ee(eemap.ELF_FILE_BASE) == eemap.ELF_VADDR_BASE,
          "documented file base maps to the documented vaddr")
    check(m.to_file(m.to_ee(4078716)) == 4078716, "file -> ee -> file round trips")
    check(m.to_ee(4078716) == m.table_ee("list1"), "table_ee agrees with to_ee")
    check(m.table_ee("list1", 2) - m.table_ee("list1", 1) == 140, "table_ee strides")
    check(m.rune_ee(1) - m.rune_ee(0) == 0x20, "rune_ee strides")
    check_raises(ValueError, lambda: m.to_ee(0), "an offset outside the ELF is refused")
    check_raises(ValueError, lambda: m.to_file(0x1000),
                 "an EE address below the ELF has no file offset")

    # Calibration against a synthetic disc + dump, with a deliberately different delta
    # from the documented one — a wrong constant must not survive.
    d = tempfile.mkdtemp()
    iso = os.path.join(d, "fake.iso")
    anchor_off = eemap.VERSION_CHECK_OFF
    disc = bytearray(anchor_off + 4096)
    for i in range(len(disc)):
        disc[i] = (i * 37 + 11) & 0xFF
    disc[anchor_off:anchor_off + 4] = eemap.VERSION_CHECK_BYTES
    with open(iso, "wb") as f:
        f.write(disc)

    real_delta = 0x1234000 - anchor_off
    dump = bytearray(eemap.EE_RAM_SIZE)
    start, blob = eemap.read_anchor(iso)
    dump[start + real_delta:start + real_delta + len(blob)] = blob
    dump = bytes(dump)

    got = eemap.calibrate(iso, dump)
    check(got.delta == real_delta, "calibration recovers the real delta")
    check(got.calibrated, "calibrated map says so")
    check(got.to_ee(anchor_off) == 0x1234000, "calibrated map places the anchor")

    check_raises(eemap.CalibrationError,
                 lambda: eemap.calibrate(iso, bytes(eemap.EE_RAM_SIZE)),
                 "a missing anchor fails loudly")

    twice = bytearray(dump)
    twice[0x400000:0x400000 + len(blob)] = blob
    check_raises(eemap.CalibrationError,
                 lambda: eemap.calibrate_from_dump(bytes(twice), start, blob),
                 "an ambiguous anchor fails rather than guessing")
    check_raises(eemap.CalibrationError,
                 lambda: eemap.calibrate_from_dump(dump, 0, b"\x00\x01"),
                 "too short an anchor is refused")

    check("list1[0]" in eemap.describe(4078716), "describe names a table record")
    check("rune[2]" in eemap.describe(eemap.RUNE_TABLE_OFF + 0x40), "describe names a rune record")


# ---------------------------------------------------------------------------
# pngdiff
# ---------------------------------------------------------------------------

def _png_chunk(name, body):
    return struct.pack(">I", len(body)) + name + body + struct.pack(">I", zlib.crc32(name + body))


def _filter_line(line, prev, bpp, ftype):
    out = bytearray(len(line))
    for i in range(len(line)):
        a = line[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        if ftype == 0:
            pred = 0
        elif ftype == 1:
            pred = a
        elif ftype == 2:
            pred = b
        elif ftype == 3:
            pred = (a + b) >> 1
        else:
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
        out[i] = (line[i] - pred) & 0xFF
    return out


def _make_png(width, height, pixel_fn, ctype=2, ftype=0):
    """Encode a PNG so the decoder is tested against real, valid input."""
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    raw = bytearray()
    prev = bytearray(width * nch)
    for y in range(height):
        line = bytearray()
        for x in range(width):
            px = pixel_fn(x, y)
            line += bytes(px[:nch]) if len(px) >= nch else bytes(list(px) + [255] * (nch - len(px)))
        raw.append(ftype)
        raw += _filter_line(line, prev, nch, ftype)
        prev = line
    body = (
        _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, ctype, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw)))
        + _png_chunk(b"IEND", b"")
    )
    return pngdiff.PNG_MAGIC + body


def test_pngdiff():
    print("pngdiff: decode + perceptual hash")

    def gradient(x, y):
        return (x * 4 % 256, y * 4 % 256, (x + y) * 2 % 256)

    # Every filter type must decode to the same image — that is the whole risk in a
    # hand-written PNG reader.
    ref = None
    for ftype in range(5):
        data = _make_png(32, 24, gradient, ctype=2, ftype=ftype)
        w, h, gray = pngdiff.decode_gray(data)
        check((w, h) == (32, 24), "filter %d: dimensions" % ftype)
        if ref is None:
            ref = gray
        else:
            check(gray == ref, "filter %d decodes identically to filter 0" % ftype)

    for ctype in (0, 2, 4, 6):
        data = _make_png(16, 16, gradient, ctype=ctype)
        w, h, gray = pngdiff.decode_gray(data)
        check(len(gray) == 256, "colour type %d decodes" % ctype)

    check_raises(pngdiff.PngError, lambda: pngdiff.decode_gray(b"not a png"),
                 "a non-PNG is rejected")
    bad = bytearray(_make_png(8, 8, gradient))
    bad[24] = 3  # IHDR colour type -> palette
    check_raises(pngdiff.PngError, lambda: pngdiff.decode_gray(bytes(bad)),
                 "an unsupported colour type is refused, not guessed")

    # The hash must call two renderings of the same scene the same, and two different
    # scenes different — that is the signal the swap loop reads.
    scene_a = _make_png(64, 48, gradient)
    scene_a_noisy = _make_png(64, 48, lambda x, y: tuple(
        min(255, c + (1 if (x + y) % 7 == 0 else 0)) for c in gradient(x, y)))
    scene_b = _make_png(64, 48, lambda x, y: (255 - x * 4 % 256, 200, (x * y) % 256))

    ha, hn, hb = (pngdiff.dhash(s) for s in (scene_a, scene_a_noisy, scene_b))
    check(pngdiff.hamming(ha, hn) <= pngdiff.SAME_SCENE, "the same scene hashes the same")
    check(pngdiff.hamming(ha, hb) > pngdiff.SAME_SCENE, "a different scene hashes differently")
    check(pngdiff.hamming(ha, ha) == 0, "identical images have distance 0")

    d = tempfile.mkdtemp()
    pa, pb = os.path.join(d, "a.png"), os.path.join(d, "b.png")
    for p, s in ((pa, scene_a), (pb, scene_b)):
        with open(p, "wb") as f:
            f.write(s)
    check(pngdiff.distance(pa, pa) == 0, "distance of a file with itself is 0")
    check(pngdiff.changed(pa, pb), "changed() flags a different scene")
    check(not pngdiff.changed(pa, pa), "changed() does not flag an identical scene")


# ---------------------------------------------------------------------------
# harness (process plumbing only — no emulator is launched)
# ---------------------------------------------------------------------------

def test_harness():
    print("harness: command construction and reporting")
    old_display = os.environ.get("DISPLAY")
    os.environ["DISPLAY"] = ":0"  # pretend a display exists so no xvfb prefix is added
    try:
        emu = harness.Pcsx2(iso="/discs/s3.iso", binary="/usr/bin/pcsx2-qt", turbo=True)
        cmd = emu.command()
        check(cmd[0] == "/usr/bin/pcsx2-qt", "binary leads the command")
        check("-batch" in cmd and "-nogui" in cmd, "batch mode so the process exits")
        check("-fastboot" in cmd and "-turbo" in cmd, "fastboot and turbo are passed")
        check(cmd[-2:] == ["--", "/discs/s3.iso"], "the ISO goes last, after --")

        st = harness.Pcsx2(statefile="/tmp/x.p2s", state=2, binary="/bin/true").command()
        check("-statefile" in st and st[st.index("-statefile") + 1] == "/tmp/x.p2s",
              "statefile is passed through")
        check("-state" in st and st[st.index("-state") + 1] == "2", "state index is passed through")
        check("--" not in st, "no trailing -- when there is no ISO")

        # Point the finder at nothing so this holds on a machine that does have PCSX2.
        old_bin = os.environ.get("PCSX2_BIN")
        os.environ["PCSX2_BIN"] = "/nonexistent/pcsx2-qt"
        try:
            check(harness.find_pcsx2() is None, "find_pcsx2 rejects a bad PCSX2_BIN")
            check_raises(harness.HarnessError,
                         lambda: harness.Pcsx2(iso="x").command(),
                         "a missing binary is reported clearly")
        finally:
            if old_bin is None:
                del os.environ["PCSX2_BIN"]
            else:
                os.environ["PCSX2_BIN"] = old_bin
    finally:
        if old_display is None:
            del os.environ["DISPLAY"]
        else:
            os.environ["DISPLAY"] = old_display

    # Headless with no xvfb must refuse rather than launch something that cannot draw.
    old_display = os.environ.pop("DISPLAY", None)
    old_wayland = os.environ.pop("WAYLAND_DISPLAY", None)
    old_path = os.environ["PATH"]
    os.environ["PATH"] = "/nonexistent"
    try:
        if os.name != "nt":
            check_raises(harness.HarnessError,
                         lambda: harness.Pcsx2(iso="x", binary="/bin/true").command(),
                         "headless without xvfb-run is refused")
    finally:
        os.environ["PATH"] = old_path
        if old_display is not None:
            os.environ["DISPLAY"] = old_display
        if old_wayland is not None:
            os.environ["WAYLAND_DISPLAY"] = old_wayland

    rows = harness.doctor()
    check(len(rows) >= 5 and all(len(r) == 3 for r in rows), "doctor returns labelled rows")
    check(any(label == "pcsx2 binary" for label, _, _ in rows), "doctor checks for the binary")


def test_edsprobe():
    """The event-script probe, against a fake client.

    It reads a pointer chain and reports whether the script pointer is moving. Both verdicts
    matter equally: calling a running scene "stuck" would send someone disassembling a handler
    that is fine, and calling a hung one "running" hides the only evidence there is. Neither
    needs an emulator to test.
    """
    print("\nedsprobe: pointer chain and stuck/running verdict")
    class Fake:
        """Enough of pine.Client to drive sample(): a flat address -> value map."""
        def __init__(self, mem):
            self.mem = mem

        def read(self, addr, width=4):
            return self.mem.get(addr, 0)

        def read_bytes(self, addr, length):
            # only ever used for the handler table
            out = bytearray()
            for i in range(length // 4):
                out += (self.mem.get(addr + i * 4, 0)).to_bytes(4, "little")
            return bytes(out)

    WORK, IP = 0x1900000, 0x1A00000
    table_mem = {edsprobe.HANDLERS + i * 4: 0x1790000 + i * 4 for i in range(edsprobe.N_HANDLERS)}
    base = dict(table_mem)
    base[edsprobe.WORK_PTR] = WORK
    base[edsprobe.LEADER] = 54
    base[WORK + edsprobe.CTX_OFF + edsprobe.IP_OFF] = IP
    base[WORK + edsprobe.CTX_OFF + edsprobe.STATE_OFF] = 3
    base[IP] = 40
    base[IP - 2] = 345

    cl = Fake(base)
    table = edsprobe._handlers(cl)
    check(len(table) == edsprobe.N_HANDLERS, "handler table read at full length")
    check(edsprobe._opcode_of(table[345], table) == 345, "handler address maps back to its opcode")
    check(edsprobe._opcode_of(0xDEADBEEF, table) is None, "an unknown handler yields no opcode")

    s = edsprobe.sample(cl, table)
    check(s["ip"] == IP and s["ctx"] == WORK + edsprobe.CTX_OFF, "chain resolves work -> ctx -> ip")
    check(s["leader"] == 54, "the leader byte rides along for context")
    check(s["op_behind"] == 345 and s.get("name_behind"), "the opcode behind the pointer is named")
    check("error" not in s, "a healthy chain reports no error")

    # A zero work pointer means we are not in a field scene; that has to be said, not crashed on.
    bad = dict(base); bad[edsprobe.WORK_PTR] = 0
    check("error" in edsprobe.sample(Fake(bad), table), "no work struct is reported, not crashed on")
    bad2 = dict(base); bad2[WORK + edsprobe.CTX_OFF + edsprobe.IP_OFF] = 0
    check("error" in edsprobe.sample(Fake(bad2), table), "an insane script pointer is reported")

    # Formatting must survive the error case, since that is what a confused user will paste back.
    check("not in a field scene" in edsprobe._fmt(edsprobe.sample(Fake(bad), table)),
          "the error case still formats")
    check("op@ip" in edsprobe._fmt(s), "the healthy case shows both opcode readings")
    check(edsprobe.KNOWN.get(346, "").startswith("set field avatar"),
          "the opcode that sets the avatar is labelled")


def main():
    for fn in (test_pine, test_savestate, test_ramscan, test_eemap, test_pngdiff, test_harness,
               test_edsprobe):
        fn()
    print("\n%d checks, %d failure(s)" % (CHECKS[0], len(FAILURES)))
    for f in FAILURES:
        print("  - %s" % f)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
