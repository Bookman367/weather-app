'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildWindDisplayGolden } = require('./helpers');
const golden = require('./wind-display.golden.json');

describe('golden: wind-display compass and drift notes', () => {
  it('matches degToCompass / driftRiskFromLimits / describeWind', () => {
    const actual = buildWindDisplayGolden();
    assert.equal(actual.generalMaxWindMph, 15);
    assert.deepEqual(actual, golden);
  });
});
