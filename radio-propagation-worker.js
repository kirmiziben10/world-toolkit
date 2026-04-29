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
var DEFAULT_RX_HEIGHT_M = 2;
var DEFAULT_RX_SENSITIVITY_DBW = -140;
var itmClimate = 5;
var itmN0 = 301;
var itmPol = 1;
var itmEpsilon = 15;
var itmSigma = 0.008;
var itmMdvar = 12;
var itmTime = 50;
var itmLocation = 50;
var itmSituation = 50;
var txAntennaGainDbi = 0;
var rxAntennaGainDbi = 0;
var rxHeightM = DEFAULT_RX_HEIGHT_M;
var rxSensitivityDbW = DEFAULT_RX_SENSITIVITY_DBW;
var txPattern = null;
var txPatternHasOffsets = false;
var patternBearingDeg = 0;
var CULL_BLOCK_SHIFT = 2;  // 4x4 blocks: cellX >> 2, cellY >> 2
var ADAPTIVE_FILL_MARGIN_DB = 28;
var ADAPTIVE_FILL_ELEV_SPAN_M = 16;

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
var adaptiveCulling = false;
var fastFillEnabled = true;
var bitmapOffsetX = 0;
var bitmapOffsetY = 0;

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

function normalizeBearingDeg(deg) {
  deg = deg % 360;
  return deg < 0 ? deg + 360 : deg;
}

function bearingFromTx(lat, lng) {
  var toRad = Math.PI / 180;
  var toDeg = 180 / Math.PI;
  var dLng = (lng - txLng) * toRad;
  var lat1 = txLat * toRad;
  var lat2 = lat * toRad;
  var y = Math.sin(dLng) * Math.cos(lat2);
  var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeBearingDeg(Math.atan2(y, x) * toDeg);
}

function patternHasOffsets(pattern) {
  if (!pattern || pattern.length !== 360) return false;
  for (var i = 0; i < pattern.length; i++) {
    if (pattern[i] !== 0) return true;
  }
  return false;
}

var MAX_PROFILE_SAMPLES = 2048;

function freeSpacePathLossDb(distM, freqMHz) {
  var safeDistKm = Math.max(distM, 1) / 1000;
  return 32.45 + 20 * Math.log10(freqMHz) + 20 * Math.log10(safeDistKm);
}

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

function latToGlobalPixelY(lat) {
  var latRad = lat * Math.PI / 180;
  var n = Math.pow(2, zoom);
  var yFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return yFrac * TILE_SIZE;
}

function lngToGlobalPixelX(lng) {
  var n = Math.pow(2, zoom);
  return ((lng + 180) / 360) * n * TILE_SIZE;
}

