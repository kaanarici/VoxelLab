import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installCompareGridDom } from './helpers/node/compare-grid-dom.mjs';
import { installViewerGlobals } from './helpers/node/viewer-globals.mjs';
import { nextTask } from './helpers/node/wait.mjs';

const { storage } = installViewerGlobals();
installCompareGridDom();

const { buildCompareGrid, drawCompare, getGroupPeers, loadComparePeers } = await import('../js/series/compare.js');
const { state } = await import('../js/core/state.js');
const { OVERLAY_CACHE_BY_KIND } = await import('../js/runtime/overlay-cache-keys.js');
const { createLocalByteSlice } = await import('../js/series/local-byte-slice.js');
const { setNoteEntriesForSlice } = await import('../js/overlay/annotation-graph.js');
const { loadRegistrationData } = await import('../js/metadata.js');

test('loadComparePeers reuses in-memory local stacks for compare mode peers', async () => {
  state.manifest = {
    series: [
      { slug: 'local_a', group: 'for-1', slices: 2, hasBrain: false, hasSeg: false, hasRegions: false },
      { slug: 'local_b', group: 'for-1', slices: 2, hasBrain: false, hasSeg: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.cmpStacks = {};
  const localA = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  const localB = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  state._localStacks = { local_a: localA, local_b: localB };

  await loadComparePeers();

  assert.equal(state.cmpStacks.local_a, localA);
  assert.equal(state.cmpStacks.local_b, localB);
  assert.equal(state.cmpStacks.local_a._dir, 'local_a');
  assert.equal(state.cmpStacks.local_b._dir, 'local_b');
});

test('loadComparePeers normalizes legacy numeric groups to canonical patient-space groups', async () => {
  state.manifest = {
    series: [
      {
        slug: 'legacy_manifest',
        group: 0,
        frameOfReferenceUID: '1.2.840.same',
        slices: 2,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasRegions: false,
      },
      {
        slug: 'local_import',
        frameOfReferenceUID: '1.2.840.same',
        slices: 2,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.overlays.useBrain = false;
  state.cmpStacks = {};
  const legacy = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  const local = [{ complete: true, naturalWidth: 4 }, { complete: true, naturalWidth: 4 }];
  state._localStacks = { legacy_manifest: legacy, local_import: local };

  await loadComparePeers();

  assert.equal(state.cmpStacks.legacy_manifest, legacy);
  assert.equal(state.cmpStacks.local_import, local);
});

test('compare grouping ignores legacy groups on invalid stack geometry', () => {
  state.manifest = {
    series: [
      {
        slug: 'bad_primary',
        group: 'legacy-for',
        frameOfReferenceUID: '1.2.bad',
        frameOfReferenceUIDConsistent: false,
        slices: 3,
        firstIPP: [0, 0, 0],
        orientation: [1, 0, 0, 0, 1, 0],
      },
      {
        slug: 'bad_peer',
        group: 'legacy-for',
        frameOfReferenceUID: '1.2.bad',
        slicePositionsDistinct: false,
        slices: 3,
        sliceSpacingStats: { min: 0, mean: 0.5, max: 1, regular: false },
        firstIPP: [0, 0, 0],
        orientation: [1, 0, 0, 0, 1, 0],
      },
    ],
  };
  state.seriesIdx = 0;
  state.cmpManualSlugs = null;

  assert.deepEqual(getGroupPeers(), []);
});

test('loadComparePeers only loads the visible slice window for remote peers', async (t) => {
  const previousImage = globalThis.Image;
  let created = 0;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      created++;
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  state.manifest = {
    series: [
      { slug: 'peer_a', group: 'for-2', slices: 20, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'peer_b', group: 'for-2', slices: 20, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 10;
  state.overlays.useBrain = false;
  state.overlays.tissue = false;
  state.overlays.heatmap = false;
  state.overlays.labels = false;
  state.cmpStacks = {};
  state._localStacks = {};

  await loadComparePeers();

  assert.equal(created, 22);
  assert.equal(state.cmpStacks.peer_a.filter(Boolean).length, 11);
  assert.equal(state.cmpStacks.peer_b.filter(Boolean).length, 11);
});

test('loadComparePeers warms the visible window when compare stacks already exist', async (t) => {
  const previousImage = globalThis.Image;
  let created = 0;

  t.after(() => {
    globalThis.Image = previousImage;
  });

  globalThis.Image = class {
    set src(value) {
      this._src = value;
      created++;
      this.complete = true;
      this.naturalWidth = 1;
      queueMicrotask(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  };

  state.manifest = {
    series: [
      { slug: 'peer_seg_a', group: 'for-3', slices: 20, hasBrain: false, hasSeg: true, hasSym: false, hasRegions: false },
      { slug: 'peer_seg_b', group: 'for-3', slices: 20, hasBrain: false, hasSeg: true, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 10;
  state.overlays.useBrain = false;
  state.overlays.tissue = true;
  state.overlays.heatmap = false;
  state.overlays.labels = false;
  state.cmpStacks = {};
  state._localStacks = {};

  await loadComparePeers();
  assert.equal(created, 44, 'base + seg overlays should load the visible window on first entry');

  state.sliceIdx = 19;
  await loadComparePeers();
  assert.equal(created, 60, 'existing compare stacks should still fetch the new visible base+overlay window');
});

test('drawCompare applies one linked viewport transform to every compare pane canvas', (t) => {
  const grid = installCompareGridDom();
  t.after(grid.restore);
  const cells = grid.cells;

  state.manifest = {
    series: [
      { slug: 'cmp_a', name: 'A', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [2, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'cmp_b', name: 'B', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [2, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.compare = { viewport: { zoom: 2, tx: 12, ty: -6 } };
  state.cmpStacks = {
    cmp_a: [{ complete: true, naturalWidth: 1 }],
    cmp_b: [{ complete: true, naturalWidth: 1 }],
  };

  buildCompareGrid();
  drawCompare();

  assert.equal(cells.length, 2);
  for (const cell of cells) {
    assert.equal(cell.canvas.style.transform, 'translate(12px, -6px) scale(2)');
    assert.equal(cell.canvas.style.transformOrigin, '50% 50%');
    assert.equal(cell.canvas.style.width, '1px');
    assert.equal(cell.canvas.style.height, '2px');
  }
});

test('drawCompare renders notes for its peer series instead of the active series', (t) => {
  storage.clear();
  const grid = installCompareGridDom(['cmp_note_peer']);
  t.after(grid.restore);

  state.manifest = {
    series: [
      { slug: 'cmp_note_active', seriesUID: 'active-series', name: 'Active', group: 'cmpn', slices: 1, width: 32, height: 32, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'cmp_note_peer', seriesUID: 'peer-series', name: 'Note Peer', group: 'cmpn', slices: 1, width: 32, height: 32, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = { cmp_note_peer: [{ complete: true, naturalWidth: 32 }] };
  setNoteEntriesForSlice(state, state.manifest.series[1], 0, [{ id: 1, x: 8, y: 9, text: 'compare note' }]);

  drawCompare();

  assert.equal(grid.record.labelsDrawn.length, 1);
});

test('drawCompare keeps no-overlay peers on the direct grayscale path', (t) => {
  const grid = installCompareGridDom(['cmp_direct'], { webgl2: class {} });
  t.after(grid.restore);

  {
    state.manifest = {
      series: [
        { slug: 'cmp_direct', name: 'Direct', group: 'cmpd', slices: 1, width: 2, height: 2, hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      ],
    };
    state.seriesIdx = 0;
    state.sliceIdx = 0;
    state.window = 255;
    state.level = 127.5;
    state.colormap = 'grayscale';
    state.overlays.useBrain = false;
    state.overlays.tissue = false;
    state.overlays.heatmap = false;
    state.overlays.labels = false;
    state.overlays.fusionSlug = '';
    state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
    state.cmpStacks = {
      cmp_direct: [{ complete: true, naturalWidth: 2, _bytes: Uint8Array.from([0, 64, 128, 255]) }],
    };

    drawCompare();
  }

  assert.equal(grid.paintCount, 1);
  assert.equal(grid.webgl2Requests, 0);
});

test('drawCompare maps peer slices in patient space instead of raw index space', (t) => {
  const grid = installCompareGridDom([
    { slug: 'primary_cmp', name: 'Primary' },
    { slug: 'peer_cmp', name: 'Peer' },
  ]);
  t.after(grid.restore);
  const cells = grid.cells;

  state.manifest = {
    series: [
      {
        slug: 'primary_cmp',
        name: 'Primary',
        frameOfReferenceUID: '1.2.3',
        slices: 4,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
      {
        slug: 'peer_cmp',
        name: 'Peer',
        frameOfReferenceUID: '1.2.3',
        slices: 2,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 3,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 1;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {
    primary_cmp: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([16]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([32]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([48]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([64]) },
    ],
    peer_cmp: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([96]) },
      undefined,
    ],
  };

  drawCompare();

  assert.equal(grid.paintCount, 2, 'peer should render its geometry-matched slice rather than a missing raw index');
  assert.equal(cells[1].label.textContent, 'Peer');
});

test('drawCompare adds registration verdicts to peer labels when sidecar data is loaded', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      reference: 'primary_reg',
      pairs: {
        peer_reg: {
          translation_magnitude_mm: 3.246,
          dice: 0.82,
          verdict: 'slightly off',
        },
      },
    }),
  });
  await loadRegistrationData();
  globalThis.fetch = previousFetch;

  const grid = installCompareGridDom([
    { slug: 'primary_reg', name: 'Primary' },
    { slug: 'peer_reg', name: 'Peer' },
  ]);
  t.after(grid.restore);
  const cells = grid.cells;

  state.manifest = {
    series: [
      { slug: 'primary_reg', name: 'Primary', group: 'reg', slices: 1, width: 1, height: 1, pixelSpacing: [1, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'peer_reg', name: 'Peer', group: 'reg', slices: 1, width: 1, height: 1, pixelSpacing: [1, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {
    primary_reg: [{ complete: true, naturalWidth: 1, _bytes: Uint8Array.from([16]) }],
    peer_reg: [{ complete: true, naturalWidth: 1, _bytes: Uint8Array.from([32]) }],
  };

  drawCompare();

  assert.equal(grid.paintCount, 2);
  assert.equal(cells[0].label.textContent, 'Primary');
  assert.equal(cells[1].label.textContent, 'Peer · slightly off · reported displacement 3.25 mm');

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      reference: 'different_primary',
      pairs: {
        peer_reg: {
          translation_magnitude_mm: 1.714,
          verdict: 'slightly off',
        },
      },
    }),
  });
  await loadRegistrationData();
  globalThis.fetch = previousFetch;
  drawCompare();
  assert.equal(cells[1].label.textContent, 'Peer');
});

test('drawCompare marks peers out of range instead of clamping to the wrong anatomy', (t) => {
  const grid = installCompareGridDom([
    { slug: 'primary_far', name: 'Primary' },
    { slug: 'peer_far', name: 'Peer' },
  ]);
  t.after(grid.restore);
  const cells = grid.cells;

  state.manifest = {
    series: [
      {
        slug: 'primary_far',
        name: 'Primary',
        frameOfReferenceUID: '1.2.4',
        slices: 4,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 3],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
      {
        slug: 'peer_far',
        name: 'Peer',
        frameOfReferenceUID: '1.2.4',
        slices: 2,
        width: 1,
        height: 1,
        pixelSpacing: [1, 1],
        sliceSpacing: 1,
        firstIPP: [0, 0, 0],
        lastIPP: [0, 0, 1],
        orientation: [1, 0, 0, 0, 1, 0],
        hasBrain: false,
        hasSeg: false,
        hasSym: false,
        hasRegions: false,
      },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 3;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {
    primary_far: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([16]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([32]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([48]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([64]) },
    ],
    peer_far: [
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([96]) },
      { complete: true, naturalWidth: 1, _bytes: Uint8Array.from([112]) },
    ],
  };

  drawCompare();

  assert.equal(grid.paintCount, 1, 'only the primary slice should render when the peer has no nearby plane');
  assert.equal(cells[1].label.textContent, 'Peer · out of range');
  assert.equal(cells[1].classes.has('out-of-range'), true);
});

test('drawCompare does not refetch a failed compare stack in a loop', async (t) => {
  const grid = installCompareGridDom();
  t.after(grid.restore);

  let ensureCalls = 0;
  const failedStack = () => {
    const stack = [{ complete: true, naturalWidth: 0 }];
    stack.ensureIndex = async () => {
      ensureCalls += 1;
      return null;
    };
    return stack;
  };

  state.manifest = {
    series: [
      { slug: 'cmp_a', name: 'A', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [1, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
      { slug: 'cmp_b', name: 'B', group: 'cmp', slices: 1, width: 1, height: 1, pixelSpacing: [1, 1], hasBrain: false, hasSeg: false, hasSym: false, hasRegions: false },
    ],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = 'cmp';
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = { cmp_a: failedStack(), cmp_b: failedStack() };

  buildCompareGrid();
  drawCompare();
  drawCompare();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ensureCalls, 0);
});

function tableOverlayCaches() {
  return Object.values(OVERLAY_CACHE_BY_KIND).filter((cache) => !cache.refuseInOverlayStack);
}

function installSingleCellCompareHost(t, slug) {
  const grid = installCompareGridDom([slug]);
  t.after(grid.restore);
  return grid;
}

test('ensureCompareCurrentSlice asks every table overlay stack for the current slice', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ colors: { 1: [255, 0, 0] }, regions: { 1: { name: 'Cortex' } } }),
  });

  const slug = 'cmp_table_ensure';
  const slice = () => createLocalByteSlice(Uint8Array.from([32]), 1, 1);
  state.manifest = {
    series: [{
      slug,
      name: 'Table',
      group: 'tbl',
      slices: 1,
      width: 1,
      height: 1,
      hasBrain: false,
      hasSeg: true,
      hasSym: true,
      hasRegions: true,
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = 'cmp';
  state.overlays.useBrain = false;
  state.overlays.tissue = true;
  state.overlays.heatmap = true;
  state.overlays.labels = true;
  state.overlays.fusionSlug = '';
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {};
  state._localStacks = { [slug]: [slice()] };
  for (const cache of tableOverlayCaches()) {
    state._localStacks[`${slug}_${cache.type}`] = [slice()];
  }

  try {
    await loadComparePeers();
    const ensureCalls = {};
    for (const cache of tableOverlayCaches()) {
      const stack = state._localStacks[`${slug}_${cache.type}`];
      stack[0] = { complete: false, naturalWidth: 0 };
      stack.ensureIndex = () => {
        ensureCalls[cache.type] = (ensureCalls[cache.type] || 0) + 1;
        return Promise.resolve(true);
      };
    }
    installSingleCellCompareHost(t, slug);
    drawCompare();
    assert.deepEqual(
      Object.fromEntries(tableOverlayCaches().map((cache) => [cache.type, ensureCalls[cache.type]])),
      Object.fromEntries(tableOverlayCaches().map((cache) => [cache.type, 1])),
    );

    state.mode = '2d';
    await nextTask();
    assert.deepEqual(
      Object.fromEntries(tableOverlayCaches().map((cache) => [cache.type, ensureCalls[cache.type]])),
      Object.fromEntries(tableOverlayCaches().map((cache) => [cache.type, 1])),
      'leaving compare mode must stop the deferred redraw from re-requesting slices',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('drawCompare paints every table overlay kind', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWebGL2 = globalThis.WebGL2RenderingContext;
  globalThis.WebGL2RenderingContext = class {};
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ colors: { 1: [255, 0, 0] }, regions: { 1: { name: 'Cortex' } } }),
  });

  const slug = 'cmp_table_paint';
  const base = () => createLocalByteSlice(Uint8Array.from([40]), 1, 1);
  const overlayBytes = {
    seg: Uint8Array.from([1]),
    sym: Uint8Array.from([255]),
    regions: Uint8Array.from([1]),
  };
  state.manifest = {
    series: [{
      slug,
      name: 'Paint',
      group: 'tblp',
      slices: 1,
      width: 1,
      height: 1,
      pixelSpacing: [1, 1],
      hasBrain: false,
      hasSeg: true,
      hasSym: true,
      hasRegions: true,
    }],
  };
  state.seriesIdx = 0;
  state.sliceIdx = 0;
  state.mode = 'cmp';
  state.window = 255;
  state.level = 127.5;
  state.colormap = 'grayscale';
  state.overlays.useBrain = false;
  state.overlays.fusionSlug = '';
  state.overlays.overlayOpacity = 1;
  state.compare = { viewport: { zoom: 1, tx: 0, ty: 0 } };
  state.cmpStacks = {};

  try {
    const painted = {};
    for (const cache of tableOverlayCaches()) {
      state.overlays.tissue = cache.kind === 'tissue';
      state.overlays.heatmap = cache.kind === 'heatmap';
      state.overlays.labels = cache.kind === 'labels';
      state._localStacks = { [slug]: [base()] };
      for (const entry of tableOverlayCaches()) {
        state._localStacks[`${slug}_${entry.type}`] = [
          createLocalByteSlice(overlayBytes[entry.type], 1, 1),
        ];
      }
      await loadComparePeers();
      const grid = installSingleCellCompareHost(t, slug);
      drawCompare();
      assert.equal(grid.paintCount, 1, `${cache.kind} should paint one compare slice`);
      painted[cache.kind] = [...grid.record.puts[0].image.data];
    }

    state.overlays.tissue = false;
    state.overlays.heatmap = false;
    state.overlays.labels = false;
    state._localStacks = { [slug]: [base()] };
    await loadComparePeers();
    const grayGrid = installSingleCellCompareHost(t, slug);
    drawCompare();
    const gray = [...grayGrid.record.puts[0].image.data];

    for (const cache of tableOverlayCaches()) {
      assert.notDeepEqual(painted[cache.kind], gray, `${cache.kind} overlay should change compare pixels`);
    }

    state.mode = '2d';
    await nextTask();
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.WebGL2RenderingContext = previousWebGL2;
  }
});
