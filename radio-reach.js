// ===== Radio Reach — Line-of-Sight Coverage App =====
// Full-window app with its own Leaflet map, collapsible filter sidebar,
// progress overlay, and coverage canvas.

(function () {
  'use strict';

  var TerrainTiles = window.TerrainTiles;
  var getTile = TerrainTiles.getTile;
  var metersPerPixel = TerrainTiles.metersPerPixel;
  var t = window.i18n.t;
  var ANALYSIS_ZOOM = 12;
  var EARTH_RADIUS = 6378137;
  var MAX_TILES_LIMIT = 500;

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
      antennaInput, radiusInput, frequencySelect,
      controlsPanel, controlsToggle;

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
    antennaInput.value = antennaHeight;
    radiusInput.value = radiusKm;

    radioState.running = true;
    analyzeBtnEl.disabled = true;
    clearBtnEl.hidden = true;
    statsPanelEl.hidden = true;

    progressOverlayEl.hidden = false;
    progressBarEl.style.width = '0%';
    progressTextEl.textContent = t('radioAnalyzing');

    removeOverlay();

    radioState.canvasLayer = new RadioCoverageLayer();
    radioState.canvasLayer.addTo(radioState.map);

    if (radioState.worker) radioState.worker.terminate();
    radioState.worker = new Worker('viewshed-worker.js');

    radioState.worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'needTiles') {
        fetchAndSendTiles(msg.tiles);
      } else if (msg.type === 'rayBatch') {
        handleRayBatch(msg);
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

  function handleRayBatch(msg) {
    if (!radioState.canvasLayer) return;
    var pct = Math.round(msg.progress * 100);
    progressBarEl.style.width = pct + '%';
    progressTextEl.textContent = t('radioRayProgress', {
      done: Math.round(msg.progress * 360),
      total: 360
    });

    var layer = radioState.canvasLayer;
    var prevLen = layer._points.length;
    for (var i = 0; i < msg.rays.length; i++) {
      var ray = msg.rays[i];
      for (var j = 0; j < ray.reachablePoints.length; j++) {
        var pt = ray.reachablePoints[j];
        if (pt.visible) {
          layer.addPoint(pt.lat, pt.lng);
        }
      }
    }
    layer.renderIncremental(prevLen);
  }

  function handleDone(stats) {
    radioState.running = false;
    analyzeBtnEl.disabled = false;
    clearBtnEl.hidden = false;
    progressOverlayEl.hidden = true;

    var maxReachKm = 0;
    if (radioState.canvasLayer && radioState.canvasLayer._points.length > 0) {
      var pts = radioState.canvasLayer._points;
      for (var i = 0; i < pts.length; i++) {
        var d = haversineDistance(radioState.lat, radioState.lng, pts[i][0], pts[i][1]);
        if (d > maxReachKm) maxReachKm = d;
      }
      maxReachKm = maxReachKm / 1000;
    }

    var radiusKm = parseFloat(radiusInput.value) || 30;
    var totalRayPoints = 360 * Math.ceil(radiusKm * 1000 / metersPerPixel(radioState.lat, ANALYSIS_ZOOM));
    var visibleCount = radioState.canvasLayer ? radioState.canvasLayer._points.length : 0;
    var coverage = totalRayPoints > 0 ? Math.min(100, Math.round((visibleCount / totalRayPoints) * 100)) : 0;

    statsEl.innerHTML =
      '<strong>' + t('radioComplete') + '</strong><br>' +
      t('radioTilesUsed', { n: stats.tilesUsed }) + '<br>' +
      t('radioMaxReach', { km: maxReachKm.toFixed(1) }) + '<br>' +
      t('radioCoverage', { pct: coverage });
    statsPanelEl.hidden = false;

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
  }

  function removeOverlay() {
    if (radioState.canvasLayer) {
      radioState.map.removeLayer(radioState.canvasLayer);
      radioState.canvasLayer = null;
    }
  }

  // ===== Canvas Coverage Layer =====
  var RadioCoverageLayer = L.Layer.extend({
    initialize: function () {
      this._points = [];
      this._canvas = null;
      this._ctx = null;
    },

    onAdd: function (map) {
      this._map = map;
      this._canvas = L.DomUtil.create('canvas', 'radio-coverage-canvas');
      var size = map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this._canvas.style.position = 'absolute';
      this._canvas.style.top = '0';
      this._canvas.style.left = '0';
      this._canvas.style.pointerEvents = 'none';
      this._canvas.style.zIndex = '450';
      this._ctx = this._canvas.getContext('2d');
      map.getPanes().overlayPane.appendChild(this._canvas);

      map.on('moveend', this._fullRedraw, this);
      map.on('zoomend', this._fullRedraw, this);
      map.on('resize', this._onResize, this);
      this._repositionCanvas();
    },

    onRemove: function (map) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      map.off('moveend', this._fullRedraw, this);
      map.off('zoomend', this._fullRedraw, this);
      map.off('resize', this._onResize, this);
      this._canvas = null;
      this._ctx = null;
    },

    _onResize: function () {
      if (!this._map || !this._canvas) return;
      var size = this._map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this._repositionCanvas();
      this._fullRedraw();
    },

    _repositionCanvas: function () {
      if (!this._map || !this._canvas) return;
      var topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
    },

    addPoint: function (lat, lng) {
      this._points.push([lat, lng]);
    },

    renderIncremental: function (startIdx) {
      if (!this._ctx || !this._map) return;
      var ctx = this._ctx;
      var map = this._map;
      var currentZoom = map.getZoom();
      var scaleFactor = Math.pow(2, currentZoom - ANALYSIS_ZOOM);
      var pixelSize = Math.max(1, Math.ceil(scaleFactor));
      var w = this._canvas.width;
      var h = this._canvas.height;

      ctx.fillStyle = 'rgba(34, 197, 94, 0.35)';

      var pts = this._points;
      for (var i = startIdx; i < pts.length; i++) {
        var p = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
        if (p.x < -pixelSize || p.x > w + pixelSize ||
            p.y < -pixelSize || p.y > h + pixelSize) continue;
        ctx.fillRect(p.x - pixelSize / 2, p.y - pixelSize / 2, pixelSize, pixelSize);
      }
    },

    _fullRedraw: function () {
      if (!this._ctx || !this._map || !this._canvas) return;
      this._repositionCanvas();
      var size = this._map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this.renderIncremental(0);
    },
  });

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
