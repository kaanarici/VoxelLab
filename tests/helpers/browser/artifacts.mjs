import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';

export const PIXEL = {
  roiBlue: (r, g, b) => r < 180 && g > 130 && b > 180,
  softRoiBlue: (r, g, b) => r < 170 && g > 160 && b > 190,
  bright: (r, g, b) => r > 230 && g > 230 && b > 230,
  nearWhite: (r, g, b) => r > 225 && g > 225 && b > 225,
  white: (r, g, b) => r > 235 && g > 235 && b > 235,
  pureWhite: (r, g, b) => r > 240 && g > 240 && b > 240,
  chromeBright: (r, g, b) => r > 220 && g > 220 && b > 220,
  dark: (r, g, b) => r < 55 && g < 55 && b < 55,
};

export function parseCsvRows(csv) {
  const [headerLine, ...lines] = csv.trim().split('\n');
  const header = headerLine.split(',');
  return lines.map(line => Object.fromEntries(line.split(',').map((cell, index) => [header[index], cell])));
}

export function wholeImage(image) {
  return { x0: 0, y0: 0, x1: image.width, y1: image.height };
}

export function countPixels(image, matcher, rect = null) {
  const { x0, y0, x1, y1 } = rect || wholeImage(image);
  const startX = Math.max(0, Math.floor(x0));
  const startY = Math.max(0, Math.floor(y0));
  const endX = Math.min(image.width, Math.ceil(x1));
  const endY = Math.min(image.height, Math.ceil(y1));
  let matches = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * image.width + x) * image.channels;
      if (matcher(image.data[offset], image.data[offset + 1], image.data[offset + 2])) matches += 1;
    }
  }
  return matches;
}

export async function readRenderedTiff(path) {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(8, true);
  const tags = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    const offset = 10 + i * 12;
    tags.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
    });
  }
  const rational = (tag) => {
    const offset = tags.get(tag).value;
    return view.getUint32(offset, true) / view.getUint32(offset + 4, true);
  };
  const pixelOffset = tags.get(273).value;
  const pixelByteCount = tags.get(279).value;
  const descriptionTag = tags.get(270);
  const description = new TextDecoder()
    .decode(bytes.subarray(descriptionTag.value, descriptionTag.value + descriptionTag.count))
    .replace(/\0$/u, '');
  return {
    magic: [bytes[0], bytes[1], view.getUint16(2, true)],
    width: tags.get(256).value,
    height: tags.get(257).value,
    compression: tags.get(259).value,
    photometric: tags.get(262).value,
    samplesPerPixel: tags.get(277).value,
    xResolution: rational(282),
    yResolution: rational(283),
    resolutionUnit: tags.get(296).value,
    pixelByteCount,
    description,
    channels: tags.get(277).value,
    data: bytes.subarray(pixelOffset, pixelOffset + pixelByteCount),
  };
}

export async function readPngImage(page, path) {
  const dataUrl = `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
  return readPngDataUrl(page, dataUrl);
}

export async function readPngDataUrl(page, dataUrl) {
  const decoded = await page.evaluate(async (source) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = source;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  }, dataUrl);
  return { ...decoded, channels: 4 };
}
