"""PINE client — talk to a running PCSX2 over its instrumentation socket.

PINE ("Protocol for Instrumentation of Network Emulators") is PCSX2's built-in IPC
server: enable it under Settings -> Advanced -> Enable PINE Server (default slot
28011). It is the only supported way to read and write the emulated PS2's memory from
another process while the game runs, which is what makes any of this automatable —
without it the alternatives are screen-scraping or hand-driving the GUI debugger.

Wire format (one request may carry several commands back to back):

    request : u32 total_len (counts itself) | u8 opcode | args... | [next command...]
    reply   : u32 total_len (counts itself) | u8 result (0 = OK, 0xFF = FAIL) | data...

Reply payloads appear in command order with no per-command framing, so a batch is only
decodable because every opcode has a fixed-width result. That is also why `Client`
verifies batching with a two-read handshake on connect and falls back to one command
per message if the reply doesn't come back the expected length: the batch shape is the
part of this protocol we could not verify against a running emulator here, and a wrong
guess would silently mis-attribute values to addresses.

Transport is a unix socket on Linux/macOS ($XDG_RUNTIME_DIR or /tmp, named `pcsx2.sock`
for the default slot and `pcsx2.sock.<slot>` otherwise) and a loopback TCP port on
Windows.
"""
import os
import socket
import struct
import sys
import time

DEFAULT_SLOT = 28011

# Opcodes, per the PINE spec. Reads take a u32 address and answer with the value at the
# requested width; writes take the address followed by the value and answer with nothing.
MSG_READ8 = 0x00
MSG_READ16 = 0x01
MSG_READ32 = 0x02
MSG_READ64 = 0x03
MSG_WRITE8 = 0x04
MSG_WRITE16 = 0x05
MSG_WRITE32 = 0x06
MSG_WRITE64 = 0x07
MSG_VERSION = 0x08
MSG_SAVESTATE = 0x09
MSG_LOADSTATE = 0x0A
MSG_TITLE = 0x0B
MSG_ID = 0x0C
MSG_UUID = 0x0D
MSG_GAMEVERSION = 0x0E
MSG_STATUS = 0x0F

RES_OK = 0x00
RES_FAIL = 0xFF

# Emulator run states reported by MSG_STATUS.
STATUS_RUNNING = 0
STATUS_PAUSED = 1
STATUS_SHUTDOWN = 2

_READ_OP = {1: MSG_READ8, 2: MSG_READ16, 4: MSG_READ32, 8: MSG_READ64}
_WRITE_OP = {1: MSG_WRITE8, 2: MSG_WRITE16, 4: MSG_WRITE32, 8: MSG_WRITE64}

# EE main RAM. Addresses outside this are rejected before they reach the socket: PCSX2
# answers an out-of-range read with a plain failure, which is indistinguishable from
# "the emulator went away" and makes a long scan very confusing to debug.
EE_RAM_BASE = 0x00000000
EE_RAM_SIZE = 32 * 1024 * 1024


class PineError(RuntimeError):
    """A PINE command failed, or the emulator answered something unparseable."""


def socket_candidates(slot=DEFAULT_SLOT):
    """Every path/endpoint a PCSX2 on `slot` might be listening on, best guess first.

    Returns a list of ("unix", path) / ("tcp", (host, port)) pairs. PINE's socket
    directory follows XDG on Linux and TMPDIR on macOS, and the default slot drops the
    numeric suffix, so several spellings are plausible on any one machine.
    """
    override = os.environ.get("PINE_SOCKET")
    if override:
        return [("unix", override)]
    if sys.platform == "win32":
        return [("tcp", ("127.0.0.1", slot))]

    names = ["pcsx2.sock.%d" % slot]
    if slot == DEFAULT_SLOT:
        names.insert(0, "pcsx2.sock")
    dirs = []
    for env in ("XDG_RUNTIME_DIR", "TMPDIR"):
        d = os.environ.get(env)
        if d:
            dirs.append(d.rstrip("/"))
    dirs.append("/tmp")

    seen, out = set(), []
    for d in dirs:
        for n in names:
            p = os.path.join(d, n)
            if p not in seen:
                seen.add(p)
                out.append(("unix", p))
    return out


