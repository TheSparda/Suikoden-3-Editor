#!/usr/bin/env python3
"""What is the event-script interpreter doing right now?

Written for one question: **why does a scripted scene hang when the field avatar is not one
of the four protagonists?** Three characters have been seen to softlock one (Koroku, Yuber,
Lucia), and ordinary dialogue works fine for all of them — so the interpreter and the text
path are healthy and something inside a *scene* is waiting forever.

Guessing has already cost two wrong answers (the per-team story index, then a missing
animation clip). This reads the answer instead. While the game is stuck, the EDS interpreter
is parked on one opcode; sampling the instruction pointer twice tells you whether it is
spinning, and the opcode number says on what.

    python3 -m tools.pcsx2.edsprobe                 # one sample
    python3 -m tools.pcsx2.edsprobe --watch 20      # 20 samples, ~2s apart

Needs PCSX2 running with PINE enabled (Settings -> Advanced -> Enable PINE Server). Nothing
is written; every access is a read.

How the chain was derived, so it can be re-checked rather than trusted:

  *(0x196A4D0)                the field/scene work pointer (MOUNT_SYSTEM_RESEARCH.md §8)
  work + 0x150                the EDS script context -- both interpreter entry points
                              (0x1778768, 0x1778D78) compute it as `a1 + 0x150` right after
                              loading the work pointer
  ctx + 0x0C                  the script stream pointer; every opcode handler reads its
                              operands through `lw $v0, 0xc($s0)`
  0x19828F8                   the 359-entry handler table; opcode = (handler - table) / 4

The opcode is read from just behind the stream pointer because handlers advance it past the
opcode word before reading operands; both readings are printed so a mis-derivation is
visible rather than silent.
"""
import argparse
import time

from . import pine

WORK_PTR = 0x196A4D0        # -> the field/scene work struct
CTX_OFF = 0x150             # work + this = the EDS script context
IP_OFF = 0x0C               # ctx + this = the script stream pointer
STATE_OFF = 0xDC            # ctx + 0x150 + 0xdc is read at the top of the interpreter loop
HANDLERS = 0x19828F8        # 359-entry opcode -> handler table
N_HANDLERS = 359
LEADER = 0x196B3F2          # the party-leader / field-avatar id, for context in the output

# Opcodes whose handlers were mapped while chasing the avatar work; a name here is a
# convenience, not a requirement -- an unnamed opcode is still fully identified by number.
KNOWN = {
    16: "leader dispatch (debug-printf variant)",
    22: "EdsCRideOnSetS",
    24: "EdsCRideOffSetS",
    26: "actor list build (leader at slot 0)",
    27: "actor list build (leader at slot 0)",
    40: "actor resolve (param 0 = the leader)",
    55: "camera target by model id",
    56: "camera target by model id",
    63: "per-team dispatch",
    64: "per-team dispatch",
    82: "per-team dispatch",
    83: "per-team dispatch",
    88: "leader -> actor record",
    108: "EdsCHorseDashSetS",
    109: "EdsCHorseInanakiE",
    310: "leader character query",
    324: "player-object compare",
    345: "field-avatar model request",
    346: "set field avatar (reads a char id from the script)",
}


def _handlers(cl):
    """opcode -> handler address, straight out of the live table."""
    raw = cl.read_bytes(HANDLERS, N_HANDLERS * 4)
    return [int.from_bytes(raw[i * 4:i * 4 + 4], "little") for i in range(N_HANDLERS)]


def _opcode_of(handler_addr, table):
    try:
        return table.index(handler_addr)
    except ValueError:
        return None


def sample(cl, table):
    """One reading of the interpreter's state. Returns a dict; `ip` is the thing to watch."""
    work = cl.read(WORK_PTR, 4)
    out = {"work": work, "leader": cl.read(LEADER, 2)}
    if not work or work < 0x100000 or work > 0x2000000:
        out["error"] = "no field/scene work struct (not in a field scene?)"
        return out
    ctx = work + CTX_OFF
    out["ctx"] = ctx
    out["state"] = cl.read(ctx + STATE_OFF, 2)
    ip = cl.read(ctx + IP_OFF, 4)
    out["ip"] = ip
    if not ip or ip < 0x100000 or ip > 0x2000000:
        out["error"] = "script stream pointer is not a sane address (no script running?)"
        return out
    # Handlers advance past the opcode before reading operands, so the word behind the
    # pointer is the one executing; the word at it is printed too, in case the offset is off.
    out["op_at"] = cl.read(ip, 2)
    out["op_behind"] = cl.read(ip - 2, 2)
    for key, raw in (("at", out["op_at"]), ("behind", out["op_behind"])):
        if raw is not None and raw < N_HANDLERS:
            out[f"name_{key}"] = KNOWN.get(raw, "")
            out[f"handler_{key}"] = table[raw]
    return out


def _fmt(s):
    if "error" in s:
        return f"  work={s['work']:08X}  leader={s.get('leader')}  -- {s['error']}"
    bits = [f"ip={s['ip']:08X}", f"state={s['state']}",
            f"op@ip={s['op_at']}", f"op@ip-2={s['op_behind']}"]
    for key in ("behind", "at"):
        h = s.get(f"handler_{key}")
        if h:
            nm = s.get(f"name_{key}") or ""
            bits.append(f"[{key}] op {s['op_' + key]} -> {h:08X}{' ' + nm if nm else ''}")
    return "  " + "  ".join(bits)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--watch", type=int, default=1,
                    help="take N samples ~2s apart (default 1). Use this while the game is hung.")
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between samples")
    ap.add_argument("--slot", type=int, default=pine.DEFAULT_SLOT)
    args = ap.parse_args(argv)

    try:
        cl = pine.Client(slot=args.slot)
        cl.connect()
    except Exception as exc:                                  # noqa: BLE001 - reported, not raised
        print(f"cannot reach PCSX2 over PINE: {exc}")
        print("Start PCSX2 with Settings -> Advanced -> Enable PINE Server, then retry.")
        return 1

    with cl:
        try:
            print(f"title: {cl.title()}   id: {cl.game_id()}")
        except Exception:                                     # noqa: BLE001 - cosmetic only
            pass
        table = _handlers(cl)
        seen = []
        for i in range(max(1, args.watch)):
            s = sample(cl, table)
            seen.append(s)
            print(f"[{i + 1}/{args.watch}]" + _fmt(s))
            if i + 1 < args.watch:
                time.sleep(args.interval)

    ips = [s.get("ip") for s in seen if s.get("ip")]
    if len(ips) > 1:
        if len(set(ips)) == 1:
            print(f"\nSTUCK: the script pointer never moved across {len(ips)} samples.")
            last = seen[-1]
            for key in ("behind", "at"):
                h = last.get(f"handler_{key}")
                if h:
                    print(f"  candidate: opcode {last['op_' + key]} -> handler {h:08X}"
                          f"{'  ' + last['name_' + key] if last.get('name_' + key) else ''}")
            print("  Disassemble that handler to see what it is waiting on:")
            print("    python3 Editor/re_elf.py dis <handler> 0x80 'ISO/Suikoden III (USA).iso'")
        else:
            print(f"\nRUNNING: the script pointer moved ({len(set(ips))} distinct values). "
                  "If the game looks hung, the wait is not in the EDS interpreter.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
