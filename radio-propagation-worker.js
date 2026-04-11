// ===== Radio Propagation Worker — Phase 3 ITM Evaluation Slice =====
// Receives a list of cells + TX params, evaluates Longley-Rice ITM path loss
// for each cell, and emits coverageBatch messages directly to the main thread.
// Tile data is fetched via the main thread proxy (same protocol as the
// orchestrator worker).
importScripts('terrain-tiles.js');
importScripts('vendor/itm/itm-glue.js');
importScripts('vendor/itm/itm-loader.js');
importScripts('vendor/itm/itm-wrapper.js');

var TILE_SIZE = self.TerrainTiles.TILE_SIZE;       // 256
var EARTH_RADIUS = 6378137;
var MAX_TILES = 2000;
var CHUNK_SIZE = 64;
var COVERAGE_BATCH_SIZE = 500;
var RX_HEIGHT_M = 2;
var RX_SENSITIVITY_DBW = -140;

var metersPerPixel = self.TerrainTiles.metersPerPixel;
var lngToTileX = self.TerrainTiles.lngToTileX;
var latToTileY = self.TerrainTiles.latToTileY;

// ===== Tile store =====
var tileStore = new Map();
var tilesUsed = 0;
var pendingTileResolve = null;

// ===== Analysis parameters (set by start message) =====
var zoom = 12;
var mpp = 0;
var txLat = 0;
var txLng = 0;
var txElevation = 0;
var antennaHeight = 10;
var freqMHz = 144;
var txPowerW = 5;
var sliceId = 0;

// ===== Message handler =====
var startQueue = [];
var processing = false;

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'start') {
    if (processing) {
      startQueue.push(msg);
    } else {
      processing = true;
      handleStart(msg);
    }
  } else if (msg.type === 'tiles') {
    handleTiles(msg.tiles);
  }
};

function onSliceFinished() {
  if (startQueue.length > 0) {
    var next = startQueue.shift();
    handleStart(next);
  } else {
    processing = false;
  }
}

// ===== Tile management =====

function handleTiles(tiles) {
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    var key = t.z + '/' + t.x + '/' + t.y;
    tileStore.set(key, new Float32Array(t.data));
  }
  if (pendingTileResolve) {
    var resolve = pendingTileResolve;
    pendingTileResolve = null;
    resolve();
  }
}

function getElevation(lat, lng) {
  var tx = lngToTileX(lng, zoom);
  var ty = latToTileY(lat, zoom);
  var key = zoom + '/' + tx + '/' + ty;
  var tile = tileStore.get(key);
  if (!tile) return null;

  var n = Math.pow(2, zoom);
  var xFrac = ((lng + 180) / 360) * n;
  var latRad = lat * Math.PI / 180;
  var yFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;

  var px = Math.floor((xFrac - tx) * TILE_SIZE);
  var py = Math.floor((yFrac - ty) * TILE_SIZE);
  px = Math.max(0, Math.min(TILE_SIZE - 1, px));
  py = Math.max(0, Math.min(TILE_SIZE - 1, py));

  return tile[py * TILE_SIZE + px];
}

function getTileCoord(lat, lng) {
  return { z: zoom, x: lngToTileX(lng, zoom), y: latToTileY(lat, zoom) };
}

