// Capture 2D / MPR / compare / 3D views as downloadable rendered images.
import { state } from './core/state.js';
import { $ } from './dom.js';
import { lengthUnitToMm, normalizeLengthUnit } from './core/physical-units.js';
import { microscopySourceWarningsText } from './microscopy/microscopy-provenance-text.js';
import { getThreeRuntime } from './runtime/viewer-runtime.js';
import { calibratedScaleBarModel } from './overlay/scale-bar.js';

const SVG_EXPORT_STYLE_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'paint-order',
  'text-anchor',
  'vector-effect',
];

function inlineSvgExportStyles(source, clone) {
  const sourceNodes = [source, ...source.querySelectorAll('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll('*')];
  sourceNodes.forEach((sourceNode, index) => {
    const target = cloneNodes[index];
    if (!target) return;
    const style = window.getComputedStyle(sourceNode);
    for (const property of SVG_EXPORT_STYLE_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (value) target.style.setProperty(property, value);
    }
  });
  clone.querySelectorAll('.roi-del-bg,.roi-del-x,.roi-del-hit,.m-del-bg,.m-del-x,.m-del-hit')
    .forEach(node => node.remove());
}

async function compose2DScreenshotCanvas() {
  const src = $('view');
  const series = state.manifest?.series?.[state.seriesIdx];
  const W = src.width;
  const H = src.height;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const svg = $('overlay-svg');
  if (svg && svg.children.length > 0) {
    const clone = svg.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', W);
    clone.setAttribute('height', H);
    clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
    inlineSvgExportStyles(svg, clone);
    const xml = new XMLSerializer().serializeToString(clone);
    const b64 = btoa(unescape(encodeURIComponent(xml)));
    const url = `data:image/svg+xml;base64,${b64}`;
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, W, H);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    });
  }
  drawScreenshotScaleBar(ctx, series, W, H);
  drawScreenshotContextLabel(ctx, series, state.sliceIdx, W, H);

  return out;
}

export function screenshot2DContextLabel(series, sliceIdx) {
  if (series?.imageDomain !== 'microscopy') return '';
  const microscopy = series.microscopy || {};
  const z = `Z ${Number(sliceIdx) + 1}`;
  const channel = Number.isFinite(Number(microscopy.channelIndex)) ? Number(microscopy.channelIndex) + 1 : 1;
  const channelName = String(microscopy.channelName || '').trim();
  const channelText = channelName ? `C${channel} ${channelName}` : `C${channel}`;
  const time = Number.isFinite(Number(microscopy.timeIndex)) ? Number(microscopy.timeIndex) + 1 : 1;
  return `${z} · ${channelText} · T${time}`;
}

export function screenshot2DSuffix(series, sliceIdx) {
  const z = `z${Number(sliceIdx) + 1}`;
  if (series?.imageDomain !== 'microscopy') return z;
  const microscopy = series.microscopy || {};
  const channel = Number.isFinite(Number(microscopy.channelIndex)) ? Number(microscopy.channelIndex) + 1 : 1;
  const time = Number.isFinite(Number(microscopy.timeIndex)) ? Number(microscopy.timeIndex) + 1 : 1;
  return `${z}_c${channel}_t${time}`;
}

export function drawScreenshotContextLabel(ctx, series, sliceIdx, width, height) {
  const label = screenshot2DContextLabel(series, sliceIdx);
  if (!ctx || !label || !(width > 0) || !(height > 0) || height < 32) return '';
  const margin = Math.max(8, Math.min(18, Math.round(Math.min(width, height) * 0.08)));
  ctx.save();
  ctx.font = '12px "SF Mono", Monaco, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const padX = 7;
  const padY = 5;
  const textWidth = Math.ceil(ctx.measureText(label).width);
  const boxWidth = Math.min(width - margin * 2, textWidth + padX * 2);
  const boxHeight = 22;
  if (boxWidth > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.86)';
    ctx.fillRect(margin, margin, boxWidth, boxHeight);
    ctx.strokeStyle = 'rgba(255,255,255,0.72)';
    ctx.lineWidth = 1;
    ctx.strokeRect(margin + 0.5, margin + 0.5, boxWidth - 1, boxHeight - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fillText(label, margin + padX, margin + padY, Math.max(0, boxWidth - padX * 2));
  }
  ctx.restore();
  return label;
}

