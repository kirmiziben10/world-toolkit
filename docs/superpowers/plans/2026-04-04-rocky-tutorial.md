# Rocky Landing Tutorial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add arm IK pointing to the desktop-buddy engine, then build an interactive first-visit tutorial in world-toolkit where Rocky walks the user through the core flow with arm pointing, highlight overlays, and escalating reminders.

**Architecture:** Two-repo change. Part 1 adds `pointAt`/`stopPointing` to `BuddyController` in the desktop-buddy repo via a post-skeleton-update callback on `Buddy3D`. Part 2 adds a tutorial orchestrator (`tutorial.js`) in world-toolkit that parses a markdown script, drives Rocky's arm pointing and speech, overlays a pulsing highlight on target UI elements, and waits for user actions. Part 3 removes the mobile gate in `buddy-integration.js` so Rocky works on small screens.

**Tech Stack:** Vanilla JS (world-toolkit), TypeScript + Three.js + Vite (desktop-buddy), CSS animations

**Spec:** `docs/superpowers/specs/2026-04-04-rocky-tutorial-design.md`

---

## File Map

### desktop-buddy repo (`../desktop-buddy/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `src/3d/Buddy3D.ts` | Modify | Add `onPostSkeletonUpdate` callback hook, invoked between skeleton update and endpoint computation |
| `src/3d/BuddyController.ts` | Modify | Add `pointAt()`, `stopPointing()`, `isPointing`, IK state, and the callback implementation |
| `src/embed.ts` | Modify | Add `extraMenuItems` array for host-page radial menu injection (Task 9) |

### world-toolkit repo (this repo)

| File | Action | Responsibility |
|------|--------|---------------|
| `tutorial.js` | Create | Tutorial parser, step orchestrator, highlight overlay, skip UI |
| `scripts/rocky-tutorial.md` | Create | Tutorial dialogue script with directives |
| `buddy-integration.js` | Modify | Remove mobile gate, add mobile miniature init, add tutorial init call, add radial menu items (skip during tutorial, replay after) |
| `app.js` | Modify | Dispatch `wt:rectangle-drawn` CustomEvent in draw handler |
| `style.css` | Modify | Tutorial highlight pulse animation, skip button styles |
| `index.html` | Modify | Add `<script src="tutorial.js">` after buddy-integration.js |
| `vendor/desktop-buddy/desktop-buddy.iife.js` | Replace | Rebuilt bundle with IK support |
| `Models/` | No change | Already in place |

---

## Task 1: Add post-skeleton-update hook to Buddy3D

**Repo:** `../desktop-buddy/`
**Files:**
- Modify: `src/3d/Buddy3D.ts:422-451`

This hook lets external code modify `skeleton.currentPose` after the animation computes it but before endpoint targets are derived from it — the insertion point for arm IK.

- [ ] **Step 1.1: Add the callback property and invoke it**

In `src/3d/Buddy3D.ts`, add a public callback property and call it in `update()`:

```typescript
// After line 167 (private _gravityEnabled = false;)
/** Called after skeleton.update but before endpoint computation. Receives capped dt. */
onPostSkeletonUpdate: ((dt: number) => void) | null = null;
```

Then in `update()`, insert the callback invocation between skeleton update (line 445) and the endpoint computation loop (line 448):

```typescript
    // Step 1: Update skeleton (computes target center poses)
    this.skeleton.update(advanceSkeleton ? cappedDt : 0);

    // Hook: allow external IK overrides on the skeleton pose
    if (this.onPostSkeletonUpdate) this.onPostSkeletonUpdate(cappedDt);

    // Step 2: Compute endpoint targets from skeleton pose for all segments
```

- [ ] **Step 1.2: Verify desktop-buddy builds**

Run:
```bash
cd ../desktop-buddy && pnpm build
```
Expected: Build succeeds with no errors.

- [ ] **Step 1.3: Commit**

```bash
cd ../desktop-buddy
git add src/3d/Buddy3D.ts
git commit -m "feat: add onPostSkeletonUpdate hook to Buddy3D for IK overrides"
```

---

## Task 2: Implement pointAt / stopPointing on BuddyController

**Repo:** `../desktop-buddy/`
**Files:**
- Modify: `src/3d/BuddyController.ts`

The IK system stores a screen-space target and arm choice. Each frame, the post-skeleton callback computes the rotation that makes the arm's local `(0, -1, 0)` axis (shoulder-to-hand) point toward the world-space target position, then overrides `skeleton.currentPose[arm].rotation`. The existing spring physics then pulls the arm smoothly toward this rotation.

