// Boot-time availability probing.
//
// A manifest entry declares slice counts and geometry before any byte is proven
// fetchable, so opening series[0] blind can land a first-time visitor on a black
// viewport. Probing the first slice keeps the opening series one that renders.
//
// Probes use GET, not HEAD: serve.py routes /api/proxy-asset inside do_GET only,
// so HEAD falls through to static file handling and 404s even for healthy remote
// assets. The winning probe also warms the cache for the slice about to be shown.

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

// Walks `order` (manifest indexes, most-preferred first) and returns the first
// index whose opening slice resolves. Probing is capped so a wholly offline
// manifest cannot stall boot; once the cap is hit the next candidate is accepted
// unprobed so the viewer still opens something.
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

// Preferred index first, then every remaining series in manifest order.
export function seriesProbeOrder(seriesList = [], preferredIdx = 0) {
  const rest = seriesList.map((_, idx) => idx).filter((idx) => idx !== preferredIdx);
  return seriesList[preferredIdx] ? [preferredIdx, ...rest] : rest;
}
