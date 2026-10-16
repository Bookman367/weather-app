'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildDeltaTTable } = require('./helpers');
const golden = require('./delta-t-table.golden.json');

describe('golden: Delta T table', () => {
  it('matches calcWetBulbC / calcDeltaT / rhFromDewPoint / classifyDeltaT / deltaTtoF', () => {
    assert.deepEqual(buildDeltaTTable(), golden);
  });
});
