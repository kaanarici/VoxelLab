import { buildDICOMSeriesResult } from './dicom-import-parse.js';
import {
  fetchSeriesItems,
  resolveDicomwebImportSession,
} from './dicomweb/dicomweb-source.js';

export {
  fetchSeriesMetadata,
  fetchSeriesItems,
  discoverQidoStudies,
  discoverQidoSeries,
  getDicomwebSessionStats,
  resolveDicomwebImportSession,
} from './dicomweb/dicomweb-source.js';

function localImportSlug(prefix = 'local') {
  return `${prefix}_${Date.now().toString(36)}`;
}

function dicomwebHeaders({ bearerToken = '', headers = {} } = {}) {
  const next = { ...headers };
  if (bearerToken && !next.Authorization && !next.authorization) next.Authorization = `Bearer ${bearerToken}`;
  return next;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('DICOMweb import was cancelled', 'AbortError');
}

export async function importDicomwebSeries({
  wadoBase,
  studyUID,
  seriesUID,
  bearerToken = '',
  headers = {},
  metadata,
  slug = localImportSlug('dicomweb'),
  onProgress = () => {},
  fetchImpl,
  signal,
  retries,
  retryStatuses,
  retryDelay,
  sessionId = '',
  cacheScopeKey = '',
  useCache = true,
}) {
  if (!String(wadoBase || '').trim() || !String(studyUID || '').trim() || !String(seriesUID || '').trim()) {
    throw new Error('DICOMweb import requires WADO-RS base URL, Study UID, and Series UID');
  }
  const requestHeaders = dicomwebHeaders({ bearerToken, headers });
  throwIfAborted(signal);
  const session = resolveDicomwebImportSession({
    sessionId,
    wadoBase,
    headers: requestHeaders,
    fetchImpl,
    retries,
    retryStatuses,
    retryDelay,
    cacheScopeKey,
  });
  const items = await fetchSeriesItems({
    wadoBase,
    studyUID,
    seriesUID,
    sessionId: session.id,
    headers: requestHeaders,
    fetchImpl,
    metadata,
    signal,
    retries,
    retryStatuses,
    retryDelay,
    cacheScopeKey,
    useCache,
  });
  throwIfAborted(signal);
  if (!items.length) throw new Error('DICOMweb series returned no frame items');
  return await buildDICOMSeriesResult(items, onProgress, slug, [], null, signal);
}
