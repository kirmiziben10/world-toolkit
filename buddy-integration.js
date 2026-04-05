/**
 * buddy-integration.js
 * Wires the Desktop Buddy (Rocky) into the World Toolkit UI.
 * Requires desktop-buddy IIFE bundle loaded before this script.
 */
(function () {
  'use strict';

  var IS_MOBILE = window.matchMedia('(max-width: 600px)').matches ||
    ('ontouchstart' in window && window.innerWidth <= 600);

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
    function getIdleTips() {
      var t = window.i18n.t;
      return [
        t('tipZoom'),
        t('tipValley'),
        t('tipCamping'),
        t('tipGlobe'),
        t('tipTerrain'),
        t('tipCloseness'),
        t('tipProminence'),
      ];
    }

    function getCurrentLang() {
      var lang = localStorage.getItem('sv_buddy_lang');
      if (!lang && navigator.language) {
        lang = navigator.language.split('-')[0];
      }
      return lang === 'tr' ? 'tr' : 'en';
    }
    window.getCurrentLang = getCurrentLang;

    // --- Init ---
    function initBuddy() {
      var lang = getCurrentLang();
      var buddyMode = IS_MOBILE ? 'miniature' : 'full';
      buddy = window.DesktopBuddy.init({
        scriptUrl: 'scripts/rocky-terrain.' + lang + '.md',
        startSequence: window.Tutorial && window.Tutorial.shouldRun() ? undefined : 'welcome',
        mode: buddyMode,
        x: IS_MOBILE ? window.innerWidth - 60 : window.innerWidth - 120,
        y: IS_MOBILE ? window.innerHeight - 50 : undefined,
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
          if (Math.random() < 0.25) {
            orchestrateGlobeSpin();
          } else {
            var tips = getIdleTips();
            var tip = tips[Math.floor(Math.random() * tips.length)];
            reactWithCooldown(tip);
          }
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

    // --- Globe Spin Orchestration ---
    var spinCheckInterval = null;
    var spinAnimInterval = null;

    function orchestrateGlobeSpin() {
      if (!buddy) return;
      if (spinCheckInterval || spinAnimInterval) return; // already running
      var globe = document.getElementById('earth-globe');
      if (!globe) return;

      var rect = globe.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      var radius = rect.width / 2;

      var bounds = buddy.controller.getScreenBounds();
      var bx = bounds.x + bounds.width / 2;
      var by = bounds.y + bounds.height / 2;

      // Ray-march 80px away from the globe's edge
      var dx = cx - bx;
      var dy = buddy.controller.mode === 'full' ? 0 : cy - by;
      var distToCenter = Math.sqrt(dx * dx + dy * dy);

      if (distToCenter === 0) { dx = 1; distToCenter = 1; }

      var nx = dx / distToCenter;
      var ny = dy / distToCenter;

      var targetX = cx - nx * (radius + 80);
      var targetY = cy - ny * (radius + 80);

      // Send Rocky directly to the exact calculated 80px standoff point
      buddy.controller.walkTo(targetX, targetY);

      spinCheckInterval = setInterval(function() {
        if (!buddy || buddy.controller.drag.isDragging) {
          clearInterval(spinCheckInterval);
          spinCheckInterval = null;
          return;
        }

        // Buddy internally nulls walkTarget when he arrives at targetX/Y
        if (buddy.controller.walkTarget == null) {
          clearInterval(spinCheckInterval);
          spinCheckInterval = null;

          buddy.controller.orbitGlobe(cx, cy, 'right');

          var spinTime = 0;
          spinAnimInterval = setInterval(function() {
            if (window.GlobeAPI) {
              window.GlobeAPI.spin(0, -0.04);
            }
            spinTime += 50;
            if (spinTime >= 3000) {
              clearInterval(spinAnimInterval);
              spinAnimInterval = null;
              if (window.GlobeAPI) {
                 window.GlobeAPI.spin((Math.random() - 0.5) * 0.3, -0.15);
              }
              if (buddy) buddy.controller.stopPointing();
            }
          }, 50);
        }
      }, 100);
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

    document.addEventListener('buddy:trigger', function(e) {
      if (e.detail === 'spin-globe') {
        orchestrateGlobeSpin();
      } else if (e.detail === 'lang-en') {
        localStorage.setItem('sv_buddy_lang', 'en');
        if (window.i18n) window.i18n.translatePage();
        setTimeout(function() { destroyBuddy(); initBuddy(); }, 1000);
      } else if (e.detail === 'lang-tr') {
        localStorage.setItem('sv_buddy_lang', 'tr');
        if (window.i18n) window.i18n.translatePage();
        setTimeout(function() { destroyBuddy(); initBuddy(); }, 1000);
      }
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

    // --- Radial menu theme helpers ---
    var RM_STORAGE_KEY = 'sv_rm_theme';

    function hexToRgb(hex) {
      var h = hex.replace('#', '');
      return {
        r: parseInt(h.substring(0, 2), 16),
        g: parseInt(h.substring(2, 4), 16),
        b: parseInt(h.substring(4, 6), 16),
      };
    }

    function hexToRgba(hex, a) {
      var c = hexToRgb(hex);
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
    }

    function lightenHex(hex, amount) {
      var c = hexToRgb(hex);
      var r = Math.min(255, c.r + Math.round(amount * 255));
      var g = Math.min(255, c.g + Math.round(amount * 255));
      var b = Math.min(255, c.b + Math.round(amount * 255));
      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    function applyRmTheme(theme) {
      var root = document.documentElement;
      if (theme.accent) {
        root.style.setProperty('--rm-border', hexToRgba(theme.accent, 0.5));
        root.style.setProperty('--rm-border-hover', hexToRgba(theme.accent, 0.8));
        root.style.setProperty('--rm-dot', hexToRgba(theme.accent, 0.5));
        root.style.setProperty('--rm-dot-border', hexToRgba(theme.accent, 0.8));
        root.style.setProperty('--rm-shadow-hover', '0 2px 20px ' + hexToRgba(theme.accent, 0.2) + ', 0 2px 12px rgba(0,0,0,0.15)');
        root.style.setProperty('--rm-sub-border', hexToRgba(theme.accent, 0.4));
        root.style.setProperty('--rm-sub-border-hover', hexToRgba(theme.accent, 0.7));
        root.style.setProperty('--rm-indicator', hexToRgba(theme.accent, 0.5));
      }
      if (theme.bg) {
        root.style.setProperty('--rm-bg', hexToRgba(theme.bg, 0.92));
        root.style.setProperty('--rm-bg-hover', hexToRgba(lightenHex(theme.bg, -0.08), 0.96));
        root.style.setProperty('--rm-sub-bg', hexToRgba(theme.bg, 0.94));
        root.style.setProperty('--rm-sub-bg-hover', hexToRgba(lightenHex(theme.bg, -0.08), 0.97));
      }
      if (theme.text) {
        root.style.setProperty('--rm-text', theme.text);
        root.style.setProperty('--rm-sub-text', theme.text);
      }
    }

    function loadRmTheme() {
      try {
        var raw = localStorage.getItem(RM_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (_) { return null; }
    }

    function saveRmTheme(theme) {
      localStorage.setItem(RM_STORAGE_KEY, JSON.stringify(theme));
    }

    // Apply saved radial menu theme on load
    var savedRmTheme = loadRmTheme();
    if (savedRmTheme) applyRmTheme(savedRmTheme);

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
        '.bdp-btn:hover{background:var(--btn-blue-hover,linear-gradient(180deg,#5DD4FB 0%,#19BCE2 50%,#069CC9 100%))}' +
        '.bdp-section{font-size:11px;font-weight:700;color:var(--accent-blue-dark,#058CB9);' +
        'margin-top:4px;padding-bottom:2px;border-bottom:1px solid var(--panel-border,rgba(5,140,185,0.25))}' +
        '.bdp-section:first-child{margin-top:0}';
      document.head.appendChild(style);

      var body = panel.querySelector('.bdp-body');
      var inputs = {};

      // --- Character Colors section ---
      var charHeader = document.createElement('div');
      charHeader.className = 'bdp-section';
      charHeader.textContent = 'Character Colors';
      body.appendChild(charHeader);

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

      // --- Radial Menu section ---
      var rmHeader = document.createElement('div');
      rmHeader.className = 'bdp-section';
      rmHeader.textContent = 'Radial Menu';
      body.appendChild(rmHeader);

      var RM_CONTROLS = {
        accent: { label: 'Accent', defaultVal: '#09ACE2' },
        bg: { label: 'Background', defaultVal: '#F0F5FA' },
        text: { label: 'Text', defaultVal: '#1a1a2e' },
      };
      var rmInputs = {};
      var currentRm = loadRmTheme() || {};

      for (var rmKey in RM_CONTROLS) {
        var rmRow = document.createElement('div');
        rmRow.className = 'bdp-row';
        var rmLbl = document.createElement('label');
        rmLbl.textContent = RM_CONTROLS[rmKey].label;
        var rmInp = document.createElement('input');
        rmInp.type = 'color';
        rmInp.dataset.rmkey = rmKey;
        rmInp.value = currentRm[rmKey] || RM_CONTROLS[rmKey].defaultVal;
        rmInputs[rmKey] = rmInp;
        rmRow.appendChild(rmLbl);
        rmRow.appendChild(rmInp);
        body.appendChild(rmRow);
      }

      // Live radial menu color change
      for (var rk in rmInputs) {
        rmInputs[rk].addEventListener('input', function () {
          var k = this.dataset.rmkey;
          var theme = loadRmTheme() || {};
          theme[k] = this.value;
          saveRmTheme(theme);
          applyRmTheme(theme);
        });
      }

      // Reset radial menu
      var rmResetBtn = document.createElement('button');
      rmResetBtn.className = 'bdp-btn';
      rmResetBtn.textContent = 'Reset Menu Colors';
      rmResetBtn.addEventListener('click', function () {
        localStorage.removeItem(RM_STORAGE_KEY);
        // Remove custom properties to restore CSS defaults
        var root = document.documentElement;
        var rmProps = ['--rm-bg', '--rm-bg-hover', '--rm-border', '--rm-border-hover',
          '--rm-text', '--rm-text-sub', '--rm-shadow', '--rm-shadow-hover',
          '--rm-dot', '--rm-dot-border', '--rm-sub-bg', '--rm-sub-bg-hover',
          '--rm-sub-border', '--rm-sub-border-hover', '--rm-sub-text', '--rm-indicator'];
        for (var i = 0; i < rmProps.length; i++) {
          root.style.removeProperty(rmProps[i]);
        }
        // Reset inputs to defaults
        for (var dk in RM_CONTROLS) {
          if (rmInputs[dk]) rmInputs[dk].value = RM_CONTROLS[dk].defaultVal;
        }
      });
      body.appendChild(rmResetBtn);

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
      // Tutorial: start on first visit, add menu items
      if (window.Tutorial && buddy.extraMenuItems) {
        function setReplayMenuItem() {
          buddy.extraMenuItems.length = 0;
          buddy.extraMenuItems.push({
            label: 'Tutorial',
            icon: '\uD83D\uDCD6',
            action: function () {
              window.Tutorial.replay(buddy);
            },
          });
        }

        if (window.Tutorial.shouldRun()) {
          buddy.extraMenuItems.push({
            label: 'Skip Tutorial',
            icon: '\u23ED',
            action: function () {
              window.Tutorial.skip();
              setReplayMenuItem();
            },
          });
          // Swap to replay item when tutorial completes naturally
          document.addEventListener('wt:tutorial-done', setReplayMenuItem, { once: true });
          setTimeout(function () { window.Tutorial.start(buddy); }, 1500);
        } else {
          setReplayMenuItem();
        }
      }
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
