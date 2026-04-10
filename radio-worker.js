// ===== Radio Propagation Worker (3-Phase ITM Pipeline) =====
// Phase 1: Geometric LOS pre-filter (silent — no rendering)
// Phase 2: Evaluation mask with dilation buffer
// Phase 3: Longley-Rice ITM path loss on mask cells
importScripts('terrain-tiles.js');
importScripts('vendor/itm/itm.js');
importScripts('vendor/itm/itm-wrapper.js');

var TILE_SIZE = self.TerrainTiles.TILE_SIZE;       // 256
var EARTH_RADIUS = 6378137;
var K_REFRACTION = 4 / 3;
var metersPerPixel = self.TerrainTiles.metersPerPixel;
var lngToTileX = self.TerrainTiles.lngToTileX;
var latToTileY = self.TerrainTiles.latToTileY;
var tileToLng = self.TerrainTiles.tileToLng;
var tileToLat = self.TerrainTiles.tileToLat;

var RAY_COUNT = 360;
var MAX_TILES = 2000;
var LOS_BLOCK_MARGIN = 200;     // meters: Phase 1 only blocks if terrain exceeds LOS by this much
var BUFFER_KM = 4;              // dilation radius for Phase 2 mask
var CHUNK_SIZE = 64;            // spatial chunk dimension for Phase 3 tile batching
var COVERAGE_BATCH_SIZE = 500;  // emit coverageBatch every N evaluated cells
var RX_HEIGHT_M = 2;            // receiver antenna height (handheld)
var RX_SENSITIVITY_DBW = -140;  // receiver sensitivity in dBW (≈ -110 dBm)

// ===== Tile store =====
var tileStore = new Map();
var tilesUsed = 0;

// ===== Analysis parameters (set by handleStart) =====
var zoom = 12;
var mpp = 0;
var txLat = 0;
var txLng = 0;
var txElevation = 0;
var antennaHeight = 10;
var radiusM = 30000;
var freqMHz = 144;
var txPowerW = 5;

// Pending tile resolution
var pendingTileResolve = null;

// ===== Message handler =====
self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'start') {
    handleStart(msg);
  } else if (msg.type === 'tiles') {
    handleTiles(msg.tiles);
  }
};

// ===== Tile management (ported verbatim from viewshed-worker.js) =====

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

function hasTile(lat, lng) {
  var tc = getTileCoord(lat, lng);
  return tileStore.has(tc.z + '/' + tc.x + '/' + tc.y);
}

function destinationPoint(lat, lng, bearingDeg, distM) {
  var toRad = Math.PI / 180;
  var toDeg = 180 / Math.PI;
  var angDist = distM / EARTH_RADIUS;
  var brng = bearingDeg * toRad;
  var lat1 = lat * toRad;
  var lng1 = lng * toRad;

  var lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng)
  );
  var lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
  );

  return { lat: lat2 * toDeg, lng: lng2 * toDeg };
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
    self.postMessage({ type: 'error', message: 'TILE_LIMIT', count: tilesUsed });
    return;
  }

  pendingTileResolve = callback;
  self.postMessage({ type: 'needTiles', tiles: toFetch });
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

// ===== Mercator helpers for mask ↔ geo conversion =====

// Global pixel at analysis zoom → lat/lng
var maskOriginGlobalX = 0;
var maskOriginGlobalY = 0;
var maskW = 0;
var maskH = 0;

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

// ===== Entry point =====

function handleStart(msg) {
  txLat = msg.lat;
  txLng = msg.lng;
  antennaHeight = msg.antennaHeight;
  radiusM = msg.radiusKm * 1000;
  zoom = msg.zoom;
  mpp = metersPerPixel(txLat, zoom);
  freqMHz = msg.freqMHz;
  txPowerW = msg.txPowerW;
  tileStore.clear();
  tilesUsed = 0;

  var txTile = getTileCoord(txLat, txLng);
  requestTilesAndRun([txTile], function () {
    txElevation = getElevation(txLat, txLng);
    if (txElevation === null) txElevation = 0;

    runPhase1(function (points) {
      if (points.length === 0) {
        self.postMessage({ type: 'done', stats: {
          tilesUsed: tilesUsed, cellsEvaluated: 0,
          strongCount: 0, usableCount: 0, marginalCount: 0, maxReachM: 0
        }});
        return;
      }
      runPhase2(points, function (mask, mw, mh, totalCells) {
        runPhase3(mask, mw, mh, totalCells);
      });
    });
  });
}

