import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  FORMAT_CAPABILITY_ROWS,
  renderFormatCapabilityMatrix,
} = await import('../js/format-capability-matrix.js');

test('format capability matrix keeps native converted unsupported and planned lanes explicit', () => {
  const statuses = new Set(FORMAT_CAPABILITY_ROWS.map(row => row.status));

  assert.deepEqual([...statuses].sort(), ['Converted', 'Native', 'Planned', 'Unsupported']);
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Converted' && /SEG|Projection/.test(row.format)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row => row.status === 'Unsupported' && /Compressed TIFF/.test(row.format)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.format === 'OME-TIFF / ImageJ TIFF'
    && /when spacing metadata is present/.test(row.note)));
  assert.ok(FORMAT_CAPABILITY_ROWS.some(row =>
    row.status === 'Planned'
    && /CZI \/ ND2 \/ LIF/.test(row.format)
    && /no first-party browser Bio-Formats parity claim/.test(row.note)));
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
