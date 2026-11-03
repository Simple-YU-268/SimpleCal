# SimpleCal Hallmark UI review

Reviewed 2026-11-03 with Nutlope/hallmark 2.0.0. Scope: application shell,
month calendar, calendar navigation, task pane, and responsive layouts.
Synthetic events are used in `code/web/hallmark-preview.html`; no account data
is included in screenshots.

## Findings and changes

| Finding | Impact | Implemented change |
| --- | --- | --- |
| Four independently rounded, outlined panels | Repeated framing competes with the calendar | Continuous desktop workspace, hairline region boundaries, opaque surfaces |
| Large outer margins and panel gutters | Less room for events at common laptop widths | Full-height shell with a capped width and a 224px navigation rail |
| Tracked small labels | Chinese weekday and calendar labels are harder to scan | Zero tracking, 12px weekday labels, 13px section labels |
| Small date hierarchy | Events and navigation compete for attention | 16px desktop day numbers and larger period heading |
| Multiple shadows on routine controls | Unnecessary visual weight | Flat primary creation control and restrained segmented controls |
| Focus styles vary across controls | Keyboard location can be unclear | Immediate shared focus-visible ring |

Brand indigo, saved calendar colors, existing navigation, handler wiring and
mobile drawers remain. The new shell intentionally replaces the older floating
panel treatment in DESIGN.md. All new styling consumes existing theme tokens.
Dark mode and custom accents therefore follow the existing theme mechanism.

## Evidence and limits

Hallmark rendered five sizes including 375, 1280, 1440 and 1920px. Before/after
comparison: `.hallmark/compare.html` (generated locally, ignored by Git).
Independent browser smoke checks cover widths 320, 375, 768, 1024, 1440 and 1920,
task-pane toggling and dark mode: no horizontal document overflow or page errors.

The original `renewal.css` scan reported 13 Floor findings and 23 Reflex findings.
The new stylesheet scan reports zero Floor findings and one explicitly waived
compact-calendar control-height finding. These are different source scopes:
this does **not** mean all legacy CSS findings have been removed. Legacy literal
colors, off-scale spacing and older tracked declarations remain in their source
files; the new cascade overrides the relevant rendered shell styles.

The compact mini-calendar retains its 28px date cells. Hallmark recommends larger
controls; expanding every cell to 32px caused overflow in the narrow seven-column
picker. The existing dimensions were retained and recorded as an exception.

Finish review performed in-thread: the calendar remains the visual anchor;
desktop framing is simpler; mobile preserves visible navigation. The previous
layout offered more decorative separation between regions. No new photo or
marketing material is appropriate for this operational screen.

Production build passes. Browser smoke checks use synthetic content and do not
replace physical-device touch testing or real-account workflow acceptance.

Frontend regression suite for the first shell pass: 122 files passed, 1520 tests
passed and one existing test skipped. Calendar scan: zero FAIL, zero WARN,
one WAIVED (39b).

## Settings and editor follow-up

Desktop settings now use a 760px dialog with a vertical category rail and aligned
option rows. Phones retain horizontal tabs; the seven accent choices fit on one
row at the common 375px width. Footer information uses less space. Event editors
share the same 8px modal radius, spacing, labels and stronger field boundaries.
Task filters distribute evenly across the pane, with consistent task text rhythm.

Vertical settings tabs support Up/Down as well as Left/Right, and their ARIA
orientation follows the viewport. The media listener is removed on close.
The hidden native color input no longer creates an invisible extra Tab stop;
the visible custom-color button still opens it.

Validation: 121 tests passed across settings, editors, tasks and calendar colors;
production build passed. Browser checks covered both modals at 320, 375, 768,
1024, 1440 and 1920px, including settings tab selection and keyboard movement.
No modal escaped the viewport, no horizontal document overflow, no page errors.
Screenshots were inspected on desktop and phone with synthetic content.

Settings and editor Hallmark scans each report zero FAIL, one WARN and one
WAIVED (39b). The F19 warning is acknowledged: the rendered application retains
four font weights from the existing type system, including bold emphasis in
controls. This round does not claim that warning or the legacy source findings
have been eliminated.

Local preview routes: `hallmark-preview.html?panel=settings` and
`hallmark-preview.html?panel=editor` on the Vite development server.
