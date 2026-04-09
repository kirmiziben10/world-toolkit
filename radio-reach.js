// ===== Radio Reach — Line-of-Sight Coverage App =====
// Companion app to Search For Spots. Computes and renders radio
// viewshed coverage from a user-selected transmitter point.
// TODO: Rocky tutorial integration — dispatch wt:radio-* events here

(function () {
  'use strict';

  var TerrainTiles = window.TerrainTiles;
  var getTile = TerrainTiles.getTile;
  var metersPerPixel = TerrainTiles.metersPerPixel;
  var t = window.i18n.t;
  var ANALYSIS_ZOOM = 12;
  var EARTH_RADIUS = 6378137;
  var MAX_TILES_LIMIT = 500;

  var radioState = {
    marker: null,
    lat: null,
    lng: null,
    worker: null,
    canvasLayer: null,
    running: false,
    active: false,  // true when Radio Reach window is focused and listening for map clicks
  };

  // ===== DOM refs (cached on init) =====
  var coordsEl, instructionEl, analyzeBtnEl, clearBtnEl,
      progressEl, progressBarEl, progressTextEl, statsEl,
      antennaInput, radiusInput, frequencySelect;

  // ===== Expose for app.js wiring =====
  window.RadioReach = {
    init: init,
    setActive: setActive,
    isActive: function () { return radioState.active; },
    handleMapClick: handleMapClick,
  };

  function init() {
    coordsEl = document.getElementById('radio-coords');
    instructionEl = document.getElementById('radio-instruction');
    analyzeBtnEl = document.getElementById('radio-analyze-btn');
    clearBtnEl = document.getElementById('radio-clear-btn');
    progressEl = document.getElementById('radio-progress');
    progressBarEl = document.getElementById('radio-progress-bar');
    progressTextEl = document.getElementById('radio-progress-text');
    statsEl = document.getElementById('radio-stats');
    antennaInput = document.getElementById('radio-antenna-height');
    radiusInput = document.getElementById('radio-radius');
    frequencySelect = document.getElementById('radio-frequency');

    analyzeBtnEl.addEventListener('click', startAnalysis);
    clearBtnEl.addEventListener('click', clearAll);
  }

  function setActive(active) {
    radioState.active = active;
  }

  // ===== Map Click Handler =====
  function handleMapClick(latlng, map) {
    if (!radioState.active) return;
    if (radioState.running) return;

    radioState.lat = latlng.lat;
    radioState.lng = latlng.lng;

    // Place or move marker
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
      }).addTo(map);
    }

    // Show coords
    coordsEl.textContent = t('radioSelectedPoint') + ': ' +
      radioState.lat.toFixed(5) + '°N, ' + radioState.lng.toFixed(5) + '°E';
    coordsEl.hidden = false;
    instructionEl.hidden = true;

    // Enable analyze
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
    statsEl.hidden = true;
    progressEl.hidden = false;
    progressBarEl.style.width = '0%';
    progressTextEl.textContent = t('radioAnalyzing');

    // Clear previous overlay
    removeOverlay();

    // Create canvas overlay
    var map = getMap();
    radioState.canvasLayer = new RadioCoverageLayer();
    radioState.canvasLayer.addTo(map);

    // Spawn worker
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
        // Return a flat zero tile on failure
        return { z: tc.z, x: tc.x, y: tc.y, data: new Float32Array(256 * 256) };
      });
    });

    Promise.all(promises).then(function (results) {
      if (!radioState.worker) return;
      var transfers = [];
      var tileData = results.map(function (r) {
        // Copy the data so the shared tile cache isn't neutered by transfer
        var copy = new Float32Array(r.data);
        transfers.push(copy.buffer);
        return { z: r.z, x: r.x, y: r.y, data: copy.buffer };
      });
      radioState.worker.postMessage({ type: 'tiles', tiles: tileData }, transfers);

      // Update tile count display
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

    // Paint visible points
    for (var i = 0; i < msg.rays.length; i++) {
      var ray = msg.rays[i];
      for (var j = 0; j < ray.reachablePoints.length; j++) {
        var pt = ray.reachablePoints[j];
        if (pt.visible) {
          radioState.canvasLayer.addPoint(pt.lat, pt.lng);
        }
      }
    }
    radioState.canvasLayer.render();
  }

  function handleDone(stats) {
    radioState.running = false;
    analyzeBtnEl.disabled = false;
    clearBtnEl.hidden = false;
    progressEl.hidden = true;

    // Compute max reach
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
    // Approximate coverage: visible area / total circular area
    // Use point count as proxy — each point covers ~1 pixel area
    var totalRayPoints = 360 * Math.ceil(radiusKm * 1000 / metersPerPixel(radioState.lat, ANALYSIS_ZOOM));
    var visibleCount = radioState.canvasLayer ? radioState.canvasLayer._points.length : 0;
    var coverage = totalRayPoints > 0 ? Math.min(100, Math.round((visibleCount / totalRayPoints) * 100)) : 0;

    statsEl.innerHTML =
      t('radioComplete') + '<br>' +
      t('radioTilesUsed', { n: stats.tilesUsed }) + '<br>' +
      t('radioMaxReach', { km: maxReachKm.toFixed(1) }) + '<br>' +
      t('radioCoverage', { pct: coverage });
    statsEl.hidden = false;

    if (radioState.worker) {
      radioState.worker.terminate();
      radioState.worker = null;
    }
  }

  function handleError(msg) {
    radioState.running = false;
    analyzeBtnEl.disabled = radioState.lat === null;
    progressEl.hidden = true;

    if (msg.message === 'TILE_LIMIT') {
      statsEl.innerHTML = t('radioTileLimitExceeded', { n: msg.count || MAX_TILES_LIMIT });
    } else {
      statsEl.innerHTML = t('radioAborted') + ': ' + sanitize(msg.message);
    }
    statsEl.hidden = false;
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
      getMap().removeLayer(radioState.marker);
      radioState.marker = null;
    }
    removeOverlay();

    coordsEl.hidden = true;
    instructionEl.hidden = false;
    analyzeBtnEl.disabled = true;
    clearBtnEl.hidden = true;
    progressEl.hidden = true;
    statsEl.hidden = true;
    progressBarEl.style.width = '0%';
  }

  function removeOverlay() {
    if (radioState.canvasLayer) {
      getMap().removeLayer(radioState.canvasLayer);
      radioState.canvasLayer = null;
    }
  }

  // ===== Canvas Coverage Layer =====
  // Custom Leaflet layer that accumulates points and renders them as a single canvas
  var RadioCoverageLayer = L.Layer.extend({
    initialize: function () {
      this._points = []; // [[lat, lng], ...]
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

      map.on('moveend', this._repositionCanvas, this);
      map.on('zoomend', this._repositionCanvas, this);
      map.on('resize', this._onResize, this);
      this._repositionCanvas();
    },

    onRemove: function (map) {
      if (this._canvas && this._canvas.parentNode) {
        this._canvas.parentNode.removeChild(this._canvas);
      }
      map.off('moveend', this._repositionCanvas, this);
      map.off('zoomend', this._repositionCanvas, this);
      map.off('resize', this._onResize, this);
      this._canvas = null;
      this._ctx = null;
    },

    _onResize: function () {
      if (!this._map || !this._canvas) return;
      var size = this._map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this.render();
    },

    _repositionCanvas: function () {
      if (!this._map || !this._canvas) return;
      var topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      var size = this._map.getSize();
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this.render();
    },

    addPoint: function (lat, lng) {
      this._points.push([lat, lng]);
    },

    render: function () {
      if (!this._ctx || !this._map) return;
      var ctx = this._ctx;
      var map = this._map;
      var canvas = this._canvas;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (this._points.length === 0) return;

      // Determine pixel size for coverage rectangles
      // Each point represents ~1 pixel at the analysis zoom,
      // so size it proportionally to current map zoom
      var currentZoom = map.getZoom();
      var scaleFactor = Math.pow(2, currentZoom - ANALYSIS_ZOOM);
      var pixelSize = Math.max(1, Math.ceil(scaleFactor));

      ctx.fillStyle = 'rgba(34, 197, 94, 0.35)';

      var pts = this._points;
      for (var i = 0; i < pts.length; i++) {
        var p = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
        // Skip points outside canvas
        if (p.x < -pixelSize || p.x > canvas.width + pixelSize ||
            p.y < -pixelSize || p.y > canvas.height + pixelSize) continue;
        ctx.fillRect(p.x - pixelSize / 2, p.y - pixelSize / 2, pixelSize, pixelSize);
      }
    },
  });

  // ===== Utility =====
  function getMap() {
    // Access the shared map from app.js
    return window._worldToolkitMap;
  }

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
