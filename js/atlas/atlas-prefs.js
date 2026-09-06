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
  try { s.setItem(KEY, on ? '1' : '0'); } catch {                    }
}
