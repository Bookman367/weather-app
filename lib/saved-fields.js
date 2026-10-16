// ============================================================
// Saved fields — named locations for the Hero spray map
//
// Browser-local, versioned document. No accounts. The model is a
// small standalone module so it can later move into a shared core
// (same UMD shape as lib/spray-settings.js).
//
// Storage key includes the schema version (hero.savedFields.v1) so
// a future v2 can migrate without colliding with this document.
//
// Works in Node (require) and the browser (global SavedFields).
// ============================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root === 'object' && root) {
    root.SavedFields = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'hero.savedFields.v1';

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function newId() {
    return 'field-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function parseCoordinate(value, min, max) {
    const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
  }

  function parseAcres(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = typeof value === 'number' ? value : parseFloat(String(value).trim());
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  }

  function normalizeField(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim();
    const lat = parseCoordinate(raw.lat, -90, 90);
    const lon = parseCoordinate(raw.lon, -180, 180);
    if (!name || lat == null || lon == null) return null;
    return {
      id: String(raw.id || newId()),
      name,
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      acres: parseAcres(raw.acres),
      createdAt: raw.createdAt || nowIso(),
      updatedAt: raw.updatedAt || raw.createdAt || nowIso()
    };
  }

  function emptyDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: 'hero',
      kind: 'saved-fields',
      activeId: null,
      fields: []
    };
  }

  // Accepts today's v1 document. Unknown future versions still try to
  // read known fields so a newer writer does not wipe the store.
  function normalizeDocument(raw) {
    const doc = emptyDocument();
    if (!raw || typeof raw !== 'object') return doc;
    const fields = Array.isArray(raw.fields)
      ? raw.fields.map(normalizeField).filter(Boolean)
      : [];
    const seen = new Set();
    doc.fields = fields.filter((f) => {
      if (seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
    const requested = raw.activeId != null ? String(raw.activeId) : null;
    doc.activeId = requested && doc.fields.some(f => f.id === requested) ? requested : null;
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

  function listFields(doc) {
    return (doc && Array.isArray(doc.fields)) ? doc.fields.slice() : [];
  }

  function resolveActive(doc) {
    const fields = listFields(doc);
    if (!fields.length) return null;
    const id = doc && doc.activeId;
    return fields.find(f => f.id === id) || null;
  }

  function setActive(storage, id) {
    const doc = readStorage(storage);
    if (id == null || id === '') {
      doc.activeId = null;
    } else if (!doc.fields.some(f => f.id === id)) {
      doc.activeId = null;
    } else {
      doc.activeId = id;
    }
    return writeStorage(storage, doc);
  }

  function upsertField(storage, input) {
    const doc = readStorage(storage);
    const incoming = normalizeField(input);
    if (!incoming) throw new Error('A field needs a name and a valid lat/lon');
    incoming.updatedAt = nowIso();
    const idx = doc.fields.findIndex(f => f.id === incoming.id);
    if (idx === -1) {
      incoming.createdAt = incoming.createdAt || nowIso();
      doc.fields.push(incoming);
    } else {
      incoming.createdAt = doc.fields[idx].createdAt || incoming.createdAt;
      doc.fields[idx] = incoming;
    }
    doc.activeId = incoming.id;
    return writeStorage(storage, doc);
  }

  function renameField(storage, id, name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('A field name is required');
    const doc = readStorage(storage);
    const field = doc.fields.find(f => f.id === id);
    if (!field) throw new Error('Field not found');
    field.name = trimmed;
    field.updatedAt = nowIso();
    doc.activeId = field.id;
    return writeStorage(storage, doc);
  }

  function deleteField(storage, id) {
    const doc = readStorage(storage);
    doc.fields = doc.fields.filter(f => f.id !== id);
    if (doc.activeId === id) doc.activeId = null;
    return writeStorage(storage, doc);
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
    emptyDocument,
    normalizeDocument,
    normalizeField,
    loadStore,
    listFields,
    resolveActive,
    setActive,
    upsertField,
    renameField,
    deleteField,
    parseCoordinate,
    parseAcres,
    memoryStorage
  };
}));