// ===== Phase 1: Geometric LOS pre-filter =====
// Identical to the original ray-caster but:
//  - Blocking requires terrain > rayAlt + LOS_BLOCK_MARGIN (200m)
//  - No rayBatch messages — results accumulated silently
//  - Reachable points stored as flat [lat, lng] pairs

function runPhase1(callback) {
  var stepM = mpp;
  var maxSteps = Math.ceil(radiusM / stepM);

  var rays = [];
  for (var a = 0; a < RAY_COUNT; a++) {
    rays.push({ azimuth: a, step: 0, blocked: false, done: false });
  }

  var completedRays = 0;
  var reachablePoints = []; // [{lat, lng}, ...]

  function processBatch() {
    var neededTiles = [];
    var neededSet = {};

    for (var i = 0; i < rays.length; i++) {
      var ray = rays[i];
      if (ray.done) continue;
      if (ray.blocked || ray.step >= maxSteps) {
        ray.done = true;
        completedRays++;
        continue;
      }

      var stepsThisBatch = 0;
      var rayNeedsTile = false;
      while (ray.step < maxSteps && !ray.blocked && stepsThisBatch < 200) {
        ray.step++;
        stepsThisBatch++;
        var distM = ray.step * stepM;
        var pt = destinationPoint(txLat, txLng, ray.azimuth, distM);

        if (!hasTile(pt.lat, pt.lng)) {
          var tc = getTileCoord(pt.lat, pt.lng);
          var key = tc.z + '/' + tc.x + '/' + tc.y;
          if (!neededSet[key]) {
            neededSet[key] = true;
            neededTiles.push(tc);
          }
          ray.step--;
          rayNeedsTile = true;
          break;
        }

        var terrainElev = getElevation(pt.lat, pt.lng);
        if (terrainElev === null) {
          ray.blocked = true;
          break;
        }

        var earthCurve = (distM * distM) / (2 * K_REFRACTION * EARTH_RADIUS);
        var rayAlt = txElevation + antennaHeight - earthCurve;

        // Relaxed blocking: only stop if terrain exceeds LOS by >200m
        if (terrainElev > rayAlt + LOS_BLOCK_MARGIN) {
          ray.blocked = true;
          break;
        }

        reachablePoints.push({ lat: pt.lat, lng: pt.lng });
      }

      if (!rayNeedsTile && (ray.blocked || ray.step >= maxSteps) && !ray.done) {
        ray.done = true;
        completedRays++;
      }
    }

    if (completedRays >= RAY_COUNT) {
      self.postMessage({ type: 'phase1Done', count: reachablePoints.length });
      callback(reachablePoints);
      return;
    }

    if (neededTiles.length > 0) {
      requestTilesAndRun(neededTiles, processBatch);
    } else {
      setTimeout(processBatch, 0);
    }
  }

  processBatch();
}

// ===== Phase 2: Build evaluation mask =====

