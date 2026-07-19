// Replay path for microscopy workflow recipes: fail-closed validation against
// the active series followed by a transactional apply with full rollback.
// Shared series-shape and numeric primitives are imported from recipe-encode.js.

import { state } from '../core/state.js';
import { setColormap, setWindowLevel } from '../core/state/viewer-commands.js';
import {
  angleEntriesForSlice,
  nextDrawingEntryId,
  roiEntriesForSlice,
  setAngleEntriesForSlice,
  setRoiEntriesForSlice,
} from '../overlay/annotation-graph.js';
import { lengthUnitToMm, normalizeLengthUnit } from '../core/physical-units.js';
import { seriesPersistenceKey } from '../series/series-identity.js';
import {
  importRoiResultsBundle,
  roiResultRows,
  roiResultsBundleIncompatibleRowCount,
  validateRoiResultsBundleForSeries,
} from '../roi/roi-results.js';
import { MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS } from '../sidecar-schemas.js';
import { replayAnalysisOp } from './microscopy-analysis.js';
import { ensureMicroscopyComposite, setMicroscopyCompositeChannelEnabled, setMicroscopyCompositeEnabled } from './microscopy-channel-composite.js';
import { applyDisplayRangeToChannelStacks, finiteDisplayRange } from './microscopy-display-range.js';
import {
  activeSeries,
  angleObjectId,
  channelCount,
  channelNameForIndex,
  cleanPoint,
  depthCount,
  finiteInteger,
  finitePositiveInteger,
  finitePositiveNumber,
  hasKnownXYCalibration,
  measurementRows,
  timeCount,
} from './microscopy-workflow-recipe-encode.js';

const SUPPORTED_RECIPE_SCHEMAS = new Set(MICROSCOPY_WORKFLOW_RECIPE_SCHEMAS);

function sourceFormatForSeries(series = {}) {
  return String(series.microscopyDataset?.source?.originalFormat || series.sequence || '').trim();
}

function sourceFormatForRecipe(recipe = {}) {
  return String(recipe?.target?.sourceFormat || '').trim();
}

function canApplyRecipeCalibration(recipe = {}, series = {}) {
  const calibration = recipe?.calibration || {};
  return recipe?.requirements?.calibrationRequired
    && !hasKnownXYCalibration(series)
    && sourceFormatForRecipe(recipe) === 'TIFF sequence'
    && sourceFormatForSeries(series) === 'TIFF sequence'
    && calibration.xyKnown === true
    && finitePositiveNumber(calibration.rowMm) != null
    && finitePositiveNumber(calibration.colMm) != null;
}

function seriesWithRecipeCalibration(series = {}, recipe = {}) {
  if (!canApplyRecipeCalibration(recipe, series)) return series;
  const calibration = recipe.calibration || {};
  return {
    ...series,
    pixelSpacing: [finitePositiveNumber(calibration.rowMm), finitePositiveNumber(calibration.colMm)],
    _spacingKnown: true,
    sliceSpacing: calibration.zKnown ? finitePositiveNumber(calibration.zMm, series.sliceSpacing) : series.sliceSpacing,
    sliceThickness: calibration.zKnown ? finitePositiveNumber(calibration.zMm, series.sliceThickness) : series.sliceThickness,
    _sliceSpacingKnown: calibration.zKnown ? true : series._sliceSpacingKnown,
    microscopy: {
      ...(series.microscopy || {}),
      calibrationSource: 'manual',
      physicalUnit: normalizeLengthUnit(calibration.displayUnit || series.microscopy?.physicalUnit || 'µm'),
    },
  };
}