function requestTilesAndRun(neededTiles, callback) {
  var toFetch = [];
  var seen = {};
  for (var i = 0; i < neededTiles.length; i++) {
    var t = neededTiles[i];
    var key = t.z + '/' + t.x + '/' + t.y;
    if (!tileStore.has(key) && !seen[key]) {
      toFetch.push(t);
      seen[key] = true;
    }
  }

  if (toFetch.length === 0) {
    callback();
    return;
  }

  tilesUsed += toFetch.length;
  if (tilesUsed > MAX_TILES) {
    self.postMessage({ type: 'error', message: 'TILE_LIMIT', sliceId: sliceId });
    return;
  }

  pendingTileResolve = callback;
  self.postMessage({ type: 'needTiles', tiles: toFetch, sliceId: sliceId });
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

var MAX_PROFILE_SAMPLES = 2048;

function buildProfile(lat1, lng1, lat2, lng2) {
  var distM = haversineDistance(lat1, lng1, lat2, lng2);
  if (distM < mpp) return null;

  var nSamples = Math.max(2, Math.round(distM / mpp));
  // Cap at WASM PFL buffer limit — resample at coarser spacing for long paths
  if (nSamples > MAX_PROFILE_SAMPLES) nSamples = MAX_PROFILE_SAMPLES;
  var spacingM = distM / (nSamples - 1);
  var profile = new Float32Array(nSamples);

  for (var i = 0; i < nSamples; i++) {
    var frac = i / (nSamples - 1);
    var lat = lat1 + (lat2 - lat1) * frac;
    var lng = lng1 + (lng2 - lng1) * frac;
    var elev = getElevation(lat, lng);
    if (elev === null) return null;
    profile[i] = elev;
  }

  return { profile: profile, spacingM: spacingM };
}

// ===== Mask-to-geo coordinate helpers =====
var maskOriginGlobalX = 0;
var maskOriginGlobalY = 0;

function globalPixelYToLat(gpy) {
  var n = Math.pow(2, zoom);
  var yFrac = gpy / (n * TILE_SIZE);
  var nVal = Math.PI - 2 * Math.PI * yFrac;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(nVal) - Math.exp(-nVal)));
}

function globalPixelXToLng(gpx) {
  var n = Math.pow(2, zoom);
  return (gpx / (n * TILE_SIZE)) * 360 - 180;
}

function collectChunkTiles(cells, startIdx, endIdx) {
  // Find bbox of chunk cells only (not TX) for corner ray tracing
  var minLat = Infinity, maxLat = -Infinity;
  var minLng = Infinity, maxLng = -Infinity;

  for (var i = startIdx; i < endIdx; i++) {
    var c = cells[i];
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
  }

  var seen = {};
  var tiles = [];

  function addTile(tz, tx, ty) {
    var key = tz + '/' + tx + '/' + ty;
    if (!seen[key]) {
      seen[key] = true;
      tiles.push({ z: tz, x: tx, y: ty });
    }
  }

  // Collect tiles along a ray from TX to a target point using Bresenham-style stepping
  function traceRayTiles(toLat, toLng) {
    var x0 = lngToTileX(txLng, zoom);
    var y0 = latToTileY(txLat, zoom);
    var x1 = lngToTileX(toLng, zoom);
    var y1 = latToTileY(toLat, zoom);
    addTile(zoom, x0, y0);
    addTile(zoom, x1, y1);

    var dx = Math.abs(x1 - x0);
    var dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;

    var cx = x0, cy = y0;
    while (cx !== x1 || cy !== y1) {
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx)  { err += dx; cy += sy; }
      addTile(zoom, cx, cy);
    }
  }

  // Trace rays from TX to the four geographic corners of the chunk
  traceRayTiles(minLat, minLng);
  traceRayTiles(minLat, maxLng);
  traceRayTiles(maxLat, minLng);
  traceRayTiles(maxLat, maxLng);

  // Also include the chunk's own tiles directly (cells need their own tile data)
  var chunkTxMin = lngToTileX(minLng, zoom);
  var chunkTxMax = lngToTileX(maxLng, zoom);
  var chunkTyMin = latToTileY(maxLat, zoom);
  var chunkTyMax = latToTileY(minLat, zoom);
  for (var ty = chunkTyMin; ty <= chunkTyMax; ty++) {
    for (var tx = chunkTxMin; tx <= chunkTxMax; tx++) {
      addTile(zoom, tx, ty);
    }
  }

  return tiles;
}

// ===== WASM init state =====
var wasmReady = false;
var wasmInitPromise = null;

function ensureWasmReady() {
  if (wasmReady) return Promise.resolve();
  if (wasmInitPromise) return wasmInitPromise;
  wasmInitPromise = self.initITM().then(function () {
    wasmReady = true;
  });
  return wasmInitPromise;
}

