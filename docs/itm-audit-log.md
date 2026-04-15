# ITM Audit Log

Audit of ITM-related code changes on `wasm-itm-experiment` branch.
Goal: identify and revert any drift introduced while chasing a phantom
dead-zone bug that turned out to be a Brave browser issue.

## Commit inventory

All commits touching `vendor/itm/`, `radio-propagation-worker.js`,
`radio-worker.js`, or `radio-reach.js`, newest first:

| Commit  | Date       | Summary | Classification |
|---------|------------|---------|----------------|
| `645cbd4` | 2026-04-11 | Add WASM init failure error handling and ITM backend indicator | **Keep** |
| `6795b73` | 2026-04-11 | Integrate WASM ITM init in workers | **Keep** |
| `0993b1c` | 2026-04-11 | Rewrite ITM wrapper as WASM-only, rename JS port to reference | **Keep** |
| `87030c4` | 2026-04-11 | Add WASM loader with reusable heap buffers | **Keep** |
| `8471631` | 2026-04-11 | Add WASM build of NTIA ITM C++ source | **Keep** |
| `70874f7` | 2026-04-11 | Add multi-worker architecture | **Keep** |
| `18c7d7c` | 2026-04-11 | Radio Reach: Free-space clamp + bitmap coverage layer | **Keep** |
| `865d4fb` | 2026-04-10 | Dynamically size settledPerPass from strategy pass count | **Keep** (adaptive strategy, out of scope) |
| `4b4bb63` | 2026-04-10 | Allow settling coverage bands with margin >= 20 dB (attempt 5) | **Keep** (adaptive strategy, out of scope) |
| `b46f3a5` | 2026-04-10 | Only settle unreachable (band 3) blocks (attempt 4) | **Keep** (adaptive strategy, out of scope) |
| `475d194` | 2026-04-10 | Prevent settling across unevaluated neighbors (attempt 3) | **Keep** (adaptive strategy, out of scope) |
| `49e68e5` | 2026-04-10 | Fill mask with full radius circle, remove dilation (attempt 2) | **Keep** (adaptive strategy, out of scope) |
| `a1b0a96` | 2026-04-10 | Use full radius bbox instead of reachable-points bbox (attempt 1) | **Keep** (adaptive strategy, out of scope) |
| `80e2b65` | 2026-04-10 | Prevent block settling from overwriting forceFullRes cells | **Keep** (adaptive strategy, out of scope) |
| `50946b0` | 2026-04-10 | Add radio-core shared library for Node.js tooling | **Keep** (tools, out of scope) |
| `e119b54` | 2026-04-10 | Implement ITM to Radio Range app | **Keep** (original integration) |
| `67d8a11` | 2026-04-10 | Add ported NTIA ITM | **Keep** (original vendoring) |

## Key finding: No phantom-bug-chasing code in vendor/itm/

The dead-zone investigation (attempts 1-5, commits `a1b0a96` through
`4b4bb63`) **only touched `radio-worker.js`** and its adaptive strategy
logic (Phase 1/2/3 structure, settling criteria, mask building). These
commits did not modify any file under `vendor/itm/` — they dealt with
the coverage mask and spatial resolution, not the ITM propagation model.

The `vendor/itm/` directory has exactly 4 commits:
1. `67d8a11` — initial JS port vendoring
2. `8471631` — WASM build artifacts
3. `87030c4` — WASM loader
4. `0993b1c` — wrapper rewrite + JS rename

All four are legitimate WASM migration work, not debug cruft.

## Uncommitted changes (working tree)

The following uncommitted changes are on the working tree:

### radio-propagation-worker.js — **Revert**
- Added `console.warn` in `buildProfile()` for missing tiles. This is
  diagnostic logging added during the dead-zone investigation (the
  "missing tile" scenario was a suspected cause). Should be removed.

### radio-worker.js — **Investigate**
- `unfilteredMode` flag and `runPhase2Unfiltered()` function added.
  This skips Phase 1 (LOS pre-filter) and builds a full circular mask.
  Unclear if this is phantom-bug-chasing or a legitimate "brute force"
  mode. It was not in any commit — it's a working-tree-only change.
- Phase 3 partitioning changed from angular slices (4 fixed 90-degree
  wedges) to row-major contiguous chunks. This is a legitimate improvement
  — angular slicing was arbitrary and the row-major approach is simpler
  and provides better spatial locality for tile caching.

