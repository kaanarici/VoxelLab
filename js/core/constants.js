export const CT_HU_LO = -1024;
export const CT_HU_HI = 2048;
export const CT_HU_RANGE = CT_HU_HI - CT_HU_LO;

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

export const CT_WINDOWS =                                            ({
  full: ctWindow({ label: 'Full', width: CT_HU_RANGE, level: (CT_HU_LO + CT_HU_HI) / 2, intensity: 1.25 }),
  soft: ctWindow({ label: 'Soft', width: 400, level: 50, intensity: 1.5 }),
  lung: ctWindow({ label: 'Lung', width: 1500, level: -500, intensity: 1.35 }),
  bone: ctWindow({ label: 'Bone', width: 2000, level: 300, intensity: 1.25 }),
});

export function ctWindowToWL(win) {
  return {
    window: Math.max(1, Math.min(512, Math.round((win.width / CT_HU_RANGE) * 255))),
    level: Math.max(0, Math.min(255, Math.round(huToNormalized(win.level) * 255))),
  };
}

export const THREE_D_PRESETS = {
  t2_tse: { lowT: 0.08, highT: 0.95, intensity: 1.5, mode: 'alpha' },
  t1_se: { lowT: 0.06, highT: 0.92, intensity: 1.55, mode: 'alpha' },
  flair: { lowT: 0.05, highT: 0.9, intensity: 1.65, mode: 'alpha' },
  dwi_adc: { lowT: 0.02, highT: 0.85, intensity: 1.7, mode: 'alpha' },
  swi_3d: { lowT: 0.04, highT: 0.9, intensity: 1.8, mode: 'alpha' },
};

export const MR_PRESETS = {
  full:     { window: 255, level: 128, label: 'Full' },
  contrast: { window: 150, level: 90,  label: 'Contrast' },
  bright:   { window: 200, level: 96,  label: 'Bright' },
};

export const TISSUE_NAMES = ['—', 'CSF', 'Gray matter', 'White matter'];

export const SEG_PALETTE = {
  0: [0, 0, 0, 0],
  1: [125, 211, 252, 200],
  2: [134, 239, 172, 200],
  3: [251, 191, 36, 200],
};

export const TISSUE_LABEL_COUNT = Math.max(...Object.keys(SEG_PALETTE).map(Number)) + 1;

export const TISSUE_OPACITY = {
  1: 0.55,
  2: 0.55,
  3: 0.65,
};

export const BASE_PREFETCH_CONCURRENCY = 4;
export const OVERLAY_PREFETCH_CONCURRENCY = 2;
export const REMOTE_BASE_PREFETCH_CONCURRENCY = 8;
export const REMOTE_OVERLAY_PREFETCH_CONCURRENCY = 3;

export const DEFAULT_PREFETCH_LIMIT = 24;
