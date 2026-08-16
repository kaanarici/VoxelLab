# VoxelLab Design System

This document records the visual and interaction rules used by VoxelLab. It
explains why the interface uses its current tokens and components so new work
can remain consistent with the existing application.

The source of truth is the token set in `css/base.css :root`, its `html.light`
overrides, and the surface classes in `css/*.css`. Markup lives in
`templates/*.html` and behavior is wired by focused modules under `js/`. When
the code and this document disagree, update this document.

---

## 1. Color

### The rule: monochrome chrome, color only in data

The application chrome is pure grayscale. **No blue, no purple, no brand hue anywhere in the UI shell.** Hue is reserved for *data* and exceptional destructive/error states: segmentation overlays, symmetry/diff maps, LUTs, finding-severity tags, delete affordances, and error text. The justification: in a medical image viewer the operator must read color as signal. Routine buttons, panels, toolbars, menus, and text stay neutral; saturated chrome is limited to a warning that requires attention.

Two consequences follow:
- A new control gets a grayscale token (`--text`, `--muted`, `--icon-idle`, `--accent-bg`), never an invented accent color.
- Data-bearing color comes from the **severity/data tokens** below (or from LUT/overlay code that paints onto the canvas), and only there.

### Theming

Light mode is a `.light` class on `<html>` that swaps the neutral ramp. **The inspection surface stays dark in both themes**: `.canvas-wrap` re-pins the dark tokens and a black canvas background even under `html.light`, because image windowing is calibrated against black. Only app chrome themes. `html.light-switching` zeroes transition durations for an instant, flash-free swap.

### Tokens (`css/base.css :root`): role, not just hex

**Surfaces (dark / light)**: see §3 for layering intent.
| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#0a0a0a` | `#f0f0f0` | App backdrop; the deepest layer. Also the inner color of the focus ring gap. |
| `--panel` | `#111111` | `#fafafa` | Default raised surface: cards, popovers, modals, notifications. |
| `--elev` | `#161616` | `#f0f0f0` | Inset/recessed fill: kbd chips, tags, input wells, code blocks, flat cards. |
| `--hover` | `#171717` | `#ebebeb` | Hover wash on interactive rows/buttons. |
| `--border` | `#1e1e1e` | `#e0e0e0` | Hairline separators and resting control outlines. |

**Text & icons**
| Token | Dark | Role |
|---|---|---|
| `--text` | `#f0f0f0` | Primary text, active labels, checked/checkmark fills. |
| `--muted` | `#8c8c8c` | Secondary text, resting button labels, placeholders. |
| `--dim` | `#3a3a3a` | Disabled text, kbd glyphs, empty-state icons, scrollbar thumb. |
| `--icon-idle` | `#6a6a6a` | Resting icon color: visible but quiet, held to ≥4.5:1 on `--bg`. |
| `--accent` | `#f5f5f5` | Near-white emphasis (active status dot). Grayscale, *not* a hue. |
| `--accent-bg` | `rgba(255,255,255,.06)` | Active/pressed fill for toggles, segmented items, selected rows. |
| `--active-bg` | `rgba(255,255,255,.08)` | Stronger selected-row fill (list selection). |

**Data, severity, and destructive/error color: the only places hue is allowed**
| Token | Dark | Role |
|---|---|---|
| `--danger` | `#e57373` | Destructive action affordance (delete menu items, error dialog text). |
| `--color-abnormal` | `#d67676` | Severity: abnormal finding tag / dot; error dialog body. |
| `--color-attention` | `#d4a72c` | Severity: needs-attention finding tag / dot (amber). |
| `--color-microbleed` | `#9b8fb0` | Data class color: microbleed segmentation. |

These hues appear only on data classes, severity/finding tags, channel LUT
swatches, segmentation overlays, destructive affordances, and error text.
Routine chrome (buttons, panels, sidebars, and toolbars) is strictly monochrome;
no structural class introduces hue.

**Tooltips (always dark, both themes)**
| Token | Value | Role |
|---|---|---|
| `--tooltip-bg` | `#1a1a1a` | Tooltip bubble fill. |
| `--tooltip-border` | `#2a2a2a` | Tooltip bubble outline. |
| `--tooltip-text` | `#e0e0e0` | Tooltip text. |

