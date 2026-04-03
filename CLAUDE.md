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
  → app.js validates tile count before allowing analysis (MAX_TILES=80)
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
  → app.js clips results to selection bounds (selectionBounds.contains)
  → app.js renders directional SVG markers (score + bearing wedge),
    view-line polylines on popup open, and compass bearing labels
```

### Files

- **`app.js`** — Main controller: Leaflet map init, tile fetching/decoding (main thread Canvas), WebWorker lifecycle, UI state, result display. All terrain tile CORS image loading happens here, not in the worker.
- **`terrain-worker.js`** — Off-thread terrain analysis engine. Receives a raw `Float32Array` elevation grid. Contains all geospatial math: coordinate conversions (Mercator tile↔lat/lng), slope, peak finding, valley detection, scoring, clustering. Communicates via `postMessage` with progress updates.
- **`globe.js`** — Interactive 3D Earth widget (p5.js WEBGL, instance mode). Satellite texture composited from Esri tiles at zoom 2 (4×4 → 1024px), remapped from Web Mercator to equirectangular before UV-mapping onto the sphere. State machine: dragging → decelerating → settled → showcase. Fires `globe-navigate` CustomEvent; app.js listens and calls `map.flyTo`. Map navigation only triggers on label click, not globe click.
- **`style.css`** — Windows XP/7 Aero-inspired glassmorphism theme (light, not dark). Note: elements using `display: flex` need explicit `[hidden]` selectors (e.g., `#progress-overlay[hidden] { display: none; }`) because CSS display overrides the HTML `hidden` attribute. Windows use a manual z-index counter (`_topZ = 300`, incremented on focus) for stacking order.
- **`index.html`** — Single page. Dependencies loaded via CDN: Leaflet, Leaflet.Draw, Leaflet.markercluster, p5.js, Ubuntu font.

### Key Design Decisions

- Terrain tile decoding uses main-thread `<canvas>` (not OffscreenCanvas in worker) for broader browser compatibility
- Analysis zoom is fixed at z=11 (~58m/pixel at 40°N latitude)
- 1-tile padding around user selection ensures peaks near edges are detected
- Viewpoint candidates are subsampled every 3rd pixel for performance
- Results are spatially clustered (400m min distance) and capped at 150
- **Visual clustering**: Leaflet.markercluster groups nearby markers at lower zoom levels; clicking a cluster zooms in or spiderfies to reveal individual viewpoints
- **State persistence**: Liked/starred spots stored in localStorage (`sv_liked`, `sv_starred`) as JSON-serialized Sets, keyed by `${lat.toFixed(5)},${lng.toFixed(5)}`. Map position/zoom (`sv_map_view`) and base layer choice (`sv_base_layer`) also persisted
- **Key limits**: MAX_TILES=80 per selection (app.js), SUBSAMPLE=3 pixels (worker), CLUSTER_DISTANCE_M=400m, MAX_RESULTS=150
- **Marker private state**: Result markers store data as `marker._vpScore`, `marker._viewLine`, `marker._peakDot` etc. — view-lines are created on popup open and cleaned up on popup close
- **Tile boundary display**: Only tiles that intersect the user's selection are drawn on the map; padding tiles fetched for analysis are not shown
- **Results clipping**: Worker results are filtered post-analysis to only include viewpoints inside `state.selectionBounds`

### Rectangle Selection & Undo/Redo

- Draw toolbar only allows rectangles; edit toolbar is disabled — the drawn rectangle is always directly editable via `layer.editing.enable()` (no save step)
- `setupRectEditing(layer)` attaches an `edit` listener that debounces history pushes (400ms) so continuous handle-dragging = one undo step
- `state.editDebounce` is stored on `state` (not in a closure) so undo/redo can safely recreate the layer without leaking stale timers
- Undo/redo: `state.boundsHistory` (array of plain `{south,north,west,east}` objects) + `state.historyIndex`. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y keyboard shortcuts wired in `initButtons()`
- `validateSelection(bounds)` is called on every draw/edit/delete/undo/redo and enables/disables the Analyze button with a live tile count

### Globe Widget (`globe.js`)

- **Texture**: 16 Esri satellite tiles at zoom 2 composited onto a 1024×1024 canvas, then `mercatorToEquirect()` remaps each output row from linear latitude to the corresponding Mercator source row to correct polar distortion
- **Sphere**: `p.sphere(74, 48, 32)` — radius 74 fills the 150px circular container with ~1px margin. MSAA via `setAttributes('antialias', true)`, HiDPI via `pixelDensity(2)`
- **Physics**: Flick velocity computed from a 100ms pointer trail (`pointerTrail`) on mouseup rather than the last delta, so fast flicks capture full momentum. Non-linear slingshot boost: `boost = 1 + speed * 8`. DAMPING=0.94, SETTLE_THRESHOLD=0.002
- **State machine**:
  - `dragging` — globe tracks pointer exactly
  - decelerating — physics coasts with damping until velocity < SETTLE_THRESHOLD
  - `settled` — globe stops, pinned dot appears at surface, geocode fires, 20s timer starts
  - `showcase` — auto-rotates slowly (AUTO_SPIN=0.0015), dot and label hidden