- [ ] **Step 2.1: Add IK state fields**

In `BuddyController`, add imports and private fields after the existing private fields (after line 37):

```typescript
import * as THREE from 'three';
```

(THREE is already imported in the file's dependencies via Buddy3D — but BuddyController doesn't import it directly. Add it at the top of the file.)

After the `private readonly ROOT_GRAVITY = 15;` line, add:

```typescript
  // --- Arm IK state ---
  private _ikTarget: { screenX: number; screenY: number; arm: 'armL' | 'armR' } | null = null;
  private _ikBlending = false;
  private _ikBlendT = 0;
  private _ikBlendDuration = 0.5;
  private readonly _ikSavedQuat = new THREE.Quaternion();
  private readonly _ikTempVec = new THREE.Vector3();
  private readonly _ikTempQuat = new THREE.Quaternion();
```

- [ ] **Step 2.2: Wire the post-skeleton callback in the constructor**

At the end of the constructor (after the `setupGroundForFullMode()` call block), add:

```typescript
    // Wire IK override into the post-skeleton hook
    this.buddy.onPostSkeletonUpdate = (dt: number) => this._applyIkOverride(dt);
```

- [ ] **Step 2.3: Implement public API methods**

Add after the `dismissSpeech()` method:

```typescript
  /**
   * Point an arm at a screen position. Call every frame with updated coords.
   * The arm smoothly rotates via spring physics to aim at the target.
   */
  pointAt(screenX: number, screenY: number, arm: 'left' | 'right' = 'right'): void {
    this._ikTarget = {
      screenX,
      screenY,
      arm: arm === 'left' ? 'armL' : 'armR',
    };
    this._ikBlending = false;
  }

  /** Blend the arm back to the current animation over blendDuration seconds. */
  stopPointing(blendDuration = 0.5): void {
    if (!this._ikTarget) return;
    // Snapshot the current IK-overridden rotation for blend-out
    this._ikSavedQuat.copy(
      this.buddy.skeleton.currentPose[this._ikTarget.arm].rotation,
    );
    this._ikBlending = true;
    this._ikBlendDuration = blendDuration;
    this._ikBlendT = 0;
  }

  get isPointing(): boolean {
    return this._ikTarget !== null;
  }
```

- [ ] **Step 2.4: Implement the private IK override callback**

Add after the `clampToScreen()` method:

```typescript
  /**
   * Post-skeleton-update callback. Overrides the targeted arm's pose rotation
   * so its local (0, -1, 0) axis points from the shoulder toward the screen target.
   */
  private _applyIkOverride(dt: number): void {
    if (!this._ikTarget) return;

    const armType = this._ikTarget.arm;
    const pose = this.buddy.skeleton.currentPose[armType];

    if (this._ikBlending) {
      // Slerp from saved IK rotation toward animation rotation (already computed by skeleton)
      const animRotation = this._ikTempQuat.copy(pose.rotation);
      this._ikBlendT += dt;
      const t = Math.min(this._ikBlendT / this._ikBlendDuration, 1);
      pose.rotation.slerpQuaternions(this._ikSavedQuat, animRotation, t);
      if (t >= 1) {
        this._ikTarget = null;
        this._ikBlending = false;
      }
      return;
    }

    // Compute world-space target from screen coordinates
    const target = this._ikTempVec.copy(
      this.buddy.scene3d.unprojectToWorld(this._ikTarget.screenX, this._ikTarget.screenY, 0),
    );

    // Shoulder is at the arm center (pose.position is world-space center of arm segment)
    const direction = target.sub(pose.position).normalize();

    // Rest direction of arm: shoulder-to-hand is (0, -1, 0) in local space
    const restDir = new THREE.Vector3(0, -1, 0);

    // Compute rotation from rest direction to target direction
    pose.rotation.setFromUnitVectors(restDir, direction);
  }
```

- [ ] **Step 2.5: Clean up stopPointing in dispose**

In the `dispose()` method, add cleanup before the existing `this.buddy.dispose()`:

```typescript
    this._ikTarget = null;
    this.buddy.onPostSkeletonUpdate = null;
```

- [ ] **Step 2.6: Build and verify**

Run:
```bash
cd ../desktop-buddy && pnpm build
```
Expected: Build succeeds with no errors.

- [ ] **Step 2.7: Commit**