**Right-rail typography hierarchy** (panels read as quiet metadata, not chrome)
| Token | Dark | Role |
|---|---|---|
| `--rail-title` | `#a0a0a0` | Section/group title. |
| `--rail-label` | `#8a8a8a` | Control labels in the rail. |
| `--rail-value` | `var(--text)` | The actual readout value (highest contrast in the rail). |
| `--rail-stat` | `#7c7c7c` | Tag/stat chip text. |
| `--rail-caption` | `#8c8c8c` | Captions. |
| `--rail-micro` | `#828282` | Micro-labels. |

---

## 2. Typography & Spacing

### Type

Base: `13px / 1.45`, system stack `-apple-system, "SF Pro Text", "Inter", system-ui, sans-serif`, with `-webkit-font-smoothing: antialiased` + `-moz-osx-font-smoothing: grayscale`. There is no display/serif face: this is a dense tool UI, not a marketing page.

**Ramp** (live tokens in `css/base.css`; DESIGN.md used to list ad-hoc px):
| Size | Token | Weight | When to use |
|---|---|---|---|
| 9px | `--fs-micro` | 500, tabular | Count pills, flat severity labels. |
| 10px | `--fs-caption` | 500–600 | Section overlines (uppercase, `0.1em` tracking), rail captions, command-palette keycaps. |
| 11px | `--fs-body` | 500 | Buttons (`.btn`), segmented items. The workhorse control size. |
| 12px | `--fs-body-lg` | 500 | Dropdown/menu rows, list descriptions, labeled icon buttons. |
| 13px | `--fs-title` | 400–500 | Body text, card/modal titles (500, `--tracking-tight`), dialog body. |
| 15px | `--fs-title-lg` | 500 | Prominent headings. |
| 20px | *(empty-state title, currently hardcoded)* | 500 | First-run empty-state title. |
| 28px | `--fs-display` | 200 | Sole hero numeral (slice index). |

Conventions:
- **Tabular numerals** (`font-variant-numeric: tabular-nums`) on every numeric readout, count, slider value, and kbd chip so digits don't jitter while scrubbing.
- **Uppercase + ~0.1em letter-spacing** marks structural overlines and segmented controls (section titles, command-palette sections, segmented items). Normal case everywhere else.
- Titles use `--tracking-tight` (`-0.01em`); never tighten body text.
- `text-wrap: balance` on headings/`.sec-title`; `text-wrap: pretty` on paragraphs and disclaimers.
- Weight ceiling is 600 (glyph fallbacks, value readouts). No bold/800 anywhere: emphasis comes from color/contrast, not weight.

### Spacing: 4pt scale

| Token | Value | When to use |
|---|---|---|
| `--space-xs` | 4px | Icon-to-label gaps, tight inline gaps, micro margins. |
| `--space-sm` | 8px | Default control gap, preset-button padding, row gaps. |
| `--space-md` | 12px | Intra-panel padding, vertical rhythm between groups. |
| `--space-lg` | 16px | Section/panel block padding, the outer rail inset. |

Layout-specific spacing tokens build on the same grid: `--sidebar-px: 16px`, `--sidebar-item-py: 8px`, `--chrome-header-pl: 12px` / `--chrome-header-pr: 8px`, and the composite `--rail-section-padding`. Extra steps already in the token file: `--space-2xs` 2px, `--space-2sm` 6px, `--space-10` 10px, `--space-14` 14px, `--space-xl` 24px. Do not invent further ad-hoc steps.

### Radius & sizing

- `--radius: 4px`: default for buttons, inputs, chips, list rows.
- `--radius-lg: 6px`: larger surfaces: popovers, modals, notifications.
- Also in the token file: `--radius-sm` 2px, `--radius-md` 8px, `--radius-xl` 12px, `--radius-pill`.
- Icon sizes: `--icon-sm: 13px` (inline/menu), `--icon-md: 16px` (sidebar actions), `--icon-lg: 15px` (toolbar). Hit targets: `--btn-sidebar: 28px`, `--btn-toolbar: 30px`. Honor these so density stays uniform.

---

## 3. Surfaces & Elevation

