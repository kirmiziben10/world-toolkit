// ===== Terrain Analysis WebWorker =====
// Runs entirely off the main thread for smooth UI

const EARTH_RADIUS = 6378137; // meters
const TILE_SIZE = 256;
const SUBSAMPLE = 3; // Check every Nth pixel for viewpoint candidates
const PEAK_WINDOW_PX = 9; // Half-window for peak detection (pixels)
const PROFILE_SAMPLES = 30; // Points to sample along view-to-peak line
const CLUSTER_DISTANCE_M = 400; // Min distance between results (meters)
const MAX_RESULTS = 150;

// ===== Message Handler =====
self.onmessage = function (e) {
  try {
    const { elevations: buffer, width, height, tileXMin, tileYMin, zoom, params } = e.data;
    const elevations = new Float32Array(buffer);

    const tileInfo = { tileXMin, tileYMin, zoom, width, height };

    // Compute meters per pixel at center of grid
    const centerY = height / 2;
    const centerLat = pixelToLat(centerY, tileInfo);
    const mpp = metersPerPixel(centerLat, zoom);

    progress('Computing slope map...', 5);
    const slopes = computeSlope(elevations, width, height, mpp);

    progress('Finding mountain peaks...', 20);
    const peaks = findPeaks(elevations, slopes, width, height, mpp, params.minProminence);
    progress(`Found ${peaks.length} peaks`, 35, `Prominence ≥ ${params.minProminence}m`);

    progress('Searching for scenic viewpoints...', 40);
    const viewpoints = findViewpoints(elevations, slopes, peaks, width, height, mpp, tileInfo, params);
    progress(`Found ${viewpoints.length} candidates`, 70);

    progress('Clustering nearby results...', 75);
    const clustered = clusterResults(viewpoints, CLUSTER_DISTANCE_M, mpp);

    // Convert pixel coords to lat/lng and compute bearing
    const results = clustered.slice(0, MAX_RESULTS).map((vp) => {
      const lat = pixelToLat(vp.py, tileInfo);
      const lng = pixelToLng(vp.px, tileInfo);
      const peakLat = pixelToLat(vp.peakPy, tileInfo);
      const peakLng = pixelToLng(vp.peakPx, tileInfo);
      const viewBearing = computeBearing(lat, lng, peakLat, peakLng);
      return {
        lat,
        lng,
        elevation: vp.elevation,
        slope: vp.slope,
        peakElevation: vp.peakElevation,
        peakDistance: vp.peakDistanceM,
        peakProminence: vp.peakProminence,
        valleyDepth: vp.valleyDepth,
        score: vp.score,
        peakLat,
        peakLng,
        viewBearing,
      };
    });

    progress('Done!', 100, `${results.length} viewpoints found`);
    self.postMessage({ type: 'result', viewpoints: results });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};

// ===== Progress Reporting =====
function progress(text, percent, detail) {
  self.postMessage({ type: 'progress', text, percent, detail: detail || '' });
}

// ===== Coordinate Conversions =====
function pixelToLng(px, info) {
  const tileXFrac = info.tileXMin + px / TILE_SIZE;
  const n = Math.pow(2, info.zoom);
  return (tileXFrac / n) * 360 - 180;
}

function pixelToLat(py, info) {
  const tileYFrac = info.tileYMin + py / TILE_SIZE;
  const n = Math.pow(2, info.zoom);
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileYFrac) / n)));
  return (latRad * 180) / Math.PI;
}

function metersPerPixel(lat, zoom) {
  return (Math.cos((lat * Math.PI) / 180) * 2 * Math.PI * EARTH_RADIUS) / (TILE_SIZE * Math.pow(2, zoom));
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== Bearing Computation =====
function computeBearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ===== Slope Computation (Horn's method / Sobel) =====
function computeSlope(elev, w, h, cellSize) {
  const slope = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;

      // 3x3 Sobel kernel
      const a = elev[(y - 1) * w + (x - 1)];
      const b = elev[(y - 1) * w + x];
      const c = elev[(y - 1) * w + (x + 1)];
      const d = elev[y * w + (x - 1)];
      const f = elev[y * w + (x + 1)];
      const g = elev[(y + 1) * w + (x - 1)];
      const hh = elev[(y + 1) * w + x];
      const ii = elev[(y + 1) * w + (x + 1)];

      const dzdx = (c + 2 * f + ii - a - 2 * d - g) / (8 * cellSize);
      const dzdy = (g + 2 * hh + ii - a - 2 * b - c) / (8 * cellSize);

      slope[idx] = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * (180 / Math.PI);
    }
  }

  return slope;
}

// ===== Peak Detection =====
function findPeaks(elev, slopes, w, h, mpp, minProminence) {
  const peaks = [];
  const windowR = PEAK_WINDOW_PX;
  const promRadius = Math.max(windowR * 2, 20); // Larger radius for prominence calc

  for (let y = windowR; y < h - windowR; y += 2) {
    for (let x = windowR; x < w - windowR; x += 2) {
      const idx = y * w + x;
      const e = elev[idx];

      // Skip low points, ocean, or very steep spots
      if (e < 100 || slopes[idx] > 60) continue;

      // Check if local maximum in window
      let isMax = true;
      for (let dy = -windowR; dy <= windowR && isMax; dy++) {
        for (let dx = -windowR; dx <= windowR && isMax; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (elev[(y + dy) * w + (x + dx)] > e) isMax = false;
        }
      }

      if (!isMax) continue;

      // Compute prominence: difference from lowest point in a larger neighborhood
      let minNearby = e;
      for (let dy = -promRadius; dy <= promRadius; dy += 2) {
        for (let dx = -promRadius; dx <= promRadius; dx += 2) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const ne = elev[ny * w + nx];
          if (ne < minNearby) minNearby = ne;
        }
      }

      const prominence = e - minNearby;
      if (prominence >= minProminence) {
        peaks.push({ px: x, py: y, elevation: e, prominence });
      }
    }
  }

  return peaks;
}

