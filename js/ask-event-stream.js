import { EnvelopeValidationError, normalizeAskResult } from './ask-envelopes.js';

export const ASK_EVENT_PROTOCOL = 'voxellab.ask-event';
export const ASK_EVENT_VERSION = 1;

export class AskEventStreamError extends Error {
  constructor(reason) {
    super(`ask-event-stream:${reason}`);
    this.name = 'AskEventStreamError';
    this.reason = reason;
  }
}

function fail(reason) {
  throw new AskEventStreamError(reason);
}

function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('not_object');
  return value;
}

function allowedFields(payload, allowed) {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) fail(`unexpected_field:${key}`);
  }
}

function stringField(payload, key, { allowEmpty = false } = {}) {
  if (!Object.hasOwn(payload, key)) fail(`${key}_missing`);
  const value = payload[key];
  if (typeof value !== 'string') fail(`${key}_not_string`);
  if (!allowEmpty && !value) fail(`${key}_empty`);
  return value;
}

const BASE_FIELDS = ['protocol', 'version', 'type'];
const TOOL_KINDS = new Set(['read', 'inspect', 'measure', 'voxel', 'other']);
const TOOL_STATES = new Set(['running', 'done', 'error']);

/** Validate and normalize one versioned Ask transport event. */
export function normalizeAskEvent(value) {
  const payload = objectValue(value);
  const protocol = stringField(payload, 'protocol');
  if (protocol !== ASK_EVENT_PROTOCOL) fail('unsupported_protocol');
  if (!Object.hasOwn(payload, 'version')) fail('version_missing');
  if (!Number.isInteger(payload.version)) fail('version_not_integer');
  if (payload.version !== ASK_EVENT_VERSION) fail(`unsupported_version:${payload.version}`);
  const type = stringField(payload, 'type');
  const base = { protocol, version: ASK_EVENT_VERSION, type };

  if (type === 'phase') {
    allowedFields(payload, new Set([...BASE_FIELDS, 'value']));
    const phase = stringField(payload, 'value');
    if (phase !== 'composing') fail(`unsupported_phase:${phase}`);
    return { ...base, value: phase };
  }
  if (type === 'tool') {
    const id = stringField(payload, 'id');
    const state = stringField(payload, 'state');
    if (!TOOL_STATES.has(state)) fail(`unsupported_tool_state:${state}`);
    if (state !== 'running') {
      allowedFields(payload, new Set([...BASE_FIELDS, 'id', 'state']));
      return { ...base, id, state };
    }
    allowedFields(payload, new Set([...BASE_FIELDS, 'id', 'state', 'kind', 'label', 'detail']));
    const kind = stringField(payload, 'kind');
    if (!TOOL_KINDS.has(kind)) fail(`unsupported_tool_kind:${kind}`);
    return {
      ...base,
      id,
      state,
      kind,
      label: stringField(payload, 'label'),
      detail: stringField(payload, 'detail', { allowEmpty: true }),
    };
  }
  if (type === 'delta') {
    allowedFields(payload, new Set([...BASE_FIELDS, 'text']));
    return { ...base, text: stringField(payload, 'text', { allowEmpty: true }) };
  }
  if (type === 'tool_output') {
    allowedFields(payload, new Set([...BASE_FIELDS, 'id', 'text']));
    return {
      ...base,
      id: stringField(payload, 'id'),
      text: stringField(payload, 'text', { allowEmpty: true }),
    };
  }
  if (type === 'result') {
    allowedFields(payload, new Set([...BASE_FIELDS, 'result']));
    try {
      return { ...base, result: normalizeAskResult(payload.result) };
    } catch (error) {
      if (error instanceof EnvelopeValidationError) fail(`result:${error.reason}`);
      throw error;
    }
  }
  if (type === 'error') {
    allowedFields(payload, new Set([...BASE_FIELDS, 'error']));
    return { ...base, error: stringField(payload, 'error', { allowEmpty: true }) };
  }
  if (type === 'done') {
    allowedFields(payload, new Set(BASE_FIELDS));
    return base;
  }
  fail(`unsupported_type:${type}`);
}

function parseEvent(dataLines) {
  const data = dataLines.join('\n');
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    throw new AskEventStreamError('invalid_json');
  }
  return normalizeAskEvent(event);
}

/** Decode JSON Server-Sent Events across arbitrary network chunk boundaries. */
export async function* readAskEventStream(stream, { maxEventChars = 1_000_000 } = {}) {
  if (!stream?.getReader) throw new AskEventStreamError('missing_body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let dataChars = 0;
  let complete = false;

  const acceptLine = (line) => {
    if (!line) {
      if (!dataLines.length) return null;
      const event = parseEvent(dataLines);
      dataLines = [];
      dataChars = 0;
      return event;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return null;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
    dataChars += value.length;
    if (dataChars > maxEventChars) {
      throw new AskEventStreamError('event_too_large');
    }
    return null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      for (;;) {
        const lf = buffer.indexOf('\n');
        const cr = buffer.indexOf('\r');
        let end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) break;
        if (buffer[end] === '\r' && end === buffer.length - 1 && !done) break;
        const width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
        const event = acceptLine(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
        if (event) yield event;
      }

      if (!done) {
        if (buffer.length > maxEventChars) throw new AskEventStreamError('event_too_large');
        continue;
      }
      if (buffer) {
        const event = acceptLine(buffer);
        if (event) yield event;
      }
      if (dataLines.length) yield parseEvent(dataLines);
      return;
    }
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* response may already be closed */ }
    }
    reader.releaseLock?.();
  }
}
