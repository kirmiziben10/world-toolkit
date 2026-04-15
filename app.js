// ===== Constants =====
const DEFAULT_CENTER = [39.0, 35.5]; // Turkey centered
const DEFAULT_ZOOM = 6;
const ANALYSIS_ZOOM = 11;
const MAX_TILES = 80;
const RECT_STYLE = {
  color: '#09ACE2', weight: 2, fillOpacity: 0.1, dashArray: '8, 6',
};
const t = window.i18n.t;
const TerrainTiles = window.TerrainTiles;
const TILE_SIZE = TerrainTiles.TILE_SIZE;
const getTile = TerrainTiles.getTile;
const lngToTileX = TerrainTiles.lngToTileX;
const latToTileY = TerrainTiles.latToTileY;
const tileToLng = TerrainTiles.tileToLng;
const tileToLat = TerrainTiles.tileToLat;
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const OPENTOPOMAP_ATTRIBUTION =
  `Map data: ${OSM_ATTRIBUTION}, SRTM | ` +
  `Map style: &copy; <a href="https://opentopomap.org/about">OpenTopoMap</a> (CC-BY-SA)`;
const ESRI_WORLD_TOPO_ATTRIBUTION =
  'Sources: Esri, HERE, Garmin, Intermap, INCREMENT P, GEBCO, USGS, FAO, NPS, ' +
  'NRCan, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Mapwithyou, ' +
  'NOSTRA, &copy; OpenStreetMap contributors, and the GIS User Community';
const ESRI_WORLD_IMAGERY_ATTRIBUTION =
  'Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

// ===== Mobile Detection =====
const IS_MOBILE = window.matchMedia('(max-width: 600px)').matches ||
  ('ontouchstart' in window && window.innerWidth <= 600);

// ===== Cached DOM refs (set in init) =====
let analyzeBtnEl = null;
let analyzeBtnTextEl = null;
let undoBtnEl = null;
let redoBtnEl = null;
let layerControl = null;

// ===== State =====
const state = {
  map: null,
  drawnItems: null,
  selectionBounds: null,
  resultMarkers: [],
  clusterGroup: null,
  expandedMarkers: [],
  tileBoundaries: [],
  viewLines: [],
  worker: null,
  results: [],
  likedSpots: new Set(JSON.parse(localStorage.getItem('sv_liked') || '[]')),
  starredSpots: new Set(JSON.parse(localStorage.getItem('sv_starred') || '[]')),
  boundsHistory: [],
  historyIndex: -1,
  editDebounce: null,
  baseLayers: null,
};

// ===== localStorage Persistence =====
function saveLiked() {
  localStorage.setItem('sv_liked', JSON.stringify([...state.likedSpots]));
}
function saveStarred() {
  localStorage.setItem('sv_starred', JSON.stringify([...state.starredSpots]));
}
function makeSpotId(vp) {
  return `${vp.lat.toFixed(5)},${vp.lng.toFixed(5)}`;
}

// ===== Compass Helpers =====
const COMPASS_LABELS = () => t('compass');
function bearingToCompass(deg) {
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_LABELS()[idx];
}

// ===== Window Layout Persistence =====
function captureWindowLayout(win) {
  if (!win) return null;
  const rect = win.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function applyWindowLayout(win, layout) {
  if (!win || !layout) return;
  win.style.top = layout.top + 'px';
  win.style.left = layout.left + 'px';
  win.style.width = layout.width + 'px';
  win.style.height = layout.height + 'px';
}

function isWindowMaximized(winId) {
  return !IS_MOBILE && localStorage.getItem('sv_win_maximized_' + winId) === 'true';
}

function setWindowMaximizedState(winId, maximized) {
  if (IS_MOBILE) return;
  localStorage.setItem('sv_win_maximized_' + winId, maximized ? 'true' : 'false');
}

function applyMaximizedWindowLayout(winId) {
  const win = document.getElementById(winId);
  if (!win) return;
  win.style.top = '0px';
  win.style.left = '0px';
  win.style.width = window.innerWidth + 'px';
  win.style.height = window.innerHeight + 'px';
}

function saveWindowLayout(winId, layout) {
  if (IS_MOBILE) return;
  if (!layout && isWindowMaximized(winId)) return;
  const win = document.getElementById(winId);
  const nextLayout = layout || captureWindowLayout(win);
  if (!nextLayout) return;
  localStorage.setItem('sv_layout_' + winId, JSON.stringify(nextLayout));
}

function loadWindowLayout(winId) {
  const raw = localStorage.getItem('sv_layout_' + winId);
  if (!raw) return null;
  try {
    const l = JSON.parse(raw);
    l.left = Math.max(0, Math.min(l.left, window.innerWidth - 100));
    l.top  = Math.max(0, Math.min(l.top,  window.innerHeight - 60));
    return l;
  } catch { return null; }
}

function restoreWindowLayout(winId) {
  const l = loadWindowLayout(winId);
  if (!l) return;
  const win = document.getElementById(winId);
  applyWindowLayout(win, l);
}

function restoreWindowState(winId) {
  if (IS_MOBILE) return;
  if (isWindowMaximized(winId)) {
    applyMaximizedWindowLayout(winId);
    return;
  }
  restoreWindowLayout(winId);
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  const ready = window.i18n && window.i18n.ready ? window.i18n.ready : Promise.resolve();
  ready.then(init);
});

function init() {
  analyzeBtnEl = document.getElementById('analyze-btn');
  analyzeBtnTextEl = analyzeBtnEl.querySelector('.btn-text');
  undoBtnEl = document.getElementById('undo-btn');
  redoBtnEl = document.getElementById('redo-btn');
  if (!IS_MOBILE) {
    ['main-window', 'loved-window', 'starred-window', 'radio-window'].forEach(restoreWindowState);
  }
  initMap();
  initDrawControls();
  initSliders();
  initButtons();
  updateSearchTerrainCreditHtml();
  updateGlobeAttribution();
  if (!IS_MOBILE) {
    initWindowDrag();
    initWindowResize();
    initXpWindow('loved-window', 'loved-window-titlebar');
    initXpWindow('starred-window', 'starred-window-titlebar');
    initXpWindow('radio-window', 'radio-window-titlebar');
  }

  // Init Radio Reach companion app
  if (window.RadioReach) {
    window.RadioReach.init();
    // If radio window was restored as open, invalidate map after layout settles
    if (!document.getElementById('radio-window').hidden) {
      setTimeout(() => window.RadioReach.invalidateMap(), 400);
    }
  }

  // Globe widget → map navigation
  document.addEventListener('globe-navigate', (e) => {
    if (state.map) state.map.flyTo([e.detail.lat, e.detail.lng], 6, { duration: 1.5 });
  });

  // Invalidate map size after layout settles (flush side panel)
  requestAnimationFrame(() => {
    if (state.map) state.map.invalidateSize();
  });

  document.addEventListener('i18n:changed', handleLanguageChange);
}

// ===== Map Setup =====
function initMap() {
  state.map = L.map('map', {
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: false,
  });

  // Standard OSM base layer (fits the XP/7 light theme)
  const osm = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: OSM_ATTRIBUTION,
      maxZoom: 19,
    }
  );

  // OpenTopoMap layer
  const topo = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    {
      attribution: OPENTOPOMAP_ATTRIBUTION,
      maxZoom: 17,
    }
  );

  const worldTopo = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: ESRI_WORLD_TOPO_ATTRIBUTION,
      maxZoom: 19,
    }
  );

  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
      maxZoom: 19,
    }
  );

  state.baseLayers = {
    standard: osm,
    topographic: topo,
    worldTopo: worldTopo,
    satellite: satellite,
  };
  state.baseLayers.standard.options.svBaseLayerKey = 'standard';
  state.baseLayers.topographic.options.svBaseLayerKey = 'topographic';
  state.baseLayers.worldTopo.options.svBaseLayerKey = 'worldTopo';
  state.baseLayers.satellite.options.svBaseLayerKey = 'satellite';

  // Restore saved base layer or default to topo
  const savedLayer = normalizeBaseLayerKey(localStorage.getItem('sv_base_layer'));
  (state.baseLayers[savedLayer] || state.baseLayers.topographic).addTo(state.map);

  rebuildLayerControl();
  L.control.zoom({ position: 'topright' }).addTo(state.map);

  // Persist base layer choice
  state.map.on('baselayerchange', (e) => {
    localStorage.setItem('sv_base_layer', e.layer && e.layer.options && e.layer.options.svBaseLayerKey || 'topographic');
  });

  // Restore saved map position
  const savedView = localStorage.getItem('sv_map_view');
  if (savedView) {
    try {
      const v = JSON.parse(savedView);
      state.map.setView([v.lat, v.lng], v.zoom);
    } catch {}
  }

  // Persist map position on move/zoom
  state.map.on('moveend', () => {
    const c = state.map.getCenter();
    localStorage.setItem('sv_map_view', JSON.stringify({
      lat: c.lat, lng: c.lng, zoom: state.map.getZoom(),
    }));
  });

}

