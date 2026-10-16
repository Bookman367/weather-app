'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildStoresGolden } = require('./helpers');
const golden = require('./stores.golden.json');

describe('golden: SpraySettings and SavedFields documents', () => {
  it('matches emptyDocument / normalizeDocument / exportDocument with frozen time', () => {
    const actual = buildStoresGolden();
    assert.equal(actual.spraySettings.exportEmpty.exportedAt, '2026-10-16T18:00:00.000Z');
    assert.deepEqual(actual, golden);
  });
});
