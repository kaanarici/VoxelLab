// Lock-toggle controller for the anatomy-label pills (shared by the 2D + 3D
// overlays). Hover is now entirely declarative: the volume tooltip is the app's
// standard [data-tip] manager (set per pill in atlas-svg), and the dot→lock
// reveal + sibling dim are pure CSS. Hover NEVER touches the model or the other
// labels — isolation is deliberate (click the lock here, or solo from the
// Structures panel) — so sweeping fast across stacked labels can't flash the
// 3D model or make labels blink on/off. Only the lock click needs JS.

import { toggleLockedLabel } from '../core/state/viewer-tool-commands.js';

const _installed = new WeakMap(); // svg -> click handler

export function installSelectionUI(svg) {
  if (!svg || _installed.has(svg)) return;
  // Clicking ANYWHERE on a pill (not just the lock glyph) toggles its lock —
  // the lock icon is the affordance, the whole label is the hit target.
  const onClick = (event) => {
    const pill = event.target.closest?.('.atlas-pill');
    if (!pill || !svg.contains(pill)) return;
    const label = Number(pill.dataset.label);
    if (!Number.isFinite(label)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleLockedLabel(label);
  };
  svg.addEventListener('click', onClick);
  _installed.set(svg, onClick);
}

export function teardownSelectionUI(svg) {
  const onClick = _installed.get(svg);
  if (!onClick) return;
  svg.removeEventListener('click', onClick);
  _installed.delete(svg);
}
