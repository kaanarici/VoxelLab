// Three-point angle measurement tool. The user clicks three points on
// a 2D slice: the two endpoints of the angle's arms and the vertex.
// Rendered as SVG in the measurement overlay alongside rulers and ROIs.
//
// Persisted by selected-series fingerprint and slice, the same pattern as
// linear measurements in measure.js.

import { $, canvasScreenScale, clientToCanvasPx } from '../dom.js';
import { inPlanePixelSpacing } from '../core/geometry.js';
import { state } from '../core/state.js';
import { angleEntriesForSlice } from '../overlay/annotation-graph.js';
import {
  appendAngleMeasurement,
  deleteAngleMeasurementAt,
  setAngleMode,
  setAnglePending,
} from '../core/state/viewer-tool-commands.js';
import { renderRoiResults } from './roi-results.js';

function refreshRoiResults() {
  if (globalThis.document?.createElement instanceof Function) renderRoiResults();
}

function angleKey() {
  return `${state.manifest.series[state.seriesIdx].slug}|${state.sliceIdx}`;
}

function anglesHere() {
  const series = state.manifest.series[state.seriesIdx];
  return series ? angleEntriesForSlice(state, series, state.sliceIdx) : [];
}

function currentMicroscopyScope() {
  const series = state.manifest.series[state.seriesIdx];
  if (series?.imageDomain !== 'microscopy') return null;
  return {
    channelIndex: Number(series.microscopy?.channelIndex || 0),
    channelName: series.microscopy?.channelName || '',
    timeIndex: Number(series.microscopy?.timeIndex || 0),
  };
}

function angleVisibleInCurrentScope(angle) {
  const scope = currentMicroscopyScope();
  if (!scope || !angle.microscopy) return true;
  return Number(angle.microscopy.channelIndex || 0) === scope.channelIndex
    && Number(angle.microscopy.timeIndex || 0) === scope.timeIndex;
}

export function toggleAngle() {
  if (state.mode !== '2d' && !state.angleMode) return false;
  setAngleMode(!state.angleMode);
  const btn = $('btn-angle');
  if (btn) btn.classList.toggle('active', state.angleMode);
  return state.angleMode;
}

export function isAngleMode() { return state.angleMode; }

export function onAngleClick(ev) {
  if (!state.angleMode || state.mode !== '2d') return;
  const [x, y] = clientToCanvasPx($('view'), ev.clientX, ev.clientY);

  if (!state.anglePending) {
    // First click = first arm endpoint
    setAnglePending([{ x, y }]);
  } else if (state.anglePending.length === 1) {
    // Second click = vertex
    setAnglePending([...state.anglePending, { x, y }]);
  } else {
    // Third click = second arm endpoint → finalize
    const [p1, vertex, p3] = [...state.anglePending, { x, y }];
    const series = state.manifest.series[state.seriesIdx];
    const a = computeAngle(p1, vertex, p3, series);
    const k = angleKey();
    appendAngleMeasurement(k, { p1, vertex, p3, deg: a, microscopy: currentMicroscopyScope() });
    setAnglePending(null);
    refreshRoiResults();
  }
}

function physicalAxes(series) {
  const spacing = inPlanePixelSpacing(series);
  return {
    sx: spacing.colMm,
    sy: spacing.rowMm,
  };
}

function physicalDelta(point, vertex, series) {
  const { sx, sy } = physicalAxes(series);
  return {
    dx: (point.x - vertex.x) * sx,
    dy: (point.y - vertex.y) * sy,
  };
}

function computeAngle(p1, vertex, p3, series) {
  const { dx: dx1, dy: dy1 } = physicalDelta(p1, vertex, series);
  const { dx: dx2, dy: dy2 } = physicalDelta(p3, vertex, series);
  const dot = dx1 * dx2 + dy1 * dy2;
  const mag1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const mag2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
  if (mag1 < 0.001 || mag2 < 0.001) return 0;
  const cos = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  return Math.acos(cos) * (180 / Math.PI);
}

