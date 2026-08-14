import { $ } from '../dom.js';
import {
  getThreeRuntime,
  setThreeRuntimeShell,
  setThreeRuntimeRenderFns,
} from '../runtime/viewer-runtime.js';
import * as THREE from './vendor-three.js';
import { TrackballControls } from './vendor-trackball-controls.js';

import { setThreeDView } from './volume-3d-views.js';
import { show3DHover } from './volume-3d-hover.js';

// Callbacks invoked after every 3D frame is rendered, with { renderer, scene,
// camera }. Used by the 3D atlas overlay to reproject its labels in lock-step
// with the volume (so leader lines stay glued to structures while orbiting).
const postRenderCallbacks = new Set();

/** Register a post-render callback; returns an unsubscribe function. */
export function onThreePostRender(cb) {
  postRenderCallbacks.add(cb);
  return () => postRenderCallbacks.delete(cb);
}

/**
 * Creates renderer, scene, camera, TrackballControls, render loop, resize,
 * pointer safety nets, and 3D canvas hover. Installs shell via setThreeRuntimeShell.
 */
export function ensureThreeRenderer(deps) {
  const { is3dActive, hideHover } = deps;
  const three = getThreeRuntime();

  const container = $('three-container');
  const w = container.clientWidth || window.innerWidth - 480;
  const h = container.clientHeight || window.innerHeight - 90;
  if (three.renderer) {
    three.renderer.setSize(w, h);
    three.camera.aspect = w / h;
    three.camera.updateProjectionMatrix();
    if (three.controls.handleResize) three.controls.handleResize();
    if (three.renderNow) three.renderNow();
    if (three.requestRender) three.requestRender('resize');
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  // Cap the device pixel ratio: a 3× display would otherwise push ~9× the
  // fragments through the heavy volume raycast shader for no visible gain.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(2.2, 1.8, 2.2);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.0;
  controls.zoomSpeed = 1.1;
  controls.panSpeed = 1.0;
  // Slightly stiffer damping so zoom/orbit inertia settles quickly instead of
  // drifting after the gesture ends (the lingering glide reads as "lag").
  controls.dynamicDampingFactor = 0.2;
  controls.noPan = false;
  controls.noZoom = false;
  controls.noRotate = false;

  // True between a TrackballControls 'start' and 'end'; gates the hover raymarch.
  let pointerInteracting = false;
  window.addEventListener('pointerup', (e) => {
    if (is3dActive() && renderer.domElement.isConnected) {
      renderer.domElement.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: e.pointerId, pointerType: e.pointerType,
        clientX: e.clientX, clientY: e.clientY, bubbles: false,
      }));
    }
  });
  window.addEventListener('blur', () => {
    // The synthetic pointerup below uses a fixed mouse id, which won't release a
    // tracked touch pointer; clear the flag directly so hover never stays off.
    pointerInteracting = false;
    if (is3dActive() && renderer.domElement.isConnected) {
      renderer.domElement.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'mouse', bubbles: false,
      }));
    }
  });

  let rafId = 0;
  let loopUntil = 0;
  // While the camera is moving, raycast at a fraction of the full step budget.
  // The shader's jitter/dither hides the lower sample count during motion, and
  // the settling frame is redrawn at full quality — this is what keeps zoom,
  // orbit, and pan smooth instead of stalling on the per-frame volume march.
  const DRAFT_STEP_SCALE = 0.4;
  const MIN_DRAFT_STEPS = 96;
  function applyRenderQuality(draft) {
    const mat = three.mesh?.material;
    const u = mat?.uniforms?.uSteps;
    if (!u) return;
    // Leave uSteps untouched if the full budget is unknown — never restore to a
    // draft value (which would lock the volume at low quality).
    const full = mat.userData.fullSteps;
    if (!full) return;
    // Only volumes too large for a precomputed gradient drop quality in motion;
    // everything else has cheap shading and renders full quality even mid-orbit.
    const useDraft = draft && mat.userData.progressive === true;
    const target = useDraft
      ? Math.max(MIN_DRAFT_STEPS, Math.round(full * DRAFT_STEP_SCALE))
      : full;
    if (u.value !== target) u.value = target;
  }
  function scheduleFrame() {
    if (rafId) return;
    rafId = requestAnimationFrame(renderFrame);
  }
  function renderScene(draft, { updateControls = true } = {}) {
    if (!is3dActive()) return;
    if (updateControls) controls.update();
    applyRenderQuality(draft);
    renderer.render(scene, camera);
    for (const cb of postRenderCallbacks) {
      try { cb({ renderer, scene, camera }); } catch { /* a label overlay error must not kill the loop */ }
    }
  }
  function renderFrame() {
    rafId = 0;
    // controls.update() can dispatch 'change' and extend loopUntil, so read it
    // after: a frame with time left is mid-motion (draft); the first frame past
    // the deadline is the settle frame (full quality, then the loop stops).
    if (!is3dActive()) return;
    controls.update();
    const animating = Date.now() < loopUntil;
    renderScene(animating, { updateControls: false });
    if (animating) scheduleFrame();
  }
  function requestRender(_reason = 'update', burstMs = 0) {
    if (!is3dActive()) return;
    if (burstMs > 0) loopUntil = Math.max(loopUntil, Date.now() + burstMs);
    scheduleFrame();
  }
  function startLoop() {
    requestRender('start-loop', 220);
  }
  function stopLoop() {
    loopUntil = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  function renderNow() {
    renderScene(false);
  }
  controls.addEventListener('start', () => { pointerInteracting = true; requestRender('controls-start', 500); });
  controls.addEventListener('change', () => requestRender('controls-change', 220));
  controls.addEventListener('end', () => { pointerInteracting = false; requestRender('controls-end', 160); });
  setThreeRuntimeShell({ renderer, scene, camera, controls, startLoop });
  setThreeRuntimeRenderFns({ startLoop, stopLoop, requestRender, renderNow });
  startLoop();

  const syncRendererToContainer = () => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    renderer.setSize(cw, ch);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    if (controls.handleResize) controls.handleResize();
    renderNow();
    requestRender('container-resize', 120);
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncRendererToContainer).observe(container);
  } else {
    window.addEventListener('resize', syncRendererToContainer);
  }

  renderer.domElement.addEventListener('dblclick', (e) => {
    e.preventDefault();
    setThreeDView('reset');
    requestRender('dblclick-view', 160);
  });

  let hoverThrottle = 0;
  renderer.domElement.addEventListener('mousemove', (e) => {
    // Skip the CPU hover raymarch mid-drag — it competes with the render loop.
    if (pointerInteracting) return;
    const now = Date.now();
    if (now - hoverThrottle < 66) return;
    hoverThrottle = now;
    show3DHover(e, renderer, camera);
  });
  renderer.domElement.addEventListener('mouseleave', hideHover);
}
