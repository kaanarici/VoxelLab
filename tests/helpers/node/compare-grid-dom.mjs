function paneContext(record) {
  return {
    createImageData(width, height) {
      record.created.push({ width, height });
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image, x = 0, y = 0) {
      record.puts.push({ image, x, y });
    },
    clearRect() {},
    drawImage() {},
    save() {},
    restore() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    fillText(text) { record.labelsDrawn.push(text); },
  };
}

function paneCanvas(record) {
  const context = paneContext(record);
  return {
    style: {},
    width: 0,
    height: 0,
    addEventListener() {},
    getContext: () => context,
  };
}

function gridCell(record, { slug, name = slug }) {
  const canvas = paneCanvas(record);
  const label = { textContent: name };
  const classes = new Set();
  return {
    className: '',
    dataset: { slug },
    canvas,
    label,
    classes,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener() {},
    querySelector(selector) {
      if (selector === 'canvas') return canvas;
      if (selector === '.cmp-lbl') return label;
      return null;
    },
  };
}

export function installCompareGridDom(specs = [], { webgl2 = null } = {}) {
  const previousDocument = globalThis.document;
  const previousWebGL2 = globalThis.WebGL2RenderingContext;
  const record = { puts: [], created: [], labelsDrawn: [], offscreenContextTypes: [] };
  const declared = specs.map(spec => (typeof spec === 'string' ? { slug: spec } : spec));
  const cells = declared.map(spec => gridCell(record, spec));
  const host = {
    innerHTML: '',
    querySelectorAll(selector) {
      if (selector === '.cmp-cell') return cells;
      if (selector === '.cmp-cell canvas') return cells.map(cell => cell.canvas);
      return [];
    },
    appendChild(node) { cells.push(node); },
  };

  if (webgl2 !== null) globalThis.WebGL2RenderingContext = webgl2;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return gridCell(record, { slug: '' });
      return {
        width: 0,
        height: 0,
        getContext(type) {
          record.offscreenContextTypes.push(type);
          if (type === 'webgl2') return null;
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x, _y, width, height) {
              return { data: new Uint8ClampedArray(width * height * 4) };
            },
          };
        },
      };
    },
    getElementById(id) { return id === 'cmp-grid' ? host : null; },
  };

  return {
    host,
    cells,
    record,
    get paintCount() { return record.puts.length; },
    get webgl2Requests() { return record.offscreenContextTypes.filter(type => type === 'webgl2').length; },
    labelText(slug) { return cells.find(cell => cell.dataset.slug === slug)?.label.textContent; },
    restore() {
      globalThis.document = previousDocument;
      globalThis.WebGL2RenderingContext = previousWebGL2;
    },
  };
}

export function emptyCompareGridDom(options = {}) {
  const grid = installCompareGridDom([], options);
  grid.cells.length = 0;
  return grid;
}
