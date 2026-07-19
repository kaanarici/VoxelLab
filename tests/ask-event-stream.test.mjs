import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AskEventStreamError, normalizeAskEvent, readAskEventStream } from '../js/ask-event-stream.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contract/ask-events-v1.json', import.meta.url), 'utf8'));

function streamChunks(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks, options) {
  const events = [];
  for await (const event of readAskEventStream(streamChunks(chunks), options)) events.push(event);
  return events;
}

test('ask event stream decodes frames split across chunks and CRLF boundaries', async () => {
  const tool = fixture.valid.find((item) => item.id === 'tool-read-running').input;
  const result = fixture.valid.find((item) => item.id === 'result').input;
  assert.deepEqual(await collect([
    ': keepalive\r',
    `\ndata: ${JSON.stringify(tool)}\r\n\r`,
    `\ndata: ${JSON.stringify(result).slice(0, 80)}`,
    `\ndata: ${JSON.stringify(result).slice(80)}\n\n`,
  ]), [tool, result]);
});

test('ask event stream flushes a final unterminated data frame', async () => {
  const done = fixture.valid.find((item) => item.id === 'done').input;
  assert.deepEqual(await collect([`data: ${JSON.stringify(done)}`]), [done]);
});

test('Ask event v1 fixture valid cases match the JavaScript normalizer', () => {
  for (const item of fixture.valid) assert.deepEqual(normalizeAskEvent(item.input), item.input, item.id);
});

test('Ask event v1 fixture invalid cases have shared named reasons', () => {
  for (const item of fixture.invalid) {
    assert.throws(
      () => normalizeAskEvent(item.input),
      (error) => error instanceof AskEventStreamError && error.reason === item.reason,
      item.id,
    );
  }
});

test('ask event stream rejects an invalid event before yielding it', async () => {
  const invalid = fixture.invalid.find((item) => item.id === 'unknown-version');
  const iterator = readAskEventStream(streamChunks([`data: ${JSON.stringify(invalid.input)}\n\n`]));
  await assert.rejects(() => iterator.next(), (error) => (
    error instanceof AskEventStreamError && error.reason === invalid.reason
  ));
});

test('ask event stream rejects malformed and oversized events', async () => {
  await assert.rejects(
    () => collect(['data: not-json\n\n']),
    (error) => error instanceof AskEventStreamError && error.reason === 'invalid_json',
  );
  await assert.rejects(
    () => collect(['data: {"long":"value"}\n\n'], { maxEventChars: 5 }),
    (error) => error instanceof AskEventStreamError && error.reason === 'event_too_large',
  );
});
