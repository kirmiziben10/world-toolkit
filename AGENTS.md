# AGENTS.md

## Development
- Zero-build static app. Dev server: `python3 -m http.server 8765`
- No npm, no bundler. CDN dependencies in `index.html`.

## Architecture
- Two independent apps in one page: viewpoint finder (`app.js`) and Radio Reach (`radio-reach.js`).
- **Tile fetching protocol**: Workers never fetch tiles directly. They post `needTiles` to the main thread, which fetches via `TerrainTiles.getTile` and posts back decoded `Float32Array` grids. This shares the tile cache across workers.
- **Viewpoint vs Radio tile decoding**: Viewpoint pipeline uses main-thread `<canvas>` (broader compat); Radio pipeline uses `OffscreenCanvas` inside workers via `terrain-tiles.js`.
- Viewpoint analysis zoom is fixed at z=11; Radio defaults to z=12 (selectable z8–z12).
- Results are post-clipped to `selectionBounds` in `app.js` after worker returns them.

## Key Limits
- Viewpoint: `MAX_TILES=80`, subsample every 3rd pixel, cluster at 400m, cap at 150 results.
- Radio: `MAX_RADIUS_KM=1000`, `MAX_TILES_LIMIT=2000`, `MAX_BITMAP_MB=300`.

## CSS Quirks
- Elements with `display: flex` need explicit `[hidden] { display: none; }` selectors because CSS `display` overrides the HTML `hidden` attribute.
- Windows use a manual z-index counter (`_topZ = 300`, incremented on focus) for stacking.

## State & Persistence
- `localStorage` keys: `sv_liked`, `sv_starred`, `sv_map_view`, `sv_base_layer`, `sv_filters_collapsed`, `sv_buddy_visible`, `sv_buddy_lang`, `sv_tutorial_done`, `sv_radio_*`.
- Rectangle edit history debounce (400ms) is stored on `state.editDebounce` (not a closure) so undo/redo can safely recreate the layer.

## Accessibility
- **Live region**: Use `announce(msg)` in `app.js`. It clears `#app-announcer` text and re-sets it on the next animation frame so repeats announce.
- **Progress bars**: Never set `style.width` directly. Use `setProgressBarState(percent, text, detail)` (app.js) or `setRadioProgress(percent, text)` (radio-reach.js). Pass `null` to keep the current value; passing `0` resets it.
- **Window toggles**: After flipping `hidden` on any window, call `updateWindowToggleState(winId)` so `aria-expanded` stays in sync.
- **Toggle buttons**: Use `buildToggleButtonContent(kind, active, withText)` and `updateToggleButtonState(btn, kind, active)` for love/star buttons. Do not mutate `textContent`/`classList` directly.
- **Leaflet controls**: After adding any Leaflet control, call `syncMapControlAccessibility()` to pull `title` into `aria-label`.
- **Form labels (Radio)**: `assignClosestControlLabel(control)` and `initAccessibility()` wire visible `<span class="label-text">` to inputs via `aria-labelledby`. Re-run on `i18n:changed`.
- **i18n attributes**: `data-i18n-attr="attr:key,attr2:key2"`. Prefer this over re-applying ARIA labels in JS on language change.

## Mobile
- `IS_MOBILE` is set at load time via `matchMedia('(max-width: 600px)')` + `ontouchstart` check.
- On mobile, `main-window` starts hidden (inline `<script>` before `app.js` loads).
- Window drag/resize/maximize (`initWindowDrag`, `initWindowResize`, `initMaximize`) are skipped entirely when `IS_MOBILE`.
- Controls panel becomes an absolute-positioned 80vw overlay.

## Language & i18n
- Supported: `en`, `tr`. Resolution order: `localStorage('sv_buddy_lang')` → `navigator.language` prefix → `'en'`.
- `window.getCurrentLang()` is the shared source of truth for both UI (`i18n.js`) and Rocky.
- `window.i18n.setLang(lang)` dispatches `i18n:changed`. Buddy re-inits on this event.

## Rocky (Desktop Buddy)
- Integration logic lives only in `buddy-integration.js`. Core physics/rendering lives in `../desktop-buddy/` (see its `CLAUDE.md`).
- `vendor/desktop-buddy/desktop-buddy.iife.js` is pre-built — **do not edit directly**. Rebuild:
  ```bash
  cd ../desktop-buddy && pnpm build
  cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
  cp -r dist/Models/ ../world-toolkit/Models/
  ```
- Do **not** move the `Models/` directory — the IIFE hardcodes paths as `Models/*.obj` relative to page origin.
- Buddy is disabled on mobile. Canvas z-index is 999999, speech bubble is 1000000.

## ITM / Radio WASM
- Runtime backend is `vendor/itm/itm-glue.wasm` (Emscripten). `itm-js-reference.js` is validation-only.
- Rebuild: `bash vendor/itm/build-wasm.sh` (requires Emscripten SDK).
- Validate JS reference against NTIA test cases: `node vendor/itm/test/validate-ntia.mjs` (threshold ≤ 0.27 dB).

## opencode.json
- `python3 -m http.server *` is pre-allowed in `.opencode/opencode.json`.
