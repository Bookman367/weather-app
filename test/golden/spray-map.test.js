'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSprayMapGolden } = require('./helpers');
const golden = require('./spray-map.golden.json');

describe('golden: spray-map rollup / grid / cache', () => {
  it('matches rollupDaily, applyViewWindows, getCacheKey, generateGrid, and the forecast URL', () => {
    assert.deepEqual(buildSprayMapGolden(), golden);
  });
});
