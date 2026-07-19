import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  FORMAT_CAPABILITY_ROWS,
  renderFormatCapabilityMatrix,
} = await import('../js/format-capability-matrix.js');

test('format capability matrix keeps native converted and unsupported lanes explicit', () => {
  const statuses = new Set(FORMAT_CAPABILITY_ROWS.map(row => row.status));
  const rows = new Map(FORMAT_CAPABILITY_ROWS.map(row => [row.format, row]));

  assert.deepEqual([...statuses].sort(), ['Converted', 'Native', 'Unsupported']);
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Converted' && /SEG|Projection/.test(row.format)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Unsupported' && /TIFF JPEG/.test(row.format)));
  assert.match(rows.get('DICOM CT/MR/PT/NM/OT').note, /patient-space geometry.*pixel layout/);
  assert.match(rows.get('NIfTI-1/2 .nii/.nii.gz').note, /dim-4.*signed 8-bit and unsigned 32-bit.*fail closed/);
  assert.match(rows.get('OME-TIFF / ImageJ TIFF').note, /8\/16\/32-bit.*RGB\/RGBA.*line profiles/);
  assert.match(rows.get('ImageJ ROI .roi').note, /open PolyLine.*active microscopy series|active microscopy series.*open PolyLine/);
  assert.match(rows.get('ImageJ ROI .zip').note, /valid CRC32.*byte budgets/);
  assert.match(rows.get('SEG / RTSTRUCT / SR / RT Dose').note, /session queue.*never decoded, rendered, calculated, or exported/);
  assert.match(rows.get('OME-Zarr (limited)').note, /OME-NGFF 0\.4\/0\.5.*Zarr v3.*fail closed/);
  assert.match(rows.get('CZI / ND2 / LIF / OIB / OIF / LSM bridge').note, /CZI scenes.*LIF images\/positions.*external converter.*Bio-Formats parity/);
});

test('renderFormatCapabilityMatrix escapes row values', () => {
  const html = renderFormatCapabilityMatrix([{
    status: 'Native',
    format: '<OME>',
    note: 'safe & local',
  }]);

  assert.match(html, /role="table"/);
  assert.match(html, /&lt;OME&gt;/);
  assert.match(html, /safe &amp; local/);
  assert.doesNotMatch(html, /<OME>/);
});
