// ===== Radio Propagation Worker (Orchestrator) =====
// Phase 1: Geometric LOS pre-filter (silent — no rendering)
// Phase 2: Evaluation mask with dilation buffer
// Phase 3: Partitions mask cells into angular slices and delegates
//          to propagation workers spawned by the main thread
importScripts('terrain-tiles.js');

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
        // Emit coverage bounds for bitmap layer
        self.postMessage({
          type: 'coverageBounds',
          minLat: globalPixelYToLat(maskOriginGlobalY + mh),
          maxLat: globalPixelYToLat(maskOriginGlobalY),
          minLng: globalPixelXToLng(maskOriginGlobalX),
          maxLng: globalPixelXToLng(maskOriginGlobalX + mw),
          widthPx: mw,
          heightPx: mh
        });
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

function freeSpaceMaxDistanceM(txPowerW, freqMHz) {
  var marginDb = 10 * Math.log10(txPowerW) + 140;
  var dKm = Math.pow(10, (marginDb - 32.45 - 20 * Math.log10(freqMHz)) / 20);
  return dKm * 1000;
}

function runPhase2(points, callback) {
  // 0. Compute free-space clamp radius
  var fsMaxM = freeSpaceMaxDistanceM(txPowerW, freqMHz);
  var wasClamped = fsMaxM < radiusM;
  var clampRadiusM = Math.min(radiusM, fsMaxM);

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

  // 2b. Shrink bbox to clamp circle if free-space max is smaller than user radius
  if (wasClamped) {
    var txGX = lngToGlobalPixelX(txLng);
    var txGY = latToGlobalPixelY(txLat);
    var clampPx = Math.ceil(clampRadiusM / mpp) + bufferPx;
    minGX = Math.max(minGX, Math.floor(txGX) - clampPx);
    maxGX = Math.min(maxGX, Math.ceil(txGX) + clampPx);
    minGY = Math.max(minGY, Math.floor(txGY) - clampPx);
    maxGY = Math.min(maxGY, Math.ceil(txGY) + clampPx);
  }

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

  // 6. Clip to clamped radius circle
  var totalCells = 0;
  for (var py = 0; py < maskH; py++) {
    for (var px = 0; px < maskW; px++) {
      if (!mask[py * maskW + px]) continue;
      var cellLat = globalPixelYToLat(maskOriginGlobalY + py);
      var cellLng = globalPixelXToLng(maskOriginGlobalX + px);
      var dist = haversineDistance(txLat, txLng, cellLat, cellLng);
      if (dist > clampRadiusM) {
        mask[py * maskW + px] = 0;
      } else {
        totalCells++;
      }
    }
  }

  var phase2Msg = { type: 'phase2Done', totalCells: totalCells };
  if (wasClamped) {
    phase2Msg.clampedRadiusKm = clampRadiusM / 1000;
    phase2Msg.wasClamped = true;
  }
  self.postMessage(phase2Msg);
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

// ===== Phase 3: Partition mask cells and delegate to propagation workers =====
// Instead of evaluating ITM here, we collect all 1-cells from the mask,
// partition them by angular slice around the TX, and send them to the main
// thread which spawns dedicated propagation workers.

var SLICE_COUNT = 4;  // angular partitions (0-90°, 90-180°, 180-270°, 270-360°)

function runPhase3(mask, mw, mh, totalCells) {
  // Compute TX position in mask pixel space
  var txPxX = lngToGlobalPixelX(txLng) - maskOriginGlobalX;
  var txPxY = latToGlobalPixelY(txLat) - maskOriginGlobalY;

  // Collect all 1-cells and assign to angular slices
  var slices = [];
  for (var s = 0; s < SLICE_COUNT; s++) slices.push([]);

  var sliceAngle = (2 * Math.PI) / SLICE_COUNT;

  for (var py = 0; py < mh; py++) {
    for (var px = 0; px < mw; px++) {
      if (!mask[py * mw + px]) continue;

      var dx = px - txPxX;
      var dy = py - txPxY;
      var angle = Math.atan2(dy, dx); // -PI to PI
      if (angle < 0) angle += 2 * Math.PI; // 0 to 2PI

      var sliceIdx = Math.floor(angle / sliceAngle);
      if (sliceIdx >= SLICE_COUNT) sliceIdx = SLICE_COUNT - 1;

      slices[sliceIdx].push({
        cellX: px,
        cellY: py,
        lat: globalPixelYToLat(maskOriginGlobalY + py),
        lng: globalPixelXToLng(maskOriginGlobalX + px)
      });
    }
  }

  self.postMessage({
    type: 'phase3Partition',
    slices: slices,
    totalCells: totalCells,
    txParams: {
      txLat: txLat,
      txLng: txLng,
      txElevation: txElevation,
      antennaHeight: antennaHeight,
      freqMHz: freqMHz,
      txPowerW: txPowerW,
      zoom: zoom,
      mpp: mpp
    },
    tilesUsed: tilesUsed
  });
}
