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
const ORTHOGRAPHIC_VIEW_HEIGHT = 2.4;
const TURNTABLE_PERIOD_MS = 24_000;
const TURNTABLE_FRAME_MS = 1000 / 30;
let turntableController = null;

function fitOrthographicCamera(camera, width, height) {
  const halfHeight = ORTHOGRAPHIC_VIEW_HEIGHT / 2;
  const halfWidth = halfHeight * Math.max(width, 1) / Math.max(height, 1);
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

export function toggleThreeTurntable() {
  return turntableController?.toggle() || false;
}

export function stopThreeTurntable() {
  turntableController?.stop();
}

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
    fitOrthographicCamera(three.camera, w, h);
    if (three.controls.handleResize) three.controls.handleResize();
    if (three.renderNow) three.renderNow();
    if (three.requestRender) three.requestRender('resize');
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const devicePixelRatio = window.devicePixelRatio || 1;
  const settledPixelRatio = Math.min(devicePixelRatio, 1.5);
  const interactivePixelRatio = Math.min(devicePixelRatio, 1);
  let currentPixelRatio = settledPixelRatio;
  renderer.setPixelRatio(currentPixelRatio);
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
  fitOrthographicCamera(camera, w, h);
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
  let turntableActive = false;
  let turntableAngle = 0;
  let turntableLastTime = 0;
  let turntableLastFrame = 0;
  const turntableAxis = new THREE.Vector3(0, 1, 0);
  const turntableTarget = new THREE.Vector3();
  const turntableOrigin = new THREE.Vector3();
  const turntableOffset = new THREE.Vector3();
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function syncTurntableButton() {
    const button = $('three-turntable');
    if (!button) return;
    button.disabled = reducedMotion?.matches === true;
    button.setAttribute('aria-pressed', String(turntableActive));
    button.setAttribute('aria-label', turntableActive ? 'Stop turntable' : 'Start turntable');
  }
  function setRenderResolution(interactive) {
    const next = interactive ? interactivePixelRatio : settledPixelRatio;
    if (next === currentPixelRatio) return;
    currentPixelRatio = next;
    renderer.setPixelRatio(next);
  }
  function stopTurntable({ render = true } = {}) {
    if (!turntableActive) return;
    turntableActive = false;
    turntableLastTime = 0;
    syncTurntableButton();
    if (render) requestRender('turntable-stop', 100);
  }
  function toggleTurntable() {
    if (turntableActive) {
      stopTurntable();
      return false;
    }
    if (reducedMotion?.matches || !is3dActive()) return false;
    setThreeDView('reset');
    turntableTarget.copy(controls.target || new THREE.Vector3());
    turntableOrigin.copy(camera.position).sub(turntableTarget);
    turntableAngle = 0;
    turntableLastTime = 0;
    turntableLastFrame = 0;
    turntableActive = true;
    syncTurntableButton();
    requestRender('turntable-start');
    return true;
  }
  function scheduleFrame() {
    if (rafId) return;
    rafId = requestAnimationFrame(renderFrame);
  }
  function renderScene({ updateControls = true } = {}) {
    if (!is3dActive()) return;
    if (updateControls) controls.update();
    renderer.render(scene, camera);
    for (const cb of postRenderCallbacks) {
      try { cb({ renderer, scene, camera }); } catch { /* a label overlay error must not kill the loop */ }
    }
  }
  function renderFrame(timestamp) {
    rafId = 0;
    if (!is3dActive()) return;
    controls.update();
    const controlsAnimating = Date.now() < loopUntil;
    const interactive = controlsAnimating || turntableActive;
    setRenderResolution(interactive);
    let shouldRender = true;
    if (turntableActive) {
      if (turntableLastTime) {
        const elapsed = Math.min(timestamp - turntableLastTime, 100);
        turntableAngle = (turntableAngle + elapsed * Math.PI * 2 / TURNTABLE_PERIOD_MS) % (Math.PI * 2);
      }
      turntableLastTime = timestamp;
      shouldRender = !turntableLastFrame || timestamp - turntableLastFrame >= TURNTABLE_FRAME_MS;
      if (shouldRender) {
        turntableLastFrame = timestamp;
        turntableOffset.copy(turntableOrigin).applyAxisAngle(turntableAxis, turntableAngle);
        camera.position.copy(turntableTarget).add(turntableOffset);
        camera.lookAt(turntableTarget);
      }
    }
    if (shouldRender) renderScene({ updateControls: false });
    if (interactive) scheduleFrame();
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
    stopTurntable({ render: false });
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    setRenderResolution(false);
  }
  function renderNow() {
    renderScene();
  }
  controls.addEventListener('start', () => {
    pointerInteracting = true;
    stopTurntable({ render: false });
    requestRender('controls-start', 500);
  });
  controls.addEventListener('change', () => requestRender('controls-change', 220));
  controls.addEventListener('end', () => { pointerInteracting = false; requestRender('controls-end', 160); });
  setThreeRuntimeShell({ renderer, scene, camera, controls, startLoop });
  setThreeRuntimeRenderFns({ startLoop, stopLoop, requestRender, renderNow });
  turntableController = { toggle: toggleTurntable, stop: stopTurntable };
  reducedMotion?.addEventListener?.('change', () => {
    if (reducedMotion.matches) stopTurntable();
    syncTurntableButton();
  });
  syncTurntableButton();
  startLoop();

  const syncRendererToContainer = () => {
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (cw <= 0 || ch <= 0) return;
    renderer.setSize(cw, ch);
    fitOrthographicCamera(camera, cw, ch);
    if (controls.handleResize) controls.handleResize();
    renderNow();
    requestRender('container-resize', 120);
  };
  const Observer = globalThis.ResizeObserver;
  if (Observer) {
    new Observer(syncRendererToContainer).observe(container);
  } else {
    window.addEventListener('resize', syncRendererToContainer);
  }

  renderer.domElement.addEventListener('dblclick', (e) => {
    e.preventDefault();
    stopTurntable({ render: false });
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
