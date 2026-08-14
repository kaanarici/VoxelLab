export function seriesIdentityKey(series, manifest = {}) {
  if (!series?.slug) return '';
  return [
    manifest?.patient || '',
    series.sourceStudyUID || series.studyUID || series.studyInstanceUID || manifest?.studyUID || manifest?.studyDate || '',
    series.group ?? '',
    series.sourceSeriesUID || series.seriesUID || series.seriesInstanceUID || series.sourceJobId || '',
    series.slug,
  ].map((part) => String(part || '').replaceAll('|', '/')).join('|');
}

export function seriesVariantKey(series, variant, manifest = {}) {
  const identity = seriesIdentityKey(series, manifest);
  if (!identity) return '';
  if (series?.imageDomain !== 'microscopy') return `${identity}|${variant || 'base'}`;
  const c = Math.max(0, Math.floor(Number(series.microscopy?.channelIndex || 0)));
  const t = Math.max(0, Math.floor(Number(series.microscopy?.timeIndex || 0)));
  return `${identity}|${variant || 'base'}|c${c}|t${t}`;
}

function durablePersistenceIdentity(series, manifest, source) {
  const sourceFiles = source.files || series.microscopy?.sourceFiles || [];
  if (series.imageDomain !== 'microscopy' || (!sourceFiles.length && !series.sourceUrl && !series.sourceFile)) {
    return seriesIdentityKey(series, manifest);
  }
  return [
    manifest?.patient || '',
    series.sourceStudyUID || series.studyUID || series.studyInstanceUID || manifest?.studyUID || manifest?.studyDate || '',
    series.group ?? '',
    series.sourceSeriesUID || series.seriesUID || series.seriesInstanceUID || series.sourceJobId || '',
    'microscopy-source',
  ].map((part) => String(part || '').replaceAll('|', '/')).join('|');
}

function microscopyPersistenceGrid(series) {
  const zAxis = (series.microscopyDataset?.axes || []).find(axis => axis?.name === 'z');
  const declaredSlices = [zAxis?.size, series.microscopy?.sizeZ, series.slices]
    .map(Number)
    .find(value => Number.isInteger(value) && value > 0) || 1;
  const zMm = Number(series.sliceSpacing || series.sliceThickness || 0);
  const lastZ = zMm > 0 ? (declaredSlices - 1) * zMm : 0;
  return [
    series.width,
    series.height,
    declaredSlices,
    series.pixelSpacing,
    series.sliceSpacing,
    series.orientation,
    [0, 0, 0],
    [0, 0, lastZ],
  ];
}

// Durable user-authored data needs more than the display slug: slugs repeat
// across imported studies. Keep this descriptor deliberately limited to fields
// that describe the selected source and its pixel grid so it is stable across
// viewer sessions while separating otherwise similarly named series.
export function seriesPersistenceFingerprint(series, manifest = {}) {
  if (!series?.slug) return '';
  const source = series.microscopyDataset?.source || {};
  const payload = {
    v: 2,
    identity: durablePersistenceIdentity(series, manifest, source),
    grid: series.imageDomain === 'microscopy'
      ? microscopyPersistenceGrid(series)
      : [series.width, series.height, series.slices, series.pixelSpacing, series.sliceSpacing, series.orientation, series.firstIPP, series.lastIPP],
    source: [
      series.imageDomain,
      series.sequence,
      series.sourceFile,
      series.sourceUrl,
      series.microscopy?.sourceFiles,
      source.originalFormat,
      source.files,
      source.signatures,
    ],
  };
  return JSON.stringify(payload);
}

const FNV128_OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn;
const FNV128_PRIME = 0x1000000000000000000013bn;
const FNV128_MASK = (1n << 128n) - 1n;

function compactIdentityDigest(value) {
  let hash = FNV128_OFFSET_BASIS;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV128_PRIME) & FNV128_MASK;
  }
  return hash.toString(16).padStart(32, '0');
}

export function seriesPersistenceKey(series, manifest = {}) {
  const fingerprint = seriesPersistenceFingerprint(series, manifest);
  // Keep patient names, source URLs, and long microscopy file lists out of
  // localStorage keys and exported bundle identity fields. This digest is an
  // opaque deterministic identity, not an authentication or integrity token.
  return fingerprint ? `v2:${compactIdentityDigest(fingerprint)}` : '';
}
