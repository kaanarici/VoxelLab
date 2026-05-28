import { state } from './state.js';
import { applyDisplayRangeToChannelStacks, finiteDisplayRange } from './microscopy-display-range.js';
import { setColormap, setWindowLevel } from './state/viewer-commands.js';
import { ensureMicroscopyComposite, setMicroscopyCompositeChannelEnabled, setMicroscopyCompositeEnabled } from './microscopy-channel-composite.js';
import { drawingEntriesForSeries } from './annotation-graph.js';

export const MICROSCOPY_WORKFLOW_RECIPE_SCHEMA = 'voxellab.microscopyWorkflowRecipe.v1';

function finitePositiveInteger(value, fallback = 1) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteInteger(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function finiteRange(range) {
  return finiteDisplayRange(range);
}

function channelCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 'c')?.size
      ?? series.microscopy?.sizeC
      ?? series.microscopyDataset?.channels?.length
      ?? 1,
    1,
  );
}

function timeCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 't')?.size
      ?? series.microscopy?.sizeT
      ?? 1,
    1,
  );
}

function depthCount(series = {}) {
  return finitePositiveInteger(
    series.microscopyDataset?.axes?.find((axis) => axis?.name === 'z')?.size
      ?? series.microscopy?.sizeZ
      ?? series.slices
      ?? 1,
    1,
  );
}

function hasKnownXYCalibration(series = {}) {
  const spacing = Array.isArray(series.pixelSpacing) ? series.pixelSpacing : [];
  return spacing.length >= 2 && Number(spacing[0]) > 0 && Number(spacing[1]) > 0 && series._spacingKnown !== false;
}

