// Gather measurements / ROIs / annotations for SR export.
import { drawingEntriesForSeries } from '../overlay/annotation-graph.js';
import { inPlanePixelSpacing } from '../core/geometry.js';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanedStats(stats, spacingKnown = true) {
  if (!stats || typeof stats !== 'object') return stats;
  const out = {};
  for (const key of ['area_mm2', 'mean', 'std']) {
    if (key === 'area_mm2' && !spacingKnown) continue;
    const value = finiteNumber(stats[key]);
    if (value != null) out[key] = value;
  }
  if (stats.adc && typeof stats.adc === 'object') {
    const mean = finiteNumber(stats.adc.mean);
    if (mean != null) out.adc = { mean };
  }
  return Object.keys(out).length ? out : null;
}

export function collectMeasurements(host) {
  const slug = host.manifest.series[host.seriesIdx].slug;
  const series = host.manifest.series[host.seriesIdx];
  const spacing = inPlanePixelSpacing(series);
  const out = [];
  for (const entry of drawingEntriesForSeries(host, slug)) {
    if (entry.kind === 'line') {
      const m = entry.data;
      const length = finiteNumber(m.mm);
      if (length == null) continue;
      const item = {
        kind: 'length',
        slice: entry.sliceIdx,
        handles: [[m.x1, m.y1], [m.x2, m.y2]],
      };
      if (spacing.known && m.unit !== 'px') item.length_mm = length;
      else item.length_px = length;
      out.push(item);
    } else if (entry.kind === 'angle') {
      const a = entry.data;
      out.push({
        kind: 'angle',
        slice: entry.sliceIdx,
        angle_deg: a.deg,
        handles: [[a.p1.x, a.p1.y], [a.vertex.x, a.vertex.y], [a.p3.x, a.p3.y]],
      });
    } else if (entry.kind === 'ellipse' || entry.kind === 'polygon') {
      const r = entry.data;
      out.push({
        kind: entry.kind,
        slice: entry.sliceIdx,
        handles: r.pts,
        stats: cleanedStats(r.stats, spacing.known),
      });
    } else if (entry.kind === 'note') {
      const n = entry.data;
      out.push({
        kind: 'text',
        slice: entry.sliceIdx,
        handles: [[n.x, n.y]],
        text: n.text || '',
      });
    }
  }

  return { slug, series, measurements: out };
}
