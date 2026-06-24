import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  FORMAT_CAPABILITY_ROWS,
  renderFormatCapabilityMatrix,
} = await import('../js/format-capability-matrix.js');

test('format capability matrix keeps native converted and unsupported lanes explicit', () => {
  const statuses = new Set(FORMAT_CAPABILITY_ROWS.map(row => row.status));

  assert.deepEqual([...statuses].sort(), ['Converted', 'Native', 'Unsupported']);
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Converted' && /SEG|Projection/.test(row.format)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Unsupported' && /Compressed TIFF/.test(row.format)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.format === 'OME-TIFF / ImageJ TIFF'
    && /when spacing metadata is present/.test(row.note)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.status === 'Native'
    && row.format === 'ImageJ ROI .roi'
    && /straight-line/.test(row.note)
    && /angle/.test(row.note)
    && /opened onto the active microscopy series/.test(row.note)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.status === 'Native'
    && row.format === 'ImageJ ROI .zip'
    && /stored\/deflated supported ROI sidecars/.test(row.note)
    && /opened onto the active microscopy series/.test(row.note)
    && /straight-line and angle measurements/.test(row.note)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.status === 'Converted'
    && row.format === 'SEG / RTSTRUCT / SR / RT Dose'
    && /Session-bound import onto a loaded source/.test(row.note)
    && /SR re-import is limited to VoxelLab-exported measurement notes/.test(row.note)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.status === 'Converted'
    && row.format === 'CZI / ND2 / LIF / OIB / OIF / LSM bridge'
    && /Local backend can convert CZI\/ND2\/LIF with optional readers/.test(row.note)
    && /CZI\/ND2\/LIF\/OIB\/OIF\/LSM through a configured external OME-TIFF converter/.test(row.note)
    && /Electron uses the same external-converter boundary/.test(row.note)
    && /not native browser import/.test(row.note)
    && /first-party Bio-Formats parity/.test(row.note)));
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
