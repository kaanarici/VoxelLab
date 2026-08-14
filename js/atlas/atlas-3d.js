// Atlas overlay for the 3D volume. Labels match the CURRENT scrubber slice (the
// same regions the 2D view shows for that slice) — projected onto the slice's
// depth plane and re-projected every frame, so the leader lines stay glued to
// the structures and sweep as you orbit, while the pills live in two evenly-
// spaced screen columns aligned just outside the model. Hidden when the cut face
// turns away from the camera, or when the clip box / transfer function removes
// the structure.
//
// Lazy-loaded: imported only when the 3D atlas is first enabled (it pulls in the
// Three render loop), so the 2D atlas and app startup never load Three for this.

import { state, subscribe } from '../core/state.js';
import { $ } from '../dom.js';
import { getThreeRuntime } from '../runtime/viewer-runtime.js';
import { activeOverlayStateForSeries } from '../runtime/active-overlay-state.js';
import { regionsForSlice, invalidateRegionIndex } from './region-index.js';
import { layoutAtlasLabels } from './atlas-layout.js';
import { ROW_H } from './atlas-svg.js';
import { renderAtlasPills, clearAtlasPills } from './atlas-render.js';
import { anatomyBadge } from '../region-source.js';
import { volumeTip } from './label-inspect.js';
import { installSelectionUI, teardownSelectionUI } from './atlas-selection-ui.js';
import { onThreePostRender } from '../volume/volume-three-bootstrap.js';
import * as THREE from '../volume/vendor-three.js';

const PAD = 16;
const COL_GAP = 20;
const COL_W_FRAC = 0.16;
const COL_W_MIN = 120;
const COL_W_MAX = 200;
const MAX_VISIBLE = 28; // cap on-screen callouts for legibility
// A label drops once fewer than this fraction of its voxels fall inside the
// transfer-function window (i.e. the structure has mostly stopped rendering).
const MIN_VISIBLE_FRACTION = 0.1;

let _enabled = false;
let _unhookRender = null;
let _unsubs = [];
let _dirty = true;
let _lastW = 0;
let _lastH = 0;
const _lastCam = new Float64Array(16);

const _world = new THREE.Vector3();
const _view = new THREE.Vector3();
const _ndc = new THREE.Vector3();
const _faceA = new THREE.Vector3();
const _faceB = new THREE.Vector3();
const _faceN = new THREE.Vector3();
const _camToFace = new THREE.Vector3();

function cameraMoved(camera) {
  const e = camera.matrixWorld.elements;
  let moved = false;
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(e[i] - _lastCam[i]) > 1e-6) moved = true;
    _lastCam[i] = e[i];
  }
  return moved;
}

