import { obliqueBasis } from '../mpr/mpr-oblique-geometry.js';
import { clampClipPlaneDepth, clampObliquePitch, clampObliqueYaw } from '../core/view-limits.js';

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * @param {{
 *   dims?: { W?: number, H?: number, D?: number },
 *   spacing?: { row?: number, col?: number, slice?: number },
 *   yaw?: number,
 *   pitch?: number,
 *   depth?: number,
 *   invert?: boolean,
 * }} [options]
 */
export function volumeClipPlane({
  dims,
  spacing,
  yaw = 0,
  pitch = 0,
  depth = 0.5,
  invert = false,
} = {}) {
  const W = Math.max(1, Math.floor(finite(dims?.W, 1)));
  const H = Math.max(1, Math.floor(finite(dims?.H, 1)));
  const D = Math.max(1, Math.floor(finite(dims?.D, 1)));
  const extents = [
    W * Math.max(0, finite(spacing?.col, 1)),
    H * Math.max(0, finite(spacing?.row, 1)),
    D * Math.max(0, finite(spacing?.slice, 1)),
  ];
  const { n } = obliqueBasis(clampObliqueYaw(yaw), clampObliquePitch(pitch));
  const normal = n.map((component, index) => component * extents[index]);
  const minProjection = normal.reduce((sum, component) => sum + Math.min(0, component), 0);
  const maxProjection = normal.reduce((sum, component) => sum + Math.max(0, component), 0);
  const threshold = minProjection + (maxProjection - minProjection) * clampClipPlaneDepth(depth);
  const direction = invert ? 1 : -1;
  return [
    normal[0] * direction,
    normal[1] * direction,
    normal[2] * direction,
    -threshold * direction,
  ];
}

export function clipPlaneContainsPoint(plane, point, epsilon = 1e-9) {
  if (!Array.isArray(plane) || plane.length !== 4) return true;
  const value = plane[0] * point[0] + plane[1] * point[1] + plane[2] * point[2] + plane[3];
  return value >= -Math.abs(epsilon);
}