function collectChunkTiles(cells, startIdx, endIdx) {
  // Find bbox of chunk cells for direct chunk-tile inclusion
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
    var startGX = lngToGlobalPixelX(txLng);
    var startGY = latToGlobalPixelY(txLat);
    var endGX = lngToGlobalPixelX(toLng);
    var endGY = latToGlobalPixelY(toLat);
    var deltaGX = endGX - startGX;
    var deltaGY = endGY - startGY;
    var stepPx = TILE_SIZE * 0.5;
    var nSteps = Math.max(2, Math.ceil(Math.max(Math.abs(deltaGX), Math.abs(deltaGY)) / stepPx));

    for (var i = 0; i <= nSteps; i++) {
      var frac = i / nSteps;
      var gpx = startGX + deltaGX * frac;
      var gpy = startGY + deltaGY * frac;
      addTile(zoom, Math.floor(gpx / TILE_SIZE), Math.floor(gpy / TILE_SIZE));
    }
  }

  // Trace rays from TX to every cell in the chunk
  for (var i = startIdx; i < endIdx; i++) {
    traceRayTiles(cells[i].lat, cells[i].lng);
  }

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

    var itmRef = self.ITM;

    jsComputeFn = function (profile, spacingM, txHeightM, rxHeightM, freqMHz, params) {
      var nSamples = profile.length;
      var N = nSamples - 1;
      params = params || {};

      var climate = params.climate === undefined ? 5 : params.climate;
      var n0 = params.n0 === undefined ? 301 : params.n0;
      var pol = params.pol === undefined ? 1 : params.pol;
      var epsilon = params.epsilon === undefined ? 15 : params.epsilon;
      var sigma = params.sigma === undefined ? 0.008 : params.sigma;
      var mdvar = params.mdvar === undefined ? 12 : params.mdvar;
      var time = params.time === undefined ? 50 : params.time;
      var location = params.location === undefined ? 50 : params.location;
      var situation = params.situation === undefined ? 50 : params.situation;

      // Build PFL array: [N, spacingM, elev0, ..., elevN]
      var pfl = new Array(nSamples + 2);
      pfl[0] = N;
      pfl[1] = spacingM;
      for (var i = 0; i < nSamples; i++) {
        pfl[2 + i] = profile[i];
      }

      var result = itmRef.ITM_P2P_TLS(
        txHeightM, rxHeightM, pfl,
        climate, n0, freqMHz,
        pol, epsilon, sigma,
        mdvar, time, location, situation
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
  txAntennaGainDbi = msg.txGainDbi === undefined ? 0 : msg.txGainDbi;
  rxAntennaGainDbi = msg.rxGainDbi === undefined ? 0 : msg.rxGainDbi;
  rxHeightM = msg.rxHeightM === undefined ? DEFAULT_RX_HEIGHT_M : msg.rxHeightM;
  rxSensitivityDbW = msg.rxSensitivityDbW === undefined ? DEFAULT_RX_SENSITIVITY_DBW : msg.rxSensitivityDbW;
  txPattern = msg.txPattern && msg.txPattern.length === 360 ? new Float32Array(msg.txPattern) : null;
  txPatternHasOffsets = patternHasOffsets(txPattern);
  patternBearingDeg = normalizeBearingDeg(msg.patternBearingDeg || 0);
  zoom = msg.zoom;
  mpp = msg.mpp;
  sliceId = msg.sliceId;
  adaptiveCulling = msg.adaptiveCulling || false;
  fastFillEnabled = msg.fastFillEnabled !== false;
  maskOriginGlobalX = msg.maskOriginGlobalX;
  maskOriginGlobalY = msg.maskOriginGlobalY;
  bitmapOffsetX = msg.bitmapOffsetX || 0;
  bitmapOffsetY = msg.bitmapOffsetY || 0;

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
        cellX: px + bitmapOffsetX,
        cellY: globalCellY + bitmapOffsetY,
        lat: globalPixelYToLat(maskOriginGlobalY + globalCellY + 0.5),
        lng: globalPixelXToLng(maskOriginGlobalX + px + 0.5)
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
  var txGainDbi = txAntennaGainDbi;
  var rxGainDbi = rxAntennaGainDbi;
  var sliceRxHeightM = rxHeightM;
  var sliceRxSensitivityDbW = rxSensitivityDbW;

  var evaluated = 0;
  // Binary batch buffer: Float32Array triples [fullBitmapX, fullBitmapY, band, ...]
  var batchBuf = new Float32Array(COVERAGE_BATCH_SIZE * 3);
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
    batchBuf = new Float32Array(COVERAGE_BATCH_SIZE * 3);
    batchCount = 0;
  }

  function emitCell(cell, band) {
    var distM = haversineDistance(txLat, txLng, cell.lat, cell.lng);
    if (distM > maxReachM) maxReachM = distM;

    if (band === 0) strongCount++;
    else if (band === 1) usableCount++;
    else marginalCount++;

    var bi = batchCount * 3;
    batchBuf[bi]     = cell.cellX;
    batchBuf[bi + 1] = cell.cellY;
    batchBuf[bi + 2] = band;
    batchCount++;

    if (batchCount >= COVERAGE_BATCH_SIZE) {
      flushBatch(evaluated / totalCells);
    }
  }

  function evaluateCell(cell) {
    var distM = haversineDistance(txLat, txLng, cell.lat, cell.lng);
    var effectiveTxGainDbi = txGainDbi;
    var itmParams = {
      climate: itmClimate,
      n0: itmN0,
      pol: itmPol,
      epsilon: itmEpsilon,
      sigma: itmSigma,
      mdvar: itmMdvar,
      time: itmTime,
      location: itmLocation,
      situation: itmSituation
    };

    if (txPatternHasOffsets) {
      var azimuthDeg = bearingFromTx(cell.lat, cell.lng);
      var patternIndex = normalizeBearingDeg(Math.round(azimuthDeg - patternBearingDeg));
      effectiveTxGainDbi += txPattern[patternIndex] || 0;
    }

    if (distM < mpp) {
      return txPowerDbW + effectiveTxGainDbi + rxGainDbi - freeSpacePathLossDb(distM, freqMHz) - sliceRxSensitivityDbW;
    }

    // ITM is validated for 20 MHz to 20 GHz. Below 20 MHz, keep the
    // analysis running with a free-space-only fallback instead of failing.
    if (freqMHz < 20) {
      return txPowerDbW + effectiveTxGainDbi + rxGainDbi - freeSpacePathLossDb(distM, freqMHz) - sliceRxSensitivityDbW;
    }

    var result = buildProfile(txLat, txLng, cell.lat, cell.lng);
    if (!result) return -Infinity;

    var pathLoss;
    try {
      var computeFn = activeEngine === 'js' ? jsComputeFn : self.computeITMPathLoss;
      pathLoss = computeFn(
        result.profile, result.spacingM, antennaHeight, sliceRxHeightM, freqMHz, itmParams
      );
    } catch (e) {
      return -Infinity;
    }

    return txPowerDbW + effectiveTxGainDbi + rxGainDbi - pathLoss - sliceRxSensitivityDbW;
  }

  // Sort cells into 64×64 spatial chunks for tile batching efficiency.
  var chunkMap = {};
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var ck = (c.cellX >> 6) + ',' + (c.cellY >> 6);
    if (!chunkMap[ck]) chunkMap[ck] = [];
    chunkMap[ck].push(c);
  }
  var chunkKeys = Object.keys(chunkMap).map(function (key) {
    var chunk = chunkMap[key];
    var sumLat = 0;
    var sumLng = 0;
    for (var ci = 0; ci < chunk.length; ci++) {
      sumLat += chunk[ci].lat;
      sumLng += chunk[ci].lng;
    }
    var centerLat = sumLat / chunk.length;
    var centerLng = sumLng / chunk.length;
    var angle = Math.atan2(centerLat - txLat, centerLng - txLng);
    return {
      key: key,
      dist: haversineDistance(txLat, txLng, centerLat, centerLng),
      angle: angle
    };
  }).sort(function (a, b) {
    if (a.dist !== b.dist) return a.dist - b.dist;
    return a.angle - b.angle;
  });
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

    var chunk = chunkMap[chunkKeys[chunkIndex].key];
    chunkIndex++;

    // Collect tiles needed for this chunk
    var neededTiles = collectChunkTiles(chunk, 0, chunk.length);

    requestTilesAndRun(neededTiles, function () {
      if (adaptiveCulling) {
        processChunkCoarseToFine(chunk);
      } else {
        processChunkStandard(chunk);
      }
      setTimeout(processNextChunk, 0);
    });
  }

  // ===== Standard 1:1 per-cell evaluation =====
  function processChunkStandard(chunk) {
    for (var ci = 0; ci < chunk.length; ci++) {
      var cell = chunk[ci];
      evaluated++;

      var margin = evaluateCell(cell);
      if (margin === -Infinity) continue;

      var band;
      if (margin > 20)      band = 0;
      else if (margin >= 5) band = 1;
      else if (margin >= 0) band = 2;
      else continue;

      emitCell(cell, band);
    }
  }

  // ===== Coarse-to-fine 2-pass evaluation =====
  function processChunkCoarseToFine(chunk) {
    // Sub-group cells into 4x4 blocks within this chunk
    var blockMap = {};
    for (var ci = 0; ci < chunk.length; ci++) {
      var cell = chunk[ci];
      var bk = (cell.cellX >> CULL_BLOCK_SHIFT) + ',' + (cell.cellY >> CULL_BLOCK_SHIFT);
      if (!blockMap[bk]) blockMap[bk] = [];
      blockMap[bk].push(cell);
    }

    var blockKeys = Object.keys(blockMap);
    for (var bi = 0; bi < blockKeys.length; bi++) {
      var block = blockMap[blockKeys[bi]];

      var scoutPlan = buildAdaptiveScoutPlan(block);
      var scoutMargins = [];
      var scoutBands = [];
      var allDead = true;
      var fillBand = -1;

      for (var si = 0; si < scoutPlan.scouts.length; si++) {
        var scoutCell = scoutPlan.scouts[si];
        evaluated++;

        var scoutMargin = evaluateCell(scoutCell);
        scoutMargins.push(scoutMargin);

        if (scoutMargin === -Infinity || scoutMargin < 0) continue;

        allDead = false;
        var scoutBand = marginToBand(scoutMargin);
        scoutBands.push(scoutBand);
        emitCell(scoutCell, scoutBand);
      }

      if (allDead) {
        evaluated += block.length - scoutPlan.scouts.length;
        continue;
      }

      if (
        fastFillEnabled &&
        scoutBands.length === scoutPlan.scouts.length &&
        scoutPlan.elevSpan <= ADAPTIVE_FILL_ELEV_SPAN_M &&
        minArrayValue(scoutMargins) >= ADAPTIVE_FILL_MARGIN_DB
      ) {
        fillBand = scoutBands[0];
      }

      for (var j = 0; j < block.length; j++) {
        var blockCell = block[j];
        if (blockCell._adaptiveScout) continue;

        if (fillBand !== -1) {
          evaluated++;
          emitCell(blockCell, fillBand);
          continue;
        }

        evaluated++;

        var margin = evaluateCell(blockCell);
        if (margin === -Infinity || margin < 0) continue;
        emitCell(blockCell, marginToBand(margin));
      }

      for (var ck = 0; ck < scoutPlan.scouts.length; ck++) {
        scoutPlan.scouts[ck]._adaptiveScout = false;
      }
    }
  }

  function buildAdaptiveScoutPlan(block) {
    var highestCell = block[0];
    var closestCell = block[0];
    var centerCell = block[Math.floor(block.length / 2)];
    var maxElev = -Infinity;
    var minElev = Infinity;
    var minDist = Infinity;

    for (var i = 0; i < block.length; i++) {
      var cell = block[i];
      if (cell.elev === undefined) cell.elev = getElevation(cell.lat, cell.lng);
      var elev = cell.elev;
      if (elev !== null) {
        if (elev > maxElev) {
          maxElev = elev;
          highestCell = cell;
        }
        if (elev < minElev) minElev = elev;
      }

      if (cell.distM === undefined) cell.distM = haversineDistance(txLat, txLng, cell.lat, cell.lng);
      if (cell.distM < minDist) {
        minDist = cell.distM;
        closestCell = cell;
      }
    }

    var scouts = [];
    var scoutSeen = new Set();
    addAdaptiveScout(scouts, scoutSeen, closestCell);
    addAdaptiveScout(scouts, scoutSeen, centerCell);
    addAdaptiveScout(scouts, scoutSeen, highestCell);

    return {
      scouts: scouts,
      elevSpan: (maxElev === -Infinity || minElev === Infinity) ? Infinity : maxElev - minElev
    };
  }

  function addAdaptiveScout(list, seen, cell) {
    if (!cell) return;
    var key = cell.cellX + ',' + cell.cellY;
    if (seen.has(key)) return;
    seen.add(key);
    cell._adaptiveScout = true;
    list.push(cell);
  }

  function marginToBand(margin) {
    if (margin > 20) return 0;
    if (margin >= 5) return 1;
    return 2;
  }

  function minArrayValue(values) {
    var min = Infinity;
    for (var i = 0; i < values.length; i++) {
      if (values[i] < min) min = values[i];
    }
    return min;
  }

  processNextChunk();
}
