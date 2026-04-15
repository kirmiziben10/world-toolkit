#!/usr/bin/env node
/**
 * NTIA ITM Validation Harness
 *
 * Runs all 5 official NTIA point-to-point test cases against the JS
 * reference implementation and reports worst-case dB delta.
 *
 * Usage:  node validate-ntia.mjs
 * Exit:   0 if worst-case delta <= THRESHOLD, 1 otherwise
 *
 * Test data:  p2p.csv  (parameters + expected A__db)
 *             pfls.csv (terrain profiles, one per test case)
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the JS reference implementation
const ITM = require('../itm-js-reference.js');

const THRESHOLD_DB = 0.27; // acceptance threshold (worst-case from original validation)

// ===== Parse test data =====

function loadP2P() {
  const csv = readFileSync(join(__dirname, 'p2p.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(Number);
    const obj = {};
    header.forEach((h, i) => obj[h] = vals[i]);
    return obj;
  });
}

function loadProfiles() {
  const csv = readFileSync(join(__dirname, 'pfls.csv'), 'utf8');
  return csv.trim().split('\n').map(line => line.split(',').map(Number));
}

// ===== Run validation =====

const testCases = loadP2P();
const profiles = loadProfiles();

if (testCases.length !== profiles.length) {
  console.error(`Mismatch: ${testCases.length} test cases but ${profiles.length} profiles`);
  process.exit(1);
}

console.log(`Running ${testCases.length} NTIA P2P test cases...\n`);

let worstDelta = 0;
let allPass = true;

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const pflRaw = profiles[i];

  // pflRaw format: [N, spacing, elev0, elev1, ..., elevN]
  // Already in the PFL format expected by ITM_P2P_TLS
  const pfl = pflRaw;

  const result = ITM.ITM_P2P_TLS(
    tc.h_tx__meter, tc.h_rx__meter, pfl,
    tc.climate, tc.N_0, tc.f__mhz,
    tc.pol, tc.epsilon, tc.sigma,
    tc.mdvar, tc.time, tc.location, tc.situation
  );

  const expected = tc.A__db;
  const got = result.A__db;
  const delta = Math.abs(got - expected);

  if (delta > worstDelta) worstDelta = delta;

  const pass = delta <= THRESHOLD_DB;
  if (!pass) allPass = false;

  const distKm = (pfl[0] * pfl[1] / 1000).toFixed(1);

  console.log(
    `  Case ${i + 1}: ${tc.f__mhz} MHz, ${distKm} km` +
    `  expected ${expected.toFixed(2)}, got ${got.toFixed(2)}` +
    `  delta ${delta.toFixed(3)} dB` +
    `  ${pass ? 'PASS' : 'FAIL'}` +
    (result.error > 0 ? `  (error: ${result.error}, warnings: 0x${result.warnings.toString(16)})` : '')
  );
}

console.log(`\nWorst-case delta: ${worstDelta.toFixed(3)} dB (threshold: ${THRESHOLD_DB} dB)`);
console.log(allPass ? 'ALL PASS' : 'SOME FAILED');

process.exit(allPass ? 0 : 1);
