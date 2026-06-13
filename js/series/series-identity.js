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
  return identity ? `${identity}|${variant || 'base'}` : '';
}