function matchesSeriesShape(recipe = {}, series = {}) {
  const target = recipe?.target || {};
  const geometry = target.geometry || {};
  const recipeWidth = finitePositiveInteger(geometry.width, 0);
  const recipeHeight = finitePositiveInteger(geometry.height, 0);
  const recipeZ = finitePositiveInteger(geometry.sizeZ, 0);
  const recipeC = finitePositiveInteger(geometry.sizeC, 0);
  const recipeT = finitePositiveInteger(geometry.sizeT, 0);
  if (target.imageDomain && target.imageDomain !== series.imageDomain) return false;
  if (recipeWidth && recipeWidth !== finitePositiveInteger(series.width, 1)) return false;
  if (recipeHeight && recipeHeight !== finitePositiveInteger(series.height, 1)) return false;
  if (recipeZ && recipeZ !== depthCount(series)) return false;
  if (recipeC && recipeC !== channelCount(series)) return false;
  if (recipeT && recipeT !== timeCount(series)) return false;
  const recipeFormat = String(target.sourceFormat || '').trim();
  const seriesFormat = sourceFormatForSeries(series);
  if (recipeFormat && seriesFormat && recipeFormat !== seriesFormat) return false;
  return true;
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function calibrationSnapshot(series = {}) {
  return {
    pixelSpacing: Array.isArray(series.pixelSpacing) ? series.pixelSpacing.slice() : null,
    sliceSpacing: series.sliceSpacing,
    sliceThickness: series.sliceThickness,
    spacingKnown: series._spacingKnown,
    sliceSpacingKnown: series._sliceSpacingKnown,
    microscopy: cloneJson(series.microscopy || {}),
    microscopyDataset: cloneJson(series.microscopyDataset || {}),
  };
}

function restoreCalibrationSnapshot(series = {}, snapshot = {}) {
  if (snapshot.pixelSpacing) series.pixelSpacing = snapshot.pixelSpacing.slice();
  else delete series.pixelSpacing;
  series.sliceSpacing = snapshot.sliceSpacing;
  series.sliceThickness = snapshot.sliceThickness;
  series._spacingKnown = snapshot.spacingKnown;
  series._sliceSpacingKnown = snapshot.sliceSpacingKnown;
  series.microscopy = cloneJson(snapshot.microscopy || {});
  series.microscopyDataset = cloneJson(snapshot.microscopyDataset || {});
}

function axisByName(dataset = {}, name) {
  return dataset.axes?.find((axis) => axis?.name === name) || null;
}

function applyRecipeCalibration(series = {}, recipe = {}) {
  if (!canApplyRecipeCalibration(recipe, series)) return false;
  const calibration = recipe.calibration || {};
  const rowMm = finitePositiveNumber(calibration.rowMm);
  const colMm = finitePositiveNumber(calibration.colMm);
  if (rowMm == null || colMm == null) return false;
  const unit = normalizeLengthUnit(calibration.displayUnit || series.microscopy?.physicalUnit || 'µm');
  const unitMm = lengthUnitToMm(unit);
  const xUnit = colMm / unitMm;
  const yUnit = rowMm / unitMm;
  const zMm = calibration.zKnown ? finitePositiveNumber(calibration.zMm) : null;
  const zUnit = zMm == null ? null : zMm / unitMm;
  series.pixelSpacing = [rowMm, colMm];
  series._spacingKnown = true;
  series.microscopy = series.microscopy || {};
  series.microscopy.calibrationSource = 'manual';
  series.microscopy.physicalUnit = unit;
  series.microscopy.physicalSizeX = xUnit;
  series.microscopy.physicalSizeY = yUnit;
  if (zMm != null) {
    series.sliceSpacing = zMm;
    series.sliceThickness = zMm;
    series._sliceSpacingKnown = true;
    series.microscopy.physicalSizeZ = zUnit;
  }
  for (const [name, scale] of [['x', xUnit], ['y', yUnit], ['z', zUnit]]) {
    if (scale == null) continue;
    const axis = axisByName(series.microscopyDataset, name);
    if (!axis) continue;
    axis.scale = scale;
    axis.unit = unit;
    axis.known = true;
  }
  if (series.microscopyDataset?.source) {
    const resolved = new Set([
      'missing_xy_physical_size',
      'unsupported_x_physical_unit',
      'unsupported_y_physical_unit',
      ...(zMm != null ? ['missing_z_physical_size', 'unsupported_z_physical_unit'] : []),
    ]);
    series.microscopyDataset.source.warnings = (series.microscopyDataset.source.warnings || [])
      .filter((warning) => !resolved.has(warning));
  }
  return true;
}

function stackForPosition(series, channelIndex, timeIndex, host = state) {
  const stacks = host?._localMicroscopyStacks?.[series?.slug];
  return stacks?.[`${channelIndex}|${timeIndex}`] || null;
}

function activateStackPosition(series, channelIndex, timeIndex, host = state) {
  const stack = stackForPosition(series, channelIndex, timeIndex, host);
  if (!stack) return false;
  const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === channelIndex);
  series.microscopy.channelIndex = channelIndex;
  series.microscopy.channelName = channel?.name || `Channel ${channelIndex + 1}`;
  series.microscopy.timeIndex = timeIndex;
  host._localStacks[series.slug] = stack;
  host.imgs = stack;
  host.sliceIdx = Math.max(0, Math.min(host.sliceIdx, stack.length - 1));
  return true;
}

