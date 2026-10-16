'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const OF = require('../lib/offline-forecast');

function sampleForecast() {
  return {
    location: { display: 'Osmond, NE', lat: 42.35, lon: -97.59 },
    hourly: [{ time: '2026-10-16T13:00', spray: { status: 'caution', reasons: [] } }]
  };
}

describe('offline forecast store', () => {
  it('empty / missing / corrupt storage is an unusable versioned document', () => {
    const empty = OF.loadLast(OF.memoryStorage());
    assert.equal(empty.schemaVersion, OF.SCHEMA_VERSION);
    assert.equal(empty.app, 'hero');
    assert.equal(empty.kind, 'last-forecast');
    assert.equal(empty.fetchedAt, null);
    assert.equal(empty.data, null);
    assert.equal(OF.isUsable(empty), false);
    assert.equal(OF.isUsable(OF.loadLast(null)), false);

    const corrupt = OF.loadLast(OF.memoryStorage({ [OF.STORAGE_KEY]: '{not-json' }));
    assert.equal(OF.isUsable(corrupt), false);
    assert.equal(OF.STORAGE_KEY, 'hero.lastForecast.v1');
  });

  it('saves the last successful forecast with fetchedAt and rejects incomplete copies', () => {
    const storage = OF.memoryStorage();
    const fetchedAt = '2026-10-16T18:04:00.000Z';
    const saved = OF.saveLast(storage, {
      fetchedAt,
      query: 'Osmond, NE',
      data: sampleForecast()
    });
    assert.equal(saved.fetchedAt, fetchedAt);
    assert.equal(saved.query, 'Osmond, NE');
    assert.equal(saved.data.hourly.length, 1);
    assert.equal(OF.isUsable(OF.loadLast(storage)), true);

    OF.saveLast(storage, { fetchedAt, data: { hourly: [] } });
    assert.equal(OF.loadLast(storage).query, 'Osmond, NE', 'bad save must not wipe a good copy');

    assert.equal(OF.isUsable(OF.normalizeDocument({ fetchedAt, data: { hourly: [] } })), false);
    assert.equal(OF.isUsable(OF.normalizeDocument({ data: sampleForecast() })), false);
  });

  it('reads cache headers from a fetch Response-like object', () => {
    const headers = {
      get(name) {
        if (name === OF.FROM_CACHE_HEADER) return '1';
        if (name === OF.CACHED_AT_HEADER) return '2026-10-16T15:00:00.000Z';
        return null;
      }
    };
    const resp = { headers };
    assert.equal(OF.isCachedResponse(resp), true);
    assert.equal(OF.fetchedAtFromResponse(resp), '2026-10-16T15:00:00.000Z');
    assert.equal(OF.isCachedResponse({ headers: { get: () => null } }), false);
    assert.equal(OF.fetchedAtFromResponse({ headers: { Date: 'Thu, 16 Oct 2026 15:00:00 GMT' } }), '2026-10-16T15:00:00.000Z');
    assert.equal(OF.FROM_CACHE_HEADER, 'X-Hero-From-Cache');
    assert.equal(OF.CACHED_AT_HEADER, 'X-Hero-Cached-At');
    assert.equal(OF.LAST_FORECAST_PATH, '/__hero/last-forecast');
  });
});

describe('forecast freshness labels', () => {
  const now = Date.parse('2026-10-16T18:00:00.000Z');

  it('always states the age; offline copies are labeled offline', () => {
    assert.equal(OF.formatAge('2026-10-16T17:59:30.000Z', now), 'just now');
    assert.equal(OF.formatAge('2026-10-16T17:45:00.000Z', now), '15 minutes ago');
    assert.equal(OF.formatAge('2026-10-16T17:00:00.000Z', now), '1 hour ago');
    assert.equal(OF.formatAge('2026-10-16T12:00:00.000Z', now), '6 hours ago');
    assert.equal(OF.formatAge('2026-10-14T18:00:00.000Z', now), '2 days ago');
    assert.equal(OF.formatAge('not-a-date', now), 'unknown time');

    const live = OF.freshnessLabel({ fetchedAt: '2026-10-16T17:45:00.000Z', fromCache: false }, now);
    assert.match(live, /^Updated 15 minutes ago/);
    assert.doesNotMatch(live, /offline/i);

    const offline = OF.freshnessLabel({ fetchedAt: '2026-10-16T12:00:00.000Z', fromCache: true }, now);
    assert.match(offline, /^Last updated 6 hours ago/);
    assert.match(offline, /\(offline\)/);
  });
});
