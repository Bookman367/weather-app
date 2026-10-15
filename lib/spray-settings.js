// ============================================================
// Named spray settings — Hero user presets + Ops export shape
//
// Built-in "Recommended" is always the default. Custom named
// settings reuse the same limits keys PRODUCTS.general already
// uses (wind, gust, temp, RH, precip, inversion). No new weather
// inputs. Per-job / per-field overrides are out of scope here
// (Ops owns those); the JSON leaves jobId/fieldId null so Ops
// can import this document later without a reshape.
//
// Works in Node (require) and the browser (global SpraySettings).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.SpraySettings = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'hero.spraySettings.v1';
  const RECOMMENDED_ID = 'recommended';
  const RECOMMENDED_NAME = 'Recommended';

  // Same keys scoreSprayConditions reads from a product object,
  // plus the unused-but-present general-shape pair (min/max delta-t)
  // so the exported document matches today's PRODUCTS.general.
  const LIMIT_KEYS = [
    'max_wind_mph',
    'max_gust_mph',
    'min_temp_f',
    'max_temp_f',
    'min_rh',
    'max_rh',
    'max_precip_pct',
    'min_delta_t',
    'max_delta_t',
    'avoid_inversion',
    'prefer_max_temp_f',
    'inversion_wind_threshold',
    'inversion_cloud_threshold'
  ];

  const EDITOR_FIELDS = [
    { key: 'max_wind_mph', label: 'Max wind (mph)', type: 'number' },
    { key: 'max_gust_mph', label: 'Max gust (mph)', type: 'number' },
    { key: 'min_temp_f', label: 'Min temp (°F)', type: 'number' },
    { key: 'max_temp_f', label: 'Max temp (°F)', type: 'number' },
    { key: 'min_rh', label: 'Min humidity (%)', type: 'number' },
    { key: 'max_rh', label: 'Max humidity (%)', type: 'number' },
    { key: 'max_precip_pct', label: 'Max rain chance (%)', type: 'number' },
    { key: 'avoid_inversion', label: 'Flag inversion risk', type: 'boolean' }
  ];

  // Must stay in lockstep with PRODUCTS.general (proven by tests).
  const RECOMMENDED_LIMITS = {
    max_wind_mph: 15,
    max_gust_mph: 20,
    min_temp_f: 50,
    max_temp_f: 95,
    min_rh: 30,
    max_rh: 95,
    max_precip_pct: 30,
    min_delta_t: 2,
    max_delta_t: 8,
    avoid_inversion: true
  };

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function pickLimits(source) {
    if (!source || typeof source !== 'object') return null;
    const out = {};
    let hasAny = false;
    for (const key of LIMIT_KEYS) {
      if (source[key] === undefined || source[key] === null || source[key] === '') continue;
      if (key === 'avoid_inversion') {
        out[key] = Boolean(source[key]);
        hasAny = true;
        continue;
      }
      const n = Number(source[key]);
      if (!Number.isFinite(n)) continue;
      out[key] = n;
      hasAny = true;
    }
    return hasAny ? out : null;
  }

  function recommendedLimits() {
    return clone(RECOMMENDED_LIMITS);
  }

  function recommendedSetting() {
    return {
      id: RECOMMENDED_ID,
      name: RECOMMENDED_NAME,
      builtIn: true,
      productKey: 'general',
      limits: recommendedLimits(),
      notes: 'Built-in Hero recommended preset (General Ag Guidelines)',
      createdAt: null,
      updatedAt: null
    };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newId() {
    return 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function normalizeCustom(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    const limits = Object.assign({}, recommendedLimits(), pickLimits(raw.limits) || {});
    if (!name) return null;
    return {
      id: String(raw.id || newId()),
      name,
      builtIn: false,
      productKey: 'general',
      limits,
      notes: raw.notes != null ? String(raw.notes) : '',
      createdAt: raw.createdAt || nowIso(),
      updatedAt: raw.updatedAt || raw.createdAt || nowIso()
    };
  }

  function emptyDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: 'hero',
      kind: 'spray-settings',
      scope: 'user',
      jobId: null,
      fieldId: null,
      exportedAt: null,
      activeId: RECOMMENDED_ID,
      settings: [recommendedSetting()]
    };
  }

  function normalizeDocument(raw) {
    const doc = emptyDocument();
    if (!raw || typeof raw !== 'object') return doc;
    const customs = Array.isArray(raw.settings)
      ? raw.settings.map(normalizeCustom).filter(Boolean).filter(s => s.id !== RECOMMENDED_ID)
      : [];
    doc.settings = [recommendedSetting(), ...customs];
    const requested = raw.activeId != null ? String(raw.activeId) : RECOMMENDED_ID;
    doc.activeId = doc.settings.some(s => s.id === requested) ? requested : RECOMMENDED_ID;
    if (raw.jobId != null) doc.jobId = raw.jobId;
    if (raw.fieldId != null) doc.fieldId = raw.fieldId;
    if (raw.scope === 'job' || raw.scope === 'field' || raw.scope === 'user') {
      doc.scope = raw.scope;
    }
    return doc;
  }

  function readStorage(storage) {
    if (!storage || typeof storage.getItem !== 'function') return emptyDocument();
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return emptyDocument();
      return normalizeDocument(JSON.parse(raw));
    } catch {
      return emptyDocument();
    }
  }

  function writeStorage(storage, doc) {
    if (!storage || typeof storage.setItem !== 'function') return doc;
    storage.setItem(STORAGE_KEY, JSON.stringify(doc));
    return doc;
  }

  function loadStore(storage) {
    return readStorage(storage);
  }

  function listSettings(doc) {
    return (doc && doc.settings) ? doc.settings.slice() : [recommendedSetting()];
  }

  function resolveActive(doc) {
    const settings = listSettings(doc);
    const id = (doc && doc.activeId) || RECOMMENDED_ID;
    return settings.find(s => s.id === id) || settings[0] || recommendedSetting();
  }

  function setActive(storage, id) {
    const doc = readStorage(storage);
    if (!doc.settings.some(s => s.id === id)) {
      doc.activeId = RECOMMENDED_ID;
    } else {
      doc.activeId = id;
    }
    return writeStorage(storage, doc);
  }

  function upsertSetting(storage, input) {
    const doc = readStorage(storage);
    const incoming = normalizeCustom(input);
    if (!incoming) throw new Error('A setting name is required');
    if (incoming.id === RECOMMENDED_ID) throw new Error('The recommended preset cannot be overwritten');
    incoming.updatedAt = nowIso();
    const idx = doc.settings.findIndex(s => s.id === incoming.id);
    if (idx === -1) {
      incoming.createdAt = incoming.createdAt || nowIso();
      doc.settings.push(incoming);
    } else {
      incoming.createdAt = doc.settings[idx].createdAt || incoming.createdAt;
      doc.settings[idx] = incoming;
    }
    doc.activeId = incoming.id;
    return writeStorage(storage, doc);
  }

  function deleteSetting(storage, id) {
    if (id === RECOMMENDED_ID) throw new Error('The recommended preset cannot be deleted');
    const doc = readStorage(storage);
    doc.settings = doc.settings.filter(s => s.id !== id);
    if (doc.activeId === id) doc.activeId = RECOMMENDED_ID;
    return writeStorage(storage, doc);
  }

  function exportDocument(doc) {
    const out = normalizeDocument(doc);
    out.exportedAt = nowIso();
    return out;
  }

  function importDocument(storage, raw) {
    const doc = normalizeDocument(raw);
    return writeStorage(storage, doc);
  }

  function parseLimitsParam(raw) {
    if (raw == null || raw === '') return null;
    let parsed = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return pickLimits(parsed);
  }

  function isCustomActive(setting) {
    return Boolean(setting && !setting.builtIn && setting.id !== RECOMMENDED_ID);
  }

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

  return {
    SCHEMA_VERSION,
    STORAGE_KEY,
    RECOMMENDED_ID,
    RECOMMENDED_NAME,
    LIMIT_KEYS,
    EDITOR_FIELDS,
    RECOMMENDED_LIMITS,
    recommendedLimits,
    recommendedSetting,
    pickLimits,
    parseLimitsParam,
    emptyDocument,
    normalizeDocument,
    loadStore,
    listSettings,
    resolveActive,
    setActive,
    upsertSetting,
    deleteSetting,
    exportDocument,
    importDocument,
    isCustomActive,
    memoryStorage
  };
}));