function displayRangeStackStats(series, channelIndex, host = state) {
  const stacks = host?._localMicroscopyStacks?.[series?.slug] || {};
  let total = 0;
  let raw = 0;
  for (const [key, images] of Object.entries(stacks)) {
    const [stackChannel] = key.split('|').map(Number);
    if (stackChannel !== channelIndex || !Array.isArray(images)) continue;
    total += images.length;
    raw += images.filter((image) => finiteDisplayRange(image?._microscopyRawRange)).length;
  }
  return { total, raw };
}

function canSetDisplayRange(series, channelIndex, range, host = state) {
  const next = finiteDisplayRange(range);
  if (!next || !series?.microscopyDataset?.channels?.find((item) => Number(item?.index) === channelIndex)) return false;
  const stats = displayRangeStackStats(series, channelIndex, host);
  return stats.total > 0 && stats.raw === stats.total;
}

function setChannelDisplayColor(series, channelIndex, color) {
  const channel = series?.microscopyDataset?.channels?.find((item) => Number(item?.index) === channelIndex);
  const normalized = String(color || '').trim().toUpperCase();
  if (!channel || !/^#[0-9A-F]{6}$/.test(normalized)) return false;
  channel.displayColor = normalized;
  channel.displayColorSource = 'user';
  return true;
}

function setChannelDisplayRange(series, channelIndex, range, host = state) {
  const next = finiteDisplayRange(range);
  const channel = series?.microscopyDataset?.channels?.find((item) => Number(item?.index) === channelIndex);
  if (!channel || !next || !canSetDisplayRange(series, channelIndex, next, host)) return false;
  const updated = applyDisplayRangeToChannelStacks(host._localMicroscopyStacks?.[series.slug] || {}, channelIndex, next);
  const stats = displayRangeStackStats(series, channelIndex, host);
  if (updated !== stats.total) return false;
  channel.displayRange = next;
  channel.displayRangeSource = 'user';
  return true;
}

// Per-channel color + display-range snapshot used to roll back a partial apply.
function channelStateSnapshot(series = {}, sizeC = channelCount(series)) {
  return Array.from({ length: sizeC }, (_, index) => {
    const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === index) || {};
    const color = String(channel.displayColor || channel.color || '').toUpperCase();
    return {
      index,
      color: /^#[0-9A-F]{6}$/.test(color) ? color : '',
      displayRange: finiteDisplayRange(channel.displayRange),
    };
  });
}

function embeddedRoiResultsBundle(recipe) {
  const bundle = recipe?.roiResults;
  return bundle && typeof bundle === 'object' && Array.isArray(bundle.rows) && bundle.rows.length > 0 ? bundle : null;
}

function embeddedMeasurementRows(recipe) {
  return embeddedRoiResultsBundle(recipe)?.rows || [];
}

function embeddedAngleRows(recipe) {
  const bundle = recipe?.angleMeasurements;
  return bundle && typeof bundle === 'object' && Array.isArray(bundle.rows) ? bundle.rows : [];
}

function measurementsMeetRecipePrerequisite(recipe, series, host = state) {
  if (recipe?.requirements?.measurementPrerequisite !== 'results-present') return true;
  return measurementRows(series, host).length > 0 || embeddedMeasurementRows(recipe).length > 0 || embeddedAngleRows(recipe).length > 0;
}

