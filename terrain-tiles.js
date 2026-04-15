(function (root) {
  'use strict';

  var EARTH_RADIUS = 6378137; // meters
  var TILE_SIZE = 256;
  var TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
  var tileCache = new Map();

  function lngToTileX(lng, zoom) {
    return Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  }

  function latToTileY(lat, zoom) {
    var latRad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
        Math.pow(2, zoom)
    );
  }

  function tileToLng(x, zoom) {
    return (x / Math.pow(2, zoom)) * 360 - 180;
  }

  function tileToLat(y, zoom) {
    var n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function metersPerPixel(lat, zoom) {
    return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_RADIUS) / (TILE_SIZE * Math.pow(2, zoom));
  }

  function decodeTerrarium(imageData) {
    var width = imageData.width || TILE_SIZE;
    var height = imageData.height || TILE_SIZE;
    var pixels = imageData.data;
    var elevations = new Float32Array(width * height);

    for (var i = 0; i < width * height; i++) {
      var r = pixels[i * 4];
      var g = pixels[i * 4 + 1];
      var b = pixels[i * 4 + 2];
      elevations[i] = r * 256 + g + b / 256 - 32768;
    }

    return elevations;
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function getImageData(url) {
    if (typeof document !== 'undefined') {
      return loadImage(url).then(function (img) {
        var canvas = document.createElement('canvas');
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
      });
    }

    if (typeof OffscreenCanvas !== 'undefined' && typeof fetch === 'function' && typeof createImageBitmap === 'function') {
      return fetch(url)
        .then(function (response) {
          if (!response.ok) {
            throw new Error('Failed to fetch terrain tile: ' + response.status);
          }
          return response.blob();
        })
        .then(function (blob) {
          return createImageBitmap(blob);
        })
        .then(function (bitmap) {
          var canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
          var ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(bitmap, 0, 0);
          if (typeof bitmap.close === 'function') bitmap.close();
          return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
        });
    }

    return Promise.reject(new Error('No terrain tile decoder available in this environment.'));
  }

  function getTileEntry(zoom, x, y) {
    var key = zoom + '/' + x + '/' + y;
    if (tileCache.has(key)) {
      return {
        key: key,
        promise: tileCache.get(key),
        fromCache: true,
      };
    }

    var promise = getImageData(TERRAIN_URL + '/' + key + '.png')
      .then(function (imageData) {
        return decodeTerrarium(imageData);
      })
      .catch(function (err) {
        tileCache.delete(key);
        throw err;
      });

    tileCache.set(key, promise);
    return {
      key: key,
      promise: promise,
      fromCache: false,
    };
  }

  function getTile(zoom, x, y) {
    return getTileEntry(zoom, x, y).promise;
  }

  function getTileWithMetadata(zoom, x, y) {
    var entry = getTileEntry(zoom, x, y);
    return entry.promise.then(function (data) {
      return {
        key: entry.key,
        data: data,
        fromCache: entry.fromCache,
      };
    });
  }

  root.TerrainTiles = {
    TILE_SIZE: TILE_SIZE,
    TERRAIN_URL: TERRAIN_URL,
    decodeTerrarium: decodeTerrarium,
    getTile: getTile,
    getTileWithMetadata: getTileWithMetadata,
    lngToTileX: lngToTileX,
    latToTileY: latToTileY,
    tileToLng: tileToLng,
    tileToLat: tileToLat,
    metersPerPixel: metersPerPixel,
  };
})(typeof self !== 'undefined' ? self : window);
