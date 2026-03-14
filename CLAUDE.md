# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development

This is a zero-build, static web app. No npm, no bundler — just vanilla HTML/CSS/JS served directly.

```bash
# Run the dev server
python3 -m http.server 8765

# Then open http://localhost:8765/
```

## Architecture

A browser-based terrain analysis tool that finds scenic viewpoints with mountain views. **Zero backend** — all processing happens client-side using publicly available elevation data.

### Data Flow

```
User draws rectangle on Leaflet map
  → app.js computes tile coordinates for the selection
  → Fetches Terrarium-encoded PNG terrain tiles from AWS Open Data CDN
    (https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png)
  → Decodes elevation from RGB pixels: (R*256 + G + B/256) - 32768
  → Transfers Float32Array elevation grid to WebWorker (zero-copy via transferable)
  → terrain-worker.js runs analysis pipeline:
    1. Slope computation (Horn/Sobel 3×3 kernel)
    2. Peak detection (local maxima + prominence filtering)
    3. Viewpoint search (slope/elevation filters + valley detection via profile sampling)
    4. Scoring and spatial clustering
    5. Bearing computation (forward azimuth from viewpoint to best peak)
  → Results sent back as viewpoint array (includes peakLat, peakLng, viewBearing)
  → app.js renders directional SVG markers (score + bearing wedge),
    view-line polylines on popup open, and compass bearing labels
```

### Files

- **`app.js`** — Main controller: Leaflet map init, tile fetching/decoding (main thread Canvas), WebWorker lifecycle, UI state, result display. All terrain tile CORS image loading happens here, not in the worker.
- **`terrain-worker.js`** — Off-thread terrain analysis engine. Receives a raw `Float32Array` elevation grid. Contains all geospatial math: coordinate conversions (Mercator tile↔lat/lng), slope, peak finding, valley detection, scoring, clustering. Communicates via `postMessage` with progress updates.
- **`style.css`** — Windows XP/7 Aero-inspired glassmorphism theme (light, not dark). Note: elements using `display: flex` need explicit `[hidden]` selectors (e.g., `#progress-overlay[hidden] { display: none; }`) because CSS display overrides the HTML `hidden` attribute. Windows use a manual z-index counter (`_topZ = 300`, incremented on focus) for stacking order.
- **`index.html`** — Single page. Dependencies loaded via CDN: Leaflet, Leaflet.Draw, Leaflet.markercluster, Ubuntu font.

### Key Design Decisions

- Terrain tile decoding uses main-thread `<canvas>` (not OffscreenCanvas in worker) for broader browser compatibility
- Analysis zoom is fixed at z=11 (~58m/pixel at 40°N latitude)
- 1-tile padding around user selection ensures peaks near edges are detected
- Viewpoint candidates are subsampled every 3rd pixel for performance
- Results are spatially clustered (400m min distance) and capped at 150
- **Visual clustering**: Leaflet.markercluster groups nearby markers at lower zoom levels; clicking a cluster zooms in or spiderfies to reveal individual viewpoints
- **State persistence**: Liked/starred spots stored in localStorage (`sv_liked`, `sv_starred`) as JSON-serialized Sets, keyed by `${lat.toFixed(5)},${lng.toFixed(5)}`
- **Key limits**: MAX_TILES=30 per selection (app.js), SUBSAMPLE=3 pixels (worker), CLUSTER_DISTANCE_M=400m, MAX_RESULTS=150
- **Marker private state**: Result markers store data as `marker._vpScore`, `marker._viewLine`, `marker._peakDot` etc. — view-lines are created on popup open and cleaned up on popup close