// ===== JS fallback init state =====
var jsReady = false;
var jsComputeFn = null;

function ensureJSReady() {
  if (jsReady) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    try {
      importScripts('vendor/itm/itm-js-reference.js');
    } catch (e) {
      reject(new Error('Failed to load JS ITM reference: ' + e.message));
      return;
    }
    if (!self.ITM || typeof self.ITM.ITM_P2P_TLS !== 'function') {
      reject(new Error('JS ITM reference loaded but ITM.ITM_P2P_TLS not found'));
      return;
    }

    // Hardcoded params matching the WASM loader
    var CLIMATE   = 5;
    var N_0       = 301;
    var POL       = 1;
    var EPSILON   = 15;
    var SIGMA     = 0.008;
    var MDVAR     = 12;
    var TIME      = 50;
    var LOCATION  = 50;
    var SITUATION = 50;

    var itmRef = self.ITM;

    jsComputeFn = function (profile, spacingM, txHeightM, rxHeightM, freqMHz) {
      var nSamples = profile.length;
      var N = nSamples - 1;
      // Build PFL array: [N, spacingM, elev0, ..., elevN]
      var pfl = new Array(nSamples + 2);
      pfl[0] = N;
      pfl[1] = spacingM;
      for (var i = 0; i < nSamples; i++) {
        pfl[2 + i] = profile[i];
      }

      var result = itmRef.ITM_P2P_TLS(
        txHeightM, rxHeightM, pfl,
        CLIMATE, N_0, freqMHz,
        POL, EPSILON, SIGMA,
        MDVAR, TIME, LOCATION, SITUATION
      );

      if (result.error >= 1000) {
        throw new Error('ITM JS error ' + result.error + ' (warnings: 0x' + result.warnings.toString(16) + ')');
      }
      return result.A__db;
    };

    jsReady = true;
    resolve();
  });
}

// ===== Active engine selection =====
var activeEngine = 'wasm';  // 'wasm' or 'js'

// ===== Entry point =====

function handleStart(msg) {
  activeEngine = msg.itmEngine || 'wasm';

  var initPromise;
  if (activeEngine === 'js') {
    initPromise = ensureJSReady();
  } else {
    initPromise = ensureWasmReady();
  }

  initPromise.then(function () {
    handleStartInner(msg);
  }).catch(function (err) {
    var errType = activeEngine === 'js' ? 'JS_INIT_FAILED' : 'WASM_INIT_FAILED';
    self.postMessage({ type: 'error', message: errType, detail: err.message || String(err) });
    onSliceFinished();
  });
}

function handleStartInner(msg) {
  txLat = msg.txLat;
  txLng = msg.txLng;
  txElevation = msg.txElevation;
  antennaHeight = msg.antennaHeight;
  freqMHz = msg.freqMHz;
  txPowerW = msg.txPowerW;
  zoom = msg.zoom;
  mpp = msg.mpp;
  sliceId = msg.sliceId;
  maskOriginGlobalX = msg.maskOriginGlobalX;
  maskOriginGlobalY = msg.maskOriginGlobalY;

  // Decode binary mask slice into cell list
  var mask = new Uint8Array(msg.mask);
  var maskW = msg.maskW;
  var rowOffset = msg.rowOffset;
  var rows = msg.rows;
  var cells = [];
  for (var ry = 0; ry < rows; ry++) {
    var globalCellY = rowOffset + ry;
    for (var px = 0; px < maskW; px++) {
      if (!mask[ry * maskW + px]) continue;
      cells.push({
        cellX: px,
        cellY: globalCellY,
        lat: globalPixelYToLat(maskOriginGlobalY + globalCellY),
        lng: globalPixelXToLng(maskOriginGlobalX + px)
      });
    }
  }

  var totalCells = cells.length;

  // Tile limit is cumulative across all slices on this worker — do not reset tilesUsed

  // Ensure TX tile is loaded first
  var txTile = getTileCoord(txLat, txLng);
  requestTilesAndRun([txTile], function () {
    if (txElevation === undefined || txElevation === null) {
      txElevation = getElevation(txLat, txLng) || 0;
    }
    processSlice(cells, totalCells);
  });
}

