import { inPlanePixelSpacing } from './core/geometry.js';

const ANATOMY_TIPS = {
  synthseg:
    'Anatomical parcellation via SynthSeg (Billot et al., Medical Image Analysis 2023). ' +
    '32 brain regions segmented using a contrast-agnostic deep learning model. ' +
    'Not for clinical diagnosis.',
  totalseg:
    'Organ segmentation via TotalSegmentator v2 (Wasserthal et al., Radiology: AI 2023). ' +
    '67 anatomical structures identified using nnU-Net. ' +
    'Not for clinical diagnosis.',
  heuristic:
    'Approximate regions from bounding-box geometry + tissue classes — not a trained ' +
    'segmentation model. For orientation only; not for clinical diagnosis.',
  default:
    'Anatomical region overlay. Source depends on series modality. ' +
    'Not for clinical diagnosis.',
};

const VOLUME_LINE = {
  synthseg: 'Volumes use voxel counts and calibrated voxel spacing. Model: SynthSeg.',
  totalseg: 'Volumes use voxel counts and calibrated voxel spacing. Model: TotalSegmentator.',
  default:  'Volumes use voxel counts and calibrated voxel spacing.',
};

export function wirePanelInfoViewportTips() {
  document.querySelectorAll('.info-tip--viewport').forEach((el) => {
    if (el.dataset.viewportTipWired === '1') return;
    el.dataset.viewportTipWired = '1';

    const scrollHost = el.closest('.right-panel-scroll');
    let listenersActive = false;
    let scrollRaf = 0;

    const place = () => {
      const r = el.getBoundingClientRect();
      const pad = 10;
      const maxW = 280;
      const w = Math.min(maxW, Math.max(160, window.innerWidth - 2 * pad));
      let left = r.right - w;
      left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
      el.setAttribute('data-tip-fixed', '');
      el.style.setProperty('--info-tip-x', `${left}px`);
      el.style.setProperty('--info-tip-y', `${r.bottom + 6}px`);
      el.style.setProperty('--info-tip-w', `${w}px`);
    };

    const clear = () => {
      el.removeAttribute('data-tip-fixed');
      el.style.removeProperty('--info-tip-x');
      el.style.removeProperty('--info-tip-y');
      el.style.removeProperty('--info-tip-w');
    };

    const onScrollOrResize = () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        place();
      });
    };

    const start = () => {
      place();
      if (listenersActive) return;
      listenersActive = true;
      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('resize', onScrollOrResize);
      if (scrollHost) scrollHost.addEventListener('scroll', onScrollOrResize, { passive: true });
    };

    const stop = () => {
      if (!listenersActive) return;
      listenersActive = false;
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      if (scrollHost) scrollHost.removeEventListener('scroll', onScrollOrResize);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = 0;
      clear();
    };

    const considerHide = () => {
      requestAnimationFrame(() => {
        if (el.matches(':hover') || el === document.activeElement) return;
        stop();
      });
    };

    el.addEventListener('mouseenter', start);
    el.addEventListener('mouseleave', considerHide);
    el.addEventListener('focusin', start);
    el.addEventListener('focusout', considerHide);
  });
}

export function updateInfoTips(series) {
  if (!series) return;

  const src = series.anatomySource || 'default';

  const infoRegions = document.getElementById('info-regions');
  if (infoRegions) {
    infoRegions.setAttribute('data-info', ANATOMY_TIPS[src] || ANATOMY_TIPS.default);
  }

  const volLine = document.getElementById('volumes-info-line');
  if (volLine && inPlanePixelSpacing(series).known) {
    volLine.textContent = VOLUME_LINE[src] || VOLUME_LINE.default;
  }

  const infoVolumes = document.getElementById('info-volumes');
  if (infoVolumes) {
    const model = src === 'synthseg' ? 'SynthSeg' : src === 'totalseg' ? 'TotalSegmentator' : 'unknown';
    infoVolumes.setAttribute(
      'data-info',
      `Volumes use voxel counts and calibrated voxel spacing. Model: ${model}. Not for clinical diagnosis.`
    );
  }
}