```bash
cd ../desktop-buddy
git add src/3d/Buddy3D.ts src/3d/BuddyController.ts
git commit -m "feat: add pointAt/stopPointing arm IK to BuddyController"
```

---

## Task 3: Rebuild and copy desktop-buddy bundle to world-toolkit

**Repo:** Both
**Files:**
- Replace: `vendor/desktop-buddy/desktop-buddy.iife.js`

- [ ] **Step 3.1: Build and copy**

```bash
cd ../desktop-buddy && pnpm build
cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
```

- [ ] **Step 3.2: Commit in world-toolkit**

```bash
cd /home/alphanumeric/Documents/Programming/AI/world-toolkit
git add vendor/desktop-buddy/desktop-buddy.iife.js
git commit -m "chore: rebuild desktop-buddy bundle with arm IK support"
```

---

## Task 4: Dispatch `wt:rectangle-drawn` event in app.js

**Repo:** world-toolkit
**Files:**
- Modify: `app.js:225-232`

The tutorial needs a `wt:rectangle-drawn` event because the draw tool's click target and the "draw completed" event are different things. The existing `L.Draw.Event.CREATED` handler is the right place.

- [ ] **Step 4.1: Add the CustomEvent dispatch**

In `app.js`, inside the `L.Draw.Event.CREATED` handler (around line 225-232), add the dispatch after `setupRectEditing`:

Find this block:
```javascript
  state.map.on(L.Draw.Event.CREATED, (e) => {
    state.drawnItems.clearLayers();
    state.drawnItems.addLayer(e.layer);
    state.selectionBounds = e.layer.getBounds();
    validateSelection(state.selectionBounds);
    pushBoundsHistory(state.selectionBounds);
    setupRectEditing(e.layer);
  });
```

Add after `setupRectEditing(e.layer);`:
```javascript
    document.dispatchEvent(new CustomEvent('wt:rectangle-drawn'));
```

- [ ] **Step 4.2: Commit**

```bash
git add app.js
git commit -m "feat: dispatch wt:rectangle-drawn CustomEvent on draw complete"
```

---

## Task 5: Create the tutorial dialogue script

**Repo:** world-toolkit
**Files:**
- Create: `scripts/rocky-tutorial.md`

This is the authored dialogue content with directives. The format matches the spec exactly.

- [ ] **Step 5.1: Write the script file**

Create `scripts/rocky-tutorial.md`:

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

- [ ] **Step 5.2: Commit**

```bash
git add scripts/rocky-tutorial.md
git commit -m "feat: add tutorial dialogue script for Rocky onboarding"
```

---

## Task 6: Create the tutorial orchestrator (`tutorial.js`)

**Repo:** world-toolkit
**Files:**
- Create: `tutorial.js`

This is the largest task. It contains the script parser, step executor, highlight overlay, wait condition handlers, and skip/replay logic. It exposes a global `Tutorial` object that `buddy-integration.js` calls.

- [ ] **Step 6.1: Write the tutorial module**

Create `tutorial.js` with the full implementation:

```javascript
/**
 * tutorial.js
 * Parses scripts/rocky-tutorial.md and orchestrates an interactive
 * first-visit tutorial where Rocky points at UI elements and waits
 * for the user to act.
 *
 * Exposes window.Tutorial = { start, skip, replay, isActive }
 * Called from buddy-integration.js after buddy init.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'sv_tutorial_done';
  var SCRIPT_URL = 'scripts/rocky-tutorial.md';

  // --- State ---
  var steps = [];
  var currentStep = -1;
  var active = false;
  var buddyRef = null; // set by start()
  var highlightEl = null;
  var skipBtnEl = null;
  var rafId = 0;
  var timeoutIds = [];
  var waitCleanup = null;
  var isMobile = window.matchMedia('(max-width: 600px)').matches ||
    ('ontouchstart' in window && window.innerWidth <= 600);

  // ==============================
  // Script Parser
  // ==============================

  function parseScript(text) {
    var parsed = [];
    var lines = text.split('\n');
    var step = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();

      // Step header (## Step N: ...)
      if (/^## /.test(line)) {
        if (step) parsed.push(step);
        step = {
          name: line.replace(/^##\s*/, ''),
          target: null,
          targetMobile: null,
          wait: null,
          arm: 'right',
          dialogue: null,
          reminders: [],
        };
        continue;
      }

      if (!step) continue;

      // Directives
      var dir = line.match(/^<!--\s*(\w[\w-]*):\s*(.+?)\s*-->$/);
      if (dir) {
        var key = dir[1];
        var val = dir[2];
        if (key === 'target') step.target = val;
        else if (key === 'target-mobile') step.targetMobile = val;
        else if (key === 'wait') step.wait = parseWait(val);
        else if (key === 'arm') step.arm = val;
        else if (key === 'timeout') {
          // Next dialogue line(s) are reminders at this timeout
          step.reminders.push({ seconds: parseInt(val, 10), text: null });
        }
        continue;
      }

      // Dialogue (> text)
      if (/^>\s/.test(line)) {
        var text = line.replace(/^>\s*/, '');
        // If there's a pending reminder with no text, assign to it
        var pendingReminder = null;
        for (var r = step.reminders.length - 1; r >= 0; r--) {
          if (step.reminders[r].text === null) {
            pendingReminder = step.reminders[r];
            break;
          }
        }
        if (pendingReminder) {
          pendingReminder.text = text;
        } else {
          step.dialogue = text;
        }
      }
    }
    if (step) parsed.push(step);
    return parsed;
  }

  function parseWait(val) {
    var parts = val.split(/\s+/);
    var type = parts[0];
    var arg = parts.slice(1).join(' ');
    return { type: type, arg: arg };
  }

  // ==============================
  // Highlight Overlay
  // ==============================

  function createHighlight() {
    if (highlightEl) return highlightEl;
    highlightEl = document.createElement('div');
    highlightEl.className = 'tutorial-highlight';
    document.body.appendChild(highlightEl);
    return highlightEl;
  }

  function positionHighlight(el) {
    if (!highlightEl) return;
    var rect = el.getBoundingClientRect();
    var pad = 6;
    var isSmall = rect.width < 60 && rect.height < 60;
    highlightEl.style.left = (rect.left - pad) + 'px';
    highlightEl.style.top = (rect.top - pad) + 'px';
    highlightEl.style.width = (rect.width + pad * 2) + 'px';
    highlightEl.style.height = (rect.height + pad * 2) + 'px';
    highlightEl.style.borderRadius = isSmall ? '50%' : '8px';
  }

  function removeHighlight() {
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
    }
  }

  // ==============================
  // Skip Button
  // ==============================

  function showSkipBtn() {
    if (skipBtnEl) return;
    skipBtnEl = document.createElement('button');
    skipBtnEl.className = 'tutorial-skip-btn';
    skipBtnEl.textContent = 'Skip tutorial';
    skipBtnEl.addEventListener('click', function () {
      window.Tutorial.skip();
    });
    document.body.appendChild(skipBtnEl);
  }

  function hideSkipBtn() {
    if (skipBtnEl) {
      skipBtnEl.remove();
      skipBtnEl = null;
    }
  }

  // ==============================
  // Wait Condition Handlers
  // ==============================

  function waitForClick(selector, eventType, cb) {
    var el = document.querySelector(selector);
    if (!el) {
      // Poll for element existence, then attach
      var pollId = setInterval(function () {
        el = document.querySelector(selector);
        if (el) {
          clearInterval(pollId);
          el.addEventListener(eventType, handler, { once: true });
        }
      }, 300);
      timeoutIds.push(pollId);

      function handler() { cb(); }
      return function cleanup() {
        clearInterval(pollId);
        if (el) el.removeEventListener(eventType, handler);
      };
    }
    function handler() { cb(); }
    el.addEventListener(eventType, handler, { once: true });
    return function cleanup() {
      if (el) el.removeEventListener(eventType, handler);
    };
  }

  function waitForCustomEvent(eventName, cb) {
    function handler() { cb(); }
    document.addEventListener(eventName, handler, { once: true });
    return function cleanup() {
      document.removeEventListener(eventName, handler);
    };
  }

  function waitForVisible(selector, cb) {
    // Check immediately
    if (document.querySelector(selector)) { cb(); return function () {}; }

    // Poll + MutationObserver
    var done = false;
    var pollId = setInterval(function () {
      if (done) return;
      if (document.querySelector(selector)) {
        done = true;
        clearInterval(pollId);
        observer.disconnect();
        cb();
      }
    }, 300);
    timeoutIds.push(pollId);

    var observer = new MutationObserver(function () {
      if (done) return;
      if (document.querySelector(selector)) {
        done = true;
        clearInterval(pollId);
        observer.disconnect();
        cb();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return function cleanup() {
      done = true;
      clearInterval(pollId);
      observer.disconnect();
    };
  }

  // ==============================
  // Step Execution
  // ==============================

  function runStep(index) {
    if (index >= steps.length) {
      completeTutorial();
      return;
    }
    currentStep = index;
    var step = steps[index];
    var targetSelector = isMobile && step.targetMobile ? step.targetMobile : step.target;

    // Resolve target element
    var targetEl = targetSelector ? document.querySelector(targetSelector) : null;

    // Create highlight on target
    if (targetEl) {
      createHighlight();
      positionHighlight(targetEl);
    }

    // Point arm at target
    if (buddyRef && targetEl) {
      var rect = targetEl.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      buddyRef.controller.pointAt(cx, cy, step.arm);
    }

    // Say main dialogue
    if (buddyRef && step.dialogue) {
      buddyRef.controller.say(step.dialogue);
    }

    // RAF loop: keep highlight and arm tracking the target (it may move)
    function trackTarget() {
      if (!active || currentStep !== index) return;
      var sel = isMobile && step.targetMobile ? step.targetMobile : step.target;
      var el = sel ? document.querySelector(sel) : null;
      if (el) {
        positionHighlight(el);
        if (buddyRef) {
          var r = el.getBoundingClientRect();
          buddyRef.controller.pointAt(
            r.left + r.width / 2,
            r.top + r.height / 2,
            step.arm
          );
        }
      }
      rafId = requestAnimationFrame(trackTarget);
    }
    rafId = requestAnimationFrame(trackTarget);

    // Start timeout reminders
    for (var i = 0; i < step.reminders.length; i++) {
      (function (reminder) {
        var tid = setTimeout(function () {
          if (!active || currentStep !== index) return;
          if (buddyRef && reminder.text) {
            buddyRef.controller.say(reminder.text);
          }
        }, reminder.seconds * 1000);
        timeoutIds.push(tid);
      })(step.reminders[i]);
    }

    // Wait for condition
    if (step.wait) {
      var onDone = function () {
        if (!active || currentStep !== index) return;
        cleanupStep();
        runStep(index + 1);
      };

      switch (step.wait.type) {
        case 'click':
          waitCleanup = waitForClick(step.wait.arg, 'click', onDone);
          break;
        case 'dblclick':
          waitCleanup = waitForClick(step.wait.arg, 'dblclick', onDone);
          break;
        case 'custom':
          waitCleanup = waitForCustomEvent(step.wait.arg, onDone);
          break;
        case 'visible':
          waitCleanup = waitForVisible(step.wait.arg, onDone);
          break;
      }
    }
  }

  function cleanupStep() {
    cancelAnimationFrame(rafId);
    for (var i = 0; i < timeoutIds.length; i++) {
      clearTimeout(timeoutIds[i]);
      clearInterval(timeoutIds[i]); // covers setInterval IDs too
    }
    timeoutIds = [];
    if (waitCleanup) {
      waitCleanup();
      waitCleanup = null;
    }
    removeHighlight();
    if (buddyRef) {
      buddyRef.controller.stopPointing();
    }
  }

  function completeTutorial() {
    cleanupStep();
    hideSkipBtn();
    active = false;
    currentStep = -1;
    localStorage.setItem(STORAGE_KEY, 'true');
    if (buddyRef) {
      buddyRef.controller.say('{rainbow}Tutorial complete!{/rainbow} You\'re ready to find amazing viewpoints!');
    }
  }

  // ==============================
  // Public API
  // ==============================

  function start(buddy) {
    if (active) return;
    buddyRef = buddy;
    active = true;

    fetch(SCRIPT_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('Failed to load tutorial script');
        return res.text();
      })
      .then(function (text) {
        steps = parseScript(text);
        if (steps.length === 0) {
          active = false;
          return;
        }
        showSkipBtn();
        runStep(0);
      })
      .catch(function (err) {
        console.error('[Tutorial] Failed to load script:', err);
        active = false;
      });
  }

  function skip() {
    if (!active) return;
    cleanupStep();
    hideSkipBtn();
    active = false;
    currentStep = -1;
    localStorage.setItem(STORAGE_KEY, 'true');
    if (buddyRef) {
      buddyRef.controller.dismissSpeech();
    }
  }

  function replay(buddy) {
    localStorage.removeItem(STORAGE_KEY);
    skip(); // clean up any lingering state
    start(buddy);
  }

  function shouldRun() {
    return localStorage.getItem(STORAGE_KEY) !== 'true';
  }

  window.Tutorial = {
    start: start,
    skip: skip,
    replay: replay,
    shouldRun: shouldRun,
    get isActive() { return active; },
  };
})();
```