Three flat fills form the layer stack: VoxelLab uses **brightness, not drop shadows, to express depth in-plane**; real shadows are reserved for surfaces that float *above* the document (popovers, modals, notifications).

| Layer | Token | Meaning | Used by |
|---|---|---|---|
| Backdrop | `--bg` | The page floor. | `<body>`, viewer canvas wrap, empty-state. |
| Raised | `--panel` | Content sits on top of the floor. | Cards, popovers, modal cards (`.ask-card`), notifications. |
| Inset | `--elev` | Recessed *into* a surface: wells and chips read as carved-in. | Inputs, kbd chips, tags, code blocks. |

Elevation rules:
- In-plane separation = a 1px `--border` hairline and/or a `--hover` wash on interaction. No shadow.
- **Modal and dialog cards have no CSS `border` and no outline hairline.** They sit on `--panel` with ambient `--shadow-modal` only (`0 8px 24px` / `0 16px 48px`). Do not add `border: 1px solid var(--border)` or a `0 0 0 1px` ring around `.ask-card`, `.help-card`, `.shortcuts-card`, `.cmdk-dialog`, or `.project-rename-card`.
- Other floating overlays (popovers, menus) use `--shadow-popover` and `border: 0` — hairline-only, same recipe.
- `--shadow-popover`: popovers, menus, notifications, the toolbox panel.
- `--shadow-modal`: modals, dialogs, command palette, and the Ask composer bar.
- `--scrim` is a **dark dim** in both themes (`rgba(0,0,0,.5)` dark, `rgba(0,0,0,.28)` light). Do not use a white/light wash behind dialogs.
- Selected list rows that are multi-selected add an inset accent bar (`box-shadow: inset 2px 0 0 var(--text)`). A single `.active` series row uses `--active-bg` fill only.

Card/panel variant → surface mapping (so "make it X" picks the right layer):
- `--panel` + `--shadow-modal`, no CSS border → dialog/modal card (`.ask-card`, `.help-card`, `.shortcuts-card`, `.cmdk-dialog`).
- `--panel` + `--shadow-popover`, no CSS border → floating menu (`.popover-menu`, `.custom-dropdown .dd-menu`, `.toolbox-panel`).
- `--elev` → inset block (right-rail metadata, `.panel-count`, `.dd-trigger`).

---

## 4. Accessibility (WCAG)

Target: **WCAG 2.1 AA**. Text and meaningful icons meet ≥4.5:1 against their background; `--icon-idle` is explicitly tuned to clear 4.5:1 on `--bg`. `--muted`/`--dim` are used only for secondary/disabled content where the lower ratio is acceptable per AA's large-text/incidental rules: do not use `--dim` for primary readable text.

### Focus-ring contract (load-bearing: match it exactly)

Global `*:focus-visible` draws a **double ring** via box-shadow, never a single outline:
```css
box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px rgba(255,255,255,.4);
```
The inner 2px is a gap in the page-background color, the outer 2px is the visible ring: so the ring reads on any surface without touching layout. Rules every new control must follow:
- Use `:focus-visible` (keyboard), not `:focus`: don't ring on mouse click.
- Never set `outline` to satisfy focus; the box-shadow ring is the contract. (`outline: none` is already applied globally.)
- Light theme overrides the ring to `rgba(0,0,0,.25)`; the checkbox uses an `outline`-based ring as a deliberate exception (a 2px `--dim` outline) because the box is tiny.
- **Forced-colors / Windows High-Contrast**: box-shadow rings don't paint, so `@media (forced-colors: active)` falls back to a real `2px solid CanvasText` outline. Preserve this fallback in any custom focus styling.

Canonical interactive primitives carry their required accessible affordances:
buttons have an accessible name and expose pressed state when applicable;
segmented controls, dropdowns, menus, dialogs, switches, and status indicators
use their matching roles and state attributes; dialogs trap focus and restore the
prior focus on close. Reuse these primitives and verify any new interaction with
the accessibility browser suite rather than assuming markup alone is complete.

### Reduced motion

`@media (prefers-reduced-motion: reduce)`:
- Decorative entrance animations (`.ui-fade-in`) and the spinner ring spin are disabled.
- Decorative *enlarge-on-hover/active* transforms (range thumbs, checkbox knob scale, button press `scale(0.96)`) are dropped: but **color/background interaction feedback is kept**, so controls still visibly respond.
Honor this split in new motion: never gate *state* feedback behind motion; only gate purely decorative movement.

