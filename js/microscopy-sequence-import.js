const TIFF_EXT_RE = /\.(?:tif|tiff)$/i;

function basename(value = '') {
  const text = String(value || '');
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function dirname(value = '') {
  const text = String(value || '');
  const idx = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  return idx >= 0 ? text.slice(0, idx) : '';
}

function stemAndSuffix(fileName) {
  const stem = String(fileName || '').replace(/\.[^.]+$/, '');
  const match = stem.match(/^(.*?)(\d+)$/);
  if (!match) {
    const lexicalGroupStem = stem.replace(/[\s._-]*[A-Za-z]+$/g, '').replace(/[\s._-]+$/g, '') || stem;
    return { stem, groupStem: lexicalGroupStem, suffix: null };
  }
  const groupStem = match[1].replace(/[\s._-]+$/g, '') || match[1] || stem;
  return {
    stem,
    groupStem,
    suffix: {
      text: match[2],
      value: Number.parseInt(match[2], 10),
    },
  };
}

function asInputRecord(entry, sourceIndex) {
  if (typeof entry === 'string') {
    const name = basename(entry);
    return { name, path: entry, sourceIndex };
  }
  if (!entry || typeof entry !== 'object') {
    throw new Error('Microscopy sequence input must be path strings or File-like objects with a name.');
  }
  const path = typeof entry.path === 'string' ? entry.path : '';
  const name = typeof entry.name === 'string' && entry.name ? entry.name : basename(path);
  if (!name) {
    throw new Error('Microscopy sequence input entries require a non-empty file name.');
  }
  return {
    name,
    path: path || null,
    sourceIndex,
  };
}

function buildWarnings(groupId, files) {
  const warnings = [];
  const withSuffix = files.filter(file => file.suffix != null);
  if (withSuffix.length !== files.length) {
    warnings.push({
      code: 'missing_plane_index',
      groupId,
      message: 'Some files are missing a trailing numeric plane index; lexical ordering was used.',
      files: files.filter(file => file.suffix == null).map(file => file.name),
    });
    return warnings;
  }

  const seen = new Map();
  for (const file of withSuffix) {
    const value = file.suffix.value;
    if (!seen.has(value)) seen.set(value, []);
    seen.get(value).push(file.name);
  }
  const duplicates = [...seen.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([index]) => index)
    .sort((a, b) => a - b);
  if (duplicates.length) {
    warnings.push({
      code: 'ambiguous_plane_index',
      groupId,
      message: 'Duplicate numeric plane indices detected; lexical tie-breakers were used.',
      indices: duplicates,
    });
  }

  const indices = [...seen.keys()].sort((a, b) => a - b);
  if (indices.length > 1) {
    const missing = [];
    for (let i = indices[0]; i <= indices[indices.length - 1]; i++) {
      if (!seen.has(i)) missing.push(i);
    }
    if (missing.length) {
      warnings.push({
        code: 'missing_plane_index_gap',
        groupId,
        message: 'Numeric plane indices are not contiguous.',
        missing,
      });
    }
  }
  return warnings;
}

function normalizeGroup(groupId, files) {
  const warnings = buildWarnings(groupId, files);
  const useNumeric = !warnings.some(warning => warning.code === 'missing_plane_index');
  const sorted = [...files].sort((a, b) => {
    if (useNumeric && a.suffix && b.suffix && a.suffix.value !== b.suffix.value) {
      return a.suffix.value - b.suffix.value;
    }
    const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return byName || a.sourceIndex - b.sourceIndex;
  });

  const planes = sorted.map((file, z) => ({
    z,
    name: file.name,
    path: file.path,
    sourceIndex: file.sourceIndex,
    inferredIndex: file.suffix?.value ?? null,
    inferredFrom: useNumeric && file.suffix ? 'numeric-suffix' : 'lexical',
  }));

  return {
    id: groupId,
    orderStrategy: useNumeric ? 'numeric-suffix' : 'lexical',
    warnings,
    planes,
  };
}

export function normalizeMicroscopyTiffSequence(input = []) {
  const records = Array.from(input, asInputRecord);
  if (!records.length) throw new Error('No microscopy sequence files provided.');

  const nonTiff = records.filter(record => !TIFF_EXT_RE.test(record.name));
  if (nonTiff.length) {
    throw new Error(`Microscopy sequence import only accepts TIFF files (.tif/.tiff). Non-TIFF input: ${nonTiff.map(file => file.name).join(', ')}`);
  }

  const groups = new Map();
  for (const record of records) {
    const parsed = stemAndSuffix(record.name);
    const dir = dirname(record.path || '').toLowerCase();
    const keyStem = parsed.groupStem;
    const groupId = `${dir}|${keyStem.toLowerCase() || 'sequence'}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push({ ...record, ...parsed });
  }

  const sequences = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([groupId, files]) => normalizeGroup(groupId, files));

  return {
    kind: 'microscopy-tiff-sequence',
    groups: sequences,
    warnings: sequences.flatMap(group => group.warnings),
  };
}

function fileStem(fileName) {
  return basename(fileName).replace(/\.[^.]+$/, '');
}

export function microscopyTiffSequenceName(group) {
  const first = fileStem(group?.planes?.[0]?.name || 'microscopy-sequence');
  return first.replace(/[\s._-]*\d+$/, '').replace(/[\s._-]+$/, '') || first || 'microscopy-sequence';
}

export function assertMicroscopyTiffSequenceCompatible(pages) {
  const first = pages[0] || {};
  for (const page of pages) {
    if (
      page.width !== first.width
      || page.height !== first.height
      || page.bitsPerSample !== first.bitsPerSample
      || page.samplesPerPixel !== first.samplesPerPixel
      || page.sampleFormat !== first.sampleFormat
      || page.photometric !== first.photometric
    ) {
      throw new Error('TIFF sequence planes must share dimensions, pixel type, sample layout, and photometric interpretation.');
    }
  }
}

export function metadataForMicroscopyTiffSequence(pages, firstMetadata, group) {
  const sequenceProvenance = {
    groupId: group.id,
    orderStrategy: group.orderStrategy,
    warnings: group.warnings,
    planes: group.planes.map(plane => ({
      z: plane.z,
      name: plane.name,
      path: plane.path,
      sourceIndex: plane.sourceIndex,
      inferredIndex: plane.inferredIndex,
      inferredFrom: plane.inferredFrom,
    })),
  };
  return {
    ...firstMetadata,
    source: 'TIFF sequence',
    sizeX: pages[0]?.width || firstMetadata.sizeX,
    sizeY: pages[0]?.height || firstMetadata.sizeY,
    sizeZ: pages.length,
    sizeC: 1,
    sizeT: 1,
    dimensionOrder: 'XYZCT',
    tiffData: null,
    channelNames: firstMetadata.channelNames?.slice(0, 1) || [],
    sourceFiles: group.planes.map(plane => plane.name),
    sequenceProvenance,
    warnings: group.warnings.map(warning => warning.code),
  };
}
