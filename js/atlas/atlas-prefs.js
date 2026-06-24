// Tiny persisted preference: should the 3D anatomy overlay also draw floating
// region labels? Default ON. Stored in localStorage and read at the toggle /
// coupling sites only — deliberately NOT part of the reactive app state model.
// Labels are a 3D feature of the Anatomy overlay; this never touches the overlay
// (Anatomy) state itself.

const KEY = 'voxellab.anatomy.labels3d';

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function showAnatomyLabels() {
  const s = storage();
  if (!s) return true;
  try {
    const raw = s.getItem(KEY);
    return raw === null ? true : raw === '1';
  } catch { return true; }
}

export function setShowAnatomyLabels(on) {
  const s = storage();
  if (!s) return;
  try { s.setItem(KEY, on ? '1' : '0'); } catch { /* ignore quota */ }
}
