import { normalizeModality } from './dicom-meta.js';
import { seqFirst } from './derived-common.js';

export function contentItems(node) {
  return Array.isArray(node?.ContentSequence) ? node.ContentSequence : [];
}

export function itemMeaning(item) {
  return String(seqFirst(item?.ConceptNameCodeSequence)?.CodeMeaning || '').trim();
}

function itemText(item) {
  return String(item?.TextValue || '').trim();
}

function itemNumber(item) {
  const measured = seqFirst(item?.MeasuredValueSequence);
  return Number(measured?.NumericValue);
}

export function collectMeasurementGroups(dataset) {
  const groups = [];
  const stack = [...contentItems(dataset)];
  for (let index = 0; index < stack.length; index += 1) {
    const item = stack[index];
    if (itemMeaning(item) === 'Measurement Group') groups.push(item);
    stack.push(...contentItems(item));
  }
  return groups;
}

function srAnnotationText(group) {
  const lines = [];
  for (const item of contentItems(group)) {
    const meaning = itemMeaning(item);
    if (item?.ValueType === 'NUM' && Number.isFinite(itemNumber(item))) {
      lines.push(`${meaning}: ${itemNumber(item)}`);
    } else if (item?.ValueType === 'TEXT' && itemText(item)) {
      lines.push(`${meaning}: ${itemText(item)}`);
    }
  }
  return lines.join('\n').trim();
}

export function parseViewerSrReference(item) {
  const text = itemText(item);
  const match = text.match(/^(.+?)\s+slice\s+(\d+)$/i);
  if (!match) return null;
  return {
    sourceSlug: match[1].trim(),
    sliceIndex: Math.max(0, Number(match[2]) - 1),
  };
}

export function buildSRImport(meta, sourceSeries) {
  if (normalizeModality(meta?.Modality) !== 'SR') return null;
  const groups = collectMeasurementGroups(meta);
  if (!groups.length) return null;
  const width = Number(sourceSeries.width || 1);
  const height = Number(sourceSeries.height || 1);
  const annotationsBySlice = {};
  for (const group of groups) {
    const sourceText = contentItems(group).find((item) => itemMeaning(item) === 'Referenced Series');
    const reference = parseViewerSrReference(sourceText);
    if (!reference || reference.sourceSlug !== sourceSeries.slug) {
      throw new Error('SR import currently supports only VoxelLab viewer-exported measurement notes with explicit "<slug> slice N" references');
    }
    const sliceIndex = Math.max(0, Math.min(sourceSeries.slices - 1, reference.sliceIndex));
    const text = srAnnotationText(group);
    if (!text) continue;
    const key = String(sliceIndex);
    annotationsBySlice[key] = annotationsBySlice[key] || [];
    annotationsBySlice[key].push({
      x: width / 2,
      y: height / 2,
      text,
    });
  }
  return {
    kind: 'sr',
    name: String(meta.SeriesDescription || meta.SeriesInstanceUID || 'SR import'),
    annotationsBySlice,
  };
}
