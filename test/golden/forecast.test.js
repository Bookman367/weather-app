'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildForecastGolden } = require('./helpers');
const golden = require('./forecast.golden.json');

describe('golden: /api/forecast (source=open-meteo)', () => {
  it('returns a frozen JSON body with mocked fetch and frozen Date', async () => {
    const actual = await buildForecastGolden();
    assert.equal(actual.statusCode, 200);
    assert.equal(actual.body.timezone, 'America/Chicago');
    assert.deepEqual(actual, golden);
  });
});
