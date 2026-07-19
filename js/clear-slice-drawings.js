// Confirm + clear all measurements / angles / ROIs / annotations on one slice.
import { state } from './core/state.js';
import { $, showDialog } from './dom.js';
import { drawSlice } from './slice-view.js';
import { drawMeasurements } from './roi/measure.js';
import { renderAnnotationList } from './overlay/annotation.js';
import { drawSparkline } from './sparkline.js';
import { clearDrawingEntriesForSlice, drawingCountsForSlice } from './overlay/annotation-graph.js';
import { renderRoiResults } from './roi/roi-results.js';

export function clearCurrentSliceDrawings() {
  const series = state.manifest.series[state.seriesIdx];
  const z = state.sliceIdx;
  const counts = drawingCountsForSlice(state, series, z);
  const nMeasure = counts.measurements;
  const nAngle = counts.angles;
  const nROI = counts.rois;
  const nAnnot = counts.notes;
  const total = counts.total;
  if (total === 0) return;

  const close = showDialog('Clear drawings', `
    <div class="dlg-sub-spaced">
      This will remove <b>${total}</b> item${total > 1 ? 's' : ''} on slice ${z + 1}:
      ${nMeasure ? `${nMeasure} ruler${nMeasure > 1 ? 's' : ''}, ` : ''}
      ${nAngle ? `${nAngle} angle${nAngle > 1 ? 's' : ''}, ` : ''}
      ${nROI ? `${nROI} ROI${nROI > 1 ? 's' : ''}, ` : ''}
      ${nAnnot ? `${nAnnot} annotation${nAnnot > 1 ? 's' : ''}` : ''}
    </div>
    <div class="dlg-actions">
      <button class="annot-btn" id="clear-cancel">Cancel</button>
      <button class="annot-btn danger" id="clear-confirm">Clear</button>
    </div>
  `);
  $('clear-cancel').onclick = close;
  $('clear-confirm').onclick = () => {
    clearDrawingEntriesForSlice(state, series, z);
    close();
    drawSlice();
    drawMeasurements();
    renderAnnotationList();
    renderRoiResults();
    drawSparkline();
  };
}
