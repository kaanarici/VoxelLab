import { state } from './core/state.js';
import { loadImageStack } from './series/series-image-stack.js';
import { isMprActive } from './core/mode-flags.js';
import { notifyOverlayReady } from './overlay/overlay-stack.js';
import { OVERLAY_CACHE_BY_TYPE } from './runtime/overlay-cache-keys.js';
import { clearFusionRuntime, setFusionRuntime } from './runtime/viewer-runtime.js';
import { setFusionSelection } from './core/state/viewer-commands.js';

export async function loadFusion(peerSlug) {
  const cache = OVERLAY_CACHE_BY_TYPE.fusion;
  if (!peerSlug) {
    setFusionSelection(null);
    clearFusionRuntime();
    return;
  }
  setFusionSelection(peerSlug);
  const peer = state.manifest.series.find((s) => s.slug === peerSlug);
  if (!peer) return;
  const currentIndex = Math.min(state.sliceIdx, peer.slices - 1);
  const existingImgs = state[cache.imgs];
  const canReuseFusion = existingImgs?._dir === peer.slug && existingImgs.length === peer.slices;
  const fusionVoxels = canReuseFusion ? state[cache.voxels] : null;
  const { imgs, loaders } = loadImageStack(peer.slug, peer.slices, canReuseFusion ? existingImgs : null, peer, {
    label: `${peer.slug} fusion stack`,
    windowRadius: 5,
    initialIndex: currentIndex,
  });
  setFusionRuntime({ slug: peerSlug, imgs, voxels: fusionVoxels });
  imgs.ensureIndex?.(currentIndex).then(() => {
    if (state[cache.imgs] === imgs && state.overlays.fusionSlug === peerSlug && state.sliceIdx === currentIndex) {
      notifyOverlayReady();
    }
  });
  Promise.all(loaders).then(() => {
    if (state[cache.imgs] === imgs && state.overlays.fusionSlug === peerSlug) notifyOverlayReady();
  });
  if (isMprActive()) {
    imgs.prefetchRemaining?.(currentIndex, 5).then(() => {
      setFusionRuntime({ slug: peerSlug, imgs, voxels: fusionVoxels });
      notifyOverlayReady();
    });
  }
}