function getLocalizedBaseLayers() {
  return {
    [t('layerStandard')]: state.baseLayers.standard,
    [t('layerTopographic')]: state.baseLayers.topographic,
    [t('layerWorldTopo')]: state.baseLayers.worldTopo,
    [t('layerSatellite')]: state.baseLayers.satellite,
  };
}

function rebuildLayerControl() {
  if (!state.map || !state.baseLayers) return;
  if (layerControl) {
    state.map.removeControl(layerControl);
  }
  layerControl = L.control.layers(getLocalizedBaseLayers(), null, { position: 'topright' });
  layerControl.addTo(state.map);
}

function normalizeBaseLayerKey(value) {
  if (value === 'standard' || value === 'topographic' || value === 'worldTopo' || value === 'satellite') {
    return value;
  }

  var legacyMap = {};
  legacyMap[t('layerStandard')] = 'standard';
  legacyMap[t('layerTopographic')] = 'topographic';
  legacyMap[t('layerWorldTopo')] = 'worldTopo';
  legacyMap[t('layerSatellite')] = 'satellite';
  legacyMap.Standard = 'standard';
  legacyMap.Topographic = 'topographic';
  legacyMap['World Topo (Esri)'] = 'worldTopo';
  legacyMap.Satellite = 'satellite';
  legacyMap.Standart = 'standard';
  legacyMap.Topografik = 'topographic';
  legacyMap['Dünya Topo (Esri)'] = 'worldTopo';
  legacyMap.Uydu = 'satellite';

  return legacyMap[value] || 'topographic';
}

// ===== Draw Controls =====
function localizeDrawLocal() {
  L.drawLocal.draw.toolbar.actions.text = t('cancel');
  L.drawLocal.draw.toolbar.actions.title = t('cancelDrawing');
  L.drawLocal.draw.handlers.rectangle.tooltip.start = t('drawRectTooltip');
  L.drawLocal.edit.toolbar.actions.cancel.text = t('cancel');
  L.drawLocal.edit.toolbar.actions.cancel.title = t('cancelEditing');
}

function initDrawControls() {
  localizeDrawLocal();
  state.drawnItems = new L.FeatureGroup();
  state.map.addLayer(state.drawnItems);

  const drawControl = new L.Control.Draw({
    position: 'topright',
    draw: {
      polyline: false,
      polygon: false,
      circle: false,
      marker: false,
      circlemarker: false,
      rectangle: { shapeOptions: RECT_STYLE },
    },
    edit: {
      featureGroup: state.drawnItems,
      edit: false,       // no edit toolbar — rectangle is always editable
      remove: true,
    },
  });

  state.map.addControl(drawControl);

  state.map.on(L.Draw.Event.CREATED, (e) => {
    state.drawnItems.clearLayers();
    state.drawnItems.addLayer(e.layer);
    state.selectionBounds = e.layer.getBounds();
    validateSelection(state.selectionBounds);
    pushBoundsHistory(state.selectionBounds);
    setupRectEditing(e.layer);
    document.dispatchEvent(new CustomEvent('wt:rectangle-drawn'));
  });

  state.map.on(L.Draw.Event.DELETED, () => {
    state.selectionBounds = null;
    validateSelection(null);
    pushBoundsHistory(null);
  });
}

// Make a rectangle layer directly editable (handles always visible, no save step)
function setupRectEditing(layer) {
  if (layer.editing) layer.editing.enable();

  layer.on('edit', () => {
    state.selectionBounds = layer.getBounds();
    validateSelection(state.selectionBounds);
    // Debounce history push so continuous dragging = single undo step
    clearTimeout(state.editDebounce);
    state.editDebounce = setTimeout(() => {
      pushBoundsHistory(state.selectionBounds);
    }, 400);
  });
}

// ===== Undo / Redo =====
function pushBoundsHistory(bounds) {
  // Trim any redo states ahead of current position
  state.boundsHistory = state.boundsHistory.slice(0, state.historyIndex + 1);
  state.boundsHistory.push(bounds ? boundsToObj(bounds) : null);
  state.historyIndex = state.boundsHistory.length - 1;
  updateUndoRedoButtons();
}

function boundsToObj(b) {
  return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
}

function objToBounds(o) {
  return L.latLngBounds(L.latLng(o.south, o.west), L.latLng(o.north, o.east));
}

function undo() {
  if (state.historyIndex <= 0) return;
  state.historyIndex--;
  applyBoundsFromHistory();
}

function redo() {
  if (state.historyIndex >= state.boundsHistory.length - 1) return;
  state.historyIndex++;
  applyBoundsFromHistory();
}

function applyBoundsFromHistory() {
  const saved = state.boundsHistory[state.historyIndex];
  state.drawnItems.clearLayers();

  if (!saved) {
    state.selectionBounds = null;
    validateSelection(null);
    updateUndoRedoButtons();
    return;
  }

  const bounds = objToBounds(saved);
  const rect = L.rectangle(bounds, RECT_STYLE);
  state.drawnItems.addLayer(rect);
  setupRectEditing(rect);

  state.selectionBounds = bounds;
  validateSelection(bounds);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  if (undoBtnEl) undoBtnEl.disabled = state.historyIndex <= 0;
  if (redoBtnEl) redoBtnEl.disabled = state.historyIndex >= state.boundsHistory.length - 1;
}

// ===== Custom Slider =====
function initSliders() {
  const sliders = [
    { id: 'min-elevation', suffix: 'm' },
    { id: 'max-slope', suffix: '°' },
    { id: 'search-radius', suffix: ' km' },
    { id: 'min-valley-depth', suffix: 'm' },
    { id: 'min-prominence', suffix: 'm' },
  ];

  sliders.forEach(({ id, suffix }) => {
    const input = document.getElementById(id);
    const display = document.getElementById(`${id}-val`);
    const container = input.closest('.slider-track-container');
    const { positionThumb } = buildCustomSlider(container, input);
    input.addEventListener('input', () => {
      display.textContent = input.value + suffix;
    });

    // Editable label — click to type a value directly
    display.style.cursor = 'pointer';
    display.addEventListener('click', () => {
      const editInput = document.createElement('input');
      editInput.type = 'number';
      editInput.className = 'label-value label-value-edit';
      editInput.value = input.value;
      editInput.style.width = display.offsetWidth + 'px';
      display.replaceWith(editInput);
      editInput.focus();
      editInput.select();

      const commit = () => {
        const raw = parseFloat(editInput.value);
        if (!isNaN(raw)) {
          const step = +input.step;
          const snapped = Math.round((raw - (+input.min)) / step) * step + (+input.min);
          input.value = snapped;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          positionThumb();
        }
        display.textContent = input.value + suffix;
        editInput.replaceWith(display);
      };
      editInput.addEventListener('blur', commit);
      editInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') editInput.blur();
        if (e.key === 'Escape') { editInput.value = input.value; editInput.blur(); }
      });
    });
  });
}