function measurementRows(series, host = state) {
  return drawingEntriesForSeries(host, series?.slug || '')
    .filter((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon' || entry?.kind === 'point' || entry?.kind === 'line');
}

function channelRecipeState(series = {}) {
  const count = channelCount(series);
  return Array.from({ length: count }, (_, index) => {
    const channel = series.microscopyDataset?.channels?.find((item) => Number(item?.index) === index) || {};
    const color = String(channel.displayColor || channel.color || '').toUpperCase();
    return {
      index,
      name: channel.name || `Channel ${index + 1}`,
      color: /^#[0-9A-F]{6}$/.test(color) ? color : '',
      displayRange: finiteRange(channel.displayRange),
      displayRangeSource: channel.displayRangeSource || '',
    };
  });
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
  const seriesFormat = String(series.microscopyDataset?.source?.originalFormat || series.sequence || '').trim();
  if (recipeFormat && seriesFormat && recipeFormat !== seriesFormat) return false;
  return true;
}

function activeSeries(host = state) {
  return host?.manifest?.series?.[host.seriesIdx] || null;
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
    raw += images.filter((image) => finiteRange(image?._microscopyRawRange)).length;
  }
  return { total, raw };
}

function canSetDisplayRange(series, channelIndex, range, host = state) {
  const next = finiteRange(range);
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
  const next = finiteRange(range);
  const channel = series?.microscopyDataset?.channels?.find((item) => Number(item?.index) === channelIndex);
  if (!channel || !next || !canSetDisplayRange(series, channelIndex, next, host)) return false;
  const updated = applyDisplayRangeToChannelStacks(host._localMicroscopyStacks?.[series.slug] || {}, channelIndex, next);
  const stats = displayRangeStackStats(series, channelIndex, host);
  if (updated !== stats.total) return false;
  channel.displayRange = next;
  channel.displayRangeSource = 'user';
  return true;
}

export function captureMicroscopyWorkflowRecipe(host = state) {
  const series = activeSeries(host);
  if (!series || series.imageDomain !== 'microscopy') return null;
  const measurements = measurementRows(series, host);
  const requiresTrusted = measurements.some((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon');
  const countC = channelCount(series);
  const currentC = Math.max(0, Math.min(countC - 1, finiteInteger(series.microscopy?.channelIndex, 0)));
  const currentT = Math.max(0, Math.min(timeCount(series) - 1, finiteInteger(series.microscopy?.timeIndex, 0)));
  const composite = ensureMicroscopyComposite(series, countC);
  return {
    schema: MICROSCOPY_WORKFLOW_RECIPE_SCHEMA,
    kind: 'microscopy-workflow-recipe',
    createdAt: new Date().toISOString(),
    target: {
      imageDomain: 'microscopy',
      slug: series.slug || '',
      name: series.name || series.slug || '',
      sourceFormat: series.microscopyDataset?.source?.originalFormat || series.sequence || '',
      geometry: {
        width: finitePositiveInteger(series.width, 1),
        height: finitePositiveInteger(series.height, 1),
        slices: finitePositiveInteger(series.slices, 1),
        sizeZ: depthCount(series),
        sizeC: countC,
        sizeT: timeCount(series),
      },
    },
    requirements: {
      calibrationRequired: hasKnownXYCalibration(series),
      measurementPrerequisite: measurements.length > 0 ? 'results-present' : 'none',
    },
    view: {
      window: Number(host.window),
      level: Number(host.level),
      invertDisplay: !!host.invertDisplay,
      colormap: String(host.colormap || 'grayscale'),
      sliceIndex: Math.max(0, finiteInteger(host.sliceIdx, 0)),
    },
    stack: {
      channelIndex: currentC,
      timeIndex: currentT,
      compositeEnabled: !!composite.enabled,
      compositeChannels: Array.from({ length: countC }, (_, index) => composite.channels[index] !== false),
    },
    channels: channelRecipeState(series),
    exportPreferences: {
      csv: true,
      jsonBundle: true,
      overlayPng: true,
      requireTrustedMeasurements: requiresTrusted,
    },
  };
}

function measurementsMeetRecipePrerequisite(recipe, series, host = state) {
  if (recipe?.requirements?.measurementPrerequisite !== 'results-present') return true;
  return measurementRows(series, host).length > 0;
}

function trustedMeasurementsAvailable(series, host = state) {
  if (!hasKnownXYCalibration(series)) return false;
  const rows = measurementRows(series, host);
  return rows.some((entry) => entry?.kind === 'ellipse' || entry?.kind === 'polygon' || entry?.kind === 'line');
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
    if (range != null && !finiteRange(range)) {
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

export function validateMicroscopyWorkflowRecipe(recipe, host = state) {
  const series = activeSeries(host);
  if (!recipe || typeof recipe !== 'object' || recipe.schema !== MICROSCOPY_WORKFLOW_RECIPE_SCHEMA) {
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
  if (recipe?.requirements?.calibrationRequired && !hasKnownXYCalibration(series)) {
    return { ok: false, code: 'missing_calibration', message: 'Recipe requires calibrated XY spacing, but this series is uncalibrated.' };
  }
  if (!measurementsMeetRecipePrerequisite(recipe, series, host)) {
    return { ok: false, code: 'missing_measurement_prerequisite', message: 'Recipe expects existing measurement rows, but none are present.' };
  }
  if (recipe?.exportPreferences?.requireTrustedMeasurements && !trustedMeasurementsAvailable(series, host)) {
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
  const previous = {
    window: host.window,
    level: host.level,
    invertDisplay: host.invertDisplay,
    colormap: host.colormap,
    sliceIdx: host.sliceIdx,
    channelIndex: series.microscopy?.channelIndex || 0,
    timeIndex: series.microscopy?.timeIndex || 0,
    composite: {
      ...ensureMicroscopyComposite(series, sizeC),
      channels: ensureMicroscopyComposite(series, sizeC).channels.slice(),
    },
    channels: channelRecipeState(series),
  };
  const rollback = () => {
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
  };
  try {
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
      const range = finiteRange(channel.displayRange);
      if (range && !setChannelDisplayRange(series, channel.index, range, host)) {
        throw new Error('unsupported_display_range');
      }
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