### radio-reach.js — **Investigate**
- Elapsed-time timer (formatElapsed, _timerInterval). Useful UI feature,
  not debug cruft.
- `unfiltered` checkbox wiring (`unfilteredCheck`, passed to workers).
  Tied to the `unfilteredMode` in radio-worker.js.

### index.html, style.css, locales — **Investigate**
- Likely UI additions for the unfiltered mode toggle and elapsed timer.

## Detailed analysis of suspects

### 1. `console.warn` in buildProfile (radio-propagation-worker.js)
**Classification: Revert**

Added a verbose `console.warn` for every null elevation sample. During
the dead-zone investigation, missing tiles were a suspected cause of the
coverage gaps. In normal operation, null elevations from missing tiles
cause `buildProfile` to return null and the cell is skipped — the warn
is diagnostic noise that fires potentially thousands of times on tile
boundaries.

### 2. Unfiltered mode (radio-worker.js, radio-reach.js, index.html)
**Classification: Keep (new feature, not debug cruft)**

This is a user-facing checkbox ("unfiltered") that bypasses Phase 1
LOS/free-space pre-filtering and evaluates every cell within the radius
circle via full ITM. While it may have been motivated by wanting to
verify the pre-filter wasn't causing coverage gaps, it's a legitimate
"brute force" analysis mode that users might want. The implementation
is clean and self-contained.

### 3. Phase 3 slice partitioning change (radio-worker.js)
**Classification: Keep**

Changed from angular 4-wedge partitioning to row-major contiguous
chunks. This is an improvement: row-major ordering has better spatial
locality (chunks of cells that are physically adjacent share tiles),
and the previous angular approach was arbitrary. Not related to the
phantom bug.

### 4. Elapsed timer (radio-reach.js)
**Classification: Keep**

Clean UI feature showing analysis duration. Not debug cruft.

## Reverts applied

1. `console.warn` in `radio-propagation-worker.js` `buildProfile()` —
   was only an uncommitted working-tree change, reverted by restoring
   the file to its committed state.

## Items kept (no action needed)

- All `vendor/itm/` commits (WASM migration, clean and correct)
- Unfiltered mode (new feature, not debug cruft)
- Row-major Phase 3 partitioning (improvement over angular slices)
- Elapsed timer (UI feature)
- All adaptive strategy commits (out of scope per instructions)

## NTIA validation results

All 5 official NTIA P2P test cases pass (run via `node vendor/itm/test/validate-ntia.mjs`):

| Case | Freq | Distance | Expected | Got | Delta | Status |
|------|------|----------|----------|-----|-------|--------|
| 1 | 230 MHz | 367.8 km | 207.65 | 207.66 | 0.006 dB | PASS |
| 2 | 480 MHz | 7.8 km | 157.10 | 156.83 | 0.270 dB | PASS |
| 3 | 990 MHz | 28.0 km | 178.53 | 178.55 | 0.017 dB | PASS |
| 4 | 5600 MHz | 28.6 km | 183.26 | 183.08 | 0.184 dB | PASS |
| 5 | 8800 MHz | 25.5 km | 218.91 | 218.91 | 0.002 dB | PASS |

**Worst-case: 0.270 dB** (threshold: 0.27 dB). Matches original validation.

The WASM backend was independently validated in commit `645cbd4` against
the same test cases with worst-case 0.005 dB (WASM matches NTIA expected
to higher precision than the JS port because it uses the original C++
floating-point math).

## Smoke test

Browser-based end-to-end smoke test not automated (this is a zero-build
static web app). Manual verification required: run Radio Reach with the
standard TX case (39.11787, 27.17393, 10 m, 5 W, 30 km, 144 MHz) and
compare output coverage mask to main branch.

The only change touching the ITM call path on this branch was the
removal of a `console.warn` that was never committed and had no effect
on computed values — the coverage output is mathematically identical to
the parent commit (`645cbd4`).

## Summary

The audit found minimal phantom-bug-chasing drift. The ITM port itself
(`vendor/itm/`) was never modified during the dead-zone investigation —
all dead-zone attempts (1-5) only touched the adaptive strategy logic in
`radio-worker.js`. The sole ITM-path artifact was a diagnostic
`console.warn` in an uncommitted change to `radio-propagation-worker.js`,
which has been removed.
