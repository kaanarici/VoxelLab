import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  applyDisplayRangeToChannelStacks,
  rawDisplayRangeToByteRange,
} = await import('../js/microscopy-display-range.js');

test('rawDisplayRangeToByteRange preserves raw endpoints outside normalized byte bounds', () => {
  assert.deepEqual(rawDisplayRangeToByteRange([10, 2000], [0, 30]), [85, 17000]);
});

test('rawDisplayRangeToByteRange honors MINISWHITE inversion after byte normalization', () => {
  assert.deepEqual(rawDisplayRangeToByteRange([5, 10], [0, 20], { invert: true }), [127.5, 191.25]);
});

test('applyDisplayRangeToChannelStacks recomputes each timepoint from its own raw range', () => {
  const stacks = {
    '0|0': [{ _microscopyRawRange: [0, 100] }],
    '0|1': [{ _microscopyRawRange: [100, 300] }],
    '1|0': [{ _microscopyRawRange: [0, 100] }],
  };

  assert.equal(applyDisplayRangeToChannelStacks(stacks, 0, [50, 150]), 2);
  assert.deepEqual(stacks['0|0'][0]._microscopyDisplayByteRange, [127.5, 382.5]);
  assert.deepEqual(stacks['0|1'][0]._microscopyDisplayByteRange, [-63.75, 63.75]);
  assert.equal(stacks['1|0'][0]._microscopyDisplayByteRange, undefined);
});
