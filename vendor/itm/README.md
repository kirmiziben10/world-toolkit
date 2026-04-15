# NTIA Irregular Terrain Model (ITM) — Vendored Port

## What's here

| File / Directory | Purpose |
|---|---|
| `itm-js-reference.js` | Pure JS port of the NTIA ITM C++ reference. Used for validation only — not loaded at runtime. |
| `itm-glue.js` + `itm-glue.wasm` | Emscripten WASM build of the NTIA C++ source. This is the runtime backend. |
| `itm-loader.js` | WASM module loader with reusable heap buffers (no malloc/free in hot path). |
| `itm-wrapper.js` | Public API: `initITM()`, `computeITMPathLoss(profile, spacingM, txHeightM, rxHeightM, freqMHz)`. |
| `build-wasm.sh` | Build script for regenerating the WASM binary from source. |
| `src/` | Patched NTIA C++ source files (22 files). |
| `include/` | Patched NTIA C++ headers. |
| `test/` | NTIA official test data and validation harness. |

## Upstream source

- **Repository:** https://github.com/NTIA/itm (v1.4)
- **License:** Public domain (US government work, NTIA/ITS)
- **Patches applied:**
  - Windows backslash include paths → Unix forward slashes
  - `__declspec(dllexport)` → `EMSCRIPTEN_KEEPALIVE` under `__EMSCRIPTEN__`

## Running the validation tests

```bash
node vendor/itm/test/validate-ntia.mjs
```

Runs all 5 official NTIA point-to-point test cases against the JS
reference implementation. Acceptance threshold: **≤ 0.27 dB** worst-case
delta from expected values.

Expected output:
```
Running 5 NTIA P2P test cases...

  Case 1: 230 MHz, 367.8 km  expected 207.65, got 207.66  delta 0.006 dB  PASS
  Case 2: 480 MHz, 7.8 km    expected 157.10, got 156.83  delta 0.270 dB  PASS
  Case 3: 990 MHz, 28.0 km   expected 178.53, got 178.55  delta 0.017 dB  PASS
  Case 4: 5600 MHz, 28.6 km  expected 183.26, got 183.08  delta 0.184 dB  PASS
  Case 5: 8800 MHz, 25.5 km  expected 218.91, got 218.91  delta 0.002 dB  PASS

Worst-case delta: 0.270 dB (threshold: 0.27 dB)
ALL PASS
```

## Rebuilding the WASM binary

Requires Emscripten SDK:

```bash
git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest
cd /path/to/world-toolkit
bash vendor/itm/build-wasm.sh
```

## API usage

```js
// In a Web Worker:
importScripts('vendor/itm/itm-glue.js');
importScripts('vendor/itm/itm-loader.js');
importScripts('vendor/itm/itm-wrapper.js');

await initITM(); // must be called once before computing

var loss = computeITMPathLoss(
  elevationProfile,  // Float32Array of terrain elevations TX→RX
  spacingMeters,     // distance between profile samples
  txHeightM,         // TX antenna height AGL
  rxHeightM,         // RX antenna height AGL
  freqMHz            // frequency in MHz (20–20000)
);
```

Hardcoded parameters (not exposed in API):
- Climate: continental temperate (5)
- Surface refractivity: 301 N-Units
- Polarization: vertical (1)
- Ground permittivity: 15
- Ground conductivity: 0.008 S/m
- Variability mode: broadcast (12)
- Time/Location/Situation: 50/50/50%
