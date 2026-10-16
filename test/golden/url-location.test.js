'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildUrlLocationGolden } = require('./helpers');
const golden = require('./url-location.golden.json');

describe('golden: url-location query parser', () => {
  it('matches fromSearch / fromQuery snapshots', () => {
    assert.deepEqual(buildUrlLocationGolden(), golden);
  });
});
