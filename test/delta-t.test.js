'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  calcDeltaT,
  calcWetBulbC,
  rhFromDewPoint,
  classifyDeltaT,
  deltaTtoF
} = require('../lib/spray-logic');

// Stull (2011) wet-bulb, evaluated independently so the test is not
// just "function equals itself". Values rounded to 0.1 °C.
const KNOWN = [
  // T °C, RH %, expected Tw °C, expected Delta-T °C
  { t: 20, rh: 50, tw: 13.7, dt: 6.3 },
  { t: 25, rh: 60, tw: 19.5, dt: 5.5 },
  { t: 30, rh: 20, tw: 15.9, dt: 14.1 },
  { t: 10, rh: 90, tw: 8.9, dt: 1.1 },
  { t: 35, rh: 40, tw: 24.5, dt: 10.5 },
  { t: 15, rh: 70, tw: 11.6, dt: 3.4 }
];

describe('Delta T (wet-bulb depression)', () => {
  it('matches known Stull wet-bulb / Delta-T pairs', () => {
    for (const row of KNOWN) {
      const tw = calcWetBulbC(row.t, row.rh);
      const dt = calcDeltaT(row.t, row.rh);
      assert.ok(Number.isFinite(tw), `Tw finite for ${row.t}°C / ${row.rh}%`);
      assert.ok(Number.isFinite(dt), `ΔT finite for ${row.t}°C / ${row.rh}%`);
      assert.equal(Math.round(tw * 10) / 10, row.tw, `Tw ${row.t}°C ${row.rh}%`);
      assert.equal(Math.round(dt * 10) / 10, row.dt, `ΔT ${row.t}°C ${row.rh}%`);
      assert.equal(Math.round((row.t - tw) * 10) / 10, row.dt);
    }
  });

  it('is wet-bulb depression, not dew-point depression', () => {
    const t = 25;
    const rh = 50;
    const dew = 13.9; // approx dew point at 25°C / 50% RH
    const dt = calcDeltaT(t, rh, dew);
    const dewDepression = t - dew;
    assert.ok(dt < dewDepression - 1, 'ΔT must be smaller than T − Td');
    assert.ok(dt > 4 && dt < 8, '25°C / 50% RH is a mid-range spray ΔT');
  });

  it('recovers RH from dew point when humidity is missing', () => {
    const t = 20;
    const rh = 50;
    const dew = 9.3; // Magnus-Tetens dew point ≈ 20°C / 50% RH
    const recovered = rhFromDewPoint(t, dew);
    assert.ok(Math.abs(recovered - 50) < 1.5, `recovered RH ${recovered}`);
    const fromRh = calcDeltaT(t, rh);
    const fromDew = calcDeltaT(t, null, dew);
    assert.ok(fromDew != null);
    assert.ok(Math.abs(fromRh - fromDew) < 0.3);
  });

  it('prefers provided RH over dew point', () => {
    const withBoth = calcDeltaT(20, 50, 0);
    const rhOnly = calcDeltaT(20, 50);
    assert.equal(withBoth, rhOnly);
  });

  it('returns null for unusable inputs and never goes negative', () => {
    assert.equal(calcDeltaT(null, 50), null);
    assert.equal(calcDeltaT(20, null), null);
    assert.equal(calcDeltaT(20, 'nope'), null);
    const saturated = calcDeltaT(20, 100);
    assert.ok(saturated != null && saturated >= 0);
    assert.ok(saturated < 0.6, '100% RH is a near-zero Delta-T');
  });

  it('converts a °C spread to a °F spread with no 32° offset', () => {
    assert.equal(deltaTtoF(5), 9);
    assert.equal(deltaTtoF(0), 0);
    assert.equal(deltaTtoF(null), null);
  });
});

describe('Delta T display bands (ag-spray °C)', () => {
  it('uses <2 too low, 2–8 ideal, 8–10 marginal, >10 too dry', () => {
    assert.deepEqual(classifyDeltaT(1.9), { band: 'too-low', label: 'Too low', className: 'dt-bad' });
    assert.deepEqual(classifyDeltaT(2), { band: 'ideal', label: 'Ideal', className: 'dt-optimal' });
    assert.deepEqual(classifyDeltaT(8), { band: 'ideal', label: 'Ideal', className: 'dt-optimal' });
    assert.deepEqual(classifyDeltaT(8.1), { band: 'marginal', label: 'Marginal', className: 'dt-caution' });
    assert.deepEqual(classifyDeltaT(10), { band: 'marginal', label: 'Marginal', className: 'dt-caution' });
    assert.deepEqual(classifyDeltaT(10.1), { band: 'too-dry', label: 'Too dry', className: 'dt-bad' });
    assert.equal(classifyDeltaT(null).band, 'unknown');
  });
});
