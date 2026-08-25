# Recruitment Randomizer — Research Plan

**Question:** *Can we shuffle recruitment requirements for a Suikoden III randomizer mode, and how would we approach it?*

**Short answer:** Yes in principle, but recruitment is **scripted, not table-driven**, so a "true" ISO randomizer is a real reverse-engineering effort. There is a spectrum of approaches — from one we can ship now with zero ISO hacking, to a full event-script rewrite. This plan defines the concept precisely, records what the disc recon already told us, lays out the approaches by effort/risk, and gives a phased plan with go/no-go gates.

---

## 1. Define the concept precisely

"Shuffle recruitment requirements" can mean three quite different things. They differ enormously in difficulty, so we pick deliberately:

| # | Interpretation | Player experience | Difficulty |
|---|----------------|-------------------|------------|
| **A** | **Reward shuffle** — keep each recruit *trigger* where it is, change *which character* it grants | "Watari's 100k-potch task now gives you Ace instead" — every character ends up behind a different requirement | Hard (script/ELF RE) |
| **B** | **Condition shuffle** — keep each character, swap their *conditions* | "To get Watari you now need 50 Stars; Sanae now costs 100k potch" | Hardest (rewrite conditions) |
| **C** | **Parameter shuffle** — keep triggers + characters, randomize numeric *parameters* (potch cost, star threshold) *if* they are data | "Watari now costs a random amount; the star-gate is a random number" | Medium *iff* parameters are table-driven |

For a first randomizer, **Interpretation A (reward shuffle)** is the standard choice in the romhacking world: it produces exactly the "different requirement for every unit" feel the question asks for, without having to *author* new conditions — we only have to find and remap a character-id operand at each existing recruit point. B and C are stretch goals.

**Non-goal for v1:** rewriting dialogue, adding new conditions, or changing story-critical (auto-join) recruits.

---

## 2. What the disc recon already established

Confirmed by inspecting the real 4 GB USA ISO (`ISO/Suikoden III (USA).iso`):

- **Disc layout:** `SLUS_203.87` (main ELF, 3.9 MB), `DATA/` (per-area packed `.BIN` archives), `MODULES/` (only Sony IRX drivers — irrelevant), `MOVIE/`, `SD/`.
- **All known ISO tables are pure data** — character stats (`0x3E3C7C`), growth/skill caps (`0x3E1338`), support skills, shops/prices, the spell/rune-effect table (`0x3EC2A0`). See `Editor/Suikoden3_ISO_offsets.md`. **None of them is a recruitment table.**
- **Recruitment is not a lookup** — it's the *result* of event logic. In the save, meeting a condition sets that character's **recruit word** (`RECRUIT_OFF = 0x232`, per-char u16, bits 2–5 = team bitmask). We fully understand the *recorded state*; what we lack is the *code/script that writes it*.
- **`DATA/*.BIN` are packed archives**, one per area/scenario (`HNKT`, `KRVI`, `LZVI`, `IKVI`, …). `FSECT.BIN` (89 KB) is a **32-bit offset/pointer table** — almost certainly the archive table-of-contents. This is the single most important early RE target: crack FSECT and we can extract the sub-files (maps + event scripts).
- **No English identifiers** — the ELF's strings are engine internals (`walk_start_L`, …); a Japanese-developed 2002 title has no `recruit`/`join` strings to anchor on. Everything is compiled MIPS + bytecode.

**Implication:** recruit "grant" happens in one (or both) of two places — a central routine in the **ELF** (e.g. a `set_recruit(charId)` function or a recruit-flag table it indexes), and/or per-event **script bytecode** inside `DATA/*.BIN`. Which one determines whether this is *medium* or *hard*.

---

## 3. Approaches, by tier

