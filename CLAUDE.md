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
    (https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png)
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
    view-line polylines on popup open, compass bearing labels,
    Google Earth 3D scene links, and Google Maps directions links
```

### Files

- **`app.js`** — Main controller for the viewpoint pipeline: Leaflet map init, tile fetching/decoding (main thread via `TerrainTiles`), `terrain-worker.js` lifecycle, UI state, result display.
- **`terrain-worker.js`** — Off-thread viewpoint analysis engine. Receives a raw `Float32Array` elevation grid. Contains slope, peak finding, valley detection, scoring, clustering. Communicates via `postMessage` with progress updates.
- **`terrain-tiles.js`** — Shared tile utility (`window.TerrainTiles` / `self.TerrainTiles`). Tile coord math, Terrarium decode, and tile fetching with an in-memory cache. Works in both the window (via `<canvas>`) and Web Workers (via `importScripts` + `OffscreenCanvas` + `createImageBitmap`). Used directly by the radio workers; the viewpoint worker still relies on the main thread to hand it a decoded grid.
- **`globe.js`** — Interactive 3D Earth widget (p5.js WEBGL, instance mode). Satellite texture composited from Esri tiles at zoom 2 (4×4 → 1024px), remapped from Web Mercator to equirectangular before UV-mapping onto the sphere. State machine: dragging → decelerating → settled → showcase. Fires `globe-navigate` CustomEvent; app.js listens and calls `map.flyTo`. Map navigation only triggers on label click, not globe click.
- **`radio-reach.js`** — Radio Reach app controller (`window.RadioReach`). Owns its own Leaflet map, sidebar, progress overlay, and gradient coverage canvas layer. Manages the radio worker lifecycle and the propagation worker pool. See the Radio Reach section.
- **`radio-worker.js`** — Radio pipeline orchestrator worker. Phase 1: 360-ray geometric LOS pre-filter (k=4/3 earth refraction). Phase 2: dilated evaluation mask. Phase 3: partitions reachable cells into angular slices and delegates to propagation workers. Requests tiles from the main thread via a `needTiles` message.
- **`radio-propagation-worker.js`** — Longley-Rice ITM evaluation slice worker. Loads the WASM ITM engine from `vendor/itm/` and evaluates path loss per cell, emitting `coverageBatch` messages directly to the main thread. Spawned in a pool (up to 4, sized from `navigator.hardwareConcurrency - 1`).
- **`i18n.js`** — Lightweight i18n runtime (`window.i18n`). Loads `locales/{en,tr}.json`, applies `data-i18n`, `data-i18n-attr`, `data-i18n-placeholder` on elements. Language source is `localStorage('sv_buddy_lang')`, shared with Rocky.
- **`tutorial.js`** — First-visit interactive tutorial (`window.Tutorial`). Parses `scripts/rocky-tutorial.md`, points Rocky at UI elements, persists completion via `localStorage('sv_tutorial_done')`.
- **`buddy-integration.js`** — Rocky glue code. See the Rocky section.
- **`style.css`** — Windows XP/7 Aero-inspired glassmorphism theme (light, not dark). Note: elements using `display: flex` need explicit `[hidden]` selectors (e.g., `#progress-overlay[hidden] { display: none; }`) because CSS display overrides the HTML `hidden` attribute. Windows use a manual z-index counter (`_topZ = 300`, incremented on focus) for stacking order.
- **`index.html`** — Single page. Dependencies loaded via CDN: Leaflet, Leaflet.Draw, Leaflet.markercluster, p5.js, Ubuntu font.
- **`vendor/itm/`** — NTIA Longley-Rice ITM C++ compiled to WebAssembly (`itm-glue.wasm`) plus JS loader/wrapper and a JS reference port (`itm-js-reference.js`). Used by `radio-propagation-worker.js`. Rebuild WASM with `bash vendor/itm/build-wasm.sh` (requires Emscripten SDK).
- **`locales/{en,tr}.json`** — UI string tables consumed by `i18n.js`.
- **`scripts/rocky-terrain.{en,tr}.md`**, **`scripts/rocky-tutorial.{en,tr}.md`** — Rocky dialogue and tutorial scripts per language (see Rocky section).

### Key Design Decisions