- [ ] **Step 6.2: Commit**

```bash
git add tutorial.js
git commit -m "feat: add tutorial orchestrator with script parser, highlight, and wait conditions"
```

---

## Task 7: Add tutorial CSS styles

**Repo:** world-toolkit
**Files:**
- Modify: `style.css` (append before mobile breakpoint)

- [ ] **Step 7.1: Add tutorial highlight and skip button styles**

Insert before the `/* ===== Mobile Layout ===== */` comment (line 1528):

```css
/* ===== Tutorial Overlay ===== */
.tutorial-highlight {
  position: fixed;
  z-index: 500000;
  pointer-events: none;
  border: 2px solid var(--accent-cyan);
  box-shadow:
    0 0 0 4px rgba(151, 214, 244, 0.3),
    0 0 20px rgba(9, 172, 226, 0.4);
  animation: tutorial-pulse 1.5s ease-in-out infinite;
  transition: left 0.15s ease, top 0.15s ease, width 0.15s ease, height 0.15s ease;
}

@keyframes tutorial-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(151, 214, 244, 0.3), 0 0 20px rgba(9, 172, 226, 0.4); }
  50% { box-shadow: 0 0 0 8px rgba(151, 214, 244, 0.15), 0 0 30px rgba(9, 172, 226, 0.6); }
}

.tutorial-skip-btn {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 500001;
  padding: 6px 16px;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-md);
  background: var(--panel-bg);
  backdrop-filter: var(--backdrop-blur);
  color: var(--text-muted);
  font-family: var(--font-main);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.tutorial-skip-btn:hover {
  color: var(--text-dark);
  border-color: var(--accent-blue);
}
```

