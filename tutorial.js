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
        var dialogueText = line.replace(/^>\s*/, '');
        // If there's a pending reminder with no text, assign to it
        var pendingReminder = null;
        for (var r = step.reminders.length - 1; r >= 0; r--) {
          if (step.reminders[r].text === null) {
            pendingReminder = step.reminders[r];
            break;
          }
        }
        if (pendingReminder) {
          pendingReminder.text = dialogueText;
        } else {
          step.dialogue = dialogueText;
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
      buddyRef.controller.say(window.i18n ? window.i18n.t('tutorialComplete') : '{rainbow}Tutorial complete!{/rainbow} You\'re ready to find amazing viewpoints!');
    }
    document.dispatchEvent(new CustomEvent('wt:tutorial-done'));
  }

  // ==============================
  // Public API
  // ==============================

  function start(buddy) {
    if (active) return;
    buddyRef = buddy;
    active = true;

    var activeLang = window.getCurrentLang ? window.getCurrentLang() : 'en';
    var scriptUrl = 'scripts/rocky-tutorial.' + activeLang + '.md';

    fetch(scriptUrl)
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
    // Clean up without re-setting localStorage (skip() would re-set it)
    if (active) {
      cleanupStep();
      hideSkipBtn();
      active = false;
      currentStep = -1;
      if (buddyRef) buddyRef.controller.dismissSpeech();
    }
    localStorage.removeItem(STORAGE_KEY);
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
