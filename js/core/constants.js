// Segmentation colours, 3D transfer presets, CT HU ranges (normalized 0-1,
// matching the CT raw-volume HU span).

export const CT_HU_LO = -1024;
export const CT_HU_HI = 2048;
export const CT_HU_RANGE = CT_HU_HI - CT_HU_LO; // 3072

function clampHu(hu) {
  return Math.max(CT_HU_LO, Math.min(CT_HU_HI, hu));
}

function huToNormalized(hu) {
  return (clampHu(hu) - CT_HU_LO) / CT_HU_RANGE;
}

function ctWindow({ label, width, level, intensity }) {
  const lowHu = clampHu(level - width / 2);
  const highHu = clampHu(level + width / 2);
  return {
    label,
    width,
    level,
    lowHu,
    highHu,
    lowT: huToNormalized(lowHu),
    highT: huToNormalized(highHu),
    intensity,
  };
}

/** @typedef {{ label: string; width: number; level: number; lowHu: number; highHu: number; lowT: number; highT: number; intensity: number }} CTWindowDef */

/** CT 3D transfer ranges derived from conventional CT WW/WL values. */
export const CT_WINDOWS = /** @type {Record<string, CTWindowDef>} */ ({
  full: ctWindow({ label: 'Full', width: CT_HU_RANGE, level: (CT_HU_LO + CT_HU_HI) / 2, intensity: 1.25 }),
  soft: ctWindow({ label: 'Soft', width: 400, level: 50, intensity: 1.5 }),
  lung: ctWindow({ label: 'Lung', width: 1500, level: -500, intensity: 1.35 }),
  bone: ctWindow({ label: 'Bone', width: 2000, level: 300, intensity: 1.25 }),
});

/**
 * Map a CT window (HU width/level) to the 8-bit display W/L the 2D viewport uses.
 * The 2D base byte linearly encodes the [CT_HU_LO, CT_HU_HI] HU band, so a HU
 * window is an exact 8-bit W/L within that band (metal/contrast beyond +2048 stay
 * clamped — that needs the wider-band source, tracked separately). Lets the 2D
 * canvas honor real lung/soft/bone windows, not just an arbitrary slider.
 */
export function ctWindowToWL(win) {
  return {
    window: Math.max(1, Math.min(512, Math.round((win.width / CT_HU_RANGE) * 255))),
    level: Math.max(0, Math.min(255, Math.round(huToNormalized(win.level) * 255))),
  };
}

/** Per-series defaults when entering 3D. `mode`: alpha | mip | minip */
export const THREE_D_PRESETS = {
  t2_tse: { lowT: 0.08, highT: 0.95, intensity: 1.5, mode: 'alpha' },
  t1_se: { lowT: 0.06, highT: 0.92, intensity: 1.55, mode: 'alpha' },
  flair: { lowT: 0.05, highT: 0.9, intensity: 1.65, mode: 'alpha' },
  dwi_adc: { lowT: 0.02, highT: 0.85, intensity: 1.7, mode: 'alpha' },
  swi_3d: { lowT: 0.04, highT: 0.9, intensity: 1.8, mode: 'alpha' },
};

// 8-bit MR W/L presets (same fields as manual W/L).
export const MR_PRESETS = {
  full:     { window: 255, level: 128, label: 'Full' },
  contrast: { window: 150, level: 90,  label: 'Contrast' },
  bright:   { window: 200, level: 96,  label: 'Bright' },
};

export const TISSUE_NAMES = ['—', 'CSF', 'Gray matter', 'White matter'];

/** Label → [R,G,B,A] for 2D overlay compositing (A 0–255). */
export const SEG_PALETTE = {
  0: [0, 0, 0, 0],
  1: [125, 211, 252, 200],
  2: [134, 239, 172, 200],
  3: [251, 191, 36, 200],
};

// Shape: 4 -> background label 0 plus tissue labels 1..3.
export const TISSUE_LABEL_COUNT = Math.max(...Object.keys(SEG_PALETTE).map(Number)) + 1;

/** Per tissue-class opacity multiplier 0–1 for 3D label LUT alpha. */
export const TISSUE_OPACITY = {
  1: 0.55,
  2: 0.55,
  3: 0.65,
};

const _regionOp = {};
for (let i = 1; i < 256; i++) _regionOp[i] = 0.32;
export const REGION_OPACITY = _regionOp;

// Image-stack prefetch tuning (shared by select-series.js, overlay-stack.js, series-image-stack.js).
export const BASE_PREFETCH_CONCURRENCY = 4;
export const OVERLAY_PREFETCH_CONCURRENCY = 2;
export const REMOTE_BASE_PREFETCH_CONCURRENCY = 8;
export const REMOTE_OVERLAY_PREFETCH_CONCURRENCY = 3;
/** Default max slices queued ahead in loadImageStack.prefetchRemaining (local / non-remote). */
export const DEFAULT_PREFETCH_LIMIT = 24;
