'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSunTimesGolden } = require('./helpers');
const golden = require('./sun-times.golden.json');

describe('golden: sun-times display helpers', () => {
  it('matches parse / format / daylight / index snapshots', () => {
    assert.deepEqual(buildSunTimesGolden(), golden);
  });
});