- Viewpoint pipeline: terrain tile decoding uses main-thread `<canvas>` for broader browser compatibility; the radio pipeline uses `OffscreenCanvas` inside the workers via `terrain-tiles.js`
- Viewpoint analysis zoom is fixed at z=11 (~58m/pixel at 40°N latitude); radio analysis defaults to z=12 (selectable z8–z12 in Advanced settings)
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
- **GlobeAPI**: `window.GlobeAPI = { spin(vx, vy) }` exposed at init for programmatic spin control. Adds velocity and clears pin/settled/showcase state (guarded to only reset when state actually needs clearing)

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
- **`scripts/rocky-terrain.{en,tr}.md`** — Dialogue scripts per language (markdown format with HTML comment directives). Edit these to change what Rocky says. Format documented in `../desktop-buddy/CLAUDE.md` under "Scripting system".
- **`scripts/rocky-tutorial.{en,tr}.md`** — Tutorial dialogue scripts per language.

**Event bridge (app.js → buddy-integration.js):**
- `wt:rectangle-drawn` — dispatched after the user draws a selection rectangle
- `wt:analysis-start` — dispatched when terrain analysis begins
- `wt:results` — dispatched after `displayResults()`, detail: `{ count }`
- `wt:like` — dispatched after `toggleLike()`, detail: `{ added: boolean }`
- `wt:star` — dispatched after `toggleStar()`, detail: `{ added: boolean }`

Radio Reach does not currently dispatch `wt:` events.

**Event bridge (buddy scripts → buddy-integration.js):**
- `buddy:trigger` with `detail: 'spin-globe'` — triggers the globe spin orchestration
- `buddy:trigger` with `detail: 'lang-en'` / `'lang-tr'` — switches language and reinits buddy

These are `CustomEvent`s on `document`. To add new buddy reactions: dispatch a new `wt:` event in `app.js`, listen for it in `buddy-integration.js`.

**Key constraints:**
- Buddy is **disabled on mobile** (`IS_MOBILE` check in `buddy-integration.js`)
- Buddy canvas z-index is 999999, speech bubble is 1000000 — above all world-toolkit UI
- 8-second cooldown between reactions to avoid spamming dialogue
- Visibility toggled via double-click on the Rocky desktop icon; persisted in `localStorage` (`sv_buddy_visible`)
- The IIFE bundle hardcodes model paths as `Models/*.obj` relative to page origin — do not move the `Models/` directory without updating the bundle

**Multi-language support:**
- Language resolved by `getCurrentLang()` in `buddy-integration.js` (also exposed as `window.getCurrentLang` for use by `tutorial.js`)
- Resolution order: `localStorage('sv_buddy_lang')` → `navigator.language` prefix → default `'en'`
- Supported languages: `en`, `tr`. Scripts live at `scripts/rocky-terrain.{lang}.md` and `scripts/rocky-tutorial.{lang}.md`
- Language switch via `buddy:trigger` event destroys and reinits the buddy after 1s delay

**Globe spin orchestration:**
- `orchestrateGlobeSpin()` walks Rocky to 80px from the globe edge, starts an orbit animation, then spins the globe via `window.GlobeAPI.spin(vx, vy)` for 3 seconds
- `window.GlobeAPI` is exposed by `globe.js` at init — `spin(vx, vy)` adds velocity impulses and clears settled/showcase state
- Re-entrancy guarded by module-level `spinCheckInterval`/`spinAnimInterval` refs — a second call while spinning is a no-op
- Idle timer has 25% chance to trigger a globe spin instead of showing a tip

**Rebuilding the buddy bundle:**
```bash
cd ../desktop-buddy && pnpm build
cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
cp -r dist/Models/ ../world-toolkit/Models/
```

### Internationalization

- Supported languages: `en`, `tr`. Strings live in `locales/{lang}.json`; default is `en`.
- `i18n.js` resolves language via `window.getCurrentLang()` → `localStorage('sv_buddy_lang')` → `navigator.language` prefix → `'en'`. Same key as Rocky, so UI and dialogue stay in sync.
- HTML hooks: `data-i18n="key"` (textContent), `data-i18n-attr="attr:key,attr2:key2"` (attributes), `data-i18n-placeholder="key"` (input placeholder). Parameters via `{{name}}`.
- `window.i18n.setLang(lang)` switches language, re-applies translations, and dispatches an `i18n:changed` CustomEvent. `buddy-integration.js` destroys and reinits Rocky on language change.

### Radio Reach

A second self-contained app mounted in `#radio-window`, opened via the Radio Reach desktop icon. Runs a Longley-Rice ITM propagation analysis and renders a gradient coverage canvas layer on its own Leaflet map.