// ===== Viewpoint Detection =====
function findViewpoints(elev, slopes, peaks, w, h, mpp, tileInfo, params) {
  const { minElevation, maxSlope, searchRadiusKm, minValleyDepth } = params;
  const searchRadiusPx = (searchRadiusKm * 1000) / mpp;
  const minDistPx = 500 / mpp; // Don't be right on the mountain
  const viewpoints = [];

  let checked = 0;
  const totalCandidates = Math.ceil(h / SUBSAMPLE) * Math.ceil(w / SUBSAMPLE);

  for (let y = SUBSAMPLE; y < h - SUBSAMPLE; y += SUBSAMPLE) {
    // Progress update every few rows
    if (y % (SUBSAMPLE * 20) === 0) {
      const pct = (y / h) * 100;
      progress('Scanning for viewpoints...', 40 + pct * 0.3, `Row ${y} / ${h}`);
    }

    for (let x = SUBSAMPLE; x < w - SUBSAMPLE; x += SUBSAMPLE) {
      const idx = y * w + x;
      const e = elev[idx];
      const s = slopes[idx];

      // Basic filters
      if (e < minElevation || s > maxSlope || e <= 0) continue;

      // Check each peak
      let bestMatch = null;

      for (const peak of peaks) {
        const dx = peak.px - x;
        const dy = peak.py - y;
        const distPx = Math.sqrt(dx * dx + dy * dy);

        // Distance filters
        if (distPx > searchRadiusPx || distPx < minDistPx) continue;

        // The peak should be higher than viewer
        if (peak.elevation <= e) continue;

        // Sample elevation profile for valley detection
        const valley = detectValley(elev, w, h, x, y, peak.px, peak.py, e, peak.elevation);

        if (valley.depth >= minValleyDepth) {
          const distM = distPx * mpp;
          const score = computeScore(e, s, peak, valley.depth, distM, maxSlope);

          if (!bestMatch || score > bestMatch.score) {
            bestMatch = {
              px: x,
              py: y,
              elevation: e,
              slope: s,
              peakElevation: peak.elevation,
              peakProminence: peak.prominence,
              peakDistanceM: distM,
              valleyDepth: valley.depth,
              score,
              peakPx: peak.px,
              peakPy: peak.py,
            };
          }
        }
      }

      if (bestMatch) {
        viewpoints.push(bestMatch);
      }
    }
  }

  return viewpoints;
}

// ===== Valley Detection =====
function detectValley(elev, w, h, x1, y1, x2, y2, elev1, elev2) {
  let minElev = Math.min(elev1, elev2);
  let minProfile = Infinity;

  for (let i = 1; i < PROFILE_SAMPLES - 1; i++) {
    const t = i / (PROFILE_SAMPLES - 1);
    const sx = Math.round(x1 + (x2 - x1) * t);
    const sy = Math.round(y1 + (y2 - y1) * t);

    // Clamp to grid bounds
    const cx = Math.max(0, Math.min(w - 1, sx));
    const cy = Math.max(0, Math.min(h - 1, sy));

    const e = elev[cy * w + cx];
    if (e < minProfile) minProfile = e;
  }

  const depth = minElev - minProfile;
  return { depth: Math.max(0, depth), minElevation: minProfile };
}

// ===== Scoring =====
function computeScore(elevation, slope, peak, valleyDepth, distanceM, maxSlope) {
  // Valley depth is most important — dramatic views
  const valleyScore = Math.min(valleyDepth / 300, 1) * 35;

  // Peak prominence — bigger mountain = more impressive
  const promScore = Math.min(peak.prominence / 800, 1) * 25;

  // Low slope — flatter = better for picnic/camping
  const slopeScore = Math.max(0, (maxSlope - slope) / maxSlope) * 20;

  // Distance — not too close, not too far (sweet spot ~2-5km)
  const distKm = distanceM / 1000;
  const distScore = (distKm >= 2 && distKm <= 8 ? 1 : distKm < 2 ? distKm / 2 : 8 / distKm) * 15;

  // Elevation bonus — higher spots tend to have better views
  const elevScore = Math.min(elevation / 1500, 1) * 5;

  return valleyScore + promScore + slopeScore + distScore + elevScore;
}

// ===== Clustering =====
function clusterResults(viewpoints, minDistM, mpp) {
  // Sort by score descending
  viewpoints.sort((a, b) => b.score - a.score);

  const minDistPx = minDistM / mpp;
  const kept = [];

  for (const vp of viewpoints) {
    let tooClose = false;
    for (const existing of kept) {
      const dx = vp.px - existing.px;
      const dy = vp.py - existing.py;
      if (Math.sqrt(dx * dx + dy * dy) < minDistPx) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) kept.push(vp);
    if (kept.length >= MAX_RESULTS) break;
  }

  return kept;
}
