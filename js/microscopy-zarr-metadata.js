function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed;
}

function axisTypeFromName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower === 't') return 'time';
  if (lower === 'c') return 'channel';
  if (lower === 'x' || lower === 'y' || lower === 'z') return 'space';
  return 'custom';
}

function normalizeAxis(rawAxis, index, errors, warnings) {
  const fallbackName = `axis_${index}`;
  if (typeof rawAxis === 'string') {
    const name = nonEmptyString(rawAxis) || fallbackName;
    warnings.push(`axes_${name}_string_form`);
    return {
      name,
      type: axisTypeFromName(name),
      size: 1,
      unit: '',
      known: false,
      scale: 0,
      translation: 0,
    };
  }

  if (!isObject(rawAxis)) {
    errors.push(`axes_${index}_invalid`);
    return {
      name: fallbackName,
      type: 'custom',
      size: 1,
      unit: '',
      known: false,
      scale: 0,
      translation: 0,
    };
  }

  const name = nonEmptyString(rawAxis.name) || fallbackName;
  const type = nonEmptyString(rawAxis.type).toLowerCase() || axisTypeFromName(name);
  const unit = nonEmptyString(rawAxis.unit);
  if (!nonEmptyString(rawAxis.type)) warnings.push(`axes_${name}_missing_type`);

  return {
    name,
    type,
    size: 1,
    unit,
    known: false,
    scale: 0,
    translation: 0,
  };
}

function validateAxisNames(axes, errors) {
  const seen = new Set();
  for (const axis of axes) {
    if (seen.has(axis.name)) errors.push(`axes_duplicate_name_${axis.name}`);
    seen.add(axis.name);
  }
}

function validateAxisLayout(axes, errors, warnings) {
  // https://ngff.openmicroscopy.org/0.5/index.html#2-4-multiscales-metadata
  if (axes.length < 2 || axes.length > 5) errors.push('axes_length_out_of_range');

  const spaceCount = axes.filter((axis) => axis.type === 'space').length;
  if (spaceCount < 2 || spaceCount > 3) errors.push('axes_space_count_invalid');

  let seenNonTime = false;
  let seenSpace = false;
  for (const axis of axes) {
    if (axis.type !== 'time') seenNonTime = true;
    if (axis.type === 'time' && seenNonTime) errors.push('axes_time_order_invalid');

    if (axis.type === 'space') seenSpace = true;
    if ((axis.type === 'channel' || axis.type === 'custom' || axis.type === '') && seenSpace) {
      errors.push('axes_channel_or_custom_order_invalid');
    }
  }

  const spatialAxisNames = axes.filter((axis) => axis.type === 'space').map((axis) => axis.name.toLowerCase());
  if (spaceCount === 3 && spatialAxisNames.join('') !== 'zyx') warnings.push('axes_spatial_order_not_zyx');
}

function toNumberVector(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) return null;
  const numbers = value.map((item) => Number(item));
  return numbers.every(Number.isFinite) ? numbers : null;
}

function normalizeTransformList(rawTransforms, axisCount, label, errors, warnings, { requireScale = true } = {}) {
  if (!Array.isArray(rawTransforms)) {
    errors.push(`${label}_coordinate_transformations_missing`);
    return { scale: null, translation: null, steps: [] };
  }

  let scaleVector = null;
  let translationVector = null;
  let scaleSeen = 0;
  let translationSeen = 0;
  const steps = [];

  for (let i = 0; i < rawTransforms.length; i += 1) {
    const item = rawTransforms[i];
    if (!isObject(item)) {
      errors.push(`${label}_transform_${i}_invalid`);
      continue;
    }
    const type = nonEmptyString(item.type).toLowerCase();
    if (type !== 'scale' && type !== 'translation') {
      errors.push(`${label}_transform_${i}_type_invalid`);
      continue;
    }

    if (type === 'scale') {
      scaleSeen += 1;
      const vec = toNumberVector(item.scale, axisCount);
      if (vec) {
        scaleVector = vec;
      } else if (nonEmptyString(item.path)) {
        warnings.push(`${label}_scale_path_unresolved`);
      } else {
        errors.push(`${label}_scale_vector_invalid`);
      }
      steps.push({ type: 'scale', values: vec || null, path: nonEmptyString(item.path) || null });
      continue;
    }

    translationSeen += 1;
    const vec = toNumberVector(item.translation, axisCount);
    if (vec) {
      translationVector = vec;
    } else if (nonEmptyString(item.path)) {
      warnings.push(`${label}_translation_path_unresolved`);
    } else {
      errors.push(`${label}_translation_vector_invalid`);
    }

    if (scaleSeen === 0) {
      // https://ngff.openmicroscopy.org/0.5/index.html#2-4-multiscales-metadata
      errors.push(`${label}_translation_before_scale`);
    }

    steps.push({ type: 'translation', values: vec || null, path: nonEmptyString(item.path) || null });
  }

  if (requireScale && scaleSeen !== 1) {
    // https://ngff.openmicroscopy.org/0.5/index.html#2-4-multiscales-metadata
    errors.push(`${label}_scale_count_invalid`);
  }
  if (translationSeen > 1) errors.push(`${label}_translation_count_invalid`);

  return { scale: scaleVector, translation: translationVector, steps };
}

