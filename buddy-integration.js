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

    // --- Start ---
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