function runPhase2(points, callback) {
  // 1. Compute bounding box of reachable points in global pixel coords
  var minGX = Infinity, maxGX = -Infinity;
  var minGY = Infinity, maxGY = -Infinity;

  for (var i = 0; i < points.length; i++) {
    var gx = lngToGlobalPixelX(points[i].lng);
    var gy = latToGlobalPixelY(points[i].lat);
    if (gx < minGX) minGX = gx;
    if (gx > maxGX) maxGX = gx;
    if (gy < minGY) minGY = gy;
    if (gy > maxGY) maxGY = gy;
  }

  // 2. Add buffer (4 km → pixels)
  var bufferPx = Math.ceil((BUFFER_KM * 1000) / mpp);
  minGX = Math.floor(minGX) - bufferPx;
  maxGX = Math.ceil(maxGX) + bufferPx;
  minGY = Math.floor(minGY) - bufferPx;
  maxGY = Math.ceil(maxGY) + bufferPx;

  maskOriginGlobalX = minGX;
  maskOriginGlobalY = minGY;
  maskW = maxGX - minGX + 1;
  maskH = maxGY - minGY + 1;

  // 3. Allocate mask
  var mask = new Uint8Array(maskW * maskH);

  // 4. Project reachable points into mask
  for (var i = 0; i < points.length; i++) {
    var gx = Math.round(lngToGlobalPixelX(points[i].lng)) - maskOriginGlobalX;
    var gy = Math.round(latToGlobalPixelY(points[i].lat)) - maskOriginGlobalY;
    if (gx >= 0 && gx < maskW && gy >= 0 && gy < maskH) {
      mask[gy * maskW + gx] = 1;
    }
  }

  // 5. Dilate mask using separable sliding-window box dilation
  dilateMask(mask, maskW, maskH, bufferPx);

  // 6. Clip to radius circle
  var totalCells = 0;
  for (var py = 0; py < maskH; py++) {
    for (var px = 0; px < maskW; px++) {
      if (!mask[py * maskW + px]) continue;
      var cellLat = globalPixelYToLat(maskOriginGlobalY + py);
      var cellLng = globalPixelXToLng(maskOriginGlobalX + px);
      var dist = haversineDistance(txLat, txLng, cellLat, cellLng);
      if (dist > radiusM) {
        mask[py * maskW + px] = 0;
      } else {
        totalCells++;
      }
    }
  }

  self.postMessage({ type: 'phase2Done', totalCells: totalCells });
  callback(mask, maskW, maskH, totalCells);
}

function dilateMask(mask, w, h, radius) {
  // Horizontal pass
  var temp = new Uint8Array(w * h);
  for (var y = 0; y < h; y++) {
    var count = 0;
    // Initialize window [0, radius]
    for (var x = 0; x <= radius && x < w; x++) {
      if (mask[y * w + x]) count++;
    }
    for (var x = 0; x < w; x++) {
      if (count > 0) temp[y * w + x] = 1;
      // Add right edge
      var addX = x + radius + 1;
      if (addX < w && mask[y * w + addX]) count++;
      // Remove left edge
      var removeX = x - radius;
      if (removeX >= 0 && mask[y * w + removeX]) count--;
    }
  }
  // Vertical pass: temp → mask
  for (var x = 0; x < w; x++) {
    var count = 0;
    for (var y = 0; y <= radius && y < h; y++) {
      if (temp[y * w + x]) count++;
    }
    for (var y = 0; y < h; y++) {
      mask[y * w + x] = count > 0 ? 1 : 0;
      var addY = y + radius + 1;
      if (addY < h && temp[addY * w + x]) count++;
      var removeY = y - radius;
      if (removeY >= 0 && temp[removeY * w + x]) count--;
    }
  }
}

// ===== Phase 3: Longley-Rice ITM on mask cells =====

