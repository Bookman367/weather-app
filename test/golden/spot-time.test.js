'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSpotTimeGolden } = require('./helpers');
const golden = require('./spot-time.golden.json');

describe('golden: spot-local time helpers', () => {
  it('matches futureHoursFromNow / nowInSpotTimezone / hourOfDayFromTime', () => {
    assert.deepEqual(buildSpotTimeGolden(), golden);
  });
});
