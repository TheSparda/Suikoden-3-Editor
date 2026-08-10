#!/usr/bin/env bash
# Make a working copy of the Suikoden III ISO for safe patch testing, apply an
# example edit, and print PCSX2 verification steps. Never touches the original.
#
# Usage: ./make_test_iso.sh "/path/to/Suikoden III (USA).iso"
set -euo pipefail

SRC="${1:-ISO/Suikoden III (USA).iso}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DST="${SRC%.iso}.TEST.iso"

if [[ ! -f "$SRC" ]]; then echo "source ISO not found: $SRC" >&2; exit 1; fi

echo "Copying ISO -> $DST  (4.3 GB, ~a minute)..."
cp -c "$SRC" "$DST" 2>/dev/null || cp "$SRC" "$DST"   # -c = APFS clone (instant) when available

echo "Applying example edit to the COPY: Fire rune -> huge AOE damage..."
python3 "$HERE/s3patch.py" reskin-rune "$DST" --rune fire --power 3000 --aoe on --no-backup

cat <<'STEPS'

--- Verify in PCSX2 ---
1. Open PCSX2 -> load the *.TEST.iso (not your original).
2. Start/continue a game where a character has the Fire Rune equipped.
3. In battle, cast the Fire rune's spells (Flaming Arrows / Dancing Flames /
   Blazing Wall / Explosion).
   Expect: all four now hit for ~3000 and strike an AREA (target + surrounding
   foes) even the ones that were single-target before.
4. If it works, re-apply your real edits to a fresh copy of the original.
   If the game hangs or values look wrong, the original is untouched — just
   delete the .TEST.iso and try different values.

Note: on-screen spell *descriptions* still show old numbers (static text).
STEPS
echo "Done. Test ISO: $DST"