```
User clicks map to place TX; optionally right-clicks / long-presses to set a direction target
  → radio-reach.js validates budget (MAX_RADIUS_KM=1000, MAX_TILES_LIMIT=2000, MAX_BITMAP_MB=300)
    and shows a memory warning/block based on MEMORY_RISK_RATIO_WARN / _BLOCK
  → Spawns 1 orchestrator worker (radio-worker.js) + N propagation workers
    (radio-propagation-worker.js, PROP_WORKER_COUNT = min(4, hardwareConcurrency-1))
  → Orchestrator Phase 1: 360-ray geometric LOS pre-filter with 4/3-earth refraction
  → Orchestrator Phase 2: dilated evaluation mask (BUFFER_KM=4)
  → Orchestrator Phase 3: partitions reachable cells into angular wedges (WEDGE_DEG=10)
    and hands each wedge's cell list to a propagation worker
  → Each propagation worker evaluates ITM path loss per cell via WASM and emits
    coverageBatch messages (every COVERAGE_BATCH_SIZE=500 cells) straight to the main thread
  → radio-reach.js paints batches into an ImageData-backed canvas overlay
    with Strong / Usable / Marginal bands
```

**Tile fetching protocol:** Workers do NOT fetch tiles themselves. They send `{ type: 'needTiles', tiles: [...] }` to the main thread, which fetches via `TerrainTiles.getTile` and posts back the decoded `Float32Array` elevation grids. This keeps network/Canvas work on the main thread and shares the tile cache across all workers.

**Key limits** (from `radio-reach.js`): `MAX_RADIUS_KM=1000`, `MAX_TILES_LIMIT=2000`, `MAX_BITMAP_MB=300`, `COVERAGE_BUFFER_KM=4`, `BROWSER_OVERHEAD_MB=180`, `PROP_WORKER_OVERHEAD_MB=32`, `BITMAP_BYTES_PER_PIXEL=9` (ImageData + band buffer + canvas backing), `SWEEP_TILE_FETCH_CONCURRENCY=4`, `RADAR_SWEEP_WEDGE_DEG=10`.

**ITM engine:** WASM (`vendor/itm/itm-glue.wasm`) by default, selectable in Advanced settings. `itm-js-reference.js` exists as a JS port for comparison only. Rebuild WASM with `bash vendor/itm/build-wasm.sh` (Emscripten SDK required).

**Advanced settings** (`<details id="radio-advanced-settings">`): resolution override, engine picker (WASM / JS), sweep mode, adaptive culling, fast-fill, and debug overlays (downloaded tiles, skipped tiles, tile borders, wedge borders, analysis bounds). Debug overlays render into dedicated Leaflet panes `radio-debug-pane` / `radio-preview-pane`.

**Persistence** (`localStorage` keys, all `sv_radio_*`): `sv_radio_map_view` (falls back to `sv_map_view` on first open so the radio map opens where the viewpoint map was), `sv_radio_filters_collapsed`, `sv_radio_advanced_open`. TX location is not persisted.

**Lifecycle hooks from app.js:** `window.RadioReach.init()` is called once at load; `window.RadioReach.invalidateMap()` is called whenever the radio window is shown, focused, maximized, or resized, so Leaflet reclaims its container size.

### Mobile Layout

- **Detection**: `IS_MOBILE` constant set at load time via `matchMedia('(max-width: 600px)')` combined with `ontouchstart` check
- **Home screen**: On mobile, `main-window` starts hidden (set in inline `<script>` before app.js loads). Globe and desktop icons are centered for a portrait layout
- **Fullscreen windows**: All `.xp-window` elements are forced to `100vw × 100vh` via CSS; resize handles, window borders, and maximize buttons are hidden
- **Window drag/resize/maximize disabled**: `initWindowDrag()`, `initWindowResize()`, `initMaximize()`, and layout persistence are skipped when `IS_MOBILE`
- **Window open/close animations**: Mobile uses simple CSS class-based animations (`win-opening`/`win-closing`) instead of the desktop transform-origin zoom effect
- **Controls panel**: Becomes an absolute-positioned 80vw overlay (max 320px) sliding from the left edge with a box-shadow
- **Results panel**: Bottom-sheet style, `max-height: 45%`
- **Responsive breakpoints**: `max-width: 900px` breakpoint now excludes mobile (`min-width: 601px`); dedicated `max-width: 600px` breakpoint handles mobile
