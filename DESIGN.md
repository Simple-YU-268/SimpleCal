---
name: SimpleCal
description: A bright, calm month-first calendar with tasks within reach.
colors:
  primary: "#3B54C4"
  on-primary: "#FFFFFF"
  mist: "#BEEFEA"
  sun: "#FFD94D"
  rose: "#FFC7DE"
  sky: "#B7D6F7"
  ink: "#173B35"
  accent-ink: "#3B54C4"
  background: "#F4F6F8"
  canvas-top: "#EFF3F8"
  canvas-bottom: "#E6EBF1"
  surface: "#FFFFFF"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "19px"
    fontWeight: 750
    letterSpacing: "-0.025em"
rounded:
  control: "10px"
  panel: "16px"
  chip: "6px"
spacing:
  compact: "8px"
  regular: "16px"
  roomy: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
  event-chip:
    backgroundColor: "color-mix(in srgb, var(--chip-color) 46%, var(--surface))"
    rounded: "{rounded.chip}"
---

## Overview
SimpleCal is an independent, self-hosted planning workspace. The month calendar is the visual anchor; navigation stays quiet on the left and tasks remain available on the right. The user's selected palette and month-first layout take precedence over exploratory concept seeds.

The interface follows the macOS Calendar and TimeTree pattern: a quiet neutral workspace, one paper-like calendar surface, and a single tinted color per event. Material is used only where it earns its place — chrome is glassy and the content is flat.

## Colors
The user-selected primary is deep indigo, replacing the former mint identity. Primary actions and selected segmented controls use white ink. Dark mode lifts the primary to `#6f82d4` with `#10201e` ink; soft dark selection uses `#2c404e` and `#9ca9e1` text. Calendar colors remain independent, including previously saved mint calendars.

The colour-carried desktop month view uses 46% event-color blocks (64% on hover), 30% in dark mode, with square category markers. Desktop month chips prioritize titles; time remains in the DOM and is visible in details and time-based views. Phone chip geometry remains unchanged.
The surface ramp is **neutral**: `--gray-25` through `--gray-200` are grey, not green-tinted. A tinted ramp made the whole app read as one green wash and dulled the accent, so the green survives only in the ink (`--gray-900` evergreen) that text is drawn in. Indigo signals the primary action; mist, sun, rose and sky distinguish calendar categories. Keep stored custom colors intact. Existing palette identifiers remain compatible with saved data. Use semantic tokens for dark mode rather than putting white backgrounds directly into components.

Event color is carried by a **tint**, not a fill: `color-mix(in srgb, var(--chip-color) 46%, var(--surface))` over the paper, rising to 64% on hover. All-day and multi-day bars stay solid fills. This is the TimeTree trick — a month grid full of solid blocks reads as noise; a month grid full of tinted chips still lets the grid lines and day numbers stay legible.

The **canvas** (`--canvas-top` → `--canvas-bottom`) is a two-stop vertical wash, light above and deeper below, and it sits under every pane. It is one step below the chrome and two steps below the paper, so the calendar sheet always reads as the brightest plane in the room. In dark mode the same rule inverts: the canvas (`#14171B` → `#090B0E`) is darker than the paper, and the paper becomes the one surface that does not let light through. A flat single-colour canvas made the window float on nothing.

Indigo is reserved for three things and nothing else: the primary action, today, and the current selection. Hover states are neutral. An earlier pass tinted every icon-button hover, which made the gear and the magnifier glow and set the whole toolbar breathing.

## Typography
Use the operating system text family for a dense, familiar planning tool, including its native Chinese fallback. Emphasize hierarchy through weight and spacing: 22px workspace title, 19px brand, 14px body and task titles, 12px supporting text, 11px hour-axis and chip labels. Calendar numerals use tabular figures.

Weekday headings are **not** uppercased and are centered over their column: "周一" reads as a word, while "MON" reads as a label. The hour axis runs from 12 AM to 11 PM with every hour labelled, including midnight.

## Layout
At 1280px and above, open the right task list by default. The desktop grid has a 232px navigation column, flexible calendar, and 300px task list, with 14px gutters and 16px exterior space. Smaller desktops keep the task list available on demand. Mobile retains its navigation drawers and bottom tabs. At 900px and below, a two-row toolbar separates identity/actions from month navigation. Below 901px, search uses its compact icon entry. All views, forms and overflow states must remain usable.