- **Pinned dot**: `latLngToSurface(lat, lng, RADIUS+1)` cached as `pinSurface` on settle — not recomputed every frame
- **Center reticle**: white dot at `(0, 0, RADIUS+1)` shown during drag and deceleration
- **Reverse geocoding**: Nominatim, debounced 700ms after settle, keyed by `lat.toFixed(1),lng.toFixed(1)` to skip redundant calls
- **Label**: `#globe-label` div inserted after `#earth-globe`. Clicking it fires `globe-navigate` → `map.flyTo`. Hidden during drag/showcase
- **Edge shine**: CSS `#earth-globe::after` with inset box-shadows (blue atmosphere + dark shadow + bright top-left highlight)
- **DOM refs**: `analyzeBtnEl`, `analyzeBtnTextEl`, `undoBtnEl`, `redoBtnEl` cached in `init()` — not queried on every event

### Controls Panel Toggle

- Chevron toggle button (`#controls-toggle`) is a sibling of `#controls-panel` inside `#window-content`, not a child
- Collapsed state uses `margin-left` transition (0.3s cubic-bezier) to slide the panel off-screen; toggle slides with it via `left` transition
- Collapsed/expanded state persisted in `localStorage` (`sv_filters_collapsed`). On mobile, starts collapsed by default
- After toggling, `map.invalidateSize()` is called (with 310ms delay matching transition) so Leaflet reclaims/yields the space

### Desktop Buddy Integration ("Rocky")

An animated 3D character (Three.js) embedded as a desktop pet. Source project lives at `../desktop-buddy/` with its own CLAUDE.md — read that before modifying the buddy's core code (physics, rendering, animation, scripting).

**Integration files (in this repo):**
- **`buddy-integration.js`** — Glue code. Initializes the buddy, wires world-toolkit CustomEvents to buddy reactions, manages cooldown, idle tips, and desktop icon toggle. This is the only file to edit for changing how Rocky interacts with world-toolkit.
- **`vendor/desktop-buddy/desktop-buddy.iife.js`** — Pre-built IIFE bundle. Do NOT edit directly — rebuild from `../desktop-buddy/` with `pnpm build`, then copy `dist/desktop-buddy.iife.js` here.
- **`Models/`** — OBJ model files at project root (fetched as `Models/Head.obj` etc. relative to page origin). Copied from `../desktop-buddy/dist/Models/`.
- **`scripts/rocky-terrain.md`** — Dialogue script (markdown format with HTML comment directives). Edit this to change what Rocky says. Format documented in `../desktop-buddy/CLAUDE.md` under "Scripting system".

**Event bridge (app.js → buddy-integration.js):**
- `wt:analysis-start` — dispatched when terrain analysis begins
- `wt:results` — dispatched after `displayResults()`, detail: `{ count }`
- `wt:like` — dispatched after `toggleLike()`, detail: `{ added: boolean }`
- `wt:star` — dispatched after `toggleStar()`, detail: `{ added: boolean }`

These are `CustomEvent`s on `document`. To add new buddy reactions: dispatch a new `wt:` event in `app.js`, listen for it in `buddy-integration.js`.

**Key constraints:**
- Buddy is **disabled on mobile** (`IS_MOBILE` check in `buddy-integration.js`)
- Buddy canvas z-index is 999999, speech bubble is 1000000 — above all world-toolkit UI
- 8-second cooldown between reactions to avoid spamming dialogue
- Visibility toggled via double-click on the Rocky desktop icon; persisted in `localStorage` (`sv_buddy_visible`)
- The IIFE bundle hardcodes model paths as `Models/*.obj` relative to page origin — do not move the `Models/` directory without updating the bundle

**Rebuilding the buddy bundle:**
```bash
cd ../desktop-buddy && pnpm build
cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
cp -r dist/Models/ ../world-toolkit/Models/
```

### Mobile Layout

- **Detection**: `IS_MOBILE` constant set at load time via `matchMedia('(max-width: 600px)')` combined with `ontouchstart` check
- **Home screen**: On mobile, `main-window` starts hidden (set in inline `<script>` before app.js loads). Globe and desktop icons are centered for a portrait layout
- **Fullscreen windows**: All `.xp-window` elements are forced to `100vw × 100vh` via CSS; resize handles, window borders, and maximize buttons are hidden
- **Window drag/resize/maximize disabled**: `initWindowDrag()`, `initWindowResize()`, `initMaximize()`, and layout persistence are skipped when `IS_MOBILE`
- **Window open/close animations**: Mobile uses simple CSS class-based animations (`win-opening`/`win-closing`) instead of the desktop transform-origin zoom effect
- **Controls panel**: Becomes an absolute-positioned 80vw overlay (max 320px) sliding from the left edge with a box-shadow
- **Results panel**: Bottom-sheet style, `max-height: 45%`
- **Responsive breakpoints**: `max-width: 900px` breakpoint now excludes mobile (`min-width: 601px`); dedicated `max-width: 600px` breakpoint handles mobile
