// ===== Constants =====
const DEFAULT_CENTER = [39.0, 35.5]; // Turkey centered
const DEFAULT_ZOOM = 6;
const ANALYSIS_ZOOM = 11;
const TILE_SIZE = 256;
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const MAX_TILES = 30;

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
const COMPASS_LABELS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function bearingToCompass(deg) {
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_LABELS[idx];
}

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', init);

function init() {
  initMap();
  initDrawControls();
  initSliders();
  initButtons();
  initWindowDrag();
  initWindowResize();
  initXpWindow('loved-window', 'loved-window-titlebar');
  initXpWindow('starred-window', 'starred-window-titlebar');
  // Invalidate map size after layout settles (flush side panel)
  requestAnimationFrame(() => {
    if (state.map) state.map.invalidateSize();
  });
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
      attribution: '&copy; <a href="https://osm.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }
  );

  // OpenTopoMap layer
  const topo = L.tileLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
      maxZoom: 17,
    }
  );

  osm.addTo(state.map);

  L.control.layers({ 'Standard': osm, 'Topographic': topo }, null, { position: 'topright' }).addTo(state.map);
  L.control.zoom({ position: 'topright' }).addTo(state.map);
}

// ===== Draw Controls =====
function initDrawControls() {
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
      rectangle: {
        shapeOptions: {
          color: '#09ACE2',
          weight: 2,
          fillOpacity: 0.1,
          dashArray: '8, 6',
        },
      },
    },
    edit: {
      featureGroup: state.drawnItems,
      remove: true,
    },
  });

  state.map.addControl(drawControl);

  state.map.on(L.Draw.Event.CREATED, (e) => {
    state.drawnItems.clearLayers();
    state.drawnItems.addLayer(e.layer);
    state.selectionBounds = e.layer.getBounds();
    document.getElementById('analyze-btn').disabled = false;
  });

  state.map.on(L.Draw.Event.DELETED, () => {
    state.selectionBounds = null;
    document.getElementById('analyze-btn').disabled = true;
  });
}

// ===== Slider Bindings =====
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
    input.addEventListener('input', () => {
      display.textContent = input.value + suffix;
    });
  });
}

