// ============================================================
// Ops → Hero location links
//
// Ops opens Hero with ?lat=42.38756&lon=-97.77837 (optional &name=...).
// index.html and spray-map.html use this to land on that spot.
//
// Valid lat/lon win over GPS and the last saved field. Bad, missing,
// or out-of-range values are ignored (caller falls through). The
// location is not saved as a field — name is display-only.
//
// Works in Node (require) and the browser (global UrlLocation).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.UrlLocation = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function firstValue(value) {
    if (Array.isArray(value)) return value[0];
    return value;
  }

  function parseCoord(value, min, max) {
    const raw = firstValue(value);
    if (raw === undefined || raw === null || raw === '') return null;
    const text = String(raw).trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  }

  function parseName(value) {
    const raw = firstValue(value);
    if (raw === undefined || raw === null) return null;
    const name = String(raw).trim();
    return name || null;
  }

  // Returns { lat, lon, name } or null. name may be null.
  function fromQuery(query) {
    const q = query || {};
    const lat = parseCoord(q.lat, -90, 90);
    const lon = parseCoord(q.lon, -180, 180);
    if (lat == null || lon == null) return null;
    return { lat, lon, name: parseName(q.name) };
  }

  function fromSearch(search) {
    if (search instanceof URLSearchParams) {
      return fromQuery({
        lat: search.get('lat'),
        lon: search.get('lon'),
        name: search.get('name')
      });
    }
    if (search && typeof search === 'object' && !Array.isArray(search)) {
      return fromQuery(search);
    }
    const text = String(search == null ? '' : search);
    const trimmed = text.charAt(0) === '?' ? text.slice(1) : text;
    const params = new URLSearchParams(trimmed);
    return fromQuery({
      lat: params.get('lat'),
      lon: params.get('lon'),
      name: params.get('name')
    });
  }

  return {
    fromQuery,
    fromSearch
  };
}));