### Tier 0 — Save-side "logical" randomizer *(ships now, zero ISO hacking)*
Generate, from a seed, a randomized **recruitment plan** — a permutation that says which unit sits behind which "slot," plus which are locked until N others are recruited — and **enforce/track it through the existing save editor** (recruit bitmask) and the **108 Stars dashboard**. It's a self-imposed *challenge* randomizer: the game's triggers are unchanged; the tool defines and polices the rule set, and can flip recruit bits to match the plan.
- **Feasibility:** high — we already have the recruit bitmask, `s3_recruit_meta.json` (all 108 requirements), and the dashboard.
- **Value:** real and immediate; good seed-sharing/challenge-run feature.
- **Limit:** doesn't change what the *game* does in-story; it's a layer on top.

### Tier 1 — ELF-level recruit hook *(medium)*
If the game routes every recruit through a **central ELF routine or a recruit-id table**, we can remap at the ELF level (patch the table, or the character-id the routine is called with) — one clean patch point, no archive format needed.
- **How we'd find it:** PCSX2 debugger. Set a **write breakpoint on the save's recruit-word region** (or the in-RAM mirror), recruit a unit in-game, and catch the code that writes it. Backtrace to the routine + its char-id argument. Repeat for 2–3 recruits to see if it's one shared routine.
- **Feasibility:** medium; depends entirely on whether recruitment is centralized. Common in JRPGs.
- **Value:** could deliver a genuine reward-shuffle with far less work than script RE.

### Tier 2 — Event-script reward shuffle *(hard, the "full" randomizer)*
Decode `FSECT.BIN` → extract `DATA/*.BIN` sub-files → identify the event-script **opcode that grants a character** → remap its char-id operand at every recruit point → repack → rebuild ISO.
- **Feasibility:** hard. Requires reverse-engineering (a) the archive/TOC format and (b) the script bytecode's "recruit" opcode. No public tooling is assumed.
- **Value:** the complete, authentic randomizer if Tier 1 proves recruitment is script-driven rather than centralized.

### Tier 3 — Condition / parameter shuffle *(hardest — stretch)*
Interpretation B/C: rewrite the *conditions* (star thresholds, potch costs, dialogue gates). Needs full script comprehension and careful softlock avoidance. **Out of scope for a first version**; revisit only if Tier 2 succeeds and parameters turn out to be reachable.

---

## 4. Recommended strategy

**Run two tracks in parallel:**

1. **Ship Tier 0 now** — a seed-based recruitment-challenge randomizer built on the 108 Stars dashboard. Delivers a usable "randomizer mode" immediately and is independently valuable.
2. **Recon Tier 1** — a time-boxed PCSX2-debugger investigation to answer the one question that decides everything: *is recruitment centralized in the ELF, or scattered across scripts?* The answer routes us to Tier 1 (medium) or Tier 2 (hard), or tells us to stop at Tier 0.

Only commit to Tier 2 after Tier 1 recon, behind a go/no-go gate.

---

## 5. Key research questions & how to answer each

| Q | Question | Method | Decides |
|---|----------|--------|---------|
| Q1 | Is there a single ELF routine / table that grants recruits? | PCSX2 write-breakpoint on the recruit-word RAM mirror; backtrace on 2–3 recruits | Tier 1 vs Tier 2 |
| Q2 | What is the `FSECT.BIN` / `DATA/*.BIN` archive format? | Parse the 32-bit offset table; correlate offsets to sub-file boundaries; look for sub-headers/magic | Whether Tier 2 is even tractable |
| Q3 | Which recruits are story-critical (must never shuffle)? | Already have it — `auto:true` in `s3_recruit_meta.json` (54 story, 53 optional) | The shuffle's safe candidate pool |
| Q4 | What are the dependency chains? (e.g. "joins with Duke," "50 Stars first") | `how` text in `s3_recruit_meta.json` + manual graph | Logic constraints so a seed stays completable |
| Q5 | Does shuffling break the 108-for-best-ending / merge logic? | In-emulator test on a Tier-0 or Tier-1 build | Whether "all 108" stays achievable |
| Q6 | How do we rebuild the ISO after edits? | Reuse the ranged-read + VCDIFF/xdelta pipeline already built; validate the `0x3F1E60` version word | Delivery mechanics |

---

## 6. Constraints & hazards