The month grid puts the day number **right-aligned** in its cell head, with the lunar date beneath it, the way macOS Calendar does. The weekday header is centered, not left-aligned to the first column.

The toolbar is two groups, and each group answers one question:

- **Left — where am I:** Today, the stepping arrows, the period title, and the view
  switcher. The switcher sits immediately after the title, as in Google Calendar,
  because it describes the same thing the title describes.
- **Right — what am I doing:** search, tasks, settings, account.

The view switcher used to sit between the search capsule and the task button, which
split the right-hand cluster in half: a row of view names that belonged to neither
group. The title also used to stretch to fill the navigation band (438px of empty
box around "2026年11月"); it now hugs its own text, and the leftover room collects
after the switcher.

Desktop is a **floating window** on the canvas: four panes, 12px gutters, 16px
rounds. Below 901px the app becomes a full-bleed surface — an opaque toolbar, a
grey navigation column and a white paper calendar — because a floating window on a
phone wastes the screen it is meant to fill.

## Elevation & Depth
Glass is a functional material for the toolbar, the **navigation column**, the task panel and the sign-in card — the surfaces that float over other content and need to read as separate. The calendar itself is **paper**: an opaque panel with a soft offset shadow, so grid lines and day numbers stay sharp. Dialog depth uses a soft, offset shadow. Respect reduced-transparency preferences with opaque surfaces.

Shadow means offset plus blur. A tight ring reads as a sticker, not as depth.

The window is one object with three panes: header, navigation column and task
panel are the same glass, and the calendar is the paper inside it. The navigation
column used to be transparent, so the application read as three and a half pieces —
two floating panes and a column of raw canvas. One material for all three chrome
surfaces is what makes it a window.

Declare elevation once. A glass pane gets a hairline border for its edge and only a
contact shadow for its lift; a wide soft shadow *plus* a border is a ghost card.
The paper is the only surface allowed a real offset shadow.

## Shapes
Panels and dialogs have 16px corners; controls use 10px and calendar chips 6px (4px on phones). The original geometric calendar mark uses an indigo calendar tile, evergreen binding and yellow date point. SVG is the source for packaged raster icons.

No colored side-tabs: a saturated stripe down the edge of a card or callout reads as an alert, not as decoration. Carry state in the fill, the type, or a border of the surface ramp instead.

## Components
Opening an event or task shows its details before editing. Animate a gentle enlargement from the selected item's bounds using 380ms exponential ease-out. Closing releases dialog state immediately and lets an inert visual clone fade for 160ms. Keyboard focus is restored to the trigger. Reduced-motion and unsupported animation APIs use immediate state changes.

The **current-time rule** spans every day column of a week, with a dot at its left end, the way macOS Calendar and TimeTree draw it. Anchoring it to the "today" column made it stop after that column.

The **task list is a list, not a deck of cards**: rows are separated by hairlines, never boxed.

Controls share one recipe wherever they repeat. The **segmented control** — the
view switcher and the task filters are the same component — is a recessed track
with an indigo thumb that carries a hairline ring; the thumb is the only layer with a
shadow. Buttons are 30px inside a 3px track so the whole control stays 36px tall
and lines up with the icon buttons beside it. Icon buttons hover in neutral grey;
only the selected state is indigo. Today is the one filled pill in the toolbar, in
white with a hairline, so it reads as pressable on glass. Inputs share a 10px
radius and one focus ring.

Task rows are 56px tall with a 14px title over a 12px meta line, separated by a
hairline. The checkbox is a ring in the task's own calendar colour that fills in
when done — the shape carries the state, so colour is never the only signal.

On phones (≤520px) a month cell is ~48px wide, and a single Chinese time label ("上午10:00") is already wider than that. The compact chip is therefore one 20px line with a 3px color stripe, and the **title takes the space** — the time stays in the DOM for assistive technology but yields its width. Squeezing both produced a sliced "上午10:" and no title at all, which identified nothing.

## Do's and Don'ts
- Use the calendar and task content to establish hierarchy.
- Keep custom accent settings, keyboard navigation and saved data compatible.
- Reserve blur for surfaces that benefit from separation and context.
- Keep the last stylesheet in the cascade honest: a rule added there silently beats an earlier `@media` block, so scope it to the widths it was designed for.
- Do not display inherited product branding in everyday UI.
- Preserve source copyrights and acknowledgements in repository documentation.
- Do not rely on pastel color alone for completion, selection or keyboard focus.
- Do not nest cards, and do not let a panel float as a card inside another card.
