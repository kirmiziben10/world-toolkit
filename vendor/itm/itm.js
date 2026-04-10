/**
 * NTIA Irregular Terrain Model (ITM) — Point-to-Point Mode
 *
 * Source:     Ported from NTIA/itm C++ reference (https://github.com/NTIA/itm), v1.4
 * License:    Public domain (US government work)
 * Port:       Claude Code port, April 2026
 * Validation: Matches NTIA official test cases within 0.27 dB worst case (5/5 pass)
 *
 * Works in Node.js (require), browser (script tag), and Web Workers (importScripts).
 */
(function () {
    "use strict";

    // =========================================================================
    // Constants
    // =========================================================================

    var PI = 3.1415926535897932384;
    var SQRT2 = Math.sqrt(2);
    var a_0__meter = 6370e3;
    var a_9000__meter = 9000e3;
    var THIRD = 1.0 / 3.0;

    // =========================================================================
    // Macros (inlined as functions)
    // =========================================================================

    function MAX(x, y) { return Math.max(x, y); }
    function MIN(x, y) { return Math.min(x, y); }
    function DIM(x, y) { return x > y ? x - y : 0; }

    // =========================================================================
    // Enums
    // =========================================================================

    var SINGLE_MESSAGE_MODE = 0;
    var ACCIDENTAL_MODE = 1;
    var MOBILE_MODE = 2;
    var BROADCAST_MODE = 3;

    var POLARIZATION__HORIZONTAL = 0;
    var POLARIZATION__VERTICAL = 1;

    var MODE__NOT_SET = 0;
    var MODE__P2P = 0;
    var MODE__AREA = 1;
    var MODE__LINE_OF_SIGHT = 1;
    var MODE__DIFFRACTION = 2;
    var MODE__TROPOSCATTER = 3;

    // Radio climates
    var CLIMATE__EQUATORIAL = 1;
    var CLIMATE__CONTINENTAL_SUBTROPICAL = 2;
    var CLIMATE__MARITIME_SUBTROPICAL = 3;
    var CLIMATE__DESERT = 4;
    var CLIMATE__CONTINENTAL_TEMPERATE = 5;
    var CLIMATE__MARITIME_TEMPERATE_OVER_LAND = 6;
    var CLIMATE__MARITIME_TEMPERATE_OVER_SEA = 7;

    // =========================================================================
    // Error / Warning codes
    // =========================================================================

    var SUCCESS = 0;
    var NO_WARNINGS = 0;
    var SUCCESS_WITH_WARNINGS = 1;

    var ERROR__TX_TERMINAL_HEIGHT = 1000;
    var ERROR__RX_TERMINAL_HEIGHT = 1001;
    var ERROR__INVALID_RADIO_CLIMATE = 1002;
    var ERROR__INVALID_TIME = 1003;
    var ERROR__INVALID_LOCATION = 1004;
    var ERROR__INVALID_SITUATION = 1005;
    var ERROR__INVALID_CONFIDENCE = 1006;
    var ERROR__INVALID_RELIABILITY = 1007;
    var ERROR__REFRACTIVITY = 1008;
    var ERROR__FREQUENCY = 1009;
    var ERROR__POLARIZATION = 1010;
    var ERROR__EPSILON = 1011;
    var ERROR__SIGMA = 1012;
    var ERROR__GROUND_IMPEDANCE = 1013;
    var ERROR__MDVAR = 1014;
    var ERROR__EFFECTIVE_EARTH = 1016;
    var ERROR__PATH_DISTANCE = 1017;
    var ERROR__DELTA_H = 1018;
    var ERROR__TX_SITING_CRITERIA = 1019;
    var ERROR__RX_SITING_CRITERIA = 1020;
    var ERROR__SURFACE_REFRACTIVITY_SMALL = 1021;
    var ERROR__SURFACE_REFRACTIVITY_LARGE = 1022;

    var WARN__TX_TERMINAL_HEIGHT = 0x0001;
    var WARN__RX_TERMINAL_HEIGHT = 0x0002;
    var WARN__FREQUENCY = 0x0004;
    var WARN__PATH_DISTANCE_TOO_BIG_1 = 0x0008;
    var WARN__PATH_DISTANCE_TOO_BIG_2 = 0x0010;
    var WARN__PATH_DISTANCE_TOO_SMALL_1 = 0x0020;
    var WARN__PATH_DISTANCE_TOO_SMALL_2 = 0x0040;
    var WARN__TX_HORIZON_ANGLE = 0x0080;
    var WARN__RX_HORIZON_ANGLE = 0x0100;
    var WARN__TX_HORIZON_DISTANCE_1 = 0x0200;
    var WARN__RX_HORIZON_DISTANCE_1 = 0x0400;
    var WARN__TX_HORIZON_DISTANCE_2 = 0x0800;
    var WARN__RX_HORIZON_DISTANCE_2 = 0x1000;
    var WARN__EXTREME_VARIABILITIES = 0x2000;
    var WARN__SURFACE_REFRACTIVITY = 0x4000;

    // =========================================================================
    // Complex number helpers
    // =========================================================================

    function cplx(re, im) {
        return { re: re, im: im };
    }

    function cplxAbs(c) {
        return Math.sqrt(c.re * c.re + c.im * c.im);
    }

    function cplxAdd(a, b) {
        return { re: a.re + b.re, im: a.im + b.im };
    }

    function cplxSub(a, b) {
        return { re: a.re - b.re, im: a.im - b.im };
    }

    function cplxMul(a, b) {
        return {
            re: a.re * b.re - a.im * b.im,
            im: a.re * b.im + a.im * b.re
        };
    }

    function cplxDiv(a, b) {
        var denom = b.re * b.re + b.im * b.im;
        return {
            re: (a.re * b.re + a.im * b.im) / denom,
            im: (a.im * b.re - a.re * b.im) / denom
        };
    }

    function cplxMulScalar(c, s) {
        return { re: c.re * s, im: c.im * s };
    }

    function cplxSqrt(c) {
        var r = cplxAbs(c);
        var arg = Math.atan2(c.im, c.re);
        var sr = Math.sqrt(r);
        return {
            re: sr * Math.cos(arg / 2),
            im: sr * Math.sin(arg / 2)
        };
    }

    function cplxExp(c) {
        var er = Math.exp(c.re);
        return {
            re: er * Math.cos(c.im),
            im: er * Math.sin(c.im)
        };
    }

    // =========================================================================
    // FreeSpaceLoss
    // =========================================================================

    function FreeSpaceLoss(d__meter, f__mhz) {
        return 32.45 + 20.0 * Math.log10(f__mhz) + 20.0 * Math.log10(d__meter / 1000.0);
    }

    // =========================================================================
    // FresnelIntegral
    // =========================================================================

    function FresnelIntegral(v2) {
        if (v2 < 5.76)
            return 6.02 + 9.11 * Math.sqrt(v2) - 1.27 * v2;
        else
            return 12.953 + 10 * Math.log10(v2);
    }

    // =========================================================================
    // SigmaHFunction
    // =========================================================================

    function SigmaHFunction(delta_h__meter) {
        return 0.78 * delta_h__meter * Math.exp(-0.5 * Math.pow(delta_h__meter, 0.25));
    }

    // =========================================================================
    // TerrainRoughness
    // =========================================================================

    function TerrainRoughness(d__meter, delta_h__meter) {
        return delta_h__meter * (1.0 - 0.8 * Math.exp(-d__meter / 50e3));
    }

    // =========================================================================
    // InverseComplementaryCumulativeDistributionFunction
    // =========================================================================

    function InverseComplementaryCumulativeDistributionFunction(q) {
        var C_0 = 2.515516;
        var C_1 = 0.802853;
        var C_2 = 0.010328;
        var D_1 = 1.432788;
        var D_2 = 0.189269;
        var D_3 = 0.001308;

        var x = q;
        if (q > 0.5) x = 1.0 - x;

        var T_x = Math.sqrt(-2.0 * Math.log(x));
        var zeta_x = ((C_2 * T_x + C_1) * T_x + C_0) / (((D_3 * T_x + D_2) * T_x + D_1) * T_x + 1.0);
        var Q_q = T_x - zeta_x;

        if (q > 0.5) Q_q = -Q_q;

        return Q_q;
    }

    // =========================================================================
    // LinearLeastSquaresFit
    // =========================================================================

    function LinearLeastSquaresFit(pfl, d_start, d_end) {
        var np = pfl[0] | 0;
        var i_start = (Math.max(0, d_start / pfl[1])) | 0;
        var i_end = np - (Math.max(0, np - d_end / pfl[1])) | 0;

        if (i_end <= i_start) {
            i_start = Math.max(0, i_start - 1) | 0;
            i_end = np - (Math.max(0, np - (i_end + 1))) | 0;
        }

        var x_length = i_end - i_start;
        var mid_shifted_index = -0.5 * x_length;
        var mid_shifted_end = i_end + mid_shifted_index;

        var sum_y = 0.5 * (pfl[i_start + 2] + pfl[i_end + 2]);
        var scaled_sum_y = 0.5 * (pfl[i_start + 2] - pfl[i_end + 2]) * mid_shifted_index;

        for (var i = 2; i <= x_length; i++) {
            i_start++;
            mid_shifted_index++;
            sum_y += pfl[i_start + 2];
            scaled_sum_y += pfl[i_start + 2] * mid_shifted_index;
        }

        sum_y = sum_y / x_length;
        scaled_sum_y = scaled_sum_y * 12.0 / ((x_length * x_length + 2.0) * x_length);

        var fit_y1 = sum_y - scaled_sum_y * mid_shifted_end;
        var fit_y2 = sum_y + scaled_sum_y * (np - mid_shifted_end);

        return { fit_y1: fit_y1, fit_y2: fit_y2 };
    }

    // =========================================================================
    // FindHorizons
    // =========================================================================

    function FindHorizons(pfl, a_e__meter, h__meter) {
        var np = pfl[0] | 0;
        var xi = pfl[1];
        var d__meter = pfl[0] * pfl[1];

        var z_tx__meter = pfl[2] + h__meter[0];
        var z_rx__meter = pfl[np + 2] + h__meter[1];

        var theta_hzn = [0, 0];
        var d_hzn__meter = [0, 0];

        theta_hzn[0] = (z_rx__meter - z_tx__meter) / d__meter - d__meter / (2 * a_e__meter);
        theta_hzn[1] = -(z_rx__meter - z_tx__meter) / d__meter - d__meter / (2 * a_e__meter);
        d_hzn__meter[0] = d__meter;
        d_hzn__meter[1] = d__meter;

        var d_tx__meter = 0.0;
        var d_rx__meter = d__meter;

        for (var i = 1; i < np; i++) {
            d_tx__meter += xi;
            d_rx__meter -= xi;

            var theta_tx = (pfl[i + 2] - z_tx__meter) / d_tx__meter - d_tx__meter / (2 * a_e__meter);
            var theta_rx = -(z_rx__meter - pfl[i + 2]) / d_rx__meter - d_rx__meter / (2 * a_e__meter);

            if (theta_tx > theta_hzn[0]) {
                theta_hzn[0] = theta_tx;
                d_hzn__meter[0] = d_tx__meter;
            }
            if (theta_rx > theta_hzn[1]) {
                theta_hzn[1] = theta_rx;
                d_hzn__meter[1] = d_rx__meter;
            }
        }

        return { theta_hzn: theta_hzn, d_hzn__meter: d_hzn__meter };
    }

    // =========================================================================
    // ComputeDeltaH
    // =========================================================================

    function ComputeDeltaH(pfl, d_start__meter, d_end__meter) {
        var np = pfl[0] | 0;

        var x_start = d_start__meter / pfl[1];
        var x_end = d_end__meter / pfl[1];

        if (x_end - x_start < 2.0) return 0;

        var p10 = (0.1 * (x_end - x_start + 8.0)) | 0;
        p10 = MIN(MAX(4, p10), 25);

        var n = 10 * p10 - 5;
        var p90 = n - p10;

        var np_s = n - 1;

        // s[] array: s[0] = np_s, s[1] = 1.0, s[2..n+1] = interpolated elevations
        var s = new Array(n + 2);
        s[0] = np_s;
        s[1] = 1.0;

        x_end = (x_end - x_start) / np_s;

        var i = x_start | 0;
        // float() cast in C++ — subtract (i+1)
        x_start -= (i + 1.0);

        for (var j = 0; j < n; j++) {
            while (x_start > 0.0 && (i + 1) < np) {
                x_start--;
                i++;
            }
            s[j + 2] = pfl[i + 3] + (pfl[i + 3] - pfl[i + 2]) * x_start;
            x_start += x_end;
        }

        // Linear least squares fit
        var lsq = LinearLeastSquaresFit(s, 0.0, np_s);
        var fit_y1 = lsq.fit_y1;
        var fit_y2 = lsq.fit_y2;

        fit_y2 = (fit_y2 - fit_y1) / np_s;

        // Compute diffs
        var diffs = new Array(n);
        for (var j = 0; j < n; j++) {
            diffs[j] = s[j + 2] - fit_y1;
            fit_y1 += fit_y2;
        }

        // nth_element with greater (descending) comparator:
        // sort descending, then index directly
        diffs.sort(function (a, b) { return b - a; });

        var q10 = diffs[p10 - 1];
        var q90 = diffs[p90];

        var delta_h_d__meter = q10 - q90;

        var delta_h__meter = delta_h_d__meter / (1.0 - 0.8 * Math.exp(-(d_end__meter - d_start__meter) / 50e3));

        return delta_h__meter;
    }

    // =========================================================================
    // QuickPfl
    // =========================================================================

    function QuickPfl(pfl, gamma_e, h__meter) {
        var d__meter = pfl[0] * pfl[1];
        var np = pfl[0] | 0;
        var a_e__meter = 1 / gamma_e;

        var hzn = FindHorizons(pfl, a_e__meter, h__meter);
        var theta_hzn = hzn.theta_hzn;
        var d_hzn__meter = hzn.d_hzn__meter;
        var h_e__meter = [0, 0];

        var d_start__meter = MIN(15.0 * h__meter[0], 0.1 * d_hzn__meter[0]);
        var d_end__meter = d__meter - MIN(15.0 * h__meter[1], 0.1 * d_hzn__meter[1]);

        var delta_h__meter = ComputeDeltaH(pfl, d_start__meter, d_end__meter);

        if (d_hzn__meter[0] + d_hzn__meter[1] > 1.5 * d__meter) {
            var lsq = LinearLeastSquaresFit(pfl, d_start__meter, d_end__meter);
            h_e__meter[0] = h__meter[0] + Math.max(0, pfl[2] - lsq.fit_y1);
            h_e__meter[1] = h__meter[1] + Math.max(0, pfl[np + 2] - lsq.fit_y2);

            for (var i = 0; i < 2; i++) {
                d_hzn__meter[i] = Math.sqrt(2.0 * h_e__meter[i] * a_e__meter) * Math.exp(-0.07 * Math.sqrt(delta_h__meter / MAX(h_e__meter[i], 5.0)));
            }

            var combined = d_hzn__meter[0] + d_hzn__meter[1];
            if (combined <= d__meter) {
                var q = Math.pow(d__meter / combined, 2);
                for (var i = 0; i < 2; i++) {
                    h_e__meter[i] *= q;
                    d_hzn__meter[i] = Math.sqrt(2.0 * h_e__meter[i] * a_e__meter) * Math.exp(-0.07 * Math.sqrt(delta_h__meter / MAX(h_e__meter[i], 5.0)));
                }
            }

            for (var i = 0; i < 2; i++) {
                var q = Math.sqrt(2.0 * h_e__meter[i] * a_e__meter);
                theta_hzn[i] = (0.65 * delta_h__meter * (q / d_hzn__meter[i] - 1.0) - 2.0 * h_e__meter[i]) / q;
            }
        } else {
            var r1 = LinearLeastSquaresFit(pfl, d_start__meter, 0.9 * d_hzn__meter[0]);
            h_e__meter[0] = h__meter[0] + Math.max(0, pfl[2] - r1.fit_y1);

            var r2 = LinearLeastSquaresFit(pfl, d__meter - 0.9 * d_hzn__meter[1], d_end__meter);
            h_e__meter[1] = h__meter[1] + Math.max(0, pfl[np + 2] - r2.fit_y2);
        }

        return {
            theta_hzn: theta_hzn,
            d_hzn__meter: d_hzn__meter,
            h_e__meter: h_e__meter,
            delta_h__meter: delta_h__meter,
            d__meter: d__meter
        };
    }

    // =========================================================================
    // InitializePointToPoint
    // =========================================================================

    function InitializePointToPoint(f__mhz, h_sys__meter, N_0, pol, epsilon, sigma) {
        var gamma_a = 157e-9;
        var N_s;

        if (h_sys__meter === 0.0)
            N_s = N_0;
        else
            N_s = N_0 * Math.exp(-h_sys__meter / 9460.0);

        var gamma_e = gamma_a * (1.0 - 0.04665 * Math.exp(N_s / 179.3));

        // ep_r = complex(epsilon, 18000 * sigma / f__mhz)
        var ep_r = cplx(epsilon, 18000 * sigma / f__mhz);

        // Z_g = sqrt(ep_r - 1.0)  (complex sqrt of complex value)
        var Z_g = cplxSqrt(cplxSub(ep_r, cplx(1.0, 0.0)));

        // if vertical polarization: Z_g = Z_g / ep_r
        if (pol === POLARIZATION__VERTICAL)
            Z_g = cplxDiv(Z_g, ep_r);

        return { Z_g: Z_g, gamma_e: gamma_e, N_s: N_s };
    }

    // =========================================================================
    // KnifeEdgeDiffraction
    // =========================================================================

    function KnifeEdgeDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter) {
        var d_ML__meter = d_hzn__meter[0] + d_hzn__meter[1];
        var theta_nlos = d__meter / a_e__meter - theta_los;
        var d_nlos__meter = d__meter - d_ML__meter;

        var v_1 = 0.0795775 * (f__mhz / 47.7) * Math.pow(theta_nlos, 2) * d_hzn__meter[0] * d_nlos__meter / (d_nlos__meter + d_hzn__meter[0]);
        var v_2 = 0.0795775 * (f__mhz / 47.7) * Math.pow(theta_nlos, 2) * d_hzn__meter[1] * d_nlos__meter / (d_nlos__meter + d_hzn__meter[1]);

        return FresnelIntegral(v_1) + FresnelIntegral(v_2);
    }

    // =========================================================================
    // HeightFunction
    // =========================================================================

    function HeightFunction(x__km, K) {
        var w, result;

        if (x__km < 200.0) {
            w = -Math.log(K);
            if (K < 1e-5 || x__km * Math.pow(w, 3) > 5495.0) {
                result = -117.0;
                if (x__km > 1.0)
                    result = 17.372 * Math.log(x__km) + result;
            } else {
                result = 2.5e-5 * Math.pow(x__km, 2) / K - 8.686 * w - 15.0;
            }
        } else {
            result = 0.05751 * x__km - 4.343 * Math.log(x__km);
            if (x__km < 2000) {
                w = 0.0134 * x__km * Math.exp(-0.005 * x__km);
                result = (1.0 - w) * result + w * (17.372 * Math.log(x__km) - 117.0);
            }
        }

        return result;
    }

    // =========================================================================
    // SmoothEarthDiffraction
    // =========================================================================

    function SmoothEarthDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter, h_e__meter, Z_g) {
        var a__meter = [0, 0, 0];
        var d__km = [0, 0, 0];
        var F_x__db = [0, 0];
        var K = [0, 0, 0];
        var B_0 = [0, 0, 0];
        var x__km = [0, 0, 0];
        var C_0 = [0, 0, 0];

        var theta_nlos = d__meter / a_e__meter - theta_los;
        var d_ML__meter = d_hzn__meter[0] + d_hzn__meter[1];

        a__meter[0] = (d__meter - d_ML__meter) / (d__meter / a_e__meter - theta_los);
        a__meter[1] = 0.5 * Math.pow(d_hzn__meter[0], 2) / h_e__meter[0];
        a__meter[2] = 0.5 * Math.pow(d_hzn__meter[1], 2) / h_e__meter[1];

        d__km[0] = (a__meter[0] * theta_nlos) / 1000.0;
        d__km[1] = d_hzn__meter[0] / 1000.0;
        d__km[2] = d_hzn__meter[1] / 1000.0;

        var absZ_g = cplxAbs(Z_g);

        for (var i = 0; i < 3; i++) {
            C_0[i] = Math.pow((4.0 / 3.0) * a_0__meter / a__meter[i], THIRD);
            K[i] = 0.017778 * C_0[i] * Math.pow(f__mhz, -THIRD) / absZ_g;
            B_0[i] = 1.607 - K[i];
        }

        x__km[1] = B_0[1] * Math.pow(C_0[1], 2) * Math.pow(f__mhz, THIRD) * d__km[1];
        x__km[2] = B_0[2] * Math.pow(C_0[2], 2) * Math.pow(f__mhz, THIRD) * d__km[2];
        x__km[0] = B_0[0] * Math.pow(C_0[0], 2) * Math.pow(f__mhz, THIRD) * d__km[0] + x__km[1] + x__km[2];

        F_x__db[0] = HeightFunction(x__km[1], K[1]);
        F_x__db[1] = HeightFunction(x__km[2], K[2]);

        var G_x__db = 0.05751 * x__km[0] - 10.0 * Math.log10(x__km[0]);

        return G_x__db - F_x__db[0] - F_x__db[1] - 20;
    }

    // =========================================================================
    // DiffractionLoss
    // =========================================================================

    function DiffractionLoss(d__meter, d_hzn__meter, h_e__meter, Z_g, a_e__meter,
        delta_h__meter, h__meter, mode, theta_los, d_sML__meter, f__mhz) {

        var A_k__db = KnifeEdgeDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter);
        var A_se__db = SmoothEarthDiffraction(d__meter, f__mhz, a_e__meter, theta_los, d_hzn__meter, h_e__meter, Z_g);

        var delta_h_dsML__meter = TerrainRoughness(d_sML__meter, delta_h__meter);
        var sigma_h_d__meter = SigmaHFunction(delta_h_dsML__meter);

        var A_fo__db = MIN(15.0, 5 * Math.log10(1.0 + 1e-5 * h__meter[0] * h__meter[1] * f__mhz * sigma_h_d__meter));

        var delta_h_d__meter = TerrainRoughness(d__meter, delta_h__meter);

        var q = h__meter[0] * h__meter[1];
        var qk = h_e__meter[0] * h_e__meter[1] - q;

        if (mode === MODE__P2P)
            q += 10.0;

        var term1 = Math.sqrt(1.0 + qk / q);

        var d_ML__meter = d_hzn__meter[0] + d_hzn__meter[1];

        q = (term1 + (-theta_los * a_e__meter + d_ML__meter) / d__meter) * MIN(delta_h_d__meter * f__mhz / 47.7, 6283.2);

        var w = 25.1 / (25.1 + Math.sqrt(q));

        return w * A_se__db + (1.0 - w) * A_k__db + A_fo__db;
    }

    // =========================================================================
    // LineOfSightLoss
    // =========================================================================

    function LineOfSightLoss(d__meter, h_e__meter, Z_g, delta_h__meter,
        M_d, A_d0, d_sML__meter, f__mhz) {

        var delta_h_d__meter = TerrainRoughness(d__meter, delta_h__meter);
        var sigma_h_d__meter = SigmaHFunction(delta_h_d__meter);

        var wn = f__mhz / 47.7;
        var sin_psi = (h_e__meter[0] + h_e__meter[1]) / Math.sqrt(Math.pow(d__meter, 2) + Math.pow(h_e__meter[0] + h_e__meter[1], 2));

        // R_e = (sin_psi - Z_g) / (sin_psi + Z_g) * exp(-MIN(10.0, wn * sigma_h_d__meter * sin_psi))
        // sin_psi is real, Z_g is complex
        var num = cplxSub(cplx(sin_psi, 0), Z_g);       // (sin_psi - Z_g)
        var den = cplxAdd(cplx(sin_psi, 0), Z_g);       // (sin_psi + Z_g)
        var ratio = cplxDiv(num, den);
        var expFactor = Math.exp(-MIN(10.0, wn * sigma_h_d__meter * sin_psi));
        var R_e = cplxMulScalar(ratio, expFactor);

        var q = R_e.re * R_e.re + R_e.im * R_e.im;
        if (q < 0.25 || q < sin_psi)
            R_e = cplxMulScalar(R_e, Math.sqrt(sin_psi / q));

        var delta_phi = wn * 2.0 * h_e__meter[0] * h_e__meter[1] / d__meter;
        if (delta_phi > PI / 2.0)
            delta_phi = PI - Math.pow(PI / 2.0, 2) / delta_phi;

        // rr = complex(cos(delta_phi), -sin(delta_phi)) + R_e
        var rr = cplxAdd(cplx(Math.cos(delta_phi), -Math.sin(delta_phi)), R_e);

        var A_t__db = -10 * Math.log10(rr.re * rr.re + rr.im * rr.im);
        var A_d__db = M_d * d__meter + A_d0;

        var w = 1 / (1 + f__mhz * delta_h__meter / MAX(10e3, d_sML__meter));

        return w * A_t__db + (1 - w) * A_d__db;
    }

    // =========================================================================
    // H0Curve and H0Function
    // =========================================================================

    function H0Curve(j, r) {
        var a = [25.0, 80.0, 177.0, 395.0, 705.0];
        var b = [24.0, 45.0, 68.0, 80.0, 105.0];
        return 10 * Math.log10(1 + a[j] * Math.pow(1 / r, 4) + b[j] * Math.pow(1.0 / r, 2));
    }

    function H0Function(r, eta_s) {
        eta_s = MIN(MAX(eta_s, 1), 5);

        var i = (eta_s | 0);  // int cast
        var q = eta_s - i;

        var result = H0Curve(i - 1, r);
        if (q !== 0.0)
            result = (1.0 - q) * result + q * H0Curve(i, r);

        return result;
    }

    // =========================================================================
    // FFunction
    // =========================================================================

    function FFunction(td) {
        var a = [133.4, 104.6, 71.8];
        var b = [0.332e-3, 0.212e-3, 0.157e-3];
        var c = [-10, -2.5, 5];

        var i;
        if (td <= 10e3)
            i = 0;
        else if (td <= 70e3)
            i = 1;
        else
            i = 2;

        return a[i] + b[i] * td + c[i] * Math.log10(td);
    }

    // =========================================================================
    // TroposcatterLoss
    // =========================================================================

    function TroposcatterLoss(d__meter, theta_hzn, d_hzn__meter, h_e__meter,
        a_e__meter, N_s, f__mhz, theta_los, h0Ref) {

        var H_0;
        var wn = f__mhz / 47.7;

        if (h0Ref.value > 15.0) {
            H_0 = h0Ref.value;
        } else {
            var ad = d_hzn__meter[0] - d_hzn__meter[1];
            var rr = h_e__meter[1] / h_e__meter[0];

            if (ad < 0.0) {
                ad = -ad;
                rr = 1.0 / rr;
            }

            var theta = theta_hzn[0] + theta_hzn[1] + d__meter / a_e__meter;
            var r_1 = 2.0 * wn * theta * h_e__meter[0];
            var r_2 = 2.0 * wn * theta * h_e__meter[1];

            if (r_1 < 0.2 && r_2 < 0.2)
                return 1001;

            var s = (d__meter - ad) / (d__meter + ad);
            var q = MIN(MAX(0.1, rr / s), 10.0);
            s = MAX(0.1, s);

            var h_0__meter = (d__meter - ad) * (d__meter + ad) * theta * 0.25 / d__meter;

            var Z_0__meter = 1.7556e3;
            var Z_1__meter = 8.0e3;

            var eta_s = (h_0__meter / Z_0__meter) * (1.0 + (0.031 - N_s * 2.32e-3 + Math.pow(N_s, 2) * 5.67e-6) * Math.exp(-Math.pow(MIN(1.7, h_0__meter / Z_1__meter), 6)));

            var H_00 = (H0Function(r_1, eta_s) + H0Function(r_2, eta_s)) / 2;

            var Delta_H_0 = MIN(H_00, 6.0 * (0.6 - Math.log10(MAX(eta_s, 1.0))) * Math.log10(s) * Math.log10(q));

            H_0 = H_00 + Delta_H_0;
            H_0 = MAX(H_0, 0.0);

            if (eta_s < 1.0)
                H_0 = eta_s * H_0 + (1.0 - eta_s) * 10 * Math.log10(Math.pow((1.0 + SQRT2 / r_1) * (1.0 + SQRT2 / r_2), 2) * (r_1 + r_2) / (r_1 + r_2 + 2 * SQRT2));

            if (H_0 > 15.0 && h0Ref.value >= 0.0)
                H_0 = h0Ref.value;
        }

        h0Ref.value = H_0;

        var th = d__meter / a_e__meter - theta_los;
        var D_0__meter = 40e3;
        var H__meter = 47.7;

        return FFunction(th * d__meter) + 10 * Math.log10(wn * H__meter * Math.pow(th, 4)) - 0.1 * (N_s - 301.0) * Math.exp(-th * d__meter / D_0__meter) + H_0;
    }

    // =========================================================================
    // LongleyRice
    // =========================================================================

    function LongleyRice(theta_hzn, f__mhz, Z_g, d_hzn__meter,
        h_e__meter, gamma_e, N_s, delta_h__meter, h__meter,
        d__meter, mode, warningsRef) {

        var propmode = MODE__NOT_SET;
        var A_ref__db = 0;

        // effective earth radius
        var a_e__meter = 1 / gamma_e;

        var d_hzn_s__meter = [0, 0];
        // Terrestrial smooth earth horizon distance approximation
        for (var i = 0; i < 2; i++)
            d_hzn_s__meter[i] = Math.sqrt(2.0 * h_e__meter[i] * a_e__meter);

        // Maximum line-of-sight distance for smooth earth
        var d_sML__meter = d_hzn_s__meter[0] + d_hzn_s__meter[1];

        // Maximum line-of-sight distance for actual path
        var d_ML__meter = d_hzn__meter[0] + d_hzn__meter[1];

        // Angular distance of line-of-sight region
        var theta_los = -MAX(theta_hzn[0] + theta_hzn[1], -d_ML__meter / a_e__meter);

        // Check validity of small angle approximation
        if (Math.abs(theta_hzn[0]) > 200e-3)
            warningsRef.value |= WARN__TX_HORIZON_ANGLE;
        if (Math.abs(theta_hzn[1]) > 200e-3)
            warningsRef.value |= WARN__RX_HORIZON_ANGLE;

        // Checks that the actual horizon distance can't be less than 1/10 of the smooth earth horizon distance
        if (d_hzn__meter[0] < 0.1 * d_hzn_s__meter[0])
            warningsRef.value |= WARN__TX_HORIZON_DISTANCE_1;
        if (d_hzn__meter[1] < 0.1 * d_hzn_s__meter[1])
            warningsRef.value |= WARN__RX_HORIZON_DISTANCE_1;

        // Checks that the actual horizon distance can't be greater than 3 times the smooth earth horizon distance
        if (d_hzn__meter[0] > 3.0 * d_hzn_s__meter[0])
            warningsRef.value |= WARN__TX_HORIZON_DISTANCE_2;
        if (d_hzn__meter[1] > 3.0 * d_hzn_s__meter[1])
            warningsRef.value |= WARN__RX_HORIZON_DISTANCE_2;

        // Check the surface refractivity
        if (N_s < 150)
            return { error: ERROR__SURFACE_REFRACTIVITY_SMALL, A_ref__db: 0, propmode: propmode };
        if (N_s > 400)
            return { error: ERROR__SURFACE_REFRACTIVITY_LARGE, A_ref__db: 0, propmode: propmode };
        if (N_s < 250) // 150 <= N_s < 250
            warningsRef.value |= WARN__SURFACE_REFRACTIVITY;

        // Check effective earth size
        if (a_e__meter < 4000000 || a_e__meter > 13333333)
            return { error: ERROR__EFFECTIVE_EARTH, A_ref__db: 0, propmode: propmode };

        // Check ground impedance
        if (Z_g.re <= Math.abs(Z_g.im))
            return { error: ERROR__GROUND_IMPEDANCE, A_ref__db: 0, propmode: propmode };

        // Select two distances far in the diffraction region
        var d_3__meter = MAX(d_sML__meter, d_ML__meter + 5.0 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, 1.0 / 3.0));
        var d_4__meter = d_3__meter + 10.0 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, 1.0 / 3.0);

        // Compute the diffraction loss at the two distances
        var A_3__db = DiffractionLoss(d_3__meter, d_hzn__meter, h_e__meter, Z_g, a_e__meter, delta_h__meter, h__meter, mode, theta_los, d_sML__meter, f__mhz);
        var A_4__db = DiffractionLoss(d_4__meter, d_hzn__meter, h_e__meter, Z_g, a_e__meter, delta_h__meter, h__meter, mode, theta_los, d_sML__meter, f__mhz);

        // Compute the slope and intercept of the diffraction line
        var M_d = (A_4__db - A_3__db) / (d_4__meter - d_3__meter);
        var A_d0__db = A_3__db - M_d * d_3__meter;

        var d_min__meter = Math.abs(h_e__meter[0] - h_e__meter[1]) / 200e-3;

        if (d__meter < d_min__meter)
            warningsRef.value |= WARN__PATH_DISTANCE_TOO_SMALL_1;
        if (d__meter < 1e3)
            warningsRef.value |= WARN__PATH_DISTANCE_TOO_SMALL_2;
        if (d__meter > 1000e3)
            warningsRef.value |= WARN__PATH_DISTANCE_TOO_BIG_1;
        if (d__meter > 2000e3)
            warningsRef.value |= WARN__PATH_DISTANCE_TOO_BIG_2;

        // if the path distance is less than the maximum smooth earth line of sight distance...
        if (d__meter < d_sML__meter) {
            // Compute the diffraction loss at the maximum smooth earth line of sight distance
            var A_sML__db = d_sML__meter * M_d + A_d0__db;

            // [ERL 79-ITS 67, Eqn 3.16a], in meters instead of km and with MIN() part below
            var d_0__meter = 0.04 * f__mhz * h_e__meter[0] * h_e__meter[1];

            var d_1__meter;
            if (A_d0__db >= 0.0) {
                d_0__meter = MIN(d_0__meter, 0.5 * d_ML__meter);                // other part of [ERL 79-ITS 67, Eqn 3.16a]
                d_1__meter = d_0__meter + 0.25 * (d_ML__meter - d_0__meter);    // [ERL 79-ITS 67, Eqn 3.16d]
            } else {
                d_1__meter = MAX(-A_d0__db / M_d, 0.25 * d_ML__meter);
            }

            var A_1__db = LineOfSightLoss(d_1__meter, h_e__meter, Z_g, delta_h__meter, M_d, A_d0__db, d_sML__meter, f__mhz);

            var flag = false;

            var kHat_1__db_per_meter = 0;
            var kHat_2__db_per_meter = 0;

            if (d_0__meter < d_1__meter) {
                var A_0__db = LineOfSightLoss(d_0__meter, h_e__meter, Z_g, delta_h__meter, M_d, A_d0__db, d_sML__meter, f__mhz);

                var q = Math.log(d_sML__meter / d_0__meter);

                // [ERL 79-ITS 67, Eqn 3.20]
                kHat_2__db_per_meter = MAX(0.0, ((d_sML__meter - d_0__meter) * (A_1__db - A_0__db) - (d_1__meter - d_0__meter) * (A_sML__db - A_0__db)) / ((d_sML__meter - d_0__meter) * Math.log(d_1__meter / d_0__meter) - (d_1__meter - d_0__meter) * q));

                flag = A_d0__db > 0.0 || kHat_2__db_per_meter > 0.0;

                if (flag) {
                    // [ERL 79-ITS 67, Eqn 3.21]
                    kHat_1__db_per_meter = (A_sML__db - A_0__db - kHat_2__db_per_meter * q) / (d_sML__meter - d_0__meter);

                    if (kHat_1__db_per_meter < 0.0) {
                        kHat_1__db_per_meter = 0.0;
                        kHat_2__db_per_meter = DIM(A_sML__db, A_0__db) / q;

                        if (kHat_2__db_per_meter === 0.0)
                            kHat_1__db_per_meter = M_d;
                    }
                }
            }

            if (!flag) {
                kHat_1__db_per_meter = DIM(A_sML__db, A_1__db) / (d_sML__meter - d_1__meter);
                kHat_2__db_per_meter = 0.0;

                if (kHat_1__db_per_meter === 0.0)
                    kHat_1__db_per_meter = M_d;
            }

            var A_o__db = A_sML__db - kHat_1__db_per_meter * d_sML__meter - kHat_2__db_per_meter * Math.log(d_sML__meter);

            // [ERL 79-ITS 67, Eqn 3.19]
            A_ref__db = A_o__db + kHat_1__db_per_meter * d__meter + kHat_2__db_per_meter * Math.log(d__meter);
            propmode = MODE__LINE_OF_SIGHT;
        } else {
            // this is a trans-horizon path

            // select two points far into the troposcatter region
            var d_5__meter = d_ML__meter + 200e3;
            var d_6__meter = d_ML__meter + 400e3;

            // Compute the troposcatter loss at the two distances
            var h0Ref = { value: -1 };
            var A_6__db = TroposcatterLoss(d_6__meter, theta_hzn, d_hzn__meter, h_e__meter, a_e__meter, N_s, f__mhz, theta_los, h0Ref);
            var A_5__db = TroposcatterLoss(d_5__meter, theta_hzn, d_hzn__meter, h_e__meter, a_e__meter, N_s, f__mhz, theta_los, h0Ref);

            var M_s, A_s0__db, d_x__meter;

            // if we got a reasonable prediction value back...
            if (A_5__db < 1000.0) {
                // Compute the slope of the troposcatter line
                M_s = (A_6__db - A_5__db) / 200e3;

                // Find the diffraction-troposcatter transition distance
                d_x__meter = MAX(MAX(d_sML__meter, d_ML__meter + 1.088 * Math.pow(Math.pow(a_e__meter, 2) / f__mhz, 1.0 / 3.0) * Math.log(f__mhz)), (A_5__db - A_d0__db - M_s * d_5__meter) / (M_d - M_s));

                // Compute the intercept of the troposcatter line
                A_s0__db = (M_d - M_s) * d_x__meter + A_d0__db;
            } else {
                // troposcatter gives no real results - so use diffraction line parameters for tropo line
                M_s = M_d;
                A_s0__db = A_d0__db;
                d_x__meter = 10e6;
            }

            // Determine if its diffraction or troposcatter and compute the loss
            if (d__meter > d_x__meter) {
                A_ref__db = M_s * d__meter + A_s0__db;
                propmode = MODE__TROPOSCATTER;
            } else {
                A_ref__db = M_d * d__meter + A_d0__db;
                propmode = MODE__DIFFRACTION;
            }
        }

        // Don't allow a negative loss
        A_ref__db = MAX(A_ref__db, 0.0);

        return { error: SUCCESS, A_ref__db: A_ref__db, propmode: propmode };
    }

    // =========================================================================
    // Curve (helper for Variability)
    // =========================================================================

    function Curve(c1, c2, x1, x2, x3, d_e__meter) {
        return (c1 + c2 / (1.0 + Math.pow((d_e__meter - x2) / x3, 2))) * (Math.pow(d_e__meter / x1, 2)) / (1.0 + (Math.pow(d_e__meter / x1, 2)));
    }

    // =========================================================================
    // Variability
    // =========================================================================

    function Variability(time, location, situation, h_e__meter, delta_h__meter,
        f__mhz, d__meter, A_ref__db, climate, mdvar, warningsRef) {

        // Asymptotic values from TN101, Fig 10.13
        var all_year = [
            [-9.67,   -0.62,    1.26,   -9.21,   -0.62,   -0.39,      3.15],
            [12.7,     9.19,   15.5,     9.05,    9.19,    2.86,   857.9],
            [144.9e3, 228.9e3, 262.6e3,  84.1e3, 228.9e3, 141.7e3, 2222.e3],
            [190.3e3, 205.2e3, 185.2e3, 101.1e3, 205.2e3, 315.9e3,  164.8e3],
            [133.8e3, 143.6e3,  99.8e3,  98.6e3, 143.6e3, 167.4e3,  116.3e3]
        ];

        var bsm1 = [2.13,      2.66,    6.11,     1.98,   2.68,    6.86,    8.51];
        var bsm2 = [159.5,     7.67,    6.65,    13.11,   7.16,   10.38,  169.8];
        var xsm1 = [762.2e3, 100.4e3, 138.2e3, 139.1e3,  93.7e3, 187.8e3, 609.8e3];
        var xsm2 = [123.6e3, 172.5e3, 242.2e3, 132.7e3, 186.8e3, 169.6e3, 119.9e3];
        var xsm3 = [94.5e3,  136.4e3, 178.6e3, 193.5e3, 133.5e3, 108.9e3, 106.6e3];

        var bsp1 = [2.11, 6.87, 10.08, 3.68, 4.75, 8.58, 8.43];
        var bsp2 = [102.3, 15.53, 9.60, 159.3, 8.12, 13.97, 8.19];
        var xsp1 = [636.9e3, 138.7e3, 165.3e3, 464.4e3, 93.2e3, 216.0e3, 136.2e3];
        var xsp2 = [134.8e3, 143.7e3, 225.7e3, 93.1e3, 135.9e3, 152.0e3, 188.5e3];
        var xsp3 = [95.6e3, 98.6e3, 129.7e3, 94.2e3, 113.4e3, 122.7e3, 122.9e3];

        var C_D = [1.224, 0.801, 1.380, 1.000, 1.224, 1.518, 1.518];
        var z_D = [1.282, 2.161, 1.282, 20.0, 1.282, 1.282, 1.282];

        var bfm1 = [1.0, 1.0, 1.0, 1.0, 0.92, 1.0, 1.0];
        var bfm2 = [0.0, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0];
        var bfm3 = [0.0, 0.0, 0.0, 0.0, 1.77, 0.0, 0.0];

        var bfp1 = [1.0, 0.93, 1.0, 0.93, 0.93, 1.0, 1.0];
        var bfp2 = [0.0, 0.31, 0.0, 0.19, 0.31, 0.0, 0.0];
        var bfp3 = [0.0, 2.00, 0.0, 1.79, 2.00, 0.0, 0.0];

        var z_T = InverseComplementaryCumulativeDistributionFunction(time / 100);
        var z_L = InverseComplementaryCumulativeDistributionFunction(location / 100);
        var z_S = InverseComplementaryCumulativeDistributionFunction(situation / 100);

        var climate_idx = climate; // Create an internal copy for modification
        climate_idx--; // 0-based indexes

        var wn = f__mhz / 47.7;

        // compute the effective distance
        var d_ex__meter = Math.sqrt(2 * a_9000__meter * h_e__meter[0]) + Math.sqrt(2 * a_9000__meter * h_e__meter[1]) + Math.pow((575.7e12 / wn), THIRD);

        var d_e__meter;
        if (d__meter < d_ex__meter)
            d_e__meter = 130e3 * d__meter / d_ex__meter;
        else
            d_e__meter = 130e3 + d__meter - d_ex__meter;

        //////////////////////////////////
        // situation variability calcs

        var mdvar_internal = mdvar;  // Create an internal copy to modify
        var plus20 = mdvar_internal >= 20;
        if (plus20)
            mdvar_internal -= 20;

        var sigma_S;
        if (plus20)
            sigma_S = 0.0;
        else {
            var D__meter = 100e3;                                // Scale distance, D = 100 km
            sigma_S = 5.0 + 3.0 * Math.exp(-d_e__meter / D__meter);      // [Algorithm, Eqn 5.10]
        }

        //
        //////////////////////////////////

        var plus10 = mdvar_internal >= 10;
        if (plus10)
            mdvar_internal -= 10;

        var V_med__db = Curve(all_year[0][climate_idx], all_year[1][climate_idx], all_year[2][climate_idx], all_year[3][climate_idx], all_year[4][climate_idx], d_e__meter);

        if (mdvar_internal === SINGLE_MESSAGE_MODE) {
            z_T = z_S;
            z_L = z_S;
        } else if (mdvar_internal === ACCIDENTAL_MODE) {
            z_L = z_S;
        } else if (mdvar_internal === MOBILE_MODE) {
            z_L = z_T;
        }
        // else using Broadcast Mode (no additional operations)

        if (Math.abs(z_T) > 3.10 || Math.abs(z_L) > 3.10 || Math.abs(z_S) > 3.10)
            warningsRef.value |= WARN__EXTREME_VARIABILITIES;

        //////////////////////////////////
        // location variability calcs

        var sigma_L;
        if (plus10)
            sigma_L = 0.0;
        else {
            var delta_h_d__meter = TerrainRoughness(d__meter, delta_h__meter);
            sigma_L = 10.0 * wn * delta_h_d__meter / (wn * delta_h_d__meter + 13.0);
        }
        var Y_L = sigma_L * z_L;

        //
        //////////////////////////////////

        //////////////////////////////////
        // time variability calcs

        var q = Math.log(0.133 * wn);
        var g_minus = bfm1[climate_idx] + bfm2[climate_idx] / (Math.pow(bfm3[climate_idx] * q, 2) + 1.0);
        var g_plus = bfp1[climate_idx] + bfp2[climate_idx] / (Math.pow(bfp3[climate_idx] * q, 2) + 1.0);

        var sigma_T_minus = Curve(bsm1[climate_idx], bsm2[climate_idx], xsm1[climate_idx], xsm2[climate_idx], xsm3[climate_idx], d_e__meter) * g_minus;
        var sigma_T_plus = Curve(bsp1[climate_idx], bsp2[climate_idx], xsp1[climate_idx], xsp2[climate_idx], xsp3[climate_idx], d_e__meter) * g_plus;

        var sigma_TD = C_D[climate_idx] * sigma_T_plus;
        var tgtd = (sigma_T_plus - sigma_TD) * z_D[climate_idx];

        var sigma_T;
        if (z_T < 0.0)
            sigma_T = sigma_T_minus;
        else if (z_T <= z_D[climate_idx])
            sigma_T = sigma_T_plus;
        else
            sigma_T = sigma_TD + tgtd / z_T;
        var Y_T = sigma_T * z_T;

        //
        /////////////////////////////////

        var Y_S_temp = Math.pow(sigma_S, 2) + Math.pow(Y_T, 2) / (7.8 + Math.pow(z_S, 2)) + Math.pow(Y_L, 2) / (24.0 + Math.pow(z_S, 2));

        var Y_R, Y_S;
        if (mdvar_internal === SINGLE_MESSAGE_MODE) {
            Y_R = 0.0;
            Y_S = Math.sqrt(Math.pow(sigma_T, 2) + Math.pow(sigma_L, 2) + Y_S_temp) * z_S;
        } else if (mdvar_internal === ACCIDENTAL_MODE) {
            Y_R = Y_T;
            Y_S = Math.sqrt(Math.pow(sigma_L, 2) + Y_S_temp) * z_S;
        } else if (mdvar_internal === MOBILE_MODE) {
            Y_R = Math.sqrt(Math.pow(sigma_T, 2) + Math.pow(sigma_L, 2)) * z_T;
            Y_S = Math.sqrt(Y_S_temp) * z_S;
        } else { // BROADCAST_MODE
            Y_R = Y_T + Y_L;
            Y_S = Math.sqrt(Y_S_temp) * z_S;
        }

        var result = A_ref__db - V_med__db - Y_R - Y_S;

        // [Algorithm, Eqn 52]
        if (result < 0.0)
            result = result * (29.0 - result) / (29.0 - 10.0 * result);

        return result;
    }

    // =========================================================================
    // ValidateInputs
    // =========================================================================

    function ValidateInputs(h_tx__meter, h_rx__meter, climate, time,
        location, situation, N_0, f__mhz, pol,
        epsilon, sigma, mdvar, warningsRef) {

        if (h_tx__meter < 1.0 || h_tx__meter > 1000.0)
            warningsRef.value |= WARN__TX_TERMINAL_HEIGHT;

        if (h_tx__meter < 0.5 || h_tx__meter > 3000.0)
            return ERROR__TX_TERMINAL_HEIGHT;

        if (h_rx__meter < 1.0 || h_rx__meter > 1000.0)
            warningsRef.value |= WARN__RX_TERMINAL_HEIGHT;

        if (h_rx__meter < 0.5 || h_rx__meter > 3000.0)
            return ERROR__RX_TERMINAL_HEIGHT;

        if (climate !== CLIMATE__EQUATORIAL &&
            climate !== CLIMATE__CONTINENTAL_SUBTROPICAL &&
            climate !== CLIMATE__MARITIME_SUBTROPICAL &&
            climate !== CLIMATE__DESERT &&
            climate !== CLIMATE__CONTINENTAL_TEMPERATE &&
            climate !== CLIMATE__MARITIME_TEMPERATE_OVER_LAND &&
            climate !== CLIMATE__MARITIME_TEMPERATE_OVER_SEA)
            return ERROR__INVALID_RADIO_CLIMATE;

        if (N_0 < 250 || N_0 > 400)
            return ERROR__REFRACTIVITY;

        if (f__mhz < 40.0 || f__mhz > 10000.0)
            warningsRef.value |= WARN__FREQUENCY;

        if (f__mhz < 20 || f__mhz > 20000)
            return ERROR__FREQUENCY;

        if (pol !== POLARIZATION__HORIZONTAL &&
            pol !== POLARIZATION__VERTICAL)
            return ERROR__POLARIZATION;

        if (epsilon < 1)
            return ERROR__EPSILON;

        if (sigma <= 0)
            return ERROR__SIGMA;

        if ((mdvar < 0) ||
            (mdvar > 3 && mdvar < 10) ||
            (mdvar > 13 && mdvar < 20) ||
            (mdvar > 23 && mdvar < 30) ||
            (mdvar > 33))
            return ERROR__MDVAR;

        if (situation <= 0 || situation >= 100)
            return ERROR__INVALID_SITUATION;

        if (time <= 0 || time >= 100)
            return ERROR__INVALID_TIME;

        if (location <= 0 || location >= 100)
            return ERROR__INVALID_LOCATION;

        return SUCCESS;
    }

    // =========================================================================
    // ITM_P2P_TLS — Main entry point
    // =========================================================================

    function ITM_P2P_TLS(h_tx__meter, h_rx__meter, pfl, climate, N_0, f__mhz,
        pol, epsilon, sigma, mdvar, time, location, situation) {

        var warningsRef = { value: NO_WARNINGS };
        var intermediateValues = {};

        // initial input validation check
        var rtn = ValidateInputs(h_tx__meter, h_rx__meter, climate, time, location, situation, N_0, f__mhz, pol, epsilon, sigma, mdvar, warningsRef);
        if (rtn !== SUCCESS)
            return { A__db: 0, warnings: warningsRef.value, error: rtn, intermediateValues: intermediateValues };

        intermediateValues.d__km = (pfl[0] * pfl[1]) / 1000;

        var np = pfl[0] | 0;     // number of points in the pfl

        // compute the average path height, ignoring first and last 10%
        var p10 = (0.1 * np) | 0;
        var h_sys__meter = 0;

        for (var i = p10; i <= np - p10; i++)
            h_sys__meter += pfl[i + 2];

        h_sys__meter = h_sys__meter / (np - 2 * p10 + 1);

        var init = InitializePointToPoint(f__mhz, h_sys__meter, N_0, pol, epsilon, sigma);
        var Z_g = init.Z_g;
        var gamma_e = init.gamma_e;
        var N_s = init.N_s;

        var h__meter = [h_tx__meter, h_rx__meter];
        var qpfl = QuickPfl(pfl, gamma_e, h__meter);
        var theta_hzn = qpfl.theta_hzn;
        var d_hzn__meter = qpfl.d_hzn__meter;
        var h_e__meter = qpfl.h_e__meter;
        var delta_h__meter = qpfl.delta_h__meter;
        var d__meter = qpfl.d__meter;

        // Reference attenuation, in dB
        var lr = LongleyRice(theta_hzn, f__mhz, Z_g, d_hzn__meter, h_e__meter, gamma_e, N_s, delta_h__meter, h__meter, d__meter, MODE__P2P, warningsRef);

        if (lr.error !== SUCCESS)
            return { A__db: 0, warnings: warningsRef.value, error: lr.error, intermediateValues: intermediateValues };

        var A_ref__db = lr.A_ref__db;
        var propmode = lr.propmode;

        var A_fs__db = FreeSpaceLoss(d__meter, f__mhz);

        var A__db = Variability(time, location, situation, h_e__meter, delta_h__meter, f__mhz, d__meter, A_ref__db, climate, mdvar, warningsRef) + A_fs__db;

        // Save off intermediate values
        intermediateValues.A_ref__db = A_ref__db;
        intermediateValues.A_fs__db = A_fs__db;
        intermediateValues.delta_h__meter = delta_h__meter;
        intermediateValues.d_hzn__meter = [d_hzn__meter[0], d_hzn__meter[1]];
        intermediateValues.h_e__meter = [h_e__meter[0], h_e__meter[1]];
        intermediateValues.N_s = N_s;
        intermediateValues.theta_hzn = [theta_hzn[0], theta_hzn[1]];
        intermediateValues.mode = propmode;

        var error = SUCCESS;
        if (warningsRef.value !== NO_WARNINGS)
            error = SUCCESS_WITH_WARNINGS;

        return {
            A__db: A__db,
            warnings: warningsRef.value,
            error: error,
            intermediateValues: intermediateValues
        };
    }

    // =========================================================================
    // ITM_P2P_CR — Confidence/Reliability entry point
    // =========================================================================

    function ITM_P2P_CR(h_tx__meter, h_rx__meter, pfl, climate, N_0, f__mhz,
        pol, epsilon, sigma, mdvar, confidence, reliability) {

        var result = ITM_P2P_TLS(h_tx__meter, h_rx__meter, pfl, climate, N_0, f__mhz,
            pol, epsilon, sigma, mdvar, reliability, 50, confidence);

        // convert TLS error codes for time and situation into CR error codes
        if (result.error === ERROR__INVALID_TIME)
            result.error = ERROR__INVALID_RELIABILITY;
        if (result.error === ERROR__INVALID_SITUATION)
            result.error = ERROR__INVALID_CONFIDENCE;

        return result;
    }

    // =========================================================================
    // Export
    // =========================================================================

    var ITM = {
        // Main entry points
        ITM_P2P_TLS: ITM_P2P_TLS,
        ITM_P2P_CR: ITM_P2P_CR,

        // Helper functions (exposed for testing / advanced use)
        FreeSpaceLoss: FreeSpaceLoss,
        FresnelIntegral: FresnelIntegral,
        SigmaHFunction: SigmaHFunction,
        TerrainRoughness: TerrainRoughness,
        InverseComplementaryCumulativeDistributionFunction: InverseComplementaryCumulativeDistributionFunction,
        LinearLeastSquaresFit: LinearLeastSquaresFit,
        FindHorizons: FindHorizons,
        ComputeDeltaH: ComputeDeltaH,
        QuickPfl: QuickPfl,
        InitializePointToPoint: InitializePointToPoint,
        KnifeEdgeDiffraction: KnifeEdgeDiffraction,
        HeightFunction: HeightFunction,
        SmoothEarthDiffraction: SmoothEarthDiffraction,
        DiffractionLoss: DiffractionLoss,
        LineOfSightLoss: LineOfSightLoss,
        H0Curve: H0Curve,
        H0Function: H0Function,
        FFunction: FFunction,
        TroposcatterLoss: TroposcatterLoss,
        LongleyRice: LongleyRice,
        Curve: Curve,
        Variability: Variability,
        ValidateInputs: ValidateInputs,

        // Complex number utilities
        cplx: cplx,
        cplxAbs: cplxAbs,
        cplxAdd: cplxAdd,
        cplxSub: cplxSub,
        cplxMul: cplxMul,
        cplxDiv: cplxDiv,
        cplxMulScalar: cplxMulScalar,
        cplxSqrt: cplxSqrt,
        cplxExp: cplxExp,

        // Error codes
        SUCCESS: SUCCESS,
        NO_WARNINGS: NO_WARNINGS,
        SUCCESS_WITH_WARNINGS: SUCCESS_WITH_WARNINGS,
        ERROR__TX_TERMINAL_HEIGHT: ERROR__TX_TERMINAL_HEIGHT,
        ERROR__RX_TERMINAL_HEIGHT: ERROR__RX_TERMINAL_HEIGHT,
        ERROR__INVALID_RADIO_CLIMATE: ERROR__INVALID_RADIO_CLIMATE,
        ERROR__INVALID_TIME: ERROR__INVALID_TIME,
        ERROR__INVALID_LOCATION: ERROR__INVALID_LOCATION,
        ERROR__INVALID_SITUATION: ERROR__INVALID_SITUATION,
        ERROR__INVALID_CONFIDENCE: ERROR__INVALID_CONFIDENCE,
        ERROR__INVALID_RELIABILITY: ERROR__INVALID_RELIABILITY,
        ERROR__REFRACTIVITY: ERROR__REFRACTIVITY,
        ERROR__FREQUENCY: ERROR__FREQUENCY,
        ERROR__POLARIZATION: ERROR__POLARIZATION,
        ERROR__EPSILON: ERROR__EPSILON,
        ERROR__SIGMA: ERROR__SIGMA,
        ERROR__GROUND_IMPEDANCE: ERROR__GROUND_IMPEDANCE,
        ERROR__MDVAR: ERROR__MDVAR,
        ERROR__EFFECTIVE_EARTH: ERROR__EFFECTIVE_EARTH,
        ERROR__PATH_DISTANCE: ERROR__PATH_DISTANCE,
        ERROR__DELTA_H: ERROR__DELTA_H,
        ERROR__TX_SITING_CRITERIA: ERROR__TX_SITING_CRITERIA,
        ERROR__RX_SITING_CRITERIA: ERROR__RX_SITING_CRITERIA,
        ERROR__SURFACE_REFRACTIVITY_SMALL: ERROR__SURFACE_REFRACTIVITY_SMALL,
        ERROR__SURFACE_REFRACTIVITY_LARGE: ERROR__SURFACE_REFRACTIVITY_LARGE,

        // Warning flags
        WARN__TX_TERMINAL_HEIGHT: WARN__TX_TERMINAL_HEIGHT,
        WARN__RX_TERMINAL_HEIGHT: WARN__RX_TERMINAL_HEIGHT,
        WARN__FREQUENCY: WARN__FREQUENCY,
        WARN__PATH_DISTANCE_TOO_BIG_1: WARN__PATH_DISTANCE_TOO_BIG_1,
        WARN__PATH_DISTANCE_TOO_BIG_2: WARN__PATH_DISTANCE_TOO_BIG_2,
        WARN__PATH_DISTANCE_TOO_SMALL_1: WARN__PATH_DISTANCE_TOO_SMALL_1,
        WARN__PATH_DISTANCE_TOO_SMALL_2: WARN__PATH_DISTANCE_TOO_SMALL_2,
        WARN__TX_HORIZON_ANGLE: WARN__TX_HORIZON_ANGLE,
        WARN__RX_HORIZON_ANGLE: WARN__RX_HORIZON_ANGLE,
        WARN__TX_HORIZON_DISTANCE_1: WARN__TX_HORIZON_DISTANCE_1,
        WARN__RX_HORIZON_DISTANCE_1: WARN__RX_HORIZON_DISTANCE_1,
        WARN__TX_HORIZON_DISTANCE_2: WARN__TX_HORIZON_DISTANCE_2,
        WARN__RX_HORIZON_DISTANCE_2: WARN__RX_HORIZON_DISTANCE_2,
        WARN__EXTREME_VARIABILITIES: WARN__EXTREME_VARIABILITIES,
        WARN__SURFACE_REFRACTIVITY: WARN__SURFACE_REFRACTIVITY,

        // Enum constants
        SINGLE_MESSAGE_MODE: SINGLE_MESSAGE_MODE,
        ACCIDENTAL_MODE: ACCIDENTAL_MODE,
        MOBILE_MODE: MOBILE_MODE,
        BROADCAST_MODE: BROADCAST_MODE,
        POLARIZATION__HORIZONTAL: POLARIZATION__HORIZONTAL,
        POLARIZATION__VERTICAL: POLARIZATION__VERTICAL,
        MODE__NOT_SET: MODE__NOT_SET,
        MODE__P2P: MODE__P2P,
        MODE__AREA: MODE__AREA,
        MODE__LINE_OF_SIGHT: MODE__LINE_OF_SIGHT,
        MODE__DIFFRACTION: MODE__DIFFRACTION,
        MODE__TROPOSCATTER: MODE__TROPOSCATTER,
        CLIMATE__EQUATORIAL: CLIMATE__EQUATORIAL,
        CLIMATE__CONTINENTAL_SUBTROPICAL: CLIMATE__CONTINENTAL_SUBTROPICAL,
        CLIMATE__MARITIME_SUBTROPICAL: CLIMATE__MARITIME_SUBTROPICAL,
        CLIMATE__DESERT: CLIMATE__DESERT,
        CLIMATE__CONTINENTAL_TEMPERATE: CLIMATE__CONTINENTAL_TEMPERATE,
        CLIMATE__MARITIME_TEMPERATE_OVER_LAND: CLIMATE__MARITIME_TEMPERATE_OVER_LAND,
        CLIMATE__MARITIME_TEMPERATE_OVER_SEA: CLIMATE__MARITIME_TEMPERATE_OVER_SEA
    };

    if (typeof module !== "undefined" && module.exports)
        module.exports = ITM;
    else if (typeof self !== "undefined")
        self.ITM = ITM;

})();