function normalizeDatasets(datasetsRaw, axisCount, errors, warnings) {
  if (!Array.isArray(datasetsRaw) || datasetsRaw.length === 0) {
    errors.push('datasets_missing');
    return [];
  }

  return datasetsRaw.map((dataset, index) => {
    const label = `dataset_${index}`;
    if (!isObject(dataset)) {
      errors.push(`${label}_invalid`);
      return {
        level: index,
        path: '',
        scale: null,
        translation: null,
        coordinateTransformations: [],
      };
    }

    const path = nonEmptyString(dataset.path);
    if (!path) errors.push(`${label}_path_missing`);

    const transforms = normalizeTransformList(
      dataset.coordinateTransformations,
      axisCount,
      label,
      errors,
      warnings,
      { requireScale: true },
    );

    return {
      level: index,
      path,
      scale: transforms.scale,
      translation: transforms.translation,
      coordinateTransformations: transforms.steps,
    };
  });
}

function normalizeHexColor(value) {
  const raw = nonEmptyString(value).replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(raw) ? `#${raw}` : null;
}

function finiteWindowPair(window, keys) {
  const values = keys.map((key) => Number(window?.[key]));
  return values.every(Number.isFinite) ? values : null;
}

function normalizeChannels(omero, expectedCount, errors, warnings) {
  const fallbackCount = Math.max(1, Number.isFinite(expectedCount) ? expectedCount : 1);
  if (!isObject(omero)) {
    return Array.from({ length: fallbackCount }, (_, index) => ({
      index,
      name: `Channel ${index + 1}`,
      color: null,
      lut: 'gray',
      emissionWavelength: null,
      dataRange: null,
      displayRange: null,
    }));
  }

  if (!Array.isArray(omero.channels)) {
    // https://ngff.openmicroscopy.org/0.5/index.html#2-5-omero-metadata-transitional
    errors.push('omero_channels_missing');
    return Array.from({ length: fallbackCount }, (_, index) => ({
      index,
      name: `Channel ${index + 1}`,
      color: null,
      lut: 'gray',
      emissionWavelength: null,
      dataRange: null,
      displayRange: null,
    }));
  }

  const channels = omero.channels.map((rawChannel, index) => {
    if (!isObject(rawChannel)) {
      errors.push(`omero_channel_${index}_invalid`);
      return {
        index,
        name: `Channel ${index + 1}`,
        color: null,
        lut: 'gray',
        emissionWavelength: null,
        dataRange: null,
        displayRange: null,
      };
    }

    const color = normalizeHexColor(rawChannel.color);
    if (!color) errors.push(`omero_channel_${index}_color_invalid`);

    const window = isObject(rawChannel.window) ? rawChannel.window : null;
    if (!window) {
      // https://ngff.openmicroscopy.org/0.5/index.html#2-5-omero-metadata-transitional
      errors.push(`omero_channel_${index}_window_missing`);
    }

    // OME-Zarr 0.5 OMERO metadata defines min/max as data bounds and start/end
    // as the rendering window: https://ngff.openmicroscopy.org/0.5/#2-5-omero-metadata-transitional
    const dataRange = finiteWindowPair(window, ['min', 'max']);
    const displayRange = finiteWindowPair(window, ['start', 'end']) || dataRange;
    if (window && !dataRange) errors.push(`omero_channel_${index}_window_minmax_invalid`);
    if (window && !finiteWindowPair(window, ['start', 'end'])) {
      errors.push(`omero_channel_${index}_window_startend_invalid`);
    }

    return {
      index,
      name: nonEmptyString(rawChannel.label) || `Channel ${index + 1}`,
      color,
      lut: nonEmptyString(rawChannel.family) || 'gray',
      emissionWavelength: null,
      dataRange,
      displayRange,
    };
  });

  if (expectedCount > 0 && channels.length !== expectedCount) warnings.push('omero_channel_count_mismatch');
  return channels;
}

