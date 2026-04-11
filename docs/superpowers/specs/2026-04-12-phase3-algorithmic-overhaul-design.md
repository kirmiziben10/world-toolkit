# Phase 3: Algorithmic Overhaul — Design Spec

## Overview

Three features that break the computation limits of the Radio Reach propagation analysis tool:

1. **Memory Guardrail** — Prevent browser tab crashes for large radii
2. **Radar Sweep State Machine** — Process the circle in sequential 10-degree wedges
3. **Coarse-to-Fine ITM Evaluation** — Hierarchical 2-pass culling in propagation workers

All three features are controlled by existing UI toggles (Radar Sweep Mode, Adaptive Culling) that are currently wired but non-functional.

## Files Modified

| File | Changes |
|------|---------|
| `radio-reach.js` | Memory guardrail, wedge dispatch loop, `wedgeDone` message, coverage layer init for sweep, progress reporting |
| `radio-worker.js` | Sector state machine, per-wedge tile eviction, wedge mask builder, `wedgeDone` handler, adaptive culling flag passthrough |
| `radio-propagation-worker.js` | Coarse-to-fine 2-pass evaluation in `processSlice` |
| `locales/en.json` | New i18n key for memory guardrail warning |
| `locales/tr.json` | Turkish translation for memory guardrail warning |

## 1. Memory Guardrail (`radio-reach.js`)

**Location:** `startAnalysis()`, before worker spawn.

**Logic:**
```
pixelRadius = (radiusKm * 1000) / metersPerPixel(lat, ANALYSIS_ZOOM)
diameter = pixelRadius * 2
requiredMB = (diameter * diameter) / (1024 * 1024)
```

If `requiredMB > 500` AND `radarSweepCheck.checked === false`:
- Abort immediately, do not spawn workers
- Show localized warning in stats panel: "Radius too large — enable Radar Sweep Mode or reduce radius"
- The 500MB threshold accounts for the Uint8Array mask plus working buffers

If radar sweep IS checked, no limit applies — wedge processing never builds the full mask.

## 2. Radar Sweep State Machine (`radio-worker.js`)

### Entry point

`handleStart` reads `msg.radarSweep` (boolean). If true, enters sector state machine instead of monolithic flow.

### Constants

- `WEDGE_DEG = 10` — 36 wedges covering 360 degrees

### Sector loop

For each wedge `w` (0 to 35):

1. **Tile eviction:** Clear `tileStore` except TX tile. Reset `tilesUsed` to 1. This bounds memory to tiles needed for one wedge.

2. **Phase 1 (conditional):**
   - If `adaptiveCulling === false`: Run Phase 1 LOS only for rays within `[w*10, (w+1)*10)` degrees.
   - If `adaptiveCulling === true`: Skip Phase 1 entirely.

3. **Phase 2 (wedge mask):** Build mask covering only the angular sector.
   - Compute 3 boundary points: TX position + two edge rays at `w*10` and `(w+1)*10` degrees extended to `radiusM` via `destinationPoint()`.
   - Compute tight axis-aligned bounding box of these 3 points (plus a buffer of `BUFFER_KM` pixels as in existing Phase 2).
   - Allocate a small `Uint8Array` mask for this bbox. Mask origin/dimensions are local to this wedge.
   - If adaptive culling is off: project LOS reachable points into mask, dilate with `dilateMask()`, clip to wedge arc (angle test + radius test).
   - If adaptive culling is on: iterate mask pixels, set to 1 if pixel's bearing from TX is within `[w*10, (w+1)*10)` AND distance <= `radiusM`. No LOS filtering.
   - The wedge mask is ~1/36th the pixels of the full circle mask (even smaller for edge wedges near poles of the bbox).

4. **Post `phase3Partition`:** Send wedge mask to main thread, tagged with:
   - `wedgeIndex: w`
   - `totalWedges: 36`
   - `isRadarSweep: true`

5. **Wait for `wedgeDone`:** Pause via continuation-passing pattern until main thread signals completion.

### New message types

- Orchestrator → main: `phase3Partition` (existing, extended with `wedgeIndex`, `totalWedges`, `isRadarSweep`)
- Main → orchestrator: `wedgeDone` (new)
- Orchestrator listens for `wedgeDone` in `self.onmessage`

### Coverage bounds

On the first wedge (`wedgeIndex === 0`), the orchestrator computes and sends full-circle `coverageBounds` so the main thread initializes the `RadioCoverageLayer` canvas at full size. Subsequent wedges accumulate into the same canvas.

