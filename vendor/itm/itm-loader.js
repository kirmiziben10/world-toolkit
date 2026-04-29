/**
 * ITM WASM Loader — async instantiation of the Emscripten WASM module.
 *
 * Provides loadITMWasm() which returns a Promise resolving to an object
 * with computeITMPathLossWasm(profile, spacingM, txHeightM, rxHeightM, freqMHz, params).
 *
 * CRITICAL: All WASM heap buffers are allocated ONCE at init time and reused
 * for every call. No malloc/free in the hot path.
 *
 * Works in Web Workers (importScripts) and main thread (script tag).
 * The module is cached after first instantiation.
 */
(function () {
  'use strict';

  // Max profile buffer: 2048 samples + 2 header slots = 2050 doubles = 16400 bytes
  var MAX_PFL_SLOTS = 2050;

  var cachedModule = null;
  var loadingPromise = null;

  function loadITMWasm() {
    if (cachedModule) return Promise.resolve(cachedModule);
    if (loadingPromise) return loadingPromise;

    loadingPromise = new Promise(function (resolve, reject) {
      try {
        if (typeof createITMModule !== 'function') {
          reject(new Error('ITM WASM glue not loaded (createITMModule not found)'));
          return;
        }

        // Locate the .wasm file relative to the page/worker
        var moduleOpts = {};
        if (typeof self !== 'undefined' && self.location) {
          var base = self.location.href.replace(/[^\/]*$/, '');
          moduleOpts.locateFile = function (path) {
            if (path.endsWith('.wasm')) return base + 'vendor/itm/itm-glue.wasm';
            return path;
          };
        }

        createITMModule(moduleOpts).then(function (Module) {
          // Wrap ITM_P2P_TLS via cwrap
          // C signature: int ITM_P2P_TLS(
          //   double h_tx, double h_rx, double* pfl,
          //   int climate, double N_0, double f_mhz,
          //   int pol, double epsilon, double sigma,
          //   int mdvar, double time, double location, double situation,
          //   double* A_db, long* warnings)
          var _ITM_P2P_TLS = Module.cwrap('ITM_P2P_TLS', 'number', [
            'number', 'number', 'number',   // h_tx, h_rx, pfl*
            'number', 'number', 'number',   // climate, N_0, f_mhz
            'number', 'number', 'number',   // pol, epsilon, sigma
            'number', 'number', 'number', 'number', // mdvar, time, location, situation
            'number', 'number'              // A_db*, warnings*
          ]);

          // ALLOCATE REUSABLE BUFFERS ONCE — never freed, never reallocated
          var pflPtr  = Module._malloc(MAX_PFL_SLOTS * 8); // doubles
          var aDbPtr  = Module._malloc(8);                  // double output
          var warnPtr = Module._malloc(4);                  // int32 output (long is 32-bit in wasm32)

          if (!pflPtr || !aDbPtr || !warnPtr) {
            reject(new Error('ITM WASM: failed to allocate reusable buffers'));
            return;
          }

          /**
           * Compute ITM path loss via WASM.
           * @param {Float32Array|Float64Array|number[]} profile - Terrain elevations TX→RX
           * @param {number} spacingM   - Sample spacing in meters
           * @param {number} txHeightM  - TX antenna height AGL
           * @param {number} rxHeightM  - RX antenna height AGL
           * @param {number} freqMHz    - Frequency in MHz
           * @param {Object=} params   - Optional ITM environment/statistical parameters
           * @returns {number} Basic transmission loss in dB
           */
          function computeITMPathLossWasm(profile, spacingM, txHeightM, rxHeightM, freqMHz, params) {
            var nSamples = profile.length;
            var N = nSamples - 1; // number of intervals
            var pflLen = nSamples + 2; // [N, spacingM, elev0, ..., elevN]
            params = params || {};

            var climate = params.climate === undefined ? 5 : params.climate;
            var n0 = params.n0 === undefined ? 301 : params.n0;
            var pol = params.pol === undefined ? 1 : params.pol;
            var epsilon = params.epsilon === undefined ? 15 : params.epsilon;
            var sigma = params.sigma === undefined ? 0.008 : params.sigma;
            var mdvar = params.mdvar === undefined ? 12 : params.mdvar;
            var time = params.time === undefined ? 50 : params.time;
            var location = params.location === undefined ? 50 : params.location;
            var situation = params.situation === undefined ? 50 : params.situation;

            if (pflLen > MAX_PFL_SLOTS) {
              throw new Error('ITM profile too long: ' + nSamples + ' samples (max ' + (MAX_PFL_SLOTS - 2) + ')');
            }

            // Write PFL header: pfl[0] = N (as double), pfl[1] = spacingM (as double)
            var pflF64Offset = pflPtr / 8; // byte offset → float64 index
            Module.HEAPF64[pflF64Offset]     = N;
            Module.HEAPF64[pflF64Offset + 1] = spacingM;

            // Write elevation samples as doubles
            for (var i = 0; i < nSamples; i++) {
              Module.HEAPF64[pflF64Offset + 2 + i] = profile[i];
            }

            // Zero output slots
            Module.HEAPF64[aDbPtr / 8] = 0.0;
            Module.setValue(warnPtr, 0, 'i32');

            var errCode = _ITM_P2P_TLS(
              txHeightM, rxHeightM, pflPtr,
              climate, n0, freqMHz,
              pol, epsilon, sigma,
              mdvar, time, location, situation,
              aDbPtr, warnPtr
            );

            if (errCode >= 1000) {
              var warnings = Module.getValue(warnPtr, 'i32');
              throw new Error('ITM WASM error ' + errCode + ' (warnings: 0x' + warnings.toString(16) + ')');
            }

            return Module.HEAPF64[aDbPtr / 8];
          }

          cachedModule = { computeITMPathLossWasm: computeITMPathLossWasm };
          resolve(cachedModule);
        }).catch(function (err) {
          loadingPromise = null;
          reject(err);
        });
      } catch (err) {
        loadingPromise = null;
        reject(err);
      }
    });

    return loadingPromise;
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { loadITMWasm: loadITMWasm };
  } else if (typeof self !== 'undefined') {
    self.loadITMWasm = loadITMWasm;
  }

})();