function pixelTypeFromDtypeString(dtype) {
  const token = nonEmptyString(dtype);
  if (!token) return null;

  const direct = token.toLowerCase();
  if (/^(u?int|float)[0-9]+$/.test(direct)) return direct;

  const canonical = token.replace(/^[<>|]/, '').toLowerCase();
  const match = canonical.match(/^([ui])([1248])$/);
  if (match) {
    const bits = Number(match[2]) * 8;
    return `${match[1] === 'u' ? 'u' : ''}int${bits}`;
  }
  const fMatch = canonical.match(/^f([248])$/);
  if (fMatch) {
    const bits = Number(fMatch[1]) * 8;
    return `float${bits}`;
  }
  return null;
}

function discoverPixelType(levels, arrayMetadataByPath) {
  if (!isObject(arrayMetadataByPath) || levels.length === 0) return null;
  const firstPath = levels[0]?.path;
  if (!firstPath) return null;
  const meta = arrayMetadataByPath[firstPath];
  if (!isObject(meta)) return null;

  return pixelTypeFromDtypeString(meta.data_type)
    || pixelTypeFromDtypeString(meta.dtype)
    || null;
}

function levelZeroArrayMeta(levels, arrayMetadataByPath) {
  if (!isObject(arrayMetadataByPath) || levels.length === 0) return null;
  const firstPath = levels[0]?.path;
  if (!firstPath) return null;
  const meta = arrayMetadataByPath[firstPath];
  return isObject(meta) ? meta : null;
}

function normalizeShape(rawShape) {
  if (!Array.isArray(rawShape)) return null;
  const shape = rawShape.map((value) => Math.floor(Number(value)));
  return shape.every((value) => Number.isFinite(value) && value > 0) ? shape : null;
}

function rootOmeAttributes(input) {
  if (!isObject(input)) return {};
  if (isObject(input.ome)) return input.ome;
  if (isObject(input.attributes?.ome)) return input.attributes.ome;
  return input;
}

