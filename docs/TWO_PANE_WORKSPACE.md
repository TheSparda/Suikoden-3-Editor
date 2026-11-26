# Two-pane workspace: spec

Status: approved direction (Kevin, 2026-11-27), built as v1.156.0, local only until he says ship.
Origin: the UI review in `scratch/ui-review/` found 23 ISO views in one clipping chip strip,
no grouping, no per-view dirty markers, session actions scattered across a header card and a
sticky bar, and a 900px column wasting desktop width. Kevin picked the structural fix, made
small screens a first-class target (AYANEO Pocket Micro 2, 3.5in 960x640 panel), and pulled
all seven review quick wins into scope.

## Layout

Desktop (viewport width 1024px and up): the ISO editor becomes two panes.

- Left rail, 232px, sticky, full viewport height. It holds the view navigation as a grouped
  tree and, pinned at its foot, a session panel: disc name and size, then the action bar
  (Save, dirty pill, Undo, Redo, Export recipe, Export .xdelta, Apply patch, Revert all,
  Close, status line).
- Content pane: the existing header card and view card, per-view rendering unchanged
  (same drawView output, accordions, fields, dirty/revert vocabulary). The page column widens
  to 1400px while the ISO editor is open; the content pane caps at about 1100px and data-heavy
  views use the full pane width.

View groups (all 23 views from the VIEWS array in iso.js, each in exactly one group):

- Roster: Characters, Growth, Skill effects, Support
- World: Shops, Gear, Sets, Food, Text
- Combat: Weapons, Runes, Passives, Spells, Unites, Mounts, Enemies, War, Encounter, Movement
- System: Story content, Test, Changes, Reference

Below 1024px the rail is hidden and today's layout returns: chip strip in the card, sticky
action bar. The save editor is untouched and keeps the existing mode switch; the rail exists
only inside the ISO editor's rendered markup.

## One DOM, relocated

The nav strip and the action bar are rendered once, with the ids and handlers they have today
(#isoTabs, data-v chips, #isoSaveBtn and friends). A matchMedia mover places those two nodes
into the rail on desktop and back into the card below 1024px. Nothing is duplicated, so view
switching, the dirty badge, setStatus and the test suite's selectors all keep working in both
layouts. Group headings live in the nav markup and collapse away (display:contents) in strip
mode, so the strip looks and scrolls exactly as before.

## Per-view staged-edit counts

Each nav chip carries a count badge, shown when nonzero, in both layouts (on small screens
this is also the chip dirty dot the review asked for). Counts come from buildReview(), the
same rows the dirty badge and the save confirmation already use, with a view key added:

- FIELD_REG rows take the view that was active when the field was registered (reg() records
  it; an edit is attributed to the view it was made from).
- Enemy rows and the enemy bulk summary go to Enemies; room rows and the room summary to
  Encounter; the overlay potch rows to Sets; the Fortune multiplier and the Fortune switch
  to Passives; the Prosperity switch to Sets; the bulk/other summary to Growth (buildReview's
  own comment names bulk growth and skill-cap presets as its content).
- Character renames are not byte rows; the Characters card already shows their staged count,
  so the rail does not double-count them.

Counts are review rows, not bytes: one row per labelled change, matching the "N unsaved"
pill. updateDirtyBadge() refreshes them, so they move with every edit, undo and revert.

## Small screens (first-class, not a fallback)

The Micro 2 viewports in verification: 960x640 landscape, 480x320 landscape (the panel at
2x DPR), 320x480 portrait. At these sizes the rail stays hidden and the chip strip remains,
but the sticky action bar is slimmed (review medium item 10, now in scope here): when the
viewport is at most 820px wide, or at most 660px tall below the desktop breakpoint, the bar
keeps only Save, the dirty pill, Undo, Redo and a More button. Export recipe, Export .xdelta,
Apply patch, Revert all and Close move under More. Close therefore lives in the action bar
from now on, not in the header card; on desktop it sits in the rail session panel with the
other actions. Tap targets and the tab strip keep their current sizes.

## Quick wins folded in

1. Save-button label: updateDirtyBadge() no longer overwrites the mode-aware label.
   One label per mode everywhere (rail and sticky bar are the same button): "Apply & save
   to ISO" in place, "Apply & save patched ISO" when streaming, with the dirty dot appended
   while there are unsaved changes.
2. Boot error: a failed engine start says so in plain words ("Engine failed to start.
   Reload to try again.") and the raw error is demoted to a small details line in the boot
   gate, instead of being the message. One exception, found while building: the boot
   manifest check's own error already names the broken file and the fix in plain words,
   so that one stays as the gate's message rather than being demoted.
3. Status colours: .status.err uses a crimson (--err, brightened on the dark theme so it
   reads at 13px), and --ok is brightened on the dark theme. Gold stays for interactive
   and selected elements.
4. Tab-strip affordances: a fade mask on the clipped right edge in strip mode, the active
   chip is scrolled into view on view change, and the count badges above double as dirty
   markers.
5. Theme switching moves from the footer into the header as the same two labelled buttons.
   On a first visit (no saved choice) the theme follows prefers-color-scheme: light gets
   Parchment, dark gets Crimson & Gold.
6. Closed-row summaries: Characters rows (drawRecords, list1) show the starting level from
   the matching Growth record (both lists have 80 records, same index) and an "edited"
   marker when the record's bytes differ from the loaded disc; the marker also refreshes
   live as fields are marked dirty or clean. Growth rows already carry their summary line.
7. The global filter box is hidden on the Test and Changes views (neither reads it) and
   labelled per view everywhere else ("filter spells..." and so on).

## Out of scope (follow-ups, not in this build)

- Blurb hierarchy redesign (warnings never folded, three tiers).
- Full ARIA tab-semantics pass (role=tablist, arrow-key navigation, label association).
- Suikoden V editor parity: the same chrome specified once for both editors.
- Boot error copy beyond the one failure surface above.

## Preserved behaviour

Boot gate, accordion open-state and scroll restoration in drawView, undo/redo, staged vs
saved separation, PWA/service worker behaviour. Version v1.156.0, service worker cache
s3editor-v176, by the repo's usual two-file stamp (index.html footer, sw.js).

## Verification

- cd web/tests && npm test; npm run test:realiso; the full e2e gate (npm run test:gate).
  The known Changes-section load race (fails under parallel load on the base tree too,
  passes in isolation) is demonstrated, not hidden, if it appears.
- Screenshots in scratch/ui-review-v2/, local build with the real ISO loaded: desktop
  Characters, Test and Changes; mobile Characters; 960x640, 480x320 and 320x480 with the
  slim bar visible.
