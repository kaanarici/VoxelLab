import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmDuration,
  isSticky,
  pickEviction,
  resolveKind,
  shouldAutoDismiss,
} from '../js/notify-policy.js';

test('resolveKind prefers an explicit kind, then progress, then command', () => {
  assert.equal(resolveKind({}), 'confirm');
  assert.equal(resolveKind({ duration: 1500 }), 'confirm');
  assert.equal(resolveKind({ progress: true }), 'progress');
  assert.equal(resolveKind({ command: 'python3 embed.py' }), 'action');
  assert.equal(resolveKind({ kind: 'error', progress: true }), 'error');
  assert.equal(resolveKind({ kind: 'warning', command: 'x' }), 'warning');
  assert.equal(resolveKind({ kind: 'nope' }), 'confirm');
});

test('sticky kinds skip auto-dismiss even when a duration is set', () => {
  assert.equal(isSticky('confirm'), false);
  assert.equal(isSticky('info'), false);
  assert.equal(isSticky('warning'), true);
  assert.equal(isSticky('error'), true);
  assert.equal(isSticky('action'), true);
  assert.equal(isSticky('progress'), true);
  assert.equal(shouldAutoDismiss('confirm', {}), true);
  assert.equal(shouldAutoDismiss('confirm', { duration: 0 }), false);
  assert.equal(shouldAutoDismiss('error', { duration: 9000 }), false);
  assert.equal(shouldAutoDismiss('progress', { progress: true }), false);
});

test('confirmDuration honors an explicit duration and defaults to 5000', () => {
  assert.equal(confirmDuration({}), 5000);
  assert.equal(confirmDuration({ duration: 1500 }), 1500);
  assert.equal(confirmDuration({ duration: 0 }), 0);
  assert.equal(confirmDuration({ duration: Number.NaN }), 5000);
});

test('pickEviction removes the oldest confirm before any sticky toast', () => {
  assert.equal(pickEviction([]), -1);
  assert.equal(pickEviction([
    { kind: 'error' },
    { kind: 'confirm' },
    { kind: 'confirm' },
  ]), 1);
  assert.equal(pickEviction([
    { kind: 'progress' },
    { kind: 'info' },
    { kind: 'warning' },
  ]), 1);
  assert.equal(pickEviction([
    { kind: 'error' },
    { kind: 'action' },
    { kind: 'progress' },
  ]), 0);
});