- **Story auto-joins (54 of 108) are off-limits.** Shuffling them risks softlocks; the shuffle pool is the **53 optional recruits** (already classified).
- **Dependency chains** — "joins with Duke/Futch/Franz," Melville's Ch1→Ch4 two-step, "recruit 50 Stars first," Nash's leave/rejoin. The randomizer's logic must respect these or a seed becomes uncompletable.
- **Party merge** — pre/post-merge team membership (the bitmask work) interacts with availability; a shuffled unit must still be reachable in the phase where its trigger fires.
- **Best-ending gate** — the 108-Stars ending must remain achievable; verify no unit becomes mutually exclusive.
- **Missables** — some recruits are chapter-windowed; the plan must not place a required unit behind an already-passed window.
- **Rebuild integrity** — keep the disc's version word valid; checksum/size discipline; test in PCSX2 before claiming success.

---

## 7. Assets we already have (accelerators)

- **Recruit bitmask fully reverse-engineered** — `RECRUIT_OFF`, per-char word, team bits; read/write proven.
- **`s3_recruit_meta.json`** — all 108 classified story/optional **with full how-to-recruit text** (the requirement graph, in prose).
- **108 Stars dashboard** — ready-made UI for a Tier-0 tracker/enforcer.
- **Save + ISO editors** — decode/patch/verify, undo/redo, and a **ranged-read + VCDIFF/xdelta** pipeline that already rebuilds a 4 GB ISO without holding it in memory.
- **Offset-verification methodology** — brute-force sweeps, correlation, ground-truth cross-checks (how issue #2 and the multi-team model were validated) — directly reusable for Q1/Q2.

---

## 8. Phased plan with decision gates

**Phase 0 — Tier-0 randomizer (build).**
Seed → randomized recruitment plan (respecting story/optional split + dependency graph from `recruit_meta`) → dashboard mode that shows the seed's assignments, tracks progress, and can set recruit bits to match. Deliverable: a working challenge randomizer + shareable seeds.

**Phase 1 — Tier-1 recon (investigate, time-boxed).**
PCSX2 write-breakpoint study (Q1). Deliverable: a note stating whether recruitment is centralized (→ Tier 1 patch feasible) or script-driven (→ Tier 2). **Gate G1:** proceed only if a clean patch point or a tractable archive format appears.

**Phase 2 — Tier-1 patch OR Tier-2 archive RE (conditional on G1).**
Either patch the ELF recruit routine/table for a real reward-shuffle, or crack `FSECT.BIN` (Q2) and locate the script recruit opcode. Deliverable: a proof-of-concept single remap verified in-emulator (e.g. "Watari's task now grants Ace"). **Gate G2:** one remap must work end-to-end before scaling to all 53.

**Phase 3 — Full reward shuffle + logic guarantees.**
Generalize to the whole optional pool with a completability solver (Q4/Q5), seed UI, and ISO rebuild via the existing pipeline. Deliverable: seed → patched ISO.

**Phase 4 (stretch) — Condition/parameter shuffle (Tier 3).** Only if Phase 3 lands and parameters prove reachable.

---

## 9. What could kill it (honest risks)

- Recruitment is **fully decentralized** across dozens of area scripts with no shared routine → Tier 2 only, and the archive/script formats resist RE → effort balloons.
- The archive is **compressed** (the huge `.BIN` sizes hint at bundled assets) → add a decompress/recompress step of unknown format.
- **Completability** proves hard to guarantee across chapter windows + merge phases → shuffle must be conservative (fewer units in the pool).
- **Anti-tamper/checksums** beyond the known version word → rebuild rejected by the game.

If any of these bite, **Tier 0 still stands on its own** as a shipped "randomizer mode," which is why we build it first.

---

## 10. Recommended next step

Build **Phase 0 (Tier-0 randomizer)** now — it's high-value, low-risk, and reuses the dashboard — and, in parallel, do the **Phase 1 PCSX2 recon** to learn whether a real ISO-level shuffle is medium or hard before committing to it.
