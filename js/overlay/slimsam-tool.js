import { state } from '../core/state.js';
import { $ } from '../dom.js';
import { notify, dismissNotify } from '../notify.js';
import { getSegmentationRecommendations, inferSegmentationStudy } from '../segmentation/segmentation-catalog.js';
import { overlayMask } from './slimsam-overlay.js';

const SETTINGS_KEY = 'voxellab/slimsam/settings/v1';

let _active = false;
let _drawSlice = () => {};
let _beforeActivate = () => {};
let _lastMask = null;
let _slimsam = null;
let _slimsamLoading = null;
let _slimsamManifest = null;
let _lastSlimSAMInfo = null;
let _settings = { opacity: 0.35, smooth: true };
let _selectSeries = null;

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (Number.isFinite(stored.opacity)) {
      _settings.opacity = Math.max(0.15, Math.min(0.75, stored.opacity));
    }
    if (typeof stored.smooth === 'boolean') _settings.smooth = stored.smooth;
  } catch { /* keep defaults */ }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings));
  } catch { /* ignore private-mode storage failures */ }
}

async function loadSlimSAM() {
  if (_slimsam) {
    syncSlimSAMManifest(_slimsam);
    return _slimsam;
  }
  if (!_slimsamLoading) {
    _slimsamLoading = import('./slimsam.js').then((mod) => {
      _slimsam = mod;
      syncSlimSAMManifest(mod);
      return mod;
    }).catch((error) => {
      _slimsamLoading = null;
      throw error;
    });
  }
  return _slimsamLoading;
}

function syncSlimSAMManifest(mod) {
  if (state.manifest && state.manifest !== _slimsamManifest) {
    mod.initSlimSAM(state.manifest);
    _slimsamManifest = state.manifest;
  }
}

export function initSlimSAMTool({ drawSlice, beforeActivate, selectSeries } = {}) {
  _drawSlice = drawSlice;
  _beforeActivate = typeof beforeActivate === 'function' ? beforeActivate : () => {};
  _selectSeries = typeof selectSeries === 'function' ? selectSeries : null;
  loadSettings();
  wireSlimSAMMenu();
  syncSlimSAMMenu();
}

export function isSlimSAMMode() { return _active; }

export function setSlimSAMMode(active) {
  _active = !!active;
  const btn = $('btn-slimsam');
  if (btn) {
    btn.classList.toggle('active', _active);
    btn.setAttribute?.('aria-pressed', String(_active));
  }
  if (!_active) {
    _lastMask = null;
    _drawSlice(); // clear mask overlay
  }
  syncSlimSAMMenu();
  return _active;
}

export function toggleSlimSAM() {
  if (state.mode !== '2d' && !_active) return false;
  const active = setSlimSAMMode(!_active);
  if (active) void loadSlimSAM().catch(() => null);
  return active;
}

export async function refreshSlimSAMStatus() {
  return updateSlimSAMStatus(true);
}

async function activateFromMenu() {
  if (_active) {
    setSlimSAMMode(false);
    return;
  }
  if (state.mode !== '2d') {
    notify('SlimSAM only runs in the 2D slice view.', { duration: 4000 });
    await updateSlimSAMStatus(false);
    return;
  }
  _beforeActivate();
  const info = await updateSlimSAMStatus(true);
  if (!info?.available) {
    notify('SlimSAM needs embeddings for this series before it can segment.', { duration: 5000 });
    return;
  }
  setSlimSAMMode(true);
  notify('SlimSAM armed. Click the object boundary or center on the 2D slice.', { duration: 4500 });
}

export async function onSlimSAMClick(ev, clientToCanvasPx) {
  if (!_active || state.mode !== '2d') return;

  const [px, py] = clientToCanvasPx(ev.clientX, ev.clientY);
  const series = state.manifest.series[state.seriesIdx];

  // Check if embeddings exist
  let slimsam;
  try {
    slimsam = await loadSlimSAM();
  } catch {
    notify('SlimSAM tool could not load.', { duration: 5000 });
    return;
  }
  const available = await slimsam.isSlimSAMAvailable(state.seriesIdx);
  if (!available) {
    setSlimSAMStatus('missing');
    notify('No SlimSAM embeddings for this series.', {
      command: slimsamEmbedCommand(series?.slug),
      duration: 8000,
    });
    return;
  }

  notify('SlimSAM segmenting...', { id: 'slimsam', progress: true });

  try {
    const result = await slimsam.runSlimSAMClick(px, py, state.sliceIdx, state.seriesIdx);
    if (!result || !result.mask) {
      dismissNotify('slimsam');
      notify('No mask returned — try a different area', { duration: 3000 });
      return;
    }

    _lastMask = result;
    _drawSlice();
    drawSlimSAMMask();
    syncSlimSAMMenu();
    dismissNotify('slimsam');
    notify(`SlimSAM segmented (${result.width}×${result.height})`, { duration: 2000 });
  } catch (e) {
    dismissNotify('slimsam');
    notify('SlimSAM error: ' + e.message, { duration: 5000 });
  }
}