function trustedMeasurementsAvailable(series, host = state, recipe = null) {
  if (!hasKnownXYCalibration(series)) return false;
  const rows = measurementRows(series, host);
  if (rows.some((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon' || entry?.kind === 'polyline' || entry?.kind === 'line')) return true;
  const bundle = embeddedRoiResultsBundle(recipe);
  return !!bundle?.calibration?.xyKnown
    && embeddedMeasurementRows(recipe).some((row) => row?.kind === 'ellipse' || row?.kind === 'polygon' || row?.kind === 'polyline' || row?.kind === 'line');
}

function embeddedRoiResultsMismatch(reason = '') {
  if (reason === 'bundle_axis_mismatch') {
    return {
      ok: false,
      code: 'roi_results_bundle_axis_mismatch',
      message: 'Recipe ROI results axes do not match this microscopy stack.',
    };
  }
  if (reason === 'bundle_calibration_mismatch') {
    return {
      ok: false,
      code: 'roi_results_bundle_calibration_mismatch',
      message: 'Recipe ROI results calibration does not match this microscopy stack.',
    };
  }
  return {
    ok: false,
    code: 'roi_results_series_mismatch',
    message: 'Recipe ROI results do not match the active microscopy series.',
  };
}

function validateChannelShape(recipe, series, host = state) {
  const expected = channelCount(series);
  const channels = Array.isArray(recipe?.channels) ? recipe.channels : [];
  if (channels.length !== expected) {
    return {
      ok: false,
      code: 'incompatible_channel_count',
      message: `Recipe expects ${channels.length} channels but this series has ${expected}.`,
    };
  }
  for (const channel of channels) {
    const index = finiteInteger(channel?.index, -1);
    if (index < 0 || index >= expected) {
      return {
        ok: false,
        code: 'invalid_channel_index',
        message: `Recipe channel index ${index} is outside this series channel range.`,
      };
    }
    const range = channel?.displayRange;
    if (range != null && !finiteDisplayRange(range)) {
      return {
        ok: false,
        code: 'invalid_display_range',
        message: `Recipe channel C${index + 1} has an invalid display range.`,
      };
    }
    if (range && !canSetDisplayRange(series, index, range, host)) {
      return {
        ok: false,
        code: 'unsupported_display_range',
        message: `Recipe channel C${index + 1} display range cannot be applied with the current stack data.`,
      };
    }
    const color = String(channel?.color || '').trim();
    if (color && !/^#[0-9A-F]{6}$/i.test(color)) {
      return {
        ok: false,
        code: 'invalid_channel_color',
        message: `Recipe channel C${index + 1} has an invalid color value.`,
      };
    }
  }
  return { ok: true, code: '', message: '' };
}

function pointFitsSeries(point, series = {}) {
  return point
    && point.x >= 0
    && point.y >= 0
    && point.x <= finitePositiveInteger(series.width, 1)
    && point.y <= finitePositiveInteger(series.height, 1);
}

function validateAngleMeasurements(recipe, series = {}) {
  const rows = embeddedAngleRows(recipe);
  if (!rows.length) return { ok: true, code: '', message: '' };
  const sizeZ = depthCount(series);
  const sizeC = channelCount(series);
  const sizeT = timeCount(series);
  for (const row of rows) {
    const points = row?.points || {};
    const sliceIndex = finiteInteger(row?.sliceIndex, -1);
    const channelIndex = finiteInteger(row?.channelIndex, -1);
    const timeIndex = finiteInteger(row?.timeIndex, -1);
    if (sliceIndex < 0 || sliceIndex >= sizeZ) {
      return { ok: false, code: 'angle_measurements_axis_mismatch', message: 'Recipe angle measurements target a Z slice outside this stack.' };
    }
    if (channelIndex < 0 || channelIndex >= sizeC) {
      return { ok: false, code: 'angle_measurements_axis_mismatch', message: 'Recipe angle measurements target a channel outside this stack.' };
    }
    if (timeIndex < 0 || timeIndex >= sizeT) {
      return { ok: false, code: 'angle_measurements_axis_mismatch', message: 'Recipe angle measurements target a timepoint outside this stack.' };
    }
    if (!Number.isFinite(Number(row?.angleDeg))
      || !pointFitsSeries(points.p1, series)
      || !pointFitsSeries(points.vertex, series)
      || !pointFitsSeries(points.p3, series)) {
      return { ok: false, code: 'angle_measurements_geometry_mismatch', message: 'Recipe angle measurement geometry does not fit this microscopy stack.' };
    }
  }
  return { ok: true, code: '', message: '' };
}

export function validateMicroscopyWorkflowRecipe(recipe, host = state) {
  const series = activeSeries(host);
  if (!recipe || typeof recipe !== 'object' || !SUPPORTED_RECIPE_SCHEMAS.has(recipe.schema)) {
    return { ok: false, code: 'invalid_recipe', message: 'Workflow recipe JSON is not a valid VoxelLab microscopy recipe.' };
  }
  if (!series || series.imageDomain !== 'microscopy') {
    return { ok: false, code: 'wrong_domain', message: 'Open a microscopy series before replaying a microscopy workflow recipe.' };
  }
  if (recipe?.target?.imageDomain !== 'microscopy') {
    return { ok: false, code: 'wrong_recipe_domain', message: 'This recipe is not marked for microscopy workflows.' };
  }
  if (!matchesSeriesShape(recipe, series)) {
    const matches = (host?.manifest?.series || []).filter((candidate) =>
      candidate?.imageDomain === 'microscopy' && matchesSeriesShape(recipe, candidate));
    if (matches.length > 1) {
      return { ok: false, code: 'ambiguous_series_match', message: 'Recipe matches multiple microscopy series. Activate one exact target series first.' };
    }
    if (matches.length === 1) {
      return { ok: false, code: 'inactive_series_mismatch', message: `Recipe matches "${matches[0].name || matches[0].slug}", not the active series.` };
    }
    return { ok: false, code: 'incompatible_dimensions', message: 'Recipe geometry/channel/time dimensions do not match the active microscopy series.' };
  }
  const effectiveSeries = seriesWithRecipeCalibration(series, recipe);
  if (recipe?.requirements?.calibrationRequired && !hasKnownXYCalibration(effectiveSeries)) {
    return { ok: false, code: 'missing_calibration', message: 'Recipe requires calibrated XY spacing, but this series is uncalibrated.' };
  }
  const embeddedBundle = embeddedRoiResultsBundle(recipe);
  if (embeddedBundle) {
    const roiCheck = validateRoiResultsBundleForSeries(embeddedBundle, effectiveSeries);
    if (!roiCheck.ok) return embeddedRoiResultsMismatch(roiCheck.reason);
    if (roiResultsBundleIncompatibleRowCount(embeddedBundle, effectiveSeries) > 0) {
      return {
        ok: false,
        code: 'roi_results_incompatible_rows',
        message: 'Recipe ROI results include rows that do not fit this microscopy stack.',
      };
    }
  }
  if (!measurementsMeetRecipePrerequisite(recipe, effectiveSeries, host)) {
    return { ok: false, code: 'missing_measurement_prerequisite', message: 'Recipe expects existing measurement rows, but none are present.' };
  }
  if (recipe?.exportPreferences?.requireTrustedMeasurements && !trustedMeasurementsAvailable(effectiveSeries, host, recipe)) {
    return { ok: false, code: 'untrusted_measurements', message: 'Recipe requires trusted calibrated measurements, but the current series does not have them.' };
  }
  const sizeC = channelCount(series);
  const sizeT = timeCount(series);
  const sizeZ = depthCount(series);
  const stack = recipe.stack || {};
  const channelIndex = finiteInteger(stack.channelIndex, -1);
  const timeIndex = finiteInteger(stack.timeIndex, -1);
  const sliceIndex = finiteInteger(recipe?.view?.sliceIndex, -1);
  if (channelIndex < 0 || channelIndex >= sizeC) {
    return { ok: false, code: 'incompatible_channel_count', message: `Recipe channel index ${channelIndex} is out of range for this series.` };
  }
  if (timeIndex < 0 || timeIndex >= sizeT) {
    return { ok: false, code: 'incompatible_time_count', message: `Recipe time index ${timeIndex} is out of range for this series.` };
  }
  if (sliceIndex < 0 || sliceIndex >= sizeZ) {
    return { ok: false, code: 'incompatible_depth', message: `Recipe Z index ${sliceIndex} is out of range for this series.` };
  }
  if (!stackForPosition(series, channelIndex, timeIndex, host)) {
    return { ok: false, code: 'missing_stack_position', message: 'Recipe stack position is unavailable for this series.' };
  }
  const compositeEnabled = !!stack.compositeEnabled;
  if (compositeEnabled && sizeC < 2) {
    return { ok: false, code: 'unsupported_mode', message: 'Recipe requires composite mode, but this series has fewer than 2 channels.' };
  }
  const compositeChannels = Array.isArray(stack.compositeChannels) ? stack.compositeChannels : [];
  if (compositeEnabled && compositeChannels.length !== sizeC) {
    return { ok: false, code: 'incompatible_channel_count', message: 'Recipe composite channel map does not match this series channel count.' };
  }
  const channelCheck = validateChannelShape(recipe, series, host);
  if (!channelCheck.ok) return channelCheck;
  const angleCheck = validateAngleMeasurements(recipe, effectiveSeries);
  if (!angleCheck.ok) return angleCheck;
  const analysisCheck = validateAnalysisOps(recipe, series, { sizeC, sizeT, sizeZ });
  if (!analysisCheck.ok) return analysisCheck;
  return { ok: true, code: '', message: '' };
}

// Fail-closed validation of the optional analysisOps log. Returns ok when absent/null.
export function validateAnalysisOps(recipe, series, dims = null) {
  const ops = recipe?.analysisOps;
  if (ops == null) return { ok: true, code: '', message: '' };
  if (!Array.isArray(ops)) {
    return { ok: false, code: 'invalid_analysis_ops', message: 'Recipe analysis operations are malformed.' };
  }
  const sizeC = dims?.sizeC ?? channelCount(series);
  const sizeT = dims?.sizeT ?? timeCount(series);
  const sizeZ = dims?.sizeZ ?? depthCount(series);
  for (const op of ops) {
    if (!op || !['analyze-particles', 'line-profile', 'pixelwise-colocalization'].includes(op.op)) {
      return { ok: false, code: 'unknown_analysis_op', message: 'Recipe contains an unsupported analysis operation.' };
    }
    const { z, t } = op.inputs || {};
    if (!(finiteInteger(t, -1) >= 0 && finiteInteger(t, -1) < sizeT)
      || !(finiteInteger(z, -1) >= 0 && finiteInteger(z, -1) < sizeZ)) {
      return { ok: false, code: 'analysis_op_axis_mismatch', message: 'Recipe analysis operation targets a position outside this stack.' };
    }
    if (op.op === 'analyze-particles' && !(finiteInteger(op.inputs?.c, -1) >= 0 && finiteInteger(op.inputs?.c, -1) < sizeC)) {
      return { ok: false, code: 'analysis_op_axis_mismatch', message: 'Recipe analysis operation targets a position outside this stack.' };
    }
    if (op.op === 'analyze-particles' && !Number.isFinite(Number(op.params?.threshold?.resolvedValue))) {
      return { ok: false, code: 'unresolved_threshold_value', message: 'Recipe analysis operation has no resolved threshold value.' };
    }
    if (op.op === 'line-profile') {
      if (!(finiteInteger(op.inputs?.c, -1) >= 0 && finiteInteger(op.inputs?.c, -1) < sizeC)) {
        return { ok: false, code: 'analysis_op_axis_mismatch', message: 'Recipe analysis operation targets a position outside this stack.' };
      }
      const line = op.params?.line || {};
      const values = [line.x1, line.y1, line.x2, line.y2].map(Number);
      if (op.params?.sampling !== 'nearest' && op.params?.sampling !== 'bilinear') {
        return { ok: false, code: 'invalid_analysis_profile', message: 'Recipe line profile has an unsupported sampling method.' };
      }
      if (!values.every(Number.isFinite) || Math.hypot(values[2] - values[0], values[3] - values[1]) <= 0) {
        return { ok: false, code: 'invalid_analysis_profile', message: 'Recipe line profile has invalid line geometry.' };
      }
    }
    if (op.op === 'pixelwise-colocalization') {
      const cA = finiteInteger(op.inputs?.cA, -1);
      const cB = finiteInteger(op.inputs?.cB, -1);
      if (cA < 0 || cA >= sizeC || cB < 0 || cB >= sizeC || cA === cB) {
        return { ok: false, code: 'analysis_op_axis_mismatch', message: 'Recipe colocalization operation targets invalid channels.' };
      }
      const thresholds = [op.params?.thresholdA, op.params?.thresholdB].map(Number);
      if (!thresholds.every(value => Number.isFinite(value) && value >= 0) || op.params?.roiMask != null) {
        return { ok: false, code: 'invalid_analysis_colocalization', message: 'Recipe colocalization thresholds or mask are invalid.' };
      }
    }
  }
  return { ok: true, code: '', message: '' };
}

function applyEmbeddedRoiResults(recipe, series, host = state) {
  const bundle = embeddedRoiResultsBundle(recipe);
  if (!bundle) return { ok: true, code: '', message: '' };
  const result = importRoiResultsBundle(bundle, host);
  const expectedIds = new Set(bundle.rows.map((row) => row?.roiObjectId).filter(Boolean));
  const liveIds = new Set(roiResultRows(host, series).map((row) => row.objectId));
  const alreadyPresent = expectedIds.size > 0 && [...expectedIds].every((id) => liveIds.has(id));
  if (result.ok || (result.reason === 'no_importable_rois' && alreadyPresent)) {
    return { ok: true, code: '', message: '' };
  }
  return {
    ok: false,
    code: result.reason || 'roi_results_replay_failed',
    message: 'Workflow recipe ROI results could not be replayed for the active microscopy series.',
  };
}

function applyEmbeddedAngleMeasurements(recipe, series, host = state) {
  const rows = embeddedAngleRows(recipe);
  if (!rows.length) return { ok: true, code: '', message: '' };
  const bySlice = new Map();
  for (const row of rows) {
    const sliceIndex = finiteInteger(row?.sliceIndex, 0);
    if (!bySlice.has(sliceIndex)) bySlice.set(sliceIndex, []);
    bySlice.get(sliceIndex).push(row);
  }
  for (const [sliceIndex, sliceRows] of bySlice.entries()) {
    const live = angleEntriesForSlice(host, series, sliceIndex).map((entry) => ({ ...entry }));
    const scopedId = (value) => {
      const text = String(value || '');
      const separator = text.lastIndexOf('|');
      return separator >= 0 ? text.slice(separator + 1) : '';
    };
    const sameNumber = (left, right) => Math.abs(Number(left) - Number(right)) <= 1e-6;
    const samePoint = (left, right) => left && right
      && sameNumber(left.x, right.x)
      && sameNumber(left.y, right.y);
    const matchesRow = (entry, row) => {
      const points = row?.points || {};
      const microscopy = entry?.microscopy || {};
      return String(entry?.label || '').trim() === String(row?.label || '').trim()
        && sameNumber(entry?.deg, row?.angleDeg)
        && samePoint(entry?.p1, points.p1)
        && samePoint(entry?.vertex, points.vertex)
        && samePoint(entry?.p3, points.p3)
        && finiteInteger(microscopy.channelIndex, 0) === finiteInteger(row?.channelIndex, 0)
        && finiteInteger(microscopy.timeIndex, 0) === finiteInteger(row?.timeIndex, 0);
    };
    const next = live.slice();
    for (const row of sliceRows) {
      const objectId = String(row?.angleObjectId || '');
      const localObjectId = scopedId(objectId);
      const alreadyPresent = objectId && next.some((entry, index) => {
        const liveIds = [entry.recipeAngleObjectId, angleObjectId(series, sliceIndex, entry, index)].filter(Boolean);
        if (liveIds.includes(objectId)) return true;
        return localObjectId
          && liveIds.some(value => scopedId(value) === localObjectId)
          && matchesRow(entry, row);
      });
      if (alreadyPresent) continue;
      const points = row.points || {};
      next.push({
        id: nextDrawingEntryId(next),
        label: String(row.label || '').trim(),
        p1: cleanPoint(points.p1),
        vertex: cleanPoint(points.vertex),
        p3: cleanPoint(points.p3),
        deg: Number(row.angleDeg),
        microscopy: {
          channelIndex: finiteInteger(row.channelIndex, 0),
          channelName: String(row.channelName || channelNameForIndex(series, finiteInteger(row.channelIndex, 0))),
          timeIndex: finiteInteger(row.timeIndex, 0),
        },
        createdAt: row.createdAt || new Date().toISOString(),
        recipeAngleObjectId: objectId,
        source: 'VoxelLab microscopy workflow recipe',
      });
    }
    setAngleEntriesForSlice(host, series, sliceIndex, next);
  }
  return { ok: true, code: '', message: '' };
}

export function applyMicroscopyWorkflowRecipe(recipe, host = state) {
  const check = validateMicroscopyWorkflowRecipe(recipe, host);
  if (!check.ok) return check;
  const series = activeSeries(host);
  const stack = recipe.stack || {};
  const channelIndex = finiteInteger(stack.channelIndex, 0);
  const timeIndex = finiteInteger(stack.timeIndex, 0);
  const sliceIndex = finiteInteger(recipe?.view?.sliceIndex, 0);
  const channels = Array.isArray(recipe.channels) ? recipe.channels : [];
  const compositeEnabled = !!stack.compositeEnabled;
  const sizeC = channelCount(series);
  const previousComposite = ensureMicroscopyComposite(series, sizeC);
  const previous = {
    window: host.window,
    level: host.level,
    invertDisplay: host.invertDisplay,
    colormap: host.colormap,
    sliceIdx: host.sliceIdx,
    channelIndex: series.microscopy?.channelIndex || 0,
    timeIndex: series.microscopy?.timeIndex || 0,
    calibration: calibrationSnapshot(series),
    composite: {
      ...previousComposite,
      channels: previousComposite.channels.slice(),
    },
    channels: channelStateSnapshot(series, sizeC),
    analysisLog: cloneJson(host?._microscopyAnalysisLog || {}),
    analysisResults: cloneJson(host?._microscopyAnalysisResults || {}),
  };
  const createdAnalysis = [];
  const rollback = () => {
    restoreCalibrationSnapshot(series, previous.calibration);
    setWindowLevel(previous.window, previous.level);
    setColormap(previous.colormap);
    host.invertDisplay = !!previous.invertDisplay;
    activateStackPosition(series, previous.channelIndex, previous.timeIndex, host);
    host.sliceIdx = Math.max(0, previous.sliceIdx);
    setMicroscopyCompositeEnabled(series, !!previous.composite.enabled, sizeC);
    for (let i = 0; i < previous.composite.channels.length; i += 1) {
      const nextEnabled = previous.composite.channels[i] !== false;
      const currentEnabled = series.microscopy?.composite?.channels?.[i] !== false;
      if (currentEnabled === nextEnabled) continue;
      setMicroscopyCompositeChannelEnabled(series, i, nextEnabled, sizeC);
    }
    for (const channel of previous.channels) {
      if (channel.color) setChannelDisplayColor(series, channel.index, channel.color);
      if (channel.displayRange) setChannelDisplayRange(series, channel.index, channel.displayRange, host);
    }
    for (const { sliceIdx, ids } of createdAnalysis) {
      const kept = roiEntriesForSlice(host, series, sliceIdx).filter((entry) => !ids.has(entry.importedObjectId));
      setRoiEntriesForSlice(host, series, sliceIdx, kept);
    }
    host._microscopyAnalysisLog = previous.analysisLog;
    host._microscopyAnalysisResults = previous.analysisResults;
  };
  try {
    applyRecipeCalibration(series, recipe);
    setWindowLevel(Number(recipe.view?.window || host.window), Number(recipe.view?.level || host.level));
    setColormap(String(recipe.view?.colormap || 'grayscale'));
    host.invertDisplay = !!recipe.view?.invertDisplay;
    if (!activateStackPosition(series, channelIndex, timeIndex, host)) {
      throw new Error('missing_stack_position');
    }
    host.sliceIdx = Math.max(0, Math.min(depthCount(series) - 1, sliceIndex));
    setMicroscopyCompositeEnabled(series, compositeEnabled, sizeC);
    if (compositeEnabled) {
      const desired = Array.isArray(stack.compositeChannels) ? stack.compositeChannels : [];
      for (let i = 0; i < sizeC; i += 1) {
        const nextEnabled = desired[i] !== false;
        const currentEnabled = series.microscopy?.composite?.channels?.[i] !== false;
        if (currentEnabled === nextEnabled) continue;
        if (!setMicroscopyCompositeChannelEnabled(series, i, nextEnabled, sizeC)) {
          throw new Error('unsupported_mode');
        }
      }
    }
    for (const channel of channels) {
      if (channel.color && !setChannelDisplayColor(series, channel.index, channel.color)) {
        throw new Error('invalid_channel_color');
      }
      const range = finiteDisplayRange(channel.displayRange);
      if (range && !setChannelDisplayRange(series, channel.index, range, host)) {
        throw new Error('unsupported_display_range');
      }
    }
    const embeddedResults = applyEmbeddedRoiResults(recipe, series, host);
    if (!embeddedResults.ok) throw new Error(embeddedResults.code || 'roi_results_replay_failed');
    const embeddedAngles = applyEmbeddedAngleMeasurements(recipe, series, host);
    if (!embeddedAngles.ok) throw new Error(embeddedAngles.code || 'angle_measurements_replay_failed');
    const analysisOps = Array.isArray(recipe.analysisOps) ? recipe.analysisOps : [];
    for (const descriptor of analysisOps) {
      const createsRoiEntries = descriptor?.op === 'analyze-particles';
      const expected = new Set(descriptor?.outputRoiObjectIds || []);
      const liveIds = new Set(roiResultRows(host, series).map((row) => row.objectId));
      if (createsRoiEntries && expected.size > 0 && [...expected].every((id) => liveIds.has(id))) continue; // idempotent re-apply
      const res = replayAnalysisOp(host, series, descriptor);
      if (!res?.ok) throw new Error('analysis_op_replay_failed');
      if (createsRoiEntries) {
        createdAnalysis.push({ sliceIdx: finiteInteger(descriptor?.inputs?.z, 0), ids: new Set(res.objectIds || []) });
      }
    }
    const analysisIdentity = seriesPersistenceKey(series, host?.manifest || {});
    if (analysisOps.length && analysisIdentity) {
      if (!host._microscopyAnalysisLog) host._microscopyAnalysisLog = {};
      host._microscopyAnalysisLog[analysisIdentity] = analysisOps.slice();
    }
    return { ok: true, code: '', message: '' };
  } catch (error) {
    rollback();
    return {
      ok: false,
      code: error?.message || 'recipe_apply_failed',
      message: 'Workflow recipe could not be applied safely; active state was left unchanged.',
    };
  }
}
