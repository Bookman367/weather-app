'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/saved-fields');

describe('saved fields store', () => {
  it('empty / missing storage is an empty versioned document', () => {
    const empty = F.loadStore(F.memoryStorage());
    const missing = F.loadStore(null);
    assert.equal(empty.schemaVersion, F.SCHEMA_VERSION);
    assert.equal(empty.app, 'hero');
    assert.equal(empty.kind, 'saved-fields');
    assert.equal(empty.activeId, null);
    assert.deepEqual(empty.fields, []);
    assert.equal(F.resolveActive(missing), null);
    assert.equal(F.STORAGE_KEY, 'hero.savedFields.v1');
  });

  it('corrupt localStorage falls back without throwing', () => {
    const storage = F.memoryStorage({ [F.STORAGE_KEY]: '{not-json' });
    const doc = F.loadStore(storage);
    assert.equal(doc.fields.length, 0);
    assert.equal(F.resolveActive(doc), null);
  });

  it('saving a named field persists lat/lon/acres and becomes active', () => {
    const storage = F.memoryStorage();
    F.upsertField(storage, {
      name: ' North 80 ',
      lat: 42.35123,
      lon: -97.79012,
      acres: 80.25
    });
    const doc = F.loadStore(storage);
    const active = F.resolveActive(doc);
    assert.equal(active.name, 'North 80');
    assert.equal(active.lat, 42.35123);
    assert.equal(active.lon, -97.79012);
    assert.equal(active.acres, 80.25);
    assert.equal(doc.fields.length, 1);
    assert.equal(doc.activeId, active.id);
    assert.match(active.id, /^field-/);
  });

  it('acres is optional and rejected when negative', () => {
    const storage = F.memoryStorage();
    F.upsertField(storage, { name: 'Home', lat: 40, lon: -96 });
    assert.equal(F.resolveActive(F.loadStore(storage)).acres, null);

    F.upsertField(storage, { name: 'Home', lat: 40, lon: -96, acres: '' });
    assert.equal(F.resolveActive(F.loadStore(storage)).acres, null);

    const withJunk = F.normalizeField({ name: 'Home', lat: 40, lon: -96, acres: -4 });
    assert.equal(withJunk.acres, null);
  });

  it('rejects a field without a name or a valid coordinate', () => {
    const storage = F.memoryStorage();
    assert.throws(() => F.upsertField(storage, { name: '', lat: 40, lon: -96 }));
    assert.throws(() => F.upsertField(storage, { name: 'X', lat: 99, lon: -96 }));
    assert.throws(() => F.upsertField(storage, { name: 'X', lat: 40, lon: -200 }));
    assert.equal(F.normalizeField({ name: 'X', lat: 'nope', lon: -96 }), null);
  });

  it('rename and delete keep the document consistent', () => {
    const storage = F.memoryStorage();
    const created = F.upsertField(storage, { name: 'South 40', lat: 41.1, lon: -96.2, acres: 40 });
    const id = created.activeId;

    F.renameField(storage, id, 'South 40 (irrigated)');
    assert.equal(F.resolveActive(F.loadStore(storage)).name, 'South 40 (irrigated)');

    assert.throws(() => F.renameField(storage, id, '   '));
    assert.throws(() => F.renameField(storage, 'missing', 'Nope'));

    F.deleteField(storage, id);
    const after = F.loadStore(storage);
    assert.equal(after.fields.length, 0);
    assert.equal(after.activeId, null);
  });

  it('picking a field sets active; unknown id clears it', () => {
    const storage = F.memoryStorage();
    F.upsertField(storage, { name: 'A', lat: 41, lon: -96 });
    const a = F.resolveActive(F.loadStore(storage));
    F.upsertField(storage, { name: 'B', lat: 42, lon: -97 });
    assert.equal(F.resolveActive(F.loadStore(storage)).name, 'B');

    F.setActive(storage, a.id);
    assert.equal(F.resolveActive(F.loadStore(storage)).name, 'A');

    F.setActive(storage, 'no-such-field');
    assert.equal(F.resolveActive(F.loadStore(storage)), null);
    F.setActive(storage, a.id);
    F.setActive(storage, null);
    assert.equal(F.resolveActive(F.loadStore(storage)), null);
  });

  it('normalizeDocument drops junk and de-duplicates ids', () => {
    const raw = {
      schemaVersion: 99,
      fields: [
        { id: 'field-1', name: 'Keep', lat: 40.1, lon: -96.1, acres: 10 },
        { id: 'field-1', name: 'Dup', lat: 41, lon: -97 },
        { name: '', lat: 40, lon: -96 },
        { name: 'Bad lat', lat: 200, lon: -96 }
      ],
      activeId: 'field-1'
    };
    const doc = F.normalizeDocument(raw);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.fields.length, 1);
    assert.equal(doc.fields[0].name, 'Keep');
    assert.equal(doc.activeId, 'field-1');
  });
});
