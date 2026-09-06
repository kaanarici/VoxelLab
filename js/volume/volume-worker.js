import { DCMJS_IMPORT_URL, FZSTD_ESM_URL } from '../core/dependencies.js';
import { normalizeUint16RawVolume } from './volume-raw-normalize.js';
import { decodeZstdRawVolume } from './volume-zstd-decode.js';
import {
  addDICOMActualInputBytes,
  assertDICOMActualFileBytes,
  isDICOMResourceLimit,
} from '../dicom/dicom-import-resources.js';

let ZstdDecompress = null;
let dcmjs = null;

async function ensureDcmjs() {
  if (dcmjs) return dcmjs;
  dcmjs = await import(DCMJS_IMPORT_URL);
  return dcmjs;
}

function looksLikeSourceManifest(payload) {
  return payload != null && Object(payload) === payload && !Array.isArray(payload) && !(payload instanceof Function)
    && (payload.sourceKind === 'projection' || payload.sourceKind === 'ultrasound');
}

async function readDicomFiles(files, { metadataOnly, onProgress }) {
  const lib = await ensureDcmjs();
  const DicomMessage = lib.data.DicomMessage;
  const datasets = [];
  const sourceManifests = {};
  let parsed = 0;
  let actualInputBytes = 0;

  for (const [index, file] of files.entries()) {
    if (/\.json$/i.test(file?.name || '')) {
      try {
        const bytes = await file.arrayBuffer();
        assertDICOMActualFileBytes(bytes.byteLength, file, index);
        actualInputBytes = addDICOMActualInputBytes(actualInputBytes, bytes.byteLength, file, index);
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (looksLikeSourceManifest(payload) && payload.seriesUID) {
          sourceManifests[String(payload.seriesUID)] = { payload, sourceId: index };
        }
      } catch (error) {
        if (isDICOMResourceLimit(error)) throw error;
      }
      continue;
    }
    try {
      const ab = await file.arrayBuffer();
      assertDICOMActualFileBytes(ab.byteLength, file, index);
      actualInputBytes = addDICOMActualInputBytes(actualInputBytes, ab.byteLength, file, index);
      const ds = metadataOnly
        ? DicomMessage.readFile(ab, {
          ignoreErrors: false,
          untilTag: '7FE00010',
          includeUntilTagValue: false,
          noCopy: true,
        })
        : DicomMessage.readFile(ab);
      const meta = lib.data.DicomMetaDictionary.naturalizeDataset(ds.dict);
      if (!Object.hasOwn(meta, 'PixelData')) continue;
      const item = {
        meta,
        sourceByteLength: ab.byteLength,
        sourceId: index,
      };
      if (!metadataOnly) item.pixelData = ds.dict['7FE00010'];
      datasets.push(item);
      parsed += 1;
      if (parsed % 10 === 0) onProgress(parsed, files.length);
    } catch (error) {
      if (isDICOMResourceLimit(error)) throw error;
    }
  }
  return { datasets, sourceManifests };
}

self.onmessage = async (e) => {
  const { type, id } = e.data;

  if (type === 'decompress') {
    try {
      let buf = e.data.buffer;

      if (e.data.compressed) {
        if (!ZstdDecompress) {
          ({ Decompress: ZstdDecompress } = await import(FZSTD_ESM_URL));
        }
        buf = decodeZstdRawVolume(buf, e.data.expectedVoxels, ZstdDecompress);
      }

      const f32 = normalizeUint16RawVolume(buf, e.data.expectedVoxels);

      self.postMessage({ type: 'result', id, f32 }, [f32.buffer]);
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }

  if (type === 'flatten-image-bitmaps') {
    const inputBitmaps = e.data.bitmaps;
    const bitmaps = Array.isArray(inputBitmaps) ? inputBitmaps : [];
    try {
      const { w, h, d } = e.data;
      if (!Array.isArray(inputBitmaps) || inputBitmaps.length !== d) {
        throw new Error(`flatten-image-bitmaps: got ${inputBitmaps?.length} bitmaps, expected ${d}`);
      }

      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const out = new Uint8Array(w * h * d);
      for (let z = 0; z < d; z++) {
        const bmp = bitmaps[z];
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
        const rgba = ctx.getImageData(0, 0, w, h).data;

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

  if (type === 'scan-dicom-files' || type === 'parse-dicom-files') {
    try {
      const payload = await readDicomFiles(e.data.files || [], {
        metadataOnly: type === 'scan-dicom-files',
        onProgress(parsed, total) {
          self.postMessage({
            type: 'progress',
            id,
            stage: type === 'scan-dicom-files' ? 'discovering' : 'parsing',
            detail: `${parsed} / ${total}`,
          });
        },
      });
      self.postMessage({
        type: 'dicom-result',
        id,
        payload,
      });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: err.message });
    }
  }
};
