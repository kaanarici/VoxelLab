export function createCanvasStub({ dataUrl = '' } = {}) {
  const puts = [];
  const created = [];
  const context = {
    puts,
    created,
    createImageData(width, height) {
      created.push({ width, height });
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image, x = 0, y = 0) {
      puts.push({ image, x, y });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    context,
    puts,
    getContext() { return context; },
    get lastImageData() { return puts.at(-1)?.image ?? null; },
  };
  if (dataUrl) canvas.toDataURL = () => dataUrl;
  return canvas;
}

export function installCanvasDocument({ dataUrl = '', extraGlobals = {} } = {}) {
  const previousDocument = globalThis.document;
  const previousExtras = Object.fromEntries(
    Object.keys(extraGlobals).map(name => [name, globalThis[name]]),
  );
  const canvases = [];
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      const canvas = createCanvasStub({ dataUrl });
      canvases.push(canvas);
      return canvas;
    },
  };
  Object.assign(globalThis, extraGlobals);
  return {
    canvases,
    get lastCanvas() { return canvases.at(-1) ?? null; },
    restore() {
      globalThis.document = previousDocument;
      Object.assign(globalThis, previousExtras);
    },
  };
}

export async function withCanvasDocument(fn, options = {}) {
  const stub = installCanvasDocument(options);
  try {
    return await fn(stub);
  } finally {
    stub.restore();
  }
}
