# SimpleCal UI redesign acceptance record

Reviewed on 2026-11-02. This continues the existing project; prior DAV implementation changes remain in the working tree.

## Indigo implementation
The user selected V2 colour-carried calendar with deep-indigo `#3b54c4` actions. Neutral paper and quiet chrome preserve the month-first workspace. Desktop event blocks use 46% color (64% hover), dark blocks 30%, and square category markers. Selected controls use accent fill. Desktop month chips prioritize titles by hiding time visually, while details and time-based views retain it. Phone geometry remains unchanged. Stored calendar colors and explicit accent preferences remain compatible. Brand rasters derive from `code/scripts/generate-brand.mjs`.

## Direction contract
THESIS: Calendar categories carry color independently of the application accent.

OWN-WORLD: Indigo actions and selection, neutral paper, colored event blocks, compact standard calendar controls.

STORY: Scan the month, identify categories, create or inspect events, and manage nearby tasks.

FIRST VIEWPORT: Left navigation, central month, right task list; compact screens retain full-width calendar with drawers and tabs.

FORM: User-pinned, code-led V2 selected after candidate exploration; no new concept roll during implementation.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

## 2026-11-02 third pass — layout, palette and controls

The second pass rebuilt the interior of the Apple/TimeTree world. This pass rebuilds
the *shell*: how the window is put together, what the ground is made of, and how
the controls behave.

### Layout — one window, two questions

The toolbar was split into two groups, and the view switcher moved out of the
right-hand cluster:

| | Before | After |
|---|---|---|
| Toolbar | `logo │ 今天 ‹ › 2026年11月 │ 搜索 │ 年 月 周 四日 日 日程 │ 任务 │ ⚙ │ 头像` | `logo │ 今天 ‹ › 2026年11月 │ 年 月 周 四日 日 日程 │ 搜索 │ 任务 │ ⚙ │ 头像` |
| Title box | 438px wide, mostly empty | 114px, hugging the text |

The switcher used to sit between the search capsule and the task button, so the
right-hand cluster was cut in half by a row of view names that belonged to neither
group. It now follows the period title — the same thing the title describes, so
they belong together — and the toolbar answers *where am I* on the left and
*what am I doing* on the right. The title's `flex: 1 1 auto` became
`flex: 0 1 auto`, so the leftover room collects after the switcher instead of
around the title text.

The navigation column used to be transparent while the toolbar and task panel were
glass: the application read as three and a half pieces. All three chrome surfaces
now share one glass material, so the desktop is one window with three panes around
a paper calendar. Below 901px the app turns into a full-bleed surface — opaque
toolbar, grey navigation column, white paper — because a floating window on a
phone wastes the screen it is meant to fill.

### Palette — the ground the window stands on

- The canvas is a two-stop vertical wash (`--canvas-top` → `--canvas-bottom`),
  light above and deeper below: `#EFF3F8 → #E6EBF1` in light, `#14171B → #090B0E`
  in dark. It sits one step under the chrome and two steps under the paper, so the
  calendar sheet is always the brightest plane. The flat single-colour canvas
  (`#F4F6F8`) made the window float on nothing.
- In dark mode the canvas is now *deeper* than the panels, which the old flat
  `#15171A` was not; the paper reads as the one surface that does not let light
  through.
- Glass panes lost their wide soft shadow: the hairline border declares the edge
  and the shadow is contact only. Border plus wide shadow is a ghost card.
- Indigo is reserved for the primary action, today and the current selection. Icon
  buttons now hover in neutral grey; tinting every hover with the accent made the
  gear and the magnifier glow and the toolbar look like it was breathing.

### Controls — one recipe, repeated honestly

- The segmented control (view switcher and task filters are the same component)
  keeps a 3px recessed track with a white thumb, but the thumb gained a hairline
  ring so it does not blur on glass, the buttons tightened to 10px side padding
  (the header group shrank from 264px to ~230px), and the track is back to 36px
  tall so it lines up with the icon buttons beside it.
- Segmented buttons and icon buttons both gained `:active` and `:disabled` states.
- "Today" is now a white pill with a hairline instead of a grey blob that
  disappeared against the glass.
- The search field keeps its hairline border instead of going transparent.
- The primary "New event" button is 42px with a 12px radius and a soft offset
  shadow.
- Task rows are 56px (was 64px) so a screenful holds two more tasks; the
  checkbox ring fills in when the task is done, so shape carries the state.
- Inputs share a 10px radius and one focus ring.

## 2026-11-02 second pass — macOS Calendar / TimeTree reference

The palette and material direction (mint accent, evergreen ink, Apple-style liquid
glass) was already committed; this pass rebuilt the interface *inside* that world,
taking information architecture and material cues from macOS Calendar and TimeTree.

### Surface and colour

- The surface ramp is neutral again. `--gray-25`…`--gray-200` were green-tinted,
  which made the whole app read as one green wash and dulled the mint accent. The
  green survives only in the ink (`--gray-900`) that text is drawn in.