function buildCustomSlider(container, input) {
  const min = +input.min, max = +input.max, step = +input.step;
  const tallEvery = +(container.dataset.tallEvery || 5);
  const numSteps = Math.round((max - min) / step);
  const pad = 5; // px padding on each side matching CSS left/right

  // --- Notches ---
  const notchBar = document.createElement('div');
  notchBar.className = 'slider-notches';
  for (let i = 0; i <= numSteps; i++) {
    const notch = document.createElement('div');
    notch.className = 'slider-notch' + (i % tallEvery === 0 ? ' tall' : '');
    notchBar.appendChild(notch);
  }
  container.appendChild(notchBar);

  // --- Track line ---
  const trackLine = document.createElement('div');
  trackLine.className = 'slider-track-line';
  container.appendChild(trackLine);

  // --- Thumb ---
  const thumb = document.createElement('div');
  thumb.className = 'slider-thumb';
  container.appendChild(thumb);

  // Distribute notches evenly across the track width
  function getTrackW() { return container.clientWidth - pad * 2; }

  function layoutNotches() {
    const trackW = getTrackW();
    const notches = notchBar.children;
    const count = notches.length;
    if (count <= 1 || trackW <= 0) return;
    const spacing = trackW / (count - 1);
    for (let i = 0; i < count; i++) {
      notches[i].style.position = 'absolute';
      notches[i].style.left = (i * spacing - 0.5) + 'px';
    }
    // Match track line exactly to first–last notch span
    trackLine.style.left = pad + 'px';
    trackLine.style.width = (trackW + 1) + 'px';
    positionThumb();
  }

  function positionThumb() {
    const trackW = getTrackW();
    const ratio = Math.max(0, Math.min(1, (+input.value - min) / (max - min)));
    thumb.style.left = (pad + ratio * trackW - 5) + 'px';
  }

  // Snap value to nearest step
  function snapValue(raw) {
    const clamped = Math.max(min, Math.min(max, raw));
    return Math.round((clamped - min) / step) * step + min;
  }

  // --- Drag handling ---
  function onPointerDown(e) {
    e.preventDefault();
    thumb.classList.add('dragging');
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      const x = (ev.clientX || ev.touches[0].clientX) - rect.left - pad;
      const trackW = getTrackW();
      const ratio = Math.max(0, Math.min(1, x / trackW));
      const val = snapValue(min + ratio * (max - min));
      if (+input.value !== val) {
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      positionThumb();
    };
    const onUp = () => {
      thumb.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    // Jump to click position
    onMove(e);
  }

  thumb.addEventListener('mousedown', onPointerDown);
  thumb.addEventListener('touchstart', onPointerDown, { passive: false });

  // Also allow clicking directly on the track
  container.addEventListener('mousedown', (e) => {
    if (e.target === thumb) return;
    onPointerDown(e);
  });
  container.addEventListener('touchstart', (e) => {
    if (e.target === thumb) return;
    onPointerDown(e);
  }, { passive: false });

  layoutNotches();
  // Relayout on resize (e.g. controls panel toggle)
  new ResizeObserver(() => layoutNotches()).observe(container);

  return { positionThumb };
}

// ===== Button Bindings =====
function initButtons() {
  document.getElementById('analyze-btn').addEventListener('click', startAnalysis);

  // Leaflet trash button — intercept click to show menu
  const recycleMenu = document.getElementById('recycle-menu');

  // Wait for Leaflet.Draw to render, then hijack the trash button
  setTimeout(() => {
    const trashBtn = document.querySelector('.leaflet-draw-edit-remove');
    if (!trashBtn) return;

    trashBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!recycleMenu.hidden) { recycleMenu.hidden = true; return; }
      const btnRect = trashBtn.getBoundingClientRect();
      // Briefly show off-screen to measure width
      recycleMenu.style.visibility = 'hidden';
      recycleMenu.hidden = false;
      const menuW = recycleMenu.offsetWidth;
      recycleMenu.style.visibility = '';
      recycleMenu.style.left = (btnRect.left - menuW - 4) + 'px';
      recycleMenu.style.top = btnRect.top + 'px';
      document.getElementById('recycle-clear-all').disabled =
        state.resultMarkers.length === 0 && !state.selectionBounds;
      document.getElementById('recycle-clear-selection').disabled = !state.selectionBounds;
    }, true); // capture phase to beat Leaflet's handler
  }, 0);

  // Dismiss menu on outside click
  document.addEventListener('click', (e) => {
    if (!recycleMenu.hidden && !recycleMenu.contains(e.target) &&
        !e.target.closest('.leaflet-draw-edit-remove')) {
      recycleMenu.hidden = true;
    }
  });

  // Clear All — remove results + selection
  document.getElementById('recycle-clear-all').addEventListener('click', () => {
    recycleMenu.hidden = true;
    clearResults();
    document.getElementById('results-panel').hidden = true;
    state.drawnItems.clearLayers();
    state.selectionBounds = null;
    state.boundsHistory = [null];
    state.historyIndex = 0;
    validateSelection(null);
    updateUndoRedoButtons();
  });

  // Clear Selection — remove rectangle but keep result points
  document.getElementById('recycle-clear-selection').addEventListener('click', () => {
    recycleMenu.hidden = true;
    state.drawnItems.clearLayers();
    state.selectionBounds = null;
    state.boundsHistory = [null];
    state.historyIndex = 0;
    validateSelection(null);
    updateUndoRedoButtons();
    state.tileBoundaries.forEach((layer) => state.map.removeLayer(layer));
    state.tileBoundaries = [];
  });

  document.getElementById('close-results').addEventListener('click', () => {
    document.getElementById('results-panel').hidden = true;
  });

  // Controls panel toggle — restore saved state (suppress transition on load)
  const controlsPanel = document.getElementById('controls-panel');
  const controlsToggle = document.getElementById('controls-toggle');
  if (IS_MOBILE || localStorage.getItem('sv_filters_collapsed') === '1') {
    controlsPanel.style.transition = 'none';
    controlsToggle.style.transition = 'none';
    controlsPanel.classList.add('collapsed');
    controlsToggle.classList.add('collapsed');
    requestAnimationFrame(() => {
      controlsPanel.style.transition = '';
      controlsToggle.style.transition = '';
      if (state.map) state.map.invalidateSize();
    });
  }
  controlsToggle.addEventListener('click', () => {
    controlsPanel.classList.toggle('collapsed');
    controlsToggle.classList.toggle('collapsed');
    localStorage.setItem('sv_filters_collapsed', controlsPanel.classList.contains('collapsed') ? '1' : '0');
    // Let the map reclaim/yield the space
    requestAnimationFrame(() => {
      setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 310);
    });
  });

  // Undo / Redo buttons
  document.getElementById('undo-btn').addEventListener('click', undo);
  document.getElementById('redo-btn').addEventListener('click', redo);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.ctrlKey && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
    else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
  });


  // Window chrome buttons
  document.getElementById('btn-close').addEventListener('click', () => {
    const win = document.getElementById('main-window');
    const icon = document.getElementById('icon-search-spots');
    closeWindow(win, icon);
  });

  document.getElementById('btn-help').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelpTooltip(e.currentTarget, [
      t('helpStep1'),
      t('helpStep2'),
      t('helpStep3'),
      t('helpStep4'),
      t('helpStep5'),
      t('helpStep6'),
    ], buildHelpCreditsHtml());
  });

  // Desktop icon: open/focus Search window
  document.getElementById('icon-search-spots').addEventListener('click', () => {
    const win = document.getElementById('main-window');
    iconPop(document.getElementById('icon-search-spots'));
    if (win.hidden) {
      win.hidden = false;
      win.style.zIndex = getTopZ();
      openWindow(win, document.getElementById('icon-search-spots'));
    } else {
      win.style.zIndex = getTopZ();
    }
  });

  // Desktop icon: Loved Spots
  document.getElementById('icon-loved-spots').addEventListener('click', () => {
    iconPop(document.getElementById('icon-loved-spots'));
    openSavedPanel('loved');
  });

  // Desktop icon: Starred Spots
  document.getElementById('icon-starred-spots').addEventListener('click', () => {
    iconPop(document.getElementById('icon-starred-spots'));
    openSavedPanel('starred');
  });

  // Desktop icon: Radio Reach
  document.getElementById('icon-radio-reach').addEventListener('click', () => {
    iconPop(document.getElementById('icon-radio-reach'));
    const win = document.getElementById('radio-window');
    if (win.hidden) {
      if (!IS_MOBILE) {
        if (isWindowMaximized('radio-window')) {
          applyMaximizedWindowLayout('radio-window');
        } else {
          const saved = loadWindowLayout('radio-window');
          if (saved) {
            applyWindowLayout(win, saved);
          } else {
            win.style.top = '106px';
            win.style.left = '124px';
            win.style.width = 'calc(100vw - 248px)';
            win.style.height = 'calc(100vh - 132px)';
          }
        }
      }
      win.hidden = false;
      win.style.zIndex = getTopZ();
      openWindow(win, document.getElementById('icon-radio-reach'));
    } else {
      win.style.zIndex = getTopZ();
    }
    if (window.RadioReach) {
      window.RadioReach.invalidateMap();
      // Also invalidate after open animation finishes
      win.addEventListener('animationend', function () {
        window.RadioReach.invalidateMap();
      }, { once: true });
    }
  });

  // Close secondary windows
  document.getElementById('btn-close-loved').addEventListener('click', () => {
    closeWindow(document.getElementById('loved-window'), document.getElementById('icon-loved-spots'));
  });
  document.getElementById('btn-close-starred').addEventListener('click', () => {
    closeWindow(document.getElementById('starred-window'), document.getElementById('icon-starred-spots'));
  });
  document.getElementById('btn-close-radio').addEventListener('click', () => {
    closeWindow(document.getElementById('radio-window'), document.getElementById('icon-radio-reach'));
  });

  // Maximize buttons (desktop only)
  if (!IS_MOBILE) {
    initMaximize('main-window',    'btn-maximize-main');
    initMaximize('loved-window',   'btn-maximize-loved');
    initMaximize('starred-window', 'btn-maximize-starred');
    initMaximize('radio-window',   'btn-maximize-radio');
  }

  // Bring any window to front on click
  ['main-window', 'loved-window', 'starred-window', 'radio-window'].forEach(id => {
    document.getElementById(id).addEventListener('mousedown', () => {
      document.getElementById(id).style.zIndex = getTopZ();
    });
  });
}

