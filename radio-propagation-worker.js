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

function collectChunkTiles(cells, startIdx, endIdx) {
  // Find bbox of chunk cells + TX
  var minLat = txLat, maxLat = txLat;
  var minLng = txLng, maxLng = txLng;

  for (var i = startIdx; i < endIdx; i++) {
    var c = cells[i];
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
  }

  var txMin = lngToTileX(minLng, zoom);
  var txMax = lngToTileX(maxLng, zoom);
  var tyMin = latToTileY(maxLat, zoom);
  var tyMax = latToTileY(minLat, zoom);

  var tiles = [];
  for (var ty = tyMin; ty <= tyMax; ty++) {
    for (var tx = txMin; tx <= txMax; tx++) {
      tiles.push({ z: zoom, x: tx, y: ty });
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

// ===== Entry point =====

function handleStart(msg) {
  ensureWasmReady().then(function () {
    handleStartInner(msg);
  }).catch(function (err) {
    self.postMessage({ type: 'error', message: 'WASM_INIT_FAILED', detail: err.message || String(err) });
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

  var cells = msg.cells;
  var totalCells = cells.length;

  // Track tiles-used per slice (don't clear cache between slices on same worker)
  tilesUsed = 0;

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
  var batchCells = [];
  var strongCount = 0, usableCount = 0, marginalCount = 0;
  var maxReachM = 0;

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
      if (batchCells.length > 0) {
        self.postMessage({
          type: 'coverageBatch',
          sliceId: sliceId,
          cells: batchCells,
          progress: 1.0,
          evaluated: evaluated
        });
      }
      self.postMessage({
        type: 'sliceDone',
        sliceId: sliceId,
        itmBackend: typeof getITMBackend === 'function' ? getITMBackend() : 'unknown',
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
          pathLoss = self.computeITMPathLoss(
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

        batchCells.push({ cellX: cell.cellX, cellY: cell.cellY, band: band });

        if (batchCells.length >= COVERAGE_BATCH_SIZE) {
          self.postMessage({
            type: 'coverageBatch',
            sliceId: sliceId,
            cells: batchCells,
            progress: evaluated / totalCells,
            evaluated: evaluated
          });
          batchCells = [];
        }
      }

      setTimeout(processNextChunk, 0);
    });
  }

  processNextChunk();
}
