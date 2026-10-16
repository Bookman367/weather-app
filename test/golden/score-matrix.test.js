'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildScoreMatrix } = require('./helpers');
const golden = require('./score-matrix.golden.json');

describe('golden: scoreSprayConditions matrix', () => {
  it('matches the committed snapshot for 5000 hours × products × methods × settings', () => {
    const actual = buildScoreMatrix();
    assert.equal(actual.hourCount, 5000);
    assert.equal(actual.generalMaxWindMph, 15);
    assert.deepEqual(actual, golden);
  });
});
