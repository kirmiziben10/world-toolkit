/**
 * ITM Wrapper — clean API for Radio Reach integration.
 *
 * Requires itm.js to be loaded first (provides self.ITM or require('./itm')).
 * Works in browser, Web Worker (importScripts), and Node.js.
 */
(function () {
  'use strict';

  var ITM = (typeof self !== 'undefined' && self.ITM) ||
            (typeof module !== 'undefined' && require('./itm'));

  // Hardcoded defaults for Radio Reach
  var CLIMATE = 5;       // continental temperate
  var N_0     = 301;     // standard refractivity, N-Units
  var POL     = 1;       // vertical polarization
  var EPSILON = 15;      // average ground relative permittivity
  var SIGMA   = 0.008;   // average ground conductivity, S/m
  var MDVAR   = 12;      // broadcast mode, no direct situation variability
  var TIME    = 50;      // median time percentage
  var LOCATION = 50;     // median location percentage
  var SITUATION = 50;    // median situation percentage

  /**
   * Compute point-to-point path loss using the NTIA Longley-Rice ITM.
   *
   * @param {Float32Array|number[]} profile - Terrain elevations in meters, TX-to-RX
   * @param {number} spacingM   - Distance between profile samples, in meters
   * @param {number} txHeightM  - TX antenna height above ground level, in meters
   * @param {number} rxHeightM  - RX antenna height above ground level, in meters
   * @param {number} freqMHz    - Frequency in MHz (20–20000)
   * @returns {number} Basic transmission loss in dB
   */
  function computeITMPathLoss(profile, spacingM, txHeightM, rxHeightM, freqMHz) {
    // Build PFL array: [N, stepMeters, elev0, elev1, ..., elevN]
    // N = number of intervals = number of elevation samples - 1
    var nSamples = profile.length;
    var N = nSamples - 1;

    var pfl = new Array(N + 2);
    pfl[0] = N;
    pfl[1] = spacingM;
    for (var i = 0; i < nSamples; i++) {
      pfl[i + 2] = profile[i];
    }

    var result = ITM.ITM_P2P_TLS(
      txHeightM, rxHeightM, pfl,
      CLIMATE, N_0, freqMHz,
      POL, EPSILON, SIGMA,
      MDVAR, TIME, LOCATION, SITUATION
    );

    // Error codes >= 1000 are hard failures; 0 and 1 (SUCCESS_WITH_WARNINGS) are fine
    if (result.error >= 1000) {
      throw new Error('ITM error ' + result.error + ' (warnings: 0x' + result.warnings.toString(16) + ')');
    }

    return result.A__db;
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { computeITMPathLoss: computeITMPathLoss };
  } else if (typeof self !== 'undefined') {
    self.computeITMPathLoss = computeITMPathLoss;
  }

})();