## 3. Main Thread Sweep Handling (`radio-reach.js`)

### `handlePhase3Partition` changes

When `msg.isRadarSweep === true`:
- On first wedge: initialize `RadioCoverageLayer` with full-circle bounds (already received via `coverageBounds`).
- Spawn propagation workers for this wedge's mask.
- On all sliceDone for this wedge: aggregate stats, terminate prop workers, post `{ type: 'wedgeDone' }` back to orchestrator.
- Track `wedgesCompleted` for progress.

### Progress reporting

- Overall: `(wedgesCompleted / totalWedges) * 100%`
- Within wedge: per-cell evaluation progress as before
- Progress text shows: "Wedge N/36 — evaluating cells"

## 4. Coarse-to-Fine ITM Evaluation (`radio-propagation-worker.js`)

### Entry point

`handleStartInner` receives `msg.adaptiveCulling` (boolean), passes it to `processSlice`.

### Modified `processSlice` flow

When `adaptiveCulling === true`:

1. **Block grid overlay:** Within each 64x64 chunk, sub-group cells into 4x4 blocks keyed by `(cellX >> 2, cellY >> 2)`.

2. **Pass 1 — Coarse scout:** For each 4x4 block:
   - Pick the cell nearest to the block center.
   - Run `buildProfile` + ITM on this single cell.
   - If margin >= 0 (marginal or better): block is "alive."
   - If margin < 0: block is "dead" — all cells in the block are skipped.

3. **Pass 2 — Fine fill:** For alive blocks, iterate all cells normally (existing per-cell loop).

4. **Counting:** Dead-block cells increment `evaluated` but are not processed (no buildProfile/ITM calls). This keeps progress reporting accurate.

### Fallback

When `adaptiveCulling === false`: existing 1:1 per-cell loop unchanged.

### Performance characteristics

- Best case (mostly dead terrain): evaluates ~6.25% of cells (1 scout per 16-cell block)
- Worst case (all blocks alive): ~6% overhead from extra scout evaluations
- Typical mountainous terrain: 40-60% cell reduction expected

## 5. Toggle Interaction Matrix

| Radar Sweep | Adaptive Culling | Phase 1 | Mask Builder | Evaluation | Memory Limit |
|:-----------:|:----------------:|:-------:|:------------:|:----------:|:------------:|
| Off         | Off              | Normal (360-ray LOS) | LOS bbox + dilate | 1:1 per-cell | 500MB guard |
| Off         | On               | **Skipped** | Full circle unfiltered | **Coarse-to-fine** | 500MB guard |
| On          | Off              | Per-wedge rays | Wedge bbox + dilate | 1:1 per-cell | No limit |
| On          | On               | **Skipped** | Wedge arc fill | **Coarse-to-fine** | No limit |

## 6. Data Flow (Sweep + Culling)

```
radio-reach.js:
  Memory guardrail check → OK
  Spawn orchestrator worker with {radarSweep: true, adaptiveCulling: true}

radio-worker.js:
  For wedge 0..35:
    Clear tileStore (keep TX tile)
    Skip Phase 1 (adaptive culling bypasses LOS)
    Build wedge-arc mask (small Uint8Array)
    Post phase3Partition {mask, wedgeIndex, totalWedges, isRadarSweep}
    Wait for wedgeDone

radio-reach.js (per wedge):
  Receive phase3Partition
  Initialize canvas on first wedge (full-circle bounds)
  Partition wedge mask into row-bands
  Spawn propagation workers

radio-propagation-worker.js (per wedge slice):
  Decode mask → cells
  Group into 64x64 chunks
    Within each chunk: sub-group into 4x4 blocks
    Pass 1: Scout center cell of each block (ITM)
    Pass 2: Fine-fill alive blocks, skip dead blocks
  Emit coverageBatch → main thread renders cells
  Emit sliceDone

radio-reach.js (per wedge completion):
  Aggregate slice stats
  Post wedgeDone to orchestrator
  Update progress: "Wedge N/36"
```

## 7. Atomic Commit Plan

1. **Commit 1:** Memory guardrail in `radio-reach.js` + i18n keys
2. **Commit 2:** Radar sweep state machine in `radio-worker.js` + main thread dispatch changes in `radio-reach.js`
3. **Commit 3:** Coarse-to-fine evaluation in `radio-propagation-worker.js` + adaptive culling flag passthrough
