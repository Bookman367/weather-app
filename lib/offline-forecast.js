// ============================================================
// Last successful forecast — shown when the phone is offline.
//
// Never treat cached weather as live. The stored document always
// carries fetchedAt so the UI can say how old the data is.
//
// Works in Node (require) and the browser (global OfflineForecast).
// The service worker importScripts this file so cache headers match.
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.OfflineForecast = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'hero.lastForecast.v1';
  const FROM_CACHE_HEADER = 'X-Hero-From-Cache';
  const CACHED_AT_HEADER = 'X-Hero-Cached-At';
  const LAST_FORECAST_PATH = '/__hero/last-forecast';

  function memoryStorage(initial) {
    const data = Object.assign({}, initial || {});
    return {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem(key, value) {
        data[key] = String(value);
      },
      removeItem(key) {
        delete data[key];
      }
    };
  }

  function parseIso(value) {
    if (!value) return null;
    const ms = Date.parse(String(value));
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }

  function hasHourlyData(data) {
    return !!(data && typeof data === 'object' && Array.isArray(data.hourly) && data.hourly.length > 0);
  }

  function emptyDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: 'hero',
      kind: 'last-forecast',
      fetchedAt: null,
      query: null,
      data: null
    };
  }

  function normalizeDocument(raw) {
    const doc = emptyDocument();
    if (!raw || typeof raw !== 'object') return doc;
    const fetchedAt = parseIso(raw.fetchedAt);
    const data = hasHourlyData(raw.data) ? raw.data : null;
    if (!fetchedAt || !data) return doc;
    doc.fetchedAt = fetchedAt;
    doc.query = raw.query == null || raw.query === '' ? null : String(raw.query);
    doc.data = data;
    return doc;
  }

  function isUsable(doc) {
    return !!(doc && parseIso(doc.fetchedAt) && hasHourlyData(doc.data));
  }

  function loadLast(storage) {
    if (!storage || typeof storage.getItem !== 'function') return emptyDocument();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return emptyDocument();
      return normalizeDocument(JSON.parse(raw));
    } catch {
      return emptyDocument();
    }
  }

  function saveLast(storage, input) {
    const doc = normalizeDocument(input);
    if (!isUsable(doc)) return emptyDocument();
    if (!storage || typeof storage.setItem !== 'function') return doc;
    storage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return doc;
  }

  function headerValue(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
      const v = headers.get(name);
      return v == null || v === '' ? null : String(v);
    }
    const direct = headers[name] || headers[name.toLowerCase()];
    return direct == null || direct === '' ? null : String(direct);
  }

  function isCachedResponse(response) {
    if (!response || typeof response !== 'object') return false;
    return headerValue(response.headers, FROM_CACHE_HEADER) === '1';
  }

  function fetchedAtFromResponse(response, fallbackIso) {
    if (response && response.headers) {
      const cached = parseIso(headerValue(response.headers, CACHED_AT_HEADER));
      if (cached) return cached;
      const httpDate = parseIso(headerValue(response.headers, 'Date'));
      if (httpDate) return httpDate;
    }
    return parseIso(fallbackIso) || null;
  }

  function plural(n, word) {
    return n === 1 ? word : word + 's';
  }

  function formatAge(fetchedAt, nowMs) {
    const iso = parseIso(fetchedAt);
    if (!iso) return 'unknown time';
    const then = Date.parse(iso);
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const delta = now - then;
    if (!Number.isFinite(delta)) return 'unknown time';
    if (delta < 0) return 'just now';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (delta < minute) return 'just now';
    if (delta < hour) {
      const n = Math.floor(delta / minute);
      return n + ' ' + plural(n, 'minute') + ' ago';
    }
    if (delta < day) {
      const n = Math.floor(delta / hour);
      return n + ' ' + plural(n, 'hour') + ' ago';
    }
    if (delta < 7 * day) {
      const n = Math.floor(delta / day);
      return n + ' ' + plural(n, 'day') + ' ago';
    }
    try {
      return new Date(then).toLocaleString();
    } catch {
      return iso;
    }
  }

  function formatClock(fetchedAt) {
    const iso = parseIso(fetchedAt);
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  // Always include the age. Cached/offline copies are labeled so they
  // cannot be mistaken for a live pull.
  function freshnessLabel(input, nowMs) {
    const fromCache = !!(input && input.fromCache);
    const fetchedAt = input && input.fetchedAt;
    const age = formatAge(fetchedAt, nowMs);
    const clock = formatClock(fetchedAt);
    const when = clock ? age + ' · ' + clock : age;
    if (fromCache) return 'Last updated ' + when + ' (offline)';
    return 'Updated ' + when;
  }

  return {
    SCHEMA_VERSION,
    STORAGE_KEY,
    FROM_CACHE_HEADER,
    CACHED_AT_HEADER,
    LAST_FORECAST_PATH,
    emptyDocument,
    normalizeDocument,
    isUsable,
    loadLast,
    saveLast,
    isCachedResponse,
    fetchedAtFromResponse,
    formatAge,
    formatClock,
    freshnessLabel,
    memoryStorage
  };
}));
