// Raw plane accessor for retained local microscopy C/Z/T planes.
export function rawPlaneFor(host, series, c, t, z) {
  const planes = host?._localMicroscopyPlanes?.[series?.slug]?.[`${c | 0}|${t | 0}`];
  return planes?.[z | 0] ?? null;
}
