export function normalizeRegionMeta(regionMeta) {
  if (!regionMeta) return null;
  if (!regionMeta.regions) return regionMeta.legend ? regionMeta : { ...regionMeta, legend: {} };
  const legend = { ...(regionMeta.legend || {}) };
  let changed = !regionMeta.legend;
  for (const [label, region] of Object.entries(regionMeta.regions || {})) {
    const name = region?.constructor === String ? region : region?.name;
    if (name && legend[label] == null) {
      legend[label] = name;
      changed = true;
    }
  }
  return changed ? { ...regionMeta, legend } : regionMeta;
}

export function regionLabelName(regionMeta, label) {
  if (!regionMeta || label == null) return '';
  const key = String(label);

  const region = regionMeta.regions?.[key] ?? regionMeta.regions?.[label];
  const regionName = region?.constructor === String ? region : region?.name;
  if (regionName) return regionName;
  return regionMeta.legend?.[key] ?? regionMeta.legend?.[label] ?? '';
}
