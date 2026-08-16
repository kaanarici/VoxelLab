import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  askModelDisclosure,
  askModelRequestFields,
  migrateAskModelKey,
  pickAskModel,
} from '../js/ask-models.js';

const models = [
  { key: 'claude:fable', provider: 'claude', model: 'fable', label: 'Fable 5', group: 'Claude Code' },
  { key: 'claude:opus', provider: 'claude', model: 'opus', label: 'Opus 5', group: 'Claude Code' },
  { key: 'codex:gpt-5.5', provider: 'codex', model: 'gpt-5.5', label: 'GPT-5.5', group: 'Codex' },
];

test('migrateAskModelKey maps the previous hardcoded picker ids', () => {
  assert.equal(migrateAskModelKey('opus-4.8'), 'claude:opus');
  assert.equal(migrateAskModelKey('gpt-5.5'), 'codex:gpt-5.5');
  assert.equal(migrateAskModelKey('claude:opus'), 'claude:opus');
  assert.equal(migrateAskModelKey(''), '');
});

test('pickAskModel keeps a stored CLI model when it is still listed', () => {
  const picked = pickAskModel(models, 'opus-4.8', 'codex');
  assert.equal(picked?.key, 'claude:opus');
});

test('pickAskModel falls back to Opus inside Claude, else the configured provider', () => {
  assert.equal(pickAskModel(models, 'claude:missing', 'codex')?.key, 'codex:gpt-5.5');
  assert.equal(pickAskModel(models, '', 'claude')?.key, 'claude:opus');
  assert.equal(pickAskModel(models, '', '')?.key, 'claude:opus');
  assert.equal(pickAskModel([], 'claude:opus'), null);
});

test('askModelRequestFields omits blank model ids so the CLI default can win', () => {
  assert.deepEqual(askModelRequestFields({ provider: 'claude', model: 'opus' }), {
    provider: 'claude',
    model: 'opus',
  });
  assert.deepEqual(askModelRequestFields({ provider: 'claude', model: '' }), {
    provider: 'claude',
  });
  assert.deepEqual(askModelRequestFields(null), {});
});

test('askModelDisclosure names the destination and the data leaving the device', () => {
  const disclosure = askModelDisclosure(models[1]);
  assert.equal(disclosure.text, 'Sends images to Opus 5 via Claude Code · current slice, selections, and study details · not a diagnosis');
  assert.match(disclosure.title, /Images leave this device/);
  assert.match(disclosure.title, /other slices/);
  assert.match(askModelDisclosure(null).text, /selected AI provider/);
});