function drawSlimSAMMask() {
  if (!_lastMask || !_active) return;
  const canvas = $('view');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  overlayMask(ctx, _lastMask, {
    color: [64, 180, 255], // cyan-blue
    opacity: _settings.opacity,
    smooth: _settings.smooth,
  });
}

function wireSlimSAMMenu() {
  const btn = $('btn-slimsam');
  const menu = $('slimsam-menu');
  if (!btn || !menu || btn.dataset.slimsamWired === '1') return;
  btn.dataset.slimsamWired = '1';

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    setSlimSAMMenuOpen(menu.hidden);
    if (!menu.hidden) void updateSlimSAMStatus(true);
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  $('slimsam-enable')?.addEventListener('click', () => void activateFromMenu());
  $('slimsam-refresh')?.addEventListener('click', () => void updateSlimSAMStatus(true));
  $('segmentation-cloud-settings')?.addEventListener('click', () => {
    void import('../cloud-settings-ui.js').then(mod => mod.openCloudSettingsModal());
  });
  $('slimsam-clear')?.addEventListener('click', () => {
    _lastMask = null;
    _drawSlice();
    syncSlimSAMMenu();
  });
  $('slimsam-opacity')?.addEventListener('input', (event) => {
    _settings.opacity = Number(event.target.value) || 0.35;
    saveSettings();
    syncSlimSAMMenu();
    if (_lastMask && _active) {
      _drawSlice();
      drawSlimSAMMask();
    }
  });
  $('slimsam-smooth')?.addEventListener('change', (event) => {
    _settings.smooth = !!event.target.checked;
    saveSettings();
    if (_lastMask && _active) {
      _drawSlice();
      drawSlimSAMMask();
    }
  });
  document.addEventListener('click', () => setSlimSAMMenuOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setSlimSAMMenuOpen(false);
  });
}

