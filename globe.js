// globe.js — Interactive 3D Earth widget using p5.js (WEBGL)
(function () {
  const SIZE = 150;
  const RADIUS = 74;
  const DAMPING = 0.91;
  const DRAG_SENSITIVITY = 0.008;
  const AUTO_SPIN = 0.0015;
  const GEOCODE_DELAY = 700;
  const SETTLE_THRESHOLD = 0.002;
  const SHOWCASE_DELAY = 20000;       // 20 seconds idle before auto-rotate
  const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

  // Rotation & velocity
  let rotX = 0, rotY = 0;
  let velX = 0, velY = 0;

  // Interaction
  let dragging = false;
  let lastMX = 0, lastMY = 0;
  let totalDragDist = 0;

  // Globe state machine: dragging → decelerating → settled → showcase
  let settled = false;
  let showcasing = false;
  let pinLat = null, pinLng = null;   // lat/lng where the dot is pinned (null = center reticle)
  let pinSurface = null;              // cached latLngToSurface result for pinned dot
  let showcaseTimer = null;

  // Resources
  let earthTex = null;
  let canvasEl = null;
  let labelEl = null;
  let geocodeTimer = null;

  // ---- Texture: composite satellite tiles at zoom 2 (4×4 = 1024px) then remap ----
  const TEX_ZOOM = 2;
  const TEX_GRID = 1 << TEX_ZOOM;               // 4
  const TEX_SIZE = TEX_GRID * 256;               // 1024

  function loadSatelliteTexture(p) {
    const merc = document.createElement('canvas');
    merc.width = TEX_SIZE;
    merc.height = TEX_SIZE;
    const ctx = merc.getContext('2d');
    let loaded = 0;
    const total = TEX_GRID * TEX_GRID;           // 16

    for (let ty = 0; ty < TEX_GRID; ty++) {
      for (let tx = 0; tx < TEX_GRID; tx++) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          ctx.drawImage(img, tx * 256, ty * 256);
          if (++loaded === total) {
            const eq = mercatorToEquirect(merc);
            p.loadImage(eq.toDataURL('image/jpeg', 0.9), tex => { earthTex = tex; });
          }
        };
        img.onerror = () => { if (++loaded === total) {
          const eq = mercatorToEquirect(merc);
          p.loadImage(eq.toDataURL('image/jpeg', 0.9), tex => { earthTex = tex; });
        }};
        img.src = TILE_URL + '/' + TEX_ZOOM + '/' + ty + '/' + tx;
      }
    }
  }

  function mercatorToEquirect(src) {
    const W = src.width, H = src.height;
    const srcData = src.getContext('2d').getImageData(0, 0, W, H).data;
    const dst = document.createElement('canvas');
    dst.width = W; dst.height = H;
    const dstCtx = dst.getContext('2d');
    const dstImg = dstCtx.createImageData(W, H);
    const out = dstImg.data;
    const DEG2RAD = Math.PI / 180;
    const MAX_MERC_LAT = 85.05113;

    for (let yOut = 0; yOut < H; yOut++) {
      const lat = 90 - (yOut / H) * 180;
      if (Math.abs(lat) >= MAX_MERC_LAT) {
        for (let x = 0; x < W; x++) {
          const i = (yOut * W + x) * 4;
          out[i] = 6; out[i+1] = 20; out[i+2] = 50; out[i+3] = 255;
        }
        continue;
      }
      const latRad = lat * DEG2RAD;
      const mercFrac = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
      const srcY = Math.max(0, Math.min(H - 1, Math.round(mercFrac * H)));
      const srcBase = srcY * W * 4;
      const dstBase = yOut * W * 4;
      for (let x = 0; x < W; x++) {
        const s = srcBase + x * 4, d = dstBase + x * 4;
        out[d] = srcData[s]; out[d+1] = srcData[s+1];
        out[d+2] = srcData[s+2]; out[d+3] = srcData[s+3];
      }
    }
    dstCtx.putImageData(dstImg, 0, 0);
    return dst;
  }

  // ---- Rotation <-> LatLng ----
  function getLatLng() {
    const lat = Math.max(-85, Math.min(85, -rotX * 180 / Math.PI));
    let lng = -(rotY * 180 / Math.PI) - 180;
    lng = ((lng % 360) + 540) % 360 - 180;
    return { lat, lng };
  }

  function setRotFromLatLng(lat, lng) {
    rotX = -lat * Math.PI / 180;
    rotY = -(lng + 180) * Math.PI / 180;
  }

  // Convert lat/lng to a 3D point on the sphere surface (in the sphere's local frame)
  function latLngToSurface(lat, lng, r) {
    const theta = (lng + 180) / 360 * Math.PI * 2;
    const phi = (90 - lat) / 180 * Math.PI;
    return {
      x: r * Math.sin(theta) * Math.sin(phi),
      y: -r * Math.cos(phi),
      z: r * Math.cos(theta) * Math.sin(phi),
    };
  }

  // ---- Reverse geocoding (Nominatim, debounced) ----
  let lastGeoKey = '';

  async function reverseGeocode() {
    const { lat, lng } = getLatLng();
    const key = lat.toFixed(1) + ',' + lng.toFixed(1);
    if (key === lastGeoKey) return;
    lastGeoKey = key;

    try {
      const resp = await fetch(
        'https://nominatim.openstreetmap.org/reverse?lat=' + lat.toFixed(3) +
        '&lon=' + lng.toFixed(3) + '&format=json&zoom=5&accept-language=en',
        { headers: { 'User-Agent': 'WorldToolkit/1.0' } }
      );
      const data = await resp.json();
      const name = data.address
        ? (data.address.country || data.address.ocean || data.display_name)
        : lat.toFixed(1) + '\u00B0, ' + lng.toFixed(1) + '\u00B0';
      showLabel(name || lat.toFixed(1) + '\u00B0, ' + lng.toFixed(1) + '\u00B0');
    } catch {
      showLabel(lat.toFixed(1) + '\u00B0, ' + lng.toFixed(1) + '\u00B0');
    }
  }

  function showLabel(text) {
    if (!labelEl) return;
    labelEl.textContent = text;
    labelEl.hidden = false;
  }

  function scheduleGeocode() {
    clearTimeout(geocodeTimer);
    geocodeTimer = setTimeout(reverseGeocode, GEOCODE_DELAY);
  }

  // ---- Map navigation via custom event ----
  function navigateMap() {
    const { lat, lng } = getLatLng();
    document.dispatchEvent(new CustomEvent('globe-navigate', { detail: { lat, lng } }));
  }

  // ---- State transitions ----
  function onSettle() {
    settled = true;
    velX = 0;
    velY = 0;
    const ll = getLatLng();
    pinLat = ll.lat;
    pinLng = ll.lng;
    pinSurface = latLngToSurface(pinLat, pinLng, RADIUS + 1);
    scheduleGeocode();

    // Start 20s countdown to showcase mode
    clearTimeout(showcaseTimer);
    showcaseTimer = setTimeout(() => {
      showcasing = true;
      settled = false;
      pinLat = null;
      pinLng = null;
      pinSurface = null;
      if (labelEl) labelEl.hidden = true;
    }, SHOWCASE_DELAY);
  }

  function onInteractionStart() {
    settled = false;
    showcasing = false;
    pinLat = null;
    pinLng = null;
    pinSurface = null;
    velX = 0;
    velY = 0;
    clearTimeout(showcaseTimer);
    clearTimeout(geocodeTimer);
    if (labelEl) labelEl.hidden = true;
  }

  // ---- Pointer helpers ----
  function onPointerDown(x, y, e) {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    lastMX = x;
    lastMY = y;
    totalDragDist = 0;
    onInteractionStart();
  }

  function onPointerMove(x, y) {
    if (!dragging) return;
    const dx = x - lastMX;
    const dy = y - lastMY;
    totalDragDist += Math.abs(dx) + Math.abs(dy);
    velY = dx * DRAG_SENSITIVITY;
    velX = -dy * DRAG_SENSITIVITY;
    rotY += velY;
    rotX += velX;
    lastMX = x;
    lastMY = y;
  }

  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    if (canvasEl) canvasEl.style.cursor = 'grab';
    // Tap (no real drag) → immediately settle in place
    if (totalDragDist < 5) {
      onSettle();
    }
  }

  // ---- p5 sketch (instance mode) ----
  const sketch = (p) => {
    p.setup = () => {
      p.setAttributes('antialias', true);
      p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
      const cnv = p.createCanvas(SIZE, SIZE, p.WEBGL);
      cnv.parent('earth-globe');
      canvasEl = cnv.elt;
      canvasEl.style.borderRadius = '50%';
      canvasEl.style.cursor = 'grab';
      canvasEl.style.display = 'block';

      setRotFromLatLng(39.0, 35.5);
      loadSatelliteTexture(p);

      canvasEl.addEventListener('mousedown', (e) => {
        const r = canvasEl.getBoundingClientRect();
        onPointerDown(e.clientX - r.left, e.clientY - r.top, e);
        canvasEl.style.cursor = 'grabbing';
      });
      canvasEl.addEventListener('touchstart', (e) => {
        const r = canvasEl.getBoundingClientRect();
        const t = e.touches[0];
        onPointerDown(t.clientX - r.left, t.clientY - r.top, e);
      }, { passive: false });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const r = canvasEl.getBoundingClientRect();
        onPointerMove(e.clientX - r.left, e.clientY - r.top);
      });
      window.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const r = canvasEl.getBoundingClientRect();
        const t = e.touches[0];
        onPointerMove(t.clientX - r.left, t.clientY - r.top);
        e.preventDefault();
      }, { passive: false });

      window.addEventListener('mouseup', onPointerUp);
      window.addEventListener('touchend', onPointerUp);

      // Initial settle (show Turkey with pinned dot)
      onSettle();
    };

    p.draw = () => {
      p.background(6, 10, 24);

      p.ambientLight(50);
      p.pointLight(255, 250, 240, -300, -150, 300);

      // ---- Physics ----
      if (!dragging) {
        if (showcasing) {
          // Showcase: gentle auto-rotation, no dot, no label
          rotY += AUTO_SPIN;
        } else if (!settled) {
          // Decelerating after release
          rotY += velY;
          rotX += velX;
          velX *= DAMPING;
          velY *= DAMPING;

          // Check if globe has come to rest
          if (Math.abs(velY) < SETTLE_THRESHOLD && Math.abs(velX) < SETTLE_THRESHOLD) {
            onSettle();
          }
        }
        // If settled: no rotation, globe is still
      }

      // Clamp latitude
      rotX = p.constrain(rotX, -p.HALF_PI + 0.15, p.HALF_PI - 0.15);

      // ---- Draw globe ----
      p.push();
      p.rotateX(rotX);
      p.rotateY(rotY);

      // Earth sphere
      p.push();
      if (earthTex) {
        p.noStroke();
        p.texture(earthTex);
      } else {
        p.noStroke();
        p.ambientMaterial(30, 70, 140);
      }
      p.sphere(RADIUS, 48, 32);
      p.pop();

      // Pinned dot on sphere surface (settled state)
      if (pinSurface !== null) {
        const pt = pinSurface;
        p.push();
        p.translate(pt.x, pt.y, pt.z);
        p.noStroke();
        p.emissiveMaterial(255);
        p.sphere(2.5);
        p.pop();
      }

      p.pop(); // end rotation

      // Center reticle (during drag or deceleration — not settled, not showcase)
      if (pinLat === null && !showcasing) {
        p.push();
        p.translate(0, 0, RADIUS + 1);
        p.noStroke();
        p.emissiveMaterial(255);
        p.sphere(2.5);
        p.pop();
      }
    };
  };

  // ---- Bootstrap ----
  function initGlobe() {
    const img = document.getElementById('earth-img');
    if (img) img.remove();

    labelEl = document.createElement('div');
    labelEl.id = 'globe-label';
    labelEl.hidden = true;
    labelEl.addEventListener('click', navigateMap);
    const globe = document.getElementById('earth-globe');
    globe.parentElement.insertBefore(labelEl, globe.nextSibling);

    new p5(sketch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGlobe);
  } else {
    initGlobe();
  }
})();