let _topZ = 300;
function getTopZ() { return ++_topZ; }

// ===== Saved Windows (Loved / Starred) =====
function openSavedPanel(type) {
  const winId = type === 'loved' ? 'loved-window' : 'starred-window';
  const iconId = type === 'loved' ? 'icon-loved-spots' : 'icon-starred-spots';
  const win = document.getElementById(winId);
  const icon = document.getElementById(iconId);
  // Only animate open if truly hidden; otherwise just focus
  if (win.hidden) {
    if (!IS_MOBILE) {
      if (isWindowMaximized(winId)) {
        applyMaximizedWindowLayout(winId);
      } else {
        const saved = loadWindowLayout(winId);
        if (saved) {
          applyWindowLayout(win, saved);
        } else {
          const offset = type === 'loved' ? 0 : 344;
          win.style.top = '120px';
          win.style.left = `calc(50% - 160px + ${offset}px)`;
          win.style.width = '320px';
          win.style.height = '460px';
        }
      }
    }
    win.hidden = false;
    win.style.zIndex = getTopZ();
    openWindow(win, icon);
  } else {
    win.style.zIndex = getTopZ();
  }
  renderSavedPanel(type);
}

// ===== Window Open / Close Animation Utilities =====

const ICON_MAP = {
  'main-window':    'icon-search-spots',
  'loved-window':   'icon-loved-spots',
  'starred-window': 'icon-starred-spots',
  'radio-window':   'icon-radio-reach',
};

function openWindow(winEl, iconEl) {
  if (!IS_MOBILE) localStorage.setItem('sv_win_open_' + winEl.id, 'true');
  if (IS_MOBILE) {
    winEl.classList.remove('win-closing');
    winEl.classList.add('win-opening');
    winEl.addEventListener('animationend', () => {
      winEl.classList.remove('win-opening');
    }, { once: true });
    // Invalidate map after opening
    requestAnimationFrame(() => { if (state.map) state.map.invalidateSize(); });
    return;
  }
  // Element is already unhidden — measure, set transform-origin, animate
  winEl.style.visibility = 'hidden';         // prevent 1-frame flash
  requestAnimationFrame(() => {
    const wr = winEl.getBoundingClientRect();
    const ir = iconEl.getBoundingClientRect();
    const ox = (ir.left + ir.width  / 2) - wr.left;
    const oy = (ir.top  + ir.height / 2) - wr.top;
    winEl.style.transformOrigin = `${ox}px ${oy}px`;
    winEl.style.visibility = '';
    winEl.classList.remove('win-closing');
    winEl.classList.add('win-opening');
    winEl.addEventListener('animationend', () => {
      winEl.classList.remove('win-opening');
      winEl.style.transformOrigin = '';
    }, { once: true });
  });
}

function closeWindow(winEl, iconEl) {
  if (winEl.hidden) return;
  if (!IS_MOBILE) {
    localStorage.setItem('sv_win_open_' + winEl.id, 'false');
    saveWindowLayout(winEl.id);
  }
  if (IS_MOBILE) {
    winEl.classList.remove('win-opening');
    winEl.classList.add('win-closing');
    winEl.addEventListener('animationend', () => {
      winEl.classList.remove('win-closing');
      winEl.hidden = true;
    }, { once: true });
    return;
  }
  const wr = winEl.getBoundingClientRect();
  const ir = iconEl.getBoundingClientRect();
  const ox = (ir.left + ir.width  / 2) - wr.left;
  const oy = (ir.top  + ir.height / 2) - wr.top;
  winEl.style.transformOrigin = `${ox}px ${oy}px`;
  winEl.classList.remove('win-opening');
  winEl.classList.add('win-closing');
  winEl.addEventListener('animationend', () => {
    winEl.classList.remove('win-closing');
    winEl.style.transformOrigin = '';
    winEl.hidden = true;
  }, { once: true });
}

function iconPop(iconEl) {
  iconEl.classList.remove('icon-popping');
  void iconEl.offsetWidth; // force reflow to restart
  iconEl.classList.add('icon-popping');
  iconEl.addEventListener('animationend', () => {
    iconEl.classList.remove('icon-popping');
  }, { once: true });
}

// ===== Help Tooltip =====
function toggleHelpTooltip(btnEl, items, footerHtml) {
  const tooltip = document.getElementById('help-tooltip');
  const footer = document.getElementById('help-tooltip-footer');
  if (!tooltip.hidden) { tooltip.hidden = true; return; }

  document.getElementById('help-tooltip-list').innerHTML = items.map(item => `<li>${item}</li>`).join('');
  tooltip.querySelector('.help-tooltip-title').textContent = t('helpTitle');
  if (footerHtml) {
    footer.innerHTML = footerHtml;
    footer.hidden = false;
  } else {
    footer.innerHTML = '';
    footer.hidden = true;
  }

  // Reveal off-screen first to measure
  tooltip.style.visibility = 'hidden';
  tooltip.hidden = false;
  const ttRect = tooltip.getBoundingClientRect();
  const btnRect = btnEl.getBoundingClientRect();

  let top  = btnRect.bottom + 6;
  let left = btnRect.right - ttRect.width;
  left = Math.max(8, Math.min(left, window.innerWidth  - ttRect.width  - 8));
  top  = Math.max(8, Math.min(top,  window.innerHeight - ttRect.height - 8));

  tooltip.style.top  = top  + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.visibility = '';
}

function buildHelpCreditsHtml() {
  const silkLink = '<a href="https://www.famfamfam.com/lab/icons/silk/" target="_blank" rel="noopener noreferrer">Silk by Mark James</a>';
  const ccLink = '<a href="https://creativecommons.org/licenses/by/2.5/" target="_blank" rel="noopener noreferrer">CC BY 2.5</a>';
  const threeLink = '<a href="https://threejs.org/" target="_blank" rel="noopener noreferrer">Three.js</a>';
  const terrainLink = '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">Mapzen Terrain Tiles on AWS Open Data</a>';
  const terrainAttributionLink = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">terrain attribution guide</a>';

  return [
    `<div class="help-tooltip-footer-title">${t('helpCreditsTitle')}</div>`,
    `<p>${t('helpCreditsMap')}</p>`,
    `<p>${t('helpCreditsGeocoding')}</p>`,
    `<p>${t('helpCreditsTerrain', { terrain: terrainLink })}</p>`,
    `<p>${t('helpCreditsTerrainSources', { attribution: terrainAttributionLink })}</p>`,
    `<p>${t('helpCreditsIcons', { silk: silkLink, license: ccLink })}</p>`,
    `<p>${t('helpCreditsRendering', { three: threeLink })}</p>`,
  ].join('');
}