// ===== Button Bindings =====
function initButtons() {
  document.getElementById('analyze-btn').addEventListener('click', startAnalysis);

  document.getElementById('clear-btn').addEventListener('click', () => {
    clearResults();
    document.getElementById('clear-btn').hidden = true;
    document.getElementById('results-panel').hidden = true;
  });

  document.getElementById('close-results').addEventListener('click', () => {
    document.getElementById('results-panel').hidden = true;
  });


  // Window chrome buttons
  document.getElementById('btn-close').addEventListener('click', () => {
    const win = document.getElementById('main-window');
    const icon = document.getElementById('icon-search-spots');
    closeWindow(win, icon);
  });

  document.getElementById('btn-help').addEventListener('click', () => {
    alert('ScenicView — Terrain Analysis Tool\n\n'
      + '1. Use the rectangle tool to select an area on the map\n'
      + '2. Adjust analysis sliders as needed\n'
      + '3. Click "Analyze Area" to find scenic viewpoints\n\n'
      + 'Results show viewpoints scored by elevation, slope, and nearby peaks.');
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

  // Close secondary windows
  document.getElementById('btn-close-loved').addEventListener('click', () => {
    closeWindow(document.getElementById('loved-window'), document.getElementById('icon-loved-spots'));
  });
  document.getElementById('btn-close-starred').addEventListener('click', () => {
    closeWindow(document.getElementById('starred-window'), document.getElementById('icon-starred-spots'));
  });

  // Bring any window to front on click
  ['main-window', 'loved-window', 'starred-window'].forEach(id => {
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
    const offset = type === 'loved' ? 0 : 344;
    win.style.top = '120px';
    win.style.left = `calc(50% - 160px + ${offset}px)`;
    win.style.width = '320px';
    win.style.height = '460px';
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
};

function openWindow(winEl, iconEl) {
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

function renderSavedPanel(type) {
  const isLoved = type === 'loved';
  const set = isLoved ? state.likedSpots : state.starredSpots;
  const listEl = document.getElementById(isLoved ? 'loved-list' : 'starred-list');

  if (set.size === 0) {
    listEl.innerHTML = `<p class="saved-empty">${isLoved ? '❤️' : '⭐'} No ${isLoved ? 'loved' : 'starred'} spots yet.<br><small>Run an analysis and heart/star spots you like!</small></p>`;
    return;
  }

  // Find matching viewpoints from current results
  const matched = state.results.filter(vp => set.has(makeSpotId(vp)));
  if (matched.length === 0) {
    listEl.innerHTML = `<p class="saved-empty">Your ${isLoved ? 'loved' : 'starred'} spots are from a previous session.<br><small>Re-analyze the area to see them on the map.</small></p>`;
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
        <span class="result-stat">Elev: <strong>${Math.round(vp.elevation)}m</strong></span>
        <span class="result-stat">Slope: <strong>${vp.slope.toFixed(1)}°</strong></span>
        <span class="result-stat">Peak: <strong>${Math.round(vp.peakElevation)}m</strong></span>
        <span class="result-stat">Valley: <strong>${Math.round(vp.valleyDepth)}m</strong></span>
      </div>
    `;
    card.addEventListener('click', () => {
      state.map.setView([vp.lat, vp.lng], 14);
    });
    listEl.appendChild(card);
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
    isDragging = false;
    document.body.style.userSelect = '';
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
    isResizing = false;
    currentHandle = null;
    document.body.style.userSelect = '';
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
    if (isDragging) { isDragging = false; document.body.style.userSelect = ''; }
  });

  // --- Resize ---
  const handles = win.querySelectorAll('.resize-handle');
  const minW = 260, minH = 200;
  let isResizing = false;
  let currentHandle = null;
  let startX, startY, startW, startH, startLeft, startTop;

  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
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
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) { isResizing = false; currentHandle = null; document.body.style.userSelect = ''; }
  });
}

function lngToTileX(lng, zoom) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
}

function tileToLng(x, zoom) {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tileToLat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
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

  // Create a canvas for decoding
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let loaded = 0;

  // Clear previous tile boundaries
  state.tileBoundaries.forEach((layer) => state.map.removeLayer(layer));
  state.tileBoundaries = [];

  // Fetch all tiles and draw boundaries
  const promises = [];
  for (let ty = yMin; ty <= yMax; ty++) {
    for (let tx = xMin; tx <= xMax; tx++) {
      const offsetX = (tx - xMin) * TILE_SIZE;
      const offsetY = (ty - yMin) * TILE_SIZE;

      // Draw tile boundary on map
      const tileNorth = tileToLat(ty, zoom);
      const tileSouth = tileToLat(ty + 1, zoom);
      const tileWest = tileToLng(tx, zoom);
      const tileEast = tileToLng(tx + 1, zoom);

      const tileBounds = L.latLngBounds(
        [tileSouth, tileWest],
        [tileNorth, tileEast]
      );

      const rect = L.rectangle(tileBounds, {
        color: '#09ACE2',
        weight: 1,
        fillOpacity: 0,
        dashArray: '4, 4',
        interactive: false,
      }).addTo(state.map);

      // Label with tile coords
      const label = L.tooltip({
        permanent: true,
        direction: 'center',
        className: 'tile-label',
      })
        .setContent(`${tx},${ty}`)
        .setLatLng(tileBounds.getCenter());
      rect.bindTooltip(label);

      state.tileBoundaries.push(rect);

      const promise = fetchTileImage(zoom, tx, ty)
        .then((img) => {
          ctx.drawImage(img, offsetX, offsetY);
          loaded++;
          // Mark tile as loaded (solid border)
          rect.setStyle({ dashArray: null, color: '#09ACE2', weight: 1.5 });
          updateProgress(
            'Fetching elevation tiles...',
            (loaded / totalTiles) * 50,
            `${loaded} / ${totalTiles} tiles`
          );
        })
        .catch(() => {
          // Tile missing (ocean, etc.) — mark as failed
          rect.setStyle({ color: '#ef4444', fillOpacity: 0.05 });
          loaded++;
          updateProgress(
            'Fetching elevation tiles...',
            (loaded / totalTiles) * 50,
            `${loaded} / ${totalTiles} tiles`
          );
        });
      promises.push(promise);
    }
  }

  await Promise.all(promises);

  // Decode all pixels
  updateProgress('Decoding elevation data...', 55);
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    elevations[i] = r * 256 + g + b / 256 - 32768;
  }

  return {
    elevations,
    width,
    height,
    tileXMin: xMin,
    tileYMin: yMin,
    zoom,
  };
}

function fetchTileImage(zoom, x, y) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `${TERRAIN_URL}/${zoom}/${x}/${y}.png`;
  });
}

// ===== Analysis Pipeline =====
async function startAnalysis() {
  if (!state.selectionBounds) return;

  const analyzeBtn = document.getElementById('analyze-btn');
  analyzeBtn.disabled = true;
  showProgress('Starting analysis...');

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

    const results = await runWorkerAnalysis(grid, params);

    // Step 3: Display results
    hideProgress();
    displayResults(results);
    document.getElementById('clear-btn').hidden = false;
  } catch (err) {
    hideProgress();
    alert('Analysis failed: ' + err.message);
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
        updateProgress(msg.text, 60 + msg.percent * 0.4, msg.detail);
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
      '<p style="padding:16px;color:var(--text-muted);text-align:center;">No viewpoints matched your criteria. Try adjusting the filters or selecting a different area.</p>';
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
    const card = document.createElement('div');
    card.className = 'result-card';
    card.dataset.vpid = vpId;
    card.innerHTML = `
      <div class="result-card-header">
        <span class="result-score" style="color:${scoreColor}">${Math.round(vp.score)}</span>
        <span class="result-bearing" title="View direction">
          <span class="bearing-arrow" style="transform:rotate(${bearing}deg)">↑</span>
          ${compassDir}
        </span>
        <span class="result-coords">${vp.lat.toFixed(4)}°N, ${vp.lng.toFixed(4)}°E</span>
      </div>
      <div class="result-stats">
        <span class="result-stat">Elev: <strong>${Math.round(vp.elevation)}m</strong></span>
        <span class="result-stat">Slope: <strong>${vp.slope.toFixed(1)}°</strong></span>
        <span class="result-stat">Peak: <strong>${Math.round(vp.peakElevation)}m</strong></span>
        <span class="result-stat">Valley: <strong>${Math.round(vp.valleyDepth)}m</strong></span>
      </div>
      <div class="result-actions">
        <button class="action-btn like-btn ${state.likedSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}" title="Love this spot">
          ${state.likedSpots.has(vpId) ? '❤️' : '🤍'}
        </button>
        <button class="action-btn star-btn ${state.starredSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}" title="Star this spot">
          ${state.starredSpots.has(vpId) ? '⭐' : '☆'}
        </button>
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

function createPopupContent(vp, index, vpId) {
  const scoreColor = getScoreColor(vp.score);
  const compass = bearingToCompass(vp.viewBearing || 0);
  const bearingDeg = Math.round(vp.viewBearing || 0);
  return `
    <div class="popup-title" style="color:${scoreColor}">Viewpoint #${index + 1} — Score: ${Math.round(vp.score)}</div>
    <div class="popup-bearing">
      <span class="popup-bearing-arrow" style="transform:rotate(${bearingDeg}deg)">↑</span>
      View Direction: <strong>${compass} (${bearingDeg}°)</strong>
    </div>
    <div class="popup-grid">
      <div>
        <div class="popup-stat-label">Elevation</div>
        <div class="popup-stat-value">${Math.round(vp.elevation)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">Slope</div>
        <div class="popup-stat-value">${vp.slope.toFixed(1)}°</div>
      </div>
      <div>
        <div class="popup-stat-label">Nearest Peak</div>
        <div class="popup-stat-value">${Math.round(vp.peakElevation)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">Valley Depth</div>
        <div class="popup-stat-value">${Math.round(vp.valleyDepth)}m</div>
      </div>
      <div>
        <div class="popup-stat-label">Peak Distance</div>
        <div class="popup-stat-value">${(vp.peakDistance / 1000).toFixed(1)} km</div>
      </div>
      <div>
        <div class="popup-stat-label">Prominence</div>
        <div class="popup-stat-value">${Math.round(vp.peakProminence)}m</div>
      </div>
    </div>
    <div class="popup-actions">
      <button class="action-btn like-btn popup-like ${state.likedSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}">
        ${state.likedSpots.has(vpId) ? '❤️' : '🤍'} Love
      </button>
      <button class="action-btn star-btn popup-star ${state.starredSpots.has(vpId) ? 'active' : ''}" data-vpid="${vpId}">
        ${state.starredSpots.has(vpId) ? '⭐' : '☆'} Star
      </button>
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
      <text x="24" y="28" text-anchor="middle" fill="#fff" font-size="10" font-weight="700" font-family="Inter,system-ui,sans-serif">${Math.round(score)}</text>
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
             <span class="cluster-count">${count} views</span>
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