class Client:
    """A connected PINE session. Use as a context manager."""

    def __init__(self, slot=DEFAULT_SLOT, timeout=5.0, endpoint=None):
        self.slot = slot
        self.timeout = timeout
        self.endpoint = endpoint
        self.sock = None
        self.batching = True

    # -- connection ---------------------------------------------------------

    def connect(self):
        endpoints = [self.endpoint] if self.endpoint else socket_candidates(self.slot)
        errors = []
        for kind, addr in endpoints:
            try:
                if kind == "unix":
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                else:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(self.timeout)
                s.connect(addr)
            except OSError as e:
                errors.append("%s: %s" % (addr, e))
                continue
            self.sock = s
            self.endpoint = (kind, addr)
            self._probe_batching()
            return self
        raise PineError(
            "no PINE server reachable on slot %d. Is PCSX2 running with "
            "Settings -> Advanced -> Enable PINE Server ticked?\n  tried: %s"
            % (self.slot, "; ".join(errors))
        )

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def __enter__(self):
        if self.sock is None:
            self.connect()
        return self

    def __exit__(self, *exc):
        self.close()

    def _probe_batching(self):
        """Send two reads in one message; if the reply isn't 8 bytes of payload, stop
        batching. Cheap insurance against a protocol revision that framed replies
        differently — everything still works, just slower.

        A desync here would poison every later command, so a failed probe also drops the
        connection back to one command per message rather than leaving unread bytes on
        the socket.
        """
        cmds = [self._cmd(MSG_READ32, struct.pack("<I", 0)),
                self._cmd(MSG_READ32, struct.pack("<I", 4))]
        try:
            self.batching = len(self._exchange(cmds)) == 8
        except (PineError, OSError):
            self.batching = False
            # Anything the server may still be sending would land in the middle of the
            # next reply; start clean.
            self._reconnect()

    def _reconnect(self):
        kind, addr = self.endpoint
        self.close()
        s = socket.socket(socket.AF_UNIX if kind == "unix" else socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(addr)
        self.sock = s

    # -- framing ------------------------------------------------------------

    @staticmethod
    def _cmd(opcode, args=b""):
        """One command: opcode byte plus its arguments. No length prefix — the prefix
        belongs to the *message*, and several commands may share one."""
        return bytes([opcode]) + args

    def _recv_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise PineError("PINE connection closed by the emulator (it probably exited)")
            buf += chunk
        return bytes(buf)

    def _exchange(self, commands):
        """Send one message carrying `commands`, return its payload (result byte
        stripped). One length prefix covers the whole message."""
        if self.sock is None:
            raise PineError("not connected")
        body = b"".join(commands)
        self.sock.sendall(struct.pack("<I", 4 + len(body)) + body)
        (total,) = struct.unpack("<I", self._recv_exact(4))
        if total < 5:
            raise PineError("malformed PINE reply header (len=%d)" % total)
        body = self._recv_exact(total - 4)
        if body[0] != RES_OK:
            raise PineError("PINE command failed (result=0x%02X)" % body[0])
        return body[1:]

    def _batch(self, commands, result_widths):
        """Run `commands` and split the reply by `result_widths`.

        Replies carry no per-command framing, so the split is only valid because every
        opcode used here has a fixed-width result. A reply of the wrong total length
        means that assumption broke; raise rather than hand back mis-aligned values.
        """
        if not commands:
            return []
        if self.batching:
            payload = self._exchange(commands)
            want = sum(result_widths)
            if len(payload) != want:
                raise PineError(
                    "PINE batch reply was %d bytes, expected %d" % (len(payload), want)
                )
            out, pos = [], 0
            for w in result_widths:
                out.append(payload[pos:pos + w])
                pos += w
            return out
        return [self._exchange([c]) for c in commands]

    # -- memory -------------------------------------------------------------

    @staticmethod
    def _check_range(addr, length):
        if addr < EE_RAM_BASE or addr + length > EE_RAM_BASE + EE_RAM_SIZE:
            raise ValueError(
                "0x%08X+%d is outside EE main RAM (0x%08X..0x%08X)"
                % (addr, length, EE_RAM_BASE, EE_RAM_BASE + EE_RAM_SIZE - 1)
            )

    def read(self, addr, width=4):
        """Read one unsigned little-endian value of `width` bytes (1/2/4/8)."""
        return self.read_many([(addr, width)])[0]

    def read_many(self, requests):
        """Read many (addr, width) pairs in as few round trips as the server allows."""
        cmds, widths = [], []
        for addr, width in requests:
            if width not in _READ_OP:
                raise ValueError("bad read width %r" % (width,))
            self._check_range(addr, width)
            cmds.append(self._cmd(_READ_OP[width], struct.pack("<I", addr)))
            widths.append(width)
        out = []
        for raw, w in zip(self._batch(cmds, widths), widths):
            out.append(int.from_bytes(raw[:w], "little"))
        return out

    def read_bytes(self, addr, length, chunk=256):
        """Read a byte range. Assembled from 8-bit reads, so it is fine for a record or
        a table but not for scanning all 32 MB — take a savestate for that (see
        savestate.py, which pulls eeMemory.bin straight out of the .p2s)."""
        self._check_range(addr, length)
        out = bytearray()
        for start in range(0, length, chunk):
            n = min(chunk, length - start)
            vals = self.read_many([(addr + start + i, 1) for i in range(n)])
            out += bytes(vals)
        return bytes(out)

    def write(self, addr, value, width=4):
        """Write one unsigned little-endian value of `width` bytes."""
        self.write_many([(addr, value, width)])

    def write_many(self, writes):
        cmds = []
        for addr, value, width in writes:
            if width not in _WRITE_OP:
                raise ValueError("bad write width %r" % (width,))
            self._check_range(addr, width)
            cmds.append(
                self._cmd(
                    _WRITE_OP[width],
                    struct.pack("<I", addr) + int(value).to_bytes(width, "little"),
                )
            )
        self._batch(cmds, [0] * len(cmds))

    def write_bytes(self, addr, data, chunk=256):
        self._check_range(addr, len(data))
        for start in range(0, len(data), chunk):
            piece = data[start:start + chunk]
            self.write_many([(addr + start + i, b, 1) for i, b in enumerate(piece)])

    # -- emulator control ---------------------------------------------------

    def _string_cmd(self, opcode):
        payload = self._exchange([self._cmd(opcode)])
        # String replies are a u32 length followed by a NUL-terminated string.
        if len(payload) < 4:
            raise PineError("short string reply for opcode 0x%02X" % opcode)
        (n,) = struct.unpack("<I", payload[:4])
        return payload[4:4 + n].split(b"\0", 1)[0].decode("utf-8", "replace")

    def version(self):
        return self._string_cmd(MSG_VERSION)

    def title(self):
        return self._string_cmd(MSG_TITLE)

    def game_id(self):
        """The disc serial, e.g. SLUS-20387 — the check that we booted the right disc."""
        return self._string_cmd(MSG_ID)

    def game_version(self):
        return self._string_cmd(MSG_GAMEVERSION)

    def status(self):
        payload = self._exchange([self._cmd(MSG_STATUS)])
        return int.from_bytes(payload[:4], "little")

    def save_state(self, slot):
        self._exchange([self._cmd(MSG_SAVESTATE, bytes([slot & 0xFF]))])

    def load_state(self, slot):
        self._exchange([self._cmd(MSG_LOADSTATE, bytes([slot & 0xFF]))])


def connect(slot=DEFAULT_SLOT, timeout=5.0, retries=0, delay=1.0):
    """Connect, optionally retrying — a freshly launched PCSX2 needs a second or two
    before the socket exists."""
    last = None
    for attempt in range(retries + 1):
        try:
            return Client(slot=slot, timeout=timeout).connect()
        except PineError as e:
            last = e
            if attempt < retries:
                time.sleep(delay)
    raise last


def wait_for_game(client, serial=None, timeout=120.0, poll=1.0):
    """Block until the emulator reports a running game (and, if given, the expected
    disc serial). Booting a PS2 disc takes tens of seconds, so every automated step has
    to gate on this rather than a fixed sleep."""
    deadline = time.time() + timeout
    seen = None
    while time.time() < deadline:
        try:
            if client.status() == STATUS_RUNNING:
                seen = client.game_id()
                if serial is None or serial.replace("_", "-") in seen.replace("_", "-"):
                    return seen
        except PineError:
            pass
        time.sleep(poll)
    raise PineError(
        "timed out waiting for a running game%s (last serial seen: %r)"
        % ("" if serial is None else " with serial %s" % serial, seen)
    )
