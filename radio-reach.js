// ===== Radio Reach — Longley-Rice Propagation Coverage App =====
// Full-window app with its own Leaflet map, collapsible filter sidebar,
// progress overlay, and gradient coverage canvas.

(function () {
  'use strict';

  var TerrainTiles = window.TerrainTiles;
  var getTile = TerrainTiles.getTile;
  var getTileWithMetadata = TerrainTiles.getTileWithMetadata;
  var metersPerPixel = TerrainTiles.metersPerPixel;
  var tileToLat = TerrainTiles.tileToLat;
  var tileToLng = TerrainTiles.tileToLng;
  var t = window.i18n.t;
  var ANALYSIS_ZOOM = 12;
  var EARTH_RADIUS = 6378137;
  var MAX_RADIUS_KM = 1000;
  var MAX_TILES_LIMIT = 2000;
  var MAX_BITMAP_MB = 300;
  var COVERAGE_BUFFER_KM = 4;
  var BROWSER_OVERHEAD_MB = 180;
  var TILE_BYTES_PER_TILE = 256 * 256 * 4;
  var PROP_WORKER_OVERHEAD_MB = 32;
  var MEMORY_RISK_RATIO_WARN = 0.35;
  var MEMORY_RISK_RATIO_BLOCK = 0.6;
  var SWEEP_TILE_FETCH_CONCURRENCY = 4;
  var RADAR_SWEEP_WEDGE_DEG = 10;
  var RADIO_DEBUG_PANE = 'radio-debug-pane';
  var RADIO_PREVIEW_PANE = 'radio-preview-pane';
  // ImageData (4 B/px) + band buffer (1 B/px) + canvas backing store (~4 B/px).
  var BITMAP_BYTES_PER_PIXEL = 9;
  var PROP_WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  // Attribution strings
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var TOPO_ATTR = 'Map data: ' + OSM_ATTR + ', SRTM | Map style: &copy; <a href="https://opentopomap.org/about">OpenTopoMap</a> (CC-BY-SA)';

  var radioState = {
    map: null,
    marker: null,
    directionLat: null,
    directionLng: null,
    debugLayer: null,
    previewLayer: null,
    lat: null,
    lng: null,
    worker: null,
    propWorkers: [],
    canvasLayer: null,
    running: false,
    startTime: 0,
    analysisToken: 0,
    coverageBounds: null,
    analysisTileCount: 0,
    analysisTileKeys: null,
    debugRefreshQueued: false,
    debugTileRecords: null,
    customPattern: null,
    customPatternName: '',
    customPatternInvalid: false,
  };

  // ===== DOM refs (cached on init) =====
  var coordsEl, instructionEl, warningEl, analyzeBtnEl, clearBtnEl,
      progressOverlayEl, progressBarEl, progressTextEl,
      statsPanelEl, statsEl, eirpDisplayEl,
      antennaInput, radiusInput, frequencySelect, frequencyCustomGroup,
      frequencyCustomInput, txPowerInput, txGainInput,
      rxGainInput, rxHeightInput, rxHeightPresetSelect,
      rxSensitivityInput, rxSensitivityPresetSelect,
      patternPresetSelect, patternBearingInput, patternUploadGroup,
      patternUploadBtn, patternFileInput, patternFileStatusEl,
      resolutionSelect, sectorAngleInput,
      controlsPanel, controlsToggle, legendEl, unfilteredCheck,
      radarSweepCheck, adaptiveCullingCheck, fastFillCheck,
      clearDirectionBtn, fastFillLabelEl, radioTerrainCreditEl, itmEngineSelect,
      advancedSettingsEl, debugDownloadedTilesCheck, debugSkippedTilesCheck,
      debugTileBordersCheck, debugWedgeBordersCheck, debugAnalysisBoundsCheck;

  // ===== Expose for app.js wiring =====
  window.RadioReach = {
    init: init,
    invalidateMap: invalidateMap,
  };

  function init() {
    coordsEl = document.getElementById('radio-coords');
    instructionEl = document.getElementById('radio-instruction');
    warningEl = document.getElementById('radio-warning');
    analyzeBtnEl = document.getElementById('radio-analyze-btn');
    clearBtnEl = document.getElementById('radio-clear-btn');
    progressOverlayEl = document.getElementById('radio-progress-overlay');
    progressBarEl = document.getElementById('radio-progress-bar');
    progressTextEl = document.getElementById('radio-progress-text');
    statsPanelEl = document.getElementById('radio-stats-panel');
    statsEl = document.getElementById('radio-stats');
    eirpDisplayEl = document.getElementById('radio-eirp-display');
    antennaInput = document.getElementById('radio-antenna-height');
    radiusInput = document.getElementById('radio-radius');
    sectorAngleInput = document.getElementById('radio-sector-angle');
    frequencySelect = document.getElementById('radio-frequency');
    frequencyCustomGroup = document.getElementById('radio-frequency-custom-group');
    frequencyCustomInput = document.getElementById('radio-frequency-custom');
    resolutionSelect = document.getElementById('radio-resolution');
    txPowerInput = document.getElementById('radio-tx-power');
    txGainInput = document.getElementById('radio-tx-gain');
    rxGainInput = document.getElementById('radio-rx-gain');
    rxHeightInput = document.getElementById('radio-rx-height');
    rxHeightPresetSelect = document.getElementById('radio-rx-height-preset');
    rxSensitivityInput = document.getElementById('radio-rx-sensitivity');
    rxSensitivityPresetSelect = document.getElementById('radio-rx-sensitivity-preset');
    patternPresetSelect = document.getElementById('radio-pattern-preset');
    patternBearingInput = document.getElementById('radio-pattern-bearing');
    patternUploadGroup = document.getElementById('radio-pattern-upload-group');
    patternUploadBtn = document.getElementById('radio-pattern-upload-btn');
    patternFileInput = document.getElementById('radio-pattern-file');
    patternFileStatusEl = document.getElementById('radio-pattern-file-status');
    legendEl = document.getElementById('radio-legend');
    controlsPanel = document.getElementById('radio-controls-panel');
    controlsToggle = document.getElementById('radio-controls-toggle');
    unfilteredCheck = document.getElementById('radio-unfiltered');
    radarSweepCheck = document.getElementById('radio-radar-sweep');
    adaptiveCullingCheck = document.getElementById('radio-adaptive-culling');
    fastFillCheck = document.getElementById('radio-fast-fill');
    fastFillLabelEl = document.getElementById('radio-fast-fill-label');
    clearDirectionBtn = document.getElementById('radio-clear-direction');
    radioTerrainCreditEl = document.getElementById('radio-terrain-credit');
    itmEngineSelect = document.getElementById('radio-itm-engine');
    advancedSettingsEl = document.getElementById('radio-advanced-settings');
    debugDownloadedTilesCheck = document.getElementById('radio-debug-downloaded-tiles');
    debugSkippedTilesCheck = document.getElementById('radio-debug-skipped-tiles');
    debugTileBordersCheck = document.getElementById('radio-debug-tile-borders');
    debugWedgeBordersCheck = document.getElementById('radio-debug-wedge-borders');
    debugAnalysisBoundsCheck = document.getElementById('radio-debug-analysis-bounds');

    analyzeBtnEl.addEventListener('click', startAnalysis);
    clearBtnEl.addEventListener('click', clearAll);
    if (clearDirectionBtn) clearDirectionBtn.addEventListener('click', clearDirectionTarget);

    // Stats panel close button
    document.getElementById('radio-close-stats').addEventListener('click', function () {
      statsPanelEl.hidden = true;
    });
    document.addEventListener('i18n:changed', function () {
      updateTerrainCreditHtml();
      updatePatternUi();
      updateEirpDisplay();
    });

    bindWarningInputs();
    bindDebugInputs();
    syncFastFillControl();
    initAdvancedSettings();
    initReceiverPresets();
    initFrequencyControls();
    initPatternControls();
    updateEirpDisplay();
    updateTerrainCreditHtml();
    updateAnalysisWarning();

    // Controls panel toggle
    initControlsToggle();

    // Initialize own Leaflet map
    initMap();
    updateDirectionPreview();
  }

  // ===== Map =====
  function initMap() {
    radioState.map = L.map('radio-map', {
      center: [39.9, 32.8],
      zoom: 7,
      zoomControl: false,
    });
    var debugPane = radioState.map.createPane(RADIO_DEBUG_PANE);
    debugPane.style.zIndex = '540';
    debugPane.style.pointerEvents = 'none';
    var previewPane = radioState.map.createPane(RADIO_PREVIEW_PANE);
    previewPane.style.zIndex = '550';
    previewPane.style.pointerEvents = 'none';
    radioState.debugLayer = L.layerGroup().addTo(radioState.map);
    radioState.previewLayer = L.layerGroup().addTo(radioState.map);

    // Base layers
    var topo = L.tileLayer(
      'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { attribution: TOPO_ATTR, maxZoom: 17 }
    );
    var osm = L.tileLayer(
      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      { attribution: OSM_ATTR, maxZoom: 19 }
    );
    var satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 }
    );

    topo.addTo(radioState.map);

    var baseLayers = {};
    baseLayers[t('layerTopographic')] = topo;
    baseLayers[t('layerStandard')] = osm;
    baseLayers[t('layerSatellite')] = satellite;
    L.control.layers(baseLayers, null, { position: 'topright' }).addTo(radioState.map);
    L.control.zoom({ position: 'topright' }).addTo(radioState.map);

    // Restore saved position
    var savedView = localStorage.getItem('sv_radio_map_view') || localStorage.getItem('sv_map_view');
    if (savedView) {
      try {
        var v = JSON.parse(savedView);
        radioState.map.setView([v.lat, v.lng], v.zoom);
      } catch (e) {}
    }

    // Persist position
    radioState.map.on('moveend', function () {
      var c = radioState.map.getCenter();
      localStorage.setItem('sv_radio_map_view', JSON.stringify({
        lat: c.lat, lng: c.lng, zoom: radioState.map.getZoom(),
      }));
    });

    radioState.map.getContainer().addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    // Map click places transmitter
    radioState.map.on('click', function (e) {
      handleMapClick(e.latlng);
    });
    radioState.map.on('contextmenu', function (e) {
      if (e.originalEvent) e.originalEvent.preventDefault();
      handleDirectionTarget(e.latlng);
    });
  }

  function invalidateMap() {
    if (radioState.map) {
      radioState.map.invalidateSize();
    }
  }

  // ===== Controls Panel Toggle =====
  function initControlsToggle() {
    var IS_MOBILE = window.matchMedia('(max-width: 600px)').matches && ('ontouchstart' in window);
    var storageKey = 'sv_radio_filters_collapsed';

    if (IS_MOBILE || localStorage.getItem(storageKey) === '1') {
      controlsPanel.style.transition = 'none';
      controlsToggle.style.transition = 'none';
      controlsPanel.classList.add('collapsed');
      controlsToggle.classList.add('collapsed');
      requestAnimationFrame(function () {
        controlsPanel.style.transition = '';
        controlsToggle.style.transition = '';
        invalidateMap();
      });
    }

    controlsToggle.addEventListener('click', function () {
      controlsPanel.classList.toggle('collapsed');
      controlsToggle.classList.toggle('collapsed');
      localStorage.setItem(storageKey, controlsPanel.classList.contains('collapsed') ? '1' : '0');
      requestAnimationFrame(function () {
        setTimeout(function () { invalidateMap(); }, 310);
      });
    });
  }

  function initAdvancedSettings() {
    if (!advancedSettingsEl) return;

    var storageKey = 'sv_radio_advanced_open';
    if (localStorage.getItem(storageKey) === '1') {
      advancedSettingsEl.open = true;
    }

    advancedSettingsEl.addEventListener('toggle', function () {
      localStorage.setItem(storageKey, advancedSettingsEl.open ? '1' : '0');
    });
  }

  function initReceiverPresets() {
    bindPresetSelect(rxHeightInput, rxHeightPresetSelect, [1.5, 2, 10, 30]);
    bindPresetSelect(rxSensitivityInput, rxSensitivityPresetSelect, [-110, -116, -130, -140]);
  }

  function initPatternControls() {
    if (patternPresetSelect) {
      patternPresetSelect.addEventListener('change', function () {
        updatePatternUi();
        refreshAnalysisUiState();
      });
    }

    if (patternUploadBtn && patternFileInput) {
      patternUploadBtn.addEventListener('click', function () {
        patternFileInput.click();
      });
      patternFileInput.addEventListener('change', handlePatternFileSelected);
    }

    updatePatternUi();
  }

  function initFrequencyControls() {
    updateFrequencyUi();
  }

  function updateFrequencyUi() {
    if (!frequencySelect || !frequencyCustomGroup) return;
    frequencyCustomGroup.hidden = frequencySelect.value !== 'custom';
  }

  function getSelectedFrequencyMHz() {
    if (frequencySelect && frequencySelect.value === 'custom') {
      var customMHz = clampNumber(frequencyCustomInput.value, 0.1, 20000, 144);
      if (frequencyCustomInput) frequencyCustomInput.value = customMHz;
      return customMHz;
    }
    return parseFloat(frequencySelect.value);
  }

  function supportsITMFrequency(freqMHz) {
    return freqMHz >= 20 && freqMHz <= 20000;
  }

  function handlePatternFileSelected() {
    if (!patternFileInput || !patternFileInput.files || !patternFileInput.files[0]) return;

    var file = patternFileInput.files[0];
    var reader = new FileReader();

    reader.onload = function () {
      try {
        radioState.customPattern = parseCustomPattern(String(reader.result || ''));
        radioState.customPatternName = file.name;
        radioState.customPatternInvalid = false;
      } catch (err) {
        radioState.customPattern = null;
        radioState.customPatternName = '';
        radioState.customPatternInvalid = true;
      }

      patternFileInput.value = '';
      updatePatternUi();
      refreshAnalysisUiState();
    };

    reader.onerror = function () {
      radioState.customPattern = null;
      radioState.customPatternName = '';
      radioState.customPatternInvalid = true;
      patternFileInput.value = '';
      updatePatternUi();
    };

    reader.readAsText(file);
  }

  function parseCustomPattern(text) {
    var lines = text.split(/\r?\n/).map(function (line) {
      return line.trim();
    }).filter(function (line) {
      return line.length > 0;
    });

    if (lines.length !== 360) {
      throw new Error('Expected 360 numeric lines');
    }

    var pattern = new Float32Array(360);
    for (var i = 0; i < 360; i++) {
      var value = parseFloat(lines[i]);
      if (!isFinite(value)) {
        throw new Error('Invalid numeric value at line ' + (i + 1));
      }
      pattern[i] = value;
    }

    return pattern;
  }

  function updatePatternUi() {
    if (!patternPresetSelect) return;

    var isCustom = patternPresetSelect.value === 'custom';
    if (patternUploadGroup) {
      patternUploadGroup.hidden = !isCustom;
    }
    if (!patternFileStatusEl) return;

    if (!isCustom) {
      patternFileStatusEl.hidden = true;
      patternFileStatusEl.textContent = '';
      return;
    }

    patternFileStatusEl.hidden = false;
    if (radioState.customPatternInvalid) {
      patternFileStatusEl.textContent = t('radioPatternInvalid');
    } else if (radioState.customPattern && radioState.customPatternName) {
      patternFileStatusEl.textContent = t('radioPatternLoaded', { name: radioState.customPatternName });
    } else {
      patternFileStatusEl.textContent = t('radioPatternAwaitingFile');
    }
  }

  function getPatternConfig() {
    var preset = patternPresetSelect ? patternPresetSelect.value : 'omni';
    var bearingDeg = patternBearingInput ? clampNumber(patternBearingInput.value, 0, 359, 0) : 0;
    if (patternBearingInput) patternBearingInput.value = bearingDeg;

    return {
      preset: preset,
      bearingDeg: bearingDeg,
      pattern: buildPatternForPreset(preset)
    };
  }

  function buildPatternForPreset(preset) {
    if (preset === 'custom') {
      return radioState.customPattern ? new Float32Array(radioState.customPattern) : createOmniPattern();
    }
    if (preset === 'dipole') return createDipolePattern();
    if (preset === 'yagi3') return createYagi3Pattern();
    if (preset === 'yagi5') return createYagi5Pattern();
    if (preset === 'cardioid') return createCardioidPattern();
    return createOmniPattern();
  }

  function createPattern(generator) {
    var pattern = new Float32Array(360);
    for (var deg = 0; deg < 360; deg++) {
      pattern[deg] = generator(deg * Math.PI / 180, deg);
    }
    return pattern;
  }

  function createOmniPattern() {
    return new Float32Array(360);
  }

  function createDipolePattern() {
    return createPattern(function (rad) {
      return -40 * Math.pow(Math.sin(rad), 2);
    });
  }

  function createYagi3Pattern() {
    return createPattern(function (rad) {
      return -Math.min(22, 18 * Math.pow(Math.sin(rad / 2), 2) + 4 * Math.pow(Math.sin(rad), 2));
    });
  }

  function createYagi5Pattern() {
    return createPattern(function (rad) {
      return -Math.min(28, 24 * Math.pow(Math.sin(rad / 2), 2) + 10 * Math.pow(Math.sin(rad), 4));
    });
  }

  function createCardioidPattern() {
    return createPattern(function (rad) {
      return -20 * Math.pow(Math.sin(rad / 2), 2);
    });
  }

  function bindPresetSelect(inputEl, selectEl, presetValues) {
    if (!inputEl || !selectEl) return;

    function syncFromInput() {
      var value = parseFloat(inputEl.value);
      var matched = false;
      for (var i = 0; i < presetValues.length; i++) {
        if (!isNaN(value) && Math.abs(value - presetValues[i]) < 0.0001) {
          selectEl.value = String(presetValues[i]);
          matched = true;
          break;
        }
      }
      if (!matched) {
        selectEl.value = 'custom';
      }
    }

    selectEl.addEventListener('change', function () {
      if (selectEl.value !== 'custom') {
        inputEl.value = selectEl.value;
      }
      refreshAnalysisUiState();
    });

    inputEl.addEventListener('input', syncFromInput);
    inputEl.addEventListener('change', syncFromInput);

    syncFromInput();
  }

  function refreshAnalysisUiState() {
    updateEirpDisplay();
    updateAnalysisWarning();
    updateDirectionPreview();
  }

  function updateEirpDisplay() {
    if (!eirpDisplayEl) return;

    var p = parseFloat(txPowerInput.value) || 0;
    var g = parseFloat(txGainInput.value) || 0;
    var eirpDbW = 10 * Math.log10(p) + g;
    var eirpW = Math.pow(10, eirpDbW / 10);

    eirpDisplayEl.textContent = t('radioEirpDisplay', {
      w: eirpW.toFixed(1),
      dbw: eirpDbW.toFixed(1)
    });
  }

  // ===== Map Click Handler =====
  function handleMapClick(latlng) {
    if (radioState.running) return;

    radioState.lat = latlng.lat;
    radioState.lng = latlng.lng;

    if (radioState.marker) {
      radioState.marker.setLatLng(latlng);
    } else {
      radioState.marker = L.marker(latlng, {
        icon: L.divIcon({
          className: 'radio-tx-marker',
          html: '<div class="radio-tx-dot"></div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
      }).addTo(radioState.map);
    }

    coordsEl.textContent = t('radioSelectedPoint') + ': ' +
      radioState.lat.toFixed(5) + ', ' + radioState.lng.toFixed(5);
    coordsEl.hidden = false;
    instructionEl.hidden = true;
    analyzeBtnEl.disabled = false;
    updateDirectionPreview();
    updateAnalysisWarning();
  }

  function handleDirectionTarget(latlng) {
    if (radioState.running || radioState.lat === null) return;

    radioState.directionLat = latlng.lat;
    radioState.directionLng = latlng.lng;

    updateDirectionPreview();
    updateAnalysisWarning();
  }

  function clearDirectionTarget() {
    radioState.directionLat = null;
    radioState.directionLng = null;
    updateDirectionPreview();
    updateAnalysisWarning();
  }

  function getSectorConfig() {
    var angleDeg = sectorAngleInput ? clampNumber(sectorAngleInput.value, 1, 360, 60) : 60;
    if (sectorAngleInput) sectorAngleInput.value = angleDeg;

    if (radioState.lat === null || radioState.lng === null ||
        radioState.directionLat === null || radioState.directionLng === null) {
      return {
        hasTarget: false,
        enabled: false,
        angleDeg: angleDeg,
        bearingDeg: 0
      };
    }

    return {
      hasTarget: true,
      enabled: angleDeg < 360,
      angleDeg: angleDeg,
      bearingDeg: bearingFromLatLng(
        radioState.lat,
        radioState.lng,
        radioState.directionLat,
        radioState.directionLng
      )
    };
  }

  function hasDirectionTarget() {
    return radioState.directionLat !== null && radioState.directionLng !== null;
  }

  function updateDirectionPreview() {
    if (!radioState.previewLayer) return;

    radioState.previewLayer.clearLayers();
    syncSectorAngleControl();
    if (clearDirectionBtn) {
      clearDirectionBtn.hidden = !hasDirectionTarget();
    }
    scheduleDebugOverlayRefresh();

    if (radioState.lat === null || radioState.lng === null) return;

    var txLatLng = L.latLng(radioState.lat, radioState.lng);
    var radiusKm = clampNumber(radiusInput.value, 5, MAX_RADIUS_KM, 30);
    var radiusM = radiusKm * 1000;
    var txPowerW = clampNumber(txPowerInput.value, 0.1, 100, 5);
    var txGainDbi = clampNumber(txGainInput.value, -10, 30, 0);
    var rxGainDbi = clampNumber(rxGainInput.value, -10, 30, 0);
    var rxSensitivityDbW = clampNumber(rxSensitivityInput.value, -150, -50, -110) - 30;
    var freqMHz = getSelectedFrequencyMHz();
    var radarSweep = !!(radarSweepCheck && radarSweepCheck.checked);
    var powerLimitM = freeSpaceMaxDistanceM(txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW);

    L.circle(txLatLng, {
      pane: RADIO_PREVIEW_PANE,
      radius: radiusM,
      color: '#09ACE2',
      weight: 2,
      opacity: 0.75,
      dashArray: '10 8',
      fillColor: '#09ACE2',
      fillOpacity: 0.03,
      interactive: false
    }).addTo(radioState.previewLayer);

    if (!radarSweep && powerLimitM < radiusM - 1) {
      L.circle(txLatLng, {
        pane: RADIO_PREVIEW_PANE,
        radius: powerLimitM,
        color: '#D5B456',
        weight: 2,
        opacity: 0.95,
        dashArray: '4 6',
        fillColor: '#D5B456',
        fillOpacity: 0.05,
        interactive: false
      }).addTo(radioState.previewLayer);
    }

    if (!hasDirectionTarget()) {
      return;
    }

    var targetLatLng = L.latLng(radioState.directionLat, radioState.directionLng);
    var sectorConfig = getSectorConfig();

    L.polyline([txLatLng, targetLatLng], {
      pane: RADIO_PREVIEW_PANE,
      color: '#D5B456',
      weight: 2,
      opacity: 0.9,
      dashArray: '6 6',
      interactive: false
    }).addTo(radioState.previewLayer);

    L.circleMarker(targetLatLng, {
      pane: RADIO_PREVIEW_PANE,
      radius: 6,
      color: '#8C6B12',
      weight: 2,
      fillColor: '#FFF2C0',
      fillOpacity: 0.95,
      interactive: false
    }).addTo(radioState.previewLayer);

    if (!sectorConfig.enabled) return;

    var radiusKm = clampNumber(radiusInput.value, 5, MAX_RADIUS_KM, 30);
    var sectorLatLngs = buildSectorPreviewLatLngs(
      radioState.lat,
      radioState.lng,
      sectorConfig.bearingDeg,
      sectorConfig.angleDeg,
      radiusKm * 1000
    );

    L.polygon(sectorLatLngs, {
      pane: RADIO_PREVIEW_PANE,
      color: '#D5B456',
      weight: 2,
      opacity: 0.95,
      dashArray: '8 6',
      fillColor: '#D5B456',
      fillOpacity: 0.12,
      interactive: false
    }).addTo(radioState.previewLayer);
  }

  function syncFastFillControl() {
    if (!fastFillCheck) return;
    var enabled = !!(adaptiveCullingCheck && adaptiveCullingCheck.checked);
    fastFillCheck.disabled = !enabled;
    if (fastFillLabelEl) {
      fastFillLabelEl.classList.toggle('is-disabled', !enabled);
    }
  }

  function syncSectorAngleControl() {
    if (!sectorAngleInput) return;
    var enabled = hasDirectionTarget();
    sectorAngleInput.disabled = !enabled;
    var groupEl = sectorAngleInput.closest ? sectorAngleInput.closest('.control-group') : null;
    if (groupEl) {
      groupEl.classList.toggle('is-disabled', !enabled);
    }
  }

  function updateTerrainCreditHtml() {
    if (!radioTerrainCreditEl) return;
    var terrainLink = '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">Mapzen Terrain Tiles on AWS Open Data</a>';
    var terrainAttributionLink = '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">terrain attribution guide</a>';
    radioTerrainCreditEl.innerHTML = t('radioTerrainCredit', {
      terrain: terrainLink,
      attribution: terrainAttributionLink
    });
  }

  function bindDebugInputs() {
    [debugDownloadedTilesCheck, debugSkippedTilesCheck, debugTileBordersCheck,
     debugWedgeBordersCheck, debugAnalysisBoundsCheck].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', scheduleDebugOverlayRefresh);
    });
  }

  // ===== Analysis =====
  function startAnalysis() {
    if (radioState.lat === null || radioState.running) return;

    var antennaHeight = clampNumber(antennaInput.value, 0, 500, 10);
    var radiusKm = clampNumber(radiusInput.value, 5, MAX_RADIUS_KM, 30);
    var txPowerW = clampNumber(txPowerInput.value, 0.1, 100, 5);
    var txGainDbi = clampNumber(txGainInput.value, -10, 30, 0);
    var rxGainDbi = clampNumber(rxGainInput.value, -10, 30, 0);
    var rxHeightM = clampNumber(rxHeightInput.value, 0, 100, 2);
    var rxSensitivityDbm = clampNumber(rxSensitivityInput.value, -150, -50, -110);
    var rxSensitivityDbW = rxSensitivityDbm - 30;
    var freqMHz = getSelectedFrequencyMHz();
    var unfiltered = !!(unfilteredCheck && unfilteredCheck.checked);
    var radarSweep = !!(radarSweepCheck && radarSweepCheck.checked);
    var adaptiveCulling = !!(adaptiveCullingCheck && adaptiveCullingCheck.checked);
    var fastFillEnabled = !!(fastFillCheck && fastFillCheck.checked && adaptiveCulling);
    var itmEngine = itmEngineSelect ? itmEngineSelect.value : 'wasm';
    var sectorConfig = getSectorConfig();
    var patternConfig = getPatternConfig();
    var resVal = resolutionSelect ? resolutionSelect.value : 'auto';
    var analysisZoom;
    if (resVal === 'auto') {
      analysisZoom = Math.min(12, Math.max(8, 12 - Math.floor(Math.log2(radiusKm / 30))));
    } else {
      analysisZoom = parseInt(resVal, 10);
    }
    antennaInput.value = antennaHeight;
    radiusInput.value = radiusKm;
    txPowerInput.value = txPowerW;
    txGainInput.value = txGainDbi;
    rxGainInput.value = rxGainDbi;
    rxHeightInput.value = rxHeightM;
    rxSensitivityInput.value = rxSensitivityDbm;
    updateEirpDisplay();

    var memoryEstimate = estimateAnalysisMemoryMB(
      radioState.lat,
      analysisZoom,
      radiusKm,
      txPowerW,
      freqMHz,
      txGainDbi,
      rxGainDbi,
      rxSensitivityDbW,
      radarSweep
    );
    renderAnalysisWarning(memoryEstimate, radarSweep, resVal, freqMHz);

    var analysisToken = beginAnalysisSession();

    radioState.running = true;
    radioState.analysisZoom = analysisZoom;
    radioState.startTime = performance.now();
    radioState._timerInterval = setInterval(function () {
      var el = document.getElementById('radio-elapsed');
      if (el) el.textContent = formatElapsed(performance.now() - radioState.startTime);
    }, 100);
    analyzeBtnEl.disabled = true;
    clearBtnEl.hidden = true;
    statsPanelEl.hidden = true;
    if (legendEl) legendEl.hidden = true;

    progressOverlayEl.hidden = false;
    progressBarEl.style.width = '0%';
    progressTextEl.textContent = t('radioPhase1');

    removeOverlay();

    radioState.canvasLayer = new RadioCoverageLayer();
    radioState.canvasLayer.addTo(radioState.map);

    if (radioState.worker) radioState.worker.terminate();
    radioState.worker = new Worker('radio-worker.js');

    radioState.worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'needTiles') {
        fetchAndSendTiles(msg.tiles, radioState.worker, analysisToken);
      } else if (msg.type === 'phase1Done') {
        handlePhase1Done(msg);
      } else if (msg.type === 'phase2Done') {
        handlePhase2Done(msg);
      } else if (msg.type === 'coverageBounds') {
        handleCoverageBounds(msg);
      } else if (msg.type === 'phase3Partition') {
        handlePhase3Partition(msg);
      } else if (msg.type === 'done') {
        handleDone(msg.stats);
      } else if (msg.type === 'error') {
        handleError(msg);
      }
    };

    radioState.worker.onerror = function (err) {
      handleError({ message: err.message || 'Worker error' });
    };

    radioState.worker.postMessage({
      type: 'start',
      lat: radioState.lat,
      lng: radioState.lng,
      antennaHeight: antennaHeight,
      radiusKm: radiusKm,
      zoom: analysisZoom,
      freqMHz: freqMHz,
      txPowerW: txPowerW,
      txGainDbi: txGainDbi,
      rxGainDbi: rxGainDbi,
      rxHeightM: rxHeightM,
      rxSensitivityDbW: rxSensitivityDbW,
      txPattern: patternConfig.pattern,
      patternBearingDeg: patternConfig.bearingDeg,
      unfiltered: unfiltered,
      itmEngine: itmEngine,
      radarSweep: radarSweep,
      adaptiveCulling: adaptiveCulling,
      fastFillEnabled: fastFillEnabled,
      sectorEnabled: sectorConfig.enabled,
      sectorBearingDeg: sectorConfig.bearingDeg,
      sectorAngleDeg: sectorConfig.angleDeg,
    });
  }

  function fetchAndSendTiles(tiles, targetWorker, analysisToken) {
    if (!isAnalysisSessionActive(analysisToken) || !targetWorker) return;

    var reservation = reserveAnalysisTiles(tiles);
    if (!reservation.ok) {
      handleError({ message: 'TILE_LIMIT', count: reservation.count });
      return;
    }

    loadTerrainTiles(tiles, radioState._isRadarSweep ? SWEEP_TILE_FETCH_CONCURRENCY : 0).then(function (results) {
      if (!isAnalysisSessionActive(analysisToken) || !targetWorker) return;

      noteDebugTileResults(results);

      var transfers = [];
      var tileData = results.map(function (r) {
        var copy = new Float32Array(r.data);
        transfers.push(copy.buffer);
        return { z: r.z, x: r.x, y: r.y, data: copy.buffer };
      });

      try {
        targetWorker.postMessage({ type: 'tiles', tiles: tileData }, transfers);
      } catch (err) {
        if (isAnalysisSessionActive(analysisToken)) {
          handleError({ message: 'TILE_FETCH_FAILED', detail: err.message || String(err) });
        }
        return;
      }

      progressTextEl.textContent = t('radioFetchingTiles');
    }).catch(function (err) {
      if (!isAnalysisSessionActive(analysisToken)) return;
      handleError({ message: 'TILE_FETCH_FAILED', detail: err.message || String(err) });
    });
  }

  function loadTerrainTiles(tiles, concurrency) {
    if (!concurrency || tiles.length <= concurrency) {
      return Promise.all(tiles.map(loadTerrainTile));
    }

    var results = new Array(tiles.length);
    var nextIndex = 0;
    var active = 0;

    return new Promise(function (resolve, reject) {
      function pump() {
        if (nextIndex >= tiles.length && active === 0) {
          resolve(results);
          return;
        }

        while (active < concurrency && nextIndex < tiles.length) {
          (function (idx) {
            active++;
            loadTerrainTile(tiles[idx]).then(function (result) {
              results[idx] = result;
              active--;
              pump();
            }).catch(reject);
          })(nextIndex);
          nextIndex++;
        }
      }

      pump();
    });
  }

  function loadTerrainTile(tc) {
    if (getTileWithMetadata) {
      return getTileWithMetadata(tc.z, tc.x, tc.y).then(function (result) {
        return {
          z: tc.z,
          x: tc.x,
          y: tc.y,
          data: result.data,
          fromCache: !!result.fromCache
        };
      });
    }

    return getTile(tc.z, tc.x, tc.y).then(function (data) {
      return { z: tc.z, x: tc.x, y: tc.y, data: data, fromCache: false };
    });
  }

  function handlePhase1Done(msg) {
    progressTextEl.textContent = t('radioPhase2');
    progressBarEl.style.width = '15%';
  }

  function handlePhase2Done(msg) {
    radioState._totalCells = msg.totalCells;
    var text = t('radioPhase2');
    if (msg.wasClamped) {
      text += ' ' + t('radioClampedNotice', { km: msg.clampedRadiusKm.toFixed(1) });
    }
    progressTextEl.textContent = text;
    progressBarEl.style.width = '15%';
  }

  function handleCoverageBounds(msg) {
    radioState.coverageBounds = {
      minLat: msg.minLat,
      maxLat: msg.maxLat,
      minLng: msg.minLng,
      maxLng: msg.maxLng
    };
    scheduleDebugOverlayRefresh();

    if (!radioState.canvasLayer) return;
    radioState.canvasLayer.initBitmap(
      msg.minLat, msg.maxLat, msg.minLng, msg.maxLng,
      msg.widthPx, msg.heightPx
    );
    progressTextEl.textContent = t('radioPhase3', { done: 0, total: radioState._totalCells || '?' });
    progressBarEl.style.width = '20%';
  }

  function handleCoverageBatch(msg) {
    if (!radioState.canvasLayer) return;
    var totalEval = radioState._propTotalEvaluated || 0;
    totalEval += msg.evaluated;
    // evaluated in msg is slice-local; track cumulative across all slices
    // We overwrite per-slice tracking below in _propSliceEval
    var sliceKey = 'slice_' + (msg.sliceId || 0);
    if (!radioState._propSliceEval) radioState._propSliceEval = {};
    var prevSliceEval = radioState._propSliceEval[sliceKey] || 0;
    radioState._propTotalEvaluated = (radioState._propTotalEvaluated || 0) + (msg.evaluated - prevSliceEval);
    radioState._propSliceEval[sliceKey] = msg.evaluated;

    var totalCells = radioState._totalCells || 1;
    var pct = 20 + Math.round((radioState._propTotalEvaluated / totalCells) * 80);
    if (pct > 99) pct = 99;
    progressBarEl.style.width = pct + '%';
    progressTextEl.textContent = t('radioPhase3', {
      done: radioState._propTotalEvaluated,
      total: totalCells
    });

    var layer = radioState.canvasLayer;
    // Decode binary coverage: Float32Array with [x, y, band, ...] triples.
    var data = new Float32Array(msg.cells);
    for (var i = 0; i < data.length; i += 3) {
      layer.setCellByBitmapXY(Math.round(data[i]), Math.round(data[i + 1]), data[i + 2]);
    }
    layer.scheduleRefresh();
  }

  // ===== Phase 3 Partition → Spawn Propagation Workers =====
  function handlePhase3Partition(msg) {
    var mask = new Uint8Array(msg.mask);
    var maskW = msg.maskW;
    var maskH = msg.maskH;
    var txParams = msg.txParams;
    var analysisToken = radioState.analysisToken;

    // Track sweep state
    if (msg.isRadarSweep) {
      radioState._isRadarSweep = true;
      radioState._sweepTotalWedges = msg.totalWedges;
      if (!radioState._sweepAggStats) {
        // Initialize aggregate stats on first wedge
        radioState._sweepWedgesCompleted = 0;
        radioState._sweepAggStats = {
          evaluated: 0, strongCount: 0, usableCount: 0,
          marginalCount: 0, maxReachM: 0
        };
        radioState._totalCells = 0;
      }
    }

    radioState._propTotalCells = msg.totalCells;
    radioState._propTotalEvaluated = 0;
    radioState._propSliceEval = {};
    radioState._propOrchestratorTiles = msg.tilesUsed;
    radioState._unfiltered = msg.txParams.unfiltered;

    // Accumulate total cells across wedges for sweep mode
    if (msg.isRadarSweep) {
      radioState._totalCells += msg.totalCells;
    } else {
      radioState._totalCells = msg.totalCells;
    }

    if (msg.totalCells === 0) {
      if (msg.isRadarSweep) {
        radioState._sweepWedgesCompleted++;
        var emptyWedgePct = Math.round((radioState._sweepWedgesCompleted / radioState._sweepTotalWedges) * 100);
        if (emptyWedgePct > 99) emptyWedgePct = 99;
        progressBarEl.style.width = emptyWedgePct + '%';
        progressTextEl.textContent = t('radioSweepProgress', {
          done: radioState._sweepWedgesCompleted,
          total: radioState._sweepTotalWedges
        });
        radioState.worker.postMessage({ type: 'wedgeDone' });
      } else {
        handleDone({
          tilesUsed: getAnalysisTileCount(),
          cellsEvaluated: 0,
          strongCount: 0,
          usableCount: 0,
          marginalCount: 0,
          maxReachM: 0,
          workerCount: 1
        });
      }
      return;
    }

    // Determine slice count: split mask into horizontal row-bands
    var sliceCount = Math.min(4, maskH);
    if (sliceCount < 1) sliceCount = 1;
    radioState._propWorkerCount = msg.isRadarSweep ? 1 : Math.min(PROP_WORKER_COUNT, sliceCount);

    // Terminate any lingering propagation workers
    terminatePropWorkers();

    // Build row-range slices: each slice is a contiguous band of rows
    var slices = [];
    var baseRows = Math.floor(maskH / sliceCount);
    var remainder = maskH % sliceCount;
    var rowOffset = 0;
    for (var s = 0; s < sliceCount; s++) {
      var rows = baseRows + (s < remainder ? 1 : 0);
      var byteOffset = rowOffset * maskW;
      var byteLen = rows * maskW;
      slices.push({
        sliceId: s,
        rowOffset: rowOffset,
        rows: rows,
        mask: mask.slice(byteOffset, byteOffset + byteLen)
      });
      rowOffset += rows;
    }

    // Distribute slices round-robin to workers
    var workerCount = radioState._propWorkerCount;
    var workerSlices = [];
    for (var w = 0; w < workerCount; w++) workerSlices.push([]);
    for (var s = 0; s < slices.length; s++) {
      workerSlices[s % workerCount].push(slices[s]);
    }

    // Track completion for this wedge/partition
    radioState._propSlicesDone = 0;
    radioState._propTotalSlices = slices.length;
    radioState._propAggStats = {
      evaluated: 0,
      strongCount: 0,
      usableCount: 0,
      marginalCount: 0,
      maxReachM: 0
    };

    if (msg.isRadarSweep) {
      startSweepSliceProcessing(slices, maskW, msg, txParams, analysisToken);
      return;
    }

    // Spawn workers
    radioState.propWorkers = [];
    for (var w = 0; w < workerCount; w++) {
      var pw = new Worker('radio-propagation-worker.js');
      radioState.propWorkers.push(pw);

      // Set up message handler (closure over pw reference)
      pw.onmessage = (function (workerRef) {
        return function (e) {
          var m = e.data;
          if (m.type === 'needTiles') {
            fetchAndSendTiles(m.tiles, workerRef, analysisToken);
          } else if (m.type === 'coverageBatch') {
            handleCoverageBatch(m);
          } else if (m.type === 'sliceDone') {
            handleSliceDone(m);
          } else if (m.type === 'error') {
            handleError(m);
          }
        };
      })(pw);

      pw.onerror = function (err) {
        handleError({ message: err.message || 'Propagation worker error' });
      };

      // Post all slices assigned to this worker
      for (var si = 0; si < workerSlices[w].length; si++) {
        var assignment = workerSlices[w][si];
        var sliceMaskCopy = new Uint8Array(assignment.mask);
        pw.postMessage({
          type: 'start',
          mask: sliceMaskCopy.buffer,
          maskW: maskW,
          rowOffset: assignment.rowOffset,
          rows: assignment.rows,
          maskOriginGlobalX: msg.maskOriginGlobalX,
          maskOriginGlobalY: msg.maskOriginGlobalY,
          bitmapOffsetX: msg.bitmapOffsetX || 0,
          bitmapOffsetY: msg.bitmapOffsetY || 0,
          sliceId: assignment.sliceId,
          txLat: txParams.txLat,
          txLng: txParams.txLng,
          txElevation: txParams.txElevation,
          antennaHeight: txParams.antennaHeight,
          freqMHz: txParams.freqMHz,
          txPowerW: txParams.txPowerW,
          txGainDbi: txParams.txGainDbi,
          rxGainDbi: txParams.rxGainDbi,
          rxHeightM: txParams.rxHeightM,
          rxSensitivityDbW: txParams.rxSensitivityDbW,
          txPattern: txParams.txPattern,
          patternBearingDeg: txParams.patternBearingDeg,
          zoom: txParams.zoom,
          mpp: txParams.mpp,
          unfiltered: radioState._unfiltered,
          itmEngine: txParams.itmEngine,
          adaptiveCulling: txParams.adaptiveCulling,
          fastFillEnabled: txParams.fastFillEnabled
        }, [sliceMaskCopy.buffer]);
      }
    }
  }

  function startSweepSliceProcessing(slices, maskW, msg, txParams, analysisToken) {
    var pw = new Worker('radio-propagation-worker.js');
    var nextSliceIndex = 0;

    radioState.propWorkers = [pw];

    pw.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'needTiles') {
        fetchAndSendTiles(m.tiles, pw, analysisToken);
      } else if (m.type === 'coverageBatch') {
        handleCoverageBatch(m);
      } else if (m.type === 'sliceDone') {
        handleSliceDone(m);
        if (radioState.running && radioState._isRadarSweep && radioState._propSlicesDone < radioState._propTotalSlices) {
          postNextSweepSlice();
        }
      } else if (m.type === 'error') {
        handleError(m);
      }
    };

    pw.onerror = function (err) {
      handleError({ message: err.message || 'Propagation worker error' });
    };

    postNextSweepSlice();

    function postNextSweepSlice() {
      if (nextSliceIndex >= slices.length) return;

      var assignment = slices[nextSliceIndex++];
      var sliceMaskCopy = new Uint8Array(assignment.mask);
      pw.postMessage({
        type: 'start',
        mask: sliceMaskCopy.buffer,
        maskW: maskW,
        rowOffset: assignment.rowOffset,
        rows: assignment.rows,
        maskOriginGlobalX: msg.maskOriginGlobalX,
        maskOriginGlobalY: msg.maskOriginGlobalY,
        bitmapOffsetX: msg.bitmapOffsetX || 0,
        bitmapOffsetY: msg.bitmapOffsetY || 0,
        sliceId: assignment.sliceId,
        txLat: txParams.txLat,
        txLng: txParams.txLng,
        txElevation: txParams.txElevation,
        antennaHeight: txParams.antennaHeight,
        freqMHz: txParams.freqMHz,
        txPowerW: txParams.txPowerW,
        txGainDbi: txParams.txGainDbi,
        rxGainDbi: txParams.rxGainDbi,
        rxHeightM: txParams.rxHeightM,
        rxSensitivityDbW: txParams.rxSensitivityDbW,
        txPattern: txParams.txPattern,
        patternBearingDeg: txParams.patternBearingDeg,
        zoom: txParams.zoom,
        mpp: txParams.mpp,
        unfiltered: radioState._unfiltered,
        itmEngine: txParams.itmEngine,
        adaptiveCulling: txParams.adaptiveCulling,
        fastFillEnabled: txParams.fastFillEnabled
      }, [sliceMaskCopy.buffer]);
    }
  }

  function handleSliceDone(msg) {
    var agg = radioState._propAggStats;
    agg.evaluated += msg.stats.evaluated;
    agg.strongCount += msg.stats.strongCount;
    agg.usableCount += msg.stats.usableCount;
    agg.marginalCount += msg.stats.marginalCount;
    if (msg.stats.maxReachM > agg.maxReachM) agg.maxReachM = msg.stats.maxReachM;
    if (msg.itmBackend) agg.itmBackend = msg.itmBackend;

    radioState._propSlicesDone++;
    if (radioState._propSlicesDone >= radioState._propTotalSlices) {
      // All slices for this partition are done
      terminatePropWorkers();

      if (radioState._isRadarSweep) {
        // Accumulate into sweep-level stats
        var sa = radioState._sweepAggStats;
        sa.evaluated += agg.evaluated;
        sa.strongCount += agg.strongCount;
        sa.usableCount += agg.usableCount;
        sa.marginalCount += agg.marginalCount;
        if (agg.maxReachM > sa.maxReachM) sa.maxReachM = agg.maxReachM;
        if (agg.itmBackend) sa.itmBackend = agg.itmBackend;

        radioState._sweepWedgesCompleted++;
        var wedgePct = Math.round((radioState._sweepWedgesCompleted / radioState._sweepTotalWedges) * 100);
        if (wedgePct > 99) wedgePct = 99;
        progressBarEl.style.width = wedgePct + '%';
        progressTextEl.textContent = t('radioSweepProgress', {
          done: radioState._sweepWedgesCompleted,
          total: radioState._sweepTotalWedges
        });

        // Signal orchestrator to advance to next wedge
        radioState.worker.postMessage({ type: 'wedgeDone' });
      } else {
        // Standard (non-sweep) completion
        handleDone({
          tilesUsed: getAnalysisTileCount(),
          cellsEvaluated: agg.evaluated,
          strongCount: agg.strongCount,
          usableCount: agg.usableCount,
          marginalCount: agg.marginalCount,
          maxReachM: agg.maxReachM,
          workerCount: radioState._propWorkerCount,
          itmBackend: agg.itmBackend
        });
      }
    }
  }

  function terminatePropWorkers() {
    for (var i = 0; i < radioState.propWorkers.length; i++) {
      radioState.propWorkers[i].terminate();
    }
    radioState.propWorkers = [];
  }

  function handleDone(stats) {
    stats = stats || {};

    // In sweep mode, the orchestrator's final 'done' message has zeroed stats;
    // use the accumulated sweep stats instead
    if (radioState._isRadarSweep && radioState._sweepAggStats) {
      var sa = radioState._sweepAggStats;
      stats = {
        tilesUsed: getAnalysisTileCount(),
        cellsEvaluated: sa.evaluated,
        strongCount: sa.strongCount,
        usableCount: sa.usableCount,
        marginalCount: sa.marginalCount,
        maxReachM: sa.maxReachM,
        workerCount: radioState._propWorkerCount || 1,
        itmBackend: sa.itmBackend
      };
    }

    stats.tilesUsed = getAnalysisTileCount();

    radioState.running = false;
    radioState._isRadarSweep = false;
    radioState._sweepAggStats = null;
    if (radioState._timerInterval) {
      clearInterval(radioState._timerInterval);
      radioState._timerInterval = null;
    }
    var elapsed = performance.now() - radioState.startTime;
    analyzeBtnEl.disabled = false;
    clearBtnEl.hidden = false;
    progressOverlayEl.hidden = true;

    if (radioState.canvasLayer) {
      radioState.canvasLayer.flushRefresh();
    }

    var maxReachKm = (stats.maxReachM / 1000).toFixed(1);
    var mppVal = metersPerPixel(radioState.lat, radioState.analysisZoom || ANALYSIS_ZOOM);
    var zoomUsed = radioState.analysisZoom || ANALYSIS_ZOOM;
    var pixelAreaKm2 = (mppVal * mppVal) / 1e6;
    var strongAreaKm2 = (stats.strongCount * pixelAreaKm2).toFixed(1);
    var usableAreaKm2 = (stats.usableCount * pixelAreaKm2).toFixed(1);
    var marginalAreaKm2 = (stats.marginalCount * pixelAreaKm2).toFixed(1);
    var workerCount = stats.workerCount || 1;

    statsEl.innerHTML =
      '<strong>' + t('radioComplete') + '</strong><br>' +
      t('radioTilesUsed', { n: stats.tilesUsed }) + '<br>' +
      t('radioCellsEvaluated', { n: stats.cellsEvaluated }) + '<br>' +
      t('radioMaxReach', { km: maxReachKm }) + '<br>' +
      t('radioZoomUsed', { z: zoomUsed, mpp: Math.round(mppVal) }) + '<br>' +
      t('radioWorkerCount', { n: workerCount }) + '<br>' +
      t('radioElapsed', { time: formatElapsed(elapsed) }) + '<br>' +
      '<span class="radio-stat-strong">&#9632;</span> ' + t('radioStrongArea', { km2: strongAreaKm2 }) + '<br>' +
      '<span class="radio-stat-usable">&#9632;</span> ' + t('radioUsableArea', { km2: usableAreaKm2 }) + '<br>' +
      '<span class="radio-stat-marginal">&#9632;</span> ' + t('radioMarginalArea', { km2: marginalAreaKm2 }) +
      '<br>ITM: ' + (stats.itmBackend === 'wasm' ? 'WASM' : stats.itmBackend || 'unknown');
    statsPanelEl.hidden = false;

    if (legendEl) legendEl.hidden = false;

    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
    terminatePropWorkers();
  }

  function handleError(msg) {
    radioState.running = false;
    radioState._isRadarSweep = false;
    radioState._sweepAggStats = null;
    if (radioState._timerInterval) {
      clearInterval(radioState._timerInterval);
      radioState._timerInterval = null;
    }
    analyzeBtnEl.disabled = radioState.lat === null;
    progressOverlayEl.hidden = true;

    if (msg.message === 'TILE_LIMIT') {
      statsEl.innerHTML = t('radioTileLimitExceeded', {
        n: msg.count || getAnalysisTileCount() || MAX_TILES_LIMIT
      });
    } else if (msg.message === 'TILE_FETCH_FAILED') {
      if (msg.detail) console.error('Terrain tile fetch failed:', msg.detail);
      statsEl.innerHTML = t('radioTileFetchFailed');
    } else if (msg.message === 'WASM_INIT_FAILED') {
      console.error('ITM WASM init failed:', msg.detail);
      statsEl.innerHTML = t('radioWasmRequired');
    } else {
      statsEl.innerHTML = t('radioAborted') + ': ' + sanitize(msg.message);
    }
    statsPanelEl.hidden = false;
    clearBtnEl.hidden = false;

    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
    terminatePropWorkers();
  }

  function clearAll() {
    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
    terminatePropWorkers();
    radioState.running = false;
    radioState._isRadarSweep = false;
    radioState._sweepAggStats = null;
    if (radioState._timerInterval) {
      clearInterval(radioState._timerInterval);
      radioState._timerInterval = null;
    }
    radioState.lat = null;
    radioState.lng = null;
    radioState.directionLat = null;
    radioState.directionLng = null;
    radioState.coverageBounds = null;
    radioState.analysisTileCount = 0;
    radioState.analysisTileKeys = null;
    radioState.debugTileRecords = null;

    if (radioState.marker) {
      radioState.map.removeLayer(radioState.marker);
      radioState.marker = null;
    }
    removeOverlay();
    if (radioState.previewLayer) {
      radioState.previewLayer.clearLayers();
    }
    if (radioState.debugLayer) {
      radioState.debugLayer.clearLayers();
    }

    coordsEl.hidden = true;
    instructionEl.hidden = false;
    analyzeBtnEl.disabled = true;
    if (warningEl) {
      warningEl.hidden = true;
      warningEl.textContent = '';
      warningEl.removeAttribute('data-level');
    }
    clearBtnEl.hidden = true;
    if (clearDirectionBtn) clearDirectionBtn.hidden = true;
    progressOverlayEl.hidden = true;
    statsPanelEl.hidden = true;
    progressBarEl.style.width = '0%';
    if (legendEl) legendEl.hidden = true;
  }

  function removeOverlay() {
    if (radioState.canvasLayer) {
      radioState.map.removeLayer(radioState.canvasLayer);
      radioState.canvasLayer = null;
    }
  }

  // ===== Bitmap Coverage Layer (L.ImageOverlay) =====
  // RGBA colors for bands: [R, G, B, A]
  var BAND_RGBA = [
    [34, 197, 94, 140],    // band 0: strong (green, ~55% alpha)
    [163, 230, 53, 128],   // band 1: usable (lime, ~50% alpha)
    [250, 204, 21, 115]    // band 2: marginal (yellow, ~45% alpha)
  ];
  var BAND_EMPTY = 3;

  var RadioCoverageLayer = L.Layer.extend({
    initialize: function () {
      this._overlayA = null;
      this._overlayB = null;
      this._objectUrlA = null;
      this._objectUrlB = null;
      this._visibleOverlay = 'A';
      this._imageData = null;
      this._bandData = null;
      this._canvas = null;
      this._bounds = null;
      this._bitmapW = 0;
      this._bitmapH = 0;
      this._minLat = 0;
      this._maxLat = 0;
      this._minLng = 0;
      this._maxLng = 0;
      // Mercator Y at top/bottom for pixel mapping
      this._mercYTop = 0;
      this._mercYBot = 0;
      this._refreshTimer = null;
      this._pendingCells = 0;
    },

    onAdd: function (map) {
      this._map = map;
    },

    onRemove: function (map) {
      if (this._overlayA) {
        map.removeLayer(this._overlayA);
        this._overlayA = null;
      }
      if (this._overlayB) {
        map.removeLayer(this._overlayB);
        this._overlayB = null;
      }
      if (this._objectUrlA) {
        URL.revokeObjectURL(this._objectUrlA);
        this._objectUrlA = null;
      }
      if (this._objectUrlB) {
        URL.revokeObjectURL(this._objectUrlB);
        this._objectUrlB = null;
      }
      if (this._refreshTimer) {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = null;
      }
      this._map = null;
    },

    initBitmap: function (minLat, maxLat, minLng, maxLng, widthPx, heightPx) {
      this._minLat = minLat;
      this._maxLat = maxLat;
      this._minLng = minLng;
      this._maxLng = maxLng;
      this._bitmapW = widthPx;
      this._bitmapH = heightPx;

      // Pre-compute Mercator Y for top (maxLat) and bottom (minLat)
      this._mercYTop = _latToMercY(maxLat);
      this._mercYBot = _latToMercY(minLat);

      this._imageData = new ImageData(widthPx, heightPx);
      this._bandData = new Uint8Array(widthPx * heightPx);
      for (var i = 0; i < this._bandData.length; i++) this._bandData[i] = BAND_EMPTY;

      this._canvas = document.createElement('canvas');
      this._canvas.width = widthPx;
      this._canvas.height = heightPx;

      this._bounds = L.latLngBounds([minLat, minLng], [maxLat, maxLng]);
      this._pendingCells = 0;

      // Create both overlays for double buffering
      var blankUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      var overlayOpts = { interactive: false, zIndex: 450 };
      if (this._overlayA) this._map.removeLayer(this._overlayA);
      if (this._overlayB) this._map.removeLayer(this._overlayB);
      if (this._objectUrlA) { URL.revokeObjectURL(this._objectUrlA); this._objectUrlA = null; }
      if (this._objectUrlB) { URL.revokeObjectURL(this._objectUrlB); this._objectUrlB = null; }
      this._overlayA = L.imageOverlay(blankUrl, this._bounds, Object.assign({ opacity: 1 }, overlayOpts)).addTo(this._map);
      this._overlayB = L.imageOverlay(blankUrl, this._bounds, Object.assign({ opacity: 0 }, overlayOpts)).addTo(this._map);
      this._visibleOverlay = 'A';
    },

    setCellByLatLng: function (lat, lng, band) {
      if (!this._imageData) return;
      // X: linear in longitude
      var px = Math.round(((lng - this._minLng) / (this._maxLng - this._minLng)) * (this._bitmapW - 1));
      // Y: linear in Mercator-projected space (top=0)
      var mercY = _latToMercY(lat);
      var py = Math.round(((this._mercYTop - mercY) / (this._mercYTop - this._mercYBot)) * (this._bitmapH - 1));

      if (px < 0 || px >= this._bitmapW || py < 0 || py >= this._bitmapH) return;

      var idx = py * this._bitmapW + px;
      this._bandData[idx] = band;

      var rgba = BAND_RGBA[band];
      var off = idx * 4;
      this._imageData.data[off]     = rgba[0];
      this._imageData.data[off + 1] = rgba[1];
      this._imageData.data[off + 2] = rgba[2];
      this._imageData.data[off + 3] = rgba[3];

      this._pendingCells++;
    },

    setCellByBitmapXY: function (px, py, band) {
      if (!this._imageData) return;
      if (px < 0 || px >= this._bitmapW || py < 0 || py >= this._bitmapH) return;

      var idx = py * this._bitmapW + px;
      this._bandData[idx] = band;

      var rgba = BAND_RGBA[band];
      var off = idx * 4;
      this._imageData.data[off]     = rgba[0];
      this._imageData.data[off + 1] = rgba[1];
      this._imageData.data[off + 2] = rgba[2];
      this._imageData.data[off + 3] = rgba[3];

      this._pendingCells++;
    },

    scheduleRefresh: function () {
      if (this._refreshTimer) return;
      var self = this;
      if (this._pendingCells >= 30000) {
        this._doRefresh();
      } else {
        this._refreshTimer = setTimeout(function () {
          self._refreshTimer = null;
          self._doRefresh();
        }, 1000);
      }
    },

    flushRefresh: function () {
      if (this._refreshTimer) {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = null;
      }
      this._doRefresh();
    },

    _doRefresh: function () {
      if (!this._map || !this._imageData || !this._canvas) return;
      if (!this._overlayA || !this._overlayB) return;
      this._pendingCells = 0;

      var ctx = this._canvas.getContext('2d');
      ctx.putImageData(this._imageData, 0, 0);

      var self = this;
      var isA = this._visibleOverlay === 'A';

      this._canvas.toBlob(function (blob) {
        if (!self._map) return;
        var newUrl = URL.createObjectURL(blob);

        // Write to the staging (hidden) overlay
        var staging = isA ? self._overlayB : self._overlayA;
        staging.setUrl(newUrl);

        var imgEl = staging.getElement();
        var doSwap = function () {
          if (!self._map) {
            URL.revokeObjectURL(newUrl);
            return;
          }
          // Make staging visible, hide current
          staging.setOpacity(1);
          (isA ? self._overlayA : self._overlayB).setOpacity(0);

          // Revoke the old URL of the now-hidden overlay
          var oldUrl = isA ? self._objectUrlA : self._objectUrlB;
          if (oldUrl) URL.revokeObjectURL(oldUrl);

          // Store new URL in the staging slot, clear the hidden slot
          if (isA) {
            self._objectUrlB = newUrl;
            self._objectUrlA = null;
          } else {
            self._objectUrlA = newUrl;
            self._objectUrlB = null;
          }

          // Flip visible tracker
          self._visibleOverlay = isA ? 'B' : 'A';
        };

        if (imgEl) {
          imgEl.addEventListener('load', function onLoad() {
            imgEl.removeEventListener('load', onLoad);
            doSwap();
          });
        } else {
          doSwap();
        }
      });
    },
  });

  function _latToMercY(lat) {
    var latRad = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  }

  function beginAnalysisSession() {
    radioState.analysisToken += 1;
    radioState.coverageBounds = null;
    radioState.analysisTileCount = 0;
    radioState.analysisTileKeys = Object.create(null);
    radioState.debugTileRecords = Object.create(null);
    scheduleDebugOverlayRefresh();
    return radioState.analysisToken;
  }

  function isAnalysisSessionActive(token) {
    return radioState.running && token === radioState.analysisToken;
  }

  function getAnalysisTileCount() {
    return radioState.analysisTileCount || 0;
  }

  function reserveAnalysisTiles(tiles) {
    var keys = radioState.analysisTileKeys;
    var pending = [];
    var seen = Object.create(null);
    var currentCount = getAnalysisTileCount();

    if (!keys) {
      keys = Object.create(null);
      radioState.analysisTileKeys = keys;
    }

    for (var i = 0; i < tiles.length; i++) {
      var key = tiles[i].z + '/' + tiles[i].x + '/' + tiles[i].y;
      if (keys[key] || seen[key]) continue;
      seen[key] = true;
      pending.push(key);
    }

    if (currentCount + pending.length > MAX_TILES_LIMIT) {
      return { ok: false, count: currentCount + pending.length };
    }

    for (var j = 0; j < pending.length; j++) {
      keys[pending[j]] = true;
    }
    radioState.analysisTileCount = currentCount + pending.length;

    return { ok: true, count: radioState.analysisTileCount };
  }

  function estimateCoverageBitmapMB(lat, zoom, radiusKm, txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW, radarSweep) {
    var radiusM = radiusKm * 1000;
    var effectiveRadiusM = radarSweep ? radiusM : Math.min(radiusM, freeSpaceMaxDistanceM(txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW));
    var mpp = metersPerPixel(lat, zoom);
    var radiusPx = Math.ceil(effectiveRadiusM / mpp);
    var bufferPx = Math.ceil((COVERAGE_BUFFER_KM * 1000) / mpp);
    var sidePx = (radiusPx + bufferPx) * 2 + 1;
    var totalBytes = sidePx * sidePx * BITMAP_BYTES_PER_PIXEL;
    return totalBytes / (1024 * 1024);
  }

  function estimateAnalysisMemoryMB(lat, zoom, radiusKm, txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW, radarSweep) {
    var bitmapMB = estimateCoverageBitmapMB(lat, zoom, radiusKm, txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW, radarSweep);
    var radiusM = radiusKm * 1000;
    var effectiveRadiusM = radarSweep ? radiusM : Math.min(radiusM, freeSpaceMaxDistanceM(txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW));
    var mpp = metersPerPixel(lat, zoom);
    var tileSpanM = mpp * 256;
    var approxRadiusTiles = Math.ceil(effectiveRadiusM / Math.max(tileSpanM, 1));
    var tileArea = Math.PI * approxRadiusTiles * approxRadiusTiles;
    var tileMB = Math.min(tileArea, MAX_TILES_LIMIT) * TILE_BYTES_PER_TILE / (1024 * 1024);
    var workerMB = PROP_WORKER_COUNT * PROP_WORKER_OVERHEAD_MB;
    var totalMB = bitmapMB + tileMB + workerMB + BROWSER_OVERHEAD_MB;
    var availableMemoryGB = getAvailableMemoryGB();
    var availableMB = availableMemoryGB !== null ? availableMemoryGB * 1024 : null;
    var risk = 'ok';

    if (availableMB !== null) {
      if (totalMB >= availableMB * MEMORY_RISK_RATIO_BLOCK) risk = 'block';
      else if (totalMB >= availableMB * MEMORY_RISK_RATIO_WARN) risk = 'warn';
    } else if (totalMB >= MAX_BITMAP_MB + BROWSER_OVERHEAD_MB) {
      risk = 'warn';
    }

    return {
      bitmapMB: bitmapMB,
      tileMB: tileMB,
      workerMB: workerMB,
      totalMB: totalMB,
      availableMemoryGB: availableMemoryGB,
      risk: risk,
      approxTiles: Math.min(Math.round(tileArea), MAX_TILES_LIMIT)
    };
  }

  function getAvailableMemoryGB() {
    if (typeof navigator !== 'undefined' && typeof navigator.deviceMemory === 'number') {
      return navigator.deviceMemory;
    }
    if (typeof performance !== 'undefined' && performance.memory && performance.memory.jsHeapSizeLimit) {
      return performance.memory.jsHeapSizeLimit / (1024 * 1024 * 1024);
    }
    return null;
  }

  function shouldWarnForLargeManualRun(memoryEstimate, radarSweep, resVal) {
    if (memoryEstimate.risk !== 'ok') return true;
    if (memoryEstimate.availableMemoryGB !== null) return false;
    if (!radarSweep && memoryEstimate.bitmapMB > 200) return true;
    if (resVal !== 'auto' && memoryEstimate.totalMB > 256) return true;
    return false;
  }

  function bindWarningInputs() {
    [antennaInput, radiusInput, txPowerInput, txGainInput, rxGainInput,
     rxHeightInput, rxSensitivityInput, patternBearingInput,
     frequencyCustomInput, sectorAngleInput].forEach(function (el) {
      if (!el) return;
      el.addEventListener('input', refreshAnalysisUiState);
      el.addEventListener('change', refreshAnalysisUiState);
    });
    [frequencySelect, resolutionSelect, radarSweepCheck, adaptiveCullingCheck,
     itmEngineSelect, rxHeightPresetSelect, rxSensitivityPresetSelect,
     patternPresetSelect].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', refreshAnalysisUiState);
    });
    if (frequencySelect) {
      frequencySelect.addEventListener('change', updateFrequencyUi);
    }
    if (adaptiveCullingCheck) {
      adaptiveCullingCheck.addEventListener('change', syncFastFillControl);
    }
  }

  function noteDebugTileResults(results) {
    if (!results || !results.length) return;

    var records = radioState.debugTileRecords;
    var changed = false;
    if (!records) {
      records = Object.create(null);
      radioState.debugTileRecords = records;
    }

    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      var key = result.z + '/' + result.x + '/' + result.y;
      if (records[key]) continue;
      records[key] = {
        z: result.z,
        x: result.x,
        y: result.y,
        status: result.fromCache ? 'skipped' : 'downloaded'
      };
      changed = true;
    }

    if (changed && hasTileDebugOverlaysEnabled()) {
      scheduleDebugOverlayRefresh();
    }
  }

  function scheduleDebugOverlayRefresh() {
    if (radioState.debugRefreshQueued) return;
    radioState.debugRefreshQueued = true;

    var schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : function (callback) { return setTimeout(callback, 16); };

    schedule(function () {
      radioState.debugRefreshQueued = false;
      renderDebugOverlays();
    });
  }

  function renderDebugOverlays() {
    if (!radioState.debugLayer) return;

    radioState.debugLayer.clearLayers();

    var flags = getDebugOverlayFlags();
    if (!flags.showDownloadedTiles && !flags.showSkippedTiles &&
        !flags.showTileBorders && !flags.showWedgeBorders &&
        !flags.showAnalysisBounds) {
      return;
    }

    if (hasTileDebugOverlaysEnabled()) {
      var records = radioState.debugTileRecords;
      var keys = records ? Object.keys(records).sort() : [];
      for (var i = 0; i < keys.length; i++) {
        var record = records[keys[i]];
        var tileStyle = getDebugTileStyle(record, flags);
        if (!tileStyle) continue;
        L.rectangle(getTileLatLngBounds(record.z, record.x, record.y), tileStyle)
          .addTo(radioState.debugLayer);
      }
    }

    if (flags.showAnalysisBounds && radioState.coverageBounds) {
      L.rectangle([
        [radioState.coverageBounds.minLat, radioState.coverageBounds.minLng],
        [radioState.coverageBounds.maxLat, radioState.coverageBounds.maxLng]
      ], {
        pane: RADIO_DEBUG_PANE,
        color: '#bb4526',
        weight: 1.5,
        opacity: 0.82,
        dashArray: '7 5',
        fillOpacity: 0,
        interactive: false
      }).addTo(radioState.debugLayer);
    }

    if (flags.showWedgeBorders && radioState.lat !== null && radioState.lng !== null &&
        radarSweepCheck && radarSweepCheck.checked) {
      drawDebugSweepWedges();
    }
  }

  function getDebugOverlayFlags() {
    return {
      showDownloadedTiles: !!(debugDownloadedTilesCheck && debugDownloadedTilesCheck.checked),
      showSkippedTiles: !!(debugSkippedTilesCheck && debugSkippedTilesCheck.checked),
      showTileBorders: !!(debugTileBordersCheck && debugTileBordersCheck.checked),
      showWedgeBorders: !!(debugWedgeBordersCheck && debugWedgeBordersCheck.checked),
      showAnalysisBounds: !!(debugAnalysisBoundsCheck && debugAnalysisBoundsCheck.checked)
    };
  }

  function hasTileDebugOverlaysEnabled() {
    var flags = getDebugOverlayFlags();
    return flags.showDownloadedTiles || flags.showSkippedTiles || flags.showTileBorders;
  }

  function getDebugTileStyle(record, flags) {
    var showFill = (record.status === 'downloaded' && flags.showDownloadedTiles) ||
      (record.status === 'skipped' && flags.showSkippedTiles);
    if (!showFill && !flags.showTileBorders) return null;

    var statusColor = record.status === 'downloaded' ? '#0e8bc0' : '#c48a18';
    var neutralBorder = '#7a6331';

    return {
      pane: RADIO_DEBUG_PANE,
      color: showFill ? statusColor : neutralBorder,
      weight: showFill ? 1.2 : 1,
      opacity: showFill ? 0.82 : 0.5,
      dashArray: record.status === 'skipped' ? '6 4' : null,
      fillColor: statusColor,
      fillOpacity: showFill ? (record.status === 'downloaded' ? 0.16 : 0.13) : 0,
      interactive: false
    };
  }

  function getTileLatLngBounds(z, x, y) {
    return [
      [tileToLat(y + 1, z), tileToLng(x, z)],
      [tileToLat(y, z), tileToLng(x + 1, z)]
    ];
  }

  function drawDebugSweepWedges() {
    var txLatLng = L.latLng(radioState.lat, radioState.lng);
    var radiusM = clampNumber(radiusInput.value, 5, MAX_RADIUS_KM, 30) * 1000;

    L.circle(txLatLng, {
      pane: RADIO_DEBUG_PANE,
      radius: radiusM,
      color: '#8f5a17',
      weight: 1,
      opacity: 0.55,
      dashArray: '2 9',
      fillOpacity: 0,
      interactive: false
    }).addTo(radioState.debugLayer);

    for (var bearing = 0; bearing < 360; bearing += RADAR_SWEEP_WEDGE_DEG) {
      var edgePoint = destinationPoint(radioState.lat, radioState.lng, bearing, radiusM);
      L.polyline([
        txLatLng,
        [edgePoint.lat, edgePoint.lng]
      ], {
        pane: RADIO_DEBUG_PANE,
        color: '#8f5a17',
        weight: 1,
        opacity: 0.52,
        dashArray: '3 8',
        interactive: false
      }).addTo(radioState.debugLayer);
    }
  }

  function updateAnalysisWarning() {
    if (!warningEl) return;
    if (radioState.lat === null) {
      warningEl.hidden = true;
      warningEl.textContent = '';
      warningEl.removeAttribute('data-level');
      return;
    }

    var radiusKm = clampNumber(radiusInput.value, 5, MAX_RADIUS_KM, 30);
    var txPowerW = clampNumber(txPowerInput.value, 0.1, 100, 5);
    var txGainDbi = clampNumber(txGainInput.value, -10, 30, 0);
    var rxGainDbi = clampNumber(rxGainInput.value, -10, 30, 0);
    var rxSensitivityDbW = clampNumber(rxSensitivityInput.value, -150, -50, -110) - 30;
    var freqMHz = getSelectedFrequencyMHz();
    var radarSweep = !!(radarSweepCheck && radarSweepCheck.checked);
    var resVal = resolutionSelect ? resolutionSelect.value : 'auto';
    var analysisZoom = resVal === 'auto'
      ? Math.min(12, Math.max(8, 12 - Math.floor(Math.log2(radiusKm / 30))))
      : parseInt(resVal, 10);
    var memoryEstimate = estimateAnalysisMemoryMB(
      radioState.lat,
      analysisZoom,
      radiusKm,
      txPowerW,
      freqMHz,
      txGainDbi,
      rxGainDbi,
      rxSensitivityDbW,
      radarSweep
    );

    renderAnalysisWarning(memoryEstimate, radarSweep, resVal, freqMHz);
  }

  function renderAnalysisWarning(memoryEstimate, radarSweep, resVal, freqMHz) {
    if (!warningEl) return;

    var lowFreqWarning = supportsITMFrequency(freqMHz) ? '' : t('radioLowFreqFallbackWarning');
    var memoryWarning = memoryEstimate.risk !== 'ok' || shouldWarnForLargeManualRun(memoryEstimate, radarSweep, resVal);
    var shouldWarn = !!lowFreqWarning || memoryWarning;
    if (!shouldWarn) {
      warningEl.hidden = true;
      warningEl.textContent = '';
      warningEl.removeAttribute('data-level');
      return;
    }

    if (memoryWarning && (memoryEstimate.bitmapMB > MAX_BITMAP_MB || memoryEstimate.risk === 'block')) {
      warningEl.textContent = t('radioMemoryGuardrail', {
        mb: Math.round(memoryEstimate.totalMB),
        bitmapMb: Math.round(memoryEstimate.bitmapMB),
        ramGb: memoryEstimate.availableMemoryGB !== null ? memoryEstimate.availableMemoryGB.toFixed(1) : '?'
      });
      if (lowFreqWarning) {
        warningEl.textContent += ' ' + lowFreqWarning;
      }
      warningEl.dataset.level = 'high';
      warningEl.hidden = false;
      return;
    }

    warningEl.textContent = memoryWarning ? buildMemoryWarningText(memoryEstimate, radarSweep, resVal) : lowFreqWarning;
    if (memoryWarning && lowFreqWarning) {
      warningEl.textContent += ' ' + lowFreqWarning;
    }
    warningEl.dataset.level = 'warn';
    warningEl.hidden = false;
  }

  function buildMemoryWarningText(memoryEstimate, radarSweep, resVal) {
    var lines = [
      t('radioMemoryWarningSummary', {
        totalMb: Math.round(memoryEstimate.totalMB),
        bitmapMb: Math.round(memoryEstimate.bitmapMB),
        tileMb: Math.round(memoryEstimate.tileMB)
      })
    ];

    if (memoryEstimate.availableMemoryGB !== null) {
      lines.push(t('radioMemoryWarningRam', { ramGb: memoryEstimate.availableMemoryGB.toFixed(1) }));
    }
    if (!radarSweep) {
      lines.push(t('radioMemoryWarningSweep'));
    }
    if (resVal !== 'auto') {
      lines.push(t('radioMemoryWarningManualZoom'));
    }

    return lines.join(' ');
  }

  function freeSpaceMaxDistanceM(txPowerW, freqMHz, txGainDbi, rxGainDbi, rxSensitivityDbW) {
    var marginDb = 10 * Math.log10(txPowerW) + txGainDbi + rxGainDbi - rxSensitivityDbW;
    var dKm = Math.pow(10, (marginDb - 32.45 - 20 * Math.log10(freqMHz)) / 20);
    return dKm * 1000;
  }

  // ===== Utility =====
  function clampNumber(val, min, max, fallback) {
    var n = parseFloat(val);
    if (isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function haversineDistance(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function normalizeBearing(deg) {
    deg = deg % 360;
    return deg < 0 ? deg + 360 : deg;
  }

  function bearingFromLatLng(lat1, lng1, lat2, lng2) {
    var toRad = Math.PI / 180;
    var phi1 = lat1 * toRad;
    var phi2 = lat2 * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var y = Math.sin(dLng) * Math.cos(phi2);
    var x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
    return normalizeBearing(Math.atan2(y, x) * 180 / Math.PI);
  }

  function destinationPoint(lat, lng, bearingDeg, distanceM) {
    var angularDistance = distanceM / EARTH_RADIUS;
    var bearingRad = normalizeBearing(bearingDeg) * Math.PI / 180;
    var latRad = lat * Math.PI / 180;
    var lngRad = lng * Math.PI / 180;
    var sinLat = Math.sin(latRad);
    var cosLat = Math.cos(latRad);
    var sinAd = Math.sin(angularDistance);
    var cosAd = Math.cos(angularDistance);
    var sinBearing = Math.sin(bearingRad);
    var cosBearing = Math.cos(bearingRad);

    var destLat = Math.asin(sinLat * cosAd + cosLat * sinAd * cosBearing);
    var destLng = lngRad + Math.atan2(
      sinBearing * sinAd * cosLat,
      cosAd - sinLat * Math.sin(destLat)
    );

    return {
      lat: destLat * 180 / Math.PI,
      lng: ((destLng * 180 / Math.PI + 540) % 360) - 180
    };
  }

  function buildSectorPreviewLatLngs(lat, lng, bearingDeg, angleDeg, radiusM) {
    var points = [];
    var startBearing = bearingDeg - angleDeg / 2;
    var endBearing = bearingDeg + angleDeg / 2;
    var edgeSteps = Math.max(12, Math.ceil(radiusM / 12000));
    var arcSteps = Math.max(24, Math.ceil(angleDeg / 3));

    points.push([lat, lng]);

    for (var edgeOut = 1; edgeOut <= edgeSteps; edgeOut++) {
      var outPoint = destinationPoint(lat, lng, startBearing, radiusM * edgeOut / edgeSteps);
      points.push([outPoint.lat, outPoint.lng]);
    }

    for (var arcIndex = 1; arcIndex <= arcSteps; arcIndex++) {
      var sampleBearing = startBearing + (angleDeg * arcIndex / arcSteps);
      var arcPoint = destinationPoint(lat, lng, sampleBearing, radiusM);
      points.push([arcPoint.lat, arcPoint.lng]);
    }

    for (var edgeBack = edgeSteps - 1; edgeBack >= 0; edgeBack--) {
      var backPoint = destinationPoint(lat, lng, endBearing, radiusM * edgeBack / edgeSteps);
      points.push([backPoint.lat, backPoint.lng]);
    }

    return points;
  }

  function sanitize(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    var frac = Math.floor((ms % 1000) / 100);
    if (m > 0) return m + 'm ' + s + '.' + frac + 's';
    return s + '.' + frac + 's';
  }

})();
