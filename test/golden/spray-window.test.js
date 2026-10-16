'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildSprayWindowGolden, buildOpenMeteo7d } = require('./helpers');
const golden = require('./spray-window.golden.json');
const fixture = require('./fixtures/open-meteo-7d.json');

describe('golden: /api/spray-window', () => {
  it('committed Open-Meteo fixture matches the deterministic builder', () => {
    assert.deepEqual(fixture, buildOpenMeteo7d());
  });

  it('returns a frozen JSON body with mocked fetch and frozen Date', async () => {
    const actual = await buildSprayWindowGolden();
    assert.equal(actual.statusCode, 200);
    assert.equal(actual.body.fetchedAt, '2026-10-16T18:00:00.000Z');
    assert.deepEqual(actual, golden);
  });
});
