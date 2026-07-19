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

The application chrome is pure grayscale. **No blue, no purple, no brand hue anywhere in the UI shell.** Hue is reserved exclusively for *data*: segmentation overlays, symmetry/diff maps, LUTs, and finding-severity tags. The justification: in a medical image viewer the operator must read color as signal (a red region means a finding, not a button). Spending color on chrome trains the eye to ignore it. So buttons, panels, toolbars, menus, and text are all neutral; the only saturated pixels on screen should be carrying information.

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
| `--muted` | `#7a7a7a` | Secondary text, resting button labels, placeholders. |
| `--dim` | `#3a3a3a` | Disabled text, kbd glyphs, empty-state icons, scrollbar thumb. |
| `--icon-idle` | `#6a6a6a` | Resting icon color: visible but quiet, held to ≥4.5:1 on `--bg`. |
| `--accent` | `#f5f5f5` | Near-white emphasis (active status dot). Grayscale, *not* a hue. |
| `--accent-bg` | `rgba(255,255,255,.06)` | Active/pressed fill for toggles, segmented items, selected rows. |
| `--active-bg` | `rgba(255,255,255,.08)` | Stronger selected-row fill (list selection). |

**Data & severity color: the only place hue is allowed**
| Token | Dark | Role |
|---|---|---|
| `--danger` | `#e57373` | Destructive action affordance (delete menu items, error dialog text). |
| `--color-abnormal` | `#d67676` | Severity: abnormal finding tag / dot; error dialog body. |
| `--color-attention` | `#d4a72c` | Severity: needs-attention finding tag / dot (amber). |
| `--color-microbleed` | `#9b8fb0` | Data class color: microbleed segmentation. |

These hues appear only on data classes: the severity/finding tags, channel LUT swatches, and segmentation overlays. Chrome (buttons, panels, sidebars, toolbars) is strictly monochrome; no structural class introduces hue.

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
| `--rail-caption` | `#7a7a7a` | Captions. |
| `--rail-micro` | `#828282` | Micro-labels. |

---

## 2. Typography & Spacing

### Type

Base: `13px / 1.45`, system stack `-apple-system, "SF Pro Text", "Inter", system-ui, sans-serif`, with `-webkit-font-smoothing: antialiased` + `-moz-osx-font-smoothing: grayscale`. There is no display/serif face: this is a dense tool UI, not a marketing page.

**Ramp** (every size in the system, with where it belongs):
| Size | Weight | When to use |
|---|---|---|
| 9px | 500, tabular | Count pills, kbd chips, flat severity labels: the smallest metadata badges. |
| 10px | 500–600 | Section overlines (uppercase, `0.1em` tracking), value readouts (tabular), empty-state badges. |
| 11px | 500 | Buttons (`.ui-btn`), segmented items, dropdown/menu rows, list descriptions, dialog sub-labels. The workhorse control size. |
| 12px | 500 | Labeled icon buttons, `lg` button, menu trigger labels, tooltips, list-row name, empty-state subtitle. |
| 13px | 400–500 | Body text, card/modal titles (500, `-0.005em`), dialog body. The base size. |
| 15px | 500 | Empty-state title: the largest type in the system, for the primary "no data" message. |

Conventions:
- **Tabular numerals** (`font-variant-numeric: tabular-nums`) on every numeric readout, count, slider value, and kbd chip so digits don't jitter while scrubbing.
- **Uppercase + ~0.1em letter-spacing** marks structural overlines and segmented controls (section titles, command-palette sections, segmented items). Normal case everywhere else.
- Titles use slight negative tracking (`-0.005em`); never tighten body text.
- `text-wrap: balance` on headings/`.sec-title`; `text-wrap: pretty` on paragraphs and disclaimers.
- Weight ceiling is 600 (glyph fallbacks, value readouts). No bold/800 anywhere: emphasis comes from color/contrast, not weight.

### Spacing: 4pt scale

| Token | Value | When to use |
|---|---|---|
| `--space-xs` | 4px | Icon-to-label gaps, tight inline gaps, micro margins. |
| `--space-sm` | 8px | Default control gap, preset-button padding, row gaps. |
| `--space-md` | 12px | Intra-panel padding, vertical rhythm between groups. |
| `--space-lg` | 16px | Section/panel block padding, the outer rail inset. |

Layout-specific spacing tokens build on the same grid: `--sidebar-px: 16px`, `--sidebar-item-py: 8px`, `--chrome-header-pl: 12px` / `--chrome-header-pr: 8px`, and the composite `--rail-section-padding`. Ad-hoc gaps in primitive CSS (5/6/7/10/14px) are local control geometry, not new scale steps: do not promote them to tokens.

### Radius & sizing

