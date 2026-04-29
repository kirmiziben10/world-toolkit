/**
 * ITM Wrapper — WASM-only API for Radio Reach integration.
 *
 * Requires itm-glue.js and itm-loader.js to be loaded first.
 * Works in Web Workers (importScripts) and main thread (script tag).
 *
 * NO JS FALLBACK. If WASM fails to load, initITM() throws and analysis
 * must not proceed.
 */
(function () {
  'use strict';

  var wasmComputeFn = null;
  var ready = false;
  var initPromise = null;

  /**
   * Initialize the WASM ITM backend. Must be called once before
   * computeITMPathLoss(). Throws if WASM instantiation fails.
   * Safe to call multiple times — returns cached promise.
   * @returns {Promise<void>}
   */
  function initITM() {
    if (initPromise) return initPromise;

    initPromise = new Promise(function (resolve, reject) {
      var loadFn = (typeof self !== 'undefined' && self.loadITMWasm) ||
                   (typeof module !== 'undefined' && (function () {
                     try { return require('./itm-loader').loadITMWasm; } catch (e) { return null; }
                   })());

      if (!loadFn) {
        initPromise = null;
        reject(new Error('ITM WASM loader not available (loadITMWasm not found)'));
        return;
      }

      loadFn().then(function (wasmModule) {
        wasmComputeFn = wasmModule.computeITMPathLossWasm;
        ready = true;
        resolve();
      }).catch(function (err) {
        initPromise = null;
        reject(new Error('ITM WASM init failed: ' + (err.message || err)));
      });
    });

    return initPromise;
  }

  /**
   * Compute point-to-point path loss using the NTIA Longley-Rice ITM (WASM).
   * initITM() must have completed before calling this.
   *
   * @param {Float32Array|Float64Array|number[]} profile - Terrain elevations TX→RX
   * @param {number} spacingM   - Distance between profile samples, in meters
   * @param {number} txHeightM  - TX antenna height above ground level, in meters
   * @param {number} rxHeightM  - RX antenna height above ground level, in meters
   * @param {number} freqMHz    - Frequency in MHz (20–20000)
   * @param {Object=} params   - Optional ITM environment/statistical parameters
   * @returns {number} Basic transmission loss in dB
   */
  function computeITMPathLoss(profile, spacingM, txHeightM, rxHeightM, freqMHz, params) {
    if (!ready) {
      throw new Error('ITM not initialized — call initITM() first.');
    }
    return wasmComputeFn(profile, spacingM, txHeightM, rxHeightM, freqMHz, params);
  }

  /**
   * Returns true if initITM() has completed successfully.
   * @returns {boolean}
   */
  function isITMReady() {
    return ready;
  }

  /**
   * Returns the active backend name ('wasm').
   * @returns {string}
   */
  function getITMBackend() {
    return 'wasm';
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeITMPathLoss: computeITMPathLoss, initITM: initITM, isITMReady: isITMReady, getITMBackend: getITMBackend };
  } else if (typeof self !== 'undefined') {
    self.computeITMPathLoss = computeITMPathLoss;
    self.initITM = initITM;
    self.isITMReady = isITMReady;
    self.getITMBackend = getITMBackend;
  }

})();