export function drawScreenshotScaleBar(ctx, series, width, height) {
  if (!ctx || !series || !(width > 0) || !(height > 0)) return null;
  const model = calibratedScaleBarModel(series, {
    canvasCssWidth: width,
    imageWidth: series.width || width,
    zoom: 1,
  });
  const margin = Math.max(8, Math.min(18, Math.round(Math.min(width, height) * 0.08)));
  if (!model || model.widthPx > width - margin * 2 || height < 48) return null;

  const x2 = width - margin;
  const x1 = x2 - model.widthPx;
  const y = height - margin;
  ctx.save();
  ctx.font = '12px "SF Mono", Monaco, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.78)';
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.strokeText(model.label, x2, y - 7);
  ctx.fillText(model.label, x2, y - 7);
  ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.moveTo(x1, y - 6);
  ctx.lineTo(x1, y + 1);
  ctx.moveTo(x2, y - 6);
  ctx.lineTo(x2, y + 1);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.96)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.moveTo(x1, y - 6);
  ctx.lineTo(x1, y + 1);
  ctx.moveTo(x2, y - 6);
  ctx.lineTo(x2, y + 1);
  ctx.stroke();
  ctx.restore();
  return model;
}

function writeTiffEntry(view, offset, tag, type, count, value) {
  view.setUint16(offset, tag, true);
  view.setUint16(offset + 2, type, true);
  view.setUint32(offset + 4, count, true);
  if (type === 3 && count === 1) view.setUint16(offset + 8, value, true);
  else view.setUint32(offset + 8, value, true);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function reducedRational(value) {
  const denominator = 1_000_000;
  const numerator = Math.max(1, Math.round(value * denominator));
  let a = numerator;
  let b = denominator;
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  const gcd = a || 1;
  return [numerator / gcd, denominator / gcd];
}

function writeTiffRational(view, offset, value) {
  const [numerator, denominator] = reducedRational(value);
  view.setUint32(offset, numerator, true);
  view.setUint32(offset + 4, denominator, true);
}

function imageJUnit(unit = 'µm') {
  const normalized = normalizeLengthUnit(unit);
  return normalized === 'µm' ? 'um' : normalized;
}

function formatMetadataNumber(value) {
  return Number(value).toPrecision(12).replace(/\.?0+$/u, '');
}

export function renderedTiffSnapshotMetadata(series = {}, sliceIdx = 0) {
  if (series?.imageDomain !== 'microscopy') return null;
  const rowMm = positiveNumber(series.pixelSpacing?.[0]);
  const colMm = positiveNumber(series.pixelSpacing?.[1]);
  const unit = normalizeLengthUnit(series.microscopy?.physicalUnit || series.physicalUnit || 'µm');
  const unitMm = lengthUnitToMm(unit);
  if (!rowMm || !colMm || !(unitMm > 0)) return null;
  const pixelWidth = colMm / unitMm;
  const pixelHeight = rowMm / unitMm;
  const zMm = positiveNumber(series.sliceThickness || series.sliceSpacing || series.microscopy?.physicalSizeZMm);
  const sourceWarnings = microscopySourceWarningsText(series);
  const description = [
    'ImageJ=1.54',
    'images=1',
    `unit=${imageJUnit(unit)}`,
    `pixel_width=${formatMetadataNumber(pixelWidth)}`,
    `pixel_height=${formatMetadataNumber(pixelHeight)}`,
    zMm ? `spacing=${formatMetadataNumber(zMm / unitMm)}` : '',
    sourceWarnings === 'None' ? '' : `source_warnings=${sourceWarnings}`,
    `label=${screenshot2DContextLabel(series, sliceIdx) || 'VoxelLab rendered snapshot'}`,
  ].filter(Boolean).join('\n');
  return {
    description,
    xResolution: 1 / pixelWidth,
    yResolution: 1 / pixelHeight,
  };
}

export function encodeRenderedRgbTiff({ width, height, data, metadata = null }) {
  const W = Math.max(0, Math.floor(Number(width) || 0));
  const H = Math.max(0, Math.floor(Number(height) || 0));
  const rgba = data instanceof Uint8ClampedArray || data instanceof Uint8Array ? data : null;
  if (!(W > 0) || !(H > 0) || !rgba || rgba.length < W * H * 4) return null;
  const description = metadata?.description ? new TextEncoder().encode(`${metadata.description}\0`) : null;
  const xResolution = positiveNumber(metadata?.xResolution);
  const yResolution = positiveNumber(metadata?.yResolution);
  const hasResolution = xResolution && yResolution;
  const entryCount = 10 + (description ? 1 : 0) + (hasResolution ? 3 : 0);
  const ifdOffset = 8;
  const ifdSize = 2 + entryCount * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const descriptionOffset = bitsOffset + 6;
  const xResolutionOffset = descriptionOffset + (description?.length || 0);
  const yResolutionOffset = xResolutionOffset + (hasResolution ? 8 : 0);
  const pixelOffset = yResolutionOffset + (hasResolution ? 8 : 0);
  const pixelBytes = W * H * 3;
  const bytes = new Uint8Array(pixelOffset + pixelBytes);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);
  let entryOffset = ifdOffset + 2;
  const entry = (tag, type, count, value) => {
    writeTiffEntry(view, entryOffset, tag, type, count, value);
    entryOffset += 12;
  };
  entry(256, 4, 1, W);
  entry(257, 4, 1, H);
  entry(258, 3, 3, bitsOffset);
  entry(259, 3, 1, 1);
  entry(262, 3, 1, 2);
  if (description) entry(270, 2, description.length, descriptionOffset);
  entry(273, 4, 1, pixelOffset);
  entry(277, 3, 1, 3);
  entry(278, 4, 1, H);
  entry(279, 4, 1, pixelBytes);
  entry(284, 3, 1, 1);
  if (hasResolution) {
    entry(282, 5, 1, xResolutionOffset);
    entry(283, 5, 1, yResolutionOffset);
    entry(296, 3, 1, 1);
  }
  view.setUint32(entryOffset, 0, true);
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  if (description) bytes.set(description, descriptionOffset);
  if (hasResolution) {
    writeTiffRational(view, xResolutionOffset, xResolution);
    writeTiffRational(view, yResolutionOffset, yResolution);
  }
  let dst = pixelOffset;
  for (let src = 0; src < W * H * 4; src += 4) {
    bytes[dst] = rgba[src];
    bytes[dst + 1] = rgba[src + 1];
    bytes[dst + 2] = rgba[src + 2];
    dst += 3;
  }
  return bytes;
}

