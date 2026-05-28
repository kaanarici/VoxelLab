import { normalizeLengthUnit } from './physical-units.js';

function decodeXmlAttr(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function attrsFromText(text) {
  const attrs = {};
  for (const item of String(text || '').matchAll(/([A-Za-z0-9_:.-]+)="([^"]*)"/g)) {
    attrs[item[1]] = decodeXmlAttr(item[2]);
  }
  return attrs;
}

function byteHex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0').toUpperCase();
}

export function omeRgbaColorToHex(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^#[0-9A-Fa-f]{6}$/.test(raw)) return raw.toUpperCase();
  const numeric = /^#[0-9A-Fa-f]{8}$/.test(raw)
    ? Number.parseInt(raw.replace(/^#/, ''), 16)
    : Number(raw);
  if (!Number.isFinite(numeric)) return null;
  const rgba = numeric >>> 0;
  return `#${byteHex((rgba >>> 24) & 0xff)}${byteHex((rgba >>> 16) & 0xff)}${byteHex((rgba >>> 8) & 0xff)}`;
}

export function omeChannelMetadata(description = '') {
  return [...String(description || '').matchAll(/<Channel\b([^>]*)>/gi)].map((match, index) => {
    const attrs = attrsFromText(match[1]);
    return {
      index,
      name: attrs.Name || attrs.ID || `Channel ${index + 1}`,
      // OME Channel/@Color is a signed 32-bit RGBA integer; schema default -1 is solid white.
      // https://www.openmicroscopy.org/Schemas/Documentation/Generated/OME-2016-06/ome_xsd.html#Channel_Color
      color: omeRgbaColorToHex(attrs.Color === undefined ? '-1' : attrs.Color),
      emissionWavelength: Number(attrs.EmissionWavelength) || null,
      emissionWavelengthUnit: normalizeLengthUnit(attrs.EmissionWavelengthUnit || 'nm'),
    };
  });
}