function setSlimSAMMenuOpen(open) {
  const btn = $('btn-slimsam');
  const menu = $('slimsam-menu');
  if (!btn || !menu) return;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

async function updateSlimSAMStatus(loadModule) {
  syncSlimSAMMenu();
  const series = state.manifest?.series?.[state.seriesIdx];
  if (!series) {
    renderSegmentationCatalog(null, null);
    setSlimSAMStatus('setup', 'Open a study series first.', '');
    return { available: false };
  }
  if (state.mode !== '2d') {
    renderSegmentationCatalog(series, _lastSlimSAMInfo);
    setSlimSAMStatus('setup', 'Click-to-segment is a 2D slice tool. Switch to 2D when you want to place prompts; the model catalog above still applies to this study.', '');
    return { available: false };
  }

  setSlimSAMStatus('checking', 'Checking local SAM sidecars for this series...', '');
  let slimsam;
  try {
    slimsam = loadModule ? await loadSlimSAM() : _slimsam;
  } catch {
    setSlimSAMStatus('blocked', 'SlimSAM could not load the browser decoder module.', '');
    return { available: false };
  }
  if (!slimsam) {
    setSlimSAMStatus('checking', 'Open this menu to check whether this scan has embeddings.', '');
    return { available: false };
  }

  const info = await slimsam.getSlimSAMInfo(state.seriesIdx);
  _lastSlimSAMInfo = info;
  renderSegmentationCatalog(series, _lastSlimSAMInfo);
  if (!info.available) {
    if (info.reason === 'geometry_mismatch') {
      setSlimSAMStatus(
        'blocked',
        'SAM sidecars were found, but their dimensions do not match this series. Regenerate them for the current scan before using click-to-segment.',
        slimsamEmbedCommand(series.slug),
      );
      return info;
    }
    setSlimSAMStatus(
      'missing',
      'SlimSAM click masks do not need a Modal key, but this scan does not have local SAM embeddings yet. Generate the sidecars, or use Cloud settings for GPU-backed segmentation adapters.',
      slimsamEmbedCommand(series.slug),
    );
    return info;
  }

  const slices = Number(info.meta?.slices || 0);
  const size = `${info.meta?.width || series.width}x${info.meta?.height || series.height}`;
  setSlimSAMStatus(
    'ready',
    `Ready for this series: ${slices} embedded slice${slices === 1 ? '' : 's'} at ${size}. Click Start, then click the structure on the 2D slice.`,
    '',
  );
  return info;
}

function setSlimSAMStatus(kind, message = '', command = '') {
  const pill = $('slimsam-state-pill');
  const status = $('slimsam-status');
  const commandBox = $('slimsam-command');
  const commandCode = $('slimsam-command-code');
  if (pill) {
    pill.className = `slimsam-pill ${kind}`;
    pill.textContent = kind === 'ready' ? 'Ready'
      : kind === 'missing' ? 'Missing'
        : kind === 'blocked' ? 'Blocked'
          : kind === 'setup' ? 'Setup'
            : 'Checking';
  }
  if (status && message) status.textContent = message;
  if (commandBox && commandCode) {
    commandBox.hidden = !command;
    commandCode.textContent = command;
  }
  syncSlimSAMMenu();
}

function syncSlimSAMMenu() {
  const series = state.manifest?.series?.[state.seriesIdx];
  if (series) renderSegmentationCatalog(series, _lastSlimSAMInfo);
  const enable = $('slimsam-enable');
  if (enable) enable.textContent = _active ? 'Stop clicking' : 'Start clicking';
  const clear = $('slimsam-clear');
  if (clear) clear.hidden = !_lastMask;
  const opacity = $('slimsam-opacity');
  if (opacity) opacity.value = String(_settings.opacity);
  const opacityVal = $('slimsam-opacity-val');
  if (opacityVal) opacityVal.textContent = `${Math.round(_settings.opacity * 100)}%`;
  const smooth = $('slimsam-smooth');
  if (smooth) smooth.checked = _settings.smooth;
}

function slimsamEmbedCommand(slug = '') {
  return `python3 python/slimsam_embed.py ${slug}`.trim();
}

function renderSegmentationCatalog(series, slimsamInfo) {
  const summary = $('segmentation-summary');
  const list = $('segmentation-engine-list');
  if (!summary || !list) return;
  if (!series) {
    summary.textContent = 'Open a series to see compatible segmentation engines.';
    list.replaceChildren();
    return;
  }
  const slimInfo = slimsamInfo?.slug === series.slug ? slimsamInfo : null;
  const study = inferSegmentationStudy(series);
  const recommendations = getSegmentationRecommendations(series, { slimsamInfo: slimInfo, limit: 7 });
  summary.textContent = segmentationSummaryText(study, recommendations);
  list.replaceChildren(...recommendations.map(createSegmentationEngineNode));
}

function segmentationSummaryText(study, recommendations) {
  const ready = recommendations.filter((item) => item.status === 'available' || item.status === 'ready' || item.status === 'can-run').length;
  const planned = recommendations.filter((item) => item.status === 'adapter-planned').length;
  const modality = study.modality === 'UNKNOWN' ? 'unknown modality' : study.modality;
  return `${modality} ${study.dimensions.replace('-', ' ')} · ${ready} usable now · ${planned} adapters planned`;
}

function createSegmentationEngineNode(engine) {
  const gpu = engine.execution.includes('modal-cloud-gpu') ? 'Cloud GPU' : engine.execution[0] || '';
  const meta = [engine.family, engine.interaction, gpu].filter(Boolean).join(' · ');
  const row = document.createElement('div');
  row.className = 'segmentation-engine';
  row.dataset.engine = engine.id;

  const head = document.createElement('div');
  head.className = 'segmentation-engine-head';
  const name = document.createElement('div');
  name.className = 'segmentation-engine-name';
  name.textContent = engine.name;
  const status = document.createElement('div');
  status.className = `segmentation-engine-status ${engine.status}`;
  status.textContent = engine.statusLabel;
  head.append(name, status);

  const note = document.createElement('div');
  note.className = 'segmentation-engine-note';
  note.textContent = engine.note;
  const metaEl = document.createElement('div');
  metaEl.className = 'segmentation-engine-meta';
  metaEl.textContent = meta;

  row.append(head, note, metaEl);
  const action = createSegmentationEngineAction(engine);
  if (action) row.append(action);
  return row;
}

function createSegmentationEngineAction(engine) {
  if (engine.status !== 'can-run' || !engine.execution.includes('modal-cloud-gpu')) return null;
  const button = document.createElement('button');
  button.className = 'segmentation-engine-action';
  button.type = 'button';
  button.textContent = 'Cloud GPU';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    void openSegmentationCloudAction(engine);
  });
  return button;
}

async function openSegmentationCloudAction(engine) {
  if (!_selectSeries) {
    notify('Cloud segmentation needs the upload workflow to be initialized.', { duration: 4000 });
    return;
  }
  setSlimSAMMenuOpen(false);
  const { showStudyUploadModal } = await import('../projects/study-upload-modal.js');
  await showStudyUploadModal(_selectSeries, {
    contextTitle: `${engine.name} cloud action`,
    contextBody: 'Select the original CT/MR DICOM stack. VoxelLab checks cloud eligibility before any upload.',
  });
}
