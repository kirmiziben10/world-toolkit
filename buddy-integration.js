/**
 * buddy-integration.js
 * Wires the Desktop Buddy (Rocky) into the World Toolkit UI.
 * Requires desktop-buddy IIFE bundle loaded before this script.
 */
(function () {
  'use strict';

  // Skip on mobile — buddy would obstruct the small screen
  var IS_MOBILE = window.matchMedia('(max-width: 600px)').matches ||
    ('ontouchstart' in window && window.innerWidth <= 600);
  if (IS_MOBILE) return;

  function setup() {
    if (!window.DesktopBuddy) {
      console.warn('[BuddyIntegration] DesktopBuddy not found on window');
      return;
    }

    // --- State ---
    var buddy = null;
    var visible = localStorage.getItem('sv_buddy_visible') !== 'false'; // default: visible
    var lastReactionTime = 0;
    var REACTION_COOLDOWN = 8000; // ms
    var lastActivityTime = Date.now();
    var idleTimerId = null;
    var IDLE_TIMEOUT = 60000; // 60s

    // --- Idle tips ---
    var idleTips = [
      '{color:cyan}Pro tip:{/color} Zoom in closer on the map for {bold}more precise{/bold} viewpoint locations!',
      'Did you know? {bold}Valley depth{/bold} is the single most important factor in the {rainbow}scenic score{/rainbow}!',
      '{color:green}Camping tip:{/color} Look for spots with slopes under {bold}10 degrees{/bold} — your back will thank you!',
      'The {bold}globe{/bold} on the left is interactive! Spin it to explore {rainbow}the world{/rainbow}!',
      '{shake}Fun fact:{/shake} The terrain data comes from open elevation tiles at {bold}~58m resolution{/bold}!',
      'Try using the {color:cyan}Closeness{/color} slider to find viewpoints {bold}nearer{/bold} to dramatic peaks!',
      '{bold}Peak prominence{/bold} measures how much a mountain stands out — higher is more {rainbow}dramatic{/rainbow}!',
    ];

    // --- Init ---
    function initBuddy() {
      buddy = window.DesktopBuddy.init({
        scriptUrl: 'scripts/rocky-terrain.md',
        startSequence: 'welcome',
        mode: 'miniature',
        x: window.innerWidth - 120,
        y: window.innerHeight - 100,
      });
      document.addEventListener('pointerdown', resetActivity);
      document.addEventListener('keydown', resetActivity);
      startIdleTimer();
    }

    function destroyBuddy() {
      if (!buddy) return;
      stopIdleTimer();
      document.removeEventListener('pointerdown', resetActivity);
      document.removeEventListener('keydown', resetActivity);
      buddy.destroy();
      buddy = null;
    }

    // --- Cooldown-aware speech ---
    function reactWithCooldown(text, triggerName) {
      if (!buddy) return;
      var now = Date.now();
      if (now - lastReactionTime < REACTION_COOLDOWN) return;
      lastReactionTime = now;
      buddy.controller.say(text);
      if (triggerName) {
        buddy.controller.handleTrigger(triggerName);
      }
    }

    // --- Activity tracking for idle tips ---
    function resetActivity() {
      lastActivityTime = Date.now();
    }

    function startIdleTimer() {
      stopIdleTimer();
      idleTimerId = setInterval(function () {
        if (!buddy) return;
        if (Date.now() - lastActivityTime > IDLE_TIMEOUT) {
          var tip = idleTips[Math.floor(Math.random() * idleTips.length)];
          reactWithCooldown(tip);
          lastActivityTime = Date.now(); // reset so next tip waits another 60s
        }
      }, 15000); // check every 15s
    }

    function stopIdleTimer() {
      if (idleTimerId) {
        clearInterval(idleTimerId);
        idleTimerId = null;
      }
    }

    // --- World Toolkit event wiring ---

    document.addEventListener('wt:analysis-start', function () {
      resetActivity();
      reactWithCooldown(
        '{color:cyan}Ooh!{/color} Scanning the terrain... Let\'s find some {bold}amazing{/bold} viewpoints!',
        'wave'
      );
    });

    document.addEventListener('wt:results', function (e) {
      resetActivity();
      var count = e.detail && e.detail.count;
      if (count == null) return;
      if (count === 0) {
        reactWithCooldown(
          'Hmm, {shake}no spots{/shake} matched. Try a {bold}larger area{/bold} or {color:green}lower{/color} the filters!'
        );
      } else if (count < 10) {
        reactWithCooldown(
          '{color:cyan}Found ' + count + ' viewpoint' + (count === 1 ? '' : 's') + '!{/color} ' +
          'Quality over quantity! {bold}Click a marker{/bold} to explore.'
        );
      } else {
        reactWithCooldown(
          '{rainbow}Wow!{/rainbow} {bold}' + count + ' viewpoints{/bold} found! ' +
          'That\'s a {shake}goldmine{/shake} of scenic spots!'
        );
      }
    });

    document.addEventListener('wt:like', function (e) {
      if (!e.detail || !e.detail.added) return;
      resetActivity();
      reactWithCooldown(
        'Great pick! I bet the view from there is {rainbow}breathtaking{/rainbow}!'
      );
    });

    document.addEventListener('wt:star', function (e) {
      if (!e.detail || !e.detail.added) return;
      resetActivity();
      reactWithCooldown(
        '{bold}Starred!{/bold} Don\'t forget your {color:green}hiking boots{/color}!'
      );
    });

    // --- Desktop icon toggle ---
    var iconEl = document.getElementById('icon-rocky');
    if (iconEl) {
      iconEl.addEventListener('dblclick', function () {
        visible = !visible;
        localStorage.setItem('sv_buddy_visible', visible ? 'true' : 'false');
        if (visible) {
          if (!buddy) initBuddy();
        } else {
          destroyBuddy();
        }
      });
    }

    // --- Debug color menu ---
    var SEGMENT_LABELS = {
      head: 'Head',
      torso: 'Torso',
      armL: 'Left Arm',
      armR: 'Right Arm',
      legL: 'Left Leg',
      legR: 'Right Leg',
    };
    var STORAGE_KEY = 'sv_buddy_colors';
    var debugPanel = null;

    function hexFromInt(n) {
      return '#' + ('000000' + n.toString(16)).slice(-6);
    }

    function intFromHex(hex) {
      return parseInt(hex.replace('#', ''), 16);
    }

    function loadSavedColors() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    }

    function saveColors(colors) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
    }

    function applyColors(colors) {
      if (!buddy) return;
      var segments = buddy.controller.buddy.segments;
      for (var key in colors) {
        if (segments[key]) {
          segments[key].mesh.material.color.set(intFromHex(colors[key]));
        }
      }
    }

    function applySavedColors() {
      var colors = loadSavedColors();
      if (colors) applyColors(colors);
    }

    function getCurrentColors() {
      if (!buddy) return {};
      var segments = buddy.controller.buddy.segments;
      var colors = {};
      for (var key in SEGMENT_LABELS) {
        colors[key] = hexFromInt(segments[key].mesh.material.color.getHex());
      }
      return colors;
    }

    function createDebugPanel() {
      var panel = document.createElement('div');
      panel.id = 'buddy-debug-panel';
      panel.innerHTML = '<div class="bdp-title">Rocky Debug<button class="bdp-close">\u00d7</button></div><div class="bdp-body"></div>';

      var style = document.createElement('style');
      style.textContent =
        '#buddy-debug-panel{position:fixed;top:60px;right:20px;z-index:1000001;width:220px;' +
        'border-radius:8px;overflow:hidden;font-family:var(--font-main,system-ui,sans-serif);' +
        'font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,0.25);border:1px solid var(--win-border-stroke,#97D6F4);' +
        'background:var(--panel-bg,rgba(240,245,250,0.95));backdrop-filter:blur(8px)}' +
        '.bdp-title{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;' +
        'background:var(--panel-header-bg,linear-gradient(180deg,#09ACE2 0%,#058CB9 100%));' +
        'color:#fff;font-weight:600;font-size:12px;text-shadow:0 1px 0 rgba(0,0,0,0.3);cursor:move}' +
        '.bdp-close{background:none;border:none;color:#fff;font-size:16px;cursor:pointer;padding:0 2px;line-height:1}' +
        '.bdp-close:hover{color:#fcc}' +
        '.bdp-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px}' +
        '.bdp-row{display:flex;align-items:center;justify-content:space-between}' +
        '.bdp-row label{font-size:12px;color:var(--text-dark,#1a1a2e)}' +
        '.bdp-row input[type=color]{width:32px;height:22px;border:1px solid #b0c4d8;border-radius:3px;' +
        'padding:0;cursor:pointer;background:none}' +
        '.bdp-btn{display:block;width:100%;padding:4px 0;margin-top:2px;border:1px solid var(--accent-blue-dark,#058CB9);' +
        'border-radius:4px;background:var(--btn-blue,linear-gradient(180deg,#4DC4EB 0%,#09ACE2 50%,#058CB9 100%));' +
        'color:#fff;font-size:11px;font-weight:600;cursor:pointer;text-align:center}' +
        '.bdp-btn:hover{background:var(--btn-blue-hover,linear-gradient(180deg,#5DD4FB 0%,#19BCE2 50%,#069CC9 100%))}';
      document.head.appendChild(style);

      var body = panel.querySelector('.bdp-body');
      var inputs = {};

      for (var key in SEGMENT_LABELS) {
        var row = document.createElement('div');
        row.className = 'bdp-row';
        var lbl = document.createElement('label');
        lbl.textContent = SEGMENT_LABELS[key];
        var inp = document.createElement('input');
        inp.type = 'color';
        inp.dataset.seg = key;
        inputs[key] = inp;
        row.appendChild(lbl);
        row.appendChild(inp);
        body.appendChild(row);
      }

      // Reset button
      var resetBtn = document.createElement('button');
      resetBtn.className = 'bdp-btn';
      resetBtn.textContent = 'Reset to Default';
      body.appendChild(resetBtn);

      document.body.appendChild(panel);

      // Populate current colors
      function syncInputs() {
        var colors = getCurrentColors();
        for (var k in colors) {
          if (inputs[k]) inputs[k].value = colors[k];
        }
      }
      syncInputs();

      // Live color change
      for (var seg in inputs) {
        inputs[seg].addEventListener('input', function () {
          var s = this.dataset.seg;
          if (buddy && buddy.controller.buddy.segments[s]) {
            buddy.controller.buddy.segments[s].mesh.material.color.set(intFromHex(this.value));
          }
          saveColors(getCurrentColors());
        });
      }

      // Reset
      resetBtn.addEventListener('click', function () {
        localStorage.removeItem(STORAGE_KEY);
        // Re-read default colors from the segments (they're already in the material,
        // but we lost the originals — use the known defaults from Buddy3D)
        var defaults = {
          head: '#6b7b8d', torso: '#8b6b4a', armL: '#5a6b5a',
          armR: '#5a6b5a', legL: '#7a7a7a', legR: '#7a7a7a',
        };
        applyColors(defaults);
        syncInputs();
      });

      // Close button
      panel.querySelector('.bdp-close').addEventListener('click', function () {
        toggleDebugPanel();
      });

      // Draggable title bar
      var titleBar = panel.querySelector('.bdp-title');
      var dragging = false, dx = 0, dy = 0;
      titleBar.addEventListener('pointerdown', function (e) {
        if (e.target.classList.contains('bdp-close')) return;
        dragging = true;
        dx = e.clientX - panel.offsetLeft;
        dy = e.clientY - panel.offsetTop;
        e.preventDefault();
      });
      document.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        panel.style.left = (e.clientX - dx) + 'px';
        panel.style.right = 'auto';
        panel.style.top = (e.clientY - dy) + 'px';
      });
      document.addEventListener('pointerup', function () {
        dragging = false;
      });

      return panel;
    }

    function toggleDebugPanel() {
      if (debugPanel) {
        debugPanel.remove();
        debugPanel = null;
      } else {
        if (!buddy) return;
        debugPanel = createDebugPanel();
      }
    }

    // Ctrl+Shift+B toggles debug panel
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        toggleDebugPanel();
      }
    });

    // --- Start ---
    // Patch initBuddy to apply saved colors after init
    var _origInitBuddy = initBuddy;
    initBuddy = function () {
      _origInitBuddy();
      // Apply saved colors after a short delay (models may still be loading)
      setTimeout(applySavedColors, 500);
      setTimeout(applySavedColors, 2000); // retry after models load
    };

    if (visible) {
      initBuddy();
    }
  }

  // Handle both cases: DOM already ready (scripts at bottom of body) or still loading
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