- Event colour rides a **tint** — `color-mix(in srgb, var(--chip-color) 22%, var(--surface))`,
  34% on hover — instead of a solid fill, so the grid lines and day numbers stay
  legible. All-day and multi-day bars keep their solid fill.
- Glass is confined to the surfaces that genuinely float: toolbar, task panel,
  sign-in card. The calendar stays an opaque paper panel with an offset shadow.

### Calendar structure

- Weekday headings are centred and no longer uppercased; the month cell head
  keeps the day number right-aligned with the lunar date beneath it.
- The current-time rule spans every day column of the week with a dot at its left
  end. It used to be anchored to the "today" column, so it stopped after that column.
- The hour axis labels all 24 hours, midnight included; the 0-hour label rides the
  top edge of the scroll area instead of an hour line it cannot sit on.
- The agenda time column widened from 128px to 164px so a full 12-hour range with
  the Chinese period marker ("上午10:00 – 上午11:00") stays on one line and rows
  stay aligned with their neighbours.

### Phone month cell

Two defects, both found by measuring the rendered page rather than by reading CSS:

1. `renewal.css` is the last stylesheet loaded, so its plain `.chip` rule silently
   beat `views.css`'s `@media (max-width: 520px)` compact block — phones were
   getting the 22px/13px desktop chip instead of the 20px/11px single-line one.
   The desktop expression is now scoped to `min-width: 521px`.
2. With the compact block in force, a phone month cell is ~48px wide while a single
   Chinese time label ("上午10:00") is 49px on its own. Both on one line produced a
   sliced "上午10:" and no title at all. The compact chip now gives the width to the
   title; the time stays in the DOM for assistive technology and still renders
   wherever a cell is wide enough for it.

### Verification

- Frontend full suite: 119 files passed, 1512 assertions passed, 1 existing skip
  (`npm --prefix code/web test -- --run --maxWorkers=4`).
- Browser fixture matrix: 320, 390, 768, 1024 and 1440px; light, dark, login and
  reduced motion — no page errors, no horizontal overflow, no title occlusion.
- Rendered measurement of the time grid: 7 day columns at 114px each, the now rule
  spanning the full 798px grid, and every agenda time label on a single 21px line.
- Production Vite build passed. `git diff --check` passed.
- Impeccable detector: no findings across `code/web/src/styles` and `code/web/src/js`.
  The one hit — the compact chip's 3px category stripe — carries an inline
  `impeccable-disable side-tab` note: it is colour coding on a 48px cell, not a
  decorative card edge.

## Delivered

- Month-first desktop workspace with the task list initially open at 1280px and wider.
- Original SimpleCal calendar/C mark across SVG, favicon, PWA and fnOS package assets.
- Indigo, periwinkle, sun, rose and jade category colors with readable evergreen text and semantic dark surfaces.
- Detail-first task interaction, origin-based enlargement, reduced-motion fallback, Escape and save focus recovery.
- Compact two-row navigation below 901px and a task sheet above mobile chrome.
- Product context in PRODUCT.md, normative tokens and guidance in DESIGN.md, and Impeccable sidecar metadata.

## Verification

- Frontend full suite: 119 files passed, 1511 assertions passed, 1 existing skip (`npm --prefix code/web test -- --run --maxWorkers=4`). Limiting workers avoids CPU-contention timeouts observed during concurrent browser/build work.
- Subsequent focus-after-save regression: taskbar and motion files, 19 tests passed.
- Browser fixture matrix: 320, 390, 768, 1024 and 1440px; light, dark, login and reduced motion; 8 base scenes and 15 scene/interaction observations. Synthetic API data is defined in `code/scripts/capture-ui.mjs`; this is a frontend integration check, not live DAV-server certification.
- Browser assertions cover page errors, horizontal overflow, month-label occlusion, task-sheet stacking, details/edit flow, Escape focus recovery and task-panel preservation.
- Server default-calendar/storage checks: 2 test files passed, with 50 internal checks; saved explicit custom colors remain intact.
- Icon integrity: 86/86 source checks. Temporary complete fnOS assembly: 142/142 checks, with a deliberate corrupt-icon negative check correctly rejected.
- Production Vite build passed. `git diff --check` passed.
- Impeccable detector returned no findings for the reviewed UI and motion targets; independent rendered review drove the compact toolbar, task-sheet and focus repairs.

## Reproduce browser review

Install `playwright` into a temporary tools directory (no application dependency change). Set `SIMPLECAL_PLAYWRIGHT` to its `index.mjs` if it is outside `%TEMP%/simplecal-browser-tools/node_modules/playwright`. Set `SIMPLECAL_BROWSER` to a Chromium executable when Edge is not at the default Windows location. Then run:

```powershell
node code/scripts/capture-ui.mjs "$env:TEMP/simplecal-ui-review"
```

The script owns and shuts down its Vite server and browser. Fixtures never read an existing account or user data. Screenshots and `report.json` remain outside source control.