export function normalizeOmeZarrMetadata(input = {}, { arrayMetadataByPath = null } = {}) {
  const errors = [];
  const warnings = [];

  const ome = rootOmeAttributes(input);
  const multiscales = Array.isArray(ome.multiscales) ? ome.multiscales : null;
  if (!multiscales?.length) {
    const omeVersion = nonEmptyString(ome.version);
    if (!omeVersion) warnings.push('ome_version_missing');
    if (omeVersion && !/^0\.(4|5)(\..*)?$/.test(omeVersion)) warnings.push('ome_version_unrecognized');
    errors.push('multiscales_missing');
    return {
      source: {
        kind: 'ome-zarr',
        path: '',
        originalFormat: 'OME-Zarr',
        converter: null,
        converterVersion: null,
        checksum: '',
        warnings,
      },
      axes: [],
      pixel: { type: 'unknown', samplesPerPixel: 1, endianness: 'unknown', min: null, max: null },
      channels: [],
      levels: [],
      errors,
      warnings,
    };
  }

  if (multiscales.length > 1) warnings.push('multiscales_multiple_entries_first_selected');
  const selected = isObject(multiscales[0]) ? multiscales[0] : {};
  const omeVersion = nonEmptyString(ome.version) || nonEmptyString(selected.version);
  if (!omeVersion) warnings.push('ome_version_missing');
  if (omeVersion && !/^0\.(4|5)(\..*)?$/.test(omeVersion)) warnings.push('ome_version_unrecognized');

  const axesRaw = Array.isArray(selected.axes) ? selected.axes : [];
  if (axesRaw.length === 0) errors.push('axes_missing');

  const axes = axesRaw.map((axis, index) => normalizeAxis(axis, index, errors, warnings));
  validateAxisNames(axes, errors);
  validateAxisLayout(axes, errors, warnings);

  const datasets = normalizeDatasets(selected.datasets, axes.length, errors, warnings);

  const msTransforms = selected.coordinateTransformations
    ? normalizeTransformList(
      selected.coordinateTransformations,
      axes.length,
      'multiscales',
      errors,
      warnings,
      { requireScale: true },
    )
    : { scale: null, translation: null, steps: [] };

  const levelZeroScale = datasets[0]?.scale;
  const levelZeroTranslation = datasets[0]?.translation;
  const levelZeroMeta = levelZeroArrayMeta(datasets, arrayMetadataByPath);
  const levelZeroShape = normalizeShape(levelZeroMeta?.shape);
  const levelZeroDimensionNames = Array.isArray(levelZeroMeta?.dimension_names)
    ? levelZeroMeta.dimension_names.map((name) => nonEmptyString(name))
    : null;

  if (levelZeroShape && levelZeroShape.length !== axes.length) {
    // https://ngff.openmicroscopy.org/0.5/index.html#2-1-axes-metadata
    errors.push('axes_dimension_count_mismatch');
  }

  if (levelZeroDimensionNames && levelZeroDimensionNames.length === axes.length) {
    for (let i = 0; i < axes.length; i += 1) {
      if (levelZeroDimensionNames[i] && levelZeroDimensionNames[i] !== axes[i].name) {
        // https://ngff.openmicroscopy.org/0.5/index.html#2-1-axes-metadata
        errors.push(`axes_dimension_name_mismatch_${axes[i].name}`);
      }
    }
  }

  for (let i = 0; i < axes.length; i += 1) {
    const axis = axes[i];
    const datasetScale = levelZeroScale?.[i];
    const multiscaleScale = msTransforms.scale?.[i];
    const datasetTranslation = levelZeroTranslation?.[i];
    const multiscaleTranslation = msTransforms.translation?.[i];

    const scaleValue = Number(datasetScale) * Number(multiscaleScale || 1);
    axis.scale = Number.isFinite(scaleValue) && scaleValue > 0 ? scaleValue : 0;

    const translationValue = (Number.isFinite(datasetTranslation) ? datasetTranslation : 0)
      + (Number.isFinite(multiscaleTranslation) ? multiscaleTranslation : 0);
    axis.translation = Number.isFinite(translationValue) ? translationValue : 0;
    axis.known = axis.scale > 0;
    axis.size = levelZeroShape?.[i] > 0 ? levelZeroShape[i] : 1;
  }

  const channelAxis = axes.find((axis) => axis.type === 'channel');
  const channelCount = channelAxis ? Math.max(1, Math.floor(channelAxis.size || 1)) : 1;
  if (channelAxis && channelAxis.scale === 0) {
    // Channel-axis scale is commonly unitless; zero here means unresolved transform scale.
    channelAxis.known = false;
  }

  if (isObject(ome.omero)) warnings.push('omero_transitional_metadata');
  const channels = normalizeChannels(ome.omero, channelCount, errors, warnings);

  const pixelType = discoverPixelType(datasets, arrayMetadataByPath) || 'unknown';
  if (pixelType === 'unknown') warnings.push('pixel_type_unresolved');

  const normalized = {
    source: {
      kind: 'ome-zarr',
      path: '',
      originalFormat: 'OME-Zarr',
      converter: null,
      converterVersion: null,
      checksum: '',
      warnings,
    },
    axes,
    pixel: {
      type: pixelType,
      samplesPerPixel: 1,
      endianness: 'unknown',
      min: null,
      max: null,
    },
    channels,
    levels: datasets,
    multiscales: {
      version: omeVersion || null,
      name: nonEmptyString(selected.name) || null,
      type: nonEmptyString(selected.type) || null,
      metadata: isObject(selected.metadata) ? selected.metadata : null,
    },
    errors,
    warnings,
  };

  return normalized;
}
