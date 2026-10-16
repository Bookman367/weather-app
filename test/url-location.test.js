'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/url-location');

describe('Ops lat/lon query links', () => {
  it('opens the Ops example coordinates and optional name; ignores bad values', () => {
    const ops = U.fromSearch('?lat=42.38756&lon=-97.77837&name=North%2080');
    assert.deepEqual(ops, { lat: 42.38756, lon: -97.77837, name: 'North 80' });

    const coordsOnly = U.fromSearch('lat=42.38756&lon=-97.77837');
    assert.deepEqual(coordsOnly, { lat: 42.38756, lon: -97.77837, name: null });

    assert.equal(U.fromSearch('?lat=91&lon=-97.77837'), null, 'lat out of range');
    assert.equal(U.fromSearch('?lat=42.38756&lon=-181'), null, 'lon out of range');
    assert.equal(U.fromSearch('?lat=nope&lon=-97.77837'), null, 'non-numeric lat');
    assert.equal(U.fromSearch('?lat=42.38756'), null, 'lon missing');
    assert.equal(U.fromSearch('?lon=-97.77837'), null, 'lat missing');
    assert.equal(U.fromSearch('?name=North%2080'), null, 'name without coords');
    assert.equal(U.fromSearch(''), null);
    assert.equal(U.fromQuery({ lat: 42.38756, lon: -97.77837, name: '   ' }).name, null);
  });
});
