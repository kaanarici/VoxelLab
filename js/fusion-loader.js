import { state } from './core/state.js';
import { loadImageStack } from './series/series-image-stack.js';
import { syncOverlays } from './sync.js';
import { isMprActive } from './core/mode-flags.js';
import { clearFusionRuntime, setFusionRuntime } from './runtime/viewer-runtime.js';
import { setFusionSelection } from './core/state/viewer-commands.js';

export async function loadFusion(peerSlug) {
  if (!peerSlug) {
    setFusionSelection(null);
    clearFusionRuntime();
    return;
  }
  setFusionSelection(peerSlug);
  const peer = state.manifest.series.find((s) => s.slug === peerSlug);
  if (!peer) return;
  const currentIndex = Math.min(state.sliceIdx, peer.slices - 1);
  const canReuseFusion = state.fusionImgs?._dir === peer.slug && state.fusionImgs.length === peer.slices;
  const fusionVoxels = canReuseFusion ? state.fusionVoxels : null;
  const { imgs, loaders } = loadImageStack(peer.slug, peer.slices, canReuseFusion ? state.fusionImgs : null, peer, {
    label: `${peer.slug} fusion stack`,
    windowRadius: 5,
    initialIndex: currentIndex,
  });
  setFusionRuntime({ slug: peerSlug, imgs, voxels: fusionVoxels });
  imgs.ensureIndex?.(currentIndex).then(() => {
    if (state.fusionImgs === imgs && state.fusionSlug === peerSlug && state.sliceIdx === currentIndex) {
      syncOverlays();
    }
  });
  Promise.all(loaders).then(() => {
    if (state.fusionImgs === imgs && state.fusionSlug === peerSlug) syncOverlays();
  });
  if (isMprActive()) {
    imgs.prefetchRemaining?.(currentIndex, 5).then(() => {
      setFusionRuntime({ slug: peerSlug, imgs, voxels: fusionVoxels });
      syncOverlays();
    });
  }
}
