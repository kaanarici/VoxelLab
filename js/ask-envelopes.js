export class EnvelopeValidationError extends Error {
  constructor(envelope, reason) {
    super(`${envelope}:${reason}`);
    this.name = 'EnvelopeValidationError';
    this.envelope = envelope;
    this.reason = reason;
  }
}

function objectValue(value, envelope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EnvelopeValidationError(envelope, 'not_object');
  }
  return value;
}

function unexpected(payload, allowed, envelope) {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new EnvelopeValidationError(envelope, `unexpected_field:${key}`);
  }
}

function stringField(payload, key, envelope, { allowEmpty = false } = {}) {
  if (!Object.hasOwn(payload, key)) throw new EnvelopeValidationError(envelope, `${key}_missing`);
  const value = payload[key];
  if (typeof value !== 'string') throw new EnvelopeValidationError(envelope, `${key}_not_string`);
  if (!allowEmpty && !value) throw new EnvelopeValidationError(envelope, `${key}_empty`);
  return value;
}

function booleanField(payload, key, envelope) {
  if (!Object.hasOwn(payload, key)) throw new EnvelopeValidationError(envelope, `${key}_missing`);
  const value = payload[key];
  if (typeof value !== 'boolean') throw new EnvelopeValidationError(envelope, `${key}_not_boolean`);
  return value;
}

function nonnegativeInteger(payload, key, envelope) {
  if (!Object.hasOwn(payload, key)) throw new EnvelopeValidationError(envelope, `${key}_missing`);
  const value = payload[key];
  if (!Number.isInteger(value) || value < 0) {
    throw new EnvelopeValidationError(envelope, `${key}_not_nonnegative_integer`);
  }
  return value;
}

function regionField(payload, envelope) {
  if (!Object.hasOwn(payload, 'region')) return null;
  const value = payload.region;
  if (!Array.isArray(value) || value.length !== 4) throw new EnvelopeValidationError(envelope, 'region_not_bounds');
  const bounds = value.map((item) => {
    if (!Number.isInteger(item) || item < 0) throw new EnvelopeValidationError(envelope, 'region_not_bounds');
    return item;
  });
  if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) {
    throw new EnvelopeValidationError(envelope, 'region_inverted');
  }
  return bounds;
}

function normalizeAskFields(payload, envelope) {
  const normalized = {
    key: stringField(payload, 'key', envelope),
    slice: nonnegativeInteger(payload, 'slice', envelope),
    x: nonnegativeInteger(payload, 'x', envelope),
    y: nonnegativeInteger(payload, 'y', envelope),
    question: stringField(payload, 'question', envelope),
    answer: stringField(payload, 'answer', envelope, { allowEmpty: true }),
    crop: stringField(payload, 'crop', envelope),
  };
  const region = regionField(payload, envelope);
  if (region) normalized.region = region;
  if (Object.hasOwn(payload, 'contextFingerprint')) {
    normalized.contextFingerprint = stringField(payload, 'contextFingerprint', envelope);
  }
  return normalized;
}

export function normalizeAskEntry(value) {
  const envelope = 'ask-entry';
  const payload = objectValue(value, envelope);
  unexpected(payload, new Set(['key', 'slice', 'x', 'y', 'question', 'answer', 'crop', 'region', 'contextFingerprint']), envelope);
  return normalizeAskFields(payload, envelope);
}

export function normalizeAskResult(value) {
  const envelope = 'ask-result';
  const payload = objectValue(value, envelope);
  unexpected(payload, new Set(['cached', 'key', 'slice', 'x', 'y', 'question', 'answer', 'crop', 'region', 'contextFingerprint']), envelope);
  const { cached: _cached, ...entryPayload } = payload;
  return {
    cached: booleanField(payload, 'cached', envelope),
    ...normalizeAskFields(entryPayload, envelope),
  };
}

export function normalizeAskSidecar(value) {
  const envelope = 'ask-sidecar';
  const payload = objectValue(value, envelope);
  unexpected(payload, new Set(['slug', 'entries']), envelope);
  const slug = stringField(payload, 'slug', envelope);
  if (!Array.isArray(payload.entries)) throw new EnvelopeValidationError(envelope, 'entries_not_array');
  return { slug, entries: payload.entries.map((entry) => normalizeAskEntry(entry)) };
}

function stringArray(payload, key, envelope) {
  if (!Object.hasOwn(payload, key)) throw new EnvelopeValidationError(envelope, `${key}_missing`);
  const value = payload[key];
  if (!Array.isArray(value)) throw new EnvelopeValidationError(envelope, `${key}_not_array`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new EnvelopeValidationError(envelope, `${key}_${index}_not_string`);
    return item;
  });
}

function normalizeConsultFields(payload, envelope) {
  return {
    disclaimer: stringField(payload, 'disclaimer', envelope),
    provider: stringField(payload, 'provider', envelope),
    model: stringField(payload, 'model', envelope),
    impression: stringField(payload, 'impression', envelope, { allowEmpty: true }),
    ask_radiologist: stringArray(payload, 'ask_radiologist', envelope),
    limitations: stringField(payload, 'limitations', envelope, { allowEmpty: true }),
  };
}

export function normalizeConsultDocument(value) {
  const envelope = 'consult-document';
  const payload = objectValue(value, envelope);
  unexpected(payload, new Set(['disclaimer', 'provider', 'model', 'impression', 'ask_radiologist', 'limitations']), envelope);
  return normalizeConsultFields(payload, envelope);
}

export function normalizeConsultResult(value) {
  const envelope = 'consult-result';
  const payload = objectValue(value, envelope);
  unexpected(payload, new Set(['cached', 'disclaimer', 'provider', 'model', 'impression', 'ask_radiologist', 'limitations']), envelope);
  const { cached: _cached, ...documentPayload } = payload;
  return {
    cached: booleanField(payload, 'cached', envelope),
    ...normalizeConsultFields(documentPayload, envelope),
  };
}
