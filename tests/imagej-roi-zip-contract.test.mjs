import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { imageJRoiZip, parseImageJRoi, parseImageJRoiZipEntries } from '../js/microscopy/imagej-roi.js';
import { splitMicroscopySidecars } from '../js/projects/microscopy-sidecars.js';
import { zipArchive } from './fixtures/imagej-roi-zip-helpers.mjs';

function localStoredEntry(name, bytes) {
  const encodedName = Buffer.from(name);
  const entry = Buffer.alloc(30 + encodedName.length + bytes.length);
  entry.writeUInt32LE(0x04034b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt32LE(0, 14);
  entry.writeUInt32LE(bytes.length, 18);
  entry.writeUInt32LE(bytes.length, 22);
  entry.writeUInt16LE(encodedName.length, 26);
  encodedName.copy(entry, 30);
  bytes.copy(entry, 30 + encodedName.length);
  return entry;
}

function roiZip() {
  return Buffer.from(imageJRoiZip([
    { kind: 'line', label: 'axon', points: [[2, 4], [10, 4]] },
  ]));
}

test('ImageJ ROI ZIP requires a complete central directory and EOCD', async () => {
  const zip = roiZip();
  const eocdOffset = zip.length - 22;
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  await assert.rejects(
    () => parseImageJRoiZipEntries(zip.subarray(0, centralOffset)),
    /end-of-central-directory record is missing/,
  );
});

test('ImageJ ROI ZIP rejects local and central descriptor-flag disagreement', async () => {
  const zip = roiZip();
  zip.writeUInt16LE(0x08, 6);

  await assert.rejects(
    () => parseImageJRoiZipEntries(zip),
    /central-directory metadata does not match its local entry/,
  );
});

test('ImageJ ROI ZIP rejects trailing payload after the EOCD envelope', async () => {
  await assert.rejects(
    () => parseImageJRoiZipEntries(Buffer.concat([roiZip(), Buffer.from('junk')])),
    /end-of-central-directory record is missing/,
  );
});

test('ImageJ ROI ZIP imports valid ROI entries while ignoring valid non-ROI entries', async () => {
  const validRoi = Buffer.from(imageJRoiZip([
    { kind: 'point', label: 'spot', points: [[3, 6]] },
  ]));
  const centralOffset = validRoi.readUInt32LE(validRoi.length - 6);
  const localRoi = validRoi.subarray(0, centralOffset);
  const result = await parseImageJRoiZipEntries(zipArchive([
    localRoi,
    localStoredEntry('notes.txt', Buffer.from('research notes')),
  ]));

  assert.deepEqual(result.rois.map(roi => roi.name), ['spot_z1_c1_t1']);
  assert.deepEqual(result.skipped, []);
});

test('microscopy sidecar intake rejects declared oversize ROI files before arrayBuffer', async () => {
  let reads = 0;
  const makeFile = (name, size) => ({
    name,
    size,
    arrayBuffer: async () => {
      reads += 1;
      return new ArrayBuffer(0);
    },
  });
  const result = await splitMicroscopySidecars([
    makeFile('oversize.zip', 80 * 1024 * 1024 + 1),
    makeFile('oversize.roi', 8 * 1024 * 1024 + 1),
  ]);

  assert.equal(reads, 0);
  assert.equal(result.imageJRoiSidecarErrors.length, 2);
  assert.match(result.imageJRoiSidecarErrors[0].reason, /input budget/);
  assert.match(result.imageJRoiSidecarErrors[1].reason, /input budget/);
});

test('ImageJ ROI parser rechecks actual standalone ROI bytes', () => {
  assert.throws(
    () => parseImageJRoi(Buffer.alloc(8 * 1024 * 1024 + 1)),
    /ImageJ ROI file exceeds the 8388608 byte input budget/,
  );
});
