S3 MultiTeam Test.ps2  —  in-game test for the multi-team recruit bitmask
==========================================================================

WHAT THIS TESTS
---------------
Our editor can set several protagonists' "team" bits (bits 2-5, mask 0x3C) on one
character at once. Late-game saves prove the GAME itself does this (the Hugo/Chris/
Geddoe merge group). The open question: pre-merge, does setting a foreign team bit
actually make that unit USABLE in your current protagonist's party, or does it only
RECORD the recruiter while story phase still gates availability?

This card lets you check in-game. It is a copy of a valid 8MB PS2 card; only the
save payloads + slot titles were changed (each gamedata keeps its own valid
checksum, so the game loads them normally).

THE 4 SLOTS
-----------
  Slot 1  "S3 MULTITEAM 1 CONTROL"     Pre-merge save (Chapter 2 era, 84 recruited),
                                        UNMODIFIED. Baseline.
  Slot 2  "S3 MULTITEAM 2 TEST 3UNITS" The SAME save, except three distinctive
                                        single-team units were given ALL four team
                                        bits (Hugo+Chris+Geddoe+Thomas):
                                            Fubar  (normally Hugo only)
                                            Ace    (normally Geddoe only)
                                            Borus  (normally Chris only)
  Slot 3  "S3 MULTITEAM 3 ALT CHAPTER" A different pre-merge chapter (Chapter 3 era),
                                        unmodified — a second scene to try.
  Slot 4  "S3 MULTITEAM 4 ENDGAME REF" A merged endgame save, for reference.

HOW TO RUN THE TEST
-------------------
1. Point your emulator (PCSX2) at this card, boot Suikoden III, choose LOAD.
   You'll see the four slots with the titles above (the in-game load screen reads
   each save's real data, so playtime/chapter show correctly).
2. Load Slot 1 first. Open party formation and note which units are available for
   your current protagonist. Fubar / Ace / Borus that don't belong to your
   protagonist should NOT be selectable.
3. Load Slot 2 (same point in the story). Open party formation again.
      * If Fubar/Ace/Borus that were foreign are NOW selectable  -> the team bit
        GATES availability (Interpretation A — cross-team use works).
      * If nothing changed                                       -> the bit only
        RECORDS the recruiter; story phase still gates them (Interpretation B).
4. Slot 3 lets you repeat the observation in a different chapter/protagonist.

Whichever protagonist that chapter puts you in, at least two of the three test
units are "foreign" to that team, so the comparison is meaningful in any slot.

(Regenerate with scratchpad/build_test_card.py — operates only on local saves;
no game data is committed to the repo.)
