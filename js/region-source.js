// Honest, source-aware framing for the approximate region/anatomy labels, shared
// by the regions legend and the on-image label caption so the wording stays
// consistent and never claims a method that didn't run on the series. The source
// is series.anatomySource (set by the pipeline: 'synthseg' | 'totalseg' |
// 'heuristic'); unknown falls back to a generic, conservative line.

const DISCLAIMER = {
  totalseg: 'Organ labels from TotalSegmentator (deep learning). Research preview — not for diagnosis.',
  synthseg: 'Brain parcellation from SynthSeg (deep learning). Research preview — not for diagnosis.',
  heuristic: 'Approximate regions from geometry + tissue classes — not a trained model. Orientation only.',
};
const DISCLAIMER_DEFAULT = 'Approximate region labels — not validated for diagnosis.';

/** Full one-line provenance/disclaimer for the regions legend. */
export function anatomyDisclaimer(series) {
  return DISCLAIMER[series?.anatomySource] || DISCLAIMER_DEFAULT;
}

const BADGE = {
  totalseg: 'Approximate organ labels · not diagnostic',
  synthseg: 'Approximate brain labels · not diagnostic',
  heuristic: 'Approximate labels · not diagnostic',
};

/** Short caption for the on-image label overlay (2D + 3D). */
export function anatomyBadge(series) {
  return BADGE[series?.anatomySource] || 'Approximate labels · not diagnostic';
}
