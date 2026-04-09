// ===== Viewshed Analysis WebWorker =====
// Radio line-of-sight coverage computation.
// Requests tiles on demand from the main thread.
importScripts('terrain-tiles.js');

var TILE_SIZE = self.TerrainTiles.TILE_SIZE;
var EARTH_RADIUS = 6378137; // meters
var K_REFRACTION = 4 / 3; // standard atmospheric refraction
var metersPerPixel = self.TerrainTiles.metersPerPixel;
var lngToTileX = self.TerrainTiles.lngToTileX;
var latToTileY = self.TerrainTiles.latToTileY;
var tileToLng = self.TerrainTiles.tileToLng;
var tileToLat = self.TerrainTiles.tileToLat;

var RAY_COUNT = 360;
var BATCH_SIZE = 30; // emit rayBatch every N completed rays
var MAX_TILES = 500; // soft safety limit

// Tile store: Map keyed by "z/x/y" → Float32Array
var tileStore = new Map();
var tilesUsed = 0;
var zoom = 12;
var mpp = 0;
var txLat = 0;
var txLng = 0;
var txElevation = 0;
var antennaHeight = 10;
var radiusM = 30000;

// Pending tile resolution
var pendingTileResolve = null;

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'start') {
    handleStart(msg);
  } else if (msg.type === 'tiles') {
    handleTiles(msg.tiles);
  }
};

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

  // Pixel within tile
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

// Compute destination lat/lng given start, bearing (deg), and distance (m)
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

function handleStart(msg) {
  txLat = msg.lat;
  txLng = msg.lng;
  antennaHeight = msg.antennaHeight;
  radiusM = msg.radiusKm * 1000;
  zoom = msg.zoom;
  mpp = metersPerPixel(txLat, zoom);
  tileStore.clear();
  tilesUsed = 0;

  // Step size = 1 pixel at analysis zoom
  var stepM = mpp;
  var maxSteps = Math.ceil(radiusM / stepM);

  // Pre-compute ray azimuths and step points
  // We'll process all 360 rays, requesting tiles as needed

  // First, request the tile for the transmitter
  var txTile = getTileCoord(txLat, txLng);
  var needed = [txTile];
  requestTilesAndRun(needed, function () {
    txElevation = getElevation(txLat, txLng);
    if (txElevation === null) txElevation = 0;

    // Process all rays in batches, requesting tiles as needed
    processRays(stepM, maxSteps);
  });
}

function requestTilesAndRun(neededTiles, callback) {
  // Filter out already-loaded tiles
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

function processRays(stepM, maxSteps) {
  var rays = [];
  for (var a = 0; a < RAY_COUNT; a++) {
    rays.push({
      azimuth: a,
      step: 0,
      blocked: false,
      points: []
    });
  }

  var completedRays = 0;
  var batchPoints = [];

  function processBatch() {
    var neededTiles = [];
    var neededSet = {};
    var batchCompleted = [];
    var needsTiles = false;

    for (var i = 0; i < rays.length; i++) {
      var ray = rays[i];
      if (ray.blocked || ray.step >= maxSteps) {
        if (!ray.done) {
          ray.done = true;
          completedRays++;
          batchCompleted.push({
            azimuth: ray.azimuth,
            reachablePoints: ray.points
          });
        }
        continue;
      }

      // Walk this ray forward
      var stepsThisBatch = 0;
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
          // Back up one step so we re-process this point after tiles arrive
          ray.step--;
          needsTiles = true;
          break;
        }

        var terrainElev = getElevation(pt.lat, pt.lng);
        if (terrainElev === null) {
          ray.blocked = true;
          break;
        }

        // Line-of-sight: ray altitude at distance d
        // rayAlt = txElevation + antennaHeight - (d² / (2 × k × R))
        var earthCurve = (distM * distM) / (2 * K_REFRACTION * EARTH_RADIUS);
        var rayAlt = txElevation + antennaHeight - earthCurve;

        if (terrainElev > rayAlt) {
          // Terrain blocks the ray
          ray.blocked = true;
          ray.points.push({ lat: pt.lat, lng: pt.lng, visible: false });
          break;
        }

        ray.points.push({ lat: pt.lat, lng: pt.lng, visible: true });
      }

      // If ray just completed without needing tiles
      if (!needsTiles && (ray.blocked || ray.step >= maxSteps) && !ray.done) {
        ray.done = true;
        completedRays++;
        batchCompleted.push({
          azimuth: ray.azimuth,
          reachablePoints: ray.points
        });
      }
    }

    // Emit batch of completed rays
    if (batchCompleted.length > 0) {
      self.postMessage({
        type: 'rayBatch',
        rays: batchCompleted,
        progress: completedRays / RAY_COUNT
      });
    }

    // Check if all rays are done
    if (completedRays >= RAY_COUNT) {
      self.postMessage({
        type: 'done',
        stats: { tilesUsed: tilesUsed, raysTotal: RAY_COUNT, raysCompleted: completedRays }
      });
      return;
    }

    // If we need tiles, request them and continue
    if (neededTiles.length > 0) {
      self.postMessage({
        type: 'rayBatch',
        rays: batchCompleted.length > 0 ? [] : [],
        progress: completedRays / RAY_COUNT
      });
      requestTilesAndRun(neededTiles, processBatch);
    } else {
      // All rays either done or still walking — keep going
      // Use setTimeout to avoid blocking
      setTimeout(processBatch, 0);
    }
  }

  processBatch();
}