function processSlice(cells, totalCells) {
  var txPowerDbW = 10 * Math.log10(txPowerW);
  var txGainDbi = 0;
  var rxGainDbi = 0;

  var evaluated = 0;
  // Binary batch buffer: Uint16Array triples [cellX, cellY, band, ...]
  var batchBuf = new Uint16Array(COVERAGE_BATCH_SIZE * 3);
  var batchCount = 0;
  var strongCount = 0, usableCount = 0, marginalCount = 0;
  var maxReachM = 0;

  function flushBatch(progress) {
    if (batchCount === 0) return;
    var slice = batchBuf.slice(0, batchCount * 3);
    self.postMessage({
      type: 'coverageBatch',
      sliceId: sliceId,
      cells: slice.buffer,
      progress: progress,
      evaluated: evaluated
    }, [slice.buffer]);
    batchBuf = new Uint16Array(COVERAGE_BATCH_SIZE * 3);
    batchCount = 0;
  }

  // Sort cells into 64×64 spatial chunks for tile batching efficiency.
  // Group by (cellX >> 6, cellY >> 6) to match CHUNK_SIZE = 64.
  var chunkMap = {};
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var ck = (c.cellX >> 6) + ',' + (c.cellY >> 6);
    if (!chunkMap[ck]) chunkMap[ck] = [];
    chunkMap[ck].push(c);
  }
  var chunkKeys = Object.keys(chunkMap);
  var chunkIndex = 0;

  function processNextChunk() {
    if (chunkIndex >= chunkKeys.length) {
      // Flush remaining batch
      flushBatch(1.0);
      self.postMessage({
        type: 'sliceDone',
        sliceId: sliceId,
        itmBackend: activeEngine,
        stats: {
          evaluated: evaluated,
          reachable: strongCount + usableCount + marginalCount,
          strongCount: strongCount,
          usableCount: usableCount,
          marginalCount: marginalCount,
          maxReachM: maxReachM,
          tilesUsed: tilesUsed
        }
      });
      onSliceFinished();
      return;
    }

    var chunk = chunkMap[chunkKeys[chunkIndex]];
    chunkIndex++;

    // Collect tiles needed for this chunk
    var neededTiles = collectChunkTiles(chunk, 0, chunk.length);

    requestTilesAndRun(neededTiles, function () {
      for (var ci = 0; ci < chunk.length; ci++) {
        var cell = chunk[ci];
        evaluated++;

        var result = buildProfile(txLat, txLng, cell.lat, cell.lng);
        if (!result) continue;

        var pathLoss;
        try {
          var computeFn = activeEngine === 'js' ? jsComputeFn : self.computeITMPathLoss;
          pathLoss = computeFn(
            result.profile, result.spacingM, antennaHeight, RX_HEIGHT_M, freqMHz
          );
        } catch (e) {
          continue;
        }

        var margin = txPowerDbW + txGainDbi + rxGainDbi - pathLoss - RX_SENSITIVITY_DBW;

        var band;
        if (margin > 20)      { band = 0; strongCount++; }
        else if (margin >= 5) { band = 1; usableCount++; }
        else if (margin >= 0) { band = 2; marginalCount++; }
        else continue;

        var distM = haversineDistance(txLat, txLng, cell.lat, cell.lng);
        if (distM > maxReachM) maxReachM = distM;

        var bi = batchCount * 3;
        batchBuf[bi]     = cell.cellX;
        batchBuf[bi + 1] = cell.cellY;
        batchBuf[bi + 2] = band;
        batchCount++;

        if (batchCount >= COVERAGE_BATCH_SIZE) {
          flushBatch(evaluated / totalCells);
        }
      }

      setTimeout(processNextChunk, 0);
    });
  }

  processNextChunk();
}
