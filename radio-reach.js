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
  var MAX_MASK_MB = 300;
  var PROP_WORKER_COUNT = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

  // Attribution strings
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  var TOPO_ATTR = 'Map data: ' + OSM_ATTR + ', SRTM | Map style: &copy; <a href="https://opentopomap.org/about">OpenTopoMap</a> (CC-BY-SA)';

  var radioState = {
    map: null,
    marker: null,
    lat: null,
    lng: null,
    worker: null,
    propWorkers: [],
    canvasLayer: null,
    running: false,
    startTime: 0,
  };

  // ===== DOM refs (cached on init) =====
  var coordsEl, instructionEl, analyzeBtnEl, clearBtnEl,
      progressOverlayEl, progressBarEl, progressTextEl,
      statsPanelEl, statsEl,
      antennaInput, radiusInput, frequencySelect, txPowerInput,
      resolutionSelect,
      controlsPanel, controlsToggle, legendEl, unfilteredCheck,
      radarSweepCheck, adaptiveCullingCheck, itmEngineSelect;

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
    resolutionSelect = document.getElementById('radio-resolution');
    txPowerInput = document.getElementById('radio-tx-power');
    legendEl = document.getElementById('radio-legend');
    controlsPanel = document.getElementById('radio-controls-panel');
    controlsToggle = document.getElementById('radio-controls-toggle');
    unfilteredCheck = document.getElementById('radio-unfiltered');
    radarSweepCheck = document.getElementById('radio-radar-sweep');
    adaptiveCullingCheck = document.getElementById('radio-adaptive-culling');
    itmEngineSelect = document.getElementById('radio-itm-engine');

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
    var radiusKm = clampNumber(radiusInput.value, 5, 1000, 30);
    var txPowerW = clampNumber(txPowerInput.value, 0.1, 100, 5);
    var freqMHz = parseFloat(frequencySelect.value);
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

    // Memory guardrail: abort if full-circle mask would exceed MAX_MASK_MB
    // and radar sweep is not enabled to break the work into wedges
    if (!radarSweepCheck.checked) {
      var mppGuard = metersPerPixel(radioState.lat, analysisZoom);
      var pixelRadius = (radiusKm * 1000) / mppGuard;
      var diameter = pixelRadius * 2;
      var requiredMB = (diameter * diameter) / (1024 * 1024);
      if (requiredMB > MAX_MASK_MB) {
        statsEl.innerHTML = t('radioMemoryGuardrail', { mb: Math.round(requiredMB) });
        statsPanelEl.hidden = false;
        return;
      }
    }

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
        fetchAndSendTiles(msg.tiles, radioState.worker);
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
      unfiltered: unfilteredCheck.checked,
      itmEngine: itmEngineSelect.value,
      radarSweep: radarSweepCheck.checked,
      adaptiveCulling: adaptiveCullingCheck.checked,
    });
  }

  function fetchAndSendTiles(tiles, targetWorker) {
    var promises = tiles.map(function (tc) {
      return getTile(tc.z, tc.x, tc.y).then(function (data) {
        return { z: tc.z, x: tc.x, y: tc.y, data: data };
      }).catch(function () {
        return { z: tc.z, x: tc.x, y: tc.y, data: new Float32Array(256 * 256) };
      });
    });

    Promise.all(promises).then(function (results) {
      if (!targetWorker) return;
      var transfers = [];
      var tileData = results.map(function (r) {
        var copy = new Float32Array(r.data);
        transfers.push(copy.buffer);
        return { z: r.z, x: r.x, y: r.y, data: copy.buffer };
      });
      targetWorker.postMessage({ type: 'tiles', tiles: tileData }, transfers);
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
    // Decode binary coverage: Float32Array with [lat, lng, band, ...] triples
    var data = new Float32Array(msg.cells);
    for (var i = 0; i < data.length; i += 3) {
      layer.setCellByLatLng(data[i], data[i + 1], data[i + 2]);
    }
    layer.scheduleRefresh();
  }

  // ===== Phase 3 Partition → Spawn Propagation Workers =====
  function handlePhase3Partition(msg) {
    var mask = new Uint8Array(msg.mask);
    var maskW = msg.maskW;
    var maskH = msg.maskH;
    var txParams = msg.txParams;

    // Track sweep state
    if (msg.isRadarSweep) {
      radioState._isRadarSweep = true;
      radioState._sweepTotalWedges = msg.totalWedges;
      if (!radioState._sweepAggStats) {
        // Initialize aggregate stats on first wedge
        radioState._sweepWedgesCompleted = 0;
        radioState._sweepAggStats = {
          evaluated: 0, strongCount: 0, usableCount: 0,
          marginalCount: 0, maxReachM: 0, tilesUsed: 0
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

    // Determine slice count: split mask into horizontal row-bands
    var sliceCount = Math.min(4, maskH);
    if (sliceCount < 1) sliceCount = 1;
    radioState._propWorkerCount = Math.min(PROP_WORKER_COUNT, sliceCount);

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
      maxReachM: 0,
      tilesUsed: msg.tilesUsed
    };

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
            fetchAndSendTiles(m.tiles, workerRef);
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
          sliceId: assignment.sliceId,
          txLat: txParams.txLat,
          txLng: txParams.txLng,
          txElevation: txParams.txElevation,
          antennaHeight: txParams.antennaHeight,
          freqMHz: txParams.freqMHz,
          txPowerW: txParams.txPowerW,
          zoom: txParams.zoom,
          mpp: txParams.mpp,
          unfiltered: radioState._unfiltered,
          itmEngine: txParams.itmEngine,
          adaptiveCulling: txParams.adaptiveCulling
        }, [sliceMaskCopy.buffer]);
      }
    }
  }

  function handleSliceDone(msg) {
    var agg = radioState._propAggStats;
    agg.evaluated += msg.stats.evaluated;
    agg.strongCount += msg.stats.strongCount;
    agg.usableCount += msg.stats.usableCount;
    agg.marginalCount += msg.stats.marginalCount;
    agg.tilesUsed += msg.stats.tilesUsed;
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
        sa.tilesUsed += agg.tilesUsed;
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
          tilesUsed: agg.tilesUsed,
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
    // In sweep mode, the orchestrator's final 'done' message has zeroed stats;
    // use the accumulated sweep stats instead
    if (radioState._isRadarSweep && radioState._sweepAggStats) {
      var sa = radioState._sweepAggStats;
      stats = {
        tilesUsed: sa.tilesUsed,
        cellsEvaluated: sa.evaluated,
        strongCount: sa.strongCount,
        usableCount: sa.usableCount,
        marginalCount: sa.marginalCount,
        maxReachM: sa.maxReachM,
        workerCount: radioState._propWorkerCount || 1,
        itmBackend: sa.itmBackend
      };
    }

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
      statsEl.innerHTML = t('radioTileLimitExceeded', { n: msg.count || MAX_TILES_LIMIT });
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

  function formatElapsed(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    var frac = Math.floor((ms % 1000) / 100);
    if (m > 0) return m + 'm ' + s + '.' + frac + 's';
    return s + '.' + frac + 's';
  }

})();