---

## 5. UI Vocabulary

This is a template-driven app: the DOM for every surface is authored in
`templates/*.html` (sidebar, toolbar, panels, viewer-shell, modals,
command-palette) and injected at boot; behavior is wired by thin modules in
`js/<domain>/` via `$()` lookups + class/attribute toggles. To build a new
control: add markup to the relevant template using the canonical classes below,
then wire it in the domain module. There is no DOM-factory layer: the classes
+ templates ARE the primitive system.

Canonical classes (each is the one sanctioned way to render its role):

- **Buttons**: `.btn` (text), `.icon-btn` (30px toolbar), `.act-btn` (28px sidebar/header). Surface-scoped variants (`.preset-btn`, `.roi-results-export`, `.annot-btn`, `.mpr-tb-btn`) share the same states: hover → `--hover`, `:active` press, `:disabled` (opacity + `pointer-events:none`), `:focus-visible` → the global double ring.
- **Segmented**: `.pill-group` + `.pill` (W/L presets, render-mode, CT-window). Children flex to fill.
- **Dropdown**: toolbar widgets use `.custom-dropdown` + `.dd-trigger` / `.dd-menu` / `.dd-item`. Native `<select class="select-like">` is enhanced by `select-like-dropdown.js` into `.select-dropdown` / `.select-dropdown-trigger` / `.select-dropdown-menu`.
- **Sliders**: `.scrubber` range (filled via `--fill`), `.cine-speed`; right-rail rows use `.tool-row` (`.tl-lbl` / `.tl-sl` / `.tl-val`) for label + slider + tabular readout. Track `--text`, rest `--dim`; knob shadow from `--shadow-knob`.
- **Checkbox / switch**: `.ui-checkbox` (hollow ring + dot, `.ui-checkbox-box`) and `.ui-switch` (`.ui-switch-track` / `.ui-switch-thumb`).
- **Tag / count**: `.panel-count` (count chip), `.mpr-tb-pill` (status pill), finding/severity tags (the sanctioned home for severity color).
- **Keycap**: `<kbd>` inside `.sidebar-shortcut` (20×20, 12px `--icon-idle` on `--elev`, matching `.act-btn` / `.sidebar-ico`; `--text` on Search-row hover) and `.cmdk` rows.
- **Section (collapsible)**: `.rp-section.collapsible` + `.sec-title` / `.rp-collapse-ico` / `.rp-body` (grid 1fr↔0fr). Section headers: `.section-header` / `.section-title`.
- **Rows**: `.sidebar-row` (full-width action) and `.series-list li` (`.sname` / `.sdesc`; `.active` = `--active-bg` fill).
- **Menu / popover**: `.popover-menu` + `.popover-item` (folder/sort/context menus), floating via `--shadow-popover` with `border: 0`.
- **Empty state**: `.empty-state` (viewer) and `.rp-empty*` (rail). First-run drop on `#empty-state` opens the study dialog.
- **Spinner**: `.viewer-spinner` + helpers in `js/spinner.js` (flash-guarded). Uses `--shadow-float`, not `--shadow-popover`.
- **Tooltip**: singleton `.tip-bubble` rendered by `js/tooltips.js`; anchors carry `data-tip` (+ optional `data-tip-pos`).
- **Modal / dialog**: `.ask-card` (upload, confirm, cloud settings, consult), `.help-card`, `.shortcuts-card`, `.cmdk-dialog`, `.project-rename-card`. No CSS border; `--shadow-modal` for lift. Opened via `openModal`/`showDialog` in `js/dom.js`. The Open study dialog is folder-first: the drop zone click opens a directory picker; individual files are a secondary control.
- **Notification**: `.notify-item` via `js/notify.js`. Kinds (`confirm`, `info`, `warning`, `error`, `progress`, `action`) set `data-notify-kind` and the persist policy; the panel stays grayscale with a 2px kind rail.

Shared DOM helpers (`js/dom.js`): `$`, `escapeHtml`, `colorSwatchSvg`,
`trapFocus`/`releaseFocus`, `clientToCanvasPx`, and the modal orchestration above.
