# Rocky Landing Tutorial - Design Spec

## Context

New users have no guidance on how to use the terrain analysis tool. Rocky (the desktop buddy) should walk them through the core flow on first visit via a fully scripted, interactive tutorial. Rocky uses arm IK to physically point at UI elements, waits for the user to act, and gives escalating reminders if they get sidetracked. The tutorial is authored in a markdown script file so dialogue, targets, and timing are all editable without touching code.

This also enables Rocky on mobile (previously disabled entirely) in miniature mode.

## Scope

Two repos are affected:

1. **desktop-buddy** (engine) -- Add arm IK pointing API (`pointAt`/`stopPointing`) for both arms
2. **world-toolkit** (app) -- Tutorial orchestrator, script parser, highlight overlay, mobile buddy enable, skip UI

## Part 1: Arm IK System (desktop-buddy)

### What it does

Adds `pointAt(screenX, screenY, arm?)` to `BuddyController`. Given a screen coordinate, rotates the specified arm so it aims at that point. The existing spring physics pulls the arm smoothly toward the computed rotation, giving organic motion.

### How it works

The arm is a single segment with shoulder (endA) at local `(0, 0.84, 0)` and hand (endB) at `(0, -0.84, 0)`. In rest pose the arm hangs down (Y-axis aligned). Pointing means rotating the arm so its local negative-Y axis (shoulder-to-hand direction) faces the target.

1. Convert target screen coords to world position via `scene3d.unprojectToWorld()`
2. Compute direction vector from arm's shoulder world position to target world position
3. Compute quaternion that rotates the arm's rest direction `(0, -1, 0)` to align with this direction
4. Store this as a per-frame pose override

The override is applied in `BuddyController.update()` after `skeleton.update()` but before `Buddy3D.update()` computes endpoint targets. This means:
- The skeleton animation runs normally for all other segments
- Only the pointed arm's pose rotation is replaced
- Physics springs pull the arm toward the IK target with natural jiggle

### API surface

```typescript
// BuddyController
pointAt(screenX: number, screenY: number, arm?: 'left' | 'right'): void
stopPointing(blendDuration?: number): void
get isPointing(): boolean
```

`pointAt` is called every frame with updated coordinates (the caller tracks the target). `stopPointing` blends back to the current animation over `blendDuration` seconds (default 0.5).

### Files to modify

