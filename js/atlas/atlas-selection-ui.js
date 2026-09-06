import { toggleLockedLabel } from '../core/state/viewer-tool-commands.js';

const _installed = new WeakMap();

export function installSelectionUI(svg) {
  if (!svg || _installed.has(svg)) return;

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
