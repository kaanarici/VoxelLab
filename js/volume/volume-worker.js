import { DCMJS_IMPORT_URL, FZSTD_ESM_URL } from '../core/dependencies.js';
import { normalizeUint16RawVolume } from './volume-raw-normalize.js';
import { decodeZstdRawVolume } from './volume-zstd-decode.js';
import { computeGradientRGBA8 } from './volume-gradient.js';
import {
  addDICOMActualInputBytes,
  assertDICOMActualFileBytes,
  isDICOMResourceLimit,
} from '../dicom/dicom-import-resources.js';

// Web Worker for heavy volume operations. Runs off the main thread so
// fzstd decompression + uint16→float32 conversion don't freeze the UI.
//
// Messages:
//   { type: 'decompress', id, buffer, compressed }
//     → decompresses (if compressed), converts uint16 LE → float32 [0,1]
//     → posts back { type: 'result', id, f32 } with f32 as transferable
//
// The worker is stateless — each message is independent. The main thread
// manages caching, series identity, and GPU upload.

let ZstdDecompress = null;
let dcmjs = null;

async function ensureDcmjs() {
  if (dcmjs) return dcmjs;
  dcmjs = await import(DCMJS_IMPORT_URL);
  return dcmjs;
}

function looksLikeSourceManifest(payload) {
  return payload && typeof payload === 'object'
    && (payload.sourceKind === 'projection' || payload.sourceKind === 'ultrasound');
}

self.onmessage = async (e) => {
  const { type, id } = e.data;

  if (type === 'decompress') {
    try {
      let buf = e.data.buffer;

      // Decompress if the source is zstd-compressed
      if (e.data.compressed) {
        if (!ZstdDecompress) {
          ({ Decompress: ZstdDecompress } = await import(FZSTD_ESM_URL));
        }
        buf = decodeZstdRawVolume(buf, e.data.expectedVoxels, ZstdDecompress);
      }

      const f32 = normalizeUint16RawVolume(buf, e.data.expectedVoxels);

      // Transfer the Float32Array buffer back (zero-copy)
      self.postMessage({ type: 'result', id, f32 }, [f32.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }

  if (type === 'gradient') {
    try {
      const { data, width, height, depth, isFloat } = e.data;
      const rgba = computeGradientRGBA8(data, width, height, depth, isFloat);
      self.postMessage({ type: 'gradient-result', id, rgba }, [rgba.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
    return;
  }

  if (type === 'flatten-image-bitmaps') {
    const inputBitmaps = e.data.bitmaps;
    const bitmaps = Array.isArray(inputBitmaps) ? inputBitmaps : [];
    try {
      const { w, h, d } = e.data;
      if (!Array.isArray(inputBitmaps) || inputBitmaps.length !== d) {
        throw new Error(`flatten-image-bitmaps: got ${inputBitmaps?.length} bitmaps, expected ${d}`);
      }
      // Reuse one OffscreenCanvas across slices to avoid per-slice GC churn.
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const out = new Uint8Array(w * h * d);
      for (let z = 0; z < d; z++) {
        const bmp = bitmaps[z];
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;
        // Single channel from R; PNG slice writers store luminance.
        const base = z * w * h;
        for (let i = 0, p = 0; i < rgba.length; i += 4, p++) out[base + p] = rgba[i];
      }
      self.postMessage({ type: 'flatten-result', id, bytes: out }, [out.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    } finally {
      for (const bitmap of bitmaps) bitmap?.close?.();
    }
    return;
  }

  if (type === 'parse-dicom-files') {
    try {
      const lib = await ensureDcmjs();
      const DicomMessage = lib.data.DicomMessage;
      const datasets = [];
      const sourceManifests = {};
      let parsed = 0;
      let actualInputBytes = 0;

      for (const [index, file] of (e.data.files || []).entries()) {
        if (/\.json$/i.test(file?.name || '')) {
          try {
            const bytes = await file.arrayBuffer();
            assertDICOMActualFileBytes(bytes.byteLength, file, index);
            actualInputBytes = addDICOMActualInputBytes(actualInputBytes, bytes.byteLength, file, index);
            const payload = JSON.parse(new TextDecoder().decode(bytes));
            if (looksLikeSourceManifest(payload) && payload.seriesUID) {
              sourceManifests[String(payload.seriesUID)] = payload;
            }
          } catch (error) {
            if (isDICOMResourceLimit(error)) throw error;
            // Ignore sidecar JSON that is not a source manifest.
          }
          continue;
        }
        try {
          const ab = await file.arrayBuffer();
          assertDICOMActualFileBytes(ab.byteLength, file, index);
          actualInputBytes = addDICOMActualInputBytes(actualInputBytes, ab.byteLength, file, index);
          const ds = DicomMessage.readFile(ab);
          const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
          if (!meta.PixelData) continue;
          datasets.push({
            meta,
            pixelData: ds.dict['7FE00010'],
            sourceByteLength: ab.byteLength,
            sourceId: index,
          });
          parsed++;
          if (parsed % 10 === 0) {
            self.postMessage({
              type: 'progress',
              id,
              stage: 'parsing',
              detail: `${parsed} / ${e.data.files.length}`,
            });
          }
        } catch (error) {
          if (isDICOMResourceLimit(error)) throw error;
          // Skip unparseable files.
        }
      }

      self.postMessage({
        type: 'dicom-result',
        id,
        payload: { datasets, sourceManifests },
      });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }
};
