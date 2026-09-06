const DISCLAIMER = {
  totalseg: 'Organ labels from TotalSegmentator (deep learning). Research preview — not for diagnosis.',
  synthseg: 'Brain parcellation from SynthSeg (deep learning). Research preview — not for diagnosis.',
  heuristic: 'Approximate regions from geometry + tissue classes — not a trained model. Orientation only.',
};
const DISCLAIMER_DEFAULT = 'Approximate region labels — not validated for diagnosis.';

export function anatomyDisclaimer(series) {
  return DISCLAIMER[series?.anatomySource] || DISCLAIMER_DEFAULT;
}

const BADGE = {
  totalseg: 'Approximate organ labels · not diagnostic',
  synthseg: 'Approximate brain labels · not diagnostic',
  heuristic: 'Approximate labels · not diagnostic',
};

export function anatomyBadge(series) {
  return BADGE[series?.anatomySource] || 'Approximate labels · not diagnostic';
}