- `--radius: 4px`: default for buttons, inputs, chips, list rows.
- `--radius-lg: 6px`: larger surfaces: popovers, modals, notifications.
- Icon sizes: `--icon-sm: 13px` (inline/menu), `--icon-md: 16px` (sidebar actions), `--icon-lg: 15px` (toolbar). Hit targets: `--btn-sidebar: 28px`, `--btn-toolbar: 30px`. Honor these so density stays uniform.

---

## 3. Surfaces & Elevation

Three flat fills form the layer stack: VoxelLab uses **brightness, not drop shadows, to express depth in-plane**; real shadows are reserved for surfaces that float *above* the document (popovers, modals, notifications).

| Layer | Token | Meaning | Used by |
|---|---|---|---|
| Backdrop | `--bg` | The page floor. | `<body>`, viewer canvas wrap, empty-state. |
| Raised | `--panel` | Content sits on top of the floor. | Cards (`.vl-card`), popovers, modal cards, notifications. |
| Inset | `--elev` | Recessed *into* a surface: wells and chips read as carved-in. | Inputs, kbd chips, tags, code blocks, `.vl-card.is-flat`. |

Elevation rules:
- In-plane separation = a 1px `--border` hairline and/or a `--hover` wash on interaction. No shadow.
- Floating overlays get one of two shadow tokens, both of which lead with a `0 0 0 1px rgba(255,255,255,.08)` light hairline (a faint top-edge highlight that reads as a lifted edge in the dark theme), then layered ambient shadows:
  - `--shadow-popover`: popovers, menus, notifications, `.vl-card.is-elevated`, the spinner disc.
  - `--shadow-modal`: modals (a deeper, wider cast for the highest layer).
- Selected list rows add an inset accent bar (`box-shadow: inset 2px 0 0 var(--text)`) rather than a fill change alone: a grayscale selection marker, consistent with the no-chrome-color rule.

Card/panel variant → surface mapping (so "make it X" picks the right layer):
- `--panel` + border → raised grouped surface (e.g. `.notify-item`, dialog cards).
- `--panel` + `--shadow-popover` → floating surface (`.popover-menu`, `.custom-dropdown .dd-menu`, `.toolbox-panel`).
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

Every interactive primitive carries its accessible affordances already: buttons set `aria-label`/`title` when label is empty and `aria-pressed` when `active`; segmented/dropdown use `role=group`/`listbox` + `aria-selected`/`aria-expanded`; menus set `aria-haspopup`; modals set `role=dialog` + `aria-modal` and trap focus (`trapFocus`/`releaseFocus`) restoring the prior focus on close; switch sets `role=switch`; status dots set `role=img` only when a `label` is given (otherwise `aria-hidden`). Reuse these primitives rather than re-implementing the wiring.

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
- **Dropdown**: `.custom-dropdown` + `.dd-trigger` / `.dd-menu` / `.dd-item`. Native `<select class="select-like">` is progressively enhanced by `select-like-dropdown.js`.
- **Sliders**: `.scrubber` range (filled via `--fill`), `.cine-speed`; right-rail rows use `.tool-row` (`.tl-lbl` / `.tl-sl` / `.tl-val`) for label + slider + tabular readout. Track `--text`, rest `--dim`; knob shadow from `--shadow-thumb`.
- **Checkbox / switch**: `.ui-checkbox` (hollow ring + dot, `.ui-checkbox-box`) and `.ui-switch` (`.ui-switch-track` / `.ui-switch-thumb`).
- **Tag / count**: `.panel-count` (count chip), `.mpr-tb-pill` (status pill), finding/severity tags (the sanctioned home for severity color).
- **Keycap**: `<kbd>` inside `.sidebar-shortcut` and `.cmdk` rows.
- **Section (collapsible)**: `.rp-section.collapsible` + `.sec-title` / `.rp-collapse-ico` / `.rp-body` (grid 1fr↔0fr). Section headers: `.section-header` / `.section-title`.
- **Rows**: `.sidebar-row` (full-width action) and `.series-list li` (`.sname` / `.sdesc` / `.ai-dot`; `.active` = surface fill).
- **Menu / popover**: `.popover-menu` + `.popover-item` (folder/sort/context menus), floating via `--shadow-popover`.
- **Empty state**: `.empty-state` (viewer) and `.rp-empty*` (rail).
- **Spinner**: `.viewer-spinner` + helpers in `js/spinner.js` (flash-guarded).
- **Tooltip**: singleton `.tip-bubble` rendered by `js/tooltips.js`; anchors carry `data-tip` (+ optional `data-tip-pos`).
- **Modal**: `[id$="-modal"].visible`, focus-trapped via `openModal`/`showDialog` in `js/dom.js`.
- **Notification**: `.notify-item` via `js/notify.js`.

Shared DOM helpers (`js/dom.js`): `$`, `escapeHtml`, `colorSwatchSvg`,
`trapFocus`/`releaseFocus`, `clientToCanvasPx`, and the modal orchestration above.
