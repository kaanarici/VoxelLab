import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  omeChannelMetadata,
  omeRgbaColorToHex,
} = await import('../js/microscopy/microscopy-ome-channel-metadata.js');

test('omeRgbaColorToHex decodes signed OME RGBA integers', () => {
  assert.equal(omeRgbaColorToHex('-16776961'), '#FF0000');
  assert.equal(omeRgbaColorToHex('16711935'), '#00FF00');
  assert.equal(omeRgbaColorToHex('-1'), '#FFFFFF');
  assert.equal(omeRgbaColorToHex('not-a-number'), null);
});

test('omeChannelMetadata preserves names, colors, and emission wavelengths', () => {
  const channels = omeChannelMetadata(`
    <Channel ID="Channel:0:0" Name="DAPI" Color="-16776961" EmissionWavelength="460" EmissionWavelengthUnit="nm"/>
    <Channel ID="Channel:0:1" Name="GFP" Color="16711935" EmissionWavelength="510" EmissionWavelengthUnit="nm"/>
    <Channel ID="Channel:0:2" Name="Brightfield"/>
  `);

  assert.deepEqual(channels, [{
    index: 0,
    name: 'DAPI',
    color: '#FF0000',
    emissionWavelength: 460,
    emissionWavelengthUnit: 'nm',
  }, {
    index: 1,
    name: 'GFP',
    color: '#00FF00',
    emissionWavelength: 510,
    emissionWavelengthUnit: 'nm',
  }, {
    index: 2,
    name: 'Brightfield',
    color: '#FFFFFF',
    emissionWavelength: null,
    emissionWavelengthUnit: 'nm',
  }]);
});