function updateSearchTerrainCreditHtml() {
  const creditEl = document.getElementById('search-terrain-credit');
  if (!creditEl) return;

  const terrainLink = '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">Mapzen Terrain Tiles on AWS Open Data</a>';
  const terrainAttributionLink = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">terrain attribution guide</a>';

  creditEl.innerHTML = t('searchTerrainCredit', {
    terrain: terrainLink,
    attribution: terrainAttributionLink
  });
}

function updateGlobeAttribution() {
  const attributionEl = document.getElementById('globe-attribution');
  if (!attributionEl) return;

  const imageryLink = '<a href="https://doc.arcgis.com/en/data-appliance/2022/maps/world-imagery-map.htm" target="_blank" rel="noopener noreferrer">Esri, Maxar, Earthstar Geographics, and the GIS User Community</a>';
  const osmLink = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>';
  const nominatimLink = '<a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noopener noreferrer">Nominatim</a>';

  attributionEl.innerHTML =
    `<span class="globe-attribution-row"><strong>${t('globeImageryLabel')}</strong> ${imageryLink}</span>` +
    `<span class="globe-attribution-row"><strong>${t('globeGeocodingLabel')}</strong> ${osmLink} via ${nominatimLink}</span>`;
}

document.addEventListener('click', (e) => {
  const tooltip = document.getElementById('help-tooltip');
  if (tooltip && !tooltip.hidden && !tooltip.contains(e.target) && !e.target.closest('#btn-help')) {
    tooltip.hidden = true;
  }
});