- [ ] **Step 7.2: Commit**

```bash
git add style.css
git commit -m "feat: add tutorial highlight pulse and skip button styles"
```

---

## Task 8: Wire tutorial into buddy-integration.js

**Repo:** world-toolkit
**Files:**
- Modify: `buddy-integration.js`

Three changes: (a) remove the mobile early-return so buddy works on all screens, (b) use miniature mode on mobile and full mode on desktop, (c) start the tutorial on first visit and add radial menu items for skip/replay.

- [ ] **Step 8.1: Remove mobile gate and adjust mode**

Replace the mobile gate at the top of the IIFE (lines 9-12):

```javascript
  // Skip on mobile — buddy would obstruct the small screen
  var IS_MOBILE = window.matchMedia('(max-width: 600px)').matches ||
    ('ontouchstart' in window && window.innerWidth <= 600);
  if (IS_MOBILE) return;
```

With:

```javascript
  var IS_MOBILE = window.matchMedia('(max-width: 600px)').matches ||
    ('ontouchstart' in window && window.innerWidth <= 600);
```

(Remove the `if (IS_MOBILE) return;` line only.)

- [ ] **Step 8.2: Set mode based on device in initBuddy**

In `initBuddy()` (around line 42), change the mode from hardcoded `'miniature'` to device-dependent:

Replace:
```javascript
      buddy = window.DesktopBuddy.init({
        scriptUrl: 'scripts/rocky-terrain.md',
        startSequence: 'welcome',
        mode: 'miniature',
        x: window.innerWidth - 120,
        y: window.innerHeight - 100,
      });
```

With:
```javascript
      var buddyMode = IS_MOBILE ? 'miniature' : 'full';
      buddy = window.DesktopBuddy.init({
        scriptUrl: 'scripts/rocky-terrain.md',
        startSequence: window.Tutorial && window.Tutorial.shouldRun() ? undefined : 'welcome',
        mode: buddyMode,
        x: IS_MOBILE ? window.innerWidth - 60 : window.innerWidth - 120,
        y: IS_MOBILE ? window.innerHeight - 50 : undefined,
      });
```

Note: when tutorial should run, we skip the welcome sequence (set `startSequence: null`) so the tutorial speaks first.

- [ ] **Step 8.3: Start tutorial after buddy init**

In the patched `initBuddy` function (the one that applies saved colors, around line 485-490), add tutorial start after the color-apply timeouts:

Replace:
```javascript
    var _origInitBuddy = initBuddy;
    initBuddy = function () {
      _origInitBuddy();
      // Apply saved colors after a short delay (models may still be loading)
      setTimeout(applySavedColors, 500);
      setTimeout(applySavedColors, 2000); // retry after models load
    };
```

