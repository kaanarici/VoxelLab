import { normalizeModality } from './dicom-meta.js';
import {
  geoSliceSpacing,
  incrementReason,
  numberList,
  positiveSpacing2,
  RTSTRUCT_NO_USABLE_CONTOURS_REASON,
  seqFirst,
  sliceIndexForIPP,
  sourceContourGridReady,
  voxelPointForLps,
} from './derived-common.js';

export function rtstructSourceSeriesUID(meta) {
  const frameRef = seqFirst(meta?.ReferencedFrameOfReferenceSequence);
  const studyRef = seqFirst(frameRef?.RTReferencedStudySequence);
  const seriesRef = seqFirst(studyRef?.RTReferencedSeriesSequence);
  return String(seriesRef?.SeriesInstanceUID || '');
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += (x1 * y2) - (x2 * y1);
  }
  return Math.abs(sum) * 0.5;
}

function rtstructContourCount(meta) {
  return (meta?.ROIContourSequence || []).reduce(
    (sum, contourGroup) => sum + (Array.isArray(contourGroup?.ContourSequence) ? contourGroup.ContourSequence.length : 0),
    0,
  );
}

function rtstructReasonSummary(reasonCounts = {}) {
  return Object.entries(reasonCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
}

export function rtstructNoContoursResult(reasonCounts) {
  const summary = rtstructReasonSummary(reasonCounts);
  return {
    skipped: true,
    reason: summary ? `${RTSTRUCT_NO_USABLE_CONTOURS_REASON} (${summary})` : RTSTRUCT_NO_USABLE_CONTOURS_REASON,
    reasonCounts,
  };
}

export function buildRTStructImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'RTSTRUCT') return null;
  const skippedReasonCounts = {};
  if (!sourceContourGridReady(sourceSeries)) {
    incrementReason(skippedReasonCounts, 'source_geometry_not_contour_ready');
    return {
      kind: 'rtstruct',
      name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'RTSTRUCT import'),
      roisBySlice: {},
      skippedReasonCounts,
    };
  }
  if (rtstructContourCount(meta) <= 0) incrementReason(skippedReasonCounts, 'rtstruct_no_contours');
  const sliceSpacing = Math.max(geoSliceSpacing(sourceSeries), 1e-6);
  const planeToleranceMm = 1.2;
  const planeToleranceSlices = planeToleranceMm / sliceSpacing;
  const names = new Map((meta.StructureSetROISequence || []).map((roi) => [
    Number(roi?.ROINumber || 0),
    String(roi?.ROIName || roi?.ROIDescription || `ROI ${roi?.ROINumber || ''}`).trim() || 'ROI',
  ]));
  const roisBySlice = {};
  for (const contourGroup of meta.ROIContourSequence || []) {
    const roiNumber = Number(contourGroup?.ReferencedROINumber || 0);
    const roiName = names.get(roiNumber) || `ROI ${roiNumber || ''}`.trim();
    for (const contour of contourGroup?.ContourSequence || []) {
      if (String(contour?.ContourGeometricType || '').toUpperCase() !== 'CLOSED_PLANAR') {
        incrementReason(skippedReasonCounts, 'unsupported_contour_type');
        continue;
      }
      const raw = numberList(contour?.ContourData, 6);
      if (raw.length < 6 || raw.length % 3 !== 0) {
        incrementReason(skippedReasonCounts, 'invalid_contour_data');
        continue;
      }
      const points = [];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      let invalidPoint = false;
      for (let i = 0; i < raw.length; i += 3) {
        cx += raw[i];
        cy += raw[i + 1];
        cz += raw[i + 2];
        const point = voxelPointForLps(sourceSeries, [raw[i], raw[i + 1], raw[i + 2]]);
        if (!point) {
          invalidPoint = true;
          break;
        }
        points.push(point);
      }
      if (invalidPoint) {
        incrementReason(skippedReasonCounts, 'contour_point_not_mappable');
        continue;
      }
      const centroid = [
        cx / points.length,
        cy / points.length,
        cz / points.length,
      ];
      const zSpread = points.reduce((spread, point) => ({
        min: Math.min(spread.min, point[2]),
        max: Math.max(spread.max, point[2]),
      }), { min: Infinity, max: -Infinity });
      const sliceIndex = sliceIndexForIPP(sourceSeries, centroid, planeToleranceMm);
      if (sliceIndex < 0 || sliceIndex >= sourceSeries.slices) {
        incrementReason(skippedReasonCounts, 'contour_slice_out_of_range');
        continue;
      }
      if ((zSpread.max - zSpread.min) > planeToleranceSlices) {
        incrementReason(skippedReasonCounts, 'contour_not_planar_on_source_slice');
        continue;
      }
      const polygon = points.map(([x, y]) => [x, y]);
      const areaPx = polygonArea(polygon);
      const spacing = positiveSpacing2(sourceSeries.pixelSpacing);
      const stats = spacing ? { area_mm2: areaPx * spacing[0] * spacing[1] } : null;
      const key = String(sliceIndex);
      roisBySlice[key] = roisBySlice[key] || [];
      roisBySlice[key].push({
        shape: 'polygon',
        pts: polygon,
        text: roiName,
        sourceObjectUID: String(meta.SOPInstanceUID || ''),
        stats,
      });
    }
  }
  return {
    kind: 'rtstruct',
    name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'RTSTRUCT import'),
    roisBySlice,
    skippedReasonCounts,
  };
}