// Render angle measurements + in-progress preview into the shared SVG.
// Called from drawMeasurements() so angles coexist with rulers and ROIs.
export function drawAngles(svg) {
  const list = anglesHere().filter(angleVisibleInCurrentScope);
  const canvas = $('view');
  const displayScale = canvasScreenScale(svg, canvas.width, canvas.height);
  const scaleX = Math.max(1e-6, displayScale.x);
  const scaleY = Math.max(1e-6, displayScale.y);
  const fontSize = 11 / scaleY;
  const svgNS = 'http://www.w3.org/2000/svg';

  list.forEach((m) => {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'angle-group');

    // Two arm lines from vertex
    for (const ep of [m.p1, m.p3]) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', m.vertex.x); line.setAttribute('y1', m.vertex.y);
      line.setAttribute('x2', ep.x); line.setAttribute('y2', ep.y);
      line.setAttribute('class', 'm-line');
      g.appendChild(line);
    }

    // Vertex dot
    const dot = document.createElementNS(svgNS, 'ellipse');
    dot.setAttribute('cx', m.vertex.x); dot.setAttribute('cy', m.vertex.y);
    dot.setAttribute('rx', 3 / scaleX); dot.setAttribute('ry', 3 / scaleY);
    dot.setAttribute('class', 'm-dot');
    g.appendChild(dot);

    // Arc indicator (small arc at vertex)
    const arcRadius = 20;
    const dx1 = (m.p1.x - m.vertex.x) * scaleX;
    const dy1 = (m.p1.y - m.vertex.y) * scaleY;
    const dx2 = (m.p3.x - m.vertex.x) * scaleX;
    const dy2 = (m.p3.y - m.vertex.y) * scaleY;
    const a1 = Math.atan2(dy1, dx1);
    const a2 = Math.atan2(dy2, dx2);
    const sx = m.vertex.x + arcRadius * Math.cos(a1) / scaleX;
    const sy = m.vertex.y + arcRadius * Math.sin(a1) / scaleY;
    const ex = m.vertex.x + arcRadius * Math.cos(a2) / scaleX;
    const ey = m.vertex.y + arcRadius * Math.sin(a2) / scaleY;
    // Shape: -0.35 -> shortest signed arc from ray 1 to ray 2 in radians.
    const delta = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const sweep = delta >= 0 ? 1 : 0;
    const arc = document.createElementNS(svgNS, 'path');
    arc.setAttribute('d', `M ${sx} ${sy} A ${arcRadius / scaleX} ${arcRadius / scaleY} 0 ${largeArc} ${sweep} ${ex} ${ey}`);
    arc.setAttribute('fill', 'none');
    arc.setAttribute('stroke', 'rgba(255,255,255,0.7)');
    arc.setAttribute('stroke-width', '1');
    g.appendChild(arc);

    // Label
    const midAngle = a1 + delta / 2;
    const labelRadius = arcRadius + 11;
    const lx = m.vertex.x + labelRadius * Math.cos(midAngle) / scaleX;
    const ly = m.vertex.y + labelRadius * Math.sin(midAngle) / scaleY;
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', lx); label.setAttribute('y', ly);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'm-label');
    label.setAttribute('font-size', fontSize);
    label.textContent = `${m.deg.toFixed(1)}°`;
    label.setAttribute('transform', `translate(${lx} ${ly}) scale(${scaleY / scaleX} 1) translate(${-lx} ${-ly})`);
    g.appendChild(label);

    // Delete button
    const dx = lx + (label.textContent.length * 3.2 + 10) / scaleX;
    const dy = ly - 4 / scaleY;
    const bg = document.createElementNS(svgNS, 'ellipse');
    bg.setAttribute('cx', dx); bg.setAttribute('cy', dy);
    bg.setAttribute('rx', 8 / scaleX); bg.setAttribute('ry', 8 / scaleY);
    bg.setAttribute('class', 'm-del-bg');
    g.appendChild(bg);
    const x1 = dx - 3.2 / scaleX, x2 = dx + 3.2 / scaleX;
    const y1 = dy - 3.2 / scaleY, y2 = dy + 3.2 / scaleY;
    const cross1 = document.createElementNS(svgNS, 'line');
    cross1.setAttribute('x1', x1); cross1.setAttribute('y1', y1);
    cross1.setAttribute('x2', x2); cross1.setAttribute('y2', y2);
    cross1.setAttribute('class', 'm-del-x');
    g.appendChild(cross1);
    const cross2 = document.createElementNS(svgNS, 'line');
    cross2.setAttribute('x1', x2); cross2.setAttribute('y1', y1);
    cross2.setAttribute('x2', x1); cross2.setAttribute('y2', y2);
    cross2.setAttribute('class', 'm-del-x');
    g.appendChild(cross2);
    const hit = document.createElementNS(svgNS, 'ellipse');
    hit.setAttribute('cx', dx); hit.setAttribute('cy', dy);
    hit.setAttribute('rx', 8 / scaleX); hit.setAttribute('ry', 8 / scaleY);
    hit.setAttribute('class', 'm-del-hit');
    hit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteAngleMeasurementAt(angleKey(), m);
      refreshRoiResults();
      g.remove();
    });
    g.appendChild(hit);

    svg.appendChild(g);
  });

  // In-progress preview
  if (state.anglePending && state.anglePending.length > 0) {
    for (const pt of state.anglePending) {
      const dot = document.createElementNS(svgNS, 'ellipse');
      dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
      dot.setAttribute('rx', 4 / scaleX); dot.setAttribute('ry', 4 / scaleY);
      dot.setAttribute('class', 'm-dot');
      svg.appendChild(dot);
    }
    // Draw arm lines from last point
    if (state.anglePending.length === 2) {
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', state.anglePending[0].x);
      line.setAttribute('y1', state.anglePending[0].y);
      line.setAttribute('x2', state.anglePending[1].x);
      line.setAttribute('y2', state.anglePending[1].y);
      line.setAttribute('class', 'm-line');
      svg.appendChild(line);
    }
  }
}