function bytesToDataUrl(bytes, mimeType) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function canvasToRenderedTiffDataUrl(canvas, metadata = null) {
  const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
  if (!canvas?.width || !canvas?.height || !ctx) return '';
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = encodeRenderedRgbTiff({
    width: image.width,
    height: image.height,
    data: image.data,
    metadata,
  });
  return bytes ? bytesToDataUrl(bytes, 'image/tiff') : '';
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve) => {
    if (!canvas?.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(blob => resolve(blob), type);
  });
}

export async function capture2DScreenshotPngBlob() {
  if (state.mode !== '2d') return null;
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) return null;
  const canvas = await compose2DScreenshotCanvas();
  const blob = await canvasToBlob(canvas, 'image/png');
  if (!blob) return null;
  return {
    blob,
    filename: `${series.slug}_${screenshot2DSuffix(series, state.sliceIdx)}.png`,
    contextLabel: screenshot2DContextLabel(series, state.sliceIdx),
  };
}

export async function takeScreenshot(format = 'png') {
  const series = state.manifest.series[state.seriesIdx];
  const slug = series.slug;
  const mode = state.mode;
  let dataUrl = null;
  let suffix = '';
  let extension = 'png';
  const three = getThreeRuntime();

  if (mode === '3d' && three.renderer) {
    if (format === 'tiff') return false;
    const r = three.renderer;
    r.render(three.scene, three.camera);
    dataUrl = r.domElement.toDataURL('image/png');
    suffix = '3d';
  } else if (mode === 'mpr') {
    const ax = $('mpr-ax');
    const co = $('mpr-co');
    const sa = $('mpr-sa');
    const H = Math.max(ax.height, co.height, sa.height);
    const W = ax.width + co.width + sa.width + 20;
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, W, H);
    octx.drawImage(ax, 0, (H - ax.height) / 2);
    octx.drawImage(co, ax.width + 10, (H - co.height) / 2);
    octx.drawImage(sa, ax.width + co.width + 20, (H - sa.height) / 2);
    const zFrac = state.mprZ / Math.max(1, series.slices - 1);
    drawScreenshotCrosshair(octx, 0, (H - ax.height) / 2, ax.width, ax.height, state.mprX, state.mprY);
    drawScreenshotCrosshair(octx, ax.width + 10, (H - co.height) / 2, co.width, co.height, state.mprX, (1 - zFrac) * (co.height - 1));
    drawScreenshotCrosshair(
      octx,
      ax.width + co.width + 20,
      (H - sa.height) / 2,
      sa.width,
      sa.height,
      state.mprY * (sa.width - 1) / Math.max(1, series.height - 1),
      (1 - zFrac) * (sa.height - 1),
    );
    dataUrl = format === 'tiff' ? canvasToRenderedTiffDataUrl(out) : out.toDataURL('image/png');
    extension = format === 'tiff' ? 'tif' : 'png';
    suffix = `mpr_z${state.mprZ + 1}`;
  } else if (mode === 'cmp') {
    const cells = document.querySelectorAll('#cmp-grid canvas');
    if (!cells.length) return;
    let maxW = 0;
    let maxH = 0;
    cells.forEach((c) => {
      maxW = Math.max(maxW, c.width);
      maxH = Math.max(maxH, c.height);
    });
    const cols = 2;
    const rows = Math.ceil(cells.length / 2);
    const gap = 10;
    const out = document.createElement('canvas');
    out.width = cols * maxW + (cols - 1) * gap;
    out.height = rows * maxH + (rows - 1) * gap;
    const octx = out.getContext('2d');
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, out.width, out.height);
    cells.forEach((c, i) => {
      const r = Math.floor(i / cols);
      const col = i % cols;
      octx.drawImage(
        c,
        col * (maxW + gap) + (maxW - c.width) / 2,
        r * (maxH + gap) + (maxH - c.height) / 2,
      );
    });
    dataUrl = format === 'tiff' ? canvasToRenderedTiffDataUrl(out) : out.toDataURL('image/png');
    extension = format === 'tiff' ? 'tif' : 'png';
    suffix = `compare_z${state.sliceIdx + 1}`;
  } else {
    const canvas = await compose2DScreenshotCanvas();
    const metadata = format === 'tiff' ? renderedTiffSnapshotMetadata(series, state.sliceIdx) : null;
    dataUrl = format === 'tiff' ? canvasToRenderedTiffDataUrl(canvas, metadata) : canvas.toDataURL('image/png');
    extension = format === 'tiff' ? 'tif' : 'png';
    suffix = screenshot2DSuffix(series, state.sliceIdx);
  }

  if (!dataUrl) return;
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${slug}_${suffix}.${extension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
}

function drawScreenshotCrosshair(ctx, x, y, w, h, cx, cy) {
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + cy + 0.5); ctx.lineTo(x + w, y + cy + 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + cx + 0.5, y); ctx.lineTo(x + cx + 0.5, y + h); ctx.stroke();
}
