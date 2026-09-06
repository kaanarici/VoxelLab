import { imageUrlForStack } from './series-image-stack.js';

const PROBE_TIMEOUT_MS = 2500;
const DEFAULT_MAX_PROBES = 6;

const unavailableSlugs = new Set();

export function seriesHasSessionPixels(series, { localStacks = {} } = {}) {
  const slug = String(series?.slug || '').trim();
  if (!slug || !Number.isFinite(series?.slices) || series.slices <= 0) return false;
  const stack = localStacks[slug];
  return Array.isArray(stack) && stack.length === series.slices;
}

export function seriesCanOpenInViewer(series, {
  localStacks = {},
} = {}) {
  if (seriesHasSessionPixels(series, { localStacks })) return true;
  if (!series?.slug || !Number.isFinite(series?.slices) || series.slices <= 0) return false;
  return !isSeriesKnownUnavailable(series.slug);
}

export function isSeriesKnownUnavailable(slug) {
  return !!slug && unavailableSlugs.has(slug);
}

export function markSeriesUnavailable(slug) {
  if (slug) unavailableSlugs.add(slug);
}

export function clearSeriesAvailability(slug) {
  if (slug) unavailableSlugs.delete(slug);
  else unavailableSlugs.clear();
}

export async function probeSeriesAvailable(series, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (!series?.slug || !Number.isFinite(series.slices) || series.slices <= 0) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(imageUrlForStack(series.slug, 0, series), { signal: controller.signal });
    return !!res?.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function firstAvailableSeriesIdx(seriesList = [], order = [], options = {}) {
  const { maxProbes = DEFAULT_MAX_PROBES, ...probeOptions } = options;
  const candidates = order.filter((idx) => seriesList[idx]);
  if (!candidates.length) return -1;

  let probes = 0;
  for (const idx of candidates) {
    if (probes >= maxProbes) return idx;
    probes += 1;
    if (await probeSeriesAvailable(seriesList[idx], probeOptions)) return idx;
    markSeriesUnavailable(seriesList[idx].slug);
  }
  return candidates[0];
}

export function seriesProbeOrder(seriesList = [], preferredIdx = 0) {
  const rest = seriesList.map((_, idx) => idx).filter((idx) => idx !== preferredIdx);
  return seriesList[preferredIdx] ? [preferredIdx, ...rest] : rest;
}
