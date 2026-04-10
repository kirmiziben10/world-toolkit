// ===== Radio Reach — Longley-Rice Propagation Coverage App =====
// Full-window app with its own Leaflet map, collapsible filter sidebar,
// progress overlay, and gradient coverage canvas.

(function () {
  'use strict';

  var TerrainTiles = window.TerrainTiles;
  var getTile = TerrainTiles.getTile;
  var metersPerPixel = TerrainTiles.metersPerPixel;
  var t = window.i18n.t;
  var ANALYSIS_ZOOM = 12;
  var EARTH_RADIUS = 6378137;
  var MAX_TILES_LIMIT = 2000;

  // Attribution strings
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var TOPO_ATTR = 'Map data: ' + OSM_ATTR + ', SRTM | Map style: &copy; <a href="https://opentopomap.org/about">OpenTopoMap</a> (CC-BY-SA)';

  var radioState = {
    map: null,
    marker: null,
    lat: null,
    lng: null,
    worker: null,
    canvasLayer: null,
    running: false,
  };

  // ===== DOM refs (cached on init) =====
  var coordsEl, instructionEl, analyzeBtnEl, clearBtnEl,
      progressOverlayEl, progressBarEl, progressTextEl,
      statsPanelEl, statsEl,
      antennaInput, radiusInput, frequencySelect, txPowerInput,
      controlsPanel, controlsToggle, legendEl;

  // ===== Expose for app.js wiring =====
  window.RadioReach = {
    init: init,
    invalidateMap: invalidateMap,
  };

  function init() {
    coordsEl = document.getElementById('radio-coords');
    instructionEl = document.getElementById('radio-instruction');
    analyzeBtnEl = document.getElementById('radio-analyze-btn');
    clearBtnEl = document.getElementById('radio-clear-btn');
    progressOverlayEl = document.getElementById('radio-progress-overlay');
    progressBarEl = document.getElementById('radio-progress-bar');
    progressTextEl = document.getElementById('radio-progress-text');
    statsPanelEl = document.getElementById('radio-stats-panel');
    statsEl = document.getElementById('radio-stats');
    antennaInput = document.getElementById('radio-antenna-height');
    radiusInput = document.getElementById('radio-radius');
    frequencySelect = document.getElementById('radio-frequency');
    txPowerInput = document.getElementById('radio-tx-power');
    legendEl = document.getElementById('radio-legend');
    controlsPanel = document.getElementById('radio-controls-panel');
    controlsToggle = document.getElementById('radio-controls-toggle');

    analyzeBtnEl.addEventListener('click', startAnalysis);
    clearBtnEl.addEventListener('click', clearAll);

    // Stats panel close button
    document.getElementById('radio-close-stats').addEventListener('click', function () {
      statsPanelEl.hidden = true;
    });

    // Controls panel toggle
    initControlsToggle();

    // Initialize own Leaflet map
    initMap();
  }

  // ===== Map =====
  function initMap() {
    radioState.map = L.map('radio-map', {
      center: [39.9, 32.8],
      zoom: 7,
      zoomControl: false,
    });

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

    // Map click places transmitter
    radioState.map.on('click', function (e) {
      handleMapClick(e.latlng);
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
  }

  // ===== Analysis =====
  function startAnalysis() {
    if (radioState.lat === null || radioState.running) return;

    var antennaHeight = clampNumber(antennaInput.value, 0, 500, 10);
    var radiusKm = clampNumber(radiusInput.value, 5, 100, 30);
    var txPowerW = clampNumber(txPowerInput.value, 0.1, 100, 5);
    var freqMHz = parseFloat(frequencySelect.value);
    antennaInput.value = antennaHeight;
    radiusInput.value = radiusKm;
    txPowerInput.value = txPowerW;

    radioState.running = true;
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
        fetchAndSendTiles(msg.tiles);
      } else if (msg.type === 'phase1Done') {
        handlePhase1Done(msg);
      } else if (msg.type === 'phase2Done') {
        handlePhase2Done(msg);
      } else if (msg.type === 'coverageBounds') {
        handleCoverageBounds(msg);
      } else if (msg.type === 'coverageBatch') {
        handleCoverageBatch(msg);
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
      zoom: ANALYSIS_ZOOM,
      freqMHz: freqMHz,
      txPowerW: txPowerW,
    });
  }

  function fetchAndSendTiles(tiles) {
    var promises = tiles.map(function (tc) {
      return getTile(tc.z, tc.x, tc.y).then(function (data) {
        return { z: tc.z, x: tc.x, y: tc.y, data: data };
      }).catch(function () {
        return { z: tc.z, x: tc.x, y: tc.y, data: new Float32Array(256 * 256) };
      });
    });

    Promise.all(promises).then(function (results) {
      if (!radioState.worker) return;
      var transfers = [];
      var tileData = results.map(function (r) {
        var copy = new Float32Array(r.data);
        transfers.push(copy.buffer);
        return { z: r.z, x: r.x, y: r.y, data: copy.buffer };
      });
      radioState.worker.postMessage({ type: 'tiles', tiles: tileData }, transfers);
      progressTextEl.textContent = t('radioFetchingTiles');
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
    var pct = 20 + Math.round(msg.progress * 80);
    progressBarEl.style.width = pct + '%';
    progressTextEl.textContent = t('radioPhase3', {
      done: msg.evaluated,
      total: radioState._totalCells || '?'
    });

    var layer = radioState.canvasLayer;
    for (var i = 0; i < msg.cells.length; i++) {
      var c = msg.cells[i];
      layer.setCellByLatLng(c.lat, c.lng, c.band);
    }
    layer.scheduleRefresh();
  }

  function handleDone(stats) {
    radioState.running = false;
    analyzeBtnEl.disabled = false;
    clearBtnEl.hidden = false;
    progressOverlayEl.hidden = true;

    if (radioState.canvasLayer) {
      radioState.canvasLayer.flushRefresh();
    }

    var maxReachKm = (stats.maxReachM / 1000).toFixed(1);
    var mppVal = metersPerPixel(radioState.lat, ANALYSIS_ZOOM);
    var pixelAreaKm2 = (mppVal * mppVal) / 1e6;
    var strongAreaKm2 = (stats.strongCount * pixelAreaKm2).toFixed(1);
    var usableAreaKm2 = (stats.usableCount * pixelAreaKm2).toFixed(1);
    var marginalAreaKm2 = (stats.marginalCount * pixelAreaKm2).toFixed(1);

    statsEl.innerHTML =
      '<strong>' + t('radioComplete') + '</strong><br>' +
      t('radioTilesUsed', { n: stats.tilesUsed }) + '<br>' +
      t('radioCellsEvaluated', { n: stats.cellsEvaluated }) + '<br>' +
      t('radioMaxReach', { km: maxReachKm }) + '<br>' +
      '<span class="radio-stat-strong">&#9632;</span> ' + t('radioStrongArea', { km2: strongAreaKm2 }) + '<br>' +
      '<span class="radio-stat-usable">&#9632;</span> ' + t('radioUsableArea', { km2: usableAreaKm2 }) + '<br>' +
      '<span class="radio-stat-marginal">&#9632;</span> ' + t('radioMarginalArea', { km2: marginalAreaKm2 });
    statsPanelEl.hidden = false;

    if (legendEl) legendEl.hidden = false;

    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
  }

  function handleError(msg) {
    radioState.running = false;
    analyzeBtnEl.disabled = radioState.lat === null;
    progressOverlayEl.hidden = true;

    if (msg.message === 'TILE_LIMIT') {
      statsEl.innerHTML = t('radioTileLimitExceeded', { n: msg.count || MAX_TILES_LIMIT });
    } else {
      statsEl.innerHTML = t('radioAborted') + ': ' + sanitize(msg.message);
    }
    statsPanelEl.hidden = false;
    clearBtnEl.hidden = false;

    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
  }

  function clearAll() {
    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
    radioState.running = false;
    radioState.lat = null;
    radioState.lng = null;

    if (radioState.marker) {
      radioState.map.removeLayer(radioState.marker);
      radioState.marker = null;
    }
    removeOverlay();

    coordsEl.hidden = true;
    instructionEl.hidden = false;
    analyzeBtnEl.disabled = true;
    clearBtnEl.hidden = true;
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
      this._overlay = null;
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
      this._objectUrl = null;
    },

    onAdd: function (map) {
      this._map = map;
    },

    onRemove: function (map) {
      if (this._overlay) {
        map.removeLayer(this._overlay);
        this._overlay = null;
      }
      if (this._objectUrl) {
        URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = null;
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

    scheduleRefresh: function () {
      if (this._refreshTimer) return;
      var self = this;
      if (this._pendingCells >= 5000) {
        this._doRefresh();
      } else {
        this._refreshTimer = setTimeout(function () {
          self._refreshTimer = null;
          self._doRefresh();
        }, 200);
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
      this._pendingCells = 0;

      var ctx = this._canvas.getContext('2d');
      ctx.putImageData(this._imageData, 0, 0);

      // Revoke old object URL
      if (this._objectUrl) {
        URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = null;
      }

      var self = this;
      this._canvas.toBlob(function (blob) {
        if (!self._map) return;
        self._objectUrl = URL.createObjectURL(blob);
        if (self._overlay) {
          self._overlay.setUrl(self._objectUrl);
        } else {
          self._overlay = L.imageOverlay(self._objectUrl, self._bounds, {
            opacity: 1,
            interactive: false,
            zIndex: 450
          }).addTo(self._map);
        }
      });
    },
  });

  function _latToMercY(lat) {
    var latRad = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + latRad / 2));
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

  function sanitize(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