With:
```javascript
    var _origInitBuddy = initBuddy;
    initBuddy = function () {
      _origInitBuddy();
      // Apply saved colors after a short delay (models may still be loading)
      setTimeout(applySavedColors, 500);
      setTimeout(applySavedColors, 2000); // retry after models load
      // Start tutorial on first visit (after a short delay for models to load)
      if (window.Tutorial && window.Tutorial.shouldRun()) {
        setTimeout(function () { window.Tutorial.start(buddy); }, 1500);
      }
    };
```

- [ ] **Step 8.4: Add tutorial items to radial menu**

The radial menu is built in the desktop-buddy embed.ts `buildMenuItems()`. Since that's in the IIFE bundle, we can't modify it from here. Instead, add the tutorial items dynamically after buddy init by using the radial menu's existing API.

Actually, looking at the code, `buildMenuItems()` is called every time the menu is shown (line 207 in embed.ts). The items are rebuilt fresh each time. We need a different approach.

The returned `buddy` object has `buddy.radialMenu` which is the `RadialMenu` instance, and `buildMenuItems` is an internal function in the IIFE closure. We can't modify it.

The cleanest approach: add our own context menu handler that intercepts the right-click and injects extra items. But that's complex.

Simpler approach: after `buddy` is initialized, we can monkey-patch the context menu handler. But the handler is inside the IIFE closure.

Simplest approach that works: The `buddy` object returned from `init()` includes `radialMenu`. We can listen for the `contextmenu` event ourselves at a higher priority and call `radialMenu.show()` with augmented items. But we don't have access to `buildMenuItems()`.

Given the constraints of the IIFE architecture, the most practical approach is to add a skip button (already done in tutorial.js) for during-tutorial, and add a "Replay Tutorial" option via a simple keyboard shortcut or a floating button that appears after tutorial completion. The spec also mentions the skip button as a radial menu item, but this would require modifying the desktop-buddy embed.ts to accept external menu item injection.

Let's add a `menuItems` hook to the returned buddy object. This requires a small change to `embed.ts`.

**In `../desktop-buddy/src/embed.ts`**, add after the `buildMenuItems` function (before the return statement):

Add a public `extraMenuItems` array on the returned object. Then modify the contextmenu handler to include them.

This is a cross-repo change, so we need to go back to desktop-buddy. Add this field and wire it up:

In `embed.ts`, add a mutable array before the return:

```typescript
  /** Extra menu items injected by host page (e.g. tutorial skip/replay) */
  const extraMenuItems: RadialMenuItem[] = [];
```

Modify the contextMenuHandler to append extra items:

```typescript
  const contextMenuHandler = (e: MouseEvent) => {
    if (!isOnCharacter(e.clientX, e.clientY)) return;
    e.preventDefault();
    e.stopPropagation();

    if (radialMenu.isVisible) {
      radialMenu.hide();
      return;
    }

    const items = buildMenuItems();
    items.push(...extraMenuItems);
    radialMenu.show(e.clientX, e.clientY, items);
  };
```

And include it in the return:
```typescript
  return {
    controller,
    scriptRunner,
    events,
    radialMenu,
    extraMenuItems,
    start,
    stop,
    setMode,
    destroy: () => { ... },
  };
```

Then in `buddy-integration.js`, after tutorial init:

```javascript
      // Add tutorial radial menu items
      if (buddy.extraMenuItems) {
        if (window.Tutorial && !window.Tutorial.shouldRun()) {
          buddy.extraMenuItems.push({
            label: 'Tutorial',
            icon: '\uD83D\uDCD6',
            action: function () {
              window.Tutorial.replay(buddy);
            },
          });
        }
      }
```

And during tutorial, add a skip item:
```javascript
      if (window.Tutorial && window.Tutorial.shouldRun()) {
        buddy.extraMenuItems.push({
          label: 'Skip Tutorial',
          icon: '\u23ED',
          action: function () {
            window.Tutorial.skip();
            // Replace skip with replay
            buddy.extraMenuItems.length = 0;
            buddy.extraMenuItems.push({
              label: 'Tutorial',
              icon: '\uD83D\uDCD6',
              action: function () {
                window.Tutorial.replay(buddy);
              },
            });
          },
        });
      }
```

- [ ] **Step 8.5: Commit buddy-integration.js**

```bash
git add buddy-integration.js
git commit -m "feat: enable buddy on mobile, wire tutorial start and radial menu items"
```

---

## Task 9: Add extraMenuItems to desktop-buddy embed.ts and rebuild