function runPhase3(mask, mw, mh, totalCells) {
  var txPowerDbW = 10 * Math.log10(txPowerW);
  var txGainDbi = 0;
  var rxGainDbi = 0;

  var evaluated = 0;
  var batchCells = [];
  var strongCount = 0, usableCount = 0, marginalCount = 0;
  var maxReachM = 0;

  var chunksX = Math.ceil(mw / CHUNK_SIZE);
  var chunksY = Math.ceil(mh / CHUNK_SIZE);
  var totalChunks = chunksX * chunksY;
  var chunkIndex = 0;

  function processNextChunk() {
    if (chunkIndex >= totalChunks) {
      // Flush remaining batch
      if (batchCells.length > 0) {
        self.postMessage({
          type: 'coverageBatch', cells: batchCells,
          progress: 1.0, evaluated: evaluated
        });
      }
      self.postMessage({ type: 'done', stats: {
        tilesUsed: tilesUsed,
        cellsEvaluated: evaluated,
        strongCount: strongCount,
        usableCount: usableCount,
        marginalCount: marginalCount,
        maxReachM: maxReachM
      }});
      return;
    }

    var cx = chunkIndex % chunksX;
    var cy = Math.floor(chunkIndex / chunksX);
    chunkIndex++;

    // Check if chunk has any set cells
    var x0 = cx * CHUNK_SIZE;
    var y0 = cy * CHUNK_SIZE;
    var x1 = Math.min(x0 + CHUNK_SIZE, mw);
    var y1 = Math.min(y0 + CHUNK_SIZE, mh);

    var hasAnyCells = false;
    for (var py = y0; py < y1 && !hasAnyCells; py++) {
      for (var px = x0; px < x1 && !hasAnyCells; px++) {
        if (mask[py * mw + px]) hasAnyCells = true;
      }
    }
    if (!hasAnyCells) {
      setTimeout(processNextChunk, 0);
      return;
    }

    // Collect tiles needed: bbox of (TX, chunk corners)
    var neededTiles = collectChunkTiles(x0, y0, x1, y1);

    requestTilesAndRun(neededTiles, function () {
      evaluateChunk(mask, mw, x0, y0, x1, y1,
        txPowerDbW, txGainDbi, rxGainDbi);
      setTimeout(processNextChunk, 0);
    });
  }

  function evaluateChunk(mask, mw, x0, y0, x1, y1,
                         txPowerDbW, txGainDbi, rxGainDbi) {
    for (var py = y0; py < y1; py++) {
      for (var px = x0; px < x1; px++) {
        if (!mask[py * mw + px]) continue;

        var cellLat = globalPixelYToLat(maskOriginGlobalY + py);
        var cellLng = globalPixelXToLng(maskOriginGlobalX + px);

        // Build elevation profile TX → cell
        var profile = buildProfile(txLat, txLng, cellLat, cellLng);
        if (!profile) continue;

        // Call ITM
        var pathLoss;
        try {
          pathLoss = self.computeITMPathLoss(
            profile, mpp, antennaHeight, RX_HEIGHT_M, freqMHz
          );
        } catch (e) {
          continue;
        }

        // Signal margin
        var margin = txPowerDbW + txGainDbi + rxGainDbi - pathLoss - RX_SENSITIVITY_DBW;

        var band;
        if (margin > 20)      { band = 0; strongCount++; }
        else if (margin >= 5) { band = 1; usableCount++; }
        else if (margin >= 0) { band = 2; marginalCount++; }
        else continue; // unreachable

        var distM = haversineDistance(txLat, txLng, cellLat, cellLng);
        if (distM > maxReachM) maxReachM = distM;

        evaluated++;
        batchCells.push({ lat: cellLat, lng: cellLng, band: band });

        if (batchCells.length >= COVERAGE_BATCH_SIZE) {
          self.postMessage({
            type: 'coverageBatch', cells: batchCells,
            progress: evaluated / totalCells, evaluated: evaluated
          });
          batchCells = [];
        }
      }
    }
  }

  processNextChunk();
}

function collectChunkTiles(x0, y0, x1, y1) {
  // Convert chunk corners to lat/lng
  var tlLat = globalPixelYToLat(maskOriginGlobalY + y0);
  var tlLng = globalPixelXToLng(maskOriginGlobalX + x0);
  var brLat = globalPixelYToLat(maskOriginGlobalY + y1);
  var brLng = globalPixelXToLng(maskOriginGlobalX + x1);

  // Bounding box including TX
  var minLat = Math.min(txLat, tlLat, brLat);
  var maxLat = Math.max(txLat, tlLat, brLat);
  var minLng = Math.min(txLng, tlLng, brLng);
  var maxLng = Math.max(txLng, tlLng, brLng);

  var txMin = lngToTileX(minLng, zoom);
  var txMax = lngToTileX(maxLng, zoom);
  var tyMin = latToTileY(maxLat, zoom); // maxLat → smaller tile Y
  var tyMax = latToTileY(minLat, zoom);

  var tiles = [];
  for (var ty = tyMin; ty <= tyMax; ty++) {
    for (var tx = txMin; tx <= txMax; tx++) {
      tiles.push({ z: zoom, x: tx, y: ty });
    }
  }
  return tiles;
}

function buildProfile(lat1, lng1, lat2, lng2) {
  var distM = haversineDistance(lat1, lng1, lat2, lng2);
  if (distM < mpp) return null; // too close

  var nSamples = Math.max(2, Math.round(distM / mpp));
  var profile = new Float32Array(nSamples);

  for (var i = 0; i < nSamples; i++) {
    var frac = i / (nSamples - 1);
    var lat = lat1 + (lat2 - lat1) * frac;
    var lng = lng1 + (lng2 - lng1) * frac;
    var elev = getElevation(lat, lng);
    if (elev === null) return null;
    profile[i] = elev;
  }

  return profile;
}