- `src/3d/BuddyController.ts` -- Add `pointAt()`, `stopPointing()`, per-frame IK override in `update()`
- `src/embed.ts` -- Expose `pointAt`/`stopPointing` on the returned object (they're already on controller, just documenting)

### Files NOT modified

- `Skeleton.ts` -- No changes. IK override happens after skeleton update, not inside it
- `animations.ts` -- No changes. Existing animations unaffected
- `Segment.ts`, `Buddy3D.ts` -- No structural changes. The override modifies `skeleton.currentPose[arm]` directly

### Rebuild

After implementing, rebuild and copy to world-toolkit:
```bash
cd ../desktop-buddy && pnpm build
cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
```

## Part 2: Tutorial Orchestrator (world-toolkit)

### New file: `tutorial.js`

Lightweight module that:
1. Checks `localStorage('sv_tutorial_done')` on load -- skips if already completed
2. Fetches and parses `scripts/rocky-tutorial.md` into a step array
3. Executes steps sequentially, each with: target resolution, arm pointing, dialogue, wait condition, timeout escalation
4. On completion or skip, sets `sv_tutorial_done` and cleans up

### Script format: `scripts/rocky-tutorial.md`

```markdown
# Rocky's Tutorial

<!-- tutorial: onboarding -->

## Step 1: Open the app
<!-- target: #icon-search-spots -->
<!-- target-mobile: #icon-search-spots -->
<!-- wait: dblclick #icon-search-spots -->
<!-- arm: right -->
> {color:cyan}Welcome!{/color} Double-click this icon to start exploring!

<!-- timeout: 10 -->
> Still here? Just {bold}double-click{/bold} that icon!

<!-- timeout: 25 -->
> Come on, give it a try! I'm pointing right at it!

<!-- timeout: 45 -->
> {shake}I'll wait all day if I have to!{/shake}

## Step 2: Draw a rectangle
<!-- target: .leaflet-draw-draw-rectangle -->
<!-- target-mobile: .leaflet-draw-draw-rectangle -->
<!-- wait: custom wt:rectangle-drawn -->
<!-- arm: right -->
> Now click this tool and {bold}drag a rectangle{/bold} on the map!

<!-- timeout: 15 -->
> Click the rectangle tool, then drag on the map to select an area.

<!-- timeout: 30 -->
> Just draw a rectangle anywhere — you can always redo it!

## Step 3: Analyze
<!-- target: #analyze-btn -->
<!-- target-mobile: #analyze-btn -->
<!-- wait: click #analyze-btn -->
<!-- arm: left -->
> Hit {bold}Analyze{/bold} and I'll find the best viewpoints!

<!-- timeout: 10 -->
> That big button right there — give it a click!

## Step 4: Check results
<!-- target: .result-card -->
<!-- target-mobile: .result-card -->
<!-- wait: visible .result-card -->
<!-- arm: right -->
> {rainbow}Nice!{/rainbow} These are your viewpoints! Click any card to see it on the map!
```

### Directive reference

| Directive | Format | Purpose |
|-----------|--------|---------|
| `<!-- tutorial: name -->` | string | Declares a tutorial sequence |
| `<!-- target: selector -->` | CSS selector | Element for arm pointing + highlight (desktop) |
| `<!-- target-mobile: selector -->` | CSS selector | Override target for mobile layout (falls back to `target`) |
| `<!-- wait: type [arg] -->` | `click sel`, `dblclick sel`, `custom eventName`, `visible sel` | Pause until user action |
| `<!-- arm: left\|right -->` | `left` or `right` | Which arm points (default: `right`) |
| `<!-- timeout: seconds -->` | number | Dialogue lines after this fire at the specified delay |
| `> text` | rich text | Dialogue line (same markup as existing scripts) |

### Step execution flow

```
For each step:
  1. Resolve target selector -> element
  2. Get element center via getBoundingClientRect()
  3. Create highlight overlay on element
  4. Call buddy.controller.pointAt(x, y, arm)
  5. buddy.controller.say(main dialogue)
  6. Start RAF loop: re-resolve element position, update pointAt coords
  7. Start timeout timers for escalating reminders
  8. Listen for wait condition:
     - click/dblclick: addEventListener on target element
     - custom: document.addEventListener for CustomEvent
     - visible: MutationObserver + polling for element existence
  9. On condition met:
     - Clear all timers
     - Remove highlight
     - buddy.controller.stopPointing()
     - Advance to next step
```

### Target highlight

A pulsing CSS ring overlay (`div.tutorial-highlight`) absolutely positioned over the target element:
- `position: fixed`, tracks element via `getBoundingClientRect()` in a RAF loop
- Pulsing animation: `box-shadow` with keyframes scaling opacity
- `z-index: 500000` (below buddy canvas 999999, above all app UI)
- `pointer-events: none` so clicks pass through to the actual element
- `border-radius` adapts: circular for small elements (buttons), rounded-rect for larger ones

### Skip button

- Fixed-position "Skip" text in bottom-right corner while tutorial is active
- Also added as a radial menu item on Rocky during the tutorial
- Both call `tutorial.skip()` which: stops pointing, dismisses speech, removes highlight, sets localStorage, cleans up all listeners

### Replay

- After tutorial completion, a "Tutorial" item appears in Rocky's radial menu
- Clicking it clears `sv_tutorial_done` and restarts from step 1

### New CustomEvent needed

`wt:rectangle-drawn` -- dispatched in `app.js` when a rectangle is drawn on the map (inside the existing `L.Draw.Event.CREATED` handler). This is needed because the draw tool's click target and the actual "draw completed" event are different things.

### Files to modify

- **`tutorial.js`** (new) -- Tutorial parser, orchestrator, highlight overlay, skip UI
- **`buddy-integration.js`** -- Remove `IS_MOBILE` gate, add tutorial init call, add radial menu items for skip/replay, start buddy in miniature mode on mobile
- **`app.js`** -- Dispatch `wt:rectangle-drawn` CustomEvent in draw handler
- **`style.css`** -- Tutorial highlight animation, skip button styles
- **`index.html`** -- Add `<script src="tutorial.js">` after buddy-integration.js
- **`scripts/rocky-tutorial.md`** (new) -- Tutorial dialogue script

## Part 3: Mobile Buddy Enable

### Changes

- Remove `if (IS_MOBILE) return;` from `buddy-integration.js`
- On mobile (`IS_MOBILE`), initialize buddy with `mode: 'miniature'`
- On desktop, initialize with `mode: 'full'` (changing from current `mode: 'miniature'` in buddy-integration.js line 45 to match user's stated preference for full mode on desktop)
- During tutorial on mobile, buddy stays in miniature mode (speech bubble above head works well on small screens)
- During tutorial on desktop, buddy is in full mode (uses dialogue box at bottom of screen)

### What already works on mobile

- `PointerEvent` API handles touch + mouse (drag, tap)
- Screen-edge clamping prevents buddy from going offscreen
- Speech bubble positions relative to head screen position
- Desktop icon double-click toggle works with touch `dblclick`

### What needs attention

- Full-mode dialogue box width may need a `max-width` on narrow screens
- Miniature mode speech bubble is already compact and works well
- Roaming speed may feel fast on small screens -- could reduce for mobile but not critical for v1

## Verification

### Desktop
1. Open `http://localhost:8765/` with cleared localStorage
2. Rocky appears in full mode, tutorial auto-starts
3. Rocky points right arm at Search for Spots icon with pulsing highlight
4. Wait 10s+ -- escalating reminder dialogue appears
5. Double-click icon -- highlight moves to rectangle draw tool
6. Draw rectangle -- highlight moves to Analyze button
7. Click Analyze -- wait for results, highlight on result card
8. Tutorial completes, `sv_tutorial_done` set in localStorage
9. Refresh -- no tutorial, Rocky behaves normally
10. Right-click Rocky -- "Tutorial" menu item replays it

### Mobile
1. Open on mobile/DevTools mobile viewport
2. Rocky appears in miniature mode, tutorial starts
3. Same flow but with `target-mobile` selectors where they differ
4. Skip button visible and functional
5. After tutorial, buddy continues working (roaming, reactions, radial menu)

### Arm IK (desktop-buddy)
1. Run desktop-buddy dev server
2. Call `controller.pointAt(100, 100, 'right')` from console
3. Right arm smoothly rotates to point at top-left
4. Move target -- arm follows with spring physics
5. `controller.stopPointing()` -- arm blends back to idle animation
6. Test left arm: `controller.pointAt(500, 300, 'left')`

### Edge cases
- Target element not yet in DOM (e.g., result card before analysis) -- `wait: visible` polls for existence
- Window resize during tutorial -- RAF loop re-resolves element position
- User closes main window during tutorial -- tutorial pauses, re-points when window reopens
- Tutorial skip mid-step -- all cleanup runs (listeners, timers, highlight, pointing)