function renderSavedPanel(type) {
  const isLoved = type === 'loved';
  const set = isLoved ? state.likedSpots : state.starredSpots;
  const listEl = document.getElementById(isLoved ? 'loved-list' : 'starred-list');

  if (set.size === 0) {
    listEl.innerHTML = `<p class="saved-empty">${isLoved ? t('noLovedYet') : t('noStarredYet')}<br><small>${t('emptyHint')}</small></p>`;
    return;
  }

  // Find matching viewpoints from current results
  const matched = state.results.filter(vp => set.has(makeSpotId(vp)));
  if (matched.length === 0) {
    listEl.innerHTML = `<p class="saved-empty">${isLoved ? t('lovedPrevSession') : t('starredPrevSession')}<br><small>${t('reanalyzeHint')}</small></p>`;
    return;
  }

  listEl.innerHTML = '';
  matched.forEach((vp) => {
    const scoreColor = getScoreColor(vp.score);
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-card-header">
        <span class="result-score" style="color:${scoreColor}">${Math.round(vp.score)}</span>
        <span class="result-coords">${vp.lat.toFixed(4)}°N, ${vp.lng.toFixed(4)}°E</span>
      </div>
      <div class="result-stats">
        <span class="result-stat">${t('elev')}: <strong>${Math.round(vp.elevation)}m</strong></span>
        <span class="result-stat">${t('slope')}: <strong>${vp.slope.toFixed(1)}°</strong></span>
        <span class="result-stat">${t('peak')}: <strong>${Math.round(vp.peakElevation)}m</strong></span>
        <span class="result-stat">${t('valley')}: <strong>${Math.round(vp.valleyDepth)}m</strong></span>
      </div>
    `;
    card.addEventListener('click', () => {
      state.map.setView([vp.lat, vp.lng], 14);
    });
    listEl.appendChild(card);
  });
}

// ===== Maximize / Restore =====
const MAXIMIZE_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="14" height="14" rx="1.5" stroke="white" stroke-width="1.5"/></svg>`;
const RESTORE_SVG  = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="3" width="11" height="11" rx="1.5" stroke="white" stroke-width="1.5"/><rect x="3" y="6" width="11" height="11" rx="1.5" stroke="white" stroke-width="1.5" fill="rgba(255,255,255,0.15)"/></svg>`;

function syncMaximizeButton(winId, btn) {
  if (!btn) return;
  if (isWindowMaximized(winId)) {
    btn.innerHTML = RESTORE_SVG;
    btn.title = t('restore');
  } else {
    btn.innerHTML = MAXIMIZE_SVG;
    btn.title = t('maximize');
  }
}

function syncAllMaximizeButtons() {
  if (IS_MOBILE) return;
  syncMaximizeButton('main-window', document.getElementById('btn-maximize-main'));
  syncMaximizeButton('loved-window', document.getElementById('btn-maximize-loved'));
  syncMaximizeButton('starred-window', document.getElementById('btn-maximize-starred'));
  syncMaximizeButton('radio-window', document.getElementById('btn-maximize-radio'));
}

function initMaximize(winId, btnId) {
  const win = document.getElementById(winId);
  const btn = document.getElementById(btnId);
  let savedLayout = isWindowMaximized(winId) ? loadWindowLayout(winId) : null;

  syncMaximizeButton(winId, btn);

  btn.addEventListener('click', () => {
    if (isWindowMaximized(winId)) {
      const layout = savedLayout || loadWindowLayout(winId);
      setWindowMaximizedState(winId, false);
      if (layout) {
        applyWindowLayout(win, layout);
        saveWindowLayout(winId, layout);
      }
      savedLayout = null;
    } else {
      savedLayout = captureWindowLayout(win);
      if (savedLayout) saveWindowLayout(winId, savedLayout);
      setWindowMaximizedState(winId, true);
      applyMaximizedWindowLayout(winId);
    }
    syncMaximizeButton(winId, btn);
    win.classList.add('win-maximizing');
    let rafId;
    function tickResize() {
      if (state.map) state.map.invalidateSize({ animate: false });
      if (winId === 'radio-window' && window.RadioReach) window.RadioReach.invalidateMap();
      rafId = requestAnimationFrame(tickResize);
    }
    rafId = requestAnimationFrame(tickResize);
    win.addEventListener('transitionend', () => {
      cancelAnimationFrame(rafId);
      win.classList.remove('win-maximizing');
      if (state.map) state.map.invalidateSize();
      if (winId === 'radio-window' && window.RadioReach) window.RadioReach.invalidateMap();
    }, { once: true });
  });
}

// ===== Window Dragging =====
function initWindowDrag() {
  const win = document.getElementById('main-window');
  const titlebar = document.getElementById('window-titlebar');
  
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  titlebar.addEventListener('mousedown', (e) => {
    if (isWindowMaximized('main-window')) return;
    if (e.target.closest('.titlebar-trailing')) return;
    
    isDragging = true;
    const rect = win.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    let x = e.clientX - offsetX;
    let y = e.clientY - offsetY;
    
    // Clamp to viewport
    y = Math.max(0, y);
    x = Math.max(0, Math.min(x, window.innerWidth - 100)); // ensure titlebar handles remain visible
    
    win.style.left = x + 'px';
    win.style.top = y + 'px';
    win.style.transform = 'none'; // Clear any default transforms
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.userSelect = '';
      saveWindowLayout('main-window');
    }
  });
}

// ===== Window Resizing =====
function initWindowResize() {
  const win = document.getElementById('main-window');
  const handles = win.querySelectorAll('.resize-handle');
  
  let isResizing = false;
  let currentHandle = null;
  let startX, startY, startW, startH, startLeft, startTop;

  // Min dimensions matching CSS
  const minW = 400;
  const minH = 300;

  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      if (isWindowMaximized('main-window')) return;
      isResizing = true;
      currentHandle = handle;
      
      const rect = win.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      startLeft = rect.left;
      startTop = rect.top;
      
      document.body.style.userSelect = 'none';
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    let newW = startW;
    let newH = startH;
    let newLeft = startLeft;
    let newTop = startTop;

    const classList = currentHandle.classList;
    
    // East / West
    if (classList.contains('resize-e') || classList.contains('resize-ne') || classList.contains('resize-se')) {
      newW = startW + dx;
    } else if (classList.contains('resize-w') || classList.contains('resize-nw') || classList.contains('resize-sw')) {
      newW = startW - dx;
      if (newW >= minW) newLeft = startLeft + dx;
    }
    
    // North / South
    if (classList.contains('resize-s') || classList.contains('resize-se') || classList.contains('resize-sw')) {
      newH = startH + dy;
    } else if (classList.contains('resize-n') || classList.contains('resize-ne') || classList.contains('resize-nw')) {
      newH = startH - dy;
      if (newH >= minH) newTop = startTop + dy;
    }

    // Apply limits
    newW = Math.max(minW, newW);
    newH = Math.max(minH, newH);

    win.style.width = newW + 'px';
    win.style.height = newH + 'px';
    win.style.left = newLeft + 'px';
    win.style.top = newTop + 'px';
    
    // Trigger map resize if leafet is ready
    if (state.map) state.map.invalidateSize();
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      currentHandle = null;
      document.body.style.userSelect = '';
      saveWindowLayout('main-window');
    }
  });
}

// ===== Generic XP Window Drag + Resize =====
function initXpWindow(winId, titlebarId) {
  const win = document.getElementById(winId);
  const titlebar = document.getElementById(titlebarId);

  // --- Drag ---
  let isDragging = false;
  let dragOffX = 0, dragOffY = 0;

  titlebar.addEventListener('mousedown', (e) => {
    if (isWindowMaximized(winId)) return;
    if (e.target.closest('.titlebar-trailing')) return;
    isDragging = true;
    const rect = win.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    document.body.style.userSelect = 'none';
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    let x = Math.max(0, Math.min(e.clientX - dragOffX, window.innerWidth - 100));
    let y = Math.max(0, e.clientY - dragOffY);
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) { isDragging = false; document.body.style.userSelect = ''; saveWindowLayout(winId); }
  });

  // --- Resize ---
  const handles = win.querySelectorAll('.resize-handle');
  const minW = 260, minH = 200;
  let isResizing = false;
  let currentHandle = null;
  let startX, startY, startW, startH, startLeft, startTop;

  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      if (isWindowMaximized(winId)) return;
      isResizing = true;
      currentHandle = handle;
      const rect = win.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      startW = rect.width; startH = rect.height;
      startLeft = rect.left; startTop = rect.top;
      document.body.style.userSelect = 'none';
      e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let newW = startW, newH = startH, newLeft = startLeft, newTop = startTop;
    const cl = currentHandle.classList;
    if (cl.contains('resize-e') || cl.contains('resize-ne') || cl.contains('resize-se')) newW = startW + dx;
    else if (cl.contains('resize-w') || cl.contains('resize-nw') || cl.contains('resize-sw')) { newW = startW - dx; if (newW >= minW) newLeft = startLeft + dx; }
    if (cl.contains('resize-s') || cl.contains('resize-se') || cl.contains('resize-sw')) newH = startH + dy;
    else if (cl.contains('resize-n') || cl.contains('resize-ne') || cl.contains('resize-nw')) { newH = startH - dy; if (newH >= minH) newTop = startTop + dy; }
    win.style.width  = Math.max(minW, newW) + 'px';
    win.style.height = Math.max(minH, newH) + 'px';
    win.style.left = newLeft + 'px';
    win.style.top  = newTop  + 'px';
    if (winId === 'radio-window' && window.RadioReach) window.RadioReach.invalidateMap();
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) { isResizing = false; currentHandle = null; document.body.style.userSelect = ''; saveWindowLayout(winId); }
  });
}

// Compute how many tiles a bounds selection requires (with 1-tile padding)
function countTilesForBounds(bounds) {
  const xMin = lngToTileX(bounds.getWest(), ANALYSIS_ZOOM) - 1;
  const xMax = lngToTileX(bounds.getEast(), ANALYSIS_ZOOM) + 1;
  const yMin = latToTileY(bounds.getNorth(), ANALYSIS_ZOOM) - 1;
  const yMax = latToTileY(bounds.getSouth(), ANALYSIS_ZOOM) + 1;
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}

// Validate selection size and update the Analyze button state
function validateSelection(bounds) {
  if (!bounds) {
    analyzeBtnEl.disabled = true;
    analyzeBtnTextEl.textContent = t('analyzeArea');
    return;
  }
  const tiles = countTilesForBounds(bounds);
  if (tiles > MAX_TILES) {
    analyzeBtnEl.disabled = true;
    analyzeBtnTextEl.textContent = t('areaTooLarge', {n: tiles, max: MAX_TILES});
  } else {
    analyzeBtnEl.disabled = false;
    analyzeBtnTextEl.textContent = t('analyzeArea');
  }
}

// ===== Fetch & Decode Terrain Tiles =====
async function fetchElevationGrid(bounds, zoom) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  // Compute tile range with 1-tile padding
  const xMin = lngToTileX(west, zoom) - 1;
  const xMax = lngToTileX(east, zoom) + 1;
  const yMin = latToTileY(north, zoom) - 1; // north = smaller y
  const yMax = latToTileY(south, zoom) + 1;

  const tilesX = xMax - xMin + 1;
  const tilesY = yMax - yMin + 1;
  const totalTiles = tilesX * tilesY;

  if (totalTiles > MAX_TILES) {
    throw new Error(
      `Selected area requires ${totalTiles} tiles (max ${MAX_TILES}). Please select a smaller area.`
    );
  }

  const width = tilesX * TILE_SIZE;
  const height = tilesY * TILE_SIZE;
  const elevations = new Float32Array(width * height);

  let loaded = 0;

  // Clear previous tile boundaries
  state.tileBoundaries.forEach((layer) => state.map.removeLayer(layer));
  state.tileBoundaries = [];

  // Fetch all tiles — only draw boundaries for tiles inside user selection
  const selBounds = L.latLngBounds([south, west], [north, east]);
  const promises = [];
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      const offsetX = (tx - xMin) * TILE_SIZE;
      const offsetY = (ty - yMin) * TILE_SIZE;

      const tileNorth = tileToLat(ty, zoom);
      const tileSouth = tileToLat(ty + 1, zoom);
      const tileWest = tileToLng(tx, zoom);
      const tileEast = tileToLng(tx + 1, zoom);

      const tileBounds = L.latLngBounds(
        [tileSouth, tileWest],
        [tileNorth, tileEast]
      );

      // Only show tile boundaries that overlap the user's actual selection
      let rect = null;
      if (tileBounds.intersects(selBounds)) {
        rect = L.rectangle(tileBounds, {
          color: '#09ACE2',
          weight: 1,
          fillOpacity: 0,
          dashArray: '4, 4',
          interactive: false,
        }).addTo(state.map);

        const label = L.tooltip({
          permanent: true,
          direction: 'center',
          className: 'tile-label',
        })
          .setContent(`${tx},${ty}`)
          .setLatLng(tileBounds.getCenter());
        rect.bindTooltip(label);

        state.tileBoundaries.push(rect);
      }

      const promise = getTile(zoom, tx, ty)
        .then((tileData) => {
          copyTileIntoGrid(tileData, elevations, width, offsetX, offsetY);
          loaded++;
          if (rect) rect.setStyle({ dashArray: null, color: '#09ACE2', weight: 1.5 });
          updateProgress(
            t('fetchingTiles'),
            (loaded / totalTiles) * 50,
            t('tileProgress', {loaded: loaded, total: totalTiles})
          );
        })
        .catch(() => {
          loaded++;
          if (rect) rect.setStyle({ color: '#ef4444', fillOpacity: 0.05 });
          updateProgress(
            t('fetchingTiles'),
            (loaded / totalTiles) * 50,
            t('tileProgress', {loaded: loaded, total: totalTiles})
          );
        });
      promises.push(promise);
    }
  }

  await Promise.all(promises);

  updateProgress(t('decodingElevation'), 55);

  return {
    elevations,
    width,
    height,
    tileXMin: xMin,
    tileYMin: yMin,
    zoom,
  };
}

function copyTileIntoGrid(tileData, grid, gridWidth, offsetX, offsetY) {
  for (let row = 0; row < TILE_SIZE; row++) {
    const srcStart = row * TILE_SIZE;
    const srcEnd = srcStart + TILE_SIZE;
    const destStart = (offsetY + row) * gridWidth + offsetX;
    grid.set(tileData.subarray(srcStart, srcEnd), destStart);
  }
}

// ===== Analysis Pipeline =====
async function startAnalysis() {
  if (!state.selectionBounds) return;

  const analyzeBtn = document.getElementById('analyze-btn');
  analyzeBtn.disabled = true;
  showProgress(t('startingAnalysis'));
  document.dispatchEvent(new CustomEvent('wt:analysis-start'));

  try {
    // Step 1: Fetch elevation data
    const grid = await fetchElevationGrid(state.selectionBounds, ANALYSIS_ZOOM);

    // Step 2: Send to worker for processing
    updateProgress('Running terrain analysis...', 60);

    const params = {
      minElevation: parseInt(document.getElementById('min-elevation').value),
      maxSlope: parseInt(document.getElementById('max-slope').value),
      searchRadiusKm: parseInt(document.getElementById('search-radius').value),
      minValleyDepth: parseInt(document.getElementById('min-valley-depth').value),
      minProminence: parseInt(document.getElementById('min-prominence').value),
    };

    const rawResults = await runWorkerAnalysis(grid, params);

    // Step 3: Clip results to user's selection bounds
    const results = rawResults.filter(vp =>
      state.selectionBounds.contains(L.latLng(vp.lat, vp.lng))
    );

    hideProgress();
    displayResults(results);
    document.dispatchEvent(new CustomEvent('wt:results', { detail: { count: results.length } }));
  } catch (err) {
    hideProgress();
    alert(t('analysisFailed') + err.message);
    console.error(err);
  } finally {
    analyzeBtn.disabled = false;
  }
}

function runWorkerAnalysis(grid, params) {
  return new Promise((resolve, reject) => {
    if (state.worker) state.worker.terminate();

    state.worker = new Worker('terrain-worker.js');

    state.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const text = t(msg.key, msg.params);
        const detail = msg.detailKey ? t(msg.detailKey, msg.params) : '';
        updateProgress(text, 60 + msg.percent * 0.4, detail);
      } else if (msg.type === 'result') {
        resolve(msg.viewpoints);
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    };

    state.worker.onerror = (err) => reject(err);

    // Transfer the buffer for zero-copy performance
    state.worker.postMessage(
      {
        elevations: grid.elevations.buffer,
        width: grid.width,
        height: grid.height,
        tileXMin: grid.tileXMin,
        tileYMin: grid.tileYMin,
        zoom: grid.zoom,
        params,
      },
      [grid.elevations.buffer]
    );
  });
}

// ===== Display Results =====
function clearResults() {
  if (state.clusterGroup) {
    state.map.removeLayer(state.clusterGroup);
    state.clusterGroup = null;
  }
  state.expandedMarkers.forEach((m) => state.map.removeLayer(m));
  state.expandedMarkers = [];
  state.resultMarkers = [];
  state.viewLines.forEach((l) => state.map.removeLayer(l));
  state.viewLines = [];
  state.tileBoundaries.forEach((layer) => state.map.removeLayer(layer));
  state.tileBoundaries = [];
  state.results = [];
}

function displayResults(viewpoints) {
  clearResults();
  state.results = viewpoints;

  if (viewpoints.length === 0) {
    document.getElementById('results-count').textContent = '0';
    document.getElementById('results-list').innerHTML =
      `<p style="padding:16px;color:var(--text-muted);text-align:center;">${t('noResults')}</p>`;
    document.getElementById('results-panel').hidden = false;
    return;
  }

  // Sort by score descending
  viewpoints.sort((a, b) => b.score - a.score);

  // Create cluster group with custom icon
  state.clusterGroup = L.markerClusterGroup({
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    spiderfyDistanceMultiplier: 1.8,
    iconCreateFunction: createClusterIcon,
    animate: true,
  });

  // When a cluster is clicked, break it apart permanently
  state.clusterGroup.on('clusterclick', (e) => {
    const childMarkers = e.layer.getAllChildMarkers();
    childMarkers.forEach((m) => {
      state.clusterGroup.removeLayer(m);
      m.addTo(state.map);
      state.expandedMarkers.push(m);
    });
  });

  // Create markers and result cards
  const listEl = document.getElementById('results-list');
  listEl.innerHTML = '';

  viewpoints.forEach((vp, i) => {
    const vpId = makeSpotId(vp);
    // Directional SVG marker
    const scoreColor = getScoreColor(vp.score);
    const bearing = vp.viewBearing || 0;
    const markerSvg = createDirectionalMarkerSvg(vp.score, scoreColor, bearing);

    const marker = L.marker([vp.lat, vp.lng], {
      icon: L.divIcon({
        className: 'viewpoint-marker',
        html: markerSvg,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      }),
    });

    // Store score on marker for cluster icon averaging
    marker._vpScore = vp.score;
    marker._vpId = vpId;

    marker.bindPopup(createPopupContent(vp, i, vpId));

    // Show view-line on popup open
    marker.on('popupopen', () => {
      if (vp.peakLat != null && vp.peakLng != null) {
        const line = L.polyline(
          [[vp.lat, vp.lng], [vp.peakLat, vp.peakLng]],
          { className: 'view-line', weight: 2, opacity: 0.7, dashArray: '6, 8', interactive: false }
        ).addTo(state.map);

        // Peak target marker
        const peakDot = L.circleMarker([vp.peakLat, vp.peakLng], {
          radius: 5, className: 'peak-target', fillOpacity: 0.9, weight: 1.5, interactive: false,
        }).addTo(state.map);

        marker._viewLine = line;
        marker._peakDot = peakDot;
      }
      // Wire up popup heart/star buttons
      wirePopupActions(vpId);
    });
    marker.on('popupclose', () => {
      if (marker._viewLine) { state.map.removeLayer(marker._viewLine); marker._viewLine = null; }
      if (marker._peakDot) { state.map.removeLayer(marker._peakDot); marker._peakDot = null; }
    });

    state.clusterGroup.addLayer(marker);
    state.resultMarkers.push(marker);

    // Result card
    const compassDir = bearingToCompass(bearing);
    const { geUrl, mapsUrl } = buildViewpointUrls(vp);

    const card = document.createElement('div');
    card.className = 'result-card';
    card.dataset.vpid = vpId;
    card.innerHTML = `
      <div class="result-card-header">
        <span class="result-score" style="color:${scoreColor}">${Math.round(vp.score)}</span>
        <span class="result-bearing" title="${t('viewDirection')}">
          <span class="bearing-arrow" style="transform:rotate(${bearing}deg)">↑</span>
          ${compassDir}
        </span>
        <span class="result-coords">${vp.lat.toFixed(4)}°N, ${vp.lng.toFixed(4)}°E</span>
      </div>
      <div class="result-stats">
        <span class="result-stat">${t('elev')}: <strong>${Math.round(vp.elevation)}m</strong></span>
        <span class="result-stat">${t('slope')}: <strong>${vp.slope.toFixed(1)}°</strong></span>
        <span class="result-stat">${t('peak')}: <strong>${Math.round(vp.peakElevation)}m</strong></span>
        <span class="result-stat">${t('valley')}: <strong>${Math.round(vp.valleyDepth)}m</strong></span>
      </div>
      <div class="result-actions">
        <button class="action-btn like-btn ${state.likedSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}" title="${t('loveThisSpot')}">
          ${state.likedSpots.has(vpId) ? '❤️' : '🤍'}
        </button>
        <button class="action-btn star-btn ${state.starredSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}" title="${t('starThisSpot')}">
          ${state.starredSpots.has(vpId) ? '⭐' : '☆'}
        </button>
        <a class="action-btn map-btn" href="${mapsUrl}" target="_blank" rel="noopener" title="${t('getDirections')}">🗺️</a>
        <a class="action-btn ge-btn" href="${geUrl}" target="_blank" rel="noopener" title="${t('scenic3dView')}">🌍</a>
      </div>
    `;
    // Navigate on card body click (not buttons)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.action-btn')) return;
      state.map.setView([vp.lat, vp.lng], 14);
      setTimeout(() => marker.openPopup(), 400);
    });
    // Heart
    card.querySelector('.like-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLike(vpId, card.querySelector('.like-btn'));
    });
    // Star
    card.querySelector('.star-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleStar(vpId, card.querySelector('.star-btn'));
    });
    listEl.appendChild(card);
  });

  state.map.addLayer(state.clusterGroup);

  document.getElementById('results-count').textContent = viewpoints.length;
  document.getElementById('results-panel').hidden = false;

  // Fit map to results
  if (viewpoints.length > 0) {
    state.map.fitBounds(state.clusterGroup.getBounds().pad(0.1));
  }
}

// Build Google Earth 3D scene and Maps directions URLs for a viewpoint.
// +50m altitude prevents the camera from spawning underground on steep slopes.
function buildViewpointUrls(vp) {
  const searchLat = vp.lat.toString().replace(/\./g, '%2e');
  const searchLng = vp.lng.toString().replace(/\./g, '%2e');
  const bearingDeg = Math.round(vp.viewBearing || 0);
  return {
    geUrl: `https://earth.google.com/web/search/${searchLat},${searchLng}/@${vp.lat},${vp.lng},${vp.elevation + 50}a,100d,35y,${bearingDeg}h,85t,0r`,
    mapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${vp.lat},${vp.lng}`,
  };
}

function createPopupContent(vp, index, vpId) {
  const scoreColor = getScoreColor(vp.score);
  const compass = bearingToCompass(vp.viewBearing || 0);
  const bearingDeg = Math.round(vp.viewBearing || 0);
  const { geUrl, mapsUrl } = buildViewpointUrls(vp);

  return `
    <div class="popup-title" style="color:${scoreColor}">${t('viewpointTitle', {n: index + 1, score: Math.round(vp.score)})}</div>
    <div class="popup-bearing">
      <span class="popup-bearing-arrow" style="transform:rotate(${bearingDeg}deg)">↑</span>
      ${t('viewDirectionLabel')} <strong>${compass} (${bearingDeg}°)</strong>
    </div>
    <div class="popup-grid">
      <div>
        <div class="popup-stat-label">${t('elevation')}</div>
        <div class="popup-stat-value">${Math.round(vp.elevation)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">${t('slopeLabel')}</div>
        <div class="popup-stat-value">${vp.slope.toFixed(1)}°</div>
      </div>
      <div>
        <div class="popup-stat-label">${t('nearestPeak')}</div>
        <div class="popup-stat-value">${Math.round(vp.peakElevation)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">${t('valleyDepthLabel')}</div>
        <div class="popup-stat-value">${Math.round(vp.valleyDepth)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">${t('peakDistance')}</div>
        <div class="popup-stat-value">${(vp.peakDistance / 1000).toFixed(1)} km</div>
      </div>
      <div>
        <div class="popup-stat-label">${t('prominence')}</div>
        <div class="popup-stat-value">${Math.round(vp.peakProminence)}m</div>
      </div>
    </div>
    <div class="popup-warning" role="note" aria-label="${t('accessWarning')}">
      <strong>${t('accessWarning')}:</strong> ${t('privatePropertyWarning')}
    </div>
    <div class="popup-actions">
      <button class="action-btn like-btn popup-like ${state.likedSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}">
        ${state.likedSpots.has(vpId) ? '❤️' : '🤍'} ${t('love')}
      </button>
      <button class="action-btn star-btn popup-star ${state.starredSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}">
        ${state.starredSpots.has(vpId) ? '⭐' : '☆'} ${t('star')}
      </button>
      <a class="action-btn map-btn" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ ${t('maps')}</a>
      <a class="action-btn ge-btn" href="${geUrl}" target="_blank" rel="noopener">🌍 ${t('scene3d')}</a>
    </div>
  `;
}

function wirePopupActions(vpId) {
  const likeBtn = document.querySelector('.popup-like[data-vpid="' + vpId + '"]');
  const starBtn = document.querySelector('.popup-star[data-vpid="' + vpId + '"]');
  if (likeBtn) likeBtn.addEventListener('click', () => toggleLike(vpId, likeBtn));
  if (starBtn) starBtn.addEventListener('click', () => toggleStar(vpId, starBtn));
}

function toggleLike(vpId, btn) {
  if (state.likedSpots.has(vpId)) {
    state.likedSpots.delete(vpId);
    btn.textContent = '🤍';
    btn.classList.remove('active');
  } else {
    state.likedSpots.add(vpId);
    btn.textContent = '❤️';
    btn.classList.add('active');
  }
  saveLiked();
  // sync card button if popup button was toggled
  syncActionBtn('like-btn', vpId);
  document.dispatchEvent(new CustomEvent('wt:like', { detail: { added: state.likedSpots.has(vpId) } }));
}

function toggleStar(vpId, btn) {
  if (state.starredSpots.has(vpId)) {
    state.starredSpots.delete(vpId);
    btn.textContent = '☆';
    btn.classList.remove('active');
  } else {
    state.starredSpots.add(vpId);
    btn.textContent = '⭐';
    btn.classList.add('active');
  }
  saveStarred();
  syncActionBtn('star-btn', vpId);
  document.dispatchEvent(new CustomEvent('wt:star', { detail: { added: state.starredSpots.has(vpId) } }));
}

function syncActionBtn(cls, vpId) {
  // sync all other buttons with the same vpId in DOM
  document.querySelectorAll(`.${cls}[data-vpid="${vpId}"]`).forEach(b => {
    const isLike = cls === 'like-btn';
    const active = isLike ? state.likedSpots.has(vpId) : state.starredSpots.has(vpId);
    b.classList.toggle('active', active);
    if (isLike) b.textContent = active ? '❤️' : '🤍';
    else b.textContent = active ? '⭐' : '☆';
  });
}

// ===== Directional Marker SVG =====
function createDirectionalMarkerSvg(score, color, bearing) {
  // SVG with a rotated wedge pointing in the view direction + center score circle
  return `
    <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" class="direction-marker-svg">
      <!-- Directional wedge -->
      <g transform="rotate(${bearing}, 24, 24)">
        <path d="M24 4 L30 18 Q24 14 18 18 Z" fill="${color}" opacity="0.75" />
        <path d="M24 4 L30 18 Q24 14 18 18 Z" fill="none" stroke="${color}" stroke-width="0.5" opacity="0.9" />
      </g>
      <!-- Score circle -->
      <circle cx="24" cy="24" r="13" fill="${color}" />
      <circle cx="24" cy="24" r="13" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="1" />
      <text x="24" y="28" text-anchor="middle" fill="#fff" font-size="10" font-weight="700" font-family="Ubuntu,system-ui,sans-serif">${Math.round(score)}</text>
    </svg>
  `;
}

function getScoreColor(score) {
  // Map 0-100 to warm red → cool blue (XP/7 theme)
  const hue = 190 + Math.min(30, score * 0.3); // blue → cyan range
  const sat = 70 + Math.min(20, score * 0.2);
  const light = 35 + Math.min(25, score * 0.25);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

// ===== Cluster Icon =====
function createClusterIcon(cluster) {
  const markers = cluster.getAllChildMarkers();
  const count = markers.length;

  // Average score for color
  let totalScore = 0;
  for (const m of markers) {
    totalScore += (m._vpScore || 0);
  }
  const avgScore = totalScore / count;
  const color = getScoreColor(avgScore);

  // Size scales with count
  const size = count < 10 ? 44 : count < 30 ? 50 : count < 70 ? 56 : 62;

  return L.divIcon({
    html: `<div class="cluster-icon" style="background:${color};width:${size}px;height:${size}px;">
             <span class="cluster-score">${Math.round(avgScore)}</span>
             <span class="cluster-count">${t('clusterViews', {n: count})}</span>
           </div>`,
    className: 'viewpoint-cluster',
    iconSize: L.point(size, size),
  });
}

// ===== Progress UI =====
function showProgress(text) {
  document.getElementById('progress-overlay').hidden = false;
  document.getElementById('progress-text').textContent = text;
  document.getElementById('progress-bar').style.width = '0%';
  document.getElementById('progress-detail').textContent = '';
}

function updateProgress(text, percent, detail) {
  document.getElementById('progress-text').textContent = text;
  if (percent != null) {
    document.getElementById('progress-bar').style.width = percent + '%';
  }
  if (detail != null) {
    document.getElementById('progress-detail').textContent = detail;
  }
}

function hideProgress() {
  document.getElementById('progress-overlay').hidden = true;
}

function handleLanguageChange() {
  localizeDrawLocal();
  rebuildLayerControl();
  updateSearchTerrainCreditHtml();
  updateGlobeAttribution();
  syncAllMaximizeButtons();
  validateSelection(state.selectionBounds);

  if (!document.getElementById('loved-window').hidden) {
    renderSavedPanel('loved');
  }
  if (!document.getElementById('starred-window').hidden) {
    renderSavedPanel('starred');
  }
  if (!document.getElementById('results-panel').hidden || state.results.length > 0) {
    const resultsPanel = document.getElementById('results-panel');
    const wasHidden = resultsPanel.hidden;
    displayResults(state.results.slice());
    resultsPanel.hidden = wasHidden;
  }
}
