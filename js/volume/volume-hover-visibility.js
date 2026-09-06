function vectorComponents(value, fallback) {
  if (Array.isArray(value)) return value;
  if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
    return [value.x, value.y, value.z, Number.isFinite(value.w) ? value.w : undefined];
  }
  return fallback;
}

export function volumeHoverPointVisible(point, voxelIndex, uniforms = {}) {
  const clipMin = vectorComponents(uniforms.uClipMin?.value, [0, 0, 0]);
  const clipMax = vectorComponents(uniforms.uClipMax?.value, [1, 1, 1]);
  if (point[0] < clipMin[0] || point[0] > clipMax[0]
    || point[1] < clipMin[1] || point[1] > clipMax[1]
    || point[2] < clipMin[2] || point[2] > clipMax[2]) return false;

  if (uniforms.uClipPlaneEnabled?.value === 1) {
    const plane = vectorComponents(uniforms.uClipPlane?.value, [0, 0, 0, 0]);
    if (plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3] < 0) return false;
  }

  if (uniforms.uLabelMode?.value > 0) {
    const labels = uniforms.uLabel?.value?.image?.data;
    const hidden = uniforms.uHiddenLabels?.value;
    const label = Number(labels?.[voxelIndex] || 0);
    if (((hidden?.[label >>> 5] || 0) & (1 << (label & 31))) || (uniforms.uIsolate?.value === 1 && !label)) return false;
  }
  return true;
}