function updateLabels() {
  const svg = $('atlas3d-svg');
  if (!svg || !_enabled) return;
  if (state.mode !== '3d' && state.mode !== 'mpr3d') { clearAtlasPills(svg); return; }
  const three = getThreeRuntime();
  const { mesh, camera, renderer } = three;
  if (!mesh || !camera || !renderer) { clearAtlasPills(svg); return; }
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) { clearAtlasPills(svg); return; }

  const overlays = activeOverlayStateForSeries(series);
  const labels = overlays.labels;
  // Independent of the colour overlay (labels.enabled): labels need only the
  // region data (available + meta), so they show with or without Anatomy colour.
  if (!labels.available || !labels.meta) { clearAtlasPills(svg); return; }

  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 2 || h < 2) return;

  const moved = cameraMoved(camera);
  if (!_dirty && !moved && w === _lastW && h === _lastH && svg.childNodes.length) return;
  _dirty = false;
  _lastW = w; _lastH = h;

  // Align the overlay exactly to the renderer canvas inside #canvas-wrap.
  const wrap = $('canvas-wrap');
  if (wrap) {
    const cr = canvas.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    svg.style.left = `${cr.left - wr.left}px`;
    svg.style.top = `${cr.top - wr.top}px`;
    svg.style.width = `${cr.width}px`;
    svg.style.height = `${cr.height}px`;
  }
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  // When something is locked, only the locked structures render, so show ONLY
  // their labels (the rest would point at hidden geometry). Otherwise show all
  // minus the user's manual hidden set; hover-fade is pure CSS.
  const manualHidden = state.hiddenLabels instanceof Set ? state.hiddenLabels : new Set();
  const locked = state.lockedLabels instanceof Set ? state.lockedLabels : new Set();
  const isLockedView = locked.size > 0;
  const show = (label) => (isLockedView ? locked.has(label) : !manualHidden.has(label));
  const regions = regionsForSlice(series, state.sliceIdx);
  if (!regions.length) { clearAtlasPills(svg); return; }

  const W = series.width | 0;
  const H = series.height | 0;
  const D = series.slices | 0;
  const lz = (state.sliceIdx + 0.5) / D - 0.5; // current slice's depth plane in local box space
  const tz = (state.sliceIdx + 0.5) / D; // ...in [0,1] texcoord, for clip-box testing
  const lowT = Number.isFinite(state.lowT) ? state.lowT : 0;
  const highT = Number.isFinite(state.highT) ? state.highT : 1;
  const clipMin = state.clipMin || [0, 0, 0];
  const clipMax = state.clipMax || [1, 1, 1];
  mesh.updateWorldMatrix(true, false);

  // World-space normal of the slice plane (local +z, the cut face exposed by the
  // depth scrubber). When it faces away from the camera the structures are on the
  // far/occluded side, so we hide those callouts.
  _faceA.set(0, 0, lz); mesh.localToWorld(_faceA);
  _faceB.set(0, 0, lz + 0.05); mesh.localToWorld(_faceB);
  _faceN.copy(_faceB).sub(_faceA).normalize();

  const visible = [];
  for (const r of regions) {
    if (!show(r.label)) continue;
    const tx = r.cx / W;
    const ty = r.cy / H;
    // Clipped away by the 3D clip box?
    if (tx < clipMin[0] || tx > clipMax[0] || ty < clipMin[1] || ty > clipMax[1]
      || tz < clipMin[2] || tz > clipMax[2]) continue;
    // Windowed out by the transfer function? Hide when too little of the region's
    // voxels actually fall inside [low,high] (i.e. the structure barely renders).
    if (r.intensityCdf) {
      const loV = Math.max(0, Math.floor(lowT * 255));
      const hiV = Math.min(255, Math.ceil(highT * 255));
      const inWindow = r.intensityCdf[hiV] - (loV > 0 ? r.intensityCdf[loV - 1] : 0);
      if (inWindow / r.areaPx < MIN_VISIBLE_FRACTION) continue;
    }
    _world.set(tx - 0.5, ty - 0.5, lz);
    mesh.localToWorld(_world);
    // Occlusion cull only in the all-visible view. When locked, the structure is
    // isolated and you orbit around it, so keep its label stable (no flicker).
    if (!isLockedView) {
      _camToFace.copy(camera.position).sub(_world);
      if (_camToFace.dot(_faceN) <= 0) continue; // slice plane turned away from camera
    }
    _view.copy(_world).applyMatrix4(camera.matrixWorldInverse);
    if (_view.z >= -0.001) continue; // behind the camera
    _ndc.copy(_world).project(camera);
    if (_ndc.x < -1.05 || _ndc.x > 1.05 || _ndc.y < -1.05 || _ndc.y > 1.05) continue; // off-screen
    visible.push({
      label: r.label,
      name: r.name,
      color: r.color,
      areaPx: r.areaPx,
      anchorX: (_ndc.x * 0.5 + 0.5) * w,
      anchorY: (-_ndc.y * 0.5 + 0.5) * h,
    });
  }
  if (visible.length > MAX_VISIBLE) {
    visible.sort((p, q) => q.areaPx - p.areaPx);
    visible.length = MAX_VISIBLE;
  }

  let colW = Math.min(COL_W_MAX, Math.max(COL_W_MIN, w * COL_W_FRAC));
  colW = Math.max(80, Math.min(colW, (w - 2 * PAD - 2 * COL_GAP - 120) / 2));
  const placed = layoutAtlasLabels({
    items: visible,
    bounds: { top: PAD, bottom: h - PAD },
    centerX: w / 2,
    rowH: ROW_H,
  });
  // Aligned columns sit just outside the model's projected box (not the screen
  // edge), so labels stay close to it. Outer edges line up; inner edges hug it.
  let minMX = Infinity;
  let maxMX = -Infinity;
  for (let c = 0; c < 8; c += 1) {
    _world.set((c & 1) ? 0.5 : -0.5, (c & 2) ? 0.5 : -0.5, (c & 4) ? 0.5 : -0.5);
    mesh.localToWorld(_world);
    _ndc.copy(_world).project(camera);
    const sx = (_ndc.x * 0.5 + 0.5) * w;
    if (sx < minMX) minMX = sx;
    if (sx > maxMX) maxMX = sx;
  }
  const outerL = Math.max(PAD, minMX - COL_GAP - colW);
  const outerR = Math.min(w - PAD, maxMX + COL_GAP + colW);

  const items = placed.map((it) => ({
    label: it.label,
    name: it.name,
    color: it.color,
    side: it.side,
    pillOuterX: it.side === 'left' ? outerL : outerR,
    anchorX: it.anchorX,
    anchorY: it.anchorY,
    pillCenterY: it.y,
    colW,
    locked: locked.has(it.label),
    tip: volumeTip(series, state.regionMeta, it.label),
  }));
  renderAtlasPills(svg, items, items.length ? anatomyBadge(series) : '', w, h);
}

function invalidate(rebuildIndex = false) {
  if (rebuildIndex) invalidateRegionIndex();
  _dirty = true;
  getThreeRuntime().requestRender?.('atlas3d', 120);
}

export function setAtlas3DActive(active) {
  if (active === _enabled) return;
  _enabled = active;
  const svg = $('atlas3d-svg');
  $('canvas-wrap')?.classList.toggle('atlas3d', active);
  if (active) {
    _dirty = true;
    invalidateRegionIndex();
    if (svg) installSelectionUI(svg, { is3d: true });
    if (!_unhookRender) _unhookRender = onThreePostRender(updateLabels);
    if (!_unsubs.length) {
      const rebuild = ['regionVoxels', 'regionImgs', 'regionMeta', 'useRegions', 'voxels', 'hrVoxels', 'useBrain'];
      const rerender = ['sliceIdx', 'hiddenLabels', 'lockedLabels', 'lowT', 'highT', 'intensity', 'clipMin', 'clipMax'];
      _unsubs = [
        ...rebuild.map((key) => subscribe(key, () => invalidate(true))),
        ...rerender.map((key) => subscribe(key, () => invalidate(false))),
      ];
    }
    getThreeRuntime().requestRender?.('atlas3d-on', 220);
  } else {
    _unhookRender?.();
    _unhookRender = null;
    _unsubs.forEach((u) => u());
    _unsubs = [];
    if (svg) { teardownSelectionUI(svg); clearAtlasPills(svg); }
  }
}

export function isAtlas3DActive() {
  return _enabled;
}