**Repo:** `../desktop-buddy/`
**Files:**
- Modify: `src/embed.ts`

- [ ] **Step 9.1: Add extraMenuItems array and wire into context menu**

In `src/embed.ts`, add the `extraMenuItems` array before the context menu handler (before line 196):

```typescript
  /** Extra menu items injected by host page (e.g. tutorial skip/replay) */
  const extraMenuItems: RadialMenuItem[] = [];
```

Modify the contextMenuHandler (around line 196-209). Change:
```typescript
    radialMenu.show(e.clientX, e.clientY, buildMenuItems());
```
To:
```typescript
    const items = buildMenuItems();
    items.push(...extraMenuItems);
    radialMenu.show(e.clientX, e.clientY, items);
```

Add `extraMenuItems` to the return object (around line 325):
```typescript
  return {
    controller,
    scriptRunner,
    events,
    radialMenu,
    extraMenuItems,
    start,
    stop,
    setMode,
    destroy: () => {
```

- [ ] **Step 9.2: Build and copy to world-toolkit**

```bash
cd ../desktop-buddy && pnpm build
cp dist/desktop-buddy.iife.js ../world-toolkit/vendor/desktop-buddy/
```

- [ ] **Step 9.3: Commit in desktop-buddy**

```bash
cd ../desktop-buddy
git add src/embed.ts
git commit -m "feat: add extraMenuItems for host-page radial menu injection"
```

- [ ] **Step 9.4: Commit updated bundle in world-toolkit**

```bash
cd /home/alphanumeric/Documents/Programming/AI/world-toolkit
git add vendor/desktop-buddy/desktop-buddy.iife.js
git commit -m "chore: rebuild desktop-buddy bundle with extraMenuItems support"
```

---

## Task 10: Add tutorial script tag to index.html

**Repo:** world-toolkit
**Files:**
- Modify: `index.html:312`

- [ ] **Step 10.1: Add script tag**

After the `<script src="buddy-integration.js"></script>` line (line 312), add:

```html
  <script src="tutorial.js"></script>
```

- [ ] **Step 10.2: Commit**

```bash
git add index.html
git commit -m "feat: load tutorial.js in index.html"
```

---

## Task 11: Manual verification

This task covers the verification matrix from the spec. No code changes — just testing.

- [ ] **Step 11.1: Start dev server**

```bash
cd /home/alphanumeric/Documents/Programming/AI/world-toolkit
python3 -m http.server 8765
```

- [ ] **Step 11.2: Desktop test — clear localStorage and reload**

Open `http://localhost:8765/` in the browser. Open DevTools → Application → Local Storage and delete `sv_tutorial_done`. Reload.

Verify:
- Rocky appears in full mode
- Tutorial auto-starts after ~1.5s
- Rocky points right arm at "Search for Spots" icon with pulsing highlight
- Wait 10s+ — escalating reminder dialogue appears
- Double-click icon — highlight moves to rectangle draw tool
- Draw rectangle — highlight moves to Analyze button
- Click Analyze — wait for results, highlight on result card
- Tutorial completes, `sv_tutorial_done` set in localStorage
- Refresh — no tutorial, Rocky behaves normally
- Right-click Rocky — "Tutorial" menu item replays it

- [ ] **Step 11.3: Mobile test**

Open DevTools → toggle device toolbar (mobile viewport ~375px wide).

Verify:
- Rocky appears in miniature mode
- Tutorial starts with `target-mobile` selectors
- Skip button visible and functional
- After tutorial, buddy continues working

- [ ] **Step 11.4: Edge case checks**

- Resize window during tutorial — highlight tracks element
- Click "Skip tutorial" mid-step — all cleanup runs
- After skip, right-click Rocky — "Tutorial" item replays

---

## Dependency Order

```
Task 1 (Buddy3D hook)
  → Task 2 (BuddyController pointAt)
    → Task 3 (rebuild bundle)
Task 9 (extraMenuItems in embed.ts)
  → rebuild included in Task 9

Task 4 (wt:rectangle-drawn event) — independent
Task 5 (tutorial script) — independent
Task 7 (CSS styles) — independent

Task 6 (tutorial.js) — depends on Tasks 3, 4, 5
Task 8 (buddy-integration.js) — depends on Tasks 3, 6, 9
Task 10 (index.html) — depends on Task 6

Task 11 (verification) — depends on all above
```

Recommended execution order: Tasks 1→2→9→3(+9 rebuild)→4→5→7→6→8→10→11
