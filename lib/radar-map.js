// ============================================================
// RainViewer radar card — display only
//
// Free Weather Maps API (no key):
//   GET https://api.rainviewer.com/public/weather-maps.json
// Frames: radar.past (≈2 hours, 10-minute steps). Tile URL:
//   {host}{path}/256/{z}/{x}/{y}/2/1_1.png
// Color scheme 2 = Universal Blue (personal-use API). Options 1_1 =
// smoothed + snow. maxNativeZoom 7.
//
// Same approach as the Ops Weather tab: Leaflet, satellite or street
// base, latest frame, play/pause through the catalog. Leaflet CSS/JS
// are not in the first HTML paint — the page injects them lazily.
//
// Display only. Does not change spray scoring.
//
// Works in Node (require) and the browser (global RadarMap).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.RadarMap = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RAINVIEWER_API = 'https://api.rainviewer.com/public/weather-maps.json';
  const LEAFLET_VERSION = '1.9.4';
  const TILE_SIZE = 256;
  const COLOR_SCHEME = 2;
  const TILE_OPTIONS = '1_1';
  const MAX_NATIVE_ZOOM = 7;
  const DEFAULT_ZOOM = 8;
  const RADAR_OPACITY = 0.7;
  const ANIMATION_MS = 500;

  const BASE_LAYERS = {
    street: {
      id: 'street',
      label: 'Street',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    },
    satellite: {
      id: 'satellite',
      label: 'Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19
    }
  };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function leafletAssets() {
    const v = LEAFLET_VERSION;
    return {
      css: `https://unpkg.com/leaflet@${v}/dist/leaflet.css`,
      js: `https://unpkg.com/leaflet@${v}/dist/leaflet.js`
    };
  }

  function wrapIndex(index, length) {
    const n = finiteNumber(length);
    if (n == null || n <= 0) return 0;
    const i = finiteNumber(index);
    if (i == null) return 0;
    return ((Math.trunc(i) % n) + n) % n;
  }

  function radarTileUrl(host, frame) {
    const h = String(host || '').replace(/\/$/, '');
    const path = frame && frame.path != null ? String(frame.path) : '';
    return `${h}${path}/${TILE_SIZE}/{z}/{x}/{y}/${COLOR_SCHEME}/${TILE_OPTIONS}.png`;
  }

  function parseCatalog(json) {
    const empty = { host: '', frames: [], latestIndex: 0 };
    if (!json || typeof json !== 'object' || !json.radar) return empty;
    const past = Array.isArray(json.radar.past) ? json.radar.past : [];
    const nowcast = Array.isArray(json.radar.nowcast) ? json.radar.nowcast : [];
    if (!past.length && !nowcast.length) return empty;
    const host = String(json.host || '').replace(/\/$/, '');

    function toFrame(raw, kind) {
      const time = finiteNumber(raw && raw.time);
      const path = raw && raw.path != null ? String(raw.path) : '';
      if (time == null || !path) return null;
      return { time, path, kind };
    }

    const frames = [];
    for (const raw of past) {
      const frame = toFrame(raw, 'past');
      if (frame) frames.push(frame);
    }
    const latestIndex = Math.max(0, frames.length - 1);
    for (const raw of nowcast) {
      const frame = toFrame(raw, 'nowcast');
      if (frame) frames.push(frame);
    }
    if (!frames.length) return empty;
    return { host, frames, latestIndex };
  }

  function formatFrameClock(unixSec, { utcOffsetSeconds } = {}) {
    const t = finiteNumber(unixSec);
    if (t == null) return '';
    const offset = finiteNumber(utcOffsetSeconds);
    if (offset == null) {
      const d = new Date(t * 1000);
      if (Number.isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    const shifted = new Date(t * 1000 + offset * 1000);
    const h = shifted.getUTCHours();
    const m = shifted.getUTCMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function createAnimator(frames, opts) {
    const options = opts || {};
    const list = Array.isArray(frames) ? frames : [];
    const n = list.length;
    const intervalMs = finiteNumber(options.intervalMs) || ANIMATION_MS;
    const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : setTimeout;
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : clearTimeout;
    const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
    let index = n ? wrapIndex(options.startIndex == null ? n - 1 : options.startIndex, n) : 0;
    let playing = false;
    let timer = null;

    function emit() {
      if (onFrame) onFrame(n ? list[index] : null, index, playing);
    }

    function show(i) {
      if (!n) return 0;
      index = wrapIndex(i, n);
      emit();
      return index;
    }

    function stopTimer() {
      if (timer != null) {
        clearTimeoutFn(timer);
        timer = null;
      }
    }

    function tick() {
      if (!playing) return;
      show(index + 1);
      timer = setTimeoutFn(tick, intervalMs);
    }

    function play() {
      if (playing || n < 2) return false;
      playing = true;
      emit();
      timer = setTimeoutFn(tick, intervalMs);
      return true;
    }

    function pause() {
      const was = playing;
      playing = false;
      stopTimer();
      if (was) emit();
      return true;
    }

    function toggle() {
      if (playing) pause();
      else play();
      return playing;
    }

    function destroy() {
      pause();
    }

    emit();

    return {
      show,
      play,
      pause,
      toggle,
      destroy,
      getIndex: () => index,
      isPlaying: () => playing
    };
  }

  function mountMap(opts) {
    const o = opts || {};
    const L = o.L;
    const mapEl = o.mapEl;
    const parsed = o.parsed;
    if (!L || !mapEl || !parsed || !parsed.frames.length) return null;
    const lat = finiteNumber(o.lat);
    const lon = finiteNumber(o.lon);
    if (lat == null || lon == null) return null;

    const map = L.map(mapEl, {
      zoomControl: true,
      attributionControl: true
    }).setView([lat, lon], finiteNumber(o.zoom) || DEFAULT_ZOOM);

    const street = L.tileLayer(BASE_LAYERS.street.url, {
      attribution: BASE_LAYERS.street.attribution,
      maxZoom: BASE_LAYERS.street.maxZoom
    });
    const satellite = L.tileLayer(BASE_LAYERS.satellite.url, {
      attribution: BASE_LAYERS.satellite.attribution,
      maxZoom: BASE_LAYERS.satellite.maxZoom
    });

    let baseId = 'satellite';
    satellite.addTo(map);

    if (typeof L.circleMarker === 'function') {
      L.circleMarker([lat, lon], {
        radius: 6,
        color: '#3ddc84',
        fillColor: '#3ddc84',
        fillOpacity: 0.9,
        weight: 2
      }).addTo(map);
    }

    const radarLayers = parsed.frames.map(frame => L.tileLayer(radarTileUrl(parsed.host, frame), {
      tileSize: TILE_SIZE,
      opacity: 0,
      maxNativeZoom: MAX_NATIVE_ZOOM,
      maxZoom: 12,
      zIndex: 400
    }));
    radarLayers.forEach(layer => layer.addTo(map));

    function showRadar(i) {
      radarLayers.forEach((layer, idx) => {
        if (layer && typeof layer.setOpacity === 'function') {
          layer.setOpacity(idx === i ? RADAR_OPACITY : 0);
        }
      });
    }

    const animator = createAnimator(parsed.frames, {
      startIndex: parsed.latestIndex,
      intervalMs: o.intervalMs || ANIMATION_MS,
      setTimeoutFn: o.setTimeoutFn,
      clearTimeoutFn: o.clearTimeoutFn,
      onFrame(frame, index, playing) {
        showRadar(index);
        if (o.timeEl) {
          o.timeEl.textContent = frame
            ? formatFrameClock(frame.time, { utcOffsetSeconds: o.utcOffsetSeconds })
            : '';
        }
        if (o.playBtn) o.playBtn.textContent = playing ? '⏸' : '▶';
      }
    });

    function setBase(id) {
      const next = id === 'street' ? 'street' : 'satellite';
      if (next !== baseId) {
        if (next === 'street') {
          map.removeLayer(satellite);
          street.addTo(map);
        } else {
          map.removeLayer(street);
          satellite.addTo(map);
        }
        baseId = next;
      }
      if (o.streetBtn) o.streetBtn.classList.toggle('active', baseId === 'street');
      if (o.satBtn) o.satBtn.classList.toggle('active', baseId === 'satellite');
      return baseId;
    }

    if (o.playBtn) o.playBtn.onclick = () => animator.toggle();
    if (o.streetBtn) o.streetBtn.onclick = () => setBase('street');
    if (o.satBtn) o.satBtn.onclick = () => setBase('satellite');
    setBase('satellite');

    const invalidate = typeof map.invalidateSize === 'function'
      ? () => { try { map.invalidateSize(); } catch (err) { /* ignore */ } }
      : () => {};
    const idle = typeof o.setTimeoutFn === 'function' ? o.setTimeoutFn : setTimeout;
    idle(invalidate, 0);

    return {
      destroy() {
        animator.destroy();
        try { map.remove(); } catch (err) { /* ignore */ }
      },
      togglePlay() { return animator.toggle(); },
      setBase,
      getBase: () => baseId,
      animator,
      map
    };
  }

  return {
    RAINVIEWER_API,
    LEAFLET_VERSION,
    TILE_SIZE,
    COLOR_SCHEME,
    TILE_OPTIONS,
    MAX_NATIVE_ZOOM,
    DEFAULT_ZOOM,
    RADAR_OPACITY,
    ANIMATION_MS,
    BASE_LAYERS,
    leafletAssets,
    wrapIndex,
    radarTileUrl,
    parseCatalog,
    formatFrameClock,
    createAnimator,
    mountMap
  };
}));
